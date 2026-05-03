#!/usr/bin/env node
// ccg-hook: commit-msg-review
// Heuristic git commit-msg hook — checks the draft commit message against the
// staged diff to catch the "spec drift" pattern observed in CCG v4.0 P14 / v4.1
// P18, where commit text described one thing but `git diff --staged` told a
// different story.
//
// Why heuristic instead of LLM-backed:
//   A pre-commit hook MUST be fast (<200ms typical). Spawning codex/gemini per
//   commit is unworkable. Instead we rely on a small set of cheap consistency
//   checks that catch the obvious mistakes (wrong filename mentioned, wrong
//   phase tag, missing operation type). False negatives are acceptable; false
//   positives must be rare and the failure message must point to the cause.
//
// Hook contract (git commit-msg hook):
//   argv[2] : path to file containing the draft commit message
//             (git invokes hook as: .git/hooks/commit-msg .git/COMMIT_EDITMSG)
//             If absent we read .git/COMMIT_EDITMSG relative to cwd.
//   stdin   : ignored (some integrations pipe the message; we accept it as an
//             optional fallback when no path is provided).
//   exit 0  : message looks consistent — commit proceeds
//   exit !0 : print a corrective hint to stderr and abort the commit
//
// This hook is OPT-IN. The CCG installer copies the file to ~/.claude/hooks/
// but does NOT register it under `git config core.hooksPath` or in
// .git/hooks/commit-msg. See templates/hooks/README-commit-msg-review.md for
// the activation steps.

'use strict'

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests via module.exports)
// ---------------------------------------------------------------------------

/**
 * Strip the body / scissor lines / comments that git inserts into
 * COMMIT_EDITMSG. We only keep meaningful authored text so heuristics do not
 * trip over template scaffolding (e.g. "# Please enter the commit message...").
 *
 * Returns { subject, body, full } where:
 *   - subject : first non-empty, non-comment line (used for type/phase/file)
 *   - body    : remaining authored lines joined back (kept for filename hits)
 *   - full    : subject + body, lower-cased once for case-insensitive matching
 */
function stripCommitTemplate(rawMessage) {
  const lines = rawMessage.split(/\r?\n/)
  const kept = []
  for (const line of lines) {
    // Stop at git's scissors line — anything below is diff context git appended.
    if (line.startsWith('# ------------------------ >8 ------------------------')) break
    // Skip git's instructional comments.
    if (line.startsWith('#')) continue
    kept.push(line)
  }

  // Subject = first non-blank kept line. Empty if user cleared the buffer.
  let subject = ''
  let bodyStartIdx = 0
  for (let i = 0; i < kept.length; i++) {
    if (kept[i].trim().length > 0) {
      subject = kept[i].trim()
      bodyStartIdx = i + 1
      break
    }
  }
  const body = kept.slice(bodyStartIdx).join('\n')
  const full = `${subject}\n${body}`
  return { subject, body, full, fullLower: full.toLowerCase() }
}

/**
 * Pull `path/to/file.ext` style tokens out of the message so we can compare
 * them to the staged file list. We deliberately require at least one path
 * separator OR a recognizable extension — bare words like "tests" should not
 * count, but `tests/foo.spec.ts` and `foo.ts` both should.
 *
 * Tradeoffs:
 *   - We tokenize on whitespace and punctuation that is unlikely to appear
 *     mid-path (commas, parens, backticks).
 *   - We strip a trailing period/comma that often follows a path in prose.
 *   - We KEEP `**` and `*` glob characters — they almost never show up in
 *     real commit text and removing them risks merging unrelated tokens.
 */
