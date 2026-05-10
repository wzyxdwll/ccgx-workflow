/**
 * ccgx kill-orphans — Detect and clean orphan child processes that survived
 * Claude Code session exit on Windows (root cause: Claude Code does not use
 * Win32 JobObject + KILL_ON_JOB_CLOSE for MCP/plugin children, so when the
 * main session dies, children orphan; same root cause underlying the
 * "[Bug] Windows: MCP child processes orphan on session exit" issue).
 *
 * Detection:
 *   - All `node.exe` processes (Windows) / `node` processes (POSIX)
 *   - Filter by cmdline pattern → categorize:
 *       'mcp-server'  : playwright | context7 | contextweaver | fast-context | ace-tool
 *       'codex-cli'   : openai-codex / codex-cli / codex-companion / codex.js
 *       'gemini-cli'  : @google/gemini-cli / gemini-companion
 *       'phase-runner': ccg-phase-runner-launcher
 *       'dev-server'  : pnpm/npm/yarn run dev | quasar | vite | webpack | next
 *
 * dev-server processes are NEVER killed (they're real user dev servers,
 * not orphans).
 *
 * Modes:
 *   --dry-run (default)  Show targets, don't kill
 *   --kill               Actually terminate orphans (with wmic fallback for
 *                        stuck-syscall processes that refuse Stop-Process)
 *   --min-age-hours <N>  Only target processes older than N hours (default: 1)
 *
 * Cross-platform: Windows uses Get-CimInstance / Stop-Process / wmic;
 * POSIX uses ps + kill.
 */

import { execSync } from 'node:child_process'
import ansis from 'ansis'
import { isWindows } from '../utils/platform'

interface NodeProcInfo {
  pid: number
  ageHours: number
  cpuSeconds: number
  cmdLine: string
  category: 'mcp-server' | 'codex-cli' | 'gemini-cli' | 'phase-runner' | 'dev-server' | 'other'
}

export interface KillOrphansOptions {
  dryRun?: boolean
  minAgeHours?: number
  stuckOnly?: boolean
}

// "Stuck" detection is intentionally narrow: it ONLY catches broker daemon
// processes (acp-broker / app-server-broker) hung in an IPC syscall. We
// deliberately exclude:
//   - companion processes (codex-companion / gemini-companion) — they
//     legitimately spend most wall-time blocked on remote LLM API responses,
//     so low-CPU + high-wall is normal, not stuck.
//   - MCP servers (context7 / playwright / ace-tool) — same reason, they
//     idle waiting for MCP requests; --min-age-hours covers truly orphaned ones.
//
// Empirical signature from 1.0.x dogfood: stuck broker = 5+ minutes wall,
// < 1% CPU/wall ratio, 0 active children.
const STUCK_MIN_AGE_SECONDS = 300 // 5 min
const STUCK_CPU_RATIO_THRESHOLD = 0.01 // CPU < 1% of wall time

export function isBrokerProcess(p: NodeProcInfo): boolean {
  return /acp-broker|app-server-broker|broker-lifecycle/.test(p.cmdLine)
}

export function isStuck(p: NodeProcInfo): boolean {
  if (!isBrokerProcess(p)) return false
  const wallSeconds = p.ageHours * 3600
  if (wallSeconds < STUCK_MIN_AGE_SECONDS) return false
  return p.cpuSeconds / wallSeconds < STUCK_CPU_RATIO_THRESHOLD
}

function categorize(cmdLine: string): NodeProcInfo['category'] {
  const cmd = cmdLine.toLowerCase()
  if (/quasar|vite|webpack|next\b|nuxt|astro|svelte-kit|pnpm.*run.*dev|npm.*run.*dev|yarn.*run.*dev|yarn dev|pnpm dev|npm run dev/.test(cmd)) {
    return 'dev-server'
  }
  if (/ccg-phase-runner-launcher|ccgx-call-plugin/.test(cmd)) return 'phase-runner'
  if (/codex-companion|codex-cli|@openai\/codex|openai-codex.*codex/.test(cmd)) return 'codex-cli'
  if (/gemini-companion|@google\/gemini-cli|google-gemini.*gemini/.test(cmd)) return 'gemini-cli'
  if (/playwright|context7|contextweaver|fast-context|ace-tool/.test(cmd)) return 'mcp-server'
  return 'other'
}

