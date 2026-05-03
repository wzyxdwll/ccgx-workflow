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
   - **CRITICAL**: You MUST launch BOTH {{BACKEND_PRIMARY}} AND {{FRONTEND_PRIMARY}} in a SINGLE message with TWO Bash tool calls.
   - **DO NOT** call one model first and wait. Launch BOTH simultaneously with `run_in_background: true`.
   - **工作目录**：`{{WORKDIR}}` **必须通过 Bash 执行 `pwd`（Unix）或 `cd`（Windows CMD）获取当前工作目录的绝对路径**，禁止从 `$HOME` 或环境变量推断。如果用户通过 `/add-dir` 添加了多个工作区，先确定任务相关的工作区。

   **Step 2.1**: In ONE message, make TWO parallel Bash calls:

   **FIRST Bash call ({{BACKEND_PRIMARY}})**:
   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend {{BACKEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nAnalyze change <change_id> from backend perspective:\n- Implementation approach\n- Technical risks\n- Alternative architectures\n- Edge cases and failure modes\nOUTPUT: JSON with analysis\nEOF",
     run_in_background: true,
     timeout: 300000,
     description: "{{BACKEND_PRIMARY}}: backend analysis"
   })
   ```

   **SECOND Bash call ({{FRONTEND_PRIMARY}}) - IN THE SAME MESSAGE**:
   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend {{FRONTEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nAnalyze change <change_id> from frontend/integration perspective:\n- Maintainability assessment\n- Scalability considerations\n- Integration conflicts\nOUTPUT: JSON with analysis\nEOF",
     run_in_background: true,
     timeout: 300000,
     description: "{{FRONTEND_PRIMARY}}: frontend analysis"
   })
   ```

   **Step 2.2**: After BOTH Bash calls return task IDs, wait for results with TWO TaskOutput calls:
   ```
   TaskOutput({ task_id: "<codex_task_id>", block: true, timeout: 600000 })
   TaskOutput({ task_id: "<gemini_task_id>", block: true, timeout: 600000 })
   ```

   ⛔ **前端模型失败必须重试**：若前端模型调用失败，最多重试 2 次（间隔 5 秒）。3 次全败才跳过。
   ⛔ **后端模型结果必须等待**：后端模型执行 5-15 分钟属正常，超时后继续轮询，禁止跳过。

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

5. **Update OPSX Artifacts**
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
