---
description: '双模型交叉审查（独立工具，随时可用）'
---
<!-- CCG:SPEC:REVIEW:START -->
**Core Philosophy**
- Dual-model cross-validation catches blind spots single-model review would miss.
- Critical findings SHOULD be addressed before proceeding.
- Review validates implementation against spec constraints and code quality.
- This is an independent review tool—can be used anytime, not tied to archive workflow.

**Guardrails**
- **MANDATORY**: Both {{BACKEND_PRIMARY}} AND {{FRONTEND_PRIMARY}} must complete review before synthesis.
- Review scope is strictly limited to the proposal's changes—no scope creep.
- Refer to `openspec/config.yaml` for project conventions when reviewing OpenSpec proposals.

**Steps**
1. **Select Proposal**
   - Run `openspec list --json` to display Active Changes.
   - Confirm with user which proposal ID to review.
   - Run `openspec status --change "<proposal_id>" --json` to load spec and tasks.

2. **Collect Implementation Artifacts**
   - Identify all files modified by this proposal.
   - Use `git diff` to get change summary.
   - Load relevant spec constraints and PBT properties from `openspec/changes/<id>/specs/`.

3. **Multi-Model Review (PARALLEL)**

   **调用通道路由（CCG codeagent 退役，v2.2.0+）**

   双模型并行通道从 `Bash(codeagent-wrapper)` **默认切换**为 plugin spawn：

   1. **优先 plugin spawn**（默认）：装了 `codex@openai-codex` + gemini plugin（推荐 `gemini@gemini-ccgx` fork；或上游 `gemini@google-gemini` 配 repatch 脚本）→ 用 `Agent(subagent_type="codex:codex-rescue")` + `Agent(subagent_type="gemini:gemini-rescue")` 并行，主线接 ≤200 token 摘要。
   2. **降级 codeagent-wrapper**（BC fallback）：plugin 未装 → fallback Bash 调用，行为与 plugin 路径等价。

   **判定**：preflight `Bash` 跑 `node ~/.claude/.ccg/scripts/check-plugins.cjs`（解析 Claude Code 权威 `installed_plugins.json`）。exit `0` + stdout `{"codex":"<ver>","gemini":"<ver>"}` → 通道 A（plugin 默认）；非 `0` → 通道 B（wrapper BC fallback）。

   ⚠️ spec-review 命令在主线 context 内，**允许** `Agent(...)`——与 subagent "禁止嵌套 spawn" 约束不冲突。

   - **CRITICAL**: You MUST launch BOTH {{BACKEND_PRIMARY}} AND {{FRONTEND_PRIMARY}} in a SINGLE message with TWO parallel tool calls.
   - **DO NOT** call one model first and wait. Launch BOTH simultaneously.
   - **工作目录**：`{{WORKDIR}}` **必须通过 Bash 执行 `pwd`（Unix）或 `cd`（Windows CMD）获取当前工作目录的绝对路径**，禁止从 `$HOME` 或环境变量推断。如果用户通过 `/add-dir` 添加了多个工作区，先确定任务相关的工作区。

   **Step 3.1**: In ONE message, spawn TWO models in parallel.

   **⚠ 预备动作（spawn 前必须执行）**：`codex:codex-rescue` / `gemini:gemini-rescue` 是 thin forwarder，不会主动 Read 路径文件。主线必须在 spawn 前先 Read 两个角色提示词文件，把**内容**直接拼入下方 Agent prompt 的 `<role>` 块。

   - backend role: `Read("~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/reviewer.md")` → `${backendRole}`
   - frontend role: `Read("~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/reviewer.md")` → `${frontendRole}`

   Prompt 结构按 `gpt-5-4-prompting` skill 推荐（review 类任务额外加 `<grounding_rules>` + `<dig_deeper_nudge>`）。

   **通道 A — plugin spawn（默认）**：

   **FIRST Agent call ({{BACKEND_PRIMARY}})**:
   ```
   Agent({
     subagent_type: "codex:codex-rescue",
     description: "spec-review: backend/logic review",
     prompt: `<role>
