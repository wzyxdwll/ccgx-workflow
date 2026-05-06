/**
 * v4.5 Phase 3 (P1c): Nested RSS stress benchmark for CLI subprocess phase-runner.
 *
 * Measures retained Working Set / RSS slope when an outer `claude -p --agent ccg/phase-runner`
 * CLI subprocess performs 5 / 10 / 20 nested `Agent(...)` spawns. Drives Decision Gate G2:
 *
 *   - slope ≤ 200 MB/nested → recommend default cap = 5
 *   - slope 200-500 MB/nested → recommend default cap = 3
 *   - slope > 500 MB/nested → trigger G2 NO-GO (Phase 6 推迟 v4.6)
 *
 * NOT a vitest test — spawns real `claude` CLI subprocesses, costs real money.
 *
 * Run:
 *   pnpm tsx tests/poc/nested-rss-stress.ts --matrix=trivial-single --n=5
 *   pnpm tsx tests/poc/nested-rss-stress.ts --matrix=plugin-single --plugin=codex --n=5
 *   pnpm tsx tests/poc/nested-rss-stress.ts --matrix=trivial-concurrent --outers=4 --n=5
 *   pnpm tsx tests/poc/nested-rss-stress.ts --matrix=plugin-concurrent --plugin=codex --outers=4 --n=5
 *   pnpm tsx tests/poc/nested-rss-stress.ts --all   # 4 matrix scenarios, pilot N=5 each
 *
 * Cost guardrail: every nested spawn capped at $0.10 via `--max-budget-usd`. Pilot all=4 ≈ $1.5–$3.
 *
 * Acceptance refs: .ccg/roadmap.md Phase 3, .ccg/poc-v45/codex-review.md C1.
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ---------------------------------------------------------------------------
// Config / types
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '..', '..')
const OUTPUT_DIR = join(REPO_ROOT, '.ccg', 'poc-v45')
const PER_NESTED_BUDGET_USD = 0.1
const OUTER_TIMEOUT_MS = 8 * 60 * 1000 // 8 min per outer subprocess
const NESTED_INTRA_DELAY_MS = 500
const CONCURRENT_OUTER_STAGGER_MS = 100

type MatrixId = 'trivial-single' | 'plugin-single' | 'trivial-concurrent' | 'plugin-concurrent'
type Plugin = 'codex' | 'gemini' | 'general-purpose'

interface MatrixConfig {
  id: MatrixId
  plugin: Plugin
  outers: number // 1 or 4
  nestedN: number // 5/10/20
}

interface RssSample {
  /** Sample label, e.g. "baseline", "after-nested-3", "outer-exit" */
  label: string
  /** Wall-clock ms since outer launch */
  elapsedMs: number
  /** Working Set / RSS in MB; -1 if sampling failed (process gone or PS error) */
  rssMb: number
}

interface OuterRunResult {
  outerIndex: number
  pid: number | null
  exitCode: number | null
  durationMs: number
  samples: RssSample[]
  /** number of nested spawns the outer claims it ran (parsed from output) */
  reportedNestedCount: number | null
  /** raw stdout/stderr for forensics */
  stdoutTail: string
  stderrTail: string
  /** budgetable error: true if outer crashed before finishing all nested */
  errored: boolean
}

