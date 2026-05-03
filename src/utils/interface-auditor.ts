/**
 * Interface Auditor (CCG v4.3 Phase 27).
 *
 * 跨 phase 接口审计 verifier specialist。每 phase commit 后由主线在 quality-router
 * triple/debate 模式的 verify wave 内并行 spawn 一次（与 codex+gemini cross-vendor
 * verify 并列）。
 *
 * 检测 5 类**真实事故型**风险：
 *
 *   1. SSoT 违反（critical）— 重复 type / 重复实现（v4.2 P22 重新引入 planVerifyWave 同型）
 *   2. 半成品（major）— export 但无 import consumer（v4.1 P19 paths 字段无 consumer 同型）
 *   3. magic string 不在 ground truth（critical）— 硬编码 subagent_type / hook event
 *      跟 P26 sampler 实采集合不符（v4.2.0 codex:codex-rescue 同型）
 *   4. commit message vs diff 一致性（major）— 与 P29 hook 协作的事后审
 *   5. mock 与 ground truth schema 偏差（info/major）— 与 P28 fixtures 协作的线索提供
 *
 * 设计原则（与 v4.2.1 verify-orchestrator / challenger-orchestrator 一致）：
 *   - 纯函数：本模块仅提供 parser + 类型 schema；agent 实现逻辑放 prompt 里
 *   - 复用 challenger-orchestrator.parseFindings 鲁棒化（单/双引号 / json fence /
 *     balanced-bracket tokenizer 兜底）
 *   - 输出协议与 challenger / verify summary 同源（STATUS / FINDINGS / NOTES），
 *     调用方决定语义
 *
 * 调用方：
 *   - templates/commands/autonomous.md Step 4.4 verify wave 综合
 *   - quality-router.ts.buildVerifyWave (triple/debate spawns 内追加 interface-auditor)
 *
 * 不做：
 *   - 不实际 spawn agent（主线 LLM 派发；本 helper 只产出 schema + 解析）
 *   - 不读 ground truth 文件（agent prompt 内 Read，本 helper 处理结果摘要）
 *   - 不实现 5 项检查（agent 自己 grep + Bash 完成，本 helper 仅解析摘要）
 */

import {
  parseChallengerSummary,
  type ChallengerAgent,
  type Finding,
  type FindingSeverity,
} from './challenger-orchestrator'

// ---------------------------------------------------------------------------
// 1. Schema
// ---------------------------------------------------------------------------

/**
 * Interface auditor 5 类 finding category 枚举。
 *
 * 严格枚举的目的：主线综合 verify 决策时可按 category 分组阈值（譬如 ssot-violation
 * 永远 critical，mock-drift 永远 info）。
 */
export type InterfaceAuditCategory =
  | 'ssot-violation'
  | 'leftover'
  | 'magic-string-mismatch'
  | 'commit-diff-drift'
  | 'mock-drift'
  | 'unknown'

/**
 * Interface auditor 单条 finding。比通用 Finding 更紧（category 严格枚举）。
 */
export interface InterfaceAuditFinding {
  severity: FindingSeverity
  category: InterfaceAuditCategory
  message: string
}

/**
 * Interface auditor ≤200 token 摘要解析后的结构。
 */
export interface InterfaceAuditReport {
  /** 解析状态 */
  status: 'complete' | 'error'
  /** 5 类检查命中的 finding（含 critical/major/info 三档） */
  findings: InterfaceAuditFinding[]
  /** Notes 字段 */
  notes: string
  /** 原始摘要文本（debug 用） */
  raw: string
}

// ---------------------------------------------------------------------------
// 2. Constants
// ---------------------------------------------------------------------------

const VALID_CATEGORIES: readonly InterfaceAuditCategory[] = [
  'ssot-violation',
  'leftover',
  'magic-string-mismatch',
  'commit-diff-drift',
  'mock-drift',
  'unknown',
] as const

// ---------------------------------------------------------------------------
// 3. parseInterfaceAuditorReport
// ---------------------------------------------------------------------------

/**
 * 解析 interface-auditor agent 返回的 ≤200 token 摘要文本。
 *
 * 复用 challenger-orchestrator.parseChallengerSummary 的鲁棒化 parser（同样的
 * STATUS / FINDINGS / NOTES 协议 + 单引号/双引号/json-fence/嵌套 {} 容错），
 * 然后把 generic Finding[] 收紧成 InterfaceAuditFinding[]（category 枚举 normalize）。
 *
 * 与 verify-orchestrator.parseVerifyReport 不同点：
 *   - 不区分 criticals / majors（本模块由调用方在 synthesize 时按 severity 分组）
 *   - category 严格枚举到 InterfaceAuditCategory（unknown 兜底，不丢 finding）
 *
 * @param text  agent 返回的 ≤200 token 摘要原文
 */
export function parseInterfaceAuditorReport(text: string): InterfaceAuditReport {
  // challenger parser 要求 ChallengerAgent union；interface-auditor 不在 union 内，
  // 但 parser 内部不强校验 agent 字符串，cast 即可（与 verify-orchestrator 同手法）。
  let raw: ReturnType<typeof parseChallengerSummary>
  try {
    raw = parseChallengerSummary('interface-auditor' as ChallengerAgent, text)
  } catch (e) {
    return {
      status: 'error',
      findings: [],
      notes: e instanceof Error ? e.message : String(e),
      raw: text,
    }
  }

  const findings = raw.findings.map(normalizeFindingCategory)

  return {
    status: raw.status,
    findings,
    notes: raw.notes,
    raw: text,
  }
}

/**
 * 把 challenger Finding（category: string）收紧成 InterfaceAuditFinding
 * （category: InterfaceAuditCategory 枚举）。未识别 category → 'unknown'。
 */
function normalizeFindingCategory(f: Finding): InterfaceAuditFinding {
  const cat = f.category.toLowerCase().trim()
  const matched = VALID_CATEGORIES.find(c => c === cat)
  return {
    severity: f.severity,
    category: matched ?? 'unknown',
    message: f.message,
  }
}

// ---------------------------------------------------------------------------
// 4. Severity helpers (主线 verify 综合用)
// ---------------------------------------------------------------------------

/**
 * 取出 critical findings（主线 synthesize 决策：任一 critical → revise）。
 */
export function criticalFindings(report: InterfaceAuditReport): InterfaceAuditFinding[] {
  return report.findings.filter(f => f.severity === 'critical')
}

/**
 * 取出 major findings（参考用，不阻塞推进；与 verify-orchestrator 语义一致）。
 */
export function majorFindings(report: InterfaceAuditReport): InterfaceAuditFinding[] {
  return report.findings.filter(f => f.severity === 'major')
}

/**
 * 是否含可阻塞推进的 finding（critical）。供主线 synthesize 调用。
 */
export function hasBlockingFindings(report: InterfaceAuditReport): boolean {
  return report.findings.some(f => f.severity === 'critical')
}
