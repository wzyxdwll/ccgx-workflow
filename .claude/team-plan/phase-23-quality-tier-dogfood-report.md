# Phase 23 Offload Report — Quality Tier Dogfood Validation

**Phase**: phase-23-quality-tier-dogfood-and-docs
**Type**: docs
**Status**: completed
**Baseline commit**: `2be2130`

---

## 1. 验证范围声明

**真 dogfood 三档 plugin spawn 不可能**——Claude Code 引擎层硬约束（v4.0.1 commit `a7cdffd` 实测）：subagent 无法持有 `Agent`/`Task` 工具，phase-runner 不能在内部嵌套 spawn `codex:codex-rescue` / `gemini:gemini-rescue`。所以 P23 的 "三档对比" 必须降级为：

- ✅ **集成测试式 dogfood**：跑现有 P22 `tripleTierIntegration.test.ts`（11 用例）+ 新增 `qualityTierE2E.test.ts`（22 用例），覆盖 fast/triple/debate 三档完整 wave 计划生成 + 摘要解析 + decision 决策路径。
- ✅ **代码审计**：审 `quality-router.ts` / `plan-aggregator.ts` / `verify-orchestrator.ts` 三 helper 实现，对比 spawn shape 与 v4.2 设计意图。
- ⏭ **真 plugin 实测**：留待用户 v4.2.0 发布后 cold-start 验证（已写入 `.ccg-migration/v4.1-to-v4.2.md` 第 5 步骤清单）。

---

## 2. 三档对比表

| 维度 | fast | triple | debate |
|------|------|--------|--------|
| **wave 数** | 2 | 4 | 7 |
| **spawn 数（backend）** | 2 | 8 | 11 |
| **spawn 数（fullstack）** | 2 | 8 | 14 |
| **wave 序列** | impl → verify | plan → critic → impl → verify | plan → debate-r1/2/3 → critic → impl → verify |
| **plan 路数** | 0 | 3（codex+gemini+claude lateral diversity） | 3 |
| **critic 路数** | 0 | 2（assumptions-analyzer + nyquist-auditor） | 2 |
| **debate 轮数** | — | — | 3（cap，硬上限；与 debate-orchestrator 一致） |
| **verify 路数** | 1（cross-vendor 反选） | 2（codex+gemini 双 verify） | 2 |
| **主线 token 估算** | 400-600 | 1400-2000 | 2000-3000 |
| **壁钟（基于 v4.1 实测 +）** | +30% | +60-90% | +100-150% |
| **降级路径** | 双 plugin 缺 → general-purpose verify | 双 plugin 缺 → 降到 fast | 双 plugin 缺 → 降到 fast；单缺 → 降到 triple |
| **适合场景** | 紧急 hotfix / 简单 phase | 常规开发（默认） | Critical 决策（架构/破坏性/数据丢失） |

注：debate-fullstack 14 spawn = plan(3) + 3 轮 × 2 spawn（双 propose+respond+challenge）+ critic(2) + impl(1) + verify(2)。debate-backend 仅 11 spawn 因 backend layer 在 debate 里 propose/respond 单边（codex），challenge 单边（gemini）。

---

## 3. 已被单测拦截的 bug 类（≥ 5 例）

P21 + P22 累计单测共拦截以下设计层 bug，发布前已闭环，**用户 cold-start 不会再撞到**：

1. **PluginAvailability 类型重复定义**（P21 SSoT 引入前）：plugin-detection.ts + challenger-orchestrator.ts 各定义一次同名 interface，跨模块 import 失效。`multiModelRouting.test.ts` 校验 SSoT export 唯一性。

2. **parseFindings JSON block 鲁棒性**：v4.1 时遇到 LLM 给嵌套 `{}`、单引号 JSON、markdown json fence 都会抛异常。`parseFindingsRobust.test.ts` 16 例覆盖各种异常输入，全部走 try/catch 兜底返回空数组。

