# CCG v4.5 PoC Backend Architecture Review

Date: 2026-05-06

Reviewer: Codex

Verdict: GO-WITH-FIXES

The v4.5 direction, replacing long-lived in-process `Agent(subagent_type="phase-runner")` calls with `Bash(claude -p --agent ccg/phase-runner ...)`, is architecturally sound for the original production failure: it moves phase-runner transcript/state growth out of the main `claude.exe` process and lets the OS reclaim the child process when the phase exits.

The PoC does not yet justify enabling the revived three-layer nested G-plan as a default production path. T9 proves nested spawn availability, not nested spawn safety. The required P1 work is process supervision, memory stress testing, broker transaction isolation, recovery reconciliation, and a real prompt-cache/cost benchmark.

## Artifacts Reviewed

Required PoC artifacts:

- `.ccg/poc-v45/poc-results.md`
- `.ccg/poc-v45/t1.out`
- `.ccg/poc-v45/t2.out`

Directory check result: no `t*.stream` files were present in `.ccg/poc-v45`.

Additional same-directory artifacts read as supporting context:

- `.ccg/poc-v45/t1.err`
- `.ccg/poc-v45/t2.err`
- `.ccg/poc-v45/test1-trivial.txt`
- `.ccg/poc-v45/test4-stream.txt`
- `.ccg/poc-v45/test7-progress.txt`
- `.ccg/poc-v45/test9-nested-spawn.txt`

Repo design evidence read for existing CCG constraints:

- `templates/commands/autonomous.md`
- `templates/commands/cancel.md`
- `src/utils/jobs.ts`
- `.claude/plan/v4.4.2-verify-wave-bash-direct.md`
- `CHANGELOG.md`

## PoC Evidence Baseline

The PoC report states the goal explicitly: validate `claude -p --agent phase-runner` as a replacement for `Agent(subagent_type="phase-runner")` to eliminate the main-process transcript leak.

Key PoC facts used in this review:

- T1: project-cwd CLI phase-runner passed, wall 7s, total cost `$0.412`, `cache_creation_input_tokens=65,863`, `cache_read_input_tokens=0`.
- T2: `--bare` failed under OAuth with "Not logged in"; `--bare` skips OAuth/keychain and requires explicit `ANTHROPIC_API_KEY` or `apiKeyHelper`.
- T3: clean-cwd CLI phase-runner passed, wall 17s, total cost `$0.135`, `cache_creation_input_tokens=19,871`, `cache_read_input_tokens=20,684`.
- T4: `--output-format stream-json` produced no stdout without `--verbose`.
- T4b: `stream-json --verbose` passed with 47 events.
- T7: `Bash(run_in_background=true)` plus redirected `stream-json` file showed live progress, with events growing 34 -> 62 -> 70 -> 73 over about 30 seconds; final `result.result` was parseable.
- T9: CLI subprocess had Agent tool available and one nested `general-purpose` spawn succeeded in 2515ms.

The PoC conclusions also include important caveats:

- D6/D7/D8 propose progress capture through `.context/jobs/<job-id>/progress.jsonl` and parsing final `result.result`.
- D9 skips `--bare` for v4.5 v1 because OAuth users cannot use it without additional auth setup.
- D10 proposes allowing subprocess phase-runner to nested-spawn `Agent(codex:codex-rescue)`.
- Open question #4 explicitly defers Windows process-semantics design for killing the main thread while background `claude` subprocesses exist.

## Executive Assessment

The OS process boundary fixes the original failure mode only at the outer phase-runner boundary:

```text
main claude.exe
  -> CLI claude subprocess per phase
```

That means the main process should no longer retain every phase-runner sidechain transcript for the whole 7.5h autonomous run.

The revived G-plan adds another dynamic:

```text
main claude.exe
  -> CLI claude subprocess per phase
       -> nested Agent(codex:codex-rescue | gemini:gemini-rescue | general-purpose)
            -> plugin or subagent process
```

This may still be acceptable, but only if the CLI subprocess is treated as a supervised worker with bounded lifetime, bounded nested-spawn count, crash-safe job state, process-tree cleanup, and transaction-scoped broker logging. T9 is a capability test, not a load, failure, or memory test.

## C1 - Nested Spawn RSS Accumulation In CLI Subprocess

### What the PoC Proved

T9 proves that a CLI subprocess launched through `claude -p --agent ccg/phase-runner` has the Agent tool and can successfully run one nested `general-purpose` spawn. The report records `agent_tool_present:true`, `nested_spawn_works:true`, and a 2515ms nested spawn.

