import { describe, expect, it } from 'vitest'
// @ts-expect-error — invoke-model.mjs is a runtime template, no .d.ts
import { lookPath } from '../../../templates/scripts/invoke-model.mjs'

// Windows uses ';' separator and PATHEXT-driven extension resolution.
// We inject env / platform / statFn directly so these tests run on any host OS.

function makeFakeStat(existing: Set<string>) {
  return (full: string) => {
    if (existing.has(full)) {
      return { isFile: () => true } as any
    }
    const err: any = new Error('ENOENT')
    err.code = 'ENOENT'
    throw err
  }
}

const winEnv = (overrides: Record<string, string> = {}) => ({
  PATH: 'C:\\nvm4w\\nodejs;C:\\Windows\\System32',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  ...overrides,
})

describe('lookPath (Windows PATHEXT resolution)', () => {
  it('resolves bare command name to .CMD via PATHEXT', () => {
    const existing = new Set(['C:\\nvm4w\\nodejs\\codex.CMD'])
    const out = lookPath('codex', {
      platform: 'win32',
      env: winEnv(),
      statFn: makeFakeStat(existing),
    })
    expect(out).toBe('C:\\nvm4w\\nodejs\\codex.CMD')
  })

  it('resolves to .EXE when both .EXE and .CMD coexist (PATHEXT order)', () => {
    const existing = new Set([
      'C:\\nvm4w\\nodejs\\node.EXE',
      'C:\\nvm4w\\nodejs\\node.CMD',
    ])
    const out = lookPath('node', {
      platform: 'win32',
      env: winEnv(),
      statFn: makeFakeStat(existing),
    })
    // .EXE comes before .CMD in PATHEXT
    expect(out).toBe('C:\\nvm4w\\nodejs\\node.EXE')
  })

  it('skips extensionless file with same name (would be sh script, not executable on Windows)', () => {
    const existing = new Set([
      'C:\\nvm4w\\nodejs\\codex',         // bash script — must be ignored
      'C:\\nvm4w\\nodejs\\codex.CMD',
    ])
    const out = lookPath('codex', {
      platform: 'win32',
      env: winEnv(),
      statFn: makeFakeStat(existing),
    })
    expect(out).toBe('C:\\nvm4w\\nodejs\\codex.CMD')
  })

  it('returns original cmd when nothing matches (let spawn ENOENT)', () => {
    const out = lookPath('does-not-exist', {
      platform: 'win32',
      env: winEnv(),
      statFn: makeFakeStat(new Set()),
    })
    expect(out).toBe('does-not-exist')
  })

  it('passes through absolute paths unchanged', () => {
    const out = lookPath('C:\\foo\\bar.exe', {
      platform: 'win32',
      env: winEnv(),
      statFn: makeFakeStat(new Set()),
    })
    expect(out).toBe('C:\\foo\\bar.exe')
  })

  it('passes through paths containing separators unchanged', () => {
    expect(lookPath('./local-script', { platform: 'win32', env: winEnv(), statFn: makeFakeStat(new Set()) }))
      .toBe('./local-script')
    expect(lookPath('foo\\bar', { platform: 'win32', env: winEnv(), statFn: makeFakeStat(new Set()) }))
      .toBe('foo\\bar')
  })

  it('searches current directory before PATH (mirrors cmd.exe / Go LookPath)', () => {
    // No file in PATH dirs, but a foo.CMD in cwd-relative resolution.
    const existing = new Set(['foo.CMD'])
    const out = lookPath('foo', {
      platform: 'win32',
      env: winEnv(),
      statFn: makeFakeStat(existing),
    })
    expect(out).toBe('foo.CMD')
  })

  it('honours dotted command name (tries raw form first, then PATHEXT)', () => {
    const existing = new Set(['C:\\nvm4w\\nodejs\\my.tool'])
    const out = lookPath('my.tool', {
      platform: 'win32',
      env: winEnv(),
      statFn: makeFakeStat(existing),
    })
    // 'my.tool' has a dot, so raw form matches before PATHEXT append
    expect(out).toBe('C:\\nvm4w\\nodejs\\my.tool')
  })

  it('falls back to PATHEXT for dotted name when raw form missing', () => {
    const existing = new Set(['C:\\nvm4w\\nodejs\\my.tool.EXE'])
    const out = lookPath('my.tool', {
      platform: 'win32',
      env: winEnv(),
      statFn: makeFakeStat(existing),
    })
    expect(out).toBe('C:\\nvm4w\\nodejs\\my.tool.EXE')
  })

  it('uses Path env var when PATH is missing (Windows env keys are case-insensitive at OS level)', () => {
    const existing = new Set(['C:\\Tools\\codex.CMD'])
    const out = lookPath('codex', {
      platform: 'win32',
      env: { Path: 'C:\\Tools', PATHEXT: '.CMD' },
      statFn: makeFakeStat(existing),
    })
    expect(out).toBe('C:\\Tools\\codex.CMD')
  })
})

describe('lookPath (non-Windows passthrough)', () => {
  it('returns cmd unchanged on linux (spawn handles PATH lookup natively)', () => {
    const out = lookPath('codex', {
      platform: 'linux',
      env: { PATH: '/usr/local/bin:/usr/bin' },
      statFn: () => { throw new Error('should not be called') },
    })
    expect(out).toBe('codex')
  })

  it('returns cmd unchanged on darwin', () => {
    const out = lookPath('node', {
      platform: 'darwin',
      env: { PATH: '/opt/homebrew/bin' },
      statFn: () => { throw new Error('should not be called') },
    })
    expect(out).toBe('node')
  })
})
