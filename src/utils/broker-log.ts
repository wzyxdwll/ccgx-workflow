/**
 * Broker log — tx_id correlation for concurrent multi-process events
 * (v4.5 P1d, codex C3).
 *
 * Why this exists
 * ---------------
 * v4.4.2 commit `26a579d` already identified that any consumer of `broker.log`
 * which uses tail-position / time-window / nearest-error heuristics will mis-
 * attribute events under concurrency. v4.5 G-plan multiplies concurrency to
 * 20 ways (4 outer CLI × 5 nested plugin), so any heuristic correlation will
 * silently corrupt audit trails.
 *
 * Bedrock truth: the only reliable correlator across concurrent OS processes
 * is a 128-bit unique id (`crypto.randomUUID`, V4 UUID, ~5.3e36 collision space).
 * Time, sequence, and PID are all reused; only the UUID is not. Therefore the
 * broker.log MUST be written and read exclusively through tx_id correlation.
 *
 * Contract
 * --------
 *   - tx_id is allocated by `newTxId()` exactly once per logical transaction
 *     (e.g. one nested plugin spawn). Children inherit it via env (`CCG_BROKER_TX_ID`).
 *   - Every event is one JSONL line; one append per event; never edit prior lines.
 *   - Schema is validated on read; events missing required fields are dropped
 *     and counted (caller can decide whether that's a bug to surface).
 *   - `getTxLineage(txId)` returns ALL events sharing exact tx_id, in file order.
 *   - There is intentionally NO API for "events near event X by time" or
 *     "the last event before exit" — those are precisely the heuristics that
 *     misattribute under concurrency.
 *
 * Cross-platform
 * --------------
 * Pure Node stdlib. JSONL append uses `fs.appendFileSync` which on POSIX maps to
 * a single `write(2)` with O_APPEND (atomic up to PIPE_BUF, kernel-serialized
 * for short lines on most filesystems); on Windows the runtime acquires an
 * exclusive write lock per syscall. For typical event payloads (<1 KiB) we get
 * line-atomicity in practice, which is what JSONL parsers assume.
 *
 * NB: this module is the SCHEMA owner. Consumers (hooks, dashboards, the
 * supervisor) must import from here rather than inlining their own parsing.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Event types observed on the broker.log channel. Kept open-ended (string)
 * rather than a strict enum so future plugin events don't require a release
 * of this module — but the schema validator still requires the field to be a
 * non-empty string.
 */
export type BrokerEventType =
  | 'tx_start'
  | 'tx_end_success'
  | 'tx_end_failure'
  | 'tx_progress'
  | 'tx_handoff'
  | (string & {})

export interface BrokerEvent {
  /** 128-bit V4 UUID. Unique per logical transaction. Never reused. */
  tx_id: string
  /** ccg job id; ties events back to `.context/jobs/<id>/state.json`. */
  job_id: string
  /** phase id from roadmap.md (e.g. `phase-v4.5-04-broker-stress`). */
  phase_id: string
  /** PID of the outer CLI subprocess (the L1 boundary in v4.5). */
  outer_cli_pid: number
  /**
   * PID of the inner plugin subprocess (the L2 boundary; nested only).
   * For events emitted by the outer CLI itself this is 0.
   */
  plugin_pid: number
  /** Event kind; producer's choice, must be non-empty. */
  event_type: BrokerEventType
  /** ISO 8601 with millisecond precision (`Date#toISOString()`). */
  timestamp: string
  /**
   * Per-tx_id monotonic counter. Producers track their own counter for the
   * single tx they own; readers can verify ordering within a single tx.
   */
  sequence: number
  /** Free-form data payload. Schema validation does not inspect this. */
  payload?: Record<string, unknown>
}

const REQUIRED_FIELDS: (keyof BrokerEvent)[] = [
  'tx_id',
  'job_id',
  'phase_id',
  'outer_cli_pid',
  'plugin_pid',
  'event_type',
  'timestamp',
  'sequence',
]

// ---------------------------------------------------------------------------
// tx_id generation
// ---------------------------------------------------------------------------

/**
 * Mint a fresh 128-bit V4 UUID. Wraps `crypto.randomUUID` (Node 14.17+) so the
 * call site can't accidentally substitute `Math.random` / `Date.now` / PID
 * (all of which leak entropy and reuse across processes).
 *
 * Birthday-paradox math: at 1e6 ids, collision probability ≈ 1.5e-26.
 * For the v4.5 stress envelope (1e5 spawns) collision is effectively impossible.
 */
