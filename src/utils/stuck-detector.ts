/**
 * v4.5 P7: Stuck detector — analyze phase-runner `progress.jsonl` for
 * symptoms of hangs / loops, returning warnings (NOT killing the process).
 *
 * Three detection rules (per Phase 7 acceptance §3):
 *   a. Loop:        same tool_use (name + args hash) ≥ 3 times in a row
 *   b. Slow tool:   tool_use without matching tool_result for > 30s
 *   c. Stalled:     no new event for > 5 minutes since last activity
 *
 * Output: WarningList consumed by `/ccg:status --tail` (renders as colored
 * banner) and Dashboard mode (per-phase ⚠ marker).
 */

import { createHash } from 'node:crypto'
import { parseStreamLine, type StreamEvent } from './stream-renderer'

// ---------------------------------------------------------------------------
// Tunables (acceptance values; exposed for test overrides)
// ---------------------------------------------------------------------------

export interface StuckDetectorOptions {
  /** Same-tool-call repetition threshold. Default 3. */
  loopThreshold?: number
  /** Tool execution-time warning threshold (ms). Default 30_000. */
  slowToolMs?: number
  /** Stream-stalled warning threshold (ms). Default 300_000 (5 min). */
  stalledMs?: number
  /** Reference time for `now` checks. Default Date.now(). */
  now?: number
}

export type WarningKind = 'loop' | 'slow-tool' | 'stalled'

export interface StuckWarning {
  kind: WarningKind
  message: string
  /** Detail for callers wanting to render extra context (tool name, etc.). */
  detail?: {
    toolName?: string
    repeatCount?: number
    elapsedMs?: number
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stable hash of tool args for loop detection. */
function hashArgs(input: unknown): string {
  if (input === undefined || input === null) return 'null'
  let json: string
  try {
    json = JSON.stringify(input)
  }
  catch {
    json = String(input)
  }
  return createHash('sha1').update(json).digest('hex').slice(0, 16)
}

interface ToolCall {
  name: string
  argsHash: string
  /** Time when tool_use was emitted; ms epoch. */
  startedAt: number
  /** Time when matching tool_result was observed; ms epoch. null if pending. */
  endedAt: number | null
  /** tool_use_id linking tool_use → tool_result. */
  id?: string
}

interface EventTimestamp {
  /** ms epoch of last *any* event (fallback to file mtime if not in event). */
  lastEventAt: number
}

/**
 * Try to extract a tool_use block (name + args + optional id) from an event.
 * Returns null if not a tool_use.
 */
function extractToolUse(ev: StreamEvent): { name: string, input: unknown, id?: string } | null {
  // Top-level shape (some clients): { type: 'tool_use', tool: { name, input } }
  if (ev.tool && typeof ev.tool === 'object' && typeof ev.tool.name === 'string') {
    return { name: ev.tool.name, input: ev.tool.input ?? {} }
  }
  // Assistant message shape: content[] containing { type: 'tool_use', name, input, id }
  const content = ev.message?.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'tool_use' && typeof block.name === 'string') {
        const id = (block as { id?: unknown }).id
        return {
          name: block.name,
          input: block.input ?? {},
          id: typeof id === 'string' ? id : undefined,
        }
      }
    }
  }
  return null
}

/** Extract a tool_result tool_use_id if event is a tool_result block. */
function extractToolResultId(ev: StreamEvent): string | null {
  if (typeof ev.tool_use_id === 'string') return ev.tool_use_id
  // user message containing tool_result content block
  const content = ev.message?.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as { type?: string, tool_use_id?: unknown }
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          return b.tool_use_id
        }
      }
    }
  }
  return null
}

/**
 * Pick a timestamp for an event. Falls back to the provided `defaultMs` when
 * the event itself does not carry one. Real Claude CLI events do not always
 * include a timestamp, so callers typically pass file mtime / now.
 */
function eventTime(ev: StreamEvent, defaultMs: number): number {
  // Common shapes: ev.timestamp (string ISO), ev.message.timestamp, ev.time
  const candidates: unknown[] = [
    (ev as { timestamp?: unknown }).timestamp,
    (ev as { time?: unknown }).time,
    ev.message && (ev.message as unknown as { timestamp?: unknown }).timestamp,
  ]
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c
    if (typeof c === 'string') {
      const t = Date.parse(c)
      if (!Number.isNaN(t)) return t
    }
  }
  return defaultMs
}

