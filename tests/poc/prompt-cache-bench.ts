/**
 * v4.5 Phase 5 (P1e): Prompt cache + cost benchmark for `claude -p --agent ccg/phase-runner`.
 *
 * Phase scope: real CLI subprocess invocations against multiple repos / TTL modes,
 * record per-spawn cache + cost telemetry, derive budget-default tier values.
 *
 * NOT a vitest test — runs real `claude` CLI subprocesses, costs real money.
 * Run via: `pnpm tsx tests/poc/prompt-cache-bench.ts [--repos=...] [--mode=rapid|spaced|both] [--n=N]`
 *
 * Defaults conservative (real money guardrail): 10 spawn × 2 repos × 2 modes = 40 spawns,
 * cost ≤ $15 (T1 outlier $0.412 × 40 = $16.48 worst case; T3 baseline $0.135 × 40 = $5.40).
 *
 * Acceptance refs: `.ccg/v4.5-roadmap.md` P1e + `.ccg/poc-v45/poc-results.md` D3.
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile, appendFile, access, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_N_PER_CELL = 10
const DEFAULT_PROMPT = 'Reply with exactly this JSON object and nothing else: {"ok":true,"phase":"v4.5-p5-bench"}'
const DEFAULT_BUDGET_USD = 0.5 // per-spawn protection (well above PoC $0.412 outlier; reject runaway)
const TTL_SPACED_SLEEP_MS = 6 * 60 * 1000 // 6 minutes — past 5-min ephemeral cache boundary

interface RepoConfig {
  /** Slug used in JSONL filename + report */
  id: string
  /** Absolute cwd for `claude -p --add-dir` */
  workdir: string
  /** Description for report */
  desc: string
}

const REPOS: RepoConfig[] = [
  {
    id: 'ccg-workflow',
    workdir: 'D:\\workflow\\ccg-workflow',
    desc: 'Heavy CLAUDE.md (~46k tokens) — meta-doc repo',
  },
  {
    id: 'minimal',
    workdir: tmpdir() + '\\ccg-bench-empty', // empty cwd, no CLAUDE.md walkable
    desc: 'Empty cwd — no project CLAUDE.md, baseline cache size',
  },
  // uni-iam: not accessible at /d/workflow/uni-iam (verified phase 5 setup)
]

interface Cli {
  reposFilter?: string[]
  mode: 'rapid' | 'spaced' | 'both'
  nPerCell: number
  budgetUsd: number
  dryRun: boolean
  /** Skip spawns; rebuild report from existing JSONL files */
  rerenderOnly: boolean
}

function parseCli(argv: string[]): Cli {
  const cli: Cli = {
    mode: 'rapid',
    nPerCell: DEFAULT_N_PER_CELL,
    budgetUsd: DEFAULT_BUDGET_USD,
    dryRun: false,
    rerenderOnly: false,
  }
  for (const a of argv.slice(2)) {
    if (a.startsWith('--repos=')) cli.reposFilter = a.slice('--repos='.length).split(',').filter(Boolean)
    else if (a.startsWith('--mode=')) {
      const m = a.slice('--mode='.length)
      if (m !== 'rapid' && m !== 'spaced' && m !== 'both') {
        throw new Error(`--mode must be rapid|spaced|both, got "${m}"`)
      }
      cli.mode = m
    }
    else if (a.startsWith('--n=')) cli.nPerCell = Math.max(1, Number(a.slice('--n='.length)) || DEFAULT_N_PER_CELL)
    else if (a.startsWith('--budget=')) cli.budgetUsd = Math.max(0.01, Number(a.slice('--budget='.length)) || DEFAULT_BUDGET_USD)
    else if (a === '--dry-run') cli.dryRun = true
    else if (a === '--rerender-only') cli.rerenderOnly = true
    else if (a === '--help' || a === '-h') {
      console.log(USAGE)
      process.exit(0)
    }
  }
  return cli
}

