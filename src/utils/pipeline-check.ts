/**
 * Pipeline Check (CCG v4.3 Phase 25).
 *
 * 主线 spawn phase-runner 完成 commit 后，强制跑一次端到端 release pipeline 验证：
 *   1. pnpm pack 看 tarball 能否生成
 *   2. 解 tarball 列内容
 *   3. 比对 templates/commands/*.md 实际文件 vs package.json `files` 数组——找漏列
 *
 * v4.2.0 release blocker `debate.md` 漏 package.json files 这种事就由这个 helper
 * 在 commit 后立刻被抓，不必等用户 cold-start。
 *
 * 设计原则（与 v4.0 phase-context / debug-session / wave-scheduler 一致）：
 *   - 纯函数 + 几个 spawn 子进程的入口；不读 ~/.claude/、不写持久状态
 *   - 输入 workdir 路径，输出结构化 PipelineCheckReport
 *   - 失败优雅：pnpm 没装 / tar 没装 / 子进程 crash 都返回 ok=false + 错误，不抛
 *   - Cross-platform：用 child_process.execSync + node:fs + node:path 内建模块
 *
 * 调用方（主线）：
 *   - autonomous.md Step 4.4 phase 完成后（runPipelineCheck → 任何 critical → blocker 路径）
 *   - 用户手动跑 `node -e "..."` 验证
 *
 * 不做：
 *   - 不实际跑 npm install -g（破坏用户全局环境，留给用户手动）
 *   - 不修复发现的问题（建议性输出，主线决策）
 *   - 不读 settings.json / ~/.claude/（那是 ground-truth-sampler 职责，P26）
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// 1. Schema
// ---------------------------------------------------------------------------

/** 单条错误的分类。category 用于主线决策严重程度。 */
export type PipelineErrorCategory =
  | 'pack-failed'
  | 'tar-extract-failed'
  | 'missing-from-tarball'
  | 'package-json-missing'
  | 'package-json-invalid'

/**
 * 单条错误。message 给主线 / 用户读，detail 是可选 debug 信息。
 */
export interface PipelineError {
  category: PipelineErrorCategory
  message: string
  detail?: string
}

/**
 * Pipeline check 完整报告。ok=true 才允许 phase 推进。
 */
export interface PipelineCheckReport {
  ok: boolean
  errors: PipelineError[]
  warnings: string[]
  /** tarball 路径（pack 成功时填） */
  tarballPath?: string
  /** tarball 内文件清单（前缀通常是 "package/"） */
  tarballEntries?: string[]
  /**
   * templates/commands/*.md 中存在但 package.json `files` 漏列的文件。
   * 这是 v4.2.0 debate.md 漏 register 那种事故的最常见 root cause。
   */
  missingFromPackageJson: string[]
}

/** runPipelineCheck 输入选项 */
export interface PipelineCheckOptions {
  /** 项目根目录（含 package.json + templates/）。默认 process.cwd() */
  workdir?: string
  /** 是否真跑 `pnpm pack`（默认 true）；false 时跳过仅做 package.json 静态比对 */
  doPnpmPack?: boolean
}

// ---------------------------------------------------------------------------
// 2. pnpm pack — 生成 tarball
// ---------------------------------------------------------------------------

/**
 * 跑 `pnpm pack` 在 workdir 下，返回生成的 tarball 绝对路径。
 *
 * pnpm pack 输出最后一行是 tarball 文件名（如 "ccg-workflow-4.3.0.tgz"）。
 * 失败 → throw 给上层 catch。
 */
