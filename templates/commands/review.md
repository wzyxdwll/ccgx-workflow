---
description: '多模型代码审查：无参数时自动审查 git diff，双模型交叉验证；--adversarial 加敌对审查；--fix 闭环修复'
argument-hint: "[代码或描述] [--adversarial] [--fix [--all] [--auto]] [--role=architect|critic|implementer|tester|writer]"
---

# Review - 多模型代码审查

## Role-based routing（v4.1 specialist matrix）

可选 `--role=<name>` 叠加 role 维度路由：

| Role × Layer  | architect      | critic              | implementer | tester        | writer          |
| ------------- | -------------- | ------------------- | ----------- | ------------- | --------------- |
| **backend**   | codex/architect.md | codex/reviewer.md (adversarial) | codex/architect.md | codex/tester.md | claude（主线）  |
| **frontend**  | gemini/architect.md | gemini/reviewer.md (adversarial) | gemini/architect.md | gemini/tester.md | gemini/analyzer.md |
| **fullstack** | codex+gemini/architect.md | both reviewer.md (adversarial) | runner 决 | runner 决 | claude |

**未传 --role 时按 v4.0 双模型路由（{{BACKEND_PRIMARY}}/{{FRONTEND_PRIMARY}} reviewer.md）**——完全兼容现有 `--adversarial` / `--fix` 行为。`--role=critic` 等价于隐式 `--adversarial`（语义同义）。详见 `src/utils/specialist-router.ts`。

---

双模型并行审查，交叉验证综合反馈。无参数时自动审查当前 git 变更。

**v4.1 Phase 20**：双模型并行通道从 `Bash(codeagent-wrapper)` **默认切换**为 plugin spawn —— 装了 `codex@openai-codex` + `gemini@google-gemini` plugin → 用 `Agent(subagent_type="codex:codex-rescue")` + `Agent(subagent_type="gemini:gemini-rescue")` 并行，主线只接 ≤200 token 摘要；plugin 未装 → fallback 到 codeagent-wrapper 路径（v4.0 BC，将在 v5.0 移除）。preflight 用 `Bash` 跑 `ls ~/.claude/plugins/` 检测，helper 见 `src/utils/plugin-detection.ts`。

`--adversarial` 模式下额外触发第三层"敌对视角"审查，由官方 codex plugin 的 `Agent(codex:codex-rescue)` 在 fresh context 中专门挑前两轮意见的漏洞，适合极重要 PR / 安全敏感变更。需用户已装 `codex@openai-codex` plugin，否则降级为双模型审查。

`--fix` 模式下额外触发**闭环修复**：审查产出 REVIEW.md 后 spawn `code-fixer` subagent 在 git worktree 隔离环境内修复 finding，原子 commit 后透明 ff-only merge 回主分支。

## 使用方法

```bash
/review [代码或描述] [--adversarial] [--fix [--all] [--auto]]
```

- **无参数**：自动审查 `git diff HEAD`
- **有参数**：审查指定代码或描述
- **`--adversarial`**：双模型审查后追加 fresh-context 敌对审查（用 `Agent(subagent_type="codex:codex-rescue")` + `--adversarial-review`），主线 token 不被吃，3-5 分钟额外时间换更深的反向意见
- **`--fix`**：审查后 spawn `code-fixer` 修复 Critical + Warning 级 finding，worktree 隔离 + 3 层 verification + 原子 commit
- **`--fix --all`**：同上但纳入 Info 级 finding（默认不修 Info，避免噪音）
- **`--fix --auto`**：fix → re-review → fix 多轮收敛环，**上限 3 轮**（CCG 硬规约）。3 轮未收敛升级用户介入

---

## 多模型调用规范

**工作目录**：
- `{{WORKDIR}}`：**必须通过 Bash 执行 `pwd`（Unix）或 `cd`（Windows CMD）获取当前工作目录的绝对路径**，禁止从 `$HOME` 或环境变量推断
- 如果用户通过 `/add-dir` 添加了多个工作区，先用 Glob/Grep 确定任务相关的工作区
- 如果无法确定，用 `AskUserQuestion` 询问用户选择目标工作区

**调用语法**（v4.4.2 起 review/verify 路径默认走 Bash 直调）：

**通道 A — Bash 直调 plugin script（默认，绕开 sonnet wrapper）**：

