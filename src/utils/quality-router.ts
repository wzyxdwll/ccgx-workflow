/**
 * Quality Tier Router (CCG v4.2 Phase 22).
 *
 * v4.2 旗舰能力：把 v4.1 单波 phase-runner 调度扩展为**三档分级**：
 *
 *   - `--quality=fast`   — v4.1 单波 + 1 路 verify（壁钟 +30%，质量 6.5→7.5）
 *   - `--quality=triple` — Plan-Critic-Verify 三段式（默认；4 wave；壁钟 +60-90%，质量→8.5）
 *   - `--quality=debate` — triple + codex↔gemini 多轮对辩（壁钟 +100-150%，质量→9）
 *
 * 设计哲学（基于市面 SOTA Plan-Critic-Verify 实测）：
 *   - Plan 阶段 lateral diversity（codex+gemini+claude 3 路并行）
 *   - Critic 阶段 angle-based 不是 model-based（assumptions-analyzer + nyquist-auditor）
 *   - Implementer 单 strong model（一致性 > 多样性，phase-runner 全权 Bash）
 *   - Verify cross-vendor（codex+gemini 抓 race / commit drift / 半成品）
 *
 * 设计原则（与 v4.1 challenger-orchestrator / specialist-router 一致）：
 *   - 纯函数；不读文件、不 spawn 子进程
 *   - 输入 quality flag + phase 元数据 + plugin 可用性，输出 wave 计划
 *   - 失败用 throw + 明确错误信息（非法 tier）
 *   - 类型全部从 multi-model-routing SSoT 导入
 *
 * 调用方：
 *   - templates/commands/autonomous.md Step 4.0（解析 quality flag → wave 计划）
 *
 * 不做：
 *   - 不实际 spawn Agent（主线 LLM 职责）
 *   - 不读 plugin 状态（plugin-detection.ts 职责）
 *   - 不写 roadmap.md / SUMMARY.md
 */

import type { Layer, PluginAvailability } from './multi-model-routing'
import { planVerifyWave, type VerifyWavePlan } from './verify-orchestrator'

// ---------------------------------------------------------------------------
// 1. Schema
// ---------------------------------------------------------------------------

/** Quality tier 三档 */
export type QualityTier = 'fast' | 'triple' | 'debate'

/** Wave 类型：plan / critic / impl / verify / debate（仅 debate 模式） */
export type WaveKind = 'plan' | 'critic' | 'impl' | 'verify' | 'debate'

/**
 * 单个 spawn entry。复用 challenger-orchestrator 的 SpawnEntry 概念但本模块
 * 不强依赖那边的 ChallengerAgent union——quality-router 还要 spawn
 * phase-runner / claude opus 等非 challenger 角色，所以用更宽松的 string union。
 */
export interface SpawnEntry {
  /**
   * 要 spawn 的 subagent_type。
   *   - phase-runner          — implementer
   *   - codex:codex-rescue    — plugin advisor / verify (Agent subagent_type, double-prefix)
   *   - gemini:gemini-rescue  — plugin advisor / verify (Agent subagent_type, double-prefix)
   *   - assumptions-analyzer  — critic specialist
   *   - nyquist-auditor       — critic specialist
   *   - general-purpose       — 降级到 main-thread Claude（含 ccgPromptFile 引用）
   */
  agent: string
  /** 调用风格：建设性 / 对抗性 / 校验性 */
  role: 'planner' | 'critic' | 'implementer' | 'verifier' | 'debater'
  /** 一句话给主线展示的理由 */
  rationale: string
  /** 当 agent='general-purpose' 时引用的 CCG prompt 模板路径（降级路径） */
  ccgPromptFile?: string
  /**
   * v4.4.2 verify wave 字段透传（来自 verify-orchestrator.VerifySpawnEntry）：
   * 'bash-direct' 走 Bash 直调 plugin script 跳过 sonnet wrapper（消除 silent
   * fallback），'agent' 走传统 Agent spawn。仅 verify wave 当前使用，其他 wave
   * 字段保持 undefined。
   */
  invocationMode?: 'agent' | 'bash-direct'
  /**
   * v4.4.2: 当 invocationMode='bash-direct' 时，主线 Bash 工具消费的命令模板
   * （含 `<PROMPT>` 占位）。来自 verify-orchestrator.buildBashDirectCommand。
   */
  bashCommand?: string
}

/**
 * 一个 wave 的执行计划。多 wave 顺序执行；wave 内 spawns 并行。
 */
export interface WavePlan {
  kind: WaveKind
  /** 1-indexed wave 序号（仅 debate 子 wave 用 round 表达） */
  index: number
  spawns: SpawnEntry[]
  /** debate 子 wave 才有：当前是第几轮（1..N） */
  round?: number
  /** 该 wave 是否因 plugin 缺失走了降级 */
  degraded: boolean
  /** 降级原因（仅 degraded=true 时填） */
  degradeNote?: string
}

