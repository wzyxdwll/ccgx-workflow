#!/usr/bin/env node
// =============================================================================
//  ccgx-call-plugin.mjs                                          1.0.5
// -----------------------------------------------------------------------------
//  Pure-Node helper for invoking codex/gemini plugin companions WITHOUT any
//  shell-escape risk. Replaces the 1.0.4 heredoc-via-Bash pattern.
//
//  Why this exists (1.0.5 design after 1.0.4 dogfood):
//    LLM-constructed Bash commands proved unreliable. Two failure modes hit
//    in 1.0.4:
//      1. LLM cargo-culted anti-example code from review.md docs
//      2. LLM in actual review session still wrote `ls $(...) | head -1`
//         glob-hack patterns despite placeholder system
//
//    Root cause: any design that asks the LLM to construct or substitute parts
//    of a shell command has X% failure rate. X varies but is never zero.
//
//    Fix: collapse the LLM surface to "choose vendor + pass prompt-file path".
//    All path resolution, flag construction, shell-quote-avoidance are done
//    internally by Node spawn with array args (no shell).
//
//  Usage (LLM workflow):
//    1. Write prompt body to a temp file (via Write tool):
//         /tmp/ccg-codex-1234.txt
//    2. Run helper via Bash:
//         node ~/.claude/.ccg/scripts/ccgx-call-plugin.mjs codex \
//              --prompt-file /tmp/ccg-codex-1234.txt
//    3. Parse the JSON output emitted to stdout
//
//  Output schema (always JSON, even on error):
//    {
//      "status": "ok" | "error",
//      "vendor": "codex" | "gemini",
//      "version": "<plugin version>",
//      "durationMs": <number>,
//      "exitCode": <number | null>,
//      "stdout": "<companion stdout>",
//      "stderr": "<companion stderr>",
//      "error": "<error message if status=error, else absent>"
//    }
//
//  CLI args:
//    <vendor>                Required. 'codex' or 'gemini'.
//    --prompt-file <path>    Required. Path to file containing prompt body.
//    --json                  Pass --json to companion (default: true).
//    --no-json               Disable --json (text output).
//    --timeout-ms <N>        Kill companion if total wall-time exceeds N ms (default: 7200000, 2h; pass 0 to disable).
//    --max-budget-usd <N>    Forwarded to companion (default: 50).
//
//  Cross-cutting:
//    - Pure stdlib (fs, child_process, path, os). No deps.
//    - Always emits valid JSON to stdout (so LLM can always JSON.parse).
//    - Plugin path resolution via SSoT (~/.claude/plugins/installed_plugins.json).
//    - spawn uses array args + windowsHide:true → zero shell escape surface.
// =============================================================================

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Vendor → marketplace keys (ordered preference list).
//
// CCG 2.0.0: gemini-ccgx (ccgx-maintained fork shipping P-1..P-21 + W1/W2/I1
// inline, no repatch needed) is preferred over google-gemini (upstream).
// Keep this list in sync with src/utils/plugin-bash-codegen.ts.
// ---------------------------------------------------------------------------

const VENDOR_KEYS = {
  codex: ['codex@openai-codex'],
  gemini: ['gemini@gemini-ccgx', 'gemini@google-gemini'],
}

// ---------------------------------------------------------------------------
// Vendor → preferred entry script (relative to <installPath>/scripts/).
//
// gemini: prefer `gemini-batch.mjs` (CCG-only, bypasses ACP broker entirely
// — direct gemini-cli batch mode via stdin + --output-format json). Falls
// back to the legacy `gemini-companion.mjs task` (ACP path) only if the
// batch entry isn't shipped.
//
// Why bypass ACP: gemini-cli 0.40+'s session/new RPC runs MCP setup + auth
// refresh + chat startup synchronously inside the agent. On Windows the
// gemini-plugin-cc ACP broker + named-pipe transport reliably hangs trivial
// trips for 5+ minutes even when the direct CLI returns in 10-30s. Batch
// mode side-steps the entire transport stack (no broker, no detached
// process, no orphan MCP children).
// ---------------------------------------------------------------------------

const VENDOR_ENTRY_SCRIPTS = {
  codex: ['codex-companion.mjs'],
  gemini: ['gemini-batch.mjs', 'gemini-companion.mjs'],
}