export function newTxId(): string {
  return randomUUID()
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** True iff `id` is the canonical V4 UUID textual format. */
export function isValidTxId(id: unknown): id is string {
  return typeof id === 'string' && UUID_V4_RE.test(id)
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

/**
 * Validate a parsed JSON object against the BrokerEvent schema.
 * Returns a structured result so callers can decide whether to drop or surface.
 */
export function validateEvent(raw: unknown): { ok: true, event: BrokerEvent } | { ok: false, reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'not-an-object' }
  }
  const obj = raw as Record<string, unknown>

  for (const f of REQUIRED_FIELDS) {
    if (!(f in obj)) return { ok: false, reason: `missing-field:${f}` }
  }

  if (!isValidTxId(obj.tx_id)) return { ok: false, reason: 'invalid-tx_id' }
  if (typeof obj.job_id !== 'string' || obj.job_id.length === 0) return { ok: false, reason: 'invalid-job_id' }
  if (typeof obj.phase_id !== 'string' || obj.phase_id.length === 0) return { ok: false, reason: 'invalid-phase_id' }
  if (typeof obj.outer_cli_pid !== 'number' || !Number.isInteger(obj.outer_cli_pid) || obj.outer_cli_pid < 0) {
    return { ok: false, reason: 'invalid-outer_cli_pid' }
  }
  if (typeof obj.plugin_pid !== 'number' || !Number.isInteger(obj.plugin_pid) || obj.plugin_pid < 0) {
    return { ok: false, reason: 'invalid-plugin_pid' }
  }
  if (typeof obj.event_type !== 'string' || obj.event_type.length === 0) {
    return { ok: false, reason: 'invalid-event_type'  }
  }
  if (typeof obj.timestamp !== 'string' || Number.isNaN(Date.parse(obj.timestamp))) {
    return { ok: false, reason: 'invalid-timestamp' }
  }
  if (typeof obj.sequence !== 'number' || !Number.isInteger(obj.sequence) || obj.sequence < 0) {
    return { ok: false, reason: 'invalid-sequence' }
  }

  return { ok: true, event: obj as unknown as BrokerEvent }
}

// ---------------------------------------------------------------------------
// Append (write side)
// ---------------------------------------------------------------------------

/**
 * Append one event to the broker.log at `path`. Synchronous so producer code
 * doesn't have to thread async/await through tight emit loops; the call is
 * one syscall (`appendFileSync` → `open(O_APPEND) + write + close`). Caller is
 * responsible for ensuring the parent directory exists; we create it if not
 * to keep first-spawn simple.
 *
 * The line is `JSON.stringify(event) + '\n'`. We do NOT pretty-print: multi-
 * line JSON breaks JSONL parsers and is exactly the bug class this contract
 * forbids.
 */
export function appendEvent(path: string, event: BrokerEvent): void {
  const validation = validateEvent(event)
  if (!validation.ok) {
    throw new Error(`broker-log: refusing to append invalid event (${validation.reason})`)
  }
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const line = `${JSON.stringify(event)}\n`
  if (line.includes('\n', 0) && line.indexOf('\n') !== line.length - 1) {
    // Defense in depth: an unescaped newline inside JSON.stringify output is
    // impossible (it would be \n in the string) but we guard anyway since a
    // payload like `{ msg: "a\nb" }` MUST stringify without literal newlines.
    throw new Error('broker-log: serialized event contains embedded newline')
  }
  appendFileSync(path, line, { encoding: 'utf-8' })
}

// ---------------------------------------------------------------------------
// Read (parse side)
// ---------------------------------------------------------------------------

export interface ReadAllResult {
  events: BrokerEvent[]
  /** Lines that failed schema validation, with index + reason. */
  rejected: Array<{ index: number, reason: string, raw: string }>
}

/**
 * Read and validate every line in the broker.log at `path`. Missing file
 * returns empty (we don't treat absence as an error — common case is "no
 * events emitted yet").
 *
 * Rejected events are kept separately so the caller can decide between
 * "drop silently" (production hooks) and "fail loud" (audit / test code).
 */
