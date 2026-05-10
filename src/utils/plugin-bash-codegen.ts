/**
 * Plugin Bash Codegen — install-time render of literal Bash command strings
 * for cross-vendor plugin invocation (codex / gemini companion scripts).
 *
 * Why this exists (1.0.4 design after codex audit):
 *   Templates are static prompt text injected to LLM at runtime. Any "helper
 *   function call" written in templates is just pseudo-code the LLM must
 *   interpret — it has to mentally fill in opts/defaults, leading to flag
 *   drift bugs (same family as v4.4.1's 195-occurrence wrong agent name).
 *
 *   Solution: at install time, resolve plugin install paths from the canonical
 *   plugin SSoT (`~/.claude/plugins/installed_plugins.json`) and emit
 *   FULLY-RENDERED literal Bash command strings into templates via the
 *   existing `{{...}}` placeholder system. LLM sees a copy-paste-ready
 *   command, not a function signature it has to interpret.
 *
 *   Key design decisions:
 *   - Use the plugin SSoT (installed_plugins.json), NOT `ls .../companion.mjs
 *     | head -1` glob hacks (multi-version cache breaks the latter).
 *   - Use heredoc-with-quoted-EOF for prompt body so LLM never has to think
 *     about shell-escaping (critical: prompt may contain $, ', ", \, etc).
 *   - POSIX-only command form (works in Git Bash on Windows + bash on POSIX);
 *     Bash tool in Claude Code uses Git Bash on Windows by default.
 *   - Plugin missing at install time → emit a clear failure marker that
 *     surfaces a helpful error if the LLM tries to use the path.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
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
  /** Placeholder string LLM substitutes with actual prompt body. Default: '%PROMPT%'. */
  promptPlaceholder?: string
  /** Heredoc delimiter. Default: 'CCG_PROMPT_EOF' (collision-resistant). */
  heredocDelimiter?: string
}

// ---------------------------------------------------------------------------
// Plugin name → marketplace key (the keys used in installed_plugins.json)
// ---------------------------------------------------------------------------

const VENDOR_MARKETPLACE_KEYS: Record<Vendor, string> = {
  codex: 'codex@openai-codex',
  gemini: 'gemini@google-gemini',
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

  const key = VENDOR_MARKETPLACE_KEYS[vendor]
  const instances = raw?.plugins?.[key]
  if (!Array.isArray(instances) || instances.length === 0) return null

  const inst = instances[0]
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
 * Build a literal Bash command string for invoking the companion's `task`
 * subcommand. The output is shell-safe and uses heredoc-with-quoted-delimiter
 * so the prompt body NEVER needs LLM-side shell-escaping.
 *
 * Example output (codex, jsonOutput=true):
 *   node 'C:\Users\X\.claude\plugins\cache\openai-codex\codex\1.0.4\scripts\codex-companion.mjs' task --json -p "$(cat <<'CCG_PROMPT_EOF'
 *   %PROMPT%
 *   CCG_PROMPT_EOF
 *   )"
 *
 * The LLM consuming this template only needs to:
 *   1. Copy the entire command verbatim
 *   2. Replace %PROMPT% with the actual prompt body (no escaping needed —
 *      the heredoc's single-quoted delimiter guarantees literal interpretation)
 */
export function buildBashCommand(
  loc: CompanionLocation,
  options: BuildBashCommandOptions = {},
): string {
  const jsonOutput = options.jsonOutput ?? true
  const promptPlaceholder = options.promptPlaceholder ?? '%PROMPT%'
  const heredocDelimiter = options.heredocDelimiter ?? 'CCG_PROMPT_EOF'

  const quotedPath = shellQuotePosix(loc.companionPath)
  const flags = jsonOutput ? '--json' : ''

  // Heredoc form: -p "$(cat <<'EOF' ... EOF)" — the single-quoted EOF
  // delimiter prevents any shell expansion inside the heredoc body.
  // Prompt body is treated as a raw literal.
  return [
    `node ${quotedPath} task ${flags}-p "$(cat <<'${heredocDelimiter}'`,
    promptPlaceholder,
    heredocDelimiter,
    `)"`,
  ].join('\n').replace(/ -p/, ' -p').replace(/  +/g, ' ').trimEnd()
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
  const key = VENDOR_MARKETPLACE_KEYS[vendor]
  return [
    `# CCG: ${vendor} plugin (${key}) not installed at CCG install time.`,
    `# Install with: claude plugin install ${key}`,
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
  return buildBashCommand(loc, options)
}