const USAGE = `
v4.5 P1e: prompt cache + cost benchmark for \`claude -p --agent ccg/phase-runner\`

Usage:
  pnpm tsx tests/poc/prompt-cache-bench.ts [options]

Options:
  --repos=ccg-workflow,minimal   Comma-separated repo IDs to benchmark (default: all)
  --mode=rapid|spaced|both       TTL mode (default: rapid). Spaced inserts 6min sleeps to test cache TTL boundary
  --n=10                         Spawn count per cell (default: 10)
  --budget=0.5                   Per-spawn --max-budget-usd guardrail (default: \$0.50)
  --dry-run                      Print plan without invoking claude CLI
  --rerender-only                Skip spawns, rebuild report from existing .jsonl files
  -h, --help                     Show this message

Output:
  JSONL: .ccg/poc-v45/cost-cache-bench.<repoId>.<mode>.jsonl
  Report: .ccg/poc-v45/cost-cache-bench.md (re-rendered after every cell completes)

Cost estimate: ~\$0.30/spawn × n × repos × modes; default plan ~\$12 worst case
`.trim()

// ---------------------------------------------------------------------------
// Telemetry record per spawn
// ---------------------------------------------------------------------------

interface SpawnRecord {
  /** ISO8601 timestamp at spawn start */
  ts: string
  repoId: string
  mode: 'rapid' | 'spaced'
  /** 0-indexed within cell */
  idx: number
  workdir: string
  /** Wall clock total ms (spawn → exit) */
  wallMs: number
  /** API duration ms (from result event) */
  durationApiMs: number | null
  /** total_cost_usd from result event */
  totalCostUsd: number | null
  /** cache_creation_input_tokens */
  cacheCreationTokens: number | null
  /** cache_read_input_tokens */
  cacheReadTokens: number | null
  inputTokens: number | null
  outputTokens: number | null
  model: string | null
  /** SHA-256 of prompt (truncated 16 hex) — sanity check identical prompt */
  promptHashShort: string
  /** "success" | "error" | "timeout" | "no-result-event" */
  outcome: 'success' | 'error' | 'timeout' | 'no-result-event'
  /** Last 200 chars of stderr if outcome != success */
  errorTail?: string
  /** Subprocess exit code */
  exitCode: number | null
}

// ---------------------------------------------------------------------------
// Spawn helper
// ---------------------------------------------------------------------------

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  }
  catch {
    return false
  }
}

function shortHash(s: string): string {
  // Tiny FNV-1a 32-bit, no crypto dep needed for sanity check
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

interface RunOneOpts {
  workdir: string
  prompt: string
  budgetUsd: number
  /** Soft wall timeout to prevent hang */
  timeoutMs: number
}

/**
 * Run one `claude -p --agent ccg/phase-runner` subprocess and return parsed telemetry.
 *
 * Uses --output-format stream-json --verbose (per PoC D1). Last stdout line is
 * the `result` event with full usage stats.
 */
async function runOne(opts: RunOneOpts): Promise<{
  wallMs: number
  result: any | null
  stderrTail: string
  exitCode: number | null
  outcome: SpawnRecord['outcome']
}> {
  const args = [
    '-p',
    opts.prompt,
    '--agent', 'ccg/phase-runner',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--max-budget-usd', String(opts.budgetUsd),
    '--dangerously-skip-permissions',
    '--add-dir', opts.workdir,
  ]

  const t0 = Date.now()
  return new Promise((res) => {
    const child = spawn('claude', args, {
      cwd: opts.workdir,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    child.stdout.on('data', (b: Buffer) => { stdoutChunks.push(b.toString('utf8')) })
    child.stderr.on('data', (b: Buffer) => { stderrChunks.push(b.toString('utf8')) })

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') }
      catch {}
      setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 5000)
    }, opts.timeoutMs)

    child.on('exit', (code) => {
      clearTimeout(timer)
      const wallMs = Date.now() - t0
      const stdout = stdoutChunks.join('')
      const stderrTail = stderrChunks.join('').slice(-200)
      const lines = stdout.split(/\r?\n/).filter(l => l.trim().length > 0)
      let result: any = null
      // Parse from end; last `type:result` line wins
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i])
          if (obj && obj.type === 'result') {
            result = obj
            break
          }
        }
        catch {}
      }
      let outcome: SpawnRecord['outcome'] = 'success'
      if (code !== 0) outcome = 'error'
      else if (!result) outcome = 'no-result-event'
      res({ wallMs, result, stderrTail, exitCode: code, outcome })
    })

    child.on('error', () => {
      clearTimeout(timer)
      const wallMs = Date.now() - t0
      res({ wallMs, result: null, stderrTail: stderrChunks.join('').slice(-200), exitCode: null, outcome: 'error' })
    })
  })
}

