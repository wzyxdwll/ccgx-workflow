---
description: '原生多轮对辩原语：codex propose ↔ gemini challenge ↔ codex respond，主线编排 cap N 轮或 challenger 自报无 critical 即停'
argument-hint: "<topic> [--max-rounds N] [--layer backend|frontend|fullstack]"
---

# Debate - 原生多轮对辩原语

`/ccg:debate <topic>` 由**主线**管 A↔B 多轮对辩状态机。不是 spawn 一个 agent 让它管对辩——主线自己每轮 spawn 一次模型 + 接 ≤ 200 token 摘要 + 判收敛 + 决定下一轮。

> **设计来源**：用户 Q3 + `.ccg-research/07-multimodel-collaboration-rethink.md`：多模型协作的硬主修复，避免单模型自我洗稿。

## 使用方法

```bash
/ccg:debate <topic> [--max-rounds N] [--layer backend|frontend|fullstack]
```

**Flags**：

| Flag | 默认 | 说明 |
|------|------|------|
| `--max-rounds N` | `3` | 最大轮数；硬上限 `10` |
| `--layer backend\|frontend\|fullstack` | `backend` | 影响 propose / challenge 角色分配（见下表） |

## 轮次协议

主线按 `debateStateMachine(topic, options)` 给出的计划顺序 spawn：

| Round | Kind | backend | frontend | fullstack |
|-------|------|---------|----------|-----------|
| 1 | propose   | codex   | gemini   | codex + gemini 并行 |
| 2 | challenge | gemini  | codex    | codex + gemini 并行（互相反对） |
| 3 | respond   | codex   | gemini   | codex + gemini 并行 |

> 第 4 轮起循环 propose → challenge → respond，按 `--max-rounds` 截断。

## 提示词文件

| Kind | CCG Prompt（内嵌或参考） |
|------|------------------------|
| propose / respond | `~/.claude/.ccg/prompts/{codex\|gemini}/architect.md`（建设性视角） |
| challenge | `~/.claude/.ccg/prompts/{codex\|gemini}/reviewer.md`（adversarial / 专挑漏洞） |

## 主线编排状态机

**Step 0：解析参数**

1. 读 `$ARGUMENTS`，第一个非 flag token 即 topic（用引号包裹整段任务描述）
2. 解析 `--max-rounds N` / `--layer X`
3. **检测 plugin 可用性（解析 installed_plugins.json，禁止运行时探活）**：
   - 用 `Bash` 跑 `node ~/.claude/.ccg/scripts/check-plugins.cjs`（解析 Claude Code 权威 `~/.claude/plugins/installed_plugins.json` 注册表）
   - 返回 JSON `{"codex":"<ver>"|null,"gemini":"<ver>"|null}` + exit code（`0` = 两 plugin 都在；非 `0` = 至少一个缺）→ 各自标 `installed: true/false`
   - ⛔ **严禁**调用 `/gemini:status` / `/codex:status` / 任何 broker / runtime / health 探活——broker 是**懒启动**的，启动后才有；当前 `brokerRunning: false` 不代表 plugin 不可用
   - 任一 plugin 真未装 → 该模型走 general-purpose 降级路径
4. 调用 helper：`debateStateMachine(topic, { maxRounds, layer, pluginsAvailable })` 得到 `DebateRoundPlan[]`

**Step 1：按计划逐轮 spawn**

对每个 round（`for (let i = 0; i < plan.length; i++)`）：

1. 取 `round = plan[i]`
2. 对 `round.models` 中的每个 model：
   - **plugin 路径**（`pluginSubagent` = `codex:codex-rescue` 或 `gemini:gemini-rescue`）：spawn `Agent(subagent_type=round.pluginSubagent[idx], prompt=<下面的 prompt 模板>)`
     - codex 模型 → `Agent(subagent_type="codex:codex-rescue", ...)`
     - gemini 模型 → `Agent(subagent_type="gemini:gemini-rescue", ...)`
   - **降级路径**（`models[idx] === 'general-purpose'`）：spawn `Agent(subagent_type="general-purpose", prompt=<内嵌 round.ccgPromptFiles[idx] 文件全文> + <下面的 prompt 模板>)`
3. ⛔ **plugin spawn 失败必须重试**：若 `Agent(subagent_type="codex:codex-rescue"|"gemini:gemini-rescue")` 调用失败（spawn 抛错 / 返回非结构化错误 / `parseRoundSummary` 返回 `parsed=false`），最多重试 **2 次**（间隔 **5 秒**）。仅当 **3 次全部失败**时才把该模型本轮替换为 general-purpose 降级路径，并在合成的 `RoundSummary.notes` 标 `plugin spawn failed after 3 attempts, degraded: <具体根因>`。⛔ **禁止**单次失败或单次 broker 负信号即降级——broker 懒启动属正常态。

   **schema 硬约束**：标记格式必须是 `plugin spawn failed after N attempts, degraded: <reason>` 三段式（N 必须 ≥ 3，reason 必须给具体根因如 `broker timeout` / `API quota` / `parse-failed`，禁用占位文本如 `unknown` / `n/a`）。`parseRoundSummary` 自动从 NOTES 抽取 populate `RoundSummary.degraded`，Step 2 综合阶段会调 `validateRetryProtocol(累积 RoundSummary[])` 校验合规——违规会出现在最终输出的 ⚠️ 协议违规区段（用户可见）。这是把"3 次重试 + degraded 标记"从 prompt 软约束硬化为 schema-level 校验。
