# Phase 13 Offload Report — SessionStart hook + 项目记忆自动注入

**Status**: completed
**Phase ID**: phase-13-session-state-hook
**Baseline**: cf75d70 (Phase 14 commit, used as anchor)
**Worktree**: D:/workflow/ccg-workflow

## Files modified

| File | Type | Notes |
|------|------|-------|
| `templates/hooks/ccg-session-state.cjs` | new | The hook itself. CJS extension chosen so Node treats it as CommonJS regardless of any ancestor `package.json` `type: "module"` (the repo root has it; existing `.js` hooks accidentally only work because they are deployed to `~/.claude/hooks/` where no such ancestor exists). |
| `src/utils/installer-hooks.ts` | modify | (1) Added `'ccg-session-state.cjs'` to `HOOK_FILES`. (2) Added `SESSION_START_TIMEOUT_SEC = 15`. (3) `patchSettingsJson()` now appends an idempotent `hooks.SessionStart` entry pointing at the new hook. (4) `uninstallHooks()` strips SessionStart entries referencing `ccg-session-state` and prunes empty hook keys. |
| `src/utils/__tests__/sessionStateHook.test.ts` | new | 21 tests covering parseRoadmapHead / parsePhases / pickActivePhase / phaseDirName / parseSummaryFrontmatter / composeMessage + 6 integration tests for `buildAdditionalContext`. |

**No changes to** `src/utils/installer-data.ts` — the phase prompt named that file, but settings.json hook registration logic lives in `installer-hooks.ts` (which the prompt did not mention but which is the only correct place). The change is scope-equivalent: a single new SessionStart registration block, sibling to the existing PostToolUse / statusLine blocks. **No changes to** `src/index.ts` — the hook is a runtime CJS script under `templates/hooks/`, not part of the TypeScript library API surface. There is nothing meaningful to re-export.

## Acceptance verification matrix

| Criterion | Status | Evidence |
|-----------|--------|----------|
| (a) `templates/hooks/ccg-session-state.cjs` exists, SessionStart hook entrypoint | PASS | File written, exports `buildAdditionalContext` + 5 helpers. `require.main === module` guard runs `main()` only when invoked as a script. |
| (a) Detects cwd `.ccg/roadmap.md`; noop if absent | PASS | `buildAdditionalContext` returns null on missing file; `main()` emits `{}`. Smoke test on `/tmp` → `{}` exit 0. Test "returns null when cwd is not a CCG project" passes. |
| (a) Reads roadmap head metadata | PASS | `parseRoadmapHead` extracts Project / Started / Last Updated from first 30 lines. Two unit tests cover present / absent metadata. |
| (a) Scans `## Phase N: ... (status)` headers; finds first `in_progress` | PASS | `parsePhases` regex captures id (incl. decimal `1.5`) + title (with optional `[offload]` tag) + status. `pickActivePhase` prefers in_progress, then pending, else null. 5 unit tests + 6 integration tests. |
| (a) Reads `.context/<phase-id>/SUMMARY.md` frontmatter when present | PASS | `parseSummaryFrontmatter` strips quotes, ignores comments. `buildAdditionalContext` calls it conditionally with `existsSync` check. Integration test "injects the active phase and SUMMARY.md frontmatter when both exist" passes. |
| (a) Assembles concise summary string | PASS | `composeMessage` outputs `Project / Phases X/Y completed / Active phase / Provides / Next action / hint to read roadmap`. Hard-capped at 800 chars (token-budget honoring). Smoke test against real `.ccg/roadmap.md` returns 360-char message. |
| (a) Failure tolerance | PASS | Every fs/JSON op wrapped in try/catch; falls through to noop on roadmap parse failure. Stdin timeout 10s mirrors existing hook pattern. `parsePhases` ignores malformed lines (test case verifies). |
| (b) settings.json registers SessionStart hook | PASS | `installer-hooks.ts:patchSettingsJson` appends `{matcher: '', hooks: [{type: 'command', command: node "<path>", timeout: 15}]}` to `hooks.SessionStart`. Idempotent via command substring match. Uninstall path symmetrically strips. |
| (c) Unit tests cover all listed scenarios | PASS | 21/21 passing. Scenarios: schema correctness, missing roadmap → noop, in_progress + SUMMARY.md → injection, all completed → "All phases completed", missing SUMMARY.md → fallback, malformed phase line ignored, completed/total ratio reported. |
| (d) Hook behavior documented for Phase 18 integration | PASS | This report's "Hook behavior reference" section below. |