### What the PoC Did Not Prove

T9 did not measure RSS before or after the nested spawn. It did not run repeated nested spawns. It did not use `codex:codex-rescue` or `gemini:gemini-rescue`. It did not use large prompts, long transcripts, file edits, or multi-hour phase behavior. It did not run nested spawns concurrently across multiple phase-runner subprocesses.

The original production incident was a retention problem: main `claude.exe` RSS grew from 13GB to 23GB over 7.5h while running 30+ phase-runner subagents. Moving phase-runner into a CLI subprocess prevents that growth from accumulating in the main process, but it does not prove that nested Agent sidechains inside the CLI subprocess are released before that CLI subprocess exits.

### RSS Estimate

Observed production growth supplied in the task:

- Main process RSS delta: `23GB - 13GB = 10GB`.
- Number of phase-runner subagents: `30+`.

Derived estimate, clearly labeled:

- If the 10GB came from exactly 30 retained sidechains, retained RSS proxy is about `10GB / 30 = 333MB` per sidechain.
- If the real count was 40, proxy is about `250MB` per sidechain.
- If the real count was 50, proxy is about `200MB` per sidechain.

Planning estimate for unmeasured nested CLI-side retention:

| Scenario | Estimate |
|---|---:|
| Per nested Agent retained RSS proxy | 200-333MB |
| Typical phase with 5 nested spawns | 1.0-1.7GB retained in the CLI subprocess |
| 4 concurrent phase-runner subprocesses, each with 5 nested spawns | 4.0-6.7GB aggregate transient child-process RSS |

These are not observed T9 measurements. They are risk estimates using the production leak as a proxy because the PoC did not collect RSS telemetry.

### Architectural Risk

The main `claude.exe` should be protected by the outer subprocess boundary, but a long phase-runner CLI subprocess can still balloon enough to fail the phase, exhaust page file during high concurrency, or trigger OS-level memory pressure before it exits. If a CLI subprocess is orphaned, the leak can also outlive the main session.

### Required P1 Fix Action

Add a P1 memory stress suite before enabling nested G-plan by default:

1. Start one CLI phase-runner subprocess and record baseline Working Set/RSS.
2. Run 5, 10, and 20 nested Agent spawns in the same subprocess.
3. Test both trivial `general-purpose` and real plugin agents (`codex:codex-rescue`, `gemini:gemini-rescue`) if installed.
4. Record RSS after each nested spawn, after each nested completion, and after outer CLI exit.
5. Repeat with autonomous-style concurrency: 4 outer CLI subprocesses x 5 nested spawns.
6. Gate production rollout on a measured per-nested-spawn retained slope and a configured cap.

Until this exists, nested G-plan should be opt-in or disabled. The safe default is outer CLI subprocess phase-runner self-implementation with no nested rescue delegation.

## C2 - Three-Layer Process Chain Crash Recovery

### Chain Under Review

```text
main claude.exe
  -> CLI subprocess: claude -p --agent ccg/phase-runner
       -> nested Agent/plugin process
```

### Current PoC Coverage

T7 validates live progress observation through redirected `stream-json` and final parsing through `result.result`.

The PoC does not test:

- main process crash while CLI child continues,
- CLI child crash,
- nested plugin crash or hang,
- budget overrun behavior,
- parser failure on malformed final event,
- Windows Ctrl+C behavior,
- orphan cleanup,
- restart reconciliation.

The PoC itself defers `--max-budget-usd` overrun behavior and Windows process semantics in Open questions #2 and #4.

### Existing CCG State Model

`src/utils/jobs.ts` defines a filesystem job protocol under `.context/jobs/<job-id>/` with:

- `state.json`
- `result.md`
- `cancel.flag`

The file comments state "No daemon, no IPC, no DB - just files." This is a reasonable crash-recovery substrate, but current writes use direct `writeFileSync` to `state.json` and `result.md`, not temp-file-plus-rename atomic commits.

`templates/commands/cancel.md` explicitly says cancellation is cooperative and that CCG does not hold child PIDs. That is not enough for v4.5 subprocess supervision.

### Failure Mode Map

