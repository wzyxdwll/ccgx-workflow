/**
 * Scope Reduction Detection helper (CCG v4.0 Phase 4)
 *
 * 在 plan / review / spec 阶段扫描 plan 文本，检测"软化语言"——把用户已锁定决策
 * 偷偷降级为 "v1 简化" / "静态硬编码" / "未来再连接" 等。这是 GSD plan-checker
 * 维度 7b 的真实事故反推（D-26：动态成本引用被静态硬编码 v1）。
 *
 * 关键设计：单纯关键词命中**不**直接阻断（合理的 v1→v2 渐进交付会误报）。
 * 必须把命中的 plan 片段与"原始需求条目（CONTEXT.md / PRD / requirements）"做对比，
 * 命中关键词 **且** 该需求条目在原始需求中存在 → BLOCKER。
 *
 * 调用方（team-reviewer / plan-checker / spec-plan）只用本模块的纯函数做静态扫描，
 * 是否阻断由调用方按"原始需求是否覆盖该缩水点"决定。
 */

/**
 * Scope-reduction soft-language 关键词集合。
 *
 * 来源：GSD `gsd-plan-checker.md:346-389` Dimension 7b + CCG v4.0
 * `.ccg-research/03-quality-gates.md:539-549` ROI #1 痛点对应。
 *
 * 设计原则：
 * - 短语而非单词（"v1" 这类太短的单字符串容易误中"v1.2.3"等版本号）
 * - 中英双语并列（CCG 用户群覆盖中文项目）
 * - 只列**软化语言**（"v1 简化版"），不列**完成语言**（"完整实现"）
 */
export const SCOPE_REDUCTION_KEYWORDS: readonly string[] = [
  // 阶段拆分类（合理性最存疑——必须与原需求对比）
  'v1 简化',
  'v1 静态',
  'v1 硬编码',
  'v1 simplified',
  'v1 static',
  'v1 hardcoded',
  'simplified version',
  '简化版',
  '静态先',
  '静态硬编码',
  'static for now',
  'static first',
  // 推迟类（最常见的偷工减料）
  'future enhancement',
  '未来增强',
  '后续连接',
  '后续再连接',
  '后续接入',
  'will be wired later',
  'wired later',
  'connect later',
  '不连接',
  'not connected to',
  'not wired to',
  // 占位类
  'placeholder',
  '占位符',
  '占位实现',
  'temporary hardcode',
  '暂时硬编码',
  // 知难而退类（用作省略借口时）
  '太复杂',
  '太困难',
  'too complex',
  'too difficult',
  'too hard',
  'too much work',
] as const

/**
 * 单个命中记录。
 */
export interface ScopeReductionHit {
  /** 命中的关键词原文 */
  keyword: string
  /** plan 中包含命中关键词的整行（去除前后空白） */
  line: string
  /** 行号（1-based）—— 便于 reviewer 在报告里指出位置 */
  lineNumber: number
}

/**
 * 扫描 plan 文本中的 scope-reduction 关键词。
 *
 * **纯关键词扫描**——不做需求对比。调用方拿到 hits 后必须自己:
 *   1. 提取每条 hit 涉及的需求/能力（用上下文行 + RTM 表）
 *   2. 与 CONTEXT.md / PRD / requirements.md 中的原始需求条目交叉
 *   3. 若该能力在原始需求中**存在** → BLOCKER（用户决策被悄悄缩水）
 *   4. 若该能力本来就标注为"分阶段交付" → INFO 或忽略
 *
 * @param planText 完整 plan 文本（plans/01-PLAN.md 等内容）
 * @param keywords 自定义关键词集合（默认用 SCOPE_REDUCTION_KEYWORDS）
 * @returns 命中列表（按行号升序，关键词大小写不敏感匹配）
 */
export function scanScopeReduction(
  planText: string,
  keywords: readonly string[] = SCOPE_REDUCTION_KEYWORDS,
): ScopeReductionHit[] {
  if (!planText || typeof planText !== 'string') {
    return []
  }
  const hits: ScopeReductionHit[] = []
  const lines = planText.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const lower = raw.toLowerCase()
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) {
        hits.push({
          keyword: kw,
          line: raw.trim(),
          lineNumber: i + 1,
        })
        // 同一行命中多个关键词只记一次（保留首个最具体的）
        break
      }
    }
  }
  return hits
}

/**
 * 判定结果：BLOCKER / WARNING / NONE。
 */
export type ScopeReductionVerdict = 'BLOCKER' | 'WARNING' | 'NONE'

/**
 * 报告条目（含交叉对比后的最终判决）。
 */
export interface ScopeReductionFinding extends ScopeReductionHit {
  /** 最终判决——结合原始需求对比后的结果 */
  verdict: ScopeReductionVerdict
  /** 该 hit 关联到的原始需求条目（若有）—— 调用方提供 */
  matchedRequirement?: string
  /** 判决理由（人类可读） */
  reason: string
}

/**
 * 把扫描结果与原始需求做交叉，输出最终 finding。
 *
 * 判决规则：
 * - hit 命中关键词 + 同一片段在 originalRequirements 中找得到对应需求 → **BLOCKER**
 *   （用户已锁定该需求，plan 却悄悄缩水）
 * - hit 命中关键词 + 但 plan 文本明确写了"分阶段：v1 → v2 增量"且 v2 也被规划 → **NONE**
 *   （合理的渐进交付，不算缩水）
 * - hit 命中关键词 + 找不到对应需求 + 也无明确分阶段说明 → **WARNING**
 *   （可能是缩水也可能是无关字串，需人工确认）
 *
 * @param hits scanScopeReduction 的输出
 * @param originalRequirements 原始需求文本集合（CONTEXT.md / PRD / requirements.md 内容）
 * @param planText 完整 plan 文本（用来检测"分阶段交付"上下文）
 */