${backendRole}
</role>

<workdir>{{WORKDIR}}</workdir>

<task>
Review proposal <proposal_id> implementation along backend dimensions:
1. Spec Compliance — Verify ALL constraints from spec are satisfied
2. PBT Properties — Check invariants, idempotency, bounds correctly implemented
3. Logic Correctness — Edge cases, error handling, algorithm correctness
4. Backend Security — Injection vulnerabilities, auth checks, input validation
5. Regression Risk — Interface compatibility, type safety, breaking changes

Read-only review. Do NOT modify any file.
</task>

<grounding_rules>
- Every finding must cite file:line
- If a constraint was satisfied, list it in passed_checks (don't omit positives)
- "I couldn't verify X" is acceptable; fabricating X is not
- Distinguish bug (observable failure path) from concern (style/maintainability preference)
</grounding_rules>

<dig_deeper_nudge>
- For each Critical finding, check whether the same root cause appears elsewhere in the diff
- Prefer one well-cited Critical over five vague Warnings
</dig_deeper_nudge>

<structured_output_contract>
Return JSON ONLY (no preamble):
{
  "findings": [
    {
      "severity": "Critical|Warning|Info",
      "dimension": "spec_compliance|pbt|logic|security|regression",
      "file": "path/to/file.ts",
      "line": 42,
      "description": "What is wrong",
      "constraint_violated": "Constraint ID from spec (if applicable)",
      "fix_suggestion": "How to fix"
    }
  ],
  "passed_checks": ["List of verified constraints/properties"],
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
     description: "spec-review: patterns/integration review",
     prompt: `<role>
${frontendRole}
</role>

<workdir>{{WORKDIR}}</workdir>

<task>
Review proposal <proposal_id> implementation along frontend/integration dimensions:
1. Pattern Consistency — Naming conventions, code style, project patterns
2. Maintainability — Readability, complexity, documentation adequacy
3. Integration Risk — Dependency changes, cross-module impacts
4. Frontend Security — XSS, CSRF, sensitive data exposure
5. Spec Alignment — Implementation matches spec intent (not just letter)

Read-only review. Do NOT modify any file.
</task>

<grounding_rules>
- Every finding must cite file:line
- If an aspect was clean, list it in passed_checks
- "I couldn't verify X" is acceptable; fabricating X is not
</grounding_rules>

<dig_deeper_nudge>
- For each Critical finding, check whether the same pattern issue appears in adjacent files
- Prefer one well-cited Critical over five vague Warnings
</dig_deeper_nudge>

<structured_output_contract>
Return JSON ONLY (no preamble):
{
  "findings": [
    {
      "severity": "Critical|Warning|Info",
      "dimension": "patterns|maintainability|integration|security|alignment",
      "file": "path/to/file.ts",
      "line": 42,
      "description": "What is wrong",
      "spec_reference": "Spec section (if applicable)",
      "fix_suggestion": "How to fix"
    }
  ],
  "passed_checks": ["List of verified aspects"],
  "summary": "Overall assessment"
}
Return ≤200 token structured summary.
</structured_output_contract>`
   })
   ```

   **通道 B — codeagent-wrapper fallback**（plugin 未装时降级，并行用 `run_in_background: true`）：

   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend {{BACKEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nROLE_FILE: ~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/reviewer.md\nReview proposal <proposal_id> implementation:\n[Backend review dimensions - same as 通道 A]\nOUTPUT (JSON): [same schema as 通道 A]\nEOF",
     run_in_background: true,
     timeout: 300000,
     description: "{{BACKEND_PRIMARY}}: backend/logic review (BC)"
   })
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend {{FRONTEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nROLE_FILE: ~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/reviewer.md\nReview proposal <proposal_id> implementation:\n[Frontend review dimensions - same as 通道 A]\nOUTPUT (JSON): [same schema as 通道 A]\nEOF",
     run_in_background: true,
     timeout: 300000,
     description: "{{FRONTEND_PRIMARY}}: patterns/integration review (BC)"
   })
   ```

   > ⚠️ 通道 B `codeagent-wrapper` 已标 **deprecated**，仅为不能升级 plugin 的环境保留。

   **Step 3.2 (事件驱动)**：
   - **通道 A（plugin）**：两个 Agent 同 message 内 spawn，主线接 ≤200 token 摘要。Agent 完成后自动返回结果。
   - **通道 B（BC wrapper）**：spawn 两个 Bash bg 后说明 task-id 然后 **turn end**。引擎在每个 task 完成时自动发 `<task-notification>`，主线在通知触发的新 turn 处理结果。**不调 TaskOutput**。两个 task 都收到通知后才进 step 3.3。

   ⛔ **禁止**：调 `TaskOutput({block: true, timeout: 600000})` (旧 freeze poll 模式) / Kill task。
   ⚠️ **失败处理**：notification status=failed / exit ≠ 0 / parse 失败 → v1.7.87 标准 2-retry / 5s / 3-attempts；3 次全失败才降级单模型。

