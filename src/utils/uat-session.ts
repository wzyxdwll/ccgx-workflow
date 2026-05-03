/**
 * UAT Session Helper (CCG v4.0 Phase 9)
 *
 * 把 verify-work 从纯编排器升级为**会话式 UAT 工作流**。提供四块算法：
 *
 *   1. **Cold-start smoke 注入判定**：扫 git diff 路径，命中关键路径
 *      （`server.ts | app.ts | database/* | migrations/* | startup* |
 *      docker-compose*`）即返回"应注入"+ 注入测试模板。
 *   2. **UAT.md frontmatter 解析 / 生成**：跨会话状态文件，含
 *      `task_id / started_at / gaps / completed_checks / pending_checks`，
 *      `/clear` 后能 resume。
 *   3. **Issue 严重度推断**：用户报 issue 时按自然语言关键词推断
 *      `severity: critical | high | medium | low`，不让用户手填。
 *   4. **max-3-loop 收敛判定**：跟踪 diagnose → planner --gaps → plan-checker
 *      的迭代次数，达到 3 轮强制升级用户三选。
 *
 * 设计原则（与 phase 4 / 6 / 8 helper 一致）：
 *   - 纯函数；不读文件系统、不调网络。所有输入由调用方喂进来。
 *   - 输出结构化对象，调用方决定如何展示 / 阻断。
 *   - 中英双语关键词覆盖。
 *
 * 调用方：`templates/commands/verify-work.md` 主体逻辑由 LLM 执行；此处的
 * helper 让会话工作流在跨会话恢复 / 注入冷启动 / 推断严重度 / 触发收敛时
 * 跑一致的判定，避免每次重新推理。
 */

// ---------------------------------------------------------------------------
// 1. Cold-start smoke 注入判定
// ---------------------------------------------------------------------------

/**
 * 触发冷启动 smoke 测试的关键路径正则集合。
 *
 * 来源：GSD `verify-work.md:157-168` + CCG v4.0
 * `.ccg-research/03-quality-gates.md` Section 2.3 ROI #2。
 *
 * 设计原则：覆盖**只有冷启动才能暴露**的失败类——race condition / silent
 * seed failures / 缺环境变量 / migration 顺序错乱 / docker-compose 链路。
 */
export const COLD_START_PATTERNS: readonly RegExp[] = [
  /(^|\/)server\.(ts|js|mjs|cjs|tsx)$/i,
  /(^|\/)app\.(ts|js|mjs|cjs|tsx)$/i,
  /(^|\/)main\.(ts|js|mjs|cjs|tsx|go|py|rs)$/i,
  /(^|\/)index\.(ts|js|mjs|cjs|tsx)$/i, // 仅当与 server/app 同目录时强烈暗示入口
  /(^|\/)bootstrap\.(ts|js|mjs|cjs)$/i,
  /(^|\/)startup[._-]?[a-z]*/i,
  /(^|\/)database\//i,
  /(^|\/)db\//i,
  /(^|\/)migrations?\//i,
  /(^|\/)seeds?\//i,
  /(^|\/)docker-compose[a-z0-9._-]*\.ya?ml$/i,
  /(^|\/)Dockerfile[a-z0-9._-]*$/i,
  /(^|\/)\.env(\..+)?$/i,
  /(^|\/)k8s\//i,
  /(^|\/)kubernetes\//i,
]

/**
 * 单个 cold-start 命中。
 */
export interface ColdStartHit {
  /** 命中的文件路径（来自 git diff） */
  file: string
  /** 命中的正则 source（用于 audit 解释） */
  pattern: string
}

/**
 * 冷启动 smoke 注入判定结果。
 */
export interface ColdStartDecision {
  /** 是否需要注入冷启动测试 */
  shouldInject: boolean
  /** 命中的关键路径（用于报告解释） */
  hits: ColdStartHit[]
  /** 推荐的测试模板（shouldInject=true 时填充，否则空字符串） */
  smokeTemplate: string
}

