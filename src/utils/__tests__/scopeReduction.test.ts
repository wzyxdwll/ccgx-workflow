import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  SCOPE_REDUCTION_KEYWORDS,
  classifyScopeReduction,
  extractDomainTokens,
  formatScopeReductionReport,
  scanScopeReduction,
} from '../scope-reduction'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const TEAM_REVIEWER = resolve(
  REPO_ROOT,
  'templates',
  'commands',
  'agents',
  'team-reviewer.md',
)
const PLAN_CHECKER = resolve(
  REPO_ROOT,
  'templates',
  'commands',
  'agents',
  'plan-checker.md',
)
const SPEC_PLAN = resolve(REPO_ROOT, 'templates', 'commands', 'spec-plan.md')

// ---------------------------------------------------------------------------
// 1. scanScopeReduction — pure keyword scanner
// ---------------------------------------------------------------------------
describe('scanScopeReduction (pure scanner)', () => {
  it('detects "v1 静态硬编码" Chinese soft-language', () => {
    const plan = `# Plan
- task 1: 用户成本展示——v1 静态硬编码示例数字，后续连接到 billing 模块
- task 2: dashboard 渲染`
    const hits = scanScopeReduction(plan)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits.some((h) => h.keyword.includes('v1 静态') || h.keyword.includes('v1 硬编码'))).toBe(true)
  })

  it('detects "static for now" English soft-language', () => {
    const plan = `Task 1: cost reference — static for now, will be wired later to billing`
    const hits = scanScopeReduction(plan)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    // line should match either "static for now" or "wired later"
    expect(hits.some((h) => /static for now|wired later/i.test(h.line))).toBe(true)
  })

  it('returns empty list when no soft-language keywords present', () => {
    const plan = `# Clean Plan
- task 1: Implement user cost reference fully connected to billing module
- task 2: Render dashboard with live data`
    const hits = scanScopeReduction(plan)
    expect(hits).toEqual([])
  })

  it('reports correct line numbers (1-based)', () => {
    const plan = `# Plan\n\nTask 1: clean\nTask 2: too complex, defer\nTask 3: clean`
    const hits = scanScopeReduction(plan)
    expect(hits.length).toBe(1)
    expect(hits[0].lineNumber).toBe(4)
  })

  it('handles empty / non-string input gracefully', () => {
    expect(scanScopeReduction('')).toEqual([])
    // @ts-expect-error testing runtime guard
    expect(scanScopeReduction(null)).toEqual([])
    // @ts-expect-error testing runtime guard
    expect(scanScopeReduction(undefined)).toEqual([])
  })

  it('does not double-count a line with multiple keywords (records once)', () => {
    const plan = `Task 1: too complex placeholder for now`
    const hits = scanScopeReduction(plan)
    expect(hits.length).toBe(1)
  })

  it('exposes a non-empty SCOPE_REDUCTION_KEYWORDS set with both Chinese and English', () => {
    expect(SCOPE_REDUCTION_KEYWORDS.length).toBeGreaterThan(10)
    expect(SCOPE_REDUCTION_KEYWORDS.some((k) => /[一-龥]/.test(k))).toBe(true)
    expect(SCOPE_REDUCTION_KEYWORDS.some((k) => /^[a-z]/i.test(k))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. classifyScopeReduction — cross-checks hits against original requirements
// ---------------------------------------------------------------------------
describe('classifyScopeReduction (cross-check with original requirements)', () => {
  it('flags BLOCKER when hit matches an original requirement and plan has NO incremental marker', () => {
    const planText = `# Plan
- task 1: cost reference — v1 静态硬编码 mock 数字，后续连接到 billing module`
    const hits = scanScopeReduction(planText)
    const requirements = [
      'D-26: cost reference must be dynamically computed from billing module',
    ]
    const findings = classifyScopeReduction(hits, requirements, planText)
    const blockers = findings.filter((f) => f.verdict === 'BLOCKER')
    expect(blockers.length).toBeGreaterThanOrEqual(1)
    expect(blockers[0].matchedRequirement).toMatch(/billing|cost/i)
    expect(blockers[0].reason).toContain('原始需求中存在')
  })

  it('does NOT flag BLOCKER when plan explicitly stages v1 -> v2 with v2 also planned', () => {
    const planText = `# Plan
## Phase A (v1)
- task 1: cost reference — v1 静态硬编码 sample，phase 2 接入 billing
## Phase B (v2)
- task 2: phase 2 实施动态 billing 集成（增量交付）`
    const hits = scanScopeReduction(planText)
    const requirements = [
      'D-26: cost reference must be dynamically computed from billing module',
    ]
    const findings = classifyScopeReduction(hits, requirements, planText)
    const blockers = findings.filter((f) => f.verdict === 'BLOCKER')
    expect(blockers.length).toBe(0)
    // 应判 NONE（合理分阶段）
    expect(findings.some((f) => f.verdict === 'NONE')).toBe(true)
  })

  it('issues WARNING when soft-language fires but no requirement match (could be unrelated string)', () => {
    const planText = `# Plan
- task 1: minor refactor — too complex, leave as-is`
    const hits = scanScopeReduction(planText)
    const requirements = ['D-01: implement login form'] // 与 hit 无关
    const findings = classifyScopeReduction(hits, requirements, planText)
    expect(findings.length).toBe(1)
    expect(findings[0].verdict).toBe('WARNING')
  })

  it('handles multiple hits with mixed verdicts', () => {
    const planText = `# Plan
- task 1: billing integration — v1 静态硬编码（缩水）
- task 2: stylistic refactor too complex, defer
- task 3: phase 2 计划补 billing 增量交付`
    const hits = scanScopeReduction(planText)
    const requirements = [
      'D-10: billing integration must connect dashboard to billing service',
    ]
    const findings = classifyScopeReduction(hits, requirements, planText)
    // 由于 planText 包含 "phase 2" + "增量交付"，billing 命中会被判为 NONE（合理分阶段）
    // 这是设计预期：plan 显式声明分阶段时不阻断
    const noneCount = findings.filter((f) => f.verdict === 'NONE').length
    const warningCount = findings.filter((f) => f.verdict === 'WARNING').length
    expect(noneCount + warningCount).toBe(findings.length)
  })

  it('returns empty findings when scanner produced empty hits', () => {
    const findings = classifyScopeReduction([], ['D-01'], 'clean plan text')
    expect(findings).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. extractDomainTokens — domain noun extraction
// ---------------------------------------------------------------------------
describe('extractDomainTokens', () => {
  it('strips the keyword and stopwords, retains domain nouns', () => {
    const tokens = extractDomainTokens(
      'cost reference is v1 静态硬编码 to billing module',
      'v1 静态硬编码',
    )
    // "billing" 与 "module" 是关键领域词，应保留
    expect(tokens).toContain('billing')
    expect(tokens).toContain('module')
    // 不应保留 "is" / "to"
    expect(tokens).not.toContain('is')
    expect(tokens).not.toContain('to')
  })
})

// ---------------------------------------------------------------------------
// 4. formatScopeReductionReport — Markdown output convenience
// ---------------------------------------------------------------------------
describe('formatScopeReductionReport', () => {
  it('returns a clear pass message when no findings', () => {
    const out = formatScopeReductionReport([])
    expect(out).toContain('Scope Reduction 扫描通过')
  })

  it('renders BLOCKER section with line numbers and reasons', () => {
    const out = formatScopeReductionReport([
      {
        keyword: 'v1 静态硬编码',
        line: 'cost reference v1 静态硬编码',
        lineNumber: 5,
        verdict: 'BLOCKER',
        matchedRequirement: 'billing',
        reason: '命中关键词且需求存在',
      },
    ])
    expect(out).toContain('🔴 BLOCKER')
    expect(out).toContain('L5')
    expect(out).toContain('billing')
  })
})

// ---------------------------------------------------------------------------
// 5. Template integration — agents / commands include the scan rule
// ---------------------------------------------------------------------------
describe('Template integration: Scope Reduction Detection sections', () => {
  it('templates/commands/agents/team-reviewer.md mentions Scope Reduction Detection', () => {
    expect(existsSync(TEAM_REVIEWER)).toBe(true)
    const content = readFileSync(TEAM_REVIEWER, 'utf8')
    expect(content).toMatch(/Scope Reduction Detection|范围缩水检测/)
    // BLOCKER 字样必须出现（命中关键词必须可阻断）
    expect(content).toMatch(/BLOCKER/)
    // 至少包含一个核心关键词样例
    expect(content).toMatch(/v1\s*简化|v1\s*静态|v1\s*硬编码|static for now/i)
  })

  it('templates/commands/agents/plan-checker.md keeps Scope Reduction Detection step', () => {
    expect(existsSync(PLAN_CHECKER)).toBe(true)
    const content = readFileSync(PLAN_CHECKER, 'utf8')
    expect(content).toMatch(/范围缩水检测|Scope Reduction Detection/)
    // 强调"必须 BLOCKER 不接受 warning 降级"的核心约束
    expect(content).toMatch(/BLOCKER/)
    // 必须提到与原始需求对比的设计（避免合理 v1 渐进交付误报）
    expect(content).toMatch(/原始需求|original requirements|原需求|requirement/i)
  })

  it('templates/commands/spec-plan.md adds Scope Reduction scan rule', () => {
    expect(existsSync(SPEC_PLAN)).toBe(true)
    const content = readFileSync(SPEC_PLAN, 'utf8')
    expect(content).toMatch(/Scope Reduction|范围缩水/)
    expect(content).toMatch(/BLOCKER/)
  })
})
