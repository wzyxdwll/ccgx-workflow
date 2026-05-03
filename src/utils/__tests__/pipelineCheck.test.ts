/**
 * Pipeline Check tests (CCG v4.3 Phase 25).
 *
 * 重点验证：
 *   - verifyAllCommandsIncluded 静态比对 templates/commands/*.md vs package.json files
 *     （这是 v4.2.0 debate.md 漏 register 那种事故的核心检测）
 *   - runPipelineCheck 整体流程（不真跑 pnpm pack，免得测试慢）
 *
 * 不跑 pnpm pack 的原因：实际跑 pack 每次 ~30s + 产生 tarball 文件副作用，
 * 单测不该这么重。doPnpmPack=false 跳过 pack，仅做静态 package.json 比对。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  runPipelineCheck,
  verifyAllCommandsIncluded,
  renderPipelineReport,
  type PipelineCheckReport,
} from '../pipeline-check'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccg-pipecheck-'))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

/** 构造一个 fixture 项目目录 */
function setupProject(opts: {
  packageFiles?: string[]
  commandFiles?: string[]
}): string {
  // package.json
  if (opts.packageFiles !== undefined) {
    writeFileSync(
      join(tmpRoot, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        files: opts.packageFiles,
      }),
    )
  }
  // templates/commands/*.md
  if (opts.commandFiles !== undefined) {
    mkdirSync(join(tmpRoot, 'templates', 'commands'), { recursive: true })
    for (const f of opts.commandFiles) {
      writeFileSync(join(tmpRoot, 'templates', 'commands', f), `# ${f}`)
    }
  }
  return tmpRoot
}

// ---------------------------------------------------------------------------
// verifyAllCommandsIncluded
// ---------------------------------------------------------------------------

describe('verifyAllCommandsIncluded — package.json vs templates/commands', () => {
  it('精确匹配清单：所有命令都在 files 数组', () => {
    setupProject({
      packageFiles: [
        'templates/commands/plan.md',
        'templates/commands/review.md',
      ],
      commandFiles: ['plan.md', 'review.md'],
    })
    const result = verifyAllCommandsIncluded(tmpRoot)
    expect(result.missingInPackageJson).toEqual([])
    expect(result.actualCommands).toEqual([
      'templates/commands/plan.md',
      'templates/commands/review.md',
    ])
  })

  it('v4.2.0 debate.md 同型事故 — 文件存在但 files 漏列', () => {
    setupProject({
      packageFiles: [
        'templates/commands/plan.md',
        'templates/commands/review.md',
        // 故意不列 debate.md
      ],
      commandFiles: ['plan.md', 'review.md', 'debate.md'],
    })
    const result = verifyAllCommandsIncluded(tmpRoot)
    expect(result.missingInPackageJson).toEqual(['templates/commands/debate.md'])
  })

  it('目录前缀形式（"templates/commands/"）容许整目录匹配', () => {
    setupProject({
      packageFiles: ['templates/commands/'],
      commandFiles: ['plan.md', 'debate.md', 'review.md'],
    })
    const result = verifyAllCommandsIncluded(tmpRoot)
    expect(result.missingInPackageJson).toEqual([])
  })

  it('package.json 不存在 → packageFiles 空，所有命令都标 missing', () => {
    setupProject({ commandFiles: ['plan.md'] })
    const result = verifyAllCommandsIncluded(tmpRoot)
    expect(result.packageFiles).toEqual([])
    expect(result.missingInPackageJson).toEqual(['templates/commands/plan.md'])
  })

  it('templates/commands/ 不存在 → actualCommands 空', () => {
    setupProject({ packageFiles: ['dist/'] })
    const result = verifyAllCommandsIncluded(tmpRoot)
    expect(result.actualCommands).toEqual([])
    expect(result.missingInPackageJson).toEqual([])
  })

  it('同时给 tarball entries → 两层都校验（tarball 漏更可怕）', () => {
    setupProject({
      packageFiles: ['templates/commands/plan.md', 'templates/commands/debate.md'],
      commandFiles: ['plan.md', 'debate.md'],
    })
    // tarball 只含 plan.md，debate.md 应被检测出 tarball 漏
    const tarballEntries = ['package/templates/commands/plan.md', 'package/dist/index.mjs']
    const result = verifyAllCommandsIncluded(tmpRoot, tarballEntries)
    expect(result.missingInPackageJson).toEqual([])
    expect(result.missingInTarball).toEqual(['templates/commands/debate.md'])
  })

  it('忽略 .md 之外的文件（README / .ts 等）', () => {
    setupProject({
      packageFiles: ['templates/commands/plan.md'],
      commandFiles: ['plan.md'],
    })
    // 加一些非 .md 文件
    writeFileSync(join(tmpRoot, 'templates', 'commands', 'README.txt'), 'readme')
    const result = verifyAllCommandsIncluded(tmpRoot)
    expect(result.actualCommands).toEqual(['templates/commands/plan.md'])
    expect(result.missingInPackageJson).toEqual([])
  })

  it('大小写敏感（plan.MD 不算 plan.md）', () => {
    // 仅在大小写敏感文件系统验证；Windows 跳过
    if (process.platform === 'win32') return
    setupProject({
      packageFiles: ['templates/commands/plan.md'],
      commandFiles: ['plan.md'],
    })
    writeFileSync(join(tmpRoot, 'templates', 'commands', 'OTHER.md'), '# other')
    const result = verifyAllCommandsIncluded(tmpRoot)
    expect(result.actualCommands).toContain('templates/commands/OTHER.md')
    expect(result.missingInPackageJson).toEqual(['templates/commands/OTHER.md'])
  })
})