/**
 * 扫 git diff 文件列表，决定是否注入冷启动 smoke 测试。
 *
 * 启发式：任意一个路径命中 COLD_START_PATTERNS 即视为关键路径，立即返回
 * `shouldInject=true`。不做"必须命中两个"等组合判断——单点命中已足够触发，
 * 误报成本（多跑一次 smoke）远低于漏报成本（生产冷启动崩）。
 *
 * @param changedFiles git diff --name-only 输出（每行一个文件路径）
 */
export function shouldInjectColdStart(
  changedFiles: readonly string[],
): ColdStartDecision {
  const hits: ColdStartHit[] = []
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return { shouldInject: false, hits, smokeTemplate: '' }
  }

  for (const raw of changedFiles) {
    if (!raw || typeof raw !== 'string') continue
    const file = raw.trim()
    if (!file) continue
    for (const re of COLD_START_PATTERNS) {
      if (re.test(file)) {
        hits.push({ file, pattern: re.source })
        break // 同一文件命中一个正则即可，避免重复报告
      }
    }
  }

  const shouldInject = hits.length > 0
  return {
    shouldInject,
    hits,
    smokeTemplate: shouldInject ? buildColdStartSmokeTemplate(hits) : '',
  }
}

/**
 * 生成冷启动 smoke 测试模板（人类可读 markdown 段）。
 *
 * 模板包含 4 步：杀进程 → 清临时态 → 冷启动 → 主查询返回数据。模板里留有
 * `<TODO>` 占位，调用方按项目实际命令替换（pnpm dev / docker compose up / ...）。
 */
