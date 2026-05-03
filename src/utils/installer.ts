import type { InstallResult } from '../types'
import ansis from 'ansis'
import fs from 'fs-extra'
import { basename, join } from 'pathe'
import { getWorkflowById } from './installer-data'
import { installHooks, uninstallHooks } from './installer-hooks'
import { PACKAGE_ROOT, injectConfigVariables, replaceHomePathsInTemplate } from './installer-template'
import { installSkillCommands } from './skill-registry'

// ═══════════════════════════════════════════════════════
// Re-exports — all consumers import from './installer'
// These re-exports preserve backward compatibility.
// ═══════════════════════════════════════════════════════

export {
  getAllCommandIds,
  getWorkflowById,
  getWorkflowConfigs,
  getWorkflowPreset,
  WORKFLOW_PRESETS,
} from './installer-data'
export type { WorkflowPreset } from './installer-data'

export { injectConfigVariables } from './installer-template'

export {
  installAceTool,
  installAceToolRs,
  installContextWeaver,
  installFastContext,
  installMcpServer,
  syncMcpToCodex,
  syncMcpToGemini,
  uninstallAceTool,
  uninstallContextWeaver,
  uninstallFastContext,
  uninstallMcpServer,
} from './installer-mcp'
export type { ContextWeaverConfig } from './installer-mcp'

export {
  removeFastContextPrompt,
  writeFastContextPrompt,
} from './installer-prompt'

export {
  collectInvocableSkills,
  collectSkills,
  parseFrontmatter,
} from './skill-registry'
export type { SkillMeta } from './skill-registry'

// ═══════════════════════════════════════════════════════
// Binary version tracking
// ═══════════════════════════════════════════════════════

/**
 * Expected codeagent-wrapper binary version.
 * Must match the `version` constant in codeagent-wrapper/main.go.
 * When this differs from the installed binary, update triggers re-download.
 */
const EXPECTED_BINARY_VERSION = '5.10.0'

// ═══════════════════════════════════════════════════════
// Install context — shared across sub-functions
// ═══════════════════════════════════════════════════════

interface InstallConfig {
  routing: {
    mode: string
    frontend: { models: string[], primary: string }
    backend: { models: string[], primary: string }
    review: { models: string[] }
    geminiModel?: string
  }
  liteMode: boolean
  mcpProvider: string
  skipImpeccable?: boolean
}

interface InstallContext {
  installDir: string
  force: boolean
  config: InstallConfig
  templateDir: string
  result: InstallResult
}

// ═══════════════════════════════════════════════════════
// Shim launcher install (v3.0.0+)
//
// Replaces the v1.x ~ v2.x Go binary `codeagent-wrapper` (16 MB, cross-compiled
// for 6 platforms, downloaded from GitHub Release with R2 CDN fallback).
//
// New architecture:
//   1. Pure Node.js script invoke-model.mjs (~870 lines) ships in the npm
//      package under templates/scripts/ and is copied at install time to
//      ~/.claude/.ccg/scripts/invoke-model.mjs
//   2. Tiny launcher shim at ~/.claude/bin/codeagent-wrapper (Unix shell) and
//      ~/.claude/bin/codeagent-wrapper.cmd (Windows cmd) forwards to the mjs
//      script via `node`. Templates and permissions.allow keep the
//      ~/.claude/bin/codeagent-wrapper path → zero BC churn for 51 hardcoded
//      template call sites.
//   3. No network at install time. No platform binary matrix. No CI release
//      pipeline tied to ccg-workflow versioning.
//
// The launcher exposes `--version` returning `codeagent-wrapper version 5.10.0`
// (matches EXPECTED_BINARY_VERSION for installer sanity checks).
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// Shared file-copy helper
// ═══════════════════════════════════════════════════════

/**
 * Copy .md templates from srcDir → destDir with optional variable injection.
 * Returns list of installed file stems (filename without .md).
 */
async function copyMdTemplates(
  ctx: InstallContext,
  srcDir: string,
  destDir: string,
  options: { inject?: boolean } = {},
): Promise<string[]> {
  const installed: string[] = []
  if (!(await fs.pathExists(srcDir))) {
    // Log warning — helps diagnose "0 commands installed" issues
    console.error(`[CCG] Template source directory not found: ${srcDir}`)
    return installed
  }

  await fs.ensureDir(destDir)
  const files = await fs.readdir(srcDir)
  for (const file of files) {
    if (!file.endsWith('.md')) continue
    const destFile = join(destDir, file)
    if (ctx.force || !(await fs.pathExists(destFile))) {
      let content = await fs.readFile(join(srcDir, file), 'utf-8')
      if (options.inject) content = injectConfigVariables(content, ctx.config)
      content = replaceHomePathsInTemplate(content, ctx.installDir)
      await fs.writeFile(destFile, content, 'utf-8')
      installed.push(file.replace('.md', ''))
    }
  }
  return installed
}