/** Phase 元数据子集（quality-router 只关心这几个字段） */
export interface PhaseMeta {
  phaseId: string
  /** Layer 字段，参考 phase frontmatter `Type` */
  phaseType: Layer
  /**
   * Phase 自带 quality override（roadmap.md frontmatter `Quality:` 字段）。
   * 若设置，优先级高于全局 --quality flag。
   */
  quality?: QualityTier
  /**
   * v4.5 P1a: phase-runner CLI subprocess 调用所需的额外字段。
   * - `workdir`: subprocess 的 cwd（必含 D5 决策；默认空时 helper 会 fallback 到 `<WORKDIR>` 占位符）
   * - `jobId`: 用于 stream-json 落盘 `.context/jobs/<jobId>/progress.jsonl`
   * 仅在 `useDirectBashInvocation=true` 路径生效；不影响 verify wave / Agent spawn。
   */
  workdir?: string
  jobId?: string
  /**
   * v4.5 P1f: phase frontmatter `nested_rescue: true|false` override。
   * 若设置，优先级高于全局 --nested CLI flag。phase-runner prompt 注入路径
   * 参见 `resolveNestedRescue()`。
   */
  nestedRescue?: boolean
}

/** 解析 --quality=<tier> flag 的输入 */
export interface ResolveInput {
  /** Raw CLI args 字符串（包含 `--quality=...`），可空 */
  cliArgs?: string
  /** Phase frontmatter `Quality:` 字段（若解析到） */
  phaseQuality?: QualityTier
}

/** 路由完整结果（含降级摘要） */
export interface QualityPlan {
  tier: QualityTier
  /** 实际使用的 tier（resolveQualityTier 返回值，phase 优先 > flag > 默认） */
  source: 'phase-override' | 'cli-flag' | 'default'
  waves: WavePlan[]
  /** 是否因 plugin 缺失整体降级到更低 tier */
  degraded: boolean
  /** 实际降级到的目标 tier（degraded=true 时填） */
  degradedTo?: QualityTier
  degradeNote?: string
}

// ---------------------------------------------------------------------------
// 2. Constants
// ---------------------------------------------------------------------------

const ALL_TIERS: readonly QualityTier[] = ['fast', 'triple', 'debate'] as const

/** debate 模式硬上限轮数（与 debate-orchestrator 默认一致） */
const DEBATE_MAX_ROUNDS = 3

// CCG prompt 模板路径模板（plugin 缺失降级用）
const CCG_PROMPT_BASE = '~/.claude/.ccg/prompts'

// ---------------------------------------------------------------------------
// 3. resolveQualityTier — flag/phase override 解析
// ---------------------------------------------------------------------------

function isQualityTier(v: unknown): v is QualityTier {
  return typeof v === 'string' && (ALL_TIERS as readonly string[]).includes(v)
}

/**
 * 解析 --quality=<tier> CLI flag。容错：未提供或非法值返回 null。
 */
export function parseQualityFlag(args: string | undefined): QualityTier | null {
  if (typeof args !== 'string' || args.length === 0) return null
  const m = args.match(/--quality[=\s]+([a-z]+)/i)
  if (!m) return null
  const candidate = m[1].toLowerCase()
  return isQualityTier(candidate) ? candidate : null
}

/**
 * 综合 phase override / cli flag / 默认值确定 quality tier。
 *
 * 优先级（高 → 低）：
 *   1. phase frontmatter `Quality:` 字段（roadmap.md 单 phase 覆盖）
 *   2. `--quality=<tier>` CLI flag
 *   3. 默认 `triple`
 */
export function resolveQualityTier(input: ResolveInput): {
  tier: QualityTier
  source: 'phase-override' | 'cli-flag' | 'default'
} {
  if (input.phaseQuality && isQualityTier(input.phaseQuality)) {
    return { tier: input.phaseQuality, source: 'phase-override' }
  }
  const flag = parseQualityFlag(input.cliArgs)
  if (flag) {
    return { tier: flag, source: 'cli-flag' }
  }
  return { tier: 'triple', source: 'default' }
}

// ---------------------------------------------------------------------------
// 3a. v4.5 P1f — `--nested=on|off` flag 解析 + nestedRescue 优先级
// ---------------------------------------------------------------------------

/**
 * v4.5 P1f resolved nested-rescue mode source (mirror of QualityPlan.source 风格).
 */
export type NestedRescueSource = 'phase-override' | 'cli-flag' | 'default'

/** `--nested=on|off` 解析输入 */
export interface ResolveNestedInput {
  /** Raw CLI args 字符串（可包含 `--nested=on/off`） */
  cliArgs?: string
  /** Phase frontmatter `nested_rescue: true|false` */
  phaseNestedRescue?: boolean
}

/**
 * 解析 `--nested=on|off` CLI flag。容错：未提供 / 非法值返回 null。
 * 接受 `on / off / true / false`（大小写不敏感）。
 */
export function parseNestedFlag(args: string | undefined): boolean | null {
  if (typeof args !== 'string' || args.length === 0) return null
  const m = args.match(/--nested[=\s]+([a-z]+)/i)
  if (!m) return null
  const v = m[1].toLowerCase()
  if (v === 'on' || v === 'true') return true
  if (v === 'off' || v === 'false') return false
  return null
}

/**
 * 综合 phase override / cli flag / 默认值确定 nested rescue 启用状态。
 *
 * 优先级（高 → 低）：
 *   1. phase frontmatter `nested_rescue:` 字段（roadmap.md 单 phase 覆盖）
 *   2. `--nested=on|off` CLI flag
 *   3. 默认 `false`（保守：与 v4.5 v1 保守路线 100% 等价）
 */