## Test / typecheck / build

| Gate | Result | Notes |
|------|--------|-------|
| `pnpm typecheck` | PASS | Clean exit, no diagnostics. |
| `pnpm test` | PASS | 21 test files / **634 tests** all green (was 613 pre-phase; +21 new). Includes existing `installer-hooks.ts` test ("installs context-monitor + statusline hook files with shebang") which still passes despite my additions — confirms no regression on prior settings.json patching. |
| `pnpm build` | PASS | unbuild produces dist/cli.mjs (234 kB) + dist/index.mjs (241 kB). |
| Smoke test (CCG project cwd) | PASS | `echo '{"hookEventName":"SessionStart","cwd":"D:/workflow/ccg-workflow"}' \| node templates/hooks/ccg-session-state.cjs` returns valid hookSpecificOutput JSON with expected message format. |
| Smoke test (non-CCG cwd) | PASS | `cwd: /tmp` returns `{}` exit 0 — true noop. |

## Hook behavior reference (for Phase 18 integration)

When a session starts, Claude Code spawns `node "<install-dir>/hooks/ccg-session-state.cjs"` with stdin set to a JSON envelope containing at least `{ hookEventName: 'SessionStart', session_id, cwd? }`. The hook:

1. Reads stdin until close (10 s timeout fallback).
2. Resolves cwd from input JSON `cwd` field if present, else `process.cwd()`.
3. If `<cwd>/.ccg/roadmap.md` does not exist → emits `{}` and exits (non-CCG project).
4. Else parses roadmap head (Project / Started / Last Updated) + every `## Phase N: title (status)` header.
5. Picks the first in_progress phase (or first pending; or null when all done).
6. If an active phase has a matching `<cwd>/.context/phase-<NN>-<slug>/SUMMARY.md`, parses its frontmatter for `provides` / `next-action` keys.
7. Composes a ≤ 800-char message lines: project + phase counts → active/next phase → provides/next action → "Read .ccg/roadmap.md" hint.
8. Emits:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "<message>"
  }
}
```

The same module also exports the pure helpers (`module.exports = { ... }`) for unit tests. Production behavior is gated by `require.main === module` so importing it never triggers stdin reads.

## Critical issues

None.

## Major issues

None.

## Minor issues / future work

- Phase dir slug heuristic in the hook (`phase-NN-<slug>` from the roadmap title) is a best-effort match. If a phase author chooses a different `.context/<dir>/` name, the SUMMARY.md fallback path silently degrades to "no provides/next-action injected" — the roadmap-based summary still injects fine. A v4.2 follow-up could read `.ccg/state.md` (Phase 14 wave state file) to get a definitive phase→dir mapping.
- The hook does not currently consult `.ccg/state.md` for wave progress. The phase prompt mentioned it as a "could read" item; defer to Phase 14's state machine consumers if needed (Phase 18 collation can decide).
- `templates/hooks/` already in `package.json` `files` glob, so the new `.cjs` ships automatically with `npm publish`. No package.json change required.

## Pending handoff

None — git commit, tests, typecheck, and build all completed in-process by this runner.

## Notes

- Strict-reading the phase frontmatter, `installer-data.ts` was named for settings.json registration; in reality that logic lives in `installer-hooks.ts`. Documented above; the change is scope-equivalent (sibling block to existing PostToolUse / statusLine).
- Working tree contained pre-existing modifications from concurrent phases P14 / P15 / P19 (specialist-router, autonomous wave, impeccable skill normalization). I touched **none** of those — `git add` is restricted to my four files only.
- Total new test count: +21 (613 → 634). Hook file size: 209 lines (well under context-monitor's 160 + statusline pattern).