| Failure | Data-loss risk | State inconsistency risk | Orphan risk | Required behavior |
|---|---|---|---|---|
| Main crashes before CLI launch | Low | job may be queued/running without child PID | Low | state remains queued; startup reconciler marks stale queued jobs failed or retryable |
| Main crashes after CLI launch | Medium | CLI may finish but roadmap remains `in_progress` | High unless supervised | child writes result/status; restart reconciler reads result and updates roadmap or prompts user |
| Main receives Ctrl+C | Medium | cancel flag may not be written or observed | High | signal handler writes cancel flag, then kills process tree after grace period |
| T2-style auth failure at CLI startup | Low | job may remain running if exit not parsed | Low | nonzero/JSON error marks job failed with stderr summary |
| CLI crashes before final result | Medium | `progress.jsonl` partial, `state.json` running | Possible nested child remains | parent watches exit code; if no result, mark failed and kill tree |
| CLI exceeds `--max-budget-usd` | Medium | unknown final event/exit behavior; PoC untested | Medium | P1 must test and define result contract before relying on budget guardrail |
| CLI killed during nested plugin edit | High | partial file edits, report missing, maybe no commit | High | per-phase worktree or transactional sentinel; parent blocks roadmap completion until commit/result verified |
| Nested plugin crashes loudly | Low-Medium | CLI may retry or return partial | Medium | CLI must convert plugin error to structured phase failure, not success |
| Nested plugin hangs | Medium | CLI waits until timeout; parent sees no progress | High | per-nested timeout, heartbeat, process-tree kill |
| Nested plugin silent fallback | High | false `completed` summary from wrapper path | Low | use direct plugin Bash for critical verify, or require proof that nested Agent path cannot self-answer |
| Plugin succeeds but CLI dies before writing result | Medium | code/report/commit may exist but job failed | Low-Medium | reconciler validates commit sha/report and offers adopt/fail |
| CLI writes result but main parser fails | Low | job done but roadmap not advanced | Low | store raw final JSONL and result.md; parser retry path |
| Main updates roadmap before child result is durable | Medium | roadmap says completed without durable evidence | Low | roadmap update must be last step after atomic result, commit sha, and status done |

### Architectural Boundary Rule

Use one writer per state domain:

- Main orchestrator owns roadmap scheduling and final roadmap status transitions.
- CLI phase-runner owns its job-local progress, result, and phase summary.
- Nested plugin owns only its delegated work product inside the phase scope.

No layer should infer success from process exit alone. A phase is complete only if the parent sees all of:

1. terminal CLI exit status or terminal `result/success`,
2. parseable phase summary,
3. expected report/result file,
4. declared commit sha or explicit `COMMIT: none` with valid reason,
5. no active child PIDs in the job process tree.

### Required P1 Fix Action

Add a `ccg-phase-runner-launcher` supervisor rather than launching raw `claude -p` directly from template text:

- allocate job id,
- write initial state with parent PID, CLI PID, process group/job id, command, cwd, started_at,
- redirect stdout/stderr/progress to per-job files,
- monitor exit code,
- atomically write terminal state using temp file + rename,
- reconcile on startup,
- provide kill-tree semantics.

Add fault-injection tests for every row in the failure-mode table.

## C3 - broker.log Concurrent Race

### Existing Known Hazard

CCG v4.4.2 already documented that `broker.log` concurrent spawn conflict false positives were the core hazard for the PostToolUse-hook approach. The changelog says PostToolUse was avoided partly because concurrent plugin spawn can make `broker.log` checks misattribute failures.

The v4.4.2 plan also records that Bash direct invocation bypasses the sonnet wrapper but still reuses the broker. That means broker correctness remains relevant whenever nested plugin execution is revived.

### What the PoC Tested

The PoC did not test broker concurrency.

T9 nested-spawned `general-purpose`, not `codex:codex-rescue` or `gemini:gemini-rescue`. Therefore T9 did not exercise:

- plugin broker startup,
- `broker.log`,
- tx_id generation,
- tx_id correlation,
- concurrent append/read behavior,
- false-positive detection under load.

### Concurrency Multiplier

Autonomous already supports wave parallelism with `--max-concurrent N`, default 4. The v4.5 nested G-plan can add multiple nested rescue spawns inside each phase-runner. If a typical phase can spawn 5 nested rescue calls, then the broker may see:

```text
4 outer phase-runner subprocesses x 5 nested plugin spawns = 20 concurrent broker transactions
```

That is a different stress regime from a single T9 nested spawn.

### tx_id Uniqueness Risk

The PoC provides no tx_id sample. Therefore tx_id uniqueness must be treated as unverified.

Requirements:

- tx_id must include at least 128 bits of randomness or equivalent collision resistance.
- tx_id must be generated before broker invocation and passed through all broker log lines.
- Every log line must include `tx_id`, `job_id`, `phase_id`, `outer_cli_pid`, `plugin_pid`, event type, timestamp, and sequence.
- Readers must correlate only by exact tx_id, never by time window, tail position, nearest error line, or process-global "last failure".

