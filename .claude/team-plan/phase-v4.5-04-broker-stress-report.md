# Phase v4.5 Phase 4 Implementation Report — broker.log tx_id isolation + 20-way stress (Alias P1d)

**Status**: completed
**Type**: backend (fast)
**Baseline SHA**: 3df5b3a
**Commit prefix**: feat(v4.5-p4):
**Generated**: 2026-05-06

---

## Goal recap

Solve codex C3: under v4.5 G-plan 20-way concurrency (4 outer CLI × 5 nested
plugin), broker.log must correlate events through `tx_id` (V4 UUID) only —
NEVER via tail-position / time-window / nearest-error heuristics. v4.4.2
commit `26a579d` already identified this race hazard but did not engineer the
solution; Phase 4 closes that gap before Phase 6 (nested plugin spawn) lands.

## Files modified

| Path | Action | Why |
|------|--------|-----|
| `src/utils/broker-log.ts` | new | tx_id mint, schema, JSONL append, getTxLineage helper, createEmitter producer |
| `src/utils/__tests__/brokerLog.test.ts` | new | 21 unit tests covering uniqueness / schema / correlation / cross-platform |
| `tests/stress/broker-concurrent.ts` | new | OS-level stress test: 4 outer × 5 nested × 100 iter = 2000 spawns |
| `templates/scripts/ccg-phase-runner-launcher.mjs` | edit | Mint tx_id at launcher start; inject `CCG_BROKER_TX_ID` / `CCG_BROKER_LOG_PATH` / `CCG_OUTER_CLI_PID` / `CCG_JOB_ID` into spawned CLI env; persist `broker_tx_id` in state.json |

NOT modified: `templates/hooks/ccg-context-monitor.js` — grep for
`broker.log` / `broker-log` / `brokerLog` shows no existing consumer in `src/`
or `templates/`. The contract is shipped now (writer + reader + schema) so any
future consumer (Phase 6 nested supervisor / dashboards) inherits tx_id-only
correlation by construction. There is intentionally no legacy migration step.

## Acceptance verification matrix

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | `broker-log.ts` exists with tx_id (`crypto.randomUUID`), 8-field schema, JSONL append, schema-validating reader, `getTxLineage(txId)` helper | PASS | `src/utils/broker-log.ts` lines 1-300 |
| 2 | Launcher injects tx_id into CLI subprocess env | PASS | `ccg-phase-runner-launcher.mjs` lines 256-298 (env block) |
| 3 | Existing broker.log consumers replaced | PASS (vacuous) | grep shows zero existing consumers in `src/` or `templates/`; nothing to replace |
| 4 | Stress test: 4 outer × 5 nested × 100 iters real OS concurrency | PASS | `tests/stress/broker-concurrent.ts` produces 2000 spawns; 79s wall, 0 misattributions, 0 inconsistent terminals |
| 5 | ≥ 8 unit tests covering collision / schema / lineage / atomicity / cross-platform | PASS | 21 tests pass (one runs 1e5 collision check in 2.3s) |
| 6 | G3 decision gate | **PASS — Phase 6 may enable nested plugin spawn** | See "G3 result" below |
| 7 | `pnpm typecheck` + `pnpm test` pass | PASS | typecheck clean; 1249 → 1270 (+21) |
| 8 | commit prefix `feat(v4.5-p4):` | satisfied at commit time | — |

## G3 decision gate

| Invariant | Required | Observed | Verdict |
|-----------|----------|----------|---------|
| 1e5 tx_id generation, 0 collisions | 0 | 0 (227 ms) | PASS |
| 2000-spawn 20-way stress, tx_id collisions | 0 | 0 | PASS |
| Cross-tx misattribution (event with foreign tx_id appears in lineage) | 0 | 0 | PASS |
| Inconsistent terminal status (declared vs broker-log derived) | 0 | 0 | PASS |
| Total broker events emitted across 2000 spawns | ≥ 4000 (start + end) | 5021 (some had progress events) | PASS |

**Verdict: G3 PASS — Phase 6 acceptance may enable nested plugin spawn.**

Stress report sample run:
```
broker-concurrent stress: outers=4 nested=5 iters=100 failureRate=0.3
uniqueness: 100000/100000 unique (0 collisions) in 227 ms
concurrency: 2000 spawns, 5021 events, 0 misattributions, 0 inconsistent terminals in 79159 ms
report: .ccg/poc-v45/broker-stress.md
VERDICT: PASS
```

## Critical issues

None.

## Major issues

None.

## Notes

1. **Why a forbidden-API list (broker-log.ts bottom)**: explicitly NOT
   exporting `findEventByTimestamp` / `lastEventBefore` / `findFailureNearestTo`
   bakes the codex C3 hardline into the module's surface. Future contributors
   reaching for those functions will hit the comment and be redirected to
   `getTxLineage(txId)`, which forces them to plumb tx_id through env →
   exactly the discipline the contract requires.

2. **Why the stress test does NOT spawn `claude`**: codex C3 is a broker.log
   correctness invariant under concurrent OS-process writers, not a claude
   end-to-end behavior. Spawning real `claude` × 2000 would cost ~$4–$10 +
   60+ min wall time while testing the SAME `appendFileSync` code path that
   pure-Node child workers exercise. The Node workers are the simplest
   sufficient harness; they really do invoke the same `appendFileSync` →
   `write(2)` syscall sequence on the shared file. If a future change makes
   broker-log async or buffered, this test will catch it.

3. **JSONL line atomicity caveat**: `appendFileSync` maps to one `write(2)`
   with `O_APPEND` on POSIX (kernel-serialized for short lines on most
   filesystems) and to a serialized exclusive-lock write on Windows. For
   payloads <1 KiB we get line-atomicity in practice. This is the same
   guarantee the existing `progress.jsonl` writer in
   `ccg-phase-runner-launcher.mjs` relies on, so no new operational risk.

4. **Schema field `payload` is opt-in, not required**: keeping it optional
   lets producers emit minimal `tx_start` / `tx_end_*` events without churn.
   Schema validator only checks the 8 required fields.

5. **`broker_tx_id` now in state.json**: the launcher persists tx_id alongside
   cli_pid / process_group_id so a startup reconciler (Phase 2 P1b) can later
   correlate stale running jobs back to their broker.log lineage if needed.
   This is a free addition that costs nothing in the happy path.

6. **`v4.5-p4` commit prefix is final**: matches the convention used by the
   already-merged Phase 2 / Phase 5 / Phase 7 commits in this milestone
   (`feat(v4.5-p2):`, etc.).