function listNodeProcessesWindows(): NodeProcInfo[] {
  // PowerShell multi-statement script. Use -EncodedCommand (Base64 UTF-16LE)
  // to avoid cmd.exe quote/`$` interpretation and the fragile `\n\s+` → space
  // replace that broke statement separation pre-1.0.9.
  // $ProgressPreference suppresses the CLIXML progress stream that PowerShell
  // emits to stderr on first cmdlet/module load.
  // KernelModeTime + UserModeTime are in 100-nanosecond units; divide by 1e7
  // to get seconds. Used by --stuck detection to find IPC-hung processes
  // (broker daemons that show wall age > 5min but CPU ≈ 0).
  const ps = `$ProgressPreference = 'SilentlyContinue'
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
    $cd = $_.CreationDate
    $h = if ($cd) { ((Get-Date) - $cd).TotalHours } else { 0 }
    $cmd = if ($_.CommandLine) { $_.CommandLine } else { '' }
    $kt = if ($_.KernelModeTime) { $_.KernelModeTime } else { 0 }
    $ut = if ($_.UserModeTime) { $_.UserModeTime } else { 0 }
    $cpuS = ($kt + $ut) / 10000000.0
    "$($_.ProcessId)|$h|$cpuS|$cmd"
  }`
  let out: string
  try {
    const encoded = Buffer.from(ps, 'utf16le').toString('base64')
    out = execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  }
  catch {
    return []
  }

  const procs: NodeProcInfo[] = []
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const sep1 = trimmed.indexOf('|')
    const sep2 = trimmed.indexOf('|', sep1 + 1)
    const sep3 = trimmed.indexOf('|', sep2 + 1)
    if (sep1 < 0 || sep2 < 0 || sep3 < 0) continue
    const pid = Number.parseInt(trimmed.slice(0, sep1), 10)
    const ageHours = Number.parseFloat(trimmed.slice(sep1 + 1, sep2))
    const cpuSeconds = Number.parseFloat(trimmed.slice(sep2 + 1, sep3))
    const cmdLine = trimmed.slice(sep3 + 1)
    if (Number.isNaN(pid)) continue
    procs.push({
      pid,
      ageHours: Number.isFinite(ageHours) ? ageHours : 0,
      cpuSeconds: Number.isFinite(cpuSeconds) ? cpuSeconds : 0,
      cmdLine,
      category: categorize(cmdLine),
    })
  }
  return procs
}

function parseHmsToSeconds(spec: string): number {
  // ps `time` column format: [DD-]HH:MM:SS or MM:SS
  const parts = spec.split(/[-:]/).map(s => Number.parseInt(s, 10))
  if (parts.length === 4) return parts[0] * 86400 + parts[1] * 3600 + parts[2] * 60 + parts[3]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return 0
}

function listNodeProcessesPosix(): NodeProcInfo[] {
  let out: string
  try {
    out = execSync('ps -eo pid,etime,time,command', { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 })
  }
  catch {
    return []
  }
  const procs: NodeProcInfo[] = []
  for (const line of out.split('\n').slice(1)) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/)
    if (!m) continue
    const cmdLine = m[4]
    if (!/(^|\/)node(\s|$)/.test(cmdLine)) continue
    const pid = Number.parseInt(m[1], 10)
    const etime = m[2]
    const cpuTime = m[3]
    const parts = etime.split(/[-:]/).map(s => Number.parseInt(s, 10))
    let ageHours = 0
    if (parts.length === 4) ageHours = parts[0] * 24 + parts[1] + parts[2] / 60
    else if (parts.length === 3) ageHours = parts[0] + parts[1] / 60
    else if (parts.length === 2) ageHours = parts[0] / 60
    const cpuSeconds = parseHmsToSeconds(cpuTime)
    procs.push({
      pid,
      ageHours,
      cpuSeconds,
      cmdLine,
      category: categorize(cmdLine),
    })
  }
  return procs
}

export function listNodeProcesses(): NodeProcInfo[] {
  return isWindows() ? listNodeProcessesWindows() : listNodeProcessesPosix()
}

function killProcessWindows(pid: number): { ok: boolean, method: string, error?: string } {
  // 1. taskkill /F /T — cascades to child processes. Critical for broker
  //    daemons (acp-broker / app-server-broker) that spawned `gemini --acp`
  //    or codex CLI children: Stop-Process -Force does NOT cascade, so the
  //    children would orphan again after killing only the parent.
  try {
    execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'pipe' })
    return { ok: true, method: 'taskkill /F /T' }
  }
  catch { /* fall through */ }
  // 2. Stop-Process -Force (single-process fallback)
  try {
    execSync(`powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force -ErrorAction Stop"`, { stdio: 'pipe' })
    return { ok: true, method: 'Stop-Process' }
  }
  catch { /* fall through */ }
  // 3. wmic process delete (different kernel API path; succeeds when above
  //    fail on processes stuck in IPC syscall — see CCG 1.0.4 dogfood)
  try {
    execSync(`wmic process where "ProcessId=${pid}" delete`, { stdio: 'pipe' })
    return { ok: true, method: 'wmic delete' }
  }
  catch (e) {
    return { ok: false, method: 'all-failed', error: e instanceof Error ? e.message : String(e) }
  }
}