If tx_id is timestamp-only, phase-id-only, or prompt-derived, collisions or misattribution are plausible under 20-way concurrency.

### Read-Modify-Write Atomicity Risk

A global `broker.log` is safe only as an append-only event stream. It is not safe as a mutable state store.

Unsafe patterns:

- read tail of global broker.log, infer current transaction from latest lines,
- scan for recent failure markers without tx_id filtering,
- update a shared JSON status file by read-modify-write from multiple processes,
- write multiline JSON events in multiple syscalls,
- let PostToolUse hook classify one spawn based on another spawn's broker event.

Required patterns:

- per-job or per-tx broker event files, or a transaction-scoped SQLite/WAL store,
- atomic append of exactly one JSONL event per syscall where possible,
- per-tx state file committed by temp-file-plus-rename,
- lock or compare-and-swap for any shared state update,
- parser rejects events missing tx_id/job_id,
- parent/plugin success must be based on the matching tx_id terminal event.

### Required P1 Fix Action

Add a broker stress test before nested G-plan rollout:

1. Launch 4 outer CLI phase-runner subprocesses.
2. Inside each, launch 5 plugin transactions concurrently.
3. Add randomized sleeps and forced failures.
4. Assert 100% tx_id uniqueness.
5. Assert no transaction observes another transaction's failure/success.
6. Assert terminal status for each tx matches its own process result.
7. Repeat on Windows and Linux.

If this cannot be made reliable quickly, do not use nested Agent plugin spawn for v4.5 P1. Keep plugin calls in direct Bash mode with per-job output files, or isolate broker state per job.

## C4 - Parent Kill Orphan Cleanup

### PoC Coverage

T7 proves that a background CLI subprocess can write progress to a stream file while the parent polls it. It does not prove kill propagation.

The PoC explicitly defers this: Open question #4 asks whether killing the main thread propagates to background `claude` subprocesses and says explicit cancellation needs design.

Existing `/ccg:cancel` design is cooperative. It writes `.context/jobs/<job-id>/cancel.flag` and explicitly says not to kill processes because CCG does not hold child PIDs. That is insufficient for v4.5 because v4.5 intentionally creates OS child processes.

### Windows Semantics

On Windows, killing a parent process does not automatically kill its child processes. Ctrl+C delivery depends on console process group attachment and creation flags; background or detached children may not receive it. If the child process spawns additional plugin processes, those grandchildren may survive even if the CLI process is killed unless the whole tree is terminated.

Robust Windows cleanup requires one of:

- a Job Object with kill-on-job-close semantics, or
- a supervisor that records PIDs and uses `taskkill /T /F /PID <pid>` as a fallback.

The repo already contains a precedent in `codeagent-wrapper`: it uses process-tree termination on Windows because child processes can survive and hold stdout handles. That is exactly the class of failure v4.5 must design around.

### Linux/macOS Semantics

On POSIX systems, killing the parent process does not guarantee child termination. If children are in the same foreground process group, terminal Ctrl+C may reach them; if they are backgrounded, detached, or reparented, they may continue. Robust cleanup should launch the worker in a process group/session and kill the process group on cancellation or parent death.

### Nested Plugin Orphan Risk

If the CLI subprocess nested-spawns plugin processes, the plugin process may outlive both:

- the main orchestrator, and
- the CLI phase-runner subprocess.

This is the highest-risk orphan case because the plugin may continue editing files or consuming tokens after the user believes autonomous was canceled.

### Required P1 Fix Action

Add explicit process supervision:

- Windows: launch CLI and descendants in a Job Object with `KILL_ON_JOB_CLOSE`; keep `taskkill /T /F` fallback.
- Linux/macOS: launch CLI in a dedicated process group/session; terminate with SIGTERM to process group, then SIGKILL after grace period.
- Record `cli_pid`, process group/job id, start time, cwd, and command in `state.json`.
- On Ctrl+C: write `cancel.flag`, wait a short grace period, then kill the tree.
- On startup: scan `.context/jobs/*/state.json`; for `running` jobs, verify whether the PID is alive and whether the process start time matches. Mark stale jobs failed or reconcile completed result files.
- Verify nested plugin processes inherit the same job/process group. If Agent-created plugin processes escape the supervisor, nested G-plan is not production-safe on Windows.

## C5 - Prompt Cache TTL Hit Rate

### What the PoC Shows

T1 raw artifact:

- `total_cost_usd = 0.41232375`
- `cache_creation_input_tokens = 65,863`
- `cache_read_input_tokens = 0`

T3 in the PoC report:

