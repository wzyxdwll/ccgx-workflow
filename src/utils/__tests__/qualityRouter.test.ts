import { describe, expect, it } from 'vitest'
import {
  buildQualityPlan,
  parseQualityFlag,
  planWavesForTier,
  resolveQualityTier,
  type PhaseMeta,
} from '../quality-router'

const PLUGINS_BOTH = { codex: true, gemini: true }
const PLUGINS_NONE = { codex: false, gemini: false }
const PLUGINS_GEMINI_ONLY = { codex: false, gemini: true }
const PLUGINS_CODEX_ONLY = { codex: true, gemini: false }

const phase = (overrides: Partial<PhaseMeta> = {}): PhaseMeta => ({
  phaseId: 'phase-22',
  phaseType: 'backend',
  ...overrides,
})

// ---------------------------------------------------------------------------
// 1. parseQualityFlag
// ---------------------------------------------------------------------------

describe('parseQualityFlag', () => {
  it('parses --quality=fast', () => {
    expect(parseQualityFlag('--quality=fast')).toBe('fast')
  })
  it('parses --quality triple (space form)', () => {
    expect(parseQualityFlag('--quality triple')).toBe('triple')
  })
  it('parses debate', () => {
    expect(parseQualityFlag('--quality=debate')).toBe('debate')
  })
  it('case insensitive', () => {
    expect(parseQualityFlag('--QUALITY=Fast')).toBe('fast')
  })
  it('returns null for invalid value', () => {
    expect(parseQualityFlag('--quality=ludicrous')).toBeNull()
  })
  it('returns null for empty / undefined', () => {
    expect(parseQualityFlag('')).toBeNull()
    expect(parseQualityFlag(undefined)).toBeNull()
  })
  it('returns null when flag absent', () => {
    expect(parseQualityFlag('--from 3 --to 5')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. resolveQualityTier — priority stack
// ---------------------------------------------------------------------------

describe('resolveQualityTier', () => {
  it('phase override wins over flag', () => {
    const r = resolveQualityTier({ cliArgs: '--quality=fast', phaseQuality: 'debate' })
    expect(r.tier).toBe('debate')
    expect(r.source).toBe('phase-override')
  })
  it('flag used when no phase override', () => {
    const r = resolveQualityTier({ cliArgs: '--quality=fast' })
    expect(r.tier).toBe('fast')
    expect(r.source).toBe('cli-flag')
  })
  it('default triple when nothing set', () => {
    const r = resolveQualityTier({})
    expect(r.tier).toBe('triple')
    expect(r.source).toBe('default')
  })
  it('invalid phase override falls through to flag', () => {
    const r = resolveQualityTier({
      cliArgs: '--quality=fast',
      // @ts-expect-error intentional bad value
      phaseQuality: 'bogus',
    })
    expect(r.tier).toBe('fast')
    expect(r.source).toBe('cli-flag')
  })
})

// ---------------------------------------------------------------------------
// 3. planWavesForTier — wave shape per tier
// ---------------------------------------------------------------------------

describe('planWavesForTier — fast tier', () => {
  it('produces 2 waves: impl + verify', () => {
    const r = planWavesForTier('fast', phase(), PLUGINS_BOTH)
    expect(r.waves.length).toBe(2)
    expect(r.waves[0].kind).toBe('impl')
    expect(r.waves[1].kind).toBe('verify')
    expect(r.degraded).toBe(false)
    expect(r.effectiveTier).toBe('fast')
  })

  it('fast verify: backend phase → gemini verify (cross-vendor)', () => {
    const r = planWavesForTier('fast', phase({ phaseType: 'backend' }), PLUGINS_BOTH)
    const verifyWave = r.waves[1]
    expect(verifyWave.spawns).toHaveLength(1)
    expect(verifyWave.spawns[0].agent).toBe('gemini:rescue')
  })

  it('fast verify: frontend phase → codex verify', () => {
    const r = planWavesForTier('fast', phase({ phaseType: 'frontend' }), PLUGINS_BOTH)
    expect(r.waves[1].spawns[0].agent).toBe('codex:rescue')
  })

  it('fast verify: interface-auditor NOT present (fast 优先速度)', () => {
    const r = planWavesForTier('fast', phase(), PLUGINS_BOTH)
    const verify = r.waves[1]
    expect(verify.spawns.map(s => s.agent)).not.toContain('interface-auditor')
  })
})

describe('planWavesForTier — triple tier', () => {
  it('produces 4 waves: plan + critic + impl + verify', () => {
    const r = planWavesForTier('triple', phase(), PLUGINS_BOTH)
    expect(r.waves.map(w => w.kind)).toEqual(['plan', 'critic', 'impl', 'verify'])
  })

  it('plan wave has 3 lateral-diversity paths (codex + gemini + claude)', () => {
    const r = planWavesForTier('triple', phase(), PLUGINS_BOTH)
    const planWave = r.waves[0]
    expect(planWave.spawns).toHaveLength(3)
    expect(planWave.spawns[0].agent).toBe('codex:rescue')
    expect(planWave.spawns[1].agent).toBe('gemini:rescue')
    expect(planWave.spawns[2].agent).toBe('general-purpose')
    expect(planWave.spawns[2].ccgPromptFile).toContain('claude/architect.md')
  })

  it('critic wave: angle-based 2 specialists (assumptions + nyquist) regardless of layer', () => {
    const r = planWavesForTier('triple', phase({ phaseType: 'frontend' }), PLUGINS_BOTH)
    const criticWave = r.waves[1]
    expect(criticWave.spawns.map(s => s.agent)).toEqual([
      'assumptions-analyzer',
      'nyquist-auditor',
    ])
  })

  it('impl wave: single phase-runner', () => {
    const r = planWavesForTier('triple', phase(), PLUGINS_BOTH)
    expect(r.waves[2].spawns).toHaveLength(1)
    expect(r.waves[2].spawns[0].agent).toBe('phase-runner')
  })

  it('verify wave: dual cross-vendor (codex + gemini) + interface-auditor (P27)', () => {
    const r = planWavesForTier('triple', phase(), PLUGINS_BOTH)
    const verify = r.waves[3]
    expect(verify.spawns).toHaveLength(3)
    expect(verify.spawns.map(s => s.agent)).toEqual([
      'codex:rescue',
      'gemini:rescue',
      'interface-auditor',
    ])
    // interface-auditor must be tagged role=verifier
    expect(verify.spawns[2].role).toBe('verifier')
    // rationale should mention layer for debugging visibility
    expect(verify.spawns[2].rationale).toMatch(/interface audit/i)
  })

  it('verify wave: interface-auditor present even when plugins degraded', () => {
    const r = planWavesForTier('triple', phase(), PLUGINS_CODEX_ONLY)
    const verify = r.waves[3]
    // 2 verify slots (gemini → fallback) + interface-auditor
    expect(verify.spawns).toHaveLength(3)
    expect(verify.spawns[2].agent).toBe('interface-auditor')
  })
})

describe('planWavesForTier — debate tier', () => {
  it('produces 7 waves: plan + 3 debate rounds + critic + impl + verify', () => {
    const r = planWavesForTier('debate', phase(), PLUGINS_BOTH)
    expect(r.waves).toHaveLength(7)
    expect(r.waves.map(w => w.kind)).toEqual([
      'plan',
      'debate', 'debate', 'debate',
      'critic', 'impl', 'verify',
    ])
  })

  it('debate rounds carry round number 1..3', () => {
    const r = planWavesForTier('debate', phase(), PLUGINS_BOTH)
    const debateWaves = r.waves.filter(w => w.kind === 'debate')
    expect(debateWaves.map(w => w.round)).toEqual([1, 2, 3])
  })

  it('debate r1 = propose; r2 = challenge; r3 = respond', () => {
    const r = planWavesForTier('debate', phase({ phaseType: 'backend' }), PLUGINS_BOTH)
    const r1 = r.waves[1] // propose
    const r2 = r.waves[2] // challenge
    const r3 = r.waves[3] // respond
    // backend: propose=codex / challenge=gemini / respond=codex
    expect(r1.spawns[0].agent).toBe('codex:rescue')
    expect(r2.spawns[0].agent).toBe('gemini:rescue')
    expect(r3.spawns[0].agent).toBe('codex:rescue')
  })

  it('debate fullstack r1 propose has both codex + gemini', () => {
    const r = planWavesForTier('debate', phase({ phaseType: 'fullstack' }), PLUGINS_BOTH)
    const r1 = r.waves[1]
    expect(r1.spawns).toHaveLength(2)
    expect(r1.spawns.map(s => s.agent).sort()).toEqual([
      'codex:rescue',
      'gemini:rescue',
    ])
  })

  it('debate verify wave (last): codex + gemini + interface-auditor (P27)', () => {
    const r = planWavesForTier('debate', phase(), PLUGINS_BOTH)
    const verify = r.waves[r.waves.length - 1]
    expect(verify.kind).toBe('verify')
    expect(verify.spawns).toHaveLength(3)
    expect(verify.spawns.map(s => s.agent)).toEqual([
      'codex:rescue',
      'gemini:rescue',
      'interface-auditor',
    ])
  })
})

// ---------------------------------------------------------------------------
// 4. Plugin degradation paths
// ---------------------------------------------------------------------------

describe('planWavesForTier — plugin degradation', () => {
  it('debate + both plugins missing → degrade to fast', () => {
    const r = planWavesForTier('debate', phase(), PLUGINS_NONE)
    expect(r.effectiveTier).toBe('fast')
    expect(r.degradedTo).toBe('fast')
    expect(r.degraded).toBe(true)
    expect(r.waves.map(w => w.kind)).toEqual(['impl', 'verify'])
  })

  it('debate + only one plugin available → degrade to triple', () => {
    const r = planWavesForTier('debate', phase(), PLUGINS_GEMINI_ONLY)
    expect(r.effectiveTier).toBe('triple')
    expect(r.degradedTo).toBe('triple')
    expect(r.degraded).toBe(true)
  })

  it('triple + both plugins missing → degrade to fast', () => {
    const r = planWavesForTier('triple', phase(), PLUGINS_NONE)
    expect(r.effectiveTier).toBe('fast')
    expect(r.degradedTo).toBe('fast')
    expect(r.degraded).toBe(true)
  })

  it('triple + only codex available → no tier degrade, but plan wave wave-level degraded', () => {
    const r = planWavesForTier('triple', phase(), PLUGINS_CODEX_ONLY)
    expect(r.effectiveTier).toBe('triple')
    expect(r.degradedTo).toBeUndefined()
    expect(r.degraded).toBe(true) // wave-level
    const planWave = r.waves[0]
    expect(planWave.degraded).toBe(true)
    // gemini path replaced by general-purpose
    expect(planWave.spawns[1].agent).toBe('general-purpose')
    expect(planWave.spawns[1].ccgPromptFile).toContain('gemini/architect.md')
  })

  it('fast + both plugins missing → main-thread reviewer fallback', () => {
    const r = planWavesForTier('fast', phase(), PLUGINS_NONE)
    expect(r.effectiveTier).toBe('fast')
    expect(r.degraded).toBe(true)
    const verify = r.waves[1]
    expect(verify.spawns[0].agent).toBe('general-purpose')
    expect(verify.spawns[0].ccgPromptFile).toContain('claude/reviewer.md')
  })

  it('fast + frontend phase + codex missing → fallback to gemini for verify', () => {
    const r = planWavesForTier('fast', phase({ phaseType: 'frontend' }), PLUGINS_GEMINI_ONLY)
    const verify = r.waves[1]
    expect(verify.degraded).toBe(true)
    expect(verify.spawns[0].agent).toBe('gemini:rescue')
  })

  it('throws on invalid tier', () => {
    expect(() =>
      // @ts-expect-error intentional bad value
      planWavesForTier('ludicrous', phase(), PLUGINS_BOTH),
    ).toThrow(/invalid tier/)
  })
})

// ---------------------------------------------------------------------------
// 5. buildQualityPlan one-shot
// ---------------------------------------------------------------------------

describe('buildQualityPlan — one-shot integration', () => {
  it('default → triple plan', () => {
    const p = buildQualityPlan({}, phase(), PLUGINS_BOTH)
    expect(p.tier).toBe('triple')
    expect(p.source).toBe('default')
    expect(p.waves.map(w => w.kind)).toEqual(['plan', 'critic', 'impl', 'verify'])
  })

  it('--quality=fast cli flag → fast plan', () => {
    const p = buildQualityPlan({ cliArgs: '--quality=fast' }, phase(), PLUGINS_BOTH)
    expect(p.tier).toBe('fast')
    expect(p.source).toBe('cli-flag')
    expect(p.waves).toHaveLength(2)
  })

  it('phase Quality override → debate plan despite --quality=fast', () => {
    const p = buildQualityPlan(
      { cliArgs: '--quality=fast' },
      phase({ quality: 'debate' }),
      PLUGINS_BOTH,
    )
    expect(p.tier).toBe('debate')
    expect(p.source).toBe('phase-override')
    expect(p.waves).toHaveLength(7)
  })

  it('debate + plugin degrade → tier=debate but waves match fast', () => {
    const p = buildQualityPlan({ cliArgs: '--quality=debate' }, phase(), PLUGINS_NONE)
    expect(p.tier).toBe('debate') // user-requested
    expect(p.degraded).toBe(true)
    expect(p.degradedTo).toBe('fast')
    expect(p.waves.map(w => w.kind)).toEqual(['impl', 'verify'])
  })
})
