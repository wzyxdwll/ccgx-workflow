/**
 * Unit tests for plugin-bash-codegen.ts (1.0.4 design).
 *
 * Covers:
 *   - discoverCompanion: SSoT-driven plugin path resolution
 *   - shellQuotePosix: POSIX-compliant shell quote (Git Bash + bash)
 *   - buildBashCommand: literal command generation with heredoc safety
 *   - buildPluginMissingFallback: clear error when plugin not installed
 *   - resolvePluginBashCommand: top-level resolver used by installer
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildBashCommand,
  buildPluginMissingFallback,
  discoverCompanion,
  resolvePluginBashCommand,
  shellQuotePosix,
} from '../plugin-bash-codegen'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ccg-codegen-'))
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
})

// Helper: write a fake installed_plugins.json + companion file to tmpHome
function setupFakePlugin(vendor: 'codex' | 'gemini', version: string) {
  const marketplaceKey = vendor === 'codex' ? 'codex@openai-codex' : 'gemini@google-gemini'
  const installPath = join(
    tmpHome,
    '.claude',
    'plugins',
    'cache',
    vendor === 'codex' ? 'openai-codex' : 'google-gemini',
    vendor,
    version,
  )
  const scriptsDir = join(installPath, 'scripts')
  const companionPath = join(scriptsDir, `${vendor}-companion.mjs`)
  mkdirSync(scriptsDir, { recursive: true })
  writeFileSync(companionPath, '// fake companion', 'utf-8')

  const ssotPath = join(tmpHome, '.claude', 'plugins', 'installed_plugins.json')
  mkdirSync(join(tmpHome, '.claude', 'plugins'), { recursive: true })
  writeFileSync(
    ssotPath,
    JSON.stringify({
      version: 2,
      plugins: {
        [marketplaceKey]: [
          {
            scope: 'user',
            installPath,
            version,
            installedAt: '2026-05-10T00:00:00.000Z',
          },
        ],
      },
    }),
    'utf-8',
  )

  return { installPath, companionPath, version }
}

// ---------------------------------------------------------------------------
// shellQuotePosix
// ---------------------------------------------------------------------------

describe('shellQuotePosix', () => {
  it('wraps simple strings in single quotes', () => {
    expect(shellQuotePosix('hello')).toBe(`'hello'`)
  })

  it('escapes embedded single quotes via close-escape-reopen pattern', () => {
    expect(shellQuotePosix(`don't`)).toBe(`'don'\\''t'`)
  })

  it('preserves $ literal (no expansion in single quotes)', () => {
    expect(shellQuotePosix('$VAR')).toBe(`'$VAR'`)
  })

  it('preserves double quote (no escape needed in single-quote context)', () => {
    expect(shellQuotePosix('a"b')).toBe(`'a"b'`)
  })

  it('handles paths with spaces', () => {
    expect(shellQuotePosix('/path/with spaces/file.mjs')).toBe(`'/path/with spaces/file.mjs'`)
  })

  it('handles Windows paths with backslashes (literal preservation)', () => {
    const win = 'C:\\Users\\X\\.claude\\plugins\\cache\\openai-codex\\codex\\1.0.4\\scripts\\codex-companion.mjs'
    expect(shellQuotePosix(win)).toBe(`'${win}'`)
  })

  it('handles strings with multiple single quotes', () => {
    // "it's a 'test'" → 'it'\''s a '\''test'\'''
    expect(shellQuotePosix(`it's a 'test'`)).toBe(`'it'\\''s a '\\''test'\\'''`)
  })
})

// ---------------------------------------------------------------------------
// discoverCompanion
// ---------------------------------------------------------------------------

describe('discoverCompanion', () => {
  it('returns null when installed_plugins.json does not exist', () => {
    expect(discoverCompanion('codex', tmpHome)).toBeNull()
    expect(discoverCompanion('gemini', tmpHome)).toBeNull()
  })

  it('returns null when SSoT JSON is malformed', () => {
    const ssotDir = join(tmpHome, '.claude', 'plugins')
    mkdirSync(ssotDir, { recursive: true })
    writeFileSync(join(ssotDir, 'installed_plugins.json'), '{invalid json', 'utf-8')
    expect(discoverCompanion('codex', tmpHome)).toBeNull()
  })

  it('returns null when vendor key is absent', () => {
    setupFakePlugin('codex', '1.0.4')
    expect(discoverCompanion('gemini', tmpHome)).toBeNull()
  })

  it('returns null when companion file is missing despite SSoT entry', () => {
    const { companionPath } = setupFakePlugin('codex', '1.0.4')
    rmSync(companionPath)
    expect(discoverCompanion('codex', tmpHome)).toBeNull()
  })

  it('discovers codex companion correctly', () => {
    const { companionPath } = setupFakePlugin('codex', '1.0.4')
    const loc = discoverCompanion('codex', tmpHome)
    expect(loc).not.toBeNull()
    expect(loc!.vendor).toBe('codex')
    expect(loc!.companionPath).toBe(companionPath)
    expect(loc!.version).toBe('1.0.4')
  })

  it('discovers gemini companion correctly', () => {
    const { companionPath } = setupFakePlugin('gemini', '1.0.1')
    const loc = discoverCompanion('gemini', tmpHome)
    expect(loc).not.toBeNull()
    expect(loc!.vendor).toBe('gemini')
    expect(loc!.companionPath).toBe(companionPath)
    expect(loc!.version).toBe('1.0.1')
  })

  it('uses installPath from SSoT, not glob — multi-version cache safe', () => {
    // Set up TWO versions; SSoT points to specific one
    setupFakePlugin('codex', '0.9.0')
    const { companionPath: latestCompanion } = setupFakePlugin('codex', '1.0.4')

    // SSoT now points to 1.0.4 (last setup overwrote SSoT). Discovery should
    // pick that specific version, not glob to "first match" or "highest version".
    const loc = discoverCompanion('codex', tmpHome)!
    expect(loc.companionPath).toBe(latestCompanion)
    expect(loc.companionPath).toContain('1.0.4')
  })
})

// ---------------------------------------------------------------------------
// buildBashCommand
// ---------------------------------------------------------------------------

describe('buildBashCommand (1.0.5 helper form)', () => {
  function fakeLoc(vendor: 'codex' | 'gemini') {
    return {
      vendor,
      installPath: '/fake/install',
      companionPath: `/fake/install/scripts/${vendor}-companion.mjs`,
      version: '1.0.0',
    } as const
  }

  it('emits helper invocation with vendor + --json by default', () => {
    const cmd = buildBashCommand(fakeLoc('codex'), { homeDir: '/H' })
    // Helper path quoted (not companion path)
    expect(cmd).toContain(`'/H/.claude/.ccg/scripts/ccgx-call-plugin.mjs'`)
    // Vendor positional arg
    expect(cmd).toContain(' codex')
    // --json by default
    expect(cmd).toContain('--json')
    // Should NOT contain 1.0.4 heredoc artifacts
    expect(cmd).not.toContain('CCG_PROMPT_EOF')
    expect(cmd).not.toContain('%PROMPT%')
    expect(cmd).not.toContain('task -p')
    expect(cmd).not.toContain('cat <<')
    // Should NOT contain companion path (helper resolves it internally)
    expect(cmd).not.toContain('codex-companion.mjs')
  })

  it('omits --json when jsonOutput=false', () => {
    const cmd = buildBashCommand(fakeLoc('codex'), { jsonOutput: false, homeDir: '/H' })
    expect(cmd).not.toContain('--json')
  })

  it('renders gemini vendor', () => {
    const cmd = buildBashCommand(fakeLoc('gemini'), { homeDir: '/H' })
    expect(cmd).toContain(' gemini')
    expect(cmd).not.toContain(' codex')
  })

  it('respects custom helperPath', () => {
    const cmd = buildBashCommand(fakeLoc('codex'), { helperPath: '/custom/helper.mjs' })
    expect(cmd).toContain(`'/custom/helper.mjs'`)
    expect(cmd).not.toContain('ccgx-call-plugin.mjs')
  })

  it('quotes helper path with spaces correctly', () => {
    const cmd = buildBashCommand(fakeLoc('codex'), { helperPath: '/path with spaces/helper.mjs' })
    expect(cmd).toContain(`'/path with spaces/helper.mjs'`)
  })

  it('does NOT include any user prompt content (LLM passes via --prompt-file)', () => {
    // Critical: helper form never embeds prompt body. LLM appends
    //   --prompt-file <tmpfile>  separately after writing prompt to disk.
    const cmd = buildBashCommand(fakeLoc('codex'), { homeDir: '/H' })
    expect(cmd).not.toContain('-p ')
    expect(cmd).not.toContain('--prompt-file')
  })
})

// ---------------------------------------------------------------------------
// buildPluginMissingFallback
// ---------------------------------------------------------------------------

describe('buildPluginMissingFallback', () => {
  it('codex fallback contains marketplace key and exit 1', () => {
    const out = buildPluginMissingFallback('codex')
    expect(out).toContain('codex@openai-codex')
    expect(out).toContain('not installed')
    expect(out).toContain('exit 1')
  })

  it('gemini fallback contains marketplace key and exit 1', () => {
    const out = buildPluginMissingFallback('gemini')
    expect(out).toContain('gemini@google-gemini')
    expect(out).toContain('exit 1')
  })

  it('fallback emits to stderr (matches CCG convention)', () => {
    const out = buildPluginMissingFallback('codex')
    expect(out).toContain('>&2')
  })
})

// ---------------------------------------------------------------------------
// resolvePluginBashCommand (top-level integration)
// ---------------------------------------------------------------------------

describe('resolvePluginBashCommand', () => {
  it('returns helper invocation command when plugin is installed', () => {
    setupFakePlugin('codex', '1.0.4')
    const cmd = resolvePluginBashCommand('codex', {}, tmpHome)
    expect(cmd).toContain('ccgx-call-plugin.mjs')
    expect(cmd).toContain(' codex')
    expect(cmd).toContain('--json')
    expect(cmd).not.toContain('not installed')
    // 1.0.5: never inline companion path nor prompt placeholder
    expect(cmd).not.toContain('codex-companion.mjs')
    expect(cmd).not.toContain('%PROMPT%')
  })

  it('returns fallback when plugin is not installed', () => {
    const cmd = resolvePluginBashCommand('gemini', {}, tmpHome)
    expect(cmd).toContain('not installed')
    expect(cmd).toContain('gemini@google-gemini')
    expect(cmd).toContain('exit 1')
  })

  it('honors options through to buildBashCommand', () => {
    setupFakePlugin('codex', '1.0.4')
    const cmd = resolvePluginBashCommand('codex', { jsonOutput: false }, tmpHome)
    expect(cmd).not.toContain('--json')
  })
})
