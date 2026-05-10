/**
 * Verify Orchestrator (CCG v4.2 Phase 22; v4.2.1 Phase 24 — SSoT 化).
 *
 * fast/triple/debate 模式 verify wave 完成后，综合 verify reports 决定主线
 * 后续行为（advance / revise / escalate）。
 *
 * **SSoT 声明 (v4.2.1 P24)**：本模块的 `planVerifyWave()` 是 **verify wave 路由
 * 的权威实现**。`quality-router.ts.buildVerifyWave` 必须 import 本函数后做
 * schema adapter，不得复制实现。任何 verify 路由策略变更只在本文件改。
 *
 * 设计原则：
 *   - 纯函数；不读文件、不 spawn 子进程
 *   - 输入 verify reports（≤200 token 摘要文本），输出决策枚举
 *   - 复用 challenger-orchestrator 的 parseFindings 鲁棒化解析
 *
 * 调用方：
 *   - templates/commands/autonomous.md verify wave 完成后
 *   - quality-router.ts.buildVerifyWave (内部 wrap 成 WavePlan schema)
 *
 * 不做：
 *   - 不实际 spawn verify agent（quality-router 出 spawn 计划，主线 LLM 派发）
 *   - 不修订 phase（修订由主线再 spawn impl wave 完成）
 */

import type { Layer, PluginAvailability } from './multi-model-routing'
import {
  parseChallengerSummary,
  type ChallengerAgent,
  type Finding,
} from './challenger-orchestrator'
import { resolvePluginBashCommand } from './plugin-bash-codegen'

// ---------------------------------------------------------------------------
// 1. Schema
// ---------------------------------------------------------------------------

/** Verify 模式：单 verify (fast) / 双 verify (triple+debate) */
export type VerifyMode = 'single' | 'dual'

/** 单条 verify 摘要解析后的结构 */
export interface VerifyReport {
  /** 哪个 agent 返回的 verify 结果 */
  agent: string
  /** 解析状态 */
  status: 'complete' | 'error'
  /** Critical 级别 findings */
  criticals: Finding[]
  /** Major 级别 findings（参考用，不阻塞推进） */
  majors: Finding[]
  /** Notes 字段 */
  notes: string
  /** 原始文本（debug 用） */
  raw: string
}

/** 主线决策：advance / revise / escalate（与 challenger 一致） */
export type VerifyDecision = 'advance' | 'revise' | 'escalate'

/**
 * 调用方式（v4.4.2 起 verify wave 支持两种）：
 *   - 'agent'       — Agent(subagent_type=...) plugin spawn（含 sonnet wrapper，silent fallback 风险）
 *   - 'bash-direct' — Bash 直调 plugin script（codex-companion.mjs / gemini-companion.mjs）跳过 wrapper
 *
 * v4.4.2 verify wave 默认切到 'bash-direct' 架构性消除 silent contamination。
 * 其他用例（impl/autonomous/debate）仍走 'agent' 保 ≤200 token 摘要预算。
 */
export type VerifyInvocationMode = 'agent' | 'bash-direct'

/** Verify wave spawn entry（与 quality-router 的 SpawnEntry 子集对齐） */
export interface VerifySpawnEntry {
  agent: string
  rationale: string
  /** plugin 缺失走 general-purpose 时引用的 prompt 文件 */
  ccgPromptFile?: string
  /** v4.4.2: 'agent' 走 Agent spawn / 'bash-direct' 走 Bash 直调 plugin script */
  invocationMode?: VerifyInvocationMode
  /**
   * v4.4.2: 当 invocationMode='bash-direct' 时，模板渲染用的 Bash 命令模板。
   * 主线 Bash 工具直接执行此命令，stdout 为 plugin 完整 JSON 响应。
   * Plugin 脚本路径用 glob `~/.claude/plugins/cache/<vendor>/<plugin>/*\/scripts/*-companion.mjs`，
   * 主线消费时按需 ls 解析具体版本号。
   */
  bashCommand?: string
}

/** v4.4.2 planVerifyWave 选项 */
export interface PlanVerifyWaveOptions {
  /**
   * 把所有 plugin spawn entry 切成 'bash-direct' 模式（v4.4.2 verify wave 默认 true）。
   * 仅影响 plugin 路径，general-purpose 降级路径不受影响。
   */
  useDirectBashInvocation?: boolean
}

/** Verify wave 计划输出 */
export interface VerifyWavePlan {
  mode: VerifyMode
  spawns: VerifySpawnEntry[]
  degraded: boolean
  degradeNote?: string
}

