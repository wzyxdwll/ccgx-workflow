/**
 * Challenger Orchestrator (CCG v4.1 Phase 16).
 *
 * Critical phase（roadmap.md frontmatter `Critical: true`）在 phase-runner
 * 实施完成后，由**主线** spawn 一组 challenger agents 做"双视角对辩 + 假设/边界
 * 审计"，再综合反馈让 implementer 修订一轮。
 *
 * v4.0.1 commit a7cdffd 实测证伪 subagent 嵌套 spawn —— 所以这是**主线扁平化**
 * 编排（spawn implementer → 接 200-token 摘要 → 主线判 Critical → spawn
 * challenger group → 综合 → spawn implementer 修订），而不是 phase-runner
 * 内部 spawn challenger。
 *
 * 设计原则（与 v4.1 wave-scheduler / specialist-router 一致）：
 *   - 纯函数；不读文件系统、不 spawn 子进程
 *   - 输入 phase 元数据 + plugin 可用性，输出结构化 spawn 计划 / 摘要解析 / 决策
 *   - 跨平台：无路径假设
 *   - 失败用 throw + 明确错误信息（输入非法 / 类型未知）
 *
 * 调用方（概念上）：
 *   - `templates/commands/autonomous.md` Step 4.4 challenger 分支
 *
 * 不做：
 *   - 不实际 spawn Agent（主线 LLM 的职责，本 helper 只产出 spawn 计划）
 *   - 不写 roadmap.md / .context/<phase>/SUMMARY.md
 *   - 不解析 phase-runner 摘要（`phase-runner.ts` 已覆盖）
 */

// ---------------------------------------------------------------------------
// 1. Schema
// ---------------------------------------------------------------------------

// v4.2 P21: 改用 multi-model-routing SSoT 的 Layer 替代 PhaseType
import type { Layer, PluginAvailability } from './multi-model-routing'
export type { PluginAvailability } from './multi-model-routing'

/**
 * Plugin advisor agent type. Maps to Claude Code subagent_type identifiers
 * for the codex / gemini rescue plugins shipped via the `claude-plugins-*`
 * marketplace.
 */
export type PluginAdvisor = 'codex:codex-rescue' | 'gemini:gemini-rescue'

/**
 * CCG-built specialist critic agent. These ship with CCG installer
 * (templates/commands/agents/*.md) so are always available — no plugin
 * detection required.
 */
export type SpecialistCritic =
  | 'assumptions-analyzer'
  | 'nyquist-auditor'

export type ChallengerAgent = PluginAdvisor | SpecialistCritic

/**
 * Severity tier of a finding raised by a challenger.
 * `critical` — must address before advancing the phase
 * `major`    — strongly recommended; degrades quality if ignored
 * `info`     — informational only
 */
export type FindingSeverity = 'critical' | 'major' | 'info'

/**
 * Input describing the phase under challenge.
 */
export interface ChallengeInput {
  /** Phase id, e.g. "16" */
  phaseId: string
  /**
   * Phase layer from roadmap.md `Type` field.
   *
   * v4.2 P21 起统一用 multi-model-routing SSoT 的 `Layer`，
   * 替代历史 phase-runner.ts 自定义的 `PhaseType`（已收并）。
   */
  phaseType: Layer
  /** Whether `Critical: true` was declared in the phase frontmatter */
  critical: boolean
  /** What plugins the user has installed (detected at orchestrator start) */
  plugins: PluginAvailability
}

/**
 * One agent invocation in the spawn plan. Main thread spawns all entries
 * from `ChallengerPlan.spawns` in a single message (Claude Code engine
 * runs them in parallel).
 */
export interface SpawnEntry {
  agent: ChallengerAgent
  /** Adversarial framing flag; `true` for plugin advisors and specialist critics alike */
  adversarial: true
  /** Short rationale for logs / user visibility */
  rationale: string
}

/**
 * Final spawn plan returned by `planChallengerSpawns`.
 * `skipped` means Critical=false → no challengers, advance directly.
 */
export interface ChallengerPlan {
  /** Whether challenger phase runs at all */
  skipped: boolean
  /** Reason when `skipped: true` (e.g. "phase not Critical") */
  skipReason?: string
  /** List of agents to spawn in parallel */
  spawns: SpawnEntry[]
  /** `true` if any plugin was unavailable and orchestrator degraded */
  degraded: boolean
  /** Specific degradation note when `degraded: true` */
  degradeNote?: string
}

