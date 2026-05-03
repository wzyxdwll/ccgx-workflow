/**
 * Ground Truth Sampler (CCG v4.3 Phase 26).
 *
 * 实时从用户机器**采样**外部接口的真实状态——不是写一份"基于历史快照的猜测"
 * 文档（CCG 自己都做不到把所有 spec 文档同步），而是每次需要时即时读取真实
 * 状态：
 *
 *   - plugin 列表（~/.claude/plugins/installed_plugins.json）
 *   - skill 列表（~/.claude/skills/**\/SKILL.md frontmatter）
 *   - hook event schema（~/.claude/settings.json hooks 段）
 *   - package.json files vs templates/commands/ 一致性
 *
 * 输出到 .context/ground-truth/<ISO timestamp>.json + 软链 latest.json，
 * phase-runner prompt 强约束 "写涉及外部接口代码前必须 Read latest.json"。
 *
 * 解决 v4.2.0 codex:codex-rescue 同型事故：phase-runner 写代码时根本没机会
 * 凭训练数据猜外部接口名——它必须 Read 真实采样数据。
 *
 * 设计原则（与 v4.0 phase-context / v4.3 P25 pipeline-check 一致）：
 *   - 纯读取；不修改用户机器任何文件（仅读 ~/.claude/* 几个 known path）
 *   - 失败优雅：缺文件 / 解析失败 / 权限不足都返回空数组，不抛
 *   - Cross-platform：node:fs + node:os.homedir + node:path 内建模块
 *   - 输出 schema 自描述（含 sampledAt timestamp + 来源路径）
 *
 * 调用方：
 *   - autonomous.md Step 4.0 启动时 sampleAll + writeGroundTruth
 *   - phase-runner 的子任务（间接通过 prompt Read latest.json）
 *   - P28 测试 fixtures 自动生成（基于真采样输出）
 *
 * 不做：
 *   - 不真 spawn plugin 验证（引擎层禁，且开销大）
 *   - 不修改 settings.json / installed_plugins.json
 *   - 不下载 marketplace 元数据
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// 1. Schema
// ---------------------------------------------------------------------------

/**
 * 单个 plugin 的真实状态摘要。subagentTypeHints 是从 plugin 名/manifest 推断
 * 的可能 subagent_type（仅启发，不是绝对真值——绝对真值得真 spawn 试，引擎禁）。
 */
export interface PluginInfo {
  /** plugin 唯一标识（如 "codex@claude-plugins-official"） */
  name: string
  /** 简单名（"codex" / "gemini"） */
  shortName: string
  /** 安装版本 */
  version: string
  /** 安装绝对路径，可选 */
  installPath?: string
  /**
   * 经验性 subagent_type 名称提示（基于已知 marketplace 命名规则）：
   *   - codex@... → "codex:rescue", "codex:setup"
   *   - gemini@... → "gemini:rescue", "gemini:setup"
   * 仅供 phase-runner 参考；真值需 user 机器实际 system prompt 验证。
   */
  subagentTypeHints?: string[]
}

/**
 * 单个 skill 的真实状态摘要（CCG 安装的 skills/ccg/ 命名空间下）。
 */
export interface SkillInfo {
  /** SKILL.md frontmatter `name` 字段 */
  name: string
  /** SKILL.md 绝对路径 */
  path: string
  /** frontmatter `user-invocable` 字段（默认 false） */
  userInvocable: boolean
  /** 推断分类（按目录路径） */
  category?: 'tool' | 'domain' | 'impeccable' | 'orchestration' | 'unknown'
}

/**
 * 单个 hook event 的真实 schema 摘要（settings.json hooks 段）。
 */
export interface HookInfo {
  /** event 名（如 "PostToolUse" / "SessionStart"） */
  event: string
  /** matcher 字段实际类型（用户机器上就是怎么写的） */
  matcherType: 'string' | 'array' | 'object' | 'null' | 'absent' | 'other'
  /** 该 event 注册了几个 hook 入口 */
  hookCount: number
  /** 第一个 hook command 字符串前 80 字符（仅 debug 用，不含敏感路径） */
  firstCommandPreview?: string
}

/**
 * 项目维度采样：package.json files 跟 templates/commands/ 的一致性快照。
 */
export interface PackageStructureInfo {
  /** package.json `files` 数组原文 */
  packageFiles: string[]
  /** templates/commands/*.md 实际文件相对路径列表 */
  templateCommands: string[]
  /** 实际存在但 packageFiles 漏列的文件（v4.2.0 debate.md 同型事故的检测） */
  missingFromPackageFiles: string[]
}

/**
 * 完整 ground truth snapshot。所有 sub-section 都可能为空（来源文件不存在时）。
 */