function killProcessPosix(pid: number): { ok: boolean, method: string, error?: string } {
  // SIGTERM the entire process group first (negative pid = kill group),
  // matching taskkill /T cascade semantics. Falls back to single-pid
  // SIGTERM/SIGKILL if the target is not a process group leader.
  try {
    execSync(`kill -TERM -- -${pid}`, { stdio: 'pipe' })
    return { ok: true, method: 'SIGTERM (group)' }
  }
  catch { /* fall through */ }
  try {
    execSync(`kill -TERM ${pid}`, { stdio: 'pipe' })
    return { ok: true, method: 'SIGTERM' }
  }
  catch { /* fall through */ }
  try {
    execSync(`kill -KILL ${pid}`, { stdio: 'pipe' })
    return { ok: true, method: 'SIGKILL' }
  }
  catch (e) {
    return { ok: false, method: 'all-failed', error: e instanceof Error ? e.message : String(e) }
  }
}

export async function killOrphans(options: KillOrphansOptions = {}): Promise<void> {
  const dryRun = options.dryRun ?? true
  const minAgeHours = options.minAgeHours ?? 1
  const stuckOnly = options.stuckOnly ?? false

  const targetDesc = stuckOnly
    ? 'stuck broker daemons only (CPU/wall < 1%, age > 5min, ignores companions/MCP)'
    : `orphan node processes >${minAgeHours}h`
  console.log(ansis.cyan.bold('\n  ccgx kill-orphans'))
  console.log(ansis.gray(`  ${dryRun ? '[DRY-RUN]' : '[KILL MODE]'} target: ${targetDesc}\n`))

  const all = listNodeProcesses()
  if (all.length === 0) {
    console.log(ansis.yellow('  No node processes found (or unable to list).'))
    return
  }

  // Categorize
  const groups = new Map<NodeProcInfo['category'], NodeProcInfo[]>()
  for (const p of all) {
    if (!groups.has(p.category)) groups.set(p.category, [])
    groups.get(p.category)!.push(p)
  }

  console.log(ansis.bold('  Inventory:'))
  for (const cat of ['mcp-server', 'codex-cli', 'gemini-cli', 'phase-runner', 'dev-server', 'other'] as const) {
    const list = groups.get(cat) ?? []
    if (list.length === 0) continue
    const oldestH = Math.max(...list.map(p => p.ageHours))
    const stuckCount = list.filter(isStuck).length
    const tag = cat === 'dev-server' ? ansis.green('SAFE') : (cat === 'other' ? ansis.gray('UNKN') : ansis.yellow('ORPH'))
    const stuckTag = stuckCount > 0 ? ansis.red(` ${stuckCount} stuck`) : ''
    console.log(`    ${tag} ${cat.padEnd(14)} ${String(list.length).padStart(3)} processes  (oldest ${oldestH.toFixed(1)}h)${stuckTag}`)
  }
  console.log()

  // Targets: orphans in mcp-server / codex-cli / gemini-cli / phase-runner.
  // --stuck restricts to stuck ones (CPU≈0 + age>5min) regardless of minAgeHours.
  const ORPHAN_CATS: NodeProcInfo['category'][] = ['mcp-server', 'codex-cli', 'gemini-cli', 'phase-runner']
  const targets = all.filter((p) => {
    if (!ORPHAN_CATS.includes(p.category)) return false
    if (stuckOnly) return isStuck(p)
    return p.ageHours >= minAgeHours
  })

  if (targets.length === 0) {
    const reason = stuckOnly ? 'stuck' : `>${minAgeHours}h`
    console.log(ansis.green(`  ✓ No ${reason} orphans to clean.`))
    return
  }

  console.log(ansis.bold(`  Targets (${targets.length}):`))
  for (const p of targets) {
    const cmdShort = p.cmdLine.length > 60 ? `${p.cmdLine.slice(0, 60)}...` : p.cmdLine
    const wallS = p.ageHours * 3600
    const ratio = wallS > 0 ? (p.cpuSeconds / wallS) * 100 : 0
    const stuckMark = isStuck(p) ? ansis.red(' STUCK') : ''
    console.log(
      `    PID ${String(p.pid).padStart(6)}  ${p.ageHours.toFixed(1).padStart(5)}h  CPU ${p.cpuSeconds.toFixed(1).padStart(6)}s (${ratio.toFixed(2).padStart(5)}%)  ${ansis.gray(p.category.padEnd(14))} ${cmdShort}${stuckMark}`,
    )
  }
  console.log()

  if (dryRun) {
    const flag = stuckOnly ? '--stuck --kill' : '--kill'
    console.log(ansis.gray(`  Run with ${flag} to actually terminate (skips dev-server / other categories).`))
    return
  }

  const killer = isWindows() ? killProcessWindows : killProcessPosix
  let killed = 0
  let failed = 0
  for (const p of targets) {
    const r = killer(p.pid)
    if (r.ok) {
      console.log(ansis.green(`  ✓ killed PID ${p.pid} via ${r.method}`))
      killed += 1
    }
    else {
      console.log(ansis.red(`  ✗ PID ${p.pid} could not be terminated (${r.error})`))
      failed += 1
    }
  }
  console.log()
  console.log(ansis.bold(`  Result: ${killed} killed, ${failed} failed`))
  if (failed > 0) {
    console.log(ansis.yellow('  Some processes refused all kill methods (may require reboot or admin elevation).'))
  }
}