4. **等待所有 model 返回**（`run_in_background: true` + 事件驱动等通知（不调 TaskOutput））
5. 对每个返回的 ≤200 token 摘要调用 `parseRoundSummary(text)` → `RoundSummary`
6. 把本轮的 `RoundSummary[]`（fullstack 为 2 条；backend/frontend 为 1 条）合成一条主 `RoundSummary`（取最长 length，合并 propose/challenge/respond/notes 字段）追加到累积数组
7. **判收敛**：`shouldStop(累积 RoundSummary[], maxRounds)` → 返回 true 即跳出循环

**Step 2：综合输出**

主线综合产出：
- **最终方案**（最近一轮 propose 或 respond）
- **分歧点列表**（所有 challenge 内容去重 + 简化）
- **各方观点摘要表**（每轮 model × kind × 一行核心观点）
- **收敛理由**（哪个信号触发了停止：`no critical` / `max rounds` / `length-converged`）
- ⚠️ **协议违规区段**（**强制**）：在输出最终 markdown 前调用 `validateRetryProtocol(累积 RoundSummary[])` → `RetryProtocolReport`：
  - `report.compliant === false` → 主线 **必须** 在最终输出加一段 `## ⚠️ Retry Protocol Violations`，逐条列 `report.violations[]`（含 `round` / `kind` / `message`）
  - 4 类违规枚举：`parse-failed-no-degraded` / `insufficient-attempts` / `missing-reason` / `silent-success`
  - 设计动机：原 prompt 软约束 "3 次重试 + degraded 标记" 实测会被主线 LLM 跳过（真实案例：主线 R1 一次 fallback 就接受未重试也未标 degraded）。schema 硬校验让违规可观测、可枚举，避免 silent fallback 在 debate 综合阶段被吞
  - **不要**把 violations 摘要塞进对辩主体内容然后跑路——必须独立成段，让用户看见具体哪轮哪种违规

主线输出 markdown 表格，**不写文件**——主线直接展示给用户。

## Round prompt 模板（spawn 时注入）

### propose / respond round

```
你是<layer>层的 architect。
任务：propose <topic>（或 respond 上一轮的 challenge：<上一轮 challenge 内容>）

要求：
1. 给出**可落地**的方案，含关键设计决策与权衡
2. 主动列出 ≥ 2 个潜在风险或反对意见的预判
3. 输出 ≤ 200 token，严格格式：
   STATUS: completed
   PROPOSE: <方案核心一句话>     # 或 RESPOND:
   NOTES: <关键发现 / 风险点 / 一行总结>
```

### challenge round

```
你是<layer>层的 critic / reviewer，**严格 adversarial 视角**。
任务：challenge <上一轮 propose 内容>

要求：
1. 找出 ≥ 2 个 critical / 重大风险（性能、安全、可维护性、边界条件）
2. 如果**真的没有 critical**，明确说"no critical issue"或"agreement reached"
3. 输出 ≤ 200 token：
   STATUS: completed
   CHALLENGE: <核心反对论点>
   NOTES: <发现的关键漏洞 / "no critical issue" / 改进建议>
```

## 降级路径

| 触发条件 | 主线行为 |
|---------|----------|
| `detectPlugin(name)` 返回 `{ installed: false }`（目录或 marker 缺失）**或**同一模型连续 3 次 spawn 失败 | `Agent(subagent_type="general-purpose", prompt=<内嵌 ~/.claude/.ccg/prompts/<model>/<file>.md 全文> + Round prompt 模板)` |
| `parseRoundSummary` 返回 `parsed=false`（subagent 摘要格式损坏） | 本轮主 RoundSummary 标 `parsed=false`，继续下一轮但在最终 NOTES 里标"未达成共识" |
| 主线无法解析任何字段（连续 2 轮都 parsed=false） | 提前停止，输出"未达成共识 / 子模型摘要解析失败" 给用户 |

## 收敛信号（`shouldStop` 双信号）

主线**不应**自己重新发明收敛逻辑——直接用 helper：

```
shouldStop(rounds, maxRounds) → boolean
```

判定规则：
1. **任一轮**的 `challenge` 或 `notes` 字段含 `no critical` / `agreement reached` / `lgtm` / `无 critical` / `达成共识` → 立即停
2. 已达 `maxRounds` → 强制停
3. 相邻两轮 `length` 变化 < 20% → 信息收敛，停

## Helper

实现于 `src/utils/debate-orchestrator.ts`，主线**不需要 import**（已通过 `src/index.ts` 导出供 SDK 用户调用），主线直接用此模板里描述的协议手动执行各步骤。

helper 暴露：
- `debateStateMachine(topic, options)` → `DebateRoundPlan[]`
- `parseRoundSummary(text)` → `RoundSummary`（含 `degraded?: { attempts, reason }` 字段）
- `shouldStop(rounds, maxRounds)` → `boolean`
- `validateRetryProtocol(rounds)` → `RetryProtocolReport`（Step 2 综合阶段必须调；非 compliant 时主线必须在输出加协议违规区段）
- `REQUIRED_RETRY_ATTEMPTS` = `3`（与 Step 1.3 的 "3 次全部失败" 文档同步）

## 不做

- ❌ **不**改源代码 / 不写文件（debate 是纯讨论原语）
- ❌ **不**调 codeagent-wrapper（debate 走 plugin spawn 范式）
- ❌ **不** spawn debate-manager subagent 让它管对辩——主线自己管，逐轮接摘要

## 与其他命令的关系

- `/ccg:plan` / `/ccg:analyze`：单次双模型并行，不轮转。`/ccg:debate` 适合需求**有争议**或**风险高**的设计决策，用多轮"propose → challenge → respond"压力测试。
- `/ccg:review --fix`：基于已有代码改动的审查闭环。`/ccg:debate` 用于**改动前**的方案讨论。
- `/ccg:autonomous`：长跑链路，每个 phase 自包含。`/ccg:debate` 是单一主题的对辩原语，不入 roadmap。
