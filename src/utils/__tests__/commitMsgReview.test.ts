/**
 * Unit tests for templates/hooks/ccg-commit-msg-review.cjs (Phase 29).
 *
 * The hook is shipped as a standalone CommonJS Node script (no transpile step)
 * so we load it via createRequire from this ESM test file. We exercise the
 * pure helpers individually plus the integration entry `checkConsistency`,
 * which is what main() ultimately calls after I/O.
 *
 * Acceptance scenarios covered (matches phase-29 acceptance §d):
 *   - mention-of-staged-file ok-path
 *   - mention-of-unstaged-file fail-path
 *   - phase tag matches staged path (versioned form `v4.3-p27`)
 *   - phase tag mismatches staged path (e.g. `p27` but staged under phase-29)
 *   - bare-basename mentions resolve via suffix-match
 *   - empty staged set → ok (let git handle empty commits)
 *   - empty / cleared message → ok (let git enforce policy)
 *   - docs(...) commit with code-only diff → fail
 *   - test(...) commit with code-only diff → fail
 *   - normal feat(...) commit with code diff → ok
 *   - parser robustness — extractFileMentions ignores prose words
 *   - parser robustness — extractPhaseTag ignores bare numerals
 */

import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const HOOK_PATH = resolve(REPO_ROOT, 'templates', 'hooks', 'ccg-commit-msg-review.cjs')

