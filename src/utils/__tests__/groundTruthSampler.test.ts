/**
 * Ground Truth Sampler tests (CCG v4.3 Phase 26).
 *
 * 重点验证：
 *   - samplePluginList 解析 installed_plugins.json 真 schema
 *   - sampleSkillList 扫 skills/ccg/ frontmatter 容错
 *   - sampleHookSchema classify matcher 字段类型（string / array / null）
 *   - samplePackageStructure 检测 package.json files 漏列（与 P25 联动）
 *   - sampleAll 端到端 + 失败优雅（缺文件不抛）
 *   - summarizeGroundTruth 渲染 ≤500 token
 *
 * 所有测试通过 homeDir 参数注入临时目录，不污染真实 ~/.claude/。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  sampleAll,
  sampleHookSchema,
  samplePackageStructure,
  samplePluginList,
  sampleSkillList,
  summarizeGroundTruth,
  type GroundTruth,
} from '../ground-truth-sampler'

let fakeHome: string

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'ccg-gt-home-'))
})

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true })
})

function writeInstalledPlugins(payload: any) {
  const dir = join(fakeHome, '.claude', 'plugins')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'installed_plugins.json'), JSON.stringify(payload))
}

function writeSettings(payload: any) {
  const dir = join(fakeHome, '.claude')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(payload))
}

function writeSkill(relPath: string, frontmatter: string) {
  const full = join(fakeHome, '.claude', 'skills', 'ccg', relPath, 'SKILL.md')
  mkdirSync(join(fakeHome, '.claude', 'skills', 'ccg', relPath), { recursive: true })
  writeFileSync(full, `---\n${frontmatter}\n---\n\n# Body\n`)
}

// ---------------------------------------------------------------------------
// samplePluginList
// ---------------------------------------------------------------------------

describe('samplePluginList — installed_plugins.json 解析', () => {
  it('文件不存在 → 空 + warning', () => {
    const { plugins, warnings } = samplePluginList(fakeHome)
    expect(plugins).toEqual([])
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0]).toContain('not found')
  })

  it('解析 v2 schema（plugins object）', () => {
    writeInstalledPlugins({
      version: 2,
      plugins: {
        'codex@claude-plugins-official': [
          { version: '1.0.0', installPath: '/some/path' },
        ],
        'gemini@claude-plugins-official': [{ version: 'unknown' }],
      },
    })
    const { plugins, warnings } = samplePluginList(fakeHome)
    expect(warnings).toEqual([])
    expect(plugins).toHaveLength(2)
    const codex = plugins.find(p => p.shortName === 'codex')!
    expect(codex.version).toBe('1.0.0')
    expect(codex.installPath).toBe('/some/path')
    // subagent hints 命中已知 marketplace
    expect(codex.subagentTypeHints).toContain('codex:rescue')
  })

  it('JSON 解析失败 → 空 + warning', () => {
    const dir = join(fakeHome, '.claude', 'plugins')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'installed_plugins.json'), '{not valid json')
    const { plugins, warnings } = samplePluginList(fakeHome)
    expect(plugins).toEqual([])
    expect(warnings[0]).toContain('parse failed')
  })

  it('plugins 字段缺失 → 空 + warning', () => {
    writeInstalledPlugins({ version: 2 })
    const { plugins, warnings } = samplePluginList(fakeHome)
    expect(plugins).toEqual([])
    expect(warnings[0]).toContain('missing `plugins`')
  })

  it('未知 plugin 名 → subagentTypeHints undefined', () => {
    writeInstalledPlugins({
      version: 2,
      plugins: {
        'mystery-plugin@unknown': [{ version: '1.0.0' }],
      },
    })
    const { plugins } = samplePluginList(fakeHome)
    expect(plugins).toHaveLength(1)
    expect(plugins[0].subagentTypeHints).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// sampleSkillList
// ---------------------------------------------------------------------------

describe('sampleSkillList — SKILL.md frontmatter 解析', () => {
  it('skills/ccg/ 不存在 → 空 + warning', () => {
    const { skills, warnings } = sampleSkillList(fakeHome)
    expect(skills).toEqual([])
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('正确解析 user-invocable: true skill', () => {
    writeSkill('tools/verify', 'name: ccg:verify\nuser-invocable: true')
    const { skills } = sampleSkillList(fakeHome)
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('ccg:verify')
    expect(skills[0].userInvocable).toBe(true)
    expect(skills[0].category).toBe('tool')
  })

  it('user-invocable 缺失或 false → userInvocable=false', () => {
    writeSkill('domains/security', 'name: ccg:domain-security\nuser-invocable: false')
    writeSkill('domains/perf', 'name: ccg:perf')
    const { skills } = sampleSkillList(fakeHome)
    expect(skills).toHaveLength(2)
    expect(skills.every(s => !s.userInvocable)).toBe(true)
  })

  it('category 推断（tool / domain / impeccable / orchestration）', () => {
    writeSkill('tools/foo', 'name: foo')
    writeSkill('domains/bar', 'name: bar')
    writeSkill('impeccable/baz', 'name: baz')
    writeSkill('orchestration/qux', 'name: qux')
    const { skills } = sampleSkillList(fakeHome)
    const byName = Object.fromEntries(skills.map(s => [s.name, s.category]))
    expect(byName['foo']).toBe('tool')
    expect(byName['bar']).toBe('domain')
    expect(byName['baz']).toBe('impeccable')
    expect(byName['qux']).toBe('orchestration')
  })

  it('无 frontmatter SKILL.md 跳过不抛', () => {
    const dir = join(fakeHome, '.claude', 'skills', 'ccg', 'broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '# No frontmatter here')
    const { skills, warnings } = sampleSkillList(fakeHome)
    expect(skills).toEqual([])
    expect(warnings).toEqual([])
  })

  it('递归 walk 嵌套子目录', () => {
    writeSkill('domains/ai/rag-system', 'name: rag\nuser-invocable: false')
    writeSkill('domains/security/red-team', 'name: red\nuser-invocable: false')
    const { skills } = sampleSkillList(fakeHome)
    expect(skills.map(s => s.name).sort()).toEqual(['rag', 'red'])
  })

  it('frontmatter 引号容错（"foo" / \'foo\' / foo 都算 foo）', () => {
    writeSkill('tools/q1', 'name: "ccg:quoted"\nuser-invocable: true')
    writeSkill('tools/q2', "name: 'ccg:single'\nuser-invocable: true")
    const { skills } = sampleSkillList(fakeHome)
    const names = skills.map(s => s.name).sort()
    expect(names).toEqual(['ccg:quoted', 'ccg:single'])
  })
})

// ---------------------------------------------------------------------------
// sampleHookSchema
// ---------------------------------------------------------------------------

describe('sampleHookSchema — settings.json hooks 段解析', () => {
  it('settings.json 不存在 → 空 + warning', () => {
    const { hooks, warnings } = sampleHookSchema(fakeHome)
    expect(hooks).toEqual([])
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('SessionStart 无 matcher → matcherType=absent', () => {
    writeSettings({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'node script.cjs', timeout: 15 }] },
        ],
      },
    })
    const { hooks } = sampleHookSchema(fakeHome)
    expect(hooks).toHaveLength(1)
    expect(hooks[0].event).toBe('SessionStart')
    expect(hooks[0].matcherType).toBe('absent')
    expect(hooks[0].firstCommandPreview).toContain('node script.cjs')
  })

  it('PostToolUse matcher 是 string → string', () => {
    writeSettings({
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit|Write|MultiEdit',
            hooks: [{ command: 'monitor.js' }],
          },
        ],
      },
    })
    const { hooks } = sampleHookSchema(fakeHome)
    expect(hooks[0].matcherType).toBe('string')
  })

  it('matcher 是 array → array', () => {
    writeSettings({
      hooks: { Foo: [{ matcher: ['x', 'y'], hooks: [] }] },
    })
    const { hooks } = sampleHookSchema(fakeHome)
    expect(hooks[0].matcherType).toBe('array')
  })

  it('matcher 为 ""（空 string）也算 string', () => {
    writeSettings({ hooks: { Foo: [{ matcher: '', hooks: [] }] } })
    const { hooks } = sampleHookSchema(fakeHome)
    expect(hooks[0].matcherType).toBe('string')
  })

  it('多个 entry 同 event → hookCount 准确', () => {
    writeSettings({
      hooks: {
        PostToolUse: [
          { matcher: 'a', hooks: [{ command: '1.js' }] },
          { matcher: 'b', hooks: [{ command: '2.js' }] },
        ],
      },
    })
    const { hooks } = sampleHookSchema(fakeHome)
    expect(hooks[0].hookCount).toBe(2)
  })

  it('解析失败 → 空 + warning', () => {
    const dir = join(fakeHome, '.claude')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), 'BROKEN{')
    const { hooks, warnings } = sampleHookSchema(fakeHome)
    expect(hooks).toEqual([])
    expect(warnings[0]).toContain('parse failed')
  })

  it('command 字段过长 → 截 80 char', () => {
    writeSettings({
      hooks: {
        Foo: [
          { hooks: [{ command: 'A'.repeat(200) }] },
        ],
      },
    })
    const { hooks } = sampleHookSchema(fakeHome)
    expect(hooks[0].firstCommandPreview!.length).toBe(80)
  })
})

// ---------------------------------------------------------------------------
// samplePackageStructure
// ---------------------------------------------------------------------------

describe('samplePackageStructure — package.json + templates/commands 一致性', () => {
  let project: string
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'ccg-gt-proj-'))
  })
  afterEach(() => {
    rmSync(project, { recursive: true, force: true })
  })

  function writePackageJson(pkg: any) {
    writeFileSync(join(project, 'package.json'), JSON.stringify(pkg))
  }

  function writeCommand(name: string) {
    const cmdDir = join(project, 'templates', 'commands')
    mkdirSync(cmdDir, { recursive: true })
    writeFileSync(join(cmdDir, name), '# md')
  }

  it('package.json 不存在 → info=null + warning', () => {
    const { info, warnings } = samplePackageStructure(project)
    expect(info).toBeNull()
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('完美匹配（v4.2.3 fix 后状态）', () => {
    writePackageJson({
      files: [
        'templates/commands/plan.md',
        'templates/commands/debate.md',
      ],
    })
    writeCommand('plan.md')
    writeCommand('debate.md')
    const { info } = samplePackageStructure(project)
    expect(info!.missingFromPackageFiles).toEqual([])
  })

  it('v4.2.0 debate.md 漏列（pre-fix）— 检测出', () => {
    writePackageJson({
      files: ['templates/commands/plan.md'],
    })
    writeCommand('plan.md')
    writeCommand('debate.md')
    const { info } = samplePackageStructure(project)
    expect(info!.missingFromPackageFiles).toEqual(['templates/commands/debate.md'])
  })

  it('整目录前缀（"templates/commands/"）容许', () => {
    writePackageJson({ files: ['templates/commands/'] })
    writeCommand('plan.md')
    writeCommand('debate.md')
    const { info } = samplePackageStructure(project)
    expect(info!.missingFromPackageFiles).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// sampleAll — 端到端
// ---------------------------------------------------------------------------

describe('sampleAll — 综合采样', () => {
  it('完全空 home → 不抛错，warnings 含每个来源缺失', () => {
    const gt = sampleAll({ homeDir: fakeHome })
    expect(gt.plugins).toEqual([])
    expect(gt.skills).toEqual([])
    expect(gt.hooks).toEqual([])
    expect(gt.warnings.length).toBeGreaterThanOrEqual(3)
    expect(gt.sampledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(gt.packageStructure).toBeUndefined()
  })

  it('全填 home + workdir → 全字段含数据', () => {
    writeInstalledPlugins({
      version: 2,
      plugins: { 'codex@x': [{ version: '1.0' }] },
    })
    writeSkill('tools/verify', 'name: ccg:verify\nuser-invocable: true')
    writeSettings({
      hooks: { SessionStart: [{ hooks: [{ command: 'foo' }] }] },
    })
    const project = mkdtempSync(join(tmpdir(), 'ccg-gt-proj-'))
    try {
      writeFileSync(
        join(project, 'package.json'),
        JSON.stringify({ files: ['templates/commands/'] }),
      )
      const cmdDir = join(project, 'templates', 'commands')
      mkdirSync(cmdDir, { recursive: true })
      writeFileSync(join(cmdDir, 'plan.md'), '# md')

      const gt = sampleAll({ homeDir: fakeHome, workdir: project })
      expect(gt.plugins).toHaveLength(1)
      expect(gt.skills).toHaveLength(1)
      expect(gt.hooks).toHaveLength(1)
      expect(gt.packageStructure!.templateCommands).toEqual([
        'templates/commands/plan.md',
      ])
    }
    finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// summarizeGroundTruth — 渲染
// ---------------------------------------------------------------------------

describe('summarizeGroundTruth — markdown 摘要', () => {
  it('空 GroundTruth 输出最小骨架', () => {
    const gt: GroundTruth = {
      sampledAt: '2026-05-04T00:00:00Z',
      plugins: [],
      skills: [],
      hooks: [],
      warnings: [],
    }
    const md = summarizeGroundTruth(gt)
    expect(md).toContain('Plugins (0)')
    expect(md).toContain('Skills (0,')
    expect(md).toContain('Hooks (0 events)')
  })

  it('有 plugin → subagent hints 列出', () => {
    const gt: GroundTruth = {
      sampledAt: '2026-05-04T00:00:00Z',
      plugins: [
        {
          name: 'codex@x',
          shortName: 'codex',
          version: '1.0.0',
          subagentTypeHints: ['codex:rescue', 'codex:setup'],
        },
      ],
      skills: [],
      hooks: [],
      warnings: [],
    }
    const md = summarizeGroundTruth(gt)
    expect(md).toContain('codex:rescue')
    expect(md).toContain('codex:setup')
  })

  it('package missing 文件触发警告段', () => {
    const gt: GroundTruth = {
      sampledAt: '2026-05-04T00:00:00Z',
      plugins: [],
      skills: [],
      hooks: [],
      warnings: [],
      packageStructure: {
        packageFiles: ['templates/commands/plan.md'],
        templateCommands: ['templates/commands/plan.md', 'templates/commands/debate.md'],
        missingFromPackageFiles: ['templates/commands/debate.md'],
      },
    }
    const md = summarizeGroundTruth(gt)
    expect(md).toContain('⚠️')
    expect(md).toContain('debate.md')
  })

  it('plugins 数量 > 20 → 截断"还有 N 个"', () => {
    const plugins = Array.from({ length: 25 }, (_, i) => ({
      name: `p${i}@x`,
      shortName: `p${i}`,
      version: '1.0',
    }))
    const gt: GroundTruth = {
      sampledAt: '2026-05-04T00:00:00Z',
      plugins,
      skills: [],
      hooks: [],
      warnings: [],
    }
    const md = summarizeGroundTruth(gt)
    expect(md).toContain('还有 5 个')
  })
})
