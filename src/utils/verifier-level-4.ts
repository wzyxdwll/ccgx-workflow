/**
 * Verifier Level 4 — Data Flow Tracing + Override + Deferred Filtering (CCG v4.0 Phase 8)
 *
 * 在 verifier 三层（存在 / 实质 / 联通）之上加第 4 层：**数据流追踪**。
 * 这是 GSD `gsd-verifier.md:264-319` Level 4 的移植，专门解决"看起来都连上了，
 * 但实际渲染空数据"这一最大类 stub。
 *
 * 配套两个机制：
 *   - **Step 3b override**（`gsd-verifier.md:184-215`）：VERIFICATION.md frontmatter
 *     `overrides:` 字段记录用户认可的偏离，verifier 用 80% token 重叠匹配，
 *     命中即标 `PASSED (override)` 算入通过分。
 *   - **Step 9b deferred filtering**（`gsd-verifier.md:521-548`）：扫 ROADMAP / 后续
 *     phase 计划，若 gap 在后续 phase goal/SC 中显式覆盖，挪到 `deferred` 列表
 *     不算 gap。保守匹配（不明确就当真 gap）。
 *
 * 设计原则（与 phase 4 / phase 6 helper 一致）：
 *   - 纯函数；不读文件系统、不调网络。所有输入由调用方喂进来。
 *   - 输出结构化结果，调用方决定如何阻断 / 展示。
 *   - 中英双语关键词覆盖。
 *
 * 调用方：`templates/commands/agents/verifier.md` 主体逻辑由 LLM 执行；此处的
 * helper 让 verifier / spec-impl 在自动校验时跑一致的判定，避免每次重新推理。
 */

// ---------------------------------------------------------------------------
// 1. Data Flow Tracing (Level 4)
// ---------------------------------------------------------------------------

/**
 * 数据流状态——从 GSD `gsd-verifier.md:264-319` 直接对应。
 *
 * - `FLOWING`     ：fetch / query / store 真返回数据，渲染真实内容
 * - `STATIC`      ：调用了 fetch 但失败时静态兜底（`|| []` / `|| {}` / 静态常量）
 * - `DISCONNECTED`：找到状态变量但无任何数据源（useState 只有初值未被 setState 调用）
 * - `HOLLOW_PROP` ：组件 prop 直接被父级传 `[]` / `{}` 等空字面量（最大类 stub）
 * - `NO_DYNAMIC`  ：组件不渲染动态数据，跳过 Level 4
 */
export type DataFlowStatus =
  | 'FLOWING'
  | 'STATIC'
  | 'DISCONNECTED'
  | 'HOLLOW_PROP'
  | 'NO_DYNAMIC'

/**
 * Level 4 单文件追踪结果。
 */
export interface DataFlowTrace {
  /** 检测到的状态变量名（useState/useQuery/useStore） */
  stateVars: string[]
  /** 检测到的数据源调用（fetch / query / store / api 等） */
  dataSources: string[]
  /** 静态兜底命中（`|| []` / `?? {}` 等模式） */
  staticFallbacks: string[]
  /** 硬编码 prop 命中（父级传 `[]` / `{}` 给可能渲染列表的子组件） */
  hollowProps: string[]
  /** 数据流最终状态 */
  status: DataFlowStatus
  /** 判决理由（人类可读） */
  reason: string
}

/**
 * 检测组件代码是否渲染动态数据 — 触发 Level 4 的前置门。
 *
 * 启发式：包含 `useState` / `useQuery` / `useStore` / `useSWR` / `fetch(` /
 * `await ` + `.findMany()` / `.find()` / `.query(` 等动态数据接口即视为动态渲染。
 */
