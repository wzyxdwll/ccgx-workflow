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
   *   - codex:codex-rescue    — plugin advisor / verify
   *   - gemini:gemini-rescue  — plugin advisor / verify
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

/** Impl wave: 单 strong model（phase-runner，一致性 > 多样性） */
function buildImplWave(index: number, phase: PhaseMeta): WavePlan {
  return {
    kind: 'impl',
    index,
    spawns: [
      {
        agent: 'phase-runner',
        role: 'implementer',
        rationale: `single strong implementer (${phase.phaseType}); consistency > diversity`,
      },
    ],
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
 *   - fast tier: 单 verify，按 layer 反选（backend phase → gemini verify / 反之）
 *   - triple/debate tier: 双 verify（codex + gemini 并行）
 */
function buildVerifyWave(
  index: number,
  phase: PhaseMeta,
  plugins: PluginAvailability,
  tier: QualityTier,
): WavePlan {
  const vwp = planVerifyWave(tier, phase.phaseType, plugins)
  return verifyWavePlanToWavePlan(vwp, index)
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

  switch (effective) {
    case 'fast':
      // [impl, verify] 2 waves
      waves.push(buildImplWave(waveIdx++, phase))
      waves.push(buildVerifyWave(waveIdx++, phase, plugins, 'fast'))
      break

    case 'triple':
      // [plan, critic, impl, verify] 4 waves
      waves.push(buildPlanWave(waveIdx++, phase, plugins))
      waves.push(buildCriticWave(waveIdx++, phase))
      waves.push(buildImplWave(waveIdx++, phase))
      waves.push(buildVerifyWave(waveIdx++, phase, plugins, 'triple'))
      break

    case 'debate': {
      // [plan, debate-r1, debate-r2, debate-r3, critic, impl, verify] cap 7 waves
      waves.push(buildPlanWave(waveIdx++, phase, plugins))
      for (let r = 1; r <= DEBATE_MAX_ROUNDS; r++) {
        waves.push(buildDebateRound(waveIdx++, r, phase, plugins))
      }
      waves.push(buildCriticWave(waveIdx++, phase))
      waves.push(buildImplWave(waveIdx++, phase))
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
 */
export function buildQualityPlan(
  resolveInput: ResolveInput,
  phase: PhaseMeta,
  plugins: PluginAvailability,
): QualityPlan {
  const { tier, source } = resolveQualityTier({
    cliArgs: resolveInput.cliArgs,
    phaseQuality: phase.quality ?? resolveInput.phaseQuality,
  })
  const planResult = planWavesForTier(tier, phase, plugins)
  return {
    tier,
    source,
    waves: planResult.waves,
    degraded: planResult.degraded,
    degradedTo: planResult.degradedTo,
    degradeNote: planResult.degradeNote,
  }
}
