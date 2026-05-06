/**
 * Tests for v4.5 P1f (Phase 6) nested G-plan opt-in + launcher wiring.
 *
 * Coverage:
 *   - parseNestedFlag: --nested=on|off|true|false (case-insensitive) + invalid
 *   - resolveNestedRescue: phase frontmatter > CLI flag > default false priority
 *   - PhaseMeta.nestedRescue field roundtrip via buildQualityPlan
 *   - buildPhaseRunnerLauncherCommand: shape + flags + path escape
 *   - planWavesForTier with useLauncherWiring: impl wave bashCommand uses launcher
 *     instead of bare `claude -p`
 *   - default `--nested=off` 100% equivalent to v4.5 P1a behavior
 */

import { describe, expect, it } from 'vitest'
import {
  buildPhaseRunnerLauncherCommand,
  buildQualityPlan,
  DEFAULT_LAUNCHER_PATH,
  MAX_NESTED_PER_PHASE,
  parseNestedFlag,
  planWavesForTier,
  resolveNestedRescue,
  type PhaseMeta,
} from '../quality-router'

const PLUGINS_BOTH = { codex: true, gemini: true }

const phase = (overrides: Partial<PhaseMeta> = {}): PhaseMeta => ({
  phaseId: 'phase-v4.5-06-nested-gplan-wiring',
  phaseType: 'backend',
  workdir: '/d/workflow/ccg-workflow',
  jobId: 'job-p6-abc',
  ...overrides,
})

// ---------------------------------------------------------------------------
// 1. parseNestedFlag
// ---------------------------------------------------------------------------

