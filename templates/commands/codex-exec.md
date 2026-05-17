---
description: '{{BACKEND_PRIMARY}} 全权执行计划 - 读取 /ccg:plan 产出的计划文件，{{BACKEND_PRIMARY}} 承担 MCP 搜索 + 代码实现 + 测试，多模型审核'
---

# Codex-Exec - Codex 全权执行计划

$ARGUMENTS

---

## 核心理念

**与 `/ccg:plan` 配对使用**：

```
/ccg:plan → 多模型协同规划（Codex ∥ Gemini 分析 → Claude 综合）
                ↓ 计划文件 (.claude/plan/xxx.md)
/ccg:codex-exec → Codex 全权执行（MCP 搜索 + 代码实现 + 测试）
                ↓ 代码变更
                → 多模型审核（Codex ∥ Gemini 交叉审查）
```

**与 `/ccg:execute` 的区别**：

| 维度 | `/ccg:execute` | `/ccg:codex-exec` |
|------|---------------|-------------------|
| 代码实现 | Claude 重构 {{BACKEND_PRIMARY}}/{{FRONTEND_PRIMARY}} 的 Diff | **{{BACKEND_PRIMARY}} 直接实现** |
| MCP 搜索 | Claude 调用 MCP | **{{BACKEND_PRIMARY}} 调用 MCP** |
| Claude 上下文 | 高（搜索结果 + 代码全进来） | **极低（只看摘要 + diff）** |
| Claude token | 大量消耗 | **极少消耗** |
| 审核 | 多模型审查 | **多模型审查（不变）** |

---

## 语言协议

- 与工具/模型交互用 **英语**
- 与用户交互用 **中文**

---

## 多模型调用规范

**工作目录**：
- `{{WORKDIR}}`：**必须通过 Bash 执行 `pwd`（Unix）或 `cd`（Windows CMD）获取当前工作目录的绝对路径**，禁止从 `$HOME` 或环境变量推断
- 如果用户通过 `/add-dir` 添加了多个工作区，先用 Glob/Grep 确定任务相关的工作区
- 如果无法确定，用 `AskUserQuestion` 询问用户选择目标工作区

**调用通道路由（CCG codeagent 退役，v2.2.0+）**

1. **优先 plugin spawn**（默认）：plugin 已装 → `Agent(subagent_type="codex:codex-rescue")`，session 复用通过 prompt 内 `--resume` flag 表达（subagent 映射为 codex `--resume-last`）。
2. **降级 codeagent-wrapper**（BC fallback）：plugin 未装 → Bash 调用，保留 `resume <SESSION_ID>` 显式会话管理。

**判定**：preflight `Bash` 跑 `ls ~/.claude/plugins/` 看有无 `codex@*` / `gemini@*` 子目录。

**会话模型差异**：
- **通道 A（plugin）**：session 是同一 Claude session 内的最近 codex/gemini thread（`--resume-last`）。同任务多 phase 顺序执行 OK；不支持跨任务跳点 resume by ID。
- **通道 B（wrapper）**：显式 `SESSION_ID`，可跨流程任意复用历史 thread。

---

**{{BACKEND_PRIMARY}} 执行调用语法（通道 A 默认）**：

**预备动作**：spawn 前主线先 Read 角色提示词（如 `~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/architect.md`）拼入 `<role>` 块。

```
Agent({
  subagent_type: "codex:codex-rescue",
  description: "简短描述",
  prompt: `<role>
${implementerRole}
</role>

<workdir>{{WORKDIR}}</workdir>

<task>
<指令内容>
</task>

<action_safety>
- Stay strictly within the plan scope
- Run lint/typecheck if available before reporting completion
</action_safety>`
})
```

**{{BACKEND_PRIMARY}} 复用会话调用（通道 A，--resume）**：在 prompt 第一行加 `--resume`（subagent 提取为 routing flag 映射 codex `--resume-last`，不写入 task text）：

```
Agent({
  subagent_type: "codex:codex-rescue",
  description: "简短描述",
  prompt: `--resume

<task>
<指令内容（仅 delta，不重述完整 plan）>
</task>`
})
```