// ---------------------------------------------------------------------------
// runPipelineCheck — 主入口（doPnpmPack=false 跳过 pack 仅做静态比对）
// ---------------------------------------------------------------------------

describe('runPipelineCheck — 端到端（静态模式 doPnpmPack=false）', () => {
  it('完整 fixture 全过 → ok=true，无错误', () => {
    setupProject({
      packageFiles: ['templates/commands/plan.md'],
      commandFiles: ['plan.md'],
    })
    const report = runPipelineCheck({ workdir: tmpRoot, doPnpmPack: false })
    expect(report.ok).toBe(true)
    expect(report.errors).toEqual([])
    expect(report.missingFromPackageJson).toEqual([])
    expect(report.tarballPath).toBeUndefined()
  })

  it('debate.md 漏 register → ok=false + 明确错误指向漏列', () => {
    setupProject({
      packageFiles: ['templates/commands/plan.md'],
      commandFiles: ['plan.md', 'debate.md'],
    })
    const report = runPipelineCheck({ workdir: tmpRoot, doPnpmPack: false })
    expect(report.ok).toBe(false)
    expect(report.missingFromPackageJson).toEqual(['templates/commands/debate.md'])
    expect(report.errors.length).toBeGreaterThan(0)
    expect(report.errors[0].category).toBe('missing-from-tarball')
    expect(report.errors[0].message).toContain('debate.md')
  })

  it('package.json 缺失 → ok=false + package-json-missing 错误', () => {
    setupProject({ commandFiles: ['plan.md'] })
    const report = runPipelineCheck({ workdir: tmpRoot, doPnpmPack: false })
    expect(report.ok).toBe(false)
    expect(report.errors.some(e => e.category === 'package-json-missing')).toBe(true)
  })

  it('package.json files 数组空 → package-json-invalid 警告', () => {
    setupProject({ packageFiles: [], commandFiles: ['plan.md'] })
    const report = runPipelineCheck({ workdir: tmpRoot, doPnpmPack: false })
    expect(report.ok).toBe(false)
    expect(report.errors.some(e => e.category === 'package-json-invalid')).toBe(true)
  })

  it('多个漏列 → message 列前 5 + "...还有 N 个"', () => {
    setupProject({
      packageFiles: ['templates/commands/plan.md'],
      commandFiles: ['plan.md', 'debate.md', 'a.md', 'b.md', 'c.md', 'd.md', 'e.md'],
    })
    const report = runPipelineCheck({ workdir: tmpRoot, doPnpmPack: false })
    expect(report.missingFromPackageJson).toHaveLength(6)
    expect(report.errors[0].message).toContain('还有 1 个')
  })

  it('templates/commands 整目录形式 → 单文件追加都被自动覆盖', () => {
    setupProject({
      packageFiles: ['templates/commands/'],
      commandFiles: ['plan.md', 'debate.md', 'review.md', 'workflow.md'],
    })
    const report = runPipelineCheck({ workdir: tmpRoot, doPnpmPack: false })
    expect(report.ok).toBe(true)
    expect(report.missingFromPackageJson).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// renderPipelineReport — 人可读输出
// ---------------------------------------------------------------------------

describe('renderPipelineReport — markdown 输出', () => {
  it('ok=true 输出"All checks passed"', () => {
    const report: PipelineCheckReport = {
      ok: true,
      errors: [],
      warnings: [],
      missingFromPackageJson: [],
    }
    const out = renderPipelineReport(report)
    expect(out).toContain('✅')
    expect(out).toContain('All checks passed')
  })

  it('ok=false 输出 ❌ + 错误列表', () => {
    const report: PipelineCheckReport = {
      ok: false,
      errors: [
        {
          category: 'missing-from-tarball',
          message: 'debate.md 漏 register',
        },
      ],
      warnings: [],
      missingFromPackageJson: ['templates/commands/debate.md'],
    }
    const out = renderPipelineReport(report)
    expect(out).toContain('❌')
    expect(out).toContain('debate.md 漏 register')
    expect(out).toContain('missing-from-tarball')
  })

  it('warnings 段也渲染', () => {
    const report: PipelineCheckReport = {
      ok: true,
      errors: [],
      warnings: ['something minor'],
      missingFromPackageJson: [],
    }
    const out = renderPipelineReport(report)
    expect(out).toContain('something minor')
  })

  it('tarball path + entries count 渲染', () => {
    const report: PipelineCheckReport = {
      ok: true,
      errors: [],
      warnings: [],
      tarballPath: '/tmp/foo.tgz',
      tarballEntries: ['a', 'b', 'c'],
      missingFromPackageJson: [],
    }
    const out = renderPipelineReport(report)
    expect(out).toContain('/tmp/foo.tgz')
    expect(out).toContain('3 文件')
  })
})
