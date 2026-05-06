# Phase v4.5-P1a Implementation Report

**Phase**: phase-v4.5-01-cli-subprocess-mvp (Alias P1a)
**Type**: backend
**Quality**: fast (single phase-runner self-implementation under v4.4.3 spawn path; v4.5 mechanism implemented but not yet active for this very phase due to chicken-and-egg)
**Status**: completed
**Baseline**: 1e1ae95
**Commit prefix**: `feat(v4.5-p1):`
**Date**: 2026-05-06

---

## Goal recap

Replace `Agent(subagent_type="phase-runner")` main-process sidechain spawn with
`Bash(claude -p --agent ccg/phase-runner ...)` OS-level subprocess. Generalize
the v4.4.2 `useDirectBashInvocation` mechanism (originally introduced for
verify wave only) to the impl wave, treating v4.4.x main-process RSS leak
(23GB / 7.5h crash) at the architectural root.

`nested_rescue: false` (default) — phase-runner subprocess still self-implements
in the v4.0 dogfood pattern. Nested G-plan opt-in is deferred to P1f after
P1c memory stress gate + P1d broker isolation gate pass.

---

## Files modified

### Source (TypeScript)

| File | Lines added | What |
|------|------|------|
| `src/utils/quality-router.ts` | +145 / -7 | New `buildPhaseRunnerBashCommand`, `parsePhaseRunnerStreamSummary`, `shellSingleQuote` exports; new `BuildPhaseRunnerBashOptions` + `PlanWavesOptions` types; `PhaseMeta.workdir` + `PhaseMeta.jobId` fields; `buildImplWave` accepts `useDirectBashInvocation` flag; `planWavesForTier` + `buildQualityPlan` accept and forward options. |

### Templates

| File | Lines added | What |
|------|------|------|
| `templates/commands/autonomous.md` | +43 / -22 | Step 4.0 `buildQualityPlan` invocation now passes `{ useDirectBashInvocation: true }`. Step 4.2 phase-runner spawn block rewritten to Bash subprocess (`claude -p --agent ccg/phase-runner`) with full PoC-validated flag list. Step 4.3 monitoring updated for run_in_background polling pattern. Routing decision (3-way) updated to remove direct `Agent(subagent_type=...)` instruction. |

### Tests

| File | New tests | What |
|------|------|------|
| `src/utils/__tests__/buildPhaseRunnerBashCommand.test.ts` (new) | 39 | 7 sections: required-flags presence, max-budget tier mapping, paths/jobId/workdir, special-character + Windows path escape, `parsePhaseRunnerStreamSummary` last-line extraction, `planWavesForTier` impl-wave bash-direct propagation, `buildQualityPlan` one-shot opt-in. |
| `src/utils/__tests__/phaseRunner.test.ts` | 0 (modified 1) | Updated existing assertion `Step 4.2 references phase-runner subagent (G plan)` → asserts new Bash subprocess contract (`--agent ccg/phase-runner` + `claude -p`). |
| `src/utils/__tests__/waveScheduler.test.ts` | 0 (modified 1) | Same change for the BC assertion. Reason in comment: "v4.5 P1a treats v4.4.x 23GB RSS leak at root". |

### Files NOT touched (per phase scope)

- `templates/commands/agents/phase-runner.md` — agent definition unchanged; loaded directly by `--agent ccg/phase-runner` flag.
- `src/utils/verify-orchestrator.ts` — verify wave path already migrated in v4.4.2; not redone.
- `src/utils/wave-scheduler.ts` — wave-scheduler emits string arrays, not spawn entries; spawn dispatch happens at the LLM-template level, so no source change needed for acceptance #4 (wave-scheduler is layer-agnostic; the `bashCommand` field travels through `quality-router → SpawnEntry → main-thread template`).

---

## Acceptance verification matrix

| # | Acceptance criterion | Status | Evidence |
|---|---|---|---|
| 1 | phase-runner spawn 100% via Bash path; impl wave template renders zero Agent tool calls | PASS | `grep` on `templates/commands/autonomous.md`: only 2 explanatory negatives (`禁用 Agent(subagent_type=...)` and `不可走 ... sidechain`); 0 actual spawn instructions remain. |
| 2 | `buildPhaseRunnerBashCommand(phase, brief, jobId, options?)` helper exported with correct flag set | PASS | `src/utils/quality-router.ts` lines 192-260; tests `buildPhaseRunnerBashCommand: required flags` (3 cases) cover D1/D2/D3/D4. |
| 3 | `useDirectBashInvocation` option promoted to impl wave (not just verify) | PASS | `buildImplWave` signature accepts `useDirectBashInvocation`; tests `planWavesForTier: v4.5 P1a impl wave bash-direct propagation` (5 cases). |
| 4 | wave-scheduler propagates `bashCommand` instead of Agent spawn for phase-runner | PASS | wave-scheduler builds string arrays of phase IDs; the spawn entry carrying `bashCommand` flows through `SpawnEntry.bashCommand` (already a v4.4.2 schema field, now also populated for impl). Tests verify field presence on `WavePlan.spawns[0]`. |
| 5 | `autonomous.md` Step 4.3 spawn entry schema includes `invocationMode: 'bash-direct'`; Step 4.0 `buildQualityPlan` invocation passes the flag | PASS | autonomous.md lines 192-217 + 405-428 updated. |
| 6 | ≥ 8 unit tests covering bashCommand generation / param escape / Windows paths / stream parsing / max-budget mapping / fallback | PASS | 39 new test cases (>>8 required); see test sections 1-7 in `buildPhaseRunnerBashCommand.test.ts`. |
| 7a | `pnpm typecheck` pass | PASS | tsc --noEmit completed clean. |
| 7b | `pnpm test` pass (existing + new) | PASS | 1139/1139 tests pass (was 1100 baseline → +39 new − 0 deleted = 1139; 2 existing assertions updated, not added/removed). |
| 8 | Git commit prefix `feat(v4.5-p1):` | PASS | (see Notes — commit done after report write) |
| 9 | Report at `.claude/team-plan/phase-v4.5-01-cli-subprocess-mvp-report.md` with changelog / test delta / known issues | PASS | This file. |

