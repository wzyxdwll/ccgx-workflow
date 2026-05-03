import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ALL_FOCUSES,
  CODEBASE_MAPPER_OUTPUTS,
  getAllExpectedOutputs,
  getOutputFilesForFocus,
  isValidFocus,
  parseCodebaseMapperReturn,
} from '../codebase-mapper'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const MAPPER_TEMPLATE = resolve(
  REPO_ROOT,
  'templates',
  'commands',
  'agents',
  'codebase-mapper.md',
)
const INIT_TEMPLATE = resolve(REPO_ROOT, 'templates', 'commands', 'init.md')

// ---------------------------------------------------------------------------
// 1. codebase-mapper.md template — frontmatter + 4-focus contract assertions
//    (acceptance: agent file exists with correct frontmatter)
// ---------------------------------------------------------------------------
describe('codebase-mapper.md template (Phase 3 acceptance a)', () => {
  it('exists at templates/commands/agents/codebase-mapper.md', () => {
    expect(existsSync(MAPPER_TEMPLATE)).toBe(true)
  })

  const content = existsSync(MAPPER_TEMPLATE) ? readFileSync(MAPPER_TEMPLATE, 'utf8') : ''

  it('declares name=codebase-mapper in frontmatter', () => {
    expect(content).toMatch(/^---[\s\S]*?name:\s*codebase-mapper[\s\S]*?---/m)
  })

  it('declares all 5 required tools (Read, Bash, Grep, Glob, Write)', () => {
    expect(content).toMatch(/^---[\s\S]*?tools:[^\n]*\bRead\b[\s\S]*?---/m)
    expect(content).toMatch(/^---[\s\S]*?tools:[^\n]*\bBash\b[\s\S]*?---/m)
    expect(content).toMatch(/^---[\s\S]*?tools:[^\n]*\bGrep\b[\s\S]*?---/m)
    expect(content).toMatch(/^---[\s\S]*?tools:[^\n]*\bGlob\b[\s\S]*?---/m)
    expect(content).toMatch(/^---[\s\S]*?tools:[^\n]*\bWrite\b[\s\S]*?---/m)
  })

  it('documents all 4 focus values (tech / arch / quality / concerns)', () => {
    for (const focus of ALL_FOCUSES) {
      expect(content).toMatch(new RegExp(`\\b${focus}\\b`))
    }
  })

  it('mentions all 7 output file basenames', () => {
    const basenames = ['STACK.md', 'INTEGRATIONS.md', 'ARCHITECTURE.md', 'STRUCTURE.md', 'CONVENTIONS.md', 'TESTING.md', 'CONCERNS.md']
    for (const f of basenames) {
      expect(content).toContain(f)
    }
  })

  it('writes outputs into .context/codebase/ (not the legacy .planning/ path)', () => {
    expect(content).toContain('.context/codebase/')
    expect(content).not.toContain('.planning/codebase/')
  })

  it('defines the single-line return protocol (WROTE / FOCUS / EVIDENCE_COUNT)', () => {
    expect(content).toContain('WROTE:')
    expect(content).toContain('FOCUS:')
    expect(content).toContain('EVIDENCE_COUNT:')
  })

  it('explicitly requires read-only behavior (no source code modification)', () => {
    // 中英 + 标点变体
    expect(content).toMatch(/read[-_ ]only|不修改|不写源代码|read.{0,5}only/i)
  })
})

