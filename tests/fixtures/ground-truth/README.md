# Ground Truth Fixtures

Hand-curated **representative** samples of the external interfaces CCG depends on,
used to drive unit tests with real-schema mock data instead of inline assumptions.

## Why this directory exists

The v4.0 → v4.2 dogfood exposed a quality gap: **mock data self-consistent ≠
real-world correct**. Examples that single-test passes hid:

- `codex:codex-rescue` vs. `codex:rescue` namespace separation (v4.4.1 hotfix) —
  the **real** Agent(subagent_type=...) name is the **double-prefix**
  `codex:codex-rescue` / `gemini:gemini-rescue`; the **single-prefix**
  `codex:rescue` / `gemini:rescue` is the **Skill** name. CCG v4.0–4.4.0
  consistently used the wrong (single-prefix) string for Agent spawn calls;
  fixtures + interface-auditor reference data also stored the wrong direction,
  so internal cross-validation passed while real plugin spawn failed.
- SessionStart hook `matcher` field type guess (string vs. array vs. absent) —
  inline tests assumed array, real Claude Code engine accepts string `""`.
- `package.json` `files` whitelist drift — `templates/commands/debate.md` shipped
  to git but missing from npm tarball (v4.2.2 fix `3fa6be8`).

Fixtures here capture **real-schema snapshots** so unit tests can validate
parsers/routers against shapes that match what users actually have.

## Files

| File | Source schema | Used by |
|------|---------------|---------|
| `installed_plugins.sample.json` | `~/.claude/plugins/installed_plugins.json` (v2 schema) | `groundTruthSampler.test.ts`, `fixturesIntegrity.test.ts` |
| `settings.sample.json` | `~/.claude/settings.json` hooks section (multi-event, mixed matcher types) | `groundTruthSampler.test.ts`, `fixturesIntegrity.test.ts` |
| `skills.sample.json` | Resulting `SkillInfo[]` from `sampleSkillList()` (12 mixed user-invocable) | `fixturesIntegrity.test.ts` |
| `agent-summaries.sample.json` | Raw text returned by challenger/verify/debate subagents | `challengerOrchestrator.test.ts`, `verifyOrchestrator.test.ts`, `debateOrchestrator.test.ts` |

## Anonymization

All paths in fixtures replace OS user-specific segments with `<HOME>` placeholder:

- Real: `C:/Users/Administrator/.claude/plugins/...`
- Fixture: `<HOME>/.claude/plugins/...`

This keeps fixtures portable across machines/CI and avoids leaking usernames.

## Regenerating fixtures

When the underlying interface schema changes (e.g., Claude Code adds a new hook
event, plugin manifest format bumps), run:

```bash
pnpm regen-fixtures
```

The `scripts/regen-fixtures.ts` helper:

1. Calls `sampleAll()` against the current `~/.claude/`
2. Anonymizes paths (`<HOMEDIR>/.claude/...` → `<HOME>/.claude/...`)
3. Writes JSON to this directory

After regenerating, **manually review** the diff: representative fixtures should
contain a *diverse* set of shapes (e.g., both `matcher: "string"` and
`matcher: null` hooks), not just whatever happens to be installed on one
machine. Hand-edit if your environment is too narrow.

## Test contract

`fixturesIntegrity.test.ts` asserts:

- Each sample file exists and parses as valid JSON
- Schema matches `samplePluginList` / `sampleHookSchema` / etc. expectations
- Anonymized paths use `<HOME>` not real usernames

If a fixture file is renamed or schema-changed, update the integrity test +
the README table above in the same commit.
