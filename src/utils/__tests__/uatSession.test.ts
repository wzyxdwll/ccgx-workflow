import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildColdStartSmokeTemplate,
  COLD_START_PATTERNS,
  createUatSession,
  decideConvergence,
  inferIssueSeverity,
  parseUatFrontmatter,
  renderUatFrontmatter,
  shouldInjectColdStart,
  type UatSessionState,
} from '../uat-session'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const VERIFY_WORK_TEMPLATE = resolve(
  REPO_ROOT,
  'templates',
  'commands',
  'verify-work.md',
)

// ---------------------------------------------------------------------------
// 1. Cold-start smoke 注入判定
// ---------------------------------------------------------------------------

describe('shouldInjectColdStart — cold-start critical-path detection', () => {
  it('injects when git diff touches server.ts', () => {
    const decision = shouldInjectColdStart([
      'apps/api/src/server.ts',
      'README.md',
    ])
    expect(decision.shouldInject).toBe(true)
    expect(decision.hits).toHaveLength(1)
    expect(decision.hits[0].file).toBe('apps/api/src/server.ts')
    expect(decision.smokeTemplate).toContain('Cold-Start Smoke Test')
    expect(decision.smokeTemplate).toContain('Kill any running process')
    expect(decision.smokeTemplate).toContain('Cold-boot from scratch')
  })

  it('injects when migrations/* changed (silent seed failure risk)', () => {
    const decision = shouldInjectColdStart([
      'src/database/migrations/20260101_init.sql',
    ])
    expect(decision.shouldInject).toBe(true)
    expect(decision.hits[0].file).toContain('migrations/')
  })

  it('injects when docker-compose.yml changed', () => {
    const decision = shouldInjectColdStart([
      'docker-compose.yml',
      'docker-compose.prod.yaml',
    ])
    expect(decision.shouldInject).toBe(true)
    expect(decision.hits.length).toBeGreaterThanOrEqual(1)
  })

  it('injects when .env or k8s manifests touched', () => {
    expect(shouldInjectColdStart(['.env']).shouldInject).toBe(true)
    expect(shouldInjectColdStart(['.env.production']).shouldInject).toBe(true)
    expect(shouldInjectColdStart(['k8s/deploy.yaml']).shouldInject).toBe(true)
  })

  it('does NOT inject for clean docs / pure utility diff', () => {
    const decision = shouldInjectColdStart([
      'README.md',
      'docs/api.md',
      'src/utils/format-string.ts',
      'src/components/Button.tsx',
    ])
    expect(decision.shouldInject).toBe(false)
    expect(decision.hits).toHaveLength(0)
    expect(decision.smokeTemplate).toBe('')
  })

  it('handles empty / malformed input safely', () => {
    expect(shouldInjectColdStart([]).shouldInject).toBe(false)
    expect(shouldInjectColdStart([''] as never).shouldInject).toBe(false)
    expect(shouldInjectColdStart([null as never, undefined as never]).shouldInject).toBe(
      false,
    )
  })

  it('reports each unique hit only once per file', () => {
    const decision = shouldInjectColdStart(['src/server.ts'])
    expect(decision.hits).toHaveLength(1)
  })

  it('exposes a non-empty pattern catalog', () => {
    expect(COLD_START_PATTERNS.length).toBeGreaterThanOrEqual(8)
  })

  it('buildColdStartSmokeTemplate cites the triggering files', () => {
    const tmpl = buildColdStartSmokeTemplate([
      { file: 'src/server.ts', pattern: '(^|/)server' },
    ])
    expect(tmpl).toContain('`src/server.ts`')
    expect(tmpl).toContain('Issue the primary query')
  })
})

// ---------------------------------------------------------------------------
// 2. UAT.md frontmatter — schema + parse + render + resume
// ---------------------------------------------------------------------------

