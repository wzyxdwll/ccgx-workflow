/**
 * Skill Description Audit (v4.1-p19, ROI #2 / #3)
 *
 * Scans templates/skills/**\/SKILL.md and audits the `description` frontmatter
 * field. Flags descriptions that exceed the 80-character soft limit (descriptions
 * are loaded into Claude's context budget — long descriptions inflate every
 * conversation that touches the skill registry).
 *
 * Companion to v4.1-p19 skill system optimization:
 * - C1: this audit script + 80-char soft limit + 1% context budget warning
 * - C2: `context: fork` frontmatter on heavy skills (domains/, impeccable/)
 * - C3: `paths` filter on frontend-design skills
 * - A3: Chinese translation of impeccable descriptions (preserve trigger keywords)
 */

import { collectSkills, type SkillMeta } from './skill-registry'

// ═══════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════

/** Soft limit for description length (chars). Above this we flag for audit. */
export const DESCRIPTION_SOFT_LIMIT = 80

/**
 * 1% context budget threshold (in chars).
 * Default Claude context window ≈ 200k tokens ≈ 800k chars,
 * 1% ≈ 8000 chars. If total skill descriptions exceed this,
 * the registry alone consumes 1%+ of context on every load.
 */
export const CONTEXT_BUDGET_THRESHOLD = 8000

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export interface AuditRow {
  name: string
  category: string
  length: number
  overLimit: boolean
  description: string
}

export interface AuditReport {
  rows: AuditRow[]
  totalLength: number
  overLimitCount: number
  budgetExceeded: boolean
  budgetThreshold: number
}

// ═══════════════════════════════════════════════════════
// Audit core
// ═══════════════════════════════════════════════════════

/**
 * Audit a list of skill metadata records, producing per-row length + overall
 * budget analysis.
 */
export function auditSkillDescriptions(skills: SkillMeta[]): AuditReport {
  const rows: AuditRow[] = skills.map(s => ({
    name: s.name,
    category: s.category,
    length: s.description.length,
    overLimit: s.description.length > DESCRIPTION_SOFT_LIMIT,
    description: s.description,
  }))

  const totalLength = rows.reduce((sum, r) => sum + r.length, 0)
  const overLimitCount = rows.filter(r => r.overLimit).length

  return {
    rows,
    totalLength,
    overLimitCount,
    budgetExceeded: totalLength > CONTEXT_BUDGET_THRESHOLD,
    budgetThreshold: CONTEXT_BUDGET_THRESHOLD,
  }
}

/**
 * Convenience wrapper: scan a skills directory then audit its contents.
 */
export function auditSkillsDirectory(skillsDir: string): AuditReport {
  const skills = collectSkills(skillsDir)
  return auditSkillDescriptions(skills)
}

// ═══════════════════════════════════════════════════════
// Reporting
// ═══════════════════════════════════════════════════════

/**
 * Render a markdown table of the audit, sorted by length descending so the
 * worst offenders are at the top.
 */
export function renderAuditMarkdown(report: AuditReport): string {
  const sorted = [...report.rows].sort((a, b) => b.length - a.length)

  const lines: string[] = []
  lines.push('# Skill Description Audit')
  lines.push('')
  lines.push(
    `> Soft limit: ${DESCRIPTION_SOFT_LIMIT} chars per description. `
    + `Context budget threshold: ${report.budgetThreshold} chars (~1% of 200k token window).`,
  )
  lines.push('')
  lines.push(`- Total skills: **${report.rows.length}**`)
  lines.push(`- Total description length: **${report.totalLength}** chars`)
  lines.push(`- Over-limit skills: **${report.overLimitCount}**`)
  lines.push(
    `- Budget status: ${report.budgetExceeded ? '**EXCEEDED** ⚠️' : 'within budget ✅'}`,
  )
  lines.push('')
  lines.push('| Skill | Category | Length | Over Limit? |')
  lines.push('|-------|----------|--------|-------------|')

  for (const row of sorted) {
    lines.push(
      `| \`${row.name}\` | ${row.category} | ${row.length} | ${row.overLimit ? '⚠️ YES' : 'no'} |`,
    )
  }

  if (report.budgetExceeded) {
    lines.push('')
    lines.push(
      `> ⚠️ Total description length exceeds 1% context budget threshold (${report.budgetThreshold} chars). `
      + `Consider shortening over-limit descriptions while preserving trigger keywords.`,
    )
  }

  return lines.join('\n')
}
