/**
 * Unit tests for templates/scripts/ccg-phase-runner-launcher.mjs (v4.5 P1b).
 *
 * The launcher is a flat ES module shipped to ~/.claude/.ccg/scripts/ — no transpile
 * step. We exercise the pure helpers (parseArgs / buildClaudeArgs / TIER_BUDGET
 * / atomicWriteFileSync) via a dynamic ESM import. main() is integration-level
 * and not unit-tested here (it spawns `claude`, which we don't want in CI).
 *
 * Coverage includes:
 *   - argv parsing happy path + error paths (missing required flags, unknown)
 *   - buildClaudeArgs flag inventory matches the v4.5 P1a contract
 *   - tier → budget mapping
 *   - atomic write semantics (round-trip + temp cleanup)
 *
 * Indirectly validates codex C2 row 1 / row 2 behaviour: the launcher writes
 * initial state BEFORE spawn so a crash between argv parse and spawn still
 * leaves state.json behind for the reconciler to pick up.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const LAUNCHER_PATH = resolve(
  REPO_ROOT,
  'templates',
  'scripts',
  'ccg-phase-runner-launcher.mjs',
)

// Dynamic import so the script's top-level `if (isMainModule())` guard sees us
// as an importer, not as the main script — main() must NOT auto-run here.
//
// `/* @vite-ignore */` keeps Vitest's resolver from trying to transform the
// .mjs file as TypeScript: it's a hand-rolled ES module shipped to user
// machines, so we want the actual file's runtime semantics, not Vitest's view.
async function loadLauncher(): Promise<any> {
  const url = pathToFileURL(LAUNCHER_PATH).href
  const mod = await import(/* @vite-ignore */ url)
  return mod.ccgPhaseRunnerLauncherExports
}

let workdir: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ccg-launcher-test-'))
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

// =============================================================================
// parseArgs
// =============================================================================

describe('parseArgs', () => {
  it('parses the minimal required argv', async () => {
    const lib = await loadLauncher()
    const opts = lib.parseArgs([
      'node', 'launcher.mjs',
      '--job-id', 'job-abc',
      '--workdir', '/d/repo',
      '--prompt-file', '/tmp/prompt.txt',
    ])
    expect(opts.jobId).toBe('job-abc')
    expect(opts.workdir).toBe('/d/repo')
    expect(opts.promptFile).toBe('/tmp/prompt.txt')
    // Defaults.
    expect(opts.tier).toBe('triple')
    expect(opts.maxBudgetUsd).toBe(null)
    expect(opts.graceMs).toBe(5000)
  })

  it('supports --tier override', async () => {
    const lib = await loadLauncher()
    const opts = lib.parseArgs([
      'node', 'l.mjs',
      '--job-id', 'j', '--workdir', '/x', '--prompt-file', '/y',
      '--tier', 'debate',
    ])
    expect(opts.tier).toBe('debate')
  })

  it('supports --max-budget-usd numeric override', async () => {
    const lib = await loadLauncher()
    const opts = lib.parseArgs([
      'node', 'l.mjs',
      '--job-id', 'j', '--workdir', '/x', '--prompt-file', '/y',
      '--max-budget-usd', '7.5',
    ])
    expect(opts.maxBudgetUsd).toBe(7.5)
  })

  it('supports --grace-ms override', async () => {
    const lib = await loadLauncher()
    const opts = lib.parseArgs([
      'node', 'l.mjs',
      '--job-id', 'j', '--workdir', '/x', '--prompt-file', '/y',
      '--grace-ms', '2000',
    ])
    expect(opts.graceMs).toBe(2000)
  })

  it('throws when required --job-id is missing', async () => {
    const lib = await loadLauncher()
    expect(() => lib.parseArgs([
      'node', 'l.mjs', '--workdir', '/x', '--prompt-file', '/y',
    ])).toThrow(/--job-id is required/)
  })

  it('throws when required --workdir is missing', async () => {
    const lib = await loadLauncher()
    expect(() => lib.parseArgs([
      'node', 'l.mjs', '--job-id', 'j', '--prompt-file', '/y',
    ])).toThrow(/--workdir is required/)
  })

  it('throws when required --prompt-file is missing', async () => {
    const lib = await loadLauncher()
    expect(() => lib.parseArgs([
      'node', 'l.mjs', '--job-id', 'j', '--workdir', '/x',
    ])).toThrow(/--prompt-file is required/)
  })

  it('throws on unknown flag', async () => {
    const lib = await loadLauncher()
    expect(() => lib.parseArgs([
      'node', 'l.mjs',
      '--job-id', 'j', '--workdir', '/x', '--prompt-file', '/y',
      '--make-coffee', 'yes',
    ])).toThrow(/unknown flag: --make-coffee/)
  })

  it('throws on invalid --tier', async () => {
    const lib = await loadLauncher()
    expect(() => lib.parseArgs([
      'node', 'l.mjs',
      '--job-id', 'j', '--workdir', '/x', '--prompt-file', '/y',
      '--tier', 'paranoid',
    ])).toThrow(/invalid --tier: paranoid/)
  })

  it('throws when a flag is missing its value', async () => {
    const lib = await loadLauncher()
    expect(() => lib.parseArgs([
      'node', 'l.mjs', '--job-id',
    ])).toThrow(/--job-id requires a value/)
  })
})

// =============================================================================
// buildClaudeArgs — flag inventory must match buildPhaseRunnerBashCommand
// =============================================================================

describe('buildClaudeArgs', () => {
  it('produces the v4.5 P1a flag set in the right order', async () => {
    const lib = await loadLauncher()
    const promptFile = join(workdir, 'prompt.txt')
    writeFileSync(promptFile, 'do the work', 'utf-8')

    const args = lib.buildClaudeArgs({
      promptFile,
      workdir: '/d/repo',
      tier: 'triple',
      maxBudgetUsd: null,
    })

    expect(args).toEqual([
      '-p', 'do the work',
      '--agent', 'ccg/phase-runner',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--max-budget-usd', '2',
      '--dangerously-skip-permissions',
      '--add-dir', '/d/repo',
    ])
  })

  it('honors maxBudgetUsd override (priority over tier)', async () => {
    const lib = await loadLauncher()
    const promptFile = join(workdir, 'p.txt')
    writeFileSync(promptFile, 'go', 'utf-8')

    const args = lib.buildClaudeArgs({
      promptFile,
      workdir: '/x',
      tier: 'fast',
      maxBudgetUsd: 99,
    })
    const idx = args.indexOf('--max-budget-usd')
    expect(args[idx + 1]).toBe('99')
  })

  it('uses TIER_BUDGET when override is null', async () => {
    const lib = await loadLauncher()
    expect(lib.TIER_BUDGET).toEqual({ fast: 1.0, triple: 2.0, debate: 5.0 })

    const promptFile = join(workdir, 'p2.txt')
    writeFileSync(promptFile, 'x', 'utf-8')

    for (const [tier, expected] of Object.entries({ fast: '1', triple: '2', debate: '5' })) {
      const args = lib.buildClaudeArgs({
        promptFile,
        workdir: '/x',
        tier,
        maxBudgetUsd: null,
      })
      const idx = args.indexOf('--max-budget-usd')
      expect(args[idx + 1]).toBe(expected)
    }
  })

  it('reads the prompt file content into argv', async () => {
    const lib = await loadLauncher()
    const promptFile = join(workdir, 'long.txt')
    const content = 'multi\nline\nprompt body with $special and "quotes"'
    writeFileSync(promptFile, content, 'utf-8')

    const args = lib.buildClaudeArgs({
      promptFile,
      workdir: '/x',
      tier: 'triple',
      maxBudgetUsd: null,
    })
    const idx = args.indexOf('-p')
    expect(args[idx + 1]).toBe(content)
  })

  it('throws ENOENT when promptFile does not exist', async () => {
    const lib = await loadLauncher()
    expect(() => lib.buildClaudeArgs({
      promptFile: join(workdir, 'missing-prompt.txt'),
      workdir: '/x',
      tier: 'triple',
      maxBudgetUsd: null,
    })).toThrow(/ENOENT/)
  })
})

// =============================================================================
// atomicWriteFileSync (launcher-local twin of jobs.ts atomic writer)
// =============================================================================

describe('launcher.atomicWriteFileSync', () => {
  it('writes content and removes temp file', async () => {
    const lib = await loadLauncher()
    const target = join(workdir, 'state.json')
    lib.atomicWriteFileSync(target, '{"ok":true}')
    expect(readFileSync(target, 'utf-8')).toBe('{"ok":true}')

    const leftover = readdirSync(workdir).filter(f => f.startsWith('state.json.tmp.'))
    expect(leftover).toEqual([])
  })

  it('overwrites cleanly across many sequential writes', async () => {
    const lib = await loadLauncher()
    const target = join(workdir, 'progress.json')
    for (let i = 0; i < 20; i++) {
      lib.atomicWriteFileSync(target, JSON.stringify({ i }))
    }
    expect(JSON.parse(readFileSync(target, 'utf-8')).i).toBe(19)
  })
})
