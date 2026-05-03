import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  AUTO_CONVERGE_CAP,
  buildFindingCommit,
  buildReviewfixBranch,
  CLEANUP_STEP_ORDER,
  decideConverge,
  parseSentinel,
  planFindingRollback,
  planTransactionalCleanup,
  planWorktreeSetup,
  resolveSentinelPath,
  SENTINEL_RELATIVE_PATH,
  serializeSentinel,
  shellQuote,
  summarizeCleanup,
  type ReviewFixSentinel,
} from '../code-fixer-worktree'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const REVIEW_TEMPLATE = resolve(REPO_ROOT, 'templates', 'commands', 'review.md')
const CODE_FIXER_TEMPLATE = resolve(REPO_ROOT, 'templates', 'commands', 'agents', 'code-fixer.md')

// ---------------------------------------------------------------------------
// Test 1: review.md flag surface
// ---------------------------------------------------------------------------
describe('review.md --fix flag surface (Phase 10 acceptance a)', () => {
  it('exists at templates/commands/review.md', () => {
    expect(existsSync(REVIEW_TEMPLATE)).toBe(true)
  })

  const content = existsSync(REVIEW_TEMPLATE) ? readFileSync(REVIEW_TEMPLATE, 'utf8') : ''

  it('declares --fix flag', () => {
    expect(content).toMatch(/--fix\b/)
  })

  it('declares --fix --all flag (includes Info findings)', () => {
    expect(content).toMatch(/--fix\s+--all|--fix.*--all/)
  })

  it('declares --fix --auto multi-round convergence flag', () => {
    expect(content).toMatch(/--fix\s+--auto|--fix.*--auto/)
  })

  it('mentions code-fixer subagent invocation', () => {
    expect(content).toMatch(/code-fixer/i)
  })

  it('mentions worktree isolation requirement', () => {
    expect(content).toMatch(/worktree/i)
  })
})

