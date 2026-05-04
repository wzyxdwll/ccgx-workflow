import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  decideNextAction,
  parsePhaseRunnerSummary,
  routePhaseType,
} from '../phase-runner'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const PHASE_RUNNER_TEMPLATE = resolve(REPO_ROOT, 'templates', 'commands', 'agents', 'phase-runner.md')
const AUTONOMOUS_TEMPLATE = resolve(REPO_ROOT, 'templates', 'commands', 'autonomous.md')

// ---------------------------------------------------------------------------
// 1. phase-runner subagent prompt template — structural assertions
// ---------------------------------------------------------------------------
describe('phase-runner.md template (Phase 1.5 acceptance a)', () => {
  it('exists at templates/commands/agents/phase-runner.md', () => {
    expect(existsSync(PHASE_RUNNER_TEMPLATE)).toBe(true)
  })

  const content = existsSync(PHASE_RUNNER_TEMPLATE) ? readFileSync(PHASE_RUNNER_TEMPLATE, 'utf8') : ''

  it('declares name=phase-runner in frontmatter', () => {
    expect(content).toMatch(/^---[\s\S]*?name:\s*phase-runner[\s\S]*?---/m)
  })

  it('does NOT declare Agent in tools list (engine forbids subagent nest-spawn, see v4.0 dogfood validation 2026-05-04)', () => {
    // Original v4.0 design wrote `tools: ..., Agent` but Phase test phase-runner-nested-spawn
    // verified the Claude Code engine does not honor this for sub-agent contexts. Removed to
    // avoid misleading future maintainers into expecting nested-spawn capability.
    const toolsLine = content.match(/^tools:\s*(.+)$/m)?.[1] ?? ''
    expect(toolsLine).not.toMatch(/\bAgent\b/)
    expect(toolsLine).not.toMatch(/\bTask\b/)
  })

  it('documents the engine-layer constraint (subagent cannot nest-spawn Agent)', () => {
    // Top of file should now include a section explaining why Agent isn't in tools.
    expect(content).toMatch(/引擎层硬约束|cannot nest-spawn|不能嵌套 spawn/i)
  })

  it('contains Type → work-style guidance (no rescue routing — engine layer forbids that)', () => {
    // After v4.1 redesign, Type guides the IMPLEMENTER's own work style, not which subagent to spawn.
    expect(content).toMatch(/backend/i)
    expect(content).toMatch(/frontend/i)
    expect(content).toMatch(/fullstack/i)
  })

  it('defines the structured summary protocol fields', () => {
    expect(content).toContain('STATUS:')
    expect(content).toContain('COMMIT:')
    expect(content).toContain('TESTS:')
    expect(content).toContain('TYPECHECK:')
    expect(content).toContain('HANDOFF_TAKEN:')
    expect(content).toContain('NOTES:')
  })

  it('explicitly forbids modifying .ccg/roadmap.md (main-thread only)', () => {
    expect(content).toMatch(/不修改.*roadmap\.md|roadmap\.md.*只读|roadmap\.md（主线|roadmap\.md（autonomous/)
  })

  it('lists handoff types main thread expects (git_commit, test_run, typecheck)', () => {
    expect(content).toContain('git_commit')
    expect(content).toContain('test_run')
    expect(content).toContain('typecheck')
  })
})

// ---------------------------------------------------------------------------
// 2. routePhaseType — Phase Type → rescue subagent mapping (acceptance c)
// ---------------------------------------------------------------------------
describe('routePhaseType (Phase 1.5 acceptance c)', () => {
  it('routes backend to codex rescue', () => {
    expect(routePhaseType('backend')).toBe('codex:codex-rescue')
  })

  it('routes frontend to gemini rescue', () => {
    expect(routePhaseType('frontend')).toBe('gemini:gemini-rescue')
  })

  it('routes fullstack to sequential codex-then-gemini marker', () => {
    expect(routePhaseType('fullstack')).toBe('sequential:codex-then-gemini')
  })

  it('routes docs to codex (backend default)', () => {
    expect(routePhaseType('docs')).toBe('codex:codex-rescue')
  })

  it('routes generic to codex (backend default)', () => {
    expect(routePhaseType('generic')).toBe('codex:codex-rescue')
  })
})