4. **Synthesize Findings**
   - Merge findings from both models.
   - Deduplicate overlapping issues.
   - Classify by severity:
     * **Critical**: Spec violation, security vulnerability, breaking change → MUST fix
     * **Warning**: Pattern deviation, maintainability concern → SHOULD fix
     * **Info**: Minor improvement suggestion → MAY fix

5. **Present Review Report**
   - Display findings grouped by severity:
   ```
   ## Review Report: <proposal_id>

   ### Critical (X issues) - MUST FIX
   - [ ] [SPEC] file.ts:42 - Constraint X violated: description
   - [ ] [SEC] api.ts:15 - SQL injection vulnerability

   ### Warning (Y issues) - SHOULD FIX
   - [ ] [PATTERN] utils.ts:88 - Inconsistent naming convention

   ### Info (Z issues) - MAY FIX
   - [ ] [MAINT] helper.ts:20 - Consider extracting to separate function

   ### Passed Checks
   - ✅ PBT: Idempotency property verified
   - ✅ Security: No XSS vulnerabilities found
   ```

6. **Decision Gate**
   - **If Critical > 0**:
     * Present findings to user.
     * Ask: "Fix now or return to `/ccg:spec-impl` to address?"
     * Do NOT allow archiving.

   - **If Critical = 0**:
     * Ask user: "All critical checks passed. Proceed to archive?"
     * If Warning > 0, recommend addressing before archive.

7. **Optional: Inline Fix Mode**
   - If user chooses "Fix now" for Critical issues:
     * Route each fix to appropriate model (backend→{{BACKEND_PRIMARY}}, frontend→{{FRONTEND_PRIMARY}}).
     * Apply fix using unified diff patch pattern.
     * Re-run affected review dimension.
     * Repeat until Critical = 0.

8. **Context Checkpoint**
   - Report current context usage.
   - If approaching 80K tokens, suggest: "Run `/clear` and continue with `/ccg:spec-review` or `/ccg:spec-impl`"

**Exit Criteria**
Review is complete when:
- [ ] Both {{BACKEND_PRIMARY}} and {{FRONTEND_PRIMARY}} reviews completed
- [ ] All findings synthesized and classified
- [ ] Zero Critical issues remain (fixed or user-acknowledged)
- [ ] User decision captured (archive / return to impl / defer)

**Reference**
- View proposal: `openspec status --change "<id>" --json`
- Check spec constraints: `rg -n "CONSTRAINT:|MUST|INVARIANT:" openspec/changes/<id>/specs/`
- View implementation diff: `git diff`
- Archive (after passing): `/ccg:spec-impl` → Step 10
<!-- CCG:SPEC:REVIEW:END -->
