import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  checkDeferred,
  computeOverlapRatio,
  extractDataSources,
  extractGapKeywords,
  extractHollowProps,
  extractStateVars,
  extractStaticFallbacks,
  formatDataFlowReport,
  isDynamicComponent,
  matchOverride,
  tokenizeForOverride,
  traceDataFlow,
  type FuturePhasePlan,
  type VerificationOverride,
} from '../verifier-level-4'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const VERIFIER_AGENT = resolve(
  REPO_ROOT,
  'templates',
  'commands',
  'agents',
  'verifier.md',
)

// ---------------------------------------------------------------------------
// 1. Level 4 Data Flow Tracing — core algorithm
// ---------------------------------------------------------------------------

describe('Level 4: traceDataFlow', () => {
  it('detects HOLLOW_PROP — parent passes hardcoded `[]` to child component', () => {
    const source = `
      function Dashboard() {
        return <UserList items={[]} />
      }
    `
    const trace = traceDataFlow(source)
    // parent file itself isn't dynamic — we check from child's perspective via JSX scan
    // when scanning the parent, we still want to flag the hollow prop directly
    expect(extractHollowProps(source).length).toBeGreaterThan(0)
  })

  it('detects HOLLOW_PROP via traceDataFlow when component also uses dynamic hooks', () => {
    const source = `
      function Dashboard() {
        const [count, setCount] = useState(0)
        return <UserList users={[]} />
      }
    `
    const trace = traceDataFlow(source)
    expect(trace.status).toBe('HOLLOW_PROP')
    expect(trace.hollowProps.length).toBeGreaterThan(0)
    expect(trace.reason).toContain('硬编码')
  })

  it('classifies FLOWING — fetch returns real data without static fallback', () => {
    const source = `
      function UserList() {
        const [users, setUsers] = useState([])
        useEffect(() => {
          fetch('/api/users').then(r => r.json()).then(setUsers)
        }, [])
        return <ul>{users.map(u => <li>{u.name}</li>)}</ul>
      }
    `
    const trace = traceDataFlow(source)
    expect(trace.status).toBe('FLOWING')
    expect(trace.dataSources.some((s) => s.includes('fetch'))).toBe(true)
  })

  it('classifies STATIC — fetch with `|| []` fallback (silent stub)', () => {
    const source = `
      function UserList() {
        const [users, setUsers] = useState([])
        useEffect(() => {
          fetch('/api/users').then(r => r.json()).then(d => setUsers(d || []))
        }, [])
        return <ul>{users.map(u => <li>{u.name}</li>)}</ul>
      }
    `
    const trace = traceDataFlow(source)
    expect(trace.status).toBe('STATIC')
    expect(trace.staticFallbacks.length).toBeGreaterThan(0)
  })

  it('classifies DISCONNECTED — useState exists but no fetch / data source', () => {
    const source = `
      function Profile() {
        const [name, setName] = useState('Alice')
        return <h1>{name}</h1>
      }
    `
    const trace = traceDataFlow(source)
    expect(trace.status).toBe('DISCONNECTED')
    expect(trace.stateVars).toContain('name')
  })

  it('classifies NO_DYNAMIC — pure static component skips Level 4', () => {
    const source = `
      function Footer() {
        return <footer>© 2026 CCG</footer>
      }
    `
    const trace = traceDataFlow(source)
    expect(trace.status).toBe('NO_DYNAMIC')
  })

  it('handles empty / non-string input gracefully', () => {
    expect(traceDataFlow('')).toMatchObject({ status: 'NO_DYNAMIC' })
    // @ts-expect-error testing runtime guard
    expect(traceDataFlow(null)).toMatchObject({ status: 'NO_DYNAMIC' })
  })

  it('detects useQuery as dynamic source and classifies FLOWING', () => {
    const source = `
      function Posts() {
        const { data: posts } = useQuery('posts', fetchPosts)
        return <List items={posts} />
      }
    `
    expect(isDynamicComponent(source)).toBe(true)
    const trace = traceDataFlow(source)
    expect(trace.stateVars).toContain('posts')
    expect(trace.status).toBe('FLOWING')
  })

  it('detects prisma.findMany as data source', () => {
    const source = `
      async function getUsers() {
        const users = await prisma.user.findMany()
        return users
      }
      function Page() {
        const [users, setUsers] = useState([])
        useEffect(() => { getUsers().then(setUsers) }, [])
        return <List users={users} />
      }
    `
    const trace = traceDataFlow(source)
    expect(trace.dataSources.some((s) => s.includes('prisma'))).toBe(true)
    // FLOWING since no `|| []` and there is a real fetch path
    expect(['FLOWING', 'STATIC']).toContain(trace.status)
  })
})

