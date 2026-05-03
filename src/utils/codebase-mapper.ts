/**
 * codebase-mapper helper (CCG v4.0 Phase 3)
 *
 * Subagent template `templates/commands/agents/codebase-mapper.md` 在 4 路并行
 * 模式下把代码库扫描结果写到 `.context/codebase/` 七类文件。本模块导出 focus →
 * 输出文件路径的契约映射，供单元测试静态校验 + init.md 模板生成时参考。
 *
 * 调用方（init.md / plan.md / execute.md）spawn 4 个 codebase-mapper 实例时，
 * 每个实例只处理一个 focus，写自己负责的文件。主线只接收 `WROTE: ...` 单行确认。
 */

export type CodebaseMapperFocus = 'tech' | 'arch' | 'quality' | 'concerns'

export const ALL_FOCUSES: readonly CodebaseMapperFocus[] = [
  'tech',
  'arch',
  'quality',
  'concerns',
] as const

/**
 * focus → 该 focus 实例负责写入的输出文件（相对 workdir 根目录）
 *
 * 总计 7 个文件，分布在 4 个 focus（tech / arch / quality 各 2，concerns 1）。
 */
export const CODEBASE_MAPPER_OUTPUTS: Readonly<Record<CodebaseMapperFocus, readonly string[]>> = {
  tech: ['.context/codebase/STACK.md', '.context/codebase/INTEGRATIONS.md'],
  arch: ['.context/codebase/ARCHITECTURE.md', '.context/codebase/STRUCTURE.md'],
  quality: ['.context/codebase/CONVENTIONS.md', '.context/codebase/TESTING.md'],
  concerns: ['.context/codebase/CONCERNS.md'],
} as const

/**
 * 获取某个 focus 应写入的输出文件列表。
 */
export function getOutputFilesForFocus(focus: CodebaseMapperFocus): readonly string[] {
  const out = CODEBASE_MAPPER_OUTPUTS[focus]
  if (!out) {
    throw new Error(
      `Invalid focus "${String(focus)}"; expected one of: ${ALL_FOCUSES.join(', ')}`,
    )
  }
  return out
}

/**
 * 校验 focus 字符串是否合法。
 */
export function isValidFocus(value: unknown): value is CodebaseMapperFocus {
  return (
    typeof value === 'string'
    && (ALL_FOCUSES as readonly string[]).includes(value)
  )
}

/**
 * 返回 4 路并行 spawn 的预期文件路径全集（去重 + 稳定顺序）。
 *
 * 用途：单元测试断言 4 路并行覆盖 7 个文件且无遗漏。
 */
export function getAllExpectedOutputs(): readonly string[] {
  const all = ALL_FOCUSES.flatMap((f) => CODEBASE_MAPPER_OUTPUTS[f])
  // 静态契约下不应有重复，但仍走一次 Set 保险
  return Array.from(new Set(all))
}

/**
 * 解析 codebase-mapper subagent 单行返回 `WROTE: ... | FOCUS: ... | EVIDENCE_COUNT: ...`
 *
 * 主线收到 4 路并行返回后用本函数把 4 行结构化为对象，做合法性 + 完整性校验。
 */
export interface CodebaseMapperReturn {
  wroteFiles: string[]
  focus: CodebaseMapperFocus
  evidenceCount: number
}

export function parseCodebaseMapperReturn(text: string): CodebaseMapperReturn {
  // 匹配 WROTE / FOCUS / EVIDENCE_COUNT 三段，| 或换行均可分隔
  const wroteMatch = text.match(/WROTE\s*:\s*([^\n|]+)/i)
  const focusMatch = text.match(/FOCUS\s*:\s*(\w+)/i)
  const evidenceMatch = text.match(/EVIDENCE_COUNT\s*:\s*(\d+)/i)

  if (!wroteMatch) {
    throw new Error('codebase-mapper return missing WROTE: field')
  }
  if (!focusMatch) {
    throw new Error('codebase-mapper return missing FOCUS: field')
  }

  const focus = focusMatch[1].toLowerCase()
  if (!isValidFocus(focus)) {
    throw new Error(
      `codebase-mapper return has invalid FOCUS "${focus}"; expected: ${ALL_FOCUSES.join(', ')}`,
    )
  }

  const wroteFiles = wroteMatch[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  const evidenceCount = evidenceMatch ? parseInt(evidenceMatch[1], 10) : 0

  return { wroteFiles, focus, evidenceCount }
}
