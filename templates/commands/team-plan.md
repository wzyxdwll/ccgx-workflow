---
description: 'Agent Teams 规划 - Lead 调用后端/前端模型 并行分析，产出零决策并行实施计划'
---
<!-- CCG:TEAM:PLAN:START -->
**Core Philosophy**
- 产出的计划必须让 Builder teammates 能无决策机械执行。
- 每个子任务的文件范围必须隔离，确保并行不冲突。
- 多模型协作是强制的：{{BACKEND_PRIMARY}}（后端权威）+ {{FRONTEND_PRIMARY}}（前端权威）。

**Guardrails**
- 多模型分析是 **mandatory**：必须同时调用 {{BACKEND_PRIMARY}} 和 {{FRONTEND_PRIMARY}}。
- 不写产品代码，只做分析和规划。
- 计划文件必须包含 外部模型的实际分析摘要。
- 使用 `AskUserQuestion` 解决任何歧义。

**Steps**
1. **上下文收集**
   - 用 Glob/Grep/Read 分析项目结构、技术栈、现有代码模式。
   - 如果 `{{MCP_SEARCH_TOOL}}` 可用，优先语义检索。
   - 整理出：技术栈、目录结构、关键文件、现有模式。

2. **多模型并行分析（PARALLEL）**
   - **CRITICAL**: 必须在一条消息中同时发起两个 Bash 调用，`run_in_background: true`。
   - **工作目录**：`{{WORKDIR}}` **必须通过 Bash 执行 `pwd`（Unix）或 `cd`（Windows CMD）获取当前工作目录的绝对路径**，禁止从 `$HOME` 或环境变量推断。

   **FIRST Bash call ({{BACKEND_PRIMARY}})**:
   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend {{BACKEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nROLE_FILE: ~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/analyzer.md\n<TASK>\n需求：$ARGUMENTS\n上下文：<步骤1收集的项目结构和关键代码>\n</TASK>\nOUTPUT:\n1) 技术可行性评估\n2) 推荐架构方案（精确到文件和函数）\n3) 详细实施步骤\n4) 风险评估\nEOF",
     run_in_background: true,
     timeout: 3600000,
     description: "{{BACKEND_PRIMARY}} 后端分析"
   })
   ```

   **SECOND Bash call ({{FRONTEND_PRIMARY}}) - IN THE SAME MESSAGE**:
   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend {{FRONTEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nROLE_FILE: ~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/analyzer.md\n<TASK>\n需求：$ARGUMENTS\n上下文：<步骤1收集的项目结构和关键代码>\n</TASK>\nOUTPUT:\n1) UI/UX 方案\n2) 组件拆分建议（精确到文件和函数）\n3) 详细实施步骤\n4) 交互设计要点\nEOF",
     run_in_background: true,
     timeout: 3600000,
     description: "{{FRONTEND_PRIMARY}} 前端分析"
   })
   ```

   **等待结果**:
   ```
   TaskOutput({ task_id: "<codex_task_id>", block: true, timeout: 600000 })
   TaskOutput({ task_id: "<gemini_task_id>", block: true, timeout: 600000 })
   ```

   - 必须指定 `timeout: 600000`，否则默认 30 秒会提前超时。
   - 若 10 分钟后仍未完成，继续轮询，**绝对不要 Kill 进程**。
   - ⛔ **前端模型失败必须重试**：若前端模型调用失败（非零退出码或输出包含错误信息），最多重试 2 次（间隔 5 秒）。仅当 3 次全部失败时才跳过前端模型结果并使用单模型结果继续。
   - ⛔ **后端模型结果必须等待**：后端模型执行时间较长（5-15 分钟）属于正常。TaskOutput 超时后必须继续轮询，**绝对禁止在后端模型未返回结果时直接跳过**。

3. **综合分析 + 任务拆分（wave-based 依赖图）**
   - 后端方案以 {{BACKEND_PRIMARY}} 为准，前端方案以 {{FRONTEND_PRIMARY}} 为准。
   - 拆分为独立子任务，每个子任务：
     * 唯一 `id`（如 `T1`、`T2`，全局唯一）
     * 文件范围不重叠（**同 wave 内强制零交叉**）
     * 如果无法避免文件重叠 → 用 `depends_on` 设为前后依赖关系
     * 有具体实施步骤和验收标准
   - **依赖图 → wave 划分**：
     * `wave: 1` = 无依赖、可立即开跑
     * `wave: N` = 所有 `depends_on` 中的任务必须在 wave < N 中
     * 拓扑排序，最大化 wave 内并行度
     * **同 wave 内任务文件范围必须零交叉**（这是 team-architect 文件分配矩阵的延伸约束）
     * 不同 wave 严格顺序：上一 wave 全部 builder 退出后才进入下一 wave