**通道 B — wrapper BC fallback**（plugin 未装时）：

```
# 新会话（保留 SESSION_ID）
Bash({
  command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend {{BACKEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EXEC_EOF'\n<TASK>\n<指令内容>\n</TASK>\nEXEC_EOF",
  run_in_background: true,
  timeout: 3600000,
  description: "简短描述 (BC)"
})

# 复用会话
Bash({
  command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend {{BACKEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}resume <SESSION_ID> - \"{{WORKDIR}}\" <<'EXEC_EOF'\n<TASK>\n<指令内容>\n</TASK>\nEXEC_EOF",
  run_in_background: true,
  timeout: 3600000,
  description: "简短描述 (BC, resume)"
})
```

**审核调用（通道 A，双模型并行）**：参照 `/ccg:spec-review` 的 Step 3.1 pattern——`Agent(codex:codex-rescue)` + `Agent(gemini:gemini-rescue)` 同 message 并行，预读 `reviewer.md` 拼入 `<role>` 块。通道 B 同 `<<'REVIEW_EOF'... wrapper` 模式（已 deprecated）。

**角色提示词**：

| 阶段 | 后端 | 前端 |
|------|-------|--------|
| 审查 | `~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/reviewer.md` | `~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/reviewer.md` |

**事件驱动等待**：spawn 后主线说明 task-id 然后 **turn end**，引擎自动 `<task-notification>` 触发新 turn 处理结果。**不调 TaskOutput**。

⛔ **禁止**：调 `TaskOutput({block: true, timeout: 600000})` 旧 freeze poll 模式 / Kill task。

⚠️ **失败处理**：notification status=failed / exit ≠ 0 / parse 失败 → v1.7.87 标准 2-retry / 5s / 3-attempts；3 次全失败才降级单模型。

---

## 执行工作流

**执行任务**：$ARGUMENTS

### 📖 Phase 0：读取计划

`[模式：准备]`

1. **识别输入类型**：
   - 计划文件路径（如 `.claude/plan/xxx.md`）→ 读取并解析
   - 直接的任务描述 → 提示用户先执行 `/ccg:plan`

2. **解析计划内容**，提取：
   - 任务类型（前端/后端/全栈）
   - 技术方案
   - 实施步骤
   - 关键文件列表
   - SESSION_ID（`CODEX_SESSION` / `GEMINI_SESSION`）

3. **执行前确认**：
   向用户展示计划摘要，确认后执行：

   ```markdown
   ## 即将执行

   **任务**：<计划标题>
   **模式**：Codex 全权执行
   **步骤**：<N 步>
   **关键文件**：<N 个>

   Codex 将自主完成：MCP 搜索 + 代码实现 + 测试验证
   Claude 仅做最终审核

   确认执行？(Y/N)
   ```

---

### ⚡ Phase 1：Codex 全权执行

`[模式：执行]`

**将计划转化为 Codex 结构化指令，一次性下发**。按顶部「调用通道路由」选 A 或 B：

**通道 A — plugin spawn（默认）**：

```
Agent({
  subagent_type: "codex:codex-rescue",
  description: "Codex 全权执行：<计划标题>",
  prompt: `${codexSessionExists ? '--resume\n' : ''}<role>
${implementerRole}  // 主线预读 ~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/architect.md
</role>

<workdir>{{WORKDIR}}</workdir>

<task>
You are a full-stack execution agent. Implement the following plan end-to-end.

## Implementation Plan
<将 Phase 0 解析出的完整计划内容粘贴于此>

## Your Instructions

### Step 1: Context Verification
Before coding, verify you have sufficient context:
- Use ace-tool MCP (search_context) to search for relevant existing code patterns
- Read the key files listed in the plan to understand current implementation
- If the plan references external libraries/APIs, use context7 MCP to query their latest documentation
- If latest information is needed, use grok-search MCP for web search

### Step 2: Implementation
Implement each step from the plan in order:
<将计划的实施步骤逐条列出>

### Step 3: Self-Verification
After implementation:
- Run lint/typecheck if available
- Run existing tests: <从计划中提取测试命令>
- Verify no regressions in touched modules
</task>