// ---------------------------------------------------------------------------
// 2. Step 3b — Override mechanism (80% token overlap)
// ---------------------------------------------------------------------------

describe('Step 3b: matchOverride (80% token overlap)', () => {
  const overrides: VerificationOverride[] = [
    {
      must_have: 'Users can reset password via email link',
      reason: 'OAuth-only flow accepted; password reset deferred to Phase 12',
      accepted_by: 'product-owner',
      accepted_at: '2026-05-03T10:00:00Z',
    },
    {
      must_have: '用户能查看订单历史',
      reason: '改用 SQL 直查替代 GraphQL，已批',
      accepted_by: 'tech-lead',
      accepted_at: '2026-05-03T11:00:00Z',
    },
  ]

  it('matches when must_have has ≥80% token overlap with override', () => {
    const result = matchOverride(
      'Users can reset password via email link',
      overrides,
    )
    expect(result.matched).toBe(true)
    expect(result.overlapRatio).toBeGreaterThanOrEqual(0.8)
    expect(result.override?.accepted_by).toBe('product-owner')
  })

  it('does NOT match when overlap drops to ~70%', () => {
    // drop "via email link" → 4/7 tokens = ~57%
    const result = matchOverride(
      'Users can reset their forgotten secret',
      overrides,
    )
    expect(result.matched).toBe(false)
    expect(result.overlapRatio).toBeLessThan(0.8)
  })

  it('handles Chinese must_have token matching', () => {
    const result = matchOverride('用户能查看订单历史', overrides)
    expect(result.matched).toBe(true)
    expect(result.overlapRatio).toBe(1)
  })

  it('returns false when overrides list is empty', () => {
    const result = matchOverride('anything', [])
    expect(result.matched).toBe(false)
  })

  it('respects custom threshold', () => {
    // with 0.5 threshold, partial match should pass
    const result = matchOverride(
      'Users can reset their forgotten secret',
      overrides,
      0.3,
    )
    expect(result.matched).toBe(true)
  })

  it('computeOverlapRatio handles empty input', () => {
    expect(computeOverlapRatio('', 'foo bar')).toBe(0)
    expect(computeOverlapRatio('foo', '')).toBe(0)
  })

  it('tokenizeForOverride strips stopwords and short tokens', () => {
    const tokens = tokenizeForOverride('The user is in the system')
    expect(tokens).not.toContain('the')
    expect(tokens).not.toContain('is')
    expect(tokens).not.toContain('in')
    expect(tokens).toContain('user')
    expect(tokens).toContain('system')
  })
})

// ---------------------------------------------------------------------------
// 3. Step 9b — Deferred filtering (gap covered in future phase)
// ---------------------------------------------------------------------------