/**
 * One challenger's ≤200-token summary. Format mirrors phase-runner
 * summary loosely but is challenger-specific: focus on findings list.
 *
 *   STATUS: complete | error
 *   FINDINGS: [{severity, category, message}, ...]   (JSON-ish, lenient parse)
 *   NOTES: <≤80 chars>
 */
export interface ChallengerSummary {
  agent: ChallengerAgent
  status: 'complete' | 'error'
  findings: Finding[]
  notes: string
  raw: string
}

export interface Finding {
  severity: FindingSeverity
  category: string  // e.g. "assumption", "boundary", "design", "test"
  message: string
}

/**
 * Decision after collecting all challenger summaries.
 * `revise` — at least one critical finding → main thread re-spawns
 *            phase-runner with synthesized feedback (one revision round only)
 * `advance` — no critical findings → proceed with original implementation
 * `escalate` — challenger errors prevent decision → AskUserQuestion
 */
export type ChallengerDecision = 'revise' | 'advance' | 'escalate'

// ---------------------------------------------------------------------------
// 2. Spawn planning (acceptance c, d)
// ---------------------------------------------------------------------------

/**
 * Build the spawn plan for a Critical phase.
 *
 * Routing rules (acceptance c):
 *
 *   backend  + Critical=true → codex:codex-rescue + assumptions-analyzer
 *   frontend + Critical=true → gemini:gemini-rescue + nyquist-auditor
 *   fullstack+ Critical=true → codex:codex-rescue + gemini:gemini-rescue
 *                              + assumptions-analyzer + nyquist-auditor
 *   docs     + Critical=true → assumptions-analyzer (single specialist)
 *   generic  + Critical=true → assumptions-analyzer (single specialist)
 *
 * Critical=false → skip entirely, return `{ skipped: true }`.
 *
 * Plugin degradation (acceptance d): if a required plugin is unavailable,
 * drop that plugin entry and keep specialists. Do NOT fall back to
 * codeagent-wrapper (avoids re-establishing the dependency v3.0 retired).
 */
export function planChallengerSpawns(input: ChallengeInput): ChallengerPlan {
  if (!input.critical) {
    return {
      skipped: true,
      skipReason: 'phase not Critical (Critical: false or unset)',
      spawns: [],
      degraded: false,
    }
  }

  const desired = desiredAgentsForType(input.phaseType)
  const spawns: SpawnEntry[] = []
  const dropped: PluginAdvisor[] = []

  for (const agent of desired) {
    if (agent === 'codex:codex-rescue' && !input.plugins.codex) {
      dropped.push(agent)
      continue
    }
    if (agent === 'gemini:gemini-rescue' && !input.plugins.gemini) {
      dropped.push(agent)
      continue
    }
    spawns.push({
      agent,
      adversarial: true,
      rationale: rationaleFor(agent, input.phaseType),
    })
  }

  const degraded = dropped.length > 0
  return {
    skipped: false,
    spawns,
    degraded,
    degradeNote: degraded
      ? `plugin(s) unavailable, dropped: ${dropped.join(', ')}; specialists only`
      : undefined,
  }
}

function desiredAgentsForType(type: Layer): ChallengerAgent[] {
  switch (type) {
    case 'backend':
      return ['codex:codex-rescue', 'assumptions-analyzer']
    case 'frontend':
      return ['gemini:gemini-rescue', 'nyquist-auditor']
    case 'fullstack':
      return [
        'codex:codex-rescue',
        'gemini:gemini-rescue',
        'assumptions-analyzer',
        'nyquist-auditor',
      ]
    case 'docs':
    case 'generic':
      return ['assumptions-analyzer']
  }
}

function rationaleFor(agent: ChallengerAgent, type: Layer): string {
  switch (agent) {
    case 'codex:codex-rescue':
      return `backend logic adversarial review (${type})`
    case 'gemini:gemini-rescue':
      return `frontend/UX adversarial review (${type})`
    case 'assumptions-analyzer':
      return 'plan assumption audit (CCG specialist)'
    case 'nyquist-auditor':
      return 'boundary / edge-case deep audit (CCG specialist)'
  }
}

// ---------------------------------------------------------------------------
// 3. Summary parsing
// ---------------------------------------------------------------------------

