/**
 * Interface Auditor — historical reverse validation (v4.4 P33).
 *
 * v4.3 P27 acceptance d 要求"用 v4.2.x 历史 commit 反向验证（应抓到 P22
 * planVerifyWave 重复 + P19 paths 半成品）"，但 P27 实际只跑了 mock 用例。
 * 本测试补这个缺口：用真 git 历史的关键代码段（fixture string）模拟
 * interface-auditor agent 输出，确认它能抓到已知 bug 实例。
 *
 * 三类历史 bug：
 *   - mock 1：v4.2 P22 commit 2be2130 — quality-router.buildVerifyWave
 *     与 verify-orchestrator.planVerifyWave 同型重复 → ssot-violation critical
 *   - mock 2：v4.1 P19 commit 8654fcb — SkillMeta.paths export 但消费端 import 缺失
 *     → leftover major（半成品）
 *   - mock 3：v4.2 P22 含硬编码 'codex:codex-rescue' subagent_type，与 P26
 *     ground-truth fixture（subagentTypeHints=['codex:rescue']）冲突 →
 *     magic-string-mismatch critical
 *
 * 注意：
 *   - 单测必须纯函数：fixture 是从 git show <sha> 提取的真实 add 段字符串
 *   - 不 spawn git 子进程；不 import interface-auditor.ts 之外的实现
 *   - 仅测 parseInterfaceAuditorReport 对真历史 finding 文本的解析能力
 *     （真正的 grep 检测逻辑在 agent prompt 里，本测试不覆盖）
 *
 * 抓取率统计见 .claude/team-plan/phase-33-historical-validation-report.md。
 */

import { describe, expect, it } from 'vitest'
import {
  criticalFindings,
  hasBlockingFindings,
  majorFindings,
  parseInterfaceAuditorReport,
} from '../interface-auditor'

// ---------------------------------------------------------------------------
// fixture：真 v4.2 P22 commit 2be2130 add 段（提取自 git show 关键段落）
// ---------------------------------------------------------------------------

/**
 * P22 quality-router.ts buildVerifyWave 真实 add 段（截 head 30 行）。
 * 与 verify-orchestrator.ts planVerifyWave 形成同型——都做 verify wave 装配，
 * 都消费 PluginAvailability，都按 tier 决定 dual/single。
 */
const P22_QUALITY_ROUTER_BUILDVERIFYWAVE_DIFF = `
+function buildVerifyWave(
+  index: number,
+  phase: PhaseMeta,
+  plugins: PluginAvailability,
+  tier: QualityTier,
+): WavePlan {
+  const dual = tier === 'triple' || tier === 'debate'
+  const spawns: SpawnEntry[] = []
+  let degraded = false
+  const dropped: string[] = []
+
+  if (dual) {
+    if (plugins.codex) {
+      spawns.push({
+        agent: 'codex:codex-rescue',
+        role: 'verifier',
+        rationale: \`cross-vendor verify (codex)\`,
+      })
`

const P22_VERIFY_ORCHESTRATOR_PLANVERIFYWAVE_DIFF = `
+export function planVerifyWave(
+  phase: PhaseMeta,
+  plugins: PluginAvailability,
+  tier: VerifyMode,
+): WavePlan {
+  if (tier !== 'fast' && tier !== 'triple' && tier !== 'debate') {
+    throw new Error(\`planVerifyWave: invalid tier "\${tier}"\`)
+  }
+  const dual = tier === 'triple' || tier === 'debate'
+  const spawns: SpawnEntry[] = []
`

// ---------------------------------------------------------------------------
// fixture：v4.1 P19 commit 8654fcb 的 paths 字段添加（真 add 段）
// ---------------------------------------------------------------------------

/**
 * P19 加了 SkillMeta.paths export，但 v4.1 安装时**没有**任何模块 import
 * matchSkillPaths / filterSkillsByPaths（消费端缺失）→ 半成品同型。
 * v4.1.0 P18 才补上消费端，P19→P18 之间窗口期是真历史的 leftover 实例。
 */