// ---------------------------------------------------------------------------
// 2. Constants
// ---------------------------------------------------------------------------

const CCG_PROMPT_BASE = '~/.claude/.ccg/prompts'

// ---------------------------------------------------------------------------
// 3. planVerifyWave — 单/双 verify 路由
// ---------------------------------------------------------------------------

/**
 * 1.0.7: Build Bash command for verify wave plugin invocation.
 *
 * Delegates to `resolvePluginBashCommand()` (plugin-bash-codegen.ts) which
 * emits the helper-form invocation:
 *   node '<ccgx-call-plugin.mjs abs path>' codex --json
 *
 * The LLM consuming this command appends `--prompt-file <tmpfile>` after
 * writing a small task-description prompt body to disk. Helper internally
 * resolves companion path via SSoT (no glob-hack, no head -1, no
 * `<PROMPT>` placeholder) and spawns with array args (no shell escape).
 *
 * Combined with the "task description, not data" pattern (1.0.6 review.md),
 * this avoids both:
 *   - LLM cargo-culting glob-hack patterns (1.0.4 dogfood failure)
 *   - OS argv ARG_MAX ceiling on large diffs (1.0.5 dogfood failure)
 */
function buildBashDirectCommand(plugin: 'codex' | 'gemini'): string {
  return resolvePluginBashCommand(plugin)
}

/**
 * 给定 quality tier + phase layer + plugin 可用性，构造 verify wave 计划。
 *
 *   - fast    → single verify (cross-vendor: layer=frontend → codex；其他 → gemini)
 *   - triple  → dual verify (codex + gemini 并行)
 *   - debate  → dual verify
 *
 * **SSoT (v4.2.1)**：quality-router.buildVerifyWave 必须 import 此函数 + 走
 * schema adapter，不得复制路由实现。
 *
 * **v4.4.2 (E only)**：`options.useDirectBashInvocation=true` 时所有 plugin
 * spawn entry 标 invocationMode='bash-direct' + 附 bashCommand，主线模板渲染
 * 为 Bash 直调跳过 sonnet wrapper（架构性消除 silent contamination）。默认
 * false 保持向后兼容（v4.4.1 及以前的 Agent spawn 行为）。
 */
export function planVerifyWave(
  tier: 'fast' | 'triple' | 'debate',
  layer: Layer,
  plugins: PluginAvailability,
  options: PlanVerifyWaveOptions = {},
): VerifyWavePlan {
  if (!['fast', 'triple', 'debate'].includes(tier)) {
    throw new Error(`planVerifyWave: invalid tier "${tier}"`)
  }

  const useBashDirect = options.useDirectBashInvocation === true
  const dual = tier === 'triple' || tier === 'debate'
  const spawns: VerifySpawnEntry[] = []
  let degraded = false
  const dropped: string[] = []

  // v4.4.2 helper: 生成 plugin spawn entry 时按 useBashDirect 决定调用模式
  const pluginEntry = (
    plugin: 'codex' | 'gemini',
    rationale: string,
  ): VerifySpawnEntry => {
    const base: VerifySpawnEntry = {
      agent: `${plugin}:${plugin}-rescue`,
      rationale,
    }
    if (useBashDirect) {
      base.invocationMode = 'bash-direct'
      base.bashCommand = buildBashDirectCommand(plugin)
    } else {
      base.invocationMode = 'agent'
    }
    return base
  }

  if (dual) {
    if (plugins.codex) {
      spawns.push(pluginEntry('codex', 'cross-vendor verify (codex)'))
    } else {
      spawns.push({
        agent: 'general-purpose',
        rationale: 'codex plugin unavailable — main-thread fallback (codex/reviewer prompt)',
        ccgPromptFile: `${CCG_PROMPT_BASE}/codex/reviewer.md`,
      })
      degraded = true
      dropped.push('codex:codex-rescue')
    }
    if (plugins.gemini) {
      spawns.push(pluginEntry('gemini', 'cross-vendor verify (gemini)'))
    } else {
      spawns.push({
        agent: 'general-purpose',
        rationale: 'gemini plugin unavailable — main-thread fallback (gemini/reviewer prompt)',
        ccgPromptFile: `${CCG_PROMPT_BASE}/gemini/reviewer.md`,
      })
      degraded = true
      dropped.push('gemini:gemini-rescue')
    }
  } else {
    // single verify; layer-based 反选
    const preferred: 'codex' | 'gemini' = layer === 'frontend' ? 'codex' : 'gemini'
    const fallback: 'codex' | 'gemini' = preferred === 'codex' ? 'gemini' : 'codex'

    if (plugins[preferred]) {
      spawns.push(pluginEntry(preferred, `cross-vendor verify (${preferred}, layer=${layer})`))
    } else if (plugins[fallback]) {
      spawns.push(pluginEntry(fallback, `verify fallback (${fallback}, preferred ${preferred} unavailable)`))
      degraded = true
      dropped.push(`${preferred}:${preferred}-rescue`)
    } else {
      spawns.push({
        agent: 'general-purpose',
        rationale: 'both plugins unavailable — main-thread reviewer fallback',
        ccgPromptFile: `${CCG_PROMPT_BASE}/claude/reviewer.md`,
      })
      degraded = true
      dropped.push('codex:codex-rescue', 'gemini:gemini-rescue')
    }
  }

  return {
    mode: dual ? 'dual' : 'single',
    spawns,
    degraded,
    degradeNote: degraded
      ? `verify wave plugin(s) unavailable: ${dropped.join(', ')}`
      : undefined,
  }
}