interface MatrixResult {
  config: MatrixConfig
  outers: OuterRunResult[]
  startedAt: string
  finishedAt: string
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface Cli {
  matrix?: MatrixId
  all: boolean
  plugin: Plugin
  outers: number
  nestedN: number
  outFile: string
}

function parseCli(argv: string[]): Cli {
  const cli: Cli = {
    matrix: undefined,
    all: false,
    plugin: 'general-purpose',
    outers: 1,
    nestedN: 5,
    outFile: join(OUTPUT_DIR, 'nested-rss-stress.jsonl'),
  }
  for (const a of argv.slice(2)) {
    if (a === '--all') cli.all = true
    else if (a.startsWith('--matrix=')) cli.matrix = a.slice(9) as MatrixId
    else if (a.startsWith('--plugin=')) cli.plugin = a.slice(9) as Plugin
    else if (a.startsWith('--outers=')) cli.outers = parseInt(a.slice(9), 10) || 1
    else if (a.startsWith('--n=')) cli.nestedN = parseInt(a.slice(4), 10) || 5
    else if (a.startsWith('--out=')) cli.outFile = a.slice(6)
  }
  return cli
}

// ---------------------------------------------------------------------------
// Cross-platform RSS sampler
// ---------------------------------------------------------------------------

function isWindows(): boolean { return process.platform === 'win32' }

/**
 * Sample WorkingSet (Windows) or RSS (POSIX) for a pid in MB.
 * Returns -1 if process gone or sampler failed.
 */
async function sampleRssMb(pid: number): Promise<number> {
  if (!Number.isInteger(pid) || pid <= 0) return -1
  if (isWindows()) {
    return new Promise<number>((res) => {
      const ps = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `try { (Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64 } catch { -1 }`,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      )
      let out = ''
      ps.stdout.on('data', d => { out += d.toString() })
      const t = setTimeout(() => { try { ps.kill() } catch {} ; res(-1) }, 5000)
      ps.on('close', () => {
        clearTimeout(t)
        const n = parseInt(out.trim(), 10)
        if (!Number.isFinite(n) || n < 0) res(-1)
        else res(Math.round(n / (1024 * 1024)))
      })
      ps.on('error', () => { clearTimeout(t); res(-1) })
    })
  }
  // POSIX
  return new Promise<number>((res) => {
    const ps = spawn('ps', ['-o', 'rss=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    ps.stdout.on('data', d => { out += d.toString() })
    const t = setTimeout(() => { try { ps.kill() } catch {} ; res(-1) }, 5000)
    ps.on('close', () => {
      clearTimeout(t)
      const n = parseInt(out.trim(), 10)
      if (!Number.isFinite(n) || n <= 0) res(-1)
      else res(Math.round(n / 1024)) // ps RSS is KB
    })
    ps.on('error', () => { clearTimeout(t); res(-1) })
  })
}

// ---------------------------------------------------------------------------
// Build inner prompt (instructions for outer phase-runner subprocess)
//
// The outer subprocess must:
//   1. Run N nested Agent(...) spawns sequentially
//   2. Print a recognizable progress marker before/after each spawn so we can
//      correlate RSS samples
//   3. Emit a final JSON summary with reported_nested_count
// ---------------------------------------------------------------------------

function buildOuterPrompt(plugin: Plugin, n: number): string {
  // Note: the outer subprocess is `claude -p --agent ccg/phase-runner`. Its prompt
  // should make it spawn N nested Agents. Each nested spawn does trivial work to
  // minimise per-spawn cost while still incurring real process / token cost.
  const subagent
    = plugin === 'codex'
      ? 'codex:codex-rescue'
      : plugin === 'gemini'
        ? 'gemini:gemini-rescue'
        : 'general-purpose'

  const taskBody
    = subagent === 'general-purpose'
      ? 'Reply with exactly the text: NESTED_OK'
      : 'Reply in JSON: {"ok":true,"nested":true}. No code edits, no tool use.'

  return [
    'You are running a STRESS TEST. Strictly follow this protocol:',
    '',
    `1. Sequentially spawn EXACTLY ${n} Agent(...) calls with subagent_type="${subagent}".`,
    `2. For each spawn, the prompt is: ${JSON.stringify(taskBody)}.`,
    '3. Between spawns, print one line: PROGRESS k=<index> (1-indexed).',
    '4. If a spawn fails, print: PROGRESS_FAIL k=<index> reason=<short>.',
    '5. After all spawns done, print on a single line:',
    '   FINAL {"reported_nested_count": <int>, "errors": <int>}',
    '6. Do NOT run any other tool. No git, no test, no edits.',
    '7. Do NOT write any files.',
    '',
    'This is a measurement-only run. Speed matters; trivial answers are fine.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Run one outer subprocess
// ---------------------------------------------------------------------------

async function runOuter(
  outerIndex: number,
  config: MatrixConfig,
): Promise<OuterRunResult> {
  const prompt = buildOuterPrompt(config.plugin, config.nestedN)
  const startedAt = Date.now()
  const samples: RssSample[] = []
  let stdoutBuf = ''
  let stderrBuf = ''
  let lastProgressIdx = 0
  let reportedCount: number | null = null

  // Compute total budget — outer phase-runner CLAUDE.md walks ~$0.5-0.7 (P1e p90)
  // plus N nested spawns × per-nested headroom. Plugin nested ~3-5x trivial.
  const pluginMultiplier = config.plugin === 'general-purpose' ? 1 : 4
  const totalBudget = Math.max(
    1.2,
    0.8 + config.nestedN * PER_NESTED_BUDGET_USD * pluginMultiplier * 2,
  )

  const args = [
    '-p',
    prompt,
    '--agent', 'ccg/phase-runner',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    `--max-budget-usd`, String(totalBudget),
    '--dangerously-skip-permissions',
    '--add-dir', REPO_ROOT,
  ]

  return new Promise<OuterRunResult>((resolve) => {
    const child = spawn('claude', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: REPO_ROOT,
    })

    const pid = child.pid ?? null

    // Sample baseline ASAP
    const baselineSampled = (async () => {
      if (pid) {
        const rss = await sampleRssMb(pid)
        samples.push({ label: 'baseline', elapsedMs: Date.now() - startedAt, rssMb: rss })
      }
    })()

    // Periodic background sampler (every 2s, lightweight insurance)
    const samplerInterval = setInterval(async () => {
      if (!pid) return
      const rss = await sampleRssMb(pid)
      if (rss > 0) {
        samples.push({ label: `tick-${samples.length}`, elapsedMs: Date.now() - startedAt, rssMb: rss })
      }
    }, 2000)

    child.stdout.on('data', async (chunk) => {
      const s = chunk.toString()
      stdoutBuf += s
      // PROGRESS k=<n> markers — sample RSS at each
      const matches = s.matchAll(/PROGRESS k=(\d+)/g)
      for (const m of matches) {
        const k = parseInt(m[1] ?? '0', 10)
        if (Number.isFinite(k) && k > lastProgressIdx && pid) {
          lastProgressIdx = k
          const rss = await sampleRssMb(pid)
          samples.push({ label: `after-nested-${k}`, elapsedMs: Date.now() - startedAt, rssMb: rss })
        }
      }
      // FINAL marker — three forms: raw text, escaped-in-result-field, JSON value
      // 1) raw "FINAL {...}" if outer prints to stdout directly
      const finalRaw = stdoutBuf.match(/FINAL\s+(\{[^\n]+?\})/)
      // 2) "reported_nested_count":<n> appearing anywhere (covers escaped JSON
      //    inside stream-json `result` field)
      const reportedMatch = stdoutBuf.match(/reported_nested_count["\\]*:\s*(\d+)/)
      if (reportedCount === null) {
        if (finalRaw) {
          try {
            const obj = JSON.parse(finalRaw[1] ?? '{}')
            if (typeof obj.reported_nested_count === 'number') {
              reportedCount = obj.reported_nested_count
            }
          } catch {}
        }
        if (reportedCount === null && reportedMatch) {
          const n = parseInt(reportedMatch[1] ?? '', 10)
          if (Number.isFinite(n)) reportedCount = n
        }
      }
    })
    child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString() })

    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
    }, OUTER_TIMEOUT_MS)

    child.on('close', async (code) => {
      clearTimeout(timeout)
      clearInterval(samplerInterval)
      await baselineSampled
      // Pre-exit sample (process may already be reaped)
      if (pid) {
        const rss = await sampleRssMb(pid)
        if (rss > 0) {
          samples.push({ label: 'outer-exit-pre', elapsedMs: Date.now() - startedAt, rssMb: rss })
        }
      }
      resolve({
        outerIndex,
        pid,
        exitCode: code,
        durationMs: Date.now() - startedAt,
        samples,
        reportedNestedCount: reportedCount,
        stdoutTail: stdoutBuf.slice(-2000),
        stderrTail: stderrBuf.slice(-1000),
        errored: code !== 0,
      })
    })
    child.on('error', (err) => {
      clearTimeout(timeout)
      clearInterval(samplerInterval)
      stderrBuf += `\n[spawn error] ${err.message}\n`
      resolve({
        outerIndex,
        pid,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        samples,
        reportedNestedCount: null,
        stdoutTail: stdoutBuf.slice(-2000),
        stderrTail: stderrBuf.slice(-1000),
        errored: true,
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Run a matrix scenario (1 or 4 outers, possibly concurrent)
// ---------------------------------------------------------------------------

async function runMatrix(config: MatrixConfig): Promise<MatrixResult> {
  console.log(`\n[matrix] ${config.id}: outers=${config.outers}, nestedN=${config.nestedN}, plugin=${config.plugin}`)
  const startedAt = new Date().toISOString()
  const outers: OuterRunResult[] = []

  if (config.outers === 1) {
    const r = await runOuter(0, config)
    outers.push(r)
  } else {
    // Stagger launches so they don't all hit the auth/handshake exactly together
    const promises: Promise<OuterRunResult>[] = []
    for (let i = 0; i < config.outers; i++) {
      const p = (async () => {
        await new Promise(res => setTimeout(res, i * CONCURRENT_OUTER_STAGGER_MS))
        return runOuter(i, config)
      })()
      promises.push(p)
    }
    const results = await Promise.all(promises)
    outers.push(...results)
  }

  return {
    config,
    outers,
    startedAt,
    finishedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Analysis: per-nested retained slope
// ---------------------------------------------------------------------------

interface MatrixAnalysis {
  matrixId: MatrixId
  outerCount: number
  perOuterBaseline: Array<number | null>
  perOuterPeak: Array<number | null>
  perOuterDelta: Array<number | null>
  reportedNestedCounts: Array<number | null>
  /** Best-effort slope (delta / nestedN) averaged across non-errored outers */
  slopeMbPerNested: number | null
  errors: number
}

function analyseMatrix(r: MatrixResult): MatrixAnalysis {
  const perOuterBaseline: Array<number | null> = []
  const perOuterPeak: Array<number | null> = []
  const perOuterDelta: Array<number | null> = []
  const reportedNestedCounts: Array<number | null> = []
  let slopeSum = 0
  let slopeN = 0
  let errors = 0

  for (const o of r.outers) {
    if (o.errored) errors++
    const base = o.samples.find(s => s.label === 'baseline')?.rssMb ?? null
    let peak: number | null = null
    for (const s of o.samples) {
      if (s.rssMb > 0 && (peak === null || s.rssMb > peak)) peak = s.rssMb
    }
    perOuterBaseline.push(base)
    perOuterPeak.push(peak)
    const d = (base !== null && peak !== null) ? peak - base : null
    perOuterDelta.push(d)
    reportedNestedCounts.push(o.reportedNestedCount)
    if (d !== null && o.reportedNestedCount && o.reportedNestedCount > 0 && !o.errored) {
      slopeSum += d / o.reportedNestedCount
      slopeN++
    }
  }

  return {
    matrixId: r.config.id,
    outerCount: r.outers.length,
    perOuterBaseline,
    perOuterPeak,
    perOuterDelta,
    reportedNestedCounts,
    slopeMbPerNested: slopeN > 0 ? Math.round((slopeSum / slopeN) * 100) / 100 : null,
    errors,
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const cli = parseCli(process.argv)
  await mkdir(OUTPUT_DIR, { recursive: true })

  const matrices: MatrixConfig[] = []
  if (cli.all) {
    matrices.push(
      { id: 'trivial-single', plugin: 'general-purpose', outers: 1, nestedN: cli.nestedN },
      { id: 'plugin-single', plugin: 'codex', outers: 1, nestedN: cli.nestedN },
      { id: 'trivial-concurrent', plugin: 'general-purpose', outers: 4, nestedN: cli.nestedN },
      { id: 'plugin-concurrent', plugin: 'codex', outers: 4, nestedN: cli.nestedN },
    )
  } else if (cli.matrix) {
    const plugin: Plugin = cli.matrix.startsWith('plugin') ? cli.plugin : 'general-purpose'
    const outers = cli.matrix.endsWith('concurrent') ? Math.max(2, cli.outers) : 1
    matrices.push({ id: cli.matrix, plugin, outers, nestedN: cli.nestedN })
  } else {
    console.error('Specify --matrix=<id> or --all')
    process.exit(2)
  }

  const allResults: MatrixResult[] = []
  for (const m of matrices) {
    const r = await runMatrix(m)
    allResults.push(r)
    await appendFile(cli.outFile, JSON.stringify(r) + '\n', 'utf-8')
    const a = analyseMatrix(r)
    console.log(`[matrix done] ${a.matrixId} slope=${a.slopeMbPerNested ?? 'N/A'} MB/nested errors=${a.errors}/${a.outerCount}`)
  }

  // Print summary table
  console.log('\n=== SUMMARY ===')
  for (const r of allResults) {
    const a = analyseMatrix(r)
    console.log(`${a.matrixId.padEnd(22)} | outers=${a.outerCount} | nestedN=${r.config.nestedN} | slope=${a.slopeMbPerNested ?? 'N/A'} MB/nested | errors=${a.errors}`)
  }

  // Persist analysis JSON next to JSONL
  const analysisPath = cli.outFile.replace(/\.jsonl$/, '.analysis.json')
  await writeFile(analysisPath, JSON.stringify(allResults.map(analyseMatrix), null, 2), 'utf-8')
  console.log(`\nWrote analysis: ${analysisPath}`)
  console.log(`Wrote raw samples: ${cli.outFile}`)
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exit(1)
})
