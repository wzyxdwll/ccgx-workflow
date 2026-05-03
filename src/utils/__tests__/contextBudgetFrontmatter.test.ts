import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { injectConfigVariables } from '../installer'

function findPackageRoot(): string {
  let dir = import.meta.dirname
  for (let i = 0; i < 10; i++) {
    try {
      readFileSync(join(dir, 'package.json'))
      return dir
    }
    catch {
      dir = join(dir, '..')
    }
  }
  throw new Error('Could not find package root')
}

const PACKAGE_ROOT = findPackageRoot()
const COMMANDS_DIR = join(PACKAGE_ROOT, 'templates', 'commands')

const coreCommandTemplates = [
  'workflow.md',
  'execute.md',
  'team-exec.md',
  'autonomous.md',
] as const

function readTemplateFrontmatter(fileName: string): string {
  const content = readFileSync(join(COMMANDS_DIR, fileName), 'utf-8')
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  expect(match, `${fileName} should start with YAML frontmatter`).not.toBeNull()
  return match![1]
}

describe('context budget frontmatter declarations', () => {
  for (const fileName of coreCommandTemplates) {
    it(`${fileName} declares orchestrator context budget`, () => {
      const frontmatter = readTemplateFrontmatter(fileName)
      expect(frontmatter).toMatch(/^context_budget: orchestrator-15$/m)
    })

    it(`${fileName} requires fresh subagents`, () => {
      const frontmatter = readTemplateFrontmatter(fileName)
      expect(frontmatter).toMatch(/^subagent_freshness: required$/m)
    })
  }
})

describe('injectConfigVariables preserves context budget frontmatter', () => {
  it('keeps both fields unchanged in custom content', () => {
    const input = [
      '---',
      'description: test command',
      'context_budget: orchestrator-15',
      'subagent_freshness: required',
      '---',
      'Run {{MCP_SEARCH_TOOL}} with {{MCP_SEARCH_PARAM}}.',
    ].join('\n')

    const result = injectConfigVariables(input, { mcpProvider: 'contextweaver' })

    expect(result).toContain('context_budget: orchestrator-15')
    expect(result).toContain('subagent_freshness: required')
  })

  it('does not rewrite context_budget value while replacing other placeholders', () => {
    const input = 'context_budget: orchestrator-15\nmodels: {{BACKEND_MODELS}}'
    const result = injectConfigVariables(input, {
      routing: { backend: { models: ['codex', 'gemini'] } },
    })

    expect(result).toContain('context_budget: orchestrator-15')
    expect(result).toContain('models: ["codex","gemini"]')
  })

  it('does not rewrite subagent_freshness value in skip MCP mode', () => {
    const input = 'subagent_freshness: required\ntool: `{{MCP_SEARCH_TOOL}}`'
    const result = injectConfigVariables(input, { mcpProvider: 'skip' })

    expect(result).toContain('subagent_freshness: required')
    expect(result).toContain('tool: `Glob + Grep`（MCP 未配置）')
  })
})