// ---------------------------------------------------------------------------
// 3. parsePhaseRunnerSummary — structured extraction from ≤200 token text
// ---------------------------------------------------------------------------
describe('parsePhaseRunnerSummary (Phase 1.5 acceptance e)', () => {
  it('parses a fully populated completed summary', () => {
    const text = `
STATUS: completed
COMMIT: 099843b
TESTS: 191/191 passed (delta +11)
TYPECHECK: pass
HANDOFF_TAKEN: [git_commit, test_run, typecheck]
CONTEXT_DELTA: codex 接手 git/test 后无 BLOCKED
NOTES: 4 模板 frontmatter +2 字段，11 单测全过
`.trim()

    const out = parsePhaseRunnerSummary(text)
    expect(out.status).toBe('completed')
    expect(out.commit).toBe('099843b')
    expect(out.tests).toEqual({ passed: 191, total: 191, delta: 11 })
    expect(out.typecheck).toBe('pass')
    expect(out.handoffTaken).toEqual(['git_commit', 'test_run', 'typecheck'])
    expect(out.contextDelta).toMatch(/codex/)
    expect(out.notes).toMatch(/frontmatter/)
  })

  it('handles partial status with no commit', () => {
    const text = `STATUS: partial\nCOMMIT: none\nTESTS: 5/7 passed\nNOTES: 2 acceptance items unfinished`
    const out = parsePhaseRunnerSummary(text)
    expect(out.status).toBe('partial')
    expect(out.commit).toBeNull()
    expect(out.tests).toEqual({ passed: 5, total: 7, delta: 0 })
  })

  it('handles failed status without test info', () => {
    const text = `STATUS: failed\nNOTES: codex sandbox EPERM persisted across 2 retries`
    const out = parsePhaseRunnerSummary(text)
    expect(out.status).toBe('failed')
    expect(out.tests).toBeNull()
    expect(out.typecheck).toBe('unknown')
    expect(out.handoffTaken).toEqual([])
  })

  it('handles degraded status (rescue plugin missing fallback)', () => {
    const text = `STATUS: degraded\nCOMMIT: abc1234\nTESTS: 200/200 passed (delta +9)\nNOTES: rescue plugin unavailable, main thread implemented directly`
    const out = parsePhaseRunnerSummary(text)
    expect(out.status).toBe('degraded')
    expect(out.commit).toBe('abc1234')
  })

  it('throws when STATUS missing', () => {
    expect(() => parsePhaseRunnerSummary('NOTES: hello')).toThrow(/STATUS/)
  })

  it('throws on illegal STATUS value', () => {
    expect(() => parsePhaseRunnerSummary('STATUS: weird')).toThrow(/completed|partial|failed|degraded/)
  })

  it('is whitespace tolerant in field separators', () => {
    const text = `   STATUS  :   completed   \n  COMMIT:abc1234  \nNOTES:   hi`
    const out = parsePhaseRunnerSummary(text)
    expect(out.status).toBe('completed')
    expect(out.commit).toBe('abc1234')
    expect(out.notes).toMatch(/hi/)
  })

  it('preserves raw text for debugging', () => {
    const original = 'STATUS: completed\nNOTES: anything'
    const out = parsePhaseRunnerSummary(original)
    expect(out.raw).toBe(original)
  })

  it('truncates long commit shas to first match (sha7-40)', () => {
    const text = 'STATUS: completed\nCOMMIT: 9f5b94001234567890abcdef'
    const out = parsePhaseRunnerSummary(text)
    expect(out.commit).toMatch(/^[0-9a-f]{7,40}$/)
  })
})

// ---------------------------------------------------------------------------
// 4. decideNextAction — autonomous main thread decision tree
// ---------------------------------------------------------------------------
describe('decideNextAction (Phase 1.5 acceptance, main thread routing)', () => {
  const baseSummary = {
    commit: null, tests: null, typecheck: 'unknown' as const,
    handoffTaken: [], contextDelta: '', notes: '', raw: '',
  }

  it('completed → advance', () => {
    expect(decideNextAction({ ...baseSummary, status: 'completed' })).toBe('advance')
  })

  it('degraded → advance (fallback succeeded)', () => {
    expect(decideNextAction({ ...baseSummary, status: 'degraded' })).toBe('advance')
  })

  it('partial → ask_user', () => {
    expect(decideNextAction({ ...baseSummary, status: 'partial' })).toBe('ask_user')
  })

  it('failed → cascade_block_downstream', () => {
    expect(decideNextAction({ ...baseSummary, status: 'failed' })).toBe('cascade_block_downstream')
  })
})

// ---------------------------------------------------------------------------
// 5. autonomous.md Step 4.2 contract assertions (acceptance b)
// ---------------------------------------------------------------------------
describe('autonomous.md Step 4.2 (Phase 1.5 acceptance b)', () => {
  const content = existsSync(AUTONOMOUS_TEMPLATE) ? readFileSync(AUTONOMOUS_TEMPLATE, 'utf8') : ''

  it('Step 4.2 references phase-runner subagent (G plan)', () => {
    expect(content).toMatch(/subagent_type:\s*"phase-runner"/)
  })

  it('Step 4.2 explains type-aware routing delegation', () => {
    expect(content).toMatch(/phase[-_ ]runner.*phase_type|phase_type.*phase[-_ ]runner/i)
  })

  it('Step 4.3 mentions ≤200 token summary protocol', () => {
    expect(content).toMatch(/200\s*token|≤\s*200/)
  })

  it('Step 4.3 lists STATUS routing (completed/partial/failed/degraded)', () => {
    expect(content).toContain('STATUS: completed')
    expect(content).toContain('STATUS: partial')
    expect(content).toContain('STATUS: failed')
    expect(content).toContain('STATUS: degraded')
  })
})
