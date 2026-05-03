/**
 * Unit tests for templates/hooks/ccg-session-state.js (Phase 13).
 *
 * The hook is a standalone CommonJS Node script (no transpile step), so we load
 * it through createRequire instead of an ESM import. We exercise the pure
 * helpers (parseRoadmapHead / parsePhases / pickActivePhase / phaseDirName /
 * parseSummaryFrontmatter / composeMessage) plus the integration entry
 * `buildAdditionalContext`, which is what the script's main() ultimately calls.
 *
 * Acceptance scenarios covered (matches phase-13 acceptance §c):
 *   - schema correctness — the hook returns a string suitable for direct use
 *     as the SessionStart `additionalContext`
 *   - missing roadmap.md → noop (returns null, hook would emit `{}`)
 *   - in_progress phase + matching SUMMARY.md → message contains phase id +
 *     "Provides" / "Next action" injected from frontmatter
 *   - all phases completed → message states "All phases completed"
 *   - SUMMARY.md missing → fallback to roadmap-only message (no crash)
 *   - non-CCG cwd (no .ccg/) → noop
 *   - parser robustness — malformed phase line is ignored without throwing
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const HOOK_PATH = resolve(REPO_ROOT, 'templates', 'hooks', 'ccg-session-state.cjs')

// Hook is shipped as CJS. createRequire lets us load it from an ESM test file.
const requireCjs = createRequire(import.meta.url)
const hook = requireCjs(HOOK_PATH) as {
  parseRoadmapHead: (text: string) => { project?: string, started?: string, lastUpdated?: string }
  parsePhases: (text: string) => Array<{ n: string, title: string, status: string }>
  pickActivePhase: (phases: Array<{ n: string, title: string, status: string }>) => any
  phaseDirName: (p: { n: string, title: string }) => string
  parseSummaryFrontmatter: (content: string) => Record<string, string> | null
  composeMessage: (head: any, active: any, summary: any, counts: { total: number, completed: number }) => string
  buildAdditionalContext: (cwd: string) => string | null
}

let workdir: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ccg-session-hook-'))
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('parseRoadmapHead', () => {
  it('extracts Project / Started / Last Updated from the head', () => {
    const text = [
      '# CCG Roadmap',
      '',
      '**Project**: ccg-workflow v4.0',
      '**Started**: 2026-05-03',
      '**Last Updated**: 2026-05-04',
      '',
      'Body...',
    ].join('\n')
    expect(hook.parseRoadmapHead(text)).toEqual({
      project: 'ccg-workflow v4.0',
      started: '2026-05-03',
      lastUpdated: '2026-05-04',
    })
  })

  it('returns undefined fields when labels are missing', () => {
    const text = '# Title\n\nNo metadata here'
    const out = hook.parseRoadmapHead(text)
    expect(out.project).toBeUndefined()
    expect(out.started).toBeUndefined()
    expect(out.lastUpdated).toBeUndefined()
  })
})

describe('parsePhases', () => {
  it('captures id, title, and status for every Phase header', () => {
    const text = [
      '## Phase 1: Foundation (completed)',
      '',
      '## Phase 1.5: Sub-step (completed)',
      '',
      '## Phase 2: State machine [offload] (in_progress)',
      '',
      '## Phase 3: Future work (pending)',
    ].join('\n')
    const phases = hook.parsePhases(text)
    expect(phases).toEqual([
      { n: '1', title: 'Foundation', status: 'completed' },
      { n: '1.5', title: 'Sub-step', status: 'completed' },
      { n: '2', title: 'State machine', status: 'in_progress' },
      { n: '3', title: 'Future work', status: 'pending' },
    ])
  })

  it('ignores headers without a status suffix without throwing', () => {
    const text = [
      '## Phase 1: Has status (pending)',
      '## Phase 99: Missing status', // malformed — must be skipped silently
      '## Other section: not a phase',
    ].join('\n')
    expect(hook.parsePhases(text)).toEqual([
      { n: '1', title: 'Has status', status: 'pending' },
    ])
  })
})

describe('pickActivePhase', () => {
  it('prefers in_progress over pending', () => {
    const phases = [
      { n: '1', title: 'A', status: 'completed' },
      { n: '2', title: 'B', status: 'pending' },
      { n: '3', title: 'C', status: 'in_progress' },
    ]
    expect(hook.pickActivePhase(phases)).toEqual({ n: '3', title: 'C', status: 'in_progress' })
  })

  it('falls back to first pending when no in_progress exists', () => {
    const phases = [
      { n: '1', title: 'A', status: 'completed' },
      { n: '2', title: 'B', status: 'pending' },
      { n: '3', title: 'C', status: 'pending' },
    ]
    expect(hook.pickActivePhase(phases)).toEqual({ n: '2', title: 'B', status: 'pending' })
  })

  it('returns null when every phase is completed', () => {
    const phases = [
      { n: '1', title: 'A', status: 'completed' },
      { n: '2', title: 'B', status: 'completed' },
    ]
    expect(hook.pickActivePhase(phases)).toBeNull()
  })
})

describe('phaseDirName', () => {
  it('zero-pads integer ids and slugifies the title', () => {
    expect(hook.phaseDirName({ n: '7', title: 'Async triplet' })).toBe('phase-07-async-triplet')
  })

  it('preserves decimal ids unchanged', () => {
    expect(hook.phaseDirName({ n: '1.5', title: 'G plan rescue' })).toBe('phase-1.5-g-plan-rescue')
  })

  it('collapses runs of non-alphanumerics in the title', () => {
    expect(hook.phaseDirName({ n: '13', title: 'SessionStart Hook + Memory!!' })).toBe(
      'phase-13-sessionstart-hook-memory',
    )
  })
})

describe('parseSummaryFrontmatter', () => {
  it('reads scalar key/value pairs and unquotes', () => {
    const content = [
      '---',
      'phase: phase-13-session-state-hook',
      'completed: true',
      'provides: "SessionStart hook"',
      'next-action: \'wire installer\'',
      '---',
      '',
      '# body',
    ].join('\n')
    const out = hook.parseSummaryFrontmatter(content)!
    expect(out.phase).toBe('phase-13-session-state-hook')
    expect(out.provides).toBe('SessionStart hook')
    expect(out['next-action']).toBe('wire installer')
  })

  it('returns null when no frontmatter present', () => {
    expect(hook.parseSummaryFrontmatter('# Just a heading\n')).toBeNull()
  })
})

describe('composeMessage', () => {
  it('caps the message at ~800 chars to honor the token budget', () => {
    const giantTitle = 'X'.repeat(2000)
    const out = hook.composeMessage(
      { project: 'ccg' },
      { n: '1', title: giantTitle, status: 'in_progress' },
      null,
      { total: 1, completed: 0 },
    )
    expect(out.length).toBeLessThanOrEqual(800)
  })

  it('says "All phases completed" when active is null and counts match', () => {
    const out = hook.composeMessage(
      { project: 'ccg' },
      null,
      null,
      { total: 3, completed: 3 },
    )
    expect(out).toContain('All phases completed')
  })

  it('inlines provides + next-action from a SUMMARY.md frontmatter', () => {
    const out = hook.composeMessage(
      { project: 'ccg' },
      { n: '13', title: 'Hook', status: 'in_progress' },
      { provides: 'SessionStart', 'next-action': 'wire installer' },
      { total: 13, completed: 12 },
    )
    expect(out).toContain('Active phase: 13 Hook')
    expect(out).toContain('Provides: SessionStart')
    expect(out).toContain('Next action: wire installer')
  })
})

// ---------------------------------------------------------------------------
// Integration: buildAdditionalContext (drives the full pipeline)
// ---------------------------------------------------------------------------

function writeRoadmap(content: string) {
  mkdirSync(join(workdir, '.ccg'), { recursive: true })
  writeFileSync(join(workdir, '.ccg', 'roadmap.md'), content, 'utf8')
}

function writePhaseSummary(dir: string, frontmatter: Record<string, string>) {
  mkdirSync(join(workdir, '.context', dir), { recursive: true })
  const fm = ['---', ...Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`), '---', '']
  writeFileSync(join(workdir, '.context', dir, 'SUMMARY.md'), fm.join('\n'), 'utf8')
}

describe('buildAdditionalContext', () => {
  it('returns null when cwd is not a CCG project (no .ccg/roadmap.md)', () => {
    expect(hook.buildAdditionalContext(workdir)).toBeNull()
  })

  it('injects the active phase and SUMMARY.md frontmatter when both exist', () => {
    writeRoadmap(
      [
        '# Roadmap',
        '',
        '**Project**: ccg-workflow v4.1',
        '**Started**: 2026-05-04',
        '',
        '## Phase 13: SessionStart hook + memory (in_progress)',
        '',
        '## Phase 14: Wave parallel (pending)',
      ].join('\n'),
    )
    // Note: phaseDirName lowercases + collapses non-alnum, so we mirror it.
    writePhaseSummary('phase-13-sessionstart-hook-memory', {
      phase: 'phase-13-session-state-hook',
      completed: 'false',
      provides: 'SessionStart hook',
      'next-action': 'register in installer-hooks',
    })

    const out = hook.buildAdditionalContext(workdir)
    expect(out).toBeTruthy()
    expect(out!).toContain('ccg-workflow v4.1')
    expect(out!).toContain('Active phase: 13')
    expect(out!).toContain('Provides: SessionStart hook')
    expect(out!).toContain('Next action: register in installer-hooks')
  })

  it('falls back to roadmap-only summary when SUMMARY.md is absent', () => {
    writeRoadmap(
      [
        '**Project**: ccg-workflow',
        '',
        '## Phase 1: Foundation (completed)',
        '## Phase 2: Pending work (in_progress)',
      ].join('\n'),
    )
    const out = hook.buildAdditionalContext(workdir)
    expect(out).toBeTruthy()
    expect(out!).toContain('Active phase: 2')
    // No SUMMARY.md means no Provides/Next action injected
    expect(out!).not.toContain('Provides:')
    expect(out!).not.toContain('Next action:')
  })

  it('says "All phases completed" when every phase is done', () => {
    writeRoadmap(
      [
        '**Project**: ccg-workflow',
        '',
        '## Phase 1: A (completed)',
        '## Phase 2: B (completed)',
      ].join('\n'),
    )
    const out = hook.buildAdditionalContext(workdir)
    expect(out).toBeTruthy()
    expect(out!).toContain('All phases completed')
  })

  it('returns a usable context string even if roadmap has no phases at all', () => {
    writeRoadmap('# Just a title\n\n**Project**: tiny-proj\n')
    const out = hook.buildAdditionalContext(workdir)
    expect(out).toBeTruthy()
    expect(out!).toContain('tiny-proj')
  })

  it('reports completed/total ratio in the summary line', () => {
    writeRoadmap(
      [
        '**Project**: ccg',
        '',
        '## Phase 1: A (completed)',
        '## Phase 2: B (completed)',
        '## Phase 3: C (in_progress)',
        '## Phase 4: D (pending)',
      ].join('\n'),
    )
    const out = hook.buildAdditionalContext(workdir)
    expect(out!).toContain('2/4 completed')
  })
})
