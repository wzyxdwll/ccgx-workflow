// ═══════════════════════════════════════════════════════
// Hook installer (v3.0.0+)
//
// Installs the Context Monitor + Statusline hooks adapted from GSD.
//
//   ccg-statusline.js     — statusLine.command writes context metrics
//                            to {tmpdir}/claude-ctx-{session_id}.json
//   ccg-context-monitor.js — PostToolUse reads metrics, injects warnings
//                             when remaining context drops below 35%/25%
//
// The two hooks form a producer/consumer pair: the statusline produces
// the bridge file on every render, the monitor consumes it after each
// tool use. This makes the AGENT itself aware of context pressure — not
// just the user looking at the statusbar.
//
// Settings.json patching is conservative:
//   • PostToolUse: registered idempotently; matched by command substring
//   • statusLine: only set when not already configured (preserves user choice)
//   • Uninstall: removes hook files and any ccg-* references from settings
// ═══════════════════════════════════════════════════════

import fs from 'fs-extra'
import { join } from 'pathe'

interface HookContext {
  installDir: string
  templateDir: string
  errors: string[]
}

/**
 * Hook scripts shipped under templates/hooks/. Filenames are also the
 * sentinel substrings used to find/clean entries in settings.json.
 */
const HOOK_FILES = [
  'ccg-context-monitor.js',
  'ccg-statusline.js',
  'ccg-session-state.cjs',
] as const

const POST_TOOL_MATCHER = 'Bash|Edit|Write|MultiEdit|Agent|Task'
const POST_TOOL_TIMEOUT_SEC = 10
// SessionStart fires once per session before any tool use, so a slightly higher
// timeout is safe and avoids losing the injection on a slow disk read.
const SESSION_START_TIMEOUT_SEC = 15

/**
 * Build the platform-appropriate `node <script>` command. Quotes the path
 * so spaces in ~/.claude (e.g. Windows usernames with spaces) survive.
 */
function buildHookCommand(hookFilePath: string): string {
  return `node "${hookFilePath}"`
}

/**
 * Copy templates/hooks/*.js → ~/.claude/hooks/*.js. Returns count of
 * files actually written. Always overwrites — hook scripts are owned by
 * the installer (no user-edit preservation).
 */
export async function copyHookFiles(ctx: HookContext): Promise<number> {
  const srcDir = join(ctx.templateDir, 'hooks')
  const destDir = join(ctx.installDir, 'hooks')

  if (!(await fs.pathExists(srcDir))) {
    ctx.errors.push(`Hooks template directory not found: ${srcDir}`)
    return 0
  }

  await fs.ensureDir(destDir)

  let written = 0
  for (const file of HOOK_FILES) {
    const src = join(srcDir, file)
    const dest = join(destDir, file)
    if (!(await fs.pathExists(src))) {
      ctx.errors.push(`Hook source missing: ${src}`)
      continue
    }
    try {
      await fs.copy(src, dest, { overwrite: true })
      // Unix executable bit so `node script.js` works even if user invokes it directly.
      if (process.platform !== 'win32') {
        await fs.chmod(dest, 0o755)
      }
      written++
    }
    catch (err) {
      ctx.errors.push(`Failed to copy hook ${file}: ${err}`)
    }
  }
  return written
}

/**
 * Idempotently register the context-monitor hook in settings.json under
 * PostToolUse. If an entry already references ccg-context-monitor, leaves
 * it untouched. If statusLine.command is unset, points it at ccg-statusline.
 *
 * Failure here is non-fatal — copyHookFiles having succeeded means the
 * scripts exist and a user can wire them up manually if needed.
 */