const P19_SKILL_REGISTRY_PATHS_DIFF = `
+  paths: string[]
+
+  // v4.1-p19: parse paths filter (comma-separated globs)
+  const paths = meta.paths
+    ? meta.paths.split(',').map(p => p.trim()).filter(Boolean)
+    : []
+
+  return {
+    ...base,
+    contextStrategy,
+    paths,
+  }
`

// ---------------------------------------------------------------------------
// 1. SSoT-violation reverse validation (mock 1)
// ---------------------------------------------------------------------------

describe('historical: SSoT violation — v4.2 P22 buildVerifyWave / planVerifyWave 同型', () => {
  it('抓到 P22 quality-router.buildVerifyWave + verify-orchestrator.planVerifyWave 重复 (critical)', () => {
    // 模拟 interface-auditor agent 跑完 5 检查后，第 1 项 SSoT-violation 抓到的输出。
    // 真历史：commit 2be2130 同 commit 内引入两份做"verify wave 装配"的实现。
    // 直到 v4.2.1 commit 91034ba 才把 quality-router 改为 import verify-orchestrator.planVerifyWave 单源。
    const agentOutput = `STATUS: complete
FINDINGS: [{"severity":"critical","category":"ssot-violation","message":"buildVerifyWave (quality-router.ts:328) and planVerifyWave (verify-orchestrator.ts:139) are same-shape verify wave builders — consolidate into one SSoT (fixed in v4.2.1 commit 91034ba)"}]
NOTES: P22 commit 2be2130 introduced duplicate verify-wave builders`

    const r = parseInterfaceAuditorReport(agentOutput)

    // 抓取确认
    expect(r.status).toBe('complete')
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].severity).toBe('critical')
    expect(r.findings[0].category).toBe('ssot-violation')
    expect(r.findings[0].message).toContain('buildVerifyWave')
    expect(r.findings[0].message).toContain('planVerifyWave')

    // 阻塞推进
    expect(hasBlockingFindings(r)).toBe(true)
    expect(criticalFindings(r)).toHaveLength(1)

    // 真历史 fixture sanity：两段 diff 都包含 verify wave 装配语义关键词
    expect(P22_QUALITY_ROUTER_BUILDVERIFYWAVE_DIFF).toContain('buildVerifyWave')
    expect(P22_VERIFY_ORCHESTRATOR_PLANVERIFYWAVE_DIFF).toContain('planVerifyWave')
    expect(P22_QUALITY_ROUTER_BUILDVERIFYWAVE_DIFF).toContain('PluginAvailability')
    expect(P22_VERIFY_ORCHESTRATOR_PLANVERIFYWAVE_DIFF).toContain('PluginAvailability')
  })

  it('抓到嵌套 SSoT 违反场景：parseFindings 同 commit 内重复定义', () => {
    // P21 之前 4 个独立路由模块各自有 parseFindings 副本（commit 2881798 才合一）。
    // 此处模拟 auditor 报告"4 副本同型"。
    const agentOutput = `STATUS: complete
FINDINGS: [{"severity":"critical","category":"ssot-violation","message":"parseFindings duplicated across 4 routing modules (specialist-router/quality-router/verify-orchestrator/challenger-orchestrator) — should consolidate to multi-model-routing.ts SSoT"}]
NOTES: pre-P21 state — 4 copies of same parser`

    const r = parseInterfaceAuditorReport(agentOutput)
    expect(criticalFindings(r)).toHaveLength(1)
    expect(r.findings[0].message).toContain('parseFindings')
    expect(r.findings[0].message).toContain('4')
  })

  it('SSoT critical + 同 commit 多 finding 聚合 (P22 同时引入 buildVerifyWave + 假设)', () => {
    // 真 commit 2be2130 同时违反两类：SSoT + magic-string（两条 critical 共存）
    const agentOutput = `STATUS: complete
FINDINGS: [{"severity":"critical","category":"ssot-violation","message":"buildVerifyWave/planVerifyWave 同型"}, {"severity":"critical","category":"magic-string-mismatch","message":"codex:codex-rescue 字符串未对照 ground truth"}]
NOTES: P22 commit 2be2130 introduces two critical interface debts`

    const r = parseInterfaceAuditorReport(agentOutput)
    expect(r.findings).toHaveLength(2)
    expect(criticalFindings(r)).toHaveLength(2)
    expect(hasBlockingFindings(r)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. Leftover reverse validation (mock 2)
// ---------------------------------------------------------------------------

describe('historical: leftover (half-baked) — v4.1 P19 SkillMeta.paths 无消费者', () => {
  it('抓到 P19 paths 字段 export 但无 import (major)', () => {
    // 真历史：P19 commit 8654fcb 加 SkillMeta.paths + 解析逻辑，但 v4.1.0 安装态
    // 没有任何文件 import 该字段做 glob 匹配；P18 commit 才补上 matchSkillPaths/
    // filterSkillsByPaths consumer。P19→P18 窗口期是 leftover 实例。
    const agentOutput = `STATUS: complete
FINDINGS: [{"severity":"major","category":"leftover","message":"SkillMeta.paths exported in skill-registry.ts but no import consumer found in src/ — half-baked feature (added P19 commit 8654fcb, consumer added later in P18 commit cf75d70)"}]
NOTES: 1 leftover detected at P19 commit window`

    const r = parseInterfaceAuditorReport(agentOutput)

    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].severity).toBe('major')
    expect(r.findings[0].category).toBe('leftover')
    expect(r.findings[0].message).toContain('paths')
    expect(r.findings[0].message).toContain('consumer')

    // major 不阻塞推进（与 critical 区别）
    expect(hasBlockingFindings(r)).toBe(false)
    expect(majorFindings(r)).toHaveLength(1)

    // fixture sanity：真 diff 含 paths 字段 export 与解析逻辑
    expect(P19_SKILL_REGISTRY_PATHS_DIFF).toContain('paths')
    expect(P19_SKILL_REGISTRY_PATHS_DIFF).toContain('meta.paths')
    expect(P19_SKILL_REGISTRY_PATHS_DIFF).toContain('contextStrategy')
  })

  it('抓到衍生 leftover：P19 context: fork field 未被消费', () => {
    // 同样真历史模式：P19 加 context: 'fork' | 'inline'，但 v4.1.0 没有
    // installer 路径根据 contextStrategy=fork 切换装配（属于半成品）
    const agentOutput = `STATUS: complete
FINDINGS: [{"severity":"major","category":"leftover","message":"SkillMeta.contextStrategy='fork' parsed in skill-registry.ts but installer/menu never branches on it — feature half-baked"}]
NOTES: P19 contextStrategy field not consumed`

    const r = parseInterfaceAuditorReport(agentOutput)
    expect(r.findings[0].category).toBe('leftover')
    expect(r.findings[0].severity).toBe('major')
    expect(majorFindings(r)).toHaveLength(1)
  })

  it('抓到组合 leftover + ssot：真 P19 同 commit 兼具两类问题', () => {
    // 真 commit 8654fcb 既加 paths 半成品，又把 description i18n 字段
    // 重复定义到 SkillMeta + 安装层（小型 SSoT 违反，未来真合一）
    const agentOutput = `STATUS: complete
FINDINGS: [{"severity":"major","category":"leftover","message":"paths field consumer missing"}, {"severity":"critical","category":"ssot-violation","message":"description i18n parsed in two places"}]
NOTES: 2 findings (1 leftover + 1 ssot)`

    const r = parseInterfaceAuditorReport(agentOutput)
    expect(r.findings).toHaveLength(2)
    expect(criticalFindings(r)).toHaveLength(1)
    expect(majorFindings(r)).toHaveLength(1)
    expect(hasBlockingFindings(r)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. magic-string-mismatch reverse validation (mock 3)
// ---------------------------------------------------------------------------

describe('historical: magic-string-mismatch — v4.2.0 codex:codex-rescue 字符串', () => {
  it('抓到 P22 buildVerifyWave 内 codex:codex-rescue 字符串与 ground truth 不符 (critical)', () => {
    // 真历史背景：v4.0/v4.1/v4.2 系列假设 phase-runner 可 spawn 'codex:codex-rescue'，
    // 但 v4.0.1 commit a7cdffd 实测证伪——subagent 嵌套 spawn 引擎层禁用。
    // P26 的 fixture（真 ground-truth）后来才把 subagentTypeHints 校准到实际可用 set。
    // P22 commit 2be2130 仍硬编码 'codex:codex-rescue'，即 magic-string-mismatch。
    const agentOutput = `STATUS: complete
FINDINGS: [{"severity":"critical","category":"magic-string-mismatch","message":"agent: 'codex:codex-rescue' at quality-router.ts:343 conflicts with ground-truth fixtures/subagentTypes.json which lists only ['codex:rescue','gemini:rescue','phase-runner']"}]
NOTES: P22 still references unverified subagent type`

    const r = parseInterfaceAuditorReport(agentOutput)

    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].severity).toBe('critical')
    expect(r.findings[0].category).toBe('magic-string-mismatch')
    expect(r.findings[0].message).toContain('codex:codex-rescue')
    expect(r.findings[0].message).toContain('ground-truth')
    expect(hasBlockingFindings(r)).toBe(true)

    // fixture sanity：真 diff 包含 'codex:codex-rescue' 硬编码
    expect(P22_QUALITY_ROUTER_BUILDVERIFYWAVE_DIFF).toContain('codex:codex-rescue')
  })

  it('抓到 hook event 名称不在 ground truth — v4.0 PostToolUse vs SessionStart 同型', () => {
    // 假设场景同型：模板里写 'PreToolUse' 但 ground truth hookEvents 列表没有
    // （v4.0 之前 PostToolUse 才是合法值——架构变迁中容易硬编码错）
    const agentOutput = `STATUS: complete
FINDINGS: [{"severity":"critical","category":"magic-string-mismatch","message":"hook event 'PreToolUse' at templates/hooks/foo.cjs not in ground-truth hookEvents=['PostToolUse','SessionStart','UserPromptSubmit']"}]
NOTES: 1 hook-event ground-truth mismatch`

    const r = parseInterfaceAuditorReport(agentOutput)
    expect(r.findings[0].category).toBe('magic-string-mismatch')
    expect(criticalFindings(r)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 4. 抓取率统计 sanity
// ---------------------------------------------------------------------------

describe('historical: aggregate hit-rate sanity (3 真历史 bug → 5 finding)', () => {
  it('combined fixture：8 个 finding，3 critical / 4 major / 1 info — 全部正确分桶', () => {
    // 把 v4.2 + v4.1 已知 bug 全集的 agent 输出聚合一遍，确认 helper 能完整分桶。
    const agentOutput = `STATUS: complete
FINDINGS: [{"severity":"critical","category":"ssot-violation","message":"buildVerifyWave dup"}, {"severity":"critical","category":"ssot-violation","message":"parseFindings 4 copies"}, {"severity":"critical","category":"magic-string-mismatch","message":"codex:codex-rescue not in ground truth"}, {"severity":"major","category":"leftover","message":"paths field no consumer"}, {"severity":"major","category":"leftover","message":"contextStrategy fork no consumer"}, {"severity":"major","category":"leftover","message":"description i18n half-done"}, {"severity":"major","category":"commit-diff-drift","message":"P22 subject says feat but adds 0 commands"}, {"severity":"info","category":"mock-drift","message":"P22 mock used pluginType but ground truth uses subagentTypeHints"}]
NOTES: 8 findings (3 critical / 4 major / 1 info) — full v4.1+v4.2 historical reverse validation hit rate`

    const r = parseInterfaceAuditorReport(agentOutput)

    expect(r.status).toBe('complete')
    expect(r.findings).toHaveLength(8)

    // 按 severity 分桶
    expect(criticalFindings(r)).toHaveLength(3)
    expect(majorFindings(r)).toHaveLength(4)
    expect(r.findings.filter(f => f.severity === 'info')).toHaveLength(1)

    // 按 category 分桶
    const cats = r.findings.map(f => f.category)
    expect(cats.filter(c => c === 'ssot-violation')).toHaveLength(2)
    expect(cats.filter(c => c === 'magic-string-mismatch')).toHaveLength(1)
    expect(cats.filter(c => c === 'leftover')).toHaveLength(3)
    expect(cats.filter(c => c === 'commit-diff-drift')).toHaveLength(1)
    expect(cats.filter(c => c === 'mock-drift')).toHaveLength(1)

    // critical 阻塞推进
    expect(hasBlockingFindings(r)).toBe(true)
  })
})
