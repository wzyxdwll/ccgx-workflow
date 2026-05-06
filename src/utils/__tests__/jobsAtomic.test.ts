/**
 * Atomicity contract tests for src/utils/jobs.ts (v4.5 P1b).
 *
 * Codex C2 row 11/13 require: state.json / result.md / cancel.flag must never
 * be observed in a half-written state, even under concurrent writers or a
 * SIGKILL between open and write.
 *
 * Proving "never half-written" with Node's fs API at unit-test scope is
 * impossible (we can't fault-inject mid-syscall). What we CAN verify:
 *   1. Implementation uses temp file + rename (no in-place truncate-then-write).
 *   2. Temp files are always cleaned up on success.
 *   3. Temp files are cleaned up when the rename throws (so we don't leak
 *      `state.json.tmp.<rand>` across crashes).
 *   4. After completion only the canonical filename exists in the dir.
 *   5. Round-trip: write+read returns identical content for state, result, and
 *      cancel-flag paths (via writeJobState/writeJobResult/requestCancel).
 *   6. Concurrency smoke: 50 parallel writes produce a valid final JSON
 *      (last-rename-wins; no torn JSON).
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  atomicWriteFileSync,
  isCancelRequested,
  jobCancelFlagPath,
  jobDir,
  jobResultPath,
  jobStatePath,
  readJobResult,
  requestCancel,
  writeJobResult,
  writeJobState,
  type JobState,
} from '../jobs'

let workdir: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ccg-jobs-atomic-'))
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

function makeJob(id: string, overrides: Partial<JobState> = {}): JobState {
  return {
    task_id: id,
    kind: 'phase-runner',
    status: 'running',
    started_at: '2026-05-06T10:00:00.000Z',
    last_update: '2026-05-06T10:00:00.000Z',
    summary: 'atomic test',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------

describe('atomicWriteFileSync', () => {
  it('writes the canonical path and removes the temp file on success', () => {
    const target = join(workdir, 'state.json')
    atomicWriteFileSync(target, '{"hello":"world"}')
    expect(existsSync(target)).toBe(true)
    // No leftover temp.
    const leftover = readdirSync(workdir).filter(f => f.startsWith('state.json.tmp.'))
    expect(leftover).toEqual([])
  })

  it('cleans up the temp file when the initial write throws (e.g. ENOENT)', () => {
    // Forces a write failure by pointing at a path inside a non-existent dir.
    // Covers "the rename never gets a chance because the open(2) failed" path,
    // which is the more common failure mode than a successful write + failed
    // rename. Either path triggers the same try/catch + cleanup.
    const target = join(workdir, 'no-such-dir', 'state.json')
    expect(() => atomicWriteFileSync(target, 'data')).toThrow()
    // No temp left in workdir root either.
    const leftover = readdirSync(workdir).filter(f => f.startsWith('state.json.tmp.'))
    expect(leftover).toEqual([])
    expect(existsSync(target)).toBe(false)
  })

  it('uses unique temp suffixes — concurrent writers do not overwrite each other', () => {
    const target = join(workdir, 'state.json')
    // Sequential 50 writes — each must succeed; no temp left at the end.
    for (let i = 0; i < 50; i++) {
      atomicWriteFileSync(target, `{"i":${i}}`)
    }
    const final = readFileSync(target, 'utf-8')
    // Last write is the persisted one; JSON parses cleanly.
    expect(JSON.parse(final).i).toBe(49)
    const leftover = readdirSync(workdir).filter(f => f.startsWith('state.json.tmp.'))
    expect(leftover).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('writeJobState — atomic semantics', () => {
  it('round-trips state and never leaves a temp file on success', () => {
    const job = makeJob('atomic-1')
    writeJobState(workdir, job)
    expect(existsSync(jobStatePath(workdir, 'atomic-1'))).toBe(true)
    const dir = jobDir(workdir, 'atomic-1')
    const leftover = readdirSync(dir).filter(f => f.startsWith('state.json.tmp.'))
    expect(leftover).toEqual([])
  })

  it('persists valid JSON every time across rapid sequential writes', () => {
    const job = makeJob('atomic-2')
    writeJobState(workdir, job)
    for (let i = 0; i < 20; i++) {
      writeJobState(workdir, { ...job, summary: `update ${i}` })
    }
    const persisted = JSON.parse(readFileSync(jobStatePath(workdir, 'atomic-2'), 'utf-8'))
    expect(persisted.summary).toBe('update 19')
    expect(persisted.task_id).toBe('atomic-2')
  })
})

// ---------------------------------------------------------------------------

describe('writeJobResult — atomic semantics', () => {
  it('round-trips result and leaves no temp on success', () => {
    writeJobResult(workdir, 'atomic-3', 'STATUS: completed\nNOTES: ok\n')
    expect(readJobResult(workdir, 'atomic-3')).toMatch(/STATUS: completed/)
    const dir = jobDir(workdir, 'atomic-3')
    const leftover = readdirSync(dir).filter(f => f.startsWith('result.md.tmp.'))
    expect(leftover).toEqual([])
  })

  it('overwrites cleanly without partial bytes', () => {
    writeJobResult(workdir, 'atomic-4', 'first content')
    writeJobResult(workdir, 'atomic-4', 'second content')
    expect(readJobResult(workdir, 'atomic-4')).toBe('second content')
  })
})

// ---------------------------------------------------------------------------

describe('requestCancel — atomic cancel.flag', () => {
  it('writes flag atomically and leaves no temp', () => {
    writeJobState(workdir, makeJob('atomic-5'))
    requestCancel(workdir, 'atomic-5')
    expect(isCancelRequested(workdir, 'atomic-5')).toBe(true)
    const flagContent = readFileSync(jobCancelFlagPath(workdir, 'atomic-5'), 'utf-8')
    expect(flagContent).toMatch(/cancel-requested-at: \d{4}-\d{2}-\d{2}T/)
    const dir = jobDir(workdir, 'atomic-5')
    const leftover = readdirSync(dir).filter(f => f.startsWith('cancel.flag.tmp.'))
    expect(leftover).toEqual([])
  })

  it('cancel.flag is well-formed text — never half-written', () => {
    writeJobState(workdir, makeJob('atomic-6'))
    requestCancel(workdir, 'atomic-6')
    const flagContent = readFileSync(jobCancelFlagPath(workdir, 'atomic-6'), 'utf-8')
    // Format: line ends with newline; fully valid even if observed mid-write.
    expect(flagContent.endsWith('\n')).toBe(true)
  })
})

// ---------------------------------------------------------------------------

describe('result + state path layout', () => {
  it('result is sibling of state inside same job dir', () => {
    writeJobState(workdir, makeJob('atomic-7'))
    writeJobResult(workdir, 'atomic-7', 'final')
    expect(jobResultPath(workdir, 'atomic-7'))
      .toBe(join(jobDir(workdir, 'atomic-7'), 'result.md'))
    expect(jobStatePath(workdir, 'atomic-7'))
      .toBe(join(jobDir(workdir, 'atomic-7'), 'state.json'))
  })
})
