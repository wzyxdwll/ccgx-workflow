---
description: 'Agent Teams 并行实施 - 读取计划文件，spawn Builder teammates 并行写代码'
context_budget: orchestrator-15
subagent_freshness: required
---
<!-- CCG:TEAM:EXEC:START -->
**Core Philosophy**
- 实施是纯机械执行——所有决策已在 team-plan 阶段完成。
- Lead 不写代码，只做编排和汇总。
- 调度模式 = **wave-based 依赖图调度**：
  * 同一 wave 内任务文件零交叉，Builder 并行 spawn
  * 跨 wave 严格顺序，上一 wave 全部退出后才进入下一 wave
  * 失败的任务不阻塞同 wave 其他任务，但会让下游 wave 中依赖它的任务被 skipped
- 每个 wave 结束写 `.ccg/state.md`，支持断点续跑。

**Guardrails**
- **前置条件**：`.claude/team-plan/` 下必须有计划文件。没有则终止，提示先运行 `/ccg:team-plan`。
- **Agent Teams 必须启用**：需要 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`。
- Lead 绝不直接修改产品代码。
- 每个 Builder 只能修改分配给它的文件。
- 同一 wave 内的多个 Agent 调用**必须在一条消息内同时发出**（多 tool calls 并行 spawn）。

**Steps**

### Step 1: 前置检查
- 检测 Agent Teams 是否可用。
- 若不可用，输出启用指引后终止：
  ```
  ⚠️ Agent Teams 未启用。请先配置：
  在 settings.json 中添加：
  { "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" } }
  ```
- 读取 `.claude/team-plan/` 下最新的计划文件。
- 若无计划文件，提示：`请先运行 /ccg:team-plan <任务描述> 生成计划`，终止。
- 通过 Bash `pwd` 获取 WORKDIR 绝对路径。

### Step 2: 解析依赖图
1. **读取计划文件**：优先解析末尾的 `tasks:` yaml 块（machine-readable），fallback 到 Markdown 子任务列表。
2. **抽取每个任务**：`id` / `type` / `files` / `wave` / `depends_on` / `prompt-bearing 内容（实施步骤 + 验收标准 + 文件范围）`。
3. **降级兼容（旧版 plan 文件）**：
   - 若任何任务缺失 `wave` 字段 → 整份计划全部归入 `wave: 1`，`depends_on: []`，全并行执行。
   - 若任何任务缺失 `id` 字段 → 按出现顺序自动编号 `T1, T2, ...`。
   - 输出降级提示：`⚠️ 检测到旧版 plan（无 wave 字段），已降级为单 wave 全并行模式`。
4. **拓扑校验**：
   - `depends_on` 引用的 id 必须都存在
   - 任务自身 wave 必须严格大于其所有 `depends_on` 任务的 wave
   - 同 wave 内任务文件 `files` 必须零交叉
   - 任一校验失败 → 终止，列出问题并要求用户修正 plan 文件
5. **断点续跑检测**：
   - 若 `<WORKDIR>/.ccg/state.md` 已存在，读取其中各任务状态：
     * `completed` → 跳过
     * `failed` / `skipped` → 询问用户是重跑还是保留
     * `in_progress` / `pending` → 重新调度
   - 若不存在，初始化新的 state.md（见 Step 6）。

### Step 3: 用户确认 + 创建 Team
- 向用户展示：
  ```
  📋 即将进行 wave-based 并行实施：
  - 总子任务：N 个（已完成 K，待执行 N-K）
  - 总 Wave 数：M 个
  - Wave 1: X 个并行 Builder
  - Wave 2: Y 个并行 Builder（依赖 Wave 1）
  - ...
  - 失败处理：单任务失败不阻塞同 wave，依赖该任务的下游任务自动 skipped
  - 状态文件：.ccg/state.md（每个 wave 结束自动更新）
  确认开始？
  ```
- 用 `AskUserQuestion` 等待确认。
- 调用 TeamCreate 创建 team，team_name 设为 `<plan-id>-team`。
- 为所有"待执行"的子任务一次性调用 TaskCreate（注意：不是分 wave 创建，是一次创建完）。
- 用 TaskUpdate 的 `addBlockedBy` 把每个任务的 `depends_on` 转为 task 依赖（让 Claude Code 任务板自带依赖可视化）。

### Step 4: Wave 调度主循环

**对 wave = 1, 2, ..., M 依次执行：**

1. **决定本 wave 的可执行任务集合**：
   - 收集所有 `wave == 当前 wave 号` 的任务
   - 排除：状态为 `completed` 的任务
   - 排除：任何一个 `depends_on` 任务状态为 `failed` 或 `skipped` 的任务 → 标记为 `skipped`，并在状态文件中说明原因（"upstream T2 failed"）
   - 剩下的就是本 wave 真正要 spawn 的任务

2. **如果本 wave 可执行任务为空** → 直接进入下一 wave。

3. **⛔ 一条消息内并行 spawn 所有 Builder**：
   - 你必须在**同一条 assistant message 中发起多个 Agent 工具调用**，每个待执行任务对应一个 Agent 调用。
   - 例：本 wave 有 3 个任务 → 这条消息包含 3 个 Agent tool calls，三个 Builder 同时启动。
   - 禁止串行（spawn builder-1 → 等结果 → spawn builder-2）。
   - 每个 Agent 调用必须包含：
     * **team_name**: Step 3 创建的 team name
     * **name**: `"builder-<task-id>"`（如 `builder-T1`、`builder-T3`）
     * **model**: `"sonnet"`
     * **prompt**: 见下方模板
   - spawn 后立即对每个 Task 调用 TaskUpdate 设 owner、status="in_progress"。

   **Builder spawn prompt 模板**：
   ```
   你是 Builder，负责实施一个子任务。严格按照以下指令执行。

   ## 你的任务 ID
   <task.id>

   ## 你的任务
   <从计划文件中提取该任务的完整实施步骤、验收标准、上下文>

   ## 工作目录
   <WORKDIR>

   ## 文件范围约束（⛔ 硬性规则）
   你只能创建或修改以下文件：
   <task.files>
   严禁修改任何其他文件。违反此规则等于任务失败。

   ## 上游依赖产物（仅供参考，不要修改）
   <列出 depends_on 中已 completed 任务实际产出的文件，让 Builder 知道接口形态>

   ## 实施要求
   1. 严格按照实施步骤执行
   2. 代码必须符合项目现有规范和模式
   3. 完成后运行相关的 lint/typecheck 验证（如果项目有配置）
   4. 代码应自解释，非必要不加注释

   ## 验收标准
   <从计划中提取>

   完成所有步骤后，标记任务为 completed。
   失败时，明确说出失败原因，标记为 failed，不要假装完成。
   ```

4. **等待本 wave 全部 Builder 退出**：
   - teammates 完成 task 后会自动发消息，无需轮询。
   - 进入 **delegate 模式**：除了接消息和回复，不做任何其他事。
   - 如某个 Builder 发消息求助 → 通过 SendMessage 回复指导，不替它写代码。
   - 单 Builder 失败：
     * 记录失败原因到 state.md
     * **不打断**同 wave 其他 Builder 继续工作
   - 必须等到本 wave **全部 Builder** 都退出（completed 或 failed），才能进入下一 wave。

5. **Wave 结束清理**：
   - 通过 SendMessage 给本 wave 所有 Builder 发 shutdown_request。
   - 更新 `.ccg/state.md`（见 Step 6 格式）。
   - 输出 wave 摘要：
     ```
     ✅ Wave <N> 完成: completed=X, failed=Y, skipped=Z
     → 进入 Wave <N+1>
     ```

### Step 5: 失败处理选项

当某个 wave 出现 `failed` 任务时，所有后续 wave 调度结束后（**不在 wave 中途打断**），向用户报告：

```markdown
## ⚠️ 实施完成（含失败任务）

