/**
 * Phase-scoped context state machine (v4.0 Phase 2).
 *
 * Manages `.context/<phase>/{CONTEXT,SUMMARY}.md` files that decouple the
 * orchestrator (main thread) from builder subagents:
 *
 * - CONTEXT.md  — frozen decisions from /ccg:plan, consumed by downstream
 *                 plan/exec stages. Markdown body is human-readable; YAML
 *                 frontmatter is machine-readable.
 * - SUMMARY.md  — machine-readable frontmatter written by /ccg:execute
 *                 (and team-exec) after each plan completes. The orchestrator
 *                 reads ONLY the frontmatter (< 200 tokens / phase) instead of
 *                 piping back the full builder stdout.
 *
 * Token budget contract: parsing 5 SUMMARY.md frontmatters MUST stay < 1000
 * tokens of orchestrator context (the `summaryTokenEstimate` helper makes this
 * empirically verifiable in unit tests).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PhaseContext {
  phase: string
  plan: string
  goal: string
  decisions: string[]
  constraints: string[]
  files: string[]
  createdAt: string
}

export interface PhaseSummary {
  phase: string
  plan: string
  provides: string[]
  affects: string[]
  keyFiles: string[]
  completed: boolean
  completedAt?: string
  notes?: string
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the directory holding phase-scoped state files.
 * Convention: `<workdir>/.context/<phase>/`.
 */
export function phaseDir(workdir: string, phase: string): string {
  return join(workdir, '.context', sanitizePhase(phase))
}

export function contextPath(workdir: string, phase: string): string {
  return join(phaseDir(workdir, phase), 'CONTEXT.md')
}

export function summaryPath(workdir: string, phase: string): string {
  return join(phaseDir(workdir, phase), 'SUMMARY.md')
}

/**
 * Strip filesystem-hostile characters from a phase id so it can be used as a
 * directory name on Windows / macOS / Linux. Keeps alphanumerics, dashes,
 * underscores and dots; collapses everything else to `-`.
 */
export function sanitizePhase(phase: string): string {
  return phase.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

// ---------------------------------------------------------------------------
// Frontmatter parsing / serialization (minimal YAML — string scalars + list)
// ---------------------------------------------------------------------------

/**
 * Extract the YAML frontmatter block from a Markdown file. Returns `null` if
 * the file does not start with `---\n`.
 */
export function extractFrontmatter(content: string): string | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return m ? m[1] : null
}

/**
 * Parse a small subset of YAML — enough for SUMMARY.md frontmatter:
 *
 *   key: scalar value
 *   key: [a, b, c]
 *   key:
 *     - a
 *     - b
 *
 * Quoted strings (single or double) are unwrapped. No anchors, no nested maps.
 * Throws on malformed input — keeps parser small and predictable.
 */
export function parseFrontmatterFields(yaml: string): Record<string, string | string[] | boolean> {
  const out: Record<string, string | string[] | boolean> = {}
  const lines = yaml.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) {
      i += 1
      continue
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
    if (!match) {
      throw new Error(`phase-context: malformed frontmatter line: ${line}`)
    }
    const key = match[1]
    const rest = match[2].trim()
    if (rest === '') {
      // Block list follows
      const items: string[] = []
      i += 1
      while (i < lines.length && /^\s+-\s+/.test(lines[i])) {
        items.push(unquote(lines[i].replace(/^\s+-\s+/, '').trim()))
        i += 1
      }
      out[key] = items
      continue
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim()
      out[key] = inner ? inner.split(',').map(s => unquote(s.trim())) : []
    }
    else if (rest === 'true' || rest === 'false') {
      out[key] = rest === 'true'
    }
    else {
      out[key] = unquote(rest)
    }
    i += 1
  }
  return out
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('\'') && s.endsWith('\''))) {
    return s.slice(1, -1)
  }
  return s
}

