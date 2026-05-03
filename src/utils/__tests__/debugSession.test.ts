import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  countRefuted,
  decideSessionOutcome,
  DEBUG_SESSION_DIR,
  findConfirmed,
  formatManagerSummary,
  HYPOTHESIS_FAILURE_CAP,
  makeHypothesis,
  resolveDebugSessionPath,
  resolveHypothesis,
  serializeSession,
  type DebugSession,
} from '../debug-session'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const DEBUG_TEMPLATE = resolve(REPO_ROOT, 'templates', 'commands', 'debug.md')
const DEBUG_MANAGER_TEMPLATE = resolve(
  REPO_ROOT,
  'templates',
  'commands',
  'agents',
  'debug-session-manager.md',
)
const DEBUGGER_TEMPLATE = resolve(
  REPO_ROOT,
  'templates',
  'commands',
  'agents',
  'debugger.md',
)

// ---------------------------------------------------------------------------
// Test 1: hypothesis falsifiability hard constraint (科学方法守门员)
// ---------------------------------------------------------------------------
describe('makeHypothesis (科学方法约束)', () => {
  it('builds an open hypothesis with description + falsifiable_test', () => {
    const h = makeHypothesis({
      description: 'useState double-init in strict mode',
      falsifiable_test: 'pnpm test foo.test.ts -t "double init"',
    })
    expect(h.description).toBe('useState double-init in strict mode')
    expect(h.falsifiable_test).toBe('pnpm test foo.test.ts -t "double init"')
    expect(h.status).toBe('open')
    expect(h.evidence).toBe('')
  })

  it('throws when falsifiable_test is missing (empty string)', () => {
    expect(() =>
      makeHypothesis({
        description: 'something might be wrong',
        falsifiable_test: '',
      }),
    ).toThrow(/falsifiable/)
  })

  it('throws when falsifiable_test is only whitespace', () => {
    expect(() =>
      makeHypothesis({
        description: 'something might be wrong',
        falsifiable_test: '   \n  \t  ',
      }),
    ).toThrow(/falsifiable/)
  })

  it('throws when description is empty', () => {
    expect(() =>
      makeHypothesis({
        description: '',
        falsifiable_test: 'pnpm test',
      }),
    ).toThrow(/description/)
  })

  it('rejects "代码可能有 bug" 类无法证伪的空话——通过强制 falsifiable_test 实现', () => {
    // 这里测的不是 description 内容（LLM 才能判定语义），而是结构性约束：
    // 缺 falsifiable_test 必抛错 → LLM 被迫给出可观察的 fail 条件
    expect(() =>
      // @ts-expect-error 故意缺字段
      makeHypothesis({ description: '代码可能有 bug' }),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Test 2: resolve hypothesis（confirmed/refuted 状态机）
// ---------------------------------------------------------------------------
describe('resolveHypothesis (状态机)', () => {
  it('resolves open → confirmed with evidence', () => {
    const h = makeHypothesis({
      description: 'A',
      falsifiable_test: 'cmd',
    })
    const r = resolveHypothesis(h, 'confirmed', 'output: matches expected pattern')
    expect(r.status).toBe('confirmed')
    expect(r.evidence).toContain('matches expected pattern')
  })

  it('resolves open → refuted with evidence', () => {
    const h = makeHypothesis({ description: 'A', falsifiable_test: 'cmd' })
    const r = resolveHypothesis(h, 'refuted', 'output: counterexample observed')
    expect(r.status).toBe('refuted')
    expect(r.evidence).toContain('counterexample')
  })

  it('throws when re-resolving an already-resolved hypothesis', () => {
    const h = makeHypothesis({ description: 'A', falsifiable_test: 'cmd' })
    const r = resolveHypothesis(h, 'confirmed', 'evidence')
    expect(() => resolveHypothesis(r, 'refuted', 'new evidence')).toThrow(
      /already resolved/,
    )
  })

  it('throws when evidence is empty', () => {
    const h = makeHypothesis({ description: 'A', falsifiable_test: 'cmd' })
    expect(() => resolveHypothesis(h, 'confirmed', '')).toThrow(/evidence/)
  })
})

// ---------------------------------------------------------------------------
// Test 3: 多轮 session 文件累积（hypothesis 1 失败 → hypothesis 2）
// ---------------------------------------------------------------------------
describe('multi-round hypothesis accumulation', () => {
  it('accumulates hypotheses across rounds (H1 refuted → H2 added)', () => {
    const session: DebugSession = {
      slug: 'foo',
      symptoms: 'crash on login',
      hypothesis_chain: [],
      next_action: 'investigate auth flow',
      status: 'investigating',
      mode: 'find_root_cause_only',
    }

    // Round 1: add + refute H1
    const h1 = makeHypothesis({
      description: 'JWT expired',
      falsifiable_test: 'inspect token exp claim',
    })
    session.hypothesis_chain.push(h1)
    expect(countRefuted(session)).toBe(0)

    session.hypothesis_chain[0] = resolveHypothesis(
      session.hypothesis_chain[0],
      'refuted',
      'token exp 1h in future',
    )
    expect(countRefuted(session)).toBe(1)

    // Round 2: add H2 (H1 still in chain, refuted)
    const h2 = makeHypothesis({
      description: 'cookie SameSite blocking POST',
      falsifiable_test: 'curl with SameSite=None',
    })
    session.hypothesis_chain.push(h2)
    expect(session.hypothesis_chain.length).toBe(2)
    expect(session.hypothesis_chain[0].status).toBe('refuted')
    expect(session.hypothesis_chain[1].status).toBe('open')
  })
})

// ---------------------------------------------------------------------------
// Test 4: cap 3 hypothesis 失败 → CHECKPOINT REACHED
// ---------------------------------------------------------------------------
describe('decideSessionOutcome — checkpoint at 3 refutes', () => {
  it('exposes HYPOTHESIS_FAILURE_CAP=3 (CCG hard rule)', () => {
    expect(HYPOTHESIS_FAILURE_CAP).toBe(3)
  })

  it('returns null when fewer than 3 refuted hypotheses', () => {
    const session: DebugSession = {
      slug: 'x',
      symptoms: 'y',
      hypothesis_chain: [
        { description: 'a', falsifiable_test: 't', evidence: 'e', status: 'refuted' },
        { description: 'b', falsifiable_test: 't', evidence: 'e', status: 'refuted' },
      ],
      next_action: 'try H3',
      status: 'investigating',
      mode: 'find_root_cause_only',
    }
    expect(decideSessionOutcome(session)).toBeNull()
  })

  it('returns CHECKPOINT_REACHED when 3 hypotheses refuted', () => {
    const session: DebugSession = {
      slug: 'tricky-bug',
      symptoms: 'y',
      hypothesis_chain: [
        { description: 'a', falsifiable_test: 't', evidence: 'e', status: 'refuted' },
        { description: 'b', falsifiable_test: 't', evidence: 'e', status: 'refuted' },
        { description: 'c', falsifiable_test: 't', evidence: 'e', status: 'refuted' },
      ],
      next_action: 'escalate',
      status: 'investigating',
      mode: 'find_and_fix',
    }
    const result = decideSessionOutcome(session)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('CHECKPOINT_REACHED')
    if (result!.kind === 'CHECKPOINT_REACHED') {
      expect(result!.hypotheses_tried).toBe(3)
      expect(result!.slug).toBe('tricky-bug')
      expect(result!.reason).toMatch(/3|escalat/i)
    }
  })
})

// ---------------------------------------------------------------------------
// Test 5: find_root_cause_only mode 不应用 fix
// ---------------------------------------------------------------------------
describe('decideSessionOutcome — find_root_cause_only mode', () => {
  it('returns ROOT_CAUSE_FOUND immediately when a hypothesis is confirmed (no fix step)', () => {
    const session: DebugSession = {
      slug: 'auth-bug',
      symptoms: 'login fails',
      hypothesis_chain: [
        {
          description: 'cookie SameSite=Strict blocks cross-site POST',
          falsifiable_test: 'curl with SameSite=None',
          evidence:
            'Setting SameSite=None lets the request through.\nSuggested fix: change cookie to SameSite=None; Secure',
          status: 'confirmed',
        },
      ],
      next_action: 'report',
      status: 'root_cause_found',
      mode: 'find_root_cause_only',
    }
    const result = decideSessionOutcome(session)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('ROOT_CAUSE_FOUND')
    if (result!.kind === 'ROOT_CAUSE_FOUND') {
      expect(result!.root_cause).toMatch(/SameSite=Strict/)
      expect(result!.suggested_fix).toMatch(/SameSite=None; Secure/)
    }
  })
})

// ---------------------------------------------------------------------------
// Test 6: find_and_fix mode 应用 fix 后跑测试验证
// ---------------------------------------------------------------------------
describe('decideSessionOutcome — find_and_fix mode', () => {
  it('returns null when root cause found but fix not yet applied/verified', () => {
    const session: DebugSession = {
      slug: 'x',
      symptoms: 'y',
      hypothesis_chain: [
        {
          description: 'root cause X',
          falsifiable_test: 't',
          evidence: 'confirmed',
          status: 'confirmed',
        },
      ],
      next_action: 'apply fix',
      status: 'investigating', // fix 还没跑
      mode: 'find_and_fix',
    }
    expect(decideSessionOutcome(session)).toBeNull()
  })

  it('returns DEBUG_COMPLETE when fix applied + verification passed', () => {
    const session: DebugSession = {
      slug: 'auth-bug',
      symptoms: 'login fails',
      hypothesis_chain: [
        {
          description: 'cookie SameSite blocks POST',
          falsifiable_test: 't',
          evidence: 'confirmed',
          status: 'confirmed',
        },
      ],
      next_action: 'done',
      status: 'root_cause_found',
      mode: 'find_and_fix',
    }
    const result = decideSessionOutcome(session, {
      fix_applied: 'changed cookie SameSite=None; Secure in src/auth.ts',
      verification: 'pnpm test auth.test.ts: 12 passed',
    })
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('DEBUG_COMPLETE')
    if (result!.kind === 'DEBUG_COMPLETE') {
      expect(result!.fix_applied).toMatch(/SameSite=None/)
      expect(result!.verification).toMatch(/12 passed/)
    }
  })

  it('returns null when fix_applied or verification is empty (anti-foot-gun)', () => {
    const session: DebugSession = {
      slug: 'x',
      symptoms: 'y',
      hypothesis_chain: [
        {
          description: 'root',
          falsifiable_test: 't',
          evidence: 'e',
          status: 'confirmed',
        },
      ],
      next_action: '',
      status: 'root_cause_found',
      mode: 'find_and_fix',
    }
    // fix_applied missing
    expect(
      decideSessionOutcome(session, { fix_applied: '', verification: 'tests pass' }),
    ).toBeNull()
    // verification missing
    expect(
      decideSessionOutcome(session, { fix_applied: 'fix X', verification: '' }),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Test 7: session path resolution
// ---------------------------------------------------------------------------
describe('resolveDebugSessionPath', () => {
  it('joins workdir + .context/debug + slug.md', () => {
    const got = resolveDebugSessionPath('/home/u/proj', 'cookie-samesite')
    expect(got).toMatch(/\/home\/u\/proj\/\.context\/debug\/cookie-samesite\.md$/)
  })

  it('throws when slug is empty', () => {
    expect(() => resolveDebugSessionPath('/home/u/proj', '')).toThrow()
  })

  it('exposes DEBUG_SESSION_DIR=.context/debug', () => {
    expect(DEBUG_SESSION_DIR).toBe('.context/debug')
  })
})

// ---------------------------------------------------------------------------
// Test 8: session serialize roundtrip readability
// ---------------------------------------------------------------------------
describe('serializeSession (markdown rendering)', () => {
  it('produces readable markdown with frontmatter + Symptoms + Hypothesis Chain', () => {
    const session: DebugSession = {
      slug: 'foo-bar',
      symptoms: 'crash on login',
      hypothesis_chain: [
        {
          description: 'JWT expired',
          falsifiable_test: 'inspect token exp claim',
          evidence: 'token exp is 1h in future',
          status: 'refuted',
        },
        {
          description: 'cookie blocked',
          falsifiable_test: 'curl with SameSite=None',
          evidence: '',
          status: 'open',
        },
      ],
      next_action: 'try cookie hypothesis',
      status: 'investigating',
      mode: 'find_root_cause_only',
    }
    const md = serializeSession(session)
    expect(md).toMatch(/^---\nslug: foo-bar/m)
    expect(md).toMatch(/mode: find_root_cause_only/)
    expect(md).toMatch(/status: investigating/)
    expect(md).toMatch(/hypotheses_total: 2/)
    expect(md).toMatch(/hypotheses_refuted: 1/)
    expect(md).toMatch(/## Symptoms/)
    expect(md).toMatch(/crash on login/)
    expect(md).toMatch(/## Hypothesis Chain/)
    expect(md).toMatch(/### H1.*REFUTED/)
    expect(md).toMatch(/### H2.*OPEN/)
    expect(md).toMatch(/JWT expired/)
    expect(md).toMatch(/cookie blocked/)
  })

  it('handles empty hypothesis_chain', () => {
    const session: DebugSession = {
      slug: 'x',
      symptoms: '?',
      hypothesis_chain: [],
      next_action: 'gather more info',
      status: 'investigating',
      mode: 'find_root_cause_only',
    }
    const md = serializeSession(session)
    expect(md).toMatch(/no hypotheses yet/)
  })
})

// ---------------------------------------------------------------------------
// Test 9: formatManagerSummary — 三种 kind 都能渲染紧凑摘要
// ---------------------------------------------------------------------------
describe('formatManagerSummary (主线摘要协议)', () => {
  it('renders ROOT_CAUSE_FOUND with key fields', () => {
    const s = formatManagerSummary({
      kind: 'ROOT_CAUSE_FOUND',
      slug: 'auth-bug',
      root_cause: 'cookie SameSite=Strict blocks cross-site POST',
      suggested_fix: 'set SameSite=None; Secure',
    })
    expect(s).toMatch(/^STATUS: ROOT_CAUSE_FOUND/m)
    expect(s).toMatch(/SLUG: auth-bug/)
    expect(s).toMatch(/ROOT_CAUSE: .*SameSite/)
    expect(s).toMatch(/SUGGESTED_FIX: .*SameSite=None/)
  })

  it('renders DEBUG_COMPLETE with fix + verification', () => {
    const s = formatManagerSummary({
      kind: 'DEBUG_COMPLETE',
      slug: 'auth-bug',
      root_cause: 'cookie SameSite blocks POST',
      fix_applied: 'changed src/auth.ts L42',
      verification: 'auth.test.ts 12 passed',
    })
    expect(s).toMatch(/^STATUS: DEBUG_COMPLETE/m)
    expect(s).toMatch(/FIX_APPLIED:.*src\/auth\.ts/)
    expect(s).toMatch(/VERIFICATION:.*12 passed/)
  })

  it('renders CHECKPOINT_REACHED with hypotheses_tried + reason', () => {
    const s = formatManagerSummary({
      kind: 'CHECKPOINT_REACHED',
      slug: 'tricky',
      hypotheses_tried: 3,
      reason: '3 hypotheses refuted without finding root cause',
    })
    expect(s).toMatch(/^STATUS: CHECKPOINT_REACHED/m)
    expect(s).toMatch(/HYPOTHESES_TRIED: 3/)
    expect(s).toMatch(/REASON:.*refuted/)
  })

  it('truncates very long fields to keep summary ≤200 token', () => {
    const longRC = 'x'.repeat(500)
    const s = formatManagerSummary({
      kind: 'ROOT_CAUSE_FOUND',
      slug: 'x',
      root_cause: longRC,
      suggested_fix: 'short',
    })
    expect(s.length).toBeLessThan(800)
    expect(s).toMatch(/\.\.\./)
  })
})

// ---------------------------------------------------------------------------
// Test 10: helper queries countRefuted / findConfirmed
// ---------------------------------------------------------------------------
describe('countRefuted + findConfirmed (查询助手)', () => {
  it('countRefuted counts only refuted entries', () => {
    const session: DebugSession = {
      slug: 'x',
      symptoms: 'y',
      hypothesis_chain: [
        { description: 'a', falsifiable_test: 't', evidence: 'e', status: 'refuted' },
        { description: 'b', falsifiable_test: 't', evidence: '', status: 'open' },
        { description: 'c', falsifiable_test: 't', evidence: 'e', status: 'confirmed' },
        { description: 'd', falsifiable_test: 't', evidence: 'e', status: 'refuted' },
      ],
      next_action: '',
      status: 'investigating',
      mode: 'find_root_cause_only',
    }
    expect(countRefuted(session)).toBe(2)
  })

  it('findConfirmed returns first confirmed, null when none', () => {
    const empty: DebugSession = {
      slug: 'x',
      symptoms: 'y',
      hypothesis_chain: [
        { description: 'a', falsifiable_test: 't', evidence: 'e', status: 'refuted' },
      ],
      next_action: '',
      status: 'investigating',
      mode: 'find_root_cause_only',
    }
    expect(findConfirmed(empty)).toBeNull()

    const withConfirmed: DebugSession = {
      ...empty,
      hypothesis_chain: [
        { description: 'a', falsifiable_test: 't', evidence: 'e', status: 'refuted' },
        { description: 'b', falsifiable_test: 't', evidence: 'e', status: 'confirmed' },
      ],
    }
    const c = findConfirmed(withConfirmed)
    expect(c).not.toBeNull()
    expect(c!.description).toBe('b')
  })
})

// ---------------------------------------------------------------------------
// Test 11: Template files exist + have correct surface (acceptance gate)
// ---------------------------------------------------------------------------
describe('template surface (Phase 11 acceptance)', () => {
  it('templates/commands/debug.md exists and references debug-session-manager', () => {
    expect(existsSync(DEBUG_TEMPLATE)).toBe(true)
    const content = readFileSync(DEBUG_TEMPLATE, 'utf8')
    expect(content).toMatch(/debug-session-manager/i)
  })

  it('debug.md references both modes (find_root_cause_only / find_and_fix)', () => {
    const content = readFileSync(DEBUG_TEMPLATE, 'utf8')
    expect(content).toMatch(/find_root_cause_only/)
    expect(content).toMatch(/find_and_fix/)
  })

  it('debug-session-manager.md exists with proper frontmatter', () => {
    expect(existsSync(DEBUG_MANAGER_TEMPLATE)).toBe(true)
    const content = readFileSync(DEBUG_MANAGER_TEMPLATE, 'utf8')
    expect(content).toMatch(/^---[\s\S]*?name:\s*debug-session-manager[\s\S]*?---/m)
    // manager 必须能 spawn debugger（含 Task 工具）
    expect(content).toMatch(/Task/)
  })

  it('debug-session-manager.md mentions persistent session file path', () => {
    const content = readFileSync(DEBUG_MANAGER_TEMPLATE, 'utf8')
    expect(content).toMatch(/\.context\/debug/)
  })

  it('debug-session-manager.md describes all 3 result kinds', () => {
    const content = readFileSync(DEBUG_MANAGER_TEMPLATE, 'utf8')
    expect(content).toMatch(/ROOT_CAUSE_FOUND|ROOT CAUSE FOUND/)
    expect(content).toMatch(/DEBUG_COMPLETE|DEBUG COMPLETE/)
    expect(content).toMatch(/CHECKPOINT_REACHED|CHECKPOINT REACHED/)
  })

  it('debug-session-manager.md mandates falsifiable hypothesis (科学方法)', () => {
    const content = readFileSync(DEBUG_MANAGER_TEMPLATE, 'utf8')
    expect(content).toMatch(/falsifiable/i)
  })

  it('debug-session-manager.md enforces 3-hypothesis cap', () => {
    const content = readFileSync(DEBUG_MANAGER_TEMPLATE, 'utf8')
    expect(content).toMatch(/3.*(hypothes|假设|cap)|cap.*3|HYPOTHESIS_FAILURE_CAP/i)
  })

  it('debugger.md exists with proper frontmatter', () => {
    expect(existsSync(DEBUGGER_TEMPLATE)).toBe(true)
    const content = readFileSync(DEBUGGER_TEMPLATE, 'utf8')
    expect(content).toMatch(/^---[\s\S]*?name:\s*debugger[\s\S]*?---/m)
  })

  it('debugger.md describes scientific method (hypothesis + falsifiable test)', () => {
    const content = readFileSync(DEBUGGER_TEMPLATE, 'utf8')
    expect(content).toMatch(/hypothes/i)
    expect(content).toMatch(/falsifiable/i)
  })
})