4. **写入计划文件**
   - 路径：`.claude/team-plan/<任务名>.md`（英文短横线命名）
   - 计划文件骨架（按以下章节顺序写入）：

     - **标题**: `# Team Plan: <任务名>`
     - **## 概述**: 一句话描述
     - **## {{BACKEND_PRIMARY}} 分析摘要**: 后端模型实际返回的关键内容
     - **## {{FRONTEND_PRIMARY}} 分析摘要**: 前端模型实际返回的关键内容
     - **## 技术方案**: 综合最优方案 + 关键技术决策
     - **## 子任务列表**: 每个子任务一节，逐项展开（见下方"子任务节模板"）
     - **## 任务依赖图 (machine-readable)**: 一段 yaml fenced 代码块（见下方"yaml 模板"）
     - **## 文件冲突检查**: 列出每个 wave 内文件零交叉的校验结果
     - **## Wave 摘要**: 每 wave 一行，列出 wave 号 + 任务 id 列表 + 并行度

   - **子任务节模板**（每个 task 一段）:

     ```
     ### T1: <名称>
     - **id**: T1
     - **wave**: 1
     - **depends_on**: []
     - **类型**: 前端/后端
     - **文件范围**: <精确文件路径列表>
     - **实施步骤**:
       1. <具体步骤>
       2. <具体步骤>
     - **验收标准**: <怎么算完成>
     ```

   - **yaml 模板**（写入"任务依赖图"章节，是 team-exec 解析依赖图的权威来源）:

     ```yaml
     tasks:
       - id: T1
         type: 后端
         files: [src/api/users.ts, src/api/users.test.ts]
         wave: 1
         depends_on: []
         acceptance: GET/POST /api/users 返回正确 schema, 单测通过
       - id: T2
         type: 后端
         files: [prisma/schema.prisma]
         wave: 1
         depends_on: []
         acceptance: User model 含 email/passwordHash/createdAt, migration 可前后回滚
       - id: T3
         type: 前端
         files: [src/components/UserCard.tsx]
         wave: 2
         depends_on: [T1]
         acceptance: 接收 User props, 渲染头像+姓名+邮箱, 已通过 a11y 检查
       - id: T4
         type: 前端
         files: [src/pages/UserList.tsx]
         wave: 2
         depends_on: [T1, T3]
         acceptance: 拉取 /api/users 列表渲染 UserCard, 含 loading/empty/error 三态
     ```

     **字段约定**：
     - `id`/`type`/`files`/`wave`/`depends_on`：必需，team-exec 解析必备
     - `acceptance`：必需，单行验收准则，由 team-architect 委派后写入；team-exec 在 wave 完成时把它转给 verifier 校验

   - **Wave 摘要示例**:
     - **Wave 1** (并行): T1, T2 — 2 个 builder 同时跑
     - **Wave 2** (依赖 Wave 1): T3, T4 — 等 Wave 1 全部完成后启动

   **降级兼容**：旧版 plan 文件（无 `wave` / `depends_on` 字段）由 team-exec 在解析时自动归入 `wave: 1`，全部并行执行。

5. **用户确认**
   - 展示计划摘要（子任务数、Wave 数、每 wave 并行度、总 Builder 峰值）。
   - 用 `AskUserQuestion` 请求确认。
   - 确认后提示：`计划已就绪，运行 /ccg:team-exec 开始 wave-based 并行实施`

6. **上下文检查点**
   - 报告当前上下文使用量。
   - 如果接近 80K：建议 `/clear` 后运行 `/ccg:team-exec`。

**Exit Criteria**
- [ ] {{BACKEND_PRIMARY}} + {{FRONTEND_PRIMARY}} 分析完成
- [ ] 每个子任务都有唯一 `id`、`wave`、`depends_on` 字段
- [ ] 同 wave 内文件范围零交叉（已校验）
- [ ] 跨 wave 依赖关系闭合（`depends_on` 引用的 id 都存在且 wave 更小）
- [ ] 计划文件已写入 `.claude/team-plan/`，含 yaml `tasks:` 块
- [ ] 用户已确认计划
<!-- CCG:TEAM:PLAN:END -->