export function resolveNestedRescue(input: ResolveNestedInput): {
  enabled: boolean
  source: NestedRescueSource
} {
  if (typeof input.phaseNestedRescue === 'boolean') {
    return { enabled: input.phaseNestedRescue, source: 'phase-override' }
  }
  const flag = parseNestedFlag(input.cliArgs)
  if (flag !== null) {
    return { enabled: flag, source: 'cli-flag' }
  }
  return { enabled: false, source: 'default' }
}

// ---------------------------------------------------------------------------
// 3b. v4.5 P1a — phase-runner Bash subprocess 命令构造
// ---------------------------------------------------------------------------

/** v4.5 P1a: max-budget 三档（与 PoC D3 决策一致） */
const PHASE_RUNNER_BUDGET_USD: Record<QualityTier, number> = {
  fast: 1.0,
  triple: 2.0,
  debate: 5.0,
}

/**
 * v4.5 P1c (Phase 3): max nested Agent spawns inside a single CLI phase-runner
 * subprocess. Conservative default = 3 (200-500MB/nested zone per codex C1
 * estimate, awaiting full-matrix RSS bench data).
 *
 * Decision Gate G2 (.ccg/poc-v45/nested-rss-bench.md):
 *   - measured slope ≤ 200 MB/nested → can raise to 5
 *   - measured slope 200-500 MB/nested → keep at 3
 *   - measured slope > 500 MB/nested → G2 NO-GO, drop to 0 + Phase 6 推迟 v4.6
 *
 * Consumed by: P1f (Phase 6) gate — phase-runner subprocess refuses nested
 * spawn beyond this cap, falls back to self-implementation for the overflow.
 */
export const MAX_NESTED_PER_PHASE = 3

/**
 * v4.5 P1c (Phase 3): RSS hard ceiling for a single CLI phase-runner subprocess.
 * Beyond this the supervisor (`writeDegradedFlag`) marks the job degraded so
 * phase-runner falls back to self-implementation; nested spawns are vetoed
 * for the rest of the phase.
 *
 * 4 GB chosen as half the typical 8 GB workstation budget — leaves headroom
 * for 4 concurrent outers (worst case 16 GB before degrade triggers anywhere).
 */
export const PHASE_RUNNER_RSS_DEGRADE_MB = 4096

/** Options for `buildPhaseRunnerBashCommand` */
export interface BuildPhaseRunnerBashOptions {
  /** Quality tier，决定 `--max-budget-usd`；缺省 `triple` */
  tier?: QualityTier
  /** override max-budget；优先级高于 tier */
  maxBudgetUsd?: number
  /** subprocess cwd；缺省走 phase.workdir，再缺省占位 `<WORKDIR>` */
  workdir?: string
  /** stream-json 落盘的 job-id；缺省走 phase.jobId，再缺省占位 `<JOB_ID>` */
  jobId?: string
  /** prompt 落盘文件的相对/绝对路径；缺省 `.context/jobs/<jobId>/prompt.txt` */
  promptFile?: string
}

/**
 * 单引号 POSIX shell-escape：把字符串包成 `'...'`，内部 `'` 转为 `'\''`。
 * 用于 `--add-dir` 等带路径或空格的参数；纯字符串拼接，主线 LLM 不需 spawn。
 *
 * Windows path 兼容：保留原始字符（含 `\`）；调用者负责传 git-bash / WSL 风格
 * 的路径或 Windows 字面值；shell 直接展开为字面字符串，不解释反斜杠。
 */
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * v4.5 P1a: 构造 `claude -p --agent ccg/phase-runner` Bash 命令字符串。
 *
 * 输出符合 PoC D1-D8 全部决策：
 *   - `--output-format stream-json` AND `--verbose`（D1，T4 隐藏依赖）
 *   - `--include-partial-messages`（D2，token 级流式）
 *   - `--max-budget-usd <N>`（D3，三档 fast=1.0/triple=2.0/debate=5.0）
 *   - `--dangerously-skip-permissions`（D4，子进程全自治）
 *   - `--add-dir <workdir>`（D5，subprocess cwd = phase workdir）
 *   - stdout 重定向到 `.context/jobs/<job-id>/progress.jsonl`（D6）
 *   - prompt 通过 `$(cat <prompt-file>)` 注入避免命令行特殊字符 escape 难题
 *
 * 设计：纯字符串 helper，不 spawn child_process；主线 LLM 调 Bash tool 实际跑。
 *
 * @param phase phase 元数据（用 phaseId / phaseType / workdir / jobId）
 * @param promptText  prompt 内容（暂未使用，由调用方写到 promptFile，留作未来 inline 模式）
 * @param jobId  job-id（重定向 stream-json 落盘）；optional，缺省读 phase.jobId 或占位
 * @param options 其他 override
 * @returns Bash 命令字符串，可直接 `Bash(cmd)` 跑（含 `> ... 2>&1`）
 *
 * @example
 *   buildPhaseRunnerBashCommand(
 *     { phaseId: 'phase-1', phaseType: 'backend', workdir: '/d/repo' },
 *     'phase prompt body',
 *     'job-abc123',
 *   )
 *   // → claude -p "$(cat .context/jobs/job-abc123/prompt.txt)" \
 *   //     --agent ccg/phase-runner --output-format stream-json --verbose \
 *   //     --include-partial-messages --max-budget-usd 2.0 \
 *   //     --dangerously-skip-permissions --add-dir '/d/repo' \
 *   //     > .context/jobs/job-abc123/progress.jsonl 2>&1
 */