// ═══════════════════════════════════════════════════════
// Install sub-steps
// ═══════════════════════════════════════════════════════

/**
 * Install slash command .md files from templates/commands/
 */
async function installCommandFiles(ctx: InstallContext, workflowIds: string[]): Promise<void> {
  const commandsDir = join(ctx.installDir, 'commands', 'ccg')

  for (const workflowId of workflowIds) {
    const workflow = getWorkflowById(workflowId)
    if (!workflow) {
      ctx.result.errors.push(`Unknown workflow: ${workflowId}`)
      continue
    }

    for (const cmd of workflow.commands) {
      const srcFile = join(ctx.templateDir, 'commands', `${cmd}.md`)
      const destFile = join(commandsDir, `${cmd}.md`)

      try {
        if (await fs.pathExists(srcFile)) {
          if (ctx.force || !(await fs.pathExists(destFile))) {
            let content = await fs.readFile(srcFile, 'utf-8')
            content = injectConfigVariables(content, ctx.config)
            content = replaceHomePathsInTemplate(content, ctx.installDir)
            await fs.writeFile(destFile, content, 'utf-8')
          }
          // Count as installed whether written or already existing
          ctx.result.installedCommands.push(cmd)
        }
        else {
          const placeholder = `---
description: "${workflow.descriptionEn}"
---

# /ccg:${cmd}

${workflow.description}

> This command is part of CCG multi-model collaboration system.
`
          await fs.writeFile(destFile, placeholder, 'utf-8')
          ctx.result.installedCommands.push(cmd)
        }
      }
      catch (error) {
        ctx.result.errors.push(`Failed to install ${cmd}: ${error}`)
        ctx.result.success = false
      }
    }
  }
}

/**
 * Install agent .md files from templates/commands/agents/
 */
async function installAgentFiles(ctx: InstallContext): Promise<void> {
  try {
    await copyMdTemplates(
      ctx,
      join(ctx.templateDir, 'commands', 'agents'),
      join(ctx.installDir, 'agents', 'ccg'),
      { inject: true },
    )
  }
  catch (error) {
    ctx.result.errors.push(`Failed to install agents: ${error}`)
    ctx.result.success = false
  }
}

/**
 * Install expert prompt .md files from templates/prompts/{codex,gemini,claude}/
 */
async function installPromptFiles(ctx: InstallContext): Promise<void> {
  const promptsTemplateDir = join(ctx.templateDir, 'prompts')
  const promptsDir = join(ctx.installDir, '.ccg', 'prompts')
  if (!(await fs.pathExists(promptsTemplateDir))) {
    ctx.result.errors.push(`Prompts template directory not found: ${promptsTemplateDir}`)
    return
  }

  for (const model of ['codex', 'gemini', 'claude']) {
    try {
      const installed = await copyMdTemplates(
        ctx,
        join(promptsTemplateDir, model),
        join(promptsDir, model),
      )
      for (const name of installed) {
        ctx.result.installedPrompts.push(`${model}/${name}`)
      }
    }
    catch (error) {
      ctx.result.errors.push(`Failed to install ${model} prompts: ${error}`)
      ctx.result.success = false
    }
  }
}

/**
 * Recursively collect skill names (directories containing SKILL.md, excludes root).
 * Used by both install (count) and uninstall (list names).
 */
async function collectSkillNames(dir: string, depth = 0): Promise<string[]> {
  const names: string[] = []
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        names.push(...await collectSkillNames(join(dir, entry.name), depth + 1))
      }
      else if (entry.name === 'SKILL.md' && depth > 0) {
        names.push(basename(dir))
      }
    }
  }
  catch (error) {
    // Only suppress ENOENT (dir not found); log other errors that indicate real problems
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.error(`[CCG] Failed to read skills directory ${dir}: ${code || error}`)
    }
  }
  return names
}

/**
 * Remove a directory and collect .md file stems. Returns [] if dir doesn't exist.
 */
