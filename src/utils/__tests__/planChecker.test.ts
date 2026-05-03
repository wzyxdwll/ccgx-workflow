import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  checkDim10ClaudeMdCompliance,
  checkDim1RequirementCoverage,
  checkDim2TaskCompleteness,
  checkDim5ScopeSanity,
  checkDim7bScopeReduction,
  formatPlanCheckerReport,
  parsePlanFrontmatter,
  parseTasks,
  runPlanChecker,
} from '../plan-checker'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const PLAN_CHECKER_AGENT = resolve(
  REPO_ROOT,
  'templates',
  'commands',
  'agents',
  'plan-checker.md',
)
const SPEC_PLAN = resolve(REPO_ROOT, 'templates', 'commands', 'spec-plan.md')
const PLAN_CMD = resolve(REPO_ROOT, 'templates', 'commands', 'plan.md')

// ---------------------------------------------------------------------------
// Helpers — sample fixtures
// ---------------------------------------------------------------------------

function makeTask(opts: {
  index: number
  files?: boolean
  action?: boolean
  verify?: boolean
  done?: boolean
}): string {
  const lines: string[] = []
  lines.push(`## Task ${opts.index}: sample task`)
  if (opts.files !== false) lines.push('- Files: src/foo.ts')
  if (opts.action !== false) lines.push('- Action: implement Foo class')
  if (opts.verify !== false) lines.push('- Verify: pnpm test foo')
  if (opts.done !== false) lines.push('- Done: tests green + Foo exported')
  lines.push('')
  return lines.join('\n')
}

function makePlan({
  requirements = ['REQ-01'],
  tasks = 1,
  taskOpts,
  extraBody = '',
  frontmatter,
}: {
  requirements?: string[]
  tasks?: number
  taskOpts?: Parameters<typeof makeTask>[0]
  extraBody?: string
  frontmatter?: string
} = {}): string {
  const fm =
    frontmatter ??
    `---\nplan: sample\nrequirements: [${requirements.map((r) => `"${r}"`).join(', ')}]\n---\n`
  const body: string[] = []
  for (let i = 1; i <= tasks; i++) {
    body.push(makeTask({ ...(taskOpts ?? {}), index: i }))
  }
  body.push(extraBody)
  return `${fm}\n# Plan\n\n${body.join('\n')}`
}

