/**
 * Debate Orchestrator (CCG v4.1 Phase 17).
 *
 * `/ccg:debate <topic>` 主线编排原语：A↔B 多轮对辩
 * （codex propose ↔ gemini challenge ↔ codex respond），cap N 轮
 * 或 challenger 自报 "no critical" 即停。
 *
 * 设计原则（与 v4.1 phase-context / wave-scheduler / specialist-router 一致）：
 *   - 纯函数；不读文件系统、不 spawn 子进程
 *   - 输入主题 + options，输出 round-by-round 计划（由主线消费）
 *   - 跨平台：无路径假设
 *   - 失败用 throw + 明确错误信息（非法 layer / max-rounds）
 *
 * 调用方：
 *   - `templates/commands/debate.md` Step 1（解析 layer / 构造 round 计划）
 *   - `templates/commands/debate.md` Step 2-N（每轮 spawn 后解析摘要）
 *   - `templates/commands/debate.md` Step convergence（判定 shouldStop）
 *
 * 不做：
 *   - 不实际 spawn Agent（主线 LLM 职责，helper 仅给计划）
 *   - 不写文件
 *   - 不读 plugin 状态（plugin 缺失检测在主线）
 */

// ---------------------------------------------------------------------------
// 1. Schema
// ---------------------------------------------------------------------------

// v4.2 P21: layer / model 收敛到 multi-model-routing SSoT
import type { Layer } from './multi-model-routing'

/**
 * 对辩 layer：决定 propose / challenge 角色分配。
 * SSoT `Layer` 5 项中 debate-orchestrator 仅消费 backend/frontend/fullstack。
 */
export type DebateLayer = Extract<Layer, 'backend' | 'frontend' | 'fullstack'>

/** 单轮在对辩里的位置 */
export type DebateRoundKind = 'propose' | 'challenge' | 'respond'

/**
 * 底层模型选择。`general-purpose` 表示降级到 CCG 自家 prompt 模板。
 * v4.2 P21 起继承自 multi-model-routing SSoT 的 Model union（取 codex/gemini/general-purpose 子集）。
 */
export type DebateModel = 'codex' | 'gemini' | 'general-purpose'

/** 触发降级原因 */
export type DebateFallbackReason = 'plugin-missing' | 'parse-failed' | null

export interface DebateOptions {
  /** 最大轮数，默认 3 */
  maxRounds?: number
  /** layer 决定 propose 角色：backend → codex / frontend → gemini / fullstack → both */
  layer?: DebateLayer
  /**
   * Plugin 可用性。主线在 spawn 前检测，传入此字段。
   * - 默认 { codex: true, gemini: true }
   * - 任一为 false 时该模型降级到 general-purpose + CCG prompt 模板
   */
  pluginsAvailable?: { codex?: boolean; gemini?: boolean }
}

export interface DebateRoundPlan {
  /** 1-indexed 轮序号 */
  round: number
  /** 本轮在对辩里的角色 */
  kind: DebateRoundKind
  /**
   * 本轮要 spawn 的模型清单。fullstack × propose 时返回 [codex, gemini]
   * 双 propose；其他场景返回单元素数组。
   */
  models: DebateModel[]
  /**
   * 每个 model 对应的 plugin subagent_type；general-purpose 时为 null
   * 主线降级到内嵌 CCG prompt 模板。
   */
  pluginSubagent: (string | null)[]
  /**
   * 每个 model 对应的 CCG prompt 文件相对路径（用于降级或参考），
   * 例如 `~/.claude/.ccg/prompts/codex/architect.md`。
   */
  ccgPromptFiles: string[]
  /** 是否是降级路径（plugin 缺失） */
  fallback: DebateFallbackReason
}

export interface RoundSummary {
  /** 主线提取自 subagent ≤200 token 摘要的 propose / challenge / respond 字段 */
  propose?: string
  challenge?: string
  respond?: string
  /** 摘要中 NOTES 字段原文（用于收敛判定） */
  notes?: string
  /** 该摘要文本长度（字符）— shouldStop 用作长度变化判定 */
  length: number
  /** 解析是否成功；缺字段不抛错，失败标 false 让主线兜底"未达成共识" */
  parsed: boolean
}

