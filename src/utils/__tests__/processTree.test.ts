/**
 * Process-tree supervision tests for src/utils/process-tree.ts (v4.5 P1b).
 *
 * Coverage map → codex C2 thirteen-row "failure-mode table":
 *
 *   row 1  main crashes before CLI launch
 *   row 2  main crashes after CLI launch
 *   row 3  main receives Ctrl+C
 *   row 4  CLI auth failure
 *   row 5  CLI crashes before final result
 *   row 6  CLI exceeds budget
 *   row 7  CLI killed during nested edit
 *   row 8  nested plugin loud crash
 *   row 9  nested plugin hang
 *   row 10 nested plugin silent fallback   (orthogonal — covered by broker tests)
 *   row 11 plugin succeeds but CLI dies
 *   row 12 CLI writes result but parser fails
 *   row 13 main updates roadmap before child result is durable
 *
 * Rows that are orthogonal to process-tree (parser / broker / silent fallback)
 * are still asserted at the *boundary*: this module's job is to surface the
 * fact that a child is/isn't alive accurately. Higher layers consume that.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isProcessAlive,
  killProcessTree,
  reconcileStaleJobs,
  type SupervisedJobState,
} from '../process-tree'
import { jobDir, type JobState } from '../jobs'

let workdir: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ccg-process-tree-'))
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

function writeJobStateRaw(jobId: string, state: SupervisedJobState | JobState) {
  const dir = jobDir(workdir, jobId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8')
}

function writeResult(jobId: string, body: string) {
  const dir = jobDir(workdir, jobId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'result.md'), body, 'utf-8')
}

// =============================================================================
// isProcessAlive
// =============================================================================

describe('isProcessAlive', () => {
  it('returns true for the current process pid', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('returns false for pid <= 0', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
  })

  it('returns false for non-integer pid', () => {
    expect(isProcessAlive(Number.NaN)).toBe(false)
    expect(isProcessAlive(1.5)).toBe(false)
  })

  it('returns false for a guaranteed-dead pid', () => {
    // PID 2_147_483_646 (max int32 - 1) — kernel allocates pids well below this.
    // ESRCH path → false.
    expect(isProcessAlive(2_147_483_646)).toBe(false)
  })
})

// =============================================================================
// killProcessTree
// =============================================================================

describe('killProcessTree', () => {
  it('row 5: returns terminated=true when target pid is already dead', async () => {
    const result = await killProcessTree({ pid: 2_147_483_646, graceMs: 10 })
    expect(result.terminated).toBe(true)
    expect(result.steps).toContain('already-dead')
  })

  it('row 3 (POSIX path): SIGTERM → grace → SIGKILL escalation', async () => {
    let killCalls: Array<{ target: number, signal: NodeJS.Signals | number | undefined }> = []
    const fakeKill = (target: number, signal?: NodeJS.Signals | number) => {
      killCalls.push({ target, signal })
      // Simulate target stays alive after SIGTERM, dies before SIGKILL is checked.
      // Implementation calls isProcessAlive (real fn) — we cannot mock that here
      // without DI; instead we point at a real-but-soon-dead pid. So we instead
      // pass a long-lived pid and assert *what was sent*, not "is gone".
    }
    const sleepFn = async () => { /* skip the 5s wait */ }

    const result = await killProcessTree({
      pid: process.pid, // real, alive — won't actually die
      pgid: process.pid,
      graceMs: 0,
      killFn: fakeKill,
      sleepFn,
      isWindowsFn: () => false,
    })

    // Both SIGTERM and SIGKILL must be issued because the test pid stays alive.
    const signals = killCalls.map(c => c.signal)
    expect(signals).toContain('SIGTERM')
    expect(signals).toContain('SIGKILL')
    // Process group target = -pgid.
    expect(killCalls[0].target).toBe(-process.pid)
    // terminated reflects "is target alive at end?" — process.pid is the test
    // process, so still alive, so terminated=false. That's the contract.
    expect(result.terminated).toBe(false)
  })

  it('row 7 / row 9 (Windows path): taskkill graceful then forced', async () => {
    const calls: Array<{ argv: string[] }> = []
    const spawnFn = (cmd: string, argv: readonly string[]) => {
      calls.push({ argv: [cmd, ...argv] })
      return { status: 0, signal: null, output: [], pid: 0, stdout: '', stderr: '' } as any
    }

    const result = await killProcessTree({
      pid: process.pid,
      graceMs: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawnSyncFn: spawnFn as any,
      sleepFn: async () => {},
      isWindowsFn: () => true,
    })

    // Graceful then forced — both invocations of taskkill.
    expect(calls.length).toBe(2)
    expect(calls[0].argv[0]).toBe('taskkill')
    expect(calls[0].argv).toContain('/T')
    expect(calls[0].argv).not.toContain('/F') // graceful
    expect(calls[1].argv).toContain('/F') // forced
    // process.pid is alive → terminated=false (taskkill doesn't kill us in test).
    expect(result.terminated).toBe(false)
  })

  it('row 9 (nested plugin hang): kills process group, not just root pid', async () => {
    const killCalls: number[] = []
    const fakeKill = (target: number) => {
      killCalls.push(target)
    }
    await killProcessTree({
      pid: process.pid,
      pgid: 12345,
      graceMs: 0,
      killFn: fakeKill,
      sleepFn: async () => {},
      isWindowsFn: () => false,
    })
    // Process group kill target is -pgid.
    expect(killCalls).toContain(-12345)
    // Without pgid we'd see +pid; with pgid we should NOT see plain pid.
    expect(killCalls).not.toContain(process.pid)
  })

  it('refuses invalid pids gracefully (no crash)', async () => {
    const result1 = await killProcessTree({ pid: -1 })
    expect(result1.terminated).toBe(false)
    expect(result1.errors[0]).toMatch(/invalid pid/)

    const result2 = await killProcessTree({ pid: 0 })
    expect(result2.errors[0]).toMatch(/invalid pid/)
  })

  it('row 9 ESRCH between liveness and SIGTERM is handled cleanly', async () => {
    // First call to isProcessAlive returns true (mocked via using current pid),
    // second call (after SIGTERM) returns ESRCH from the kill itself.
    let calls = 0
    const fakeKill = () => {
      calls++
      const err: NodeJS.ErrnoException = new Error('No such process')
      err.code = 'ESRCH'
      throw err
    }
    const result = await killProcessTree({
      pid: process.pid,
      pgid: process.pid,
      graceMs: 0,
      killFn: fakeKill,
      sleepFn: async () => {},
      isWindowsFn: () => false,
    })
    expect(calls).toBeGreaterThanOrEqual(1)
    expect(result.steps.some(s => s.includes('ESRCH'))).toBe(true)
  })
})

