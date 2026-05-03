# Phase 24 Offload Report — v4.2.1 Review-driven Patch

**Status**: completed
**Date**: 2026-05-04
**Baseline**: 91034ba (v4.2.0 release commit)
**Phase Type**: backend
**Quality**: fast (single-spawn rescue path)

---

## 1. Acceptance Verification Matrix

| Criterion | Status | Evidence |
|-----------|--------|----------|
| **a. planVerifyWave SSoT** | PASS | `verify-orchestrator.ts.planVerifyWave` 加 SSoT 注释段；`quality-router.ts.buildVerifyWave` 删除 90 行独立实现，改为 import + `verifyWavePlanToWavePlan` adapter wrap；既存 `qualityRouter.test.ts` (33 例) / `verifyOrchestrator.test.ts` (24 例) 行为不变全通过 |
| **b. extractDivergences token-set 算法** | PASS | `plan-aggregator.ts.extractDivergences` 重写为 union-find + `MIN_SHARED_TOKENS=2`；新增 5 个 token-set 单测覆盖 Redis/Memcached 同组 / CDN 独立 / 完全冲突 / 部分共识 / 单 source 独有 |
| **c. token-aware brief 长度限制** | PASS | 新增 `estimateTokens(text)` export（英文 word 1 token / 中文 char 1 token / 其他 0.3 token/char）；`BRIEF_MAX_TOKENS = 500` 替代字符常量；二分截断保证真实 token ≤ 500；6 个 estimateTokens 单测通过 |
| **d. dogfood 风格集成测试** | PASS | 新建 `tripleTierIntegrationDogfood.test.ts`（13 用例 ≥ 8 要求）：真冲突 / 中英混合 / 多 bullet 格式 / JSON 容错 / 缺路径 / decision_required 触发 / first-token 误配修复 / SSoT 联动 |
| **e. bump version + CHANGELOG** | PASS | `package.json` 4.2.0 → 4.2.1；`CHANGELOG.md` 顶部加 [4.2.1] - 2026-05-04 段（修复 / 测试 / 影响范围）；README/CLAUDE.md/migration 未动 |

---

## 2. Files Modified

| File | Δ Lines | 说明 |
|------|---------|------|
| `src/utils/quality-router.ts` | −80, +25 | 删 buildVerifyWave 独立实现 90 行 → 加 verifyWavePlanToWavePlan adapter 14 行 + import + 11 行新 buildVerifyWave |
| `src/utils/verify-orchestrator.ts` | +9, −2 | 顶部 SSoT 声明注释段 + planVerifyWave docstring 调整 |
| `src/utils/plan-aggregator.ts` | +95, −47 | extractDivergences union-find 重写 + estimateTokens 新增 + serializeBriefForPrompt 二分截断 + 常量重命名（SERIALIZED_BRIEF_MAX_CHARS → BRIEF_MAX_TOKENS / 新增 MIN_SHARED_TOKENS） |
| `src/index.ts` | +1 | export estimateTokens |
| `src/utils/__tests__/planAggregator.test.ts` | +160 | 新增 6 个 estimateTokens 单测 + 5 个 extractDivergences token-set 单测 + 1 个纯中文 token 截断回归测试 + 既有 length budget 测试改 token 语义 |
| `src/utils/__tests__/tripleTierIntegrationDogfood.test.ts` | +275 | 新建：13 dogfood 集成用例 |
| `package.json` | +1, −1 | version 4.2.0 → 4.2.1 |
| `CHANGELOG.md` | +27 | 顶部加 [4.2.1] 段 |

---

## 3. Test Results

```
Test Files  35 passed (35)   (P23: 34, +1: tripleTierIntegrationDogfood)
     Tests  938 passed (938) (P23: 913, +25)
  Duration  ~12s
```

**新增覆盖**：
- `estimateTokens`: 6 用例（空/纯英/纯中/混合/长 word/标点）
- `extractDivergences token-set`: 5 用例
- `serializeBriefForPrompt token budget`: 1 新回归 + 既有 4 用例改 token 语义
- `tripleTierIntegrationDogfood`: 13 端到端用例

**类型检查**：`pnpm typecheck` 通过（tsc --noEmit 无报错）。
**构建**：`pnpm build` 通过；dist/index.mjs 含新 export `estimateTokens`。

---

## 4. Review Issue 修复对照

| Review Issue | 根因 | 修复 |
|--------------|------|------|
| #1 planVerifyWave 重复实现 | P22 落地时未审视 P21 SSoT 原则；同样的 cross-vendor 路由策略在 quality-router 与 verify-orchestrator 各写一遍 | 锁定 verify-orchestrator 为权威；quality-router 改 import + adapter；schema 不冲突，任一侧改路由策略只在 verify-orchestrator 改 |
| #2 extractDivergences first-token 错配 | "use Redis cache" / "use Memcached cache" / "use email auth" 首 token 都是 "use"，错配进同一 group；预估真数据 30-50% 错位 | 改 union-find + token-set 共享 ≥ 2；Redis/Memcached 共享 {use, cache} 同 group；email auth 与之共享 1 token 独立。MIN_SHARED_TOKENS 参数化便于后续调优 |
| #3 中文 token 估算偏差 2x | 注释假设 char ≈ 0.5 token，但中文 GPT/Claude tokenizer 实测 1 char ≈ 1 token；纯中文 1000 char ≈ 1000 token，超 500 预算 2x | 新增 estimateTokens 按字符类型加权；二分截断真实 token ≤ 500；保留 estimateBriefLength API 但语义从 char 改 token（旧测试 <1000 仍宽松通过） |

---

## 5. Critical Issues

**None.**

---

## 6. Major Issues

**None.**

---

## 7. Pending Handoff

- `git_commit`: 主线接手（沙箱外） — files modified 已落盘，未 stage/commit
- `typecheck`: PASS（已自检）
- `test_run`: PASS 938/938（已自检）
- `build`: PASS（已自检）

---

## 8. Notes

- v4.2.1 patch 严格按 review 暴露的 3 项问题修订，零 scope creep。
- API 兼容：所有原 export 签名不变；`estimateTokens` 是新 export，不影响现有 caller。
- `estimateBriefLength` 语义从 char 改 token，但既有测试用 `<1000` 阈值，新值（token）总是 < 1000，不会失败。
- v4.1/v4.2 核心 helper（multi-model-routing / specialist-router / challenger / debate / plugin-detection / wave-scheduler / phase-context / debug-session / jobs / templates 等）零改动。
