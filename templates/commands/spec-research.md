---
description: '需求 → 约束集（并行探索 + OPSX 提案）'
---
<!-- CCG:SPEC:RESEARCH:START -->
**Core Philosophy**
- Research produces **constraint sets**, not information dumps. Each constraint narrows the solution space.
- Constraints tell subsequent stages "don't consider this direction," enabling mechanical execution without decisions.
- Output: 约束集合 + 可验证的成功判据 (constraint sets + verifiable success criteria).
- Strictly adhere to OPSX rules when writing spec-structured documents.

**Guardrails**
- **STOP! BEFORE ANY OTHER ACTION**: You MUST perform Prompt Enhancement FIRST. This is NON-NEGOTIABLE.
- **NEVER** divide subagent tasks by roles (e.g., "架构师agent", "安全专家agent").
- **ALWAYS** divide by context boundaries (e.g., "user-related code", "authentication logic").
- Each subagent context must be self-contained with independent output.
- Use `{{MCP_SEARCH_TOOL}}` to minimize grep/find operations.
- Do not make architectural decisions—surface constraints that guide decisions.
- **USER GUIDANCE RULE**: When suggesting next steps to the user, ALWAYS use CCG commands (`/ccg:spec-research`, `/ccg:spec-plan`, `/ccg:spec-impl`, `/ccg:spec-review`). NEVER suggest `/opsx:*` commands to the user. If OpenSpec CLI returns error messages referencing OPSX skills, translate them to CCG equivalents.
- **PHASE BOUNDARY**: This phase ONLY generates the OPSX proposal artifact. Do NOT modify any source code. Do NOT proceed to planning or implementation. After the proposal is generated, STOP and inform the user: "Research complete. Run `/ccg:spec-plan` to continue."

**Steps**
0. **MANDATORY: Enhance Requirement FIRST**
   - **DO THIS IMMEDIATELY. DO NOT SKIP.**
   - **Prompt 增强**（按 `/ccg:enhance` 的逻辑执行）：分析 $ARGUMENTS 的意图、缺失信息、隐含假设，补全为结构化需求（明确目标、技术约束、范围边界、验收标准）。
   - Use enhanced prompt for ALL subsequent steps.

1. **Generate OPSX Change**
   - Check if change already exists:
     ```bash
     openspec list --json
     ```
   - If change doesn't exist, create it:
     ```bash
     openspec new change "<brief-descriptive-name>"
     ```
   - This scaffolds `openspec/changes/<name>/` with proposal.md.
   - If change already exists, continue with existing change.

2. **Initial Codebase Assessment**
   - Use `{{MCP_SEARCH_TOOL}}` to scan codebase.
   - Determine project scale: single vs multi-directory structure.
   - **Decision**: If multi-directory → enable parallel Explore subagents.

3. **Define Exploration Boundaries (Context-Based)**
   - Identify natural context boundaries (NOT functional roles):
     * Subagent 1: User domain code (models, services, UI)
     * Subagent 2: Auth & authorization (middleware, session, tokens)
     * Subagent 3: Infrastructure (configs, deployments, builds)
   - Each boundary should be self-contained: no cross-communication needed.