// =============================================================================
// reconcileStaleJobs — covers rows 1, 2, 11, 13
// =============================================================================

describe('reconcileStaleJobs', () => {
  it('returns empty when .context/jobs/ does not exist (row 1: pre-launch)', () => {
    const report = reconcileStaleJobs({ workdir })
    expect(report.scanned).toBe(0)
    expect(report.entries).toEqual([])
  })

  it('row 2: cli_pid dead AND result.md present → adopt-result', () => {
    writeJobStateRaw('j-adopt', {
      task_id: 'j-adopt',
      kind: 'phase-runner',
      status: 'running',
      started_at: new Date().toISOString(),
      last_update: new Date().toISOString(),
      cli_pid: 2_147_483_646,
    })
    writeResult('j-adopt', 'STATUS: completed\nNOTES: from inner CLI before main crashed\n')

    const report = reconcileStaleJobs({ workdir })
    expect(report.scanned).toBe(1)
    expect(report.entries[0].action).toBe('adopt-result')

    // state.json updated to done.
    const fs = require('node:fs') as typeof import('node:fs')
    const updated = JSON.parse(
      fs.readFileSync(join(jobDir(workdir, 'j-adopt'), 'state.json'), 'utf-8'),
    )
    expect(updated.status).toBe('done')
    expect(updated.summary).toMatch(/adopted result\.md/)
  })

  it('row 5: cli_pid dead AND no result.md → mark-failed-stale', () => {
    writeJobStateRaw('j-stale', {
      task_id: 'j-stale',
      kind: 'phase-runner',
      status: 'running',
      started_at: new Date().toISOString(),
      last_update: new Date().toISOString(),
      cli_pid: 2_147_483_646,
    })
    const report = reconcileStaleJobs({ workdir })
    expect(report.entries[0].action).toBe('mark-failed-stale')

    const fs = require('node:fs') as typeof import('node:fs')
    const updated = JSON.parse(
      fs.readFileSync(join(jobDir(workdir, 'j-stale'), 'state.json'), 'utf-8'),
    )
    expect(updated.status).toBe('failed')
    expect(updated.summary).toMatch(/no result\.md found/)
  })

  it('legacy job without cli_pid → mark-failed-no-result', () => {
    writeJobStateRaw('j-legacy', {
      task_id: 'j-legacy',
      kind: 'autonomous',
      status: 'running',
      started_at: '2026-05-01T00:00:00.000Z',
      last_update: '2026-05-01T00:00:00.000Z',
    })
    const report = reconcileStaleJobs({ workdir })
    expect(report.entries[0].action).toBe('mark-failed-no-result')

    const fs = require('node:fs') as typeof import('node:fs')
    const updated = JSON.parse(
      fs.readFileSync(join(jobDir(workdir, 'j-legacy'), 'state.json'), 'utf-8'),
    )
    expect(updated.status).toBe('failed')
    expect(updated.summary).toMatch(/legacy job without cli_pid/)
  })

  it('cli_pid alive → no-op (does not touch state)', () => {
    writeJobStateRaw('j-running', {
      task_id: 'j-running',
      kind: 'phase-runner',
      status: 'running',
      started_at: new Date().toISOString(),
      last_update: new Date().toISOString(),
      cli_pid: process.pid, // ourselves — alive
    })
    const report = reconcileStaleJobs({ workdir })
    expect(report.entries[0].action).toBe('no-op')
    expect(report.entries[0].reason).toBe('cli_pid still alive')
  })

  it('terminal status → no-op (idempotent across multiple session-starts)', () => {
    for (const status of ['done', 'failed', 'canceled'] as const) {
      writeJobStateRaw(`j-${status}`, {
        task_id: `j-${status}`,
        kind: 'phase-runner',
        status,
        started_at: new Date().toISOString(),
        last_update: new Date().toISOString(),
        cli_pid: 2_147_483_646,
      })
    }
    const report = reconcileStaleJobs({ workdir })
    expect(report.entries.every(e => e.action === 'no-op')).toBe(true)
  })

  it('PID-reuse heuristic: alive PID + 24h+ old started_at → treat as stale', () => {
    // Pretend "now" is 48h after started_at, beyond the 24h reuse window.
    const startedAt = '2026-05-01T00:00:00.000Z'
    const nowMs = Date.parse(startedAt) + 48 * 60 * 60 * 1000

    writeJobStateRaw('j-reused', {
      task_id: 'j-reused',
      kind: 'phase-runner',
      status: 'running',
      started_at: startedAt,
      last_update: startedAt,
      cli_pid: process.pid, // alive but probably reused
    })

    const report = reconcileStaleJobs({ workdir, nowMs })
    expect(report.entries[0].action).toBe('mark-failed-stale')
    expect(report.entries[0].reason).toMatch(/pid reuse/)
  })

  it('row 11: PID-reuse heuristic + result.md present → adopt with reuse note', () => {
    const startedAt = '2026-05-01T00:00:00.000Z'
    const nowMs = Date.parse(startedAt) + 48 * 60 * 60 * 1000

    writeJobStateRaw('j-reused-with-result', {
      task_id: 'j-reused-with-result',
      kind: 'phase-runner',
      status: 'running',
      started_at: startedAt,
      last_update: startedAt,
      cli_pid: process.pid,
    })
    writeResult('j-reused-with-result', 'STATUS: completed (recovered)\n')

    const report = reconcileStaleJobs({ workdir, nowMs })
    expect(report.entries[0].action).toBe('adopt-result')
    expect(report.entries[0].reason).toMatch(/pid reuse/)
  })

  it('row 13 idempotency: running again on already-reconciled jobs is a no-op', () => {
    writeJobStateRaw('j-once', {
      task_id: 'j-once',
      kind: 'phase-runner',
      status: 'running',
      started_at: new Date().toISOString(),
      last_update: new Date().toISOString(),
      cli_pid: 2_147_483_646,
    })
    const r1 = reconcileStaleJobs({ workdir })
    expect(r1.entries[0].action).toBe('mark-failed-stale')

    const r2 = reconcileStaleJobs({ workdir })
    // Now status=failed → terminal → no-op.
    expect(r2.entries[0].action).toBe('no-op')
  })

  it('skips corrupt state.json silently rather than throwing', () => {
    const dir = jobDir(workdir, 'j-corrupt')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'state.json'), '{not valid json', 'utf-8')

    expect(() => reconcileStaleJobs({ workdir })).not.toThrow()
    const report = reconcileStaleJobs({ workdir })
    expect(report.scanned).toBe(0)
  })

  it('row 4 (auth fail): job already terminal (failed) → no-op, not retouched', () => {
    writeJobStateRaw('j-auth-fail', {
      task_id: 'j-auth-fail',
      kind: 'phase-runner',
      status: 'failed',
      started_at: new Date().toISOString(),
      last_update: new Date().toISOString(),
      summary: 'launcher: auth failure: Not logged in',
      cli_pid: 2_147_483_646,
    })
    const report = reconcileStaleJobs({ workdir })
    expect(report.entries[0].action).toBe('no-op')
    expect(report.entries[0].reason).toBe('terminal status failed')
  })

  it('row 6 (budget overrun): launcher already wrote terminal failed → no-op', () => {
    writeJobStateRaw('j-budget', {
      task_id: 'j-budget',
      kind: 'phase-runner',
      status: 'failed',
      started_at: new Date().toISOString(),
      last_update: new Date().toISOString(),
      summary: 'exit code 70 (budget exceeded)',
      cli_pid: 2_147_483_646,
    })
    const report = reconcileStaleJobs({ workdir })
    expect(report.entries[0].action).toBe('no-op')
  })

  it('mixes 4 scenarios in one workdir cleanly', () => {
    // running + alive
    writeJobStateRaw('j-mix-alive', {
      task_id: 'j-mix-alive',
      kind: 'phase-runner',
      status: 'running',
      started_at: new Date().toISOString(),
      last_update: new Date().toISOString(),
      cli_pid: process.pid,
    })
    // running + dead + result
    writeJobStateRaw('j-mix-adopt', {
      task_id: 'j-mix-adopt',
      kind: 'phase-runner',
      status: 'running',
      started_at: new Date().toISOString(),
      last_update: new Date().toISOString(),
      cli_pid: 2_147_483_646,
    })
    writeResult('j-mix-adopt', 'STATUS: completed\n')
    // running + dead + no result
    writeJobStateRaw('j-mix-stale', {
      task_id: 'j-mix-stale',
      kind: 'phase-runner',
      status: 'running',
      started_at: new Date().toISOString(),
      last_update: new Date().toISOString(),
      cli_pid: 2_147_483_646,
    })
    // terminal
    writeJobStateRaw('j-mix-done', {
      task_id: 'j-mix-done',
      kind: 'phase-runner',
      status: 'done',
      started_at: new Date().toISOString(),
      last_update: new Date().toISOString(),
      cli_pid: 2_147_483_646,
    })

    const report = reconcileStaleJobs({ workdir })
    expect(report.scanned).toBe(4)
    const actions = Object.fromEntries(report.entries.map(e => [e.jobId, e.action]))
    expect(actions['j-mix-alive']).toBe('no-op')
    expect(actions['j-mix-adopt']).toBe('adopt-result')
    expect(actions['j-mix-stale']).toBe('mark-failed-stale')
    expect(actions['j-mix-done']).toBe('no-op')
  })
})

