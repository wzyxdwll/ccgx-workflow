/**
 * Plan Checker 5-Dimension validation helper (CCG v4.0 Phase 6)
 *
 * 在 plan 写完后、动手实施前对 plan 做静态校验。这是 GSD plan-checker
 * 12 维度的高 ROI 子集（5 个维度）：
 *
 *   Dim 1: Requirement Coverage —— 每条 ROADMAP requirement ID 是否被某 plan
 *          的 frontmatter `requirements` 字段声明
 *   Dim 2: Task Completeness —— 每个 task 必含 Files / Action / Verify / Done
 *          四件套，缺一即 BLOCKER
 *   Dim 5: Scope Sanity —— 单 plan 任务数 ≤ 3（4 警告，5+ BLOCKER 强拆）
 *   Dim 7b: Scope Reduction Detection —— 复用 Phase 4 的 scope-reduction helper
 *   Dim 10: CLAUDE.md Compliance —— plan 不违反项目 CLAUDE.md 的禁用模式 /
 *          必须步骤
 *
 * 设计原则（与 scope-reduction 一致）：
 * - 纯函数；不读文件系统、不调网络。所有输入由调用方喂进来。
 * - 输出结构化 finding 列表，调用方决定如何展示 / 如何阻断。
 * - 中英双语关键词覆盖，与 GSD 原版保持一致。
 *
 * 调用方（templates/commands/agents/plan-checker.md 主体逻辑由 LLM 执行；
 * 此处的 helper 让 verifier / spec-plan 在自动校验时跑一致的判定）。
 */

import {
  classifyScopeReduction,
  scanScopeReduction,
  type ScopeReductionFinding,
} from './scope-reduction'

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

export type PlanCheckerSeverity = 'BLOCKER' | 'WARNING' | 'INFO'

export type PlanCheckerDimensionId = '1' | '2' | '5' | '7b' | '10'

export interface PlanCheckerFinding {
  /** 命中维度 ID */
  dimension: PlanCheckerDimensionId
  /** 严重级（BLOCKER 必修，WARNING 建议，INFO 提示） */
  severity: PlanCheckerSeverity
  /** 简短问题描述（人类可读） */
  message: string
  /** 修复建议（必填——禁止"有问题但没说咋改"） */
  suggestion: string
  /** 可选定位（line / task id / requirement id） */
  location?: string
}

export interface PlanCheckerResult {
  findings: PlanCheckerFinding[]
  /** 是否存在任何 BLOCKER —— 调用方据此决定是否 max-3-loop 退回 planner */
  hasBlocker: boolean
  /** 三种严重级的命中数 */
  counts: Record<PlanCheckerSeverity, number>
}

// ---------------------------------------------------------------------------
// Plan / Task 解析
// ---------------------------------------------------------------------------

/**
 * Plan 中提取的单个 task 描述（用于 Dim 2 完整性 + Dim 5 范围理智判定）。
 */
export interface ParsedTask {
  /** task 在 plan 中的序号（1-based） */
  index: number
  /** task 的标题或第一行（用于错误定位） */
  title: string
  /** task 在原文中的行号（1-based） */
  lineNumber: number
  /** task 的全文（标题 + 后续描述行直到下一个 task） */
  body: string
  /** 是否包含 Files 字段（路径声明） */
  hasFiles: boolean
  /** 是否包含 Action 字段（动作描述） */
  hasAction: boolean
  /** 是否包含 Verify 字段（验证命令） */
  hasVerify: boolean
  /** 是否包含 Done 字段（完成判据） */
  hasDone: boolean
}

/**
 * Plan 中提取的 frontmatter 结构（仅关心 plan-checker 用得上的字段）。
 *
 * 约定的 plan 文件 frontmatter 格式：
 * ```
 * ---
 * plan: <name>
 * requirements: [REQ-01, REQ-02]
 * ---
 * ```
 */
export interface ParsedPlanFrontmatter {
  /** plan 名（可选） */
  plan?: string
  /** plan 声明覆盖的需求 ID 列表（来自 frontmatter `requirements`） */
  requirements: string[]
}

/**
 * 解析 plan 顶部的 YAML frontmatter（仅 requirements / plan 字段）。
 *
 * 容错性强：无 frontmatter / 字段缺失 / 字段格式异常都返回空数组。
 * 不引入 yaml 库——格式简单到正则就够用。
 */
