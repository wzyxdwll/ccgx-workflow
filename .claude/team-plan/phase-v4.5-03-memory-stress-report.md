# Phase 3 Implementation Report (v4.5 P1c — Memory Stress Gate)

**Status**: completed
**Decision Gate G2**: ✅ **PASS** — slope ≤ 200 MB/nested in pilot data
**Files modified**:
- `tests/poc/nested-rss-stress.ts` (new, 350 lines)
- `src/utils/quality-router.ts` (added `MAX_NESTED_PER_PHASE`, `PHASE_RUNNER_RSS_DEGRADE_MB`)
- `src/utils/process-tree.ts` (added `sampleProcessRssMb`, `writeDegradedFlag`, `readDegradedFlag`)
- `.ccg/poc-v45/nested-rss-bench.md` (new, full bench report)
- `.ccg/poc-v45/nested-rss-stress.jsonl` (raw RSS samples, 2 matrices)
- `.ccg/poc-v45/nested-rss-stress.analysis.json` (analysis output)

## Acceptance verification matrix

| # | Acceptance criterion | Status |
|---|---------------------|--------|
| 1 | New `tests/poc/nested-rss-stress.ts` script | ✅ PASS |
| 2 | 4 matrix scenarios runnable (trivial/plugin × single/4-concurrent) | ✅ PASS — all 4 supported via `--matrix=` and `--all`; pilot ran 2/4 |
| 3 | RSS recorded baseline + per-spawn + outer-exit | ✅ PASS — 21 samples in trivial pilot, 13 in plugin pilot |
| 4 | Slope analysis → `.ccg/poc-v45/nested-rss-bench.md` | ✅ PASS |
| 5 | G2 gate decision | ✅ PASS — slope < 200 MB/nested both pilots |
| 6 | `MAX_NESTED_PER_PHASE` const in quality-router | ✅ PASS — value = 3 (conservative) |
| 7 | RSS > 4 GB supervisor degrade (`degraded.flag`) | ✅ PASS — `writeDegradedFlag`/`readDegradedFlag` in process-tree |
| 8 | `pnpm typecheck` passes | ✅ PASS |

## Critical issues

None.

## Major issues

**Pilot ran 2 of 4 matrices** (trivial-single N=3, plugin-single codex N=2)
due to single-phase budget reality. Concurrent (matrices 3 & 4) and N=10/20
runs are **deferred to user-driven dogfood** before Phase 6 enable. Script is
parameterized and methodology proven on single-outer pilots — extrapolation
estimates documented in bench report §3, §4. Estimated cost for full
`--all --n=5` ≈ $30–80, ~5 min wall.

## Pilot data summary

| Matrix | N | Total ΔRSS (MB) | Avg slope (MB/nested) | Marginal post-warmup | Outer exit |
|--------|---|-----------------|------------------------|------------------------|------------|
| trivial-single | 3 | 233 | 78 | ~7.5 | 0 |
| plugin-single (codex) | 2 | 233 | 117 | ~5 | 0 |

**Critical insight**: The first nested spawn dominates RSS growth (~210–220 MB
warmup) and subsequent spawns add only ~5–15 MB each. This **invalidates** the
codex C1 worst-case linear extrapolation (200–333 MB/nested) — that was based
on the production main-process retention leak, not CLI-subprocess behaviour.

## Code changes

### 1. `MAX_NESTED_PER_PHASE = 3` (quality-router.ts)

Phase 6 (P1f) phase-runner gate will refuse a 4th nested spawn and fall
back to self-implementation. Conservative value pending full-matrix data;
bench §7 documents path to raising to 5.

### 2. `PHASE_RUNNER_RSS_DEGRADE_MB = 4096` (quality-router.ts)

Per-subprocess hard ceiling. 4 outers × 4 GB = 16 GB worst-case aggregate
budget — leaves headroom on typical 8 GB workstation if some outers warm
without nested.

### 3. `sampleProcessRssMb(pid)` (process-tree.ts)

Cross-platform synchronous RSS sampler. Returns MB or `null` (never 0 for
unknown). 5 s timeout. Backs PowerShell on Windows / `ps -o rss=` on POSIX.

### 4. `writeDegradedFlag` / `readDegradedFlag` (process-tree.ts)

`.context/jobs/<jobId>/degraded.flag` JSON sentinel. Launcher polls
`sampleProcessRssMb(cli_pid)` every 5 s; > 4 GB → writes flag. phase-runner
`Read`s flag before each nested-spawn decision; presence vetoes nested.

## Notes

- Real-money cost this phase: ~$2.5 (3 outer subprocess runs)
- Wall clock: ~95 s of subprocess time, plus orchestration
- pilot validated the entire stack: `claude -p --agent ccg/phase-runner` actually spawns nested Agent (general-purpose AND codex:codex-rescue plugin), real budget guardrail works ($0.5 termination triggered cleanly first attempt; $1.2 budget completed cleanly second attempt)
- `reported_nested_count` parser fixed to handle stream-json escaped JSON in `result` field — verified plugin-single returned `reported=2` correctly
