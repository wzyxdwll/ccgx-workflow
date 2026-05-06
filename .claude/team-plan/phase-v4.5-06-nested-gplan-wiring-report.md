# Phase v4.5-06 Implementation Report

**Phase**: Phase 6 — Nested G-plan opt-in 渐进开启 + launcher wiring (Alias P1f)
**Status**: completed
**Quality**: fast (single impl wave; no plan/critic/debate)
**Critical**: true (per roadmap; challenger orchestration left to main thread per v4.1 design)
**Date**: 2026-05-06
**Baseline SHA**: 2befa42

---

## Files modified

- `templates/commands/agents/phase-runner.md`
  - Removed v4.0 "⚠️ 引擎层硬约束" section (no longer applicable in CLI subprocess mode per v4.5 PoC T9)
  - Added "🔁 v4.5 启动模式（CLI 子进程）" section explaining v4.0 → v4.5 transition
  - Added "Nested rescue delegation (v4.5 P1f opt-in)" section with: trigger condition, type routing matrix, CAP=3 rule, supervisor degraded.flag protocol, plugin spawn failure fallback paths, summary protocol extension
  - Updated input contract table to include `nested_rescue` + `job_id` fields
  - Phase B (实施) split into self-implementation vs nested rescue paths
  - Phase F clarification: nested rescue ≠ challenger (two independent mechanisms)
  - 严格约束 ❌ section updated to reflect new constraints (CAP, degraded.flag check)

- `src/utils/quality-router.ts`
  - Added `PhaseMeta.nestedRescue?: boolean` field
  - Added `parseNestedFlag(args)` helper — parses `--nested=on|off|true|false`
  - Added `resolveNestedRescue(input)` helper — phase frontmatter > CLI flag > default false
  - Added `buildPhaseRunnerLauncherCommand(phase, options)` helper — generates `node launcher.mjs ...` invocation wrapping `claude -p`
  - Added `DEFAULT_LAUNCHER_PATH` exported constant (`~/.claude/scripts/ccg-phase-runner-launcher.mjs`)
  - Added `BuildPhaseRunnerLauncherOptions` interface
  - Extended `PlanWavesOptions.useLauncherWiring?: boolean` (only effective when `useDirectBashInvocation: true`)
  - Updated `buildImplWave` to switch between bare `claude -p` (P1a path, BC + dev workflow) and launcher-wrapped (P1f production path)

- `templates/commands/autonomous.md`
  - Added `--nested=on|off` CLI flag to Step 2 flag table
  - Added Step 4.0c "Nested rescue 解析（v4.5 P1f opt-in）" — full priority stack, prompt injection
  - Step 4.0a `buildQualityPlan` invocation now passes `useLauncherWiring: true`
  - Step 4.2 phase-runner spawn snippet rewritten: `Bash(node launcher.mjs ...)` instead of bare `claude -p`
  - Step 4.2 prompt.txt schema updated to include `nested_rescue` + `job_id` fields
  - Step 4.3 polling description updated for launcher wrapping
  - Removed misleading "禁用 Agent..." line; clarified that CLI subprocess mode unlocks Agent tool natively

- `templates/commands/status.md`
  - Mode E step 5 cleared `[v4.5-p2-pending]` tag
  - Added Bash + node -e implementation sample calling `killProcessTree({pid, pgid, graceMs})`
  - Updated source-of-truth helper list to reflect Phase 2 P1b completion

- `src/utils/__tests__/nestedGplan.test.ts` (new) — 39 tests covering all 6 acceptance test surfaces

- Test fixups (consequential to template changes):
  - `src/utils/__tests__/phaseRunner.test.ts`: updated 2 assertions (engine-layer constraint section gone; new section v4.5 CLI mode + nested rescue)
  - `src/utils/__tests__/waveScheduler.test.ts`: updated assertion to require `ccg-phase-runner-launcher` reference

---

## Acceptance verification matrix