### 失败任务
- T2: 用户 API（src/api/users.ts）
  - 失败原因：<Builder 报告的失败信息>
  - 修改的文件：<git status 列出>
  - 影响下游：T4（已 skipped）、T7（已 skipped）

### 选项
1. **重试一次**：将失败任务重置为 pending，重新走 wave 调度（依赖它的 skipped 任务也会重新进入待执行）
2. **传给 Reviewer**：用 `/ccg:team-review` 让双模型审查失败原因和修改的文件
3. **接受失败**：保留 state.md，跳出执行
```

用 `AskUserQuestion` 让用户选择。**重试**最多再走一轮 wave 调度，第二次仍失败则强制选 2/3。

### Step 5.5: Frontmatter-only Summary 读取（v4.0 Phase 2 状态机）

**核心契约**：Lead 不接 Builder 的全部 stdout。每个 Builder 完成任务后，**必须由 Lead 读取该任务对应的 `.context/<phase>/SUMMARY.md` 的 YAML frontmatter**——不读 body，不读 builder transcript。

- `<phase>` 取计划文件主名（如 `.claude/team-plan/user-auth.md` → `user-auth`）。
- frontmatter 字段（与 `/ccg:execute` 5.3 写入约定一致）：`phase`, `plan`, `provides`, `affects`, `key_files`, `completed`, `completed_at`, `notes`。
- **预算硬约束**：单个 SUMMARY.md frontmatter < 200 tokens，5 个 phase 累计 < 1000 tokens 进入 orchestrator context。如某 SUMMARY 超出 200 tokens，截断 `notes` 字段并记录到 state.md 的 Notes 段。
- **缺失处理**：若 Builder 没写 SUMMARY.md（异常退出 / 老版本 plan 文件），Lead 把对应任务标 `failed` 而非凭 builder 消息推断状态。

读取实现（推荐用 `src/utils/phase-context.ts` 暴露的 `readSummaryFrontmatter()`，等价于 Read SUMMARY.md 后只取 `---...---` 之间的内容）。

### Step 6: 汇总 + 清理

1. **汇总报告**：
   ```markdown
   ## ✅ Team 并行实施完成

   ### Wave 执行摘要
   | Wave | 总任务 | completed | failed | skipped | 实际并行度 |
   |------|--------|-----------|--------|---------|-----------|
   | 1    | 2      | 2         | 0      | 0       | 2         |
   | 2    | 3      | 2         | 1      | 0       | 3         |
   | 3    | 1      | 0         | 0      | 1       | 0         |

   ### 任务详情
   | Task ID | 名称 | 状态 | 修改文件 |
   |---------|------|------|----------|
   | T1      | 用户 API | ✅ completed | src/api/users.ts |
   | T2      | 数据模型 | ✅ completed | prisma/schema.prisma |
   | T3      | 用户卡片 | ✅ completed | src/components/UserCard.tsx |
   | T4      | 用户列表 | ❌ failed | (失败原因) |
   | T5      | 用户编辑 | ⏭ skipped | (依赖 T4) |

   ### 后续建议
   1. 运行完整测试：`npm test` / `pnpm test`
   2. 检查模块间集成
   3. 提交代码：`git add -A && git commit`
   ```

2. **清理 Team**：通过 SendMessage shutdown 剩余 teammates，TeamDelete 清理 team。

3. **保留 state.md**：不要删除 `.ccg/state.md`——下次再跑同一 plan 时它就是断点。仅在所有任务全部 completed 时才清理。

**Exit Criteria**
- [ ] 依赖图解析完成（含旧版降级路径）
- [ ] 所有可执行 wave 已按顺序跑完
- [ ] 同 wave Builder 在单条消息内并行 spawn（已校验：消息内多 tool calls）
- [ ] 失败任务不阻塞同 wave，下游依赖任务自动 skipped
- [ ] `.ccg/state.md` 反映最终状态
- [ ] 变更摘要 + Wave 表已输出
- [ ] Team 已清理

---

## 状态文件格式

每个 wave 结束后，team-exec 都要重写 `<WORKDIR>/.ccg/state.md`。格式如下（user-readable + 可被下次 team-exec 重新解析）：

```markdown
# CCG Team Execution State

