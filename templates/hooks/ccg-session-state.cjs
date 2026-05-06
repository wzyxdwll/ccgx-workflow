#!/usr/bin/env node
// ccg-hook: session-state
// SessionStart Hook — auto-inject CCG project memory into a fresh session.
//
// Problem this solves (CCG v4.0 dogfood Q6 + GSD gsd-session-state.sh parity):
//   After /clear or a brand-new session, the orchestrator has zero memory of
//   the project's roadmap state. Users had to manually paste a "resume" file
//   (see .ccg/SESSION-RESUME.md) to get going. This hook automates it: when a
//   session starts in a CCG project (cwd has .ccg/roadmap.md), it injects a
//   ≤200-token summary describing project name, active phase, and next action.
//
// Hook contract (Claude Code SessionStart event):
//   stdin  : JSON with at least { hookEventName, session_id, cwd? }
//            cwd may be absent — we fall back to process.cwd().
//   stdout : JSON
//              { hookSpecificOutput: { hookEventName: 'SessionStart',
//                                      additionalContext: '<string>' } }
//            Empty / missing additionalContext means "no injection". For non-CCG
//            projects we exit cleanly without writing anything (noop).
//
// Failure policy: never throw; never block a session start. Any parse error or
// missing file degrades to a smaller-but-still-useful summary, or to a noop.

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests via ccgSessionStateHookExports)
// ---------------------------------------------------------------------------

/**
 * Extract roadmap.md head metadata: project name, started, last updated.
 *
 * Roadmap convention (see .ccg/roadmap.md): bold-tagged key-value lines such as
 *   **Project**: ccg-workflow v4.0
 *   **Started**: 2026-05-03
 *   **Last Updated**: 2026-05-04
 * Lines may appear in any order within the first ~20 lines. Anything we cannot
 * locate yields undefined — callers must tolerate that.
 */
function parseRoadmapHead(text) {
  const head = text.split(/\r?\n/).slice(0, 30).join('\n')
  const grab = (label) => {
    const re = new RegExp(`\\*\\*${label}\\*\\*\\s*[:：]\\s*(.+)`, 'i')
    const m = head.match(re)
    return m ? m[1].trim() : undefined
  }
  return {
    project: grab('Project'),
    started: grab('Started'),
    lastUpdated: grab('Last Updated'),
  }
}

/**
 * Parse phase headers. Each phase is denoted by `## Phase N: Title (status)`,
 * where `N` may include a dot (e.g. 1.5) and `status` is one of completed /
 * in_progress / pending / blocked / skipped.
 *
 * Returns array preserving file order. The "active" phase used for context
 * injection is the first one whose status is `in_progress`; if none, the
 * first `pending` phase; if all completed, null.
 */
function parsePhases(text) {
  const re = /^##\s+Phase\s+([\d.]+)\s*:\s*(.+?)\s*(?:\[[^\]]+\])?\s*\(([^)]+)\)\s*$/gim
  const phases = []
  let match
  while ((match = re.exec(text)) !== null) {
    phases.push({
      n: match[1],
      title: match[2].trim(),
      status: match[3].trim().toLowerCase(),
    })
  }
  return phases
}

/**
 * Pick the phase whose state is most relevant for resume context.
 *   1. First in_progress phase (resume work mid-flight)
 *   2. Else first pending phase (next-up work)
 *   3. Else null (every phase completed)
 */
function pickActivePhase(phases) {
  return (
    phases.find(p => p.status === 'in_progress')
    || phases.find(p => p.status === 'pending')
    || null
  )
}

/**
 * Map a roadmap phase entry to its `.context/<dir>/SUMMARY.md` directory name.
 *
 * Convention used by /ccg:autonomous + phase-runner: `phase-NN-<slug>` where NN
 * is two-digit (zero-padded for integers). Phase 1.5 keeps its decimal. Slug is
 * the title lowercased with non-alphanumerics collapsed to dashes.
 *
 * We do NOT guarantee this dir exists — caller must existsSync() before reading.
 */
