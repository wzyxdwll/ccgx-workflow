/**
 * Tests for v4.5 P1a `buildPhaseRunnerBashCommand` + companion helpers in
 * `quality-router.ts`. Covers PoC D1-D8 decisions + acceptance contract:
 *
 *   - all required CLI flags present (D1/D2/D3/D4)
 *   - max-budget tier mapping (D3: fast=1.0 / triple=2.0 / debate=5.0)
 *   - subprocess cwd via --add-dir (D5)
 *   - stream-json file path .context/jobs/<jobId>/progress.jsonl (D6)
 *   - special-character / Windows-path escape correctness
 *   - parsePhaseRunnerStreamSummary picks `result.result` from last line (D8)
 *   - planWavesForTier `useDirectBashInvocation` propagates to impl wave
 *   - buildQualityPlan one-shot opt-in path
 */

import { describe, expect, it } from 'vitest'
import {
  buildPhaseRunnerBashCommand,
  buildQualityPlan,
  parsePhaseRunnerStreamSummary,
  planWavesForTier,
  shellSingleQuote,
  type PhaseMeta,
} from '../quality-router'

const PLUGINS_BOTH = { codex: true, gemini: true }

const phase = (overrides: Partial<PhaseMeta> = {}): PhaseMeta => ({
  phaseId: 'phase-v4.5-01-cli-subprocess-mvp',
  phaseType: 'backend',
  workdir: '/d/workflow/ccg-workflow',
  jobId: 'job-abc123',
  ...overrides,
})

// ---------------------------------------------------------------------------
// 1. Required flags presence (PoC D1/D2/D4)
// ---------------------------------------------------------------------------

describe('buildPhaseRunnerBashCommand: required flags', () => {
  it('contains all PoC-mandated flags for fast tier', () => {
    const cmd = buildPhaseRunnerBashCommand(phase(), '', undefined, { tier: 'fast' })
    expect(cmd).toContain('--agent ccg/phase-runner')
    expect(cmd).toContain('--output-format stream-json')
    expect(cmd).toContain('--verbose')
    expect(cmd).toContain('--include-partial-messages')
    expect(cmd).toContain('--max-budget-usd 1')
    expect(cmd).toContain('--dangerously-skip-permissions')
    expect(cmd).toContain('--add-dir')
  })

  it('contains all PoC-mandated flags for triple tier', () => {
    const cmd = buildPhaseRunnerBashCommand(phase(), '', undefined, { tier: 'triple' })
    expect(cmd).toContain('--max-budget-usd 2')
    // both stream-json and verbose required (D1 hidden requirement T4)
    expect(cmd).toContain('--output-format stream-json')
    expect(cmd).toContain('--verbose')
  })

  it('contains all PoC-mandated flags for debate tier', () => {
    const cmd = buildPhaseRunnerBashCommand(phase(), '', undefined, { tier: 'debate' })
    expect(cmd).toContain('--max-budget-usd 5')
  })
})

// ---------------------------------------------------------------------------
// 2. max-budget tier mapping (D3)
// ---------------------------------------------------------------------------

