---
phase: debate-broker-detection-fix
plan: .claude/plan/debate-broker-detection-fix.md
goal: 修复 /ccg:debate 因 broker 运行态误判导致的提前降级 + 对齐 v1.7.87 标准重试规则
decisions:
  - 仅改 templates/commands/debate.md 三处文本
  - Step 0.3 改纯目录+marker 探测，禁止运行时探活
  - Step 1 加 2 retries / 5s / 3 attempts 规则
  - 降级表触发条件 = detectPlugin returns false OR 同模型 3 次 spawn 失败
  - 不改 plugin-detection.ts / debate-orchestrator.ts / 单测
  - Phase 2.1-2.3 双模型并行被故意跳过：30 行补丁 KISS + 用户刚报 gemini broker
constraints:
  - 不破坏 v4.0+ plugin spawn 协议
  - 不破坏 BC：真没装 plugin 仍能 general-purpose 降级
  - 文本措辞与 14 sibling 模板一致（plan.md:139 / review.md:114 等）
files:
  - templates/commands/debate.md
created_at: 2026-05-04
---

# CONTEXT — debate-broker-detection-fix

## 关键事实

1. `src/utils/plugin-detection.ts:106-150` 已是纯目录+marker 探测（无 broker 查询），不需改
2. `src/utils/debate-orchestrator.ts:138-167` 仅消费 `options.pluginsAvailable`，不需改
3. `templates/commands/debate.md` `grep "重试\|retry"` 返回空（其他 14 sibling 模板命中）
4. 14 sibling 模板凭纯文本约束运行 1+ 月零事故 → 文本约束 sufficient

## 验证命令

```bash
# Step 1 验证
grep -c "detectPluginAvailability" templates/commands/debate.md   # ≥1
# Step 2 验证
grep -c "重试 2 次" templates/commands/debate.md                 # ≥1
# Step 3 验证
grep -c "连续 3 次 spawn 失败" templates/commands/debate.md       # ≥1
# 回归
pnpm typecheck && pnpm test
```