function serializeScalar(value: string): string {
  // Quote when value contains YAML-meaningful chars
  if (/[:#\[\],&*!|>'"%@`]/.test(value) || value === '' || /^\s|\s$/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`
  }
  return value
}

function serializeList(values: string[]): string {
  if (values.length === 0)
    return '[]'
  return `[${values.map(serializeScalar).join(', ')}]`
}

// ---------------------------------------------------------------------------
// CONTEXT.md (frozen plan decisions)
// ---------------------------------------------------------------------------

/**
 * Write `.context/<phase>/CONTEXT.md` capturing the frozen decisions from
 * /ccg:plan. The body is plain Markdown so it remains diffable; the
 * frontmatter is the machine-readable contract.
 */
export function writeContext(workdir: string, ctx: PhaseContext): string {
  const target = contextPath(workdir, ctx.phase)
  mkdirSync(dirname(target), { recursive: true })

  const frontmatter = [
    '---',
    `phase: ${serializeScalar(ctx.phase)}`,
    `plan: ${serializeScalar(ctx.plan)}`,
    `goal: ${serializeScalar(ctx.goal)}`,
    `decisions: ${serializeList(ctx.decisions)}`,
    `constraints: ${serializeList(ctx.constraints)}`,
    `files: ${serializeList(ctx.files)}`,
    `created_at: ${serializeScalar(ctx.createdAt)}`,
    '---',
    '',
  ].join('\n')

  const body = [
    `# Phase Context: ${ctx.phase}`,
    '',
    `**Plan**: ${ctx.plan}`,
    `**Goal**: ${ctx.goal}`,
    '',
    '## Decisions (frozen)',
    ...(ctx.decisions.length ? ctx.decisions.map(d => `- ${d}`) : ['_(none)_']),
    '',
    '## Constraints',
    ...(ctx.constraints.length ? ctx.constraints.map(c => `- ${c}`) : ['_(none)_']),
    '',
    '## Files',
    ...(ctx.files.length ? ctx.files.map(f => `- \`${f}\``) : ['_(none)_']),
    '',
  ].join('\n')

  writeFileSync(target, frontmatter + body, 'utf8')
  return target
}

export function readContext(workdir: string, phase: string): PhaseContext | null {
  const target = contextPath(workdir, phase)
  if (!existsSync(target))
    return null
  const content = readFileSync(target, 'utf8')
  const fm = extractFrontmatter(content)
  if (!fm)
    return null
  const fields = parseFrontmatterFields(fm)
  return {
    phase: String(fields.phase ?? phase),
    plan: String(fields.plan ?? ''),
    goal: String(fields.goal ?? ''),
    decisions: toList(fields.decisions),
    constraints: toList(fields.constraints),
    files: toList(fields.files),
    createdAt: String(fields.created_at ?? ''),
  }
}

// ---------------------------------------------------------------------------
// SUMMARY.md (machine-readable phase outcome)
// ---------------------------------------------------------------------------

/**
 * Write `.context/<phase>/SUMMARY.md`. The orchestrator must be able to make
 * advance / retry / skip decisions reading ONLY this file's frontmatter.
 *
 * Frontmatter fields (acceptance b):
 *   phase, plan, provides, affects, key-files (key_files), completed,
 *   completed_at, notes
 */
export function writeSummary(workdir: string, summary: PhaseSummary): string {
  const target = summaryPath(workdir, summary.phase)
  mkdirSync(dirname(target), { recursive: true })

  const frontmatter = [
    '---',
    `phase: ${serializeScalar(summary.phase)}`,
    `plan: ${serializeScalar(summary.plan)}`,
    `provides: ${serializeList(summary.provides)}`,
    `affects: ${serializeList(summary.affects)}`,
    `key_files: ${serializeList(summary.keyFiles)}`,
    `completed: ${summary.completed ? 'true' : 'false'}`,
    ...(summary.completedAt ? [`completed_at: ${serializeScalar(summary.completedAt)}`] : []),
    ...(summary.notes ? [`notes: ${serializeScalar(summary.notes)}`] : []),
    '---',
    '',
  ].join('\n')

  const body = [
    `# Phase Summary: ${summary.phase}`,
    '',
    `**Plan**: ${summary.plan}  `,
    `**Status**: ${summary.completed ? 'completed' : 'in-progress'}`,
    summary.completedAt ? `**Completed**: ${summary.completedAt}` : '',
    '',
    '## Provides',
    ...(summary.provides.length ? summary.provides.map(p => `- ${p}`) : ['_(none)_']),
    '',
    '## Affects',
    ...(summary.affects.length ? summary.affects.map(a => `- ${a}`) : ['_(none)_']),
    '',
    '## Key files',
    ...(summary.keyFiles.length ? summary.keyFiles.map(f => `- \`${f}\``) : ['_(none)_']),
    '',
    summary.notes ? `## Notes\n\n${summary.notes}\n` : '',
  ].filter(Boolean).join('\n')

  writeFileSync(target, frontmatter + body, 'utf8')
  return target
}

export function readSummary(workdir: string, phase: string): PhaseSummary | null {
  const target = summaryPath(workdir, phase)
  if (!existsSync(target))
    return null
  const content = readFileSync(target, 'utf8')
  const fm = extractFrontmatter(content)
  if (!fm)
    return null
  const fields = parseFrontmatterFields(fm)
  return {
    phase: String(fields.phase ?? phase),
    plan: String(fields.plan ?? ''),
    provides: toList(fields.provides),
    affects: toList(fields.affects),
    keyFiles: toList(fields.key_files),
    completed: fields.completed === true,
    completedAt: fields.completed_at ? String(fields.completed_at) : undefined,
    notes: fields.notes ? String(fields.notes) : undefined,
  }
}

/**
 * Read only the frontmatter block of SUMMARY.md without parsing the body.
 * This is the path orchestrators (autonomous, team-exec) must take to keep
 * context usage bounded.
 *
 * Returns the frontmatter raw text, or `null` if the file does not exist.
 */
export function readSummaryFrontmatter(workdir: string, phase: string): string | null {
  const target = summaryPath(workdir, phase)
  if (!existsSync(target))
    return null
  const content = readFileSync(target, 'utf8')
  return extractFrontmatter(content)
}

// ---------------------------------------------------------------------------
// Token estimation (cheap heuristic — 1 token ≈ 4 chars for English/CJK mix)
// ---------------------------------------------------------------------------

/**
 * Estimate the orchestrator token cost of reading a frontmatter block.
 * Conservative heuristic: ceil(chars / 3.5). Not exact tokenization, but
 * tight enough that test assertions stay valid against real tokenizers.
 */
export function summaryTokenEstimate(frontmatter: string): number {
  return Math.ceil(frontmatter.length / 3.5)
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function toList(value: unknown): string[] {
  if (Array.isArray(value))
    return value.map(String)
  if (typeof value === 'string' && value)
    return [value]
  return []
}