// ---------------------------------------------------------------------------
// 1. parsePlanFrontmatter
// ---------------------------------------------------------------------------
describe('parsePlanFrontmatter', () => {
  it('parses inline `requirements: [A, B]` format', () => {
    const fm = parsePlanFrontmatter(
      `---\nplan: x\nrequirements: [REQ-01, "REQ-02", REQ-03]\n---\n# body\n`,
    )
    expect(fm.plan).toBe('x')
    expect(fm.requirements).toEqual(['REQ-01', 'REQ-02', 'REQ-03'])
  })

  it('parses multi-line list `requirements:\\n  - A` format', () => {
    const fm = parsePlanFrontmatter(
      `---\nrequirements:\n  - REQ-01\n  - REQ-02\nfoo: bar\n---\n`,
    )
    expect(fm.requirements).toEqual(['REQ-01', 'REQ-02'])
  })

  it('returns empty list when no frontmatter', () => {
    const fm = parsePlanFrontmatter('# Plan\nNo frontmatter here.')
    expect(fm.requirements).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. parseTasks — task extraction & 4-field detection
// ---------------------------------------------------------------------------
describe('parseTasks', () => {
  it('detects all 4 fields when present', () => {
    const text = makePlan({ tasks: 1 })
    const tasks = parseTasks(text)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].hasFiles).toBe(true)
    expect(tasks[0].hasAction).toBe(true)
    expect(tasks[0].hasVerify).toBe(true)
    expect(tasks[0].hasDone).toBe(true)
  })

  it('detects missing Verify and Done fields', () => {
    const text = makePlan({
      tasks: 1,
      taskOpts: { index: 1, verify: false, done: false },
    })
    const tasks = parseTasks(text)
    expect(tasks[0].hasVerify).toBe(false)
    expect(tasks[0].hasDone).toBe(false)
    expect(tasks[0].hasFiles).toBe(true)
    expect(tasks[0].hasAction).toBe(true)
  })

  it('parses multiple tasks via Chinese "任务" header', () => {
    const text = `---\nrequirements: [R-1]\n---\n## 任务 1\n- 文件: a.ts\n- 动作: do\n- 验证: pnpm test\n- 完成: green\n## 任务 2\n- 文件: b.ts\n- 动作: do2\n- 验证: pnpm test2\n- 完成: green2\n`
    const tasks = parseTasks(text)
    expect(tasks).toHaveLength(2)
    expect(tasks.every((t) => t.hasFiles && t.hasAction && t.hasVerify && t.hasDone)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. Dim 1 — Requirement Coverage
// ---------------------------------------------------------------------------
describe('Dim 1: Requirement Coverage', () => {
  it('flags BLOCKER when a roadmap requirement is missing in all plans', () => {
    const findings = checkDim1RequirementCoverage(
      ['REQ-01', 'REQ-02', 'REQ-03'],
      [{ requirements: ['REQ-01', 'REQ-03'] }],
    )
    expect(findings).toHaveLength(1)
    expect(findings[0].dimension).toBe('1')
    expect(findings[0].severity).toBe('BLOCKER')
    expect(findings[0].location).toBe('REQ-02')
  })

  it('passes when all requirements are declared (case-insensitive)', () => {
    const findings = checkDim1RequirementCoverage(
      ['REQ-01', 'REQ-02'],
      [{ requirements: ['req-01'] }, { requirements: ['REQ-02'] }],
    )
    expect(findings).toEqual([])
  })

  it('returns empty when roadmapRequirements is empty', () => {
    expect(checkDim1RequirementCoverage([], [])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. Dim 2 — Task Completeness
// ---------------------------------------------------------------------------
describe('Dim 2: Task Completeness', () => {
  it('flags BLOCKER when a task is missing Verify and Done', () => {
    const text = makePlan({
      tasks: 1,
      taskOpts: { index: 1, verify: false, done: false },
    })
    const tasks = parseTasks(text)
    const findings = checkDim2TaskCompleteness(tasks)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('BLOCKER')
    expect(findings[0].message).toMatch(/Verify/)
    expect(findings[0].message).toMatch(/Done/)
  })

  it('passes when all 4 fields are present', () => {
    const tasks = parseTasks(makePlan({ tasks: 2 }))
    const findings = checkDim2TaskCompleteness(tasks)
    expect(findings).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5. Dim 5 — Scope Sanity
// ---------------------------------------------------------------------------
describe('Dim 5: Scope Sanity', () => {
  it('passes for ≤3 tasks', () => {
    const tasks = parseTasks(makePlan({ tasks: 3 }))
    expect(checkDim5ScopeSanity(tasks)).toEqual([])
  })

  it('warns on 4 tasks', () => {
    const tasks = parseTasks(makePlan({ tasks: 4 }))
    const findings = checkDim5ScopeSanity(tasks)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('WARNING')
  })

  it('blockers on 5+ tasks', () => {
    const tasks = parseTasks(makePlan({ tasks: 5 }))
    const findings = checkDim5ScopeSanity(tasks)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('BLOCKER')
    expect(findings[0].message).toMatch(/5/)
  })
})

// ---------------------------------------------------------------------------
// 6. Dim 7b — Scope Reduction (delegates to scope-reduction helper)
// ---------------------------------------------------------------------------
describe('Dim 7b: Scope Reduction Detection', () => {
  it('flags BLOCKER when "v1 静态" hits a known requirement (billing) without v2 plan', () => {
    const planText = `# Plan\n## Task 1\n- Files: src/dashboard.ts\n- Action: dashboard cost reference v1 静态硬编码 sample numbers, will be wired later\n- Verify: pnpm test dashboard\n- Done: dashboard renders\n`
    const findings = checkDim7bScopeReduction(planText, [
      'dashboard cost reference must be dynamically computed from billing module',
    ])
    const blockers = findings.filter((f) => f.severity === 'BLOCKER')
    expect(blockers.length).toBeGreaterThanOrEqual(1)
    expect(blockers[0].dimension).toBe('7b')
  })

  it('passes when soft language is paired with explicit v2/phase 2 plan', () => {
    const planText = `---\nrequirements: [REQ-01]\n---\n# Plan (incremental)\nv1 静态硬编码 cost reference for now; v2 in next phase wires it to billing.\n`
    const findings = checkDim7bScopeReduction(planText, ['cost reference billing'])
    expect(findings.filter((f) => f.severity === 'BLOCKER')).toEqual([])
  })

  it('returns empty when plan is clean', () => {
    const planText = makePlan({ tasks: 1 })
    expect(checkDim7bScopeReduction(planText, ['REQ-01'])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 7. Dim 10 — CLAUDE.md Compliance
// ---------------------------------------------------------------------------
describe('Dim 10: CLAUDE.md Compliance', () => {
  it('flags BLOCKER on forbidden literal pattern', () => {
    const planText = `# Plan\n## Task 1\n- Action: run git push --force --no-verify on main\n`
    const findings = checkDim10ClaudeMdCompliance(planText, ['--no-verify'], [])
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('BLOCKER')
    expect(findings[0].dimension).toBe('10')
  })

  it('flags BLOCKER on forbidden RegExp pattern', () => {
    const planText = `Action: do git reset --hard origin/main\n`
    const findings = checkDim10ClaudeMdCompliance(
      planText,
      [/git\s+reset\s+--hard/i],
      [],
    )
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('BLOCKER')
  })

  it('warns when required step is not mentioned', () => {
    const planText = `# Plan\n## Task 1\n- Files: a.ts\n- Action: change\n- Verify: lint\n- Done: ok\n`
    const findings = checkDim10ClaudeMdCompliance(planText, [], ['pnpm typecheck'])
    expect(findings.some((f) => f.severity === 'WARNING' && f.dimension === '10')).toBe(true)
  })

  it('passes when no forbidden / all required steps present', () => {
    const planText = `# Plan\nrun pnpm typecheck and pnpm test before commit.\n`
    const findings = checkDim10ClaudeMdCompliance(
      planText,
      ['--no-verify'],
      ['pnpm typecheck', 'pnpm test'],
    )
    expect(findings).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 8. runPlanChecker — top-level orchestration
// ---------------------------------------------------------------------------
describe('runPlanChecker', () => {
  it('returns hasBlocker=false for a fully compliant plan', () => {
    const planText = makePlan({ tasks: 2, requirements: ['REQ-01'] })
    const result = runPlanChecker({
      planText,
      roadmapRequirements: ['REQ-01'],
      originalRequirements: [],
      claudeMdForbidden: ['--no-verify'],
      claudeMdRequired: [],
    })
    expect(result.hasBlocker).toBe(false)
    expect(result.counts.BLOCKER).toBe(0)
  })

  it('returns hasBlocker=true when 5+ tasks AND missing requirement', () => {
    const planText = makePlan({ tasks: 5, requirements: ['REQ-01'] })
    const result = runPlanChecker({
      planText,
      roadmapRequirements: ['REQ-01', 'REQ-02'],
    })
    expect(result.hasBlocker).toBe(true)
    expect(result.counts.BLOCKER).toBeGreaterThanOrEqual(2)
    const dims = new Set(result.findings.map((f) => f.dimension))
    expect(dims.has('1')).toBe(true)
    expect(dims.has('5')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 9. formatPlanCheckerReport — markdown output
// ---------------------------------------------------------------------------
describe('formatPlanCheckerReport', () => {
  it('emits ✅ verdict when no blockers', () => {
    const result = runPlanChecker({
      planText: makePlan({ tasks: 1 }),
      roadmapRequirements: ['REQ-01'],
    })
    const md = formatPlanCheckerReport(result)
    expect(md).toMatch(/✅ 放行/)
  })

  it('emits ❌ verdict when blockers present', () => {
    const result = runPlanChecker({
      planText: makePlan({ tasks: 5 }),
      roadmapRequirements: ['REQ-01'],
    })
    const md = formatPlanCheckerReport(result)
    expect(md).toMatch(/❌/)
    expect(md).toMatch(/BLOCKER/)
  })
})

// ---------------------------------------------------------------------------
// 10. Template wiring — the agent doc + commands embed the 5 dimensions
// ---------------------------------------------------------------------------
describe('templates wiring (Phase 6 plan-checker upgrade)', () => {
  it('plan-checker.md exists and references all 5 dimensions', () => {
    expect(existsSync(PLAN_CHECKER_AGENT)).toBe(true)
    const md = readFileSync(PLAN_CHECKER_AGENT, 'utf8')
    // 5 dimension IDs must appear (1 / 2 / 5 / 7b / 10)
    expect(md).toMatch(/Dim(?:ension)?\s*1/i)
    expect(md).toMatch(/Dim(?:ension)?\s*2/i)
    expect(md).toMatch(/Dim(?:ension)?\s*5/i)
    expect(md).toMatch(/Dim(?:ension)?\s*7b/i)
    expect(md).toMatch(/Dim(?:ension)?\s*10/i)
  })

  it('plan-checker.md mentions max-3-loop convergence', () => {
    const md = readFileSync(PLAN_CHECKER_AGENT, 'utf8')
    expect(md).toMatch(/max[- ]?3[- ]?loop|3\s*轮|至多.*3.*次/i)
  })

  it('spec-plan.md auto-spawns plan-checker after artifacts', () => {
    expect(existsSync(SPEC_PLAN)).toBe(true)
    const md = readFileSync(SPEC_PLAN, 'utf8')
    expect(md).toMatch(/plan-checker/i)
    expect(md).toMatch(/自动\s*plan-checker|automatic\s*plan-checker/i)
  })

  it('plan.md auto-spawns plan-checker before delivery', () => {
    expect(existsSync(PLAN_CMD)).toBe(true)
    const md = readFileSync(PLAN_CMD, 'utf8')
    expect(md).toMatch(/plan-checker/i)
  })
})
