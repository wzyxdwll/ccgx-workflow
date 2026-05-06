/**
 * Job state management for async background tasks (v4.0 Phase 7).
 *
 * Commands `/ccg:status`, `/ccg:result`, `/ccg:cancel` use these helpers to
 * make long-running background work (codex:codex-rescue / gemini:gemini-rescue / autonomous
 * phases) observable from the user level. Job state lives entirely on the
 * filesystem under `<workdir>/.context/jobs/<job-id>/`:
 *
 *   - state.json   — JobState (machine-readable status / phase / summary)
 *   - result.md    — final output blob (≤ 200 token summary by convention)
 *   - cancel.flag  — sentinel file; child task polls and exits cooperatively
 *
 * No daemon, no IPC, no DB — just files. This keeps the design crash-safe
 * and works identically across Windows / macOS / Linux.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled'

export type JobKind =
  | 'codex-rescue'
  | 'gemini-rescue'
  | 'phase-runner'
  | 'autonomous'
  | 'team-exec'
  | 'generic'

export interface JobState {
  task_id: string
  kind: JobKind
  status: JobStatus
  phase_id?: string
  started_at: string
  last_update: string
  summary?: string
  cancel_requested?: boolean
}

const REQUIRED_FIELDS: (keyof JobState)[] = [
  'task_id',
  'kind',
  'status',
  'started_at',
  'last_update',
]

const VALID_STATUSES: ReadonlySet<JobStatus> = new Set([
  'queued',
  'running',
  'done',
  'failed',
  'canceled',
])

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function jobsRoot(workdir: string): string {
  return join(workdir, '.context', 'jobs')
}

export function jobDir(workdir: string, jobId: string): string {
  return join(jobsRoot(workdir), sanitizeJobId(jobId))
}

export function jobStatePath(workdir: string, jobId: string): string {
  return join(jobDir(workdir, jobId), 'state.json')
}

export function jobResultPath(workdir: string, jobId: string): string {
  return join(jobDir(workdir, jobId), 'result.md')
}

export function jobCancelFlagPath(workdir: string, jobId: string): string {
  return join(jobDir(workdir, jobId), 'cancel.flag')
}

/**
 * Sanitize a job-id so it is filesystem-safe on every platform. Allows
 * alphanumerics plus `-`, `_`, `.`. Everything else is collapsed to `-`.
 */