// ---------------------------------------------------------------------------
// 4. Parse verify summary (复用 challenger parser)
// ---------------------------------------------------------------------------

/**
 * 解析单条 verify summary 文本。复用 challenger-orchestrator.parseChallengerSummary
 * 的鲁棒化 parser（同样的 STATUS / FINDINGS / NOTES schema）。
 *
 * 与 challenger 不同点：verify 没有"adversarial"语义，但摘要协议复用同一格式
 * 简化代码 + 测试。caller 决定调用语义。
 *
 * @param agent  调用方传入的 agent 名（quality-router 的 SpawnEntry.agent）
 * @param text   subagent 返回的 ≤200 token 摘要原文
 */
export function parseVerifyReport(agent: string, text: string): VerifyReport {
  // challenger parser 要求 ChallengerAgent union；verify agent 可能是
  // codex:codex-rescue / gemini:gemini-rescue / general-purpose / 其他自定义。
  // 用 union 兼容名直接转 cast，parser 内部不强校验 agent 字符串。
  let raw: ReturnType<typeof parseChallengerSummary>
  try {
    raw = parseChallengerSummary(agent as ChallengerAgent, text)
  } catch (e) {
    return {
      agent,
      status: 'error',
      criticals: [],
      majors: [],
      notes: e instanceof Error ? e.message : String(e),
      raw: text,
    }
  }

  const criticals = raw.findings.filter(f => f.severity === 'critical')
  const majors = raw.findings.filter(f => f.severity === 'major')

  return {
    agent,
    status: raw.status,
    criticals,
    majors,
    notes: raw.notes,
    raw: text,
  }
}

// ---------------------------------------------------------------------------
// 5. Synthesize decision
// ---------------------------------------------------------------------------

/**
 * 综合多个 verify reports 给主线决策。
 *
 *   - 任一 status='error'                    → escalate (AskUserQuestion)
 *   - 任一 critical finding                  → revise (主线 spawn 修订轮)
 *   - 全部 complete + 0 critical             → advance
 *   - 空报告列表（异常）                      → escalate
 */
export function synthesizeVerifyResults(reports: VerifyReport[]): VerifyDecision {
  if (!Array.isArray(reports) || reports.length === 0) {
    return 'escalate'
  }
  const hasError = reports.some(r => r.status === 'error')
  if (hasError) return 'escalate'

  const hasCritical = reports.some(r => r.criticals.length > 0)
  if (hasCritical) return 'revise'

  return 'advance'
}

/**
 * 综合 verify reports 中的 critical findings 成单一反馈块，注入修订轮
 * phase-runner 的 prompt（与 challenger.synthesizeRevisionFeedback 同源）。
 *
 * 修订轮要求：仅修复 critical 项，不重做整个 phase。
 */
export function synthesizeVerifyFeedback(reports: VerifyReport[]): string {
  const critical = reports.flatMap(r =>
    r.criticals.map(f => ({ from: r.agent, ...f })),
  )
  if (critical.length === 0) return ''

  const lines = [
    '## Verify 反馈（critical 必修）',
    '',
    'verify wave 标出下列 critical findings，修订轮必须处理：',
    '',
    ...critical.map((c, i) =>
      `${i + 1}. [${c.from}] (${c.category}) ${c.message}`,
    ),
    '',
    '修订要求：仅修复上述 critical 项，不重做整个 phase；保留原 commit 历史。',
  ]
  return lines.join('\n')
}