export interface GroundTruth {
  /** ISO 8601 采样时间戳 */
  sampledAt: string
  /** ~/.claude/plugins/installed_plugins.json 读出的 plugin 列表 */
  plugins: PluginInfo[]
  /** ~/.claude/skills/ccg/**\/SKILL.md 解析的 skill 列表 */
  skills: SkillInfo[]
  /** ~/.claude/settings.json hooks 段实际 schema */
  hooks: HookInfo[]
  /** 项目维度（仅 sampleAll 传 workdir 时填） */
  packageStructure?: PackageStructureInfo
  /** 采样过程中的非致命警告 */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// 2. Plugin 采样
// ---------------------------------------------------------------------------

/**
 * 已知 plugin marketplace 命名 → 推断 subagent_type 列表。
 * 仅作启发，不是权威源——phase-runner 还要看 system prompt 真 skill 列表确认。
 */
const KNOWN_SUBAGENT_HINTS: Record<string, string[]> = {
  codex: ['codex:rescue', 'codex:setup'],
  gemini: ['gemini:rescue', 'gemini:setup'],
  'frontend-design': ['frontend-design:frontend-design'],
  'code-review': ['code-review:code-review'],
}

function shortNameOf(pluginKey: string): string {
  // "codex@claude-plugins-official" → "codex"
  const at = pluginKey.indexOf('@')
  return at > 0 ? pluginKey.slice(0, at) : pluginKey
}

/**
 * 读 ~/.claude/plugins/installed_plugins.json，返回标准化的 PluginInfo[]。
 * 文件不存在 → [] + warning；JSON 解析失败 → [] + warning。
 */
export function samplePluginList(homeDir: string = homedir()): {
  plugins: PluginInfo[]
  warnings: string[]
} {
  const warnings: string[] = []
  const path = join(homeDir, '.claude', 'plugins', 'installed_plugins.json')
  if (!existsSync(path)) {
    return { plugins: [], warnings: [`installed_plugins.json not found at ${path}`] }
  }

  let raw: any
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  }
  catch (e) {
    warnings.push(`installed_plugins.json parse failed: ${e instanceof Error ? e.message : String(e)}`)
    return { plugins: [], warnings }
  }

  if (!raw?.plugins || typeof raw.plugins !== 'object') {
    warnings.push('installed_plugins.json missing `plugins` object')
    return { plugins: [], warnings }
  }

  const out: PluginInfo[] = []
  for (const [name, instances] of Object.entries(raw.plugins as Record<string, any[]>)) {
    if (!Array.isArray(instances) || instances.length === 0) continue
    const inst = instances[0]
    const shortName = shortNameOf(name)
    out.push({
      name,
      shortName,
      version: typeof inst?.version === 'string' ? inst.version : 'unknown',
      installPath: typeof inst?.installPath === 'string' ? inst.installPath : undefined,
      subagentTypeHints: KNOWN_SUBAGENT_HINTS[shortName],
    })
  }
  return { plugins: out, warnings }
}

// ---------------------------------------------------------------------------
// 3. Skill 采样
// ---------------------------------------------------------------------------

function inferSkillCategory(relPath: string): SkillInfo['category'] {
  if (relPath.includes('/tools/') || relPath.startsWith('tools/')) return 'tool'
  if (relPath.includes('/domains/') || relPath.startsWith('domains/')) return 'domain'
  if (relPath.includes('/impeccable/') || relPath.startsWith('impeccable/')) return 'impeccable'
  if (relPath.includes('/orchestration/') || relPath.startsWith('orchestration/')) return 'orchestration'
  return 'unknown'
}

const SKILL_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/