4. **Parallel Multi-Model Exploration**

   **调用通道路由（CCG codeagent 退役，v2.2.0+）**

   双模型并行通道从 `Bash(codeagent-wrapper)` **默认切换**为 plugin spawn：

   1. **优先 plugin spawn**（默认）：装了 `codex@openai-codex` + gemini plugin（推荐 `gemini@gemini-ccgx` fork，含 P-1..P-21 + W1/W2/I1 patch；或上游 `gemini@google-gemini` 配 repatch 脚本）→ 用 `Agent(subagent_type="codex:codex-rescue")` + `Agent(subagent_type="gemini:gemini-rescue")` 并行，主线接 ≤200 token 摘要。
   2. **降级 codeagent-wrapper**（BC fallback）：plugin 未装 → fallback Bash 调用，行为与 plugin 路径等价。

   **判定**：preflight `Bash` 跑 `ls ~/.claude/plugins/` 看有无 `codex@*` / `gemini@*` 子目录。

   ⚠️ spec-research 命令在主线 context 内，**允许** `Agent(...)`——与 subagent "禁止嵌套 spawn" 约束不冲突。

   - **CRITICAL**: You MUST launch BOTH {{BACKEND_PRIMARY}} AND {{FRONTEND_PRIMARY}} in a SINGLE message with TWO parallel tool calls.
   - **DO NOT** call one model first and wait. Launch BOTH simultaneously.
   - **工作目录**：`{{WORKDIR}}` **必须通过 Bash 执行 `pwd`（Unix）或 `cd`（Windows CMD）获取当前工作目录的绝对路径**，禁止从 `$HOME` 或环境变量推断。如果用户通过 `/add-dir` 添加了多个工作区，先确定任务相关的工作区。

   **Output Template** (instruct both models to use this format):
   ```json
   {
     "module_name": "context boundary explored",
     "existing_structures": ["key patterns found"],
     "existing_conventions": ["standards in use"],
     "constraints_discovered": ["hard constraints limiting solution space"],
     "open_questions": ["ambiguities requiring user input"],
     "dependencies": ["cross-module dependencies"],
     "risks": ["potential blockers"],
     "success_criteria_hints": ["observable success behaviors"]
   }
   ```

   **Step 4.1**: In ONE message, spawn TWO models in parallel.

   **⚠ 预备动作（spawn 前必须执行）**：`codex:codex-rescue` / `gemini:gemini-rescue` 是 thin forwarder（一行 `Bash node companion.mjs task <prompt>` 转发），**不会**主动 Read 路径文件。主线必须在 spawn 前先 Read 两个角色提示词文件，把**内容**直接拼入下方 Agent prompt 的 `<role>` 块——不是写路径。

   - backend role: `Read("~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/analyzer.md")` → `${backendRole}`
   - frontend role: `Read("~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/analyzer.md")` → `${frontendRole}`

   Prompt 结构按 `gpt-5-4-prompting` skill 推荐（XML 块、紧凑、操作性）：`<role>` + `<task>` + `<grounding_rules>` + `<structured_output_contract>`。

   **通道 A — plugin spawn（默认）**：

   **FIRST Agent call ({{BACKEND_PRIMARY}} — backend boundaries)**:
   ```
   Agent({
     subagent_type: "codex:codex-rescue",
     description: "spec-research: backend boundary exploration",
     prompt: `<role>
${backendRole}
</role>

<workdir>{{WORKDIR}}</workdir>

<task>
Explore backend context boundaries for <change description>:
- Existing structures and patterns
- Conventions in use
- Hard constraints limiting solution space
- Dependencies and risks
</task>

<grounding_rules>
- Cite file:line for every claim about existing code
- Mark hypotheses explicitly; don't state guesses as facts
- If a question can't be answered from the repo, list it in open_questions
</grounding_rules>

<structured_output_contract>
Return JSON ONLY (no preamble, no commentary):
{
  "module_name": "context boundary explored",
  "existing_structures": ["key patterns found"],
  "existing_conventions": ["standards in use"],
  "constraints_discovered": ["hard constraints limiting solution space"],
  "open_questions": ["ambiguities requiring user input"],
  "dependencies": ["cross-module dependencies"],
  "risks": ["potential blockers"],
  "success_criteria_hints": ["observable success behaviors"]
}
Return ≤200 token structured summary.
</structured_output_contract>`
   })
   ```

   **SECOND Agent call ({{FRONTEND_PRIMARY}} — frontend boundaries) - IN THE SAME MESSAGE**:
   ```
   Agent({
     subagent_type: "gemini:gemini-rescue",
     description: "spec-research: frontend boundary exploration",
     prompt: `<role>
${frontendRole}
</role>

<workdir>{{WORKDIR}}</workdir>

<task>
Explore frontend context boundaries for <change description>:
- Existing structures and patterns
- Conventions in use
- Hard constraints limiting solution space
- Dependencies and risks
</task>

<grounding_rules>
- Cite file:line for every claim about existing code
- Mark hypotheses explicitly; don't state guesses as facts
- If a question can't be answered from the repo, list it in open_questions
</grounding_rules>