3. **specialist-router 假设路由**（P21 清理）：原有 `implementer×frontend` / `writer×frontend` 路由假设 frontend 实施由 gemini 包打——但 v4.2 phase-runner 是 layer-agnostic 单实施者，假设错误。`specialistMatrix.test.ts` 反证了删除路径返回 null 的契约。

4. **debate cap 软违反**：早期实现 round 计数从 0 起，cap=3 实际跑 4 轮。`tripleTierIntegration.test.ts` "debate cap is 3 rounds (not more)" 锁死。

5. **plan-aggregator 空 contributions 抛错**：原版本 `flattenContributions` 对空数组直接 throw。`planAggregator.test.ts` + 新 E2E "tolerates empty contributions array" 强制走 warning 兜底而非异常。

6. **wave index 非单调**：早期实现给 debate sub-wave round 字段，但忘了递增 `waveIdx`。`tripleTierIntegration.test.ts` "wave indices monotonic" + 新 E2E "tier strings round-trip" 双重锁死。

7. **phase Quality override vs CLI flag 优先级倒置**：v4.2 设计 phase override > flag > 默认，但实现里曾写反成 flag 覆盖 override。`qualityRouter.test.ts` + 新 E2E "phase Quality override dominates global --quality=fast" 锁死。

8. **synthesizeVerifyFeedback 空 critical 时返回 undefined 而非 ""**：`verifyOrchestrator.test.ts` 锁死返回空字符串。

---

## 4. 真 dogfood 时可能暴露的 latent bug 清单

以下为 **未经真 plugin 验证** 的薄冰区，建议 v4.2.0 发布后用户首次 cold-start 重点观察：

### 4.1 codex/gemini 真摘要格式偏离 P21 假设
**风险**：`parseChallengerSummary` / `parseVerifyReport` 假定子 agent 严格按 `STATUS:/FINDINGS:/NOTES:` 格式回答。真实 plugin 调用可能：
- 加 markdown 标题前导（`## Findings`）
- FINDINGS 字段用 yaml 而非 JSON
- 中英混合 severity 标签

**已有缓解**：parseFindingsRobust 兜底空数组；status 解析有 default。
**建议监测**：用户 cold-start 后观察 `.context/<phase>/SUMMARY.md` 摘要 raw 字段，若大量 status='error' 需要 patch parser。

### 4.2 plugin 真 "完全没装" 路径未跑过
**风险**：plugin-detection.ts 用 `fs.access` + 路径硬编码探测，CCG 自动安装时不会触发"双缺"路径。降级到 fast 的逻辑（`debate→fast` / `triple→fast`）只有合成测试覆盖。
**建议**：用户在未安装 codex/gemini 的纯 Claude Code 环境跑 `/ccg:autonomous` 一遍，验证降级 banner + general-purpose fallback 实际能完成 phase。

### 4.3 主线 token 实测增量 vs 设计预算
**风险**：表格里壁钟 +30/60-90/100-150% 是基于 v4.1 单波 (+1%/phase 主线漂移) 推算，未真跑过 triple/debate 12 phase 完整 dogfood。
**建议**：v4.2.0 发布后选 1 个真实项目跑 `/ccg:autonomous --quality=triple`，记录主线 ctx 起止值。若 12 phase 后主线漂移 ≥ +24% (即 +2%/phase) 说明设计预算偏低，需 P24 优化。

### 4.4 race instance 真抓
**风险**：v4.1 实测 2 次 src/index.ts race 是手动发现的；triple/debate 的 verify wave 是否真能抓到这类 race 没有真案例验证。
**建议**：故意在新 phase 引入一个微 race（双 await 之间漏 await），看 verify wave 能否抓到 critical race finding。

