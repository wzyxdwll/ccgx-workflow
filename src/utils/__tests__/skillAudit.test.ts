import fs from 'fs-extra'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  auditSkillDescriptions,
  auditSkillsDirectory,
  CONTEXT_BUDGET_THRESHOLD,
  DESCRIPTION_SOFT_LIMIT,
  renderAuditMarkdown,
} from '../skill-description-audit'
import { collectSkills, parseFrontmatter, type SkillMeta } from '../skill-registry'

describe('skill-description-audit (v4.1-p19)', () => {
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(join(tmpdir(), 'skill-audit-'))
  })

  afterEach(async () => {
    await fs.remove(tmpRoot)
  })

  async function writeSkill(relPath: string, frontmatter: string) {
    const dir = join(tmpRoot, relPath)
    await fs.ensureDir(dir)
    await fs.writeFile(
      join(dir, 'SKILL.md'),
      `---\n${frontmatter}\n---\n\n# Skill body\n`,
      'utf-8',
    )
  }

  // ─── parseFrontmatter: new context/paths fields ────────────

  describe('parseFrontmatter — context/paths fields', () => {
    it('parses context: fork', () => {
      const meta = parseFrontmatter(
        `---\nname: foo\ndescription: x\nuser-invocable: false\ncontext: fork\n---`,
      )
      expect(meta).not.toBeNull()
      expect(meta!.context).toBe('fork')
    })

    it('parses paths field with comma-separated globs', () => {
      const meta = parseFrontmatter(
        `---\nname: foo\ndescription: x\npaths: "*.tsx,*.vue,*.css"\n---`,
      )
      expect(meta).not.toBeNull()
      expect(meta!.paths).toBe('*.tsx,*.vue,*.css')
    })
  })

  // ─── collectSkills: SkillMeta.context / .paths ─────────────

  describe('collectSkills — extracts context/paths into SkillMeta', () => {
    it('defaults context to "inline" when not specified', async () => {
      await writeSkill('plain', `name: plain\ndescription: lightweight skill`)
      const skills = collectSkills(tmpRoot)
      expect(skills).toHaveLength(1)
      expect(skills[0].context).toBe('inline')
      expect(skills[0].paths).toEqual([])
    })

    it('parses context: fork into SkillMeta.context', async () => {
      await writeSkill(
        'heavy',
        `name: heavy\ndescription: heavy skill\ncontext: fork`,
      )
      const skills = collectSkills(tmpRoot)
      expect(skills).toHaveLength(1)
      expect(skills[0].context).toBe('fork')
    })

    it('rejects unknown context values, falling back to inline', async () => {
      await writeSkill(
        'weird',
        `name: weird\ndescription: weird skill\ncontext: spawn`,
      )
      const skills = collectSkills(tmpRoot)
      expect(skills[0].context).toBe('inline')
    })

    it('parses paths into glob array', async () => {
      await writeSkill(
        'frontend',
        `name: frontend\ndescription: frontend skill\npaths: "*.tsx,*.vue,*.css"`,
      )
      const skills = collectSkills(tmpRoot)
      expect(skills[0].paths).toEqual(['*.tsx', '*.vue', '*.css'])
    })

    it('handles whitespace and empty entries in paths', async () => {
      await writeSkill(
        'ws',
        `name: ws\ndescription: x\npaths: "*.ts, *.js , ,*.css"`,
      )
      const skills = collectSkills(tmpRoot)
      expect(skills[0].paths).toEqual(['*.ts', '*.js', '*.css'])
    })
  })

  // ─── auditSkillDescriptions ────────────────────────────────

  describe('auditSkillDescriptions', () => {
    function makeSkill(name: string, description: string): SkillMeta {
      return {
        name,
        description,
        userInvocable: false,
        allowedTools: ['Read'],
        argumentHint: '',
        aliases: [],
        category: 'domain',
        runtimeType: 'knowledge',
        relPath: `domains/${name}`,
        skillPath: `/fake/${name}/SKILL.md`,
        scriptPath: null,
        context: 'inline',
        paths: [],
      }
    }

    it('flags descriptions over 80-char soft limit', () => {
      const long = 'x'.repeat(DESCRIPTION_SOFT_LIMIT + 5)
      const short = 'x'.repeat(DESCRIPTION_SOFT_LIMIT - 5)
      const report = auditSkillDescriptions([
        makeSkill('a', long),
        makeSkill('b', short),
      ])
      expect(report.overLimitCount).toBe(1)
      expect(report.rows.find(r => r.name === 'a')!.overLimit).toBe(true)
      expect(report.rows.find(r => r.name === 'b')!.overLimit).toBe(false)
    })

    it('computes total length correctly', () => {
      const report = auditSkillDescriptions([
        makeSkill('a', 'abc'),
        makeSkill('b', 'defg'),
      ])
      expect(report.totalLength).toBe(7)
    })

    it('flags budget exceeded when total > 1% threshold', () => {
      // Create enough skills to blow past CONTEXT_BUDGET_THRESHOLD chars total
      const big = 'x'.repeat(500)
      const skills = Array.from({ length: 20 }, (_, i) =>
        makeSkill(`s${i}`, big))
      const report = auditSkillDescriptions(skills)
      expect(report.totalLength).toBeGreaterThan(CONTEXT_BUDGET_THRESHOLD)
      expect(report.budgetExceeded).toBe(true)
    })

    it('reports within-budget for small registries', () => {
      const report = auditSkillDescriptions([
        makeSkill('a', 'short'),
        makeSkill('b', 'also short'),
      ])
      expect(report.budgetExceeded).toBe(false)
    })
  })

  // ─── renderAuditMarkdown ───────────────────────────────────

  describe('renderAuditMarkdown', () => {
    it('renders a markdown table with header + rows', async () => {
      await writeSkill('alpha', `name: alpha\ndescription: short`)
      await writeSkill('beta', `name: beta\ndescription: ${'x'.repeat(100)}`)
      const report = auditSkillsDirectory(tmpRoot)
      const md = renderAuditMarkdown(report)

      expect(md).toContain('# Skill Description Audit')
      expect(md).toContain('| Skill | Category | Length | Over Limit?')
      expect(md).toContain('alpha')
      expect(md).toContain('beta')
      // Over-limit row should show warning emoji
      expect(md).toMatch(/beta.*⚠️ YES/)
    })

    it('emits budget-exceeded warning when over 1% threshold', () => {
      const long = 'x'.repeat(1000)
      const skills = Array.from({ length: 10 }, (_, i) => ({
        name: `s${i}`,
        description: long,
        userInvocable: false,
        allowedTools: ['Read'],
        argumentHint: '',
        aliases: [],
        category: 'domain' as const,
        runtimeType: 'knowledge' as const,
        relPath: `domains/s${i}`,
        skillPath: `/x/s${i}/SKILL.md`,
        scriptPath: null,
        context: 'inline' as const,
        paths: [],
      }))
      const report = auditSkillDescriptions(skills)
      const md = renderAuditMarkdown(report)
      expect(md).toMatch(/EXCEEDED/)
    })
  })
})