/**
 * Parse a challenger's ≤200-token structured summary.
 *
 * Lenient: missing FINDINGS line → empty array; malformed JSON-ish list →
 * best-effort extraction of `severity:critical|major|info` substrings.
 *
 * Throws only when `STATUS` is missing or unrecognized — that signals a
 * bug in the challenger agent contract, not a bad phase.
 */
export function parseChallengerSummary(
  agent: ChallengerAgent,
  text: string,
): ChallengerSummary {
  const get = (key: string): string | null => {
    const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'mi')
    const m = text.match(re)
    return m ? m[1].trim() : null
  }

  const statusRaw = get('STATUS')
  if (!statusRaw) {
    throw new Error(`challenger ${agent} summary missing required STATUS field`)
  }
  const statusLower = statusRaw.toLowerCase().split(/\s+/)[0]
  const status: 'complete' | 'error' =
    statusLower === 'complete' || statusLower === 'completed'
      ? 'complete'
      : statusLower === 'error' || statusLower === 'failed'
        ? 'error'
        : (() => {
          throw new Error(
            `challenger ${agent} summary STATUS=${statusRaw} not one of complete|error`,
          )
        })()

  const findingsRaw = get('FINDINGS')
  const findings = findingsRaw ? parseFindings(findingsRaw) : []

  const notes = get('NOTES') ?? ''

  return { agent, status, findings, notes, raw: text }
}

/**
 * Parse a FINDINGS field value into structured Finding[].
 *
 * v4.2 P21 鲁棒化（acceptance c）：
 *
 *   1. Strip ```json``` 围栏（codex/gemini plugin 经常把 JSON 用三反引号包裹）
 *   2. JSON.parse 优先；成功 + 是数组 → normalizeFinding 走完
 *   3. JSON 失败 → 单引号 → 双引号 normalize 重试
 *   4. 仍失败 → balanced-bracket tokenizer 切分顶层对象
 *      （正则 `/\{[^}]*\}/` 不支持嵌套 `{}` in message 字段，必须字符级匹配）
 *   5. 每个块再按 severity/category/message 字段抽取（regex 容错单/双引号）
 *
 * 不引入新依赖（acceptance contract）；纯 Node 内建。
 */
function parseFindings(raw: string): Finding[] {
  let trimmed = stripJsonFence(raw.trim())

  // 1. 严格 JSON
  const direct = tryParseJsonArray(trimmed)
  if (direct !== null) return direct

  // 2. 单引号 → 双引号 normalize 后再试
  // 注意：仅替换裸单引号；不破坏字符串内容（best-effort，下面 balanced 切分仍兜底）
  const normalized = normalizeQuotes(trimmed)
  const secondTry = tryParseJsonArray(normalized)
  if (secondTry !== null) return secondTry

  // 3. balanced-bracket tokenizer：手动切分顶层 `{...}`，
  //    在 message 字段含嵌套 `{}` 或 `},` 等情况时仍能正确边界识别。
  const blocks = splitTopLevelObjects(trimmed)
  const findings: Finding[] = []
  for (const block of blocks) {
    // 单块再尝试 JSON 解析（修了引号或天然标准）
    const parsedSingle = tryParseJsonObject(stripJsonFence(block)) ??
      tryParseJsonObject(normalizeQuotes(block))
    if (parsedSingle) {
      const f = normalizeFinding(parsedSingle)
      if (f) findings.push(f)
      continue
    }
    // 退到 regex 抽取（仅作最后一道保险）
    const f = extractFindingViaRegex(block)
    if (f) findings.push(f)
  }
  return findings
}

/** 去掉 ```json ... ``` 围栏（兼容大小写、可有可无 lang 标识） */
function stripJsonFence(s: string): string {
  const m = s.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/)
  if (m) return m[1].trim()
  // 单行 ``` 包裹也支持
  const inline = s.match(/^```\s*([\s\S]*?)\s*```$/)
  if (inline) return inline[1].trim()
  return s
}

/** 尝试 JSON.parse 成 array → Finding[]，失败返回 null */
function tryParseJsonArray(s: string): Finding[] | null {
  if (!s.startsWith('[')) return null
  try {
    const parsed = JSON.parse(s)
    if (Array.isArray(parsed)) {
      return parsed
        .map(normalizeFinding)
        .filter((f): f is Finding => f !== null)
    }
  } catch {
    // ignore
  }
  return null
}

