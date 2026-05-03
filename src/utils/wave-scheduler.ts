/**
 * Wave Scheduler (CCG v4.1 Phase 14).
 *
 * `/ccg:autonomous --parallel` 的依赖图调度核心。把扁平的 phase 序列按
 * `Depends on` 字段拓扑排序成 wave（无依赖 → wave 1，依赖 wave 1 → wave 2，
 * ...），波内 phase 没有依赖关系可主线一次性并行 spawn `Agent(phase-runner)`。
 *
 * 设计原则（与 v4.0 phase-context.ts / debug-session.ts 一致）：
 *   - 纯函数；不读文件系统、不 spawn 子进程
 *   - 输入 markdown 字符串 / 结构化对象，输出结构化结果
 *   - 跨平台：无路径假设
 *   - 失败用 throw + 明确错误信息（依赖循环 / 引用未知 phase）
 *
 * 调用方：
 *   - `templates/commands/autonomous.md` Step 4.0（解析 roadmap）
 *   - `templates/commands/autonomous.md` Step 4.2（按 wave 并行 spawn）
 *
 * 不做：
 *   - 不实际 spawn Agent（那是主线 LLM 的职责，本 helper 只决定 wave 划分）
 *   - 不写 `.ccg/roadmap.md`（autonomous 主线唯一写者）
 *   - 不读 SUMMARY.md / state.md（与 phase-context / team-exec 协议解耦）
 */

// ---------------------------------------------------------------------------
// 1. Schema
// ---------------------------------------------------------------------------

export type PhaseStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'

/**
 * 单个 phase 的最小结构化记录。从 roadmap.md 的 `## Phase N: <name> (<status>)`
 * 标题 + `- **Depends on**: ...` 行解析得到。
 *
 * `id` 保留为字符串以容纳 "1.5" 这类小数 phase 编号（v3.1 / v4.0 实际场景）。
 */
export interface RoadmapPhase {
  /** phase 标识，例如 "1" / "1.5" / "13" */
  id: string
  /** phase 标题（不含 "Phase N: " 前缀和状态括号） */
  name: string
  /** 状态括号内的关键字 */
  status: PhaseStatus
  /** 依赖的 phase id 列表。`(none)` 表示空 */
  dependsOn: string[]
}

/**
 * Wave 调度结果。`waves[i]` 是第 i+1 wave 内的 phase id 列表（顺序无意义，波内
 * 可以并行）。`skipped` 是因上游 failed/skipped 而 cascade 标 blocked 的 phase。
 */
export interface WaveSchedule {
  /** waves[0] = wave 1（最先跑），waves[1] = wave 2，... */
  waves: string[][]
  /** cascade-skip 决策的 phase id 集合 */
  skipped: string[]
  /** wave-i phase 数量超过 maxConcurrent 时的批分组：batches[w][b] = wave w 第 b 批 */
  batches?: string[][][]
}

// ---------------------------------------------------------------------------
// 2. Roadmap 解析
// ---------------------------------------------------------------------------

const PHASE_HEADER_RE = /^## Phase ([0-9]+(?:\.[0-9]+)?)\s*:\s*(.+?)\s*\(([a-z_]+)\)\s*$/
const DEPENDS_ON_RE = /^-\s+\*\*Depends on\*\*\s*:\s*(.+)$/

/**
 * 解析 roadmap.md 文本，抽出每个 phase 的 id / name / status / dependsOn。
 *
 * 容错原则：
 *   - phase 标题正则不匹配的行直接忽略（roadmap.md 含里程碑总结表等噪音）
 *   - 单个 phase 没有 `- **Depends on**:` 行视为 `(none)`（向后兼容老格式）
 *   - 同一 phase 出现多次（不该发生）时后者覆盖前者并 throw
 *
 * 抛错场景：phase id 重复声明 / 状态值不合法
 */
export function parseRoadmap(content: string): RoadmapPhase[] {
  const phases: RoadmapPhase[] = []
  const lines = content.split(/\r?\n/)
  let current: RoadmapPhase | null = null
  const seen = new Set<string>()

  const flushCurrent = (): void => {
    if (current) {
      if (seen.has(current.id))
        throw new Error(`wave-scheduler: duplicate Phase ${current.id} declaration`)
      seen.add(current.id)
      phases.push(current)
    }
  }

  for (const line of lines) {
    const headerMatch = line.match(PHASE_HEADER_RE)
    if (headerMatch) {
      flushCurrent()
      const [, id, name, statusRaw] = headerMatch
      if (!isPhaseStatus(statusRaw))
        throw new Error(`wave-scheduler: Phase ${id} has illegal status "${statusRaw}"`)
      current = {
        id,
        name: name.trim(),
        status: statusRaw,
        dependsOn: [],
      }
      continue
    }

    if (current) {
      const depMatch = line.match(DEPENDS_ON_RE)
      if (depMatch)
        current.dependsOn = parseDependsOn(depMatch[1])
    }
  }
  flushCurrent()

  return phases
}