<action_safety>
- Follow existing code conventions in this project
- Handle edge cases and errors properly
- Keep changes minimal and focused on the plan
- Do NOT modify files outside the plan's scope
</action_safety>

<structured_output_contract>
Respond with this structured report:

### CONTEXT_GATHERED
<What information was searched/found, key findings from MCP tools>

### CHANGES_MADE
For each file changed: file path / what changed / why / lines added-removed

### VERIFICATION_RESULTS
- Lint/typecheck: pass/fail
- Tests: pass/fail (details if fail)

### REMAINING_ISSUES
<Any unresolved issues>
</structured_output_contract>`
})
```

**📌 同 Claude session 内后续 Phase 2.5（修正）会自动通过 `--resume` 接到 codex 的 last thread**（plugin 路径无显式 SESSION_ID）。

**通道 B — wrapper BC fallback**：

```
Bash({
  command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend {{BACKEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}resume <CODEX_SESSION> - \"{{WORKDIR}}\" <<'EXEC_EOF'\n<TASK>\nYou are a full-stack execution agent. Implement the following plan end-to-end.\n\n## Implementation Plan\n<完整计划>\n\n## Output Format\n<同上结构化报告>\n</TASK>\nEXEC_EOF",
  run_in_background: true,
  timeout: 3600000,
  description: "Codex 全权执行：<计划标题> (BC)"
})
```

**📌 记录 SESSION_ID**（`CODEX_EXEC_SESSION`）供 Phase 2.5 显式 resume。

事件驱动等待：spawn 完后主线 turn end，等 task-notification 自动唤醒。

---

### 🔍 Phase 2：Claude 轻量审核

`[模式：审核]`

**Claude 只做最小验证，不重复 Codex 已做的工作**：

1. **读取 Codex 报告**：解析 CONTEXT_GATHERED / CHANGES_MADE / VERIFICATION_RESULTS / REMAINING_ISSUES
2. **查看实际变更**：

   ```
   Bash({ command: "git diff HEAD", description: "查看 Codex 实际变更" })
   ```

3. **快速判定**：
   - 变更是否在计划范围内？
   - 是否有明显安全/逻辑问题？
   - 测试是否通过？

4. **处理结果**：
   - ✅ **通过** → Phase 3 多模型审核
   - ⚠️ **小问题** → Claude 直接修复（< 10 行的修正 Claude 自己做）
   - ❌ **需返工** → Phase 2.5 追加指令

---

### 🔄 Phase 2.5：追加指令（仅在需返工时）

`[模式：追加]`

**复用 Codex 会话，下发修正指令**。按顶部「调用通道路由」选 A 或 B：

**通道 A — plugin spawn（默认，--resume）**：

```
Agent({
  subagent_type: "codex:codex-rescue",
  description: "Codex 修正：<问题简述>",
  prompt: `--resume

<task>
The implementation needs corrections:

## Issues Found
1. <问题描述 + 具体文件:行号>
2. <问题描述 + 具体文件:行号>

## Required Fixes
1. <具体修正要求>
2. <具体修正要求>

Apply fixes and re-run tests. Report results in the same format as Phase 1.
</task>`
})
```

**通道 B — wrapper BC fallback**：

```
Bash({
  command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend {{BACKEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}resume <CODEX_EXEC_SESSION> - \"{{WORKDIR}}\" <<'FIXEOF'\n<TASK>\nThe implementation needs corrections:\n\n## Issues Found\n1. ...\n\n## Required Fixes\n1. ...\n\nApply fixes and re-run tests. Report results in the same format.\n</TASK>\nFIXEOF",
  run_in_background: true,
  timeout: 3600000,
  description: "Codex 修正：<问题简述> (BC)"
})
```

等待完成后回到 Phase 2。**最多 2 轮返工**，超过则 Claude 直接接管修复。

---

### ✅ Phase 3：多模型审核

`[模式：审核]`

**并行调用 {{BACKEND_PRIMARY}} + {{FRONTEND_PRIMARY}} 交叉审查**（多模型协同不变）：