function tryParseJsonObject(s: string): Record<string, unknown> | null {
  const t = s.trim()
  if (!t.startsWith('{')) return null
  try {
    const v = JSON.parse(t)
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * 单引号 → 双引号 normalize（best-effort）。
 * 仅在键名 / 简单字符串值场景安全；复杂转义场景可能错。
 * 调用方在失败时 fall back 到 balanced 切分，不依赖此函数完全正确。
 */
function normalizeQuotes(s: string): string {
  // 替换裸单引号为双引号；不处理转义（best-effort）
  // 同时给无引号的键加引号：{severity: x} → {"severity": x}
  let out = s.replace(/'/g, '"')
  // 给 {key: ...} 模式的裸键名加引号
  out = out.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
  return out
}

/**
 * 字符级 balanced-bracket tokenizer。
 * 在顶层 `[` 内逐个抽出平衡的 `{...}` 块；忽略字符串内的 `{` `}`。
 *
 * 输入示例（嵌套 message）：
 *   `[{severity:"critical", message:"err in {x: 1}"}, {severity:"info"}]`
 * 输出：
 *   ['{severity:"critical", message:"err in {x: 1}"}', '{severity:"info"}']
 */
function splitTopLevelObjects(raw: string): string[] {
  const out: string[] = []
  let depth = 0
  let inString: '"' | "'" | null = null
  let escape = false
  let start = -1

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (escape) { escape = false; continue }
    if (inString) {
      if (ch === '\\') { escape = true; continue }
      if (ch === inString) inString = null
      continue
    }
    if (ch === '"' || ch === "'") {
      inString = ch
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        out.push(raw.slice(start, i + 1))
        start = -1
      }
    }
  }
  return out
}

/** 单块 regex 抽取兜底（balanced 切出来的块仍 JSON.parse 失败时用） */
function extractFindingViaRegex(block: string): Finding | null {
  const sev = block.match(/severity\s*:\s*['"]?(critical|major|info)['"]?/i)?.[1]?.toLowerCase()
  if (!sev) return null
  const cat = block.match(/category\s*:\s*['"]?([^,'"}\s]+)/i)?.[1] ?? 'unknown'
  const msg = block.match(/message\s*:\s*['"]([^'"]*)['"]/i)?.[1]
    ?? block.match(/message\s*:\s*([^,}]+)/i)?.[1]?.trim()
    ?? ''
  return {
    severity: sev as FindingSeverity,
    category: cat.trim(),
    message: msg.trim(),
  }
}

function normalizeFinding(raw: unknown): Finding | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const sev = String(r.severity ?? '').toLowerCase() as FindingSeverity
  if (!['critical', 'major', 'info'].includes(sev)) return null
  return {
    severity: sev,
    category: String(r.category ?? 'unknown').trim(),
    message: String(r.message ?? '').trim(),
  }
}

// ---------------------------------------------------------------------------
// 4. Decision synthesis (acceptance e mock cases)
// ---------------------------------------------------------------------------

/**
 * Decide what main thread does after collecting all challenger summaries.
 *
 *   any critical finding → revise (one revision round; caller enforces cap)
 *   no critical, all complete → advance
 *   any error status → escalate (AskUserQuestion)
 */
export function decideFromSummaries(
  summaries: ChallengerSummary[],
): ChallengerDecision {
  if (summaries.length === 0) return 'advance'

  const hasError = summaries.some(s => s.status === 'error')
  if (hasError) return 'escalate'

  const hasCritical = summaries.some(s =>
    s.findings.some(f => f.severity === 'critical'),
  )
  if (hasCritical) return 'revise'

  return 'advance'
}

/**
 * Synthesize critical findings across all challengers into a single
 * feedback block to inject into the implementer's revision prompt.
 *
 * Returns a markdown string suitable for embedding in the phase-runner
 * spawn prompt's `phase_acceptance` extension.
 */
export function synthesizeRevisionFeedback(
  summaries: ChallengerSummary[],
): string {
  const critical = summaries.flatMap(s =>
    s.findings
      .filter(f => f.severity === 'critical')
      .map(f => ({ from: s.agent, ...f })),
  )
  if (critical.length === 0) return ''

  const lines = [
    '## Challenger 反馈（critical 必修）',
    '',
    '本 phase 标记 Critical=true，下列 critical findings 必须在修订轮处理：',
    '',
    ...critical.map((c, i) =>
      `${i + 1}. [${c.from}] (${c.category}) ${c.message}`,
    ),
    '',
    '修订要求：仅修复上述 critical 项，不重做整个 phase；保留原 commit 历史。',
  ]
  return lines.join('\n')
}