function phaseDirName(phase) {
  const n = phase.n
  const padded = /^\d+$/.test(n) ? n.padStart(2, '0') : n
  const slug = phase.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug ? `phase-${padded}-${slug}` : `phase-${padded}`
}

/**
 * Lift YAML frontmatter into a flat Record<string, string>. Only handles the
 * minimal subset that .context/<phase>/SUMMARY.md uses — scalar key/value pairs
 * and short inline lists. Anything fancier degrades to the raw string.
 *
 * We deliberately do NOT pull in src/utils/phase-context.ts here — this hook
 * runs as a standalone Node script under ~/.claude/hooks/ with no transpile
 * step, so it must be self-contained.
 */
function parseSummaryFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return null
  const out = {}
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const km = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
    if (!km) continue
    let value = km[2].trim()
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1)
    }
    out[km[1]] = value
  }
  return out
}

/**
 * Compose the actual additionalContext string (capped to keep main-thread
 * context budget honored). Stays under ~200 tokens by hard-truncating at
 * 800 chars after composition.
 *
 * Inputs:
 *   head   — { project, started, lastUpdated } (any may be undefined)
 *   active — phase object or null
 *   summary — parsed SUMMARY.md frontmatter or null
 *   counts — { total, completed }
 */
function composeMessage(head, active, summary, counts) {
  const lines = []
  lines.push('[CCG] Project memory restored from .ccg/roadmap.md.')

  const projectLine = []
  if (head.project) projectLine.push(`Project: ${head.project}`)
  if (counts.total > 0) {
    projectLine.push(`Phases: ${counts.completed}/${counts.total} completed`)
  }
  if (projectLine.length) lines.push(projectLine.join(' | '))

  if (!active) {
    if (counts.total > 0 && counts.completed === counts.total) {
      lines.push('Status: All phases completed.')
    }
    else if (counts.total === 0) {
      lines.push('Status: roadmap.md present but no phases parsed.')
    }
  }
  else {
    const tag = active.status === 'in_progress' ? 'Active' : 'Next'
    lines.push(`${tag} phase: ${active.n} ${active.title} (${active.status})`)
    if (summary) {
      const provides = summary.provides
      const nextAction = summary['next-action'] || summary.next_action || summary.nextAction
      if (provides) lines.push(`Provides: ${provides}`)
      if (nextAction) lines.push(`Next action: ${nextAction}`)
    }
  }

  lines.push('Read .ccg/roadmap.md for full state. Continue from the active phase or ask the user where to start.')

  let msg = lines.join('\n')
  if (msg.length > 800) msg = `${msg.slice(0, 797)}...`
  return msg
}

// ---------------------------------------------------------------------------
// v4.5 P1b — startup reconciler (inlined CJS twin of src/utils/process-tree.ts).
//
// The hook MUST stay self-contained (see top-of-file comment). We duplicate
// the minimal logic rather than `require('../../src/utils/process-tree')` —
// the hook is shipped to ~/.claude/hooks/ where TS source is unavailable.
//
// Behaviour matrix (mirrors process-tree.ts reconcileStaleJobs):
//   - .context/jobs/* missing                         → no-op (return empty)
//   - state.status terminal (done/failed/canceled)    → no-op
//   - cli_pid alive                                   → no-op
//   - cli_pid dead AND result.md present              → adopt-result
//   - cli_pid dead AND no result.md                   → mark-failed-stale
//   - status=running but no cli_pid (legacy)          → mark-failed-no-result
// ---------------------------------------------------------------------------

function isAlivePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  }
  catch (err) {
    if (err && err.code === 'EPERM') return true
    return false
  }
}

function atomicWriteFileSync(target, content) {
  const rand = crypto.randomBytes(6).toString('hex')
  const tmp = `${target}.tmp.${rand}`
  try {
    fs.writeFileSync(tmp, content, 'utf-8')
    fs.renameSync(tmp, target)
  }
  catch (err) {
    try { fs.unlinkSync(tmp) }
    catch { /* nothing to clean up */ }
    throw err
  }
}

