/**
 * Plugin Bash Codegen — install-time render of helper-script invocation
 * commands for cross-vendor plugin invocation (codex / gemini companion).
 *
 * Why this exists (1.0.5 design after 1.0.4 dogfood):
 *   1.0.4 emitted heredoc-form Bash commands with %PROMPT% placeholder for
 *   LLM substitution. Two failure modes hit in dogfood:
 *     1. LLM cargo-culted anti-example code documented in templates
 *     2. LLM in actual review session still wrote `ls $(...) | head -1`
 *        glob-hack patterns, ignoring the heredoc placeholder mechanism
 *
 *   Root cause: any design that asks the LLM to construct OR substitute
 *   parts of a shell command has X% failure rate, X > 0 always.
 *
 *   1.0.5 fix: collapse the LLM surface to "choose vendor + pass prompt-file
 *   path". All plugin path resolution, flag construction, and shell-escape
 *   avoidance are done internally by `ccgx-call-plugin.mjs` Node helper
 *   (spawn array args, no shell layer). LLM only writes prompt to a tmpfile
 *   and runs the rendered helper command.
 *
 *   Placeholder semantics (1.0.5):
 *     {{CODEX_BASH_TASK}}    →
 *       node '<helper-abs-path>' codex --json
 *
 *     LLM workflow:
 *       1. Write prompt body to /tmp/ccg-codex-XXX.txt (via Write tool)
 *       2. Run: <placeholder> --prompt-file /tmp/ccg-codex-XXX.txt
 *       3. Parse JSON output: {status, stdout, stderr, exitCode, ...}
 *
 *   The {{CODEX_BASH_TASK}} value does NOT include --prompt-file, so the LLM
 *   appends it after writing the tmpfile. This minimizes substitution surface:
 *   no %PROMPT_FILE% placeholder for LLM to misuse.
 *
 *   Plugin missing at install time → fallback emits a clear error command.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join as joinPosix } from 'node:path/posix'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Vendor = 'codex' | 'gemini'

export interface CompanionLocation {
  vendor: Vendor
  /** plugin install root, e.g. C:\Users\...\plugins\cache\openai-codex\codex\1.0.4 */
  installPath: string
  /** absolute path to <vendor>-companion.mjs */
  companionPath: string
  /** plugin version string */
  version: string
}

export interface BuildBashCommandOptions {
  /** Use --json output. Default: true. */
  jsonOutput?: boolean
  /** Override helper script absolute path. Default: ~/.claude/.ccg/scripts/ccgx-call-plugin.mjs */
  helperPath?: string
  /** Override homeDir (for tests). Default: os.homedir() */
  homeDir?: string
}

// ---------------------------------------------------------------------------
// Plugin name → marketplace keys (the keys used in installed_plugins.json).
//
// Ordered list — the first key found in installed_plugins.json wins.
//
// CCG 2.0.0: gemini-ccgx (ccgx-maintained fork at wzyxdwll/gemini-plugin-cc)
// is preferred over google-gemini (upstream sakibsadmanshajib/gemini-plugin-cc)
// because the fork ships P-1..P-21 + W1/W2/I1 patches inline — no repatch
// script needed. The upstream key remains as fallback so users who haven't
// switched yet keep working (repatch-gemini-plugin.mjs still maintains them).
// ---------------------------------------------------------------------------

const VENDOR_MARKETPLACE_KEYS: Record<Vendor, string[]> = {
  codex: ['codex@openai-codex'],
  gemini: ['gemini@gemini-ccgx', 'gemini@google-gemini'],
}

/**
 * Primary install command shown in error / setup messages. Always points at
 * the recommended (CCG-maintained) source for the vendor.
 */