describe('parseNestedFlag', () => {
  it('parses --nested=on', () => {
    expect(parseNestedFlag('--nested=on')).toBe(true)
  })
  it('parses --nested=off', () => {
    expect(parseNestedFlag('--nested=off')).toBe(false)
  })
  it('parses --nested=true / --nested=false', () => {
    expect(parseNestedFlag('--nested=true')).toBe(true)
    expect(parseNestedFlag('--nested=false')).toBe(false)
  })
  it('parses space form', () => {
    expect(parseNestedFlag('--nested on')).toBe(true)
    expect(parseNestedFlag('--nested off')).toBe(false)
  })
  it('case insensitive', () => {
    expect(parseNestedFlag('--NESTED=On')).toBe(true)
    expect(parseNestedFlag('--Nested=OFF')).toBe(false)
  })
  it('returns null for invalid value', () => {
    expect(parseNestedFlag('--nested=maybe')).toBeNull()
    expect(parseNestedFlag('--nested=1')).toBeNull()
  })
  it('returns null when flag absent or empty', () => {
    expect(parseNestedFlag('')).toBeNull()
    expect(parseNestedFlag(undefined)).toBeNull()
    expect(parseNestedFlag('--from 3 --to 5')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. resolveNestedRescue priority stack
// ---------------------------------------------------------------------------

describe('resolveNestedRescue', () => {
  it('phase override beats flag (true)', () => {
    const r = resolveNestedRescue({
      cliArgs: '--nested=off',
      phaseNestedRescue: true,
    })
    expect(r.enabled).toBe(true)
    expect(r.source).toBe('phase-override')
  })

  it('phase override beats flag (false)', () => {
    const r = resolveNestedRescue({
      cliArgs: '--nested=on',
      phaseNestedRescue: false,
    })
    expect(r.enabled).toBe(false)
    expect(r.source).toBe('phase-override')
  })

  it('flag used when no phase override', () => {
    expect(resolveNestedRescue({ cliArgs: '--nested=on' })).toEqual({
      enabled: true,
      source: 'cli-flag',
    })
    expect(resolveNestedRescue({ cliArgs: '--nested=off' })).toEqual({
      enabled: false,
      source: 'cli-flag',
    })
  })

  it('default false when nothing set', () => {
    expect(resolveNestedRescue({})).toEqual({
      enabled: false,
      source: 'default',
    })
  })

  it('invalid flag value falls through to default', () => {
    expect(resolveNestedRescue({ cliArgs: '--nested=bogus' })).toEqual({
      enabled: false,
      source: 'default',
    })
  })
})

// ---------------------------------------------------------------------------
// 3. PhaseMeta.nestedRescue field interaction
// ---------------------------------------------------------------------------

describe('PhaseMeta.nestedRescue field', () => {
  it('typed field accepts true / false / undefined', () => {
    const p1: PhaseMeta = phase({ nestedRescue: true })
    const p2: PhaseMeta = phase({ nestedRescue: false })
    const p3: PhaseMeta = phase()
    expect(p1.nestedRescue).toBe(true)
    expect(p2.nestedRescue).toBe(false)
    expect(p3.nestedRescue).toBeUndefined()
  })

  it('does not affect quality plan structure (plan/critic/impl/verify wave shape stable)', () => {
    const planA = buildQualityPlan({}, phase({ nestedRescue: true }), PLUGINS_BOTH)
    const planB = buildQualityPlan({}, phase({ nestedRescue: false }), PLUGINS_BOTH)
    const planC = buildQualityPlan({}, phase(), PLUGINS_BOTH)
    expect(planA.waves.map(w => w.kind)).toEqual(planB.waves.map(w => w.kind))
    expect(planB.waves.map(w => w.kind)).toEqual(planC.waves.map(w => w.kind))
  })
})

// ---------------------------------------------------------------------------
// 4. buildPhaseRunnerLauncherCommand
// ---------------------------------------------------------------------------

describe('buildPhaseRunnerLauncherCommand', () => {
  it('produces node launcher invocation with required flags', () => {
    const cmd = buildPhaseRunnerLauncherCommand(phase(), { tier: 'triple' })
    expect(cmd).toContain('node')
    expect(cmd).toContain(DEFAULT_LAUNCHER_PATH)
    expect(cmd).toContain('--job-id')
    expect(cmd).toContain('--workdir')
    expect(cmd).toContain('--prompt-file')
    expect(cmd).toContain('--tier')
    expect(cmd).toContain('--grace-ms')
  })

  it('passes phase.jobId / workdir to launcher flags', () => {
    const cmd = buildPhaseRunnerLauncherCommand(phase({
      jobId: 'job-xyz',
      workdir: '/var/repo',
    }))
    expect(cmd).toContain(`--job-id 'job-xyz'`)
    expect(cmd).toContain(`--workdir '/var/repo'`)
    expect(cmd).toContain(`--prompt-file '.context/jobs/job-xyz/prompt.txt'`)
    expect(cmd).toContain(`> '.context/jobs/job-xyz/progress.jsonl' 2>&1`)
  })

  it('options override phase defaults', () => {
    const cmd = buildPhaseRunnerLauncherCommand(phase(), {
      jobId: 'override-id',
      workdir: '/custom/path',
      tier: 'fast',
    })
    expect(cmd).toContain(`--job-id 'override-id'`)
    expect(cmd).toContain(`--workdir '/custom/path'`)
    expect(cmd).toContain(`--tier 'fast'`)
    expect(cmd).not.toContain('job-p6-abc')
  })

  it('falls back to placeholder when missing fields', () => {
    const cmd = buildPhaseRunnerLauncherCommand(phase({
      workdir: undefined,
      jobId: undefined,
    }))
    expect(cmd).toContain('<JOB_ID>')
    expect(cmd).toContain('<WORKDIR>')
  })

  it('rejects invalid tier', () => {
    expect(() => buildPhaseRunnerLauncherCommand(phase(), {
      // @ts-expect-error invalid tier
      tier: 'ludicrous',
    })).toThrow(/invalid tier/)
  })

  it('handles paths with single quotes via escaping', () => {
    const cmd = buildPhaseRunnerLauncherCommand(phase(), {
      workdir: `/tmp/joe's-repo`,
    })
    expect(cmd).toContain(`--workdir '/tmp/joe'\\''s-repo'`)
  })

  it('handles Windows native path', () => {
    const cmd = buildPhaseRunnerLauncherCommand(phase(), {
      workdir: 'D:\\workflow\\ccg-workflow',
    })
    expect(cmd).toContain(`--workdir 'D:\\workflow\\ccg-workflow'`)
  })

  it('appends max-budget-usd when override given', () => {
    const cmd = buildPhaseRunnerLauncherCommand(phase(), {
      tier: 'fast',
      maxBudgetUsd: 7.5,
    })
    expect(cmd).toContain('--max-budget-usd 7.5')
  })

  it('omits max-budget-usd when not given (launcher uses tier default)', () => {
    const cmd = buildPhaseRunnerLauncherCommand(phase(), { tier: 'fast' })
    expect(cmd).not.toContain('--max-budget-usd')
  })

  it('grace-ms defaults to 5000', () => {
    const cmd = buildPhaseRunnerLauncherCommand(phase())
    expect(cmd).toContain('--grace-ms 5000')
  })

  it('grace-ms override', () => {
    const cmd = buildPhaseRunnerLauncherCommand(phase(), { graceMs: 10000 })
    expect(cmd).toContain('--grace-ms 10000')
  })

  it('custom launcher path for tests', () => {
    const cmd = buildPhaseRunnerLauncherCommand(phase(), {
      launcherPath: '/test/fixtures/launcher.mjs',
    })
    expect(cmd).toContain(`node '/test/fixtures/launcher.mjs'`)
    expect(cmd).not.toContain(DEFAULT_LAUNCHER_PATH)
  })
})

// ---------------------------------------------------------------------------
// 5. planWavesForTier with useLauncherWiring
// ---------------------------------------------------------------------------

describe('planWavesForTier: useLauncherWiring propagation', () => {
  it('default (no option) → impl wave no bashCommand at all (BC)', () => {
    const r = planWavesForTier('triple', phase(), PLUGINS_BOTH)
    const impl = r.waves.find(w => w.kind === 'impl')!
    expect(impl.spawns[0].invocationMode).toBeUndefined()
    expect(impl.spawns[0].bashCommand).toBeUndefined()
  })

  it('useDirectBashInvocation only → bashCommand uses bare claude -p (P1a path)', () => {
    const r = planWavesForTier('triple', phase(), PLUGINS_BOTH, {
      useDirectBashInvocation: true,
    })
    const impl = r.waves.find(w => w.kind === 'impl')!
    expect(impl.spawns[0].invocationMode).toBe('bash-direct')
    expect(impl.spawns[0].bashCommand).toContain('claude -p')
    expect(impl.spawns[0].bashCommand).not.toContain('ccg-phase-runner-launcher')
  })

  it('useDirectBashInvocation + useLauncherWiring → bashCommand uses launcher (P1f path)', () => {
    const r = planWavesForTier('triple', phase(), PLUGINS_BOTH, {
      useDirectBashInvocation: true,
      useLauncherWiring: true,
    })
    const impl = r.waves.find(w => w.kind === 'impl')!
    expect(impl.spawns[0].invocationMode).toBe('bash-direct')
    expect(impl.spawns[0].bashCommand).toContain('ccg-phase-runner-launcher')
    expect(impl.spawns[0].bashCommand).toContain('--job-id')
    expect(impl.spawns[0].bashCommand).toContain('--workdir')
  })

  it('useLauncherWiring without useDirectBashInvocation is ignored (BC)', () => {
    const r = planWavesForTier('triple', phase(), PLUGINS_BOTH, {
      useLauncherWiring: true,
    })
    const impl = r.waves.find(w => w.kind === 'impl')!
    // No bash-direct → launcher wiring inert
    expect(impl.spawns[0].invocationMode).toBeUndefined()
    expect(impl.spawns[0].bashCommand).toBeUndefined()
  })

  it('launcher path includes --tier matching phase tier', () => {
    const r = planWavesForTier('debate', phase(), PLUGINS_BOTH, {
      useDirectBashInvocation: true,
      useLauncherWiring: true,
    })
    const impl = r.waves.find(w => w.kind === 'impl')!
    expect(impl.spawns[0].bashCommand).toContain(`--tier 'debate'`)
  })

  it('fast tier launcher cmd', () => {
    const r = planWavesForTier('fast', phase(), PLUGINS_BOTH, {
      useDirectBashInvocation: true,
      useLauncherWiring: true,
    })
    const impl = r.waves.find(w => w.kind === 'impl')!
    expect(impl.spawns[0].bashCommand).toContain(`--tier 'fast'`)
  })
})

// ---------------------------------------------------------------------------
// 6. buildQualityPlan one-shot wiring opt-in
// ---------------------------------------------------------------------------

describe('buildQualityPlan: P1f launcher wiring opt-in', () => {
  it('without useLauncherWiring → impl wave uses bare claude -p', () => {
    const p = buildQualityPlan({}, phase(), PLUGINS_BOTH, {
      useDirectBashInvocation: true,
    })
    const impl = p.waves.find(w => w.kind === 'impl')!
    expect(impl.spawns[0].bashCommand).toContain('claude -p')
    expect(impl.spawns[0].bashCommand).not.toContain('ccg-phase-runner-launcher')
  })

  it('with useLauncherWiring=true → impl wave uses launcher', () => {
    const p = buildQualityPlan({}, phase(), PLUGINS_BOTH, {
      useDirectBashInvocation: true,
      useLauncherWiring: true,
    })
    const impl = p.waves.find(w => w.kind === 'impl')!
    expect(impl.spawns[0].bashCommand).toContain('ccg-phase-runner-launcher')
    expect(impl.spawns[0].bashCommand).toMatch(/--job-id/)
  })

  it('verify wave bash-direct propagation unchanged with launcher option', () => {
    const p = buildQualityPlan({}, phase(), PLUGINS_BOTH, {
      useDirectBashInvocation: true,
      useLauncherWiring: true,
    })
    const verify = p.waves.find(w => w.kind === 'verify')!
    const pluginSpawns = verify.spawns.filter(s => s.agent.includes(':'))
    for (const s of pluginSpawns) {
      expect(s.invocationMode).toBe('bash-direct')
    }
  })
})

// ---------------------------------------------------------------------------
// 7. Default --nested=off behavior 100% equivalent to v4.5 v1
// ---------------------------------------------------------------------------

describe('default nested=off behavior is BC-equivalent', () => {
  it('plan structure identical between explicit off and unset', () => {
    const explicit = buildQualityPlan(
      { cliArgs: '--nested=off' },
      phase(),
      PLUGINS_BOTH,
      { useDirectBashInvocation: true, useLauncherWiring: true },
    )
    const unset = buildQualityPlan(
      {},
      phase(),
      PLUGINS_BOTH,
      { useDirectBashInvocation: true, useLauncherWiring: true },
    )
    expect(explicit.waves.length).toBe(unset.waves.length)
    expect(explicit.waves.map(w => w.kind)).toEqual(unset.waves.map(w => w.kind))
    expect(explicit.tier).toBe(unset.tier)
  })

  it('nested flag does not appear in any spawn entry rationale', () => {
    // nested_rescue is a runtime injection into phase-runner prompt, not a
    // routing decision in quality-router. Confirm no spawns leak the field.
    const p = buildQualityPlan(
      { cliArgs: '--nested=on' },
      phase({ nestedRescue: true }),
      PLUGINS_BOTH,
      { useDirectBashInvocation: true, useLauncherWiring: true },
    )
    for (const w of p.waves) {
      for (const s of w.spawns) {
        expect(s.rationale).not.toMatch(/nested_rescue/)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 8. CAP=3 invariant exposed for phase-runner
// ---------------------------------------------------------------------------

describe('MAX_NESTED_PER_PHASE constant', () => {
  it('is 3 (per Phase 3 P1c memory stress decision)', () => {
    expect(MAX_NESTED_PER_PHASE).toBe(3)
  })
  it('is exported as a number constant', () => {
    expect(typeof MAX_NESTED_PER_PHASE).toBe('number')
    expect(Number.isInteger(MAX_NESTED_PER_PHASE)).toBe(true)
    expect(MAX_NESTED_PER_PHASE).toBeGreaterThan(0)
  })
})
