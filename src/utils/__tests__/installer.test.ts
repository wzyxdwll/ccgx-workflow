import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'fs-extra'
import { getAllCommandIds, getWorkflowById, getWorkflowConfigs, injectConfigVariables, installWorkflows, uninstallWorkflows } from '../installer'

// Helper: find package root
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
const TEMPLATES_DIR = join(PACKAGE_ROOT, 'templates', 'commands')

// ─────────────────────────────────────────────────────────────
// A. Workflow registry consistency
// ─────────────────────────────────────────────────────────────
describe('workflow registry', () => {
  it('getAllCommandIds returns at least 20 commands', () => {
    const ids = getAllCommandIds()
    expect(ids.length).toBeGreaterThanOrEqual(20)
  })

  it('every command ID has a matching template file', () => {
    const ids = getAllCommandIds()
    for (const id of ids) {
      const workflow = getWorkflowById(id)
      expect(workflow, `workflow config missing for: ${id}`).toBeDefined()
      for (const cmd of workflow!.commands) {
        const templatePath = join(TEMPLATES_DIR, `${cmd}.md`)
        expect(
          fs.existsSync(templatePath),
          `template missing: templates/commands/${cmd}.md (from workflow "${id}")`,
        ).toBe(true)
      }
    }
  })

  it('every template file has a matching workflow config', () => {
    const templateFiles = readdirSync(TEMPLATES_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace('.md', ''))
    const allCommands = getAllCommandIds()
      .flatMap(id => getWorkflowById(id)!.commands)

    for (const template of templateFiles) {
      expect(
        allCommands.includes(template),
        `template "${template}.md" has no workflow config`,
      ).toBe(true)
    }
  })

  it('getWorkflowConfigs returns sorted by order', () => {
    const configs = getWorkflowConfigs()
    for (let i = 1; i < configs.length; i++) {
      expect(configs[i].order).toBeGreaterThanOrEqual(configs[i - 1].order)
    }
  })

  it('all workflows have both name and nameEn', () => {
    const configs = getWorkflowConfigs()
    for (const config of configs) {
      expect(config.name, `${config.id} missing name`).toBeTruthy()
      expect(config.nameEn, `${config.id} missing nameEn`).toBeTruthy()
    }
  })

  it('all workflow IDs are unique', () => {
    const ids = getAllCommandIds()
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('getWorkflowById returns undefined for unknown id', () => {
    expect(getWorkflowById('nonexistent')).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────
// B. injectConfigVariables — routing & liteMode
// ─────────────────────────────────────────────────────────────
describe('injectConfigVariables — routing variables', () => {
  it('injects frontend primary model', () => {
    const input = 'primary: {{FRONTEND_PRIMARY}}'
    const result = injectConfigVariables(input, {
      routing: { frontend: { models: ['gemini'], primary: 'gemini' } },
    })
    expect(result).toBe('primary: gemini')
  })

  it('injects backend primary model', () => {
    const input = 'primary: {{BACKEND_PRIMARY}}'
    const result = injectConfigVariables(input, {
      routing: { backend: { models: ['codex'], primary: 'codex' } },
    })
    expect(result).toBe('primary: codex')
  })

  it('injects frontend models as JSON', () => {
    const input = 'models: {{FRONTEND_MODELS}}'
    const result = injectConfigVariables(input, {
      routing: { frontend: { models: ['gemini', 'claude'] } },
    })
    expect(result).toBe('models: ["gemini","claude"]')
  })

  it('injects review models', () => {
    const input = 'review: {{REVIEW_MODELS}}'
    const result = injectConfigVariables(input, {
      routing: { review: { models: ['codex', 'gemini'] } },
    })
    expect(result).toBe('review: ["codex","gemini"]')
  })

  it('injects routing mode', () => {
    const input = 'mode: {{ROUTING_MODE}}'
    const result = injectConfigVariables(input, {
      routing: { mode: 'smart' },
    })
    expect(result).toBe('mode: smart')
  })

  it('defaults to standard routing when not specified', () => {
    const input = '{{FRONTEND_PRIMARY}} / {{BACKEND_PRIMARY}}'
    const result = injectConfigVariables(input, {})
    expect(result).toBe('gemini / codex')
  })
})

describe('injectConfigVariables — liteMode', () => {
  it('injects --lite flag when liteMode is true', () => {
    const input = 'codeagent-wrapper {{LITE_MODE_FLAG}}--backend codex'
    const result = injectConfigVariables(input, { liteMode: true })
    expect(result).toBe('codeagent-wrapper --lite --backend codex')
  })

  it('injects empty string when liteMode is false', () => {
    const input = 'codeagent-wrapper {{LITE_MODE_FLAG}}--backend codex'
    const result = injectConfigVariables(input, { liteMode: false })
    expect(result).toBe('codeagent-wrapper --backend codex')
  })

  it('injects empty string when liteMode is not specified', () => {
    const input = 'codeagent-wrapper {{LITE_MODE_FLAG}}--backend codex'
    const result = injectConfigVariables(input, {})
    expect(result).toBe('codeagent-wrapper --backend codex')
  })
})

// ─────────────────────────────────────────────────────────────
// C. Template variable completeness
// ─────────────────────────────────────────────────────────────
describe('template variable completeness', () => {
  function collectTemplateFiles(dir: string): string[] {
    const files: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        files.push(...collectTemplateFiles(fullPath))
      }
      else if (entry.name.endsWith('.md')) {
        files.push(fullPath)
      }
    }
    return files
  }

  const allTemplates = collectTemplateFiles(TEMPLATES_DIR)

  it('finds template files', () => {
    expect(allTemplates.length).toBeGreaterThan(0)
  })

  for (const file of allTemplates) {
    const relativePath = file.replace(PACKAGE_ROOT + '/', '')

    it(`${relativePath}: no unprocessed {{variables}} after full injection`, () => {
      const content = readFileSync(file, 'utf-8')
      const result = injectConfigVariables(content, {
        routing: {
          mode: 'smart',
          frontend: { models: ['gemini'], primary: 'gemini' },
          backend: { models: ['codex'], primary: 'codex' },
          review: { models: ['codex', 'gemini'] },
        },
        liteMode: false,
        mcpProvider: 'ace-tool',
      })

      // Find any remaining {{ }} template variables
      const remaining = result.match(/\{\{[A-Z_]+\}\}/g) || []
      // Filter out known non-CCG variables (user-facing placeholders like {{项目路径}})
      const ccgVars = remaining.filter(v =>
        !v.includes('项目') && !v.includes('相关') && !v.includes('WORKDIR'),
      )
      expect(ccgVars, `unprocessed variables in ${relativePath}: ${ccgVars.join(', ')}`).toEqual([])
    })
  }
})

// ─────────────────────────────────────────────────────────────
// D. installWorkflows E2E — contextweaver provider
// ─────────────────────────────────────────────────────────────
describe('installWorkflows E2E — mcpProvider="contextweaver"', () => {
  const tmpDir = join(tmpdir(), `ccg-test-cw-${Date.now()}`)

  afterAll(async () => {
    await fs.remove(tmpDir)
  })

  it('installs all workflows without errors', async () => {
    const result = await installWorkflows(getAllCommandIds(), tmpDir, true, {
      mcpProvider: 'contextweaver',
    })
    expect(result.success).toBe(true)
    expect(result.errors).toEqual([])
  }, 30_000)

  it('generated command files contain contextweaver references', async () => {
    const planContent = readFileSync(join(tmpDir, 'commands', 'ccg', 'plan.md'), 'utf-8')
    expect(planContent).toContain('mcp__contextweaver__codebase-retrieval')
    expect(planContent).not.toContain('{{MCP_SEARCH_TOOL}}')
    expect(planContent).not.toContain('mcp__ace-tool')
  })

  it('generated agent planner uses contextweaver in tools', async () => {
    const content = readFileSync(join(tmpDir, 'agents', 'ccg', 'planner.md'), 'utf-8')
    expect(content).toContain('mcp__contextweaver__codebase-retrieval')
  })
})

// ─────────────────────────────────────────────────────────────
// E. uninstallWorkflows E2E
// ─────────────────────────────────────────────────────────────
describe('uninstallWorkflows E2E', () => {
  const tmpDir = join(tmpdir(), `ccg-test-uninstall-${Date.now()}`)

  afterAll(async () => {
    await fs.remove(tmpDir)
  })

  it('installs then uninstalls cleanly', async () => {
    // First install
    const installResult = await installWorkflows(getAllCommandIds(), tmpDir, true, {
      mcpProvider: 'ace-tool',
    })
    expect(installResult.success).toBe(true)

    // Verify files exist
    expect(fs.existsSync(join(tmpDir, 'commands', 'ccg', 'workflow.md'))).toBe(true)

    // Now uninstall
    const uninstallResult = await uninstallWorkflows(tmpDir)
    expect(uninstallResult.success).toBe(true)
    expect(uninstallResult.removedCommands.length).toBeGreaterThan(0)

    // Verify commands directory removed
    expect(fs.existsSync(join(tmpDir, 'commands', 'ccg'))).toBe(false)
  })

  it('uninstall on empty dir succeeds without errors', async () => {
    const emptyDir = join(tmpdir(), `ccg-test-empty-${Date.now()}`)
    const result = await uninstallWorkflows(emptyDir)
    expect(result.success).toBe(true)
    expect(result.errors).toEqual([])
    await fs.remove(emptyDir)
  })
})

// ─────────────────────────────────────────────────────────────
// F. Binary installation
// ─────────────────────────────────────────────────────────────
describe('installWorkflows — binary installation', () => {
  const tmpDir = join(tmpdir(), `ccg-test-bin-${Date.now()}`)

  afterAll(async () => {
    await fs.remove(tmpDir)
  })

  it('installs codeagent-wrapper launcher shim for current platform', async () => {
    const result = await installWorkflows(['workflow'], tmpDir, true, {
      mcpProvider: 'skip',
    })

    expect(result.binInstalled).toBe(true)
    expect(result.binPath).toBeTruthy()

    // v3.0.0+: launcher is .cmd on Windows, plain shell shim on Unix
    const launcherName = process.platform === 'win32' ? 'codeagent-wrapper.cmd' : 'codeagent-wrapper'
    expect(fs.existsSync(join(result.binPath!, launcherName))).toBe(true)

    // mjs script must be present at .ccg/scripts/invoke-model.mjs
    expect(fs.existsSync(join(tmpDir, '.ccg', 'scripts', 'invoke-model.mjs'))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────
// G. Prompts installation
// ─────────────────────────────────────────────────────────────
describe('installWorkflows — prompts installation', () => {
  const tmpDir = join(tmpdir(), `ccg-test-prompts-${Date.now()}`)

  afterAll(async () => {
    await fs.remove(tmpDir)
  })

  it('installs codex, gemini, and claude prompts', async () => {
    const result = await installWorkflows(getAllCommandIds(), tmpDir, true, {
      mcpProvider: 'skip',
    })
    expect(result.success).toBe(true)
    expect(result.installedPrompts.length).toBeGreaterThan(0)

    // Check model directories exist
    const promptsDir = join(tmpDir, '.ccg', 'prompts')
    expect(fs.existsSync(join(promptsDir, 'codex'))).toBe(true)
    expect(fs.existsSync(join(promptsDir, 'gemini'))).toBe(true)

    // Check at least one prompt per model
    const codexFiles = readdirSync(join(promptsDir, 'codex')).filter(f => f.endsWith('.md'))
    const geminiFiles = readdirSync(join(promptsDir, 'gemini')).filter(f => f.endsWith('.md'))
    expect(codexFiles.length).toBeGreaterThanOrEqual(5)
    expect(geminiFiles.length).toBeGreaterThanOrEqual(5)
  })
})

// ─────────────────────────────────────────────────────────────
// I. Hooks installation (context monitor + statusline)
// ─────────────────────────────────────────────────────────────
describe('installWorkflows — hooks installation', () => {
  const tmpDir = join(tmpdir(), `ccg-test-hooks-${Date.now()}`)

  afterAll(async () => {
    await fs.remove(tmpDir)
  })

  it('installs context-monitor + statusline hook files with shebang', async () => {
    const result = await installWorkflows(['workflow'], tmpDir, true, {
      mcpProvider: 'skip',
    })
    expect(result.success).toBe(true)

    const monitorPath = join(tmpDir, 'hooks', 'ccg-context-monitor.js')
    const statuslinePath = join(tmpDir, 'hooks', 'ccg-statusline.js')

    expect(fs.existsSync(monitorPath)).toBe(true)
    expect(fs.existsSync(statuslinePath)).toBe(true)

    // Both must start with shebang so direct invocation works on Unix
    const monitorContent = readFileSync(monitorPath, 'utf-8')
    const statuslineContent = readFileSync(statuslinePath, 'utf-8')
    expect(monitorContent.startsWith('#!/usr/bin/env node')).toBe(true)
    expect(statuslineContent.startsWith('#!/usr/bin/env node')).toBe(true)
  })

  it('registers PostToolUse + statusLine in settings.json', async () => {
    const settingsPath = join(tmpDir, 'settings.json')
    expect(fs.existsSync(settingsPath)).toBe(true)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))

    // PostToolUse entry referencing ccg-context-monitor
    const postToolUse = settings.hooks?.PostToolUse || []
    const hasMonitor = postToolUse.some((entry: any) =>
      entry?.hooks?.some((h: any) => h?.command?.includes('ccg-context-monitor')),
    )
    expect(hasMonitor).toBe(true)

    // statusLine pointing at our script
    expect(settings.statusLine?.command).toContain('ccg-statusline')
  })

  it('uninstall removes hook files and cleans settings.json', async () => {
    // Reuses the install state from previous tests; uninstall in-place.
    const result = await uninstallWorkflows(tmpDir)
    expect(result.success).toBe(true)

    expect(fs.existsSync(join(tmpDir, 'hooks', 'ccg-context-monitor.js'))).toBe(false)
    expect(fs.existsSync(join(tmpDir, 'hooks', 'ccg-statusline.js'))).toBe(false)

    // settings.json: no remaining ccg-* references
    const settingsPath = join(tmpDir, 'settings.json')
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      const stillReferenced = JSON.stringify(settings).includes('ccg-context-monitor')
        || JSON.stringify(settings).includes('ccg-statusline')
      expect(stillReferenced).toBe(false)
    }
  })

  it('does not overwrite a user-provided statusLine', async () => {
    const customDir = join(tmpdir(), `ccg-test-hooks-custom-${Date.now()}`)
    await fs.ensureDir(customDir)
    const settingsPath = join(customDir, 'settings.json')
    await fs.writeJSON(settingsPath, {
      statusLine: { type: 'command', command: 'echo my-custom-statusline' },
    })

    const result = await installWorkflows(['workflow'], customDir, true, {
      mcpProvider: 'skip',
    })
    expect(result.success).toBe(true)

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(settings.statusLine.command).toBe('echo my-custom-statusline')

    await fs.remove(customDir)
  })
})

// ─────────────────────────────────────────────────────────────
// H. Skills namespace isolation (skills/ccg/)
// ─────────────────────────────────────────────────────────────
describe('skills namespace isolation', () => {
  const tmpDir = join(tmpdir(), `ccg-test-skills-${Date.now()}`)

  afterAll(async () => {
    await fs.remove(tmpDir)
  })

  it('installs skills under skills/ccg/ namespace', async () => {
    const result = await installWorkflows(['workflow'], tmpDir, true, {
      mcpProvider: 'skip',
    })
    expect(result.success).toBe(true)
    expect(result.installedSkills).toBeGreaterThanOrEqual(6)

    // Skills must be under skills/ccg/, not skills/ root
    expect(fs.existsSync(join(tmpDir, 'skills', 'ccg', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(join(tmpDir, 'skills', 'ccg', 'tools'))).toBe(true)
    expect(fs.existsSync(join(tmpDir, 'skills', 'ccg', 'orchestration'))).toBe(true)
  })

  it('uninstall only removes skills/ccg/, preserves user skills', async () => {
    // Simulate a user-created skill at skills/my-custom-skill/SKILL.md
    const userSkillDir = join(tmpDir, 'skills', 'my-custom-skill')
    await fs.ensureDir(userSkillDir)
    await fs.writeFile(join(userSkillDir, 'SKILL.md'), '# My Custom Skill')

    // Uninstall CCG
    const result = await uninstallWorkflows(tmpDir)
    expect(result.success).toBe(true)
    expect(result.removedSkills.length).toBeGreaterThan(0)

    // CCG skills gone
    expect(fs.existsSync(join(tmpDir, 'skills', 'ccg'))).toBe(false)

    // User skill preserved!
    expect(fs.existsSync(join(userSkillDir, 'SKILL.md'))).toBe(true)

    // Cleanup
    await fs.remove(userSkillDir)
  })

  it('migrates old v1.7.73 layout to skills/ccg/', { timeout: 30_000 }, async () => {
    const migrateDir = join(tmpdir(), `ccg-test-migrate-${Date.now()}`)

    // Simulate old layout: skills/{tools,orchestration,SKILL.md,run_skill.js}
    const oldSkills = join(migrateDir, 'skills')
    await fs.ensureDir(join(oldSkills, 'tools', 'verify-security'))
    await fs.ensureDir(join(oldSkills, 'orchestration', 'multi-agent'))
    await fs.writeFile(join(oldSkills, 'SKILL.md'), '# Old Root')
    await fs.writeFile(join(oldSkills, 'run_skill.js'), '// old')
    await fs.writeFile(join(oldSkills, 'tools', 'verify-security', 'SKILL.md'), '# Old Security')
    await fs.writeFile(join(oldSkills, 'orchestration', 'multi-agent', 'SKILL.md'), '# Old Multi-Agent')

    // Also add a user skill that should NOT be migrated
    await fs.ensureDir(join(oldSkills, 'brainstorming'))
    await fs.writeFile(join(oldSkills, 'brainstorming', 'SKILL.md'), '# User Brainstorming')

    // Install triggers migration
    const result = await installWorkflows(['workflow'], migrateDir, true, {
      mcpProvider: 'skip',
    })
    expect(result.success).toBe(true)

    // CCG skills moved to skills/ccg/
    expect(fs.existsSync(join(migrateDir, 'skills', 'ccg', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(join(migrateDir, 'skills', 'ccg', 'tools'))).toBe(true)
    expect(fs.existsSync(join(migrateDir, 'skills', 'ccg', 'orchestration'))).toBe(true)

    // User skill untouched at original location
    expect(fs.existsSync(join(migrateDir, 'skills', 'brainstorming', 'SKILL.md'))).toBe(true)

    // Old CCG items no longer at root level
    expect(fs.existsSync(join(migrateDir, 'skills', 'tools'))).toBe(false)
    expect(fs.existsSync(join(migrateDir, 'skills', 'orchestration'))).toBe(false)

    await fs.remove(migrateDir)
  })
})