export function buildPhaseRunnerBashCommand(
  phase: PhaseMeta,
  _promptText: string,
  jobId?: string,
  options: BuildPhaseRunnerBashOptions = {},
): string {
  const tier = options.tier ?? phase.quality ?? 'triple'
  if (!isQualityTier(tier)) {
    throw new Error(`buildPhaseRunnerBashCommand: invalid tier "${tier}"`)
  }

  const budget = options.maxBudgetUsd ?? PHASE_RUNNER_BUDGET_USD[tier]
  if (typeof budget !== 'number' || budget <= 0 || !Number.isFinite(budget)) {
    throw new Error(`buildPhaseRunnerBashCommand: invalid maxBudgetUsd ${budget}`)
  }

  const resolvedJobId = jobId ?? phase.jobId ?? '<JOB_ID>'
  const resolvedWorkdir = options.workdir ?? phase.workdir ?? '<WORKDIR>'
  const promptFile = options.promptFile ?? `.context/jobs/${resolvedJobId}/prompt.txt`
  const progressFile = `.context/jobs/${resolvedJobId}/progress.jsonl`

  // budget formatted with up to 4 decimals trimmed
  const budgetStr = String(Number(budget.toFixed(4)))

  const parts = [
    `claude -p "$(cat ${shellSingleQuote(promptFile)})"`,
    `--agent ccg/phase-runner`,
    `--output-format stream-json`,
    `--verbose`,
    `--include-partial-messages`,
    `--max-budget-usd ${budgetStr}`,
    `--dangerously-skip-permissions`,
    `--add-dir ${shellSingleQuote(resolvedWorkdir)}`,
    `> ${shellSingleQuote(progressFile)} 2>&1`,
  ]
  return parts.join(' ')
}

/** Options for `buildPhaseRunnerLauncherCommand` (v4.5 P1f) */
export interface BuildPhaseRunnerLauncherOptions {
  /** Quality tier，决定 launcher --tier；缺省 `triple` */
  tier?: QualityTier
  /** override max-budget；优先级高于 tier */
  maxBudgetUsd?: number
  /** subprocess cwd；缺省走 phase.workdir，再缺省占位 `<WORKDIR>` */
  workdir?: string
  /** stream-json 落盘的 job-id；缺省走 phase.jobId，再缺省占位 `<JOB_ID>` */
  jobId?: string
  /** prompt 落盘文件路径；缺省 `.context/jobs/<jobId>/prompt.txt` */
  promptFile?: string
  /**
   * Launcher 安装路径。生产默认 `~/.claude/.ccg/scripts/ccg-phase-runner-launcher.mjs`
   * （installer.ts ship 到此处）。tests/dev workflow 可 override。
   */
  launcherPath?: string
  /** SIGTERM→SIGKILL grace ms；缺省 5000（与 launcher 默认一致） */
  graceMs?: number
}

/** Default launcher install path (installer.ts ships file here) */
export const DEFAULT_LAUNCHER_PATH = '~/.claude/.ccg/scripts/ccg-phase-runner-launcher.mjs'

/**
 * v4.5 P1f: 构造 launcher 包装的 phase-runner spawn 命令。
 *
 * 与 {@link buildPhaseRunnerBashCommand}（裸 `claude -p` 命令）的区别：
 * 此 helper 输出 `node <launcher> --job-id ... --workdir ... --prompt-file ... --tier ...`
 * launcher 在 `templates/scripts/ccg-phase-runner-launcher.mjs` 中实现：
 *   - 写 atomic state.json (含 parent_pid / cli_pid / process_group_id / cwd)
 *   - POSIX setsid / Windows DETACHED_PROCESS（process tree 可 kill）
 *   - 协作 cancel.flag + grace + kill-tree
 *   - terminal state atomic write + reconciler 兼容
 *   - broker tx_id 注入到子进程 env
 *
 * 用于 v4.5 P1f autonomous Step 4.2-4.3 wiring：默认 useDirectBashInvocation=true
 * 时 impl wave spawn 走此 helper 而非裸 `claude -p`，解锁 Phase 2 supervisor 全部能力。
 *
 * @param phase phase 元数据
 * @param options 其他覆盖项（默认 launcherPath、grace、tier 等）
 * @returns Bash 命令字符串，含 `> stdout 2>&1` 重定向
 *
 * @example
 *   buildPhaseRunnerLauncherCommand(
 *     { phaseId: 'phase-6', phaseType: 'backend', workdir: '/d/repo', jobId: 'job-abc' },
 *     { tier: 'triple' },
 *   )
 *   // → node '~/.claude/.ccg/scripts/ccg-phase-runner-launcher.mjs' \
 *   //     --job-id 'job-abc' --workdir '/d/repo' \
 *   //     --prompt-file '.context/jobs/job-abc/prompt.txt' \
 *   //     --tier 'triple' --grace-ms 5000 \
 *   //     > '.context/jobs/job-abc/progress.jsonl' 2>&1
 */
