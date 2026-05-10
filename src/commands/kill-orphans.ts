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
  cmdLine: string
  category: 'mcp-server' | 'codex-cli' | 'gemini-cli' | 'phase-runner' | 'dev-server' | 'other'
}

export interface KillOrphansOptions {
  dryRun?: boolean
  minAgeHours?: number
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
  const ps = `$ProgressPreference = 'SilentlyContinue'
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
    $cd = $_.CreationDate
    $h = if ($cd) { ((Get-Date) - $cd).TotalHours } else { 0 }
    $cmd = if ($_.CommandLine) { $_.CommandLine } else { '' }
    "$($_.ProcessId)|$h|$cmd"
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
    if (sep1 < 0 || sep2 < 0) continue
    const pid = Number.parseInt(trimmed.slice(0, sep1), 10)
    const ageHours = Number.parseFloat(trimmed.slice(sep1 + 1, sep2))
    const cmdLine = trimmed.slice(sep2 + 1)
    if (Number.isNaN(pid)) continue
    procs.push({
      pid,
      ageHours: Number.isFinite(ageHours) ? ageHours : 0,
      cmdLine,
      category: categorize(cmdLine),
    })
  }
  return procs
}

function listNodeProcessesPosix(): NodeProcInfo[] {
  let out: string
  try {
    out = execSync('ps -eo pid,etime,command', { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 })
  }
  catch {
    return []
  }
  const procs: NodeProcInfo[] = []
  for (const line of out.split('\n').slice(1)) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/)
    if (!m) continue
    const cmdLine = m[3]
    if (!/(^|\/)node(\s|$)/.test(cmdLine)) continue
    const pid = Number.parseInt(m[1], 10)
    // etime: dd-hh:mm:ss or hh:mm:ss or mm:ss
    const etime = m[2]
    const parts = etime.split(/[-:]/).map(s => Number.parseInt(s, 10))
    let ageHours = 0
    if (parts.length === 4) ageHours = parts[0] * 24 + parts[1] + parts[2] / 60
    else if (parts.length === 3) ageHours = parts[0] + parts[1] / 60
    else if (parts.length === 2) ageHours = parts[0] / 60
    procs.push({
      pid,
      ageHours,
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
  // 1. Stop-Process -Force
  try {
    execSync(`powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force -ErrorAction Stop"`, { stdio: 'pipe' })
    return { ok: true, method: 'Stop-Process' }
  }
  catch { /* fall through */ }
  // 2. taskkill /F
  try {
    execSync(`taskkill /F /PID ${pid}`, { stdio: 'pipe' })
    return { ok: true, method: 'taskkill /F' }
  }
  catch { /* fall through */ }
  // 3. wmic process delete (different kernel API path; succeeds when above fail
  //    on processes stuck in IPC syscall — see CCG 1.0.4 dogfood)
  try {
    execSync(`wmic process where "ProcessId=${pid}" delete`, { stdio: 'pipe' })
    return { ok: true, method: 'wmic delete' }
  }
  catch (e) {
    return { ok: false, method: 'all-failed', error: e instanceof Error ? e.message : String(e) }
  }
}

function killProcessPosix(pid: number): { ok: boolean, method: string, error?: string } {
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

  console.log(ansis.cyan.bold('\n  ccgx kill-orphans'))
  console.log(ansis.gray(`  ${dryRun ? '[DRY-RUN]' : '[KILL MODE]'} target: orphan node processes >${minAgeHours}h\n`))

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
    const tag = cat === 'dev-server' ? ansis.green('SAFE') : (cat === 'other' ? ansis.gray('UNKN') : ansis.yellow('ORPH'))
    console.log(`    ${tag} ${cat.padEnd(14)} ${String(list.length).padStart(3)} processes  (oldest ${oldestH.toFixed(1)}h)`)
  }
  console.log()

  // Targets: orphans in mcp-server / codex-cli / gemini-cli / phase-runner that are old enough
  const ORPHAN_CATS: NodeProcInfo['category'][] = ['mcp-server', 'codex-cli', 'gemini-cli', 'phase-runner']
  const targets = all.filter(p => ORPHAN_CATS.includes(p.category) && p.ageHours >= minAgeHours)

  if (targets.length === 0) {
    console.log(ansis.green(`  ✓ No orphans >${minAgeHours}h to clean.`))
    return
  }

  console.log(ansis.bold(`  Targets (${targets.length}):`))
  for (const p of targets) {
    const cmdShort = p.cmdLine.length > 70 ? `${p.cmdLine.slice(0, 70)}...` : p.cmdLine
    console.log(`    PID ${String(p.pid).padStart(6)}  ${p.ageHours.toFixed(1).padStart(5)}h  ${ansis.gray(p.category.padEnd(14))} ${cmdShort}`)
  }
  console.log()

  if (dryRun) {
    console.log(ansis.gray(`  Run with --kill to actually terminate (skips dev-server / other categories).`))
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