async function removeDirCollectMdNames(dir: string): Promise<string[]> {
  if (!(await fs.pathExists(dir))) return []
  const files = await fs.readdir(dir)
  const names = files.filter(f => f.endsWith('.md')).map(f => f.replace('.md', ''))
  await fs.remove(dir)
  return names
}

/**
 * Install skill files from templates/skills/ → ~/.claude/skills/ccg/
 * Includes v1.7.73 legacy layout migration.
 */
async function installSkillFiles(ctx: InstallContext): Promise<void> {
  const skillsTemplateDir = join(ctx.templateDir, 'skills')
  const skillsDestDir = join(ctx.installDir, 'skills', 'ccg')

  // Report error instead of silently returning when template dir is missing
  if (!(await fs.pathExists(skillsTemplateDir))) {
    ctx.result.errors.push(`Skills template directory not found: ${skillsTemplateDir}`)
    return
  }

  try {
    // Migration: move old v1.7.73 layout into skills/ccg/ namespace
    const oldSkillsRoot = join(ctx.installDir, 'skills')
    const ccgLegacyItems = ['tools', 'orchestration', 'SKILL.md', 'run_skill.js']
    const needsMigration = !await fs.pathExists(skillsDestDir)
      && await fs.pathExists(join(oldSkillsRoot, 'tools'))
    if (needsMigration) {
      await fs.ensureDir(skillsDestDir)
      for (const item of ccgLegacyItems) {
        const oldPath = join(oldSkillsRoot, item)
        const newPath = join(skillsDestDir, item)
        if (await fs.pathExists(oldPath)) {
          try {
            await fs.move(oldPath, newPath, { overwrite: true })
          }
          catch (moveErr) {
            // Windows: file locking can cause move to fail — log but continue
            ctx.result.errors.push(`Skills migration: failed to move ${item}: ${moveErr}`)
          }
        }
      }
    }

    // Recursive copy: preserves full directory tree
    // Always overwrite to ensure fresh install gets all files
    await fs.copy(skillsTemplateDir, skillsDestDir, {
      overwrite: true,
      errorOnExist: false,
    })

    // Post-copy: apply template variable replacement to .md files
    const replacePathsInDir = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          await replacePathsInDir(fullPath)
        }
        else if (entry.name.endsWith('.md')) {
          const content = await fs.readFile(fullPath, 'utf-8')
          const processed = replaceHomePathsInTemplate(content, ctx.installDir)
          if (processed !== content) {
            await fs.writeFile(fullPath, processed, 'utf-8')
          }
        }
      }
    }
    await replacePathsInDir(skillsDestDir)

    // Post-copy validation: verify at least one SKILL.md was actually copied
    const installedSkills = await collectSkillNames(skillsDestDir)
    ctx.result.installedSkills = installedSkills.length

    if (installedSkills.length === 0) {
      ctx.result.errors.push(
        `Skills copy completed but no SKILL.md found in ${skillsDestDir}. `
        + `Possible cause: file locking (antivirus), permission denied, or path too long. `
        + `Try running as administrator or disabling antivirus real-time scanning temporarily.`,
      )
    }
  }
  catch (error) {
    ctx.result.errors.push(`Failed to install skills: ${error}`)
    ctx.result.success = false
  }
}

/**
 * Auto-generate slash commands for user-invocable skills via Skill Registry.
 *
 * Scans templates/skills/ for SKILL.md files with `user-invocable: true` frontmatter,
 * then generates ~/.claude/commands/ccg/{name}.md for each — SKIPPING any name that
 * already exists in installer-data.ts to avoid conflicts with complex multi-model commands.
 */
async function installSkillGeneratedCommands(ctx: InstallContext): Promise<void> {
  const skillsTemplateDir = join(ctx.templateDir, 'skills')
  const skillsInstallDir = join(ctx.installDir, 'skills', 'ccg')
  const commandsDir = join(ctx.installDir, 'commands', 'ccg')

  if (!(await fs.pathExists(skillsTemplateDir))) return

  try {
    // Collect names of commands already installed by installer-data.ts
    const existingCommandNames = new Set<string>()
    const existingFiles = await fs.readdir(commandsDir).catch(() => [] as string[])
    for (const f of existingFiles) {
      if (f.endsWith('.md')) {
        existingCommandNames.add(basename(f, '.md'))
      }
    }

    const skipCategories: import('./skill-registry').SkillCategory[] = []
    if (ctx.config.skipImpeccable) {
      skipCategories.push('impeccable')
    }

    const generated = await installSkillCommands(
      skillsTemplateDir,
      skillsInstallDir,
      commandsDir,
      existingCommandNames,
      skipCategories,
    )

    if (generated.length > 0) {
      ctx.result.installedCommands.push(...generated)
      ctx.result.installedSkillCommands = generated.length
    }
  }
  catch (error) {
    // Non-fatal: skill command generation failure shouldn't block installation
    ctx.result.errors.push(`Skill Registry command generation warning: ${error}`)
  }
}