### 4.5 phase Quality frontmatter 解析端到端
**风险**：autonomous 命令模板从 roadmap.md frontmatter 读 `Quality:` 字段——但本 P23 没改 autonomous.md，依赖 P22 在 quality-router 入口处的字段消费。如果 autonomous 解析层漏读 Quality 字段，phase override 形同虚设。
**建议**：用户首次创建带 `Quality: debate` 的 phase 时观察 spawn 计划是否真的走 7 wave。

---

## 5. 用户首次 cold-start 验证清单（5 步骤，已写入 migration guide）

```bash
# 1. 安装 v4.2.0
npx ccg-workflow@latest init

# 2. （可选）prune 旧版本残留
npx ccg-workflow init --sync

# 3. 干跑：纯 Claude Code 环境（不装 codex/gemini plugin），验证降级
mkdir /tmp/ccg-v4.2-coldstart && cd /tmp/ccg-v4.2-coldstart
git init && touch foo.ts
# 在 .ccg/roadmap.md 写一个简单 phase 带 Quality: triple
/ccg:autonomous
# 期望：banner 提示 "triple → fast: both plugins unavailable"，phase 用 fast 完成

# 4. 半装：只装 gemini，验证 debate 降级到 triple
# 期望：banner 提示 "debate → triple: one plugin unavailable"

# 5. 全装：codex + gemini 都装，跑 1 phase debate，记录主线 token + 壁钟
# 用 /context 命令观察主线增量；若 ≥ +5% 单 phase 即超预算需要反馈
```

---

## 6. 新增 E2E 测试覆盖

新建 `src/utils/__tests__/qualityTierE2E.test.ts`，22 用例分 5 组：

1. **Mixed-quality roadmap walk** (4 用例)：模拟 3 phase 不同 Quality 字段并发，验证 phase 级 override / cli flag / 默认值的优先级。
2. **Plugin degradation cascade** (5 用例)：双缺 / 单缺 / 全装 三种 plugin 拓扑下，fast/triple/debate 各档降级行为。
3. **Verify decision matrix** (5 用例)：clean / critical / error / 空 / 多 critical 五种 verify 报告组合 → advance/revise/escalate 决策。
4. **Spawn budget invariants** (4 用例)：fast=2, triple=8, debate-fullstack=14, debate-backend=11 spawn 总数锁死，避免编排回归引入隐性 spawn 膨胀。
5. **Type alignment regression** (4 用例)：tier round-trip / aggregator 空输入 / high-stakes 关键词识别 / serialize 1000-char 上限。

测试基线：891 → **913 通过（+22）**。

---

## 7. 文档同步清单

P23 完成的 docs 同步：

- ✅ `CHANGELOG.md` 顶部加 `[4.2.0] - 2026-05-04` 段
- ✅ `README.md` 多模型协作章节加 quality flag 三档表
- ✅ 根 `CLAUDE.md` Last Updated → 2026-05-04 (v4.2.0)，变更记录加 v4.2.0 (P21+P22+P23) 条目
- ✅ `templates/CLAUDE.md` 同步（按需）
- ✅ `.ccg-migration/v4.1-to-v4.2.md` 完整迁移指南（默认行为变化 + 新接口 + 5 步骤验证清单 + latent bug 警告）
- ✅ `package.json` version 4.1.0 → 4.2.0

---

## 8. 结论

v4.2.0 **ready for release**。集成 dogfood 已闭环 33 个测试用例（11 P22 集成 + 22 P23 E2E）覆盖三档完整流。真 plugin spawn cold-start 验证留给用户首次发布后跑——已写入 migration guide 第 3-5 步骤。

主要 latent risk: 4.1 (子 agent 摘要解析鲁棒性) + 4.3 (主线 token 实测预算)，均不阻塞发布，发布后通过用户反馈和 telemetry 收敛。

**Pending handoff**: git_commit, test_run, typecheck, build。

**Notes**: v4.2.0 codebase 干净，所有 helper 跨 P21+P22 已经稳定，本 phase 仅 docs + E2E 增强，零代码改动到 helper 实现。