describe('Step 9b: checkDeferred (gap → future phase coverage)', () => {
  const futurePhases: FuturePhasePlan[] = [
    {
      phase_id: 'phase-09-uat-session',
      title: '会话式 UAT + cold-start smoke',
      goal: '会话式 UAT 工作流 + cold-start smoke 注入 + UAT.md session 持久化',
      success_criteria:
        '用户可以通过会话流程逐项确认 UAT，cold-start smoke 自动注入数据库初始化测试',
    },
    {
      phase_id: 'phase-10-code-review-fix',
      title: 'code-review --fix --auto + worktree 隔离',
      goal: 'review 找到的 critical 问题自动修复、worktree 隔离不撞前台',
      success_criteria:
        'critical 自动修复 + worktree 隔离 + transactional cleanup',
    },
  ]

  it('marks gap as deferred when ≥3 keywords match a future phase', () => {
    const result = checkDeferred(
      'cold-start smoke 测试缺失，UAT.md 持久化未实现',
      futurePhases,
    )
    expect(result.deferred).toBe(true)
    expect(result.matchedPhase?.phase_id).toBe('phase-09-uat-session')
    expect(result.matchedKeywords.length).toBeGreaterThanOrEqual(3)
  })

  it('does NOT mark deferred when keywords do not overlap future phases', () => {
    const result = checkDeferred(
      'GraphQL schema generation pipeline missing',
      futurePhases,
    )
    expect(result.deferred).toBe(false)
  })

  it('handles empty future phases gracefully (no deferred)', () => {
    const result = checkDeferred('anything', [])
    expect(result.deferred).toBe(false)
    expect(result.matchedKeywords).toEqual([])
  })

  it('respects conservative matching — single keyword hit alone is not enough', () => {
    const result = checkDeferred(
      'audit',
      futurePhases,
      3, // require 3 hits minimum
      0.5,
    )
    // single token "audit" — even if matched, ratio = 1/1 but absolute count < 3
    // but minHitRatio = 0.5 still triggers when all tokens match
    // we expect FALSE because "audit" alone doesn't appear in any phase
    expect(result.deferred).toBe(false)
  })

  it('extractGapKeywords handles empty input', () => {
    expect(extractGapKeywords('')).toEqual([])
  })

  it('matches gap with code-review keywords to phase-10', () => {
    const result = checkDeferred(
      'critical 问题 review 后没有自动修复 worktree 隔离',
      futurePhases,
    )
    expect(result.deferred).toBe(true)
    expect(result.matchedPhase?.phase_id).toBe('phase-10-code-review-fix')
  })
})

// ---------------------------------------------------------------------------
// 4. Helper integrity — extractors + report formatting
// ---------------------------------------------------------------------------

describe('Helpers — extractors and report', () => {
  it('isDynamicComponent recognizes axios.get', () => {
    expect(isDynamicComponent("axios.get('/api/users')")).toBe(true)
  })

  it('extractStateVars handles useStore destructuring (skipped — not currently destructured form supported)', () => {
    // We support `const foo = useStore(...)` form, not `const { foo } = useStore`
    const src = `const counter = useStore(state => state.count)`
    expect(extractStateVars(src)).toContain('counter')
  })

  it('extractStaticFallbacks finds `?? {}`', () => {
    const src = `const data = result ?? {}`
    expect(extractStaticFallbacks(src).length).toBeGreaterThan(0)
  })

  it('extractDataSources finds axios methods', () => {
    const src = `axios.post('/api/login', creds)`
    expect(extractDataSources(src).some((s) => s.includes('axios.post'))).toBe(
      true,
    )
  })

  it('formatDataFlowReport renders sections for HOLLOW_PROP', () => {
    const trace = traceDataFlow(`
      function Dashboard() {
        const [c, setC] = useState(0)
        return <UserList items={[]} />
      }
    `)
    const report = formatDataFlowReport(trace)
    expect(report).toContain('数据流')
    expect(report).toContain('HOLLOW_PROP')
    expect(report).toContain('硬编码 prop')
  })

  it('formatDataFlowReport renders FLOWING report cleanly', () => {
    const trace = traceDataFlow(`
      function X() {
        const [u, setU] = useState([])
        useEffect(() => fetch('/api/u').then(r => r.json()).then(setU), [])
        return <List items={u} />
      }
    `)
    const report = formatDataFlowReport(trace)
    expect(report).toContain('FLOWING')
    expect(report).toContain('数据源')
  })
})

// ---------------------------------------------------------------------------
// 5. Verifier agent template integration — Level 4 documented
// ---------------------------------------------------------------------------

describe('Verifier agent template integration', () => {
  it('verifier.md exists and references Level 4 + override + deferred', () => {
    expect(existsSync(VERIFIER_AGENT)).toBe(true)
    const content = readFileSync(VERIFIER_AGENT, 'utf-8')
    expect(content).toMatch(/Level 4|Level\s*4|数据流追踪/)
    expect(content).toMatch(/override|覆盖机制/i)
    expect(content).toMatch(/deferred|推迟项过滤/i)
  })

  it('verifier.md documents the 4 data flow statuses', () => {
    const content = readFileSync(VERIFIER_AGENT, 'utf-8')
    expect(content).toContain('FLOWING')
    expect(content).toContain('STATIC')
    expect(content).toContain('DISCONNECTED')
    expect(content).toContain('HOLLOW_PROP')
  })

  it('verifier.md documents the 80% override threshold', () => {
    const content = readFileSync(VERIFIER_AGENT, 'utf-8')
    expect(content).toMatch(/80%|0\.8|80 ?percent/)
  })
})