export function buildPhaseRunnerLauncherCommand(
  phase: PhaseMeta,
  options: BuildPhaseRunnerLauncherOptions = {},
): string {
  const tier = options.tier ?? phase.quality ?? 'triple'
  if (!isQualityTier(tier)) {
    throw new Error(`buildPhaseRunnerLauncherCommand: invalid tier "${tier}"`)
  }

  const resolvedJobId = options.jobId ?? phase.jobId ?? '<JOB_ID>'
  const resolvedWorkdir = options.workdir ?? phase.workdir ?? '<WORKDIR>'
  const promptFile = options.promptFile ?? `.context/jobs/${resolvedJobId}/prompt.txt`
  const progressFile = `.context/jobs/${resolvedJobId}/progress.jsonl`
  const launcher = options.launcherPath ?? DEFAULT_LAUNCHER_PATH
  const graceMs = options.graceMs ?? 5000

  const parts = [
    `node ${shellSingleQuote(launcher)}`,
    `--job-id ${shellSingleQuote(resolvedJobId)}`,
    `--workdir ${shellSingleQuote(resolvedWorkdir)}`,
    `--prompt-file ${shellSingleQuote(promptFile)}`,
    `--tier ${shellSingleQuote(tier)}`,
  ]
  if (typeof options.maxBudgetUsd === 'number'
    && Number.isFinite(options.maxBudgetUsd)
    && options.maxBudgetUsd > 0) {
    parts.push(`--max-budget-usd ${String(Number(options.maxBudgetUsd.toFixed(4)))}`)
  }
  parts.push(`--grace-ms ${String(graceMs)}`)
  parts.push(`> ${shellSingleQuote(progressFile)} 2>&1`)

  return parts.join(' ')
}

/**
 * v4.5 P1a: 从 stream-json 落盘文件末行抽取 phase-runner 最终摘要。
 *
 * Claude CLI 在 `--output-format stream-json` 下最后一行是 `{type: 'result', ...}`
 * 事件，含 `result.result` 字符串字段（即 phase-runner 的 ≤200 token SUMMARY）。
 *
 * @param progressJsonl  整个 progress.jsonl 文件内容（多行 ndjson）
 * @returns SUMMARY 字符串；若末行非 result 事件 / 缺字段返回 null（caller fallback）
 *
 * @example
 *   parsePhaseRunnerStreamSummary([
 *     '{"type":"system","subtype":"init"}',
 *     '{"type":"assistant","message":...}',
 *     '{"type":"result","subtype":"success","result":"STATUS: completed\\nCOMMIT: abc1234..."}',
 *   ].join('\n'))
 *   // → "STATUS: completed\nCOMMIT: abc1234..."
 */
export function parsePhaseRunnerStreamSummary(progressJsonl: string): string | null {
  if (typeof progressJsonl !== 'string' || progressJsonl.length === 0) return null
  // 末非空行
  const lines = progressJsonl.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length === 0) return null
  const last = lines[lines.length - 1]
  let parsed: unknown
  try {
    parsed = JSON.parse(last)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (obj.type !== 'result') return null
  const result = obj.result
  return typeof result === 'string' ? result : null
}

// ---------------------------------------------------------------------------
// 4. Plan / Critic / Impl / Verify wave 构造（角色路由）
// ---------------------------------------------------------------------------

/** Plan wave: 3 路 lateral diversity（codex + gemini + claude opus） */
function buildPlanWave(
  index: number,
  phase: PhaseMeta,
  plugins: PluginAvailability,
): WavePlan {
  const spawns: SpawnEntry[] = []
  let degraded = false
  const dropped: string[] = []

  // codex 路：plugin 优先；缺失降级 general-purpose + codex/architect.md
  if (plugins.codex) {
    spawns.push({
      agent: 'codex:codex-rescue',
      role: 'planner',
      rationale: `backend / system-design plan path (${phase.phaseType})`,
    })
  } else {
    spawns.push({
      agent: 'general-purpose',
      role: 'planner',
      rationale: 'codex plugin unavailable — main-thread fallback with codex/architect prompt',
      ccgPromptFile: `${CCG_PROMPT_BASE}/codex/architect.md`,
    })
    degraded = true
    dropped.push('codex:codex-rescue')
  }

  // gemini 路：plugin 优先；缺失降级 general-purpose + gemini/architect.md
  if (plugins.gemini) {
    spawns.push({
      agent: 'gemini:gemini-rescue',
      role: 'planner',
      rationale: `frontend / UX plan path (${phase.phaseType})`,
    })
  } else {
    spawns.push({
      agent: 'general-purpose',
      role: 'planner',
      rationale: 'gemini plugin unavailable — main-thread fallback with gemini/architect prompt',
      ccgPromptFile: `${CCG_PROMPT_BASE}/gemini/architect.md`,
    })
    degraded = true
    dropped.push('gemini:gemini-rescue')
  }

  // claude opus 路：主线模型，无外部 prompt（lateral diversity 第三视角）
  spawns.push({
    agent: 'general-purpose',
    role: 'planner',
    rationale: 'claude opus 3rd-perspective plan (lateral diversity)',
    ccgPromptFile: `${CCG_PROMPT_BASE}/claude/architect.md`,
  })

  return {
    kind: 'plan',
    index,
    spawns,
    degraded,
    degradeNote: degraded
      ? `plan wave plugin(s) unavailable: ${dropped.join(', ')}; fallback to general-purpose`
      : undefined,
  }
}