// ---------------------------------------------------------------------------
// 2. init.md modifications — verify 4-way parallel codebase-mapper spawn
//    (acceptance: init.md calls codebase-mapper before init-architect)
// ---------------------------------------------------------------------------
describe('init.md template integrates codebase-mapper (Phase 3 acceptance b)', () => {
  const content = existsSync(INIT_TEMPLATE) ? readFileSync(INIT_TEMPLATE, 'utf8') : ''

  it('references codebase-mapper subagent', () => {
    expect(content).toMatch(/codebase-mapper/)
  })

  it('declares 4-way parallel spawn (one Agent call per focus)', () => {
    // 4 focuses must each appear as a distinct prompt argument
    for (const focus of ALL_FOCUSES) {
      expect(content).toMatch(new RegExp(`focus\\s*=\\s*${focus}|focus:\\s*${focus}|"${focus}"`))
    }
  })

  it('mentions the 4-parallel-then-sequential ordering with init-architect', () => {
    // init-architect 必须在 codebase-mapper 4 路完成后才跑
    const mapperIdx = content.indexOf('codebase-mapper')
    const archIdx = content.indexOf('init-architect')
    expect(mapperIdx).toBeGreaterThanOrEqual(0)
    expect(archIdx).toBeGreaterThan(mapperIdx)
  })
})

// ---------------------------------------------------------------------------
// 3. ALL_FOCUSES contract
// ---------------------------------------------------------------------------
describe('ALL_FOCUSES (Phase 3 acceptance c)', () => {
  it('contains exactly 4 entries', () => {
    expect(ALL_FOCUSES).toHaveLength(4)
  })

  it('contains tech / arch / quality / concerns in this stable order', () => {
    expect(ALL_FOCUSES).toEqual(['tech', 'arch', 'quality', 'concerns'])
  })
})