> 1.0.4 起 Bash 命令字符串由 install 时直接渲染（基于 `~/.claude/plugins/installed_plugins.json`
> 真值源），LLM 只需 copy 整段 + 替换 `%PROMPT%` 即可。**禁止凭印象拼 `node "$(ls ...) | head -1"
> task -p ...` inline 命令** —— glob hack 在 plugin 多版本 cache 下行为不可预测，且参数漂移
> 与 v4.4.1 的 195 处错名 bug 同型。

```
# 后端审查（codex 视角）
Bash({
  command: `{{CODEX_BASH_TASK}}`,   ← install 时已渲染为完整命令，含 heredoc 安全 prompt 注入
  description: "Review: backend (codex direct)",
  run_in_background: true,
  timeout: 3600000
})

# 前端审查（gemini 视角）
Bash({
  command: `{{GEMINI_BASH_TASK}}`,
  description: "Review: frontend (gemini direct)",
  run_in_background: true,
  timeout: 3600000
})
```

LLM 消费协议：把上面命令字符串里的 `%PROMPT%` 替换为完整 prompt 文本（含 ROLE_FILE 引用 +
TASK 描述 + OUTPUT 要求），**不要在外面加任何 escape**——heredoc `<<'CCG_PROMPT_EOF'`
的单引号 delimiter 已保证 `$` / `'` / `"` / `\` 全部按字面量处理。

⛔ **不要**用 `Agent(subagent_type="codex:codex-rescue"|"gemini:gemini-rescue")`：

review/verify 路径输出**直接落地**决策（PR merge / advance / revise / escalate），无下游兜底。
plugin 经由 `Agent(...)` spawn 时引擎启动 sonnet wrapper 扮演 codex/gemini 客户端，broker 故障 /
CLI 空答 / auth 过期时 wrapper 受 instruction-tuning 驱动**自答 fabricated cross-vendor 视角**
（silent fallback），主线无法察觉。Bash 直调消除 wrapper 层，stdout 即真实 plugin 输出。

详见 `src/utils/verify-orchestrator.ts:planVerifyWave` 的 `useDirectBashInvocation` 选项 +
`src/utils/plugin-bash-codegen.ts`（1.0.4 install-time codegen）。

主线接 stdout JSON（5-50KB），按 plugin --json schema 解析 `result.text` 字段，失败信号：
- exit code ≠ 0 → loud fail，触发 v1.7.87 标准 2-retry / 5s / 3-attempts 规则
- stdout 空 / 字节 < 100 → 同上视为失败

并行**两个 Bash 在同一 message 内 `run_in_background: true` 同时 spawn**。

**通道 B — codeagent-wrapper fallback**（plugin 未装时降级，并行用 `run_in_background: true`）：

```
Bash({
  command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend <{{BACKEND_PRIMARY}}|{{FRONTEND_PRIMARY}}> {{GEMINI_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'
ROLE_FILE: <角色提示词路径>
<TASK>
审查以下代码变更：
<git diff 内容>
</TASK>
OUTPUT: 按 Critical/Major/Minor/Suggestion 分类列出问题
EOF",
  run_in_background: true,
  timeout: 3600000,
  description: "简短描述"
})
```

> ⚠️ 通道 B `codeagent-wrapper` 在 v4.1 已标 **deprecated**，将在 v5.0 移除。

**角色提示词**：

| 模型 | 提示词 |
|------|--------|
| 后端 | `~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/reviewer.md` |
| 前端 | `~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/reviewer.md` |

**并行调用 + 事件驱动等待（v4.5.2 起）**：

1. 在同一 message 内 spawn 两个（或多个）`Bash(run_in_background: true)` 并行任务
2. spawn 完成后主线说明已启动哪些 task（含 task-id），然后**直接 turn end**，**不调 TaskOutput**
3. Claude Code 引擎在每个 background task 完成时自动发 `<task-notification>` system-reminder 触发主线新 turn
4. 主线在收到通知的新 turn 处理：
   - 从 notification `<task-id>` 定位是哪个任务
   - 从 `<output-file>` 路径 read stdout（plugin --json 输出 5-50KB）
   - JSON parse `result.text` 字段（plugin 通道）/ `--progress` 行（codeagent-wrapper 通道）
5. **必须等所有相关 task 都收到通知**才进入下一阶段（主线按 task-id 计数已收齐）

⛔ **禁止做**：
- 调 `TaskOutput({block: true, timeout: 600000})` —— 这会 freeze 主线 10 分钟，且超时后还要轮询，体验极差（v4.5.1 之前的旧模式，已废弃）
- 收到部分通知就跳过等其他模型
- 主动 Kill task

⚠️ **失败处理**：
- notification `status: failed` / exit code ≠ 0 / stdout < 100 字节 / JSON parse 失败 → 视为失败
- v1.7.87 标准 2-retry / 5s / 3-attempts 规则
- 3 次全失败才考虑降级到单模型继续

---

## 执行工作流

### 🔍 阶段 1：获取待审查代码

`[模式：研究]`

**无参数时**：执行 `git diff HEAD` 和 `git status --short`

**有参数时**：使用指定的代码/描述

调用 `{{MCP_SEARCH_TOOL}}` 获取相关上下文。

### 🔬 阶段 2：并行审查

`[模式：审查]`

**⚠️ 必须发起两个并行 Bash 调用**（参照上方调用规范）：

1. **{{BACKEND_PRIMARY}} 后端审查**：`Bash({ command: "...--backend {{BACKEND_PRIMARY}}...", run_in_background: true })`
   - ROLE_FILE: `~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/reviewer.md`
   - 需求：审查代码变更（git diff 内容）
   - OUTPUT：按 Critical/Major/Minor/Suggestion 分类列出安全性、性能、错误处理问题

2. **{{FRONTEND_PRIMARY}} 前端审查**：`Bash({ command: "...--backend {{FRONTEND_PRIMARY}}...", run_in_background: true })`
   - ROLE_FILE: `~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/reviewer.md`
   - 需求：审查代码变更（git diff 内容）
   - OUTPUT：按 Critical/Major/Minor/Suggestion 分类列出可访问性、响应式、设计一致性问题

**事件驱动等待**：spawn 完两个 Bash bg 后主线 turn end，等 task-notification 自动唤醒。两个 task 都收到通知后进阶段 3。

**务必遵循上方 `多模型调用规范` 的 `重要` 指示**

### 🛡 阶段 2.5：敌对审查（仅 `--adversarial`）

`[模式：敌对]`

**仅当 `$ARGUMENTS` 含 `--adversarial` 字面量时启动**。否则跳过本阶段。

调用方式（Bash 直调，绕开 sonnet wrapper）：

```
Bash({
  command: `{{CODEX_BASH_TASK}}`,   ← 同上，install 时渲染为完整命令
  description: "Adversarial review (codex direct)",
  run_in_background: true,
  timeout: 3600000
})
```

把命令里的 `%PROMPT%` 替换为以下完整 prompt 文本（heredoc 已保证字面量传递，不需要 escape）：

```
--adversarial-review

请对以下代码变更进行敌对视角审查：

<git diff 内容（与阶段 2 同输入）>

已有的前两轮审查意见（仅供你判断哪些被低估，不要重复结论）：

<阶段 2 后端审查结果摘要>

<阶段 2 前端审查结果摘要>

你的任务：
1. 找出前两轮**未发现或低估**的安全/性能/正确性漏洞
2. 假设代码作者刻意误导，挑刺
3. 输出格式：[Critical-Adversarial] / [Major-Adversarial] 列表，每条标"为什么前两轮没发现"
```

⛔ 不用 `Agent(subagent_type="codex:codex-rescue")`：review/verify 路径输出直接落地，silent fallback
风险（sonnet wrapper 受 instruction-tuning 自答冒充 adversarial 视角）不可接受。详见前文「通道 A」段。

收到 stdout JSON 后解析 `result.text` 字段保留待阶段 3 综合。stdout 空或 exit≠0 → 走标准 2-retry 规则。

**降级**：若 `codex:codex-rescue` 不可用（用户没装 `codex@openai-codex` plugin），输出"⚠️ 跳过敌对审查，未检测到 codex plugin"并继续阶段 3，不阻塞流程。

### 🔀 阶段 3：综合反馈

`[模式：综合]`

1. 收集**所有**审查结果（双模型 + 可选的敌对审查）
2. 按严重程度分类：Critical / Major / Minor / Suggestion
3. 去重合并 + 交叉验证
4. **敌对审查标识**：来自阶段 2.5 的 finding 在最终报告中带 🛡 标记，并保留"前两轮没发现"的原因说明（这是用户判断敌对审查 ROI 的依据）

### 📊 阶段 4：呈现审查结果

`[模式：总结]`

```markdown
## 📋 代码审查报告

### 审查范围
- 变更文件：<数量> | 代码行数：+X / -Y
- 审查模式：双模型 / 双模型 + 🛡 敌对审查

### 关键问题 (Critical)
> 必须修复才能合并
1. <问题描述> - [后端/前端模型]
2. 🛡 <问题描述> - [敌对审查] · 前两轮未发现：<原因>

### 主要问题 (Major) / 次要问题 (Minor) / 建议 (Suggestions)
...

### 总体评价
- 代码质量：[优秀/良好/需改进]
- 是否可合并：[是/否/需修复后]
- 敌对审查 ROI：[N 个新发现 / 0 个新发现，下次可省略] (仅 --adversarial 模式)
```

---

## 关键规则

1. **无参数 = 审查 git diff** – 自动获取当前变更
2. **双模型交叉验证** – 后端问题以 {{BACKEND_PRIMARY}} 为准，前端问题以 {{FRONTEND_PRIMARY}} 为准
3. 外部模型对文件系统**零写入权限**

---

## 🔧 阶段 5：闭环修复（仅 `--fix` / `--fix --all` / `--fix --auto`）

`[模式：修复]`

**仅当 `$ARGUMENTS` 含 `--fix` 字面量时启动**。否则跳过本阶段。

### 5.1 启动恢复扫描

在创建新 worktree **前**：

```bash
# 检查上次 review-fix 是否被中断（OOM / 重启 / Ctrl-C）
cat .context/review-fix-recovery-pending.json 2>/dev/null
```

存在 → 上一次跑被中断。`AskUserQuestion`：复用 / 强制清理。

### 5.2 持久化 REVIEW.md

把阶段 4 的综合审查结果写到 `.context/review-{timestamp}/REVIEW.md`（path 由 code-fixer 通过参数接收），格式：

```markdown
## Findings

| ID | Severity | File | Line | Description | Suggested Fix |
|----|----------|------|------|-------------|---------------|
| C-01 | Critical | src/auth.ts | 42 | SQL identifier not escaped | use parameterized query |
| W-02 | Warning | src/api.ts | 88 | missing error boundary | wrap in try/catch |
| ...
```

`--fix --all` 模式下额外含 Info 级 finding。

### 5.3 Spawn code-fixer subagent

```
Agent({
  subagent_type: "code-fixer",
  description: "Closed-loop review fix",
  prompt: `请按以下契约执行闭环修复：

review_md_path: <REVIEW.md 路径>
phase_id: <padded phase 号，例 "10"，没有 phase 上下文则用 "00">
base_sha: <当前 HEAD 的 sha>
current_branch: <当前分支名>
workdir: <项目绝对路径>
fix_scope: critical_warning | all | auto
auto_round: <仅 --auto 模式，当前轮次 1-indexed>

工程契约见 templates/commands/agents/code-fixer.md：
- 强制 git worktree 隔离 + recovery sentinel
- 4 步严格顺序 transactional cleanup tail
- per-finding rollback 用 git checkout（不用 Write 工具）
- 3 层 verification Tier
- 每 finding 原子 commit
`
})
```

**code-fixer 完成后产出**：`REVIEW-FIX.md`（同目录），含 per-finding outcome + cleanup tail 状态。

### 5.4 多轮收敛（仅 `--fix --auto`）

`--auto` 模式下，code-fixer 第 1 轮跑完后：

1. Read REVIEW-FIX.md，提取本轮 finding 数（critical / warning / info）
2. 调用收敛判定（参考 `src/utils/code-fixer-worktree.ts:decideConverge`）：
   - `converged`（critical+warning=0）→ 完成，输出收敛报告
   - `escalate`（达到 3 轮 cap 或 stall）→ `AskUserQuestion`："继续手动修 / 接受现状 / 回滚全部"
   - `continue` → 重跑阶段 1-4 生成新 REVIEW.md，再 spawn code-fixer，`auto_round` +1

**3 轮上限是 CCG 硬规约**（与 plan-checker / verify-work 一致），**禁止**绕过。

### 5.5 闭环修复总结

```markdown
## 🔧 闭环修复总结

- 修复模式：`--fix` / `--fix --all` / `--fix --auto`
- 修复轮次：<N> / 3
- Findings 处理：<M>（Critical: <a> / Warning: <b> / Info: <c>）
- Atomic commits: <K>
- Worktree cleanup: ok / partial（merge 失败保留 worktree 待人工）
- 需人工核实的逻辑修复：<L> 项（标记 `requires human verification`）
```

### 关键安全约束

⚠️ **以下违反任意一条 = 工程事故**：

- worktree 创建 **必须** 在写 sentinel 之前
- cleanup tail 4 步**必须**严格按 `merge_ff_only → worktree_remove → branch_delete → sentinel_remove` 顺序
- 任何步骤失败**必须**立即停（不继续后续步骤）
- per-finding rollback **必须**用 `git checkout --`，**禁止**用 Write 工具
- `--auto` 收敛轮次**必须** ≤ 3
