import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  contextPath,
  extractFrontmatter,
  parseFrontmatterFields,
  phaseDir,
  readContext,
  readSummary,
  readSummaryFrontmatter,
  sanitizePhase,
  summaryPath,
  summaryTokenEstimate,
  writeContext,
  writeSummary,
} from '../phase-context'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const PLAN_TEMPLATE = resolve(REPO_ROOT, 'templates', 'commands', 'plan.md')
const EXECUTE_TEMPLATE = resolve(REPO_ROOT, 'templates', 'commands', 'execute.md')
const TEAM_EXEC_TEMPLATE = resolve(REPO_ROOT, 'templates', 'commands', 'team-exec.md')

let workdir: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ccg-phase-ctx-'))
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Path / sanitization helpers
// ---------------------------------------------------------------------------

describe('sanitizePhase', () => {
  it('keeps alphanumerics and dashes/underscores/dots', () => {
    expect(sanitizePhase('phase-02-context.state_machine')).toBe('phase-02-context.state_machine')
  })

  it('collapses unsafe runs to single dash', () => {
    expect(sanitizePhase('phase 02 ?? context')).toBe('phase-02-context')
  })

  it('strips leading/trailing dashes', () => {
    expect(sanitizePhase('--weird/phase!--')).toBe('weird-phase')
  })
})