// ---------------------------------------------------------------------------
// 2. Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ROUNDS = 3
const HARD_MAX_ROUNDS = 10  // 防止编排器被滥用，硬上限
const LENGTH_DELTA_THRESHOLD = 0.2  // 收敛信号 #2：相邻两轮长度变化 < 20%

/** challenger 自报"无 critical"的关键词列表（大小写不敏感） */
const NO_CRITICAL_PATTERNS = [
  'no critical issue',
  'no critical issues',
  'no critical',
  'agreement reached',
  'agreed',
  'lgtm',
  '无 critical',
  '无critical',
  '无重大问题',
  '达成共识',
]

// ---------------------------------------------------------------------------
// 3. Round-plan state machine（纯函数，无副作用）
// ---------------------------------------------------------------------------

/**
 * 给定 layer + options 返回 round-by-round 计划。**不 spawn**，由主线消费。
 *
 * 协议（v4.1 Phase 17 acceptance a）：
 *   - Round 1: propose       — backend→codex / frontend→gemini / fullstack→[codex,gemini]
 *   - Round 2: challenge     — backend→gemini / frontend→codex / fullstack→[codex,gemini]
 *   - Round 3: respond       — 同 Round 1 propose 模型
 *   - Round N (N>3): cap 在 maxRounds，多余轮被截断
 *
 * pluginsAvailable.codex / .gemini 为 false 时，该轮 model 替换为
 * `general-purpose`，保留 ccgPromptFiles 以便主线内嵌 CCG prompt 模板。
 */
export function debateStateMachine(
  topic: string,
  options: DebateOptions = {},
): DebateRoundPlan[] {
  if (typeof topic !== 'string' || topic.trim().length === 0) {
    throw new Error('debateStateMachine: topic must be a non-empty string')
  }

  const layer: DebateLayer = options.layer ?? 'backend'
  if (!['backend', 'frontend', 'fullstack'].includes(layer)) {
    throw new Error(`debateStateMachine: invalid layer "${layer}"`)
  }

  const maxRounds = clampRounds(options.maxRounds ?? DEFAULT_MAX_ROUNDS)
  const plugins = {
    codex: options.pluginsAvailable?.codex ?? true,
    gemini: options.pluginsAvailable?.gemini ?? true,
  }

  // Round-kind sequence：propose, challenge, respond, propose, challenge, respond, ...
  const sequence: DebateRoundKind[] = []
  for (let i = 0; i < maxRounds; i++) {
    const cycle = i % 3
    sequence.push(cycle === 0 ? 'propose' : cycle === 1 ? 'challenge' : 'respond')
  }

  return sequence.map((kind, idx) =>
    buildRoundPlan(idx + 1, kind, layer, plugins),
  )
}

function buildRoundPlan(
  round: number,
  kind: DebateRoundKind,
  layer: DebateLayer,
  plugins: { codex: boolean; gemini: boolean },
): DebateRoundPlan {
  // 解析本轮的"原始模型"（pre-fallback）
  // - propose / respond: backend→codex / frontend→gemini / fullstack→[codex,gemini]
  // - challenge:         backend→gemini / frontend→codex / fullstack→[codex,gemini]
  const proposerSide: ('codex' | 'gemini')[] =
    layer === 'backend' ? ['codex']
      : layer === 'frontend' ? ['gemini']
        : ['codex', 'gemini']
  const challengerSide: ('codex' | 'gemini')[] =
    layer === 'backend' ? ['gemini']
      : layer === 'frontend' ? ['codex']
        : ['codex', 'gemini']

  const rawModels: ('codex' | 'gemini')[] =
    kind === 'challenge' ? challengerSide : proposerSide

  // CCG prompt 文件：propose/respond → architect.md（建设性视角）
  // challenge → reviewer.md（critic / adversarial）
  const promptName = kind === 'challenge' ? 'reviewer.md' : 'architect.md'

  const models: DebateModel[] = []
  const pluginSubagent: (string | null)[] = []
  const ccgPromptFiles: string[] = []
  let fallback: DebateFallbackReason = null

  for (const m of rawModels) {
    const available = plugins[m]
    if (available) {
      models.push(m)
      pluginSubagent.push(m === 'codex' ? 'codex:codex-rescue' : 'gemini:gemini-rescue')
    } else {
      // 降级：plugin 缺失 → general-purpose + CCG prompt 模板
      models.push('general-purpose')
      pluginSubagent.push(null)
      fallback = 'plugin-missing'
    }
    ccgPromptFiles.push(`~/.claude/.ccg/prompts/${m}/${promptName}`)
  }

  return {
    round,
    kind,
    models,
    pluginSubagent,
    ccgPromptFiles,
    fallback,
  }
}

