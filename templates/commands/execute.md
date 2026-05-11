---
description: '多模型协作执行 - 根据计划获取原型 → Claude 重构实施 → 多模型审计交付'
context_budget: orchestrator-15
subagent_freshness: required
---

# Execute - 多模型协作执行

$ARGUMENTS

---

## 核心协议

- **语言协议**：与工具/模型交互用**英语**，与用户交互用**中文**
- **代码主权**：外部模型对文件系统**零写入权限**，所有修改由 Claude 执行
- **脏原型重构**：将外部模型的 Unified Diff 视为"脏原型"，必须重构为生产级代码
- **止损机制**：当前阶段输出通过验证前，不进入下一阶段
- **前置条件**：仅在用户对 `/ccg:plan` 输出明确回复 "Y" 后执行（如缺失，必须先二次确认）

---

## 调用通道路由（CCG codeagent 退役）

CCG 把 6 核心命令的"双模型并行"通道从 `Bash(codeagent-wrapper)` **默认切换**为 plugin spawn。判定流程：

1. **优先 plugin spawn 路径**（默认）：用户已装 `codex@openai-codex` 和 gemini plugin（推荐 `gemini@gemini-ccgx` fork，已含全部 patch；或上游 `gemini@google-gemini` 配 repatch）→ 用 `Agent(subagent_type="codex:codex-rescue")` + `Agent(subagent_type="gemini:gemini-rescue")` 并行 spawn，主线只接 plugin 自家 ≤200 token 摘要。
2. **降级 codeagent-wrapper 路径**（BC fallback）：plugin 未装 → fallback 到 `Bash(~/.claude/bin/codeagent-wrapper ...)`，行为与 plugin 路径等价。

**判断方法**：preflight 用 `Bash` 跑 `ls ~/.claude/plugins/ 2>/dev/null | grep -E '^(codex|gemini)@'`；两个 plugin 独立判定。

**单一真相源**：`src/utils/plugin-detection.ts`（导出 `detectPlugin` / `detectPluginAvailability` / `bothPluginsInstalled`）。

⚠️ Execute 命令在主线 context 内，**允许**调 `Agent(...)`——与 subagent "引擎层禁止嵌套 spawn" 约束不冲突。

---

## 多模型调用规范

**工作目录**：
- `{{WORKDIR}}`：**必须通过 Bash 执行 `pwd`（Unix）或 `cd`（Windows CMD）获取当前工作目录的绝对路径**，禁止从 `$HOME` 或环境变量推断
- 如果用户通过 `/add-dir` 添加了多个工作区，先用 Glob/Grep 确定任务相关的工作区
- 如果无法确定，用 `AskUserQuestion` 询问用户选择目标工作区

**调用语法**（双通道）：

**通道 A — plugin spawn（默认，原型生成）**：

```
Agent({
  subagent_type: "<codex:codex-rescue|gemini:gemini-rescue>",
  description: "Execute prototype: <backend|frontend>",
  prompt: `ROLE_FILE: <角色提示词路径>

<TASK>
需求：<任务描述>
上下文：<计划内容 + 目标文件>
</TASK>

OUTPUT: Unified Diff Patch ONLY. Strictly prohibit any actual modifications.
Return ≤200 token structured summary (plugin-native protocol).
`
})
```

> Plugin 上下文不需要 `resume <SESSION_ID>` —— plugin advisor 自己管理跨调用 session（用 `description` 区分阶段即可）。

**通道 B — codeagent-wrapper fallback**（plugin 未装时降级，并行用 `run_in_background: true`）：