function parseFrontmatterField(fm: string, key: string): string | undefined {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'mi')
  const m = fm.match(re)
  if (!m) return undefined
  return m[1].trim().replace(/^["']|["']$/g, '')
}

function walkSkills(
  baseDir: string,
  currentDir: string,
  out: SkillInfo[],
  warnings: string[],
): void {
  let entries: string[]
  try {
    entries = readdirSync(currentDir)
  }
  catch (e) {
    warnings.push(`readdir failed at ${currentDir}: ${e instanceof Error ? e.message : String(e)}`)
    return
  }

  for (const entry of entries) {
    const full = join(currentDir, entry)
    let stat
    try {
      stat = statSync(full)
    }
    catch {
      continue
    }
    if (stat.isDirectory()) {
      walkSkills(baseDir, full, out, warnings)
      continue
    }
    if (entry !== 'SKILL.md') continue

    let content: string
    try {
      content = readFileSync(full, 'utf-8')
    }
    catch {
      continue
    }
    const fmMatch = content.match(SKILL_FRONTMATTER_RE)
    if (!fmMatch) continue
    const fm = fmMatch[1]
    const name = parseFrontmatterField(fm, 'name')
    const invocableRaw = parseFrontmatterField(fm, 'user-invocable')
    if (!name) continue

    const relPath = full.slice(baseDir.length + 1).replace(/\\/g, '/')
    out.push({
      name,
      path: full,
      userInvocable: invocableRaw === 'true',
      category: inferSkillCategory(relPath),
    })
  }
}

/**
 * 扫 ~/.claude/skills/ccg/**\/SKILL.md，解析 frontmatter 给出 skill 列表。
 *
 * 仅读 ccg/ 命名空间，避免读到用户自建或其他 plugin 的 skill。
 */
export function sampleSkillList(homeDir: string = homedir()): {
  skills: SkillInfo[]
  warnings: string[]
} {
  const warnings: string[] = []
  const root = join(homeDir, '.claude', 'skills', 'ccg')
  if (!existsSync(root)) {
    return { skills: [], warnings: [`skills/ccg/ not found at ${root}`] }
  }
  const out: SkillInfo[] = []
  walkSkills(root, root, out, warnings)
  // 去重（极端情况同 name 多 SKILL.md）
  const seen = new Set<string>()
  const dedup = out.filter((s) => {
    const key = `${s.name}\0${s.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { skills: dedup, warnings }
}

// ---------------------------------------------------------------------------
// 4. Hook schema 采样
// ---------------------------------------------------------------------------

function classifyMatcher(matcher: unknown): HookInfo['matcherType'] {
  if (matcher === undefined) return 'absent'
  if (matcher === null) return 'null'
  if (typeof matcher === 'string') return 'string'
  if (Array.isArray(matcher)) return 'array'
  if (typeof matcher === 'object') return 'object'
  return 'other'
}

/**
 * 读 ~/.claude/settings.json 的 hooks 段，输出每个 event 的真实 schema 摘要。
 *
 * 这次 v4.1 P13 SessionStart hook 注册写错（matcher 字段是 string 还是 array）就是
 * 此采样要解决的——phase-runner 写 hook 集成代码前必须先看这份采样。
 */
export function sampleHookSchema(homeDir: string = homedir()): {
  hooks: HookInfo[]
  warnings: string[]
} {
  const warnings: string[] = []
  const path = join(homeDir, '.claude', 'settings.json')
  if (!existsSync(path)) {
    return { hooks: [], warnings: [`settings.json not found at ${path}`] }
  }

  let raw: any
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  }
  catch (e) {
    warnings.push(`settings.json parse failed: ${e instanceof Error ? e.message : String(e)}`)
    return { hooks: [], warnings }
  }

  const hooksObj = raw?.hooks
  if (!hooksObj || typeof hooksObj !== 'object') {
    return { hooks: [], warnings: ['settings.json no hooks section'] }
  }

  const out: HookInfo[] = []
  for (const [event, entries] of Object.entries(hooksObj as Record<string, any>)) {
    if (!Array.isArray(entries) || entries.length === 0) continue
    const first = entries[0]
    const matcher = first && typeof first === 'object' ? first.matcher : undefined
    const cmd = first?.hooks?.[0]?.command
    out.push({
      event,
      matcherType: classifyMatcher(matcher),
      hookCount: entries.length,
      firstCommandPreview:
        typeof cmd === 'string' ? cmd.slice(0, 80) : undefined,
    })
  }
  return { hooks: out, warnings }
}

// ---------------------------------------------------------------------------
// 5. Package structure 采样（项目维度）
// ---------------------------------------------------------------------------

/**
 * 采样项目 package.json `files` vs templates/commands/ 真实状态。
 * 跟 P25 pipeline-check.verifyAllCommandsIncluded 同源逻辑，但这里**仅采样**
 * 不做判定（pipeline-check 才决定 ok/fail）。
 */
export function samplePackageStructure(workdir: string): {
  info: PackageStructureInfo | null
  warnings: string[]
} {
  const warnings: string[] = []
  const pkgPath = join(workdir, 'package.json')
  if (!existsSync(pkgPath)) {
    return { info: null, warnings: [`package.json not found at ${pkgPath}`] }
  }

  let pkg: any
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  }
  catch (e) {
    warnings.push(`package.json parse failed: ${e instanceof Error ? e.message : String(e)}`)
    return { info: null, warnings }
  }

  const packageFiles: string[] = Array.isArray(pkg.files) ? pkg.files : []
  let templateCommands: string[] = []
  const cmdDir = join(workdir, 'templates', 'commands')
  if (existsSync(cmdDir)) {
    try {
      templateCommands = readdirSync(cmdDir)
        .filter(f => f.endsWith('.md'))
        .map(f => `templates/commands/${f}`)
    }
    catch {
      warnings.push(`readdir templates/commands failed`)
    }
  }

  const missingFromPackageFiles = templateCommands.filter((cmd) => {
    return !packageFiles.some((entry) => {
      if (entry === cmd) return true
      if (entry.endsWith('/') && cmd.startsWith(entry)) return true
      if (cmd.startsWith(`${entry}/`)) return true
      return false
    })
  })

  return {
    info: { packageFiles, templateCommands, missingFromPackageFiles },
    warnings,
  }
}

// ---------------------------------------------------------------------------
// 6. 综合入口
// ---------------------------------------------------------------------------

export interface SampleOptions {
  /** 用户机器 home dir。默认 os.homedir()。仅测试用。 */
  homeDir?: string
  /** 项目根目录。传入则采样项目维度（package.json + templates/） */
  workdir?: string
}

/**
 * 一站式采样：plugins / skills / hooks /（可选）packageStructure。
 *
 * 不抛错——所有失败都进 warnings 数组让上层决定要不要 escalate。
 */
export function sampleAll(opts: SampleOptions = {}): GroundTruth {
  const homeDir = opts.homeDir ?? homedir()
  const allWarnings: string[] = []

  const pluginRes = samplePluginList(homeDir)
  allWarnings.push(...pluginRes.warnings)

  const skillRes = sampleSkillList(homeDir)
  allWarnings.push(...skillRes.warnings)

  const hookRes = sampleHookSchema(homeDir)
  allWarnings.push(...hookRes.warnings)

  const result: GroundTruth = {
    sampledAt: new Date().toISOString(),
    plugins: pluginRes.plugins,
    skills: skillRes.skills,
    hooks: hookRes.hooks,
    warnings: allWarnings,
  }

  if (opts.workdir) {
    const pkgRes = samplePackageStructure(opts.workdir)
    if (pkgRes.info) result.packageStructure = pkgRes.info
    allWarnings.push(...pkgRes.warnings)
  }

  return result
}

/**
 * 把 GroundTruth 序列化为人可读的简短摘要（≤500 token），phase-runner prompt
 * 注入用。完整版见 latest.json。
 */
export function summarizeGroundTruth(gt: GroundTruth): string {
  const lines: string[] = []
  lines.push(`# Ground Truth (sampled ${gt.sampledAt})`)
  lines.push('')

  lines.push(`## Plugins (${gt.plugins.length})`)
  for (const p of gt.plugins.slice(0, 20)) {
    const hints = p.subagentTypeHints?.join(', ') ?? '(no hints)'
    lines.push(`- ${p.name} v${p.version} → subagent hints: ${hints}`)
  }
  if (gt.plugins.length > 20) lines.push(`- ...还有 ${gt.plugins.length - 20} 个`)
  lines.push('')

  lines.push(`## Skills (${gt.skills.length}, ${gt.skills.filter(s => s.userInvocable).length} user-invocable)`)
  const invocable = gt.skills.filter(s => s.userInvocable)
  for (const s of invocable.slice(0, 30)) {
    lines.push(`- ${s.name} (${s.category})`)
  }
  if (invocable.length > 30) lines.push(`- ...还有 ${invocable.length - 30} 个 invocable`)
  lines.push('')

  lines.push(`## Hooks (${gt.hooks.length} events)`)
  for (const h of gt.hooks) {
    lines.push(`- ${h.event}: matcher=${h.matcherType}, ${h.hookCount} entry`)
  }
  lines.push('')

  if (gt.packageStructure) {
    const ps = gt.packageStructure
    lines.push('## Package Structure')
    lines.push(`- package.json files: ${ps.packageFiles.length} entries`)
    lines.push(`- templates/commands/*.md: ${ps.templateCommands.length} files`)
    if (ps.missingFromPackageFiles.length > 0) {
      lines.push(`- ⚠️ ${ps.missingFromPackageFiles.length} commands NOT in package.json files: ${ps.missingFromPackageFiles.join(', ')}`)
    }
    else {
      lines.push('- ✅ all commands listed in package.json files')
    }
    lines.push('')
  }

  if (gt.warnings.length > 0) {
    lines.push(`## Warnings (${gt.warnings.length})`)
    for (const w of gt.warnings.slice(0, 10)) lines.push(`- ${w}`)
    if (gt.warnings.length > 10) lines.push(`- ...还有 ${gt.warnings.length - 10} 条`)
  }

  return lines.join('\n')
}
