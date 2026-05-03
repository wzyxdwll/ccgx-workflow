# Phase 7 Offload Report — Async Triplet (status / result / cancel)

**Status**: completed (degraded mode — fallback, no codex:rescue spawn)
**Phase ID**: phase-07-async-triplet
**Phase Type**: backend
**Baseline commit**: 256beb3 (drift +6 commits via Phase 1.5–6, current HEAD pre-commit: 8f212d8)

## Files modified / created

| Path | Kind | Notes |
|------|------|-------|
| `src/utils/jobs.ts` | new (218 lines) | helper module: listJobs / getJob / writeJobState / writeJobResult / readJobResult / requestCancel / isCancelRequested / sanitizeJobId + path helpers |
| `src/utils/__tests__/jobs.test.ts` | new (~230 lines) | 23 vitest cases covering schema, lifecycle, cancel, listJobs sort, corrupt-dir tolerance |
| `templates/commands/status.md` | new | 3 modes — list / single / `--wait --timeout-ms` |
| `templates/commands/result.md` | new | reads `result.md`, prints metadata, fallback when result missing |
| `templates/commands/cancel.md` | new | writes `cancel.flag`, idempotent, cooperative-cancel contract documented |
| `src/utils/installer-data.ts` | modified (+5 lines) | registered status (9.92) / result (9.94) / cancel (9.96) under "Async job triplet (v4.0 Phase 7)" section |

## Acceptance verification matrix

| Criterion | Status | Evidence |
|-----------|--------|----------|
| `templates/commands/status.md` no-arg list mode | PASS | "Mode A" section with elapsed / summary 60-char truncation |
| `status <job-id>` single-detail mode | PASS | "Mode B" section pretty-prints state.json + appends result.md |
| `status <job-id> --wait --timeout-ms <ms>` blocking | PASS | "Mode C" with 2s polling, 60s default / 600s ceiling, exit-0 on timeout |
| `templates/commands/result.md` ≤ 200 token summary | PASS | Step 3 — direct print of result.md (already 200t by phase-runner contract) + metadata footer |
| `templates/commands/cancel.md` writes cancel.flag | PASS | Step 2 — writes flag + flips `cancel_requested=true`, status untouched |
| `.context/jobs/<id>/` schema (state.json) | PASS | JobState interface — task_id / kind / status / phase_id / started_at / last_update / summary / cancel_requested |
| `src/utils/jobs.ts` listJobs / getJob / writeJobState / requestCancel | PASS | exported + tested |
| Schema validation throws on missing fields | PASS | jobs.test.ts case "throws on missing required fields" + "throws on invalid status enum" |
| ≥10 unit tests | PASS | 23 cases, 9 describe blocks |
| Required scenarios covered | PASS | create→state.json exists / listJobs all / getJob single / cancel writes flag / schema-missing-throws — all explicitly asserted |
| installer-data.ts registers 3 commands | PASS | id 9.92/9.94/9.96 added |
| installer.test.ts assertion still passes | PASS | uses `>=20` lower bound (now 34) — green |

## Critical issues

None.

## Major issues

None. Two design notes for future phases:

1. **Cooperative-cancel contract not yet enforced in producers.** `cancel.md` documents the producer-side check (phase-runner / codex:rescue / autonomous loop should call `isCancelRequested` between ticks). Wiring those producers is out-of-scope for Phase 7; tracked implicitly for Phase 8+.
2. **No JS API exposure to commands.** Slash command templates use Bash/Read shell-equivalent prose rather than importing `jobs.ts` directly (no public lib path published yet). Consistent with how `phase-context.ts` is consumed today.

## Pending handoff

| Type | Required? | Notes |
|------|-----------|-------|
| `git_commit` | YES | `feat(v4-p7):` prefix per phase contract |
| `test_run` | DONE in offload | `pnpm test` → 358/358 passing (332 baseline + 23 new + 3 from prior phases) |
| `typecheck` | DONE in offload | `pnpm typecheck` → exit 0 |
| `build` | not requested | not in acceptance |

## Notes

Pure additive change — zero edits to existing tests / commands / scripts. roadmap.md left untouched (autonomous main thread owns it).
