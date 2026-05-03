/**
 * Plugin Detection (CCG v4.1 Phase 20).
 *
 * Detects whether the user has installed Claude Code plugins that CCG's
 * 6 core commands prefer over `codeagent-wrapper`:
 *
 *   - codex@openai-codex (provides `Agent(subagent_type="codex:rescue")`)
 *   - gemini@google-gemini (provides `Agent(subagent_type="gemini:rescue")`)
 *
 * Plugins live under `~/.claude/plugins/<plugin-name>/SKILL.md` (or any
 * marker file). The detection here is intentionally lightweight: if a
 * recognizable directory exists with at least one of the plugin's standard
 * marker files, we treat the plugin as installed. Failures are non-fatal —
 * detection returns `false` so that callers fallback to `codeagent-wrapper`.
 *
 * Design principles:
 *   - Pure synchronous fs probe; no spawn / network
 *   - Cross-platform (uses pathe-style `/` joins via `path.join`)
 *   - Never throws on unexpected errors — those map to "not installed"
 *
 * Used by:
 *   - `templates/commands/{plan,execute,analyze,optimize,test,review}.md`
 *     preflight (orchestrator inlines this logic in narrative form)
 *   - `src/utils/challenger-orchestrator.ts` `PluginAvailability` populator
 *
 * Not used by:
 *   - `phase-runner` subagent (engine forbids spawning Agent inside a
 *     subagent — see commit a7cdffd)
 */

import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// v4.2 P21: PluginAvailability 收敛到 multi-model-routing SSoT
import type { PluginAvailability } from './multi-model-routing'
export type { PluginAvailability } from './multi-model-routing'

// ---------------------------------------------------------------------------
// 1. Schema
// ---------------------------------------------------------------------------

/**
 * Plugin slugs CCG cares about for v4.1 codeagent retirement.
 * Must mirror `PluginAdvisor` in `challenger-orchestrator.ts`.
 */
export type PluginName = 'codex' | 'gemini'

/**
 * Detection result for a single plugin.
 */
export interface PluginDetectionResult {
  name: PluginName
  installed: boolean
  /** Absolute path probed (for diagnostic logging) */
  probedPath: string
  /** Reason when `installed: false` */
  reason?: 'missing-dir' | 'missing-marker' | 'fs-error'
}

// ---------------------------------------------------------------------------
// 2. Path helpers
// ---------------------------------------------------------------------------

/**
 * Plugin install root. Each plugin lives in
 * `<root>/<plugin-package>@<vendor>/...`. We search by prefix because
 * vendor suffix can vary (e.g. `codex@openai-codex` vs `codex@anthropic`).
 */
function pluginRoot(home = homedir()): string {
  return join(home, '.claude', 'plugins')
}

/**
 * Marker files that prove a plugin is installed and runnable. We accept
 * any one of these — different plugin authors use different conventions.
 */
const PLUGIN_MARKERS = ['SKILL.md', 'plugin.json', 'package.json', 'manifest.json']

/**
 * Plugin directory name prefixes we recognize. Detection iterates plugin
 * root and matches any subdir that startsWith one of these.
 *
 * This is deliberately permissive: vendors fork/rename packages, and we
 * only need to know "is a codex rescue plugin available". If multiple
 * matching dirs exist, we report installed once any has a valid marker.
 */
const PLUGIN_PREFIXES: Record<PluginName, string[]> = {
  codex: ['codex@', 'codex-rescue@', 'openai-codex@'],
  gemini: ['gemini@', 'gemini-rescue@', 'google-gemini@'],
}

// ---------------------------------------------------------------------------
// 3. Detection
// ---------------------------------------------------------------------------

/**
 * Detect a single plugin by name.
 *
 * Returns `{ installed: false, reason: ... }` for any failure mode rather
 * than throwing. Caller logic (template fallback / orchestrator degrade)
 * only cares about the boolean.
 *
 * `homeDir` parameter exists for tests — production callers omit it.
 */
export function detectPlugin(
  name: PluginName,
  homeDir: string = homedir(),
): PluginDetectionResult {
  const root = pluginRoot(homeDir)
  const probedPath = root

  // Plugin root missing → no plugins installed at all
  if (!existsSync(root)) {
    return { name, installed: false, probedPath, reason: 'missing-dir' }
  }

  let entries: string[] = []
  try {
    // Avoid importing readdirSync at top-level so the test mock layer can
    // override fs cleanly; require here for static-analyzer happiness.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    entries = readdirSync(root)
  } catch {
    return { name, installed: false, probedPath, reason: 'fs-error' }
  }

  const prefixes = PLUGIN_PREFIXES[name]
  for (const entry of entries) {
    const matchesPrefix = prefixes.some((p) => entry.startsWith(p))
    if (!matchesPrefix) continue

    const dir = join(root, entry)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }

    for (const marker of PLUGIN_MARKERS) {
      const markerPath = join(dir, marker)
      if (existsSync(markerPath)) {
        return { name, installed: true, probedPath: dir }
      }
    }
  }

  return { name, installed: false, probedPath, reason: 'missing-marker' }
}

/**
 * Detect both CCG-relevant plugins in one call. Returns the
 * `PluginAvailability` shape consumed by challenger-orchestrator.
 */
export function detectPluginAvailability(
  homeDir: string = homedir(),
): PluginAvailability {
  return {
    codex: detectPlugin('codex', homeDir).installed,
    gemini: detectPlugin('gemini', homeDir).installed,
  }
}

/**
 * Convenience: are *both* plugins installed (default route in v4.1)?
 * When `false`, command templates instruct LLM to fallback to
 * `codeagent-wrapper` for the missing model only (per-model degrade,
 * not all-or-nothing).
 */
export function bothPluginsInstalled(homeDir: string = homedir()): boolean {
  const avail = detectPluginAvailability(homeDir)
  return avail.codex && avail.gemini
}
