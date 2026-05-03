import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseRoleFlag,
  promptFilePath,
  routeSpecialist,
  type SpecialistLayer,
  type SpecialistRole,
} from '../specialist-router'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const TARGET_TEMPLATES = ['plan', 'analyze', 'debug', 'review', 'optimize', 'test'].map(name =>
  resolve(REPO_ROOT, 'templates', 'commands', `${name}.md`),
)

// ---------------------------------------------------------------------------
// 1. routeSpecialist matrix (acceptance c)
// ---------------------------------------------------------------------------
describe('routeSpecialist — 5 role × 3 layer matrix', () => {
  it('architect × backend → codex only, prompts to codex/architect.md', () => {
    const r = routeSpecialist('architect', 'backend')
    expect(r.models).toEqual(['codex'])
    expect(r.promptFiles).toEqual(['architect.md'])
    expect(r.adversarial).toBe(false)
    expect(r.runnerDecides).toBe(false)
  })

  it('architect × frontend → gemini only, prompts to gemini/architect.md', () => {
    const r = routeSpecialist('architect', 'frontend')
    expect(r.models).toEqual(['gemini'])
    expect(r.promptFiles).toEqual(['architect.md'])
    expect(r.adversarial).toBe(false)
  })

  it('architect × fullstack → codex+gemini parallel (both architect.md)', () => {
    const r = routeSpecialist('architect', 'fullstack')
    expect(r.models).toEqual(['codex', 'gemini'])
    expect(r.promptFiles).toEqual(['architect.md', 'architect.md'])
    expect(r.runnerDecides).toBe(false)
  })

  it('critic × backend → codex with adversarial flag, reviewer.md', () => {
    const r = routeSpecialist('critic', 'backend')
    expect(r.models).toEqual(['codex'])
    expect(r.promptFiles).toEqual(['reviewer.md'])
    expect(r.adversarial).toBe(true)
  })

  it('critic × fullstack → both models debate adversarially', () => {
    const r = routeSpecialist('critic', 'fullstack')
    expect(r.models).toEqual(['codex', 'gemini'])
    expect(r.promptFiles).toEqual(['reviewer.md', 'reviewer.md'])
    expect(r.adversarial).toBe(true)
  })

  // v4.2 P21 (assumption purge):
  // implementer × backend 历史借用 architect.md 是未验证假设；改为 main-thread Claude，
  // 主线/phase-runner 按 phase Type 自行 spawn rescue plugin。
  it('implementer × backend → main-thread Claude (no borrowed prompt; assumption purged)', () => {
    const r = routeSpecialist('implementer', 'backend')
    expect(r.models).toEqual(['claude'])
    expect(r.promptFiles).toEqual([null])
    expect(r.adversarial).toBe(false)
  })

  it('implementer × frontend → main-thread Claude (assumption purged)', () => {
    const r = routeSpecialist('implementer', 'frontend')
    expect(r.models).toEqual(['claude'])
    expect(r.promptFiles).toEqual([null])
  })

  it('implementer × fullstack → runner decides (codex OR gemini per file), no prompt files', () => {
    const r = routeSpecialist('implementer', 'fullstack')
    expect(r.runnerDecides).toBe(true)
    expect(r.models).toEqual(['codex', 'gemini'])
    // v4.2 P21: prompt files null（主线接管 prompt 决策）
    expect(r.promptFiles).toEqual([null, null])
  })

  it('tester × backend → codex with tester.md', () => {
    const r = routeSpecialist('tester', 'backend')
    expect(r.models).toEqual(['codex'])
    expect(r.promptFiles).toEqual(['tester.md'])
  })

  it('tester × frontend → gemini with tester.md', () => {
    const r = routeSpecialist('tester', 'frontend')
    expect(r.models).toEqual(['gemini'])
    expect(r.promptFiles).toEqual(['tester.md'])
  })

  it('tester × fullstack → runner decides per file', () => {
    const r = routeSpecialist('tester', 'fullstack')
    expect(r.runnerDecides).toBe(true)
  })

  it('writer × backend → main-thread Claude (no external prompt)', () => {
    const r = routeSpecialist('writer', 'backend')
    expect(r.models).toEqual(['claude'])
    expect(r.promptFiles).toEqual([null])
  })

  it('writer × fullstack → main-thread Claude', () => {
    const r = routeSpecialist('writer', 'fullstack')
    expect(r.models).toEqual(['claude'])
    expect(r.promptFiles).toEqual([null])
  })

  // v4.2 P21 (assumption purge):
  // writer × frontend 历史借用 gemini analyzer.md 是未验证假设（analyzer 不对应
  // UX writing）；改为统一 main-thread Claude，与 backend / fullstack 一致。
  it('writer × frontend → main-thread Claude (analyzer.md borrow assumption purged)', () => {
    const r = routeSpecialist('writer', 'frontend')
    expect(r.models).toEqual(['claude'])
    expect(r.promptFiles).toEqual([null])
  })

  it('all 15 cells return a route (no undefined / throws)', () => {
    const roles: SpecialistRole[] = ['architect', 'critic', 'implementer', 'tester', 'writer']
    const layers: SpecialistLayer[] = ['backend', 'frontend', 'fullstack']
    for (const role of roles) {
      for (const layer of layers) {
        const r = routeSpecialist(role, layer)
        expect(r.models.length).toBeGreaterThan(0)
        expect(r.promptFiles.length).toBe(r.models.length)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 2. parseRoleFlag — graceful fallback to v4.0 routing (acceptance a tail)
// ---------------------------------------------------------------------------
describe('parseRoleFlag — flag detection + v4.0 BC', () => {
  it('returns null when no --role flag is present (v4.0 fallback)', () => {
    expect(parseRoleFlag('analyze the auth subsystem')).toBeNull()
    expect(parseRoleFlag('')).toBeNull()
    expect(parseRoleFlag('--mode=find_root_cause_only')).toBeNull()
  })

  it('parses --role=architect', () => {
    expect(parseRoleFlag('analyze users --role=architect')).toBe('architect')
  })

  it('parses --role architect (whitespace separator)', () => {
    expect(parseRoleFlag('--role architect target.ts')).toBe('architect')
  })

  it('parses each of the 5 roles', () => {
    for (const role of ['architect', 'critic', 'implementer', 'tester', 'writer']) {
      expect(parseRoleFlag(`--role=${role}`)).toBe(role)
    }
  })

  it('returns null for unknown role (no throw, fall back to v4.0)', () => {
    expect(parseRoleFlag('--role=wizard')).toBeNull()
    expect(parseRoleFlag('--role=')).toBeNull()
  })

  it('case-insensitive role name', () => {
    expect(parseRoleFlag('--role=ARCHITECT')).toBe('architect')
    expect(parseRoleFlag('--ROLE=critic')).toBe('critic')
  })
})

// ---------------------------------------------------------------------------
// 3. promptFilePath — absolute path construction
// ---------------------------------------------------------------------------
describe('promptFilePath — prompt file path builder', () => {
  it('builds ~/.claude/.ccg/prompts/<model>/<file> for codex/gemini', () => {
    expect(promptFilePath('codex', 'architect.md')).toBe(
      '~/.claude/.ccg/prompts/codex/architect.md',
    )
    expect(promptFilePath('gemini', 'reviewer.md')).toBe(
      '~/.claude/.ccg/prompts/gemini/reviewer.md',
    )
  })

  it('returns null for claude (main-thread) or null promptFile', () => {
    expect(promptFilePath('claude', 'architect.md')).toBeNull()
    expect(promptFilePath('codex', null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4. Command template "Role-based routing" sections (acceptance a)
// ---------------------------------------------------------------------------
describe('command templates — Role-based routing section', () => {
  it.each(TARGET_TEMPLATES)('%s exists', (path) => {
    expect(existsSync(path)).toBe(true)
  })

  it.each(TARGET_TEMPLATES)('%s contains "Role-based routing" section', (path) => {
    const content = readFileSync(path, 'utf8')
    expect(content).toMatch(/##\s+Role-based routing/i)
  })

  it.each(TARGET_TEMPLATES)('%s documents --role flag with 5 valid values', (path) => {
    const content = readFileSync(path, 'utf8')
    expect(content).toMatch(/--role\s*=?\s*architect/)
    expect(content).toMatch(/--role\s*=?\s*critic|critic/)
    expect(content).toMatch(/--role\s*=?\s*implementer|implementer/)
    expect(content).toMatch(/--role\s*=?\s*tester|tester/)
    expect(content).toMatch(/--role\s*=?\s*writer|writer/)
  })

  it.each(TARGET_TEMPLATES)('%s preserves v4.0 BC fallback note', (path) => {
    const content = readFileSync(path, 'utf8')
    // Each template must spell out "no --role → v4.0 routing" preservation
    expect(content).toMatch(/未传\s*--role|无\s*--role|fallback|兼容/i)
  })
})

// ---------------------------------------------------------------------------
// 5. Adversarial framing applies only to critic
// ---------------------------------------------------------------------------
describe('adversarial framing flag', () => {
  it('only critic role sets adversarial=true', () => {
    const layers: SpecialistLayer[] = ['backend', 'frontend', 'fullstack']
    const nonCritic: SpecialistRole[] = ['architect', 'implementer', 'tester', 'writer']
    for (const layer of layers) {
      for (const role of nonCritic) {
        expect(routeSpecialist(role, layer).adversarial).toBe(false)
      }
      expect(routeSpecialist('critic', layer).adversarial).toBe(true)
    }
  })
})