// =============================================================================
// Cross-cutting: result-existence boundary (rows 11, 12)
// =============================================================================

describe('result file boundary (rows 11, 12)', () => {
  it('row 11: presence of result.md drives adopt-result regardless of status content', () => {
    writeJobStateRaw('j-r11', {
      task_id: 'j-r11',
      kind: 'phase-runner',
      status: 'running',
      started_at: new Date().toISOString(),
      last_update: new Date().toISOString(),
      cli_pid: 2_147_483_646,
    })
    writeResult('j-r11', 'STATUS: partial\nNOTES: one acceptance criterion missed\n')
    // Reconciler does NOT parse result.md content; it only adopts the fact that
    // the file exists. Higher layers must inspect summary semantics.
    const report = reconcileStaleJobs({ workdir })
    expect(report.entries[0].action).toBe('adopt-result')
  })

  it('row 12: parser failure is orthogonal — reconciler still adopts the file', () => {
    writeJobStateRaw('j-r12', {
      task_id: 'j-r12',
      kind: 'phase-runner',
      status: 'running',
      started_at: new Date().toISOString(),
      last_update: new Date().toISOString(),
      cli_pid: 2_147_483_646,
    })
    writeResult('j-r12', 'GARBLED   NON-PARSEABLE')
    expect(existsSync(join(jobDir(workdir, 'j-r12'), 'result.md'))).toBe(true)
    const report = reconcileStaleJobs({ workdir })
    // Same outcome — the parser is a separate concern (per row 12 contract).
    expect(report.entries[0].action).toBe('adopt-result')
  })
})
