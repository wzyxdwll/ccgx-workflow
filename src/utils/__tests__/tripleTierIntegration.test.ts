/**
 * Triple-tier integration test (CCG v4.2 Phase 22).
 *
 * 跨 quality-router + plan-aggregator + verify-orchestrator 验证三档分级
 * 编排端到端契约。不 spawn 真 agent；只验证 wave 计划 + 摘要解析 + 决策
 * 路径在主线编排里能够无缝串联。
 */
import { describe, expect, it } from 'vitest'
import {
  aggregatePlans,
  serializeBriefForPrompt,
  type PlanContribution,
} from '../plan-aggregator'
import {
  buildQualityPlan,
  type PhaseMeta,
} from '../quality-router'
import {
  parseVerifyReport,
  synthesizeVerifyResults,
} from '../verify-orchestrator'

const PLUGINS_BOTH = { codex: true, gemini: true }
const PLUGINS_NONE = { codex: false, gemini: false }
const PLUGINS_GEMINI_ONLY = { codex: false, gemini: true }

const phase = (overrides: Partial<PhaseMeta> = {}): PhaseMeta => ({
  phaseId: 'phase-22',
  phaseType: 'backend',
  ...overrides,
})

describe('Triple-tier integration — fast tier', () => {
  it('fast: 2-wave plan; impl spawn = phase-runner; verify cross-vendor', () => {
    const p = buildQualityPlan({ cliArgs: '--quality=fast' }, phase(), PLUGINS_BOTH)
    expect(p.tier).toBe('fast')
    expect(p.waves).toHaveLength(2)
    expect(p.waves[0].kind).toBe('impl')
    expect(p.waves[0].spawns[0].agent).toBe('phase-runner')
    expect(p.waves[1].kind).toBe('verify')
    expect(p.waves[1].spawns).toHaveLength(1)
  })
})

describe('Triple-tier integration — triple tier', () => {
  it('triple: 4-wave plan; plan→critic→impl→verify; brief feeds impl', () => {
    const p = buildQualityPlan({}, phase(), PLUGINS_BOTH)
    expect(p.tier).toBe('triple')
    expect(p.waves).toHaveLength(4)

    // 模拟 plan wave 完成后 3 路 contribution → aggregate
    const planContribs: PlanContribution[] = [
      { model: 'codex', plan: '- 实现 register endpoint\n- 添加 bcrypt 密码哈希' },
      { model: 'gemini', plan: '- 实现 register endpoint\n- 添加 bcrypt 密码哈希' },
      { model: 'claude', plan: '- 实现 register endpoint\n- 添加 OWASP 输入校验' },
    ]
    const brief = aggregatePlans(planContribs)
    const briefMd = serializeBriefForPrompt(brief)
    expect(briefMd.length).toBeLessThanOrEqual(1000)
    expect(brief.consensus.length).toBeGreaterThan(0)

    // 模拟 verify wave 完成后两路 verify report → 决策
    const verifyReports = [
      parseVerifyReport(
        'codex:rescue',
        'STATUS: complete\nFINDINGS: []\nNOTES: clean',
      ),
      parseVerifyReport(
        'gemini:rescue',
        'STATUS: complete\nFINDINGS: []\nNOTES: clean',
      ),
    ]
    expect(synthesizeVerifyResults(verifyReports)).toBe('advance')
  })

  it('triple: critical verify finding → revise', () => {
    const p = buildQualityPlan({ cliArgs: '--quality=triple' }, phase(), PLUGINS_BOTH)
    expect(p.tier).toBe('triple')

    const verifyReports = [
      parseVerifyReport(
        'codex:rescue',
        'STATUS: complete\nFINDINGS: []\nNOTES: ok',
      ),
      parseVerifyReport(
        'gemini:rescue',
        'STATUS: complete\nFINDINGS: [{"severity":"critical","category":"race","message":"data drift"}]\nNOTES: fix',
      ),
    ]
    expect(synthesizeVerifyResults(verifyReports)).toBe('revise')
  })
})

describe('Triple-tier integration — debate tier', () => {
  it('debate: 7 waves with 3 debate rounds in middle', () => {
    const p = buildQualityPlan({ cliArgs: '--quality=debate' }, phase(), PLUGINS_BOTH)
    expect(p.tier).toBe('debate')
    expect(p.waves).toHaveLength(7)
    const debateRounds = p.waves.filter(w => w.kind === 'debate')
    expect(debateRounds).toHaveLength(3)
    expect(debateRounds.map(w => w.round)).toEqual([1, 2, 3])
  })

  it('debate cap is 3 rounds (not more)', () => {
    const p = buildQualityPlan({ cliArgs: '--quality=debate' }, phase({ phaseType: 'fullstack' }), PLUGINS_BOTH)
    const debateRounds = p.waves.filter(w => w.kind === 'debate')
    expect(debateRounds.length).toBe(3) // 硬上限
  })
})

describe('Triple-tier integration — plugin degradation behavior', () => {
  it('debate + no plugins → degrade to fast (2 waves)', () => {
    const p = buildQualityPlan({ cliArgs: '--quality=debate' }, phase(), PLUGINS_NONE)
    expect(p.tier).toBe('debate')
    expect(p.degraded).toBe(true)
    expect(p.degradedTo).toBe('fast')
    expect(p.waves).toHaveLength(2)
    expect(p.waves[0].kind).toBe('impl')
    expect(p.waves[1].kind).toBe('verify')
  })

  it('triple + no plugins → degrade to fast', () => {
    const p = buildQualityPlan({ cliArgs: '--quality=triple' }, phase(), PLUGINS_NONE)
    expect(p.degradedTo).toBe('fast')
    expect(p.waves).toHaveLength(2)
  })

  it('debate + only gemini → degrade to triple (4 waves)', () => {
    const p = buildQualityPlan({ cliArgs: '--quality=debate' }, phase(), PLUGINS_GEMINI_ONLY)
    expect(p.degradedTo).toBe('triple')
    expect(p.waves).toHaveLength(4)
  })

  it('triple + only gemini → no tier degrade but plan/verify wave wave-level fallback', () => {
    const p = buildQualityPlan({ cliArgs: '--quality=triple' }, phase(), PLUGINS_GEMINI_ONLY)
    expect(p.tier).toBe('triple')
    expect(p.degradedTo).toBeUndefined()
    expect(p.degraded).toBe(true) // wave-level
    // plan wave codex slot replaced
    const planWave = p.waves[0]
    expect(planWave.spawns[0].agent).toBe('general-purpose')
  })

  it('phase Quality override survives plugin degradation routing', () => {
    const p = buildQualityPlan(
      { cliArgs: '--quality=fast' }, // user forced fast
      phase({ quality: 'triple' }), // phase says triple
      PLUGINS_BOTH,
    )
    // phase override wins
    expect(p.tier).toBe('triple')
    expect(p.source).toBe('phase-override')
    expect(p.waves).toHaveLength(4)
  })
})

describe('Triple-tier integration — wave indices monotonic', () => {
  it('all waves indexed 1..N in order across tiers', () => {
    for (const tier of ['fast', 'triple', 'debate'] as const) {
      const p = buildQualityPlan({ cliArgs: `--quality=${tier}` }, phase(), PLUGINS_BOTH)
      const indices = p.waves.map(w => w.index)
      expect(indices).toEqual(indices.slice().sort((a, b) => a - b))
      expect(indices[0]).toBe(1)
      expect(indices[indices.length - 1]).toBe(p.waves.length)
    }
  })
})
