---
description: '多模型代码审查：无参数时自动审查 git diff，双模型交叉验证；--adversarial 加敌对审查；--fix 闭环修复'
argument-hint: "[代码或描述] [--adversarial] [--fix [--all] [--auto]] [--role=architect|critic|implementer|tester|writer]"
---

# Review - 多模型代码审查

## Role-based routing（specialist matrix）

可选 `--role=<name>` 叠加 role 维度路由：

| Role × Layer  | architect      | critic              | implementer | tester        | writer          |
| ------------- | -------------- | ------------------- | ----------- | ------------- | --------------- |
| **backend**   | codex/architect.md | codex/reviewer.md (adversarial) | codex/architect.md | codex/tester.md | claude（主线）  |
| **frontend**  | gemini/architect.md | gemini/reviewer.md (adversarial) | gemini/architect.md | gemini/tester.md | gemini/analyzer.md |
| **fullstack** | codex+gemini/architect.md | both reviewer.md (adversarial) | runner 决 | runner 决 | claude |

**未传 --role 时按双模型路由（{{BACKEND_PRIMARY}}/{{FRONTEND_PRIMARY}} reviewer.md）**——完全兼容现有 `--adversarial` / `--fix` 行为。`--role=critic` 等价于隐式 `--adversarial`（语义同义）。详见 `src/utils/specialist-router.ts`。

---

双模型并行审查，交叉验证综合反馈。无参数时自动审查当前 git 变更。

**双模型并行通道**：默认走 plugin spawn —— 装了 `codex@openai-codex` + gemini plugin（推荐 `gemini@gemini-ccgx` fork，含 P-1..P-21 + W1/W2/I1 patch；或上游 `gemini@google-gemini` 配 repatch 脚本）→ 用 `Agent(subagent_type="codex:codex-rescue")` + `Agent(subagent_type="gemini:gemini-rescue")` 并行，主线只接 ≤200 token 摘要；plugin 未装 → fallback 到 codeagent-wrapper 路径（BC fallback）。preflight 用 `Bash` 跑 `ls ~/.claude/plugins/` 检测，helper 见 `src/utils/plugin-detection.ts`。

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

**调用语法**（review/verify 路径默认走 Bash 直调）：

**通道 A — Bash 直调 plugin script（默认，绕开 sonnet wrapper）**：

> 占位符 `{{CODEX_BASH_TASK}}` / `{{GEMINI_BASH_TASK}}` 由 install 时渲染为
> `node <ccgx-call-plugin.mjs 绝对路径> <vendor> --json`。LLM **只需把 prompt
> 写入 tmpfile、追加 `--prompt-file <tmpfile>`、运行**。helper 内部处理路径解析、
> spawn array args、shell escape 全部规避——LLM 不参与任何命令构造。

**核心原则（1.0.6 起）**：**主线不传输 diff 内容给 codex/gemini**。把 diff 作为 prompt body 内嵌会撞 OS argv ~32KB 上限（Windows `CreateProcess` / POSIX `execve`）；30KB+ diff 直接 spawn 失败。**正确做法是给 codex/gemini 一个小任务描述**，让它们用自己的 Bash + Read 工具**自己跑 `git diff` 读源文件**——它们在 task mode 下有完整工具权限。

**LLM 工作流（严格 3 步）**：

```
Step 1. 用 Write 工具把【小任务描述】写到 tmpfile
   ⚠️ 内容必须是任务说明（≤ 2KB），不要塞 git diff / 文件内容
   Write({
     file_path: "/tmp/ccg-review-codex-$JOB.txt",
     content: <下方"任务描述模板">  
   })
   Write({ 同上，gemini 版本 })

Step 2. 用 Bash 调 helper（占位符已渲染）：
   Bash({
     command: `{{CODEX_BASH_TASK}} --prompt-file /tmp/ccg-review-codex-$JOB.txt`,
     description: "Review: backend (codex direct)",
     run_in_background: true,
     timeout: 3600000
   })
   Bash({
     command: `{{GEMINI_BASH_TASK}} --prompt-file /tmp/ccg-review-gemini-$JOB.txt`,
     description: "Review: frontend (gemini direct)",
     run_in_background: true,
     timeout: 3600000
   })

Step 3. 等 task-notification 通知后 Read 各自 stdout（helper 输出 JSON），
   parse `result.stdout` 拿 plugin 真实输出。
```

**任务描述模板**（写到 tmpfile 的内容；保持 ≤ 2KB）：

```
# 任务：代码审查

工作目录：<工作目录绝对路径>（你已经在这里，可直接用 Bash/Read）
角色：参考 <角色提示词文件路径>（主线写入：codex 用 ~/.claude/.ccg/prompts/codex/reviewer.md，gemini 用 gemini/reviewer.md）

## 你要做的事（用你自己的工具）

1. 跑 `git diff HEAD --stat` 看变更规模
2. 跑 `git diff HEAD` 看完整 diff 内容（如太大，逐文件 `git diff HEAD <file>`）
3. 涉及具体逻辑判断时 Read 相关源文件（看 import / 类型签名 / 调用上下文）
4. 按角色视角审查：
   - codex (backend)：算法 / 数据流 / 错误处理 / 安全 / 测试覆盖
   - gemini (frontend)：组件结构 / 视觉一致性 / 响应式 / 可访问性
5. **额外硬规则**（如有，主线在此追加，每条 ≤ 200 字）

## 输出 JSON 格式（严格）

{
  "critical": [{file, line, issue, why, fix?}, ...],
  "major":    [...],
  "minor":    [...],
  "suggestions": [...]
}

只输出 JSON，无其他文本。空类别输出 []。
```

