# 工作流指南

不同的活用不同的工作流。别纠结选哪个，看下面的决策树。

## 怎么选

```
拿到任务
  │
  ├─ 很简单，一句话说清？ ──→ /ccg:frontend 或 /ccg:backend
  │
  ├─ 想先看看计划？ ────────→ /ccg:plan → /ccg:execute
  │
  ├─ 不想让 AI 乱来？ ─────→ /ccg:spec-* 系列
  │
  ├─ 能拆成 3+ 个模块？ ───→ /ccg:team-* 系列
  │
  └─ 从头到尾全包？ ────────→ /ccg:workflow
```

## 规划 → 执行（最常用）

先让 Codex 和 Gemini 各出一份分析，Claude 综合成计划。你看完计划觉得没问题，再执行。

```bash
/ccg:plan 实现用户认证功能
# 计划保存在 .claude/plan/ 目录
# 打开看看，不满意可以直接改

# 两种执行方式，选一个：
/ccg:execute .claude/plan/user-auth.md   # Claude 亲自干，精细控制
/ccg:codex-exec .claude/plan/user-auth.md  # Codex 全干，Claude 只审核
```

**execute 和 codex-exec 怎么选？**

`execute` 适合复杂任务——Claude 处理每一步，能随时调整方向。但 token 消耗大。

`codex-exec` 适合目标明确的任务——Codex 一口气干完，Claude 最后审一遍。token 消耗小得多。

## OPSX 规范驱动（严格控制）

有些场景你不想让 AI 自由发挥。比如实现权限系统，你希望每个细节都有据可查。

OPSX 的思路是：**先把需求变成约束条件，再把约束变成零决策计划。执行阶段不需要做任何判断——所有判断在规划阶段就做完了。**

```bash
/ccg:spec-init
/ccg:spec-research 实现 RBAC 权限系统
# 这步会输出一堆约束条件，比如：
# - 必须支持角色继承
# - 权限检查延迟 < 5ms
# - 必须有审计日志

/ccg:spec-plan
# 约束 → 零决策计划
# 每一步该改哪个文件、改什么内容、怎么验证，都写清楚了

/ccg:spec-impl
# 按计划一步步执行，不需要再做决策

/ccg:spec-review
# 双模型独立审查，这个随时都能用
```

每阶段之间可以 `/clear` 释放上下文——状态存在 `openspec/` 目录里，不怕丢。

## Agent Teams 并行（多模块同时开工）

任务能拆成几个不相干的模块？比如"订单 CRUD + 支付对接 + 邮件通知"——三个模块互不依赖，让三个 Builder 同时写。

```bash
/ccg:team-research 实现订单系统
# 产出约束集 + 成功判据
# /clear

/ccg:team-plan order-system
# 拆分为互不干扰的子任务，每个 Builder 只改自己的文件
# /clear

/ccg:team-exec
# 多个 Builder 并行写代码
# /clear

/ccg:team-review
# Codex 审一遍 + Gemini 审一遍，Critical 必须修
```

**跟普通工作流比有什么区别？**

普通工作流是连续对话，上下文一直累积。Team 系列每步 `/clear`，通过文件传递状态。好处是上下文不会爆，坏处是没法随时插嘴改方向。

适合的场景：任务可以拆成 3 个以上独立模块，模块之间没有强依赖。

## 完整工作流（全自动）

`/ccg:workflow` 自动跑完 6 个阶段：研究→构思→计划→执行→优化→评审。

```bash
/ccg:workflow 实现完整的用户认证，注册、登录、JWT
```

适合不想操心中间过程的场景。但对于大任务，建议还是用 `plan + execute` 分步走，中间自己看一眼计划。
