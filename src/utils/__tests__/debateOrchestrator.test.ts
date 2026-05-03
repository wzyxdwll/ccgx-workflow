import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  debateStateMachine,
  parseRoundSummary,
  shouldStop,
  type DebateLayer,
  type RoundSummary,
} from '../debate-orchestrator'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const DEBATE_TEMPLATE = resolve(REPO_ROOT, 'templates', 'commands', 'debate.md')

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
    expect(plan[0].pluginSubagent).toEqual(['codex:rescue'])
    expect(plan[1].models).toEqual(['gemini'])
    expect(plan[1].pluginSubagent).toEqual(['gemini:rescue'])
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
        'codex:rescue',
        'gemini:rescue',
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

  it('mentions both codex:rescue and gemini:rescue plugin spawn', () => {
    const content = readFileSync(DEBATE_TEMPLATE, 'utf8')
    expect(content).toMatch(/codex:rescue/)
    expect(content).toMatch(/gemini:rescue/)
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