function extractFileMentions(message) {
  if (!message) return []
  // Split on characters that never legitimately live inside a path token.
  const tokens = message.split(/[\s`(),'"<>]+/)
  const out = []
  const seen = new Set()
  for (let raw of tokens) {
    if (!raw) continue
    // Trim trailing prose punctuation.
    raw = raw.replace(/[.,;:!?]+$/, '')
    if (!raw) continue

    const looksLikePath = raw.includes('/') || raw.includes('\\')
    const looksLikeFile = /\.[a-z0-9]{1,8}$/i.test(raw)
    if (!looksLikePath && !looksLikeFile) continue

    // Skip URL-ish tokens.
    if (/^https?:/i.test(raw)) continue

    // Normalize Windows backslashes for comparison.
    const norm = raw.replace(/\\/g, '/')
    if (!seen.has(norm)) {
      seen.add(norm)
      out.push(norm)
    }
  }
  return out
}

/**
 * Parse `git diff --cached --name-only` output. Returns array of normalized
 * paths (forward slashes) in declaration order. Empty / blank lines dropped.
 */
function parseStagedFiles(nameOnlyOutput) {
  if (!nameOnlyOutput) return []
  return nameOnlyOutput
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.replace(/\\/g, '/'))
}

/**
 * Detect the conventional-commit type prefix (feat|fix|chore|refactor|docs|
 * test|perf|style|build|ci|revert). Returns lower-case type or null.
 *
 * We accept both `type:` and `type(scope):` styles. The prefix is typically the
 * first 1–10 alphabetic characters of the subject up to the first colon.
 */
function extractCommitType(subject) {
  if (!subject) return null
  const m = subject.match(/^([a-z]+)(?:\([^)]*\))?\s*[:!]/i)
  if (!m) return null
  const t = m[1].toLowerCase()
  const known = new Set([
    'feat',
    'fix',
    'chore',
    'refactor',
    'docs',
    'test',
    'perf',
    'style',
    'build',
    'ci',
    'revert',
  ])
  return known.has(t) ? t : null
}

/**
 * Extract a CCG phase reference from the message. Recognized forms:
 *   v4.3-p27 / v4.3-P27 / p27 / phase-29 / phase-1.5 / phase 29
 * Returns the phase identifier digits (e.g. "27", "1.5") or null.
 *
 * We intentionally skip bare numerals (e.g. "fixed 27 things") to avoid
 * false positives. The `p` / `phase` qualifier is required.
 */
function extractPhaseTag(message) {
  if (!message) return null
  // v<digit>.<digit>-p<digits>  →  capture the trailing digits
  const versioned = message.match(/v\d+\.\d+(?:\.\d+)?-p(\d+(?:\.\d+)?)/i)
  if (versioned) return versioned[1]
  // phase-NN or phase NN  →  capture digits (allow decimal like 1.5)
  const phaseRe = message.match(/\bphase[-\s]+(\d+(?:\.\d+)?)\b/i)
  if (phaseRe) return phaseRe[1]
  // Standalone p27 / P29 — require word boundary on the left and a digit
  // on the right; reject if it's part of a longer word (e.g. "speed", "type").
  const standalone = message.match(/(?:^|[\s(:,/])p(\d+(?:\.\d+)?)\b/i)
  if (standalone) return standalone[1]
  return null
}

/**
 * Heuristically classify each staged path as belonging to a "feat / fix / docs
 * / test / chore / refactor" bucket. Returns the dominant bucket label or
 * null if undecidable. We use this to flag mismatches like a `docs(...)`
 * commit that actually touches `src/utils/foo.ts`.
 */
function classifyStagedFiles(stagedFiles) {
  if (!stagedFiles.length) return null
  const counts = { docs: 0, test: 0, ci: 0, chore: 0, code: 0 }
  for (const f of stagedFiles) {
    const lower = f.toLowerCase()
    if (lower.endsWith('.md') || lower.includes('/docs/') || lower === 'changelog.md' || lower === 'readme.md') {
      counts.docs++
    }
    else if (lower.includes('/__tests__/') || /\.(test|spec)\.[a-z]+$/.test(lower) || lower.startsWith('tests/')) {
      counts.test++
    }
    else if (lower.startsWith('.github/') || lower.includes('/ci/') || lower.endsWith('.yml') || lower.endsWith('.yaml')) {
      counts.ci++
    }
    else if (lower === 'package.json' || lower === 'pnpm-lock.yaml' || lower === '.gitignore' || lower === 'tsconfig.json') {
      counts.chore++
    }
    else {
      counts.code++
    }
  }
  // Pick the strongest signal. Code wins ties because most repos lean code-heavy.
  const order = ['code', 'test', 'docs', 'ci', 'chore']
  let best = null
  let bestN = 0
  for (const k of order) {
    if (counts[k] > bestN) {
      bestN = counts[k]
      best = k
    }
  }
  return { dominant: best, counts }
}

/**
 * Core consistency check. Pure (no I/O) for testability.
 *
 * Heuristics applied (each independently):
 *   #1 — every file path token in the message must appear (as suffix-match) in
 *        the staged file list. Catches "feat: rewrite package.json" when only
 *        src/utils/foo.ts is staged.
 *   #2 — if the message carries a phase tag (e.g. v4.3-p27), at least one
 *        staged path must reference that phase ("phase-27" / "p27" path).
 *   #3 — `docs(...)` commits whose staged files are dominantly code (and zero
 *        docs files) are flagged. Same for `test(...)` commits with zero test
 *        files.
 *
 * Returns:
 *   { ok: true }                    — all heuristics passed
 *   { ok: false, reason: '...' }    — first triggered heuristic wins
 *
 * Empty staged file list is treated as `ok: true` (git itself rejects empty
 * commits unless --allow-empty; we leave that policy to git).
 */
function checkConsistency(message, stagedFiles) {
  const parsed = stripCommitTemplate(message)
  if (!parsed.subject) {
    // Empty subject — let git's own enforcement handle this.
    return { ok: true }
  }
  if (!stagedFiles || stagedFiles.length === 0) {
    return { ok: true }
  }

  const stagedLower = stagedFiles.map(s => s.toLowerCase())

  // Heuristic #1 — file mentions must intersect the staged set.
  const mentionedFiles = extractFileMentions(parsed.full)
  for (const mention of mentionedFiles) {
    const m = mention.toLowerCase()
    // Allow bare basenames (e.g. "foo.ts") to match any staged path that ends
    // with that basename. Allow prefixed paths to match by suffix anywhere
    // in the staged path (handles relative vs absolute prose).
    const hit = stagedLower.some((s) => {
      if (s === m) return true
      if (s.endsWith(`/${m}`)) return true
      if (m.includes('/')) return s.endsWith(m) || s.includes(m)
      // Bare basename — match basename of staged path
      const base = s.split('/').pop() || s
      return base === m
    })
    if (!hit) {
      return {
        ok: false,
        reason: `commit message mentions \`${mention}\` but it is not in the staged files`,
      }
    }
  }

  // Heuristic #2 — phase tag must be reflected in staged paths.
  const phaseTag = extractPhaseTag(parsed.full)
  if (phaseTag) {
    const padded = /^\d+$/.test(phaseTag) ? phaseTag.padStart(2, '0') : phaseTag
    const hit = stagedLower.some((s) => {
      return (
        s.includes(`phase-${phaseTag}`)
        || s.includes(`phase-${padded}`)
        || s.includes(`/p${phaseTag}-`)
        || s.includes(`/p${phaseTag}/`)
        || s.includes(`-p${phaseTag}-`)
        || s.includes(`-p${phaseTag}.`)
      )
    })
    if (!hit) {
      // Only flag when the staged set contains paths that look phase-scoped
      // for some OTHER phase, OR when no phase path exists at all but the
      // message still claims one. The first case is the high-signal mistake
      // we are catching (wrong phase number in the prefix).
      const anyPhasePath = stagedLower.some(s => /phase-\d+|\/p\d+[-/.]|-p\d+[-.]/.test(s))
      if (anyPhasePath) {
        return {
          ok: false,
          reason: `commit message tags phase ${phaseTag} but staged paths point to a different phase`,
        }
      }
      // No phase-scoped paths at all → softer signal. Still report; the report
      // path / SUMMARY.md / context dirs almost always carry a phase number,
      // so a missing phase path with a tagged commit is suspicious.
      return {
        ok: false,
        reason: `commit message tags phase ${phaseTag} but no staged file references that phase`,
      }
    }
  }

  // Heuristic #3 — type prefix must align with the staged file mix.
  const commitType = extractCommitType(parsed.subject)
  const classification = classifyStagedFiles(stagedFiles)
  if (commitType && classification) {
    if (commitType === 'docs' && classification.counts.docs === 0 && classification.counts.code > 0) {
      return {
        ok: false,
        reason: 'commit type is `docs` but no .md / docs files are staged',
      }
    }
    if (commitType === 'test' && classification.counts.test === 0 && classification.counts.code > 0) {
      return {
        ok: false,
        reason: 'commit type is `test` but no test files are staged',
      }
    }
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// I/O glue (entry point, not exported as part of the testable surface)
// ---------------------------------------------------------------------------

/**
 * Read the draft commit message from the path git passes as argv[2], or
 * fall back to .git/COMMIT_EDITMSG / stdin. Returns the message string, or
 * null if no source produced text.
 */
function readDraftMessage(argv, cwd) {
  // 1) git's standard arg
  const argPath = argv[2]
  if (argPath && fs.existsSync(argPath)) {
    try {
      return fs.readFileSync(argPath, 'utf8')
    }
    catch {
      // fall through
    }
  }
  // 2) conventional fallback path
  const fallbackPath = path.join(cwd, '.git', 'COMMIT_EDITMSG')
  if (fs.existsSync(fallbackPath)) {
    try {
      return fs.readFileSync(fallbackPath, 'utf8')
    }
    catch {
      // fall through
    }
  }
  return null
}

/**
 * Run `git diff --cached --name-only`. Returns parsed array on success or
 * null on failure (we do not abort the commit on git invocation issues —
 * that would block the user from committing for an infrastructure reason
 * unrelated to message quality).
 */
function readStagedFiles(cwd) {
  try {
    const out = execSync('git diff --cached --name-only', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return parseStagedFiles(out)
  }
  catch {
    return null
  }
}

function main() {
  const cwd = process.cwd()
  const message = readDraftMessage(process.argv, cwd)
  if (!message) {
    // Nothing to check — let git proceed.
    process.exit(0)
  }

  const stagedFiles = readStagedFiles(cwd)
  if (stagedFiles === null) {
    // git unavailable or non-repo; never block on infra failure.
    process.exit(0)
  }

  const result = checkConsistency(message, stagedFiles)
  if (result.ok) {
    process.exit(0)
  }

  process.stderr.write(
    `[ccg-commit-msg-review] ${result.reason}\n`
    + `  Staged files (${stagedFiles.length}): ${stagedFiles.slice(0, 5).join(', ')}${stagedFiles.length > 5 ? ', ...' : ''}\n`
    + `  Fix the message or run \`git commit --no-verify\` to override.\n`,
  )
  process.exit(1)
}

if (require.main === module) {
  main()
}

// Test surface — stable contract for src/utils/__tests__/commitMsgReview.test.ts.
module.exports = {
  stripCommitTemplate,
  extractFileMentions,
  parseStagedFiles,
  extractCommitType,
  extractPhaseTag,
  classifyStagedFiles,
  checkConsistency,
}
