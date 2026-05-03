# Migration Guide: CCG v4.0 → v4.1

**Released**: 2026-05-04
**Phase scope**: P13 (SessionStart hook) → P20 (codeagent-wrapper deprecation)

> v4.1 is a **使用体验精修** release. No data-shape breaking changes for end users; all template / command shrinkage is alias-preserving or skill-redirected.

---

## TL;DR

- **7 commands removed** from registry → 5 of them live on as `/ccg:team` sub-commands or `skills/`
- **1 new command**: `/ccg:debate` (multi-round propose/challenge/respond primitive)
- **`autonomous` default behavior reversed**: now wave-parallel by default; `--sequential` for opt-out
- **`codeagent-wrapper` shim deprecated** (still works in v4.1, target removal v5.0)
- **`ccg init --sync`** new flag: lists locally-installed CCG files no longer in templates, prompts to delete
- **Skill rule-engine paths consumer**: skills with `paths:` frontmatter only activate when project tree matches glob
- **SessionStart hook**: new sessions auto-inject `.ccg/roadmap.md` head + active phase SUMMARY into Claude Code memory

---

## Removed commands (and their replacements)

| Removed | Replacement | Notes |
|---------|-------------|-------|
| `/ccg:team-research` | `/ccg:team research <args>` | Sub-command of unified team workflow |
| `/ccg:team-plan` | `/ccg:team plan <args>` | Sub-command |
| `/ccg:team-review` | `/ccg:team review <args>` | Sub-command |
| `/ccg:health` | Skill auto-generated `/ccg:health` (from `templates/skills/tools/health/SKILL.md`) | Same UX, now skill-managed |
| `/ccg:map-codebase` | Skill auto-generated `/ccg:map-codebase` | Same UX, now skill-managed |
| `/ccg:extract-learnings` | Skill auto-generated `/ccg:extract-learnings` | New skill (was placeholder before) |
| `/ccg:forensics` | Skill auto-generated `/ccg:forensics` | New skill (was placeholder before) |

**Why**: independent invocation rate < 1/week per command (per opt-in telemetry survey 2026-04). Folding `team-*` into `/ccg:team` reduces the slash-command palette top-of-mind load by 5; converting `health` / `map-codebase` to skills keeps the slug `/ccg:<name>` working (auto-generated) but makes them rule-engine-aware (e.g. `/ccg:map-codebase` only surfaces in projects with multi-module structure).

**Action required**: none. All replacements preserve the `/ccg:<name>` slug. If you scripted `/ccg:team-research foo` in CI, change to `/ccg:team research foo`.

---

## New command: `/ccg:debate`

Multi-round propose / challenge / respond debate primitive. Two roles (default codex vs gemini) iterate up to N rounds or until both report "no critical issues remain".

```bash
/ccg:debate "Should we use eventual consistency for the order ledger?"
/ccg:debate --rounds=3 --propose=codex --challenge=gemini "..."
```

Output: `.context/debate/<slug>.md` with the full transcript + final synthesis.

---

## `autonomous` default behavior reversed (v4.1-P14)

**Before (v4.0)**:
```bash
/ccg:autonomous              # sequential one-phase-at-a-time
/ccg:autonomous --parallel   # opt-in wave parallel
```

**After (v4.1)**:
```bash
/ccg:autonomous                  # default: wave parallel (Kahn topo sort)
/ccg:autonomous --sequential     # opt-out (matches v4.0 default)
/ccg:autonomous --max-concurrent 4   # cap parallel phases per wave (default 4)
```

**Wall-clock reduction**: 30-40% on the v4.0 12-phase dogfood roadmap.

