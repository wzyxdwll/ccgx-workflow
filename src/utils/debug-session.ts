/**
 * Debug Session Helper (CCG v4.0 Phase 11)
 *
 * `/ccg:debug` 重写为 manager + debugger 双层 fresh-context 模式的工程级骨架。
 *
 * 设计前提：v3.0 `/ccg:debug` 是单次双模型并行调用，没持久 session 文件、没
 * 多轮 hypothesis 链、没科学方法约束。GSD ROI #3 移植（02-subagent-matrix.md
 * Section 2.6 gsd-debug-session-manager + gsd-debugger）。
 *
 * 核心抽象：
 *
 *   1. **持久 debug session 文件**：`.context/debug/<slug>.md` 含 hypothesis 链、
 *      next_action、status。每个 hypothesis 必须 falsifiable（有可观察的 fail
 *      条件），不能写"代码可能有 bug"这种空话
 *   2. **科学方法约束**：构造 hypothesis 时强制 `falsifiable_test` 字段非空 +
 *      可执行；status 仅 `open|confirmed|refuted`
 *   3. **三种结构化结果**返回主线（manager 返回字符串，主线只读这个）：
 *      - `ROOT CAUSE FOUND` — 含 root cause 描述 + suggested fix
 *      - `DEBUG COMPLETE` — fix applied + verified
 *      - `CHECKPOINT REACHED` — cap 3 hypothesis 失败 → 升级用户
 *   4. **多 mode**：`find_root_cause_only` / `find_and_fix`
 *      - `find_root_cause_only` 不应用 fix，找到 root cause 即返回
 *      - `find_and_fix` 应用 fix 后跑测试验证；测试不过则继续构造 hypothesis
 *
 * 设计原则（与 phase 4/6/8/9/10 helper 一致）：
 *   - 纯函数；不读文件系统、不调网络、不 spawn 子进程
 *   - 输出结构化对象，由调用方决定如何持久化 / 渲染 / 执行
 *   - 跨平台：路径用 pathe，序列化用 markdown（人类可读 + 增量友好）
 *
 * 调用方：
 *   - `templates/commands/debug.md`（LLM 主线协议描述）
 *   - `templates/commands/agents/debug-session-manager.md`（manager 子 agent）
 *   - `templates/commands/agents/debugger.md`（debugger 子 agent）
 */

import { resolve as resolvePath } from 'pathe'

// ---------------------------------------------------------------------------
// 1. Schema：hypothesis / session / mode / result
// ---------------------------------------------------------------------------

/**
 * 单个 hypothesis 的结构化记录。
 *
 * **falsifiable_test 强制非空**——这是科学方法的核心：每个 hypothesis 必须有
 * 一个可观察的 fail 条件（可以是命令、断言、测试、日志检查），不允许写
 * "代码可能有 bug" 这种无法证伪的空话。
 */
export interface DebugHypothesis {
  /** 自然语言描述假设（如"useState 在 strict mode 下被双次调用导致状态错乱"） */
  description: string
  /** 可证伪的测试 / 命令 / 观察方式（必填，非空白）。
   *  例：`pnpm test foo.test.ts -t "double init"` 或 `console.log 加在 L42 后查 stdout` */
  falsifiable_test: string
  /** 跑完 falsifiable_test 后收集到的证据（命令输出 / log / stack trace）。
   *  status=open 时为空字符串；confirmed/refuted 时记录 */
  evidence: string
  /** open（未验证）/ confirmed（验证通过 → root cause 找到）/ refuted（被证伪，进下一假设） */
  status: 'open' | 'confirmed' | 'refuted'
}

/**
 * Debug session 持久状态——映射 `.context/debug/<slug>.md` 文件。
 *
 * 主线不读这个对象，只读 manager 返回的摘要字符串。session 文件给 manager
 * 自己跨轮恢复用，也给用户事后审计用。
 */
export interface DebugSession {
  /** 短 slug，匹配文件名（如 `useState-strict-mode`） */
  slug: string
  /** 用户描述的 bug 现象 / 错误信息 */
  symptoms: string
  /** Hypothesis 链——按提出顺序排列 */
  hypothesis_chain: DebugHypothesis[]
  /** 下一步动作描述（manager 在每轮末尾写） */
  next_action: string
  /** session 整体状态 */
  status: 'investigating' | 'root_cause_found' | 'escalate'
  /** 模式：仅找根因 / 找根因并修复 */
  mode: DebugMode
}

/** Manager 工作模式。 */
export type DebugMode = 'find_root_cause_only' | 'find_and_fix'

/** Manager 返回主线的三种结构化结果。 */
export type DebugManagerResult =
  | {
      kind: 'ROOT_CAUSE_FOUND'
      root_cause: string
      suggested_fix: string
      slug: string
    }
  | {
      kind: 'DEBUG_COMPLETE'
      root_cause: string
      fix_applied: string
      verification: string
      slug: string
    }
  | {
      kind: 'CHECKPOINT_REACHED'
      reason: string
      hypotheses_tried: number
      slug: string
    }

