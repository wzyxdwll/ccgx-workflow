# Phase 29 Offload Report

**Status**: completed
**Files modified**:
- (new) `templates/hooks/ccg-commit-msg-review.cjs` — heuristic commit-msg hook (~330 lines, CJS)
- (new) `templates/hooks/README-commit-msg-review.md` — opt-in activation guide
- (modified) `src/utils/installer-hooks.ts` — `HOOK_FILES` array adds `ccg-commit-msg-review.cjs`; settings.json patcher untouched (intentional — git hook, not Claude hook)
- (new) `src/utils/__tests__/commitMsgReview.test.ts` — 30 unit tests via `createRequire` against the CJS hook

## Acceptance verification matrix

| Acceptance clause | Status | Evidence |
|-------------------|--------|----------|
| a. New `ccg-commit-msg-review.cjs` reading stdin / `.git/COMMIT_EDITMSG` | PASS | `readDraftMessage()` honors `argv[2]` (git's standard), falls back to `.git/COMMIT_EDITMSG`, never blocks on read failure |
| a. Uses `git diff --cached --name-only` for staged file list | PASS | `readStagedFiles()` execs that command; non-zero exit returns null → exit 0 (never block on infra failure) |
| a. Heuristic #1 — message file name ⊆ staged | PASS | `checkConsistency` Heuristic #1, with bare-basename suffix-match for prose like "tweak foo.ts" |
| a. Heuristic #2 — phase tag (v4.3-p27 / phase-29 / p27) ↔ staged paths | PASS | `extractPhaseTag` parses 3 forms; `checkConsistency` H#2 cross-checks against `phase-NN` / `pNN` path tokens; zero-padding (`p1` → `phase-01`) supported |
| a. Heuristic #3 — operation type aligns with diff | PASS | `extractCommitType` + `classifyStagedFiles`; `docs(...)` with no .md → fail; `test(...)` with no test file → fail |
| a. Inconsistent → non-zero exit + corrective hint | PASS | `main()` writes hint to stderr listing reason + first 5 staged files + `--no-verify` escape hatch; exit code 1 |
| a. Consistent → silent exit 0 | PASS | `main()` returns 0 with no stdout/stderr |
| a. Heuristic-only (no LLM spawn) | PASS | Pure JS, no network, no subprocess except `git diff --cached` |
| b. Installed to `~/.claude/hooks/` | PASS | `HOOK_FILES` array picks it up; `copyHookFiles` already iterates that array |
| b. NOT auto-registered in settings.json | PASS | `patchSettingsJson` left unchanged — only handles PostToolUse / SessionStart / statusLine |
| b. README explains activation | PASS | `README-commit-msg-review.md` covers Option A (per-repo symlink), B (Husky), C (`core.hooksPath`) + bypass + Windows note |
| c. installer-hooks.ts HOOK_FILES updated | PASS | Diff confirms array now has 4 entries; comment explains why settings.json is intentionally untouched |
| c. copyHookFiles auto-copies | PASS | Already iterates `HOOK_FILES` — no code change needed beyond array entry |
| c. NOT registered as Claude hook in settings.json | PASS | No edits to `patchSettingsJson` |
| d. Test file with ≥10 cases | PASS | **30 cases** across 9 `describe` blocks: stripCommitTemplate (2), extractFileMentions (4), extractCommitType (2), extractPhaseTag (4), classifyStagedFiles (3), parseStagedFiles (2), checkConsistency H#1 (3), H#2 (3), H#3 (4), defensive (3) |
| d. Test: staged includes `package.json` + msg mentions it → ok | PASS | `checkConsistency H#1: passes when mentioned files are all staged` |
| d. Test: msg mentions wrong file → fail | PASS | `checkConsistency H#1: fails when message mentions a file that is NOT staged` |
| d. Test: `feat(v4.3-p27)` matches phase-27 path → ok | PASS | `checkConsistency H#2: passes when v<x.y>-p<NN> matches a phase-scoped staged path` |
| d. Test: `fix(p27)` but staged is phase-29 → fail | PASS | `checkConsistency H#2: fails when phase tag points at a different phase than staged paths` |
| e. README.md / templates/CLAUDE.md unchanged | PASS | git status shows only the 4 files in scope staged |

**File-boundary compliance**: only the 4 allowed paths are staged. WIP from P25/P27/P28 (untracked: `scripts/`, `tests/`, `src/utils/interface-auditor.ts`, `templates/commands/agents/interface-auditor.md`, modified `package.json`, `src/index.ts`, etc.) explicitly excluded from `git add`.

## Critical issues
- None.

## Major issues
- None.

## Pending handoff
- (taken) `git_commit` — staged + committed below as `feat(v4.3-p29): commit-msg-review hook (heuristic message↔diff consistency check)`
- (taken) `pnpm test` — full suite ran; 1053/1062 pass. The 9 failures are pre-existing in parallel-phase WIP (`interfaceAuditor.test.ts`, `qualityTierE2E.test.ts`, `tripleTierIntegrationDogfood.test.ts`) — verified independent of this phase by running the focused test set on touched files (142/142 pass)
- (taken) `pnpm typecheck` — clean (`tsc --noEmit` exit 0)
- (taken) `pnpm build` — clean (`unbuild` exit 0, dist size 444 KB)

## Notes
The hook is **opt-in by design**. Mainline must not auto-write to `.git/hooks/commit-msg` or `git config core.hooksPath` — that would break user-owned hook managers (Husky / lefthook). The README documents three activation paths plus the Windows note (no symlinks without elevated privileges). Heuristic #2 supports zero-padding (`v3.0.0-p1` → `phase-01`) so the historical CCG roadmap layout matches without false positives.

## Test counts
- Pre-phase baseline (clean HEAD `fbf7c3c`): 986 pass
- Post-phase touched-files focused: **142/142** pass (installer + installWorkflows + sessionStateHook + commitMsgReview)
- Post-phase full suite: 1053/1062 pass (9 failures pre-existing in parallel-phase WIP files; **0 regressions** from this phase)
- New cases added by P29: **+30** (commitMsgReview.test.ts), exceeding the spec's ≥10 floor