/** Critic wave: angle-based specialists（assumptions + nyquist），与 Type 解耦 */
function buildCriticWave(index: number, phase: PhaseMeta): WavePlan {
  // angle-based：所有 layer 都跑两个 specialist。CCG 自家 agent 必装，
  // 不做 plugin degradation（参见 challenger-orchestrator acceptance d）。
  const spawns: SpawnEntry[] = [
    {
      agent: 'assumptions-analyzer',
      role: 'critic',
      rationale: `assumption / hidden-dep audit (${phase.phaseType})`,
    },
    {
      agent: 'nyquist-auditor',
      role: 'critic',
      rationale: `boundary / edge-case audit (${phase.phaseType})`,
    },
  ]
  return { kind: 'critic', index, spawns, degraded: false }
}

/**
 * Impl wave: 单 strong model（phase-runner，一致性 > 多样性）。
 *
 * v4.5 P1a: `useDirectBashInvocation=true` 时 spawn entry 标
 * `invocationMode: 'bash-direct'` + 附 `bashCommand`，主线模板渲染为
 * `Bash(claude -p --agent ccg/phase-runner ...)` OS-level 子进程，跳过
 * `Agent(subagent_type="phase-runner")` 主进程 sidechain（治 v4.4.x 主进程
 * RSS leak）。默认 false 保持向后兼容（v4.0~v4.4 Agent spawn 行为）。
 *
 * v4.5 P1f: `useLauncherWiring=true` 时 bashCommand 由
 * {@link buildPhaseRunnerLauncherCommand} 生成，用 launcher 包装而非裸 `claude -p`。
 * 解锁 Phase 2 supervisor 全部能力（atomic state / process-tree / kill-tree）。
 * 仅在 useDirectBashInvocation=true 时生效。
 */
function buildImplWave(
  index: number,
  phase: PhaseMeta,
  options: {
    useDirectBashInvocation?: boolean
    useLauncherWiring?: boolean
    tier?: QualityTier
  } = {},
): WavePlan {
  const useBashDirect = options.useDirectBashInvocation === true
  const useLauncher = useBashDirect && options.useLauncherWiring === true
  const entry: SpawnEntry = {
    agent: 'phase-runner',
    role: 'implementer',
    rationale: `single strong implementer (${phase.phaseType}); consistency > diversity`,
  }
  if (useBashDirect) {
    entry.invocationMode = 'bash-direct'
    if (useLauncher) {
      // P1f: launcher wiring — supervisor 包装路径（默认开启）
      entry.bashCommand = buildPhaseRunnerLauncherCommand(phase, {
        tier: options.tier,
      })
    } else {
      // P1a 裸 claude -p 路径（test BC + 显式 opt-out launcher 时使用）
      entry.bashCommand = buildPhaseRunnerBashCommand(phase, '', phase.jobId, {
        tier: options.tier,
      })
    }
  }
  // 不显式设 invocationMode='agent' —— 保 v4.4 前 schema BC（既有 test 断言
  // non-verify wave spawn entry 的 invocationMode 字段为 undefined）
  return {
    kind: 'impl',
    index,
    spawns: [entry],
    degraded: false,
  }
}

/**
 * Adapter: VerifyWavePlan (verify-orchestrator schema) → WavePlan
 * (quality-router schema). Internal helper, not exported.
 *
 * verify-orchestrator 的 VerifyWavePlan 用 `mode: 'single'|'dual'` + 极简
 * spawns（无 role）。quality-router 的 WavePlan 用 `kind: WaveKind` + role-tagged
 * SpawnEntry。两个 schema 通过此 adapter 桥接，避免在两边各自维护路由实现。
 */
function verifyWavePlanToWavePlan(vwp: VerifyWavePlan, index: number): WavePlan {
  const spawns: SpawnEntry[] = vwp.spawns.map(s => ({
    agent: s.agent,
    role: 'verifier',
    rationale: s.rationale,
    ccgPromptFile: s.ccgPromptFile,
    // v4.4.2: 透传 invocationMode/bashCommand（之前 adapter drop 这两字段，
    // 导致 useDirectBashInvocation 仅对直接调 planVerifyWave 的路径生效；
    // autonomous Step 4.1 走 quality-router 路径时 silent fallback 风险残留）
    invocationMode: s.invocationMode,
    bashCommand: s.bashCommand,
  }))
  return {
    kind: 'verify',
    index,
    spawns,
    degraded: vwp.degraded,
    degradeNote: vwp.degradeNote,
  }
}