/**
 * Install rule .md files from templates/rules/ → ~/.claude/rules/
 */
async function installRuleFiles(ctx: InstallContext): Promise<void> {
  try {
    const installed = await copyMdTemplates(
      ctx,
      join(ctx.templateDir, 'rules'),
      join(ctx.installDir, 'rules'),
    )
    if (installed.length > 0) ctx.result.installedRules = true
  }
  catch (error) {
    ctx.result.errors.push(`Failed to install rules: ${error}`)
  }
}

/**
 * Install context-monitor + statusline hooks (v3.0.0+ killer feature).
 * Copies templates/hooks/*.js → ~/.claude/hooks/ and patches settings.json
 * to register the PostToolUse hook + statusLine command. Non-fatal on
 * failure — pushes errors to ctx.result.errors without flipping success.
 */
async function installHookFiles(ctx: InstallContext): Promise<void> {
  try {
    const hookCtx = {
      installDir: ctx.installDir,
      templateDir: ctx.templateDir,
      errors: [] as string[],
    }
    await installHooks(hookCtx)
    if (hookCtx.errors.length > 0) {
      ctx.result.errors.push(...hookCtx.errors.map(e => `Hook install: ${e}`))
    }
  }
  catch (error) {
    // Non-fatal: hooks are an enhancement, not a hard dependency
    ctx.result.errors.push(`Failed to install hooks (non-blocking): ${error}`)
  }
}

/**
 * Resolve the launcher path for the current platform.
 * Unix: ~/.claude/bin/codeagent-wrapper (shell script)
 * Windows: ~/.claude/bin/codeagent-wrapper.cmd (cmd batch)
 */
function getLauncherName(): string {
  return process.platform === 'win32' ? 'codeagent-wrapper.cmd' : 'codeagent-wrapper'
}

/**
 * Check if codeagent-wrapper launcher exists and is functional.
 * Returns true if the launcher passes `--version` check.
 */
export async function verifyBinary(installDir: string): Promise<boolean> {
  const binDir = join(installDir, 'bin')
  const launcherPath = join(binDir, getLauncherName())

  if (!(await fs.pathExists(launcherPath))) return false

  try {
    const { execSync } = await import('node:child_process')
    execSync(`"${launcherPath}" --version`, { stdio: 'pipe' })
    return true
  }
  catch {
    return false
  }
}

/**
 * Check if installed launcher reports the expected version.
 * The mjs script embeds `codeagent-wrapper version 5.10.0` for BC.
 */
export async function verifyBinaryVersion(installDir: string): Promise<boolean> {
  const binDir = join(installDir, 'bin')
  const launcherPath = join(binDir, getLauncherName())

  try {
    const { execSync } = await import('node:child_process')
    const output = execSync(`"${launcherPath}" --version`, { stdio: 'pipe' }).toString().trim()
    const version = output.replace(/^.*version\s*/, '')
    return version === EXPECTED_BINARY_VERSION
  }
  catch {
    return false
  }
}

/**
 * Show prominent red-box warning when codeagent-wrapper shim install failed.
 * v3.0.0+: install is purely local file copy + launcher write, so failure
 * means corrupted npm package or fs permission problem (not network).
 */
