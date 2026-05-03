# Phase 27 Interface-Auditor Report

**Status**: completed
**Baseline**: fbf7c3c (P26 ground-truth-sampler)
**Commit**: pending (handoff to phase-runner sandbox-outer)

## Files modified / created

### New files
- `templates/commands/agents/interface-auditor.md` — agent prompt (5 项检查 + ≤200 token 摘要协议)
- `src/utils/interface-auditor.ts` — types + parser helper（复用 challenger-orchestrator parseFindings 鲁棒化）
- `src/utils/__tests__/interfaceAuditor.test.ts` — 18 用例覆盖 5 类 finding + lenient parser + severity helpers + error paths
- `.claude/team-plan/phase-27-interface-auditor-report.md` — 本报告

### Modified files
- `src/utils/quality-router.ts` buildVerifyWave — triple/debate verify wave 追加 `interface-auditor` spawn (fast 不加)
- `src/utils/__tests__/qualityRouter.test.ts` — 4 新断言：
  - triple verify 3 spawn (`codex:rescue` + `gemini:rescue` + `interface-auditor`)
  - triple plugin-degraded 仍含 interface-auditor
  - debate 最末 verify wave 含 interface-auditor
  - fast verify NOT 含 interface-auditor
- `src/utils/__tests__/tripleTierIntegrationDogfood.test.ts` — verify wave 期望从 2 → 3 spawn
- `src/utils/__tests__/qualityTierE2E.test.ts` — 3 spawn budget 测试更新（triple 8→9 / debate fullstack 14→15 / debate backend 11→12）
- `templates/commands/autonomous.md` — Step 4.4 verify wave 伪码注释加 interface-auditor 第三路 spawn 说明
- `src/index.ts` — append P27 export 段（parseInterfaceAuditorReport / 3 helper / 3 type）

### 严格未触动（P28/P29 边界）
- `src/utils/verify-orchestrator.ts`（P24 SSoT 实现稳定）
- `src/utils/__tests__/verifyOrchestrator.test.ts`
- `src/utils/__tests__/challengerOrchestrator.test.ts`
- `src/utils/__tests__/debateOrchestrator.test.ts`
- `src/utils/__tests__/pluginDetection.test.ts`
- `tests/fixtures/`
- `src/utils/installer-hooks.ts`、`templates/hooks/`
- 根 CLAUDE.md / CHANGELOG.md / package.json / .ccg-migration/

## Acceptance verification matrix

| Acceptance | Result | Evidence |
|-----------|--------|---------|
| a. 新建 interface-auditor.md agent | PASS | `templates/commands/agents/interface-auditor.md` 含 subagent name/description/5 检查清单/200 token 输出协议 |
| a.1 SSoT violation 检查（grep `interface\|type` 重复 export） | PASS | agent prompt §1 SSoT violation 段 + 测试 `parses single critical SSoT-violation finding` |
| a.2 半成品检查（grep export 无 consumer） | PASS | agent prompt §2 leftover 段 + 测试 `parses single major leftover finding` |
| a.3 magic string vs ground truth | PASS | agent prompt §3 magic-string-mismatch 段（含 ground truth latest.json 对照流程）+ 测试 `parses critical magic-string-mismatch finding (v4.2.0 codex:codex-rescue 同型)` |
| a.4 commit message vs diff 一致性 | PASS | agent prompt §4 commit-diff-drift 段 + 测试 `parses commit-diff-drift major finding` |
| a.5 mock 真实性检查 | PASS | agent prompt §5 mock-drift 段 + 测试 `parses mock-drift info finding` |
| a 输出协议 ≤200 token markdown | PASS | agent prompt §Step 4 严格三段 STATUS/FINDINGS/NOTES |
| b. autonomous.md Step 4.4 verify wave 集成 | PASS | autonomous.md 伪码注释 case 'verify' 含 interface-auditor 第三路 + synthesizeVerifyResults 综合说明 |
| c. quality-router.ts buildVerifyWave triple/debate 加 interface-auditor | PASS | quality-router.ts:308 if (tier === 'triple' \|\| tier === 'debate') 追加 interface-auditor spawn；fast 不加 |
| d. interfaceAuditor.test.ts ≥12 用例 | PASS | **18 用例**：6 happy paths（5 类 finding + clean）+ 5 lenient/multi-finding + 4 error paths + 4 severity helpers |
| d.1 mock SSoT violation → critical finding | PASS | test `parses single critical SSoT-violation finding` |
| d.2 mock 半成品 → major finding | PASS | test `parses single major leftover finding` |
| d.3 mock magic string mismatch → critical | PASS | test `parses critical magic-string-mismatch finding` |
| d.4 mock 全部正常 → 0 finding | PASS | test `parses clean phase (0 findings)` |
| e. quality-router 单测 triple verify wave 含 interface-auditor | PASS | qualityRouter.test.ts:145 `verify wave: dual cross-vendor (codex + gemini) + interface-auditor (P27)` 长度 3 + 顺序断言 |

## Pending handoff (sandbox-outer)

- [ ] `git add` 范围限定（见上 Files modified 列表）
- [ ] `git commit -m "feat(v4.3-p27): interface-auditor specialist (SSoT violation + leftover detection + magic-string vs ground-truth)"`
- [ ] 已自检：`pnpm typecheck` ✅ pass / `pnpm test --run` ✅ 1029 pass / `pnpm build` ✅ ok

## Critical issues
None.

## Major issues
None.

## Notes

- 测试增量：986 baseline → 1029 pass（+43；其中 18 来自新 interfaceAuditor.test.ts，6 来自 qualityRouter.test.ts，其余增量来自既有 dogfood 测试期望调整）
- 设计取舍：interface-auditor parser 复用 challenger-orchestrator.parseChallengerSummary 鲁棒化逻辑（单/双引号、json fence、嵌套 `{}` balanced tokenizer）—— 与 verify-orchestrator.parseVerifyReport 同手法，避免重复实现 SSoT 风险
- ground truth 缺失策略：sampler 没跑过时 agent 跳第 3 项检查 + 加 info 提醒，1/2/4/5 继续——避免 P26 输出缺失阻塞 P27 verify wave 推进
- 白名单：CCG 自家 17 个 agent（phase-runner / assumptions-analyzer / nyquist-auditor / interface-auditor 等）不在 ground truth subagentTypeHints 集合时不报 magic-string-mismatch（agent prompt §3 例外段明确）
- v4.2 P22 / v4.2.0 / v4.1 P19 三起真实事故均有对应 finding category + 测试覆盖（ssot-violation / magic-string-mismatch / leftover）
- P30 dogfood 验证可通过：写一段含 SSoT violation 的 mock phase commit → 跑 quality=triple → 验证主线 verify wave 综合给出 revise decision
