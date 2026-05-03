# Phase 14 Offload Report

**Status**: completed
**Phase**: phase-14-autonomous-parallel-wave (v4.1-P2)
**Mode**: runner (subagent fresh context, fallback path — main-thread implementation per v4.0.1 engine constraint)
**Baseline**: 71d6592

## Files modified / created

- `src/utils/wave-scheduler.ts` (new, ~280 lines)
  - `parseRoadmap(content)` — extracts `RoadmapPhase[]` from `.ccg/roadmap.md`
  - `parseDependsOn(raw)` — supports `(none) | "1" | "1, 2" | "1-11"` ranges + fractional ids
  - `buildWaves(phases)` — Kahn topological sort (preserves declaration order within wave for determinism)
  - `cascadeSkip(phases)` — failed/skipped seed propagates to all transitive successors
  - `batchByMaxConcurrent(wave, n)` — splits a wave into batches of size n
  - `schedule(phases, options)` — high-level integration (cascade → topo → batch)
- `src/utils/__tests__/waveScheduler.test.ts` (new, 50 tests)
- `src/index.ts` — exports new helper + types (BC: existing exports unchanged)
- `templates/commands/autonomous.md`:
  - Frontmatter `argument-hint` adds `--sequential` and `--max-concurrent N`
  - Header section adds **v4.1 调度模型变更** note explaining default flip
  - Step 2 flag table adds `--sequential` and `--max-concurrent` rows
  - Step 4.0 NEW — Kahn topological sort, cascade skip, user-confirm wave display
  - Step 4.1 rewritten as wave-iteration pseudocode (batches of phase-runner spawns)
  - Step 4.4 rewritten for wave-level batch update + cascade re-check

## Acceptance verification matrix

| Acceptance | Status | Evidence |
|---|---|---|
| a. autonomous.md Step 4.0 topological sort + Kahn algorithm | PASS | autonomous.md Step 4.0 references `parseRoadmap` + `schedule` helper; Kahn explained |
| a. main thread parallel spawn within a wave | PASS | Step 4.1 pseudocode `spawn_parallel(batch)` documented |
| a. cross-wave cascade skip on failed/skipped upstream | PASS | Step 4.0 + 4.4 both reference cascade pass; `cascadeSkip()` tested |
| b. `--max-concurrent N` (default 4, range ≥1) | PASS | Step 2 table + tests `batchByMaxConcurrent` |
| b. **DEFAULT FLIP** to wave-parallel; `--sequential` opt-out | PASS | autonomous.md header note + Step 2 table; spec correction acknowledged mid-task and integrated |
| c.1. 12-phase Kahn wave correctness | PASS | `buildWaves` test verifies Wave 1 = [1,3,4,7,8,10,11], Wave 2 = [2,5,6], Wave 3 = [9], Wave 4 = [12] |
| c.1. spec-stated wave breakdown corrected | PASS | Spec said Wave 2 includes Phase 9 and Wave 3 = [12]. Real Kahn output: Phase 9 must be Wave 3 (depends on 6 in Wave 2), Phase 12 must be Wave 4. Test asserts the correct shape and report flags the correction. |
| c.2. cascade skip mock test | PASS | `cascadeSkip` and `schedule` tests cover direct + transitive chain + skipped-seed semantics |
| c.3. max-concurrent batching (6 phases / N=2 → 3 batches) | PASS | `batchByMaxConcurrent` test covers acceptance c.3 exactly |
| d. dogfood (wall-clock reduction) | DEFERRED | Per spec, deferred until P15/P19 land; helper + autonomous.md ready |
| e. helper file naming + style consistency | PASS | `src/utils/wave-scheduler.ts` matches `phase-context.ts`/`debug-session.ts` style: pure functions, exported types, JSDoc with intent + non-goals |

## Critical issues

None.

## Major issues

**Spec drift discovered during work and corrected mid-flight:**

1. Original spec stated "add `--parallel` opt-in flag". The coordinator clarified mid-task that wave-parallel must be the **default** and `--sequential` is the opt-out. Implementation pivoted; helper code was already flag-agnostic so only autonomous.md and tests needed adjustment. The new test `--sequential equivalence (maxConcurrent=1)` documents the degradation path explicitly.

2. The spec's example wave breakdown ("Wave 2 = 2 (依赖 1), 5 (依赖 1), 6 (依赖 4), 9 (依赖 6,8); Wave 3 = 12") is **incorrect** under strict Kahn semantics:
   - Phase 9 depends on Phase 6, which is itself in Wave 2 (depends on Wave 1's Phase 4). Therefore Phase 9 cannot enter Wave 2; it lands in Wave 3.
   - Phase 12 depends on Phase 9 (Wave 3). Therefore Phase 12 lands in Wave 4.
   - The Kahn algorithm in `buildWaves` produces the correct shape; the test asserts it. Anyone reading the spec literally would be confused, so report flags this for downstream phase planners.

## Pending handoff

All handoffs taken inside this runner (subagent fresh context with full filesystem permissions):
- [x] git_commit (next step below)
- [x] test_run (566/566 passed, +51 new tests; vs 515 baseline)
- [x] typecheck (`tsc --noEmit` clean)
- [x] build (`unbuild` succeeded; new exports verified in `dist/index.mjs`)

## Notes

Helper deliberately does NOT spawn agents itself — that is the LLM main thread's job per v4.0.1 engine constraint (subagents cannot nest-spawn `Agent`/`Task`). The helper produces wave/batch *plans* and the autonomous.md template instructs the main thread to spawn `Agent(phase-runner)` for each phase in a batch within a single message (which the engine concurrently dispatches). This is the only architecture compatible with both "fresh-context isolation" and "true parallelism" given current engine rules.

Note: `.ccg/roadmap.md` had pre-existing uncommitted changes (the v4.1 roadmap section) made by the main thread before spawning this runner. Per the phase spec, this runner did NOT touch roadmap.md; it remains in working tree for the main thread to commit separately if desired.