export function isDynamicComponent(source: string): boolean {
  if (!source || typeof source !== 'string') return false
  const dynamicPatterns = [
    /\buseState\s*\(/,
    /\buseReducer\s*\(/,
    /\buseQuery\s*\(/,
    /\buseSWR\s*\(/,
    /\buseStore\s*\(/,
    /\buseSelector\s*\(/,
    /\bfetch\s*\(/,
    /\baxios\.(get|post|put|delete|patch)\s*\(/,
    /\bprisma\.\w+\.(findMany|findUnique|findFirst|count)\s*\(/,
    /\.query\s*\(/,
    // 框架变体
    /\buseSignal\s*\(/, // Solid/Preact
    /\bref\s*\(/, // Vue Composition API（弱信号，仅作辅助）
  ]
  return dynamicPatterns.some((re) => re.test(source))
}

/**
 * 提取代码中的状态变量名（仅命名 hook，不含匿名 useEffect）。
 */
export function extractStateVars(source: string): string[] {
  if (!source) return []
  const vars: string[] = []
  // const [foo, setFoo] = useState(...)
  const useStateRe =
    /const\s*\[\s*([A-Za-z_$][\w$]*)\s*,\s*set[A-Z]\w*\s*\]\s*=\s*useState/g
  // const { data: foo } = useQuery / useSWR
  const useQueryRe =
    /const\s*\{\s*data\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/g
  // const foo = useStore / useSelector
  const useStoreRe =
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*(useStore|useSelector)\s*\(/g

  let m: RegExpExecArray | null
  while ((m = useStateRe.exec(source)) !== null) vars.push(m[1])
  while ((m = useQueryRe.exec(source)) !== null) vars.push(m[1])
  while ((m = useStoreRe.exec(source)) !== null) vars.push(m[1])
  return Array.from(new Set(vars))
}

/**
 * 提取数据源调用（fetch / api / query / prisma）。
 */
export function extractDataSources(source: string): string[] {
  if (!source) return []
  const sources: string[] = []
  const patterns: Array<[RegExp, string]> = [
    [/\bfetch\s*\(\s*['"`]([^'"`]+)['"`]/g, 'fetch:$1'],
    [/\baxios\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g, 'axios.$1:$2'],
    [/\bprisma\.(\w+)\.(findMany|findUnique|findFirst|count)\b/g, 'prisma.$1.$2'],
    [/\b(useQuery|useSWR)\s*\(\s*['"`]?([^,'"`)]+)/g, '$1:$2'],
  ]
  for (const [re, tpl] of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) {
      const filled = tpl
        .replace('$1', m[1] ?? '')
        .replace('$2', m[2] ?? '')
        .trim()
      sources.push(filled)
    }
  }
  return Array.from(new Set(sources))
}

/**
 * 检测静态兜底模式（fetch 但 fail 时返回硬编码空集）。
 *
 * 命中模式：
 *   - `data || []`
 *   - `data ?? {}`
 *   - `result || []`
 *   - `setFoo([])` 紧跟 `.catch`
 *   - `return []` / `return {}` 在 fetch 调用所在函数体
 */
export function extractStaticFallbacks(source: string): string[] {
  if (!source) return []
  const hits: string[] = []
  const fallbackPatterns = [
    /\b\w+\s*\|\|\s*\[\s*\]/g,
    /\b\w+\s*\|\|\s*\{\s*\}/g,
    /\b\w+\s*\?\?\s*\[\s*\]/g,
    /\b\w+\s*\?\?\s*\{\s*\}/g,
    /\.catch\s*\([^)]*\)\s*=>\s*\[\s*\]/g,
    /\.catch\s*\([^)]*\)\s*=>\s*\{\s*\}/g,
    /set[A-Z]\w*\s*\(\s*\[\s*\]\s*\)/g, // setFoo([])
  ]
  for (const re of fallbackPatterns) {
    const matches = source.match(re)
    if (matches) hits.push(...matches.map((m) => m.trim()))
  }
  return Array.from(new Set(hits))
}

/**
 * 检测父组件是否硬编码地把 `[]` / `{}` 传给子组件 prop。
 *
 * 命中模式：JSX 形如 `<Foo items={[]} />` 或 `<Foo data={{}} />`，
 * 这是 GSD 真实事故里最常见的"看起来连上了但实际空"的源头。
 */
export function extractHollowProps(source: string): string[] {
  if (!source) return []
  const hits: string[] = []
  // <Component prop={[]} ... /> or <Component prop={{}} />
  const re = /<([A-Z]\w*)\s+[^>]*?(\w+)\s*=\s*\{\s*(\[\s*\]|\{\s*\})\s*\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    hits.push(`<${m[1]} ${m[2]}={${m[3]}}>`)
  }
  return Array.from(new Set(hits))
}

/**
 * 综合判定数据流状态。
 *
 * 决策树（最严格优先，与 GSD 对齐）：
 *   1. 不是动态组件 → NO_DYNAMIC
 *   2. 命中 hollowProp（父传空字面量）→ HOLLOW_PROP
 *   3. 有 stateVar 但无任何 dataSource 也无 setState → DISCONNECTED
 *   4. 有 dataSource + 命中 staticFallback → STATIC（不区分有无真返回，保守判 STATIC）
 *   5. 有 dataSource 但无 staticFallback → FLOWING
 *   6. 兜底 → DISCONNECTED
 */
export function traceDataFlow(source: string): DataFlowTrace {
  if (!isDynamicComponent(source)) {
    return {
      stateVars: [],
      dataSources: [],
      staticFallbacks: [],
      hollowProps: [],
      status: 'NO_DYNAMIC',
      reason: '组件不渲染动态数据，跳过 Level 4',
    }
  }

  const stateVars = extractStateVars(source)
  const dataSources = extractDataSources(source)
  const staticFallbacks = extractStaticFallbacks(source)
  const hollowProps = extractHollowProps(source)

  if (hollowProps.length > 0) {
    return {
      stateVars,
      dataSources,
      staticFallbacks,
      hollowProps,
      status: 'HOLLOW_PROP',
      reason: `父组件硬编码传入空字面量给子组件 prop：${hollowProps.join(' / ')}`,
    }
  }

  // 有数据源（不区分是否真返回）+ 命中静态兜底 → STATIC
  if (dataSources.length > 0 && staticFallbacks.length > 0) {
    return {
      stateVars,
      dataSources,
      staticFallbacks,
      hollowProps,
      status: 'STATIC',
      reason: `数据源调用了但有静态兜底：${staticFallbacks.join(' / ')} —— 真实渲染可能为空`,
    }
  }

  if (dataSources.length > 0) {
    return {
      stateVars,
      dataSources,
      staticFallbacks,
      hollowProps,
      status: 'FLOWING',
      reason: `数据源 ${dataSources.length} 个真实调用，无静态兜底`,
    }
  }

  // 有 state var 但找不到 data source → DISCONNECTED
  return {
    stateVars,
    dataSources,
    staticFallbacks,
    hollowProps,
    status: 'DISCONNECTED',
    reason:
      stateVars.length > 0
        ? `检测到状态变量 ${stateVars.join(', ')} 但无任何数据源调用`
        : '未检测到任何数据源调用',
  }
}

// ---------------------------------------------------------------------------
// 2. Step 3b — Override Mechanism (80% token overlap matching)
// ---------------------------------------------------------------------------

/**
 * VERIFICATION.md frontmatter 的 override 条目。
 *
 * 用户认可的偏离需要记录在 frontmatter 的 `overrides:` 字段，verifier 用
 * 80% token 重叠匹配命中 must_have，命中后该项标 `PASSED (override)`。
 */
export interface VerificationOverride {
  /** 被覆盖的 must_have（truth）原文 */
  must_have: string
  /** 偏离原因（必须明确，不接受空字符串） */
  reason: string
  /** 谁批准的（用户名 / 角色） */
  accepted_by: string
  /** ISO 时间戳 */
  accepted_at: string
}

/**
 * Override 匹配结果。
 */
export interface OverrideMatchResult {
  /** 是否命中（重叠率 ≥ 0.8） */
  matched: boolean
  /** 实际重叠率（0-1） */
  overlapRatio: number
  /** 命中的 override 条目（matched=true 时填充） */
  override?: VerificationOverride
}

/**
 * Tokenize 用于 override 匹配（小写 + 拆词 + 去标点 + 去停用词）。
 *
 * 中英双语处理：
 * - 英文按空白和标点拆词，去常见停用词
 * - 中文按字符级保留（中文无空格分词，且 must_have 通常较短，按字符级计算
 *   重叠率比 jieba 更稳定）
 */
export function tokenizeForOverride(text: string): string[] {
  if (!text) return []
  const stopwords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'will', 'be', 'to',
    'for', 'of', 'on', 'in', 'at', 'and', 'or', 'but', 'with', 'as',
    'not', 'no', 'we', 'they', 'it', 'this', 'that', 'these', 'those',
  ])
  const tokens: string[] = []
  // 先拆英文单词
  const englishParts = text
    .toLowerCase()
    .replace(/[^\w\s一-鿿]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0)
  for (const part of englishParts) {
    // 中文段落保留为单字字符
    if (/[一-鿿]/.test(part)) {
      for (const ch of part) {
        if (/[一-鿿]/.test(ch)) tokens.push(ch)
        else if (ch.length >= 2 && !stopwords.has(ch)) tokens.push(ch)
      }
    } else if (!stopwords.has(part) && part.length >= 2) {
      tokens.push(part)
    }
  }
  return tokens
}

/**
 * 计算两段文本的 token 重叠率（must_have 视角，分母为 must_have 的 token 数）。
 *
 * 设计：用 must_have 作为分母，因为我们关心"override 描述是否覆盖了 must_have
 * 的关键词"，不是反过来。这样长 reason 不会稀释重叠率。
 */
export function computeOverlapRatio(mustHave: string, overrideText: string): number {
  const mustTokens = tokenizeForOverride(mustHave)
  if (mustTokens.length === 0) return 0
  const overrideTokens = new Set(tokenizeForOverride(overrideText))
  let overlap = 0
  for (const tok of mustTokens) {
    if (overrideTokens.has(tok)) overlap++
  }
  return overlap / mustTokens.length
}

/**
 * 检查某个 must_have 是否被 frontmatter overrides 覆盖（80% 阈值）。
 *
 * @param mustHave 待验证的 must_have（来自 PLAN frontmatter / ROADMAP success_criteria）
 * @param overrides VERIFICATION.md frontmatter 的 overrides 列表
 * @param threshold 重叠率阈值（默认 0.8 = 80%）
 */
export function matchOverride(
  mustHave: string,
  overrides: readonly VerificationOverride[],
  threshold = 0.8,
): OverrideMatchResult {
  if (!mustHave || overrides.length === 0) {
    return { matched: false, overlapRatio: 0 }
  }
  let best: OverrideMatchResult = { matched: false, overlapRatio: 0 }
  for (const ov of overrides) {
    const ratio = computeOverlapRatio(mustHave, ov.must_have)
    if (ratio > best.overlapRatio) {
      best = {
        matched: ratio >= threshold,
        overlapRatio: ratio,
        override: ratio >= threshold ? ov : best.override,
      }
    }
  }
  // 如果最佳重叠率达到阈值但 best.override 没被填上（极少见），补一下
  if (best.matched && !best.override) {
    best.override = overrides.find(
      (ov) => computeOverlapRatio(mustHave, ov.must_have) >= threshold,
    )
  }
  return best
}

// ---------------------------------------------------------------------------
// 3. Step 9b — Deferred Filtering (gap 在后续 phase 是否被覆盖)
// ---------------------------------------------------------------------------

/**
 * 后续 phase 计划文件——调用方喂进来。
 */
export interface FuturePhasePlan {
  /** phase 标识，如 `phase-09-uat-session` */
  phase_id: string
  /** phase 标题（人类可读） */
  title: string
  /** phase goal 文本（用来做关键词匹配） */
  goal: string
  /** success criteria 文本（合并所有 SC 为一个字符串便于匹配） */
  success_criteria: string
}

/**
 * Deferred 判定结果。
 */
export interface DeferredCheckResult {
  /** 是否在后续 phase 中被覆盖 → 不算 gap */
  deferred: boolean
  /** 命中的 phase（deferred=true 时填充） */
  matchedPhase?: FuturePhasePlan
  /** 命中关键词（人类可读） */
  matchedKeywords: string[]
}

/**
 * 提取 gap 描述中的"领域关键词"（与原始 must_have 匹配 token 类似但更激进）。
 *
 * 比 tokenizeForOverride 更宽松——保留长度 ≥ 2 的英文单词和所有中文字符。
 */
export function extractGapKeywords(gapText: string): string[] {
  if (!gapText) return []
  return Array.from(new Set(tokenizeForOverride(gapText))).filter(
    (t) => t.length >= 2,
  )
}

/**
 * 判定一个 gap 是否被后续 phase 显式覆盖（保守匹配——不明确就当真 gap）。
 *
 * 算法（与 GSD `gsd-verifier.md:521-548` 对齐）：
 * 1. 提取 gap 中的领域关键词
 * 2. 对每个后续 phase，计算 goal+success_criteria 中包含多少 gap 关键词
 * 3. 至少 ≥3 个关键词或 ≥50% 关键词命中 → 视为覆盖
 * 4. 否则不 deferred（保守：不明确即当真 gap）
 *
 * @param gapText gap 描述（来自 verifier gaps 列表的 truth/reason）
 * @param futurePhases 后续 phase 计划列表（按 roadmap 顺序，仅"未开始"phase）
 * @param minKeywordHits 最少命中的关键词数（默认 3）
 * @param minHitRatio 最少命中比率（默认 0.5）
 */
export function checkDeferred(
  gapText: string,
  futurePhases: readonly FuturePhasePlan[],
  minKeywordHits = 3,
  minHitRatio = 0.5,
): DeferredCheckResult {
  const keywords = extractGapKeywords(gapText)
  if (keywords.length === 0 || futurePhases.length === 0) {
    return { deferred: false, matchedKeywords: [] }
  }

  let bestMatch: DeferredCheckResult = { deferred: false, matchedKeywords: [] }

  for (const phase of futurePhases) {
    const phaseText = `${phase.goal}\n${phase.success_criteria}`.toLowerCase()
    const matched = keywords.filter((kw) => phaseText.includes(kw.toLowerCase()))
    const ratio = matched.length / keywords.length
    if (
      matched.length >= minKeywordHits ||
      (matched.length > 0 && ratio >= minHitRatio)
    ) {
      // 取 hit 最多的 phase
      if (matched.length > bestMatch.matchedKeywords.length) {
        bestMatch = {
          deferred: true,
          matchedPhase: phase,
          matchedKeywords: matched,
        }
      }
    }
  }

  return bestMatch
}

// ---------------------------------------------------------------------------
// 4. 报告输出辅助
// ---------------------------------------------------------------------------

export function formatDataFlowReport(trace: DataFlowTrace): string {
  const icons: Record<DataFlowStatus, string> = {
    FLOWING: '✅',
    STATIC: '⚠',
    DISCONNECTED: '❌',
    HOLLOW_PROP: '❌',
    NO_DYNAMIC: '➖',
  }
  return [
    `${icons[trace.status]} **数据流**: ${trace.status}`,
    `- 状态变量: ${trace.stateVars.length > 0 ? trace.stateVars.join(', ') : '(无)'}`,
    `- 数据源: ${trace.dataSources.length > 0 ? trace.dataSources.join(', ') : '(无)'}`,
    trace.staticFallbacks.length > 0
      ? `- 静态兜底: ${trace.staticFallbacks.join(' / ')}`
      : null,
    trace.hollowProps.length > 0
      ? `- 硬编码 prop: ${trace.hollowProps.join(' / ')}`
      : null,
    `- 判定理由: ${trace.reason}`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n')
}
