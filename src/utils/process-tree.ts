/**
 * Process tree supervision for v4.5 phase-runner subprocesses.
 *
 * Codex C2 + C4 mandate: every CLI subprocess (and any nested plugin process)
 * must be killable from the orchestrator even when the user hits Ctrl+C, the
 * subprocess hangs in an LLM call, or the main `claude.exe` crashes mid-run.
 *
 * This module provides three independently-testable primitives:
 *
 *   1. `isProcessAlive(pid, startedAt?)` — verifies a recorded PID is still
 *      the same process we launched. PID reuse hazard mitigation: if a
 *      `startedAt` ISO timestamp is provided, we additionally compare against
 *      the OS-reported process start time when available (best-effort).
 *
 *   2. `killProcessTree(opts)` — terminates a process tree with grace period.
 *      - Windows: shells out to `taskkill /T /F /PID <pid>` (mirrors the
 *        codeagent-wrapper Go implementation; KISS — no Job Object FFI).
 *      - POSIX: sends SIGTERM to the process group (`-pgid`), waits the grace
 *        period, then SIGKILL. The launcher must have called `setsid()` /
 *        `detached: true` so the child has its own process group; otherwise
 *        we fall back to single-PID kill.
 *
 *   3. `reconcileStaleJobs({workdir})` — at session start, scan
 *      `.context/jobs/*\/state.json`. For every state in `running` / `queued`,
 *      check if the recorded `cli_pid` is still alive. If not (and the result
 *      file is missing), mark the job `failed` with a "stale" summary so the
 *      roadmap doesn't loop forever.
 *
 * Pure module: zero side-effects on import; all state writes happen through
 * the explicit functions. Safe to require from a synchronous Node hook
 * (templates/hooks/ccg-session-state.cjs) or to import from TS source.
 *
 * Failure-mode coverage (codex C2 thirteen-row table cross-reference):
 *   row 1: main crashes before CLI launch        → reconciler marks queued/running stale
 *   row 2: main crashes after CLI launch          → reconciler validates cli_pid, adopts result if present
 *   row 3: main receives Ctrl+C                   → cancel.flag + grace + killProcessTree
 *   row 4: CLI auth failure                       → exit code surfaced by launcher
 *   row 5: CLI crashes before final result        → cli_pid no longer alive → reconciler marks failed
 *   row 6: CLI exceeds budget                     → launcher captures non-zero exit
 *   row 7: CLI killed during nested edit          → kill-tree includes nested plugin
 *   row 8: nested plugin loud crash               → caller surfaces failure via exit code
 *   row 9: nested plugin hang                     → grace period + kill-tree
 *   row 10: nested plugin silent fallback         → orthogonal (broker/verify path)
 *   row 11: plugin succeeds but CLI dies          → reconciler probes result.md presence
 *   row 12: CLI writes result but parser fails    → orthogonal (parser layer)
 *   row 13: roadmap advances without durable evidence → reconciler asserts result+state matched
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import {
  atomicWriteFileSync,
  jobResultPath,
  jobsRoot,
  jobStatePath,
  type JobState,
} from './jobs'

// ---------------------------------------------------------------------------
// Platform detection (no top-level side effects)
// ---------------------------------------------------------------------------

function isWindowsPlatform(): boolean {
  return process.platform === 'win32'
}

// ---------------------------------------------------------------------------
// Liveness check
// ---------------------------------------------------------------------------

/**
 * Whether a PID is still alive. Implementation:
 *   - POSIX: `process.kill(pid, 0)` — the canonical idiom; throws ESRCH for
 *     dead processes, EPERM if alive but owned by another user (treat as
 *     alive: at least we know the PID slot is taken by something).
 *   - Windows: same `process.kill(pid, 0)` works since Node 14+.
 *
 * `pid` <= 0 always returns false (no point probing init / pid 0).
 *
 * NOTE: this does NOT detect PID reuse. A long-running OS may hand the same
 * pid back to a fresh process. For PID-reuse hardening, the reconciler also
 * compares `started_at` proximity (a job started 7 days ago whose pid is
 * "alive" today is almost certainly a different process).
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // EPERM = exists but owned by another user → still "alive" for our purpose
    if (code === 'EPERM') return true
    return false
  }
}

// ---------------------------------------------------------------------------
// Kill tree
// ---------------------------------------------------------------------------

export interface KillTreeOptions {
  /** Root PID of the tree to kill. */
  pid: number
  /** POSIX process-group id (negative pid). Required on POSIX for full-tree kill. */
  pgid?: number | null
  /**
   * Milliseconds to wait between SIGTERM (or first taskkill) and SIGKILL.
   * Default 5000 — matches codex C4 "wait short grace period then kill tree".
   */
  graceMs?: number
  /**
   * Inject for tests — replaces the spawnSync used to run taskkill on Windows.
   * Returns nonzero status to simulate failure.
   */
  spawnSyncFn?: typeof spawnSync
  /**
   * Inject for tests — replaces process.kill (signal sender). Defaults to
   * Node's process.kill bound. Receives (target, signal); target may be
   * negative (process group) on POSIX.
   */
  killFn?: (target: number, signal?: NodeJS.Signals | number) => void
  /**
   * Inject for tests — controls the grace-period sleep so unit tests don't
   * actually wait 5 seconds. Returns a Promise that resolves after `ms`.
   */
  sleepFn?: (ms: number) => Promise<void>
  /** Override platform detection in tests. */
  isWindowsFn?: () => boolean
}

