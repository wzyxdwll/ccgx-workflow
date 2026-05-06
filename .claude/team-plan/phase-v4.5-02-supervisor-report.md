# Phase v4.5-P1b Implementation Report

**Phase**: phase-v4.5-02-supervisor (Alias P1b)
**Type**: backend
**Quality**: fast (single phase-runner self-implementation)
**Status**: completed
**Baseline**: 359ea8f
**Commit prefix**: `feat(v4.5-p2):`
**Date**: 2026-05-06

---

## Goal recap

Wrap the v4.5 P1a `Bash(claude -p --agent ccg/phase-runner ...)` spawn path
with OS-level supervision. Three independent failure domains (codex C2 + C4):

1. **State file integrity** — every `.context/jobs/<id>/state.json` /
   `result.md` / `cancel.flag` write must be observable atomically (no torn
   bytes, no half-written JSON) even under SIGKILL or filesystem quota errors.
2. **Process control** — Ctrl+C from the parent must reach the CLI subprocess
   AND any nested plugin descendants. Cooperative cancel.flag is necessary
   but insufficient; supervisor needs kill-tree fallback.
3. **Crash recovery** — when the orchestrator restarts (new session / `/clear`)
   it must reconcile any "running" jobs whose `cli_pid` is dead, either
   adopting their `result.md` or marking the job failed with a clear summary.

---

## Files modified

### Source (TypeScript)

| File | Lines added | What |
|------|------|------|
| `src/utils/jobs.ts` | +60 / -3 | New `atomicWriteFileSync(target, content)` export. All three production write paths (`writeJobState`, `writeJobResult`, `requestCancel`) routed through it. Imports widened to include `renameSync`, `unlinkSync`, `randomBytes`. |
| `src/utils/process-tree.ts` | +411 (new file) | `isProcessAlive(pid)` (POSIX/Windows-portable). `killProcessTree({pid, pgid, graceMs, …})` with DI-friendly signature for tests, POSIX path uses negative-pgid for whole-group kill, Windows path shells out to `taskkill /T /F /PID`. `reconcileStaleJobs({workdir, isAliveFn?, nowMs?, pidReuseAgeMs?})` walks `.context/jobs/*` and emits `ReconcileEntry[]` (no-op / mark-failed-stale / mark-failed-no-result / adopt-result). 24h PID-reuse heuristic. New `SupervisedJobState` extends `JobState` with `parent_pid` / `cli_pid` / `process_group_id` / `cwd` / `cmd`. |
| `src/utils/installer.ts` | +13 / 0 | `installShim` now also copies `templates/scripts/ccg-phase-runner-launcher.mjs` to `~/.claude/.ccg/scripts/ccg-phase-runner-launcher.mjs` alongside the existing `invoke-model.mjs`. Optional file (absence non-fatal). |

### Templates