const requireCjs = createRequire(import.meta.url)
const hook = requireCjs(HOOK_PATH) as {
  stripCommitTemplate: (raw: string) => { subject: string, body: string, full: string, fullLower: string }
  extractFileMentions: (text: string) => string[]
  parseStagedFiles: (out: string) => string[]
  extractCommitType: (subject: string) => string | null
  extractPhaseTag: (text: string) => string | null
  classifyStagedFiles: (files: string[]) => { dominant: string | null, counts: Record<string, number> } | null
  checkConsistency: (message: string, stagedFiles: string[]) => { ok: boolean, reason?: string }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('stripCommitTemplate', () => {
  it('drops git instructional comments and scissors footer', () => {
    const raw = [
      'feat(v4.3-p29): add commit-msg hook',
      '',
      'Detail body line.',
      '# Please enter the commit message for your changes.',
      '# ------------------------ >8 ------------------------',
      'diff --git a/foo b/foo',
    ].join('\n')

    const parsed = hook.stripCommitTemplate(raw)
    expect(parsed.subject).toBe('feat(v4.3-p29): add commit-msg hook')
    expect(parsed.body).toContain('Detail body line.')
    expect(parsed.body).not.toContain('Please enter')
    expect(parsed.body).not.toContain('diff --git')
  })

  it('treats an empty/cleared buffer as empty subject', () => {
    const parsed = hook.stripCommitTemplate('# only comments here\n')
    expect(parsed.subject).toBe('')
  })
})

describe('extractFileMentions', () => {
  it('captures path-like tokens and recognized extensions', () => {
    const out = hook.extractFileMentions('refactor src/utils/foo.ts and update package.json')
    expect(out).toEqual(expect.arrayContaining(['src/utils/foo.ts', 'package.json']))
  })

  it('ignores prose words that are not file paths', () => {
    const out = hook.extractFileMentions('improve docs and tests for the new feature')
    expect(out).toEqual([])
  })

  it('strips trailing punctuation following a path', () => {
    const out = hook.extractFileMentions('touched src/foo.ts, added bar.ts.')
    expect(out).toEqual(expect.arrayContaining(['src/foo.ts', 'bar.ts']))
  })

  it('normalizes Windows backslash paths to forward slashes', () => {
    const out = hook.extractFileMentions('updated src\\utils\\foo.ts handling')
    expect(out).toContain('src/utils/foo.ts')
  })
})

describe('extractCommitType', () => {
  it('recognizes type(scope): subjects', () => {
    expect(hook.extractCommitType('feat(v4.3-p29): hook')).toBe('feat')
    expect(hook.extractCommitType('docs: update README')).toBe('docs')
    expect(hook.extractCommitType('chore!: bump deps')).toBe('chore')
  })

  it('returns null for non-conventional subjects', () => {
    expect(hook.extractCommitType('Just a thought')).toBeNull()
    expect(hook.extractCommitType('')).toBeNull()
  })
})

describe('extractPhaseTag', () => {
  it('parses v<x.y>-p<n> versioned tags', () => {
    expect(hook.extractPhaseTag('feat(v4.3-p27): foo')).toBe('27')
    expect(hook.extractPhaseTag('chore(v1.5-p1.5): foo')).toBe('1.5')
  })

  it('parses standalone phase-NN', () => {
    expect(hook.extractPhaseTag('see phase-29 report')).toBe('29')
  })

  it('parses standalone p<NN> with separator', () => {
    expect(hook.extractPhaseTag('related to p29 cleanup')).toBe('29')
  })

  it('does NOT match bare numerals or words containing p<digits>', () => {
    expect(hook.extractPhaseTag('fixed 27 things')).toBeNull()
    expect(hook.extractPhaseTag('typed an answer')).toBeNull()
    expect(hook.extractPhaseTag('improve speed by 10%')).toBeNull()
  })
})

describe('classifyStagedFiles', () => {
  it('marks .md and CHANGELOG as docs', () => {
    const c = hook.classifyStagedFiles(['README.md', 'docs/architecture.md'])
    expect(c?.counts.docs).toBe(2)
    expect(c?.dominant).toBe('docs')
  })

  it('marks __tests__ and *.test.ts as test', () => {
    const c = hook.classifyStagedFiles(['src/utils/__tests__/foo.test.ts', 'src/foo.spec.ts'])
    expect(c?.counts.test).toBe(2)
    expect(c?.dominant).toBe('test')
  })

  it('marks regular source as code', () => {
    const c = hook.classifyStagedFiles(['src/utils/foo.ts', 'src/utils/bar.ts'])
    expect(c?.counts.code).toBe(2)
    expect(c?.dominant).toBe('code')
  })
})

describe('parseStagedFiles', () => {
  it('returns trimmed normalized list', () => {
    const out = hook.parseStagedFiles('src\\utils\\foo.ts\nREADME.md\n\n')
    expect(out).toEqual(['src/utils/foo.ts', 'README.md'])
  })

  it('handles empty input', () => {
    expect(hook.parseStagedFiles('')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Integration — checkConsistency
// ---------------------------------------------------------------------------

describe('checkConsistency — heuristic #1 (file mention vs staged)', () => {
  it('passes when mentioned files are all staged', () => {
    const r = hook.checkConsistency(
      'chore: bump package.json and update src/utils/foo.ts',
      ['package.json', 'src/utils/foo.ts'],
    )
    expect(r.ok).toBe(true)
  })

  it('fails when message mentions a file that is NOT staged', () => {
    const r = hook.checkConsistency(
      'chore: bump package.json',
      ['src/utils/foo.ts'],
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/package\.json/)
  })

  it('matches bare basenames against staged path basenames', () => {
    const r = hook.checkConsistency(
      'fix: tweak foo.ts',
      ['src/utils/foo.ts'],
    )
    expect(r.ok).toBe(true)
  })
})

describe('checkConsistency — heuristic #2 (phase tag vs staged)', () => {
  it('passes when v<x.y>-p<NN> matches a phase-scoped staged path', () => {
    const r = hook.checkConsistency(
      'feat(v4.3-p27): pipeline-check helper',
      ['src/utils/pipeline-check.ts', '.claude/team-plan/phase-27-pipeline-check-report.md'],
    )
    expect(r.ok).toBe(true)
  })

  it('fails when phase tag points at a different phase than staged paths', () => {
    const r = hook.checkConsistency(
      'feat(v4.3-p27): foo',
      [
        'src/utils/foo.ts',
        '.claude/team-plan/phase-29-commit-msg-lint-report.md',
      ],
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/phase 27/)
  })

  it('passes the v3.0.0-p1 zero-padding form (phase-01 staged)', () => {
    const r = hook.checkConsistency(
      'feat(v3.0.0-p1): bootstrap',
      ['.claude/team-plan/phase-01-offload-report.md'],
    )
    expect(r.ok).toBe(true)
  })
})

describe('checkConsistency — heuristic #3 (type vs staged file mix)', () => {
  it('fails when commit type is `docs` but staged files are code-only', () => {
    const r = hook.checkConsistency(
      'docs: clarify routing',
      ['src/utils/foo.ts', 'src/utils/bar.ts'],
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/docs/)
  })

  it('fails when commit type is `test` but staged files are code-only', () => {
    const r = hook.checkConsistency(
      'test: cover edge cases',
      ['src/utils/foo.ts'],
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/test/)
  })

  it('passes a normal feat commit with matching code diff', () => {
    const r = hook.checkConsistency(
      'feat(v4.3-p29): add commit-msg-review hook',
      [
        'templates/hooks/ccg-commit-msg-review.cjs',
        'src/utils/__tests__/commitMsgReview.test.ts',
        'src/utils/installer-hooks.ts',
        '.claude/team-plan/phase-29-commit-msg-lint-report.md',
      ],
    )
    expect(r.ok).toBe(true)
  })

  it('passes a docs commit that actually touches .md files', () => {
    const r = hook.checkConsistency(
      'docs: update CHANGELOG and README',
      ['CHANGELOG.md', 'README.md'],
    )
    expect(r.ok).toBe(true)
  })
})

describe('checkConsistency — defensive cases', () => {
  it('returns ok when staged file list is empty (let git enforce)', () => {
    const r = hook.checkConsistency('feat: anything', [])
    expect(r.ok).toBe(true)
  })

  it('returns ok when message is blank / comments-only', () => {
    const r = hook.checkConsistency('# only comments\n', ['src/utils/foo.ts'])
    expect(r.ok).toBe(true)
  })

  it('returns ok when message has no file/phase mentions and type matches diff', () => {
    const r = hook.checkConsistency(
      'chore: routine bookkeeping',
      ['src/utils/foo.ts'],
    )
    expect(r.ok).toBe(true)
  })
})