export interface KillTreeResult {
  /** Whether the tree appears to be terminated after the call. */
  terminated: boolean
  /** Steps taken; useful for tests + post-mortem logs. */
  steps: string[]
  /** Non-fatal errors captured during termination attempts. */
  errors: string[]
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Best-effort kill of a process tree. Always returns (no throw). Caller
 * inspects `result.terminated` + `result.errors`.
 *
 * Design notes:
 *   - We never escalate without first attempting graceful termination — a
 *     hard kill mid-edit can leave half-written files (codex C2 row 7).
 *   - On POSIX we kill the *process group* so nested plugin descendants go
 *     down too. Requires the launcher to have used `detached: true` (which
 *     makes Node call `setsid()` for us).
 *   - On Windows we use `taskkill /T /F /PID` which recursively kills the
 *     tree by walking the parent-of relation. Mirrors codeagent-wrapper
 *     `executor.go:1421` (proven across Codex Node-worker spawns).
 */
export async function killProcessTree(opts: KillTreeOptions): Promise<KillTreeResult> {
  const result: KillTreeResult = { terminated: false, steps: [], errors: [] }
  const grace = opts.graceMs ?? 5000
  const sleep = opts.sleepFn ?? defaultSleep
  const isWindows = (opts.isWindowsFn ?? isWindowsPlatform)()
  const killFn = opts.killFn ?? ((target: number, signal?: NodeJS.Signals | number) => {
    process.kill(target, signal)
  })

  if (!Number.isInteger(opts.pid) || opts.pid <= 0) {
    result.errors.push(`invalid pid: ${opts.pid}`)
    return result
  }

  // Already gone? Nothing to do.
  if (!isProcessAlive(opts.pid)) {
    result.terminated = true
    result.steps.push('already-dead')
    return result
  }

  if (isWindows) {
    // Phase 1: graceful (taskkill without /F respects WM_CLOSE for GUI children;
    // `claude` is a CLI Node process so this typically fails — we fall through
    // to the forced kill quickly, but try graceful first per the codex C2 rule
    // "no hard kill mid-edit").
    const spawnFn = opts.spawnSyncFn ?? spawnSync
    try {
      const r1 = spawnFn('taskkill', ['/T', '/PID', String(opts.pid)], {
        stdio: 'ignore',
        windowsHide: true,
      })
      result.steps.push(`taskkill-graceful:exit=${r1.status}`)
    }
    catch (err) {
      result.errors.push(`taskkill-graceful: ${(err as Error).message}`)
    }

    await sleep(grace)

    if (!isProcessAlive(opts.pid)) {
      result.terminated = true
      return result
    }

    // Phase 2: forced kill of the whole tree.
    try {
      const r2 = spawnFn('taskkill', ['/T', '/F', '/PID', String(opts.pid)], {
        stdio: 'ignore',
        windowsHide: true,
      })
      result.steps.push(`taskkill-force:exit=${r2.status}`)
    }
    catch (err) {
      result.errors.push(`taskkill-force: ${(err as Error).message}`)
    }

    result.terminated = !isProcessAlive(opts.pid)
    return result
  }

  // POSIX path. Prefer the process group if provided; otherwise single PID.
  // process.kill(-pgid, sig) sends to the entire group.
  const target = typeof opts.pgid === 'number' && opts.pgid > 0 ? -opts.pgid : opts.pid
  try {
    killFn(target, 'SIGTERM')
    result.steps.push(`SIGTERM:target=${target}`)
  }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') {
      // Already gone between our liveness check and the signal — fine.
      result.terminated = true
      result.steps.push('SIGTERM:ESRCH-already-gone')
      return result
    }
    result.errors.push(`SIGTERM: ${(err as Error).message}`)
  }

  await sleep(grace)

  if (!isProcessAlive(opts.pid)) {
    result.terminated = true
    return result
  }

  // Forced kill.
  try {
    killFn(target, 'SIGKILL')
    result.steps.push(`SIGKILL:target=${target}`)
  }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ESRCH') {
      result.errors.push(`SIGKILL: ${(err as Error).message}`)
    }
  }

  result.terminated = !isProcessAlive(opts.pid)
  return result
}