export function showBinaryDownloadWarning(binDir: string): void {
  const launcherName = getLauncherName()
  const displayPath = process.platform === 'win32'
    ? `${binDir.replace(/\//g, '\\')}\\${launcherName}`
    : `${binDir}/${launcherName}`

  console.log()
  console.log(ansis.red.bold(`  ╔════════════════════════════════════════════════════════════╗`))
  console.log(ansis.red.bold(`  ║  ⚠  codeagent-wrapper 启动器安装失败                       ║`))
  console.log(ansis.red.bold(`  ║     Launcher shim install failed (fs / package issue)      ║`))
  console.log(ansis.red.bold(`  ╚════════════════════════════════════════════════════════════╝`))
  console.log()
  console.log(ansis.yellow(`  多模型协作命令 (/ccg:workflow, /ccg:plan 等) 需要此启动器才能工作。`))
  console.log(ansis.yellow(`  Multi-model commands require this launcher to work.`))
  console.log()
  console.log(ansis.cyan(`  自动修复 / Auto fix:`))
  console.log()
  console.log(ansis.white(`    1. 清缓存重装 / Clean & reinstall:`))
  console.log(ansis.cyan(`       npm cache clean --force`))
  console.log(ansis.cyan(`       npx ccg-workflow@latest`))
  console.log()
  console.log(ansis.white(`    2. 检查路径写权限 / Check write permissions:`))
  console.log(ansis.cyan(`       ${displayPath}`))
  console.log()
  console.log(ansis.gray(`  v3.0.0+ 启动器是 ~870 行 Node 脚本（无 Go binary 下载），`))
  console.log(ansis.gray(`  失败通常意味着 fs 权限问题或 npm 包损坏，而非网络。`))
  console.log()
}

/**
 * Install codeagent-wrapper as a tiny launcher shim that forwards to the
 * Node.js script invoke-model.mjs. v3.0.0+ replaces the old Go binary with
 * pure JavaScript — no platform matrix, no GitHub Release download, no R2.
 *
 * Layout:
 *   ~/.claude/bin/codeagent-wrapper      Unix shell shim (BC path)
 *   ~/.claude/bin/codeagent-wrapper.cmd  Windows cmd shim (BC path)
 *   ~/.claude/.ccg/scripts/invoke-model.mjs   Real implementation
 *
 * Installs are idempotent — re-running overwrites the script + shim with the
 * package-bundled copy. Stale binaries from previous Go-binary versions are
 * cleaned up so that `--version` checks see the new shim.
 */