1. **获取变更 diff**：

   ```
   Bash({ command: "git diff HEAD", description: "获取完整变更 diff" })
   ```

2. **并行调用**（`run_in_background: true`）：

   - **{{BACKEND_PRIMARY}} 审查**：
     - ROLE_FILE: `~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/reviewer.md`
     - 输入：变更 Diff + 计划文件内容
     - 关注：安全性、性能、错误处理、逻辑正确性

   - **{{FRONTEND_PRIMARY}} 审查**：
     - ROLE_FILE: `~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/reviewer.md`
     - 输入：变更 Diff + 计划文件内容
     - 关注：代码可读性、设计一致性、可维护性

   用 `TaskOutput` 等待两个模型的完整审查结果。

3. **整合审查意见**：
   - 按信任规则：后端问题以 {{BACKEND_PRIMARY}} 为准，前端问题以 {{FRONTEND_PRIMARY}} 为准
   - **Critical** → 必须修复（Claude 直接修或再派 Codex）
   - **Warning** → 建议修复，报告给用户决定
   - **Info** → 记录不处理

4. **执行修复**（如有 Critical）：
   - < 10 行修正：Claude 直接修
   - ≥ 10 行修正：再派 Codex（复用 `CODEX_EXEC_SESSION`）
   - 修复后可选重复 Phase 3（直到风险可接受）

---

### 📦 Phase 4：交付

`[模式：交付]`

向用户报告：

```markdown
## ✅ 执行完成

### 执行摘要
| 项目 | 详情 |
|------|------|
| 计划 | <计划文件路径> |
| 模式 | Codex 全权执行 + 多模型审核 |
| 搜索 | <Codex 使用了哪些 MCP 工具，关键发现> |
| 变更 | <N 个文件，+X/-Y 行> |
| 测试 | <通过/失败> |
| 返工 | <0/1/2 轮> |

### 变更清单
| 文件 | 操作 | 说明 |
|------|------|------|
| path/to/file.ts | 修改/新增 | 描述 |

### 审核结果
- Codex 审查：<通过/发现 N 个问题>
- Gemini 审查：<通过/发现 N 个问题>
- Claude 处理：<已修复 N 个 Critical，N 个 Warning 待用户决定>

### 后续建议
1. [ ] <建议的测试步骤>
2. [ ] <建议的验证步骤>
```

---

## 关键规则

1. **Claude 极简原则** — Claude 不调用 MCP、不做代码检索。只读计划、指挥 Codex、审核结果。
2. **{{BACKEND_PRIMARY}} 全权执行** — MCP 搜索、文档查询、代码检索、实现、测试全由 {{BACKEND_PRIMARY}} 完成。
3. **多模型审核不变** — 审核阶段仍然 Codex ∥ Gemini 交叉审查，保证质量。
4. **信任规则** — 后端以 {{BACKEND_PRIMARY}} 为准，前端以 {{FRONTEND_PRIMARY}} 为准。
5. **一次性下发** — 尽量一次给 Codex 完整指令 + 完整计划，减少来回通信。
6. **最多 2 轮返工** — 超过 2 轮 Claude 直接接管，避免无限循环。
7. **计划对齐** — Codex 实现必须在计划范围内，超出范围的变更视为违规。

---

## 使用方法

```bash
# 标准流程：先规划，再执行
/ccg:plan 实现用户认证功能
# 审查计划后...
/ccg:codex-exec .claude/plan/user-auth.md

# 直接执行（会提示先 /ccg:plan）
/ccg:codex-exec 实现用户认证功能
```

---

## 与 /ccg:plan 的关系

```
/ccg:plan ──→ .claude/plan/xxx.md
                    │
          ┌─────────┴─────────┐
          ↓                   ↓
   /ccg:execute        /ccg:codex-exec
   (Claude 重构)       (Codex 全权)
   Claude 高消耗       Claude 极低消耗
   精细控制             高效执行
```

用户可根据任务特点选择：
- **需要精细控制** → `/ccg:execute`（Claude 逐行重构）
- **需要高效执行** → `/ccg:codex-exec`（Codex 一把梭）
