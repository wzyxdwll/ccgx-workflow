import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  debateStateMachine,
  parseRoundSummary,
  shouldStop,
  validateRetryProtocol,
  REQUIRED_RETRY_ATTEMPTS,
  type DebateLayer,
  type RoundSummary,
} from '../debate-orchestrator'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const DEBATE_TEMPLATE = resolve(REPO_ROOT, 'templates', 'commands', 'debate.md')

// Fixtures-driven (CCG v4.3 P28): real subagent round summaries
const FIXTURES_PATH = resolve(REPO_ROOT, 'tests', 'fixtures', 'ground-truth', 'agent-summaries.sample.json')
const AGENT_FIXTURES = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')) as {
  debateRoundSummaries: Record<string, string>
}

// ---------------------------------------------------------------------------
// 1. debateStateMachine — round-by-round plan
// ---------------------------------------------------------------------------
describe('debateStateMachine — round plan generator', () => {
  it('returns 3 rounds by default (propose → challenge → respond)', () => {
    const plan = debateStateMachine('topic', { layer: 'backend' })
    expect(plan.length).toBe(3)
    expect(plan[0].kind).toBe('propose')
    expect(plan[1].kind).toBe('challenge')
    expect(plan[2].kind).toBe('respond')
  })

  it('backend layer: codex propose / gemini challenge / codex respond', () => {
    const plan = debateStateMachine('topic', { layer: 'backend' })
    expect(plan[0].models).toEqual(['codex'])
    expect(plan[0].pluginSubagent).toEqual(['codex:codex-rescue'])
    expect(plan[1].models).toEqual(['gemini'])
    expect(plan[1].pluginSubagent).toEqual(['gemini:gemini-rescue'])
    expect(plan[2].models).toEqual(['codex'])
  })

  it('frontend layer: gemini propose / codex challenge / gemini respond', () => {
    const plan = debateStateMachine('topic', { layer: 'frontend' })
    expect(plan[0].models).toEqual(['gemini'])
    expect(plan[1].models).toEqual(['codex'])
    expect(plan[2].models).toEqual(['gemini'])
  })

  it('fullstack layer: dual codex+gemini on every round', () => {
    const plan = debateStateMachine('topic', { layer: 'fullstack' })
    for (const round of plan) {
      expect(round.models).toEqual(['codex', 'gemini'])
      expect(round.pluginSubagent).toEqual([
        'codex:codex-rescue',
        'gemini:gemini-rescue',
      ])
    }
  })

  it('challenge round uses reviewer.md (adversarial), propose/respond use architect.md', () => {
    const plan = debateStateMachine('topic', { layer: 'backend' })
    expect(plan[0].ccgPromptFiles[0]).toMatch(/architect\.md$/)
    expect(plan[1].ccgPromptFiles[0]).toMatch(/reviewer\.md$/)
    expect(plan[2].ccgPromptFiles[0]).toMatch(/architect\.md$/)
  })

  it('caps at default 3 rounds when maxRounds omitted', () => {
    expect(debateStateMachine('topic').length).toBe(3)
  })

  it('respects custom maxRounds (1, 2, 5)', () => {
    expect(debateStateMachine('topic', { maxRounds: 1 }).length).toBe(1)
    expect(debateStateMachine('topic', { maxRounds: 2 }).length).toBe(2)
    expect(debateStateMachine('topic', { maxRounds: 5 }).length).toBe(5)
  })

  it('clamps maxRounds to hard upper bound (10)', () => {
    const plan = debateStateMachine('topic', { maxRounds: 999 })
    expect(plan.length).toBe(10)
  })

  it('clamps maxRounds to >= 1 for nonsense values', () => {
    expect(debateStateMachine('topic', { maxRounds: 0 }).length).toBe(1)
    expect(debateStateMachine('topic', { maxRounds: -5 }).length).toBe(1)
    expect(debateStateMachine('topic', { maxRounds: NaN }).length).toBe(1)
  })

  it('throws on empty / non-string topic', () => {
    expect(() => debateStateMachine('')).toThrow(/topic/)
    expect(() => debateStateMachine('   ')).toThrow(/topic/)
    // @ts-expect-error testing runtime guard
    expect(() => debateStateMachine(undefined)).toThrow(/topic/)
  })

  it('throws on invalid layer', () => {
    // @ts-expect-error testing runtime guard
    expect(() => debateStateMachine('topic', { layer: 'mobile' })).toThrow(/layer/)
  })
})