async function installShim(ctx: InstallContext): Promise<void> {
  try {
    const binDir = join(ctx.installDir, 'bin')
    const scriptDir = join(ctx.installDir, '.ccg', 'scripts')
    await fs.ensureDir(binDir)
    await fs.ensureDir(scriptDir)

    // Source: bundled mjs script under the npm package
    const srcMjs = join(ctx.templateDir, 'scripts', 'invoke-model.mjs')
    if (!(await fs.pathExists(srcMjs))) {
      ctx.result.errors.push(
        `Bundled invoke-model.mjs missing at ${srcMjs}. `
        + `npm package may be incomplete — try: npm cache clean --force && npx ccg-workflow@latest`,
      )
      ctx.result.success = false
      return
    }

    // 1. Copy mjs script to ~/.claude/.ccg/scripts/invoke-model.mjs
    const destMjs = join(scriptDir, 'invoke-model.mjs')
    await fs.copy(srcMjs, destMjs, { overwrite: true })
    if (process.platform !== 'win32') {
      await fs.chmod(destMjs, 0o755)
    }

    // 2. Clean up any stale Go binary from v1.x/v2.x
    for (const stale of ['codeagent-wrapper.exe', 'codeagent-wrapper']) {
      const stalePath = join(binDir, stale)
      if (await fs.pathExists(stalePath)) {
        try {
          // Quick version check: if it already returns the expected version
          // string AND looks like a launcher (small), keep it
          const { execSync } = await import('node:child_process')
          const out = execSync(`"${stalePath}" --version`, { stdio: 'pipe' }).toString().trim()
          if (out.includes(EXPECTED_BINARY_VERSION)) {
            const stat = await fs.stat(stalePath)
            // Launcher is tiny (<2KB), Go binary is multi-MB
            if (stat.size > 100_000) {
              await fs.remove(stalePath) // stale Go binary, drop it
            }
          }
          else {
            await fs.remove(stalePath) // wrong version or unrelated, drop it
          }
        }
        catch {
          await fs.remove(stalePath) // unreadable, drop it
        }
      }
    }

    // 3. Write platform launcher — bake actual installDir path so launcher
    //    works regardless of CLAUDE_CONFIG_DIR / test temp dirs / custom locations.
    if (process.platform === 'win32') {
      // Windows .cmd: native backslash path
      const cmdMjs = destMjs.replace(/\//g, '\\')
      const cmdPath = join(binDir, 'codeagent-wrapper.cmd')
      const cmdContent = `@echo off\r\nnode "${cmdMjs}" %*\r\n`
      await fs.writeFile(cmdPath, cmdContent, 'utf-8')

      // Companion bash shim so Bash(*codeagent-wrapper*) permission rules and
      // git-bash callers still work on Windows.
      const shPath = join(binDir, 'codeagent-wrapper')
      const shContent = `#!/bin/sh\nexec node "${destMjs}" "$@"\n`
      await fs.writeFile(shPath, shContent, 'utf-8')
    }
    else {
      const shPath = join(binDir, 'codeagent-wrapper')
      const shContent = `#!/bin/sh\nexec node "${destMjs}" "$@"\n`
      await fs.writeFile(shPath, shContent, 'utf-8')
      await fs.chmod(shPath, 0o755)
    }

    // 4. Verify launcher works
    try {
      const { execSync } = await import('node:child_process')
      const launcherPath = join(binDir, getLauncherName())
      execSync(`"${launcherPath}" --version`, { stdio: 'pipe' })
      ctx.result.binPath = binDir
      ctx.result.binInstalled = true
    }
    catch (verifyError) {
      ctx.result.errors.push(`Launcher verification failed (non-blocking): ${verifyError}`)
    }
  }
  catch (error) {
    ctx.result.errors.push(`Failed to install codeagent-wrapper shim (non-blocking): ${error}`)
  }
}

// ═══════════════════════════════════════════════════════
// Public API: install / uninstall
// ═══════════════════════════════════════════════════════

export async function installWorkflows(
  workflowIds: string[],
  installDir: string,
  force = false,
  config?: {
    routing?: {
      mode?: string
      frontend?: { models?: string[], primary?: string }
      backend?: { models?: string[], primary?: string }
      review?: { models?: string[] }
    }
    liteMode?: boolean
    mcpProvider?: string
    skipImpeccable?: boolean
  },
): Promise<InstallResult> {
  const ctx: InstallContext = {
    installDir,
    force,
    config: {
      routing: config?.routing as InstallConfig['routing'] || {
        mode: 'smart',
        frontend: { models: ['gemini'], primary: 'gemini' },
        backend: { models: ['codex'], primary: 'codex' },
        review: { models: ['codex', 'gemini'] },
      },
      liteMode: config?.liteMode || false,
      mcpProvider: config?.mcpProvider || 'ace-tool',
      skipImpeccable: config?.skipImpeccable || false,
    },
    templateDir: join(PACKAGE_ROOT, 'templates'),
    result: {
      success: true,
      installedCommands: [],
      installedPrompts: [],
      errors: [],
      configPath: '',
    },
  }

  // ── Pre-flight: validate template directory exists ──
  // This is the #1 root cause of "silent install failure" on Windows:
  // if PACKAGE_ROOT resolved wrong, templateDir doesn't exist and every
  // sub-step silently returns empty results while reporting success.
  if (!(await fs.pathExists(ctx.templateDir))) {
    const errorMsg = `Template directory not found: ${ctx.templateDir} (PACKAGE_ROOT=${PACKAGE_ROOT}). `
      + `This usually means the npm package is incomplete or the cache is corrupted. `
      + `Try: npm cache clean --force && npx ccg-workflow@latest`
    ctx.result.errors.push(errorMsg)
    ctx.result.success = false
    return ctx.result
  }

  // Ensure base directories
  await fs.ensureDir(join(installDir, 'commands', 'ccg'))
  await fs.ensureDir(join(installDir, '.ccg'))
  await fs.ensureDir(join(installDir, '.ccg', 'prompts'))

  // Execute each install step
  await installCommandFiles(ctx, workflowIds)
  await installAgentFiles(ctx)
  await installPromptFiles(ctx)
  await installSkillFiles(ctx)
  await installSkillGeneratedCommands(ctx)
  await installRuleFiles(ctx)
  await installShim(ctx)
  await installHookFiles(ctx)

  // ── Post-flight: validate installation produced results ──
  // Catch the case where all sub-steps silently returned empty
  if (ctx.result.installedCommands.length === 0 && ctx.result.errors.length === 0) {
    ctx.result.errors.push(
      `No commands were installed (expected ${workflowIds.length}). `
      + `Template dir: ${ctx.templateDir}. `
      + `This may indicate a corrupted package or file permission issue.`,
    )
    ctx.result.success = false
  }

  ctx.result.configPath = join(installDir, 'commands', 'ccg')
  return ctx.result
}

// ═══════════════════════════════════════════════════════
// Uninstall
// ═══════════════════════════════════════════════════════

export interface UninstallResult {
  success: boolean
  removedCommands: string[]
  removedPrompts: string[]
  removedAgents: string[]
  removedSkills: string[]
  removedRules: boolean
  removedBin: boolean
  errors: string[]
}

/**
 * Uninstall workflows by removing their command files.
 * @param options.preserveBinary — when true, skip binary removal (used during update)
 */
export async function uninstallWorkflows(installDir: string, options?: { preserveBinary?: boolean }): Promise<UninstallResult> {
  const result: UninstallResult = {
    success: true,
    removedCommands: [],
    removedPrompts: [],
    removedAgents: [],
    removedSkills: [],
    removedRules: false,
    removedBin: false,
    errors: [],
  }

  const commandsDir = join(installDir, 'commands', 'ccg')
  const agentsDir = join(installDir, 'agents', 'ccg')
  const skillsDir = join(installDir, 'skills', 'ccg')
  const rulesDir = join(installDir, 'rules')
  const binDir = join(installDir, 'bin')
  const ccgConfigDir = join(installDir, '.ccg')

  // Remove CCG commands directory
  try {
    result.removedCommands = await removeDirCollectMdNames(commandsDir)
  }
  catch (error) {
    result.errors.push(`Failed to remove commands directory: ${error}`)
    result.success = false
  }

  // Remove CCG agents directory
  try {
    result.removedAgents = await removeDirCollectMdNames(agentsDir)
  }
  catch (error) {
    result.errors.push(`Failed to remove agents directory: ${error}`)
    result.success = false
  }

  // Remove CCG skills directory only (skills/ccg/) — preserves user's own skills
  if (await fs.pathExists(skillsDir)) {
    try {
      result.removedSkills = await collectSkillNames(skillsDir)
      await fs.remove(skillsDir)
    }
    catch (error) {
      result.errors.push(`Failed to remove skills: ${error}`)
      result.success = false
    }
  }

  // Remove CCG rules files
  if (await fs.pathExists(rulesDir)) {
    try {
      for (const ruleFile of ['ccg-skills.md', 'ccg-grok-search.md', 'ccg-skill-routing.md']) {
        const rulePath = join(rulesDir, ruleFile)
        if (await fs.pathExists(rulePath)) {
          await fs.remove(rulePath)
          result.removedRules = true
        }
      }
    }
    catch (error) {
      result.errors.push(`Failed to remove rules: ${error}`)
    }
  }

  // Remove codeagent-wrapper launcher shim + companion mjs script
  // (skip during update to avoid unnecessary churn)
  if (!options?.preserveBinary) {
    try {
      // bin/ launchers — clean up both Unix shim and Windows .cmd, plus any
      // stale .exe from the pre-v3.0.0 Go binary era
      if (await fs.pathExists(binDir)) {
        for (const launcher of ['codeagent-wrapper', 'codeagent-wrapper.cmd', 'codeagent-wrapper.exe']) {
          const launcherPath = join(binDir, launcher)
          if (await fs.pathExists(launcherPath)) {
            await fs.remove(launcherPath)
            result.removedBin = true
          }
        }
      }
      // .ccg/scripts/invoke-model.mjs — the actual implementation
      const scriptDir = join(installDir, '.ccg', 'scripts')
      const mjsPath = join(scriptDir, 'invoke-model.mjs')
      if (await fs.pathExists(mjsPath)) {
        await fs.remove(mjsPath)
      }
    }
    catch (error) {
      result.errors.push(`Failed to remove launcher shim: ${error}`)
      result.success = false
    }
  }

  // Remove context-monitor + statusline hook files and clean settings.json
  try {
    const { errors: hookErrors } = await uninstallHooks(installDir)
    if (hookErrors.length > 0) {
      result.errors.push(...hookErrors.map(e => `Hook uninstall: ${e}`))
    }
  }
  catch (error) {
    result.errors.push(`Failed to remove hooks: ${error}`)
  }

  // Remove .ccg config directory
  if (await fs.pathExists(ccgConfigDir)) {
    try {
      await fs.remove(ccgConfigDir)
      result.removedPrompts.push('ALL_PROMPTS_AND_CONFIGS')
    }
    catch (error) {
      result.errors.push(`Failed to remove .ccg directory: ${error}`)
    }
  }

  return result
}