```
# 复用会话调用（推荐）- 原型生成（Implementation Prototype）
Bash({
  command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend <{{BACKEND_PRIMARY}}|{{FRONTEND_PRIMARY}}> {{GEMINI_MODEL_FLAG}}resume <SESSION_ID> - \"{{WORKDIR}}\" <<'EOF'
ROLE_FILE: <角色提示词路径>
<TASK>
需求：<任务描述>
上下文：<计划内容 + 目标文件>
</TASK>
OUTPUT: Unified Diff Patch ONLY. Strictly prohibit any actual modifications.
EOF",
  run_in_background: true,
  timeout: 3600000,
  description: "简短描述"
})

# 新会话调用 - 原型生成（Implementation Prototype）
Bash({
  command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend <{{BACKEND_PRIMARY}}|{{FRONTEND_PRIMARY}}> {{GEMINI_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'
ROLE_FILE: <角色提示词路径>
<TASK>
需求：<任务描述>
上下文：<计划内容 + 目标文件>
</TASK>
OUTPUT: Unified Diff Patch ONLY. Strictly prohibit any actual modifications.
EOF",
  run_in_background: true,
  timeout: 3600000,
  description: "简短描述"
})
```

**审计调用语法**（Code Review / Audit）：

```
Bash({
  command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend <{{BACKEND_PRIMARY}}|{{FRONTEND_PRIMARY}}> {{GEMINI_MODEL_FLAG}}resume <SESSION_ID> - \"{{WORKDIR}}\" <<'EOF'
ROLE_FILE: <角色提示词路径>
<TASK>
Scope: Audit the final code changes.
Inputs:
- The applied patch (git diff / final unified diff)
- The touched files (relevant excerpts if needed)
Constraints:
- Do NOT modify any files.
- Do NOT output tool commands that assume filesystem access.
</TASK>
OUTPUT:
1) A prioritized list of issues (severity, file, rationale)
2) Concrete fixes; if code changes are needed, include a Unified Diff Patch in a fenced code block.
EOF",
  run_in_background: true,
  timeout: 3600000,
  description: "简短描述"
})
```

**角色提示词**：

| 阶段 | 后端 | 前端 |
|------|-------|--------|
| 实施 | `~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/architect.md` | `~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/frontend.md` |
| 审查 | `~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/reviewer.md` | `~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/reviewer.md` |

**会话复用**：如果 `/ccg:plan` 提供了 SESSION_ID，使用 `resume <SESSION_ID>` 复用上下文。

**事件驱动等待**：spawn 后主线说明 task-id 然后 **turn end**，引擎自动 `<task-notification>` 触发新 turn 处理结果。**不调 TaskOutput**。

⛔ **禁止**：调 `TaskOutput({block: true, timeout: 600000})` 旧 freeze poll 模式 / Kill task。

⚠️ **失败处理**：notification status=failed / exit ≠ 0 / parse 失败 → v1.7.87 标准 2-retry / 5s / 3-attempts；3 次全失败才降级单模型。

---

## 执行工作流

**执行任务**：$ARGUMENTS

### 📖 Phase 0：读取计划

`[模式：准备]`

1. **识别输入类型**：
   - 计划文件路径（如 `.claude/plan/xxx.md`）
   - 直接的任务描述

2. **读取计划内容**：
   - 若提供了计划文件路径，读取并解析
   - 提取：任务类型、实施步骤、关键文件、SESSION_ID

3. **执行前确认**：
   - 若输入为"直接任务描述"或计划中缺失 `SESSION_ID` / 关键文件：先向用户确认补全信息
   - 若无法确认用户是否已对计划回复 "Y"：必须二次询问确认后再进入下一阶段

4. **任务类型判断**：

   | 任务类型 | 判断依据 | 路由 |
   |----------|----------|------|
   | **前端** | 页面、组件、UI、样式、布局 | {{FRONTEND_PRIMARY}} |
   | **后端** | API、接口、数据库、逻辑、算法 | {{BACKEND_PRIMARY}} |
   | **全栈** | 同时包含前后端 | {{BACKEND_PRIMARY}} ∥ {{FRONTEND_PRIMARY}} 并行 |

---

### 🔍 Phase 1：上下文快速检索

`[模式：检索]`

**⚠️ 必须使用 MCP 工具快速检索上下文，禁止手动逐个读取文件**

根据计划中的"关键文件"列表，调用 `{{MCP_SEARCH_TOOL}}` 检索相关代码：