export async function patchSettingsJson(ctx: HookContext): Promise<void> {
  const settingsPath = join(ctx.installDir, 'settings.json')
  const hooksDir = join(ctx.installDir, 'hooks')
  const monitorPath = join(hooksDir, 'ccg-context-monitor.js')
  const statuslinePath = join(hooksDir, 'ccg-statusline.js')
  const sessionStatePath = join(hooksDir, 'ccg-session-state.cjs')

  let settings: Record<string, any> = {}
  if (await fs.pathExists(settingsPath)) {
    try {
      settings = await fs.readJSON(settingsPath)
    }
    catch (err) {
      // Malformed JSON (e.g. user added comments) — skip without clobbering.
      ctx.errors.push(`Skipping hook registration: settings.json could not be parsed (${err})`)
      return
    }
  }

  let modified = false

  // ── PostToolUse: ccg-context-monitor.js ──
  if (await fs.pathExists(monitorPath)) {
    if (!settings.hooks) settings.hooks = {}
    if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = []

    const alreadyRegistered = settings.hooks.PostToolUse.some((entry: any) =>
      entry?.hooks?.some((h: any) => typeof h?.command === 'string' && h.command.includes('ccg-context-monitor')),
    )

    if (!alreadyRegistered) {
      settings.hooks.PostToolUse.push({
        matcher: POST_TOOL_MATCHER,
        hooks: [
          {
            type: 'command',
            command: buildHookCommand(monitorPath),
            timeout: POST_TOOL_TIMEOUT_SEC,
          },
        ],
      })
      modified = true
    }
  }

  // ── SessionStart: ccg-session-state.js ──
  // Auto-injects CCG project memory (.ccg/roadmap.md head + active phase
  // SUMMARY.md frontmatter) into a fresh session, so /clear or new windows
  // do not lose the resume context. Idempotent by command substring.
  if (await fs.pathExists(sessionStatePath)) {
    if (!settings.hooks) settings.hooks = {}
    if (!Array.isArray(settings.hooks.SessionStart)) settings.hooks.SessionStart = []

    const alreadyRegistered = settings.hooks.SessionStart.some((entry: any) =>
      entry?.hooks?.some((h: any) => typeof h?.command === 'string' && h.command.includes('ccg-session-state')),
    )

    if (!alreadyRegistered) {
      settings.hooks.SessionStart.push({
        // SessionStart entries do not require a tool matcher; we still emit a
        // matcher field for schema parity with PostToolUse so settings.json
        // stays uniformly readable. Empty string == "match anything".
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: buildHookCommand(sessionStatePath),
            timeout: SESSION_START_TIMEOUT_SEC,
          },
        ],
      })
      modified = true
    }
  }

  // ── statusLine: ccg-statusline.js (only if user hasn't set one) ──
  if (await fs.pathExists(statuslinePath)) {
    const existing = settings.statusLine?.command
    if (!existing) {
      settings.statusLine = {
        type: 'command',
        command: buildHookCommand(statuslinePath),
        padding: 0,
      }
      modified = true
    }
    // If user already has a custom statusLine, leave it alone — they
    // forfeit the agent-facing context warnings unless they wire up
    // ccg-statusline.js themselves, but their config is preserved.
  }

  if (modified) {
    try {
      await fs.writeJSON(settingsPath, settings, { spaces: 2 })
    }
    catch (err) {
      ctx.errors.push(`Failed to write settings.json: ${err}`)
    }
  }
}

/**
 * Public install entry point. Copies hook files then patches settings.json.
 * Push errors to ctx.errors but never throw — hook install is non-fatal.
 */
export async function installHooks(ctx: HookContext): Promise<{ installed: number }> {
  const installed = await copyHookFiles(ctx)
  if (installed > 0) {
    await patchSettingsJson(ctx)
  }
  return { installed }
}

/**
 * Uninstall: remove hook files and strip ccg-* references from settings.json.
 * Returns count of hook files removed.
 */
export async function uninstallHooks(installDir: string): Promise<{ removed: number, errors: string[] }> {
  const errors: string[] = []
  let removed = 0

  // 1. Remove hook script files
  const hooksDir = join(installDir, 'hooks')
  for (const file of HOOK_FILES) {
    const filePath = join(hooksDir, file)
    if (await fs.pathExists(filePath)) {
      try {
        await fs.remove(filePath)
        removed++
      }
      catch (err) {
        errors.push(`Failed to remove ${file}: ${err}`)
      }
    }
  }

  // 2. Clean up settings.json — strip any ccg-* hook references
  const settingsPath = join(installDir, 'settings.json')
  if (await fs.pathExists(settingsPath)) {
    let settings: Record<string, any>
    try {
      settings = await fs.readJSON(settingsPath)
    }
    catch {
      return { removed, errors }
    }

    let modified = false

    // Strip PostToolUse entries that reference ccg-context-monitor
    if (Array.isArray(settings.hooks?.PostToolUse)) {
      const before = settings.hooks.PostToolUse.length
      settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter((entry: any) => {
        const hasCcg = entry?.hooks?.some(
          (h: any) => typeof h?.command === 'string' && h.command.includes('ccg-context-monitor'),
        )
        return !hasCcg
      })
      if (settings.hooks.PostToolUse.length !== before) modified = true
      if (settings.hooks.PostToolUse.length === 0) {
        delete settings.hooks.PostToolUse
        modified = true
      }
      if (settings.hooks && Object.keys(settings.hooks).length === 0) {
        delete settings.hooks
        modified = true
      }
    }

    // Strip SessionStart entries that reference ccg-session-state
    if (Array.isArray(settings.hooks?.SessionStart)) {
      const before = settings.hooks.SessionStart.length
      settings.hooks.SessionStart = settings.hooks.SessionStart.filter((entry: any) => {
        const hasCcg = entry?.hooks?.some(
          (h: any) => typeof h?.command === 'string' && h.command.includes('ccg-session-state'),
        )
        return !hasCcg
      })
      if (settings.hooks.SessionStart.length !== before) modified = true
      if (settings.hooks.SessionStart.length === 0) {
        delete settings.hooks.SessionStart
        modified = true
      }
      if (settings.hooks && Object.keys(settings.hooks).length === 0) {
        delete settings.hooks
        modified = true
      }
    }

    // Strip statusLine if it points at our script
    if (typeof settings.statusLine?.command === 'string'
      && settings.statusLine.command.includes('ccg-statusline')) {
      delete settings.statusLine
      modified = true
    }

    if (modified) {
      try {
        await fs.writeJSON(settingsPath, settings, { spaces: 2 })
      }
      catch (err) {
        errors.push(`Failed to write settings.json during uninstall: ${err}`)
      }
    }
  }

  return { removed, errors }
}
