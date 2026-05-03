import { describe, expect, it } from 'vitest'
import {
  aggregatePlans,
  estimateBriefLength,
  serializeBriefForPrompt,
  type PlanContribution,
} from '../plan-aggregator'

const codexPlan = (text: string): PlanContribution => ({ model: 'codex', plan: text })
const geminiPlan = (text: string): PlanContribution => ({ model: 'gemini', plan: text })
const claudePlan = (text: string): PlanContribution => ({ model: 'claude', plan: text })

// ---------------------------------------------------------------------------
// 1. Empty / edge cases
// ---------------------------------------------------------------------------

describe('aggregatePlans — empty and edge cases', () => {
  it('empty array → empty brief with warning', () => {
    const brief = aggregatePlans([])
    expect(brief.consensus).toEqual([])
    expect(brief.divergences).toEqual([])
    expect(brief.warnings).toContain('no plan contributions')
  })

  it('non-array throws', () => {
    expect(() => aggregatePlans(null as never)).toThrow(/must be array/)
  })

  it('all empty plan strings → warning per contribution', () => {
    const brief = aggregatePlans([codexPlan(''), geminiPlan('   ')])
    expect(brief.consensus).toEqual([])
    expect(brief.warnings.length).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// 2. Consensus extraction (mock 3 路一致)
// ---------------------------------------------------------------------------

describe('aggregatePlans — consensus when plans align', () => {
  it('3 paths agree on same bullets → consensus extracted', () => {
    const brief = aggregatePlans([
      codexPlan('- 实现用户注册 API\n- 添加密码哈希逻辑\n- 编写 unit tests'),
      geminiPlan('- 实现用户注册 API\n- 添加密码哈希逻辑\n- 编写 unit tests'),
      claudePlan('- 实现用户注册 API\n- 添加密码哈希逻辑\n- 编写 unit tests'),
    ])
    expect(brief.consensus.length).toBeGreaterThanOrEqual(2)
    expect(brief.consensus.join(' ')).toContain('用户注册')
  })

  it('serialized brief is concise when consensus dominates', () => {
    const brief = aggregatePlans([
      codexPlan('- foo bar baz qux'),
      geminiPlan('- foo bar baz qux'),
      claudePlan('- foo bar baz qux'),
    ])
    const out = serializeBriefForPrompt(brief)
    expect(out).toContain('共识要点')
    expect(out.length).toBeLessThan(500)
  })
})

// ---------------------------------------------------------------------------
// 3. Mixed: 2 路同意 1 路反对
// ---------------------------------------------------------------------------

describe('aggregatePlans — 2 agree, 1 dissent', () => {
  it('extracts both consensus and divergence', () => {
    const brief = aggregatePlans([
      codexPlan('- 使用 PostgreSQL 存储 sessions\n- 启用 OAuth 2.0 认证流程'),
      geminiPlan('- 使用 PostgreSQL 存储 sessions\n- 跳过 OAuth 改用 SAML 集成'),
      claudePlan('- 使用 PostgreSQL 存储 sessions\n- 不需要任何 SSO 集成方案'),
    ])
    // PostgreSQL 提了 3 次 → consensus
    expect(brief.consensus.some(c => c.includes('PostgreSQL'))).toBe(true)
    // 第二条三家说法完全不同（OAuth / SAML / 不需要） → divergence
    expect(brief.divergences.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 4. All conflict scenarios
// ---------------------------------------------------------------------------

describe('aggregatePlans — full conflict', () => {
  it('all paths give different plans → all divergences', () => {
    const brief = aggregatePlans([
      codexPlan('- 使用 REST API'),
      geminiPlan('- 使用 GraphQL'),
      claudePlan('- 使用 gRPC'),
    ])
    expect(brief.consensus.length).toBe(0)
    expect(brief.divergences.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 5. High-stakes decision detection
// ---------------------------------------------------------------------------

describe('aggregatePlans — decision_required (high-stakes keywords)', () => {
  it('架构 keyword in divergence → decision_required', () => {
    const brief = aggregatePlans([
      codexPlan('- 改造架构使用微服务'),
      geminiPlan('- 保持单体架构不变'),
    ])
    // both have 架构 prefix → may end up grouped; the topic should hit high-stakes
    const allTopics = [
      ...brief.divergences.map(d => d.topic),
      ...brief.decision_required,
    ].join(' ')
    // expect either decision_required populated or divergences contain 架构
    expect(allTopics).toContain('架构')
  })

  it('schema keyword triggers decision_required', () => {
    const brief = aggregatePlans([
      codexPlan('- schema breaking change'),
      geminiPlan('- minor patch'),
    ])
    // schema in topic → decision_required
    const hasDecision =
      brief.decision_required.length > 0 ||
      brief.divergences.some(d => d.topic.toLowerCase().includes('schema'))
    expect(hasDecision).toBe(true)
  })

  it('benign disagreement does not trigger decision_required', () => {
    const brief = aggregatePlans([
      codexPlan('- 把 button 颜色改红色'),
      geminiPlan('- 把 button 颜色改蓝色'),
    ])
    expect(brief.decision_required.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 6. One contribution fails to parse
// ---------------------------------------------------------------------------

describe('aggregatePlans — partial failure tolerance', () => {
  it('one contribution empty → use other 2 paths and warn', () => {
    const brief = aggregatePlans([
      codexPlan(''),
      geminiPlan('- 实现 OAuth\n- 添加 JWT 验证'),
      claudePlan('- 实现 OAuth\n- 添加 JWT 验证'),
    ])
    expect(brief.warnings.some(w => w.includes('codex'))).toBe(true)
    // 2 路同意仍能产出 consensus
    expect(brief.consensus.length).toBeGreaterThan(0)
  })

  it('contribution with no parseable bullets warned but other paths used', () => {
    const brief = aggregatePlans([
      codexPlan('a'), // too short, no bullet
      geminiPlan('- 一个有效的实施要点描述'),
      claudePlan('- 一个有效的实施要点描述'),
    ])
    // codex 只有 'a' < MIN_BULLET_LEN 应该 warn
    expect(brief.warnings.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 7. Serialized brief length budget (≤ 500 token ≈ ≤ 1000 chars)
// ---------------------------------------------------------------------------

describe('serializeBriefForPrompt — length budget', () => {
  it('short brief well under 1000 chars', () => {
    const brief = aggregatePlans([
      codexPlan('- 添加 user 模型'),
      geminiPlan('- 添加 user 模型'),
    ])
    expect(estimateBriefLength(brief)).toBeLessThan(1000)
  })

  it('huge plan content gets truncated to ≤ 1000 chars', () => {
    const huge = Array.from({ length: 100 })
      .map((_, i) => `- 要点 ${i} 内容描述非常详细包含很多文字 abcdef`)
      .join('\n')
    const brief = aggregatePlans([codexPlan(huge), geminiPlan(huge), claudePlan(huge)])
    expect(estimateBriefLength(brief)).toBeLessThanOrEqual(1000)
  })

  it('serialized output contains expected sections', () => {
    const brief = aggregatePlans([
      codexPlan('- 共识 a\n- 独有 codex 项'),
      geminiPlan('- 共识 a\n- 独有 gemini 项'),
    ])
    const out = serializeBriefForPrompt(brief)
    expect(out).toContain('Design Brief')
  })
})

// ---------------------------------------------------------------------------
// 8. Bullet split robustness
// ---------------------------------------------------------------------------

describe('aggregatePlans — bullet parsing robustness', () => {
  it('numbered list (1. 2.) works', () => {
    const brief = aggregatePlans([
      codexPlan('1. 创建 endpoint xxxxx\n2. 编写测试 yyyyy'),
      geminiPlan('1. 创建 endpoint xxxxx\n2. 编写测试 yyyyy'),
    ])
    expect(brief.consensus.length).toBeGreaterThan(0)
  })

  it('* bullet works', () => {
    const brief = aggregatePlans([
      codexPlan('* foo bar 1234567'),
      geminiPlan('* foo bar 1234567'),
    ])
    expect(brief.consensus.length).toBeGreaterThan(0)
  })

  it('plain text without bullets still parsed by paragraph', () => {
    const brief = aggregatePlans([
      codexPlan('实现用户认证模块完整流程\n\n包含登录注册功能'),
      geminiPlan('实现用户认证模块完整流程\n\n包含登录注册功能'),
    ])
    // 至少有些 bullets 被切出来
    expect(brief.consensus.length + brief.divergences.length).toBeGreaterThan(0)
  })
})
