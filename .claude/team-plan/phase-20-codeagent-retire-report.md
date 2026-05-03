# Phase 20 Implementation Report — codeagent-wrapper → plugin migration

**Status**: completed
**Phase**: 20
**Phase Type**: backend
**Critical**: true
**Baseline SHA**: 8654fcb

---

## Files modified

### Templates (6 core commands updated for v4.1 plugin spawn dual-channel)
- `templates/commands/plan.md` — added "调用通道路由" preamble + dual-channel call syntax (Agent + Bash fallback)
- `templates/commands/execute.md` — same dual-channel migration applied to prototype-generation block
- `templates/commands/analyze.md` — same dual-channel migration
- `templates/commands/optimize.md` — same dual-channel migration
- `templates/commands/test.md` — same dual-channel migration
- `templates/commands/review.md` — header updated with v4.1 routing summary + dual-channel block

### Templates (deprecation notice)
- `templates/scripts/invoke-model.mjs` — added DEPRECATED-in-v4.1 comment block (lines 4-26), preserves runtime impl unchanged for BC

### Source (helper + exports)
- `src/utils/plugin-detection.ts` — **NEW** (177 lines): `detectPlugin()` / `detectPluginAvailability()` / `bothPluginsInstalled()` — fs-probe based, non-throwing, cross-platform, uses prefix matching for `codex@*` / `gemini@*` plugin dirs under `~/.claude/plugins/`
- `src/index.ts` — appended exports for new helper (`detectPlugin`, `detectPluginAvailability`, `bothPluginsInstalled` + types `PluginDetectionResult`, `PluginName`, `PluginDetectionAvailability` aliased to avoid collision with challenger-orchestrator's `PluginAvailability`)

### Tests
- `src/utils/__tests__/codeagentMigration.test.ts` — **NEW**: 40 tests
  - 6×4=24 template-content assertions (codex:codex-rescue / gemini:gemini-rescue / Agent syntax / fallback preserved / routing narrative)
  - 4 invoke-model.mjs deprecation-notice assertions
  - 1 BC: ≥40 codeagent-wrapper invocations preserved across templates
  - 11 plugin-detection helper unit tests (install / not-install / mixed / fs-error tolerance / both-installed)

---

## Acceptance verification matrix

| Acceptance item | Verification | Result |
|---|---|---|
| a. 6 templates rewritten with Agent spawn (codex:codex-rescue + gemini:gemini-rescue) | 6 file reads + 24 grep-based assertions | PASS |
| b. invoke-model.mjs has DEPRECATED comment + replacement guidance + v5.0 removal target | 4 deprecation-notice assertions | PASS |
| c. Fallback path preserved (Bash codeagent-wrapper still callable) | 6 templates × 1 BC assertion + ≥40 callsites preserved | PASS |
| d. plugin-detection helper detects install / not-install correctly with fs mocks | 11 unit tests covering happy / error / mixed / both paths | PASS |
| e. Single test file `codeagentMigration.test.ts` covers all of a-d + 51-callsite BC | 40/40 pass | PASS |
| f. Unchanged Go code / binary (none exists post-v3.0) | n/a — invoke-model.mjs only | PASS |
| g. Predicted main-thread context drop +5%→+1.5% per call | Documented; dogfood validation deferred to next /ccg:plan run | DEFERRED-AS-NOTED |

---

## Critical issues
None.

## Major issues
None during implementation. One self-corrected issue:

- During first `pnpm build`, the new `plugin-detection` exports in `src/index.ts` were not present in built output — appears index.ts was edited concurrently by another process (parallel P16/P17 phase tooling). Re-appended exports → build verified to include `detectPlugin`, `detectPluginAvailability`, `bothPluginsInstalled` in `dist/index.mjs` exports list.

## Notes

- File-boundary discipline respected: no edits to autonomous.md / debate.md / debug.md / init.md / workflow.md / hooks/ / skills/ / prompts/ / package.json / CHANGELOG.md / installer-* / skill-registry.ts / wave-scheduler.ts / specialist-router.ts / session-state / phase-context / debug-session / jobs / challenger-orchestrator / debate-orchestrator.
- P15 `--role` flag preamble preserved in all 6 templates (added Phase 20 routing block as a separate section above 多模型调用规范 — does NOT conflict with role-based routing matrix above it).
- Dual-channel design rationale: per-plugin independent detection allows mix-and-match (e.g. only codex plugin installed → backend goes plugin, frontend stays codeagent). This is captured in routing narrative in plan.md/execute.md.
- subagent vs main-thread distinction explicitly stated in templates: "本命令在主线 context 内，**允许** `Agent(...)`——与 subagent 引擎层禁止嵌套 spawn 约束不冲突". Prevents future contributors from mistakenly applying phase-runner.md's Agent prohibition to these orchestrator-layer templates.
- v3.0+ has no Go binary in the repo (it was retired and replaced by `templates/scripts/invoke-model.mjs`). Acceptance item f is satisfied by leaving invoke-model.mjs runtime untouched and only adding the deprecation comment.
- Test count delta: +40 tests (653 baseline + 64 from concurrent P16/P17 phases + 40 mine = 757). All 25 test files / 757 tests pass.
- Typecheck pass. Build pass.
