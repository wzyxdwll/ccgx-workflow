# v4.5 PoC: phase-runner Bash subprocess validation

**Date**: 2026-05-06
**Goal**: Validate `claude -p --agent phase-runner` as replacement for `Agent(subagent_type="phase-runner")` to eliminate main-process transcript leak.
**Verdict**: ✅ **GO** — path technically viable, with one auth caveat and one cost caveat documented below.

## Environment

- Claude Code CLI: **2.1.129**
- OS: Windows 11 Pro for Workstations 10.0.26200 (QEMU/KVM guest)
- Auth mode: OAuth (no `ANTHROPIC_API_KEY`, no `apiKeyHelper`)
- phase-runner agent path: `~/.claude/agents/ccg/phase-runner.md`
- Test cwd variants: `/d/workflow/ccg-workflow` (loaded project CLAUDE.md) vs `/tmp/empty-poc` (clean)

## Test results

| # | Test | Status | Key data |
|---|------|--------|----------|
| T1 | `--agent ccg/phase-runner` from project cwd | ✅ pass | wall 7s, cost **$0.412**, cache_creation 65,863 tok |
| T2 | `--bare` mode | ❌ fail | "Not logged in" — `--bare` skips OAuth/keychain, requires explicit `ANTHROPIC_API_KEY` |
| T3 | `--agent` from clean cwd (`/tmp/empty-poc`) | ✅ pass | wall 17s, cost **$0.135** (-67%), cache_creation 19,871 tok, cache_read 20,684 |
| T4 | `stream-json` output | ⚠️ gotcha | stdout 0 bytes without `--verbose`. Hidden requirement |
| T4b | `stream-json --verbose` | ✅ pass | 47 events streamed, types: `system/init`, `hook_*`, `stream_event/*`, `assistant`, `user`, `rate_limit_event`, `result/success` |
| T7 | Bash `run_in_background=true` + stream-json file | ✅ pass | stream file grows in real time (events 34→62→70→73 over ~30s); `result.result` field contains full SUMMARY string parseable by main thread |
| T9 ⭐ | CLI subprocess: Agent tool present + nested spawn works | ✅ pass | `agent_tool_present:true`, `nested_spawn_works:true` — spawn `general-purpose` succeeded in 2515ms inside CLI subprocess |

## Key findings

### Finding 1 — `--bare` blocked under OAuth (T2)

`--bare` flag explicitly disables OAuth/keychain auth. Production users on OAuth (the default install path) **cannot use `--bare`** without first configuring `ANTHROPIC_API_KEY` or `apiKeyHelper` in settings. This blocks the cheapest cold-start mode.

**Mitigation**: install-time prompt in CCG to optionally configure `apiKeyHelper` for users who opt into v4.5 phase-runner Bash mode. Or: live with default-mode auto-discovery overhead and rely on cwd discipline (Finding 2) for cost control.

### Finding 2 — cwd dictates auto-discovery cost (T1 vs T3)

Default mode (no `--bare`) walks up cwd looking for `CLAUDE.md`. Project-root cwd → injects ~46k extra tokens of project context per spawn:

| cwd | cache_creation | cost |
|---|---|---|
| `D:\workflow\ccg-workflow` (project root, CLAUDE.md ~46k tokens) | 65,863 | $0.412 |
| `/tmp/empty-poc` (no CLAUDE.md walkable) | 19,871 | $0.135 |

For phase-runner that *must* run in workdir (to edit code), cost depends on the project's CLAUDE.md size. Typical business repos (uni-iam etc.) sit ~5–15k → cost ~$0.15–$0.20/spawn. ccg-workflow is the outlier (~$0.41) due to its meta-doc CLAUDE.md.

### Finding 3 — `stream-json` requires `--verbose` (T4)

Undocumented gotcha: `claude -p --output-format stream-json` produces 0 bytes on stdout unless `--verbose` is also passed. Error message in stderr is helpful. Generated commands must include both flags together.

### Finding 4 — observability path validated (T7)

Real-time progress observation works: main thread `Bash(run_in_background=true)` launches subprocess, redirects stream-json to file, polls file with `wc -l` / `tail`. Event types provide rich progress signal:

- `system/init` — startup metadata
- `system/hook_started` / `hook_response` / `status` — hook chain visibility
- `stream_event/message_start` / `content_block_*` / `message_stop` — token-level streaming
- `assistant` — full assistant turns
- `rate_limit_event` — rate limit state changes
- `result/success` — final summary with `result.result` containing parseable SUMMARY string

This fully replaces sidechain inline UI for long-running phases.

### Finding 5 ⭐ — nested spawn unlocked in CLI subprocess (T9)