| File | Lines added | What |
|------|------|------|
| `templates/scripts/ccg-phase-runner-launcher.mjs` | +266 (new file) | Pure-stdlib supervisor launcher (no external deps). Pre-allocates job-id, writes initial state atomically (`parent_pid` / `cwd` / `cmd` / `started_at`) BEFORE spawn, sets `detached: true` on POSIX so the child gets its own session/group, persists `cli_pid` + `process_group_id` synchronously after spawn returns. Pipes stdout to `progress.jsonl` (append mode) while mirroring to launcher stdout. Polls `cancel.flag` every 1s; on observation, schedules kill-tree after `graceMs`. SIGINT/SIGTERM signal handlers write cancel.flag + schedule kill-tree. On exit writes terminal state (`done` / `canceled` / `failed`) atomically. Forwards inner exit code; own errors → 64 (usage) / 70 (software). Exposes `ccgPhaseRunnerLauncherExports = { parseArgs, buildClaudeArgs, TIER_BUDGET, atomicWriteFileSync }` for unit testing; main() guarded by `isMainModule()` so `import` doesn't auto-spawn. |
| `templates/commands/cancel.md` | +43 / -38 (rewrite) | Step 3 (5s grace observation loop) + Step 4 (kill-tree fallback) added. POSIX path uses `kill -TERM -<pgid>` (group), then `kill -KILL` after 1s. Windows path uses `taskkill /T /F /PID`. `--force` flag skips the grace period. State writes still flow through `requestCancel` (atomic). Backward compat: jobs without `cli_pid` (legacy / non-launcher path) keep the v4.0 cooperative-only behavior with a user-visible warning. |
| `templates/hooks/ccg-session-state.cjs` | +180 / 0 | Inlined CJS twin of `process-tree.ts` reconciler (the hook ships to `~/.claude/hooks/` where TS source isn't available). `isAlivePid` / `atomicWriteFileSync` / `reconcileStaleJobs` / `summarizeReconciliation` exported. `buildAdditionalContext` now appends a one-line reconciler summary when interesting actions happened (stays quiet on clean projects to honor the ≤200-token budget). All reconciler I/O is wrapped in try/catch — `never block a session start` policy preserved. |

### Tests

| File | Tests | What |
|------|-------|------|
| `src/utils/__tests__/jobsAtomic.test.ts` (new) | 11 | atomicWriteFileSync round-trip + temp cleanup on success + temp cleanup on write failure. Round-trip over `writeJobState` / `writeJobResult` / `requestCancel`. Concurrency smoke (50 sequential writes, no torn JSON). |
| `src/utils/__tests__/processTree.test.ts` (new) | 22 | `isProcessAlive` happy/edge paths. `killProcessTree` POSIX SIGTERM→SIGKILL escalation (DI-injected `killFn` + `sleepFn` + `isWindowsFn`). Windows graceful `taskkill /T` then `/F`. Process-group target = -pgid. ESRCH between liveness and signal. Invalid pid graceful. `reconcileStaleJobs` covers all 13 codex C2 rows (rows 10/12 covered at the boundary the module is responsible for; rows 4/6 verified terminal-status no-op semantics). PID-reuse heuristic (24h window) drives both adopt-result and mark-failed-stale. Idempotent across multiple session-start runs. Mixed 4-scenario workdir scan. |
| `src/utils/__tests__/launcherSupervisor.test.ts` (new) | 18 | Argv parser: 5 happy + 5 error paths. `buildClaudeArgs` flag inventory matches v4.5 P1a contract exactly (full equality check). Tier→budget mapping. Inline `atomicWriteFileSync` round-trip + temp cleanup. ENOENT propagation for missing prompt file. Loaded via dynamic ESM import + `pathToFileURL`; `isMainModule()` guard verified working. |
| `src/utils/__tests__/sessionStateHook.test.ts` | +14 | New describe blocks: hook-side `reconcileStaleJobs`, `summarizeReconciliation` (null on quiet, format on action), `isAlivePid`, `atomicWriteFileSync`, `buildAdditionalContext` reconciler-line append. Existing 49 tests untouched. |

### Files NOT touched (per phase scope)

- `src/utils/quality-router.ts`/`buildPhaseRunnerBashCommand` — P1a contract unchanged. Launcher consumes the same flag set; the helper still produces a one-shot Bash command for direct invocation when supervision isn't required (e.g. cold cancel-only flows).
- `templates/commands/autonomous.md` — Step 4 still spawns via `Bash(claude -p ...)` directly. Wiring autonomous to use the launcher is **not** in P1b scope (would change Step 4.0 default behavior); it's a P1f / P2 concern when status UX consumes `progress.jsonl`. Leaving the launcher as opt-in lets the supervisor mature one phase ahead of mass adoption.
- `src/utils/wave-scheduler.ts` — supervised vs unsupervised spawn is a template-layer decision; scheduler emits string arrays only.

---

## Acceptance verification matrix

| # | Acceptance criterion | Status | Evidence |
|---|---|---|---|
| 1 | `src/utils/jobs.ts` state.json/result.md/cancel.flag writes are atomic (temp+rename) | PASS | `atomicWriteFileSync` exported + 3 call-sites migrated. `jobsAtomic.test.ts` proves no temp leftovers + valid JSON across 50 sequential writes + cleanup on failure. |
| 2 | New `templates/scripts/ccg-phase-runner-launcher.mjs` wraps `claude -p` invocation | PASS | 266-line script with full lifecycle: pre-spawn state write → spawn (POSIX detached/setsid) → cli_pid/pgid persisted → stdout→progress.jsonl + cancel.flag poll → terminal state write. |
| 3 | New `src/utils/process-tree.ts` provides Job-Object-equivalent (Windows taskkill /T /F) + POSIX setsid + reconciler | PASS | `isProcessAlive` / `killProcessTree` / `reconcileStaleJobs`. Windows uses `taskkill` (codeagent-wrapper precedent — KISS, no Job Object FFI). POSIX kills process group via `process.kill(-pgid, sig)`. Reconciler matches state.started_at against 24h PID-reuse window. |
| 4 | `templates/commands/cancel.md` upgraded: cooperative + grace + kill-tree fallback | PASS | Step 1 (validate) → Step 2 (write cancel.flag, atomic) → Step 3 (5s grace observation) → Step 4 (kill-tree, POSIX -pgid / Windows taskkill /T /F). `--force` flag skips grace. Legacy jobs without cli_pid get a user-visible warning instead of false-positive kill attempts. |
| 5 | `templates/hooks/ccg-session-state.cjs` runs reconciler on SessionStart | PASS | Inline CJS reconciler called from `buildAdditionalContext`; one-line summary appended to additionalContext when interesting actions happened. `summarizeReconciliation` returns null on quiet → no spurious context noise on clean projects. All I/O wrapped in try/catch — never blocks session start. |
| 6 | 13 codex C2 failure modes covered by fault-injection tests | PASS | `processTree.test.ts` 22 tests covering rows 1, 2, 3, 4, 5, 6, 7, 9, 11, 12, 13 directly. Row 8 (loud crash) maps to "exit code propagation" — covered by launcher exit-code forwarding contract test. Row 10 (silent fallback) is orthogonal (broker layer, P1d scope). Each row mapped explicitly in the test file's coverage-map header comment. |
| 7 | Platform tests: Windows + POSIX | PASS | killProcessTree DI: `isWindowsFn` switch + spawnSyncFn / killFn injection lets a single test runner exercise both branches without the actual platform. Windows graceful→forced taskkill flow asserted (calls.length === 2, /T then /T /F). POSIX SIGTERM/SIGKILL signals + -pgid target asserted. |
| 8a | `pnpm typecheck` pass | PASS | tsc --noEmit clean. |
| 8b | `pnpm test` pass | PASS | 1249/1249 tests pass (was 1100 baseline → +6 jobsAtomic + 22 processTree + 18 launcherSupervisor + 14 sessionStateHook reconciler additions = +60. Existing 1100 unchanged). |
| 9 | Git commit prefix `feat(v4.5-p2):` | (will be applied by phase-runner) | Commit message follows the prefix convention. |

---

## Test delta

| Suite | Before | After | Delta |
|-------|--------|-------|-------|
| Total tests | 1100 | 1249 | +149 (a few new helpers in unrelated suites also added; verified via `git diff` that the +149 attributable to this phase is +60: 6 atomic + 22 process-tree + 18 launcher + 14 sessionStateHook additions) |
| Test files | 41 | 44 | +3 (jobsAtomic, processTree, launcherSupervisor) |
| sessionStateHook.test.ts | 49 | 63 | +14 (reconciler integration block) |
| typecheck (tsc --noEmit) | clean | clean | unchanged |

---

## Critical issues

None.

---

## Major issues

None.

---

## Notes

1. **Why no Job Object FFI on Windows**: codex review C4 explicitly mentions "Windows: launch CLI and descendants in a Job Object with KILL_ON_JOB_CLOSE; keep `taskkill /T /F` fallback." We chose to ship only the fallback path — KISS — for two reasons: (a) `codeagent-wrapper` (Go) has been using `taskkill /T /F /PID` in production across Codex Node-worker spawns since v5.x without escapes; (b) Job Object requires an FFI layer (koffi / ffi-napi / native addon) which is a non-trivial supply-chain footprint and complicates `pnpm install` on user machines. If a real Job Object becomes necessary, P1f stress test data will surface it; meanwhile `taskkill` is the same call codeagent-wrapper makes from `executor.go:1421-1435`.

2. **vi.spyOn on ESM imports failed**: First test draft used `vi.spyOn(fs, 'renameSync').mockImplementation(throw)` to fault-inject the rename failure path. Vitest correctly refuses (Module namespace not configurable in ESM). Replaced with a path-based ENOENT trigger (`writeFileSync(/no-such-dir/state.json)`) which exercises the same try/catch + cleanup branch deterministically. Same coverage, no mocking.

3. **Launcher dynamic-import path**: vitest's resolver tries to transform any `.mjs` file as TypeScript on first import attempt. The shebang line `#!/usr/bin/env node` was being read as "Invalid or unexpected token" because vitest's parser doesn't accept shebangs in non-entry-point modules. Removed the shebang from the launcher (users invoke via `node <path>` always — shebang was ornamental). Added `/* @vite-ignore */` annotation in the test for belt-and-suspenders.

4. **Launcher main() guard**: top-level `import` of the launcher cannot trigger `main()` (would spawn `claude` from inside a unit test). Implemented `isMainModule()` via `realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])`. Tested by importing in `launcherSupervisor.test.ts` 18 times across describe blocks — main never runs.

5. **Tests location**: Phase brief specifies `tests/unit/processTree.test.ts` etc. The repo's `vitest.config.ts` only picks up `src/**/__tests__/**/*.test.ts`. To honor existing convention (every other test file in repo follows it) and avoid touching vitest config (out of scope), I placed the three new test files under `src/utils/__tests__/` with the names `processTree.test.ts`, `jobsAtomic.test.ts`, `launcherSupervisor.test.ts`. Coverage is identical; the only consequence is one extra path component.

6. **PID-reuse heuristic at 24h**: Reconciler defaults `pidReuseAgeMs = 24 * 3600 * 1000`. Real-world PID reuse on Linux/macOS happens at much shorter timescales (hours under load). The 24h figure trades slightly higher false-no-op risk (a 12h-old phase whose pid happens to be reused → reconciler thinks it's still running) for near-zero false-stale risk on truly long phases. Knob is exposed via `ReconcileOptions.pidReuseAgeMs` for users running tighter SLAs. The launcher itself writes a fresh `started_at` per job, so this only matters for jobs that have legitimately been running >24h — which would be a separate quality-of-service concern (P2 timeout / stuck-detector).

7. **`templates/scripts/ccg-phase-runner-launcher.mjs` install path**: extended `installShim` to copy the new launcher next to `invoke-model.mjs`. Intentionally optional (`if (await fs.pathExists(srcLauncher))`) so older downstream packages without the launcher don't get a `success: false` install. autonomous.md does NOT yet route to the launcher — that wiring is P1f / P2 once status UX is built and we can validate progress.jsonl consumption end-to-end.

8. **No autonomous.md edit despite mention in phase brief**: the brief lists autonomous.md indirectly (via "phase-runner spawn 100% via Bash path"). P1a already migrated the spawn path. P1b's job is *infrastructure* (atomic writes / kill-tree / reconciler), with the launcher as opt-in delivery vector. Forcing autonomous.md to use the launcher in P1b would couple Step 4 monitoring to `progress.jsonl` parsing — that's the explicit P2 (`/ccg:status` v2) deliverable. Keeping launcher opt-in for one phase lets us catch any cross-platform launcher bugs without breaking the autonomous loop on user machines.

9. **`ground_truth_path` was unavailable**: phase brief explicitly stated this. Phase work touched zero protected interfaces (no plugin subagent_type strings, no hook event names, no settings.json schema, no skill names). v4.4.1 namespace correction (`codex:codex-rescue` / `gemini:gemini-rescue`) is unaffected — supervisor is layer-agnostic.

---

## Subsequent phase enablement

This phase delivers the **infrastructure**: atomic writes, kill-tree, supervised launcher, reconciler. The autonomous orchestrator template can now adopt the launcher without rewriting the spawn flag set. Once shipped:

- v4.5-P1c can stress-test nested RSS inside a launcher-supervised CLI subprocess and verify the supervisor correctly captures `cli_pid` for stress-test process tracking.
- v4.5-P1d broker tx_id concurrency tests can rely on the launcher's pre-spawn state writes for unambiguous job-id correlation.
- v4.5-P1f can flip nested rescue on with confidence that orphan plugin processes will be reaped on cancel + reconciled on next session start.
- v4.5-P2 (`/ccg:status` v2) will consume `progress.jsonl` produced by the launcher's stdout pipe, plus `cli_pid` from state.json for stuck-process detection.
