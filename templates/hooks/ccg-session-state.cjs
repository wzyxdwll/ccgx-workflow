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

  return composeMessage(head, active, summary, counts)
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
}
