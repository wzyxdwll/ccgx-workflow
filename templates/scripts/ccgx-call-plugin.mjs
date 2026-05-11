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
//    --timeout-ms <N>        Kill companion after N ms (default: 600000).
//    --max-budget-usd <N>    Forwarded to companion (default: 50).
//
//  Cross-cutting:
//    - Pure stdlib (fs, child_process, path, os). No deps.
//    - Always emits valid JSON to stdout (so LLM can always JSON.parse).
//    - Plugin path resolution via SSoT (~/.claude/plugins/installed_plugins.json).
//    - spawn uses array args + windowsHide:true → zero shell escape surface.
// =============================================================================

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
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
// Argument parsing — minimal, KISS, no external CLI lib.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    vendor: null,
    promptFile: null,
    json: true,
    timeoutMs: 600000,
    maxBudgetUsd: 50,
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
      case '--max-budget-usd': opts.maxBudgetUsd = Number.parseFloat(next()); break
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
  --timeout-ms <N>        Kill companion after N ms (default: 600000)
  --max-budget-usd <N>    Per-call cost cap (default: 50)

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

  const companionPath = join(installPath, 'scripts', `${vendor}-companion.mjs`)
  if (!existsSync(companionPath)) {
    return { error: `companion script missing: ${companionPath}` }
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
  child.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString('utf-8') })
  child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf-8') })

  // Timeout: kill child if exceeds opts.timeoutMs
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, 5000).unref?.()
  }, opts.timeoutMs)

  const exit = await new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    child.once('error', (err) => resolve({ code: 70, signal: null, errorMsg: err.message }))
  })
  clearTimeout(timer)

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
  if (timedOut) result.error = `timeout after ${opts.timeoutMs}ms`
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
