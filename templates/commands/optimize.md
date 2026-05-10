---
description: '多模型性能优化：{{BACKEND_PRIMARY}} 后端优化 + {{FRONTEND_PRIMARY}} 前端优化'
argument-hint: "<优化目标> [--role=architect|critic|implementer|tester|writer]"
---

# Optimize - 多模型性能优化

双模型并行分析性能瓶颈，按性价比排序优化建议。

## 使用方法

```bash
/optimize <优化目标> [--role=<name>]
```

## Role-based routing（specialist matrix）

可选 `--role=<name>` 叠加 role 维度路由：

| Role × Layer  | architect      | critic              | implementer | tester        | writer          |
| ------------- | -------------- | ------------------- | ----------- | ------------- | --------------- |
| **backend**   | codex/architect.md | codex/reviewer.md (adversarial) | codex/architect.md | codex/tester.md | claude  |
| **frontend**  | gemini/architect.md | gemini/reviewer.md (adversarial) | gemini/architect.md | gemini/tester.md | gemini/analyzer.md |
| **fullstack** | codex+gemini/architect.md | both reviewer.md (adversarial) | runner 决 | runner 决 | claude |

**未传 --role 时按双模型并行（{{BACKEND_PRIMARY}}/{{FRONTEND_PRIMARY}} optimizer.md），完全兼容**。`--role=critic` 触发"性价比反对意见"——挑战通用优化套路（如盲目缓存 / over-engineering）。详见 `src/utils/specialist-router.ts`。

## 上下文

- 优化目标：$ARGUMENTS
- {{BACKEND_PRIMARY}} 专注后端性能（数据库、算法、缓存）
- {{FRONTEND_PRIMARY}} 专注前端性能（渲染、加载、交互）

## 你的角色

你是**性能工程师**，编排多模型优化流程：
- **{{BACKEND_PRIMARY}}** – 后端性能优化（**后端权威**）
- **{{FRONTEND_PRIMARY}}** – 前端性能优化（**前端权威**）
- **Claude (自己)** – 综合优化、实施变更

---

## 调用通道路由（CCG codeagent 退役）

CCG 把双模型并行通道从 `Bash(codeagent-wrapper)` **默认切换**为 plugin spawn：

1. **优先 plugin spawn**（默认）：装了 `codex@openai-codex` + `gemini@google-gemini` plugin → 用 `Agent(subagent_type="codex:codex-rescue")` + `Agent(subagent_type="gemini:gemini-rescue")` 并行，主线接 ≤200 token 摘要。
2. **降级 codeagent-wrapper**（BC fallback）：plugin 未装 → fallback 到 Bash 调用，行为与 plugin 路径等价。

**判定**：preflight `Bash` 跑 `ls ~/.claude/plugins/` 看有无 `codex@*` / `gemini@*` 子目录。helper 见 `src/utils/plugin-detection.ts`。

⚠️ Optimize 命令在主线 context 内，**允许** `Agent(...)`——与 subagent "禁止嵌套 spawn" 约束不冲突。

---

## 多模型调用规范

**工作目录**：
- `{{WORKDIR}}`：**必须通过 Bash 执行 `pwd`（Unix）或 `cd`（Windows CMD）获取当前工作目录的绝对路径**，禁止从 `$HOME` 或环境变量推断
- 如果用户通过 `/add-dir` 添加了多个工作区，先用 Glob/Grep 确定任务相关的工作区
- 如果无法确定，用 `AskUserQuestion` 询问用户选择目标工作区

**调用语法**（双通道）：

**通道 A — plugin spawn（默认）**：

```
Agent({
  subagent_type: "<codex:codex-rescue|gemini:gemini-rescue>",
  description: "Optimize: <backend|frontend>",
  prompt: `ROLE_FILE: <角色提示词路径>

<TASK>
需求：<增强后的需求（如未增强则用 $ARGUMENTS）>
上下文：<目标代码、现有性能指标等>
</TASK>

OUTPUT: 性能瓶颈列表、优化方案、预期收益
Return ≤200 token structured summary (plugin-native protocol).
`
})
```

并行**两个 Agent 在同一 message 内同时 spawn**。

**通道 B — codeagent-wrapper fallback**（plugin 未装时降级，并行用 `run_in_background: true`）：

```
Bash({
  command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend <{{BACKEND_PRIMARY}}|{{FRONTEND_PRIMARY}}> {{GEMINI_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'
ROLE_FILE: <角色提示词路径>
<TASK>
需求：<增强后的需求（如未增强则用 $ARGUMENTS）>
上下文：<目标代码、现有性能指标等>
</TASK>
OUTPUT: 性能瓶颈列表、优化方案、预期收益
EOF",
  run_in_background: true,
  timeout: 3600000,
  description: "简短描述"
})
```