// ---------------------------------------------------------------------------
// 2. Plugin fallback — plugin 缺失降级到 general-purpose
// ---------------------------------------------------------------------------
describe('debateStateMachine — plugin fallback', () => {
  it('codex plugin missing: backend round 1 falls back to general-purpose', () => {
    const plan = debateStateMachine('topic', {
      layer: 'backend',
      pluginsAvailable: { codex: false, gemini: true },
    })
    expect(plan[0].models).toEqual(['general-purpose'])
    expect(plan[0].pluginSubagent).toEqual([null])
    expect(plan[0].fallback).toBe('plugin-missing')
    // ccgPromptFiles 仍指向原本的 codex/architect.md（让主线内嵌该 prompt 模板）
    expect(plan[0].ccgPromptFiles[0]).toMatch(/codex\/architect\.md$/)
  })

  it('gemini plugin missing: frontend round 1 falls back to general-purpose', () => {
    const plan = debateStateMachine('topic', {
      layer: 'frontend',
      pluginsAvailable: { codex: true, gemini: false },
    })
    expect(plan[0].models).toEqual(['general-purpose'])
    expect(plan[0].fallback).toBe('plugin-missing')
    expect(plan[0].ccgPromptFiles[0]).toMatch(/gemini\/architect\.md$/)
  })

  it('both plugins missing: every round falls back to general-purpose', () => {
    const plan = debateStateMachine('topic', {
      layer: 'fullstack',
      pluginsAvailable: { codex: false, gemini: false },
    })
    for (const r of plan) {
      expect(r.models).toEqual(['general-purpose', 'general-purpose'])
      expect(r.pluginSubagent).toEqual([null, null])
      expect(r.fallback).toBe('plugin-missing')
    }
  })

  it('plugins all available by default: no fallback flagged', () => {
    const plan = debateStateMachine('topic', { layer: 'backend' })
    for (const r of plan) {
      expect(r.fallback).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. parseRoundSummary — 容错抽字段
// ---------------------------------------------------------------------------
describe('parseRoundSummary — tolerant field extractor', () => {
  it('returns parsed=false for empty / non-string input', () => {
    expect(parseRoundSummary('').parsed).toBe(false)
    expect(parseRoundSummary('   ').parsed).toBe(false)
    // @ts-expect-error runtime guard
    expect(parseRoundSummary(undefined).parsed).toBe(false)
  })

  it('extracts PROPOSE / NOTES fields', () => {
    const s = parseRoundSummary([
      'STATUS: completed',
      'PROPOSE: use Redis cache layer',
      'NOTES: 2-tier cache, TTL=300s',
    ].join('\n'))
    expect(s.parsed).toBe(true)
    expect(s.propose).toBe('use Redis cache layer')
    expect(s.notes).toBe('2-tier cache, TTL=300s')
  })

  it('extracts CHALLENGE field independently', () => {
    const s = parseRoundSummary('CHALLENGE: Redis bottleneck on writes')
    expect(s.challenge).toBe('Redis bottleneck on writes')
    expect(s.parsed).toBe(true)
  })

  it('extracts RESPOND field', () => {
    const s = parseRoundSummary('RESPOND: switch to write-through cache')
    expect(s.respond).toBe('switch to write-through cache')
  })

  it('case-insensitive + Chinese colon support', () => {
    const s = parseRoundSummary([
      'propose：用 Redis',
      '提议: alternative design',  // first match wins
      'NOTES: ok',
    ].join('\n'))
    expect(s.propose).toBe('用 Redis')
  })

  it('missing fields → no throw, parsed=false if nothing found', () => {
    const s = parseRoundSummary('garbage text without any field markers')
    expect(s.parsed).toBe(false)
    expect(s.propose).toBeUndefined()
    expect(s.challenge).toBeUndefined()
    expect(s.respond).toBeUndefined()
  })

  it('always records text length for shouldStop', () => {
    const s = parseRoundSummary('STATUS: ok\nPROPOSE: x')
    expect(s.length).toBeGreaterThan(0)
  })

  it('partial parse: only PROPOSE present is still parsed=true', () => {
    const s = parseRoundSummary('PROPOSE: just one field')
    expect(s.parsed).toBe(true)
    expect(s.propose).toBe('just one field')
    expect(s.challenge).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 4. shouldStop — 双信号收敛判定
// ---------------------------------------------------------------------------
describe('shouldStop — convergence signals', () => {
  const summary = (overrides: Partial<RoundSummary> = {}): RoundSummary => ({
    length: 100,
    parsed: true,
    ...overrides,
  })

  it('returns false on empty rounds', () => {
    expect(shouldStop([], 3)).toBe(false)
  })

  it('signal #1: challenger NOTES says "no critical" → stop immediately', () => {
    const rounds = [
      summary({ propose: 'plan A' }),
      summary({ challenge: 'Q', notes: 'no critical issue' }),
    ]
    expect(shouldStop(rounds, 3)).toBe(true)
  })

  it('signal #1 (Chinese): "无 critical" → stop', () => {
    const rounds = [
      summary({ propose: 'plan A' }),
      summary({ challenge: 'Q', notes: '无 critical 问题，达成共识' }),
    ]
    expect(shouldStop(rounds, 3)).toBe(true)
  })

  it('signal #1 in CHALLENGE field directly', () => {
    const rounds = [
      summary({ propose: 'plan A' }),
      summary({ challenge: 'Agreement reached on Redis approach' }),
    ]
    expect(shouldStop(rounds, 3)).toBe(true)
  })

  it('signal #2: hits maxRounds cap → stop', () => {
    const rounds = [
      summary({ propose: 'a' }),
      summary({ challenge: 'b' }),
      summary({ respond: 'c' }),
    ]
    expect(shouldStop(rounds, 3)).toBe(true)
  })

  it('signal #2: not yet at cap → continue', () => {
    const rounds = [summary({ propose: 'a' })]
    expect(shouldStop(rounds, 3)).toBe(false)
  })

  it('signal #3: adjacent length delta < 20% → stop', () => {
    const rounds = [
      summary({ propose: 'a', length: 1000 }),
      summary({ challenge: 'b', length: 1100 }),  // +10%
    ]
    expect(shouldStop(rounds, 5)).toBe(true)  // cap=5 doesn't fire
  })

  it('signal #3: large length jump (>=20%) → continue', () => {
    const rounds = [
      summary({ propose: 'a', length: 100 }),
      summary({ challenge: 'b', length: 500 }),  // +400%
    ]
    expect(shouldStop(rounds, 5)).toBe(false)
  })

  it('signal #3 disabled when length=0 (avoid div-by-zero false positive)', () => {
    const rounds = [
      summary({ length: 0 }),
      summary({ length: 100 }),
    ]
    expect(shouldStop(rounds, 5)).toBe(false)
  })

  it('multiple signals: first match wins (no critical even at round 1)', () => {
    const rounds = [
      summary({ propose: 'plan A', notes: 'lgtm' }),
    ]
    // Note: signal #1 checks notes/challenge of any round including propose-side notes
    expect(shouldStop(rounds, 3)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. Layer interaction (acceptance d4: fullstack double propose)
// ---------------------------------------------------------------------------
describe('layer × round interaction', () => {
  const layers: DebateLayer[] = ['backend', 'frontend', 'fullstack']
  it('every layer produces non-empty plans of length 3 by default', () => {
    for (const layer of layers) {
      const plan = debateStateMachine('topic', { layer })
      expect(plan.length).toBe(3)
      for (const round of plan) {
        expect(round.models.length).toBeGreaterThan(0)
        expect(round.pluginSubagent.length).toBe(round.models.length)
        expect(round.ccgPromptFiles.length).toBe(round.models.length)
      }
    }
  })

  it('fullstack propose round spawns BOTH codex and gemini in parallel', () => {
    const plan = debateStateMachine('topic', { layer: 'fullstack', maxRounds: 1 })
    expect(plan[0].kind).toBe('propose')
    expect(plan[0].models).toEqual(['codex', 'gemini'])
    // CCG prompt files mirror models in order
    expect(plan[0].ccgPromptFiles[0]).toMatch(/codex\/architect\.md$/)
    expect(plan[0].ccgPromptFiles[1]).toMatch(/gemini\/architect\.md$/)
  })
})

// ---------------------------------------------------------------------------
// 6. Command template existence & shape (acceptance a)
// ---------------------------------------------------------------------------
describe('templates/commands/debate.md', () => {
  it('exists', () => {
    expect(existsSync(DEBATE_TEMPLATE)).toBe(true)
  })

  it('contains YAML frontmatter with description', () => {
    const content = readFileSync(DEBATE_TEMPLATE, 'utf8')
    expect(content).toMatch(/^---\n[\s\S]*?description:[\s\S]*?\n---/)
  })

  it('documents --max-rounds and --layer flags', () => {
    const content = readFileSync(DEBATE_TEMPLATE, 'utf8')
    expect(content).toMatch(/--max-rounds/)
    expect(content).toMatch(/--layer/)
  })

  it('mentions propose / challenge / respond round kinds', () => {
    const content = readFileSync(DEBATE_TEMPLATE, 'utf8')
    expect(content).toMatch(/propose/i)
    expect(content).toMatch(/challenge/i)
    expect(content).toMatch(/respond/i)
  })

  it('mentions both codex:codex-rescue and gemini:gemini-rescue plugin spawn', () => {
    const content = readFileSync(DEBATE_TEMPLATE, 'utf8')
    expect(content).toMatch(/codex:codex-rescue/)
    expect(content).toMatch(/gemini:gemini-rescue/)
  })

  it('mentions general-purpose fallback path', () => {
    const content = readFileSync(DEBATE_TEMPLATE, 'utf8')
    expect(content).toMatch(/general-purpose/)
  })

  it('mentions debate-orchestrator helper or shouldStop convergence', () => {
    const content = readFileSync(DEBATE_TEMPLATE, 'utf8')
    expect(content).toMatch(/debate-orchestrator|debateStateMachine|shouldStop/)
  })
})

// ---------------------------------------------------------------------------
// 7. Fixtures-driven tests (CCG v4.3 P28)
//
// Replace inline propose/challenge/respond mock strings with real-shaped
// fixtures from agent-summaries.sample.json. Catches schema drift between
// what subagents actually return and what parser expects.
// ---------------------------------------------------------------------------

describe('parseRoundSummary — fixtures-driven (P28)', () => {
  it('parses fixture: propose_round → propose field extracted', () => {
    const s = parseRoundSummary(AGENT_FIXTURES.debateRoundSummaries.propose_round)
    expect(s.parsed).toBe(true)
    expect(s.propose).toBeDefined()
    expect(s.propose).toMatch(/Redis/)
    expect(s.notes).toBeDefined()
  })

  it('parses fixture: challenge_round → challenge field extracted', () => {
    const s = parseRoundSummary(AGENT_FIXTURES.debateRoundSummaries.challenge_round)
    expect(s.parsed).toBe(true)
    expect(s.challenge).toBeDefined()
    expect(s.challenge).toMatch(/bottleneck|write/i)
  })

  it('parses fixture: respond_round → respond field extracted', () => {
    const s = parseRoundSummary(AGENT_FIXTURES.debateRoundSummaries.respond_round)
    expect(s.parsed).toBe(true)
    expect(s.respond).toBeDefined()
    expect(s.respond).toMatch(/write-back|cache/i)
  })

  it('parses fixture: convergence_signal → notes flag stop semantics', () => {
    const s = parseRoundSummary(AGENT_FIXTURES.debateRoundSummaries.convergence_signal)
    expect(s.parsed).toBe(true)
    // Either CHALLENGE or NOTES carries the agreement signal
    const allText = `${s.challenge ?? ''}${s.notes ?? ''}`
    expect(allText).toMatch(/Agreement|consensus|no.*new/i)
  })

  it('shouldStop fires on fixture-derived convergence_signal at round 2', () => {
    const r1 = parseRoundSummary(AGENT_FIXTURES.debateRoundSummaries.propose_round)
    const r2 = parseRoundSummary(AGENT_FIXTURES.debateRoundSummaries.convergence_signal)
    expect(shouldStop([r1, r2], 5)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 6. v4.4.3 degraded marker extraction (parseRoundSummary)
// ---------------------------------------------------------------------------

describe('parseRoundSummary — degraded marker extraction (v4.4.3)', () => {
  it('extracts canonical "plugin spawn failed after N attempts, degraded: <reason>"', () => {
    const text = `STATUS: completed
PROPOSE: fallback content
NOTES: plugin spawn failed after 3 attempts, degraded: broker timeout`
    const s = parseRoundSummary(text)
    expect(s.degraded).toBeDefined()
    expect(s.degraded!.attempts).toBe(3)
    expect(s.degraded!.reason).toBe('broker timeout')
  })

  it('extracts retry count from canonical form even when reason omitted', () => {
    const text = `NOTES: plugin spawn failed after 3 attempts, degraded`
    const s = parseRoundSummary(text)
    expect(s.degraded).toBeDefined()
    expect(s.degraded!.attempts).toBe(3)
    expect(s.degraded!.reason).toBe('plugin spawn failed')
  })

  it('extracts "degraded after N attempts: reason" alternate form', () => {
    const text = `NOTES: degraded after 5 attempts: API quota exhausted`
    const s = parseRoundSummary(text)
    expect(s.degraded).toBeDefined()
    expect(s.degraded!.attempts).toBe(5)
    expect(s.degraded!.reason).toBe('API quota exhausted')
  })

  it('extracts minimal "degraded: reason" form (attempts defaults to 1)', () => {
    const text = `NOTES: degraded: parse-failed`
    const s = parseRoundSummary(text)
    expect(s.degraded).toBeDefined()
    expect(s.degraded!.attempts).toBe(1)
    expect(s.degraded!.reason).toBe('parse-failed')
  })

  it('extracts bare "degraded" with no reason as placeholder (attempts=1)', () => {
    const text = `STATUS: completed
PROPOSE: x
NOTES: something happened, degraded`
    const s = parseRoundSummary(text)
    expect(s.degraded).toBeDefined()
    expect(s.degraded!.attempts).toBe(1)
    // 该位置的 reason 由正则贪婪匹配后续文本，但本例 NOTES 行尾即结束
  })

  it('returns undefined degraded when text contains no marker', () => {
    const text = `STATUS: completed
PROPOSE: clean run
NOTES: no issue, agreement reached`
    const s = parseRoundSummary(text)
    expect(s.degraded).toBeUndefined()
  })

  it('clean propose without degraded does NOT spuriously match', () => {
    const text = `STATUS: completed
PROPOSE: my plan is to refactor X
NOTES: 2 risks predicted`
    const s = parseRoundSummary(text)
    expect(s.degraded).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 7. v4.4.3 validateRetryProtocol — schema-level hard constraint
// ---------------------------------------------------------------------------

describe('validateRetryProtocol — retry protocol enforcement (v4.4.3)', () => {
  it('exposes REQUIRED_RETRY_ATTEMPTS = 3 (synced with debate.md doc)', () => {
    expect(REQUIRED_RETRY_ATTEMPTS).toBe(3)
  })

  it('compliant: round with full content + no degraded passes', () => {
    const round: RoundSummary = {
      propose: 'design X',
      notes: 'good',
      length: 50,
      parsed: true,
    }
    const r = validateRetryProtocol([round])
    expect(r.compliant).toBe(true)
    expect(r.violations).toEqual([])
  })

  it('compliant: round with attempts=3 + concrete reason passes', () => {
    const round: RoundSummary = {
      propose: 'fallback content',
      notes: 'plugin spawn failed after 3 attempts, degraded: broker timeout',
      length: 80,
      parsed: true,
      degraded: { attempts: 3, reason: 'broker timeout' },
    }
    const r = validateRetryProtocol([round])
    expect(r.compliant).toBe(true)
  })

  it('compliant: empty array (no rounds yet)', () => {
    expect(validateRetryProtocol([]).compliant).toBe(true)
  })

  it('compliant: not-an-array input falls back to compliant (no throw)', () => {
    // @ts-expect-error intentional bad input
    const r = validateRetryProtocol(null)
    expect(r.compliant).toBe(true)
  })

  it('violation V1: parsed=false + no degraded → parse-failed-no-degraded', () => {
    const round: RoundSummary = { length: 0, parsed: false }
    const r = validateRetryProtocol([round])
    expect(r.compliant).toBe(false)
    expect(r.violations).toHaveLength(1)
    expect(r.violations[0].kind).toBe('parse-failed-no-degraded')
    expect(r.violations[0].round).toBe(1)
    expect(r.violations[0].message).toMatch(/parse/i)
  })

  it('violation V2: insufficient attempts (1 < 3) → insufficient-attempts', () => {
    const round: RoundSummary = {
      propose: 'soft fallback',
      length: 30,
      parsed: true,
      degraded: { attempts: 1, reason: 'broker timeout' },
    }
    const r = validateRetryProtocol([round])
    expect(r.compliant).toBe(false)
    expect(r.violations[0].kind).toBe('insufficient-attempts')
    expect(r.violations[0].message).toMatch(/3/)
  })

  it('violation V3: attempts=2 still violates 3-attempt floor', () => {
    const round: RoundSummary = {
      propose: 'partial',
      length: 30,
      parsed: true,
      degraded: { attempts: 2, reason: 'API quota' },
    }
    const r = validateRetryProtocol([round])
    expect(r.violations[0].kind).toBe('insufficient-attempts')
  })

  it('violation V4: missing-reason (placeholder text)', () => {
    const round: RoundSummary = {
      propose: 'fallback',
      length: 30,
      parsed: true,
      degraded: { attempts: 3, reason: 'unknown' },
    }
    const r = validateRetryProtocol([round])
    expect(r.violations.some(v => v.kind === 'missing-reason')).toBe(true)
  })

  it('violation V5: empty reason string treated as placeholder', () => {
    const round: RoundSummary = {
      propose: 'fallback',
      length: 30,
      parsed: true,
      degraded: { attempts: 3, reason: '' },
    }
    const r = validateRetryProtocol([round])
    expect(r.violations.some(v => v.kind === 'missing-reason')).toBe(true)
  })

  it('violation V6: "degraded (no reason given)" placeholder caught', () => {
    const round: RoundSummary = {
      propose: 'x',
      length: 10,
      parsed: true,
      degraded: { attempts: 3, reason: 'degraded (no reason given)' },
    }
    const r = validateRetryProtocol([round])
    expect(r.violations.some(v => v.kind === 'missing-reason')).toBe(true)
  })

  it('compound violation: insufficient attempts AND missing reason both fire', () => {
    const round: RoundSummary = {
      propose: 'x',
      length: 10,
      parsed: true,
      degraded: { attempts: 1, reason: 'unknown' },
    }
    const r = validateRetryProtocol([round])
    expect(r.violations.length).toBeGreaterThanOrEqual(2)
    const kinds = r.violations.map(v => v.kind).sort()
    expect(kinds).toContain('insufficient-attempts')
    expect(kinds).toContain('missing-reason')
  })

  it('multi-round: violations track 1-indexed round numbers', () => {
    const rounds: RoundSummary[] = [
      { propose: 'r1 ok', length: 30, parsed: true },
      { propose: 'r2 partial', length: 30, parsed: true, degraded: { attempts: 1, reason: 'broker' } },
      { length: 0, parsed: false },
    ]
    const r = validateRetryProtocol(rounds)
    expect(r.compliant).toBe(false)
    const r2v = r.violations.find(v => v.round === 2)
    const r3v = r.violations.find(v => v.round === 3)
    expect(r2v?.kind).toBe('insufficient-attempts')
    expect(r3v?.kind).toBe('parse-failed-no-degraded')
  })

  it('regression: the v4.4.2 main-thread "single-fallback acceptance" bug now hard-fails', () => {
    // 复现实测违规：主线 R1 一次 fallback 接受未重试也未标 degraded
    // 表现为 RoundSummary 缺 propose 但 parsed=false 且无 degraded
    const offending: RoundSummary = { length: 0, parsed: false }
    const r = validateRetryProtocol([offending])
    expect(r.compliant).toBe(false)
    expect(r.violations[0].kind).toBe('parse-failed-no-degraded')
  })

  it('parseRoundSummary + validateRetryProtocol pipeline: insufficient attempts caught end-to-end', () => {
    // 模拟主线偷懒只标 1 次 attempt 的违规摘要
    const text = `STATUS: completed
PROPOSE: rushed fallback
NOTES: degraded after 1 attempts: gave up early`
    const parsed = parseRoundSummary(text)
    expect(parsed.degraded?.attempts).toBe(1)
    const r = validateRetryProtocol([parsed])
    expect(r.compliant).toBe(false)
    expect(r.violations.some(v => v.kind === 'insufficient-attempts')).toBe(true)
  })
})