// ---------------------------------------------------------------------------
// Core detector
// ---------------------------------------------------------------------------

/**
 * Walk a progress.jsonl stream and collect stuck warnings. Pure function:
 * does not mutate any external state.
 *
 * @param jsonl  full file content (or partial; we tolerate trailing chunks)
 * @param options threshold overrides + reference `now` (for testing)
 */
export function detectStuck(
  jsonl: string,
  options: StuckDetectorOptions = {},
): StuckWarning[] {
  const loopThreshold = options.loopThreshold ?? 3
  const slowToolMs = options.slowToolMs ?? 30_000
  const stalledMs = options.stalledMs ?? 300_000
  const now = options.now ?? Date.now()

  const warnings: StuckWarning[] = []
  if (typeof jsonl !== 'string' || jsonl.length === 0) {
    return warnings
  }

  const events: StreamEvent[] = []
  for (const raw of jsonl.split(/\r?\n/)) {
    const ev = parseStreamLine(raw)
    if (ev) events.push(ev)
  }
  if (events.length === 0) return warnings

  // ---------------- Rule a: loop detection ----------------
  // Scan tool_use events in order; track current run of (name, argsHash).
  let runName = ''
  let runHash = ''
  let runCount = 0
  let runReported = false
  for (const ev of events) {
    const tu = extractToolUse(ev)
    if (!tu) continue
    const h = hashArgs(tu.input)
    if (tu.name === runName && h === runHash) {
      runCount += 1
      if (runCount >= loopThreshold && !runReported) {
        warnings.push({
          kind: 'loop',
          message: `⚠️  Possible loop: ${tu.name} called ${runCount}× with same args`,
          detail: { toolName: tu.name, repeatCount: runCount },
        })
        runReported = true
      }
    }
    else {
      runName = tu.name
      runHash = h
      runCount = 1
      runReported = false
    }
  }

  // ---------------- Rule b: slow tool ----------------
  // Match tool_use → tool_result by id; for tool_use without matching result
  // and elapsed > slowToolMs (vs `now`), emit a warning.
  const pending = new Map<string, ToolCall>()
  let fallbackId = 0
  let lastEventAt = 0
  for (const ev of events) {
    const ts = eventTime(ev, now)
    if (ts > lastEventAt) lastEventAt = ts

    const tu = extractToolUse(ev)
    if (tu) {
      const id = tu.id ?? `__noid_${fallbackId++}`
      pending.set(id, {
        name: tu.name,
        argsHash: hashArgs(tu.input),
        startedAt: ts,
        endedAt: null,
        id,
      })
      continue
    }

    const resultId = extractToolResultId(ev)
    if (resultId) {
      const call = pending.get(resultId)
      if (call) {
        call.endedAt = ts
        pending.delete(resultId)
      }
    }
  }

  for (const call of pending.values()) {
    const elapsed = now - call.startedAt
    if (elapsed > slowToolMs) {
      warnings.push({
        kind: 'slow-tool',
        message: `⚠️  Tool taking longer than usual (${Math.round(elapsed / 1000)}s) — ${call.name}`,
        detail: { toolName: call.name, elapsedMs: elapsed },
      })
    }
  }

  // ---------------- Rule c: stalled stream ----------------
  if (lastEventAt > 0) {
    const sinceLast = now - lastEventAt
    if (sinceLast > stalledMs) {
      warnings.push({
        kind: 'stalled',
        message: `🚨 Stream stalled — no events for ${Math.round(sinceLast / 1000)}s — possible hang`,
        detail: { elapsedMs: sinceLast },
      })
    }
  }

  return warnings
}

/**
 * Convenience: return `true` iff any warning is present. Useful for dashboard
 * row-level "⚠" marker.
 */
export function hasStuckWarning(jsonl: string, options: StuckDetectorOptions = {}): boolean {
  return detectStuck(jsonl, options).length > 0
}

// Re-export for tests
export { hashArgs as __hashArgs }
export type { EventTimestamp }
