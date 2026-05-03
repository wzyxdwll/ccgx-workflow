import { describe, expect, it } from 'vitest'
import {
  parseVerifyReport,
  planVerifyWave,
  synthesizeVerifyFeedback,
  synthesizeVerifyResults,
  type VerifyReport,
} from '../verify-orchestrator'

const PLUGINS_BOTH = { codex: true, gemini: true }
const PLUGINS_NONE = { codex: false, gemini: false }
const PLUGINS_GEMINI_ONLY = { codex: false, gemini: true }
const PLUGINS_CODEX_ONLY = { codex: true, gemini: false }

// ---------------------------------------------------------------------------
// 1. planVerifyWave routing
// ---------------------------------------------------------------------------

describe('planVerifyWave — fast tier (single)', () => {
  it('backend layer → gemini verify (cross-vendor)', () => {
    const p = planVerifyWave('fast', 'backend', PLUGINS_BOTH)
    expect(p.mode).toBe('single')
    expect(p.spawns).toHaveLength(1)
    expect(p.spawns[0].agent).toBe('gemini:gemini-rescue')
    expect(p.degraded).toBe(false)
  })

  it('frontend layer → codex verify', () => {
    const p = planVerifyWave('fast', 'frontend', PLUGINS_BOTH)
    expect(p.spawns[0].agent).toBe('codex:codex-rescue')
  })

  it('docs / generic → gemini verify', () => {
    const p1 = planVerifyWave('fast', 'docs', PLUGINS_BOTH)
    expect(p1.spawns[0].agent).toBe('gemini:gemini-rescue')
    const p2 = planVerifyWave('fast', 'generic', PLUGINS_BOTH)
    expect(p2.spawns[0].agent).toBe('gemini:gemini-rescue')
  })

  it('fullstack → gemini verify (default cross-vendor)', () => {
    const p = planVerifyWave('fast', 'fullstack', PLUGINS_BOTH)
    expect(p.spawns[0].agent).toBe('gemini:gemini-rescue')
  })

  it('preferred plugin missing → fallback to other plugin (degraded)', () => {
    const p = planVerifyWave('fast', 'backend', PLUGINS_CODEX_ONLY)
    // preferred = gemini (backend reverse), fallback = codex
    expect(p.spawns[0].agent).toBe('codex:codex-rescue')
    expect(p.degraded).toBe(true)
  })

  it('both plugins missing → general-purpose with claude/reviewer prompt', () => {
    const p = planVerifyWave('fast', 'backend', PLUGINS_NONE)
    expect(p.spawns[0].agent).toBe('general-purpose')
    expect(p.spawns[0].ccgPromptFile).toContain('claude/reviewer.md')
    expect(p.degraded).toBe(true)
  })
})

describe('planVerifyWave — triple/debate tier (dual)', () => {
  it('triple: dual codex + gemini', () => {
    const p = planVerifyWave('triple', 'backend', PLUGINS_BOTH)
    expect(p.mode).toBe('dual')
    expect(p.spawns).toHaveLength(2)
    expect(p.spawns.map(s => s.agent)).toEqual([
      'codex:codex-rescue',
      'gemini:gemini-rescue',
    ])
    expect(p.degraded).toBe(false)
  })

  it('debate: dual cross-vendor verify', () => {
    const p = planVerifyWave('debate', 'frontend', PLUGINS_BOTH)
    expect(p.mode).toBe('dual')
    expect(p.spawns).toHaveLength(2)
  })

  it('triple + only gemini → codex slot replaced by general-purpose fallback', () => {
    const p = planVerifyWave('triple', 'backend', PLUGINS_GEMINI_ONLY)
    expect(p.spawns[0].agent).toBe('general-purpose')
    expect(p.spawns[0].ccgPromptFile).toContain('codex/reviewer.md')
    expect(p.spawns[1].agent).toBe('gemini:gemini-rescue')
    expect(p.degraded).toBe(true)
  })

  it('throws on invalid tier', () => {
    expect(() =>
      // @ts-expect-error intentional bad value
      planVerifyWave('ludicrous', 'backend', PLUGINS_BOTH),
    ).toThrow(/invalid tier/)
  })
})

// ---------------------------------------------------------------------------
// 2. parseVerifyReport (复用 challenger parser)
// ---------------------------------------------------------------------------