// ---------------------------------------------------------------------------
// Argument parsing — minimal, KISS, no external CLI lib.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    vendor: null,
    promptFile: null,
    json: true,
    // 2.1.1: wall-time bumped 600s → 7200s (2h). Real codex audits /
    // multi-file reviews / planning tasks routinely run 5-30 min; the old
    // 600s default was SIGTERM-ing healthy tasks mid-thought. 2h is a
    // generous safety ceiling — pass 0 to disable entirely.
    timeoutMs: 7200000,
    // 2.1.1: NEW idle timeout. Wall-time alone is the wrong signal — a
    // healthy long-running audit produces continuous stdout/stderr (tool
    // calls, progress lines). A truly hung companion produces nothing.
    // We track lastActivityAt on every stdout/stderr chunk and SIGTERM if
    // silent for idleTimeoutMs (default 600s = 10min). Pass 0 to disable.
    idleTimeoutMs: 600000,
    maxBudgetUsd: 50,
    // 1.0.5 regression fix: pre-1.0.5 callers always passed --write directly
    // to codex-companion. Default true preserves BC; --no-write opt-out for
    // read-only review flows.
    write: true,
    model: null,
    effort: null,
    cwd: null,
  }

  const positional = []
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`flag ${arg} requires a value`)
      return v
    }
    switch (arg) {
      case '--prompt-file':    opts.promptFile = next(); break
      case '--json':           opts.json = true; break
      case '--no-json':        opts.json = false; break
      case '--timeout-ms':     opts.timeoutMs = Number.parseInt(next(), 10); break
      case '--idle-timeout-ms': opts.idleTimeoutMs = Number.parseInt(next(), 10); break
      case '--max-budget-usd': opts.maxBudgetUsd = Number.parseFloat(next()); break
      case '--write':          opts.write = true; break
      case '--no-write':       opts.write = false; break
      case '--model':          opts.model = next(); break
      case '--effort':         opts.effort = next(); break
      case '--cwd':            opts.cwd = next(); break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
      default:
        if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`)
        positional.push(arg)
    }
  }

  if (positional.length === 0) throw new Error('vendor (codex|gemini) is required')
  if (positional.length > 1) throw new Error(`too many positional args: ${positional.join(' ')}`)
  opts.vendor = positional[0]

  if (!VENDOR_KEYS[opts.vendor]) {
    throw new Error(`unknown vendor: ${opts.vendor} (must be 'codex' or 'gemini')`)
  }
  if (!opts.promptFile) {
    throw new Error('--prompt-file is required (path to file containing prompt body)')
  }
  return opts
}

function printHelp() {
  process.stderr.write(`Usage: ccgx-call-plugin.mjs <vendor> --prompt-file <path> [flags]

Required:
  <vendor>                'codex' or 'gemini'
  --prompt-file <path>    File containing prompt body (any content, no escape needed)

Optional:
  --json                  Pass --json to companion (default: true)
  --no-json               Disable --json (text output)
  --timeout-ms <N>        Kill companion if total wall-time exceeds N ms (default: 7200000, 2h; pass 0 to disable)
  --idle-timeout-ms <N>   Kill companion if no stdout/stderr output for N ms (default: 600000, 10min; pass 0 to disable). Idle detection is the right signal for "hung" — healthy long-running audits keep producing tool-call progress.
  --max-budget-usd <N>    Per-call cost cap (default: 50)
  --write                 Enable workspace-write sandbox (default: true; codex needs this to spawn read commands too under default approval policy)
  --no-write              Force read-only sandbox (companion approval-policy will decline most commands)
  --model <name>          Override model (codex only; gemini ignores)
  --effort <level>        Reasoning effort: none|minimal|low|medium|high|xhigh (codex only)
  --cwd <path>            Override working directory for the companion call. codex sandbox is cwd-bound; set this when auditing a repo other than the caller's cwd.

Outputs JSON to stdout: {status, vendor, version, durationMs, exitCode, stdout, stderr, error?}
`)
}

// ---------------------------------------------------------------------------
// Plugin discovery (mirror of plugin-bash-codegen.ts:discoverCompanion)
// ---------------------------------------------------------------------------

function discoverCompanion(vendor, homeDir = homedir()) {
  const ssotPath = join(homeDir, '.claude', 'plugins', 'installed_plugins.json')
  if (!existsSync(ssotPath)) {
    return { error: `installed_plugins.json not found at ${ssotPath}` }
  }

  let raw
  try {
    raw = JSON.parse(readFileSync(ssotPath, 'utf-8'))
  }
  catch (e) {
    return { error: `installed_plugins.json parse failed: ${e.message}` }
  }

  // Try preferred keys in order — fork first, upstream fallback.
  const keys = VENDOR_KEYS[vendor]
  let instances = null
  let matchedKey = null
  for (const key of keys) {
    const candidate = raw?.plugins?.[key]
    if (Array.isArray(candidate) && candidate.length > 0) {
      instances = candidate
      matchedKey = key
      break
    }
  }
  if (!instances || instances.length === 0) {
    return { error: `${vendor} plugin not installed (tried ${keys.join(', ')})` }
  }

  const inst = instances[0]
  const installPath = inst?.installPath
  if (typeof installPath !== 'string' || !installPath) {
    return { error: `plugin ${matchedKey} has no installPath in installed_plugins.json` }
  }

  // Walk the preferred entry-script list. First existing file wins.
  // BC: vendors with only the legacy companion still resolve correctly.
  const entryCandidates = VENDOR_ENTRY_SCRIPTS[vendor] ?? [`${vendor}-companion.mjs`]
  let companionPath = null
  for (const name of entryCandidates) {
    const candidate = join(installPath, 'scripts', name)
    if (existsSync(candidate)) {
      companionPath = candidate
      break
    }
  }
  if (!companionPath) {
    return { error: `no entry script found for ${vendor} (tried: ${entryCandidates.join(', ')}) in ${join(installPath, 'scripts')}` }
  }

  return {
    companionPath,
    version: typeof inst?.version === 'string' ? inst.version : 'unknown',
  }
}

// ---------------------------------------------------------------------------
// Output emission — always JSON, never throws to stdout
// ---------------------------------------------------------------------------

function emitJson(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

function emitError(vendor, version, error, extra = {}) {
  emitJson({
    status: 'error',
    vendor,
    version,
    durationMs: 0,
    exitCode: null,
    stdout: '',
    stderr: '',
    error,
    ...extra,
  })
}

// ---------------------------------------------------------------------------
// Main: spawn companion with array args (no shell)
// ---------------------------------------------------------------------------

async function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  }
  catch (err) {
    emitError(null, null, `arg parse: ${err.message}`)
    process.exit(64) // EX_USAGE
  }

  // Read prompt body from file (no shell, no escape concerns)
  let promptBody
  try {
    promptBody = readFileSync(opts.promptFile, 'utf-8')
  }
  catch (err) {
    emitError(opts.vendor, null, `prompt file read failed: ${err.message}`)
    process.exit(66) // EX_NOINPUT
  }

  // 2.1.1: auto-delete the prompt file after a successful read iff the
  // PHYSICAL path sits inside the caller's `<cwd>/.context/tmp/` AND the
  // filename starts with `ccg-`. This is the workflow-managed throwaway-
  // prompt directory (see templates/commands/review.md — Step 1 writes
  // prompts here).
  //
  // CRITICAL — codex audit 2026-05-12 raised: lexical `resolve()` is
  // insufficient. If `.context` or `.context/tmp` is a symlink/junction
  // pointing outside the workspace, OR the caller passes a path whose
  // lexical form is `<cwd>/.context/tmp/ccg-x.txt` but its physical
  // target is `/etc/passwd` (or worse, `C:\Windows\System32\...`), the
  // lexical-only check would still authorize the unlink. realpathSync
  // canonicalizes ALL symlinks/junctions/`..` segments before the
  // whitelist compare — both for the candidate file AND the safeRoot.
  // Two ANDed gates: physical prefix + filename prefix.
  try {
    const resolvedFile = realpathSync(opts.promptFile)
    const safeRoot = realpathSync(resolve(process.cwd(), '.context', 'tmp')) + sep
    if (resolvedFile.startsWith(safeRoot) && basename(resolvedFile).startsWith('ccg-')) {
      unlinkSync(resolvedFile)
    }
  }
  catch {
    // Best-effort. ENOENT (.context/tmp absent, file already gone, etc.)
    // is the dominant non-error case here; we deliberately don't surface
    // it. Real failures (permission etc.) will leave a file behind that
    // .gitignore catches and the user's next run overwrites.
  }

  // Discover companion via SSoT (no glob, no head -1)
  const disc = discoverCompanion(opts.vendor)
  if (disc.error) {
    emitError(opts.vendor, null, disc.error)
    process.exit(69) // EX_UNAVAILABLE
  }

  // Build companion argv as ARRAY — no shell layer ever
  const companionArgs = [
    disc.companionPath,
    'task',
    '-p',
    promptBody,
  ]
  if (opts.json) companionArgs.push('--json')
  // codex-companion flag pass-through (1.0.5 regression fix). gemini-companion
  // ignores unknown flags safely; both vendors accept this surface.
  if (opts.write) companionArgs.push('--write')
  if (opts.model) companionArgs.push('--model', opts.model)
  if (opts.effort) companionArgs.push('--effort', opts.effort)
  // --cwd pass-through: codex sandbox is cwd-bound. For cross-repo audits
  // the caller must set this to the repo being audited (codex-companion
  // does not expose --add-dir; multi-workspace requires deeper changes).
  if (opts.cwd) companionArgs.push('--cwd', opts.cwd)

  const startedAt = Date.now()

  // spawn 'node' with array args. Node will look up its own executable;
  // companionPath is passed as a literal arg, no shell interpretation.
  const child = spawn(process.execPath, companionArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      // Forward budget cap if companion respects it (codex does)
      CODEX_MAX_BUDGET_USD: String(opts.maxBudgetUsd),
      GEMINI_MAX_BUDGET_USD: String(opts.maxBudgetUsd),
    },
  })

  let stdoutBuf = ''
  let stderrBuf = ''
  let lastActivityAt = Date.now()
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf-8')
    lastActivityAt = Date.now()
  })
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf-8')
    lastActivityAt = Date.now()
  })

  // 2.1.1: two-layer timeout. wall-time is the safety ceiling; idle is the
  // primary "stuck" detector — a healthy long task keeps producing tool-call
  // / progress chunks, a truly hung companion produces nothing. SIGTERM is
  // best-effort on Windows where the kernel doesn't propagate to the
  // grandchild tree; companion processes on this code path are expected to
  // do their own subtree cleanup (taskkill /T) when they receive SIGTERM.
  let timedOut = false
  let timeoutReason = null
  const killChild = (reason) => {
    timedOut = true
    timeoutReason = reason
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, 5000).unref?.()
  }
  const wallTimer = opts.timeoutMs > 0
    ? setTimeout(() => killChild(`wall-time ${opts.timeoutMs}ms`), opts.timeoutMs)
    : null
  // Check idle every 30s. A 30s sampling granularity adds at most 30s slop
  // to the configured idle threshold, which is negligible at 600s default.
  const idleChecker = opts.idleTimeoutMs > 0
    ? setInterval(() => {
        const silent = Date.now() - lastActivityAt
        if (silent >= opts.idleTimeoutMs) {
          killChild(`idle ${silent}ms exceeds ${opts.idleTimeoutMs}ms`)
        }
      }, 30000)
    : null
  if (idleChecker?.unref) idleChecker.unref()

  const exit = await new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    child.once('error', (err) => resolve({ code: 70, signal: null, errorMsg: err.message }))
  })
  if (wallTimer) clearTimeout(wallTimer)
  if (idleChecker) clearInterval(idleChecker)

  const durationMs = Date.now() - startedAt
  const status = (!timedOut && exit.code === 0) ? 'ok' : 'error'
  const result = {
    status,
    vendor: opts.vendor,
    version: disc.version,
    durationMs,
    exitCode: exit.code,
    stdout: stdoutBuf,
    stderr: stderrBuf,
  }
  if (timedOut) result.error = `companion killed: ${timeoutReason}`
  else if (exit.errorMsg) result.error = `spawn error: ${exit.errorMsg}`
  else if (exit.code !== 0) result.error = `companion exited with code ${exit.code}`

  emitJson(result)
  process.exit(status === 'ok' ? 0 : 1)
}

// ---------------------------------------------------------------------------
// Entry point — only run main() when invoked as a script (not on import).
// ---------------------------------------------------------------------------

function isMainModule() {
  if (!process.argv[1]) return false
  try {
    const here = fileURLToPath(import.meta.url)
    return here === process.argv[1]
  }
  catch {
    return false
  }
}

if (isMainModule()) {
  main(process.argv).catch((err) => {
    emitError(null, null, `fatal: ${err.stack || err.message}`)
    process.exit(70)
  })
}

// Test surface for unit tests
export const ccgxCallPluginExports = {
  parseArgs,
  discoverCompanion,
  VENDOR_KEYS,
}