/**
 * 一次 hypothesis 失败的上限（refuted 数 ≥ 3 即触发 CHECKPOINT_REACHED）。
 *
 * 与 plan-checker `MAX_LOOP=3` / code-fixer `AUTO_CONVERGE_CAP=3` 一致——
 * CCG 全体系硬规约：3 轮没收敛就升级用户，不静默继续。
 */
export const HYPOTHESIS_FAILURE_CAP = 3

// ---------------------------------------------------------------------------
// 2. 路径解析
// ---------------------------------------------------------------------------

/** Session 文件相对工作目录的路径前缀。 */
export const DEBUG_SESSION_DIR = '.context/debug'

/**
 * 给定 workdir 和 slug 计算 session 文件绝对路径。
 *
 * @example
 *   resolveDebugSessionPath('/home/u/proj', 'useState-strict-mode') →
 *     '/home/u/proj/.context/debug/useState-strict-mode.md'
 */
export function resolveDebugSessionPath(workdir: string, slug: string): string {
  if (!slug || !slug.trim()) {
    throw new Error('slug must be non-empty')
  }
  return resolvePath(workdir, DEBUG_SESSION_DIR, `${slug}.md`)
}

// ---------------------------------------------------------------------------
// 3. 构造 + 校验 hypothesis（科学方法守门员）
// ---------------------------------------------------------------------------

/**
 * 构造一个新的 hypothesis（status=open，evidence=空）。
 *
 * **强制约束**：
 *   - description 非空
 *   - falsifiable_test 非空白（光空格/换行不算）
 *
 * 如果 falsifiable_test 缺失或仅含空白 → 抛错。这是科学方法的硬约束：
 * 每个 hypothesis 必须可证伪。
 */
export function makeHypothesis(input: {
  description: string
  falsifiable_test: string
}): DebugHypothesis {
  if (!input.description || !input.description.trim()) {
    throw new Error('hypothesis.description must be non-empty')
  }
  if (!input.falsifiable_test || !input.falsifiable_test.trim()) {
    throw new Error(
      'hypothesis.falsifiable_test must be non-empty (科学方法硬约束：每个假设必须可证伪)',
    )
  }
  return {
    description: input.description.trim(),
    falsifiable_test: input.falsifiable_test.trim(),
    evidence: '',
    status: 'open',
  }
}

/**
 * 把 open hypothesis 标记为 confirmed/refuted，附上 evidence。
 *
 * 不允许 open → open（要更新就附 evidence + 选定状态）；
 * 不允许逆向（confirmed/refuted → open）。
 */
export function resolveHypothesis(
  hypothesis: DebugHypothesis,
  outcome: 'confirmed' | 'refuted',
  evidence: string,
): DebugHypothesis {
  if (hypothesis.status !== 'open') {
    throw new Error(
      `hypothesis already resolved as ${hypothesis.status}; cannot re-resolve`,
    )
  }
  if (!evidence || !evidence.trim()) {
    throw new Error('evidence must be non-empty when resolving hypothesis')
  }
  return {
    ...hypothesis,
    status: outcome,
    evidence: evidence.trim(),
  }
}

// ---------------------------------------------------------------------------
// 4. Session 决策：何时返回三种结构化结果
// ---------------------------------------------------------------------------

/**
 * 统计 session 中 refuted hypothesis 数。
 */
export function countRefuted(session: DebugSession): number {
  return session.hypothesis_chain.filter((h) => h.status === 'refuted').length
}

/**
 * 找到第一个 confirmed hypothesis（如有）。
 */
export function findConfirmed(session: DebugSession): DebugHypothesis | null {
  return session.hypothesis_chain.find((h) => h.status === 'confirmed') ?? null
}

/**
 * 决定 manager 是否要返回主线（输出三种结构化结果之一）；返回 null 表示继续。
 *
 * 决策树：
 *   1. 有 confirmed hypothesis：
 *      - mode=find_root_cause_only → ROOT_CAUSE_FOUND
 *      - mode=find_and_fix 但 status≠root_cause_found（fix 未跑/未验）→ null（继续）
 *      - mode=find_and_fix 且 status=root_cause_found → DEBUG_COMPLETE
 *   2. refuted ≥ HYPOTHESIS_FAILURE_CAP → CHECKPOINT_REACHED
 *   3. 否则 → null（继续构造下一 hypothesis）
 */
export function decideSessionOutcome(
  session: DebugSession,
  fixDetails?: { fix_applied: string; verification: string },
): DebugManagerResult | null {
  const confirmed = findConfirmed(session)
  if (confirmed) {
    if (session.mode === 'find_root_cause_only') {
      return {
        kind: 'ROOT_CAUSE_FOUND',
        root_cause: confirmed.description,
        suggested_fix: deriveSuggestedFix(confirmed),
        slug: session.slug,
      }
    }
    // find_and_fix：必须有 fix + verification 才能返回 DEBUG_COMPLETE
    if (
      session.status === 'root_cause_found' &&
      fixDetails &&
      fixDetails.fix_applied.trim() &&
      fixDetails.verification.trim()
    ) {
      return {
        kind: 'DEBUG_COMPLETE',
        root_cause: confirmed.description,
        fix_applied: fixDetails.fix_applied.trim(),
        verification: fixDetails.verification.trim(),
        slug: session.slug,
      }
    }
    return null
  }

  if (countRefuted(session) >= HYPOTHESIS_FAILURE_CAP) {
    return {
      kind: 'CHECKPOINT_REACHED',
      reason: `${HYPOTHESIS_FAILURE_CAP} hypotheses refuted without finding root cause; escalating to user`,
      hypotheses_tried: session.hypothesis_chain.length,
      slug: session.slug,
    }
  }

  return null
}