describe('parseVerifyReport', () => {
  it('parses complete report with critical findings', () => {
    const text = `STATUS: complete
FINDINGS: [{"severity":"critical","category":"race","message":"commit drift detected"}]
NOTES: needs revision`
    const r = parseVerifyReport('codex:codex-rescue', text)
    expect(r.status).toBe('complete')
    expect(r.criticals).toHaveLength(1)
    expect(r.criticals[0].category).toBe('race')
    expect(r.notes).toBe('needs revision')
  })

  it('parses report with no findings → empty arrays', () => {
    const text = `STATUS: complete
FINDINGS: []
NOTES: looks good`
    const r = parseVerifyReport('gemini:gemini-rescue', text)
    expect(r.status).toBe('complete')
    expect(r.criticals).toHaveLength(0)
    expect(r.majors).toHaveLength(0)
  })

  it('separates critical from major', () => {
    const text = `STATUS: complete
FINDINGS: [{"severity":"critical","category":"race","message":"x"},{"severity":"major","category":"perf","message":"y"}]
NOTES: ok`
    const r = parseVerifyReport('codex:codex-rescue', text)
    expect(r.criticals).toHaveLength(1)
    expect(r.majors).toHaveLength(1)
  })

  it('missing STATUS → error report (does not throw)', () => {
    const text = `FINDINGS: []`
    const r = parseVerifyReport('codex:codex-rescue', text)
    expect(r.status).toBe('error')
  })

  it('STATUS=error → returned as-is', () => {
    const text = `STATUS: error
NOTES: spawned but crashed`
    const r = parseVerifyReport('codex:codex-rescue', text)
    expect(r.status).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// 3. synthesizeVerifyResults — decision logic
// ---------------------------------------------------------------------------

const okReport = (agent: string): VerifyReport => ({
  agent,
  status: 'complete',
  criticals: [],
  majors: [],
  notes: 'all good',
  raw: '',
})

const criticalReport = (agent: string): VerifyReport => ({
  agent,
  status: 'complete',
  criticals: [{ severity: 'critical', category: 'race', message: 'commit drift' }],
  majors: [],
  notes: 'fix needed',
  raw: '',
})

const errorReport = (agent: string): VerifyReport => ({
  agent,
  status: 'error',
  criticals: [],
  majors: [],
  notes: 'spawn failed',
  raw: '',
})

describe('synthesizeVerifyResults', () => {
  it('all complete + 0 critical → advance', () => {
    const d = synthesizeVerifyResults([okReport('codex'), okReport('gemini')])
    expect(d).toBe('advance')
  })

  it('any critical → revise', () => {
    const d = synthesizeVerifyResults([okReport('codex'), criticalReport('gemini')])
    expect(d).toBe('revise')
  })

  it('any error → escalate', () => {
    const d = synthesizeVerifyResults([okReport('codex'), errorReport('gemini')])
    expect(d).toBe('escalate')
  })

  it('error + critical → escalate (error takes precedence)', () => {
    const d = synthesizeVerifyResults([criticalReport('codex'), errorReport('gemini')])
    expect(d).toBe('escalate')
  })

  it('empty list → escalate', () => {
    expect(synthesizeVerifyResults([])).toBe('escalate')
  })

  it('non-array → escalate', () => {
    expect(synthesizeVerifyResults(null as never)).toBe('escalate')
  })
})

// ---------------------------------------------------------------------------
// 4. synthesizeVerifyFeedback
// ---------------------------------------------------------------------------

describe('synthesizeVerifyFeedback', () => {
  it('no critical → empty string', () => {
    const fb = synthesizeVerifyFeedback([okReport('codex')])
    expect(fb).toBe('')
  })

  it('with critical → markdown block with findings list', () => {
    const fb = synthesizeVerifyFeedback([
      criticalReport('codex:codex-rescue'),
      criticalReport('gemini:gemini-rescue'),
    ])
    expect(fb).toContain('Verify 反馈')
    expect(fb).toContain('codex:codex-rescue')
    expect(fb).toContain('gemini:gemini-rescue')
    expect(fb).toContain('commit drift')
    expect(fb).toContain('修订要求')
  })

  it('only includes critical, not majors', () => {
    const r: VerifyReport = {
      agent: 'codex',
      status: 'complete',
      criticals: [{ severity: 'critical', category: 'a', message: 'crit msg' }],
      majors: [{ severity: 'major', category: 'b', message: 'maj msg' }],
      notes: '',
      raw: '',
    }
    const fb = synthesizeVerifyFeedback([r])
    expect(fb).toContain('crit msg')
    expect(fb).not.toContain('maj msg')
  })
})
