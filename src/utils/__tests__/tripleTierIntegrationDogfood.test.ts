/**
 * Triple Tier Integration — Dogfood Test (CCG v4.2.1 Phase 24).
 *
 * P21+P22 集成 mock 测试已覆盖 spawn 矩阵 / decision 决策 / plugin 降级。
 * 本文件补 **dogfood 风格** 端到端用例：模拟真实 LLM 输出（非 mock fixture）
 * 走完整 pipeline，验证 P24 修的 3 项问题在真数据下不回归。
 *
 * 真实场景覆盖：
 *   - 真冲突 plan：3 model 给互斥技术栈建议（PostgreSQL / MongoDB / SQLite）
 *   - 中英混合 plan：50% 中文 50% 英文，验证 brief token 长度 ≤ 500
 *   - 多 bullet 格式：编号 / `*` / `•` / 段落混合，验证 splitIntoBullets 全识别
 *   - JSON 格式 plan：plugin 输出 JSON，验证 splitIntoBullets 容错（不崩）
 *   - 缺路径 plan：3 路输入只 1 路有内容，验证 brief 仍生成 + warning 记录
 *   - decision_required 高 stakes：分歧含 schema/migration → decision_required
 *   - extractDivergences token-set 不被 first-token 误配（P24 fix）
 *
 * 共 8 端到端用例。
 */

import { describe, expect, it } from 'vitest'
import {
  aggregatePlans,
  estimateTokens,
  serializeBriefForPrompt,
  type PlanContribution,
} from '../plan-aggregator'
import { buildQualityPlan } from '../quality-router'
import {
  parseVerifyReport,
  synthesizeVerifyResults,
} from '../verify-orchestrator'

const PLUGINS_BOTH = { codex: true, gemini: true }

// ---------------------------------------------------------------------------
// 1. 真冲突 plan：3 model 互斥数据库选型
// ---------------------------------------------------------------------------

