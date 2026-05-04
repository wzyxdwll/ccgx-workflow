---
phase: debate-broker-detection-fix
plan: .claude/plan/debate-broker-detection-fix.md
goal: 修复 /ccg:debate 因 broker 运行态误判导致的提前降级，并对齐 v1.7.87 标准重试规则
decisions:
  - 仅改 templates/commands/debate.md 三处文本（不动 helper / 不动 orchestrator）
  - Step 0.3 收紧为目录+marker 探测，明文禁止查询 broker / runtime status
  - Step 1 加 plugin spawn 失败 2 retries / 5s / 3 attempts 规则（与 14 sibling 文本一致）
  - 降级表触发条件改为 detectPlugin returns false OR 同模型连续 3 次 spawn 失败
  - 跳过双模型并行分析（Phase 2.1-2.3）：(a) 用户刚报 gemini broker (b) 30 行级补丁 KISS (c) Bedrock truths 清晰
constraints:
  - 不改 src/utils/plugin-detection.ts（已正确）
  - 不改 src/utils/debate-orchestrator.ts（已正确）
  - 不破坏 v4.0+ plugin spawn 协议
  - 不破坏 BC：真没装 plugin 仍走 general-purpose 降级
files:
  - templates/commands/debate.md
created_at: 2026-05-04
---

# Plan: debate.md 误降级修复（broker 误判 + 缺失重试规则）

## 任务类型
- [x] 后端（→ 主线 Claude，模板补丁）
- [ ] 前端
- [ ] 全栈

## 问题陈述

`/ccg:debate` Step 0.3 的"plugin 可用性检测"被主线 LLM 错误展开为运行时探活（执行 `/gemini:status` 之类），拿到 `brokerRunning: false` **单次负信号**即降级为 `general-purpose`，让 Claude 自演 Gemini，违背 `debate.md:8` "避免单模型自我洗稿"设计意图。

且 debate.md 全文**不含** v1.7.87 (2026-03-19) 引入的标准重试规则（2 retries / 5s 间隔 / 3 次全败才降级），而 14 个 sibling 命令模板全部含此规则。

实测命中：用户在主线触发 debate 后看到 `Gemini broker 不可用（brokerRunning: false），触发降级。等 codex Round 1 propose 回来后用 general-purpose 替代 gemini 视角继续。`

## Bedrock Truths（first-principles 验证）

| # | 事实 | 证据 |
|---|------|------|
| 1 | `plugin-detection.ts` 已是纯目录+marker 探测 | `src/utils/plugin-detection.ts:106-150` `existsSync` + `statSync` + marker 文件检测，无 broker 引用 |
| 2 | `debate-orchestrator.ts` 接收 caller 输入无错 | `src/utils/debate-orchestrator.ts:138-167` 仅消费 `options.pluginsAvailable` |
| 3 | 缺陷 100% 在 debate.md 提示词文本 | `grep "重试\|retry" templates/commands/debate.md` 返回空；同 grep 在其他 14 模板命中 |
| 4 | 文本约束 sufficient 已被经验证实 | v1.7.87 14 sibling 凭模板文本运行 1+ 月零 broker 误降级事故 |

## 实施步骤

### Step 1：收紧 Step 0.3 plugin 探测条件

**文件**：`templates/commands/debate.md:50-53`

**现状**：
```
3. **检测 plugin 可用性**：
   - 看 `~/.claude/plugins/` 是否含 `codex-plugin` / `gemini-plugin`
   - 任一缺失 → 该模型走 general-purpose 降级路径
```

**改为**：
```
3. **检测 plugin 可用性（纯目录探测，禁止运行时探活）**：
   - 用 `Bash` 跑 `ls ~/.claude/plugins/ 2>/dev/null` 找 `codex@*` / `gemini@*` 前缀子目录
   - 子目录内须含 `SKILL.md` / `plugin.json` / `package.json` / `manifest.json` 任一 marker 文件 → 标 `installed: true`
   - ⛔ **严禁**调用 `/gemini:status` / `/codex:status` / 任何 broker / runtime / health 探活——broker 是**懒启动**的，启动后才有；当前 false 不代表 plugin 不可用
   - 等价 helper：`detectPluginAvailability()`（`src/utils/plugin-detection.ts:156`）
   - 任一 plugin 真未装 → 该模型走 general-purpose 降级路径
```

**预期产物**：debate.md 第 50-58 行 ~9 行
**验证**：
```bash
grep -c "broker\|runtime status\|/gemini:status\|/codex:status" templates/commands/debate.md
# 期望：0（除非在禁用规则块里出现，那也只该是负面禁令文本）
grep -c "detectPluginAvailability" templates/commands/debate.md
# 期望：1
```

### Step 2：Step 1 spawn 循环加重试规则

**文件**：`templates/commands/debate.md:64` 后插入