**Action required**: if you relied on phases finishing in roadmap order for side-effects (e.g. P3 must finish before P4 starts even though P3 is not in P4's `Depends on:` list), add the explicit dependency to the phase frontmatter or pass `--sequential`.

---

## `codeagent-wrapper` shim deprecation (v4.1-P20)

The `~/.claude/bin/codeagent-wrapper` shim and its companion `invoke-model.mjs` Node script are now **deprecated**.

- ✅ **v4.1**: still ships, still works for all 6 core commands (workflow, plan, execute, debug, review, optimize)
- 🚫 **v5.0**: planned removal. Commands will spawn plugins directly via `Agent(subagent_type="codex:codex-rescue")` etc.

**Action required**:
- Install Anthropic-official Codex plugin (`codex:codex-rescue`) and Gemini plugin (`gemini:gemini-rescue`) when convenient.
- v4.1 already prefers plugin spawn paths where available — your existing wrapper-based commands keep working.
- Watch v5.0 release notes; if your `~/.claude/.ccg/scripts/invoke-model.mjs` has been customized, plan to migrate that logic before v5.0 lands.

See `.ccg-research/07-multimodel-collaboration-rethink.md` for the full rationale (engine-layer subagent nesting constraints discovered in v4.0.1).

---

## `ccg init --sync` (new in v4.1-P18)

Lists files installed under `~/.claude/{commands,agents,skills}/ccg/` that no longer exist in current bundled templates, then **prompts** before deleting.

```bash
ccg init --sync                # interactive prune
ccg init --sync --skip-prompt  # report-only (does NOT delete)
```

Critical safety properties:

- Only touches files **inside `ccg/` namespace** — your hand-authored `~/.claude/commands/my-private.md` is never seen.
- Never auto-deletes; always asks for confirmation per-batch.
- Skill-generated commands (e.g. `/ccg:health` derived from `skills/tools/health/SKILL.md`) are recognized and NOT flagged stale.

**Recommended after every major version bump**:

```bash
npx ccg-workflow@latest init     # install new version
npx ccg-workflow init --sync     # clean up stale entries from prior versions
```

---

## Skill rule-engine `paths:` consumer (v4.1-P19/P18)

Skills can now declare `paths:` in their frontmatter to limit activation to projects matching a glob pattern.

```yaml
---
name: react-polish
paths: "*.tsx, *.jsx"
user-invocable: true
---
```

When the user types `/`, the skill rule-engine walks the project tree (cap 5000 files, skips node_modules / .git / dist / etc.) and only surfaces `react-polish` if at least one `.tsx` or `.jsx` file exists.

Empty `paths:` (or omitted field) = unconditional activation (existing behavior preserved).

---

## SessionStart hook (v4.1-P13)

New `~/.claude/hooks/ccg-session-state.cjs` runs at every Claude Code session start. It auto-injects:

1. The first 20 lines of `.ccg/roadmap.md` (if present)
2. The frontmatter of `.context/<active-phase>/SUMMARY.md` (if present)

Total budget: **< 200 tokens** (precomputed). Solves the "v4.0 main thread had zero project memory after `/clear`" pain point.

**Action required**: none. Auto-installed by `ccg init` on v4.1+.

---

## Validation checklist post-upgrade

```bash
# 1. Install v4.1
npx ccg-workflow@latest init

# 2. Prune stale files
npx ccg-workflow init --sync

# 3. Verify command palette
ls ~/.claude/commands/ccg/ | wc -l   # expect ~22 commands + skill-auto-generated
```

---

## Numerical deltas

| Metric | v4.0 | v4.1 |
|--------|------|------|
| Registered commands (installer-data.ts) | 33 | 28 |
| User-facing slash commands (incl. skill-auto-gen) | ~31 | ~26 |
| Subagents | 19 | 19 |
| Skills shipped (top-level dirs) | 30 | 34 (+health, +map-codebase, +extract-learnings, +forensics) |
| Tests | 757 | 775+ |
| SessionStart hook | — | ✓ |
| autonomous default | sequential | parallel |

---

**Questions / issues**: file at https://github.com/wangzy-ai/ccg-workflow/issues