```
{{MCP_SEARCH_TOOL}}({
  query: "<基于计划内容构建的语义查询，包含关键文件、模块、函数名>",
  project_root_path: "{{WORKDIR}}"
})
```

**检索策略**：
- 从计划的"关键文件"表格提取目标路径
- 构建语义查询覆盖：入口文件、依赖模块、相关类型定义
- 若检索结果不足，可追加 1-2 次递归检索
- **禁止**使用 Bash + find/ls 手动探索项目结构

**检索完成后**：
- 整理检索到的代码片段
- 确认已获取实施所需的完整上下文
- 进入 Phase 3

---

### 🎨 Phase 3：原型获取

`[模式：原型]`

**根据任务类型路由**：

#### Route A: 前端/UI/样式 → {{FRONTEND_PRIMARY}}

**限制**：上下文 < 32k tokens

1. 调用 {{FRONTEND_PRIMARY}}（使用 `~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/frontend.md`）
2. 输入：计划内容 + 检索到的上下文 + 目标文件
3. OUTPUT: `Unified Diff Patch ONLY. Strictly prohibit any actual modifications.`
4. **{{FRONTEND_PRIMARY}} 是前端设计的权威，其 CSS/React/Vue 原型为最终视觉基准**
5. ⚠️ **警告**：忽略前端模型对后端逻辑的建议
6. 若计划包含 `FRONTEND_SESSION`：优先 `resume <FRONTEND_SESSION>`

#### Route B: 后端/逻辑/算法 → {{BACKEND_PRIMARY}}

1. 调用 {{BACKEND_PRIMARY}}（使用 `~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/architect.md`）
2. 输入：计划内容 + 检索到的上下文 + 目标文件
3. OUTPUT: `Unified Diff Patch ONLY. Strictly prohibit any actual modifications.`
4. **{{BACKEND_PRIMARY}} 是后端逻辑的权威，利用其逻辑运算与 Debug 能力**
5. 若计划包含 `BACKEND_SESSION`：优先 `resume <BACKEND_SESSION>`

#### Route C: 全栈 → 并行调用

1. **并行调用**（`run_in_background: true`）：
   - {{FRONTEND_PRIMARY}}：处理前端部分
   - {{BACKEND_PRIMARY}}：处理后端部分
2. 用 `TaskOutput` 等待两个模型的完整结果
3. 各自使用计划中对应的 `SESSION_ID` 进行 `resume`（若缺失则创建新会话）

**务必遵循上方 `多模型调用规范` 的 `重要` 指示**

---

### ⚡ Phase 4：编码实施

`[模式：实施]`

**Claude 作为代码主权者执行以下步骤**：

1. **读取 Diff**：解析外部模型返回的 Unified Diff Patch

2. **思维沙箱**：
   - 模拟应用 Diff 到目标文件
   - 检查逻辑一致性
   - 识别潜在冲突或副作用

3. **重构清理**：
   - 将"脏原型"重构为**高可读、高可维护性、企业发布级代码**
   - 去除冗余代码
   - 确保符合项目现有代码规范
   - **非必要不生成注释与文档**，代码自解释

4. **最小作用域**：
   - 变更仅限需求范围
   - **强制审查**变更是否引入副作用
   - 做针对性修正

5. **应用变更**：
   - 使用 Edit/Write 工具执行实际修改
   - **仅修改必要的代码**，严禁影响用户现有的其他功能
6. **自检验证**（强烈建议）：
   - 运行项目既有的 lint / typecheck / tests（优先最小相关范围）
   - 若失败：优先修复回归，再继续进入 Phase 5

---

### ✅ Phase 5：审计与交付

`[模式：审计]`

#### 5.1 自动审计

**变更生效后，强制立即并行调用** {{BACKEND_PRIMARY}} 和 {{FRONTEND_PRIMARY}} 进行 Code Review：

