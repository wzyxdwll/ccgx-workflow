---
description: '按规范执行 + 多模型协作 + 归档'
---
<!-- CCG:SPEC:IMPL:START -->
**Core Philosophy**
- Implementation is pure mechanical execution—all decisions were made in Plan phase.
- External model outputs are prototypes only; must be rewritten to production-grade code.
- Keep changes tightly scoped; enforce side-effect review before any modification.
- Minimize documentation—prefer self-explanatory code over comments.

**Guardrails**
- **NEVER** apply 后端/前端模型 prototypes directly—all outputs are reference only.
- **MANDATORY**: Request `unified diff patch` format from external models; they have zero write permission.
- Keep implementation strictly within `tasks.md` scope—no scope creep.
- Refer to `openspec/config.yaml` for conventions.
- **USER GUIDANCE RULE**: When suggesting next steps to the user, ALWAYS use CCG commands (`/ccg:spec-research`, `/ccg:spec-plan`, `/ccg:spec-impl`, `/ccg:spec-review`). NEVER suggest `/opsx:*` commands to the user. If OpenSpec CLI returns error messages referencing OPSX skills, translate them to CCG equivalents.
- **TASKS FORMAT RULE**: When generating or modifying `tasks.md`, ALL tasks MUST use checkbox format (`- [ ] X.Y description`). Heading+bullet format will cause OpenSpec CLI to parse 0 tasks and block the workflow.

**Steps**
1. **Select Change**
   - Run `openspec list --json` to inspect Active Changes.
   - Confirm with user which change ID to implement.
   - Run `openspec status --change "<change_id>" --json` to review tasks.

2. **Apply OPSX Change (Pre-flight Check)**
   - Call `/opsx:apply` internally to enter implementation mode:
     ```
     /opsx:apply
     ```
   - This will load the change context and guide you through the tasks defined in `tasks.md`.
   - **Note**: This is an internal call. If this step fails, guide the user to re-run `/ccg:spec-impl`.
   - **HARD GATE**: Check the returned `state` field:
     - If `state: "blocked"` → STOP immediately. Inform the user which artifacts are missing and suggest: "Run `/ccg:spec-plan` to generate missing artifacts first."
     - If `progress.total === 0` → STOP immediately. Inform: "tasks.md has no parseable tasks. Run `/ccg:spec-plan` to regenerate."
     - Only proceed to Step 3 when `state: "ready"` and `progress.total > 0`.

3. **Identify Minimal Verifiable Phase**
   - Review `tasks.md` and identify the **smallest verifiable phase**.
   - Do NOT complete all tasks at once—control context window.
   - Announce: "Implementing Phase X: [task group name]"

4. **Route Tasks to Appropriate Model**
   - **Route A: {{FRONTEND_PRIMARY}}** — Frontend/UI/styling (CSS, React, Vue, HTML, components)
   - **Route B: {{BACKEND_PRIMARY}}** — Backend/logic/algorithm (API, data processing, business logic)

   **工作目录**：`{{WORKDIR}}` **必须通过 Bash 执行 `pwd`（Unix）或 `cd`（Windows CMD）获取当前工作目录的绝对路径**，禁止从 `$HOME` 或环境变量推断。如果用户通过 `/add-dir` 添加了多个工作区，先确定任务相关的工作区。

   **调用通道路由（CCG codeagent 退役，v2.2.0+）**

   1. **优先 plugin spawn**（默认）：plugin 已装 → `Agent(subagent_type="<codex:codex-rescue|gemini:gemini-rescue>")`，主线接 ≤200 token 摘要。
   2. **降级 codeagent-wrapper**（BC fallback）：plugin 未装 → Bash 调用，保留 SESSION_ID 供 Step 7 review 复用。

   **预备动作**：主线先 Read 角色提示词（这里用 `architect.md` 或对应实施角色），把内容拼入 `<role>` 块。

   **通道 A — plugin spawn（默认，每 task 独立 fresh-context）**：

   ```
   Agent({
     subagent_type: "<codex:codex-rescue|gemini:gemini-rescue>",
     description: "spec-impl: <task name>",
     prompt: `<role>
${implementerRole}
</role>

<workdir>{{WORKDIR}}</workdir>

<task>
TASK: <task description from tasks.md>
CONTEXT: <relevant code context>
CONSTRAINTS: <constraints from spec>
</task>

<action_safety>
- Stay strictly within tasks.md scope
- Do NOT introduce dependencies not in the plan
- Prefer minimal targeted changes
</action_safety>