export function buildColdStartSmokeTemplate(hits: readonly ColdStartHit[]): string {
  const fileList = hits.map((h) => `\`${h.file}\``).join(', ')
  return [
    '### Cold-Start Smoke Test (auto-injected)',
    '',
    `**Trigger**: changes touched cold-start critical paths: ${fileList}`,
    '',
    '**Why this matters**: Race conditions / silent seed failures / missing env vars',
    'only surface on a fresh boot. Skipping this leaves prod cold-start bugs unverified.',
    '',
    '**Steps**:',
    '',
    '1. **Kill any running process**:',
    '   ```bash',
    '   # adjust to your project',
    '   pkill -f "<TODO: process pattern>" || true',
    '   docker compose down -v 2>/dev/null || true',
    '   ```',
    '',
    '2. **Clear ephemeral state** (caches, sockets, lock files; KEEP volumes/data unless required):',
    '   ```bash',
    '   rm -rf node_modules/.cache .next .turbo /tmp/<TODO> 2>/dev/null || true',
    '   ```',
    '',
    '3. **Cold-boot from scratch**:',
    '   ```bash',
    '   # adjust to your project',
    '   pnpm dev   # or: docker compose up -d  / make run / cargo run',
    '   ```',
    '',
    '4. **Issue the primary query that should return data**:',
    '   ```bash',
    '   curl -fsS http://localhost:<PORT>/<MAIN_ENDPOINT> | jq .',
    '   # Expected: non-empty payload, status 200, no 500/timeout',
    '   ```',
    '',
    '**PASS**: step 4 returns expected data within 30 s.',
    '**FAIL**: report symptom (timeout / empty / 5xx / panic log) — auto-diagnose will fire.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 2. UAT.md frontmatter — schema + parse + render
// ---------------------------------------------------------------------------

export type UatGapStatus = 'open' | 'fixed' | 'deferred'

export type UatGapSeverity = 'critical' | 'high' | 'medium' | 'low'

/**
 * 单条 gap 记录——用户在 UAT 中报告的偏离 / 失败 / 缺漏。
 */
export interface UatGap {
  /** 用户报告的症状（自然语言原文，保留即可） */
  symptom: string
  /** 严重度（推断或用户指定） */
  severity: UatGapSeverity
  /** 当前状态 */
  status: UatGapStatus
  /** 收敛环已迭代轮数（0 = 尚未开始 diagnose） */
  loopCount?: number
  /** 关联的修复 plan 文件路径（如有） */
  planRef?: string
}

/**
 * UAT 单项 check（show expected → ask if matches）。
 */
export interface UatCheck {
  /** check ID（顺序号或简短 slug） */
  id: string
  /** 期望行为描述 */
  expected: string
  /** 用户回答（true=matches，false=不符，undefined=尚未问） */
  matched?: boolean
  /** 关联 gap ID（matched=false 时记录新建的 gap 标识） */
  gapRef?: string
}

/**
 * UAT.md 状态机——跨会话持久化的核心数据结构。
 */
export interface UatSessionState {
  /** 任务 ID（与 .context/uat/<task-id>/ 路径同源） */
  taskId: string
  /** ISO 8601 起始时间 */
  startedAt: string
  /** 已完成（user 已回答）的 check 列表 */
  completedChecks: UatCheck[]
  /** 待回答的 check 列表 */
  pendingChecks: UatCheck[]
  /** 当前已发现的 gap 列表（含修复中 / 已修 / 已 defer） */
  gaps: UatGap[]
  /** 是否已注入 cold-start smoke（避免重复注入） */
  coldStartInjected: boolean
}

/**
 * 解析 UAT.md 的 frontmatter（YAML）。容错：缺字段 → 用默认空集填充。
 *
 * 不引入 YAML 库——UAT schema 字段固定且简单，正则足够。
 */
export function parseUatFrontmatter(content: string): UatSessionState | null {
  if (!content || typeof content !== 'string') return null
  const fm = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/.exec(content)
  if (!fm) return null
  const body = fm[1]

  const taskId = pickScalar(body, 'task_id') ?? ''
  const startedAt = pickScalar(body, 'started_at') ?? ''
  const coldStartInjected = pickBool(body, 'cold_start_injected') ?? false
  const gaps = pickList(body, 'gaps').map((s) => parseGapEntry(s)).filter(Boolean) as UatGap[]
  const completedChecks = pickList(body, 'completed_checks')
    .map((s) => parseCheckEntry(s))
    .filter(Boolean) as UatCheck[]
  const pendingChecks = pickList(body, 'pending_checks')
    .map((s) => parseCheckEntry(s))
    .filter(Boolean) as UatCheck[]

  if (!taskId) return null
  return {
    taskId,
    startedAt,
    completedChecks,
    pendingChecks,
    gaps,
    coldStartInjected,
  }
}

/**
 * 渲染 UatSessionState 为 UAT.md frontmatter 字符串。输出稳定（字段顺序固定）。
 */
export function renderUatFrontmatter(state: UatSessionState): string {
  const lines: string[] = []
  lines.push('---')
  lines.push(`task_id: ${quoteIfNeeded(state.taskId)}`)
  lines.push(`started_at: ${quoteIfNeeded(state.startedAt)}`)
  lines.push(`cold_start_injected: ${state.coldStartInjected ? 'true' : 'false'}`)
  lines.push('gaps:')
  for (const g of state.gaps) {
    lines.push(
      `  - { symptom: ${quoteIfNeeded(g.symptom)}, severity: ${g.severity}, status: ${g.status}${g.loopCount != null ? `, loop_count: ${g.loopCount}` : ''}${g.planRef ? `, plan_ref: ${quoteIfNeeded(g.planRef)}` : ''} }`,
    )
  }
  lines.push('completed_checks:')
  for (const c of state.completedChecks) {
    lines.push(renderCheckEntry(c))
  }
  lines.push('pending_checks:')
  for (const c of state.pendingChecks) {
    lines.push(renderCheckEntry(c))
  }
  lines.push('---')
  return lines.join('\n')
}

/**
 * 创建初始 UatSessionState（新建 UAT.md 时用）。
 */
export function createUatSession(opts: {
  taskId: string
  startedAt?: string
  pendingChecks?: UatCheck[]
}): UatSessionState {
  return {
    taskId: opts.taskId,
    startedAt: opts.startedAt ?? new Date().toISOString(),
    completedChecks: [],
    pendingChecks: opts.pendingChecks ?? [],
    gaps: [],
    coldStartInjected: false,
  }
}

// ---------------------------------------------------------------------------
// 3. Issue 严重度推断
// ---------------------------------------------------------------------------

/**
 * 严重度推断关键词表（中英双语）。匹配优先级 critical > high > medium > low。
 *
 * 设计：保守倾向——含糊不清的报告默认 medium，避免漏 critical 但也不放大噪音。
 */
const SEVERITY_KEYWORDS: Record<UatGapSeverity, readonly string[]> = {
  critical: [
    'crash',
    'panic',
    'data loss',
    'data corruption',
    'security',
    'security risk',
    'rce',
    'sql injection',
    'xss',
    'auth bypass',
    '崩溃',
    '宕机',
    '数据丢失',
    '数据损坏',
    '严重',
    '安全漏洞',
    '注入',
  ],
  high: [
    'broken',
    'fail',
    'failure',
    'error',
    'exception',
    'cannot',
    "can't",
    "won't",
    "doesn't work",
    'not working',
    'blocked',
    '500',
    'unable to',
    '坏了',
    '失败',
    '报错',
    '异常',
    '阻塞',
    '无法',
    '不能用',
  ],
  medium: [
    'slow',
    'lag',
    'incorrect',
    'wrong',
    'mismatch',
    'unexpected',
    'flicker',
    'glitch',
    '慢',
    '卡',
    '不正确',
    '错误',
    '不一致',
    '不符合',
    '闪烁',
  ],
  low: [
    'typo',
    'cosmetic',
    'minor',
    'nit',
    'style',
    'whitespace',
    'wording',
    '错别字',
    '美观',
    '细节',
    '不影响',
  ],
}

/**
 * 按用户自然语言报告推断 issue 严重度。
 *
 * 算法：
 *   1. 按 critical → high → medium → low 顺序扫关键词；
 *   2. 命中即返回该级（最严格优先）；
 *   3. 都不命中 → `medium`（保守默认，避免低估）。
 */
export function inferIssueSeverity(report: string): UatGapSeverity {
  if (!report || typeof report !== 'string') return 'medium'
  const lower = report.toLowerCase()
  for (const sev of ['critical', 'high', 'medium', 'low'] as UatGapSeverity[]) {
    for (const kw of SEVERITY_KEYWORDS[sev]) {
      if (lower.includes(kw.toLowerCase())) return sev
    }
  }
  return 'medium'
}

// ---------------------------------------------------------------------------
// 4. max-3-loop 收敛判定
// ---------------------------------------------------------------------------

export type ConvergenceVerdict =
  | 'continue' // 还可以继续迭代
  | 'escalate' // 达到 max-3，必须升级用户三选

export interface ConvergenceDecision {
  verdict: ConvergenceVerdict
  /** 当前已迭代次数 */
  currentLoop: number
  /** 上限（默认 3） */
  maxLoop: number
  /** 给主线 LLM 的下一步建议（人类可读） */
  message: string
}

/**
 * 判定 diagnose → planner --gaps → plan-checker 的迭代是否应该停下。
 *
 * 与 GSD 全体系一致：3 轮上限是硬规约（plan-checker / verify-work /
 * plan-review-convergence / code-review-fix 都是 3）。超限不允许"再来一轮"，
 * 必须明确升级用户。
 *
 * @param currentLoop 当前已尝试的轮数（已尝试 1 次后传 1，已尝试 3 次后传 3）
 * @param maxLoop 上限（默认 3）
 */
export function decideConvergence(
  currentLoop: number,
  maxLoop = 3,
): ConvergenceDecision {
  const safeLoop = Math.max(0, Math.floor(currentLoop))
  const safeMax = Math.max(1, Math.floor(maxLoop))
  if (safeLoop >= safeMax) {
    return {
      verdict: 'escalate',
      currentLoop: safeLoop,
      maxLoop: safeMax,
      message: `Convergence loop exhausted (${safeLoop}/${safeMax}). Escalate to user with 3 options: (a) force-accept partial fix, (b) provide guidance & retry, (c) abort and roll back.`,
    }
  }
  return {
    verdict: 'continue',
    currentLoop: safeLoop,
    maxLoop: safeMax,
    message: `Loop ${safeLoop}/${safeMax} — re-spawn diagnose → planner --gaps → plan-checker.`,
  }
}

// ---------------------------------------------------------------------------
// 内部辅助：极简 YAML 字段抽取（不依赖外部库）
// ---------------------------------------------------------------------------

function pickScalar(body: string, key: string): string | null {
  const re = new RegExp(`^${escapeRe(key)}\\s*:\\s*(.+?)\\s*$`, 'm')
  const m = re.exec(body)
  if (!m) return null
  return stripQuotes(m[1].trim())
}

function pickBool(body: string, key: string): boolean | null {
  const v = pickScalar(body, key)
  if (v == null) return null
  if (/^(true|yes|1)$/i.test(v)) return true
  if (/^(false|no|0)$/i.test(v)) return false
  return null
}

function pickList(body: string, key: string): string[] {
  // 仅支持 "key:\n  - item\n  - item" 多行 list 形式（renderUatFrontmatter 输出格式）
  const head = new RegExp(`^${escapeRe(key)}\\s*:\\s*$`, 'm').exec(body)
  if (!head) return []
  const after = body.slice(head.index + head[0].length)
  const items: string[] = []
  for (const line of after.split(/\r?\n/)) {
    const m = /^\s{2,}-\s*(.*)$/.exec(line)
    if (m) {
      items.push(m[1].trim())
      continue
    }
    if (line.trim() === '') continue
    // 顶级字段或 frontmatter 终止 → 停止
    if (/^[A-Za-z_]/.test(line)) break
  }
  return items
}

function parseGapEntry(entry: string): UatGap | null {
  // 支持内联对象 `{ symptom: ..., severity: ..., status: ... }`
  const obj = parseInlineObject(entry)
  if (!obj) return null
  const symptom = obj.symptom ?? ''
  const severity = (obj.severity as UatGapSeverity) ?? 'medium'
  const status = (obj.status as UatGapStatus) ?? 'open'
  if (!symptom) return null
  const gap: UatGap = { symptom, severity, status }
  if (obj.loop_count != null) {
    const n = Number(obj.loop_count)
    if (Number.isFinite(n)) gap.loopCount = n
  }
  if (obj.plan_ref) gap.planRef = String(obj.plan_ref)
  return gap
}

function parseCheckEntry(entry: string): UatCheck | null {
  const obj = parseInlineObject(entry)
  if (!obj) return null
  const id = obj.id ?? ''
  const expected = obj.expected ?? ''
  if (!id || !expected) return null
  const check: UatCheck = { id, expected }
  if (obj.matched != null) {
    const v = String(obj.matched).toLowerCase()
    if (v === 'true' || v === 'yes') check.matched = true
    else if (v === 'false' || v === 'no') check.matched = false
  }
  if (obj.gap_ref) check.gapRef = String(obj.gap_ref)
  return check
}

function renderCheckEntry(c: UatCheck): string {
  const parts: string[] = []
  parts.push(`id: ${quoteIfNeeded(c.id)}`)
  parts.push(`expected: ${quoteIfNeeded(c.expected)}`)
  if (c.matched != null) parts.push(`matched: ${c.matched ? 'true' : 'false'}`)
  if (c.gapRef) parts.push(`gap_ref: ${quoteIfNeeded(c.gapRef)}`)
  return `  - { ${parts.join(', ')} }`
}

/**
 * 解析极简的内联对象 `{ key: value, key2: value2, ... }`。
 * 不支持嵌套对象 / list；用户报告的 symptom 含逗号也支持（用引号包裹时）。
 */
function parseInlineObject(s: string): Record<string, string> | null {
  const trimmed = s.trim()
  const m = /^\{\s*(.*)\s*\}$/.exec(trimmed)
  if (!m) return null
  const body = m[1]
  const out: Record<string, string> = {}
  // 简化的 key:value 切分——支持引号内逗号
  const parts = splitTopLevelCommas(body)
  for (const part of parts) {
    const kv = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/.exec(part.trim())
    if (!kv) continue
    out[kv[1]] = stripQuotes(kv[2].trim())
  }
  return out
}

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = []
  let buf = ''
  let inSingle = false
  let inDouble = false
  for (const ch of s) {
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    if (ch === ',' && !inSingle && !inDouble) {
      out.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim()) out.push(buf)
  return out
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1)
    }
  }
  return s
}

function quoteIfNeeded(s: string): string {
  if (!s) return '""'
  // 含逗号 / 冒号 / 大括号 / 引号 → 加引号转义
  if (/[",:{}\n\r]/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return s
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
