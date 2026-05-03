/**
 * Code Fixer Worktree Helper (CCG v4.0 Phase 10)
 *
 * `/ccg:review --fix` 闭环修复模式的工程级保护层。
 *
 * 设计前提：fixer 是后台进程，会做 commit，必须不能撞前台用户工作。
 * 为此引入：
 *
 *   1. **强制 git worktree 隔离**：临时目录 `mktemp -d` + 临时分支
 *      `ccg-reviewfix/<base-sha7>-$$`，attach worktree 到该新分支（同一分支
 *      不能被两个 worktree 同时 checkout，#2990 真实 bug 反推）
 *   2. **Recovery sentinel**：worktree 创建成功后才写
 *      `.context/review-fix-recovery-pending.json`，记录 worktree_path /
 *      branch / reviewfix_branch / base_sha / started_at。任何中断
 *      （OOM/重启/Ctrl-C）下次启动能检测并清理孤儿 worktree
 *   3. **Transactional cleanup tail（4 步严格顺序）**：
 *        a. `git merge --ff-only` 主分支 ← reviewfix 分支
 *        b. `git worktree remove --force <tmp-path>`
 *        c. `git branch -D <reviewfix-branch>`（仅 ff-only 成功才执行）
 *        d. 删除 sentinel 文件
 *      倒序就是 GSD #2839 真实 bug 重现，不能乱
 *   4. **per-finding rollback** = `git checkout -- {file}`，绝不用 Write
 *      工具回滚（部分写入会损坏文件）
 *
 * 设计原则（与 phase 4 / 6 / 8 / 9 helper 一致）：
 *   - 纯函数；不读文件系统、不调网络、不 spawn 子进程
 *   - 输出结构化对象 + git/shell 命令字符串，由调用方决定如何执行
 *   - 跨平台：Unix `mktemp -d` 与 Windows `tempdir` 由调用方按 platform 选
 *
 * 调用方：
 *   - `templates/commands/review.md` 的 `--fix` 流程（LLM 主线）
 *   - `templates/commands/agents/code-fixer.md` subagent
 *   - 启动前的 sentinel 恢复扫描（`templates/commands/autonomous.md`
 *     或 review.md 自身）
 */

import { resolve as resolvePath } from 'pathe'

// ---------------------------------------------------------------------------
// 1. Recovery sentinel schema
// ---------------------------------------------------------------------------

/**
 * Sentinel 文件持久化的字段。worktree 创建成功后立即写入，cleanup 第 4 步
 * 删除。任何中断（OOM/Ctrl-C/重启/git 进程被杀）都会留下孤儿 sentinel +
 * 孤儿 worktree，下次启动 `findPendingSentinel()` 能检测并清理。
 */
export interface ReviewFixSentinel {
  /** Worktree 临时目录绝对路径，例：`/tmp/ccg-reviewfix-XXXXXX` 或
   *  `C:\\Users\\X\\AppData\\Local\\Temp\\ccg-reviewfix-XXXXXX` */
  worktree_path: string
  /** 主分支名，cleanup 第 1 步 ff-only merge 的目标，例：`master`/`main`/
   *  `feature/foo`。**注意**：是用户当前所在分支，不是 reviewfix 分支 */
  branch: string
  /** 临时分支名，例：`ccg-reviewfix/abc1234-12345`（base-sha7 + pid） */
  reviewfix_branch: string
  /** 本次修复 base 的 commit SHA（创建 worktree 时的 HEAD），用于审计追溯 */
  base_sha: string
  /** ISO 时间戳，例：`2026-05-03T10:30:00.000Z` */
  started_at: string
}

/**
 * Sentinel 文件相对项目根目录的路径。
 *
 * 选 `.context/` 而非 `/tmp/`，因为：
 *   - 项目级而非全局，多项目并行 review-fix 不互踩
 *   - `.context/` 已是 CCG 项目状态目录（phase 2 引入），与 phase / UAT
 *     状态文件同位
 *   - 项目被 `git clone` 复制到新机器时 sentinel 不会跟过去（避免假阳性）
 */
export const SENTINEL_RELATIVE_PATH = '.context/review-fix-recovery-pending.json'

/**
 * 在工作目录解析 sentinel 文件的绝对路径。
 *
 * @example
 *   resolveSentinelPath('/home/user/project') →
 *     '/home/user/project/.context/review-fix-recovery-pending.json'
 */
export function resolveSentinelPath(workdir: string): string {
  return resolvePath(workdir, SENTINEL_RELATIVE_PATH)
}