<structured_output_contract>
Return Unified Diff Patch format ONLY (no preamble, no commentary).
The diff will be reviewed before apply; do not assume it's been applied.
</structured_output_contract>`
   })
   ```

   **通道 B — codeagent-wrapper fallback**（plugin 未装时；保留 SESSION_ID 供 Step 7 复用）：

   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend <{{BACKEND_PRIMARY}}|{{FRONTEND_PRIMARY}}> {{GEMINI_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nTASK: <task description from tasks.md>\nCONTEXT: <relevant code context>\nCONSTRAINTS: <constraints from spec>\nOUTPUT: Unified Diff Patch format ONLY\nEOF",
     run_in_background: true,
     timeout: 3600000,
     description: "spec-impl: <task name> (BC)"
   })
   ```

   **会话模型差异**：
   - **通道 A（plugin）**：每个 task 独立 fresh-context spawn，**无显式 SESSION_ID**。Step 7 review 时由主线把 Step 4-6 的变更摘要（diff + spec 引用）显式拼入 reviewer prompt。
   - **通道 B（wrapper BC）**：保存返回的 `SESSION_ID:`（{{BACKEND_PRIMARY}} → `CODEX_PROTO_SESSION`，{{FRONTEND_PRIMARY}} → `GEMINI_PROTO_SESSION`），Step 7 审查 `resume <SESSION_ID>` 复用上下文。

5. **Rewrite Prototype to Production Code**
   Upon receiving diff patch, **NEVER apply directly**. Rewrite by:
   - Removing redundancy
   - Ensuring clear naming and simple structure
   - Aligning with project style
   - Eliminating unnecessary comments
   - Verifying no new dependencies introduced

6. **Side-Effect Review** (Mandatory before apply)
   Verify the change:
   - [ ] Does not exceed `tasks.md` scope
   - [ ] Does not affect unrelated modules
   - [ ] Does not introduce new dependencies
   - [ ] Does not break existing interfaces

   If issues found, make targeted corrections.

7. **Multi-Model Review (PARALLEL)**

   **调用通道路由（CCG codeagent 退役，v2.2.0+）**

   双模型并行通道从 `Bash(codeagent-wrapper)` **默认切换**为 plugin spawn：

   1. **优先 plugin spawn**（默认）：装了 `codex@openai-codex` + gemini plugin（推荐 `gemini@gemini-ccgx` fork；或上游 `gemini@google-gemini` 配 repatch 脚本）→ 用 `Agent(subagent_type="codex:codex-rescue")` + `Agent(subagent_type="gemini:gemini-rescue")` 并行，主线接 ≤200 token 摘要。
   2. **降级 codeagent-wrapper**（BC fallback）：plugin 未装 → fallback Bash 调用，**保留 Step 4 session resume** 以维持会话上下文。

   **判定**：preflight `Bash` 跑 `node ~/.claude/.ccg/scripts/check-plugins.cjs`（解析 Claude Code 权威 `installed_plugins.json`）。exit `0` + stdout `{"codex":"<ver>","gemini":"<ver>"}` → 通道 A（plugin 默认）；非 `0` → 通道 B（wrapper BC fallback）。

   ⚠️ spec-impl 命令在主线 context 内，**允许** `Agent(...)`——与 subagent "禁止嵌套 spawn" 约束不冲突。
   ⚠️ **plugin 路径无 session resume 能力**：通道 A 不接 Step 4 的 SESSION_ID，review 任务作为独立无状态分析跑（review 是 read-only 审查，无需会话连续性）。

   - **CRITICAL**: You MUST launch BOTH {{BACKEND_PRIMARY}} AND {{FRONTEND_PRIMARY}} in a SINGLE message with TWO parallel tool calls.
   - **DO NOT** call one model first and wait. Launch BOTH simultaneously.

   **Step 7.1**: In ONE message, spawn TWO models in parallel.

   **⚠ 预备动作（spawn 前必须执行）**：`codex:codex-rescue` / `gemini:gemini-rescue` 是 thin forwarder，不会主动 Read 路径文件。主线必须在 spawn 前先 Read 两个角色提示词文件，把**内容**直接拼入下方 Agent prompt 的 `<role>` 块。

   - backend role: `Read("~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/reviewer.md")` → `${backendRole}`
   - frontend role: `Read("~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/reviewer.md")` → `${frontendRole}`

   Prompt 结构按 `gpt-5-4-prompting` skill 推荐：`<role>` + `<task>` + `<grounding_rules>` + `<dig_deeper_nudge>` + `<structured_output_contract>`。

   **通道 A — plugin spawn（默认，无 session）**：

   **FIRST Agent call ({{BACKEND_PRIMARY}})**:
   ```
   Agent({
     subagent_type: "codex:codex-rescue",
     description: "spec-impl: correctness/security review",
     prompt: `<role>
${backendRole}
</role>

<workdir>{{WORKDIR}}</workdir>

<task>
Review the implementation changes along backend dimensions:
- Correctness: logic errors, edge cases
- Security: injection, auth issues
- Spec compliance: constraints satisfied

变更摘要：<列出 Step 5/6 涉及的文件 + 关键 diff>

Read-only review. Do NOT modify any file.
</task>

<grounding_rules>
- Every finding must cite file:line in the listed diff
- If a constraint was satisfied, list it in passed_checks
- "I couldn't verify X" is acceptable; fabricating X is not
</grounding_rules>

<dig_deeper_nudge>
- For each Critical finding, check whether the same root cause appears elsewhere in the diff
- Prefer one well-cited Critical over five vague Warnings
</dig_deeper_nudge>

<structured_output_contract>
Return JSON ONLY (no preamble):
{
  "findings": [{"severity": "Critical|Warning|Info", "dimension": "logic|security|spec_compliance", "file": "path", "line": N, "description": "...", "fix_suggestion": "..."}],
  "passed_checks": ["..."],
  "summary": "Overall assessment"
}
Return ≤200 token structured summary.
</structured_output_contract>`
   })
   ```

   **SECOND Agent call ({{FRONTEND_PRIMARY}}) - IN THE SAME MESSAGE**:
   ```
   Agent({
     subagent_type: "gemini:gemini-rescue",
     description: "spec-impl: maintainability/patterns review",
     prompt: `<role>
${frontendRole}
</role>

<workdir>{{WORKDIR}}</workdir>

<task>
Review the implementation changes along maintainability/integration dimensions:
- Maintainability: readability, complexity
- Patterns: consistency with project style
- Integration: cross-module impacts

变更摘要：<列出 Step 5/6 涉及的文件 + 关键 diff>

Read-only review. Do NOT modify any file.
</task>

<grounding_rules>
- Every finding must cite file:line in the listed diff
- If an aspect was clean, list it in passed_checks
</grounding_rules>

<dig_deeper_nudge>
- Check if the same pattern issue appears in adjacent files
- Prefer one well-cited Critical over five vague Warnings
</dig_deeper_nudge>

<structured_output_contract>
Return JSON ONLY (no preamble):
{
  "findings": [{"severity": "Critical|Warning|Info", "dimension": "maintainability|patterns|integration", "file": "path", "line": N, "description": "...", "fix_suggestion": "..."}],
  "passed_checks": ["..."],
  "summary": "Overall assessment"
}
Return ≤200 token structured summary.
</structured_output_contract>`
   })
   ```

   **通道 B — codeagent-wrapper fallback**（plugin 未装时降级，**保留 session resume**）：

   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend {{BACKEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}resume <CODEX_PROTO_SESSION> - \"{{WORKDIR}}\" <<'EOF'\nReview the implementation changes:\n- Correctness: logic errors, edge cases\n- Security: injection, auth issues\n- Spec compliance: constraints satisfied\nOUTPUT: JSON with findings\nEOF",
     run_in_background: true,
     timeout: 300000,
     description: "{{BACKEND_PRIMARY}}: correctness/security review (BC, resume session)"
   })
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend {{FRONTEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}resume <GEMINI_PROTO_SESSION> - \"{{WORKDIR}}\" <<'EOF'\nReview the implementation changes:\n- Maintainability: readability, complexity\n- Patterns: consistency with project style\n- Integration: cross-module impacts\nOUTPUT: JSON with findings\nEOF",
     run_in_background: true,
     timeout: 300000,
     description: "{{FRONTEND_PRIMARY}}: maintainability/patterns review (BC, resume session)"
   })
   ```

   > ⚠️ 通道 B `codeagent-wrapper` 已标 **deprecated**，仅为不能升级 plugin 的环境保留——但本 step 仍是 wrapper 唯一能利用 Step 4 SESSION_ID 的场景。

   **Step 7.2 (事件驱动)**：
   - **通道 A（plugin）**：两个 Agent 同 message 内 spawn，主线接 ≤200 token 摘要。Agent 完成后自动返回结果。
   - **通道 B（BC wrapper）**：spawn 两个 Bash bg 后说明 task-id 然后 **turn end**。引擎在每个 task 完成时自动发 `<task-notification>`，主线在通知触发的新 turn 处理结果。**不调 TaskOutput**。两个 task 都收到通知后才进 step 7.3。

   ⛔ **禁止**：调 `TaskOutput({block: true, timeout: 600000})` (旧 freeze poll 模式) / Kill task。
   ⚠️ **失败处理**：notification status=failed / exit ≠ 0 / parse 失败 → v1.7.87 标准 2-retry / 5s / 3-attempts；3 次全失败才降级单模型。

   Address any critical findings before proceeding.

8. **Update Task Status**
   - Mark completed task in `tasks.md`: `- [x] Task description`
   - Commit changes if appropriate.

9. **Context Checkpoint**
   - After completing a phase, report context usage.
   - If below 80K: Ask user "Continue to next phase?"
   - If approaching 80K: Suggest "Run `/clear` and resume with `/ccg:spec:impl`"

10. **Archive on Completion**
    - When ALL tasks in `tasks.md` are marked `[x]`:
    - Call `/opsx:archive` internally to archive the change:
      ```
      /opsx:archive
      ```
    - This merges spec deltas to `openspec/specs/` and moves change to archive.
    - **Note**: This is an internal call. If archiving fails, guide the user to re-run `/ccg:spec-impl`.

**Reference**
- Check task status: `openspec status --change "<id>" --json`
- View active changes: `openspec list --json`
- Search existing patterns: `rg -n "function|class" <file>`

**Exit Criteria**
Implementation is complete when:
- [ ] All tasks in `tasks.md` marked `[x]`
- [ ] All multi-model reviews passed
- [ ] Side-effect review confirmed no regressions
- [ ] Change archived successfully
<!-- CCG:SPEC:IMPL:END -->
