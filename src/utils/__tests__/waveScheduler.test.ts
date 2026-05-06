import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  batchByMaxConcurrent,
  buildWaves,
  cascadeSkip,
  parseDependsOn,
  parseRoadmap,
  schedule,
  type RoadmapPhase,
} from '../wave-scheduler'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const AUTONOMOUS_TEMPLATE = resolve(REPO_ROOT, 'templates', 'commands', 'autonomous.md')

// ---------------------------------------------------------------------------
// 1. parseDependsOn — robust depends-on token parser
// ---------------------------------------------------------------------------
describe('parseDependsOn', () => {
  it('returns [] for "(none)"', () => {
    expect(parseDependsOn('(none)')).toEqual([])
  })

  it('returns [] for empty string after trim', () => {
    expect(parseDependsOn('   ')).toEqual([])
  })

  it('parses a single integer id', () => {
    expect(parseDependsOn('1')).toEqual(['1'])
  })

  it('parses a comma-separated list', () => {
    expect(parseDependsOn('6, 8')).toEqual(['6', '8'])
  })

  it('expands an integer range "1-11"', () => {
    expect(parseDependsOn('1-11')).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'])
  })

  it('mixes ranges and singletons', () => {
    expect(parseDependsOn('1, 3-5, 8')).toEqual(['1', '3', '4', '5', '8'])
  })

  it('parses fractional phase id (1.5)', () => {
    expect(parseDependsOn('1.5')).toEqual(['1.5'])
  })

  it('strips trailing punctuation and full stops', () => {
    expect(parseDependsOn('1, 2.')).toEqual(['1', '2'])
  })

  it('throws on malformed range (lo > hi)', () => {
    expect(() => parseDependsOn('5-2')).toThrow(/range/)
  })

  it('throws on garbage tokens', () => {
    expect(() => parseDependsOn('something-else')).toThrow(/cannot parse/)
  })
})

