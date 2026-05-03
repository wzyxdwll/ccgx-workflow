import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getJob,
  isCancelRequested,
  jobCancelFlagPath,
  jobDir,
  jobResultPath,
  jobStatePath,
  jobsRoot,
  listJobs,
  readJobResult,
  requestCancel,
  sanitizeJobId,
  writeJobResult,
  writeJobState,
  type JobState,
} from '../jobs'

let workdir: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ccg-jobs-test-'))
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

function makeJob(id: string, overrides: Partial<JobState> = {}): JobState {
  return {
    task_id: id,
    kind: 'codex-rescue',
    status: 'running',
    phase_id: 'phase-07-async-triplet',
    started_at: '2026-05-03T10:00:00.000Z',
    last_update: '2026-05-03T10:00:00.000Z',
    summary: 'doing work',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------

describe('sanitizeJobId', () => {
  it('keeps alphanumerics, dashes, underscores, dots', () => {
    expect(sanitizeJobId('job_123-abc.7')).toBe('job_123-abc.7')
  })

  it('collapses unsafe runs to single dash', () => {
    expect(sanitizeJobId('job 1 // foo')).toBe('job-1-foo')
  })

  it('strips leading and trailing dashes', () => {
    expect(sanitizeJobId('--bad/id--')).toBe('bad-id')
  })

  it('throws on empty input', () => {
    expect(() => sanitizeJobId('   ')).toThrow(/empty/)
  })
})

// ---------------------------------------------------------------------------

describe('writeJobState + getJob', () => {
  it('creates job dir + state.json on first write', () => {
    writeJobState(workdir, makeJob('j1'))
    expect(existsSync(jobDir(workdir, 'j1'))).toBe(true)
    expect(existsSync(jobStatePath(workdir, 'j1'))).toBe(true)
  })

  it('round-trips a job — getJob returns the persisted state', () => {
    const job = makeJob('j2', { status: 'queued', summary: 'pending' })
    writeJobState(workdir, job)
    const loaded = getJob(workdir, 'j2')
    expect(loaded).not.toBeNull()
    expect(loaded!.task_id).toBe('j2')
    expect(loaded!.status).toBe('queued')
    expect(loaded!.summary).toBe('pending')
  })

  it('refreshes last_update on every write', () => {
    const job = makeJob('j3', { last_update: '2020-01-01T00:00:00.000Z' })
    writeJobState(workdir, job)
    const loaded = getJob(workdir, 'j3')!
    expect(loaded.last_update).not.toBe('2020-01-01T00:00:00.000Z')
    expect(new Date(loaded.last_update).getTime()).toBeGreaterThan(0)
  })

  it('getJob returns null for unknown job', () => {
    expect(getJob(workdir, 'does-not-exist')).toBeNull()
  })

  it('throws on missing required fields', () => {
    expect(() => writeJobState(workdir, { task_id: 'x' } as unknown as JobState)).toThrow(/missing required field/)
  })

  it('throws on invalid status enum', () => {
    expect(() =>
      writeJobState(workdir, makeJob('j4', { status: 'weird' as unknown as JobState['status'] })),
    ).toThrow(/status invalid/)
  })

  it('getJob throws when state.json is malformed JSON', () => {
    writeJobState(workdir, makeJob('j5'))
    writeFileSync(jobStatePath(workdir, 'j5'), '{not json', 'utf-8')
    expect(() => getJob(workdir, 'j5')).toThrow(/not valid JSON/)
  })
})

// ---------------------------------------------------------------------------

describe('listJobs', () => {
  it('returns empty array when jobs root is missing', () => {
    expect(listJobs(workdir)).toEqual([])
    expect(existsSync(jobsRoot(workdir))).toBe(false)
  })

  it('lists multiple jobs sorted by started_at DESC', () => {
    writeJobState(workdir, makeJob('a', { started_at: '2026-01-01T00:00:00.000Z' }))
    writeJobState(workdir, makeJob('b', { started_at: '2026-03-01T00:00:00.000Z' }))
    writeJobState(workdir, makeJob('c', { started_at: '2026-02-01T00:00:00.000Z' }))
    const jobs = listJobs(workdir)
    expect(jobs.map(j => j.task_id)).toEqual(['b', 'c', 'a'])
  })

  it('skips corrupt job dirs but does not throw', () => {
    writeJobState(workdir, makeJob('good'))
    // Corrupt sibling dir
    writeJobState(workdir, makeJob('bad'))
    writeFileSync(jobStatePath(workdir, 'bad'), '<<corrupt>>', 'utf-8')
    const jobs = listJobs(workdir)
    expect(jobs.map(j => j.task_id)).toEqual(['good'])
  })
})

// ---------------------------------------------------------------------------

describe('writeJobResult + readJobResult', () => {
  it('writes and reads a result blob', () => {
    writeJobState(workdir, makeJob('r1'))
    writeJobResult(workdir, 'r1', 'STATUS: completed\nNOTES: ok')
    expect(readJobResult(workdir, 'r1')).toBe('STATUS: completed\nNOTES: ok')
  })

  it('returns null when result is not yet written', () => {
    writeJobState(workdir, makeJob('r2'))
    expect(readJobResult(workdir, 'r2')).toBeNull()
  })

  it('writeJobResult creates job dir even before state exists', () => {
    writeJobResult(workdir, 'orphan', 'preliminary output')
    expect(existsSync(jobResultPath(workdir, 'orphan'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------

describe('requestCancel + isCancelRequested', () => {
  it('writes cancel.flag and flips cancel_requested=true', () => {
    writeJobState(workdir, makeJob('c1'))
    expect(isCancelRequested(workdir, 'c1')).toBe(false)
    const updated = requestCancel(workdir, 'c1')
    expect(updated.cancel_requested).toBe(true)
    expect(isCancelRequested(workdir, 'c1')).toBe(true)
    expect(existsSync(jobCancelFlagPath(workdir, 'c1'))).toBe(true)
  })

  it('does NOT mutate status to canceled (child task owns that transition)', () => {
    writeJobState(workdir, makeJob('c2', { status: 'running' }))
    const updated = requestCancel(workdir, 'c2')
    expect(updated.status).toBe('running')
  })

  it('throws when job does not exist', () => {
    expect(() => requestCancel(workdir, 'missing')).toThrow(/not found/)
  })

  it('throws when job is already terminal', () => {
    writeJobState(workdir, makeJob('c3', { status: 'done' }))
    expect(() => requestCancel(workdir, 'c3')).toThrow(/already done/)
    writeJobState(workdir, makeJob('c4', { status: 'canceled' }))
    expect(() => requestCancel(workdir, 'c4')).toThrow(/already canceled/)
    writeJobState(workdir, makeJob('c5', { status: 'failed' }))
    expect(() => requestCancel(workdir, 'c5')).toThrow(/already failed/)
  })

  it('is idempotent — second call still succeeds and stays canceled-pending', () => {
    writeJobState(workdir, makeJob('c6'))
    requestCancel(workdir, 'c6')
    const second = requestCancel(workdir, 'c6')
    expect(second.cancel_requested).toBe(true)
    expect(isCancelRequested(workdir, 'c6')).toBe(true)
  })
})

// ---------------------------------------------------------------------------

describe('integration — typical lifecycle', () => {
  it('queued → running → done writes the right files', () => {
    const id = 'lifecycle-1'
    writeJobState(workdir, makeJob(id, { status: 'queued', summary: 'queued for codex' }))
    writeJobState(workdir, makeJob(id, { status: 'running', summary: 'codex working' }))
    writeJobResult(workdir, id, 'STATUS: completed\nCOMMIT: deadbeef\nTESTS: 332/332 passed')
    writeJobState(workdir, makeJob(id, { status: 'done', summary: 'codex finished' }))

    const final = getJob(workdir, id)!
    expect(final.status).toBe('done')
    expect(readJobResult(workdir, id)).toContain('STATUS: completed')

    // state.json is well-formed JSON
    const raw = readFileSync(jobStatePath(workdir, id), 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })
})