/**
 * 序列化 sentinel 为 JSON 字符串（带换行，便于 cat 显示）。
 *
 * 调用方拿这个字符串后用 `fs.writeFileSync(path, json)` 写盘。**严禁**先创建
 * worktree 失败时也写 sentinel——sentinel 是 "worktree 已存在" 的承诺。
 */
export function serializeSentinel(sentinel: ReviewFixSentinel): string {
  return JSON.stringify(sentinel, null, 2) + '\n'
}

/**
 * 解析 sentinel 文件内容。坏 JSON / 缺字段返回 null（不抛异常，便于上游
 * 决定是否日志告警 vs 静默清理）。
 */
export function parseSentinel(content: string): ReviewFixSentinel | null {
  try {
    const obj = JSON.parse(content) as Partial<ReviewFixSentinel>
    if (
      typeof obj.worktree_path !== 'string' ||
      typeof obj.branch !== 'string' ||
      typeof obj.reviewfix_branch !== 'string' ||
      typeof obj.base_sha !== 'string' ||
      typeof obj.started_at !== 'string'
    ) {
      return null
    }
    return obj as ReviewFixSentinel
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 2. 命名规则：临时分支 + 临时 worktree 目录
// ---------------------------------------------------------------------------

/**
 * 生成临时分支名。
 *
 * 格式：`ccg-reviewfix/<base-sha7>-<pid>`
 *
 * 选这个格式因为：
 *   - 命名空间 `ccg-reviewfix/` 让 `git branch -D ccg-reviewfix/*` 批量清理
 *     孤儿分支变成单条命令
 *   - base-sha7 让分支名与具体 base commit 强绑定，多次 review-fix 之间
 *     不冲突
 *   - pid 后缀防止同一 base 上并发跑两次 review-fix（虽不推荐，但发生时
 *     不会撞分支名）
 *
 * @param baseSha 完整 SHA 或 sha7 都接受；内部会截前 7 位
 * @param pid    进程 ID（调用方传 `process.pid`），跨平台稳定
 */
export function buildReviewfixBranch(baseSha: string, pid: number): string {
  if (!baseSha || baseSha.length < 7) {
    throw new Error(
      `buildReviewfixBranch: baseSha must be >= 7 chars, got '${baseSha}'`,
    )
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`buildReviewfixBranch: pid must be a positive integer, got ${pid}`)
  }
  return `ccg-reviewfix/${baseSha.slice(0, 7)}-${pid}`
}

/**
 * 生成临时 worktree 目录的**模板**字符串（供 `mktemp -d` / Windows `tempdir`
 * 调用方使用）。
 *
 * Unix:    `mktemp -d "/tmp/ccg-reviewfix-XXXXXX"`
 * Windows: `New-Item -ItemType Directory "$env:TEMP\\ccg-reviewfix-<random>"`
 *
 * 这里只返回前缀字符串 `ccg-reviewfix-`，由调用方按平台拼接 mktemp 命令。
 */
export const WORKTREE_DIR_PREFIX = 'ccg-reviewfix-'

// ---------------------------------------------------------------------------
// 3. Worktree 创建：构造命令序列
// ---------------------------------------------------------------------------

/**
 * Worktree 创建步骤的描述（调用方拿去按顺序 Bash 执行）。每步失败就回滚
 * 已成功的步骤，**不**写 sentinel。
 */
export interface WorktreeSetupPlan {
  /** 临时分支名，例：`ccg-reviewfix/abc1234-12345` */
  branch: string
  /** worktree 临时目录占位（实际由 `mktemp -d` 决定，调用方填） */
  worktreeDirHint: string
  /** 第 1 步：创建 worktree + 临时分支（一条原子命令） */
  createCommand: (worktreePath: string) => string
  /** 失败时清理：worktree remove + branch -D（顺序倒过来，因为还没 merge） */
  abortCleanupCommands: (worktreePath: string) => readonly string[]
}

/**
 * 准备 worktree 创建 plan。
 *
 * 输入 baseSha 和 pid，输出**命令构造器**，让调用方根据 mktemp 动态产生的
 * worktree 路径填充。
 *
 * @example
 *   const plan = planWorktreeSetup({ baseSha: 'abc1234567', pid: 12345 })
 *   const wtPath = '/tmp/ccg-reviewfix-AbCdEf'  // mktemp -d 输出
 *   exec(plan.createCommand(wtPath))
 *   // → "git worktree add '/tmp/ccg-reviewfix-AbCdEf' \
 *   //    -b 'ccg-reviewfix/abc1234-12345' abc1234567"
 */
export function planWorktreeSetup(opts: {
  baseSha: string
  pid: number
}): WorktreeSetupPlan {
  const branch = buildReviewfixBranch(opts.baseSha, opts.pid)
  return {
    branch,
    worktreeDirHint: WORKTREE_DIR_PREFIX,
    createCommand: (worktreePath: string) =>
      `git worktree add ${shellQuote(worktreePath)} -b ${shellQuote(branch)} ${opts.baseSha}`,
    abortCleanupCommands: (worktreePath: string) => [
      // 顺序：worktree 先 remove，再删未 merge 的分支
      `git worktree remove --force ${shellQuote(worktreePath)}`,
      `git branch -D ${shellQuote(branch)}`,
    ],
  }
}

// ---------------------------------------------------------------------------
// 4. Transactional cleanup tail（4 步严格顺序）—— 核心
// ---------------------------------------------------------------------------

/**
 * Cleanup 步骤标识，按**强制顺序**枚举。
 *
 * **倒序就是 GSD #2839 真实 bug 重现**——必须严格按此顺序：
 *
 *   1. `merge_ff_only`：主分支 fast-forward merge reviewfix 分支
 *   2. `worktree_remove`：删除 worktree 目录（git 会同时解除 worktree 注册）
 *   3. `branch_delete`：删除 reviewfix 临时分支（**仅** step 1 成功才执行）
 *   4. `sentinel_remove`：删除 `.context/review-fix-recovery-pending.json`
 *
 * 为什么必须这个顺序：
 *
 *   - 先 merge，再删 worktree：merge 失败（如主分支被前台用户改动）时，
 *     worktree 还在，sentinel 还在，下次启动可恢复或人工介入
 *   - 先删 worktree，再删分支：worktree 还在时不能删它指向的分支（git 拒绝）
 *   - 仅 ff-only 成功才删分支：merge 失败但 worktree 已删的话，分支保留，
 *     用户能手动 cherry-pick 找回 fix（**关键**——丢分支 = 丢工作）
 *   - 最后删 sentinel：sentinel 是"清理未完成"的标志，只有所有动作都成功
 *     才删，否则下次启动恢复扫描必须能看到它
 */
export type CleanupStepId =
  | 'merge_ff_only'
  | 'worktree_remove'
  | 'branch_delete'
  | 'sentinel_remove'

/**
 * Cleanup 步骤的强制顺序（这是工程契约，不能乱）。
 */
export const CLEANUP_STEP_ORDER: readonly CleanupStepId[] = [
  'merge_ff_only',
  'worktree_remove',
  'branch_delete',
  'sentinel_remove',
] as const

/**
 * 单步 cleanup 描述。
 */
export interface CleanupStep {
  id: CleanupStepId
  /** 给 LLM / 日志看的人类可读描述 */
  description: string
  /** 实际要 Bash 执行的命令（sentinel_remove 不返回命令，由调用方 fs.rm） */
  command: string | null
  /**
   * 上一步失败时是否仍执行本步。
   *
   * - `merge_ff_only` 失败 → 后续全部跳过（worktree 留着，分支留着，sentinel
   *   留着，等用户介入或下次恢复）
   * - `worktree_remove` 失败 → 不删分支（git 会拒绝，且用户可能想看 worktree
   *   内容），sentinel 也不删
   * - `branch_delete` 失败 → 不删 sentinel（管理员可手动清理后再删）
   *
   * 即：**任何步失败 → 立即停止后续步骤**。
   */
  haltOnPriorFailure: true
}

/**
 * 构造 cleanup 全套命令序列。调用方按 `CLEANUP_STEP_ORDER` 顺序执行，
 * 任何一步失败就立即停（不继续）。
 *
 * @param sentinel 当前活动的 sentinel（含 worktree_path / branch /
 *                 reviewfix_branch）
 * @returns 4 个步骤的有序数组；步骤 4 的 command 为 null（fs 操作非 shell）
 */
export function planTransactionalCleanup(
  sentinel: ReviewFixSentinel,
): readonly CleanupStep[] {
  return [
    {
      id: 'merge_ff_only',
      description: `Fast-forward merge ${sentinel.reviewfix_branch} into ${sentinel.branch}`,
      command:
        // -- 切回主分支再 ff-only merge（若已在主分支，git 自动忽略 checkout）
        `git checkout ${shellQuote(sentinel.branch)} && ` +
        `git merge --ff-only ${shellQuote(sentinel.reviewfix_branch)}`,
      haltOnPriorFailure: true,
    },
    {
      id: 'worktree_remove',
      description: `Remove worktree at ${sentinel.worktree_path}`,
      command: `git worktree remove --force ${shellQuote(sentinel.worktree_path)}`,
      haltOnPriorFailure: true,
    },
    {
      id: 'branch_delete',
      description: `Delete reviewfix branch ${sentinel.reviewfix_branch}`,
      command: `git branch -D ${shellQuote(sentinel.reviewfix_branch)}`,
      haltOnPriorFailure: true,
    },
    {
      id: 'sentinel_remove',
      description: `Remove sentinel file ${SENTINEL_RELATIVE_PATH}`,
      command: null, // fs 操作，调用方用 fs.rm
      haltOnPriorFailure: true,
    },
  ]
}

/**
 * Cleanup 执行器结果（调用方逐步执行后回报）。
 */
export interface CleanupExecutionResult {
  /** 已成功执行的步骤（按顺序） */
  completed: readonly CleanupStepId[]
  /** 失败的步骤（最多 1 个，因 haltOnPriorFailure=true） */
  failedAt: CleanupStepId | null
  /** 失败原因（命令 stderr / 异常 message） */
  failureReason: string | null
}

/**
 * 给定一系列 step 执行结果（按顺序），判定整个 cleanup 是否完成。
 * 用于 LLM 决定是否输出 success / 升级用户介入。
 *
 * @param stepResults 按 CLEANUP_STEP_ORDER 顺序的执行结果数组（每步 ok/fail）
 *                   长度 ≤ 4；中途失败则数组长度 < 4
 */
export function summarizeCleanup(
  stepResults: ReadonlyArray<{ step: CleanupStepId; ok: boolean; reason?: string }>,
): CleanupExecutionResult {
  const completed: CleanupStepId[] = []
  let failedAt: CleanupStepId | null = null
  let failureReason: string | null = null

  // 按 CLEANUP_STEP_ORDER 校验顺序，乱序也算失败（防止调用方传错）
  for (let i = 0; i < stepResults.length; i++) {
    const r = stepResults[i]
    const expected = CLEANUP_STEP_ORDER[i]
    if (r.step !== expected) {
      failedAt = expected
      failureReason = `out-of-order: expected ${expected} at index ${i}, got ${r.step}`
      break
    }
    if (!r.ok) {
      failedAt = r.step
      failureReason = r.reason ?? 'unknown failure'
      break
    }
    completed.push(r.step)
  }

  return { completed, failedAt, failureReason }
}

// ---------------------------------------------------------------------------
// 5. Per-finding rollback（用 git checkout，绝不用 Write 工具）
// ---------------------------------------------------------------------------

/**
 * 单个 finding 的 rollback 计划。
 *
 * **关键约束**：必须用 `git checkout -- {file}` 回滚到 worktree HEAD（即修复
 * 开始前的状态），**绝不**用 Write 工具回滚（部分写入会损坏文件，
 * `gsd-code-fixer.md:62-91`）。
 *
 * 多文件 finding：所有受影响文件作为一组传入，单次调用全部回滚。
 */
export interface RollbackPlan {
  files: readonly string[]
  /** 单条 git 命令，含所有文件 */
  command: string
}

/**
 * 构造 per-finding rollback 命令。
 */
export function planFindingRollback(files: readonly string[]): RollbackPlan {
  if (files.length === 0) {
    throw new Error('planFindingRollback: files array must not be empty')
  }
  const quoted = files.map(shellQuote).join(' ')
  return {
    files: [...files],
    command: `git checkout -- ${quoted}`,
  }
}

// ---------------------------------------------------------------------------
// 6. 多轮收敛环（--auto cap = 3）
// ---------------------------------------------------------------------------

/**
 * `--fix --auto` 多轮收敛上限（CCG 全体系硬规约，与 plan-checker / verify-work
 * 一致）。3 轮后未收敛 → 停止 + 升级人工介入。
 */
export const AUTO_CONVERGE_CAP = 3

/**
 * 单轮收敛状态。
 */
export interface ConvergeRound {
  /** 第几轮（1-indexed） */
  round: number
  /** 本轮 review 发现的 finding 数（按严重度分） */
  findings: { critical: number; warning: number; info: number }
}

/**
 * 多轮收敛判定：是否继续 / 收敛 / 升级。
 *
 *   - `continue`：上一轮 finding 数下降，仍 < cap → 继续 fix + re-review
 *   - `converged`：finding 数为 0（critical+warning），或 stable 多轮 → 完成
 *   - `escalate`：达到 cap（默认 3 轮）或 stall（连续 2 轮 finding 数没下降） → 升级
 */
export type ConvergeDecision = 'continue' | 'converged' | 'escalate'

/**
 * 判定下一步动作。
 *
 * @param history 已完成轮次的 finding 历史（轮 1, 轮 2, ...）
 * @param cap     上限（默认 AUTO_CONVERGE_CAP=3）
 */
export function decideConverge(
  history: readonly ConvergeRound[],
  cap: number = AUTO_CONVERGE_CAP,
): ConvergeDecision {
  if (history.length === 0) {
    // 还没跑过 → 必须先跑第一轮
    return 'continue'
  }

  const last = history[history.length - 1]
  const blocking = last.findings.critical + last.findings.warning

  // 收敛：critical + warning 全清
  if (blocking === 0) {
    return 'converged'
  }

  // 达到 cap → 升级
  if (history.length >= cap) {
    return 'escalate'
  }

  // Stall 检测：连续 2 轮 finding 数没下降
  if (history.length >= 2) {
    const prev = history[history.length - 2]
    const prevBlocking = prev.findings.critical + prev.findings.warning
    if (blocking >= prevBlocking) {
      return 'escalate'
    }
  }

  return 'continue'
}

// ---------------------------------------------------------------------------
// 7. Atomic commit message 构造
// ---------------------------------------------------------------------------

/**
 * 单个 finding 的 atomic commit 数据。
 */
export interface FindingCommitInput {
  /** Phase 编号（已 zero-pad，例：`10` / `02`），由调用方决定宽度 */
  paddedPhase: string
  /** Finding 标识符，例：`F-01` / `C-03` */
  findingId: string
  /** 短描述（一行，≤80 字），用于 commit subject */
  shortDescription: string
  /** 多文件 finding 的所有受影响文件（用于 git add）。可为空 */
  files?: readonly string[]
  /** 长描述（多行，可选），用于 commit body */
  body?: string
}

/**
 * 构造 atomic commit 命令（`git add ... && git commit -m ...`）。
 *
 * Commit message 格式：`fix({paddedPhase}): {findingId} {shortDescription}`
 *
 * 多文件 finding 一次 commit 列全部路径（在 body 里），这与 GSD
 * `gsd-code-fixer.md` 的 atomic commit 规约对齐。
 */
export function buildFindingCommit(input: FindingCommitInput): {
  subject: string
  body: string
  command: string
} {
  if (!input.findingId || !input.shortDescription) {
    throw new Error('buildFindingCommit: findingId and shortDescription are required')
  }
  const subject = `fix(${input.paddedPhase}): ${input.findingId} ${input.shortDescription}`

  // body 包含文件清单 + 用户自定义 body
  const lines: string[] = []
  if (input.files && input.files.length > 0) {
    lines.push('Files:')
    for (const f of input.files) {
      lines.push(`  - ${f}`)
    }
  }
  if (input.body) {
    if (lines.length > 0) lines.push('')
    lines.push(input.body)
  }
  const body = lines.join('\n')

  // git add 多文件 + commit -m subject -m body
  const filesArg =
    input.files && input.files.length > 0
      ? input.files.map(shellQuote).join(' ')
      : '-A'
  // 用 -m subject -m body 避免 here-string 跨平台问题
  let command = `git add ${filesArg} && git commit -m ${shellQuote(subject)}`
  if (body) {
    command += ` -m ${shellQuote(body)}`
  }

  return { subject, body, command }
}

// ---------------------------------------------------------------------------
// 8. 内部工具：shell 引用
// ---------------------------------------------------------------------------

/**
 * 单引号包裹路径/字符串，转义内嵌的单引号。
 *
 * 跨平台：Unix shell + Windows CMD（CMD 不识别单引号但会把整段当字面量
 * 路径，git for Windows 接受单引号）。Windows PowerShell 也接受。
 */
export function shellQuote(s: string): string {
  if (s.length === 0) return "''"
  // 已无危险字符则可直接返回（提升可读性）—— 但保守起见统一加引号
  // 转义内嵌单引号：' → '\''
  const escaped = s.replace(/'/g, "'\\''")
  return `'${escaped}'`
}
