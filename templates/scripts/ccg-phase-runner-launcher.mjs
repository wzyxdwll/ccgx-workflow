// =============================================================================
//  ccg-phase-runner-launcher.mjs                                v4.5 P1b
// -----------------------------------------------------------------------------
//  Supervised launcher for `claude -p --agent ccg/phase-runner ...` subprocess.
//
//  Why this exists (codex C2 + C4):
//    The autonomous main thread cannot itself supervise an OS subprocess —
//    Claude is an LLM running tool calls, not a process manager. The naive
//    `Bash(claude -p ...)` shell call is fire-and-forget: if Claude crashes
//    after spawn, the subprocess can orphan; if the user hits Ctrl+C, nested
//    plugin processes survive; if the subprocess hangs, no one notices.
//
//    This launcher wraps the spawn so that:
//      1. Job state file is written atomically *before* spawn (parent_pid,
//         cli_pid, process_group_id, cwd, cmd, started_at).
//      2. The CLI subprocess is launched in its own session/process group
//         (POSIX `detached: true` → setsid()) so the whole tree can be
//         signalled as a unit.
//      3. On exit (success / error / signal), terminal state is written
//         atomically; the CCG status command can report the truth.
//      4. On the launcher receiving SIGINT/SIGTERM (Ctrl+C from the parent),
//         the cancel.flag is observed cooperatively, then the process tree
//         is killed after the grace period.
//
//  Usage (called by `Bash(node ~/.claude/.ccg/scripts/ccg-phase-runner-launcher.mjs ...)`):
//
//    node ccg-phase-runner-launcher.mjs \
//      --job-id <id> \
//      --workdir <path> \
//      --prompt-file <path> \
//      --tier <fast|triple|debate> \
//      [--max-budget-usd <N>] \
//      [--grace-ms <N>]              # SIGTERM -> SIGKILL grace, default 5000
//
//  Exit code: forwarded from the inner `claude -p` child. Launcher own errors
//  surface as exit 64 (EX_USAGE) or 70 (EX_SOFTWARE).
//
//  Cross-cutting:
//    - Pure stdlib (fs / child_process / crypto / path / os). No deps.
//    - State writes are temp + rename (atomicWriteFileSync, ported below).
//    - Stream-json output streams to .context/jobs/<id>/progress.jsonl as the
//      child runs; we don't transform it, we just plumb stdout/stderr through.
//
//  ⚠ Schema contract for state.json (consumed by reconciler in src/utils/
//     process-tree.ts → SupervisedJobState):
//
//       {
//         task_id, kind: "phase-runner", status,
//         started_at, last_update,
//         parent_pid, cli_pid, process_group_id, cwd, cmd
//       }
// =============================================================================

import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Internal helpers (kept verbatim local to keep launcher dependency-free)
// ---------------------------------------------------------------------------

function atomicWriteFileSync(target, content) {
  const rand = randomBytes(6).toString('hex')
  const tmp = `${target}.tmp.${rand}`
  try {
    writeFileSync(tmp, content, 'utf-8')
    renameSync(tmp, target)
  }
  catch (err) {
    try { unlinkSync(tmp) }
    catch { /* nothing */ }
    throw err
  }
}

function isWindows() {
  return process.platform === 'win32'
}

function nowIso() {
  return new Date().toISOString()
}

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}

// ---------------------------------------------------------------------------
// Argument parsing — minimal, KISS, no external CLI lib.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    jobId: null,
    workdir: null,
    promptFile: null,
    tier: 'triple',
    maxBudgetUsd: null,
    graceMs: 5000,
  }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) {
        throw new Error(`flag ${arg} requires a value`)
      }
      return v
    }
    switch (arg) {
      case '--job-id':       opts.jobId = next(); break
      case '--workdir':      opts.workdir = next(); break
      case '--prompt-file':  opts.promptFile = next(); break
      case '--tier':         opts.tier = next(); break
      case '--max-budget-usd': opts.maxBudgetUsd = Number.parseFloat(next()); break
      case '--grace-ms':     opts.graceMs = Number.parseInt(next(), 10); break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
      default:
        throw new Error(`unknown flag: ${arg}`)
    }
  }
  if (!opts.jobId) throw new Error('--job-id is required')
  if (!opts.workdir) throw new Error('--workdir is required')
  if (!opts.promptFile) throw new Error('--prompt-file is required')
  if (!['fast', 'triple', 'debate'].includes(opts.tier)) {
    throw new Error(`invalid --tier: ${opts.tier}`)
  }
  return opts
}

function printHelp() {
  process.stderr.write(`Usage: ccg-phase-runner-launcher.mjs [flags]

Required:
  --job-id <id>          Job identifier (becomes .context/jobs/<id>/)
  --workdir <path>       Phase workdir; subprocess cwd
  --prompt-file <path>   Prompt body file (relative to workdir or absolute)

Optional:
  --tier <fast|triple|debate>   Quality tier; maps to --max-budget-usd
                                (fast=1, triple=2, debate=5). Default: triple.
  --max-budget-usd <N>          Override per-call budget cap.
  --grace-ms <N>                SIGTERM->SIGKILL grace (default 5000).

Exits with the inner claude exit code. Own errors: 64 (usage), 70 (software).
`)
}

