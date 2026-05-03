# Phase 17 Offload Report

**Status**: completed

**Files modified**:
- NEW `templates/commands/debate.md` (138 lines) — `/ccg:debate <topic>` command template
- NEW `src/utils/debate-orchestrator.ts` (264 lines) — pure-function orchestrator (`debateStateMachine` / `parseRoundSummary` / `shouldStop`)
- NEW `src/utils/__tests__/debateOrchestrator.test.ts` (358 lines, 42 test cases)
- MODIFIED `src/utils/installer-data.ts` — appended `cmd('debate', 9.55, ...)` registration (1 line)
- MODIFIED `src/index.ts` — appended exports for helper + types (16 lines)

**Acceptance verification matrix**:

| Item | Status | Evidence |
|------|--------|----------|
| a. New `templates/commands/debate.md` with main-thread state machine | PASS | File exists; documents `--max-rounds N` + `--layer backend\|frontend\|fullstack`; describes Round 1/2/3 propose/challenge/respond protocol; references `codex:codex-rescue` / `gemini:gemini-rescue` plugin spawn |
| b. Fallback path (general-purpose + CCG prompts; tolerant parse) | PASS | Template has 「降级路径」 table; `debateStateMachine` returns `models: ['general-purpose']` + `pluginSubagent: [null]` when plugins unavailable; `parseRoundSummary` returns `parsed: false` on garbage input without throwing |
| c. New helper `src/utils/debate-orchestrator.ts` | PASS | 3 named exports: `debateStateMachine` (pure round planner) + `parseRoundSummary` (tolerant field extractor) + `shouldStop` (dual-signal convergence) — none spawn agents |
| d. Test cases enumerated (cap-3, no-critical, fullstack-double, plugin-missing, parse-tolerant) | PASS | 42 tests in 6 describe groups: state machine, plugin fallback, summary parse, convergence (shouldStop), layer × round interaction, template shape |

Test highlights:
- `cap 3 stop` — `shouldStop(3 rounds, 3)` returns true
- `B 第 2 轮无 critical → 提前停止` — `shouldStop` returns true when any round notes contain `no critical issue` / `agreement reached` / `lgtm` / `无 critical` / `达成共识`
- `fullstack 双线 propose` — `debateStateMachine('topic', { layer: 'fullstack' })[0].models === ['codex','gemini']`
- `plugin 缺失降级` — `pluginsAvailable: { codex: false }` → models becomes `['general-purpose']` with `fallback === 'plugin-missing'`
- `parse 容错` — `parseRoundSummary('garbage')` returns `{ parsed: false, length, ... }` without throw

**Critical issues**: none.

**Major issues**: none.

**Pending handoff**: phase-runner already executed `pnpm test` + `pnpm typecheck` + `pnpm build` in-process. Outstanding handoff item:
- `git_commit` — stage debate files only (boundary respected, no parallel-phase files touched)

**Tests**: 717/717 (delta +64 vs baseline 653; 42 new debate tests + 22 from already-merged parallel phases earlier in session)
**Typecheck**: pass (`tsc --noEmit` clean)
**Build**: pass (`unbuild` produces `debateStateMachine`, `parseRoundSummary`, `shouldStop` in `dist/index.mjs` exports)

**Notes**: Helper is **purely functional** — `debateStateMachine` returns a `DebateRoundPlan[]` plan that the main thread consumes, no agent spawning happens inside the helper. Convergence detection (`shouldStop`) uses three orthogonal signals: (1) challenger self-reports "no critical" / "agreement reached", (2) max-rounds cap, (3) adjacent-round length delta < 20%. File boundaries strictly respected — no edits to autonomous.md / plan|execute|analyze|optimize|test|review.md / installer-hooks.ts / challenger-orchestrator.ts.