function reconcileStaleJobs(cwd, options) {
  const opts = options || {}
  const isAlive = opts.isAliveFn || isAlivePid
  const now = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now()
  const reuseAgeMs = typeof opts.pidReuseAgeMs === 'number'
    ? opts.pidReuseAgeMs
    : 24 * 60 * 60 * 1000

  const root = path.join(cwd, '.context', 'jobs')
  const report = { scanned: 0, entries: [] }
  if (!fs.existsSync(root)) return report

  let dirs
  try { dirs = fs.readdirSync(root) }
  catch { return report }

  for (const id of dirs) {
    const sub = path.join(root, id)
    let isDir = false
    try { isDir = fs.statSync(sub).isDirectory() }
    catch { continue }
    if (!isDir) continue

    const statePath = path.join(sub, 'state.json')
    if (!fs.existsSync(statePath)) continue

    let state
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
    }
    catch {
      // Corrupt — skip silently; getJob() in src will surface to the user.
      continue
    }
    report.scanned += 1

    if (
      state.status === 'done'
      || state.status === 'failed'
      || state.status === 'canceled'
    ) {
      report.entries.push({ jobId: id, action: 'no-op', reason: 'terminal status' })
      continue
    }

    if (typeof state.cli_pid !== 'number') {
      const updated = Object.assign({}, state, {
        status: 'failed',
        summary: 'reconciler: legacy job without cli_pid; cannot verify liveness',
        last_update: new Date().toISOString(),
      })
      try { atomicWriteFileSync(statePath, JSON.stringify(updated, null, 2)) }
      catch { /* swallow — never block session start */ }
      report.entries.push({
        jobId: id,
        action: 'mark-failed-no-result',
        reason: 'no cli_pid recorded',
      })
      continue
    }

    const alive = isAlive(state.cli_pid)
    let pidProbablyReused = false
    if (alive && state.started_at) {
      const startedMs = Date.parse(state.started_at)
      if (Number.isFinite(startedMs) && (now - startedMs) > reuseAgeMs) {
        pidProbablyReused = true
      }
    }

    if (alive && !pidProbablyReused) {
      report.entries.push({ jobId: id, action: 'no-op', reason: 'cli_pid alive' })
      continue
    }

    const resultPath = path.join(sub, 'result.md')
    if (fs.existsSync(resultPath)) {
      const updated = Object.assign({}, state, {
        status: 'done',
        summary: 'reconciler: cli_pid not alive; adopted result.md after orphan recovery',
        last_update: new Date().toISOString(),
      })
      try { atomicWriteFileSync(statePath, JSON.stringify(updated, null, 2)) }
      catch { /* swallow */ }
      report.entries.push({
        jobId: id,
        action: 'adopt-result',
        reason: pidProbablyReused
          ? 'pid reuse suspected; result.md present'
          : 'cli_pid dead; result.md present',
      })
      continue
    }

    const updated = Object.assign({}, state, {
      status: 'failed',
      summary: pidProbablyReused
        ? 'reconciler: cli_pid suspected reused; no result.md found'
        : 'reconciler: cli_pid dead; no result.md found',
      last_update: new Date().toISOString(),
    })
    try { atomicWriteFileSync(statePath, JSON.stringify(updated, null, 2)) }
    catch { /* swallow */ }
    report.entries.push({
      jobId: id,
      action: 'mark-failed-stale',
      reason: pidProbablyReused
        ? 'pid reuse + no result'
        : 'cli_pid dead + no result',
    })
  }

  return report
}

/**
 * Compose a one-line reconciler summary for injection into additionalContext.
 * Returns null when nothing of interest happened (so the hook stays quiet for
 * fresh / clean sessions).
 */
function summarizeReconciliation(report) {
  if (!report || report.scanned === 0) return null
  const counts = { 'mark-failed-stale': 0, 'mark-failed-no-result': 0, 'adopt-result': 0 }
  for (const e of report.entries) {
    if (counts[e.action] !== undefined) counts[e.action] += 1
  }
  const interesting = counts['mark-failed-stale']
    + counts['mark-failed-no-result']
    + counts['adopt-result']
  if (interesting === 0) return null
  const parts = []
  if (counts['mark-failed-stale'])
    parts.push(`${counts['mark-failed-stale']} stale-failed`)
  if (counts['mark-failed-no-result'])
    parts.push(`${counts['mark-failed-no-result']} no-pid-failed`)
  if (counts['adopt-result'])
    parts.push(`${counts['adopt-result']} adopted-result`)
  return `Reconciled ${interesting}/${report.scanned} jobs: ${parts.join(', ')}.`
}