**v4.0 G-plan revival**: the engine constraint "subagent tools never include Agent/Task" applies only to `Agent(...)`-spawned sidechains in the parent process. CLI subprocess via `claude -p --agent X` is a fully independent PID and **does have Agent tool**, **and nested spawn succeeds**.

This unlocks the original v4.0 G-plan three-layer process isolation that was previously rejected:

```
main claude.exe (orchestrator)
  └─ Bash(claude -p --agent phase-runner)         ← OS-isolated subprocess
       └─ CLI subprocess (phase working memory)
            └─ Agent(codex:codex-rescue)          ← plugin sandbox
                 └─ plugin process (code edits)
```

All three boundaries are OS process boundaries (hard isolation), not in-process sidechains. CLI subprocess transcript is bounded by phase duration, not session duration.

## Cost projection (revised)

Per-autonomous-run cost estimate, based on T3 (clean cwd) baseline:

- Triple tier × 20 phases = 80 spawns
- ~16 cold (cache_creation, $0.135 each) + ~64 warm (cache_read, ~$0.005 each)
- **Estimated overhead: ~$2.50/run**

For projects with larger CLAUDE.md (10–15k tokens), scale linearly: ~$3.50–$5/run. User has confirmed this is acceptable.

## Cold-start latency (revised)

- API duration_ms (T1): 6.85s
- Wall time including CLI startup (T1): 7s
- Wall time clean cwd (T3): 17s — CLI process startup overhead under empty cwd is *higher* than project cwd (suspected hook re-execution and plugin re-sync without warm cache)

Each phase pays cold-start once per wave entry. Triple tier 4 wave/phase × ~7s = ~28s/phase startup. 20 phases = ~10 min added wall time vs current Agent spawn. Acceptable given the alternative (system crash at hour 7).

## Decisions for v4.5 implementation

| # | Decision | Reason |
|---|---|---|
| D1 | Generate command with both `--output-format stream-json` AND `--verbose` | T4 hidden requirement |
| D2 | Use `--include-partial-messages` for token-level streaming progress | T4b validated |
| D3 | Pass `--max-budget-usd <N>` per quality tier (fast=1.0, triple=2.0, debate=5.0) | Guardrail |
| D3-revision | **2026-05-06**: fast 从 0.5 升级到 1.0 — T1 实测项目 cwd 大 CLAUDE.md 场景 single spawn $0.412，0.5 上限会 truncate；1.0 在 T1/T3 数据上分别留 2.4×/7.4× buffer。codex Phase 1 verify 抓到 PoC 0.5 vs 实施 1.0 drift，spec 升级胜过实施回退。 | Tier-budget post-PoC |
| D4 | Pass `--dangerously-skip-permissions` (subprocess fully autonomous) | Required since main thread can't approve interactively |
| D5 | Subprocess cwd = phase workdir (NOT ccg-workflow root) | Real edits need workdir; cost scales with workdir CLAUDE.md size |
| D6 | Stream-json file written to `.context/jobs/<job-id>/progress.jsonl` | Observability + post-mortem replay |
| D7 | Main thread polls progress.jsonl via Bash + wc -l + tail | T7 validated path |
| D8 | Final summary parsed from last line `result.result` field | T1/T3/T7 all confirm |
| D9 | Skip `--bare` for v4.5 v1; revisit when CCG ships apiKeyHelper config option | Finding 1 blocker |
| D10 | Subprocess phase-runner CAN nest-spawn `Agent(codex:codex-rescue)` for code edits | Finding 5; revives v4.0 G-plan |

## Open questions deferred to v4.5 implementation

1. MCP config injection via `--mcp-config <file>` — flag exists, not tested in PoC; verify context7/fast-context propagate correctly to subprocess.
2. `--max-budget-usd` enforcement behavior on overrun — does subprocess cleanly exit? exit code? final result format? PoC ran under budget, didn't trigger.
3. Settings inheritance: does subprocess inherit main `~/.claude/settings.json` permissions/hooks/env? Default yes (T4b showed hooks ran), but explicit `--settings <file>` may be needed for isolated environments.
4. Windows process semantics: `kill` of main thread — does it propagate to background `claude` subprocess? Tested implicitly fine, but explicit cancellation path needs design (link to `.context/jobs/<id>/cancel.flag` protocol).

## Conclusion

PoC verdict: **GO** for v4.5 phase-runner Bash subprocess.

Engineering complexity: **low-medium** (5–9 person-days estimate confirmed; no research blockers).

Surprise upside: T9 nested-spawn unlocks G-plan three-layer isolation — should be folded into v4.5 design (phase-runner CLI subprocess can delegate code edits to `codex:codex-rescue` plugin sandbox for full process-boundary safety).