> ⚠️ 通道 B `codeagent-wrapper` 已标 **deprecated**。

**角色提示词**：

| 模型 | 提示词 |
|------|--------|
| 后端 | `~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/optimizer.md` |
| 前端 | `~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/optimizer.md` |

**并行调用 + 事件驱动等待**：

1. 同 message 内 spawn 多个 `Bash(run_in_background: true)` 并行任务
2. spawn 完后主线说明已启动 task-id，**直接 turn end**，**不调 TaskOutput**
3. Claude Code 引擎在每个 task 完成时自动发 `<task-notification>` system-reminder 触发主线新 turn
4. 主线在新 turn 处理：从 `<output-file>` 路径 read stdout，按通道 schema parse 结果
5. **必须等所有相关 task 都收到通知**才进入下一阶段（按 task-id 计数已收齐）

⛔ **禁止**：
- 调 `TaskOutput({block: true, timeout: 600000})` —— 旧 freeze poll 模式，已废弃
- 收到部分通知就跳过等其他模型
- 主动 Kill task

⚠️ **失败处理**：notification status=failed / exit ≠ 0 / stdout < 100B / JSON parse 失败 → v1.7.87 标准 2-retry / 5s / 3-attempts；3 次全失败才降级单模型继续。

---

## 沟通守则

1. 在需要询问用户时，尽量使用 `AskUserQuestion` 工具进行交互，举例场景：请求用户确认/选择/批准

---

## 执行工作流

**优化目标**：$ARGUMENTS

### 🔍 阶段 0：Prompt 增强（可选）

`[模式：准备]` - **Prompt 增强**（按 `/ccg:enhance` 的逻辑执行）：分析 $ARGUMENTS 的意图、缺失信息、隐含假设，补全为结构化需求（明确目标、技术约束、范围边界、验收标准），**用增强结果替代原始 $ARGUMENTS，后续调用后端/前端模型 时传入增强后的需求**

### 🔍 阶段 1：性能基线

`[模式：研究]`

1. 调用 `{{MCP_SEARCH_TOOL}}` 检索目标代码（如可用）
2. 识别性能关键路径
3. 收集现有指标（如有）

### 🔬 阶段 2：并行性能分析

`[模式：分析]`

**⚠️ 必须发起两个并行 Bash 调用**（参照上方调用规范）：

1. **{{BACKEND_PRIMARY}} 后端分析**：`Bash({ command: "...--backend {{BACKEND_PRIMARY}}...", run_in_background: true })`
   - ROLE_FILE: `~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/optimizer.md`
   - 需求：分析后端性能问题（$ARGUMENTS）
   - OUTPUT：性能瓶颈列表、优化方案、预期收益

2. **{{FRONTEND_PRIMARY}} 前端分析**：`Bash({ command: "...--backend {{FRONTEND_PRIMARY}}...", run_in_background: true })`
   - ROLE_FILE: `~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/optimizer.md`
   - 需求：分析前端性能问题（Core Web Vitals）
   - OUTPUT：性能瓶颈列表、优化方案、预期收益

事件驱动等待：spawn 完两个 Bash bg 后主线 turn end，等 task-notification 自动唤醒。**必须等所有模型返回后才能进入下一阶段**。

**务必遵循上方 `多模型调用规范` 的 `重要` 指示**

### 🔀 阶段 3：优化整合

`[模式：计划]`

1. 收集双模型分析结果
2. **优先级排序**：按 `影响程度 × 实施难度⁻¹` 计算性价比
3. 请求用户确认优化方案

### ⚡ 阶段 4：实施优化

`[模式：执行]`

用户确认后按优先级实施，确保不破坏现有功能。

### ✅ 阶段 5：验证

`[模式：评审]`

运行测试验证功能，对比优化前后指标。

---

## 性能指标参考

| 类型 | 指标 | 良好 | 需优化 |
|------|------|------|--------|
| 后端 | API 响应 | <100ms | >500ms |
| 后端 | 数据库查询 | <50ms | >200ms |
| 前端 | LCP | <2.5s | >4s |
| 前端 | FID | <100ms | >300ms |
| 前端 | CLS | <0.1 | >0.25 |

## 常见优化模式

**后端**：N+1→批量加载、缺索引→复合索引、重复计算→缓存、同步→异步

**前端**：大 Bundle→代码分割、频繁重渲染→memo、大列表→虚拟滚动、未优化图片→WebP

---

## 关键规则

1. **先测量后优化** – 没有数据不盲目优化
2. **性价比优先** – 高影响 + 低难度优先
3. **不破坏功能** – 优化不能引入 bug
4. **信任规则** – 后端以 {{BACKEND_PRIMARY}} 为准，前端以 {{FRONTEND_PRIMARY}} 为准