/**
 * Verify wave 构造器（quality-router 视角）。
 *
 * **v4.2.1 P24 SSoT 化**：路由实现已下沉到 verify-orchestrator.planVerifyWave；
 * 本函数只做 schema adapter，不再独立实现单/双 verify 逻辑。
 *
 * **v4.3 P27 interface-auditor 集成**：triple/debate 模式的 verify wave 在
 * codex+gemini cross-vendor 之外追加 `interface-auditor` 一路，做跨 phase 接口
 * 审计（SSoT 违反 / 半成品 / magic string vs ground truth / commit-diff drift /
 * mock-drift）。fast 模式不加（fast 优先速度，且单 verify 已能 cross-vendor）。
 *
 *   - fast tier: 单 verify，按 layer 反选（backend phase → gemini verify / 反之）
 *   - triple/debate tier: 双 verify（codex + gemini）+ interface-auditor (3 路并行)
 */
function buildVerifyWave(
  index: number,
  phase: PhaseMeta,
  plugins: PluginAvailability,
  tier: QualityTier,
): WavePlan {
  // v4.4.2: 强制 verify wave 走 Bash 直调（架构性消除 sonnet wrapper silent
  // fallback）。autonomous / quality-router 路径必须显式传此 flag —— 上游
  // planVerifyWave 默认 false 保 BC，此处显式 opt-in 与 templates/commands/
  // review.md 等手写模板的行为对齐。
  const vwp = planVerifyWave(tier, phase.phaseType, plugins, {
    useDirectBashInvocation: true,
  })
  const wavePlan = verifyWavePlanToWavePlan(vwp, index)

  // P27: triple/debate verify wave 追加 interface-auditor specialist。
  // CCG 自家 agent 必装，无 plugin degradation；fast 模式不加。
  if (tier === 'triple' || tier === 'debate') {
    wavePlan.spawns.push({
      agent: 'interface-auditor',
      role: 'verifier',
      rationale: `cross-phase interface audit (${phase.phaseType}; SSoT / leftover / magic-string / commit-drift / mock-drift)`,
    })
  }

  return wavePlan
}

/** Debate sub-wave: 单轮 propose / challenge / respond */
function buildDebateRound(
  index: number,
  round: number,
  phase: PhaseMeta,
  plugins: PluginAvailability,
): WavePlan {
  // round-kind 序列：propose → challenge → respond（与 debate-orchestrator 一致）
  const cycle = (round - 1) % 3
  const kind: 'propose' | 'challenge' | 'respond' =
    cycle === 0 ? 'propose' : cycle === 1 ? 'challenge' : 'respond'

  // 角色分配按 phase layer：
  //   backend  → propose=codex / challenge=gemini
  //   frontend → propose=gemini / challenge=codex
  //   其他     → 双 propose（fullstack/docs/generic 都给 codex+gemini）
  const layer = phase.phaseType
  const proposerSide: ('codex' | 'gemini')[] =
    layer === 'backend' ? ['codex']
      : layer === 'frontend' ? ['gemini']
        : ['codex', 'gemini']
  const challengerSide: ('codex' | 'gemini')[] =
    layer === 'backend' ? ['gemini']
      : layer === 'frontend' ? ['codex']
        : ['codex', 'gemini']

  const rawModels = kind === 'challenge' ? challengerSide : proposerSide
  const promptName = kind === 'challenge' ? 'reviewer.md' : 'architect.md'

  const spawns: SpawnEntry[] = []
  let degraded = false
  const dropped: string[] = []

  for (const m of rawModels) {
    if (plugins[m]) {
      spawns.push({
        agent: `${m}:${m}-rescue`,
        role: 'debater',
        rationale: `debate r${round} ${kind} (${m})`,
      })
    } else {
      spawns.push({
        agent: 'general-purpose',
        role: 'debater',
        rationale: `${m} plugin unavailable — main-thread fallback (debate r${round} ${kind})`,
        ccgPromptFile: `${CCG_PROMPT_BASE}/${m}/${promptName}`,
      })
      degraded = true
      dropped.push(`${m}:${m}-rescue`)
    }
  }

  return {
    kind: 'debate',
    index,
    round,
    spawns,
    degraded,
    degradeNote: degraded
      ? `debate r${round} plugin(s) unavailable: ${dropped.join(', ')}`
      : undefined,
  }
}

// ---------------------------------------------------------------------------
// 5. planWavesForTier — tier 分发与降级
// ---------------------------------------------------------------------------

/** v4.5 P1a: planWavesForTier / buildQualityPlan 选项 */
export interface PlanWavesOptions {
  /**
   * v4.5 P1a: 把 impl wave 的 phase-runner spawn 从 Agent sidechain 改为 Bash
   * 直调 `claude -p --agent ccg/phase-runner ...` OS-level 子进程。同时也会
   * 把 verify wave 的 plugin spawn 切到 bash-direct（v4.4.2 verify 治理）。
   *
   * 默认 false 时：
   *   - impl wave 走 `Agent(subagent_type="phase-runner")`（v4.0~v4.4 行为）
   *   - verify wave 走 Agent spawn（v4.4.1 及以前的 sonnet wrapper 路径）
   *
   * 默认 true（autonomous Step 4.0+ 启用）时：
   *   - impl wave 走 Bash 直调，subprocess RSS 与主进程隔离
   *   - verify wave 走 plugin script 直调，跳过 sonnet wrapper
   */
  useDirectBashInvocation?: boolean
  /**
   * v4.5 P1f: 当 `useDirectBashInvocation=true` 时，用 ccg-phase-runner-launcher.mjs
   * 包装 `claude -p` 调用而非直接裸 spawn。解锁 Phase 2 supervisor 全部能力：
   * atomic state.json / process-tree kill-tree / cancel.flag 协作 / reconciler。
   *
   * autonomous Step 4.2-4.3 默认开启。Test / dev workflow 可关闭走 P1a 裸 spawn 路径。
   * 默认 false 时保持 P1a 裸 `claude -p` BC（v4.5.0 → v4.5.1 升级路径）。
   */
  useLauncherWiring?: boolean
}