// ---------------------------------------------------------------------------
// 4. CODEBASE_MAPPER_OUTPUTS — focus → file mapping contract
// ---------------------------------------------------------------------------
describe('CODEBASE_MAPPER_OUTPUTS (Phase 3 acceptance d)', () => {
  it('tech writes STACK.md + INTEGRATIONS.md', () => {
    expect(CODEBASE_MAPPER_OUTPUTS.tech).toEqual([
      '.context/codebase/STACK.md',
      '.context/codebase/INTEGRATIONS.md',
    ])
  })

  it('arch writes ARCHITECTURE.md + STRUCTURE.md', () => {
    expect(CODEBASE_MAPPER_OUTPUTS.arch).toEqual([
      '.context/codebase/ARCHITECTURE.md',
      '.context/codebase/STRUCTURE.md',
    ])
  })

  it('quality writes CONVENTIONS.md + TESTING.md', () => {
    expect(CODEBASE_MAPPER_OUTPUTS.quality).toEqual([
      '.context/codebase/CONVENTIONS.md',
      '.context/codebase/TESTING.md',
    ])
  })

  it('concerns writes single CONCERNS.md', () => {
    expect(CODEBASE_MAPPER_OUTPUTS.concerns).toEqual(['.context/codebase/CONCERNS.md'])
  })

  it('total expected outputs across all focuses = 7 unique files', () => {
    const all = getAllExpectedOutputs()
    expect(all).toHaveLength(7)
    expect(new Set(all).size).toBe(7)
  })

  it('all output paths live under .context/codebase/', () => {
    for (const path of getAllExpectedOutputs()) {
      expect(path.startsWith('.context/codebase/')).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 5. getOutputFilesForFocus — runtime accessor
// ---------------------------------------------------------------------------
describe('getOutputFilesForFocus', () => {
  it('returns the correct file list for each valid focus', () => {
    for (const focus of ALL_FOCUSES) {
      expect(getOutputFilesForFocus(focus)).toEqual(CODEBASE_MAPPER_OUTPUTS[focus])
    }
  })

  it('throws on invalid focus', () => {
    // @ts-expect-error testing invalid input
    expect(() => getOutputFilesForFocus('bogus')).toThrow(/Invalid focus/)
  })
})

// ---------------------------------------------------------------------------
// 6. isValidFocus
// ---------------------------------------------------------------------------
describe('isValidFocus', () => {
  it.each(['tech', 'arch', 'quality', 'concerns'])('accepts %s', (v) => {
    expect(isValidFocus(v)).toBe(true)
  })

  it.each(['security', 'TECH', '', 'quality ', null, undefined, 42])(
    'rejects %s',
    (v) => {
      expect(isValidFocus(v)).toBe(false)
    },
  )
})

// ---------------------------------------------------------------------------
// 7. parseCodebaseMapperReturn — single-line subagent return parser
// ---------------------------------------------------------------------------
describe('parseCodebaseMapperReturn', () => {
  it('parses a fully populated return line', () => {
    const text
      = 'WROTE: .context/codebase/STACK.md,.context/codebase/INTEGRATIONS.md | FOCUS: tech | EVIDENCE_COUNT: 23'
    const out = parseCodebaseMapperReturn(text)
    expect(out.focus).toBe('tech')
    expect(out.wroteFiles).toEqual([
      '.context/codebase/STACK.md',
      '.context/codebase/INTEGRATIONS.md',
    ])
    expect(out.evidenceCount).toBe(23)
  })

  it('handles concerns single-file case', () => {
    const text = 'WROTE: .context/codebase/CONCERNS.md | FOCUS: concerns | EVIDENCE_COUNT: 7'
    const out = parseCodebaseMapperReturn(text)
    expect(out.focus).toBe('concerns')
    expect(out.wroteFiles).toEqual(['.context/codebase/CONCERNS.md'])
    expect(out.evidenceCount).toBe(7)
  })

  it('defaults evidenceCount to 0 when missing', () => {
    const text = 'WROTE: .context/codebase/STACK.md | FOCUS: tech'
    const out = parseCodebaseMapperReturn(text)
    expect(out.evidenceCount).toBe(0)
  })

  it('is whitespace tolerant', () => {
    const text = '   WROTE  :  .context/codebase/STACK.md  |  FOCUS:tech  '
    const out = parseCodebaseMapperReturn(text)
    expect(out.focus).toBe('tech')
    expect(out.wroteFiles).toEqual(['.context/codebase/STACK.md'])
  })

  it('throws when WROTE missing', () => {
    expect(() => parseCodebaseMapperReturn('FOCUS: tech')).toThrow(/WROTE/)
  })

  it('throws when FOCUS missing', () => {
    expect(() => parseCodebaseMapperReturn('WROTE: foo.md')).toThrow(/FOCUS/)
  })

  it('throws on illegal FOCUS value', () => {
    expect(() => parseCodebaseMapperReturn('WROTE: foo.md | FOCUS: bogus')).toThrow(
      /invalid FOCUS/,
    )
  })

  it('lowercases focus before validation (FOCUS: TECH still works)', () => {
    const text = 'WROTE: foo.md | FOCUS: TECH | EVIDENCE_COUNT: 1'
    const out = parseCodebaseMapperReturn(text)
    expect(out.focus).toBe('tech')
  })
})

// ---------------------------------------------------------------------------
// 8. 4-way parallel spawn coverage simulation (acceptance: 4 路并行覆盖 7 文件)
// ---------------------------------------------------------------------------
describe('4-way parallel spawn coverage simulation', () => {
  it('mocked 4 parallel returns cover all 7 expected output files', () => {
    // 模拟主线 spawn 4 个 codebase-mapper instance 并收集返回
    const mockReturns = ALL_FOCUSES.map((focus) => {
      const files = CODEBASE_MAPPER_OUTPUTS[focus]
      return `WROTE: ${files.join(',')} | FOCUS: ${focus} | EVIDENCE_COUNT: ${files.length * 5}`
    })

    const collected = new Set<string>()
    const focusesSeen = new Set<string>()
    for (const line of mockReturns) {
      const parsed = parseCodebaseMapperReturn(line)
      focusesSeen.add(parsed.focus)
      for (const f of parsed.wroteFiles) collected.add(f)
    }

    // 4 路并行覆盖 4 focus 全集
    expect(focusesSeen.size).toBe(4)
    // 7 文件全集
    expect(collected.size).toBe(7)
    expect([...collected].sort()).toEqual([...getAllExpectedOutputs()].sort())
  })
})
