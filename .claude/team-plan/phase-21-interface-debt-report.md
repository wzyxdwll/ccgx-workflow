# Phase 21 Offload Report — 接口债清理 + plugin 摘要实测

**Status**: completed
**Phase**: v4.2-p21
**Baseline**: 4f86cbc (v4.1.0 release)
**Date**: 2026-05-04

---

## Files modified

### 新建
- `src/utils/multi-model-routing.ts` — SSoT 模块（Layer / Model / PluginAvailability / Role union types + ALL_LAYERS / isLayer 守卫 + ROUTING_SCHEMA_VERSION）
- `src/utils/__tests__/multiModelRouting.test.ts` — 16 test cases
- `src/utils/__tests__/parseFindingsRobust.test.ts` — 16 test cases
- `.claude/team-plan/phase-21-plugin-summary-formats.md` — 5 模块假设审计 + 置信级别 + P22/P23 实测协议
- `.claude/team-plan/phase-21-interface-debt-report.md` — 本报告

### 重构
- `src/utils/specialist-router.ts` — `SpecialistLayer = Extract<Layer, ...>` + 删 `implementer → architect.md` 假设 + 删 `writer × frontend → analyzer.md` 假设
- `src/utils/challenger-orchestrator.ts` — 删重复 `PluginAvailability` interface 改 import SSoT；`PhaseType` import → `Layer` import；`parseFindings` 鲁棒化（JSON fence strip + 单/双引号 normalize + balanced-bracket tokenizer + extractFindingViaRegex 兜底）
- `src/utils/debate-orchestrator.ts` — `DebateLayer = Extract<Layer, ...>`
- `src/utils/plugin-detection.ts` — 删重复 `PluginAvailability` interface 改 import SSoT
- `src/utils/phase-runner.ts` — `PhaseType` 改为 SSoT `Layer` 别名
- `src/utils/__tests__/specialistMatrix.test.ts` — 修 implementer × backend / × frontend / × fullstack 期望（main-thread Claude）+ writer × frontend 期望
- `src/index.ts` — append SSoT exports（Layer / Model / Role / RoutingPluginAvailability / ALL_LAYERS / isLayer / ROUTING_SCHEMA_VERSION）

---

## Acceptance verification matrix

| 子条目 | 状态 | 证据 |
|------|------|------|
| (a) 新建 `multi-model-routing.ts` SSoT | PASS | 文件存在，5 union types 全统一 export，4 router 文件 import 此处 |
| (b) 4 文件 import 单源 | PASS | `pnpm typecheck` 通过，`PluginAvailability` 三处 import 同一类型 identity（`multiModelRouting.test.ts` 编译期断言）|
| (c) parseFindings 鲁棒化 | PASS | 16 个新单测 + balanced tokenizer + JSON fence strip + 单引号 normalize 全 PASS |
| (d) plugin 摘要实测调研文档 | PASS | `phase-21-plugin-summary-formats.md` 5 模块审计 + 置信级别 + P22/P23 实测协议 |
| (e) specialist-router 假设审计 | PASS | implementer/writer×frontend 改 `null` 路由；3 个原测试改写期望 |
| (f) 单测 ≥ 775 + 新增 | PASS | 总数 775 → 804（+29，含 1 个 specialistMatrix 新增 case） |

---

## Critical issues
（无）

## Major issues
（无）

## Pending handoff
（已在 Phase Runner 沙箱外完成）：
- `git_commit` — 待执行
- `test_run` — 完成（804/804 passed, +29 from baseline 775）
- `typecheck` — 完成（pass）
- `build` — 完成（pass，dist/cli.mjs 239KB / dist/index.mjs 258KB）

## Notes

接口债清理彻底（3 项 → 0），路由假设全部明示（v4.2 P22 已 unblocked）；新增 SSoT 模块为 v4.2 P22 三段式编排提供干净的类型基底。`parseFindings` 字符级 balanced tokenizer 修复 `{[^}]*}` 正则在嵌套 message 的边界 bug，覆盖 5 类输入格式。plugin 摘要实测留待 P22/P23（引擎限制 phase-runner 内不能 spawn plugin，必须主线常规命令路径走）。