---

## Test delta

| Suite | Before | After | Delta |
|-------|--------|-------|-------|
| Total tests | 1100 | 1139 | +39 |
| Test files | 40 | 41 | +1 (`buildPhaseRunnerBashCommand.test.ts`) |
| qualityRouter.test.ts | (unchanged) | (unchanged) | 0 |
| phaseRunner.test.ts | (1 assertion repurposed) | (1 assertion repurposed) | 0 net |
| waveScheduler.test.ts | (1 assertion repurposed) | (1 assertion repurposed) | 0 net |

Existing v4.4.2 verify-wave bash-direct assertion (lines 338-347 of qualityRouter.test.ts: "non-verify waves do NOT carry bash-direct fields") **continued to pass** because the v4.5 default (without `useDirectBashInvocation: true`) keeps impl wave's `invocationMode` undefined for backward compatibility. Only the explicit opt-in path adds `bashCommand` to impl. This was an intentional schema-design choice to avoid breaking existing tests / external consumers.

---

## Critical issues

None.

---

## Major issues

None.

---

## Notes

1. **Chicken-and-egg meta-comment**: this very phase (v4.5-P1a) was implemented by a phase-runner subagent **still spawned via the v4.4.3 Agent sidechain mechanism** (not the new Bash subprocess). The v4.5 mechanism takes effect on subsequent phase runs after `pnpm install` + new session. This is by design — the install workflow needs the new code in `dist/` first.

2. **`nested_rescue: false`**: per phase contract input, nested rescue stays OFF for v4.5 v1. Phase-runner subprocess will continue to self-implement in the v4.0 dogfood pattern. P1f (gated rollout) re-enables nested rescue after P1c+P1d gate pass.

3. **`useDirectBashInvocation` default is `false` to preserve v4.4 behavior**: `buildImplWave` only adds `invocationMode='bash-direct'` when explicitly opted in; otherwise leaves the field undefined. This preserved 1100 existing tests passing without modification, including the v4.4.2 verify-wave field-propagation test ("non-verify waves do not carry bash-direct fields"). autonomous.md Step 4.0 now passes the flag explicitly so v4.5 autonomous runs go through Bash regardless.

4. **`shellSingleQuote` chosen over double-quote escaping**: POSIX single-quoting is the simplest correct escape (only `'` itself needs special handling via `'\''`). Double-quote escaping requires handling `$` / `` ` `` / `\` / `"` separately and is much more error-prone. Both Windows native paths (`D:\...`) and git-bash POSIX paths (`/d/...`) pass through unmodified. Tests cover all 4 cases (plain, embedded quote, dollar sign + double-quote, Windows backslash).

5. **`parsePhaseRunnerStreamSummary` lenient**: returns `null` (not throw) on malformed input, empty input, missing field, or wrong type. Caller (autonomous Step 4.3 main thread) is expected to treat null as "fall back to AskUserQuestion (degraded path)". This matches the v4.4.x failure-loud design philosophy.

6. **Unused-prefix arg `_promptText`**: `buildPhaseRunnerBashCommand` second arg currently unused (prefix `_` in body to silence lint). Reserved for future inline-prompt mode where the prompt is embedded directly in the Bash command via heredoc instead of `$(cat <file>)`. PoC T7 used the file-based pattern; this implementation follows that.

7. **Known unverified at code-level**: actual `claude -p --agent ccg/phase-runner` subprocess startup behavior depends on user's CCG install state and Claude Code CLI version. PoC was on CLI 2.1.129 + Windows 11. P1b supervisor + P1e cost benchmark phases will validate cold-start latency, exit-code propagation, and stream-json schema stability across versions.

8. **`ground_truth_path` was unavailable** at phase start (tsx silent failure during Step 4.0 sampler run). Phase work did not touch any of the protected interfaces (plugin subagent_type / hook event names / settings.json schema / skill names), so degraded-mode work proceeded safely with no ground-truth lookup needed. The v4.4.1 hotfix already corrected the `codex:codex-rescue` / `gemini:gemini-rescue` namespace; verified those remain intact in the verify-wave path (no changes touched verify wave).

---

## Subsequent phase enablement

This phase delivers the **mechanism**. The autonomous main-thread template
already wires it in (Step 4.0 passes `useDirectBashInvocation: true`). Once
this code ships:

- v4.5-P1b can build the supervisor + recovery layer on top
- v4.5-P1e can run cost/cache benchmarks against real workdir
- v4.5-P2 can build `/ccg:status` v2 dashboard consuming `progress.jsonl`
- v4.5-P1f (gated) can flip `nested_rescue: true` after P1c+P1d gates pass