<structured_output_contract>
Return JSON ONLY (no preamble, no commentary):
{
  "module_name": "context boundary explored",
  "existing_structures": ["key patterns found"],
  "existing_conventions": ["standards in use"],
  "constraints_discovered": ["hard constraints limiting solution space"],
  "open_questions": ["ambiguities requiring user input"],
  "dependencies": ["cross-module dependencies"],
  "risks": ["potential blockers"],
  "success_criteria_hints": ["observable success behaviors"]
}
Return ≤200 token structured summary.
</structured_output_contract>`
   })
   ```

   **通道 B — codeagent-wrapper fallback**（plugin 未装时降级，并行用 `run_in_background: true`）：

   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend {{BACKEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nROLE_FILE: ~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/analyzer.md\nExplore backend context boundaries for <change description>:\n- Existing structures and patterns\n- Conventions in use\n- Hard constraints limiting solution space\n- Dependencies and risks\nOUTPUT: JSON using the output template above\nEOF",
     run_in_background: true,
     timeout: 300000,
     description: "{{BACKEND_PRIMARY}}: backend boundary exploration (BC)"
   })
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend {{FRONTEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nROLE_FILE: ~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/analyzer.md\nExplore frontend context boundaries for <change description>:\n- Existing structures and patterns\n- Conventions in use\n- Hard constraints limiting solution space\n- Dependencies and risks\nOUTPUT: JSON using the output template above\nEOF",
     run_in_background: true,
     timeout: 300000,
     description: "{{FRONTEND_PRIMARY}}: frontend boundary exploration (BC)"
   })
   ```

   > ⚠️ 通道 B `codeagent-wrapper` 已标 **deprecated**，仅为不能升级 plugin 的环境保留。

   **Step 4.2 (事件驱动)**：
   - **通道 A（plugin）**：两个 Agent 同 message 内 spawn，主线接 ≤200 token 摘要。Agent 完成后自动返回结果到调用上下文，主线直接处理。
   - **通道 B（BC wrapper）**：spawn 两个 Bash bg 后说明 task-id 然后 **turn end**。引擎在每个 task 完成时自动发 `<task-notification>`，主线在通知触发的新 turn 处理结果。**不调 TaskOutput**。两个 task 都收到通知后才进 step 4.3。

   ⛔ **禁止**：调 `TaskOutput({block: true, timeout: 600000})` (旧 freeze poll 模式) / Kill task。
   ⚠️ **失败处理**：notification status=failed / exit ≠ 0 / parse 失败 → v1.7.87 标准 2-retry / 5s / 3-attempts；3 次全失败才降级单模型。

5. **Aggregate and Synthesize**
   - Collect all subagent outputs.
   - Merge into unified constraint sets:
     * **Hard constraints**: Technical limitations, patterns that cannot be violated
     * **Soft constraints**: Conventions, preferences, style guides
     * **Dependencies**: Cross-module relationships affecting implementation order
     * **Risks**: Blockers needing mitigation

6. **User Interaction for Ambiguity Resolution**
   - Compile prioritized list of open questions.
   - Use `AskUserQuestion` tool to present systematically:
     * Group related questions
     * Provide context for each
     * Suggest defaults when applicable
   - Capture responses as additional constraints.

7. **Finalize OPSX Proposal**
   - **BEFORE calling `/opsx:continue`** (internal skill call — do NOT expose this command to user), output a structured summary for OPSX context:
     ```markdown
     ## Research Summary for OPSX

     **Discovered Constraints**:
     - [List all hard and soft constraints from Step 5]

     **Dependencies**:
     - [List cross-module dependencies]

     **Risks & Mitigations**:
     - [List identified risks and mitigation strategies]

     **Success Criteria**:
     - [List verifiable success behaviors]

     **User Confirmations**:
     - [List all user decisions from Step 6]
     ```

   - Then call `/opsx:continue` internally to generate proposal artifact:
     ```
     /opsx:continue
     ```
   - The OPSX skill will use the above summary to write proposal.md.
   - **Note**: This is an internal call. If this step fails, guide the user to re-run `/ccg:spec-research`.
   - **STOP**: After proposal is generated, verify it exists and inform user:
     "Research phase complete. Proposal generated. Run `/ccg:spec-plan` to continue planning."
     Do NOT proceed to planning or implementation.

8. **Context Checkpoint**
   - Report current context usage.
   - If approaching 80K tokens, suggest: "Run `/clear` and continue with `/ccg:spec-plan`"

**Reference**
- OPSX CLI: `openspec status --change "<id>" --json`, `openspec list --json`
- Check prior research: `ls openspec/changes/*/`
- Use `AskUserQuestion` for ANY ambiguity—never assume or guess
<!-- CCG:SPEC:RESEARCH:END -->