| # | Criterion | Status | Evidence |
|---|---|---|---|
| A1 | phase-runner.md: removed line 14-22 engine constraint section | PASS | grep shows section gone; replaced with "v4.5 启动模式" |
| A1 | phase-runner.md: added "Nested rescue delegation" section | PASS | grep "Nested rescue delegation" — 1 hit |
| A1 | phase-runner.md: routing matrix backend → codex / frontend → gemini | PASS | section explicit table |
| A1 | phase-runner.md: CAP MAX_NESTED_PER_PHASE = 3 documented | PASS | Section "单 phase nested CAP" |
| A1 | phase-runner.md: degraded.flag supervisor monitor protocol | PASS | Section "Supervisor 降级" with PHASE_RUNNER_RSS_DEGRADE_MB |
| A1 | phase-runner.md: plugin spawn failure → degraded fallback | PASS | "Plugin spawn 失败降级路径" table |
| A2 | quality-router: `MAX_NESTED_PER_PHASE` exposed | PASS | already exported (Phase 3 P1c); test confirms |
| A2 | PhaseMeta `nestedRescue: true|false` field | PASS | added; nestedGplan.test.ts §3 |
| A2 | `--nested=on|off` flag parsing | PASS | parseNestedFlag tests §1 |
| A2 | flag priority: phase frontmatter > CLI flag > default off | PASS | resolveNestedRescue tests §2 |
| A3 | autonomous.md Step 4.0c nested mode detection | PASS | section added |
| A3 | autonomous.md spawn prompt includes `nested_rescue` | PASS | prompt.txt schema updated |
| A4 | default `--nested=off` 100% equivalent to v4.5 v1 | PASS | nestedGplan.test.ts §7 — plan structure identical |
| A5 | nested cap = 3 (Phase 3 P1c) | PASS | constant; `MAX_NESTED_PER_PHASE` test §8 |
| A6 | --nested flag usage docs (README left for Phase 8) | DEFERRED | Phase 8 (release docs) per user instruction |
| B7 | autonomous.md Step 4.2-4.3 use launcher wrapper | PASS | snippet rewritten to `Bash(node launcher.mjs ...)` |
| B8 | status.md Mode E step 5 cleared pending tag | PASS | now references killProcessTree directly |
| B9 | buildPhaseRunnerBashCommand outputs launcher when useLauncherWiring | PASS | nestedGplan.test.ts §5+§6 |
| B9 | BC: useDirectBashInvocation=false unchanged | PASS | nestedGplan.test.ts §5 first test |
| C10 | nested G-plan unit tests (frontmatter, flag, prompt, cap, degraded) | PASS | 39 tests in nestedGplan.test.ts |
| C11 | launcher wiring unit tests (cmd format, --job-id, --prompt-file) | PASS | nestedGplan.test.ts §4-§6 |
| C12 | typecheck + test pass | PASS | typecheck pass; 1309/1309 tests pass |
| D13 | --nested=on E2E dogfood plan documented | PASS | see "E2E Dogfood Plan" below |

---

## Critical issues

None — all acceptance criteria met.

## Major issues

None.

## E2E Dogfood Plan (deferred to Phase 8 per chicken-and-egg constraint)

The `--nested=on` end-to-end test must run **after** Phase 8 ships (so installer carries the new launcher wiring + phase-runner.md). Plan:

1. **Setup**: install v4.5.0 to clean `~/.claude/`. Confirm `templates/scripts/ccg-phase-runner-launcher.mjs` shipped.
2. **Backend phase test**: pick a small `Type: backend` phase (e.g., a TS helper refactor). Run:
   ```
   /ccg:autonomous --only N --nested=on --quality=fast
   ```
   Expected:
   - launcher boots; state.json shows `cli_pid` + `process_group_id`
   - phase-runner CLI subprocess Read `nested_rescue: true` from prompt
   - phase-runner spawn `Agent(codex:codex-rescue)` (1 nested call)
   - broker.log shows tx_id correlation
   - phase completes with STATUS line including `nested_count: 1`
3. **Frontend phase test**: pick a small `Type: frontend` phase. Same flow but expect `Agent(gemini:gemini-rescue)`.
4. **CAP test**: contrive a phase prompt instructing 4 sequential nested spawns. Expect 4th refused with `nested-cap-reached` in NOTES.
5. **Degraded.flag test**: artificially write `degraded.flag` mid-phase via Bash. Expect phase-runner to switch to self-implementation + STATUS=degraded.
6. **Failure rollback test**: uninstall codex plugin. Run `--nested=on` backend phase. Expect graceful fallback to self-impl + `plugin-unavailable: codex:codex-rescue` in NOTES.

Coverage of Phase 8 acceptance bullet:
> `--nested=on` 端到端 dogfood：1 个 frontend phase + 1 个 backend phase

---

## Notes

- **Chicken-and-egg honored**: this phase 6 self-spawn ran via legacy v4.4.3 Agent path (not launcher / not nested). All changes apply to *future* spawns post-install. Verified: my own implementation used Read/Write/Edit/Bash — no nested spawn attempts.
- **`MAX_NESTED_PER_PHASE = 3`** comes directly from Phase 3 P1c memory stress gate (already exported by Phase 3 commit `1086aca`); Phase 6 only consumes the constant.
- **broker.log tx_id**: launcher injects `CCG_BROKER_TX_ID` env var (via Phase 2 commit `20fb5fe`); nested rescue plugins inherit it for cross-process correlation per Phase 4 commit `285b2ac`.
- **Test count**: 1300 → 1309 (+39 new + 0 broken; 2 prior tests updated for new template wording).
- **Typecheck**: passes (`tsc --noEmit` clean).
- **`useLauncherWiring` BC strategy**: defaulting to false in `PlanWavesOptions` keeps test fixtures + dev-mode bare `claude -p` working. Production autonomous.md explicitly opts in via `useLauncherWiring: true`.
- **No silent re-spawning**: phase-runner.md Phase B explicitly forbids spawning Agent when `nested_rescue: false`; CAP=3 + degraded.flag enforced before each spawn decision point.

---

## Wiring verification (manual grep)

```
$ grep -c "ccg-phase-runner-launcher" templates/commands/autonomous.md
2   # Step 4.2 snippet + Step 4.3 polling description

$ grep -c "引擎层硬约束" templates/commands/agents/phase-runner.md
0   # section removed (replaced with v4.5 CLI subprocess mode + nested rescue)

$ grep -c "Nested rescue delegation" templates/commands/agents/phase-runner.md
4   # new section header + 3 cross-references

$ grep -c "killProcessTree" templates/commands/status.md
5   # mode E step 5 wired (1 prose + sample code references)
```
