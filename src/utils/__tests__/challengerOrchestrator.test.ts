import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  decideFromSummaries,
  parseChallengerSummary,
  planChallengerSpawns,
  synthesizeRevisionFeedback,
  type ChallengeInput,
  type ChallengerSummary,
} from '../challenger-orchestrator'

const FIXTURES_PATH = resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'ground-truth', 'agent-summaries.sample.json')
const AGENT_FIXTURES = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')) as {
  challengerSummaries: Record<string, string>
}

const PLUGINS_BOTH = { codex: true, gemini: true }
const PLUGINS_NONE = { codex: false, gemini: false }
const PLUGINS_GEMINI_ONLY = { codex: false, gemini: true }

// ---------------------------------------------------------------------------
// 1. planChallengerSpawns — routing matrix (acceptance c)
// ---------------------------------------------------------------------------

describe('planChallengerSpawns — routing by phase type', () => {
  it('Critical=false → skipped: true, no spawns', () => {
    const input: ChallengeInput = {
      phaseId: '16',
      phaseType: 'backend',
      critical: false,
      plugins: PLUGINS_BOTH,
    }
    const plan = planChallengerSpawns(input)
    expect(plan.skipped).toBe(true)
    expect(plan.spawns).toEqual([])
    expect(plan.skipReason).toMatch(/not Critical/i)
  })

  it('backend + Critical=true → codex:codex-rescue + assumptions-analyzer', () => {
    const plan = planChallengerSpawns({
      phaseId: '16',
      phaseType: 'backend',
      critical: true,
      plugins: PLUGINS_BOTH,
    })
    expect(plan.skipped).toBe(false)
    expect(plan.spawns.map(s => s.agent)).toEqual([
      'codex:codex-rescue',
      'assumptions-analyzer',
    ])
    expect(plan.spawns.every(s => s.adversarial === true)).toBe(true)
    expect(plan.degraded).toBe(false)
  })

  it('frontend + Critical=true → gemini:gemini-rescue + nyquist-auditor', () => {
    const plan = planChallengerSpawns({
      phaseId: '17',
      phaseType: 'frontend',
      critical: true,
      plugins: PLUGINS_BOTH,
    })
    expect(plan.spawns.map(s => s.agent)).toEqual([
      'gemini:gemini-rescue',
      'nyquist-auditor',
    ])
  })

  it('fullstack + Critical=true → 双 plugin advisor + 双 specialist (4 spawns)', () => {
    const plan = planChallengerSpawns({
      phaseId: '20',
      phaseType: 'fullstack',
      critical: true,
      plugins: PLUGINS_BOTH,
    })
    expect(plan.spawns).toHaveLength(4)
    expect(plan.spawns.map(s => s.agent)).toEqual([
      'codex:codex-rescue',
      'gemini:gemini-rescue',
      'assumptions-analyzer',
      'nyquist-auditor',
    ])
  })

  it('docs + Critical=true → assumptions-analyzer 单兵', () => {
    const plan = planChallengerSpawns({
      phaseId: '12',
      phaseType: 'docs',
      critical: true,
      plugins: PLUGINS_BOTH,
    })
    expect(plan.spawns.map(s => s.agent)).toEqual(['assumptions-analyzer'])
  })

  it('generic + Critical=true → assumptions-analyzer 单兵', () => {
    const plan = planChallengerSpawns({
      phaseId: '99',
      phaseType: 'generic',
      critical: true,
      plugins: PLUGINS_BOTH,
    })
    expect(plan.spawns.map(s => s.agent)).toEqual(['assumptions-analyzer'])
  })
})

// ---------------------------------------------------------------------------
// 2. plugin degradation (acceptance d)
// ---------------------------------------------------------------------------

