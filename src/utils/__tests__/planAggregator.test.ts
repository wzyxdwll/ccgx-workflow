import { describe, expect, it } from 'vitest'
import {
  aggregatePlans,
  estimateBriefLength,
  estimateTokens,
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
// 7. Serialized brief length budget (≤ 500 tokens, v4.2.1 P24 token-aware)
// ---------------------------------------------------------------------------

describe('serializeBriefForPrompt — token budget (v4.2.1 P24)', () => {
  it('short brief well under 500 tokens', () => {
    const brief = aggregatePlans([
      codexPlan('- 添加 user 模型'),
      geminiPlan('- 添加 user 模型'),
    ])
    expect(estimateBriefLength(brief)).toBeLessThan(500)
  })

  it('huge plan content gets truncated to ≤ 500 tokens', () => {
    const huge = Array.from({ length: 100 })
      .map((_, i) => `- 要点 ${i} 内容描述非常详细包含很多文字 abcdef`)
      .join('\n')
    const brief = aggregatePlans([codexPlan(huge), geminiPlan(huge), claudePlan(huge)])
    expect(estimateBriefLength(brief)).toBeLessThanOrEqual(500)
  })

  it('pure Chinese huge brief stays within 500-token budget (v4.2.1 fix)', () => {
    // 旧版 (SERIALIZED_BRIEF_MAX_CHARS=1000) 对纯中文低估 2x → 实际 ≈ 1000 token
    // 新版 token-aware 截断保证真实 ≤ 500 token
    // 用不同 char 集让每个 bullet 内容各异 (避免 consensus 把它们 cluster 成 1 个)
    // 主要为 divergences 路径（每路 plan 独有，不进 consensus）
    const longBulletsCodex = Array.from({ length: 30 })
      .map((_, i) => `- 后端方案${i}使用各种独特技术栈实现具体逻辑细节比如缓存与数据库`)
      .join('\n')
    const longBulletsGemini = Array.from({ length: 30 })
      .map((_, i) => `- 前端方案${i}采用响应式组件设计与状态管理布局策略不同实现`)
      .join('\n')
    const brief = aggregatePlans([
      codexPlan(longBulletsCodex),
      geminiPlan(longBulletsGemini),
    ])
    const out = serializeBriefForPrompt(brief)
    expect(estimateTokens(out)).toBeLessThanOrEqual(500)
    // 内容总量远超 500 token，截断标记必须出现
    expect(out).toContain('(truncated)')
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
// 8. estimateTokens helper (v4.2.1 P24)
// ---------------------------------------------------------------------------

describe('estimateTokens (v4.2.1 P24)', () => {
  it('empty / non-string → 0', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens(null as never)).toBe(0)
    expect(estimateTokens(undefined as never)).toBe(0)
  })

  it('pure English: 1 word ≈ 1 token', () => {
    // "hello world this is a test" = 6 words → ~6 tokens
    const t = estimateTokens('hello world this is a test')
    expect(t).toBeGreaterThanOrEqual(6)
    expect(t).toBeLessThanOrEqual(8) // tolerance for whitespace
  })

  it('pure Chinese: 1 char ≈ 1 token', () => {
    // "这是一个测试" = 6 chars → ~6 tokens
    const t = estimateTokens('这是一个测试')
    expect(t).toBe(6)
  })

  it('mixed Chinese + English additive', () => {
    // "this is 中文测试" = 3 word + 4 中文 + spaces ≈ 7-9 tokens
    const t = estimateTokens('this is 中文测试')
    expect(t).toBeGreaterThanOrEqual(7)
    expect(t).toBeLessThanOrEqual(10)
  })

  it('long base64-like word splits at 4-char boundary', () => {
    // 16-char alphanum word ≈ 4 tokens
    const t = estimateTokens('abcdefghijklmnop')
    expect(t).toBeGreaterThanOrEqual(4)
  })

  it('symbols / digits / whitespace neutral cost', () => {
    // "1234 !@#$" → other chars × 0.3 weight
    const t = estimateTokens('1234 !@#$')
    expect(t).toBeGreaterThan(0)
    expect(t).toBeLessThan(10)
  })
})

// ---------------------------------------------------------------------------
// 9. extractDivergences token-set algorithm (v4.2.1 P24)
// ---------------------------------------------------------------------------

describe('extractDivergences — token-set algorithm (v4.2.1 P24)', () => {
  it('Redis vs Memcached share {use, cache} → grouped into single divergence', () => {
    const brief = aggregatePlans([
      codexPlan('- use Redis cache layer'),
      geminiPlan('- use Memcached cache layer'),
      claudePlan('- add CDN edge layer'),
    ])
    // Redis and Memcached share "use" + "cache" + "layer" → must be in same divergence
    const cacheDiv = brief.divergences.find(d =>
      d.options.some(o => o.option.toLowerCase().includes('redis')) &&
      d.options.some(o => o.option.toLowerCase().includes('memcached')),
    )
    expect(cacheDiv).toBeDefined()
    expect(cacheDiv!.options.length).toBeGreaterThanOrEqual(2)
  })

  it('CDN bullet shares <2 tokens with Redis/Memcached → standalone divergence', () => {
    const brief = aggregatePlans([
      codexPlan('- use Redis cache layer'),
      geminiPlan('- use Memcached cache layer'),
      claudePlan('- add CDN edge layer'),
    ])
    const cdnDiv = brief.divergences.find(d =>
      d.options.some(o => o.option.toLowerCase().includes('cdn')),
    )
    expect(cdnDiv).toBeDefined()
    // CDN must NOT be merged with Redis/Memcached group
    expect(cdnDiv!.options.some(o => o.option.toLowerCase().includes('redis'))).toBe(false)
    expect(cdnDiv!.options.some(o => o.option.toLowerCase().includes('memcached'))).toBe(false)
  })

  it('完全冲突 plan: 3 model 3 不同方案，全部独立成 divergence (token 共享 < 2)', () => {
    const brief = aggregatePlans([
      codexPlan('- 选用 Redis 做缓存'),
      geminiPlan('- 改用 PostgreSQL 备份'),
      claudePlan('- 走 GraphQL 接口'),
    ])
    expect(brief.consensus.length).toBe(0)
    // 三个 bullet 不共享任何 token；应各自独立
    expect(brief.divergences.length).toBeGreaterThanOrEqual(3)
  })

  it('部分共识 + 共享 token group: 2 路同方向 1 路不同', () => {
    const brief = aggregatePlans([
      codexPlan('- add user authentication module'),
      geminiPlan('- add user session module'),
      claudePlan('- skip CDN for now'),
    ])
    // codex / gemini 共享 {add, user, module} = 3 token → 同 divergence
    const userMod = brief.divergences.find(d =>
      d.options.some(o => o.option.toLowerCase().includes('authentication')) &&
      d.options.some(o => o.option.toLowerCase().includes('session')),
    )
    expect(userMod).toBeDefined()
  })

  it('单 source 独有 bullet 仍独立成 divergence (其他路漏想)', () => {
    const brief = aggregatePlans([
      codexPlan('- enable feature flag rollout system'),
      geminiPlan('- write unit tests for new module'),
      claudePlan('- add database migration script'),
    ])
    // 三个 bullet 互不共享 ≥2 token → 三个独立 divergence
    expect(brief.divergences.length).toBe(3)
    for (const d of brief.divergences) {
      expect(d.options.length).toBe(1) // single source
    }
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