/**
 * 解析 `Depends on` 字段右侧的内容，支持：
 *   - `(none)` → []
 *   - `1` → ["1"]
 *   - `6, 8` → ["6", "8"]
 *   - `1-11` → ["1", "2", ..., "11"]（整数范围；不展开 "1-1.5"）
 *   - 混合："1, 3-5, 8" → ["1", "3", "4", "5", "8"]
 */
export function parseDependsOn(raw: string): string[] {
  const trimmed = raw.trim().replace(/[。.]+$/, '')
  if (!trimmed || /^\(none\)$/i.test(trimmed))
    return []

  const out: string[] = []
  for (const tokenRaw of trimmed.split(',')) {
    const token = tokenRaw.trim()
    if (!token)
      continue
    const rangeMatch = token.match(/^([0-9]+)\s*-\s*([0-9]+)$/)
    if (rangeMatch) {
      const lo = Number(rangeMatch[1])
      const hi = Number(rangeMatch[2])
      if (lo > hi)
        throw new Error(`wave-scheduler: malformed range "${token}" (lo > hi)`)
      for (let i = lo; i <= hi; i++)
        out.push(String(i))
      continue
    }
    // Strip leading "Phase " prefix if present (defensive)
    const phaseMatch = token.match(/^(?:Phase\s+)?([0-9]+(?:\.[0-9]+)?)$/i)
    if (!phaseMatch)
      throw new Error(`wave-scheduler: cannot parse depends-on token "${token}"`)
    out.push(phaseMatch[1])
  }
  return out
}

function isPhaseStatus(s: string): s is PhaseStatus {
  return s === 'pending' || s === 'in_progress' || s === 'completed' || s === 'failed' || s === 'skipped'
}

// ---------------------------------------------------------------------------
// 3. Kahn 拓扑排序 → wave 划分
// ---------------------------------------------------------------------------

/**
 * 把 phase 列表按依赖图拓扑分波。Kahn 算法每轮选出当前没未满足依赖的 phase
 * 集合作为下一 wave，从图中移除后继续。
 *
 * 行为：
 *   - 引用未知 phase（`Depends on: 99` 而无 Phase 99）→ throw
 *   - 依赖循环（A → B → A）→ throw（剩余 phase 没人能进 wave）
 *   - 输入空数组 → 返回空 waves
 *   - phase 顺序不影响 wave 分组，但同 wave 内 phase 按输入声明顺序保留
 *
 * @param phases 解析后的 phase 列表
 * @returns wave 划分（waves[i] 内 phase 可并行）
 */
export function buildWaves(phases: RoadmapPhase[]): string[][] {
  if (phases.length === 0)
    return []

  const idToPhase = new Map<string, RoadmapPhase>()
  for (const p of phases)
    idToPhase.set(p.id, p)

  // Validate references
  for (const p of phases) {
    for (const dep of p.dependsOn) {
      if (!idToPhase.has(dep))
        throw new Error(`wave-scheduler: Phase ${p.id} depends on unknown Phase ${dep}`)
    }
  }

  const remaining = new Set<string>(phases.map(p => p.id))
  // Snapshot of dependency sets that we shrink as waves are emitted
  const remainingDeps = new Map<string, Set<string>>()
  for (const p of phases)
    remainingDeps.set(p.id, new Set(p.dependsOn))

  const waves: string[][] = []
  while (remaining.size > 0) {
    const ready: string[] = []
    // Preserve input order within a wave for determinism
    for (const p of phases) {
      if (!remaining.has(p.id))
        continue
      if ((remainingDeps.get(p.id)?.size ?? 0) === 0)
        ready.push(p.id)
    }
    if (ready.length === 0) {
      const stuck = Array.from(remaining).join(', ')
      throw new Error(`wave-scheduler: dependency cycle detected among phases: ${stuck}`)
    }
    waves.push(ready)
    for (const id of ready) {
      remaining.delete(id)
      // Drop this id from every other phase's pending dep set
      for (const set of remainingDeps.values())
        set.delete(id)
    }
  }
  return waves
}

// ---------------------------------------------------------------------------
// 4. Cascade skip：上游 failed/skipped → 下游标 skipped
// ---------------------------------------------------------------------------

/**
 * 计算 cascade-skip 集合：当某 phase 状态为 `failed` 或 `skipped` 时，所有
 * 依赖（直接或间接）该 phase 的 phase 都标 skipped。
 *
 * 输入是已 status-标注的 phase 列表（来自 parseRoadmap 或 mock）；返回
 * **新增**应被 cascade-skip 的 phase id 集合（不重复列出已经 failed/skipped 的）。
 *
 * @param phases 全量 phase
 * @returns 应 cascade-skip 的 phase id 列表（按 phase 输入顺序去重）
 */
