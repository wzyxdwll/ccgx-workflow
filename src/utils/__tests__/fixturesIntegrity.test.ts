/**
 * Fixtures integrity test (CCG v4.3 P28).
 *
 * Validates that tests/fixtures/ground-truth/*.sample.json files exist,
 * parse cleanly, conform to the schemas exported by ground-truth-sampler.ts,
 * and use anonymized paths (no real usernames leak).
 *
 * Round-trip property: sampler should be able to ingest fixture data and
 * produce the same shape (when wired through writeFixtures → re-parse).
 *
 * Failure modes this catches:
 *   - Fixture schema drift (sampler updated, fixtures stale)
 *   - Anonymization regression (someone regen'd without strip)
 *   - Parser regression (parsers stop accepting real-shaped input)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  sampleHookSchema,
  samplePluginList,
} from '../ground-truth-sampler'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const FIXTURES_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'ground-truth')

const FIXTURE_FILES = {
  installedPlugins: 'installed_plugins.sample.json',
  settings: 'settings.sample.json',
  skills: 'skills.sample.json',
  agentSummaries: 'agent-summaries.sample.json',
  readme: 'README.md',
} as const

function readFixture(name: string): unknown {
  const path = join(FIXTURES_DIR, name)
  return JSON.parse(readFileSync(path, 'utf8'))
}

// ---------------------------------------------------------------------------
// 1. Existence & JSON validity
// ---------------------------------------------------------------------------

describe('fixtures — file existence & JSON parse', () => {
  it('all expected fixture files exist on disk', () => {
    for (const name of Object.values(FIXTURE_FILES)) {
      const path = join(FIXTURES_DIR, name)
      expect(existsSync(path), `missing fixture: ${path}`).toBe(true)
    }
  })

  it('every .sample.json fixture parses as valid JSON', () => {
    for (const name of Object.values(FIXTURE_FILES)) {
      if (!name.endsWith('.json')) continue
      const path = join(FIXTURES_DIR, name)
      expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow()
    }
  })

  it('README.md is non-empty + mentions regen-fixtures script', () => {
    const readme = readFileSync(join(FIXTURES_DIR, FIXTURE_FILES.readme), 'utf8')
    expect(readme.length).toBeGreaterThan(200)
    expect(readme).toMatch(/regen-fixtures/)
  })
})

// ---------------------------------------------------------------------------
// 2. Schema conformance
// ---------------------------------------------------------------------------

describe('fixtures — installed_plugins schema', () => {
  const data = readFixture(FIXTURE_FILES.installedPlugins) as {
    version: number
    plugins: Record<string, Array<{ version: string; installPath?: string }>>
  }

  it('uses v2 schema (version: 2 + plugins object)', () => {
    expect(data.version).toBe(2)
    expect(typeof data.plugins).toBe('object')
    expect(Array.isArray(data.plugins)).toBe(false)
  })

  it('contains both known marketplace plugins (codex + gemini) and an unknown', () => {
    const keys = Object.keys(data.plugins)
    expect(keys.some(k => k.startsWith('codex@'))).toBe(true)
    expect(keys.some(k => k.startsWith('gemini@'))).toBe(true)
    // representative diversity: at least one unknown marketplace
    expect(keys.some(k => !k.endsWith('@claude-plugins-official'))).toBe(true)
  })

  it('every plugin entry is an array with at least one instance', () => {
    for (const [key, instances] of Object.entries(data.plugins)) {
      expect(Array.isArray(instances), `${key} not array`).toBe(true)
      expect(instances.length).toBeGreaterThan(0)
      expect(typeof instances[0].version).toBe('string')
    }
  })
})

describe('fixtures — settings schema', () => {
  const data = readFixture(FIXTURE_FILES.settings) as {
    hooks: Record<string, Array<{ matcher?: unknown; hooks: unknown[] }>>
  }

  it('has hooks section', () => {
    expect(data.hooks).toBeDefined()
    expect(typeof data.hooks).toBe('object')
  })

  it('SessionStart entry uses matcher: "" (empty string), not array', () => {
    expect(data.hooks.SessionStart).toBeDefined()
    const entry = data.hooks.SessionStart[0]
    expect(typeof entry.matcher).toBe('string')
    expect(entry.matcher).toBe('')
  })

  it('PostToolUse entry uses matcher: "Edit|Write|MultiEdit" (string regex)', () => {
    expect(data.hooks.PostToolUse).toBeDefined()
    const first = data.hooks.PostToolUse[0]
    expect(typeof first.matcher).toBe('string')
    expect(first.matcher).toMatch(/Edit/)
  })

  it('exposes mixed matcher types across events (string, absent, null)', () => {
    const types = new Set<string>()
    for (const entries of Object.values(data.hooks)) {
      for (const e of entries) {
        if (e.matcher === undefined) types.add('absent')
        else if (e.matcher === null) types.add('null')
        else if (typeof e.matcher === 'string') types.add('string')
        else if (Array.isArray(e.matcher)) types.add('array')
        else types.add('other')
      }
    }
    // Acceptance: must include at least 2 distinct shapes (representative diversity)
    expect(types.size).toBeGreaterThanOrEqual(2)
  })
})

describe('fixtures — skills schema', () => {
  const data = readFixture(FIXTURE_FILES.skills) as {
    skills: Array<{ name: string; path: string; userInvocable: boolean; category: string }>
  }

  it('exposes a skills array of 10-15 entries', () => {
    expect(Array.isArray(data.skills)).toBe(true)
    expect(data.skills.length).toBeGreaterThanOrEqual(10)
    expect(data.skills.length).toBeLessThanOrEqual(15)
  })

  it('mixes user-invocable=true and false (representative diversity)', () => {
    const invocable = data.skills.filter(s => s.userInvocable).length
    const notInvocable = data.skills.length - invocable
    expect(invocable).toBeGreaterThan(0)
    expect(notInvocable).toBeGreaterThan(0)
  })

  it('every skill has required fields with correct types', () => {
    for (const s of data.skills) {
      expect(typeof s.name).toBe('string')
      expect(s.name.length).toBeGreaterThan(0)
      expect(typeof s.path).toBe('string')
      expect(typeof s.userInvocable).toBe('boolean')
      expect(['tool', 'domain', 'impeccable', 'orchestration', 'unknown']).toContain(s.category)
    }
  })

  it('covers multiple categories (tool + domain + at least one of impeccable/orchestration)', () => {
    const cats = new Set(data.skills.map(s => s.category))
    expect(cats.has('tool')).toBe(true)
    expect(cats.has('domain')).toBe(true)
    expect(cats.size).toBeGreaterThanOrEqual(3)
  })
})

describe('fixtures — agent-summaries schema', () => {
  const data = readFixture(FIXTURE_FILES.agentSummaries) as {
    challengerSummaries: Record<string, string>
    verifySummaries: Record<string, string>
    debateRoundSummaries: Record<string, string>
  }

  it('groups summaries by orchestrator type', () => {
    expect(data.challengerSummaries).toBeDefined()
    expect(data.verifySummaries).toBeDefined()
    expect(data.debateRoundSummaries).toBeDefined()
  })

  it('every summary string starts with STATUS: marker', () => {
    const all = [
      ...Object.values(data.challengerSummaries),
      ...Object.values(data.verifySummaries),
      ...Object.values(data.debateRoundSummaries),
    ]
    for (const s of all) {
      expect(s).toMatch(/^STATUS:/)
    }
  })

  it('has at least one error case + one complete case per orchestrator group', () => {
    expect(Object.keys(data.challengerSummaries).some(k => k.includes('error'))).toBe(true)
    expect(Object.keys(data.challengerSummaries).some(k => k.includes('complete'))).toBe(true)
    expect(Object.keys(data.verifySummaries).some(k => k.includes('error'))).toBe(true)
    expect(Object.keys(data.verifySummaries).some(k => k.includes('complete'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. Anonymization
// ---------------------------------------------------------------------------

describe('fixtures — anonymization (no leaked usernames)', () => {
  // Sentinel: known username segments that should NEVER appear in fixtures
  const FORBIDDEN = [
    /\/Users\/[A-Za-z0-9._-]+\/\.claude/,
    /[A-Z]:[\\\/]Users[\\\/][A-Za-z0-9._-]+[\\\/]/i,
    /\/home\/[A-Za-z0-9._-]+\/\.claude/,
  ]

  function assertAnonymous(name: string, content: string): void {
    for (const re of FORBIDDEN) {
      expect(content, `${name} contains real-looking user path`).not.toMatch(re)
    }
  }

  it('installed_plugins.sample.json — no real user paths', () => {
    const content = readFileSync(join(FIXTURES_DIR, FIXTURE_FILES.installedPlugins), 'utf8')
    assertAnonymous(FIXTURE_FILES.installedPlugins, content)
    expect(content).toMatch(/<HOME>/)
  })

  it('settings.sample.json — no real user paths', () => {
    const content = readFileSync(join(FIXTURES_DIR, FIXTURE_FILES.settings), 'utf8')
    assertAnonymous(FIXTURE_FILES.settings, content)
    expect(content).toMatch(/<HOME>/)
  })

  it('skills.sample.json — no real user paths', () => {
    const content = readFileSync(join(FIXTURES_DIR, FIXTURE_FILES.skills), 'utf8')
    assertAnonymous(FIXTURE_FILES.skills, content)
    expect(content).toMatch(/<HOME>/)
  })
})

// ---------------------------------------------------------------------------
// 4. Round-trip — sampler can re-parse fixture data via temp FS
// ---------------------------------------------------------------------------

describe('fixtures — round-trip with sampler', () => {
  let fakeHome: string

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'ccg-fixtures-rt-'))
  })

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true })
  })

  function materialize(relative: string, content: string): void {
    const full = join(fakeHome, relative)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }

  it('samplePluginList can re-parse installed_plugins.sample.json (paths in fixture get parsed verbatim)', () => {
    const fixtureContent = readFileSync(join(FIXTURES_DIR, FIXTURE_FILES.installedPlugins), 'utf8')
    materialize('.claude/plugins/installed_plugins.json', fixtureContent)

    const { plugins, warnings } = samplePluginList(fakeHome)
    expect(warnings).toEqual([])
    expect(plugins.length).toBeGreaterThan(0)
    // Known marketplace recognized
    const codex = plugins.find(p => p.shortName === 'codex')
    expect(codex).toBeDefined()
    expect(codex!.subagentTypeHints).toContain('codex:rescue')
    expect(codex!.subagentTypeHints).not.toContain('codex:codex-rescue')
    // Unknown plugin gets undefined hints (no fabrication)
    const mystery = plugins.find(p => p.shortName === 'mystery-plugin')
    expect(mystery).toBeDefined()
    expect(mystery!.subagentTypeHints).toBeUndefined()
  })

  it('sampleHookSchema can re-parse settings.sample.json with mixed matcher types', () => {
    const fixtureContent = readFileSync(join(FIXTURES_DIR, FIXTURE_FILES.settings), 'utf8')
    materialize('.claude/settings.json', fixtureContent)

    const { hooks, warnings } = sampleHookSchema(fakeHome)
    expect(warnings).toEqual([])
    expect(hooks.length).toBeGreaterThan(0)

    // SessionStart classified as 'string' (matcher: "")
    const session = hooks.find(h => h.event === 'SessionStart')
    expect(session?.matcherType).toBe('string')

    // PostToolUse classified as 'string' (matcher: "Edit|Write|...")
    const post = hooks.find(h => h.event === 'PostToolUse')
    expect(post?.matcherType).toBe('string')
    expect(post?.hookCount).toBeGreaterThanOrEqual(2)

    // PreToolUse — matcher absent
    const pre = hooks.find(h => h.event === 'PreToolUse')
    expect(pre?.matcherType).toBe('absent')

    // Stop — matcher: null
    const stop = hooks.find(h => h.event === 'Stop')
    expect(stop?.matcherType).toBe('null')
  })

  it('round-trip is stable: sampler output matches expected event count', () => {
    const fixtureContent = readFileSync(join(FIXTURES_DIR, FIXTURE_FILES.settings), 'utf8')
    materialize('.claude/settings.json', fixtureContent)
    const { hooks } = sampleHookSchema(fakeHome)
    const fixture = JSON.parse(fixtureContent) as { hooks: Record<string, unknown[]> }
    expect(hooks.length).toBe(Object.keys(fixture.hooks).length)
  })
})
