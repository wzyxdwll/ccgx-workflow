/**
 * v4.5 P7: Stream renderer — convert phase-runner `progress.jsonl` events to
 * single-line human-readable status updates for `/ccg:status --tail`.
 *
 * Input contract: ndjson lines from `claude -p --output-format stream-json
 * --verbose --include-partial-messages` written to
 * `.context/jobs/<job-id>/progress.jsonl` (Phase 1 D6).
 *
 * Filtering policy (per gemini U3 review §3):
 *   DROP   — system/init, content_block_delta, stream_event/message_*
 *   KEEP   — tool_use, hook_started, assistant (summary), rate_limit_event,
 *            result/success
 *
 * Render policy (ASCII-only emoji per acceptance §6 Windows cmd cp936 safety
 * — NOTE: emoji ARE Unicode but Windows Terminal / PowerShell handle them.
 * Actual Windows cmd.exe cp936 issue is with U+2588 box-drawing chars used
 * for progress bars; we use `=` `>` ` ` for those. Emoji glyphs degrade to
 * `?` boxes on legacy cmd but do not corrupt output).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed Claude CLI stream-json event (we only inspect a few fields). */
export interface StreamEvent {
  type?: string
  subtype?: string
  message?: {
    role?: string
    content?: Array<{
      type?: string
      text?: string
      name?: string
      input?: Record<string, unknown>
    }>
  }
  tool_use_id?: string
  tool?: { name?: string, input?: Record<string, unknown> }
  hook?: { name?: string }
  result?: string
  // catch-all
  [key: string]: unknown
}

export interface RenderedLine {
  /** Phase tag rendered like `[Phase N]`. Empty string when phase unknown. */
  phaseTag: string
  /** `HH:MM:SS` timestamp string (UTC). Caller may strip if not desired. */
  timestamp: string
  /** Glyph + body, e.g. `🛠️ Running tool: read_file (src/auth.ts)` */
  body: string
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

const DROPPED_TYPES = new Set([
  'content_block_delta',
  'stream_event',
])

const DROPPED_SUBTYPES = new Set([
  'init',
  'message_start',
  'message_delta',
  'message_stop',
])

/**
 * Whether a parsed event should be rendered. Returns false for noise types
 * (token-by-token deltas, init banners, lifecycle plumbing).
 */
export function shouldRenderEvent(ev: StreamEvent): boolean {
  if (!ev || typeof ev !== 'object') return false
  const t = ev.type
  if (!t) return false
  if (DROPPED_TYPES.has(t)) return false
  if (t === 'system') {
    // system/init dropped; other system events (e.g. rate_limit) kept
    if (typeof ev.subtype === 'string' && DROPPED_SUBTYPES.has(ev.subtype)) return false
    if (ev.subtype === 'init') return false
  }
  if (t === 'stream_event' || t === 'message_start' || t === 'message_delta' || t === 'message_stop') {
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Format a Date as `HH:MM:SS` in UTC. */
function fmtTime(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

/** Truncate to N chars + ellipsis if longer. */
export function truncate(s: string, n: number): string {
  if (typeof s !== 'string') return ''
  const trimmed = s.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= n) return trimmed
  return trimmed.slice(0, Math.max(0, n - 1)) + '…'
}

/**
 * Render a tool_use content block to a single line.
 * Picks the first arg key/value to summarize (e.g. `read_file (src/x.ts)`).
 */
function summarizeToolArgs(input: Record<string, unknown> | undefined): string {
  if (!input || typeof input !== 'object') return ''
  const keys = Object.keys(input)
  if (keys.length === 0) return ''
  // Prefer common path-like keys
  const preferred = ['file_path', 'path', 'pattern', 'command', 'query']
  for (const k of preferred) {
    if (k in input) {
      const v = input[k]
      if (typeof v === 'string') return truncate(v, 60)
    }
  }
  const v = input[keys[0]]
  if (typeof v === 'string') return truncate(v, 60)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

/**
 * Try to extract a tool_use block from an assistant event's content array.
 * Returns null if no tool_use present.
 */
function extractToolUse(ev: StreamEvent): { name: string, input: Record<string, unknown> } | null {
  const content = ev.message?.content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : 'unknown'
      const input = block.input && typeof block.input === 'object' ? block.input : {}
      return { name, input }
    }
  }
  return null
}

/**
 * Extract the first non-empty assistant text block. Used for short summaries.
 */
function extractAssistantText(ev: StreamEvent): string | null {
  const content = ev.message?.content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      const t = block.text.trim()
      if (t.length > 0) return t
    }
  }
  return null
}