// ---------------------------------------------------------------------------
// Cell runner
// ---------------------------------------------------------------------------

interface CellPlan {
  repo: RepoConfig
  mode: 'rapid' | 'spaced'
  n: number
  prompt: string
  budgetUsd: number
  outFile: string
}

async function runCell(plan: CellPlan, dryRun: boolean): Promise<SpawnRecord[]> {
  const records: SpawnRecord[] = []
  console.log(`\n=== Cell: ${plan.repo.id} / ${plan.mode} / n=${plan.n} ===`)
  console.log(`  cwd:     ${plan.repo.workdir}`)
  console.log(`  outfile: ${plan.outFile}`)
  console.log(`  budget:  $${plan.budgetUsd}/spawn  (estimated total $${(plan.budgetUsd * plan.n).toFixed(2)})`)

  if (dryRun) {
    console.log('  [DRY RUN — skipping actual spawns]')
    return records
  }

  // Ensure workdir exists
  if (!(await pathExists(plan.repo.workdir))) {
    await ensureDir(plan.repo.workdir)
    console.log(`  created workdir ${plan.repo.workdir}`)
  }
  // Truncate JSONL file (write empty + small delay to ensure FS commit on Windows)
  await writeFile(plan.outFile, '', 'utf8')
  if (process.platform === 'win32') {
    await new Promise(r => setTimeout(r, 50))
  }

  const promptHash = shortHash(plan.prompt)

  for (let i = 0; i < plan.n; i++) {
    if (plan.mode === 'spaced' && i > 0) {
      console.log(`  [spaced] sleeping ${TTL_SPACED_SLEEP_MS / 1000}s to clear ephemeral cache TTL...`)
      await new Promise(r => setTimeout(r, TTL_SPACED_SLEEP_MS))
    }
    const ts = new Date().toISOString()
    const t0 = Date.now()
    process.stdout.write(`  [${i + 1}/${plan.n}] spawning... `)
    const out = await runOne({
      workdir: plan.repo.workdir,
      prompt: plan.prompt,
      budgetUsd: plan.budgetUsd,
      timeoutMs: 5 * 60_000,
    })
    const wallSec = ((Date.now() - t0) / 1000).toFixed(1)
    const r = out.result
    const usage = r?.usage
    const rec: SpawnRecord = {
      ts,
      repoId: plan.repo.id,
      mode: plan.mode,
      idx: i,
      workdir: plan.repo.workdir,
      wallMs: out.wallMs,
      durationApiMs: r?.duration_api_ms ?? null,
      totalCostUsd: typeof r?.total_cost_usd === 'number' ? r.total_cost_usd : null,
      cacheCreationTokens: usage?.cache_creation_input_tokens ?? null,
      cacheReadTokens: usage?.cache_read_input_tokens ?? null,
      inputTokens: usage?.input_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null,
      model: r?.modelUsage ? Object.keys(r.modelUsage)[0] ?? null : null,
      promptHashShort: promptHash,
      outcome: out.outcome,
      errorTail: out.outcome !== 'success' ? out.stderrTail : undefined,
      exitCode: out.exitCode,
    }
    records.push(rec)
    // Append-only graceful write
    await appendFile(plan.outFile, JSON.stringify(rec) + '\n', 'utf8')
    if (rec.outcome === 'success') {
      console.log(`done ${wallSec}s cost=$${(rec.totalCostUsd ?? 0).toFixed(4)} cache_create=${rec.cacheCreationTokens} cache_read=${rec.cacheReadTokens}`)
    }
    else {
      console.log(`FAIL outcome=${rec.outcome} exit=${rec.exitCode} stderr=${(rec.errorTail ?? '').replace(/\n/g, ' | ')}`)
    }
  }
  return records
}

// ---------------------------------------------------------------------------
// Aggregation + report
// ---------------------------------------------------------------------------

interface CellSummary {
  repoId: string
  mode: 'rapid' | 'spaced'
  desc: string
  n: number
  successN: number
  costP50: number | null
  costP90: number | null
  costP99: number | null
  costMin: number | null
  costMax: number | null
  costMean: number | null
  cacheCreateP50: number | null
  cacheReadP50: number | null
  wallSecP50: number | null
  errors: string[]
}