// ---------------------------------------------------------------------------
// State helpers (tightly mirror src/utils/jobs.ts contract)
// ---------------------------------------------------------------------------

function jobDir(workdir, jobId) {
  return join(workdir, '.context', 'jobs', jobId)
}

function statePath(workdir, jobId) {
  return join(jobDir(workdir, jobId), 'state.json')
}

function progressPath(workdir, jobId) {
  return join(jobDir(workdir, jobId), 'progress.jsonl')
}

function cancelFlagPath(workdir, jobId) {
  return join(jobDir(workdir, jobId), 'cancel.flag')
}

function writeState(workdir, jobId, state) {
  ensureDir(jobDir(workdir, jobId))
  const updated = { ...state, last_update: nowIso() }
  atomicWriteFileSync(statePath(workdir, jobId), JSON.stringify(updated, null, 2))
  return updated
}

// ---------------------------------------------------------------------------
// Build the `claude -p` argv. Mirrors `buildPhaseRunnerBashCommand` in
// src/utils/quality-router.ts (single source of truth for what flags live in
// production phase-runner spawn).
// ---------------------------------------------------------------------------

const TIER_BUDGET = { fast: 1.0, triple: 2.0, debate: 5.0 }

function buildClaudeArgs({ promptFile, workdir, tier, maxBudgetUsd }) {
  const budget = maxBudgetUsd ?? TIER_BUDGET[tier]
  const promptBody = readFileSync(promptFile, 'utf-8')
  return [
    '-p', promptBody,
    '--agent', 'ccg/phase-runner',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--max-budget-usd', String(budget),
    '--dangerously-skip-permissions',
    '--add-dir', workdir,
  ]
}

// ---------------------------------------------------------------------------
// Main launcher
// ---------------------------------------------------------------------------

async function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  }
  catch (err) {
    process.stderr.write(`launcher: ${err.message}\n`)
    printHelp()
    return 64 // EX_USAGE
  }

  const { jobId, workdir, graceMs } = opts
  ensureDir(jobDir(workdir, jobId))

  let claudeArgs
  try {
    claudeArgs = buildClaudeArgs(opts)
  }
  catch (err) {
    process.stderr.write(`launcher: cannot build claude args: ${err.message}\n`)
    writeState(workdir, jobId, {
      task_id: jobId,
      kind: 'phase-runner',
      status: 'failed',
      started_at: nowIso(),
      last_update: nowIso(),
      summary: `launcher build args failed: ${err.message}`,
      parent_pid: process.pid,
      cwd: workdir,
    })
    return 70 // EX_SOFTWARE
  }

  // Mint a broker tx_id (v4.5 P1d, codex C3). One V4 UUID per launcher
  // invocation; the CLI subprocess + any nested plugin Agents spawned inside
  // it inherit the same tx_id via env, so broker.log readers can correlate
  // every event back to this one logical phase-runner transaction.
  // crypto.randomUUID is the only acceptable source — Math.random / Date.now /
  // PID all leak entropy and are reused across processes.
  const txId = randomUUID()
  const brokerLogPath = join(workdir, '.context', 'broker.log')

  // Initial state — written *before* spawn so a crash between here and spawn
  // leaves a recoverable artifact for the reconciler.
  const initial = writeState(workdir, jobId, {
    task_id: jobId,
    kind: 'phase-runner',
    status: 'running',
    started_at: nowIso(),
    last_update: nowIso(),
    parent_pid: process.pid,
    cwd: workdir,
    cmd: `claude ${claudeArgs.slice(0, 6).join(' ')} ... [redacted prompt]`,
    broker_tx_id: txId,
  })

  // Spawn the child. `detached: true` on POSIX calls setsid() so the child
  // gets its own session/group → we can signal the whole tree later via -pgid.
  // On Windows, `detached: true` calls CreateProcess with DETACHED_PROCESS;
  // we still rely on `taskkill /T /F` for tree termination (codeagent-wrapper
  // precedent — see executor.go:1421).
  //
  // env inheritance: we extend process.env (parent of the launcher) with the
  // broker-correlation triplet so phase-runner subagent code + nested plugin
  // spawns can emit broker events under the same tx_id.
  const child = spawn('claude', claudeArgs, {
    cwd: workdir,
    detached: !isWindows(),
    windowsHide: true,
    // Pipe stdout to progress file; let stderr surface to the launcher's
    // stderr so users see auth / quota errors without grep-ing files.
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      ...process.env,
      CCG_BROKER_TX_ID: txId,
      CCG_BROKER_LOG_PATH: brokerLogPath,
      CCG_OUTER_CLI_PID: String(process.pid),
      CCG_JOB_ID: jobId,
      CCG_PHASE_RUNNER_TIER: opts.tier,
    },
  })

  // Persist cli_pid + process_group_id ASAP — race window before spawn returns
  // pid is closed by the time `child.pid` is set (synchronously in Node).
  const pgid = !isWindows() ? child.pid : undefined
  writeState(workdir, jobId, {
    ...initial,
    cli_pid: child.pid,
    process_group_id: pgid,
  })

  // Stream stdout to progress.jsonl. We append to keep crash-resume semantics
  // (don't truncate prior bytes if the launcher itself was restarted).
  const progressFd = openAppendStream(progressPath(workdir, jobId))
  child.stdout.on('data', (chunk) => {
    progressFd.write(chunk)
    // Mirror to the launcher's stdout for the parent Bash poller.
    process.stdout.write(chunk)
  })

  // Cooperative cancel + signal-driven kill-tree.
  let cancelInjected = false
  const tickCancelPoll = setInterval(() => {
    if (existsSync(cancelFlagPath(workdir, jobId)) && !cancelInjected) {
      cancelInjected = true
      // Step 1 cooperative: many subagents poll cancel.flag themselves.
      // Step 2 kill-tree: we still want to enforce after the grace period.
      scheduleKillTree(child, graceMs)
    }
  }, 1000)

  const onSignal = (sig) => {
    process.stderr.write(`launcher: received ${sig}; writing cancel.flag + grace ${graceMs}ms\n`)
    try {
      atomicWriteFileSync(
        cancelFlagPath(workdir, jobId),
        `cancel-requested-at: ${nowIso()}\nrequested-by: launcher signal ${sig}\n`,
      )
    }
    catch (err) {
      process.stderr.write(`launcher: cancel.flag write failed: ${err.message}\n`)
    }
    scheduleKillTree(child, graceMs)
  }
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))

  // Await child exit and write terminal state.
  const exit = await new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal })
    })
    child.once('error', (err) => {
      process.stderr.write(`launcher: spawn error: ${err.message}\n`)
      resolve({ code: 70, signal: null })
    })
  })

  clearInterval(tickCancelPoll)
  progressFd.end()

  const terminalStatus
    = exit.code === 0
      ? 'done'
      : cancelInjected
        ? 'canceled'
        : 'failed'

  writeState(workdir, jobId, {
    ...initial,
    cli_pid: child.pid,
    process_group_id: pgid,
    status: terminalStatus,
    summary: `exit code ${exit.code}${exit.signal ? ` (signal ${exit.signal})` : ''}`,
  })

  return typeof exit.code === 'number' ? exit.code : 70
}