export function classifyScopeReduction(
  hits: readonly ScopeReductionHit[],
  originalRequirements: readonly string[],
  planText: string,
): ScopeReductionFinding[] {
  const reqJoined = originalRequirements.join('\n').toLowerCase()
  const planLower = planText.toLowerCase()

  return hits.map((hit) => {
    const lineLower = hit.line.toLowerCase()

    // Step 1: 提取 hit 行中的"领域名词"（去掉关键词、连接词，剩下的内容做需求匹配）
    const domainTokens = extractDomainTokens(hit.line, hit.keyword)

    // Step 2: 检查这些 token 是否出现在原始需求中
    const matchedToken = domainTokens.find((tok) =>
      tok.length >= 3 && reqJoined.includes(tok.toLowerCase()),
    )

    // Step 3: 检查 plan 是否明确写了"v2 增量"或后续 phase 会补
    // 仅在 plan 中存在 "v2" / "phase 2" / "增量交付" / "后续 phase" 等显式延续标记时
    const hasIncrementalPlan = (
      /\b(v2|v3|phase\s*2|phase\s*ii|增量交付|后续\s*phase|next\s+phase|follow[- ]?up\s+phase)\b/i.test(planLower)
    )

    if (matchedToken && !hasIncrementalPlan) {
      return {
        ...hit,
        verdict: 'BLOCKER' as const,
        matchedRequirement: matchedToken,
        reason: `命中 "${hit.keyword}"，对应能力 "${matchedToken}" 在原始需求中存在但 plan 未完整实施`,
      }
    }

    if (matchedToken && hasIncrementalPlan) {
      return {
        ...hit,
        verdict: 'NONE' as const,
        matchedRequirement: matchedToken,
        reason: `命中 "${hit.keyword}"，但 plan 显式标注分阶段交付（v2/后续 phase 已规划），合理渐进`,
      }
    }

    return {
      ...hit,
      verdict: 'WARNING' as const,
      reason: `命中 "${hit.keyword}"，未在原始需求中找到对应能力——可能是无关字串或未列入需求的缩水，需人工确认`,
    }
  })
}

/**
 * 从命中行中粗提领域 token（去掉关键词、连接词、标点）。
 * 内部辅助函数，导出仅供测试。
 */
export function extractDomainTokens(line: string, keyword: string): string[] {
  // 移除关键词本体
  let stripped = line.toLowerCase().replace(keyword.toLowerCase(), ' ')
  // 移除常见连接词与符号（中英文）
  const stopwords = [
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'will', 'be', 'to',
    'for', 'of', 'on', 'in', 'at', 'and', 'or', 'but', 'with', 'as',
    'not', 'no', 'we', 'they', 'it', 'this', 'that', 'these', 'those',
    '的', '了', '是', '在', '和', '与', '或', '但', '不', '为', '把',
    '将', '把', '会', '要', '从', '到', '让', '给', '有', '没',
  ]
  for (const sw of stopwords) {
    stripped = stripped.replace(new RegExp(`\\b${sw}\\b`, 'gi'), ' ')
  }
  // 拆词（按空白 / 标点 / 中英文边界）
  const tokens = stripped
    .split(/[\s,.;:!?\-_\/\\(){}\[\]<>"'`]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !/^\d+$/.test(t))
  return tokens
}

/**
 * 把 finding 列表汇总为审查报告片段（Markdown）。
 *
 * 用途：reviewer / plan-checker / spec-plan 可以直接把本函数返回的字符串塞进
 * 自己的报告输出（不强制使用，仅作便利）。
 */
export function formatScopeReductionReport(
  findings: readonly ScopeReductionFinding[],
): string {
  if (findings.length === 0) {
    return '✅ Scope Reduction 扫描通过：未发现软化语言或所有命中均为合理分阶段交付。'
  }
  const blockers = findings.filter((f) => f.verdict === 'BLOCKER')
  const warnings = findings.filter((f) => f.verdict === 'WARNING')
  const lines: string[] = []
  lines.push(`## Scope Reduction Detection 结果`)
  lines.push('')
  lines.push(`- BLOCKER: ${blockers.length}`)
  lines.push(`- WARNING: ${warnings.length}`)
  lines.push('')
  if (blockers.length > 0) {
    lines.push('### 🔴 BLOCKER（必须返工）')
    for (const f of blockers) {
      lines.push(
        `- L${f.lineNumber} 关键词 \`${f.keyword}\` → 需求 "${f.matchedRequirement}"`,
      )
      lines.push(`  - 原文：${f.line}`)
      lines.push(`  - 理由：${f.reason}`)
    }
    lines.push('')
  }
  if (warnings.length > 0) {
    lines.push('### 🟡 WARNING（人工确认）')
    for (const f of warnings) {
      lines.push(`- L${f.lineNumber} 关键词 \`${f.keyword}\``)
      lines.push(`  - 原文：${f.line}`)
      lines.push(`  - 理由：${f.reason}`)
    }
  }
  return lines.join('\n')
}