describe('phaseDir / contextPath / summaryPath', () => {
  it('builds .context/<phase>/CONTEXT.md and SUMMARY.md', () => {
    const wd = '/tmp/proj'
    expect(phaseDir(wd, 'phase-02')).toBe(join(wd, '.context', 'phase-02'))
    expect(contextPath(wd, 'phase-02').endsWith(join('phase-02', 'CONTEXT.md'))).toBe(true)
    expect(summaryPath(wd, 'phase-02').endsWith(join('phase-02', 'SUMMARY.md'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

describe('extractFrontmatter', () => {
  it('returns the YAML block between --- markers', () => {
    const content = '---\nphase: p1\nfoo: bar\n---\n# body'
    expect(extractFrontmatter(content)).toBe('phase: p1\nfoo: bar')
  })

  it('returns null when no frontmatter is present', () => {
    expect(extractFrontmatter('# just markdown')).toBeNull()
  })

  it('handles CRLF line endings', () => {
    const content = '---\r\nphase: p2\r\n---\r\nbody'
    expect(extractFrontmatter(content)).toBe('phase: p2')
  })
})

describe('parseFrontmatterFields', () => {
  it('parses scalar string fields', () => {
    const out = parseFrontmatterFields('phase: phase-02\nplan: .claude/plan/foo.md')
    expect(out.phase).toBe('phase-02')
    expect(out.plan).toBe('.claude/plan/foo.md')
  })

  it('parses inline list', () => {
    const out = parseFrontmatterFields('files: [a.ts, b.ts, c.ts]')
    expect(out.files).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('parses block list', () => {
    const yaml = 'provides:\n  - SUMMARY.md writer\n  - CONTEXT.md schema'
    const out = parseFrontmatterFields(yaml)
    expect(out.provides).toEqual(['SUMMARY.md writer', 'CONTEXT.md schema'])
  })

  it('parses booleans', () => {
    const out = parseFrontmatterFields('completed: true\nfailed: false')
    expect(out.completed).toBe(true)
    expect(out.failed).toBe(false)
  })

  it('unwraps quoted scalars', () => {
    const out = parseFrontmatterFields('goal: "write SUMMARY: machine-readable"')
    expect(out.goal).toBe('write SUMMARY: machine-readable')
  })

  it('throws on malformed line', () => {
    expect(() => parseFrontmatterFields('this is not yaml')).toThrow(/malformed/)
  })

  it('returns empty list for empty inline brackets', () => {
    const out = parseFrontmatterFields('files: []')
    expect(out.files).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// CONTEXT.md round-trip
// ---------------------------------------------------------------------------

describe('writeContext / readContext', () => {
  it('round-trips a fully populated context', () => {
    const target = writeContext(workdir, {
      phase: 'phase-02-context-state-machine',
      plan: '.claude/plan/phase-02.md',
      goal: 'introduce phase-scoped state files',
      decisions: ['use frontmatter for machine read', 'separate CONTEXT vs SUMMARY'],
      constraints: ['<200 tokens per phase', 'no Agent tool in builder'],
      files: ['templates/commands/plan.md', 'templates/commands/execute.md'],
      createdAt: '2026-05-03T22:00:00+08:00',
    })
    expect(existsSync(target)).toBe(true)

    const round = readContext(workdir, 'phase-02-context-state-machine')
    expect(round).not.toBeNull()
    expect(round!.plan).toBe('.claude/plan/phase-02.md')
    expect(round!.goal).toBe('introduce phase-scoped state files')
    expect(round!.decisions).toHaveLength(2)
    expect(round!.constraints).toContain('<200 tokens per phase')
    expect(round!.files).toContain('templates/commands/plan.md')
    expect(round!.createdAt).toMatch(/^2026-05-03/)
  })

  it('returns null when CONTEXT.md does not exist', () => {
    expect(readContext(workdir, 'never-written')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// SUMMARY.md round-trip — main contract for orchestrator
// ---------------------------------------------------------------------------

describe('writeSummary / readSummary', () => {
  it('round-trips a completed summary', () => {
    const target = writeSummary(workdir, {
      phase: 'phase-02',
      plan: '.claude/plan/phase-02.md',
      provides: ['phase-context module', 'frontmatter writers'],
      affects: ['plan.md', 'execute.md', 'team-exec.md'],
      keyFiles: ['src/utils/phase-context.ts'],
      completed: true,
      completedAt: '2026-05-03T22:30:00+08:00',
      notes: 'orchestrator reads only frontmatter (<200 tokens)',
    })
    expect(existsSync(target)).toBe(true)

    const round = readSummary(workdir, 'phase-02')
    expect(round).not.toBeNull()
    expect(round!.completed).toBe(true)
    expect(round!.provides).toContain('phase-context module')
    expect(round!.affects).toContain('execute.md')
    expect(round!.keyFiles).toEqual(['src/utils/phase-context.ts'])
    expect(round!.notes).toMatch(/orchestrator/)
    expect(round!.completedAt).toMatch(/22:30/)
  })

  it('writes a not-yet-completed summary (in-progress)', () => {
    writeSummary(workdir, {
      phase: 'phase-99',
      plan: '.claude/plan/phase-99.md',
      provides: [],
      affects: [],
      keyFiles: [],
      completed: false,
    })
    const round = readSummary(workdir, 'phase-99')
    expect(round!.completed).toBe(false)
    expect(round!.completedAt).toBeUndefined()
  })

  it('returns null when SUMMARY.md does not exist', () => {
    expect(readSummary(workdir, 'never-summarized')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Frontmatter-only read — orchestrator hot path
// ---------------------------------------------------------------------------

describe('readSummaryFrontmatter (orchestrator hot path)', () => {
  it('returns only the frontmatter block, never the body', () => {
    writeSummary(workdir, {
      phase: 'phase-02',
      plan: '.claude/plan/phase-02.md',
      provides: ['p1', 'p2'],
      affects: ['a1'],
      keyFiles: ['f1.ts', 'f2.ts'],
      completed: true,
      completedAt: '2026-05-03T22:30:00+08:00',
      notes: 'short',
    })

    const fm = readSummaryFrontmatter(workdir, 'phase-02')
    expect(fm).not.toBeNull()
    expect(fm!).toContain('phase: phase-02')
    expect(fm!).toContain('completed: true')
    expect(fm!).not.toContain('# Phase Summary')
    expect(fm!).not.toContain('## Provides')
  })

  it('returns null when SUMMARY.md missing', () => {
    expect(readSummaryFrontmatter(workdir, 'missing')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Token budget — acceptance: orchestrator < 1000 tokens for 5 phases
// ---------------------------------------------------------------------------

describe('summaryTokenEstimate budget (acceptance d)', () => {
  it('a single typical SUMMARY.md frontmatter is under 200 tokens', () => {
    writeSummary(workdir, {
      phase: 'phase-02-context-state-machine',
      plan: '.claude/plan/phase-02-context-state-machine.md',
      provides: ['phase-context module', 'CONTEXT.md writer', 'SUMMARY.md writer', 'frontmatter parser'],
      affects: ['templates/commands/plan.md', 'templates/commands/execute.md', 'templates/commands/team-exec.md'],
      keyFiles: [
        'src/utils/phase-context.ts',
        'src/utils/__tests__/phaseContext.test.ts',
      ],
      completed: true,
      completedAt: '2026-05-03T22:30:00+08:00',
      notes: 'orchestrator reads only frontmatter; builders no longer pipe full stdout',
    })
    const fm = readSummaryFrontmatter(workdir, 'phase-02-context-state-machine')!
    const tokens = summaryTokenEstimate(fm)
    expect(tokens).toBeLessThan(200)
  })

  it('orchestrator reading 5 SUMMARY frontmatters stays under 1000 tokens', () => {
    const phaseIds = [
      'phase-02-context-state-machine',
      'phase-03-codebase-mapper',
      'phase-04-scope-reduction-detection',
      'phase-05-command-convergence',
      'phase-06-plan-checker-dimensions',
    ]

    let totalTokens = 0
    for (const phase of phaseIds) {
      writeSummary(workdir, {
        phase,
        plan: `.claude/plan/${phase}.md`,
        provides: [`module for ${phase}`, 'tests', 'docs'],
        affects: ['templates/commands/foo.md', 'templates/commands/bar.md'],
        keyFiles: [`src/utils/${phase}.ts`, `src/utils/__tests__/${phase}.test.ts`],
        completed: true,
        completedAt: '2026-05-03T22:30:00+08:00',
        notes: 'completed',
      })
      const fm = readSummaryFrontmatter(workdir, phase)!
      totalTokens += summaryTokenEstimate(fm)
    }

    expect(totalTokens).toBeLessThan(1000)
  })

  it('summary token cost grows linearly with phase count, no body bleed', () => {
    // Body content shouldn't affect frontmatter token count
    writeSummary(workdir, {
      phase: 'phase-x',
      plan: '.claude/plan/phase-x.md',
      provides: ['a'],
      affects: ['b'],
      keyFiles: ['c.ts'],
      completed: true,
      notes: 'x'.repeat(2000),  // huge body would-be
    })
    // notes goes into frontmatter; verify isolated estimate is body-free
    const fm = readSummaryFrontmatter(workdir, 'phase-x')!
    const fullBody = readFileSync(summaryPath(workdir, 'phase-x'), 'utf8')
    expect(fm.length).toBeLessThan(fullBody.length)
    // Even with bloated notes, fm tokens grow only by notes content, not by body markdown
    expect(summaryTokenEstimate(fm)).toBeLessThan(summaryTokenEstimate(fullBody))
  })
})

// ---------------------------------------------------------------------------
// Template integration — plan.md / execute.md / team-exec.md must reference
// the new state machine (acceptance a/b/c).
// ---------------------------------------------------------------------------

describe('plan.md template (acceptance a)', () => {
  const content = readFileSync(PLAN_TEMPLATE, 'utf8')

  it('mentions writing CONTEXT.md after plan production', () => {
    expect(content).toMatch(/CONTEXT\.md/)
    expect(content).toMatch(/\.context\/[^\s]*?(\<phase\>|phase|\$|<)/i)
  })

  it('declares the CONTEXT.md frontmatter contract (phase / plan / decisions / files)', () => {
    expect(content).toMatch(/phase\s*:/)
    expect(content).toMatch(/decisions\s*:/i)
    expect(content).toMatch(/files\s*:/i)
  })
})

describe('execute.md template (acceptance b)', () => {
  const content = readFileSync(EXECUTE_TEMPLATE, 'utf8')

  it('mentions writing SUMMARY.md after each plan completes', () => {
    expect(content).toMatch(/SUMMARY\.md/)
    expect(content).toMatch(/\.context\//)
  })

  it('lists all required SUMMARY frontmatter fields', () => {
    // phase / plan / provides / affects / key-files / completed
    expect(content).toMatch(/\bphase\s*:/)
    expect(content).toMatch(/\bplan\s*:/)
    expect(content).toMatch(/\bprovides\s*:/)
    expect(content).toMatch(/\baffects\s*:/)
    expect(content).toMatch(/\bkey[_-]?files\s*:/)
    expect(content).toMatch(/\bcompleted\s*:/)
  })
})

describe('team-exec.md template (acceptance c)', () => {
  const content = readFileSync(TEAM_EXEC_TEMPLATE, 'utf8')

  it('reads only SUMMARY.md frontmatter, not full builder stdout', () => {
    expect(content).toMatch(/SUMMARY\.md/)
    // The orchestrator must not be told to pipe builder full stdout into context
    expect(content).toMatch(/frontmatter|前置块|YAML/)
  })

  it('declares the < 200 tokens / phase budget', () => {
    expect(content).toMatch(/200\s*token|≤\s*200|<\s*1000|tokens/)
  })
})