describe('planChallengerSpawns — plugin degradation', () => {
  it('backend + codex plugin missing → only assumptions-analyzer, degraded=true', () => {
    const plan = planChallengerSpawns({
      phaseId: '16',
      phaseType: 'backend',
      critical: true,
      plugins: PLUGINS_NONE,
    })
    expect(plan.skipped).toBe(false)
    expect(plan.spawns.map(s => s.agent)).toEqual(['assumptions-analyzer'])
    expect(plan.degraded).toBe(true)
    expect(plan.degradeNote).toMatch(/codex:codex-rescue/)
  })

  it('frontend + gemini plugin missing → only nyquist-auditor, degraded=true', () => {
    const plan = planChallengerSpawns({
      phaseId: '17',
      phaseType: 'frontend',
      critical: true,
      plugins: PLUGINS_NONE,
    })
    expect(plan.spawns.map(s => s.agent)).toEqual(['nyquist-auditor'])
    expect(plan.degraded).toBe(true)
    expect(plan.degradeNote).toMatch(/gemini:gemini-rescue/)
  })

  it('fullstack + only gemini plugin available → drops codex, keeps gemini + both specialists', () => {
    const plan = planChallengerSpawns({
      phaseId: '20',
      phaseType: 'fullstack',
      critical: true,
      plugins: PLUGINS_GEMINI_ONLY,
    })
    expect(plan.spawns.map(s => s.agent)).toEqual([
      'gemini:gemini-rescue',
      'assumptions-analyzer',
      'nyquist-auditor',
    ])
    expect(plan.degraded).toBe(true)
    expect(plan.degradeNote).toMatch(/codex:codex-rescue/)
  })

  it('docs + plugins missing → still single specialist, degraded=false (no plugin needed)', () => {
    const plan = planChallengerSpawns({
      phaseId: '12',
      phaseType: 'docs',
      critical: true,
      plugins: PLUGINS_NONE,
    })
    expect(plan.spawns.map(s => s.agent)).toEqual(['assumptions-analyzer'])
    expect(plan.degraded).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. parseChallengerSummary
// ---------------------------------------------------------------------------

describe('parseChallengerSummary — lenient summary parsing', () => {
  it('parses STATUS + FINDINGS (strict JSON) + NOTES', () => {
    const text = `STATUS: complete
FINDINGS: [{"severity":"critical","category":"assumption","message":"M1"},{"severity":"major","category":"design","message":"M2"}]
NOTES: deep audit done`
    const s = parseChallengerSummary('assumptions-analyzer', text)
    expect(s.status).toBe('complete')
    expect(s.findings).toEqual([
      { severity: 'critical', category: 'assumption', message: 'M1' },
      { severity: 'major', category: 'design', message: 'M2' },
    ])
    expect(s.notes).toBe('deep audit done')
  })

  it('parses lenient format (no JSON)', () => {
    const text = `STATUS: complete
FINDINGS: [{severity:"critical", category:"boundary", message:"off-by-one"}]
NOTES: ok`
    const s = parseChallengerSummary('nyquist-auditor', text)
    expect(s.findings).toHaveLength(1)
    expect(s.findings[0].severity).toBe('critical')
    expect(s.findings[0].category).toBe('boundary')
    expect(s.findings[0].message).toBe('off-by-one')
  })

  it('handles empty findings list', () => {
    const text = `STATUS: complete
FINDINGS: []
NOTES: clean`
    const s = parseChallengerSummary('codex:codex-rescue', text)
    expect(s.findings).toEqual([])
  })

  it('throws when STATUS missing', () => {
    expect(() =>
      parseChallengerSummary('assumptions-analyzer', 'NOTES: something'),
    ).toThrow(/STATUS/)
  })

  it('accepts STATUS: error', () => {
    const text = `STATUS: error
NOTES: plugin spawn failed`
    const s = parseChallengerSummary('codex:codex-rescue', text)
    expect(s.status).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// 4. decideFromSummaries (acceptance e mock cases)
// ---------------------------------------------------------------------------

describe('decideFromSummaries — main thread decision', () => {
  function mkSummary(
    agent: ChallengerSummary['agent'],
    findings: ChallengerSummary['findings'],
    status: ChallengerSummary['status'] = 'complete',
  ): ChallengerSummary {
    return { agent, status, findings, notes: '', raw: '' }
  }

  it('4 路摘要含 1 critical → revise', () => {
    const summaries: ChallengerSummary[] = [
      mkSummary('codex:codex-rescue', [
        { severity: 'critical', category: 'design', message: 'race condition' },
      ]),
      mkSummary('gemini:gemini-rescue', [{ severity: 'major', category: 'ux', message: 'm' }]),
      mkSummary('assumptions-analyzer', []),
      mkSummary('nyquist-auditor', [{ severity: 'info', category: 'edge', message: 'i' }]),
    ]
    expect(decideFromSummaries(summaries)).toBe('revise')
  })

  it('4 路摘要无 critical → advance', () => {
    const summaries: ChallengerSummary[] = [
      mkSummary('codex:codex-rescue', [{ severity: 'major', category: 'design', message: 'm' }]),
      mkSummary('gemini:gemini-rescue', []),
      mkSummary('assumptions-analyzer', [{ severity: 'info', category: 'note', message: 'n' }]),
      mkSummary('nyquist-auditor', []),
    ]
    expect(decideFromSummaries(summaries)).toBe('advance')
  })

  it('any error status → escalate', () => {
    const summaries: ChallengerSummary[] = [
      mkSummary('codex:codex-rescue', [], 'error'),
      mkSummary('assumptions-analyzer', []),
    ]
    expect(decideFromSummaries(summaries)).toBe('escalate')
  })

  it('empty summaries → advance (no challengers ran, treat as no findings)', () => {
    expect(decideFromSummaries([])).toBe('advance')
  })
})

// ---------------------------------------------------------------------------
// 5. synthesizeRevisionFeedback
// ---------------------------------------------------------------------------

describe('synthesizeRevisionFeedback', () => {
  function mkSummary(
    agent: ChallengerSummary['agent'],
    findings: ChallengerSummary['findings'],
  ): ChallengerSummary {
    return { agent, status: 'complete', findings, notes: '', raw: '' }
  }

  it('returns empty string when no critical findings', () => {
    const fb = synthesizeRevisionFeedback([
      mkSummary('codex:codex-rescue', [{ severity: 'major', category: 'a', message: 'b' }]),
    ])
    expect(fb).toBe('')
  })

  it('aggregates critical findings across challengers with provenance', () => {
    const fb = synthesizeRevisionFeedback([
      mkSummary('codex:codex-rescue', [
        { severity: 'critical', category: 'race', message: 'msg-1' },
        { severity: 'major', category: 'x', message: 'ignore' },
      ]),
      mkSummary('assumptions-analyzer', [
        { severity: 'critical', category: 'assumption', message: 'msg-2' },
      ]),
    ])
    expect(fb).toContain('Challenger 反馈')
    expect(fb).toContain('[codex:codex-rescue]')
    expect(fb).toContain('msg-1')
    expect(fb).toContain('[assumptions-analyzer]')
    expect(fb).toContain('msg-2')
    expect(fb).not.toContain('msg ignore')
    // Should contain both critical messages but not the major one
    expect(fb).toContain('(race)')
    expect(fb).toContain('(assumption)')
  })
})

// ---------------------------------------------------------------------------
// 6. Fixtures-driven tests (CCG v4.3 P28)
//
// Goal: replace inline mock JSON with real-shaped subagent summaries from
// tests/fixtures/ground-truth/agent-summaries.sample.json. This guards against
// the "mock-self-consistent ≠ real-correct" failure mode (e.g., codex:codex-rescue
// vs codex:codex-rescue, v4.2.3 fix).
// ---------------------------------------------------------------------------

describe('parseChallengerSummary — fixtures-driven (P28)', () => {
  it('parses fixture: complete_with_critical (real subagent shape with engine-restriction note)', () => {
    const text = AGENT_FIXTURES.challengerSummaries.complete_with_critical
    const s = parseChallengerSummary('assumptions-analyzer', text)
    expect(s.status).toBe('complete')
    expect(s.findings.length).toBeGreaterThanOrEqual(1)
    const critical = s.findings.find(f => f.severity === 'critical')
    expect(critical).toBeDefined()
    // Reality check: the fixture references the real codex:codex-rescue name (not the
    // v4.2.0 codex:codex-rescue typo). Parser does not normalize names.
    expect(critical!.message).toMatch(/codex:codex-rescue|codex:codex-rescue/)
    expect(s.notes.length).toBeGreaterThan(0)
  })

  it('parses fixture: complete_no_findings → empty findings array', () => {
    const text = AGENT_FIXTURES.challengerSummaries.complete_no_findings
    const s = parseChallengerSummary('codex:codex-rescue', text)
    expect(s.status).toBe('complete')
    expect(s.findings).toEqual([])
  })

  it('parses fixture: complete_lenient_format (single-quoted JSON-ish payload)', () => {
    const text = AGENT_FIXTURES.challengerSummaries.complete_lenient_format
    const s = parseChallengerSummary('nyquist-auditor', text)
    expect(s.status).toBe('complete')
    expect(s.findings).toHaveLength(1)
    expect(s.findings[0].severity).toBe('critical')
    expect(s.findings[0].category).toBe('boundary')
  })

  it('parses fixture: error_spawn_failed → status=error preserved', () => {
    const text = AGENT_FIXTURES.challengerSummaries.error_spawn_failed
    const s = parseChallengerSummary('codex:codex-rescue', text)
    expect(s.status).toBe('error')
    expect(s.notes).toMatch(/spawn refused|plugin/)
  })

  it('decideFromSummaries on fixture-built summaries reflects real-shape decisions', () => {
    const critical = parseChallengerSummary('codex:codex-rescue', AGENT_FIXTURES.challengerSummaries.complete_with_critical)
    const clean = parseChallengerSummary('assumptions-analyzer', AGENT_FIXTURES.challengerSummaries.complete_no_findings)
    expect(decideFromSummaries([critical, clean])).toBe('revise')

    const error = parseChallengerSummary('codex:codex-rescue', AGENT_FIXTURES.challengerSummaries.error_spawn_failed)
    expect(decideFromSummaries([error, clean])).toBe('escalate')

    expect(decideFromSummaries([clean])).toBe('advance')
  })
})