**插入内容**（参考 plan.md:139 / review.md:114 / spec-impl.md:109 措辞）：
```
4. ⛔ **plugin spawn 失败必须重试**：若 `Agent(subagent_type="codex:rescue")` 或 `Agent(subagent_type="gemini:rescue")` 调用失败（spawn 抛错 / 返回非结构化错误 / `parseRoundSummary` 返回 `parsed=false`），最多重试 **2 次**（间隔 **5 秒**）。仅当 **3 次全部失败**时才把该模型本轮替换为 general-purpose 降级路径，并在合成的 `RoundSummary.notes` 标 `plugin spawn failed after 3 attempts, degraded`。
```

**预期产物**：debate.md 第 64 行后追加 ~3 行
**验证**：
```bash
grep -c "重试 2 次\|3 次全部失败" templates/commands/debate.md
# 期望：≥1
```

### Step 3：降级路径表触发条件收紧

**文件**：`templates/commands/debate.md:113-118`

**现状**第 1 行：
```
| codex / gemini plugin 未安装 | `Agent(subagent_type="general-purpose", ...)` |
```

**改为**：
```
| `detectPlugin(name)` 返回 `{ installed: false }`（目录或 marker 缺失）**或** 同一模型连续 3 次 spawn 失败 | `Agent(subagent_type="general-purpose", prompt=<内嵌 ~/.claude/.ccg/prompts/<model>/<file>.md 全文> + Round prompt 模板)` |
```

**预期产物**：debate.md 第 116 行 ~1 行改写
**验证**：
```bash
grep -c "连续 3 次 spawn 失败\|installed: false" templates/commands/debate.md
# 期望：≥1
```

### Step 4：回归验证

```bash
pnpm typecheck                                          # 无新错
pnpm test src/utils/__tests__/debateOrchestrator.test.ts # 全绿（不应有变化）
pnpm test                                               # 全量绿
```

debate-orchestrator helper 行为契约**未变**——仍按 caller 传入的 `pluginsAvailable` 决定路由。所有现有单测继续通过。

## 关键文件

| 文件 | 操作 | 行号 | 说明 |
|------|------|------|------|
| `templates/commands/debate.md` | 修改 | L50-53 | Step 0.3 收紧探测语义 |
| `templates/commands/debate.md` | 插入 | L64 后 | 加重试规则 |
| `templates/commands/debate.md` | 修改 | L116 | 降级表触发条件 |
| `src/utils/plugin-detection.ts` | **不改** | — | 现有 `detectPluginAvailability()` 已正确 |
| `src/utils/debate-orchestrator.ts` | **不改** | — | 接收 caller `pluginsAvailable` 已正确 |
| `src/utils/__tests__/debateOrchestrator.test.ts` | **不改** | — | 60+ 用例锁定 helper 行为；template 改动是文本，无回归点 |

净改动：**1 文件 / ~13 行**

## 风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| 主线 LLM 仍可能"自由发挥"绕过模板规则 | 文本写得**显式禁止**（⛔ 严禁查询 broker / /gemini:status），与 v1.7.87 14 sibling 同款防御措辞 |
| 用户真没装 plugin 时 BC 退化 | 降级表保留"detectPlugin returns false"分支；行为与 v4.1 一致 |
| 重试规则触发时间过长（最坏 3 次×timeout） | 仅在 spawn 失败时触发；正常路径零开销。与 14 sibling 一致 |
| 改完之后 sibling 模板里其他相同 bug 没修 | YAGNI；仅 debate 出问题，不外推；如其他模板出问题再单独立 phase |

## 不做（YAGNI 边界）

- ❌ 写 `attemptSpawnWithRetry()` helper — 无证据表明文本约束 insufficient
- ❌ 跨 14 sibling 模板审计 — 单点问题，不外推
- ❌ 改 `plugin-detection.ts` — 现有逻辑已正解
- ❌ 改 `debate-orchestrator.ts` — 接收 caller 输入已正解
- ❌ 改 helper 协议 / 加 metric / 加日志 — 30 行级补丁不需要

## SESSION_ID

- CODEX_SESSION: n/a（未调用，主线 architect 模式）
- GEMINI_SESSION: n/a（未调用，避免触发用户已报的 broker 问题）

## 任务清单（供 /ccg:execute 消费）

```yaml
tasks:
  - id: T1
    wave: 1
    depends_on: []
    files: [templates/commands/debate.md]
    action: edit_lines_50_to_53
    done_when: |
      grep -c "broker\|runtime status\|/gemini:status\|/codex:status" templates/commands/debate.md 在禁用文本块里出现 = 1（仅在 ⛔ 严禁规则中）
      grep -c "detectPluginAvailability" templates/commands/debate.md ≥ 1
  - id: T2
    wave: 1
    depends_on: []
    files: [templates/commands/debate.md]
    action: insert_after_line_64
    done_when: |
      grep -c "重试 2 次\|3 次全部失败" templates/commands/debate.md ≥ 1
  - id: T3
    wave: 1
    depends_on: []
    files: [templates/commands/debate.md]
    action: edit_line_116
    done_when: |
      grep -c "连续 3 次 spawn 失败\|installed: false" templates/commands/debate.md ≥ 1
  - id: T4
    wave: 2
    depends_on: [T1, T2, T3]
    files: []
    action: pnpm typecheck && pnpm test
    done_when: 全绿（无新增 fail）
```
