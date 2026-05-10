import { describe, expect, it } from 'vitest'

import { isBrokerProcess, isStuck } from '../kill-orphans'

interface ProcShape {
  pid: number
  ageHours: number
  cpuSeconds: number
  cmdLine: string
  category: 'mcp-server' | 'codex-cli' | 'gemini-cli' | 'phase-runner' | 'dev-server' | 'other'
}

function proc(overrides: Partial<ProcShape> = {}): ProcShape {
  return {
    pid: 1234,
    ageHours: 1,
    cpuSeconds: 0,
    cmdLine: '',
    category: 'other',
    ...overrides,
  }
}

describe('isBrokerProcess', () => {
  it('matches gemini acp-broker by cmdline', () => {
    expect(isBrokerProcess(proc({
      cmdLine: 'node ~/.claude/plugins/cache/google-gemini/gemini/1.0.1/scripts/acp-broker.mjs serve --endpoint pipe:...',
    }))).toBe(true)
  })

  it('matches codex app-server-broker', () => {
    expect(isBrokerProcess(proc({
      cmdLine: 'node ~/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/app-server-broker.mjs serve',
    }))).toBe(true)
  })

  it('matches broker-lifecycle helper', () => {
    expect(isBrokerProcess(proc({ cmdLine: 'node lib/broker-lifecycle.mjs' }))).toBe(true)
  })

  it('does NOT match gemini-companion (companion is not a broker)', () => {
    expect(isBrokerProcess(proc({
      cmdLine: 'node ~/.claude/plugins/cache/google-gemini/gemini/1.0.1/scripts/gemini-companion.mjs task -p ...',
    }))).toBe(false)
  })

  it('does NOT match MCP servers', () => {
    expect(isBrokerProcess(proc({
      cmdLine: 'node C:/path/to/context7-mcp/index.js',
    }))).toBe(false)
  })

  it('does NOT match dev servers', () => {
    expect(isBrokerProcess(proc({ cmdLine: 'node node_modules/vite/bin/vite.js' }))).toBe(false)
  })
})

describe('isStuck', () => {
  it('flags broker with high wall + ~0 CPU as stuck', () => {
    // Real signature from dogfood: PID 28184 codex broker, 51min wall, CPU < 1s
    expect(isStuck(proc({
      cmdLine: 'node app-server-broker.mjs serve',
      ageHours: 51 / 60, // 51min
      cpuSeconds: 0.3,
    }))).toBe(true)
  })

  it('does NOT flag broker too young (< 5min)', () => {
    expect(isStuck(proc({
      cmdLine: 'node acp-broker.mjs serve',
      ageHours: 4 / 60, // 4min — too young
      cpuSeconds: 0,
    }))).toBe(false)
  })

  it('does NOT flag actively working broker (high CPU ratio)', () => {
    expect(isStuck(proc({
      cmdLine: 'node acp-broker.mjs serve',
      ageHours: 0.5, // 30min
      cpuSeconds: 600, // 10min CPU on 30min wall = 33% — actively working
    }))).toBe(false)
  })

  it('does NOT flag companion processes even with low CPU + high wall', () => {
    // Companions legitimately spend wall time waiting on remote LLM API
    expect(isStuck(proc({
      cmdLine: 'node gemini-companion.mjs task -p ...',
      ageHours: 1, // 1h
      cpuSeconds: 0.5, // ~0% CPU — looks "stuck" but it's just waiting on API
    }))).toBe(false)
  })

  it('does NOT flag MCP servers idle', () => {
    expect(isStuck(proc({
      cmdLine: 'node context7-mcp/index.js',
      ageHours: 2,
      cpuSeconds: 1,
    }))).toBe(false)
  })

  it('boundary: exactly 5min + exactly 1% CPU is NOT stuck', () => {
    expect(isStuck(proc({
      cmdLine: 'node acp-broker.mjs',
      ageHours: 5 / 60,
      cpuSeconds: 5 * 60 * 0.01, // exactly 1%
    }))).toBe(false)
  })

  it('boundary: 5min + 0.5% CPU IS stuck', () => {
    expect(isStuck(proc({
      cmdLine: 'node acp-broker.mjs',
      ageHours: 6 / 60, // just over 5min so we are past the age gate
      cpuSeconds: 6 * 60 * 0.005, // 0.5%
    }))).toBe(true)
  })
})