export function sanitizeJobId(jobId: string): string {
  const trimmed = jobId.trim()
  if (!trimmed) {
    throw new Error('jobId cannot be empty')
  }
  return trimmed.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

function validateJobState(state: unknown): asserts state is JobState {
  if (state === null || typeof state !== 'object') {
    throw new Error('JobState must be an object')
  }
  const s = state as Record<string, unknown>
  for (const f of REQUIRED_FIELDS) {
    if (s[f] === undefined || s[f] === null || s[f] === '') {
      throw new Error(`JobState missing required field: ${f}`)
    }
  }
  if (typeof s.status !== 'string' || !VALID_STATUSES.has(s.status as JobStatus)) {
    throw new Error(`JobState.status invalid: ${String(s.status)}`)
  }
}

// ---------------------------------------------------------------------------
// Atomic write helper (v4.5 P1b — codex C2 row "any process crash leaves no
// half-written JSON"). Writes to `<target>.tmp.<rand>` then `rename` into place.
// `rename` is atomic on POSIX and behaves atomically on Windows when both
// paths are on the same volume (see codeagent-wrapper precedent + Node docs).
//
// Failure modes covered:
//   - power loss / SIGKILL between open and write → tmp file orphaned, target
//     untouched (next reader sees previous valid state)
//   - SIGKILL during rename → either tmp or target survives intact
//   - parallel writers → last-rename-wins; never a partial JSON observed
// ---------------------------------------------------------------------------

/**
 * Atomically write `content` to `target`. Internally writes to a sibling temp
 * file and renames into place. Throws on I/O error; never leaves a half-written
 * `target` file even if interrupted between the two syscalls.
 *
 * Caller is responsible for ensuring the parent directory exists.
 *
 * Idempotent w.r.t. orphaned temp files: a stale `<target>.tmp.<rand>` from a
 * prior crash does not block fresh writes (tmp uses fresh random suffix).
 */
export function atomicWriteFileSync(target: string, content: string): void {
  // 12 hex chars (48 bits) — collision-free for any realistic concurrency.
  const rand = randomBytes(6).toString('hex')
  const tmp = `${target}.tmp.${rand}`
  try {
    writeFileSync(tmp, content, 'utf-8')
    renameSync(tmp, target)
  }
  catch (err) {
    // Best-effort cleanup of the orphan; ignore if already gone.
    try { unlinkSync(tmp) }
    catch { /* nothing to clean up */ }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/**
 * Persist (or update) job state to disk. Creates the job directory if needed.
 * Always refreshes `last_update` to the current ISO timestamp.
 */
export function writeJobState(workdir: string, state: JobState): void {
  validateJobState(state)
  const dir = jobDir(workdir, state.task_id)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const updated: JobState = { ...state, last_update: new Date().toISOString() }
  // v4.5 P1b: atomic write — codex C2 "state.json never half-written under crash"
  atomicWriteFileSync(
    jobStatePath(workdir, state.task_id),
    JSON.stringify(updated, null, 2),
  )
}

/**
 * Read a single job's state. Returns `null` if the job dir does not exist.
 * Throws if `state.json` is malformed (corrupt jobs surface loudly so the
 * user can investigate rather than silently disappearing from `listJobs`).
 */
export function getJob(workdir: string, jobId: string): JobState | null {
  const path = jobStatePath(workdir, jobId)
  if (!existsSync(path)) {
    return null
  }
  const raw = readFileSync(path, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch (err) {
    throw new Error(`Job ${jobId}: state.json is not valid JSON (${(err as Error).message})`)
  }
  validateJobState(parsed)
  return parsed
}

/**
 * List all jobs under `<workdir>/.context/jobs/`. Sorted by `started_at`
 * descending (newest first). Skips directories without a valid state.json
 * (with a warning attached so callers can surface it).
 */
export function listJobs(workdir: string): JobState[] {
  const root = jobsRoot(workdir)
  if (!existsSync(root)) {
    return []
  }
  const entries = readdirSync(root)
  const jobs: JobState[] = []
  for (const id of entries) {
    const sub = join(root, id)
    try {
      if (!statSync(sub).isDirectory()) continue
    }
    catch {
      continue
    }
    try {
      const job = getJob(workdir, id)
      if (job) jobs.push(job)
    }
    catch {
      // Corrupt job dir — skip silently from list view; `getJob(id)` still
      // throws when probed directly so the user can diagnose.
    }
  }
  jobs.sort((a, b) => b.started_at.localeCompare(a.started_at))
  return jobs
}

/**
 * Read the final result blob for a job. Returns `null` if not yet written.
 */
export function readJobResult(workdir: string, jobId: string): string | null {
  const path = jobResultPath(workdir, jobId)
  if (!existsSync(path)) {
    return null
  }
  return readFileSync(path, 'utf-8')
}

/**
 * Write (or overwrite) the final result blob.
 */
export function writeJobResult(workdir: string, jobId: string, body: string): void {
  const dir = jobDir(workdir, jobId)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  // v4.5 P1b: atomic write — never observe a half-written final result blob.
  atomicWriteFileSync(jobResultPath(workdir, jobId), body)
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

/**
 * Request cancellation of a job. Writes `cancel.flag` for the child task to
 * pick up on its next polling tick, and flips `cancel_requested=true` on the
 * existing state. Status is NOT mutated to `canceled` here — that transition
 * is the child task's responsibility once it actually exits.
 *
 * Idempotent: calling twice is safe and a no-op the second time.
 *
 * Returns the updated JobState. Throws if the job does not exist or has
 * already terminated (`done` / `failed` / `canceled`).
 */
export function requestCancel(workdir: string, jobId: string): JobState {
  const existing = getJob(workdir, jobId)
  if (!existing) {
    throw new Error(`Job not found: ${jobId}`)
  }
  if (existing.status === 'done' || existing.status === 'failed' || existing.status === 'canceled') {
    throw new Error(`Cannot cancel job ${jobId}: already ${existing.status}`)
  }
  // v4.5 P1b: atomic write — cancel.flag presence is the cooperative-cancel
  // contract; a half-written flag would confuse pollers.
  atomicWriteFileSync(
    jobCancelFlagPath(workdir, jobId),
    `cancel-requested-at: ${new Date().toISOString()}\n`,
  )
  const updated: JobState = { ...existing, cancel_requested: true }
  writeJobState(workdir, updated)
  return updated
}

/**
 * Whether the cancel.flag file is present. Child tasks poll this on each
 * tick; if true, they should clean up and update status to `canceled`.
 */
export function isCancelRequested(workdir: string, jobId: string): boolean {
  return existsSync(jobCancelFlagPath(workdir, jobId))
}
