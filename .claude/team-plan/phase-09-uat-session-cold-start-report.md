# Phase 9 Offload Report — 会话式 UAT + cold-start smoke + 自动收敛

**Status**: completed (degraded mode — fallback, no nested spawn)
**Phase ID**: phase-09-uat-session-cold-start
**Phase Type**: backend
**Baseline commit**: 256beb3
**Mode**: phase-runner fallback (Edit/Write/Bash done in main thread)

## Files modified / created

| 文件 | 操作 | 行数 | 用途 |
|------|------|------|------|
| `src/utils/uat-session.ts` | created | ~430 | UAT session helper：cold-start 注入判定 / UAT.md schema / 严重度推断 / max-3-loop |
| `src/utils/__tests__/uatSession.test.ts` | created | ~280 | 31 个单测，覆盖 5 类场景（cold-start / frontmatter / severity / convergence / template integration）|
| `templates/commands/verify-work.md` | rewritten | +279/-95 | 从纯编排器改造为会话式 UAT 工作流，6 步 lifecycle |

## Acceptance verification matrix

| Acceptance 子项 | 状态 |
|----------------|------|
| verify-work.md 重写为有状态会话工作流（启动时 Read UAT.md 恢复，否则新建带 frontmatter）| ✅ PASS |
| Cold-start smoke 注入逻辑：扫 git diff 命中 server\|app\|database\|migrations\|startup\|docker-compose 即注入 | ✅ PASS |
| 测试模板：杀进程 → 清临时态 → 冷启动 → 主查询返回数据 | ✅ PASS（`buildColdStartSmokeTemplate`）|
| issue → diagnose → planner gaps → plan-checker → max-3-loop（复用 Phase 6 plan-checker.ts）| ✅ PASS（Step 5a-5e + `decideConvergence`）|
| UAT.md schema：`gaps: [{symptom, severity, status: open\|fixed\|deferred}]` | ✅ PASS |
| 单测 ≥ 10 用例覆盖：含 server.ts diff / 干净 diff / UAT.md resume / issue diagnose / max-3-loop | ✅ PASS（31 用例）|
| 可选 helper 抽算法 | ✅ PASS（`src/utils/uat-session.ts`）|

## Build & test gate

| Gate | Result |
|------|--------|
| `pnpm typecheck` | ✅ pass |
| `pnpm test` | ✅ 420 passed (389 baseline + 31 new) |

## 关键设计决策

1. **Helper 路线**：把 cold-start 判定 / frontmatter IO / 严重度推断 / convergence 判定抽到 `uat-session.ts` 纯函数。原因：与 Phase 4/6/8 helper 一致，LLM 在会话中按 schema 手写也能跑，不强依赖 Node import。
2. **Cold-start 触发集**：`server.ts | app.ts | main.* | bootstrap.* | startup* | database/ | db/ | migrations/ | seeds/ | docker-compose*.yml | Dockerfile | .env* | k8s/ | kubernetes/` —— 覆盖 Node/Go/Rust/Py 多语言入口 + 容器编排 + 环境变量。
3. **严重度关键词中英双语**：critical/high/medium/low 各列 8-12 个关键词，最严格优先匹配，不命中默认 medium（保守，避免低估）。
4. **3 轮上限是硬规约**：与 GSD plan-review-convergence / code-review-fix 一致；`decideConvergence` 在第 3 轮强制 `escalate`，不接受软化。
5. **v3.0 多门保留为 Step 2a**：verify-{module,security,quality,change} 不删，作为静态门嵌入会话工作流；v4.0 新增的 cold-start + UAT 循环裹在外层。

## Pending handoff

无沙箱限制残留——本 phase 在主线 fallback 模式下直接 Edit/Write/Bash 完成，无嵌套 spawn 需要等待。

## Notes

- Helper 设计与 Phase 4/6/8 保持一致风格（纯函数 / 中英双语 / 结构化输出）
- `uatSession.test.ts` 中加了 5 个 template integration 用例确保 verify-work.md 正文不会被未来 commit 删掉关键 schema 描述
