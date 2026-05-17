---
description: '多模型分析 → 消除歧义 → 零决策可执行计划'
---
<!-- CCG:SPEC:PLAN:START -->
**Core Philosophy**
- The goal is to eliminate ALL decision points—implementation should be pure mechanical execution.
- Every ambiguity must be resolved into explicit constraints before proceeding.
- Multi-model collaboration surfaces blind spots and conflicting assumptions.
- Every requirement must have Property-Based Testing (PBT) properties—focus on invariants.

**Guardrails**
- Do not proceed to implementation until every ambiguity is resolved.
- Multi-model collaboration is **mandatory**: use both {{BACKEND_PRIMARY}} and {{FRONTEND_PRIMARY}}.
- If constraints cannot be fully specified, escalate to user or return to research phase.
- Refer to `openspec/config.yaml` for project conventions.
- **USER GUIDANCE RULE**: When suggesting next steps to the user, ALWAYS use CCG commands (`/ccg:spec-research`, `/ccg:spec-plan`, `/ccg:spec-impl`, `/ccg:spec-review`). NEVER suggest `/opsx:*` commands to the user. If OpenSpec CLI returns error messages referencing OPSX skills, translate them to CCG equivalents.
- **TASKS FORMAT RULE**: When generating or modifying `tasks.md`, ALL tasks MUST use checkbox format (`- [ ] X.Y description`). Heading+bullet format will cause OpenSpec CLI to parse 0 tasks and block the workflow.
- **PHASE BOUNDARY**: This phase ONLY generates OPSX artifacts (specs.md, design.md, tasks.md). Do NOT modify any source code. Do NOT proceed to implementation. After artifacts are generated, STOP and inform the user: "Plan complete. Run `/ccg:spec-impl` to start implementation."

**Steps**
1. **Select Change**
   - Run `openspec list --json` to display Active Changes.
   - Confirm with user which change ID to refine.
   - Run `openspec status --change "<change_id>" --json` to review current state.

2. **Multi-Model Implementation Analysis (PARALLEL)**

   **调用通道路由（CCG codeagent 退役，v2.2.0+）**

   双模型并行通道从 `Bash(codeagent-wrapper)` **默认切换**为 plugin spawn：

   1. **优先 plugin spawn**（默认）：装了 `codex@openai-codex` + gemini plugin（推荐 `gemini@gemini-ccgx` fork；或上游 `gemini@google-gemini` 配 repatch 脚本）→ 用 `Agent(subagent_type="codex:codex-rescue")` + `Agent(subagent_type="gemini:gemini-rescue")` 并行，主线接 ≤200 token 摘要。
   2. **降级 codeagent-wrapper**（BC fallback）：plugin 未装 → fallback Bash 调用，行为与 plugin 路径等价。

   **判定**：preflight `Bash` 跑 `ls ~/.claude/plugins/` 看有无 `codex@*` / `gemini@*` 子目录。

   ⚠️ spec-plan 命令在主线 context 内，**允许** `Agent(...)`——与 subagent "禁止嵌套 spawn" 约束不冲突。

   - **CRITICAL**: You MUST launch BOTH {{BACKEND_PRIMARY}} AND {{FRONTEND_PRIMARY}} in a SINGLE message with TWO parallel tool calls.
   - **DO NOT** call one model first and wait. Launch BOTH simultaneously.
   - **工作目录**：`{{WORKDIR}}` **必须通过 Bash 执行 `pwd`（Unix）或 `cd`（Windows CMD）获取当前工作目录的绝对路径**，禁止从 `$HOME` 或环境变量推断。如果用户通过 `/add-dir` 添加了多个工作区，先确定任务相关的工作区。

   **Step 2.1**: In ONE message, spawn TWO models in parallel.

   **通道 A — plugin spawn（默认）**：

   **FIRST Agent call ({{BACKEND_PRIMARY}})**:
   ```
   Agent({
     subagent_type: "codex:codex-rescue",
     description: "spec-plan: backend analysis",
     prompt: `ROLE_FILE: ~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/analyzer.md

WORKDIR: {{WORKDIR}}

<TASK>
Analyze change <change_id> from backend perspective:
- Implementation approach
- Technical risks
- Alternative architectures
- Edge cases and failure modes
</TASK>

OUTPUT: JSON with analysis.
Return ≤200 token structured summary (plugin-native protocol).`
   })
   ```

   **SECOND Agent call ({{FRONTEND_PRIMARY}}) - IN THE SAME MESSAGE**:
   ```
   Agent({
     subagent_type: "gemini:gemini-rescue",
     description: "spec-plan: frontend analysis",
     prompt: `ROLE_FILE: ~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/analyzer.md

WORKDIR: {{WORKDIR}}

<TASK>
Analyze change <change_id> from frontend/integration perspective:
- Maintainability assessment
- Scalability considerations
- Integration conflicts
</TASK>

