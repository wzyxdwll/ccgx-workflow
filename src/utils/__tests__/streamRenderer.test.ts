/**
 * v4.5 P7 tests: stream-renderer.
 *
 * Covers acceptance §1 (event filter), §2 (per-event rendering), §4 (ASCII
 * progress bar Windows cp936 safety).
 */

import { describe, expect, it } from 'vitest'
import {
  formatElapsed,
  formatLine,
  parseStreamLine,
  progressBar,
  renderEvent,
  renderJsonl,
  shouldRenderEvent,
  truncate,
  type StreamEvent,
} from '../stream-renderer'

const FIXED_TIME = new Date('2026-05-06T08:15:22.000Z')

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

describe('shouldRenderEvent — drop/keep policy', () => {
  it('drops system/init', () => {
    expect(shouldRenderEvent({ type: 'system', subtype: 'init' })).toBe(false)
  })

  it('drops content_block_delta (token-level streaming)', () => {
    expect(shouldRenderEvent({ type: 'content_block_delta' })).toBe(false)
  })

  it('drops message_start / message_delta / message_stop lifecycle', () => {
    expect(shouldRenderEvent({ type: 'message_start' })).toBe(false)
    expect(shouldRenderEvent({ type: 'message_delta' })).toBe(false)
    expect(shouldRenderEvent({ type: 'message_stop' })).toBe(false)
  })

  it('keeps tool_use / hook_started / assistant / rate_limit / result', () => {
    expect(shouldRenderEvent({ type: 'tool_use' })).toBe(true)
    expect(shouldRenderEvent({ type: 'hook_started' })).toBe(true)
    expect(shouldRenderEvent({ type: 'assistant' })).toBe(true)
    expect(shouldRenderEvent({ type: 'rate_limit_event' })).toBe(true)
    expect(shouldRenderEvent({ type: 'result', subtype: 'success' })).toBe(true)
  })

  it('rejects malformed events safely', () => {
    expect(shouldRenderEvent({} as StreamEvent)).toBe(false)
    expect(shouldRenderEvent(null as unknown as StreamEvent)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// renderEvent — per type
// ---------------------------------------------------------------------------

describe('renderEvent', () => {
  it('renders top-level tool with args', () => {
    const ev: StreamEvent = { type: 'tool_use', tool: { name: 'read_file', input: { file_path: 'src/auth.ts' } } }
    const r = renderEvent(ev, 'Phase 2', FIXED_TIME)
    expect(r).not.toBeNull()
    expect(r!.body).toContain('🛠️')
    expect(r!.body).toContain('read_file')
    expect(r!.body).toContain('src/auth.ts')
    expect(r!.phaseTag).toBe('[Phase 2]')
    expect(r!.timestamp).toBe('08:15:22')
  })

  it('renders assistant message containing tool_use content block', () => {
    const ev: StreamEvent = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'grep_search', input: { pattern: 'TODO' } }],
      },
    }
    const r = renderEvent(ev, 'Phase 1', FIXED_TIME)
    expect(r!.body).toContain('grep_search')
    expect(r!.body).toContain('TODO')
  })

  it('prefers file path keys over other keys when summarizing args', () => {
    const ev: StreamEvent = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'edit_file', input: { new_str: 'x', file_path: 'src/auth.ts' } }],
      },
    }
    const r = renderEvent(ev, 'Phase 1', FIXED_TIME)
    expect(r!.body).toContain('src/auth.ts')
  })

  it('renders assistant text summary truncated to ≤80 chars', () => {
    const long = 'A'.repeat(200)
    const ev: StreamEvent = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: long }] },
    }
    const r = renderEvent(ev, 'Phase 1', FIXED_TIME)
    expect(r!.body.startsWith('🤖')).toBe(true)
    // body = '🤖 ' + truncated(80) = ≤ 82 chars after glyph
    expect(r!.body.replace(/^🤖\s*/, '').length).toBeLessThanOrEqual(80)
  })

  it('renders hook_started', () => {
    const ev: StreamEvent = { type: 'hook_started', hook: { name: 'PreToolUse' } }
    const r = renderEvent(ev, 'Phase 3', FIXED_TIME)
    expect(r!.body).toContain('🔗 Hook')
    expect(r!.body).toContain('PreToolUse')
  })

  it('renders rate_limit_event as warning', () => {
    const ev: StreamEvent = { type: 'rate_limit_event' }
    const r = renderEvent(ev, undefined, FIXED_TIME)
    expect(r!.body).toContain('⚠️')
    expect(r!.body).toContain('Rate limit')
    expect(r!.phaseTag).toBe('')
  })

  it('renders result/success as completion', () => {
    const ev: StreamEvent = { type: 'result', subtype: 'success', result: 'STATUS: completed' }
    const r = renderEvent(ev, 'Phase 5', FIXED_TIME)
    expect(r!.body).toContain('✅')
    expect(r!.body).toContain('Phase 5')
  })

  it('renders result/error_max_turns as failure', () => {
    const ev: StreamEvent = { type: 'result', subtype: 'error_max_turns' }
    const r = renderEvent(ev, 'Phase 5', FIXED_TIME)
    expect(r!.body).toContain('❌')
  })

  it('returns null for filtered events', () => {
    expect(renderEvent({ type: 'content_block_delta' }, 'P1', FIXED_TIME)).toBeNull()
    expect(renderEvent({ type: 'system', subtype: 'init' }, 'P1', FIXED_TIME)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// formatLine
// ---------------------------------------------------------------------------

describe('formatLine', () => {
  it('joins phase tag + timestamp + body', () => {
    const out = formatLine({ phaseTag: '[Phase 2]', timestamp: '08:15:22', body: '🤖 hello' })
    expect(out).toBe('[Phase 2] 08:15:22 🤖 hello')
  })

  it('omits empty phase tag', () => {
    const out = formatLine({ phaseTag: '', timestamp: '08:15:22', body: '🤖 hi' })
    expect(out).toBe('08:15:22 🤖 hi')
  })
})

// ---------------------------------------------------------------------------
// renderJsonl — multi-line offline render
// ---------------------------------------------------------------------------

describe('renderJsonl', () => {
  it('skips noise + parse errors and renders only kept events', () => {
    const jsonl = [
      '{"type":"system","subtype":"init"}',
      '{"type":"content_block_delta","delta":{}}',
      'not-json-{}}',
      '{"type":"hook_started","hook":{"name":"PreToolUse"}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
      '{"type":"result","subtype":"success"}',
    ].join('\n')
    const lines = renderJsonl(jsonl, 'P1')
    expect(lines).toHaveLength(3) // hook + assistant + result
    expect(lines[0]).toContain('🔗 Hook')
    expect(lines[1]).toContain('🤖 hello')
    expect(lines[2]).toContain('✅')
  })

  it('returns empty for empty / invalid input', () => {
    expect(renderJsonl('', 'P1')).toEqual([])
    expect(renderJsonl(null as unknown as string, 'P1')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// parseStreamLine
// ---------------------------------------------------------------------------

describe('parseStreamLine', () => {
  it('parses well-formed ndjson', () => {
    expect(parseStreamLine('{"type":"x"}')).toEqual({ type: 'x' })
  })

  it('returns null for blanks / parse errors / non-objects', () => {
    expect(parseStreamLine('')).toBeNull()
    expect(parseStreamLine('   ')).toBeNull()
    expect(parseStreamLine('{bad json')).toBeNull()
    expect(parseStreamLine('"just a string"')).toBeNull()
    expect(parseStreamLine('42')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

describe('truncate', () => {
  it('returns input unchanged when within limit', () => {
    expect(truncate('hello', 80)).toBe('hello')
  })

  it('truncates with ellipsis at limit', () => {
    const r = truncate('A'.repeat(100), 10)
    expect(r.length).toBe(10)
    expect(r.endsWith('…')).toBe(true)
  })

  it('collapses internal whitespace', () => {
    expect(truncate('a  \n b\tc', 80)).toBe('a b c')
  })
})

// ---------------------------------------------------------------------------
// progressBar — Windows cp936 ASCII-7 safety (acceptance §6)
// ---------------------------------------------------------------------------

describe('progressBar', () => {
  it('uses only ASCII-7 chars (= > space)', () => {
    for (const p of [0, 25, 50, 75, 99, 100]) {
      const bar = progressBar(p, 20)
      expect(bar.length).toBe(20)
      // Only =, >, or space allowed — no unicode block chars (cp936 safe)
      expect(/^[=> ]+$/.test(bar)).toBe(true)
    }
  })

  it('renders 0% as all spaces', () => {
    expect(progressBar(0, 20)).toBe(' '.repeat(20))
  })

  it('renders 100% as all =', () => {
    expect(progressBar(100, 20)).toBe('='.repeat(20))
  })

  it('mid-progress contains exactly one >', () => {
    const bar = progressBar(50, 20)
    expect((bar.match(/>/g) || []).length).toBe(1)
  })

  it('clamps out-of-range / NaN inputs', () => {
    expect(progressBar(-10, 20)).toBe(' '.repeat(20))
    expect(progressBar(150, 20)).toBe('='.repeat(20))
    expect(progressBar(NaN, 20)).toBe(' '.repeat(20))
  })
})

// ---------------------------------------------------------------------------
// formatElapsed
// ---------------------------------------------------------------------------

describe('formatElapsed', () => {
  it('formats seconds-only', () => {
    expect(formatElapsed(5_000)).toBe('5s')
  })

  it('formats minutes + seconds', () => {
    expect(formatElapsed(252_000)).toBe('4m 12s')
  })

  it('handles 0 / negative', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(-1)).toBe('0s')
  })
})