export function cascadeSkip(phases: RoadmapPhase[]): string[] {
  const idToPhase = new Map<string, RoadmapPhase>()
  for (const p of phases)
    idToPhase.set(p.id, p)

  const blocked = new Set<string>()
  // Seed: phase that is failed or already skipped propagates to its successors
  for (const p of phases) {
    if (p.status === 'failed' || p.status === 'skipped')
      blocked.add(p.id)
  }

  // BFS forward: for each phase, if any dep is in blocked, mark phase blocked too
  // Iterate until no changes (handles long chains)
  let changed = true
  while (changed) {
    changed = false
    for (const p of phases) {
      if (blocked.has(p.id))
        continue
      for (const dep of p.dependsOn) {
        if (blocked.has(dep)) {
          blocked.add(p.id)
          changed = true
          break
        }
      }
    }
  }

  // Return only the *new* cascade entries (not the original failed/skipped seed)
  const result: string[] = []
  for (const p of phases) {
    if (blocked.has(p.id) && p.status !== 'failed' && p.status !== 'skipped')
      result.push(p.id)
  }
  return result
}

// ---------------------------------------------------------------------------
// 5. Max-concurrent 批分组
// ---------------------------------------------------------------------------

/**
 * 把单个 wave 按 maxConcurrent 切分成多个批次（顺序执行批，批内并行）。
 *
 * 例：wave = [a, b, c, d, e, f]，maxConcurrent = 2 → batches = [[a,b],[c,d],[e,f]]
 *
 * @param wave 单 wave 的 phase 列表
 * @param maxConcurrent 每批最大并发数（≥ 1）
 * @returns 批次数组
 */
export function batchByMaxConcurrent(wave: string[], maxConcurrent: number): string[][] {
  if (maxConcurrent < 1)
    throw new Error(`wave-scheduler: maxConcurrent must be ≥ 1, got ${maxConcurrent}`)
  if (wave.length === 0)
    return []
  const batches: string[][] = []
  for (let i = 0; i < wave.length; i += maxConcurrent)
    batches.push(wave.slice(i, i + maxConcurrent))
  return batches
}

// ---------------------------------------------------------------------------
// 6. 高层 API：综合调度（解析 → 分波 → cascade → 批分组）
// ---------------------------------------------------------------------------

export interface ScheduleOptions {
  /** 单 wave 最大并发数；省略则不分批 */
  maxConcurrent?: number
  /** 是否仅调度 status=pending 或 in_progress 的 phase（默认 true，跳过 completed） */
  skipCompleted?: boolean
}

/**
 * 一站式调度：解析 → cascade skip → 拓扑分波 → 可选批分组。
 *
 * 完整 schedule 流程，autonomous Step 4.0 直接调用即可。
 *
 * @param phases 已解析的 phase 列表（来自 parseRoadmap）
 * @param options 调度参数
 */
export function schedule(phases: RoadmapPhase[], options: ScheduleOptions = {}): WaveSchedule {
  const skipCompleted = options.skipCompleted ?? true

  // 1. cascade skip pass on the full graph (so downstream of failed seeds are flagged)
  const cascaded = cascadeSkip(phases)
  const cascadedSet = new Set(cascaded)

  // 2. Filter out phases that should not be scheduled this run
  const schedulable = phases.filter((p) => {
    if (skipCompleted && p.status === 'completed')
      return false
    if (p.status === 'failed' || p.status === 'skipped')
      return false
    if (cascadedSet.has(p.id))
      return false
    return true
  })

  // 3. For schedulable phases, drop deps that point at completed phases
  //    (those deps are already satisfied)
  const completedSet = new Set(
    phases.filter(p => p.status === 'completed').map(p => p.id),
  )
  const filtered: RoadmapPhase[] = schedulable.map(p => ({
    ...p,
    dependsOn: p.dependsOn.filter(d => !completedSet.has(d)),
  }))

  // 4. Drop deps that point at cascaded-skipped or failed phases — those would
  //    make the schedule unsatisfiable; the cascade pass already moved their
  //    dependents into `cascaded` so we won't include them in `filtered`
  //    anyway. Defensive: also drop such deps from any survivor.
  const droppedDeps = new Set<string>([...cascadedSet, ...phases.filter(p => p.status === 'failed' || p.status === 'skipped').map(p => p.id)])
  const finalPhases: RoadmapPhase[] = filtered.map(p => ({
    ...p,
    dependsOn: p.dependsOn.filter(d => !droppedDeps.has(d)),
  }))

  const waves = buildWaves(finalPhases)

  let batches: string[][][] | undefined
  if (typeof options.maxConcurrent === 'number') {
    const cap = options.maxConcurrent
    batches = waves.map(w => batchByMaxConcurrent(w, cap))
  }

  return { waves, skipped: cascaded, batches }
}