// ---------------------------------------------------------------------------
// Test 2: code-fixer.md subagent template
// ---------------------------------------------------------------------------
describe('code-fixer.md subagent (Phase 10 acceptance b)', () => {
  it('exists at templates/commands/agents/code-fixer.md', () => {
    expect(existsSync(CODE_FIXER_TEMPLATE)).toBe(true)
  })

  const content = existsSync(CODE_FIXER_TEMPLATE)
    ? readFileSync(CODE_FIXER_TEMPLATE, 'utf8')
    : ''

  it('declares name=code-fixer in frontmatter', () => {
    expect(content).toMatch(/^---[\s\S]*?name:\s*code-fixer[\s\S]*?---/m)
  })

  it('mentions worktree isolation + recovery sentinel', () => {
    expect(content).toMatch(/worktree/i)
    expect(content).toMatch(/sentinel|recovery-pending/i)
  })

  it('lists 4-step transactional cleanup tail in correct order', () => {
    // Scope the search to the actual section heading "### Phase E."
    // (markdown H3) which immediately precedes the cleanup tail. This
    // avoids matching abort-cleanup hints earlier in the doc and
    // anchor-style cross-refs.
    const headingMatch = content.match(/###\s+Phase\s+E\.?\s*Transactional\s+Cleanup\s+Tail/i)
    expect(headingMatch).not.toBeNull()
    const headingIdx = headingMatch ? headingMatch.index! : -1
    const tail = content.slice(headingIdx)

    const mergeIdx = tail.search(/ff-only|fast-forward/i)
    const wtRemoveIdx = tail.search(/worktree remove/i)
    const branchDelIdx = tail.search(/branch -D|branch --delete/i)
    const sentinelRmIdx = tail.search(/(rm|remove|删除).{0,30}sentinel/i)
    expect(mergeIdx).toBeGreaterThanOrEqual(0)
    expect(wtRemoveIdx).toBeGreaterThan(mergeIdx)
    expect(branchDelIdx).toBeGreaterThan(wtRemoveIdx)
    expect(sentinelRmIdx).toBeGreaterThan(branchDelIdx)
  })

  it('mandates per-finding rollback via git checkout (not Write tool)', () => {
    expect(content).toMatch(/git checkout --/)
    expect(content).toMatch(/(不|never|don't|do not).{0,30}(Write|write).{0,30}(tool|工具|回滚|rollback)/i)
  })

  it('declares 3 verification tiers', () => {
    expect(content).toMatch(/Tier\s*1/i)
    expect(content).toMatch(/Tier\s*2/i)
    expect(content).toMatch(/Tier\s*3/i)
  })

  it('mandates atomic commit per finding with fix({phase}): prefix', () => {
    expect(content).toMatch(/fix\([^)]+\):/i)
  })
})

// ---------------------------------------------------------------------------
// Test 3: Recovery sentinel schema
// ---------------------------------------------------------------------------
describe('ReviewFixSentinel schema (Phase 10 acceptance c)', () => {
  it('SENTINEL_RELATIVE_PATH lives under .context/', () => {
    expect(SENTINEL_RELATIVE_PATH).toBe('.context/review-fix-recovery-pending.json')
  })

  it('resolveSentinelPath joins workdir + relative path', () => {
    const got = resolveSentinelPath('/home/u/proj')
    // pathe normalizes separators to forward slash
    expect(got).toMatch(/\/home\/u\/proj\/\.context\/review-fix-recovery-pending\.json$/)
  })

  it('serializeSentinel produces parseable JSON with all 5 fields', () => {
    const s: ReviewFixSentinel = {
      worktree_path: '/tmp/ccg-reviewfix-AbCdEf',
      branch: 'master',
      reviewfix_branch: 'ccg-reviewfix/abc1234-12345',
      base_sha: 'abc1234567890',
      started_at: '2026-05-03T10:30:00.000Z',
    }
    const json = serializeSentinel(s)
    const parsed = parseSentinel(json)
    expect(parsed).toEqual(s)
  })

  it('parseSentinel returns null for malformed JSON', () => {
    expect(parseSentinel('{not json')).toBeNull()
    expect(parseSentinel('null')).toBeNull()
    expect(parseSentinel('"string"')).toBeNull()
  })

  it('parseSentinel returns null when required fields missing', () => {
    expect(parseSentinel('{"worktree_path": "/tmp/x"}')).toBeNull()
    expect(
      parseSentinel(
        JSON.stringify({
          worktree_path: '/tmp/x',
          branch: 'main',
          reviewfix_branch: 'foo',
          base_sha: 'abc1234',
          // started_at missing
        }),
      ),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Test 4: Branch naming
// ---------------------------------------------------------------------------
describe('buildReviewfixBranch (Phase 10 branch namespace)', () => {
  it('uses ccg-reviewfix/<sha7>-<pid> format', () => {
    expect(buildReviewfixBranch('abc1234567890def', 12345)).toBe(
      'ccg-reviewfix/abc1234-12345',
    )
  })

  it('truncates SHA to first 7 chars', () => {
    const got = buildReviewfixBranch('1234567890abcdef', 999)
    expect(got).toBe('ccg-reviewfix/1234567-999')
  })

  it('rejects too-short SHA (<7 chars)', () => {
    expect(() => buildReviewfixBranch('abc', 1)).toThrow(/baseSha/)
  })

  it('rejects non-positive pid', () => {
    expect(() => buildReviewfixBranch('abc1234', 0)).toThrow(/pid/)
    expect(() => buildReviewfixBranch('abc1234', -1)).toThrow(/pid/)
  })
})

// ---------------------------------------------------------------------------
// Test 5: Worktree setup plan
// ---------------------------------------------------------------------------
describe('planWorktreeSetup (Phase 10 worktree creation)', () => {
  it('produces git worktree add command with -b flag and base SHA', () => {
    const plan = planWorktreeSetup({ baseSha: 'abc1234', pid: 5678 })
    const cmd = plan.createCommand('/tmp/ccg-reviewfix-AbCdEf')
    expect(cmd).toMatch(/git worktree add/)
    expect(cmd).toMatch(/-b 'ccg-reviewfix\/abc1234-5678'/)
    expect(cmd).toMatch(/'\/tmp\/ccg-reviewfix-AbCdEf'/)
    expect(cmd).toMatch(/abc1234$/)
  })

  it('abortCleanupCommands removes worktree before deleting branch', () => {
    const plan = planWorktreeSetup({ baseSha: 'abc1234', pid: 5678 })
    const cmds = plan.abortCleanupCommands('/tmp/ccg-reviewfix-AbCdEf')
    expect(cmds).toHaveLength(2)
    expect(cmds[0]).toMatch(/worktree remove/)
    expect(cmds[1]).toMatch(/branch -D/)
  })
})

// ---------------------------------------------------------------------------
// Test 6: Transactional cleanup tail — 4-step strict order
// ---------------------------------------------------------------------------
describe('planTransactionalCleanup (Phase 10 acceptance d)', () => {
  const sentinel: ReviewFixSentinel = {
    worktree_path: '/tmp/ccg-reviewfix-AbCdEf',
    branch: 'master',
    reviewfix_branch: 'ccg-reviewfix/abc1234-5678',
    base_sha: 'abc1234567890',
    started_at: '2026-05-03T10:30:00.000Z',
  }

  it('CLEANUP_STEP_ORDER is exactly merge → worktree_remove → branch_delete → sentinel_remove', () => {
    expect(CLEANUP_STEP_ORDER).toEqual([
      'merge_ff_only',
      'worktree_remove',
      'branch_delete',
      'sentinel_remove',
    ])
  })

  it('produces 4 steps in strict order', () => {
    const steps = planTransactionalCleanup(sentinel)
    expect(steps).toHaveLength(4)
    expect(steps.map((s) => s.id)).toEqual([
      'merge_ff_only',
      'worktree_remove',
      'branch_delete',
      'sentinel_remove',
    ])
  })

  it('step 1 uses git merge --ff-only', () => {
    const steps = planTransactionalCleanup(sentinel)
    expect(steps[0].command).toMatch(/merge --ff-only/)
    expect(steps[0].command).toMatch(/'ccg-reviewfix\/abc1234-5678'/)
  })

  it('step 2 uses git worktree remove --force', () => {
    const steps = planTransactionalCleanup(sentinel)
    expect(steps[1].command).toMatch(/worktree remove --force/)
    expect(steps[1].command).toMatch(/'\/tmp\/ccg-reviewfix-AbCdEf'/)
  })

  it('step 3 uses git branch -D (only after merge succeeded)', () => {
    const steps = planTransactionalCleanup(sentinel)
    expect(steps[2].command).toMatch(/branch -D/)
    expect(steps[2].command).toMatch(/'ccg-reviewfix\/abc1234-5678'/)
  })

  it('step 4 has null command (fs operation, not shell)', () => {
    const steps = planTransactionalCleanup(sentinel)
    expect(steps[3].command).toBeNull()
    expect(steps[3].id).toBe('sentinel_remove')
  })

  it('all steps have haltOnPriorFailure=true', () => {
    const steps = planTransactionalCleanup(sentinel)
    for (const s of steps) {
      expect(s.haltOnPriorFailure).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Test 7: Cleanup execution summary — halt on first failure
// ---------------------------------------------------------------------------
describe('summarizeCleanup (Phase 10 halt-on-failure semantics)', () => {
  it('records all 4 completed when all ok', () => {
    const result = summarizeCleanup([
      { step: 'merge_ff_only', ok: true },
      { step: 'worktree_remove', ok: true },
      { step: 'branch_delete', ok: true },
      { step: 'sentinel_remove', ok: true },
    ])
    expect(result.completed).toHaveLength(4)
    expect(result.failedAt).toBeNull()
  })

  it('halts at first failure — middle step fails, subsequent steps not executed', () => {
    // Mock: merge ok, worktree_remove fails → executor stops, only 2 entries
    const result = summarizeCleanup([
      { step: 'merge_ff_only', ok: true },
      { step: 'worktree_remove', ok: false, reason: 'worktree locked' },
    ])
    expect(result.completed).toEqual(['merge_ff_only'])
    expect(result.failedAt).toBe('worktree_remove')
    expect(result.failureReason).toMatch(/locked/)
  })

  it('detects out-of-order step results as failure (anti foot-gun)', () => {
    // Caller mistakenly sent worktree_remove first
    const result = summarizeCleanup([
      { step: 'worktree_remove', ok: true },
    ])
    expect(result.failedAt).toBe('merge_ff_only')
    expect(result.failureReason).toMatch(/out-of-order/)
    expect(result.completed).toEqual([])
  })

  it('first step (merge) failure halts cascade — branch & sentinel preserved', () => {
    const result = summarizeCleanup([
      { step: 'merge_ff_only', ok: false, reason: 'non-fast-forward: master diverged' },
    ])
    expect(result.completed).toEqual([])
    expect(result.failedAt).toBe('merge_ff_only')
    // Test guarantee: when ff-only fails, caller never touches branch -D / sentinel
  })
})

// ---------------------------------------------------------------------------
// Test 8: Per-finding rollback via git checkout (NOT Write)
// ---------------------------------------------------------------------------
describe('planFindingRollback (Phase 10 acceptance e)', () => {
  it('uses git checkout -- for single file', () => {
    const plan = planFindingRollback(['src/foo.ts'])
    expect(plan.command).toBe(`git checkout -- 'src/foo.ts'`)
  })

  it('uses git checkout -- for multi-file finding (single command)', () => {
    const plan = planFindingRollback(['src/a.ts', 'src/b.ts', 'src/c.ts'])
    expect(plan.command).toBe(`git checkout -- 'src/a.ts' 'src/b.ts' 'src/c.ts'`)
    expect(plan.files).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
  })

  it('rejects empty file list', () => {
    expect(() => planFindingRollback([])).toThrow(/empty/)
  })

  it('escapes single quotes in path (anti shell injection)', () => {
    const plan = planFindingRollback([`src/it's-bad.ts`])
    // Single quote in path becomes '\''
    expect(plan.command).toContain(`'src/it'\\''s-bad.ts'`)
  })
})

// ---------------------------------------------------------------------------
// Test 9: Atomic commit per finding
// ---------------------------------------------------------------------------
describe('buildFindingCommit (Phase 10 atomic commit)', () => {
  it('builds commit subject with fix({phase}): {id} {desc} format', () => {
    const c = buildFindingCommit({
      paddedPhase: '10',
      findingId: 'C-01',
      shortDescription: 'sanitize SQL identifier',
    })
    expect(c.subject).toBe('fix(10): C-01 sanitize SQL identifier')
  })

  it('embeds multi-file list in commit body (single commit, multiple files)', () => {
    const c = buildFindingCommit({
      paddedPhase: '10',
      findingId: 'F-02',
      shortDescription: 'rename helper across 3 files',
      files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    })
    expect(c.body).toContain('src/a.ts')
    expect(c.body).toContain('src/b.ts')
    expect(c.body).toContain('src/c.ts')
    // command does git add of all 3 files (NOT -A, scoped to finding)
    expect(c.command).toContain(`git add 'src/a.ts' 'src/b.ts' 'src/c.ts'`)
  })

  it('falls back to git add -A when no files specified', () => {
    const c = buildFindingCommit({
      paddedPhase: '10',
      findingId: 'F-03',
      shortDescription: 'config tweak',
    })
    expect(c.command).toContain('git add -A')
  })

  it('rejects missing findingId or shortDescription', () => {
    expect(() =>
      buildFindingCommit({ paddedPhase: '10', findingId: '', shortDescription: 'x' }),
    ).toThrow()
    expect(() =>
      buildFindingCommit({ paddedPhase: '10', findingId: 'F-01', shortDescription: '' }),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Test 10: --auto convergence cap = 3
// ---------------------------------------------------------------------------
describe('decideConverge (Phase 10 acceptance f, AUTO_CONVERGE_CAP=3)', () => {
  it('AUTO_CONVERGE_CAP equals 3 (CCG hard rule)', () => {
    expect(AUTO_CONVERGE_CAP).toBe(3)
  })

  it('returns continue when no rounds yet', () => {
    expect(decideConverge([])).toBe('continue')
  })

  it('returns converged when critical+warning reach 0', () => {
    const decision = decideConverge([
      { round: 1, findings: { critical: 0, warning: 0, info: 5 } },
    ])
    expect(decision).toBe('converged')
  })

  it('returns continue when findings strictly decrease and < cap', () => {
    const decision = decideConverge([
      { round: 1, findings: { critical: 3, warning: 5, info: 2 } },
      { round: 2, findings: { critical: 1, warning: 2, info: 1 } },
    ])
    expect(decision).toBe('continue')
  })

  it('returns escalate after exactly 3 rounds (cap reached)', () => {
    const decision = decideConverge([
      { round: 1, findings: { critical: 5, warning: 5, info: 0 } },
      { round: 2, findings: { critical: 3, warning: 4, info: 0 } },
      { round: 3, findings: { critical: 1, warning: 2, info: 0 } },
    ])
    expect(decision).toBe('escalate')
  })

  it('returns escalate on stall (2 consecutive rounds with non-decreasing findings)', () => {
    const decision = decideConverge([
      { round: 1, findings: { critical: 2, warning: 3, info: 0 } },
      { round: 2, findings: { critical: 2, warning: 3, info: 0 } },
    ])
    expect(decision).toBe('escalate')
  })

  it('respects custom cap parameter', () => {
    const history = [
      { round: 1, findings: { critical: 3, warning: 1, info: 0 } },
      { round: 2, findings: { critical: 1, warning: 0, info: 0 } },
    ]
    expect(decideConverge(history, 2)).toBe('escalate')
    expect(decideConverge(history, 5)).toBe('continue')
  })
})

// ---------------------------------------------------------------------------
// Test 11: shellQuote escaping
// ---------------------------------------------------------------------------
describe('shellQuote (cross-platform safety)', () => {
  it('wraps simple paths in single quotes', () => {
    expect(shellQuote('/tmp/foo')).toBe(`'/tmp/foo'`)
  })

  it('escapes single quotes correctly', () => {
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`)
  })

  it('handles empty string', () => {
    expect(shellQuote('')).toBe(`''`)
  })

  it('handles paths with spaces', () => {
    expect(shellQuote('/tmp/my dir')).toBe(`'/tmp/my dir'`)
  })
})

// ---------------------------------------------------------------------------
// Test 12: End-to-end interrupt recovery scenario (sentinel detection)
// ---------------------------------------------------------------------------
describe('Interrupt recovery scenario (Phase 10 acceptance c — sentinel survives crash)', () => {
  it('roundtrip: serialize → parse recovers exact sentinel', () => {
    // Simulate: fixer crashed mid-run, sentinel persisted on disk.
    // Next startup reads + parses sentinel to detect orphan worktree.
    const original: ReviewFixSentinel = {
      worktree_path: 'C:\\Users\\admin\\AppData\\Local\\Temp\\ccg-reviewfix-XYZ',
      branch: 'feature/auth',
      reviewfix_branch: 'ccg-reviewfix/3b29d91-12345',
      base_sha: '3b29d911234567890',
      started_at: '2026-05-03T10:30:00.000Z',
    }
    const onDisk = serializeSentinel(original)
    const recovered = parseSentinel(onDisk)
    expect(recovered).not.toBeNull()
    expect(recovered).toEqual(original)
    // Caller would then run cleanup steps using this recovered sentinel
    const plan = planTransactionalCleanup(recovered!)
    expect(plan).toHaveLength(4)
  })

  it('aborted run: cleanup at failure point preserves orphan worktree for human review', () => {
    // Scenario: cleanup ran, merge failed (e.g. user pushed conflicting commits).
    // We expect: completed=[], failedAt=merge_ff_only,
    // worktree intact, branch intact, sentinel intact → next run detects.
    const result = summarizeCleanup([
      {
        step: 'merge_ff_only',
        ok: false,
        reason: 'fatal: Not possible to fast-forward, aborting.',
      },
    ])
    expect(result.completed).toEqual([])
    expect(result.failedAt).toBe('merge_ff_only')
    // Caller's invariant: when merge fails, do NOT call subsequent steps.
    // Sentinel persists on disk → next run's `parseSentinel` finds it.
  })
})
