/**
 * v4.5 P7 tests: stuck-detector.
 *
 * Covers acceptance §3 — three rules:
 *   a. loop      (≥ 3 same-tool-call repetition)
 *   b. slow-tool (single tool > 30s without result)
 *   c. stalled   (no event for > 5min)
 */

import { describe, expect, it } from 'vitest'
import { detectStuck, hasStuckWarning, __hashArgs } from '../stuck-detector'

const T0 = Date.parse('2026-05-06T08:00:00.000Z')

/** Shape an assistant tool_use event at time `t` (ms epoch). */
function toolUse(name: string, input: unknown, id: string, t: number): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(t).toISOString(),
    message: { role: 'assistant', content: [{ type: 'tool_use', name, input, id }] },
  })
}

/** Shape a tool_result event for `id` at time `t`. */
function toolResult(id: string, t: number): string {
  return JSON.stringify({
    type: 'user',
    timestamp: new Date(t).toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  })
}

// ---------------------------------------------------------------------------
// hashArgs sanity
// ---------------------------------------------------------------------------

describe('__hashArgs', () => {
  it('produces equal hash for equal args', () => {
    expect(__hashArgs({ a: 1, b: 2 })).toBe(__hashArgs({ a: 1, b: 2 }))
  })

  it('produces different hash for different args', () => {
    expect(__hashArgs({ a: 1 })).not.toBe(__hashArgs({ a: 2 }))
  })
})

// ---------------------------------------------------------------------------
// Rule a: loop detection
// ---------------------------------------------------------------------------

describe('detectStuck — loop', () => {
  it('warns when same tool called 3× with same args', () => {
    const jsonl = [
      toolUse('edit_file', { file_path: 'a.ts', new_str: 'x' }, 'id1', T0),
      toolResult('id1', T0 + 100),
      toolUse('edit_file', { file_path: 'a.ts', new_str: 'x' }, 'id2', T0 + 200),
      toolResult('id2', T0 + 300),
      toolUse('edit_file', { file_path: 'a.ts', new_str: 'x' }, 'id3', T0 + 400),
      toolResult('id3', T0 + 500),
    ].join('\n')
    const ws = detectStuck(jsonl, { now: T0 + 1000 })
    const loop = ws.find(w => w.kind === 'loop')
    expect(loop).toBeDefined()
    expect(loop!.message).toContain('Possible loop')
    expect(loop!.message).toContain('edit_file')
    expect(loop!.detail?.repeatCount).toBe(3)
  })

  it('does NOT warn when args differ each time', () => {
    const jsonl = [
      toolUse('edit_file', { file_path: 'a.ts' }, 'id1', T0),
      toolUse('edit_file', { file_path: 'b.ts' }, 'id2', T0 + 100),
      toolUse('edit_file', { file_path: 'c.ts' }, 'id3', T0 + 200),
    ].join('\n')
    const ws = detectStuck(jsonl, { now: T0 + 1000 })
    expect(ws.find(w => w.kind === 'loop')).toBeUndefined()
  })

  it('respects custom loopThreshold', () => {
    const jsonl = [
      toolUse('grep', { pattern: 'x' }, 'id1', T0),
      toolUse('grep', { pattern: 'x' }, 'id2', T0 + 100),
    ].join('\n')
    const ws = detectStuck(jsonl, { loopThreshold: 2, now: T0 + 1000 })
    expect(ws.find(w => w.kind === 'loop')).toBeDefined()
  })

  it('emits exactly one loop warning per consecutive run', () => {
    const jsonl = [
      toolUse('grep', { p: '1' }, 'a', T0),
      toolUse('grep', { p: '1' }, 'b', T0 + 100),
      toolUse('grep', { p: '1' }, 'c', T0 + 200),
      toolUse('grep', { p: '1' }, 'd', T0 + 300),
      toolUse('grep', { p: '1' }, 'e', T0 + 400),
    ].join('\n')
    const ws = detectStuck(jsonl, { now: T0 + 1000 })
    const loops = ws.filter(w => w.kind === 'loop')
    expect(loops).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Rule b: slow tool
// ---------------------------------------------------------------------------

describe('detectStuck — slow tool', () => {
  it('warns when tool_use lacks matching result and elapsed > 30s', () => {
    const jsonl = toolUse('bash', { command: 'sleep 100' }, 'id1', T0)
    const ws = detectStuck(jsonl, { now: T0 + 60_000 })
    const slow = ws.find(w => w.kind === 'slow-tool')
    expect(slow).toBeDefined()
    expect(slow!.detail?.toolName).toBe('bash')
    expect(slow!.detail?.elapsedMs).toBeGreaterThanOrEqual(60_000)
  })

  it('does NOT warn when tool finished within threshold', () => {
    const jsonl = [
      toolUse('bash', { command: 'echo' }, 'id1', T0),
      toolResult('id1', T0 + 1_000),
    ].join('\n')
    const ws = detectStuck(jsonl, { now: T0 + 60_000 })
    expect(ws.find(w => w.kind === 'slow-tool')).toBeUndefined()
  })

  it('does NOT warn when tool still running but under threshold', () => {
    const jsonl = toolUse('bash', { command: 'echo' }, 'id1', T0)
    const ws = detectStuck(jsonl, { now: T0 + 10_000 })
    expect(ws.find(w => w.kind === 'slow-tool')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Rule c: stalled stream
// ---------------------------------------------------------------------------

describe('detectStuck — stalled', () => {
  it('warns when no events for > 5 minutes', () => {
    const jsonl = JSON.stringify({ type: 'hook_started', timestamp: new Date(T0).toISOString(), hook: { name: 'X' } })
    const ws = detectStuck(jsonl, { now: T0 + 6 * 60 * 1000 })
    const stalled = ws.find(w => w.kind === 'stalled')
    expect(stalled).toBeDefined()
    expect(stalled!.message).toContain('Stream stalled')
  })

  it('does NOT warn when last event is recent', () => {
    const jsonl = JSON.stringify({ type: 'hook_started', timestamp: new Date(T0).toISOString(), hook: { name: 'X' } })
    const ws = detectStuck(jsonl, { now: T0 + 60_000 })
    expect(ws.find(w => w.kind === 'stalled')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('detectStuck — edge cases', () => {
  it('handles empty input', () => {
    expect(detectStuck('')).toEqual([])
    expect(detectStuck(null as unknown as string)).toEqual([])
  })

  it('skips malformed lines', () => {
    const jsonl = ['not-json', '{"bad', '{"type":"hook_started","hook":{"name":"X"},"timestamp":"' + new Date(T0).toISOString() + '"}'].join('\n')
    expect(() => detectStuck(jsonl, { now: T0 + 1000 })).not.toThrow()
  })

  it('hasStuckWarning returns boolean wrapper', () => {
    const jsonl = toolUse('bash', { c: 'x' }, 'id1', T0)
    expect(hasStuckWarning(jsonl, { now: T0 + 60_000 })).toBe(true)
    expect(hasStuckWarning('')).toBe(false)
  })
})