**Plan**: .claude/team-plan/<plan-id>.md
**Team**: <team_name>
**Started**: 2026-05-03 10:00
**Last Updated**: 2026-05-03 10:42
**Current Wave**: 2 / 3

## Wave 1 (completed)
- [x] T1: 用户 API (src/api/users.ts) — completed @ 10:15
- [x] T2: 数据模型 (prisma/schema.prisma) — completed @ 10:18

## Wave 2 (in_progress)
- [x] T3: 用户卡片组件 (src/components/UserCard.tsx) — completed @ 10:30
- [ ] T4: 用户列表页 (src/pages/UserList.tsx) — in_progress (builder-T4)
- [ ] T5: 用户编辑表单 (src/pages/UserEdit.tsx) — pending (depends_on: T4)

## Wave 3 (pending)
- [ ] T6: E2E 测试 (tests/e2e/users.spec.ts) — pending (depends_on: T4, T5)

## Failed Tasks
（无）

## Skipped Tasks
（无）
```

**字段约定**：
- 每个 task 一行，`[x]` = completed，`[ ]` = pending/in_progress/failed/skipped
- 行尾 `— <status> @ <时间>` 标注最新状态
- `(builder-<id>)` 表示当前承担该任务的 Builder name
- `(depends_on: ...)` 解释 pending 原因
- Failed/Skipped 任务集中在末尾两个 section 罗列，含失败原因或跳过原因

**重跑入口约定**：下次 `/ccg:team-exec` 启动时，Step 2 检测到 state.md → 跳过所有 `[x]` 任务，从最早的 `[ ]` 任务所在的 wave 开始重新调度。

<!-- CCG:TEAM:EXEC:END -->
