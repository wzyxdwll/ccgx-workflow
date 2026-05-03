import { describe, expect, it } from 'vitest'
import { createDefaultConfig, createDefaultRouting } from '../config'

describe('createDefaultRouting', () => {
  it('returns gemini as frontend primary', () => {
    const routing = createDefaultRouting()
    expect(routing.frontend.primary).toBe('gemini')
    expect(routing.frontend.models).toEqual(['gemini'])
  })

  it('returns codex as backend primary', () => {
    const routing = createDefaultRouting()
    expect(routing.backend.primary).toBe('codex')
    expect(routing.backend.models).toEqual(['codex'])
  })

  it('returns both models for review', () => {
    const routing = createDefaultRouting()
    expect(routing.review.models).toEqual(['codex', 'gemini'])
    expect(routing.review.strategy).toBe('parallel')
  })

  it('defaults to smart mode', () => {
    const routing = createDefaultRouting()
    expect(routing.mode).toBe('smart')
  })
})

describe('createDefaultConfig', () => {
  const baseOptions = {
    language: 'zh-CN' as const,
    routing: createDefaultRouting(),
    installedWorkflows: ['workflow', 'plan'],
  }

  it('sets version from package.json', () => {
    const config = createDefaultConfig(baseOptions)
    // version should be a semver string
    expect(config.general.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('sets language correctly', () => {
    const config = createDefaultConfig(baseOptions)
    expect(config.general.language).toBe('zh-CN')
  })

  it('sets createdAt as ISO string', () => {
    const config = createDefaultConfig(baseOptions)
    // Should parse without error
    expect(() => new Date(config.general.createdAt)).not.toThrow()
    expect(new Date(config.general.createdAt).toISOString()).toBe(config.general.createdAt)
  })

  it('stores installed workflows', () => {
    const config = createDefaultConfig(baseOptions)
    expect(config.workflows.installed).toEqual(['workflow', 'plan'])
  })

  it('defaults mcpProvider to ace-tool', () => {
    const config = createDefaultConfig(baseOptions)
    expect(config.mcp.provider).toBe('ace-tool')
  })

  it('respects custom mcpProvider', () => {
    const config = createDefaultConfig({ ...baseOptions, mcpProvider: 'contextweaver' })
    expect(config.mcp.provider).toBe('contextweaver')
  })

  it('defaults liteMode to false', () => {
    const config = createDefaultConfig(baseOptions)
    expect(config.performance?.liteMode).toBe(false)
  })

  it('respects liteMode = true', () => {
    const config = createDefaultConfig({ ...baseOptions, liteMode: true })
    expect(config.performance?.liteMode).toBe(true)
  })

  it('sets paths with home directory', () => {
    const config = createDefaultConfig(baseOptions)
    expect(config.paths.commands).toContain('.claude')
    expect(config.paths.prompts).toContain('.ccg')
    expect(config.paths.backup).toContain('.ccg')
  })

  it('preserves routing config exactly', () => {
    const routing = createDefaultRouting()
    const config = createDefaultConfig({ ...baseOptions, routing })
    expect(config.routing).toEqual(routing)
  })
})