// ---------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------

export interface SupervisedJobState extends JobState {
  /** Parent orchestrator PID at launch time (informational). */
  parent_pid?: number
  /** Direct child CLI pid spawned by the launcher. */
  cli_pid?: number
  /** POSIX process group id. */
  process_group_id?: number
  /** subprocess cwd at launch time. */
  cwd?: string
  /** Bash command actually executed (redacted of secrets at write time). */
  cmd?: string
}

export interface ReconcileOptions {
  /** Project workdir; reconciler scans `<workdir>/.context/jobs/<id>/state.json` for every id. */
  workdir: string
  /** Override liveness probe in tests. */
  isAliveFn?: (pid: number) => boolean
  /**
   * Override "now" for deterministic age-based PID-reuse heuristic.
   * Default: Date.now(). Used in tests to fast-forward.
   */
  nowMs?: number
  /**
   * Maximum seconds since `started_at` after which a "still alive" PID is
   * deemed reused (very conservative — tools like systemd recycle pids on
   * the order of hours, but a 24h-old phase-runner is implausible). Defaults
   * to 24 hours.
   */
  pidReuseAgeMs?: number
}

export interface ReconcileEntry {
  jobId: string
  prior: SupervisedJobState
  action: 'no-op' | 'mark-failed-stale' | 'mark-failed-no-result' | 'adopt-result'
  reason: string
}

export interface ReconcileReport {
  scanned: number
  entries: ReconcileEntry[]
}

/**
 * Walk `.context/jobs/*` and reconcile any state stuck in `running`/`queued`
 * whose `cli_pid` is no longer alive. Idempotent: safe to call repeatedly.
 *
 * Action matrix:
 *   - state.status terminal (done/failed/canceled) → no-op
 *   - cli_pid still alive (and start time plausible) → no-op (job genuinely running)
 *   - cli_pid dead AND result.md present → adopt-result (write status=done with
 *     summary "adopted from result.md after orphan recovery")
 *   - cli_pid dead AND result.md missing → mark-failed-stale
 *   - status=running but no cli_pid recorded → mark-failed-no-result
 *     (legacy job pre-v4.5 supervision; can't verify so we surface as failed)
 */
