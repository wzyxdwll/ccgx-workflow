/**
 * Unit tests for src/utils/broker-log.ts (v4.5 P1d, codex C3).
 *
 * Coverage matrix:
 *   1. tx_id collision resistance — 1e5 generate, 0 collisions
 *   2. tx_id format validation (V4 UUID regex)
 *   3. Schema validation rejects each missing field
 *   4. Schema validation rejects type mismatches (numeric / negative / NaN)
 *   5. JSONL append round-trip (single event)
 *   6. JSONL append produces exactly one line per event (no pretty-print)
 *   7. readAllEvents tolerates missing file + trailing blank line
 *   8. readAllEvents quarantines bad lines but keeps good ones
 *   9. getTxLineage returns ONLY events with exact tx_id (no false matches
 *      across concurrent txs sharing same job_id / phase_id / pid)
 *  10. getTxLineage rejects non-UUID tx_id (defensive)
 *  11. createEmitter assigns monotonic per-tx sequence starting at 0
 *  12. groupByTx round-trips multiple interleaved txs
 *  13. Cross-platform path separator (Windows + POSIX)
 *  14. Append refuses pre-validated bad event (engineering safety net)
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  appendEvent,
  createEmitter,
  getTxLineage,
  groupByTx,
  isValidTxId,
  newTxId,
  readAllEvents,
  validateEvent,
  type BrokerEvent,
} from '../broker-log'

let workdir: string
let logPath: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ccg-broker-log-'))
  logPath = join(workdir, '.context', 'broker.log')
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

function makeEvent(overrides: Partial<BrokerEvent> = {}): BrokerEvent {
  return {
    tx_id: newTxId(),
    job_id: 'job-test-1',
    phase_id: 'phase-test',
    outer_cli_pid: 1000,
    plugin_pid: 0,
    event_type: 'tx_start',
    timestamp: new Date().toISOString(),
    sequence: 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1-2. tx_id generation
// ---------------------------------------------------------------------------

describe('newTxId / isValidTxId', () => {
  it('generates 1e5 UUIDs with zero collisions', () => {
    const N = 100_000
    const seen = new Set<string>()
    for (let i = 0; i < N; i++) {
      const id = newTxId()
      expect(seen.has(id), `collision at i=${i}: ${id}`).toBe(false)
      seen.add(id)
    }
    expect(seen.size).toBe(N)
  })

  it('produces canonical V4 UUID format', () => {
    for (let i = 0; i < 100; i++) {
      const id = newTxId()
      expect(isValidTxId(id), `invalid: ${id}`).toBe(true)
    }
  })

  it('rejects non-UUID strings', () => {
    expect(isValidTxId('')).toBe(false)
    expect(isValidTxId('abc')).toBe(false)
    expect(isValidTxId('00000000-0000-0000-0000-000000000000')).toBe(false) // not v4 (version nibble)
    expect(isValidTxId(123 as unknown as string)).toBe(false)
    expect(isValidTxId(null as unknown as string)).toBe(false)
    expect(isValidTxId(undefined as unknown as string)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3-4. Schema validation
// ---------------------------------------------------------------------------

describe('validateEvent', () => {
  it('accepts a fully valid event', () => {
    const r = validateEvent(makeEvent())
    expect(r.ok).toBe(true)
  })

  it('rejects each missing required field', () => {
    const required = [
      'tx_id', 'job_id', 'phase_id', 'outer_cli_pid', 'plugin_pid',
      'event_type', 'timestamp', 'sequence',
    ] as const
    for (const f of required) {
      const e: Record<string, unknown> = { ...makeEvent() }
      delete e[f]
      const r = validateEvent(e)
      expect(r.ok, `should reject missing ${f}`).toBe(false)
      if (!r.ok) expect(r.reason).toBe(`missing-field:${f}`)
    }
  })

  it('rejects non-object input', () => {
    expect(validateEvent(null).ok).toBe(false)
    expect(validateEvent(undefined).ok).toBe(false)
    expect(validateEvent('string').ok).toBe(false)
    expect(validateEvent(42).ok).toBe(false)
    expect(validateEvent([makeEvent()]).ok).toBe(false)
  })

  it('rejects type-mismatched fields', () => {
    expect(validateEvent({ ...makeEvent(), tx_id: 'not-a-uuid' }).ok).toBe(false)
    expect(validateEvent({ ...makeEvent(), job_id: '' }).ok).toBe(false)
    expect(validateEvent({ ...makeEvent(), phase_id: 42 }).ok).toBe(false)
    expect(validateEvent({ ...makeEvent(), outer_cli_pid: -1 }).ok).toBe(false)
    expect(validateEvent({ ...makeEvent(), outer_cli_pid: 1.5 }).ok).toBe(false)
    expect(validateEvent({ ...makeEvent(), plugin_pid: 'pid' }).ok).toBe(false)
    expect(validateEvent({ ...makeEvent(), event_type: '' }).ok).toBe(false)
    expect(validateEvent({ ...makeEvent(), timestamp: 'not-a-date' }).ok).toBe(false)
    expect(validateEvent({ ...makeEvent(), sequence: -1 }).ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5-7. Append + read round-trip
// ---------------------------------------------------------------------------

describe('appendEvent / readAllEvents', () => {
  it('round-trips a single event', () => {
    const event = makeEvent({ payload: { foo: 'bar', n: 42 } })
    appendEvent(logPath, event)
    const { events, rejected } = readAllEvents(logPath)
    expect(rejected).toEqual([])
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(event)
  })

  it('produces exactly one line per event (no pretty-print)', () => {
    const e1 = makeEvent({ event_type: 'tx_start' })
    const e2 = makeEvent({ event_type: 'tx_end_success' })
    appendEvent(logPath, e1)
    appendEvent(logPath, e2)
    const text = readFileSync(logPath, 'utf-8')
    const newlines = (text.match(/\n/g) ?? []).length
    expect(newlines).toBe(2)
    // No internal newlines from pretty-printing.
    expect(text.split('\n')).toHaveLength(3) // 2 events + trailing empty
  })

  it('refuses to append an invalid event (defense in depth)', () => {
    expect(() => appendEvent(logPath, { ...makeEvent(), sequence: -1 } as BrokerEvent)).toThrow(/invalid/)
    expect(existsSync(logPath)).toBe(false) // nothing written
  })

  it('returns empty for missing file', () => {
    const r = readAllEvents(logPath)
    expect(r.events).toEqual([])
    expect(r.rejected).toEqual([])
  })

  it('tolerates trailing blank line and quarantines bad JSON', () => {
    const good = makeEvent()
    appendEvent(logPath, good)
    // Tack on a corrupt line + extra blank.
    writeFileSync(logPath, `${readFileSync(logPath, 'utf-8')}{not-json}\n\n`)
    const { events, rejected } = readAllEvents(logPath)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(good)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatch(/^parse-error:/)
  })

  it('quarantines schema-invalid lines but keeps valid ones', () => {
    const good = makeEvent()
    appendEvent(logPath, good)
    // Manually inject a line that parses but is missing fields.
    writeFileSync(logPath, `${readFileSync(logPath, 'utf-8')}${JSON.stringify({ tx_id: 'x' })}\n`)
    const { events, rejected } = readAllEvents(logPath)
    expect(events).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatch(/^missing-field:|^invalid-/)
  })
})

// ---------------------------------------------------------------------------
// 8-9. tx_id correlation (the whole point)
// ---------------------------------------------------------------------------

describe('getTxLineage / groupByTx', () => {
  it('returns ONLY events sharing the exact tx_id', () => {
    const txA = newTxId()
    const txB = newTxId()
    // Two txs sharing job_id / phase_id / pids — the heuristic-free contract:
    // only tx_id may be used for correlation.
    appendEvent(logPath, makeEvent({ tx_id: txA, sequence: 0, event_type: 'tx_start' }))
    appendEvent(logPath, makeEvent({ tx_id: txB, sequence: 0, event_type: 'tx_start' }))
    appendEvent(logPath, makeEvent({ tx_id: txA, sequence: 1, event_type: 'tx_end_success' }))
    appendEvent(logPath, makeEvent({ tx_id: txB, sequence: 1, event_type: 'tx_end_failure' }))

    const lineageA = getTxLineage(logPath, txA)
    expect(lineageA).toHaveLength(2)
    expect(lineageA.every(e => e.tx_id === txA)).toBe(true)
    expect(lineageA[0].event_type).toBe('tx_start')
    expect(lineageA[1].event_type).toBe('tx_end_success')

    const lineageB = getTxLineage(logPath, txB)
    expect(lineageB).toHaveLength(2)
    expect(lineageB[1].event_type).toBe('tx_end_failure')
  })

  it('rejects non-UUID tx_id', () => {
    expect(() => getTxLineage(logPath, 'not-a-uuid')).toThrow(/V4 UUID/)
  })

  it('returns empty array for unknown tx_id', () => {
    appendEvent(logPath, makeEvent())
    const result = getTxLineage(logPath, newTxId())
    expect(result).toEqual([])
  })

  it('groupByTx round-trips interleaved transactions', () => {
    const txs = Array.from({ length: 10 }, () => newTxId())
    // Interleave events: emit tx_start for all, then tx_end for all.
    for (const tx of txs) appendEvent(logPath, makeEvent({ tx_id: tx, sequence: 0, event_type: 'tx_start' }))
    for (const tx of txs) appendEvent(logPath, makeEvent({ tx_id: tx, sequence: 1, event_type: 'tx_end_success' }))

    const grouped = groupByTx(logPath)
    expect(grouped.size).toBe(10)
    for (const tx of txs) {
      const arr = grouped.get(tx)
      expect(arr, `no events for ${tx}`).toBeDefined()
      expect(arr).toHaveLength(2)
      expect(arr![0].sequence).toBe(0)
      expect(arr![1].sequence).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// 10. createEmitter
// ---------------------------------------------------------------------------

describe('createEmitter', () => {
  it('assigns monotonic per-tx sequence starting at 0', () => {
    const txId = newTxId()
    const emit = createEmitter({
      path: logPath,
      txId,
      jobId: 'job-1',
      phaseId: 'phase-1',
      outerCliPid: 1234,
      pluginPid: 5678,
    })
    emit('tx_start')
    emit('tx_progress', { step: 1 })
    emit('tx_progress', { step: 2 })
    emit('tx_end_success')

    const lineage = getTxLineage(logPath, txId)
    expect(lineage.map(e => e.sequence)).toEqual([0, 1, 2, 3])
    expect(lineage.map(e => e.event_type)).toEqual(['tx_start', 'tx_progress', 'tx_progress', 'tx_end_success'])
    expect(lineage[1].payload).toEqual({ step: 1 })
  })

  it('refuses non-UUID txId at construction', () => {
    expect(() =>
      createEmitter({
        path: logPath,
        txId: 'bad',
        jobId: 'j', phaseId: 'p', outerCliPid: 1, pluginPid: 1,
      }),
    ).toThrow(/V4 UUID/)
  })

  it('two concurrent emitters produce independent sequences (no cross-talk)', () => {
    const txA = newTxId()
    const txB = newTxId()
    const emitA = createEmitter({ path: logPath, txId: txA, jobId: 'j', phaseId: 'p', outerCliPid: 1, pluginPid: 10 })
    const emitB = createEmitter({ path: logPath, txId: txB, jobId: 'j', phaseId: 'p', outerCliPid: 1, pluginPid: 20 })

    // Interleave.
    emitA('tx_start')
    emitB('tx_start')
    emitA('tx_progress')
    emitB('tx_progress')
    emitB('tx_end_success')
    emitA('tx_end_success')

    const lineageA = getTxLineage(logPath, txA)
    const lineageB = getTxLineage(logPath, txB)
    expect(lineageA.map(e => e.sequence)).toEqual([0, 1, 2])
    expect(lineageB.map(e => e.sequence)).toEqual([0, 1, 2])
    expect(lineageA.every(e => e.plugin_pid === 10)).toBe(true)
    expect(lineageB.every(e => e.plugin_pid === 20)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 11. Cross-platform path
// ---------------------------------------------------------------------------

describe('cross-platform paths', () => {
  it('handles platform-native separators in the log path', () => {
    // join() already produces native separators; we just exercise both write
    // + read at a deeply nested path to catch any string-comparison bugs.
    const nested = join(workdir, 'a', 'b', 'c', 'broker.log')
    const event = makeEvent()
    appendEvent(nested, event)
    expect(existsSync(nested)).toBe(true)
    const { events } = readAllEvents(nested)
    expect(events).toEqual([event])
  })
})
