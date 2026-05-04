import { describe, expect, it } from 'vitest'
import {
  auditAlienFilesStaged,
  criticalFindings,
  hasBlockingFindings,
  isFileInScope,
  majorFindings,
  parseInterfaceAuditorReport,
} from '../interface-auditor'

// ---------------------------------------------------------------------------
// 1. parseInterfaceAuditorReport — happy paths
// ---------------------------------------------------------------------------

describe('parseInterfaceAuditorReport — STATUS / FINDINGS / NOTES schema', () => {
  it('parses clean phase (0 findings)', () => {
    const text = `STATUS: complete
FINDINGS: []
NOTES: phase 27 commit fbf7c3c clean across 5 audits`
    const r = parseInterfaceAuditorReport(text)
    expect(r.status).toBe('complete')
    expect(r.findings).toEqual([])
    expect(r.notes).toContain('clean across 5 audits')
  })

  it('parses single critical SSoT-violation finding (v4.2 P22 同型)', () => {
    const text = `STATUS: complete
FINDINGS: [{"severity":"critical","category":"ssot-violation","message":"planVerifyWave duplicated in quality-router.ts:280 + verify-orchestrator.ts:94"}]
NOTES: 1 critical SSoT violation`
    const r = parseInterfaceAuditorReport(text)
    expect(r.status).toBe('complete')
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].severity).toBe('critical')
    expect(r.findings[0].category).toBe('ssot-violation')
    expect(r.findings[0].message).toContain('planVerifyWave')
  })

  it('parses single major leftover finding (v4.1 P19 paths 字段同型)', () => {
    const text = `STATUS: complete
FINDINGS: [{"severity":"major","category":"leftover","message":"matchSkillPaths exported in skill-registry.ts:412 but no import consumer found"}]
NOTES: 1 leftover (half-baked feature)`
    const r = parseInterfaceAuditorReport(text)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].severity).toBe('major')
    expect(r.findings[0].category).toBe('leftover')
  })

  it('parses critical magic-string-mismatch finding (v4.2.0 codex:codex-rescue 同型)', () => {
    const text = `STATUS: complete
FINDINGS: [{"severity":"critical","category":"magic-string-mismatch","message":"subagent_type 'codex:codex-rescue' at quality-router.ts:189 — ground truth subagentTypeHints=['codex:rescue']"}]
NOTES: ground-truth mismatch`
    const r = parseInterfaceAuditorReport(text)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].severity).toBe('critical')
    expect(r.findings[0].category).toBe('magic-string-mismatch')
    expect(r.findings[0].message).toContain('codex:codex-rescue')
  })

  it('parses commit-diff-drift major finding', () => {
    const text = `STATUS: complete
FINDINGS: [{"severity":"major","category":"commit-diff-drift","message":"subject says add foo but git stat 无新建 foo 路径文件"}]
NOTES: subject vs diff drift`
    const r = parseInterfaceAuditorReport(text)
    expect(r.findings[0].category).toBe('commit-diff-drift')
    expect(r.findings[0].severity).toBe('major')
  })

  it('parses mock-drift info finding', () => {
    const text = `STATUS: complete
FINDINGS: [{"severity":"info","category":"mock-drift","message":"test mock 用 pluginType 字段但 ground truth PluginInfo schema 是 subagentTypeHints"}]
NOTES: best-effort mock审`
    const r = parseInterfaceAuditorReport(text)
    expect(r.findings[0].category).toBe('mock-drift')
    expect(r.findings[0].severity).toBe('info')
  })
})

// ---------------------------------------------------------------------------
// 2. parseInterfaceAuditorReport — multi-finding + lenient parsing
// ---------------------------------------------------------------------------