1. **{{BACKEND_PRIMARY}} 审查**（`run_in_background: true`）：
   - ROLE_FILE: `~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/reviewer.md`
   - 输入：变更的 Diff + 目标文件
   - 关注：安全性、性能、错误处理、逻辑正确性

2. **{{FRONTEND_PRIMARY}} 审查**（`run_in_background: true`）：
   - ROLE_FILE: `~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/reviewer.md`
   - 输入：变更的 Diff + 目标文件
   - 关注：可访问性、设计一致性、用户体验

用 `TaskOutput` 等待两个模型的完整审查结果。优先复用 Phase 3 的会话（`resume <SESSION_ID>`）以保持上下文一致。

#### 5.2 整合修复

1. 综合 {{BACKEND_PRIMARY}} + {{FRONTEND_PRIMARY}} 的审查意见
2. 按信任规则权衡：后端以 {{BACKEND_PRIMARY}} 为准，前端以 {{FRONTEND_PRIMARY}} 为准
3. 执行必要的修复
4. 修复后按需重复 Phase 5.1（直到风险可接受）

#### 5.3 写入 phase-scoped SUMMARY.md（状态机）

**强制**：每完成一个 plan 后，写 `.context/<phase>/SUMMARY.md` 让上层 orchestrator（autonomous / team-exec）只读 frontmatter（< 200 tokens / phase）就能决策推进，避免接整段 builder stdout 污染主线 context。

`<phase>` = 计划文件主名（如 `user-auth.md` → `user-auth`），与 `/ccg:plan` 写 CONTEXT.md 的目录约定一致。

**SUMMARY.md frontmatter 必含字段（机器可读契约）**：

```yaml
---
phase: user-auth
plan: .claude/plan/user-auth.md
provides: [<本 phase 产出的能力或模块名>]
affects: [<受影响的文件/模块>]
key_files: [<本 phase 实际改动的关键文件>]
completed: true
completed_at: <ISO8601 时间>
notes: <一行收尾说明，可省略>
---
```

字段语义：
- `provides` — 下游 phase 可引用的输出（API/模块/契约）
- `affects` — 横向耦合面，给 orchestrator 做依赖图用
- `key_files` — 真正落盘的产物文件路径
- `completed` — `true` 表示 acceptance 全过；`false` 表示 partial（需要主线接手）

由 Claude 用 Write 工具直接落盘 `<WORKDIR>/.context/<phase>/SUMMARY.md`。目录不存在自动创建。**外部模型不写**——这是主线的契约边界。

#### 5.4 交付确认

审计通过且 SUMMARY.md 写入后，向用户报告：

```markdown
## ✅ 执行完成

### 变更摘要
| 文件 | 操作 | 说明 |
|------|------|------|
| path/to/file.ts | 修改 | 描述 |

### 审计结果
- {{BACKEND_PRIMARY}}：<通过/发现 N 个问题>
- {{FRONTEND_PRIMARY}}：<通过/发现 N 个问题>

### Phase 状态
- `.context/<phase>/SUMMARY.md` 已写入（completed: true / false）

### 后续建议
1. [ ] <建议的测试步骤>
2. [ ] <建议的验证步骤>
```

---

## 关键规则

1. **代码主权** – 所有文件修改由 Claude 执行，外部模型零写入权限
2. **脏原型重构** – 外部模型的输出视为草稿，必须重构
3. **信任规则** – 后端以 {{BACKEND_PRIMARY}} 为准，前端以 {{FRONTEND_PRIMARY}} 为准
4. **最小变更** – 仅修改必要的代码，不引入副作用
5. **强制审计** – 变更后必须进行多模型 Code Review

---

## 使用方法

```bash
# 执行计划文件
/ccg:execute .claude/plan/功能名.md

# 直接执行任务（适用于已在上下文中讨论过的计划）
/ccg:execute 根据之前的计划实施用户认证功能
```

---

## 与 /ccg:plan 的关系

1. `/ccg:plan` 生成计划 + SESSION_ID
2. 用户确认 "Y" 后
3. `/ccg:execute` 读取计划，复用 SESSION_ID，执行实施