export function runPnpmPack(workdir: string): string {
  const out = execSync('pnpm pack', {
    cwd: workdir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines = out.trim().split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length === 0) {
    throw new Error('pnpm pack produced no output')
  }
  // 最后一行是 tarball 文件名
  const tarballName = lines[lines.length - 1].trim()
  if (!tarballName.endsWith('.tgz')) {
    throw new Error(`pnpm pack last line is not a tgz: "${tarballName}"`)
  }
  return join(workdir, tarballName)
}

// ---------------------------------------------------------------------------
// 3. tar 列文件清单
// ---------------------------------------------------------------------------

/**
 * 列 tarball 内所有文件路径（不解压）。tar 工具 cross-platform：
 * Unix tar / Windows bsdtar / Git Bash tar 都支持 `-tzf`。
 *
 * 失败 → throw（多半是 tar 工具不存在）。
 */
export function auditTarballContents(tarballPath: string): string[] {
  const out = execSync(`tar -tzf "${tarballPath}"`, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return out
    .trim()
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0)
}

// ---------------------------------------------------------------------------
// 4. package.json files 数组 vs templates/commands/ 实际文件 比对
// ---------------------------------------------------------------------------

/**
 * 比对 `templates/commands/*.md` 实际存在的文件 vs `package.json` `files`
 * 数组 / tarball 实际打包内容，找出漏列文件。
 *
 * 这是 v4.2.0 release blocker `debate.md` 漏 package.json files 那种事故
 * 的核心检测——`templates/commands/debate.md` 在 git 树里有但 package.json
 * `files` 数组未列出，导致 npm pack 不打入 tarball。
 *
 * 检测分两层：
 *   1. 实际文件 vs package.json files 静态比对（不需要 tarball）
 *   2. 实际文件 vs tarball entries 比对（如果 tarball 提供）
 *
 * 任一层报漏列即视为问题。
 */
export function verifyAllCommandsIncluded(
  workdir: string,
  tarballEntries?: string[],
): {
  packageFiles: string[]
  actualCommands: string[]
  missingInPackageJson: string[]
  missingInTarball: string[]
} {
  const result = {
    packageFiles: [] as string[],
    actualCommands: [] as string[],
    missingInPackageJson: [] as string[],
    missingInTarball: [] as string[],
  }

  // 1. 读 package.json files 数组
  const pkgPath = join(workdir, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      if (Array.isArray(pkg.files)) result.packageFiles = pkg.files
    }
    catch {
      // 主调函数会捕捉
    }
  }

  // 2. 列实际 templates/commands/*.md
  const cmdDir = join(workdir, 'templates', 'commands')
  if (existsSync(cmdDir)) {
    const files = readdirSync(cmdDir)
      .filter(f => f.endsWith('.md'))
    result.actualCommands = files.map(f => `templates/commands/${f}`)
  }

  // 3. 比对 packageFiles —— 容许目录前缀匹配（如 "templates/commands/" 整个目录）
  for (const cmd of result.actualCommands) {
    const matched = result.packageFiles.some((entry) => {
      if (entry === cmd) return true
      // 目录形式：以 / 结尾或者刚好是父路径前缀
      if (entry.endsWith('/') && cmd.startsWith(entry)) return true
      if (cmd.startsWith(entry + '/')) return true
      return false
    })
    if (!matched) result.missingInPackageJson.push(cmd)
  }

  // 4. 如果给了 tarball entries，检查 tarball 是否真含每个 actual command
  if (tarballEntries) {
    const tarballSet = new Set(
      tarballEntries
        .map(e => e.replace(/^package\//, ''))
        .filter(e => e.startsWith('templates/commands/') && e.endsWith('.md')),
    )
    for (const cmd of result.actualCommands) {
      if (!tarballSet.has(cmd)) result.missingInTarball.push(cmd)
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// 5. 主入口
// ---------------------------------------------------------------------------

/**
 * 端到端 pipeline check：pack → audit → 漏列检测。
 *
 * 主线 spawn phase-runner 完成 commit 后调一次。任一 critical 错误（pack-failed
 * / missing-from-tarball / package-json-missing）→ ok=false → 主线进 blocker 路径。
 *
 * @param opts 配置；workdir 默认 process.cwd()
 * @returns PipelineCheckReport（不抛错，所有失败模式都进 errors 数组）
 */
export function runPipelineCheck(
  opts: PipelineCheckOptions = {},
): PipelineCheckReport {
  const workdir = opts.workdir ?? process.cwd()
  const doPnpmPack = opts.doPnpmPack ?? true
  const errors: PipelineError[] = []
  const warnings: string[] = []
  let tarballPath: string | undefined
  let tarballEntries: string[] | undefined

  // pnpm pack
  if (doPnpmPack) {
    try {
      tarballPath = runPnpmPack(workdir)
    }
    catch (e) {
      errors.push({
        category: 'pack-failed',
        message: 'pnpm pack 失败 — 可能是 build 错或 pnpm 未装',
        detail: e instanceof Error ? e.message : String(e),
      })
    }

    if (tarballPath) {
      try {
        tarballEntries = auditTarballContents(tarballPath)
      }
      catch (e) {
        errors.push({
          category: 'tar-extract-failed',
          message: 'tar -tzf 失败 — 可能是 tar 工具未装或 tarball 损坏',
          detail: e instanceof Error ? e.message : String(e),
        })
      }
    }
  }

  // 静态 + tarball 双层比对
  const verifyResult = verifyAllCommandsIncluded(workdir, tarballEntries)

  if (verifyResult.packageFiles.length === 0) {
    const pkgPath = join(workdir, 'package.json')
    if (!existsSync(pkgPath)) {
      errors.push({
        category: 'package-json-missing',
        message: `package.json 不存在: ${pkgPath}`,
      })
    }
    else {
      errors.push({
        category: 'package-json-invalid',
        message: 'package.json `files` 数组为空或解析失败',
      })
    }
  }

  if (verifyResult.missingInPackageJson.length > 0) {
    const list = verifyResult.missingInPackageJson
    errors.push({
      category: 'missing-from-tarball',
      message:
        `${list.length} 个 templates/commands/*.md 文件存在但 package.json files 漏列`
        + `（这是 v4.2.0 debate.md 漏 register 同类型事故）：${list.slice(0, 5).join(', ')}`
        + `${list.length > 5 ? `, ...还有 ${list.length - 5} 个` : ''}`,
      detail: list.join('\n'),
    })
  }

  if (verifyResult.missingInTarball.length > 0) {
    const list = verifyResult.missingInTarball
    errors.push({
      category: 'missing-from-tarball',
      message:
        `${list.length} 个 templates/commands/*.md 文件存在但 tarball 实际未打包：${list.slice(0, 5).join(', ')}`
        + `${list.length > 5 ? `, ...还有 ${list.length - 5} 个` : ''}`,
      detail: list.join('\n'),
    })
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    tarballPath,
    tarballEntries,
    missingFromPackageJson: verifyResult.missingInPackageJson,
  }
}

/**
 * 把 PipelineCheckReport 渲染为人可读的 markdown，主线给用户展示用。
 */
export function renderPipelineReport(report: PipelineCheckReport): string {
  const lines: string[] = []
  lines.push(`## Pipeline Check ${report.ok ? '✅' : '❌'}`)
  lines.push('')

  if (report.tarballPath) {
    lines.push(`- Tarball: \`${report.tarballPath}\``)
  }
  if (report.tarballEntries) {
    lines.push(`- Tarball 含 ${report.tarballEntries.length} 文件`)
  }
  lines.push('')

  if (report.errors.length > 0) {
    lines.push('### ❌ Errors')
    for (const err of report.errors) {
      lines.push(`- [${err.category}] ${err.message}`)
    }
    lines.push('')
  }

  if (report.warnings.length > 0) {
    lines.push('### ⚠️ Warnings')
    for (const w of report.warnings) lines.push(`- ${w}`)
    lines.push('')
  }

  if (report.ok) {
    lines.push('All checks passed. Tarball 内容跟 templates/commands/ 一致。')
  }

  return lines.join('\n')
}
