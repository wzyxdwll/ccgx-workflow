/**
 * Plan Aggregator (CCG v4.2 Phase 22).
 *
 * triple/debate 模式 plan wave 完成后，汇总 3 路 plan contribution 成
 * 单一 DesignBrief（共识 / 分歧 / 必决策点），由主线在 impl wave 注入
 * phase-runner 的 prompt 里。
 *
 * 综合算法（P22 起步实现，P23 dogfood 后可调优）：
 *   1. 把每路 plan 切成 bullet points（按 markdown `-` 或换行）
 *   2. 共识 = 同样 bullet 出现在 ≥ 2 路（≥ 70% 字面相似度）
 *   3. 分歧 = 仅 1 路出现 或 不同路给冲突方案
 *   4. decision_required = 分歧中标"high-stakes"关键词的（架构 / 破坏性 / 安全 / schema / 迁移）
 *
 * 设计原则（与 quality-router 一致）：
 *   - 纯函数；不读文件、不 spawn 子进程
 *   - 输入 PlanContribution[]，输出 DesignBrief
 *   - 失败容错：单路解析失败仍用其他 N-1 路（不抛错）
 *
 * 调用方：
 *   - templates/commands/autonomous.md Step 4.x triple/debate 模式 plan wave 后
 *
 * 不做：
 *   - 不解析 phase-runner 摘要（phase-runner.ts 职责）
 *   - 不做语义级对齐（只做字符级相似度，控制复杂度）
 */

import type { Model } from './multi-model-routing'

// ---------------------------------------------------------------------------
// 1. Schema
// ---------------------------------------------------------------------------

export interface PlanContribution {
  /** 哪个 model 给出的 plan（codex / gemini / claude / general-purpose 兜底） */
  model: Model
  /** Plan 文本（subagent 摘要里的 PLAN 字段或全文，主线传入哪个由编排决定） */
  plan: string
  /** plan 文本长度（字符），传入计算可缓存；缺省自动算 */
  length?: number
}

/** 一个分歧主题（topic 一致但选项不同） */
export interface Divergence {
  topic: string
  options: { from: Model; option: string }[]
}

export interface DesignBrief {
  /** ≥ 2 路提到的共识要点 */
  consensus: string[]
  /** 各模型间的分歧主题 + 各自方案 */
  divergences: Divergence[]
  /**
   * 必须由主线 / 用户决策的高 stakes 项（含 high-stakes keyword 的分歧主题）
   * 这是 divergences 的子集（按 topic 引用），不是新内容。
   */
  decision_required: string[]
  /** 解析过程的告警（路解析失败等） */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// 2. Constants
// ---------------------------------------------------------------------------

/** 字面相似度阈值（0..1）：≥ 此值认为是同一要点 */
const SIMILARITY_THRESHOLD = 0.7

/** 最小 bullet 长度（过滤无意义碎片，如单个字符） */
const MIN_BULLET_LEN = 8

/** 高 stakes 关键词（命中 → decision_required） */
const HIGH_STAKES_KEYWORDS: readonly string[] = [
  '架构', '破坏', '破坏性', '安全', 'schema', '迁移', 'migration', 'breaking',
  'security', 'architecture', 'auth', 'data loss', '数据丢失', '不兼容',
]

/** Brief markdown 序列化的硬上限（约 500 token；按 char ≈ 0.5 token 估算） */
const SERIALIZED_BRIEF_MAX_CHARS = 1000

// ---------------------------------------------------------------------------
// 3. 文本切块 + 标准化
// ---------------------------------------------------------------------------

/**
 * 把 plan 文本切成 bullet 列表。容错：
 *   - 行首 `-` / `*` / `+` / `1.` / `2)` / `•` 都识别为 bullet
 *   - 空行作为 fallback 分隔（无显式 bullet 时按段落切）
 *   - 过滤空 / 过短 / 全空白 bullet
 */
function splitIntoBullets(text: string): string[] {
  if (typeof text !== 'string' || text.trim().length === 0) return []

  const lines = text.split(/\r?\n/)
  const bullets: string[] = []
  let buffer: string[] = []

  const flush = () => {
    const joined = buffer.join(' ').trim()
    if (joined.length >= MIN_BULLET_LEN) bullets.push(joined)
    buffer = []
  }

  // 一阶段：按显式 bullet 标记切
  let hasExplicitBullet = false
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0) {
      flush()
      continue
    }
    const bulletMatch = line.match(/^(?:[-*+•]|\d+[.)])\s+(.+)$/)
    if (bulletMatch) {
      hasExplicitBullet = true
      flush()
      buffer.push(bulletMatch[1].trim())
    } else {
      buffer.push(line)
    }
  }
  flush()

  if (hasExplicitBullet) return bullets

  // 二阶段（无显式 bullet）：按行直接拆，过滤短行
  const fallback: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length >= MIN_BULLET_LEN) fallback.push(line)
  }
  return fallback
}