⛔ **严禁**：
- 不要在 prompt 里塞 git diff 内容（撞 ARG_MAX）
- 不要塞文件源代码（同上）
- 不要写 `node "$(ls ...)/codex-companion.mjs"`、不要 heredoc、不要 `-p "..."` 内联
- 不要硬编码 plugin 路径——helper 内部解析 SSoT
- **唯一允许**：copy 占位符内容 + 追加 `--prompt-file <tmpfile>`，tmpfile 只放任务描述

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

**通道 B — codeagent-wrapper fallback**（plugin 未装时降级；wrapper 走 stdin pipe，无 ARG_MAX 限制）：

通道 B 同样**遵循"不塞 diff"原则**——给 wrapper 传任务描述，让 backend codex/gemini CLI 自己跑 git diff 读源文件。wrapper 经 stdin 传 prompt（无 32KB 限制），但 prompt 内容应当还是任务描述而非 diff dump。

```
Bash({
  command: "cat /tmp/ccg-review-codex-$JOB.txt | ~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend codex - \"{{WORKDIR}}\"",
  run_in_background: true,
  timeout: 3600000,
  description: "Review: backend (wrapper fallback)"
})
```

`/tmp/ccg-review-codex-$JOB.txt` 同 通道 A 的"任务描述模板"——不变。

> ⚠️ 通道 B `codeagent-wrapper` 已标 **deprecated**，仅 plugin 未装时使用。

**角色提示词**：

| 模型 | 提示词 |
|------|--------|
| 后端 | `~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/reviewer.md` |
| 前端 | `~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/reviewer.md` |

**并行调用 + 事件驱动等待**：

1. 在同一 message 内 spawn 两个（或多个）`Bash(run_in_background: true)` 并行任务
2. spawn 完成后主线说明已启动哪些 task（含 task-id），然后**直接 turn end**，**不调 TaskOutput**
3. Claude Code 引擎在每个 background task 完成时自动发 `<task-notification>` system-reminder 触发主线新 turn
4. 主线在收到通知的新 turn 处理：
   - 从 notification `<task-id>` 定位是哪个任务
   - 从 `<output-file>` 路径 read stdout（plugin --json 输出 5-50KB）
   - JSON parse `result.text` 字段（plugin 通道）/ `--progress` 行（codeagent-wrapper 通道）
5. **必须等所有相关 task 都收到通知**才进入下一阶段（主线按 task-id 计数已收齐）

⛔ **禁止做**：
- 调 `TaskOutput({block: true, timeout: 600000})` —— 这会 freeze 主线 10 分钟，且超时后还要轮询，体验极差（旧模式，已废弃）
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

1. 用 Write 把任务描述写到两个 tmpfile（**仅任务说明 + 角色提示词路径，不塞 diff**）
2. 用 `{{CODEX_BASH_TASK}}` + `{{GEMINI_BASH_TASK}}` 占位符并行 spawn：
   - **{{BACKEND_PRIMARY}} 后端审查**：role 用 `~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/reviewer.md`
   - **{{FRONTEND_PRIMARY}} 前端审查**：role 用 `~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/reviewer.md`
3. 任务描述里要求 codex/gemini 自己跑 `git diff HEAD` 读 diff，按角色视角输出 JSON

**事件驱动等待**：spawn 完两个 Bash bg 后主线 turn end，等 task-notification 自动唤醒。两个 task 都收到通知后进阶段 3。

**务必遵循上方 `多模型调用规范` 的 `重要` 指示**——尤其是"不塞 diff"原则。

### 🛡 阶段 2.5：敌对审查（仅 `--adversarial`）

`[模式：敌对]`

**仅当 `$ARGUMENTS` 含 `--adversarial` 字面量时启动**。否则跳过本阶段。

调用方式（Bash 直调，绕开 sonnet wrapper）：

```
Step 1. 用 Write 把任务描述写入 tmpfile（同样不塞 diff，让 codex 自己读）:
   Write({ file_path: "/tmp/ccg-review-adv-$JOB.txt", content: <下方任务描述> })

Step 2. 调 helper:
   Bash({
     command: `{{CODEX_BASH_TASK}} --prompt-file /tmp/ccg-review-adv-$JOB.txt`,
     description: "Adversarial review (codex direct)",
     run_in_background: true,
     timeout: 3600000
   })
```

**Adversarial 任务描述**（写入 tmpfile 的内容；只放摘要 + 指引，不塞 diff）：

```
# 任务：敌对视角代码审查

工作目录：{{WORKDIR}}

## 你要做的事

1. 跑 `git diff HEAD` 看变更（你自己读，主线不传）
2. 涉及逻辑判断时 Read 相关源文件
3. 假设代码作者刻意误导，**只挑前两轮没发现 / 低估的**漏洞

## 前两轮审查意见摘要（避免重复结论）

后端审查 critical 项：
- <主线在此填写阶段 2 后端摘要 ≤ 500 字>

前端审查 critical 项：
- <主线在此填写阶段 2 前端摘要 ≤ 500 字>

## 输出 JSON 格式

{
  "critical_adversarial": [{file, line, issue, why_missed_before}, ...],
  "major_adversarial":    [...]
}

每条必须标"为什么前两轮没发现"。只输出 JSON。
```

主线把前两轮摘要（critical 项 ≤ 500 字）注入 tmpfile，**不要塞完整 review 输出**——主线已经看完了，传摘要即可。

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