describe('UAT.md frontmatter — parse / render / resume across sessions', () => {
  it('createUatSession produces an empty session with stable defaults', () => {
    const s = createUatSession({ taskId: 'phase-09', startedAt: '2026-05-03T10:00:00Z' })
    expect(s.taskId).toBe('phase-09')
    expect(s.completedChecks).toEqual([])
    expect(s.pendingChecks).toEqual([])
    expect(s.gaps).toEqual([])
    expect(s.coldStartInjected).toBe(false)
  })

  it('renderUatFrontmatter → parseUatFrontmatter is a round-trip', () => {
    const original: UatSessionState = {
      taskId: 'task-42',
      startedAt: '2026-05-03T10:00:00Z',
      coldStartInjected: true,
      completedChecks: [
        { id: 'C1', expected: 'login button visible', matched: true },
        {
          id: 'C2',
          expected: 'list shows 5 items',
          matched: false,
          gapRef: 'G-01',
        },
      ],
      pendingChecks: [{ id: 'C3', expected: 'logout works' }],
      gaps: [
        {
          symptom: 'list empty after refresh',
          severity: 'high',
          status: 'open',
          loopCount: 1,
          planRef: '.context/uat/task-42/fix-G-01.md',
        },
      ],
    }
    const md = renderUatFrontmatter(original)
    // Frontmatter must be wrapped between two `---` markers, ending with `---`.
    expect(md.startsWith('---\n')).toBe(true)
    expect(md.trimEnd().endsWith('---')).toBe(true)

    // Append minimal body to simulate real UAT.md and parse back
    const fullDoc = `${md}\n\n# UAT log\n\nbody...`
    const restored = parseUatFrontmatter(fullDoc)
    expect(restored).not.toBeNull()
    expect(restored!.taskId).toBe('task-42')
    expect(restored!.coldStartInjected).toBe(true)
    expect(restored!.completedChecks).toHaveLength(2)
    expect(restored!.completedChecks[1].matched).toBe(false)
    expect(restored!.completedChecks[1].gapRef).toBe('G-01')
    expect(restored!.pendingChecks).toHaveLength(1)
    expect(restored!.gaps).toHaveLength(1)
    expect(restored!.gaps[0].severity).toBe('high')
    expect(restored!.gaps[0].loopCount).toBe(1)
    expect(restored!.gaps[0].planRef).toBe('.context/uat/task-42/fix-G-01.md')
  })

  it('parseUatFrontmatter returns null when file has no frontmatter', () => {
    expect(parseUatFrontmatter('# just markdown body')).toBeNull()
    expect(parseUatFrontmatter('')).toBeNull()
  })

  it('parseUatFrontmatter requires task_id (corruption guard)', () => {
    const broken = ['---', 'started_at: 2026-01-01', '---'].join('\n')
    expect(parseUatFrontmatter(broken)).toBeNull()
  })

  it('quotes symptoms containing commas / colons safely (parser must accept them back)', () => {
    const state: UatSessionState = {
      taskId: 't',
      startedAt: '2026-05-03',
      coldStartInjected: false,
      completedChecks: [],
      pendingChecks: [],
      gaps: [
        {
          symptom: 'after login, redirect 500: timeout',
          severity: 'critical',
          status: 'open',
        },
      ],
    }
    const md = renderUatFrontmatter(state)
    const restored = parseUatFrontmatter(md)
    expect(restored).not.toBeNull()
    expect(restored!.gaps[0].symptom).toBe('after login, redirect 500: timeout')
    expect(restored!.gaps[0].severity).toBe('critical')
  })
})

// ---------------------------------------------------------------------------
// 3. Issue 严重度推断
// ---------------------------------------------------------------------------