/**
 * 给定 tier + phase + plugin 可用性，返回 wave 计划。
 *
 * 降级路径：
 *   - debate → triple：双 plugin 都缺失（debate 失去对辩多样性意义）
 *   - triple → fast：双 plugin 都缺失（plan/verify 双方向都降级到 main-thread）
 *
 * 注意：单 plugin 缺失不触发整体降级——具体 wave 内走 general-purpose
 * fallback（degraded: true）；只有双 plugin 都缺时才整体降阶。
 */
export function planWavesForTier(
  tier: QualityTier,
  phase: PhaseMeta,
  plugins: PluginAvailability,
  options: PlanWavesOptions = {},
): {
  effectiveTier: QualityTier
  waves: WavePlan[]
  degraded: boolean
  degradedTo?: QualityTier
  degradeNote?: string
} {
  if (!isQualityTier(tier)) {
    throw new Error(`planWavesForTier: invalid tier "${tier}"`)
  }

  const bothMissing = !plugins.codex && !plugins.gemini

  // 降级判定
  let effective: QualityTier = tier
  let degradedTo: QualityTier | undefined
  let degradeNote: string | undefined

  if (tier === 'debate' && bothMissing) {
    effective = 'fast'
    degradedTo = 'fast'
    degradeNote = 'debate → fast: both plugins unavailable; debate loses lateral diversity'
  } else if (tier === 'debate' && (!plugins.codex || !plugins.gemini)) {
    effective = 'triple'
    degradedTo = 'triple'
    degradeNote = 'debate → triple: one plugin unavailable; debate needs both for adversarial pairing'
  } else if (tier === 'triple' && bothMissing) {
    effective = 'fast'
    degradedTo = 'fast'
    degradeNote = 'triple → fast: both plugins unavailable; plan/verify diversity collapsed'
  }

  const waves: WavePlan[] = []
  let waveIdx = 1
  const implOpts = {
    useDirectBashInvocation: options.useDirectBashInvocation === true,
    useLauncherWiring: options.useLauncherWiring === true,
    tier: effective,
  }

  switch (effective) {
    case 'fast':
      // [impl, verify] 2 waves
      waves.push(buildImplWave(waveIdx++, phase, implOpts))
      waves.push(buildVerifyWave(waveIdx++, phase, plugins, 'fast'))
      break

    case 'triple':
      // [plan, critic, impl, verify] 4 waves
      waves.push(buildPlanWave(waveIdx++, phase, plugins))
      waves.push(buildCriticWave(waveIdx++, phase))
      waves.push(buildImplWave(waveIdx++, phase, implOpts))
      waves.push(buildVerifyWave(waveIdx++, phase, plugins, 'triple'))
      break

    case 'debate': {
      // [plan, debate-r1, debate-r2, debate-r3, critic, impl, verify] cap 7 waves
      waves.push(buildPlanWave(waveIdx++, phase, plugins))
      for (let r = 1; r <= DEBATE_MAX_ROUNDS; r++) {
        waves.push(buildDebateRound(waveIdx++, r, phase, plugins))
      }
      waves.push(buildCriticWave(waveIdx++, phase))
      waves.push(buildImplWave(waveIdx++, phase, implOpts))
      waves.push(buildVerifyWave(waveIdx++, phase, plugins, 'debate'))
      break
    }
  }

  // 任一 wave degraded → overall degraded（含 wave 级 fallback）
  const anyWaveDegraded = waves.some(w => w.degraded)
  const tierDegraded = degradedTo !== undefined

  return {
    effectiveTier: effective,
    waves,
    degraded: tierDegraded || anyWaveDegraded,
    degradedTo,
    degradeNote,
  }
}

/**
 * One-shot 入口：解析 flag → 算 tier → 构 wave。
 *
 * 主线 autonomous Step 4.0 直接调这个，得到完整执行计划。
 *
 * v4.5 P1a: `options.useDirectBashInvocation=true` 时 impl wave + verify wave
 * 都切到 Bash 直调（subprocess RSS 隔离 + verify wave silent fallback 治理）。
 */
export function buildQualityPlan(
  resolveInput: ResolveInput,
  phase: PhaseMeta,
  plugins: PluginAvailability,
  options: PlanWavesOptions = {},
): QualityPlan {
  const { tier, source } = resolveQualityTier({
    cliArgs: resolveInput.cliArgs,
    phaseQuality: phase.quality ?? resolveInput.phaseQuality,
  })
  const planResult = planWavesForTier(tier, phase, plugins, options)
  return {
    tier,
    source,
    waves: planResult.waves,
    degraded: planResult.degraded,
    degradedTo: planResult.degradedTo,
    degradeNote: planResult.degradeNote,
  }
}