function clampRounds(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1
  if (n > HARD_MAX_ROUNDS) return HARD_MAX_ROUNDS
  return Math.floor(n)
}

// ---------------------------------------------------------------------------
// 4. Round summary parsing — 容错抽取 propose / challenge / respond / NOTES
// ---------------------------------------------------------------------------

/**
 * 解析单个 subagent 返回的 ≤200 token 摘要。容错：缺字段不抛错。
 * 期望格式（与 phase-runner 摘要协议同源）：
 *
 *   STATUS: completed
 *   PROPOSE: <内容>      // 或 CHALLENGE: / RESPOND:
 *   NOTES: <一行关键发现>
 *
 * 兼容大小写 + 中英文冒号。
 */
export function parseRoundSummary(text: string): RoundSummary {
  const length = typeof text === 'string' ? text.length : 0
  const empty: RoundSummary = { length, parsed: false }

  if (typeof text !== 'string' || text.trim().length === 0) {
    return empty
  }

  const propose = extractField(text, ['propose', 'proposal', '提议', '提案'])
  const challenge = extractField(text, ['challenge', 'critique', 'critic', '挑战', '反对'])
  const respond = extractField(text, ['respond', 'response', 'reply', '回应', '答辩'])
  const notes = extractField(text, ['notes', 'note', '备注', '说明'])

  const result: RoundSummary = { length, parsed: false }
  if (propose !== undefined) result.propose = propose
  if (challenge !== undefined) result.challenge = challenge
  if (respond !== undefined) result.respond = respond
  if (notes !== undefined) result.notes = notes

  // 至少抽到一个 propose / challenge / respond / notes 字段视为解析成功
  result.parsed = [propose, challenge, respond, notes].some(v => v !== undefined)
  return result
}

function extractField(text: string, names: string[]): string | undefined {
  for (const name of names) {
    // 行内匹配：<NAME>:<value>，支持英文冒号、中文冒号、大小写
    const re = new RegExp(`^\\s*${escapeRegExp(name)}\\s*[:：]\\s*(.+?)\\s*$`, 'im')
    const m = text.match(re)
    if (m && m[1]) return m[1].trim()
  }
  return undefined
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// 5. Convergence判定 — shouldStop（双信号：B 自报 + 长度变化）
// ---------------------------------------------------------------------------

/**
 * 判定是否应在当前轮后停止对辩。双信号收敛：
 *   1. challenger 自报"无 critical issue / agreement reached" → 立即停止
 *   2. 已达 maxRounds → 强制停止
 *   3. 相邻两轮长度变化 < 20% → 信号信息收敛，停止
 *
 * 调用方语义：在每一轮 subagent 返回后调用，传入到目前为止的所有
 * RoundSummary。返回 true 主线就停止 spawn 下一轮。
 */
export function shouldStop(
  rounds: RoundSummary[],
  maxRounds = DEFAULT_MAX_ROUNDS,
): boolean {
  if (!Array.isArray(rounds) || rounds.length === 0) return false

  // 信号 #1：challenger 自报 "no critical"。检查任一轮的 challenge / notes 字段
  for (const r of rounds) {
    if (containsNoCritical(r.challenge) || containsNoCritical(r.notes)) {
      return true
    }
  }

  // 信号 #2：达到上限
  const cap = clampRounds(maxRounds)
  if (rounds.length >= cap) return true

  // 信号 #3：相邻两轮长度变化 < 20%（至少 2 轮才能比较）
  if (rounds.length >= 2) {
    const last = rounds[rounds.length - 1]
    const prev = rounds[rounds.length - 2]
    if (last.length > 0 && prev.length > 0) {
      const delta = Math.abs(last.length - prev.length) / Math.max(prev.length, 1)
      if (delta < LENGTH_DELTA_THRESHOLD) return true
    }
  }

  return false
}

function containsNoCritical(s: string | undefined): boolean {
  if (typeof s !== 'string' || s.length === 0) return false
  const lower = s.toLowerCase()
  return NO_CRITICAL_PATTERNS.some(p => lower.includes(p.toLowerCase()))
}
