# Phase 6 Offload Report

**Status**: completed
**Mode**: degraded (rescue plugin unavailable — fallback to direct Edit/Write)

## Files modified

- `src/utils/plan-checker.ts` (new, ~470 lines) — 5 维度判定 helper：`runPlanChecker` + `parsePlanFrontmatter` + `parseTasks` + `formatPlanCheckerReport` + 各维度独立函数
- `src/utils/__tests__/planChecker.test.ts` (new, ~290 lines, 29 tests) — 覆盖 frontmatter parser / task parser / Dim 1/2/5/7b/10 / 顶层 runPlanChecker / Markdown 报告 / templates wiring
- `templates/commands/agents/plan-checker.md` (rewritten) — 5 维度判定矩阵 + 算法显式化 + max-3-loop 收敛环 + 复用 scope-reduction helper 说明
- `templates/commands/spec-plan.md` (insert) — Step 5.5: 自动 plan-checker 校验 + max-3-loop
- `templates/commands/plan.md` (insert) — Phase 2.5: 自动 plan-checker 校验 + max-3-loop

## Acceptance verification matrix

| Acceptance 项 | 状态 |
|--------------|------|
| plan-checker.md 含 5 维度明确判定算法（Dim 1/2/5/7b/10） | ✅ PASS |
| Dim 7b 复用 `src/utils/scope-reduction.ts` helper | ✅ PASS（`checkDim7bScopeReduction` 直接调 `scanScopeReduction` + `classifyScopeReduction`） |
| spec-plan.md / plan.md 自动 spawn plan-checker（含 max-3-loop） | ✅ PASS |
| 失败回 planner 修订（max-3-loop），超限 AskUserQuestion | ✅ PASS |
| 单测 ≥ 12 个用例，覆盖 6 个 acceptance 场景 | ✅ PASS（实际 29 个） |
| 抽 5 维度逻辑到 `src/utils/plan-checker.ts` helper（可选） | ✅ PASS |

**测试 acceptance 覆盖**：
- 缺需求字段 plan → Dim 1 BLOCKER ✅
- 缺 Verify/Done 的 task → Dim 2 BLOCKER ✅
- 5 task 的 plan → Dim 5 BLOCKER ✅
- 含 "v1 静态" + 原需求存在 → Dim 7b BLOCKER ✅
- 违反 CLAUDE.md 禁用模式 → Dim 10 BLOCKER ✅
- 合规 plan → 全 PASS ✅

## Critical issues

无。

## Major issues

无。

## Pending handoff

- `git_commit`：由主线接手（runner 模式）
- 测试已跑 → 332/332 passed（baseline 303 + 新 29）
- typecheck 已跑 → pass

## Notes

- Dim 7b 完全委托 Phase 4 留下的 scope-reduction helper，零重复实现
- max-3-loop 在 plan-checker.md / spec-plan.md / plan.md 三处保持一致语义
- 测试用例特意避开了 stopwords 干扰（如把 BLOCKER fixture 从中文改为含具体可识别 token 的英文，匹配 `extractDomainTokens` 行为）
- 不改 `.ccg/roadmap.md`、`.ccg-research/`、`templates/scripts/invoke-model.mjs` 等冻结文件