describe('buildPhaseRunnerBashCommand: max-budget mapping', () => {
  it('fast → 1.0', () => {
    const cmd = buildPhaseRunnerBashCommand(phase(), '', undefined, { tier: 'fast' })
    expect(cmd).toMatch(/--max-budget-usd 1(?:\s|$)/)
  })
  it('triple → 2.0', () => {
    const cmd = buildPhaseRunnerBashCommand(phase(), '', undefined, { tier: 'triple' })
    expect(cmd).toMatch(/--max-budget-usd 2(?:\s|$)/)
  })
  it('debate → 5.0', () => {
    const cmd = buildPhaseRunnerBashCommand(phase(), '', undefined, { tier: 'debate' })
    expect(cmd).toMatch(/--max-budget-usd 5(?:\s|$)/)
  })
  it('explicit override beats tier default', () => {
    const cmd = buildPhaseRunnerBashCommand(phase(), '', undefined, {
      tier: 'fast',
      maxBudgetUsd: 7.5,
    })
    expect(cmd).toContain('--max-budget-usd 7.5')
  })
  it('falls back to phase.quality if tier not provided', () => {
    const cmd = buildPhaseRunnerBashCommand(
      phase({ quality: 'debate' }),
      '',
      undefined,
    )
    expect(cmd).toContain('--max-budget-usd 5')
  })
  it('defaults to triple (2.0) when neither tier nor phase.quality set', () => {
    const cmd = buildPhaseRunnerBashCommand(phase({ quality: undefined }), '', undefined)
    expect(cmd).toContain('--max-budget-usd 2')
  })
  it('rejects invalid budget', () => {
    expect(() =>
      buildPhaseRunnerBashCommand(phase(), '', undefined, { maxBudgetUsd: 0 }),
    ).toThrow(/maxBudgetUsd/)
    expect(() =>
      buildPhaseRunnerBashCommand(phase(), '', undefined, { maxBudgetUsd: -1 }),
    ).toThrow()
    expect(() =>
      buildPhaseRunnerBashCommand(phase(), '', undefined, { maxBudgetUsd: NaN }),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// 3. cwd / progress file paths (D5/D6)
// ---------------------------------------------------------------------------

describe('buildPhaseRunnerBashCommand: paths', () => {
  it('--add-dir uses phase.workdir by default (D5)', () => {
    const cmd = buildPhaseRunnerBashCommand(
      phase({ workdir: '/d/workflow/ccg-workflow' }),
      '',
      undefined,
    )
    expect(cmd).toContain(`--add-dir '/d/workflow/ccg-workflow'`)
  })

  it('options.workdir overrides phase.workdir', () => {
    const cmd = buildPhaseRunnerBashCommand(phase(), '', undefined, {
      workdir: '/var/repo',
    })
    expect(cmd).toContain(`--add-dir '/var/repo'`)
  })

  it('redirects stream-json to .context/jobs/<jobId>/progress.jsonl (D6)', () => {
    const cmd = buildPhaseRunnerBashCommand(phase(), '', 'job-xyz')
    expect(cmd).toContain(`> '.context/jobs/job-xyz/progress.jsonl' 2>&1`)
  })

  it('jobId arg beats phase.jobId', () => {
    const cmd = buildPhaseRunnerBashCommand(
      phase({ jobId: 'phase-default' }),
      '',
      'cli-override',
    )
    expect(cmd).toContain(`'.context/jobs/cli-override/progress.jsonl'`)
    expect(cmd).not.toContain('phase-default')
  })

  it('falls back to <JOB_ID> placeholder when missing both', () => {
    const cmd = buildPhaseRunnerBashCommand(
      phase({ jobId: undefined }),
      '',
      undefined,
    )
    expect(cmd).toContain('<JOB_ID>')
  })

  it('falls back to <WORKDIR> placeholder when missing workdir', () => {
    const cmd = buildPhaseRunnerBashCommand(
      phase({ workdir: undefined }),
      '',
      'job-1',
    )
    expect(cmd).toContain(`--add-dir '<WORKDIR>'`)
  })
})

// ---------------------------------------------------------------------------
// 4. Special-character escape / Windows path
// ---------------------------------------------------------------------------

describe('shellSingleQuote: parameter escaping', () => {
  it('wraps plain string in single quotes', () => {
    expect(shellSingleQuote('hello')).toBe(`'hello'`)
  })
  it('escapes embedded single quotes', () => {
    expect(shellSingleQuote(`it's`)).toBe(`'it'\\''s'`)
  })
  it('preserves double quotes / dollar / backslash literally', () => {
    // POSIX single-quote: $ and " and \ are all literal
    expect(shellSingleQuote(`$VAR "hi"`)).toBe(`'$VAR "hi"'`)
    expect(shellSingleQuote(`a\\b`)).toBe(`'a\\b'`)
  })
  it('Windows-style backslash path stays literal', () => {
    // CCG dogfoods on Windows; --add-dir typically takes git-bash style /d/...
    // but native D:\\workflow\\ccg-workflow must also pass through unmolested
    expect(shellSingleQuote(`D:\\workflow\\ccg-workflow`)).toBe(
      `'D:\\workflow\\ccg-workflow'`,
    )
  })
  it('newline characters preserved literally', () => {
    expect(shellSingleQuote('line1\nline2')).toBe(`'line1\nline2'`)
  })
})

describe('buildPhaseRunnerBashCommand: Windows path tolerance', () => {
  it('accepts native Windows path', () => {
    const cmd = buildPhaseRunnerBashCommand(phase(), '', 'job-1', {
      workdir: 'D:\\workflow\\ccg-workflow',
    })
    expect(cmd).toContain(`--add-dir 'D:\\workflow\\ccg-workflow'`)
  })
  it('accepts git-bash POSIX path', () => {
    const cmd = buildPhaseRunnerBashCommand(phase(), '', 'job-1', {
      workdir: '/d/workflow/ccg-workflow',
    })
    expect(cmd).toContain(`--add-dir '/d/workflow/ccg-workflow'`)
  })
  it('handles workdir with spaces', () => {
    const cmd = buildPhaseRunnerBashCommand(phase(), '', 'job-1', {
      workdir: '/c/Program Files/repo',
    })
    expect(cmd).toContain(`--add-dir '/c/Program Files/repo'`)
  })
  it('handles workdir containing single quote', () => {
    const cmd = buildPhaseRunnerBashCommand(phase(), '', 'job-1', {
      workdir: `/tmp/joe's-repo`,
    })
    // 单引号被正确 escape 为 '\''
    expect(cmd).toContain(`--add-dir '/tmp/joe'\\''s-repo'`)
  })
})

// ---------------------------------------------------------------------------
// 5. parsePhaseRunnerStreamSummary (D8)
// ---------------------------------------------------------------------------

describe('parsePhaseRunnerStreamSummary', () => {
  it('extracts result.result from last line', () => {
    const stream = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"working"}]}}',
      '{"type":"result","subtype":"success","result":"STATUS: completed\\nCOMMIT: abc1234"}',
    ].join('\n')
    expect(parsePhaseRunnerStreamSummary(stream)).toBe(
      'STATUS: completed\nCOMMIT: abc1234',
    )
  })

  it('returns null when last line is not a result event', () => {
    const stream = [
      '{"type":"result","subtype":"success","result":"old"}',
      '{"type":"assistant","message":{"role":"assistant","content":[]}}',
    ].join('\n')
    expect(parsePhaseRunnerStreamSummary(stream)).toBeNull()
  })

  it('returns null on malformed JSON last line', () => {
    expect(parsePhaseRunnerStreamSummary('garbage not-json')).toBeNull()
  })

  it('returns null on empty input', () => {
    expect(parsePhaseRunnerStreamSummary('')).toBeNull()
    expect(parsePhaseRunnerStreamSummary('\n\n')).toBeNull()
  })

  it('skips trailing blank lines', () => {
    const stream =
      '{"type":"system","subtype":"init"}\n' +
      '{"type":"result","subtype":"success","result":"final"}\n\n\n'
    expect(parsePhaseRunnerStreamSummary(stream)).toBe('final')
  })

  it('returns null when result field is not a string', () => {
    const stream = '{"type":"result","subtype":"success","result":{"nested":true}}'
    expect(parsePhaseRunnerStreamSummary(stream)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 6. planWavesForTier — useDirectBashInvocation propagation to impl wave
// ---------------------------------------------------------------------------

describe('planWavesForTier: v4.5 P1a impl wave bash-direct propagation', () => {
  it('default (no option) → impl wave does NOT carry bashCommand (v4.4 BC)', () => {
    const r = planWavesForTier('triple', phase(), PLUGINS_BOTH)
    const impl = r.waves.find(w => w.kind === 'impl')!
    expect(impl.spawns[0].agent).toBe('phase-runner')
    expect(impl.spawns[0].invocationMode).toBeUndefined()
    expect(impl.spawns[0].bashCommand).toBeUndefined()
  })

  it('useDirectBashInvocation=true → impl wave carries invocationMode=bash-direct', () => {
    const r = planWavesForTier('triple', phase(), PLUGINS_BOTH, {
      useDirectBashInvocation: true,
    })
    const impl = r.waves.find(w => w.kind === 'impl')!
    expect(impl.spawns[0].agent).toBe('phase-runner')
    expect(impl.spawns[0].invocationMode).toBe('bash-direct')
    expect(impl.spawns[0].bashCommand).toBeDefined()
    expect(impl.spawns[0].bashCommand).toContain('claude -p')
    expect(impl.spawns[0].bashCommand).toContain('--agent ccg/phase-runner')
  })

  it('fast tier impl wave gets max-budget-usd 1.0 in bashCommand', () => {
    const r = planWavesForTier('fast', phase(), PLUGINS_BOTH, {
      useDirectBashInvocation: true,
    })
    const impl = r.waves.find(w => w.kind === 'impl')!
    expect(impl.spawns[0].bashCommand).toContain('--max-budget-usd 1')
  })

  it('debate tier impl wave gets max-budget-usd 5.0 in bashCommand', () => {
    const r = planWavesForTier('debate', phase(), PLUGINS_BOTH, {
      useDirectBashInvocation: true,
    })
    const impl = r.waves.find(w => w.kind === 'impl')!
    expect(impl.spawns[0].bashCommand).toContain('--max-budget-usd 5')
  })

  it('non-impl waves still don\'t carry bashCommand even with option ON (plan/critic/debate)', () => {
    const r = planWavesForTier('debate', phase(), PLUGINS_BOTH, {
      useDirectBashInvocation: true,
    })
    for (const w of r.waves) {
      if (w.kind === 'impl' || w.kind === 'verify') continue
      for (const s of w.spawns) {
        expect(s.invocationMode).toBeUndefined()
        expect(s.bashCommand).toBeUndefined()
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 7. buildQualityPlan one-shot integration (v4.5 P1a opt-in)
// ---------------------------------------------------------------------------

describe('buildQualityPlan: v4.5 P1a opt-in', () => {
  it('without options → impl wave no bash-direct (back-compat)', () => {
    const p = buildQualityPlan({}, phase(), PLUGINS_BOTH)
    const impl = p.waves.find(w => w.kind === 'impl')!
    expect(impl.spawns[0].invocationMode).toBeUndefined()
  })

  it('with useDirectBashInvocation=true → impl wave bashCommand present', () => {
    const p = buildQualityPlan({}, phase(), PLUGINS_BOTH, {
      useDirectBashInvocation: true,
    })
    const impl = p.waves.find(w => w.kind === 'impl')!
    expect(impl.spawns[0].invocationMode).toBe('bash-direct')
    expect(impl.spawns[0].bashCommand).toMatch(/claude -p/)
  })

  it('preserves verify wave bash-direct propagation (v4.4.2 behavior unchanged)', () => {
    const p = buildQualityPlan({}, phase(), PLUGINS_BOTH, {
      useDirectBashInvocation: true,
    })
    const verify = p.waves.find(w => w.kind === 'verify')!
    const pluginSpawns = verify.spawns.filter(s => s.agent.includes(':'))
    for (const s of pluginSpawns) {
      expect(s.invocationMode).toBe('bash-direct')
    }
  })
})