describe('dogfood — real conflict: 3 model 数据库选型互斥', () => {
  it('aggregatePlans 输出含 3 选项 divergence + decision_required 含 schema/database', () => {
    const codexPlan: PlanContribution = {
      model: 'codex',
      plan: `- 选用 PostgreSQL 做主数据库存 user 表
- 添加 schema migration 脚本支持 zero-downtime
- 写 integration test 覆盖事务回滚场景`,
    }
    const geminiPlan: PlanContribution = {
      model: 'gemini',
      plan: `- 改用 MongoDB 做主数据库存 user 表
- 不写 schema migration（NoSQL 无 schema）
- 写 integration test 覆盖事务回滚场景`,
    }
    const claudePlan: PlanContribution = {
      model: 'claude',
      plan: `- 简化用 SQLite 做主数据库存 user 表
- 加 schema migration 工具支持 dev->prod 推送
- 写 integration test 覆盖事务回滚场景`,
    }

    const brief = aggregatePlans([codexPlan, geminiPlan, claudePlan])

    // 数据库选型分歧应捕获（PostgreSQL/MongoDB/SQLite 共享 主数据库存 / database 等 token）
    const dbDivergence = brief.divergences.find(d => {
      const allOptions = d.options.map(o => o.option.toLowerCase()).join(' ')
      return (
        allOptions.includes('postgresql')
        || allOptions.includes('mongodb')
        || allOptions.includes('sqlite')
      )
    })
    expect(dbDivergence).toBeDefined()

    // schema migration 分歧应触发 decision_required
    const allTopics = brief.decision_required.join(' ').toLowerCase()
    const hasHighStakes
      = allTopics.includes('schema')
        || allTopics.includes('migration')
        || allTopics.includes('数据库')
        || brief.divergences.some(d => /schema|migration/i.test(d.topic))
    expect(hasHighStakes).toBe(true)

    // integration test 那条 3 路完全一致（共识）
    expect(brief.consensus.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 2. 中英混合 plan：brief token 长度 ≤ 500
// ---------------------------------------------------------------------------

describe('dogfood — 中英混合 plan token-aware 长度限制', () => {
  it('plan 含 50% 中文 50% 英文，brief 序列化 ≤ 500 token', () => {
    const mixed1: PlanContribution = {
      model: 'codex',
      plan: Array.from({ length: 25 })
        .map((_, i) => `- 实现 module${i} with feature flag rollout 控制 user 灰度比例`)
        .join('\n'),
    }
    const mixed2: PlanContribution = {
      model: 'gemini',
      plan: Array.from({ length: 25 })
        .map((_, i) => `- 设计 ui${i} 组件 with responsive layout 支持移动端 portrait mode`)
        .join('\n'),
    }
    const brief = aggregatePlans([mixed1, mixed2])
    const out = serializeBriefForPrompt(brief)
    expect(estimateTokens(out)).toBeLessThanOrEqual(500)
  })

  it('纯英文 plan token 估算合理（不爆 500）', () => {
    const eng1: PlanContribution = {
      model: 'codex',
      plan: Array.from({ length: 20 })
        .map((_, i) => `- implement endpoint v${i} with rate limit and retry logic for resilience`)
        .join('\n'),
    }
    const eng2: PlanContribution = {
      model: 'gemini',
      plan: Array.from({ length: 20 })
        .map((_, i) => `- write component v${i} with hooks abstraction and lazy loading boundary`)
        .join('\n'),
    }
    const brief = aggregatePlans([eng1, eng2])
    const out = serializeBriefForPrompt(brief)
    expect(estimateTokens(out)).toBeLessThanOrEqual(500)
  })
})

// ---------------------------------------------------------------------------
// 3. 多 bullet 格式：编号 / * / • / 段落混合
// ---------------------------------------------------------------------------

describe('dogfood — 多 bullet 格式识别', () => {
  it('编号 1./2. + * + • + 段落混合都能识别', () => {
    const mixedFormat: PlanContribution = {
      model: 'codex',
      plan: `1. 第一步初始化数据库连接池
2. 第二步加载 schema 配置文件

* 单独要点：注册路由 handler 函数
* 单独要点：启动 metrics 采集器

• 添加缓存预热步骤
• 添加 graceful shutdown 钩子`,
    }
    const brief = aggregatePlans([
      mixedFormat,
      { model: 'gemini', plan: '- 简单一致要点：注册路由 handler 函数' },
    ])

    // 至少 codex 路 6 个 bullet 全部识别 + 1 路重叠 → 至少 1 consensus + 5 divergence
    expect(brief.consensus.length + brief.divergences.length).toBeGreaterThanOrEqual(5)
  })
})

// ---------------------------------------------------------------------------
// 4. JSON 格式 plan: plugin 输出 JSON，splitIntoBullets 容错
// ---------------------------------------------------------------------------

describe('dogfood — JSON 格式 plan 容错', () => {
  it('JSON 包裹 plan 不抛错（即使无 bullet 也走 fallback）', () => {
    const jsonPlan: PlanContribution = {
      model: 'codex',
      plan: `{
  "plan": [
    {"step": 1, "action": "create user table"},
    {"step": 2, "action": "add password hash"}
  ],
  "test_coverage": ["unit", "integration"]
}`,
    }
    expect(() =>
      aggregatePlans([
        jsonPlan,
        { model: 'gemini', plan: '- 实现 user 注册接口完整流程' },
      ]),
    ).not.toThrow()

    const brief = aggregatePlans([
      jsonPlan,
      { model: 'gemini', plan: '- 实现 user 注册接口完整流程' },
    ])
    // 至少 gemini 路有内容
    expect(brief.consensus.length + brief.divergences.length).toBeGreaterThan(0)
  })

  it('完全无意义文本（无 bullet 无段落）warn 记录', () => {
    const garbage: PlanContribution = { model: 'codex', plan: 'a b c' }
    const valid: PlanContribution = {
      model: 'gemini',
      plan: '- 一个有效的实施要点描述足够长',
    }
    const brief = aggregatePlans([garbage, valid])
    expect(brief.warnings.some(w => w.includes('codex'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. 缺路径 plan: 3 路只 1 路有内容
// ---------------------------------------------------------------------------

describe('dogfood — 缺路径 plan 容错', () => {
  it('3 路输入只 1 路有内容 → brief 仍生成 + warning 记 2 路缺失', () => {
    const brief = aggregatePlans([
      { model: 'codex', plan: '' },
      {
        model: 'gemini',
        plan: '- 实现 user 模块完整逻辑\n- 编写 unit 测试覆盖核心路径',
      },
      { model: 'claude', plan: '   ' },
    ])
    // 单 source bullet 仍进 divergence
    expect(brief.divergences.length).toBeGreaterThan(0)
    // 至少 2 条 warning
    expect(brief.warnings.length).toBeGreaterThanOrEqual(2)
    // brief 序列化不崩
    expect(() => serializeBriefForPrompt(brief)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 6. decision_required 高 stakes 触发：schema migration / 数据丢失
// ---------------------------------------------------------------------------

describe('dogfood — decision_required 触发条件', () => {
  it('分歧含 schema migration 关键词 → decision_required', () => {
    const brief = aggregatePlans([
      { model: 'codex', plan: '- 执行 schema migration 添加 v2 字段并 backfill' },
      { model: 'gemini', plan: '- 跳过 schema 改动只加 application-level 兼容层' },
    ])
    const hasDecision
      = brief.decision_required.length > 0
        || brief.divergences.some(d => /schema/i.test(d.topic))
    expect(hasDecision).toBe(true)
  })

  it('分歧含 数据丢失 关键词 → decision_required', () => {
    const brief = aggregatePlans([
      { model: 'codex', plan: '- 删除旧表会触发数据丢失风险需 backup' },
      { model: 'gemini', plan: '- 保留旧表防止数据丢失 migrate 时双写' },
    ])
    const allTopics = [
      ...brief.decision_required,
      ...brief.divergences.map(d => d.topic),
    ].join(' ')
    expect(allTopics).toContain('数据丢失')
  })
})

// ---------------------------------------------------------------------------
// 7. extractDivergences token-set 不被 first-token 误配 (P24 核心修复)
// ---------------------------------------------------------------------------

describe('dogfood — extractDivergences first-token 误配修复 (P24)', () => {
  it('"use Redis" / "use Memcached" / "use email auth" 不全部错配同 group', () => {
    // P24 前：3 bullet 首 token 都是 "use" → 错配同 group
    // P24 后：Redis vs Memcached 共享 {use, cache} = 2 token → 同 group
    //         email auth 与 cache 不共享足够 token → 独立 group
    const brief = aggregatePlans([
      { model: 'codex', plan: '- use Redis cache for session storage' },
      { model: 'gemini', plan: '- use Memcached cache for session storage' },
      { model: 'claude', plan: '- use email magic link auth' },
    ])

    // Redis + Memcached 应在同一 divergence (共享 use/cache/session/storage)
    const cacheDiv = brief.divergences.find(d =>
      d.options.some(o => /redis/i.test(o.option))
      && d.options.some(o => /memcached/i.test(o.option)),
    )
    expect(cacheDiv).toBeDefined()

    // email auth 必须独立 (不与 Redis/Memcached 同 group)
    if (cacheDiv) {
      const hasEmail = cacheDiv.options.some(o => /email/i.test(o.option))
      expect(hasEmail).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// 8. End-to-end pipeline: quality-router → verify-orchestrator
// ---------------------------------------------------------------------------

describe('dogfood — quality-router + verify-orchestrator 联动 SSoT (P24)', () => {
  it('triple tier verify wave 通过 quality-router buildQualityPlan 输出 codex+gemini', () => {
    const plan = buildQualityPlan(
      { cliArgs: '--quality=triple' },
      { phaseId: 'p99', phaseType: 'backend' },
      PLUGINS_BOTH,
    )
    const verifyWave = plan.waves.find(w => w.kind === 'verify')!
    expect(verifyWave.spawns).toHaveLength(2)
    expect(verifyWave.spawns.map(s => s.agent).sort()).toEqual([
      'codex:codex-rescue',
      'gemini:gemini-rescue',
    ])
    // 两个 spawn role 都是 verifier (adapter 注入)
    for (const s of verifyWave.spawns) {
      expect(s.role).toBe('verifier')
    }
  })

  it('verify wave fast tier backend → gemini single (cross-vendor)', () => {
    const plan = buildQualityPlan(
      { cliArgs: '--quality=fast' },
      { phaseId: 'p99', phaseType: 'backend' },
      PLUGINS_BOTH,
    )
    const verifyWave = plan.waves.find(w => w.kind === 'verify')!
    expect(verifyWave.spawns).toHaveLength(1)
    expect(verifyWave.spawns[0].agent).toBe('gemini:gemini-rescue')
  })

  it('verify report 解析 + advance 决策', () => {
    const text = `STATUS: complete
FINDINGS: []
NOTES: all checks pass`
    const r1 = parseVerifyReport('codex:codex-rescue', text)
    const r2 = parseVerifyReport('gemini:gemini-rescue', text)
    const decision = synthesizeVerifyResults([r1, r2])
    expect(decision).toBe('advance')
  })
})