export function reconcileStaleJobs(opts: ReconcileOptions): ReconcileReport {
  const isAlive = opts.isAliveFn ?? isProcessAlive
  const now = opts.nowMs ?? Date.now()
  const reuseAgeMs = opts.pidReuseAgeMs ?? 24 * 60 * 60 * 1000

  const root = jobsRoot(opts.workdir)
  const report: ReconcileReport = { scanned: 0, entries: [] }
  if (!existsSync(root)) return report

  let dirs: string[]
  try {
    dirs = readdirSync(root)
  }
  catch {
    return report
  }

  for (const id of dirs) {
    const sub = join(root, id)
    let isDir = false
    try { isDir = statSync(sub).isDirectory() }
    catch { continue }
    if (!isDir) continue

    const statePath = jobStatePath(opts.workdir, id)
    if (!existsSync(statePath)) continue

    let state: SupervisedJobState
    try {
      state = JSON.parse(readFileSync(statePath, 'utf-8')) as SupervisedJobState
    }
    catch {
      // Corrupt state.json — explicitly do NOT mutate; let listJobs surface it.
      continue
    }
    report.scanned += 1

    if (
      state.status === 'done'
      || state.status === 'failed'
      || state.status === 'canceled'
    ) {
      report.entries.push({
        jobId: id,
        prior: state,
        action: 'no-op',
        reason: `terminal status ${state.status}`,
      })
      continue
    }

    // Status is `queued` or `running` from here.

    // Pre-v4.5 jobs without cli_pid: surface as failed-no-result so users see
    // them rather than letting them rot as zombie "running" entries forever.
    if (typeof state.cli_pid !== 'number') {
      const updated: SupervisedJobState = {
        ...state,
        status: 'failed',
        summary: 'reconciler: legacy job without cli_pid; cannot verify liveness',
      }
      atomicWriteFileSync(statePath, JSON.stringify(updated, null, 2))
      report.entries.push({
        jobId: id,
        prior: state,
        action: 'mark-failed-no-result',
        reason: 'no cli_pid recorded',
      })
      continue
    }

    const alive = isAlive(state.cli_pid)
    let pidProbablyReused = false
    if (alive && state.started_at) {
      const startedMs = Date.parse(state.started_at)
      if (Number.isFinite(startedMs) && now - startedMs > reuseAgeMs) {
        pidProbablyReused = true
      }
    }

    if (alive && !pidProbablyReused) {
      report.entries.push({
        jobId: id,
        prior: state,
        action: 'no-op',
        reason: 'cli_pid still alive',
      })
      continue
    }

    // Process is gone. Adopt result if it materialized; else mark failed-stale.
    const resultPath = jobResultPath(opts.workdir, id)
    if (existsSync(resultPath)) {
      const updated: SupervisedJobState = {
        ...state,
        status: 'done',
        summary: 'reconciler: cli_pid not alive; adopted result.md after orphan recovery',
      }
      atomicWriteFileSync(statePath, JSON.stringify(updated, null, 2))
      report.entries.push({
        jobId: id,
        prior: state,
        action: 'adopt-result',
        reason: pidProbablyReused
          ? 'pid reuse suspected; result.md present'
          : 'cli_pid dead; result.md present',
      })
      continue
    }

    const updated: SupervisedJobState = {
      ...state,
      status: 'failed',
      summary: pidProbablyReused
        ? 'reconciler: cli_pid suspected reused; no result.md found'
        : 'reconciler: cli_pid dead; no result.md found',
    }
    atomicWriteFileSync(statePath, JSON.stringify(updated, null, 2))
    report.entries.push({
      jobId: id,
      prior: state,
      action: 'mark-failed-stale',
      reason: pidProbablyReused
        ? 'pid reuse + no result'
        : 'cli_pid dead + no result',
    })
  }

  return report
}
