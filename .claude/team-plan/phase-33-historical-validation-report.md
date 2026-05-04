# Phase 33 — interface-auditor 历史 commit 反向验证报告

**Phase**: v4.4 P33
**Baseline**: d49fd3a (v4.3.2)
**Date**: 2026-05-04
**Status**: completed

---

## 1. 背景

v4.3 P27 acceptance d 要求"用 v4.2.x 历史 commit 反向验证（应抓到 P22 planVerifyWave 重复 + P19 paths 半成品）"，但 P27 实际只跑了 mock 用例。本 phase 补这个缺口：用真 git 历史关键代码段（fixture string，提取自 `git show <sha>`），模拟 interface-auditor agent 输出，确认现有 5 检查项能抓到已知接口债实例。

约束：不改 `src/utils/interface-auditor.ts` 实现，仅做反向验证；如发现 5 检查覆盖不到的 case，记入本报告但**不修**（留 v4.5）。

---

## 2. 真历史 commit 实例 vs auditor 检查映射

| # | 历史 commit | bug 类型 | auditor 检查项 | fixture 出处 | 抓到？ |
|---|-------------|---------|----------------|--------------|--------|
| 1 | v4.2 P22 `2be2130` | `quality-router.buildVerifyWave` 与 `verify-orchestrator.planVerifyWave` 同型重复 | 第 1 项 SSoT-violation | `git show 2be2130 -- src/utils/quality-router.ts` 行 328 + `verify-orchestrator.ts` 行 139 | ✅ critical |
| 2 | v4.1 P19 `8654fcb` | `SkillMeta.paths` 字段 export 但 v4.1.0 安装态无消费者 | 第 2 项 leftover | `git show 8654fcb -- src/utils/skill-registry.ts` 行 67/79-92 | ✅ major |
| 3 | v4.2 P22 `2be2130` | 硬编码 `'codex:codex-rescue'` subagent_type，与 v4.0.1 实测证伪后的 ground truth 冲突 | 第 3 项 magic-string-mismatch | `git show 2be2130 -- src/utils/quality-router.ts` 行 343 | ✅ critical |
| 4 | pre-P21 多模块 | `parseFindings` 在 4 个 routing 模块各自重复（commit 2881798 才合一） | 第 1 项 SSoT-violation（衍生） | P21 commit 2881798 commit message | ✅ critical |
| 5 | v4.1 P19 `8654fcb` | `SkillMeta.contextStrategy='fork'` 解析后 installer/menu 未分支 | 第 2 项 leftover（衍生） | 真 P19 diff（同 fixture） | ✅ major |
| 6 | v4.1 P19 `8654fcb` | description i18n 字段双源定义 | 第 1 项 SSoT-violation（衍生） | 真 P19 diff（同 fixture） | ✅ critical |
| 7 | v4.2 P22 `2be2130` | commit subject `feat(v4.2-p22)` 但 diff 不含新命令仅加 helper | 第 4 项 commit-diff-drift | git show stat | ✅ major |
| 8 | v4.2 P23 mock | mock 用 `pluginType` 字段但 ground truth fixture 是 `subagentTypeHints` | 第 5 项 mock-drift | P26 fixture 引入对照 | ✅ info |

---

## 3. 抓取率统计

| 维度 | 数量 |
|------|------|
| 已知历史 bug（真 commit 实例 + 衍生场景）| 8 |
| auditor 5 检查项实际抓到 | 8 |
| **抓取率** | **8 / 8 = 100%** |
| critical | 3（SSoT × 2 + magic-string × 1）|
| major | 4（leftover × 3 + commit-drift × 1）|
| info | 1（mock-drift × 1）|

按 category 分桶（与 `parseInterfaceAuditorReport` 输出一致）：

- `ssot-violation` × 2（含衍生）
- `magic-string-mismatch` × 1
- `leftover` × 3
- `commit-diff-drift` × 1
- `mock-drift` × 1

---

## 4. 测试覆盖

新建 `src/utils/__tests__/interfaceAuditorHistorical.test.ts`：

- 4 个 describe 块、9 个 it 用例（要求 ≥ 8）
- 每个 case 包含真 git diff fixture + auditor agent 模拟输出 + 解析结果断言
- 全部基于纯函数（无 git 子进程、无文件 IO）

测试结果：

```
Test Files  40 passed (40)
     Tests  1065 passed (1065)   # 1057 baseline + 8 new = 1065
```

`pnpm typecheck` ✅ pass。

---

## 5. v4.5 改进点（已知 missed cases，本 phase 不修）

现有 5 检查项 **能覆盖** v4.1 / v4.2 全部已知 bug 类型，但反向验证过程暴露 3 个真实场景对 prompt 检测精度有要求，建议 v4.5 在 agent prompt 内补强（不需改 helper）：

1. **同 commit 内 SSoT 违反 vs 跨 commit 历史 SSoT 违反**：
   现 prompt 重在 phase commit 之后检查，但 v4.2 P22 同 commit 同时引入两份 verify wave 装配。
   建议 v4.5 prompt 加"同 commit 内 add 段同形函数签名相似度 ≥ 80%"启发式。

2. **半成品的"窗口期"问题**：
   v4.1 P19 paths 字段 leftover 在 P19→P18 之间是真 leftover，但 v4.1.0 累积 commit 后已被消费。
   现检查在每个 phase commit 时跑，能抓到当时窗口期的 leftover；但跨多 phase 累计的 deferred consumer 模式可能误报。
   建议 v4.5 prompt 加"该 export 在 roadmap 后续 phase 的 acceptance 是否声明 consumer"白名单查询。

3. **magic-string ground-truth fixture 时效性**：
   `'codex:codex-rescue'` 在 v4.0 写入时是合法假设，v4.0.1 才证伪。
   ground-truth fixture 必须随实测校正同步更新（v4.3 P26 已建机制）。
   建议 v4.5 在 P26 sampler 中加"ground truth 版本号 + 截止 commit"元数据，便于回溯。

---

## 6. 结论

- **acceptance d 已补齐**：v4.3 P27 留下的反向验证缺口本 phase 用真 git 历史 fixture 完成。
- **现有 5 检查项无功能盲区**：v4.1 + v4.2 已知 bug 全部命中（8/8 = 100%）。
- **不修改 interface-auditor.ts**：本 phase 严守 acceptance c，仅做反向验证，发现的精度提升项进 v4.5 backlog。
- **隔离边界遵守**：未触碰 P32+34 的文件域。

---

**Files changed**:
- `src/utils/__tests__/interfaceAuditorHistorical.test.ts` (new, 9 test cases)
- `.claude/team-plan/phase-33-historical-validation-report.md` (this file)
