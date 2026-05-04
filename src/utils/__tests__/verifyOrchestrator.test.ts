import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseVerifyReport,
  planVerifyWave,
  synthesizeVerifyFeedback,
  synthesizeVerifyResults,
  type VerifyReport,
} from '../verify-orchestrator'

// Fixtures-driven (CCG v4.3 P28): real verifier subagent reports
const FIXTURES_PATH = resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'ground-truth', 'agent-summaries.sample.json')
const AGENT_FIXTURES = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')) as {
  verifySummaries: Record<string, string>
}

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
// 1b. v4.4.2 — useDirectBashInvocation option
// ---------------------------------------------------------------------------

describe('planVerifyWave — v4.4.2 useDirectBashInvocation', () => {
  it('default (no options) keeps agent invocation mode (backward compat)', () => {
    const p = planVerifyWave('triple', 'backend', PLUGINS_BOTH)
    expect(p.spawns[0].invocationMode).toBe('agent')
    expect(p.spawns[1].invocationMode).toBe('agent')
    expect(p.spawns[0].bashCommand).toBeUndefined()
    expect(p.spawns[1].bashCommand).toBeUndefined()
  })

  it('useDirectBashInvocation=false explicit keeps agent mode', () => {
    const p = planVerifyWave('triple', 'backend', PLUGINS_BOTH, { useDirectBashInvocation: false })
    expect(p.spawns[0].invocationMode).toBe('agent')
  })

  it('useDirectBashInvocation=true switches plugin entries to bash-direct', () => {
    const p = planVerifyWave('triple', 'backend', PLUGINS_BOTH, { useDirectBashInvocation: true })
    expect(p.spawns).toHaveLength(2)
    // codex entry
    expect(p.spawns[0].agent).toBe('codex:codex-rescue')
    expect(p.spawns[0].invocationMode).toBe('bash-direct')
    expect(p.spawns[0].bashCommand).toContain('codex-companion.mjs')
    expect(p.spawns[0].bashCommand).toContain('openai-codex/codex/')
    expect(p.spawns[0].bashCommand).toContain('--json')
    // gemini entry
    expect(p.spawns[1].agent).toBe('gemini:gemini-rescue')
    expect(p.spawns[1].invocationMode).toBe('bash-direct')
    expect(p.spawns[1].bashCommand).toContain('gemini-companion.mjs')
    expect(p.spawns[1].bashCommand).toContain('google-gemini/gemini/')
  })

  it('fast tier + bash-direct: single plugin entry switches', () => {
    const p = planVerifyWave('fast', 'backend', PLUGINS_BOTH, { useDirectBashInvocation: true })
    expect(p.spawns).toHaveLength(1)
    expect(p.spawns[0].agent).toBe('gemini:gemini-rescue')
    expect(p.spawns[0].invocationMode).toBe('bash-direct')
    expect(p.spawns[0].bashCommand).toContain('gemini-companion.mjs')
  })

  it('fast tier + bash-direct + frontend layer: codex bash-direct', () => {
    const p = planVerifyWave('fast', 'frontend', PLUGINS_BOTH, { useDirectBashInvocation: true })
    expect(p.spawns[0].agent).toBe('codex:codex-rescue')
    expect(p.spawns[0].invocationMode).toBe('bash-direct')
    expect(p.spawns[0].bashCommand).toContain('codex-companion.mjs')
  })

  it('plugin missing + bash-direct: general-purpose entry NOT marked bash-direct (no plugin script to call)', () => {
    const p = planVerifyWave('triple', 'backend', PLUGINS_GEMINI_ONLY, { useDirectBashInvocation: true })
    // codex 缺失 → general-purpose（不应该 bash-direct，因为没 plugin script）
    expect(p.spawns[0].agent).toBe('general-purpose')
    expect(p.spawns[0].invocationMode).toBeUndefined()
    expect(p.spawns[0].bashCommand).toBeUndefined()
    // gemini 在 → 仍然 bash-direct
    expect(p.spawns[1].agent).toBe('gemini:gemini-rescue')
    expect(p.spawns[1].invocationMode).toBe('bash-direct')
  })

  it('both plugins missing + bash-direct: general-purpose only, no bash-direct', () => {
    const p = planVerifyWave('fast', 'backend', PLUGINS_NONE, { useDirectBashInvocation: true })
    expect(p.spawns[0].agent).toBe('general-purpose')
    expect(p.spawns[0].invocationMode).toBeUndefined()
    expect(p.spawns[0].bashCommand).toBeUndefined()
    expect(p.degraded).toBe(true)
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

// ---------------------------------------------------------------------------
// 5. Fixtures-driven tests (CCG v4.3 P28)
//
// Real verify subagent reports from agent-summaries.sample.json — guards
// against the dogfood quality gap where inline mocks all agreed but real
// shapes diverged (commit drift detection, error-state crashes, etc.).
// ---------------------------------------------------------------------------

describe('parseVerifyReport — fixtures-driven (P28)', () => {
  it('parses fixture: complete_critical_drift (real "commit drift" critical)', () => {
    const r = parseVerifyReport('codex:codex-rescue', AGENT_FIXTURES.verifySummaries.complete_critical_drift)
    expect(r.status).toBe('complete')
    expect(r.criticals).toHaveLength(1)
    expect(r.criticals[0].category).toBe('race')
    expect(r.criticals[0].message).toMatch(/commit drift/i)
  })

  it('parses fixture: complete_clean → no findings', () => {
    const r = parseVerifyReport('gemini:gemini-rescue', AGENT_FIXTURES.verifySummaries.complete_clean)
    expect(r.status).toBe('complete')
    expect(r.criticals).toHaveLength(0)
    expect(r.majors).toHaveLength(0)
  })

  it('parses fixture: complete_mixed → splits critical from major', () => {
    const r = parseVerifyReport('codex:codex-rescue', AGENT_FIXTURES.verifySummaries.complete_mixed)
    expect(r.criticals).toHaveLength(1)
    expect(r.majors).toHaveLength(1)
  })

  it('parses fixture: error_crashed → status=error preserved', () => {
    const r = parseVerifyReport('gemini:gemini-rescue', AGENT_FIXTURES.verifySummaries.error_crashed)
    expect(r.status).toBe('error')
    expect(r.notes).toMatch(/crashed|spawn/i)
  })

  it('synthesizeVerifyResults on fixture-built reports → correct decision', () => {
    const drift = parseVerifyReport('codex:codex-rescue', AGENT_FIXTURES.verifySummaries.complete_critical_drift)
    const clean = parseVerifyReport('gemini:gemini-rescue', AGENT_FIXTURES.verifySummaries.complete_clean)
    const crashed = parseVerifyReport('gemini:gemini-rescue', AGENT_FIXTURES.verifySummaries.error_crashed)

    expect(synthesizeVerifyResults([drift, clean])).toBe('revise')
    expect(synthesizeVerifyResults([clean, clean])).toBe('advance')
    expect(synthesizeVerifyResults([drift, crashed])).toBe('escalate')
  })

  it('synthesizeVerifyFeedback on fixture critical → contains real-shape message', () => {
    const drift = parseVerifyReport('codex:codex-rescue', AGENT_FIXTURES.verifySummaries.complete_critical_drift)
    const fb = synthesizeVerifyFeedback([drift])
    expect(fb).toContain('Verify 反馈')
    expect(fb).toContain('commit drift')
    expect(fb).toContain('codex:codex-rescue')
  })
})