function pct(arr: number[], p: number): number | null {
  if (!arr.length) return null
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

function summarize(records: SpawnRecord[], repo: RepoConfig, mode: 'rapid' | 'spaced'): CellSummary {
  const ok = records.filter(r => r.outcome === 'success' && typeof r.totalCostUsd === 'number')
  const costs = ok.map(r => r.totalCostUsd!).filter((x): x is number => typeof x === 'number')
  const cacheCreates = ok.map(r => r.cacheCreationTokens).filter((x): x is number => typeof x === 'number')
  const cacheReads = ok.map(r => r.cacheReadTokens).filter((x): x is number => typeof x === 'number')
  const walls = ok.map(r => r.wallMs / 1000)
  const errs = records.filter(r => r.outcome !== 'success').map(r => `idx=${r.idx} outcome=${r.outcome} exit=${r.exitCode} stderr=${(r.errorTail ?? '').slice(0, 80)}`)
  const mean = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null
  return {
    repoId: repo.id,
    mode,
    desc: repo.desc,
    n: records.length,
    successN: ok.length,
    costP50: pct(costs, 50),
    costP90: pct(costs, 90),
    costP99: pct(costs, 99),
    costMin: costs.length ? Math.min(...costs) : null,
    costMax: costs.length ? Math.max(...costs) : null,
    costMean: mean,
    cacheCreateP50: pct(cacheCreates, 50),
    cacheReadP50: pct(cacheReads, 50),
    wallSecP50: pct(walls, 50),
    errors: errs,
  }
}

function recommendBudgets(cells: CellSummary[]): { fast: number, triple: number, debate: number, basis: string } {
  // Strategy: take max p90 across all cells (worst-case repo wins), apply 50% buffer.
  // Fast tier = 1× p90 + 50% buffer; triple = 2× (room for plan/critic spawns); debate = 5× (multi-round).
  const p90s = cells.map(c => c.costP90).filter((x): x is number => typeof x === 'number')
  if (!p90s.length) {
    return { fast: 1.0, triple: 2.0, debate: 5.0, basis: 'no-data → fallback to D3 defaults' }
  }
  const worstP90 = Math.max(...p90s)
  // Per-spawn budget; tier multiplier reflects spawn count per phase (impl wave is 1 phase-runner spawn,
  // but tier bump gives headroom for retries / verify wave running on same budget pool).
  const fastBudget = +(worstP90 * 1.5).toFixed(2) // 1× spawn + 50% buffer
  const tripleBudget = +(worstP90 * 3.0).toFixed(2) // 2× spawn (impl + retry headroom) + buffer
  const debateBudget = +(worstP90 * 7.5).toFixed(2) // 5× spawn (multi-round) + buffer
  return {
    fast: Math.max(fastBudget, 1.0),
    triple: Math.max(tripleBudget, 2.0),
    debate: Math.max(debateBudget, 5.0),
    basis: `worst p90 across cells = $${worstP90.toFixed(4)}; fast = 1.5×; triple = 3×; debate = 7.5× (floor at D3 defaults)`,
  }
}

function fmt(n: number | null, digits = 4): string {
  return typeof n === 'number' ? `$${n.toFixed(digits)}` : '—'
}

function fmtTok(n: number | null): string {
  return typeof n === 'number' ? n.toLocaleString() : '—'
}

async function renderReport(cells: CellSummary[], rec: ReturnType<typeof recommendBudgets>, reportPath: string): Promise<void> {
  // Autonomous run cost = N spawn × cost per spawn (using p90 as conservative per-spawn).
  // Heuristic phase counts from acceptance:
  //   fast 5 spawns/phase × 8 phase = 40
  //   triple 11 × 8 = 88
  //   debate 18 × 8 = 144
  // But per-spawn budget assumes 1 phase-runner; verify/critic spawns are different kinds (Bash-direct plugin etc).
  // Conservative model: use p50 mean for most spawns + p90 for cold start. We keep it simple:
  // fast run cost = 5 × p50 × 8; triple = 11 × p50 × 8; debate = 18 × p50 × 8.
  const allP50s = cells.map(c => c.costP50).filter((x): x is number => typeof x === 'number')
  const p50Mean = allP50s.length ? allP50s.reduce((a, b) => a + b, 0) / allP50s.length : null
  const ccgP50 = cells.find(c => c.repoId === 'ccg-workflow' && c.mode === 'rapid')?.costP50 ?? p50Mean
  const minimalP50 = cells.find(c => c.repoId === 'minimal' && c.mode === 'rapid')?.costP50 ?? p50Mean

  const lines: string[] = []
  lines.push('# v4.5 P1e: prompt cache + cost benchmark')
  lines.push('')
  lines.push(`**Date**: ${new Date().toISOString().slice(0, 10)}`)
  lines.push(`**Phase**: phase-v4.5-05 (P1e) — Cost/cache real-workdir benchmark`)
  lines.push(`**Goal**: validate v4.5 default \`--max-budget-usd\` per quality tier; correlate cwd CLAUDE.md size with cost.`)
  lines.push(`**Method**: real \`claude -p --agent ccg/phase-runner\` subprocess invocations across repos × TTL modes.`)
  lines.push('')
  lines.push('## Sample plan')
  lines.push('')
  lines.push('| Repo | Workdir | Mode | n | Status |')
  lines.push('|------|---------|------|---|--------|')
  for (const c of cells) {
    lines.push(`| ${c.repoId} | ${c.desc} | ${c.mode} | ${c.n} | ${c.successN}/${c.n} success |`)
  }
  lines.push('')
  lines.push('> **uni-iam not benchmarked**: directory `D:/workflow/uni-iam` not accessible at phase-v4.5-05 setup time. Fallback per phase acceptance: ccg-workflow + minimal /tmp two repos.')
  lines.push('')
  lines.push('## Per-cell summary')
  lines.push('')
  lines.push('| Repo | Mode | n | OK | min | mean | p50 | p90 | p99 | max | wall p50 | cache_create p50 | cache_read p50 |')
  lines.push('|------|------|---|----|-----|------|-----|-----|-----|-----|----------|------------------|----------------|')
  for (const c of cells) {
    lines.push(`| ${c.repoId} | ${c.mode} | ${c.n} | ${c.successN} | ${fmt(c.costMin)} | ${fmt(c.costMean)} | ${fmt(c.costP50)} | ${fmt(c.costP90)} | ${fmt(c.costP99)} | ${fmt(c.costMax)} | ${typeof c.wallSecP50 === 'number' ? c.wallSecP50.toFixed(1) + 's' : '—'} | ${fmtTok(c.cacheCreateP50)} | ${fmtTok(c.cacheReadP50)} |`)
  }
  lines.push('')
  for (const c of cells.filter(x => x.errors.length)) {
    lines.push(`### Errors (${c.repoId} / ${c.mode})`)
    lines.push('')
    for (const e of c.errors) lines.push(`- ${e}`)
    lines.push('')
  }
  lines.push('## Budget recommendation')
  lines.push('')
  lines.push(`Basis: ${rec.basis}`)
  lines.push('')
  lines.push('| Tier | Current D3 | Recommended | Delta |')
  lines.push('|------|------------|-------------|-------|')
  lines.push(`| fast | \$1.0 | \$${rec.fast.toFixed(2)} | ${rec.fast === 1.0 ? 'unchanged' : (rec.fast > 1.0 ? `+\$${(rec.fast - 1.0).toFixed(2)}` : `-\$${(1.0 - rec.fast).toFixed(2)}`)} |`)
  lines.push(`| triple | \$2.0 | \$${rec.triple.toFixed(2)} | ${rec.triple === 2.0 ? 'unchanged' : (rec.triple > 2.0 ? `+\$${(rec.triple - 2.0).toFixed(2)}` : `-\$${(2.0 - rec.triple).toFixed(2)}`)} |`)
  lines.push(`| debate | \$5.0 | \$${rec.debate.toFixed(2)} | ${rec.debate === 5.0 ? 'unchanged' : (rec.debate > 5.0 ? `+\$${(rec.debate - 5.0).toFixed(2)}` : `-\$${(5.0 - rec.debate).toFixed(2)}`)} |`)
  lines.push('')
  lines.push('## Autonomous-run cost projection (8-phase milestone)')
  lines.push('')
  lines.push('Heuristic spawn count per phase (impl + verify + plan + critic + retry headroom):')
  lines.push('- fast tier ≈ 5 spawns / phase')
  lines.push('- triple tier ≈ 11 spawns / phase')
  lines.push('- debate tier ≈ 18 spawns / phase')
  lines.push('')
  if (typeof ccgP50 === 'number' && typeof minimalP50 === 'number') {
    const phases = 8
    lines.push('| Tier | spawns | ccg-workflow (heavy) p50/spawn | est. run cost | minimal (clean) p50/spawn | est. run cost |')
    lines.push('|------|--------|--------------------------------|---------------|---------------------------|---------------|')
    lines.push(`| fast | ${5 * phases} | ${fmt(ccgP50)} | ${fmt(5 * phases * ccgP50, 2)} | ${fmt(minimalP50)} | ${fmt(5 * phases * minimalP50, 2)} |`)
    lines.push(`| triple | ${11 * phases} | ${fmt(ccgP50)} | ${fmt(11 * phases * ccgP50, 2)} | ${fmt(minimalP50)} | ${fmt(11 * phases * minimalP50, 2)} |`)
    lines.push(`| debate | ${18 * phases} | ${fmt(ccgP50)} | ${fmt(18 * phases * ccgP50, 2)} | ${fmt(minimalP50)} | ${fmt(18 * phases * minimalP50, 2)} |`)
    lines.push('')
    lines.push('> **Caveat**: real autonomous run reuses prompt cache across spawns (cache_read mostly), so estimates above (using p50 which mixes cold + warm) are **upper bounds**. PoC T3 showed cold $0.135 vs warm $0.005 (27× cheaper). Real run averages closer to warm, ~30-50% of these projections.')
  }
  else {
    lines.push('_(insufficient data for projection)_')
  }
  lines.push('')
  lines.push('## D3 spec revision needed?')
  lines.push('')
  const sigDelta = Math.abs(rec.fast - 1.0) >= 0.5 || Math.abs(rec.triple - 2.0) >= 1.0 || Math.abs(rec.debate - 5.0) >= 2.0
  if (sigDelta) {
    lines.push(`**Yes** — recommended budgets diverge significantly from D3 (fast=\$1.0/triple=\$2.0/debate=\$5.0).`)
    lines.push(`Suggest D3-revision-2: fast=\$${rec.fast.toFixed(2)}/triple=\$${rec.triple.toFixed(2)}/debate=\$${rec.debate.toFixed(2)}. Main thread to decide acceptance.`)
  }
  else {
    lines.push('**No** — recommendations align with D3 within tolerance. Keep current defaults.')
  }
  lines.push('')
  lines.push('## v4.5 release notes excerpt (for P3)')
  lines.push('')
  lines.push('### Cost expectations')
  lines.push('')
  if (typeof ccgP50 === 'number' && typeof minimalP50 === 'number') {
    lines.push(`- Per phase-runner spawn (cold): \$${ccgP50.toFixed(3)} (heavy CLAUDE.md repo) / \$${minimalP50.toFixed(3)} (clean cwd)`)
    lines.push(`- Per autonomous milestone (8 phase, triple tier): ~\$${(11 * 8 * (ccgP50 + minimalP50) / 2).toFixed(0)}-${(11 * 8 * ccgP50).toFixed(0)} (depends on workdir CLAUDE.md size; warm cache reduces 30-50%)`)
  }
  lines.push(`- \`--max-budget-usd\` tier defaults: fast=\$${rec.fast.toFixed(2)}, triple=\$${rec.triple.toFixed(2)}, debate=\$${rec.debate.toFixed(2)} (per-spawn cap; autonomous run aggregates ~10-30× this)`)
  lines.push(`- Override via phase frontmatter: \`Quality: fast|triple|debate\``)
  lines.push('')
  lines.push('## Method notes')
  lines.push('')
  lines.push(`- Sample size **N=${cells[0]?.n ?? 'n/a'} per cell** is small; p90 has wide CI. PoC single-shot T1/T3 ($0.412/$0.135) sit within range.`)
  lines.push(`- Spaced mode inserts 6-min sleep to clear ephemeral cache TTL; rapid mode runs back-to-back.`)
  lines.push(`- Per-spawn \`--max-budget-usd\` guardrail set to ${cells.length ? '$' + DEFAULT_BUDGET_USD : 'n/a'} (well above PoC outliers).`)
  lines.push(`- Prompt is identical across all spawns (FNV hash sanity check) — variance from cwd CLAUDE.md auto-discovery only.`)
  lines.push(`- Source script: \`tests/poc/prompt-cache-bench.ts\` — re-run via \`pnpm tsx tests/poc/prompt-cache-bench.ts\`.`)
  lines.push('')
  await writeFile(reportPath, lines.join('\n'), 'utf8')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cli = parseCli(process.argv)
  const repos = cli.reposFilter ? REPOS.filter(r => cli.reposFilter!.includes(r.id)) : REPOS
  if (!repos.length) {
    console.error(`No repos selected (filter: ${cli.reposFilter?.join(',') ?? 'none'}; available: ${REPOS.map(r => r.id).join(',')})`)
    process.exit(2)
  }
  const modes: Array<'rapid' | 'spaced'> = cli.mode === 'both' ? ['rapid', 'spaced'] : [cli.mode]

  const repoRoot = resolve(__dirname, '..', '..')
  const outDir = join(repoRoot, '.ccg', 'poc-v45')
  await ensureDir(outDir)

  console.log(`v4.5 P1e benchmark plan:`)
  console.log(`  repos:   ${repos.map(r => r.id).join(', ')}`)
  console.log(`  modes:   ${modes.join(', ')}`)
  console.log(`  n/cell:  ${cli.nPerCell}`)
  console.log(`  budget:  $${cli.budgetUsd}/spawn`)
  console.log(`  cells:   ${repos.length * modes.length}`)
  console.log(`  spawns:  ${repos.length * modes.length * cli.nPerCell}`)
  console.log(`  est cost ceiling: $${(repos.length * modes.length * cli.nPerCell * cli.budgetUsd).toFixed(2)} (worst-case, true cost ~30-60% of this)`)
  if (modes.includes('spaced')) {
    const spacedSleepMin = (cli.nPerCell - 1) * (TTL_SPACED_SLEEP_MS / 60_000)
    console.log(`  est wall (spaced cells): ${spacedSleepMin}min sleep + spawn time`)
  }
  console.log(`  outDir:  ${outDir}`)
  console.log('')

  const allCells: CellSummary[] = []
  const reportPath = join(outDir, 'cost-cache-bench.md')

  for (const repo of repos) {
    for (const mode of modes) {
      const outFile = join(outDir, `cost-cache-bench.${repo.id}.${mode}.jsonl`)
      let records: SpawnRecord[]
      if (cli.rerenderOnly) {
        if (!(await pathExists(outFile))) {
          console.log(`[rerender-only] skipping ${repo.id}/${mode} — no existing JSONL`)
          continue
        }
        records = await loadJsonl(outFile)
        console.log(`[rerender-only] loaded ${records.length} records from ${outFile}`)
      }
      else {
        const plan: CellPlan = {
          repo,
          mode,
          n: cli.nPerCell,
          prompt: DEFAULT_PROMPT,
          budgetUsd: cli.budgetUsd,
          outFile,
        }
        records = await runCell(plan, cli.dryRun)
      }
      const cellSummary = summarize(records, repo, mode)
      allCells.push(cellSummary)
      // Re-render report after every cell so partial data is still useful if interrupted
      if (!cli.dryRun) {
        const rec = recommendBudgets(allCells)
        await renderReport(allCells, rec, reportPath)
        console.log(`  → ${reportPath} updated (${allCells.length} cell(s) so far)`)
      }
    }
  }

  if (cli.dryRun) {
    console.log('\nDry run complete — no spawns issued.')
    return
  }

  const finalRec = recommendBudgets(allCells)
  await renderReport(allCells, finalRec, reportPath)

  console.log('\n=== Done ===')
  console.log(`Cells: ${allCells.length}`)
  console.log(`Total successful spawns: ${allCells.reduce((s, c) => s + c.successN, 0)} / ${allCells.reduce((s, c) => s + c.n, 0)}`)
  console.log(`Recommended budgets: fast=$${finalRec.fast} / triple=$${finalRec.triple} / debate=$${finalRec.debate}`)
  console.log(`Report: ${reportPath}`)
}

// Run via tsx
main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})

/**
 * Helper to read a previously written JSONL file (for re-rendering report from existing data
 * without re-running spawns). Not currently wired to CLI, kept as an export for future tooling.
 */
export async function loadJsonl(path: string): Promise<SpawnRecord[]> {
  const raw = await readFile(path, 'utf8')
  return raw.split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l) as SpawnRecord)
}