- `total_cost_usd = 0.135`
- `cache_creation_input_tokens = 19,871`
- `cache_read_input_tokens = 20,684`

This means independent CLI subprocesses can get cache reads for some shared prompt prefix. The cache is not purely a parent-process memory cache. However, T1 also shows a project-cwd spawn can be fully cold, and T3 still created 19,871 new cached tokens even while reading 20,684 cached tokens.

Therefore the right conclusion is:

- Cache sharing is possible across CLI subprocesses.
- Parent-to-child warm sharing is not guaranteed.
- Warm hit rate depends on identical prompt prefixes, cwd-discovered context, model, account, and TTL.
- The PoC did not demonstrate an 80% warm hit rate across 80 production-like spawns in the target workdir.

### Why The 20% Cold / 80% Warm Projection Is Not Proven

The PoC cost projection says:

- Triple tier x 20 phases = 80 spawns.
- About 16 cold at `$0.135` each plus 64 warm at about `$0.005` each.
- Estimated overhead: about `$2.50/run`.

This is based on a clean-cwd baseline. But the implementation decision D5 says subprocess cwd must be the phase workdir, not the clean PoC directory, because real edits need the project workdir. The PoC's own Finding 2 says cwd controls auto-discovery cost and that project-root cwd created 65,863 cached tokens and cost `$0.412`.

### Recalculated Cost Scenarios

Using the PoC's 80-spawn assumption:

| Scenario | Formula | Estimate |
|---|---:|---:|
| PoC optimistic projection | `16 x $0.135 + 64 x $0.005` | `$2.48` |
| No warm hits, clean-cwd-like cold cost | `80 x $0.135` | `$10.80` |
| No warm hits, PoC-stated typical business repo cost | `80 x $0.15-$0.20` | `$12.00-$16.00` |
| No warm hits, ccg-workflow project-root observed cost | `80 x $0.41232375` | `$32.99` |

The last row is not a typical user repo estimate; it is the observed T1 project-root worst case for this repo.

Nested plugin costs are not included in this table because the PoC did not measure real nested `codex:codex-rescue` or `gemini:gemini-rescue` cost. If a phase can make 5 nested plugin calls, P1 must separately measure those calls.

### Required P1 Fix Action

Add a prompt-cache benchmark:

1. In the actual phase workdir, run 80 CLI subprocess invocations with production-like prompts within the relevant TTL window.
2. Record per-spawn `cache_creation_input_tokens`, `cache_read_input_tokens`, total cost, model, cwd, prompt hash, and elapsed time.
3. Repeat after TTL expiry.
4. Repeat with distinct phase prompts and repeated identical prompts to separate stable-prefix caching from phase-specific cold creation.
5. Report p50/p90 cost and cache hit rate.

Until this benchmark exists, budget planning should use `$10.80-$16.00/run` for typical repos and `$32.99/run` for ccg-workflow-like context-heavy repos, not `$2.50/run`.

## Cross-Cutting P1 Phase Plan Recommendation

Split v4.5 P1 into explicit sub-phases:

1. P1a - Outer CLI subprocess MVP:
   - Replace main-process `Agent(phase-runner)` with supervised `claude -p --agent ccg/phase-runner`.
   - Preserve self-implementation behavior.
   - Do not enable nested rescue delegation yet.

2. P1b - Process supervisor and recovery:
   - Implement launcher, PID/job tracking, progress capture, atomic state writes, kill-tree semantics, and startup reconciliation.
   - Cover Windows Job Object or `taskkill /T` fallback and POSIX process groups.

3. P1c - Memory stress gate:
   - Run repeated nested Agent RSS tests.
   - Decide default nested-spawn cap from measured slope.

4. P1d - Broker transaction isolation:
   - Add tx_id/job_id-scoped logging or per-job broker output.
   - Stress 20-way concurrent nested plugin transactions.

5. P1e - Cost/cache benchmark:
   - Measure 80 production-like CLI invocations in actual workdir.
   - Publish cost bands and defaults.

6. P1f - Nested G-plan gated rollout:
   - Enable nested `codex:codex-rescue`/`gemini:gemini-rescue` only after P1b-P1e pass.
   - Keep direct Bash plugin invocation for verify-critical paths unless nested Agent is proven not to silently self-answer.

## Final Verdict

GO-WITH-FIXES.

The outer CLI subprocess approach should proceed because it directly addresses the original main-process RSS leak. The nested G-plan should not be treated as production-approved from T9 alone. T9 unlocks a capability; it does not validate memory behavior, broker correctness, crash recovery, orphan cleanup, or cost.