/**
 * Build the additionalContext string for a given workdir. Returns null if the
 * cwd is not a CCG project (no .ccg/roadmap.md). Never throws.
 */
function buildAdditionalContext(cwd) {
  const roadmapPath = path.join(cwd, '.ccg', 'roadmap.md')
  if (!fs.existsSync(roadmapPath)) return null

  let roadmapText
  try {
    roadmapText = fs.readFileSync(roadmapPath, 'utf8')
  }
  catch {
    return null
  }

  const head = parseRoadmapHead(roadmapText)
  const phases = parsePhases(roadmapText)
  const active = pickActivePhase(phases)
  const counts = {
    total: phases.length,
    completed: phases.filter(p => p.status === 'completed').length,
  }

  let summary = null
  if (active) {
    const dir = phaseDirName(active)
    const summaryPath = path.join(cwd, '.context', dir, 'SUMMARY.md')
    if (fs.existsSync(summaryPath)) {
      try {
        const text = fs.readFileSync(summaryPath, 'utf8')
        summary = parseSummaryFrontmatter(text)
      }
      catch {
        // Fall through with summary=null
      }
    }
  }

  let baseMsg = composeMessage(head, active, summary, counts)

  // v4.5 P1b: run startup reconciler over .context/jobs/* and append a one-line
  // summary if anything was reconciled. Reconciler never throws — it swallows
  // I/O errors so a flaky filesystem can't block session start.
  let reconcileLine = null
  try {
    const report = reconcileStaleJobs(cwd)
    reconcileLine = summarizeReconciliation(report)
  }
  catch {
    reconcileLine = null
  }
  if (reconcileLine) {
    baseMsg = `${baseMsg}\n${reconcileLine}`
    if (baseMsg.length > 800) baseMsg = `${baseMsg.slice(0, 797)}...`
  }
  return baseMsg
}

// ---------------------------------------------------------------------------
// Entry point — only runs when this file is invoked directly (not on import).
// ---------------------------------------------------------------------------

function emit(additionalContext) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  }
  process.stdout.write(JSON.stringify(out))
}

function main() {
  let input = ''
  // Timeout guard mirrors ccg-context-monitor: never hang on a stuck pipe.
  const timer = setTimeout(() => process.exit(0), 10000)

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => (input += chunk))
  process.stdin.on('end', () => {
    clearTimeout(timer)
    let cwd = process.cwd()
    try {
      if (input.trim()) {
        const data = JSON.parse(input)
        if (typeof data.cwd === 'string' && data.cwd) cwd = data.cwd
      }
    }
    catch {
      // Bad JSON — fall back to process.cwd(). We still want to inject context
      // for the most common case (running in the project root).
    }

    let message = null
    try {
      message = buildAdditionalContext(cwd)
    }
    catch {
      message = null
    }

    if (!message) {
      // Non-CCG project: emit nothing visible. Empty object keeps Claude Code
      // happy and signals "no injection" without erroring.
      process.stdout.write('{}')
      process.exit(0)
    }

    emit(message)
    process.exit(0)
  })

  process.stdin.on('error', () => process.exit(0))
}

// Detect "imported as a module" (Node test harness) vs. "executed as script".
// require.main === module is true only when invoked via `node ccg-session-state.js`.
if (require.main === module) {
  main()
}

// Test surface — kept on a single object so the production hook surface stays
// minimal. Consumed by sessionStateHook.test.ts.
module.exports = {
  parseRoadmapHead,
  parsePhases,
  pickActivePhase,
  phaseDirName,
  parseSummaryFrontmatter,
  composeMessage,
  buildAdditionalContext,
  // v4.5 P1b additions:
  isAlivePid,
  atomicWriteFileSync,
  reconcileStaleJobs,
  summarizeReconciliation,
}