/**
 * Render a single stream event to a one-line summary, or null if filtered.
 * Caller is responsible for prepending phase tag and overwriting previous
 * line (`\r` + clear-to-eol) for tail mode.
 */
export function renderEvent(
  ev: StreamEvent,
  phaseId?: string,
  now: Date = new Date(),
): RenderedLine | null {
  if (!shouldRenderEvent(ev)) return null

  const phaseTag = phaseId ? `[${phaseId}]` : ''
  const timestamp = fmtTime(now)

  // tool_use can appear in two shapes: top-level `tool` field, or as a
  // content block in an assistant message. Handle both.
  if (ev.tool && typeof ev.tool === 'object' && typeof ev.tool.name === 'string') {
    const name = ev.tool.name
    const args = summarizeToolArgs(ev.tool.input)
    const body = args ? `🛠️  Running tool: ${name} (${args})` : `🛠️  Running tool: ${name}`
    return { phaseTag, timestamp, body }
  }

  if (ev.type === 'assistant') {
    const tu = extractToolUse(ev)
    if (tu) {
      const args = summarizeToolArgs(tu.input)
      const body = args ? `🛠️  Running tool: ${tu.name} (${args})` : `🛠️  Running tool: ${tu.name}`
      return { phaseTag, timestamp, body }
    }
    const text = extractAssistantText(ev)
    if (text) {
      return { phaseTag, timestamp, body: `🤖 ${truncate(text, 80)}` }
    }
    return null
  }

  if (ev.type === 'hook_started') {
    const name = ev.hook?.name ?? 'unknown'
    return { phaseTag, timestamp, body: `🔗 Hook: ${name}` }
  }

  if (ev.type === 'rate_limit_event') {
    return { phaseTag, timestamp, body: `⚠️  Rate limit hit (retrying...)` }
  }

  if (ev.type === 'result') {
    const sub = ev.subtype
    if (sub === 'success') {
      const phaseLabel = phaseId ?? 'job'
      return { phaseTag, timestamp, body: `✅ Phase ${phaseLabel} completed` }
    }
    if (sub === 'error' || sub === 'error_max_turns' || sub === 'error_during_execution') {
      return { phaseTag, timestamp, body: `❌ Phase failed (${sub})` }
    }
    return null
  }

  return null
}

/**
 * Format a RenderedLine for terminal output. `[Phase] HH:MM:SS body`.
 * Phase tag is omitted if empty.
 */
export function formatLine(line: RenderedLine): string {
  const tag = line.phaseTag ? `${line.phaseTag} ` : ''
  return `${tag}${line.timestamp} ${line.body}`
}

// ---------------------------------------------------------------------------
// Multi-line helpers (for offline rendering of an entire progress.jsonl)
// ---------------------------------------------------------------------------

/** Parse one ndjson line; returns null on parse error. */
export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as StreamEvent
  }
  catch {
    return null
  }
}

/**
 * Render an entire progress.jsonl file (string of ndjson). Returns array of
 * formatted lines. Skips noise + parse errors silently.
 */
export function renderJsonl(jsonl: string, phaseId?: string): string[] {
  if (typeof jsonl !== 'string' || jsonl.length === 0) return []
  const out: string[] = []
  for (const raw of jsonl.split(/\r?\n/)) {
    const ev = parseStreamLine(raw)
    if (!ev) continue
    const rendered = renderEvent(ev, phaseId)
    if (rendered) out.push(formatLine(rendered))
  }
  return out
}

// ---------------------------------------------------------------------------
// ASCII progress bar (Dashboard mode)
// ---------------------------------------------------------------------------

/**
 * Render a mini ASCII progress bar of fixed width. Uses ASCII-7 chars only
 * (`=` `>` ` `) for cp936 safety on Windows cmd.exe.
 *
 * Examples:
 *   progressBar(0,   20) → "                    "
 *   progressBar(50,  20) → "==========>         "
 *   progressBar(100, 20) → "===================="
 */
export function progressBar(percent: number, width: number = 20): string {
  if (!Number.isFinite(percent)) percent = 0
  const p = Math.max(0, Math.min(100, percent))
  const w = Math.max(1, Math.floor(width))
  const filled = Math.round((p / 100) * w)
  if (p === 100) return '='.repeat(w)
  if (filled === 0) return ' '.repeat(w)
  // filled-1 `=` + 1 `>` + rest spaces, but only if there's room
  const eqs = '='.repeat(Math.max(0, filled - 1))
  const arrow = '>'
  const spaces = ' '.repeat(Math.max(0, w - filled))
  return eqs + arrow + spaces
}

/** Format an elapsed-ms duration as `Xm Ys` or `Ys`. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m === 0) return `${s}s`
  return `${m}m ${s}s`
}
