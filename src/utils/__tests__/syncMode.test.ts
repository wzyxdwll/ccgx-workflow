/**
 * v4.1-p18: ccg init --sync mode
 *
 * Tests `computeSyncReport` from installer.ts.
 * The sync report should:
 *   - List local files no longer in templates (under ccg/ namespace only)
 *   - NOT list user-authored files (outside ccg/ namespace, but ccg/ scope is enforced
 *     by the directory layout — we only scan installDir/{commands,agents,skills}/ccg/)
 *   - Include files generated from skill registry (so they aren't flagged as stale)
 */
import fs from 'fs-extra'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock PACKAGE_ROOT to point to a controlled fake template dir
let fakeTemplateDir: string

vi.mock('../installer-template', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../installer-template')>()
  return {
    ...actual,
    get PACKAGE_ROOT() {
      // PACKAGE_ROOT is a directory whose `templates` subdir is fakeTemplateDir
      return packageRootHolder.value
    },
  }
})

const packageRootHolder: { value: string } = { value: '' }

describe('ccg init --sync mode (v4.1-p18)', () => {
  let tmpRoot: string
  let installDir: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(join(tmpdir(), 'ccg-sync-'))
    // Mock package root: templates live under tmpRoot/pkg/templates
    const pkgRoot = join(tmpRoot, 'pkg')
    fakeTemplateDir = join(pkgRoot, 'templates')
    packageRootHolder.value = pkgRoot
    await fs.ensureDir(join(fakeTemplateDir, 'commands'))
    await fs.ensureDir(join(fakeTemplateDir, 'commands', 'agents'))
    await fs.ensureDir(join(fakeTemplateDir, 'skills'))

    installDir = join(tmpRoot, 'home', '.claude')
    await fs.ensureDir(join(installDir, 'commands', 'ccg'))
    await fs.ensureDir(join(installDir, 'agents', 'ccg'))
    await fs.ensureDir(join(installDir, 'skills', 'ccg'))
  })

  afterEach(async () => {
    await fs.remove(tmpRoot).catch(() => {})
    vi.resetModules()
  })

  it('returns empty stale lists when install matches templates exactly', async () => {
    // Setup: 2 commands in template + same 2 in install
    await fs.writeFile(join(fakeTemplateDir, 'commands', 'workflow.md'), '---\ndesc: a\n---\nbody')
    await fs.writeFile(join(fakeTemplateDir, 'commands', 'plan.md'), '---\ndesc: b\n---\nbody')
    await fs.writeFile(join(installDir, 'commands', 'ccg', 'workflow.md'), 'x')
    await fs.writeFile(join(installDir, 'commands', 'ccg', 'plan.md'), 'y')

    const { computeSyncReport } = await import('../installer')
    const report = await computeSyncReport(installDir)

    expect(report.staleCommands).toEqual([])
    expect(report.installedCommands).toBe(2)
    expect(report.errors).toEqual([])
  })

  it('flags commands present locally but removed from templates', async () => {
    // Template has only `workflow.md`; install has `workflow.md` + `team-research.md` (removed v4.1-p18)
    await fs.writeFile(join(fakeTemplateDir, 'commands', 'workflow.md'), 'a')
    await fs.writeFile(join(installDir, 'commands', 'ccg', 'workflow.md'), 'a')
    await fs.writeFile(join(installDir, 'commands', 'ccg', 'team-research.md'), 'old')
    await fs.writeFile(join(installDir, 'commands', 'ccg', 'health.md'), 'old')

    const { computeSyncReport } = await import('../installer')
    const report = await computeSyncReport(installDir)

    expect(report.staleCommands.sort()).toEqual(['health.md', 'team-research.md'])
    expect(report.installedCommands).toBe(3)
  })

  it('does NOT flag commands matching skill-generated names', async () => {
    // Setup: a user-invocable skill named `health` generates a command file
    await fs.ensureDir(join(fakeTemplateDir, 'skills', 'tools', 'health'))
    await fs.writeFile(
      join(fakeTemplateDir, 'skills', 'tools', 'health', 'SKILL.md'),
      `---
name: health
description: Health check skill
user-invocable: true
allowed-tools: Read
---
body`,
    )
    // Install side has a `health.md` command (auto-generated previously)
    await fs.writeFile(join(installDir, 'commands', 'ccg', 'health.md'), 'auto-generated')

    const { computeSyncReport } = await import('../installer')
    const report = await computeSyncReport(installDir)

    // Should NOT be in stale list because skill registry covers it
    expect(report.staleCommands).not.toContain('health.md')
  })

  it('flags stale skills (entire skill directory removed from templates)', async () => {
    // Setup: install has skill dir `old-skill`, template doesn't
    await fs.ensureDir(join(installDir, 'skills', 'ccg', 'tools', 'old-skill'))
    await fs.writeFile(
      join(installDir, 'skills', 'ccg', 'tools', 'old-skill', 'SKILL.md'),
      'old skill body',
    )
    // Template has `keep-skill`
    await fs.ensureDir(join(fakeTemplateDir, 'skills', 'tools', 'keep-skill'))
    await fs.writeFile(
      join(fakeTemplateDir, 'skills', 'tools', 'keep-skill', 'SKILL.md'),
      'kept skill',
    )
    // Install also has the kept one
    await fs.ensureDir(join(installDir, 'skills', 'ccg', 'tools', 'keep-skill'))
    await fs.writeFile(
      join(installDir, 'skills', 'ccg', 'tools', 'keep-skill', 'SKILL.md'),
      'kept skill',
    )

    const { computeSyncReport } = await import('../installer')
    const report = await computeSyncReport(installDir)

    expect(report.staleSkills).toContain('old-skill')
    expect(report.staleSkills).not.toContain('keep-skill')
  })

  it('flags stale agents', async () => {
    await fs.writeFile(join(fakeTemplateDir, 'commands', 'agents', 'planner.md'), 'a')
    await fs.writeFile(join(installDir, 'agents', 'ccg', 'planner.md'), 'a')
    await fs.writeFile(join(installDir, 'agents', 'ccg', 'old-agent.md'), 'old')

    const { computeSyncReport } = await import('../installer')
    const report = await computeSyncReport(installDir)

    expect(report.staleAgents).toEqual(['old-agent.md'])
    expect(report.installedAgents).toBe(2)
  })

  it('only scans ccg/ namespace — user-authored files outside ccg/ are not seen', async () => {
    // User has their own command in commands/ (NOT under commands/ccg/)
    await fs.writeFile(join(installDir, 'commands', 'user-private.md'), 'mine')
    await fs.writeFile(join(fakeTemplateDir, 'commands', 'workflow.md'), 'a')
    await fs.writeFile(join(installDir, 'commands', 'ccg', 'workflow.md'), 'a')

    const { computeSyncReport } = await import('../installer')
    const report = await computeSyncReport(installDir)

    // user-private.md must not appear anywhere
    expect(report.staleCommands).not.toContain('user-private.md')
    expect(report.installedCommands).toBe(1) // only the ccg/ one is counted
  })

  it('handles missing install directories gracefully', async () => {
    await fs.remove(join(installDir, 'commands', 'ccg'))
    await fs.remove(join(installDir, 'agents', 'ccg'))
    await fs.remove(join(installDir, 'skills', 'ccg'))

    const { computeSyncReport } = await import('../installer')
    const report = await computeSyncReport(installDir)

    expect(report.staleCommands).toEqual([])
    expect(report.staleAgents).toEqual([])
    expect(report.staleSkills).toEqual([])
    expect(report.errors).toEqual([])
  })
})