const VENDOR_PRIMARY_INSTALL: Record<Vendor, { marketplace: string; key: string }> = {
  codex: {
    marketplace: 'openai/codex-plugin-cc',
    key: 'codex@openai-codex',
  },
  gemini: {
    marketplace: 'wzyxdwll/gemini-plugin-cc',
    key: 'gemini@gemini-ccgx',
  },
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover the companion script location from the plugin SSoT
 * (`~/.claude/plugins/installed_plugins.json`). Returns null if the plugin
 * is not installed or the install record is malformed.
 *
 * This is the canonical replacement for `ls .../<vendor>-companion.mjs |
 * head -1` patterns in templates — the SSoT knows the *exact* installPath,
 * including the version subdir, without glob ambiguity.
 */
export function discoverCompanion(
  vendor: Vendor,
  homeDir: string = homedir(),
): CompanionLocation | null {
  const ssotPath = join(homeDir, '.claude', 'plugins', 'installed_plugins.json')
  if (!existsSync(ssotPath)) return null

  let raw: any
  try {
    raw = JSON.parse(readFileSync(ssotPath, 'utf-8'))
  }
  catch {
    return null
  }

  // Try preferred keys in order — fork first, upstream fallback.
  const keys = VENDOR_MARKETPLACE_KEYS[vendor]
  let inst: any = null
  for (const key of keys) {
    const instances = raw?.plugins?.[key]
    if (Array.isArray(instances) && instances.length > 0) {
      inst = instances[0]
      break
    }
  }
  if (!inst) return null

  const installPath = inst?.installPath
  if (typeof installPath !== 'string' || !installPath) return null

  // companion.mjs is always at <installPath>/scripts/<vendor>-companion.mjs
  const companionPath = join(installPath, 'scripts', `${vendor}-companion.mjs`)
  if (!existsSync(companionPath)) return null

  const version = typeof inst?.version === 'string' ? inst.version : 'unknown'

  return { vendor, installPath, companionPath, version }
}

// ---------------------------------------------------------------------------
// Shell quoting (POSIX, works in Git Bash on Win + bash on POSIX)
// ---------------------------------------------------------------------------

/**
 * POSIX shell single-quote escape. Wraps `s` in single quotes and converts
 * any embedded `'` to `'\''` (close quote, escape literal quote, reopen).
 *
 * Example:
 *   shellQuotePosix("don't")  →  'don'\''t'
 *   shellQuotePosix("$VAR")   →  '$VAR'         (literal, no expansion)
 *   shellQuotePosix(`a"b`)    →  'a"b'          (double quote needs no escape)
 *   shellQuotePosix("/path/with spaces")  →  '/path/with spaces'
 */
export function shellQuotePosix(s: string): string {
  return `'${s.replace(/'/g, '\'\\\'\'')}'`
}

// ---------------------------------------------------------------------------
// Command builder
// ---------------------------------------------------------------------------

/**
 * Default helper script path: `~/.claude/.ccg/scripts/ccgx-call-plugin.mjs`.
 *
 * Uses POSIX-style join so the rendered Bash command works in Git Bash on
 * Windows + bash on POSIX without backslash escape concerns. The single-quoted
 * path will be passed verbatim to Node which handles both forms on Windows.
 */
function defaultHelperPath(homeDir: string): string {
  // Normalize backslash homeDir input to forward slashes for POSIX consistency.
  const normalized = homeDir.replace(/\\/g, '/')
  return joinPosix(normalized, '.claude', '.ccg', 'scripts', 'ccgx-call-plugin.mjs')
}

/**
 * Build the helper-invocation Bash command. Output is the EXACT literal
 * string the LLM should run (with `--prompt-file <path>` appended after
 * writing prompt to a tmpfile).
 *
 * Example output (codex, jsonOutput=true):
 *   node 'C:\Users\X\.claude\.ccg\scripts\ccgx-call-plugin.mjs' codex --json
 *
 * The LLM workflow consuming this is:
 *   1. Write prompt body to a tmpfile (via Write tool)
 *   2. Append `--prompt-file <tmpfile>` and run via Bash:
 *      Bash({ command: "<placeholder> --prompt-file /tmp/ccg-codex-X.txt" })
 *   3. Parse JSON from stdout
 *
 * No shell escape, no heredoc, no path glob — Helper handles everything.
 */
export function buildBashCommand(
  _loc: CompanionLocation,
  options: BuildBashCommandOptions = {},
): string {
  const jsonOutput = options.jsonOutput ?? true
  const homeDir = options.homeDir ?? homedir()
  const helperPath = options.helperPath ?? defaultHelperPath(homeDir)
  const quotedHelper = shellQuotePosix(helperPath)
  const vendor = _loc.vendor
  const jsonFlag = jsonOutput ? ' --json' : ''
  return `node ${quotedHelper} ${vendor}${jsonFlag}`
}

// ---------------------------------------------------------------------------
// Fallback when plugin not installed at install time
// ---------------------------------------------------------------------------

/**
 * Emit a Bash command that surfaces a clear error if the plugin is not
 * installed at install time. This way the LLM gets a helpful diagnostic
 * instead of a silently broken command.
 */
export function buildPluginMissingFallback(vendor: Vendor): string {
  const { marketplace, key } = VENDOR_PRIMARY_INSTALL[vendor]
  return [
    `# CCG: ${vendor} plugin not installed at CCG install time.`,
    `# Install with:`,
    `#   claude plugin marketplace add ${marketplace}`,
    `#   claude plugin install ${key}`,
    `# Then re-run: npx ccgx-workflow init --skip-prompt --skip-mcp`,
    `echo 'CCG: ${vendor} plugin not available' >&2 && exit 1`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Top-level resolver — used by installer-template.ts
// ---------------------------------------------------------------------------

/**
 * Resolve a single placeholder to its rendered Bash command. If the plugin
 * is not installed, returns a clear fallback error command that surfaces
 * the issue at runtime instead of silently breaking.
 *
 * Used by `injectConfigVariables` to substitute placeholders like:
 *   {{CODEX_BASH_TASK}}    → rendered command for codex
 *   {{GEMINI_BASH_TASK}}   → rendered command for gemini
 */
export function resolvePluginBashCommand(
  vendor: Vendor,
  options: BuildBashCommandOptions = {},
  homeDir?: string,
): string {
  const loc = discoverCompanion(vendor, homeDir)
  if (!loc) return buildPluginMissingFallback(vendor)
  return buildBashCommand(loc, { ...options, homeDir: homeDir ?? options.homeDir })
}