export function parsePlanFrontmatter(planText: string): ParsedPlanFrontmatter {
  const out: ParsedPlanFrontmatter = { requirements: [] }
  if (!planText || typeof planText !== 'string') return out

  const fm = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/.exec(planText)
  if (!fm) return out
  const body = fm[1]

  // plan 字段
  const planLine = /^plan:\s*(.+?)\s*$/m.exec(body)
  if (planLine) out.plan = planLine[1].replace(/^["']|["']$/g, '').trim()

  // requirements 字段：支持 `[A, B, C]` 或多行 list `- A\n- B`
  const inline = /^requirements:\s*\[(.+?)\]\s*$/m.exec(body)
  if (inline) {
    out.requirements = inline[1]
      .split(',')
      .map((s) => s.replace(/["']/g, '').trim())
      .filter(Boolean)
    return out
  }

  const multilineHead = /^requirements:\s*$/m.exec(body)
  if (multilineHead) {
    const after = body.slice(multilineHead.index + multilineHead[0].length)
    const items: string[] = []
    for (const line of after.split(/\r?\n/)) {
      const m = /^\s*-\s*(.+?)\s*$/.exec(line)
      if (m) items.push(m[1].replace(/["']/g, '').trim())
      else if (line.trim() && !/^\s*-/.test(line)) break
    }
    out.requirements = items.filter(Boolean)
  }

  return out
}

/**
 * 把 plan 正文按 task 拆分。识别如下任意一种 task 分隔符：
 * - `## Task <n>` / `### Task <n>` / `## 任务 <n>`
 * - `### T<n>` / `## T<n>`
 * - 编号列表 `<n>. <title>`（行首）
 *
 * 解析每个 task 的 body 中是否含 4 字段（大小写 / 中英 / `-` 列表前缀都接受）。
 */
export function parseTasks(planText: string): ParsedTask[] {
  if (!planText || typeof planText !== 'string') return []

  const lines = planText.split(/\r?\n/)
  // 找出所有 task 起始行
  const starts: { index: number; lineNumber: number; title: string }[] = []
  const headerRe =
    /^(?:#{2,4}\s+(?:Task|任务|T)\s*[#:.\s]*?(\d+)|(\d+)\.\s+\S)/i
  let counter = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = headerRe.exec(line)
    if (m) {
      counter += 1
      starts.push({
        index: counter,
        lineNumber: i + 1,
        title: line.replace(/^#+\s*/, '').trim(),
      })
    }
  }

  const tasks: ParsedTask[] = []
  for (let i = 0; i < starts.length; i++) {
    const cur = starts[i]
    const next = starts[i + 1]
    const bodyLines = lines.slice(
      cur.lineNumber - 1,
      next ? next.lineNumber - 1 : lines.length,
    )
    const body = bodyLines.join('\n')
    tasks.push({
      index: cur.index,
      title: cur.title,
      lineNumber: cur.lineNumber,
      body,
      hasFiles: hasField(body, ['files', 'file', '文件', '文件路径', '路径']),
      hasAction: hasField(body, ['action', 'actions', '动作', '操作', '步骤']),
      hasVerify: hasField(body, ['verify', 'verification', 'test', '验证', '测试']),
      hasDone: hasField(body, ['done', 'done criteria', '完成', '完成判据', '判据']),
    })
  }

  return tasks
}

/** 检测 body 中是否声明了某个字段（容错前缀: `- `, `* `, `1. `, `**`） */
function hasField(body: string, names: readonly string[]): boolean {
  const lower = body.toLowerCase()
  for (const name of names) {
    // 匹配 `name:` 或 `**name**` 或 `<name>` 等常见格式
    const re = new RegExp(
      `(^|\\n)\\s*(?:[-*]\\s*|\\d+\\.\\s*)?(?:\\*\\*|\\*|<)?\\s*${escapeRe(name)}\\s*(?:\\*\\*|\\*|>)?\\s*[:：]`,
      'i',
    )
    if (re.test(lower)) return true
  }
  return false
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// 5 个维度的判定器
// ---------------------------------------------------------------------------

/**
 * Dim 1: 需求覆盖 —— 每条 ROADMAP requirement ID 必须被某 plan 的 frontmatter
 * `requirements` 字段声明。未被任何 plan 声明的 requirement = BLOCKER。
 *
 * @param roadmapRequirements 从 `.ccg/roadmap.md` 提取的需求 ID 列表
 * @param plansFrontmatter   多个 plan 文件解析后的 frontmatter 列表
 */
export function checkDim1RequirementCoverage(
  roadmapRequirements: readonly string[],
  plansFrontmatter: readonly ParsedPlanFrontmatter[],
): PlanCheckerFinding[] {
  if (roadmapRequirements.length === 0) return []
  const declared = new Set<string>()
  for (const fm of plansFrontmatter) {
    for (const r of fm.requirements) declared.add(r.toUpperCase())
  }
  const missing = roadmapRequirements.filter(
    (r) => !declared.has(r.toUpperCase()),
  )
  return missing.map((r) => ({
    dimension: '1' as const,
    severity: 'BLOCKER' as const,
    message: `Requirement ${r} 未被任何 plan 的 frontmatter 声明覆盖`,
    suggestion: `在某个 plan 的 frontmatter 中加入 \`requirements: [..., ${r}]\` 并补对应任务`,
    location: r,
  }))
}

/**
 * Dim 2: Task 完整性 —— 每个 task 必含 Files / Action / Verify / Done 四要素，
 * 缺任一字段 = BLOCKER。
 */
export function checkDim2TaskCompleteness(
  tasks: readonly ParsedTask[],
): PlanCheckerFinding[] {
  const findings: PlanCheckerFinding[] = []
  for (const t of tasks) {
    const missing: string[] = []
    if (!t.hasFiles) missing.push('Files')
    if (!t.hasAction) missing.push('Action')
    if (!t.hasVerify) missing.push('Verify')
    if (!t.hasDone) missing.push('Done')
    if (missing.length > 0) {
      findings.push({
        dimension: '2',
        severity: 'BLOCKER',
        message: `Task ${t.index} (${t.title}) 缺少字段：${missing.join(', ')}`,
        suggestion: `在该 task 下补齐：${missing.map((m) => `${m}: <内容>`).join(' / ')}`,
        location: `task#${t.index} L${t.lineNumber}`,
      })
    }
  }
  return findings
}

/**
 * Dim 5: 范围理智 —— 单 plan 任务数 ≤ 3（4 = WARNING，5+ = BLOCKER 强拆）。
 */
export function checkDim5ScopeSanity(
  tasks: readonly ParsedTask[],
): PlanCheckerFinding[] {
  const n = tasks.length
  if (n <= 3) return []
  if (n === 4) {
    return [
      {
        dimension: '5',
        severity: 'WARNING',
        message: `单 plan 含 ${n} 个 task，临近上限（推荐 ≤ 3）`,
        suggestion: '考虑拆分为两个聚焦 plan，或合并强相关 task',
        location: `total=${n}`,
      },
    ]
  }
  return [
    {
      dimension: '5',
      severity: 'BLOCKER',
      message: `单 plan 含 ${n} 个 task，超出上限（≤ 3 任务），必须拆分`,
      suggestion: '把 plan 拆成两个或更多独立 plan，按依赖关系编号 + 注明 wave',
      location: `total=${n}`,
    },
  ]
}

/**
 * Dim 7b: Scope Reduction Detection —— 直接复用 Phase 4 的 scope-reduction helper。
 *
 * @param planText             整个 plan 文本（含 frontmatter + body）
 * @param originalRequirements 原始需求文本集合（CONTEXT.md / PRD / requirements.md）
 */
export function checkDim7bScopeReduction(
  planText: string,
  originalRequirements: readonly string[],
): PlanCheckerFinding[] {
  const hits = scanScopeReduction(planText)
  if (hits.length === 0) return []
  const classified: ScopeReductionFinding[] = classifyScopeReduction(
    hits,
    originalRequirements,
    planText,
  )
  const findings: PlanCheckerFinding[] = []
  for (const f of classified) {
    if (f.verdict === 'NONE') continue
    const severity: PlanCheckerSeverity =
      f.verdict === 'BLOCKER' ? 'BLOCKER' : 'WARNING'
    findings.push({
      dimension: '7b',
      severity,
      message:
        f.verdict === 'BLOCKER'
          ? `Scope reduction：用户决策 "${f.matchedRequirement ?? '?'}" 被悄悄缩水（命中 "${f.keyword}"）`
          : `Scope reduction 疑似命中 "${f.keyword}"，未在原始需求中找到对应能力，需人工确认`,
      suggestion:
        f.verdict === 'BLOCKER'
          ? '要么完整实施该需求（去掉软化语言），要么把 v2/后续 phase 显式写入 plan'
          : '人工确认是否为无关字串；若属于偷工减料，按 BLOCKER 处理',
      location: `L${f.lineNumber}: ${f.line.slice(0, 60)}…`,
    })
  }
  return findings
}

/**
 * Dim 10: CLAUDE.md Compliance —— plan 文本不能违反项目 CLAUDE.md 的禁用模式 /
 * 必须步骤。
 *
 * @param planText      plan 文本
 * @param forbidden     CLAUDE.md 中的禁用模式正则或字面词（命中即 BLOCKER）
 * @param required      CLAUDE.md 中的必须步骤（plan 必须提及，否则 WARNING）
 */
export function checkDim10ClaudeMdCompliance(
  planText: string,
  forbidden: readonly (string | RegExp)[],
  required: readonly string[] = [],
): PlanCheckerFinding[] {
  const findings: PlanCheckerFinding[] = []
  const lines = planText.split(/\r?\n/)

  for (const pat of forbidden) {
    const re = pat instanceof RegExp ? pat : new RegExp(escapeRe(pat), 'i')
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        findings.push({
          dimension: '10',
          severity: 'BLOCKER',
          message: `Plan 命中 CLAUDE.md 禁用模式：${pat instanceof RegExp ? pat.source : pat}`,
          suggestion: '删除该步骤；改用 CLAUDE.md 推荐的替代方案',
          location: `L${i + 1}: ${lines[i].slice(0, 60)}`,
        })
        break // 同一禁用模式只报一次
      }
    }
  }

  const lower = planText.toLowerCase()
  for (const must of required) {
    if (!lower.includes(must.toLowerCase())) {
      findings.push({
        dimension: '10',
        severity: 'WARNING',
        message: `Plan 未提及 CLAUDE.md 要求的必须步骤："${must}"`,
        suggestion: `在 plan 的 Action / Verify 段加入对 "${must}" 的明确处理`,
        location: 'plan body',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 顶层入口：跑全部 5 维度
// ---------------------------------------------------------------------------

export interface RunPlanCheckerInput {
  /** 整个 plan 文本（含 frontmatter） */
  planText: string
  /** roadmap 中所有需求 ID（用于 Dim 1） */
  roadmapRequirements?: readonly string[]
  /** 多 plan 协同时的全部 frontmatter（用于 Dim 1） */
  allPlansFrontmatter?: readonly ParsedPlanFrontmatter[]
  /** 原始需求文本集合（用于 Dim 7b） */
  originalRequirements?: readonly string[]
  /** CLAUDE.md 禁用模式（Dim 10） */
  claudeMdForbidden?: readonly (string | RegExp)[]
  /** CLAUDE.md 必须步骤（Dim 10） */
  claudeMdRequired?: readonly string[]
}

/**
 * 一站式跑完 5 维度。返回汇总 findings + hasBlocker 旗标。
 */
export function runPlanChecker(input: RunPlanCheckerInput): PlanCheckerResult {
  const {
    planText,
    roadmapRequirements = [],
    allPlansFrontmatter,
    originalRequirements = [],
    claudeMdForbidden = [],
    claudeMdRequired = [],
  } = input

  const fm = parsePlanFrontmatter(planText)
  const tasks = parseTasks(planText)

  const findings: PlanCheckerFinding[] = []

  // Dim 1：调用方传 allPlansFrontmatter 时跑跨 plan 覆盖；否则按当前 plan 单 plan 模式
  findings.push(
    ...checkDim1RequirementCoverage(
      roadmapRequirements,
      allPlansFrontmatter ?? [fm],
    ),
  )
  findings.push(...checkDim2TaskCompleteness(tasks))
  findings.push(...checkDim5ScopeSanity(tasks))
  findings.push(...checkDim7bScopeReduction(planText, originalRequirements))
  findings.push(
    ...checkDim10ClaudeMdCompliance(
      planText,
      claudeMdForbidden,
      claudeMdRequired,
    ),
  )

  const counts: Record<PlanCheckerSeverity, number> = {
    BLOCKER: 0,
    WARNING: 0,
    INFO: 0,
  }
  for (const f of findings) counts[f.severity] += 1

  return {
    findings,
    hasBlocker: counts.BLOCKER > 0,
    counts,
  }
}

// ---------------------------------------------------------------------------
// 便利的 Markdown 报告
// ---------------------------------------------------------------------------

/**
 * 把 PlanCheckerResult 渲染为 Markdown 片段（便于 reviewer/CI 直接贴出来）。
 */
export function formatPlanCheckerReport(result: PlanCheckerResult): string {
  const { findings, counts, hasBlocker } = result
  const lines: string[] = []
  lines.push('# Plan Checker Report')
  lines.push('')
  lines.push(`- BLOCKER: ${counts.BLOCKER}`)
  lines.push(`- WARNING: ${counts.WARNING}`)
  lines.push(`- INFO: ${counts.INFO}`)
  lines.push(`- Verdict: ${hasBlocker ? '❌ 退回 planner（max-3-loop）' : '✅ 放行'}`)
  lines.push('')

  const groups: Record<PlanCheckerSeverity, PlanCheckerFinding[]> = {
    BLOCKER: [],
    WARNING: [],
    INFO: [],
  }
  for (const f of findings) groups[f.severity].push(f)

  for (const sev of ['BLOCKER', 'WARNING', 'INFO'] as PlanCheckerSeverity[]) {
    if (groups[sev].length === 0) continue
    const icon = sev === 'BLOCKER' ? '🔴' : sev === 'WARNING' ? '🟡' : '🔵'
    lines.push(`## ${icon} ${sev}`)
    lines.push('')
    for (const f of groups[sev]) {
      lines.push(`- **Dim ${f.dimension}** ${f.message}`)
      if (f.location) lines.push(`  - 位置：${f.location}`)
      lines.push(`  - 修复建议：${f.suggestion}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