/**
 * 把 bullet 标准化便于相似度比较：
 *   - 转小写
 *   - 去除标点 / 多余空白
 *   - 去除常见 stopword（中文："的" "了" "和" 英文："the" "a" "and"）
 */
function normalizeBullet(s: string): string {
  return s
    .toLowerCase()
    .replace(/[，。、：；！？,.:;!?'"`()（）【】\[\]{}<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(the|a|an|and|or|of|to|in|for|is|are)\b/g, ' ')
    .replace(/[的了和与及之而]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Jaccard token-set 相似度（适合短 bullet）。
 *   - 中文按字切
 *   - 英文按词切
 *   - 返回 0..1
 */
function similarity(a: string, b: string): number {
  const tokensA = tokenize(a)
  const tokensB = tokenize(b)
  if (tokensA.size === 0 || tokensB.size === 0) return 0
  let intersect = 0
  for (const t of tokensA) {
    if (tokensB.has(t)) intersect++
  }
  const union = tokensA.size + tokensB.size - intersect
  return union === 0 ? 0 : intersect / union
}

function tokenize(s: string): Set<string> {
  const out = new Set<string>()
  // 英文 word
  const words = s.match(/[a-z0-9]+/g) ?? []
  for (const w of words) {
    if (w.length >= 2) out.add(w)
  }
  // 中文按字
  const chineseChars = s.match(/[一-鿿]/g) ?? []
  for (const c of chineseChars) out.add(c)
  return out
}

// ---------------------------------------------------------------------------
// 4. 共识 / 分歧抽取
// ---------------------------------------------------------------------------

interface IndexedBullet {
  source: Model
  raw: string
  norm: string
}

/** 把所有 contribution 平铺成 indexed bullet 列表 */
function flattenContributions(
  contributions: PlanContribution[],
): { bullets: IndexedBullet[]; warnings: string[] } {
  const bullets: IndexedBullet[] = []
  const warnings: string[] = []
  for (const c of contributions) {
    if (typeof c.plan !== 'string' || c.plan.trim().length === 0) {
      warnings.push(`plan from ${c.model} empty or non-string; skipped`)
      continue
    }
    const items = splitIntoBullets(c.plan)
    if (items.length === 0) {
      warnings.push(`plan from ${c.model} produced no parseable bullets; skipped`)
      continue
    }
    for (const b of items) {
      const norm = normalizeBullet(b)
      if (norm.length === 0) continue
      bullets.push({ source: c.model, raw: b, norm })
    }
  }
  return { bullets, warnings }
}

/**
 * 从 indexed bullet 中抽取共识（≥ 2 个 model 提到相似要点）。
 *
 * 算法（O(N²) 简易版，N 通常 < 30，不做优化）：
 *   - 每个 bullet 与后续 bullet 比相似度
 *   - ≥ SIMILARITY_THRESHOLD 且 source 不同 → 同一共识簇
 *   - 簇内 bullet 数 ≥ 2 → 进 consensus（取首条原文作代表）
 */
function extractConsensus(bullets: IndexedBullet[]): {
  consensus: string[]
  consumedIndices: Set<number>
} {
  const consensus: string[] = []
  const consumed = new Set<number>()

  for (let i = 0; i < bullets.length; i++) {
    if (consumed.has(i)) continue
    const cluster: number[] = [i]
    const sources = new Set<Model>([bullets[i].source])
    for (let j = i + 1; j < bullets.length; j++) {
      if (consumed.has(j)) continue
      const sim = similarity(bullets[i].norm, bullets[j].norm)
      if (sim >= SIMILARITY_THRESHOLD) {
        cluster.push(j)
        sources.add(bullets[j].source)
      }
    }
    // 共识需要 ≥ 2 个不同 source
    if (sources.size >= 2) {
      for (const idx of cluster) consumed.add(idx)
      consensus.push(bullets[i].raw)
    }
  }
  return { consensus, consumedIndices: consumed }
}

/**
 * 从未被共识吸收的 bullet 抽取分歧。
 *
 * 算法：
 *   - 按 normalized 前缀 / 关键 token 简易分组（找潜在 topic）
 *   - 每组内不同 source 给不同方案 → 一个 Divergence
 *   - 单 source 独有 bullet 也算分歧（只有它提了，其他没考虑到）
 */
function extractDivergences(
  bullets: IndexedBullet[],
  consumed: Set<number>,
): Divergence[] {
  const remaining = bullets
    .map((b, i) => ({ ...b, idx: i }))
    .filter(b => !consumed.has(b.idx))
  if (remaining.length === 0) return []

  // 简易分组：按 normalized 第一个非 stopword token 作 topic key
  const groups = new Map<string, typeof remaining>()
  for (const b of remaining) {
    const tokens = Array.from(tokenize(b.norm))
    if (tokens.length === 0) continue
    const key = tokens[0]
    const arr = groups.get(key) ?? []
    arr.push(b)
    groups.set(key, arr)
  }

  const divergences: Divergence[] = []
  // 已分组的
  for (const [, group] of groups) {
    const distinctSources = new Set(group.map(g => g.source))
    if (distinctSources.size >= 2) {
      // 多 source 不同方案
      divergences.push({
        topic: group[0].raw.slice(0, 60),
        options: group.map(g => ({ from: g.source, option: g.raw })),
      })
    } else {
      // 单 source 独有要点 → 也算分歧（其他 source 漏想了）
      for (const g of group) {
        divergences.push({
          topic: g.raw.slice(0, 60),
          options: [{ from: g.source, option: g.raw }],
        })
      }
    }
  }

  return divergences
}

/** 从 divergences 中识别 high-stakes 的 topic 列表 */
function extractDecisionRequired(divergences: Divergence[]): string[] {
  const required: string[] = []
  for (const d of divergences) {
    const lower = d.topic.toLowerCase()
    const hit = HIGH_STAKES_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()))
    if (hit) required.push(d.topic)
  }
  return required
}

// ---------------------------------------------------------------------------
// 5. Public API
// ---------------------------------------------------------------------------

/**
 * 综合多路 plan 成单一 DesignBrief。
 *
 * 容错：单路 plan 解析失败/为空时 warning 记录，用其他路继续。
 */
export function aggregatePlans(contributions: PlanContribution[]): DesignBrief {
  if (!Array.isArray(contributions)) {
    throw new Error('aggregatePlans: contributions must be array')
  }
  if (contributions.length === 0) {
    return {
      consensus: [],
      divergences: [],
      decision_required: [],
      warnings: ['no plan contributions'],
    }
  }

  const { bullets, warnings } = flattenContributions(contributions)
  if (bullets.length === 0) {
    return {
      consensus: [],
      divergences: [],
      decision_required: [],
      warnings: [...warnings, 'no parseable bullets across all contributions'],
    }
  }

  const { consensus, consumedIndices } = extractConsensus(bullets)
  const divergences = extractDivergences(bullets, consumedIndices)
  const decision_required = extractDecisionRequired(divergences)

  return { consensus, divergences, decision_required, warnings }
}

/**
 * 把 DesignBrief 序列化成 markdown，供 phase-runner prompt 注入。
 *
 * 长度上限 ≈ 500 token（按 SERIALIZED_BRIEF_MAX_CHARS 控制，会截断尾部）。
 */
export function serializeBriefForPrompt(brief: DesignBrief): string {
  const lines: string[] = []
  lines.push('## Design Brief（plan wave 综合）')
  lines.push('')

  if (brief.consensus.length > 0) {
    lines.push('### 共识要点')
    for (const c of brief.consensus) lines.push(`- ${truncate(c, 120)}`)
    lines.push('')
  }

  if (brief.divergences.length > 0) {
    lines.push('### 分歧主题')
    for (const d of brief.divergences) {
      lines.push(`- **${truncate(d.topic, 60)}**`)
      for (const opt of d.options) {
        lines.push(`  - [${opt.from}] ${truncate(opt.option, 100)}`)
      }
    }
    lines.push('')
  }

  if (brief.decision_required.length > 0) {
    lines.push('### 必决策点（high-stakes，主线 / 用户裁定）')
    for (const r of brief.decision_required) lines.push(`- ${truncate(r, 80)}`)
    lines.push('')
  }

  if (brief.warnings.length > 0) {
    lines.push('### 解析告警')
    for (const w of brief.warnings) lines.push(`- ${truncate(w, 100)}`)
  }

  let out = lines.join('\n').trim()
  if (out.length > SERIALIZED_BRIEF_MAX_CHARS) {
    out = out.slice(0, SERIALIZED_BRIEF_MAX_CHARS - 20) + '\n...(truncated)'
  }
  return out
}

function truncate(s: string, n: number): string {
  if (typeof s !== 'string') return ''
  return s.length <= n ? s : s.slice(0, n - 3) + '...'
}

/** 返回 brief 序列化结果的字符长度（便于测试 ≤500 token 等价 ≤1000 char） */
export function estimateBriefLength(brief: DesignBrief): number {
  return serializeBriefForPrompt(brief).length
}