OUTPUT: JSON with analysis.
Return ≤200 token structured summary (plugin-native protocol).`
   })
   ```

   **通道 B — codeagent-wrapper fallback**（plugin 未装时降级，并行用 `run_in_background: true`）：

   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend {{BACKEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nROLE_FILE: ~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/analyzer.md\nAnalyze change <change_id> from backend perspective:\n- Implementation approach\n- Technical risks\n- Alternative architectures\n- Edge cases and failure modes\nOUTPUT: JSON with analysis\nEOF",
     run_in_background: true,
     timeout: 300000,
     description: "{{BACKEND_PRIMARY}}: backend analysis (BC)"
   })
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend {{FRONTEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nROLE_FILE: ~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/analyzer.md\nAnalyze change <change_id> from frontend/integration perspective:\n- Maintainability assessment\n- Scalability considerations\n- Integration conflicts\nOUTPUT: JSON with analysis\nEOF",
     run_in_background: true,
     timeout: 300000,
     description: "{{FRONTEND_PRIMARY}}: frontend analysis (BC)"
   })
   ```

   > ⚠️ 通道 B `codeagent-wrapper` 已标 **deprecated**，仅为不能升级 plugin 的环境保留。

   **Step 2.2 (事件驱动)**：
   - **通道 A（plugin）**：两个 Agent 同 message 内 spawn，主线接 ≤200 token 摘要。Agent 完成后自动返回结果。
   - **通道 B（BC wrapper）**：spawn 两个 Bash bg 后说明 task-id 然后 **turn end**。引擎在每个 task 完成时自动发 `<task-notification>`，主线在通知触发的新 turn 处理结果。**不调 TaskOutput**。两个 task 都收到通知后才进 step 2.3。

   ⛔ **禁止**：调 `TaskOutput({block: true, timeout: 600000})` (旧 freeze poll 模式) / Kill task。
   ⚠️ **失败处理**：notification status=failed / exit ≠ 0 / parse 失败 → v1.7.87 标准 2-retry / 5s / 3-attempts；3 次全失败才降级单模型。

   - Synthesize responses and present consolidated options to user.

3. **Uncertainty Elimination Audit**
   - **{{BACKEND_PRIMARY}}**: "Review proposal for unspecified decision points. List each as: [AMBIGUITY] → [REQUIRED CONSTRAINT]"
   - **{{FRONTEND_PRIMARY}}**: "Identify implicit assumptions. Specify: [ASSUMPTION] → [EXPLICIT CONSTRAINT NEEDED]"

   **Anti-Pattern Detection** (flag and reject):
   - Information collection without decision boundaries
   - Technical comparisons without selection criteria
   - Deferred decisions marked "to be determined during implementation"

   **Target Pattern** (required for approval):
   - Explicit technology choices with parameters (e.g., "JWT with TTL=15min")
   - Concrete algorithm selections with configs (e.g., "bcrypt cost=12")
   - Precise behavioral rules (e.g., "Lock account 30min after 5 failed attempts")

   Iterate with user until ALL ambiguities resolved.

4. **PBT Property Extraction**
   - **{{BACKEND_PRIMARY}}**: "Extract PBT properties. For each requirement: [INVARIANT] → [FALSIFICATION STRATEGY]"
   - **{{FRONTEND_PRIMARY}}**: "Define system properties: [PROPERTY] | [DEFINITION] | [BOUNDARY CONDITIONS] | [COUNTEREXAMPLE GENERATION]"

   **Property Categories**:
   - **Commutativity/Associativity**: Order-independent operations
   - **Idempotency**: Repeated operations yield same result
   - **Round-trip**: Encode→Decode returns original
   - **Invariant Preservation**: State constraints maintained
   - **Monotonicity**: Ordering guarantees (e.g., timestamps increase)
   - **Bounds**: Value ranges, size limits, rate constraints

4.5. **Scope Reduction Detection（范围缩水检测，BLOCKER 级）**

   **这是 plan-checker 维度 7b 的等价扫描，移植自 GSD 真实事故反推（D-26：动态成本引用被静态硬编码 v1）。**

   在生成 OPSX artifacts 之前，对当前规划文本（多模型分析结果 + 即将写入 tasks.md 的内容）做软化语言扫描：

   **扫描关键词集合**（中英双语，大小写不敏感）：
   - 阶段拆分类：`v1 简化` / `v1 静态` / `v1 硬编码` / `simplified version` / `static for now` / `static first`
   - 推迟类：`future enhancement` / `未来增强` / `后续连接` / `will be wired later` / `not connected to`
   - 占位类：`placeholder` / `占位符` / `占位实现` / `暂时硬编码` / `temporary hardcode`
   - 知难而退类：`太复杂` / `太困难` / `too complex` / `too difficult` / `too hard`

   **关键设计：与原始需求对比，避免合理 v1 渐进交付误报**

   命中关键词后必须交叉对比，**不**直接阻断：

   1. 抽取命中行的领域名词（如 `billing`, `cost reference`）
   2. 与 OPSX `proposal.md` / `requirements.md` / 用户在 Step 1 选定的 change ID 对应需求做对比
   3. 判决：

   | 命中关键词 + 该能力在原始需求中存在 | plan 是否显式分阶段（v2/phase 2/增量交付被规划） | 判决 |
   |-------------------------------------|--------------------------------------------------|------|
   | ✅ 是 | ❌ 无 | **🔴 BLOCKER**（用户决策被缩水） |
   | ✅ 是 | ✅ 有 | **NONE**（合理渐进，放行） |
   | ❌ 否 | — | **🟡 WARNING**（人工确认） |

   **BLOCKER 永远是 BLOCKER——不接受 warning 降级。** 命中 BLOCKER 时停止生成 artifacts，向用户输出：

   ```
   🔴 SCOPE REDUCTION BLOCKER
   - 命中关键词：<keyword>
   - 原文：<line>
   - 对应需求：<requirement>
   - 选项：
     1. 完整实施该需求（重新规划，不再缩水）
     2. 拆分阶段：把 v2 phase 显式列入计划（写入下一个 OPSX change，不能口头承诺）
   ```

   只有 BLOCKER 数量为 0 时才进入 Step 5。

5. **Update OPSX Artifacts** (then auto plan-checker)
   - **BEFORE calling `/opsx:continue`** (internal skill call — do NOT expose this command to user), output a structured summary for OPSX context:
     ```markdown
     ## Planning Summary for OPSX

     **Multi-Model Analysis Results**:
     - {{BACKEND_PRIMARY}} (Backend): [Key findings and recommendations]
     - {{FRONTEND_PRIMARY}} (Frontend): [Key findings and recommendations]
     - Consolidated Approach: [Selected implementation strategy]

     **Resolved Constraints**:
     - [All explicit constraints from Step 3]

     **PBT Properties**:
     - [All extracted properties from Step 4 with falsification strategies]

     **Technical Decisions**:
     - [All finalized technology choices, algorithms, configurations]

     **Implementation Tasks**:
     - [High-level task breakdown ready for tasks.md]
     ```

   - Then call `/opsx:continue` internally to generate next artifacts:
     ```
     /opsx:continue
     ```
   - The OPSX skill will use the above summary to create specs.md, design.md, and tasks.md.
   - **Note**: This is an internal call. If this step fails, guide the user to re-run `/ccg:spec-plan`.
   - **STOP**: After artifacts are generated, verify they exist and inform user:
     "Plan phase complete. Artifacts generated: specs.md, design.md, tasks.md. Run `/ccg:spec-impl` to start implementation."
     Do NOT proceed to modify source code.

5.5. **自动 plan-checker 校验（5 维度 + max-3-loop）**

   生成 OPSX artifacts 后，**必须**自动 spawn `plan-checker` agent 对 specs.md / design.md / tasks.md 做 5 维度校验：

   ```
   Agent({
     subagent_type: "plan-checker",
     description: "Validate OPSX plan artifacts (Dim 1/2/5/7b/10)",
     prompt: "请对 openspec/changes/<change_id>/ 下的 specs.md / design.md / tasks.md 做 5 维度强校验：\n- Dim 1: Requirement Coverage（每条需求 ID 被某 plan/spec 声明）\n- Dim 2: Task Completeness（tasks.md 每条 task 含 Files/Action/Verify/Done）\n- Dim 5: Scope Sanity（≤3 tasks/plan）\n- Dim 7b: Scope Reduction（与 proposal.md 原始需求交叉对比）\n- Dim 10: CLAUDE.md Compliance（不违反项目 CLAUDE.md 禁用模式）\n输出 Plan Checker Report，并给出 ✅ 放行 / ❌ 退回 verdict。"
   })
   ```

   **max-3-loop 收敛环**：

   ```
   loop_count = 0
   while loop_count < 3:
       result = spawn plan-checker
       if not result.hasBlocker:
           break  # ✅ 通过
       # 退回 planner 修订（仅针对 BLOCKER）
       回到 Step 5 重新调用 /opsx:continue 修订 specs/design/tasks
       loop_count += 1

   if loop_count == 3 and result.hasBlocker:
       AskUserQuestion:
           prompt:  "plan-checker 3 轮仍存在 BLOCKER，请选择："
           options: ["force: 忽略 BLOCKER 强制进入实施", "guide: 提供具体指导让 planner 再试", "abort: 放弃当前 plan"]
   ```

   只有 plan-checker ✅ 放行 后才进入下一步（Context Checkpoint）。

6. **Context Checkpoint**
   - Report current context usage.
   - If approaching 80K tokens, suggest: "Run `/clear` and continue with `/ccg:spec-impl`"

**Exit Criteria**
A change is ready for implementation only when:
- [ ] All multi-model analyses completed and synthesized
- [ ] Zero ambiguities remain (verified by step 3 audit)
- [ ] All PBT properties documented with falsification strategies
- [ ] Artifacts (specs, design, tasks) generated via OpenSpec skills
- [ ] User has explicitly approved all constraint decisions

**Reference**
- Inspect change: `openspec status --change "<id>" --json`
- List changes: `openspec list --json`
- Search patterns: `rg -n "INVARIANT:|PROPERTY:" openspec/`
- Use `AskUserQuestion` for ANY ambiguity—never assume
<!-- CCG:SPEC:PLAN:END -->
