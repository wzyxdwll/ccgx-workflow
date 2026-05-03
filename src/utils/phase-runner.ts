/**
 * phase-runner subagent 协议的主线侧 helper（v4.0 Phase 1.5）
 *
 * autonomous 主线 spawn `Agent(phase-runner)` 后接到的 ≤200 token 摘要，
 * 由本模块解析为结构化对象，供主线决策 phase 推进 / 暂停 / cascade。
 *
 * 同时提供 phase Type → rescue subagent_type 的路由映射，给 phase-runner
 * subagent 模板里 `routePhaseType()` 行为做单元测试覆盖。
 */

// v4.2 P21: PhaseType 收并到 multi-model-routing SSoT 的 Layer。
// 保留别名供 BC（外部调用方仍 import 此名），新代码请直接用 Layer。
import type { Layer } from './multi-model-routing'
export type PhaseType = Layer

export type RescueSubagentType =
  | 'codex:codex-rescue'
  | 'gemini:gemini-rescue'
  | 'sequential:codex-then-gemini'

export type PhaseRunnerStatus = 'completed' | 'partial' | 'failed' | 'degraded'

export interface PhaseRunnerSummary {
  status: PhaseRunnerStatus
  commit: string | null  // sha7 or null when no commit was made
  tests: {
    passed: number
    total: number
    delta: number  // new tests added by this phase
  } | null
  typecheck: 'pass' | 'fail' | 'unknown'
  handoffTaken: string[]  // e.g. ['git_commit', 'test_run', 'typecheck']
  contextDelta: string  // ≤ 50 chars
  notes: string  // ≤ 80 chars
  raw: string  // original text for debugging
}

/**
 * Map phase Type field (declared in roadmap.md per phase) to the rescue
 * subagent that phase-runner should spawn internally.
 *
 * - `backend` / `docs` / `generic` → codex (default BACKEND_PRIMARY heuristic)
 * - `frontend` → gemini (default FRONTEND_PRIMARY heuristic)
 * - `fullstack` → marker indicating sequential (codex first, then gemini)
 *
 * The actual model resolution is done in phase-runner.md prompt; this
 * function exists for static validation of the routing contract.
 */
export function routePhaseType(type: PhaseType): RescueSubagentType {
  switch (type) {
    case 'frontend':
      return 'gemini:gemini-rescue'
    case 'fullstack':
      return 'sequential:codex-then-gemini'
    case 'backend':
    case 'docs':
    case 'generic':
      return 'codex:codex-rescue'
  }
}

/**
 * Parse the structured 200-token summary string returned by phase-runner.
 *
 * Expected format (lenient — missing lines fall back to defaults):
 *
 *   STATUS: completed | partial | failed | degraded
 *   COMMIT: <sha7> | none
 *   TESTS: <pass>/<total> passed (delta +<n>)
 *   TYPECHECK: pass | fail
 *   HANDOFF_TAKEN: [git_commit, test_run, ...]
 *   CONTEXT_DELTA: <≤50 chars>
 *   NOTES: <≤80 chars>
 *
 * Whitespace tolerant. Field order does not matter. Throws on STATUS missing
 * (it's the only required field).
 */
export function parsePhaseRunnerSummary(text: string): PhaseRunnerSummary {
  const get = (key: string): string | null => {
    const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'mi')
    const m = text.match(re)
    return m ? m[1].trim() : null
  }

  const statusRaw = get('STATUS')
  if (!statusRaw) {
    throw new Error('phase-runner summary missing required STATUS field')
  }
  const status = statusRaw.toLowerCase().split(/\s+/)[0] as PhaseRunnerStatus
  if (!['completed', 'partial', 'failed', 'degraded'].includes(status)) {
    throw new Error(`phase-runner summary STATUS=${statusRaw} not one of completed|partial|failed|degraded`)
  }

  const commitRaw = get('COMMIT')
  const commit = (commitRaw && commitRaw.toLowerCase() !== 'none')
    ? commitRaw.match(/[0-9a-f]{7,40}/i)?.[0] ?? null
    : null

  const testsRaw = get('TESTS')
  let tests: PhaseRunnerSummary['tests'] = null
  if (testsRaw) {
    const m = testsRaw.match(/(\d+)\s*\/\s*(\d+)\s+passed(?:.*?delta\s+\+?(\d+))?/i)
    if (m) {
      tests = {
        passed: Number(m[1]),
        total: Number(m[2]),
        delta: m[3] ? Number(m[3]) : 0,
      }
    }
  }

  const typecheckRaw = get('TYPECHECK')?.toLowerCase()
  const typecheck: 'pass' | 'fail' | 'unknown' =
    typecheckRaw === 'pass' ? 'pass'
      : typecheckRaw === 'fail' ? 'fail'
        : 'unknown'

  const handoffRaw = get('HANDOFF_TAKEN')
  const handoffTaken = handoffRaw
    ? handoffRaw.replace(/[\[\]]/g, '').split(',').map(s => s.trim()).filter(Boolean)
    : []

  const contextDelta = get('CONTEXT_DELTA') ?? ''
  const notes = get('NOTES') ?? ''

  return { status, commit, tests, typecheck, handoffTaken, contextDelta, notes, raw: text }
}

/**
 * Decide what autonomous main thread should do next based on summary.
 * Returns an action verb that the main thread (or its caller) handles.
 */
export type NextAction = 'advance' | 'ask_user' | 'cascade_block_downstream'

export function decideNextAction(summary: PhaseRunnerSummary): NextAction {
  switch (summary.status) {
    case 'completed':
    case 'degraded':  // degraded means fallback succeeded
      return 'advance'
    case 'partial':
      return 'ask_user'
    case 'failed':
      return 'cascade_block_downstream'
  }
}