// ---------------------------------------------------------------------------
// 2. parseRoadmap — markdown extraction
// ---------------------------------------------------------------------------
describe('parseRoadmap', () => {
  it('extracts a minimal roadmap with one phase', () => {
    const md = `
# Heading

## Phase 1: Hello world (pending)

- **Goal**: foo
- **Depends on**: (none)
`.trim()
    const phases = parseRoadmap(md)
    expect(phases).toHaveLength(1)
    expect(phases[0]).toMatchObject({
      id: '1',
      name: 'Hello world',
      status: 'pending',
      dependsOn: [],
    })
  })

  it('extracts a multi-phase roadmap with deps and ranges', () => {
    const md = `
## Phase 1: Foundation (completed)
- **Depends on**: (none)

## Phase 2: API (in_progress)
- **Depends on**: 1

## Phase 3: UI (pending)
- **Depends on**: 1, 2

## Phase 4: Final (pending)
- **Depends on**: 1-3
`.trim()
    const phases = parseRoadmap(md)
    expect(phases.map(p => p.id)).toEqual(['1', '2', '3', '4'])
    expect(phases[3].dependsOn).toEqual(['1', '2', '3'])
  })

  it('handles fractional phase ids like "1.5"', () => {
    const md = `
## Phase 1: Foo (completed)
- **Depends on**: (none)

## Phase 1.5: Hotfix (completed)
- **Depends on**: 1
`.trim()
    const phases = parseRoadmap(md)
    expect(phases.map(p => p.id)).toEqual(['1', '1.5'])
    expect(phases[1].dependsOn).toEqual(['1'])
  })

  it('throws on duplicate phase declaration', () => {
    const md = `
## Phase 1: A (pending)
- **Depends on**: (none)

## Phase 1: B (pending)
- **Depends on**: (none)
`.trim()
    expect(() => parseRoadmap(md)).toThrow(/duplicate Phase 1/)
  })

  it('throws on illegal status', () => {
    const md = '## Phase 1: A (rotting)\n- **Depends on**: (none)'
    expect(() => parseRoadmap(md)).toThrow(/illegal status/)
  })

  it('treats missing depends-on line as no deps', () => {
    const md = `## Phase 1: A (pending)\n\nSome text without depends.`
    const phases = parseRoadmap(md)
    expect(phases[0].dependsOn).toEqual([])
  })

  it('parses tagged phase headers like "[offload]" without confusing the regex', () => {
    const md = `
## Phase 5: 命令收敛第一波 [offload] (completed)
- **Depends on**: 1
`.trim()
    const phases = parseRoadmap(md)
    expect(phases[0].id).toBe('5')
    expect(phases[0].status).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// 3. buildWaves — Kahn topo sort
// ---------------------------------------------------------------------------
describe('buildWaves', () => {
  const mkPhase = (id: string, deps: string[] = [], status: 'pending' = 'pending'): RoadmapPhase =>
    ({ id, name: `Phase ${id}`, status, dependsOn: deps })

  it('returns [] for empty input', () => {
    expect(buildWaves([])).toEqual([])
  })

  it('puts independent phases all in wave 1', () => {
    const phases = [mkPhase('1'), mkPhase('2'), mkPhase('3')]
    expect(buildWaves(phases)).toEqual([['1', '2', '3']])
  })

  it('separates a linear chain into N waves', () => {
    const phases = [
      mkPhase('1'),
      mkPhase('2', ['1']),
      mkPhase('3', ['2']),
    ]
    expect(buildWaves(phases)).toEqual([['1'], ['2'], ['3']])
  })

  it('models v4.0 actual roadmap (12 phases, 11 unique parents) correctly', () => {
    // Directly mirrors v4.0 .ccg/roadmap.md Phase 1-12 dependsOn declarations
    // Phase 1.5 deliberately skipped from this test to keep it focused on
    // the exact wave shape the user spec called out.
    const phases: RoadmapPhase[] = [
      mkPhase('1'),
      mkPhase('2', ['1']),
      mkPhase('3'),
      mkPhase('4'),
      mkPhase('5', ['1']),
      mkPhase('6', ['4']),
      mkPhase('7'),
      mkPhase('8'),
      mkPhase('9', ['6', '8']),
      mkPhase('10'),
      mkPhase('11'),
      mkPhase('12', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']),
    ]
    const waves = buildWaves(phases)

    // Wave 1: phases with no deps
    expect(waves[0]).toEqual(['1', '3', '4', '7', '8', '10', '11'])
    // Wave 2: phases that only depend on Wave 1
    expect(waves[1]).toEqual(['2', '5', '6'])
    // Wave 3: Phase 9 depends on 6 (Wave 2), so it lands in Wave 3
    expect(waves[2]).toEqual(['9'])
    // Wave 4: Phase 12 depends on 1-11 (latest dep is 9 in Wave 3)
    expect(waves[3]).toEqual(['12'])
    expect(waves).toHaveLength(4)
  })

  it('throws on dependency cycle', () => {
    const phases = [mkPhase('1', ['2']), mkPhase('2', ['1'])]
    expect(() => buildWaves(phases)).toThrow(/cycle/)
  })

  it('throws when phase depends on unknown phase', () => {
    const phases = [mkPhase('1', ['99'])]
    expect(() => buildWaves(phases)).toThrow(/unknown Phase 99/)
  })

  it('preserves declaration order within a wave (deterministic)', () => {
    const phases = [mkPhase('c'), mkPhase('a'), mkPhase('b')]
    expect(buildWaves(phases)).toEqual([['c', 'a', 'b']])
  })
})

// ---------------------------------------------------------------------------
// 4. cascadeSkip — failed/skipped propagation
// ---------------------------------------------------------------------------
describe('cascadeSkip', () => {
  const mk = (id: string, deps: string[], status: RoadmapPhase['status']): RoadmapPhase =>
    ({ id, name: `Phase ${id}`, dependsOn: deps, status })

  it('returns [] when no phase is failed/skipped', () => {
    const phases = [mk('1', [], 'pending'), mk('2', ['1'], 'pending')]
    expect(cascadeSkip(phases)).toEqual([])
  })

  it('marks direct downstream as skipped when upstream failed', () => {
    // Phase A failed → Phase B (depends A) auto skipped
    const phases = [mk('A', [], 'failed'), mk('B', ['A'], 'pending')]
    expect(cascadeSkip(phases)).toEqual(['B'])
  })

  it('marks transitive downstream chain as skipped', () => {
    // A failed → B → C → D all skipped
    const phases = [
      mk('A', [], 'failed'),
      mk('B', ['A'], 'pending'),
      mk('C', ['B'], 'pending'),
      mk('D', ['C'], 'pending'),
    ]
    expect(cascadeSkip(phases).sort()).toEqual(['B', 'C', 'D'])
  })

  it('skipped seed propagates same as failed seed', () => {
    const phases = [mk('A', [], 'skipped'), mk('B', ['A'], 'pending')]
    expect(cascadeSkip(phases)).toEqual(['B'])
  })

  it('does NOT cascade through completed phases', () => {
    // A failed, B completed (independent), C depends only on B → C should NOT be skipped
    const phases = [
      mk('A', [], 'failed'),
      mk('B', [], 'completed'),
      mk('C', ['B'], 'pending'),
    ]
    expect(cascadeSkip(phases)).toEqual([])
  })

  it('does not include the originally failed/skipped phase in result', () => {
    // Result is "newly cascaded skips"; the seed itself is not re-listed
    const phases = [mk('A', [], 'failed'), mk('B', ['A'], 'pending')]
    expect(cascadeSkip(phases)).not.toContain('A')
  })
})

// ---------------------------------------------------------------------------
// 5. batchByMaxConcurrent — wave splitting
// ---------------------------------------------------------------------------
describe('batchByMaxConcurrent', () => {
  it('splits a 6-phase wave into 3 batches when max=2 (acceptance c)', () => {
    const wave = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']
    expect(batchByMaxConcurrent(wave, 2)).toEqual([
      ['p1', 'p2'],
      ['p3', 'p4'],
      ['p5', 'p6'],
    ])
  })

  it('returns a single batch when wave fits in one chunk', () => {
    expect(batchByMaxConcurrent(['p1', 'p2'], 4)).toEqual([['p1', 'p2']])
  })

  it('returns empty for empty wave', () => {
    expect(batchByMaxConcurrent([], 4)).toEqual([])
  })

  it('handles uneven trailing batch', () => {
    expect(batchByMaxConcurrent(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e'],
    ])
  })

  it('throws when maxConcurrent < 1', () => {
    expect(() => batchByMaxConcurrent(['a'], 0)).toThrow(/maxConcurrent/)
  })

  it('maxConcurrent=1 produces all-singleton batches (--sequential equivalence)', () => {
    expect(batchByMaxConcurrent(['a', 'b', 'c'], 1)).toEqual([['a'], ['b'], ['c']])
  })
})

// ---------------------------------------------------------------------------
// 6. schedule — high-level integration
// ---------------------------------------------------------------------------
describe('schedule (integration)', () => {
  const mk = (id: string, deps: string[], status: RoadmapPhase['status'] = 'pending'): RoadmapPhase =>
    ({ id, name: `Phase ${id}`, dependsOn: deps, status })

  it('default behaviour (no flag): emits Kahn waves over the v4.0 12-phase graph', () => {
    const phases: RoadmapPhase[] = [
      mk('1', []), mk('2', ['1']), mk('3', []), mk('4', []),
      mk('5', ['1']), mk('6', ['4']), mk('7', []), mk('8', []),
      mk('9', ['6', '8']), mk('10', []), mk('11', []),
      mk('12', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']),
    ]
    const result = schedule(phases)
    expect(result.waves[0]).toEqual(['1', '3', '4', '7', '8', '10', '11'])
    expect(result.waves[1]).toEqual(['2', '5', '6'])
    expect(result.waves[2]).toEqual(['9'])
    expect(result.waves[3]).toEqual(['12'])
    expect(result.skipped).toEqual([])
    expect(result.batches).toBeUndefined()  // no max-concurrent → no batches
  })

  it('--max-concurrent=2 batches a wide wave into chunks (acceptance c)', () => {
    // Wave of 6 independent phases
    const phases = [mk('a', []), mk('b', []), mk('c', []), mk('d', []), mk('e', []), mk('f', [])]
    const result = schedule(phases, { maxConcurrent: 2 })
    expect(result.waves).toEqual([['a', 'b', 'c', 'd', 'e', 'f']])
    expect(result.batches).toEqual([
      [['a', 'b'], ['c', 'd'], ['e', 'f']],
    ])
  })

  it('--sequential equivalence: maxConcurrent=1 still produces correct waves but every batch is singleton', () => {
    const phases = [mk('a', []), mk('b', []), mk('c', ['a'])]
    const result = schedule(phases, { maxConcurrent: 1 })
    expect(result.waves).toEqual([['a', 'b'], ['c']])
    expect(result.batches).toEqual([
      [['a'], ['b']],
      [['c']],
    ])
  })

  it('skipCompleted=true (default) drops completed phases and treats their deps as satisfied', () => {
    const phases = [mk('1', [], 'completed'), mk('2', ['1']), mk('3', ['2'])]
    const result = schedule(phases)
    expect(result.waves).toEqual([['2'], ['3']])
  })

  it('cascade skip: failed upstream blocks downstream from scheduling (acceptance d)', () => {
    // Phase A failed (already done), Phase B depends on A → cascade-skipped, Phase C independent
    const phases = [
      mk('A', [], 'failed'),
      mk('B', ['A']),
      mk('C', []),
    ]
    const result = schedule(phases)
    expect(result.skipped).toEqual(['B'])
    // B should not appear in any wave (it's blocked); only C runs
    expect(result.waves).toEqual([['C']])
  })

  it('cascade skip propagates through chains: A failed → B → C → D all blocked', () => {
    const phases = [
      mk('A', [], 'failed'),
      mk('B', ['A']),
      mk('C', ['B']),
      mk('D', ['C']),
    ]
    const result = schedule(phases)
    expect(result.skipped.sort()).toEqual(['B', 'C', 'D'])
    expect(result.waves).toEqual([])
  })

  it('integration: parseRoadmap → schedule reproduces v4.0 wave shape from real markdown', () => {
    const md = `
## Phase 1: Foundation (pending)
- **Depends on**: (none)

## Phase 2: API (pending)
- **Depends on**: 1

## Phase 3: Independent (pending)
- **Depends on**: (none)

## Phase 4: Final (pending)
- **Depends on**: 1-3
`.trim()
    const phases = parseRoadmap(md)
    const result = schedule(phases)
    expect(result.waves[0]).toEqual(['1', '3'])
    expect(result.waves[1]).toEqual(['2'])
    expect(result.waves[2]).toEqual(['4'])
  })
})

// ---------------------------------------------------------------------------
// 7. autonomous.md template — Step 4.0 contract assertions
// ---------------------------------------------------------------------------
describe('autonomous.md Step 4.0 wave-parallel contract (Phase 14 acceptance a/b)', () => {
  const content = existsSync(AUTONOMOUS_TEMPLATE) ? readFileSync(AUTONOMOUS_TEMPLATE, 'utf8') : ''

  it('autonomous.md exists and is non-empty', () => {
    expect(content.length).toBeGreaterThan(100)
  })

  it('declares wave-parallel as the default mode (not opt-in --parallel)', () => {
    // Default behaviour MUST be parallel; --sequential is the opt-out flag
    expect(content).toMatch(/默认.*wave|默认.*并行|wave.*默认|parallel.*default/i)
  })

  it('documents --sequential opt-out flag', () => {
    expect(content).toMatch(/--sequential/)
  })

  it('documents --max-concurrent flag with default 4', () => {
    expect(content).toMatch(/--max-concurrent/)
    expect(content).toMatch(/默认\s*4|default\s*4|=\s*4/i)
  })

  it('Step 4.0 references Kahn topological sort', () => {
    expect(content).toMatch(/Kahn|拓扑|topological/i)
  })

  it('mentions cascade skip behaviour for failed upstream', () => {
    expect(content).toMatch(/cascade.*skip|cascade.*跳过|skip.*下游|下游.*skip/i)
  })

  it('Step 4.2 phase-runner spawn protocol switched to Bash subprocess (v4.5 P1a)', () => {
    // v4.5 P1a: Agent(subagent_type="phase-runner") replaced by
    // Bash(claude -p --agent ccg/phase-runner ...) OS-level subprocess.
    // Treats v4.4.x main-process RSS leak (23GB / 7.5h crash) at root.
    expect(content).toMatch(/--agent\s+ccg\/phase-runner/)
    expect(content).toMatch(/--output-format\s+stream-json/)
  })
})