// ---------------------------------------------------------------------------
// kill-tree implementation (POSIX -pgid + Windows taskkill /T /F).
// Inline rather than imported because this script is shipped as a flat .mjs
// to ~/.claude/.ccg/scripts/ — no transpile pipeline.
// ---------------------------------------------------------------------------

function scheduleKillTree(child, graceMs) {
  if (!child || !child.pid) return
  const pid = child.pid

  // Phase 1: gentle SIGTERM (POSIX) or taskkill /T (Windows, no /F).
  try {
    if (isWindows()) {
      spawn('taskkill', ['/T', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
      })
    }
    else {
      // detached children get their own pgid == pid, so kill(-pid) hits the group.
      try { process.kill(-pid, 'SIGTERM') }
      catch { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
    }
  }
  catch {
    // Don't let signal failure prevent the forced phase.
  }

  // Phase 2 timer: if the child hasn't exited within graceMs, force kill.
  setTimeout(() => {
    if (child.exitCode !== null) return
    try {
      if (isWindows()) {
        spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
          stdio: 'ignore',
          windowsHide: true,
        })
      }
      else {
        try { process.kill(-pid, 'SIGKILL') }
        catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
      }
    }
    catch {
      // Best effort — exhausted options.
    }
  }, graceMs).unref?.()
}

// ---------------------------------------------------------------------------
// Append-mode write stream wrapper (no fs.WriteStream import for clarity)
// ---------------------------------------------------------------------------

function openAppendStream(path) {
  return createWriteStream(path, { flags: 'a' })
}

// ---------------------------------------------------------------------------
// Entry point — only run main() when invoked as a script (not when imported
// for unit tests). Detection via import.meta.url vs the resolved argv[1].
// ---------------------------------------------------------------------------

function isMainModule() {
  if (!process.argv[1]) return false
  try {
    const here = fileURLToPath(import.meta.url)
    return realpathSync(here) === realpathSync(process.argv[1])
  }
  catch {
    return false
  }
}

if (isMainModule()) {
  main(process.argv)
    .then((code) => {
      process.exit(code)
    })
    .catch((err) => {
      process.stderr.write(`launcher: fatal: ${err.stack || err.message}\n`)
      process.exit(70)
    })
}

// Test surface — exposed for unit-test consumption via dynamic import().
// Only the pure helpers; main() is integration-tested separately.
export const ccgPhaseRunnerLauncherExports = {
  parseArgs,
  buildClaudeArgs,
  TIER_BUDGET,
  atomicWriteFileSync,
}