export function readAllEvents(path: string): ReadAllResult {
  if (!existsSync(path)) return { events: [], rejected: [] }

  const text = readFileSync(path, 'utf-8')
  const events: BrokerEvent[] = []
  const rejected: ReadAllResult['rejected'] = []

  // Split on '\n' and drop the trailing empty (file ends with newline by
  // contract). Don't trim other whitespace — JSONL preserves it inside strings.
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.length === 0) continue // tolerate trailing newline + blank lines

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    }
    catch (err) {
      rejected.push({ index: i, reason: `parse-error:${(err as Error).message}`, raw: line })
      continue
    }

    const v = validateEvent(parsed)
    if (!v.ok) {
      rejected.push({ index: i, reason: v.reason, raw: line })
      continue
    }
    events.push(v.event)
  }

  return { events, rejected }
}

/**
 * All events for one tx_id, in file order. The ONLY supported correlation
 * primitive (codex C3 hardline). Returns empty array if tx not found OR if
 * the log file does not exist — equivalent outcomes from the consumer's
 * standpoint ("no events for this tx").
 */
export function getTxLineage(path: string, txId: string): BrokerEvent[] {
  if (!isValidTxId(txId)) {
    throw new Error(`broker-log: getTxLineage requires a V4 UUID, got ${String(txId).slice(0, 64)}`)
  }
  const { events } = readAllEvents(path)
  return events.filter(e => e.tx_id === txId)
}

/**
 * Group all events by tx_id. Convenience for dashboards / debugging tools
 * that want to walk every transaction once. Order within each group is file
 * order.
 */
export function groupByTx(path: string): Map<string, BrokerEvent[]> {
  const { events } = readAllEvents(path)
  const out = new Map<string, BrokerEvent[]>()
  for (const e of events) {
    let arr = out.get(e.tx_id)
    if (!arr) {
      arr = []
      out.set(e.tx_id, arr)
    }
    arr.push(e)
  }
  return out
}

// ---------------------------------------------------------------------------
// Producer helper
// ---------------------------------------------------------------------------

/**
 * Per-tx producer. Emits events with a monotonic per-tx sequence so consumers
 * can verify ordering within a single tx WITHOUT touching cross-tx ordering
 * (which is meaningless under concurrency).
 *
 * Usage (one instance per nested spawn):
 *
 *     const emit = createEmitter({
 *       path: '<workdir>/.context/broker.log',
 *       txId: process.env.CCG_BROKER_TX_ID ?? newTxId(),
 *       jobId: '<job-id>',
 *       phaseId: '<phase-id>',
 *       outerCliPid: Number(process.env.CCG_OUTER_CLI_PID ?? process.pid),
 *       pluginPid: process.pid,
 *     })
 *     emit('tx_start', { plugin: 'codex:codex-rescue' })
 *     ...
 *     emit('tx_end_success', { exit_code: 0 })
 */
export function createEmitter(opts: {
  path: string
  txId: string
  jobId: string
  phaseId: string
  outerCliPid: number
  pluginPid: number
}): (eventType: BrokerEventType, payload?: Record<string, unknown>) => void {
  if (!isValidTxId(opts.txId)) {
    throw new Error('broker-log: createEmitter requires a V4 UUID for txId')
  }
  let seq = 0
  return (eventType, payload) => {
    const event: BrokerEvent = {
      tx_id: opts.txId,
      job_id: opts.jobId,
      phase_id: opts.phaseId,
      outer_cli_pid: opts.outerCliPid,
      plugin_pid: opts.pluginPid,
      event_type: eventType,
      timestamp: new Date().toISOString(),
      sequence: seq++,
      payload,
    }
    appendEvent(opts.path, event)
  }
}

// ---------------------------------------------------------------------------
// Forbidden APIs (intentionally absent)
// ---------------------------------------------------------------------------
//
// We deliberately do NOT export:
//   - findEventByTimestamp(near)         — time correlation under 20-way
//                                          concurrency is unsound
//   - lastEventBefore(eventX)            — file-order correlation across
//                                          tx boundaries is unsound
//   - findFailureNearestTo(timestamp)    — same; this is the v4.4.2 bug class
//
// If you find yourself wanting one of these, you almost certainly want
// getTxLineage(txId) instead. That requires the caller to plumb txId through
// (env / launcher / state.json), which is the whole point of this module.