describe('parseInterfaceAuditorReport — multi-finding aggregation', () => {
  it('parses mixed-severity findings list (inline JSON, ≤200 token convention)', () => {
    const text = `STATUS: complete
FINDINGS: [{"severity":"critical","category":"ssot-violation","message":"foo dup"}, {"severity":"major","category":"leftover","message":"bar leftover"}, {"severity":"info","category":"mock-drift","message":"baz drift"}]
NOTES: 3 findings (1 critical / 1 major / 1 info)`
    const r = parseInterfaceAuditorReport(text)
    expect(r.findings).toHaveLength(3)
    expect(r.findings.map(f => f.severity)).toEqual(['critical', 'major', 'info'])
    expect(r.findings.map(f => f.category)).toEqual([
      'ssot-violation',
      'leftover',
      'mock-drift',
    ])
  })

  it('lenient: parses single-quoted JSON (challenger parser fallback)', () => {
    const text = `STATUS: complete
FINDINGS: [{'severity':'critical','category':'ssot-violation','message':'foo'}]
NOTES: single-quote tolerance`
    const r = parseInterfaceAuditorReport(text)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].severity).toBe('critical')
  })

  it('lenient: parses inline ```json fenced findings (single-line)', () => {
    // 注意：challenger parser FINDINGS 提取 regex 只匹配单行；多行 fenced JSON
    // 不被支持。本测试覆盖单行 fence 用法（agent 实际产出建议都是单行）。
    const text = `STATUS: complete
FINDINGS: \`\`\`json [{"severity":"major","category":"leftover","message":"unused export"}] \`\`\`
NOTES: inline-fenced tolerance`
    const r = parseInterfaceAuditorReport(text)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].category).toBe('leftover')
  })

  it('unknown category → normalized to "unknown" (not dropped)', () => {
    const text = `STATUS: complete
FINDINGS: [{"severity":"info","category":"some-new-category","message":"x"}]
NOTES: extension category`
    const r = parseInterfaceAuditorReport(text)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].category).toBe('unknown')
    expect(r.findings[0].severity).toBe('info')
  })

  it('empty FINDINGS (best-effort: no FINDINGS line) treated as 0 findings', () => {
    const text = `STATUS: complete
NOTES: clean`
    const r = parseInterfaceAuditorReport(text)
    expect(r.status).toBe('complete')
    expect(r.findings).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. parseInterfaceAuditorReport — error / malformed inputs
// ---------------------------------------------------------------------------

describe('parseInterfaceAuditorReport — error paths', () => {
  it('STATUS=error → returns error with notes', () => {
    const text = `STATUS: error
FINDINGS: []
NOTES: ground-truth file unreadable`
    const r = parseInterfaceAuditorReport(text)
    expect(r.status).toBe('error')
    expect(r.notes).toContain('unreadable')
  })

  it('missing STATUS → status=error (no throw)', () => {
    const text = `FINDINGS: []
NOTES: malformed input`
    const r = parseInterfaceAuditorReport(text)
    expect(r.status).toBe('error')
    expect(r.notes).toMatch(/STATUS/i)
  })

  it('STATUS bogus value → status=error (parser tolerates malformed agent contract)', () => {
    const text = `STATUS: weird-value
FINDINGS: []
NOTES: agent contract violation`
    const r = parseInterfaceAuditorReport(text)
    expect(r.status).toBe('error')
  })

  it('preserves raw text for debug', () => {
    const text = `STATUS: complete
FINDINGS: []
NOTES: x`
    const r = parseInterfaceAuditorReport(text)
    expect(r.raw).toBe(text)
  })
})

// ---------------------------------------------------------------------------
// 4. severity helpers (severity-aware aggregation)
// ---------------------------------------------------------------------------

describe('criticalFindings / majorFindings / hasBlockingFindings', () => {
  const mixedReport = parseInterfaceAuditorReport(`STATUS: complete
FINDINGS: [{"severity":"critical","category":"ssot-violation","message":"a"}, {"severity":"critical","category":"magic-string-mismatch","message":"b"}, {"severity":"major","category":"leftover","message":"c"}, {"severity":"info","category":"mock-drift","message":"d"}]
NOTES: 4 findings`)

  it('criticalFindings: returns only critical-severity', () => {
    const c = criticalFindings(mixedReport)
    expect(c).toHaveLength(2)
    expect(c.every(f => f.severity === 'critical')).toBe(true)
  })

  it('majorFindings: returns only major-severity', () => {
    const m = majorFindings(mixedReport)
    expect(m).toHaveLength(1)
    expect(m[0].category).toBe('leftover')
  })

  it('hasBlockingFindings: true iff any critical', () => {
    expect(hasBlockingFindings(mixedReport)).toBe(true)

    const cleanReport = parseInterfaceAuditorReport(`STATUS: complete
FINDINGS: [{"severity":"info","category":"mock-drift","message":"x"}]
NOTES: info only`)
    expect(hasBlockingFindings(cleanReport)).toBe(false)

    const errorReport = parseInterfaceAuditorReport(`STATUS: error
FINDINGS: []
NOTES: failed`)
    expect(hasBlockingFindings(errorReport)).toBe(false) // error ≠ blocking; main thread escalates
  })

  it('hasBlockingFindings: false on 0-finding clean phase', () => {
    const r = parseInterfaceAuditorReport(`STATUS: complete
FINDINGS: []
NOTES: clean`)
    expect(hasBlockingFindings(r)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. alien-files-staged audit (v4.4 P34 — wave race detection)
// ---------------------------------------------------------------------------

describe('auditAlienFilesStaged + isFileInScope (v4.4 P34)', () => {
  const scope = {
    phaseId: 'phase-32',
    allowedPaths: [
      'templates/commands/autonomous.md',
      'templates/commands/agents/phase-runner.md',
      'src/utils/interface-auditor.ts',
      'src/utils/__tests__/interfaceAuditor.test.ts',
      '.claude/team-plan/phase-32-34-report.md',
    ],
  }

  it('clean: all staged files in scope → 0 findings', () => {
    const raw = `templates/commands/autonomous.md
src/utils/interface-auditor.ts
.claude/team-plan/phase-32-34-report.md`
    expect(auditAlienFilesStaged(raw, scope)).toEqual([])
  })

  it('detects alien staged file → 1 critical finding', () => {
    const raw = `templates/commands/autonomous.md
src/utils/wave-scheduler.ts
src/utils/interface-auditor.ts`
    const out = auditAlienFilesStaged(raw, scope)
    expect(out).toHaveLength(1)
    expect(out[0].severity).toBe('critical')
    expect(out[0].category).toBe('alien-files-staged')
    expect(out[0].message).toContain('wave-scheduler.ts')
    expect(out[0].message).toContain('phase-32')
  })

  it('multiple aliens listed in single finding (truncated to 5)', () => {
    const raw = [
      'templates/commands/autonomous.md',  // ok
      'src/foo1.ts', 'src/foo2.ts', 'src/foo3.ts',
      'src/foo4.ts', 'src/foo5.ts', 'src/foo6.ts', 'src/foo7.ts',
    ].join('\n')
    const out = auditAlienFilesStaged(raw, scope)
    expect(out).toHaveLength(1)
    expect(out[0].message).toMatch(/staged 7 alien file/)
    expect(out[0].message).toMatch(/\+2 more/)
  })

  it('glob ** matches recursively', () => {
    const recScope = {
      phaseId: 'phase-X',
      allowedPaths: ['src/utils/**'],
    }
    expect(isFileInScope('src/utils/foo.ts', recScope)).toBe(true)
    expect(isFileInScope('src/utils/sub/deep/bar.ts', recScope)).toBe(true)
    expect(isFileInScope('src/cli.ts', recScope)).toBe(false)
  })

  it('glob single * does not cross /', () => {
    const sScope = {
      phaseId: 'phase-X',
      allowedPaths: ['src/*.ts'],
    }
    expect(isFileInScope('src/cli.ts', sScope)).toBe(true)
    expect(isFileInScope('src/utils/foo.ts', sScope)).toBe(false)
  })

  it('directory-prefix path (trailing /) matches all under it', () => {
    const dScope = {
      phaseId: 'phase-X',
      allowedPaths: ['src/utils/'],
    }
    expect(isFileInScope('src/utils/foo.ts', dScope)).toBe(true)
    expect(isFileInScope('src/utils/sub/bar.ts', dScope)).toBe(true)
    expect(isFileInScope('src/cli.ts', dScope)).toBe(false)
  })

  it('Windows-style backslash paths normalized to forward slash', () => {
    const out = auditAlienFilesStaged(
      'src\\utils\\interface-auditor.ts',
      scope,
    )
    expect(out).toEqual([])  // backslash version still in scope
  })

  it('empty staged stdout → 0 findings (clean phase committed nothing yet)', () => {
    expect(auditAlienFilesStaged('', scope)).toEqual([])
    expect(auditAlienFilesStaged('\n  \n  \n', scope)).toEqual([])
  })
})