// ─── Real templates audit: regression guard for v4.1-p19 ──────

describe('templates/skills audit (real registry)', () => {
  const SKILLS_DIR = join(__dirname, '../../../templates/skills')

  it('all 20 impeccable descriptions are ≤ 80 chars after translation', () => {
    const skills = collectSkills(SKILLS_DIR)
    const impeccable = skills.filter(s => s.category === 'impeccable')
    expect(impeccable.length).toBe(20)
    for (const s of impeccable) {
      expect(
        s.description.length,
        `Impeccable skill "${s.name}" description too long (${s.description.length} chars): "${s.description}"`,
      ).toBeLessThanOrEqual(DESCRIPTION_SOFT_LIMIT)
    }
  })

  it('all 20 impeccable descriptions still contain the trigger keyword (skill name)', () => {
    const skills = collectSkills(SKILLS_DIR)
    const impeccable = skills.filter(s => s.category === 'impeccable')
    for (const s of impeccable) {
      // The skill name (e.g. "polish", "harden") must remain in description
      // so keyword routing still triggers post-Chinese-translation.
      expect(
        s.description.toLowerCase(),
        `Impeccable skill "${s.name}" lost its trigger keyword in description: "${s.description}"`,
      ).toContain(s.name.toLowerCase())
    }
  })

  it('all 20 impeccable skills have context: fork', () => {
    const skills = collectSkills(SKILLS_DIR)
    const impeccable = skills.filter(s => s.category === 'impeccable')
    for (const s of impeccable) {
      expect(s.context, `Impeccable skill "${s.name}" missing context: fork`).toBe('fork')
    }
  })

  it('all domain SKILL.md (10 + 4 frontend-design substyles) have context: fork', () => {
    const skills = collectSkills(SKILLS_DIR)
    const domain = skills.filter(s => s.category === 'domain')
    expect(domain.length).toBeGreaterThanOrEqual(14)
    for (const s of domain) {
      expect(s.context, `Domain skill "${s.name}" missing context: fork`).toBe('fork')
    }
  })

  it('frontend-design root + 4 substyles have paths filter for *.tsx/*.vue/*.css', () => {
    const skills = collectSkills(SKILLS_DIR)
    const frontendDesign = skills.filter(
      s => s.relPath.replace(/\\/g, '/').includes('frontend-design'),
    )
    expect(frontendDesign.length).toBe(5) // root + 4 substyles
    for (const s of frontendDesign) {
      expect(
        s.paths.length,
        `Frontend-design skill "${s.name}" missing paths filter`,
      ).toBeGreaterThan(0)
      // Must filter at least one frontend file extension
      const allPaths = s.paths.join(',')
      expect(allPaths).toMatch(/tsx|jsx|vue|svelte|css|scss/)
    }
  })

  it('renders a non-empty audit report on the real registry', () => {
    const report = auditSkillsDirectory(SKILLS_DIR)
    const md = renderAuditMarkdown(report)
    expect(report.rows.length).toBeGreaterThan(20)
    expect(md).toContain('# Skill Description Audit')
  })
})