describe('inferIssueSeverity — natural-language severity inference', () => {
  it('classifies crash / data loss as critical', () => {
    expect(inferIssueSeverity('the app crashed when I clicked login')).toBe(
      'critical',
    )
    expect(inferIssueSeverity('possible data loss after migration')).toBe(
      'critical',
    )
    expect(inferIssueSeverity('数据丢失了')).toBe('critical')
  })

  it('classifies broken / 500 / cannot do X as high', () => {
    expect(inferIssueSeverity('the form is broken')).toBe('high')
    expect(inferIssueSeverity('returns 500 on /api/users')).toBe('high')
    expect(inferIssueSeverity("I can't submit the form")).toBe('high')
    expect(inferIssueSeverity('登录失败')).toBe('high')
  })

  it('classifies slow / incorrect / mismatch as medium', () => {
    expect(inferIssueSeverity('the page is slow')).toBe('medium')
    expect(inferIssueSeverity('the count is incorrect')).toBe('medium')
    expect(inferIssueSeverity('数据不一致')).toBe('medium')
  })

  it('classifies typo / cosmetic as low', () => {
    expect(inferIssueSeverity('typo in heading')).toBe('low')
    expect(inferIssueSeverity('cosmetic alignment off')).toBe('low')
  })

  it('falls back to medium on ambiguous reports (conservative default)', () => {
    expect(inferIssueSeverity('hmm, something feels off here')).toBe('medium')
    expect(inferIssueSeverity('')).toBe('medium')
    expect(inferIssueSeverity('the new thing arrived')).toBe('medium')
  })

  it('returns the most-severe match when multiple keywords appear (critical wins)', () => {
    expect(
      inferIssueSeverity('typo in error message and the app crashed too'),
    ).toBe('critical')
  })
})

// ---------------------------------------------------------------------------
// 4. max-3-loop 收敛判定
// ---------------------------------------------------------------------------

describe('decideConvergence — diagnose → planner → checker loop control', () => {
  it('continues at loop 0 / 1 / 2 (under cap)', () => {
    expect(decideConvergence(0).verdict).toBe('continue')
    expect(decideConvergence(1).verdict).toBe('continue')
    expect(decideConvergence(2).verdict).toBe('continue')
  })

  it('escalates at loop 3 (cap reached)', () => {
    const d = decideConvergence(3)
    expect(d.verdict).toBe('escalate')
    expect(d.message).toMatch(/exhausted/i)
    expect(d.message).toMatch(/3 options/)
  })

  it('escalates beyond cap (defensive — should never happen)', () => {
    expect(decideConvergence(7).verdict).toBe('escalate')
  })

  it('respects custom maxLoop', () => {
    expect(decideConvergence(1, 2).verdict).toBe('continue')
    expect(decideConvergence(2, 2).verdict).toBe('escalate')
  })

  it('coerces negative / fractional input safely', () => {
    expect(decideConvergence(-1).verdict).toBe('continue')
    expect(decideConvergence(2.7).verdict).toBe('continue')
    expect(decideConvergence(2.7).currentLoop).toBe(2)
  })

  it('reports current and max loop in decision payload', () => {
    const d = decideConvergence(1, 5)
    expect(d.currentLoop).toBe(1)
    expect(d.maxLoop).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// 5. Template integration — verify-work.md must reference the new mechanisms
// ---------------------------------------------------------------------------

describe('templates/commands/verify-work.md — session UAT contract', () => {
  it('exists at the expected path', () => {
    expect(existsSync(VERIFY_WORK_TEMPLATE)).toBe(true)
  })

  const content = existsSync(VERIFY_WORK_TEMPLATE)
    ? readFileSync(VERIFY_WORK_TEMPLATE, 'utf8')
    : ''

  it('declares UAT.md state-file resume semantics', () => {
    expect(content).toMatch(/UAT\.md/)
    expect(content).toMatch(/resume|恢复|断点|cross.session|跨会话/i)
  })

  it('describes cold-start smoke injection logic', () => {
    expect(content).toMatch(/cold[- ]?start/i)
    expect(content).toMatch(/server\.ts|migrations|docker-compose/)
  })

  it('describes issue → diagnose → planner gaps → plan-checker convergence loop', () => {
    expect(content).toMatch(/diagnose/i)
    expect(content).toMatch(/plan[- ]?checker|plan-checker/i)
    expect(content).toMatch(/3.{0,5}(轮|loop|轮收敛|attempts?)/i)
  })

  it('declares the gaps schema (symptom / severity / status)', () => {
    expect(content).toMatch(/symptom/i)
    expect(content).toMatch(/severity/i)
    expect(content).toMatch(/status/i)
  })
})