/**
 * 从 confirmed hypothesis 推断 suggested_fix 的"占位"。debugger agent 应在
 * confirm 时直接填到 evidence 里，这里不做 LLM 调用——只把 evidence 中标
 * `Suggested fix:` 段抽出来；找不到时返回兜底说明。
 */
function deriveSuggestedFix(h: DebugHypothesis): string {
  const m = h.evidence.match(/Suggested fix:\s*([\s\S]+?)(?:\n\n|$)/i)
  if (m && m[1].trim()) {
    return m[1].trim()
  }
  // 兜底：让主线去看 evidence 全文
  return `(see evidence in session: ${h.evidence.slice(0, 80)}${h.evidence.length > 80 ? '...' : ''})`
}

// ---------------------------------------------------------------------------
// 5. Session 序列化（markdown，人类可读）
// ---------------------------------------------------------------------------

/**
 * 把 session 序列化为 markdown 文本。结构：
 *   - frontmatter：slug / mode / status / next_action
 *   - Symptoms 段
 *   - Hypothesis Chain 段（每假设一个 ###，带状态徽标）
 */
export function serializeSession(session: DebugSession): string {
  const lines: string[] = []
  lines.push('---')
  lines.push(`slug: ${session.slug}`)
  lines.push(`mode: ${session.mode}`)
  lines.push(`status: ${session.status}`)
  lines.push(`next_action: ${escapeYamlValue(session.next_action)}`)
  lines.push(`hypotheses_total: ${session.hypothesis_chain.length}`)
  lines.push(`hypotheses_refuted: ${countRefuted(session)}`)
  lines.push('---')
  lines.push('')
  lines.push('# Debug Session')
  lines.push('')
  lines.push('## Symptoms')
  lines.push('')
  lines.push(session.symptoms.trim() || '(none recorded)')
  lines.push('')
  lines.push('## Hypothesis Chain')
  lines.push('')
  if (session.hypothesis_chain.length === 0) {
    lines.push('_(no hypotheses yet)_')
  } else {
    session.hypothesis_chain.forEach((h, i) => {
      const badge =
        h.status === 'confirmed' ? '✅' : h.status === 'refuted' ? '❌' : '🟡'
      lines.push(`### H${i + 1} ${badge} ${h.status.toUpperCase()}`)
      lines.push('')
      lines.push(`**Description**: ${h.description}`)
      lines.push('')
      lines.push(`**Falsifiable test**: ${h.falsifiable_test}`)
      lines.push('')
      if (h.evidence) {
        lines.push(`**Evidence**:`)
        lines.push('')
        lines.push('```')
        lines.push(h.evidence)
        lines.push('```')
        lines.push('')
      }
    })
  }
  return lines.join('\n')
}

function escapeYamlValue(s: string): string {
  // 简单保护：含特殊字符就用双引号包；否则裸值
  if (/[:#\n"'\\]/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`
  }
  return s
}

// ---------------------------------------------------------------------------
// 6. 把结果格式化为给主线的紧凑字符串
// ---------------------------------------------------------------------------

/**
 * Manager 返回主线的紧凑摘要字符串（≤200 token，主线只读这个）。
 *
 * 严格三种 kind 决定的格式，主线脚本可正则解析。
 */
export function formatManagerSummary(result: DebugManagerResult): string {
  switch (result.kind) {
    case 'ROOT_CAUSE_FOUND':
      return [
        `STATUS: ROOT_CAUSE_FOUND`,
        `SLUG: ${result.slug}`,
        `ROOT_CAUSE: ${truncate(result.root_cause, 200)}`,
        `SUGGESTED_FIX: ${truncate(result.suggested_fix, 200)}`,
      ].join('\n')
    case 'DEBUG_COMPLETE':
      return [
        `STATUS: DEBUG_COMPLETE`,
        `SLUG: ${result.slug}`,
        `ROOT_CAUSE: ${truncate(result.root_cause, 160)}`,
        `FIX_APPLIED: ${truncate(result.fix_applied, 160)}`,
        `VERIFICATION: ${truncate(result.verification, 160)}`,
      ].join('\n')
    case 'CHECKPOINT_REACHED':
      return [
        `STATUS: CHECKPOINT_REACHED`,
        `SLUG: ${result.slug}`,
        `HYPOTHESES_TRIED: ${result.hypotheses_tried}`,
        `REASON: ${truncate(result.reason, 240)}`,
      ].join('\n')
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 3) + '...'
}
