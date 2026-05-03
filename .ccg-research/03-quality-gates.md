# GSD 质量门 + 需求完成度体系（findings）

> 研究目的：摸清 GSD 在"需求完成度"和"代码质量"两个维度上的全部防护机制，与 CCG v3.0.0 现状逐项对照，给出最高 ROI 的移植清单。
>
> 研究范围：仅 `D:/workflow/get-shit-done/` 内的 commands、workflows、agents 三层；不读 GSD 自身的实现 SDK。
>
> 文档约定：所有 GSD 引用都带 `文件:行号`，所有 CCG 引用同样带 `文件:行号`。本文不写代码、不输出补丁。

---

## 1. 体系全图

GSD 的每一个 phase（阶段）都被多道门夹住。从启动到归档，这条链路上的门按顺序如下：

```mermaid
flowchart TD
    A[ROADMAP.md 定义 phase + 成功判据] --> B[discuss-phase<br/>灰区识别 + 决策固化]
    B --> C[CONTEXT.md<br/>locked decisions / deferred ideas / canonical refs]
    C --> D[plan-phase 生成 PLAN.md<br/>含 must_haves + threat_model]
    D --> E{plan-checker<br/>12 维度}
    E -- ISSUES FOUND --> F[planner 修订<br/>最多 3 轮]
    F --> E
    E -- 跨 AI 收敛 (可选) --> G[plan-review-convergence<br/>HIGH 收敛循环]
    G --> H[execute-phase<br/>wave 并行执行]
    H --> I[5.6 Post-merge build & test gate<br/>8 类项目自动检测]
    I -- 失败 --> J[修复或终止]
    I -- 成功 --> K[verifier agent<br/>4 层校验 + 反向溯源]
    K -- gaps_found --> L[diagnose-issues + plan-gap-closure<br/>planner-checker 收敛环]
    L --> H
    K -- passed/human_needed --> M[verify-work<br/>会话式 UAT]
    M -- 发现 issue --> L
    M --> N[secure-phase<br/>威胁注销 enforcing gate]
    N -- threats_open > 0 --> J
    N --> O[validate-phase<br/>Nyquist 测试覆盖]
    O --> P[code-review<br/>3 档深度 + --fix --auto]
    P -- --fix --auto --> Q[code-fixer<br/>worktree 隔离 + 3 层 verify + 原子 commit]
    Q --> P
    P --> R[ui-review / eval-review<br/>专项审查]
    R --> S[audit-uat<br/>跨 phase 收口 + stale 检测]
    S --> T[audit-milestone<br/>3 源交叉 + integration-checker]
    T -- gaps_found --> U[插入 closure phase]
    U --> H
    T --> V[complete-milestone<br/>归档 + tag]
    P -.独立调用.-> W[audit-fix<br/>分类 + 自动修复 + 测试 + 原子 commit]
```

**关键观察**：

1. **每一道门都对应一个 artifact 文件**（CONTEXT.md / PLAN.md / SUMMARY.md / VERIFICATION.md / SECURITY.md / VALIDATION.md / EVAL-REVIEW.md / UI-REVIEW.md / REVIEW.md / UAT.md / MILESTONE-AUDIT.md），这些 artifact 是后续门读取的输入，不依赖 LLM 上下文；
2. **多数门是 enforcing gate**（不是建议），代表门未通过则不能进入下一阶段（`secure-phase.md:125-134`、`audit-milestone.md:135-140`）；
3. **同样的"goal-backward"方法论被用在三个时间点**：plan-checker（执行前）、verifier（执行后）、audit-milestone（归档前），三层冗余；
4. **失败处理统一通过 planner-checker 收敛环**（`verify-work.md:611-666`、`plan-review-convergence.md:124-313`），上限 3 轮，超过即升级用户。

---

## 2. 需求完成度三道防线

### 2.1 discuss 阶段：先确认再做

GSD 把"和用户对齐"当成一个独立的 phase 步骤。它不在执行阶段问，而是把所有可能歧义提前榨干，写进 `CONTEXT.md`。

#### 灰区（gray area）识别

灰区不是泛指"还没想清楚的地方"，而是精确定义为**实现决策中用户在乎的、可能多种方向、改了就影响成品的点**（`discuss-phase.md:76-92`）。GSD 强制使用领域具体名词，不让 Claude 用"UI / UX / Behavior"这种笼统标签：

> Phase: "User authentication" → Session handling, Error responses, Multi-device policy, Recovery flow
> Phase: "Organize photo library" → Grouping criteria, Duplicate handling, Naming convention, Folder structure
> （`discuss-phase.md:81-89`）

灰区识别的算法（`discuss-phase.md:289-309`）：

1. 从 ROADMAP.md 提取 phase goal；
2. 扫码（scout_codebase）相关现有代码；
3. 读取**至多 3 个**最近的 prior CONTEXT.md，避免重复问已决策内容（`discuss-phase.md:228-262`）；
4. 对每个相关类别识别 1-2 个具体歧义；
5. 已被 prior decisions 解决的 → 标"pre-answered"；已被 SPEC.md 锁定的 → 跳过（`discuss-phase.md:303-305`）。

#### success_criteria 沉淀

成功判据来自三层：

1. **ROADMAP.md** `success_criteria` 数组——这是契约层（`gsd-verifier.md:114-122`），verifier 不允许 PLAN frontmatter 削减它；
2. **PLAN frontmatter** `must_haves: { truths, artifacts, key_links }`——这是计划层细化（`gsd-verifier.md:124-153`），可以**新增**但不能**减除** ROADMAP 的 SC；
3. **派生兜底**——如果两个都缺，verifier 用 phase goal 派生 3-7 个 observable, testable behaviors（`gsd-verifier.md:155-163`）。

#### scope 边界 enforce

`<scope_guardrail>`（`discuss-phase.md:56-74`）是硬约束：

> "[Feature X] would be a new capability — that's its own phase. Want me to note it for the roadmap backlog? For now, let's focus on [phase domain]."

启发式判定（`discuss-phase.md:63`）：**当前讨论是在澄清 phase 内 HOW，还是在加新 capability？** 后者必须挪到"Deferred Ideas"，不能偷偷做。

#### 用户决策被记录的方式

CONTEXT.md 包含 4 个段落（`discuss-phase.md:386-396`）：

| 段落 | 含义 | 下游谁读 |
|------|------|--------|
| `## Decisions` | 锁定决策（D-01, D-02, ...）| planner（必须实现）+ plan-checker（D-XX 必须出现在某个 task） |
| `## Claude's Discretion` | 自由发挥区 | planner（可任选方案） |
| `## Deferred Ideas` | 已记下但本 phase 不做 | plan-checker（绝不能出现在 plans 中） |
| `## Canonical Refs` | 用户引用的文档/ADR/SPEC，全相对路径 | 所有下游 agent |

**checkpoint 文件**（`discuss-phase.md:365`）：每个区域讨论完即写 `${phase_dir}/${padded_phase}-DISCUSS-CHECKPOINT.json`，会话中断可恢复。

### 2.2 plan-checker：计划完备性

`gsd-plan-checker` 是 GSD 体系最复杂的 agent，**12 个验证维度**（不是建议，是分级阻断器）。它在 PLAN.md 写完、execute-phase 启动前介入。

#### 12 个维度

| # | 维度 | 检测什么 | 严重度 |
|---|------|---------|--------|
| 1 | Requirement Coverage | 每个 ROADMAP requirement ID 是否被某个 plan 的 `requirements` frontmatter 字段声明 | BLOCKER 缺失 |
| 2 | Task Completeness | 每个 `<task>` 都有 Files + Action + Verify + Done | BLOCKER 缺字段 |
| 3 | Dependency Correctness | `depends_on` 无环、引用存在、wave 数与依赖一致 | BLOCKER 循环依赖 |
| 4 | Key Links Planned | artifacts 之间的 wiring（`from → to via`）有 task 实现 | WARNING |
| 5 | Scope Sanity | 单 plan ≤2-3 task，4 警告，5+ 阻断（强制拆分） | BLOCKER 5+ tasks |
| 6 | Verification Derivation | `must_haves.truths` 是用户可观察行为，不是实现细节（"密码安全" vs "bcrypt 已安装"） | WARNING |
| 7 | Context Compliance | locked decisions 100% 覆盖；deferred ideas 0 出现 | BLOCKER 违反 |
| **7b** | **Scope Reduction Detection** | 扫描 task action 中的"v1 / 简化版 / 静态先 / 未来增强 / placeholder / 太复杂" | **永远 BLOCKER**（`gsd-plan-checker.md:346-389`）|
| 7c | Architectural Tier Compliance | task 实现的 capability 是否落在 RESEARCH.md "Architectural Responsibility Map" 指定的 tier | 安全相关 BLOCKER，其他 WARNING |
| 8 | Nyquist Compliance | 每个 task 有 `<automated>` verify；watch mode 阻断；3 个连续无 automated 阻断 | BLOCKING FAIL |
| 9 | Cross-Plan Data Contracts | 多 plan 共享数据时的 transform 兼容性 | 不兼容 BLOCKER |
| 10 | CLAUDE.md Compliance | plans 是否违反项目 CLAUDE.md 的禁用模式 / 必须步骤 | 违禁 BLOCKER |
| 11 | Research Resolution | RESEARCH.md `## Open Questions` 必须以 `(RESOLVED)` 后缀结尾，每条问题有内联 RESOLVED 标记 | BLOCKER 未解 |
| 12 | Pattern Compliance | PATTERNS.md 中映射的每个新文件，PLAN.md action 是否引用对应 analog | WARNING |

#### 输入 / 输出

- 输入：`phase_dir`、所有 PLAN.md、CONTEXT.md（如存在）、RESEARCH.md（如存在）、PATTERNS.md（如存在）、ROADMAP.md、REQUIREMENTS.md、PROJECT.md（`gsd-plan-checker.md:643-729`）；
- 输出：两种结构化返回 `## VERIFICATION PASSED` 或 `## ISSUES FOUND`（带 YAML structured issues 列表，每条含 `dimension / severity / fix_hint`）（`gsd-plan-checker.md:875-933`）。

#### 失败了怎么办

`verify-work` 工作流的 `revision_loop`（`verify-work.md:611-666`）：

1. checker 返回 issues → 把结构化 issues 喂回 planner；
2. planner **目标性修订**（不是从头重写，`verify-work.md:640-642`）；
3. 再调 checker；
4. 上限 3 轮，超过则用户三选：force / 提供指导 / 放弃（`verify-work.md:656-665`）。

**Scope Reduction Detection 的关键创新**（`gsd-plan-checker.md:346-389`）：这是 GSD 真实事故反向沉淀的检查（CONTEXT.md D-26 要求"动态计算成本引用"，plan 写成"静态硬编码 v1，未连接计费表"——这种把用户决策悄悄缩水的行为永远 BLOCKER，不接受 warning 降级）。

### 2.3 verifier + verify-work：实施后核验

#### gsd-verifier：4 层校验 + 反向溯源

`gsd-verifier` 不读 SUMMARY.md（明令禁止信任 SUMMARY 的口头汇报，`gsd-verifier.md:21-22`），只看代码事实。它的方法论叫 **goal-backward**：

> 1. What must be TRUE for the goal to be achieved?
> 2. What must EXIST for those truths to hold?
> 3. What must be WIRED for those artifacts to function?
> （`gsd-verifier.md:60-69`）

**4 层校验**（`gsd-verifier.md:217-319`）：

| Level | 检查 | 状态映射 |
|-------|------|---------|
| 1 存在性 | 文件是否存在 | exists ∈ {true, false} |
| 2 实质性 | 文件不是 stub（有最小行数 / 关键 pattern） | issues empty? STUB / VERIFIED |
| 3 联通性 | 被 import + 被 use（不只是 import） | WIRED / ORPHANED / PARTIAL |
| **4 数据流** | **渲染动态数据的 artifact，数据源是否真的产生数据**（区分 fetch+静态兜底 vs 真实查询；区分硬编码 prop 传 `[]`） | **FLOWING / STATIC / DISCONNECTED / HOLLOW_PROP** |

Level 4 是最难得的（`gsd-verifier.md:264-319`）：它解决的是"看起来都连上了，但实际渲染空数据"的最大类型 stub。

**Step 7b 行为 spot-check**（`gsd-verifier.md:443-486`）：对可运行代码（API / CLI / 构建脚本），跑 2-4 个 ≤10s 的命令验证关键行为（API 返回非空、CLI 输出含期望字串、模块导出函数存在等）。

**Step 9b 推迟项过滤**（`gsd-verifier.md:521-548`）：不是所有 gap 都是 gap——如果某 gap 在后续 phase 的 goal/SC 中被显式覆盖，挪到 `deferred` 列表（不影响 status），保守匹配（不明确就当真 gap）。

**Step 3b 覆盖机制**（`gsd-verifier.md:184-215`）：允许 VERIFICATION.md frontmatter 添加 `overrides:` 字段（must_have + reason + accepted_by + accepted_at），verifier 用 80% token 重叠匹配，匹配上的项标 `PASSED (override)` 算入通过分。**这是不破坏 userspace 的关键设计**：用户认可的偏离不需要每次都失败。

#### gsd-verifier 输出契约

VERIFICATION.md frontmatter（`gsd-verifier.md:597-632`）包含：

```yaml
status: passed | gaps_found | human_needed
score: N/M
overrides_applied: 0
re_verification: { previous_status, gaps_closed, gaps_remaining, regressions }
gaps: [{ truth, status, reason, artifacts: [{path, issue}], missing: [...] }]
deferred: [{ truth, addressed_in, evidence }]
human_verification: [{ test, expected, why_human }]
```

**status 决策树**（最严格优先，`gsd-verifier.md:506-518`）：

1. 任意 truth FAILED / artifact MISSING/STUB / link NOT_WIRED / blocker anti-pattern → `gaps_found`
2. 否则有 human verification 项 → `human_needed`
3. 否则才是 `passed`——**human items 优先于 passed**，关键。

#### verify-work 编排哪些子门

`verify-work.md` 是用户跑 UAT 的入口，但它在内部串了一条完整的修复链（`verify-work.md:88-122` + 462-696`）：

1. **automated_ui_verification**：Playwright-MCP 可用时，自动跑 UI checkpoints，能自动判断的就免去手测；
2. **cold-start smoke test 注入**（`verify-work.md:157-168`）：发现 SUMMARY 涉及 `server.ts / app.ts / database/* / migrations/* / startup* / docker-compose*` 等冷启动相关路径，强制注入"杀进程 → 清临时态 → 冷启动 → 主查询返回数据"作为第一个测试。这是 GSD 的招牌——**只有冷启动才能暴露的 race condition / silent seed failures / 缺环境变量** 用这一步抓；
3. **session 持久化**：UAT.md 是带 frontmatter 的状态文件（`verify-work.md:181-228`），中断 /clear 后能恢复（`verify-work.md:343-360`）；
4. **自动 diagnose + plan_gap_closure**：用户报 issue 后**不问严重度，根据自然语言推断**（`verify-work.md:719-732`），并行 spawn debug agent 找根因，自动 spawn planner --gaps 模式生成修复计划，再 spawn plan-checker 验证修复计划，进入 max-3-loop 收敛环。

#### failure mode 处理

| 失败模式 | 处理 |
|---------|------|
| verifier 找出 gap | 写入 VERIFICATION.md frontmatter `gaps:` YAML 结构，供 `/gsd-plan-phase --gaps` 直接消费 |
| verifier 不能编程判定 | 标 `human_needed`，列出明确的 test / expected / why_human |
| UAT user 报 issue | 自动推断严重度，append 到 UAT.md `## Gaps` YAML 段，再走 diagnose → plan → checker 收敛 |
| 修复计划 3 轮不收敛 | 升级用户三选 |
| 阶段性 artifact 缺失 | `audit-milestone.md` 第 5e 节强制 fail：未验证 phase = blocker，orphan requirement = unsatisfied（`audit-milestone.md:135-140`）|

---

## 3. 代码质量五道防线

### 3.1 nyquist-auditor：深度审计 + 测试生成

Nyquist 取自信号采样定理——**采样频率必须高于变化频率才不会失真**。GSD 把它移植到测试覆盖：**每个需求必须有自动化测试，并且实施过程中"实施 task" 与"automated verify"穿插足够密**。

`gsd-nyquist-auditor` 不只是"打分"——它**会写测试**（`gsd-nyquist-auditor.md:84-95`）：

1. 读取 gap，识别可观察行为；
2. 按项目惯例（pytest/jest/vitest/go test）选 framework；
3. 生成**最小行为测试**，A/A/A 模式，行为命名（`test_user_can_reset_password`，禁止结构命名）；
4. 跑测试，失败进入 debug loop；
5. **debug 上限 3 次**（`gsd-nyquist-auditor.md:103-115`），且分类失败原因——assertion 失败但 actual 符合实现而违反需求 → 升级为 IMPLEMENTATION BUG，**绝不修改实现**（`gsd-nyquist-auditor.md:21-22`，明文规定 implementation files READ-ONLY）；
6. 三类返回：`GAPS FILLED` / `PARTIAL` / `ESCALATE`（`gsd-nyquist-auditor.md:127-188`）。

**对应深度的不同**：

- 普通 review：找问题，输出建议；
- nyquist-auditor：**遇到没测试的需求自动写测试并跑通**，写不通就升级而不软化结论。

**Wave 0 概念**（`gsd-plan-checker.md:474-478`）：测试可以作为 Wave 0 task 先创建，后续实现 task 引用同一文件路径。这让 TDD 模式可以在并行执行体系下成立。

### 3.2 code-review --fix 模式

#### 普通模式 vs --fix 模式

`code-review.md` 命令本身只产出 REVIEW.md（`code-review.md:1-30`），由 `gsd-code-reviewer` 写。但加 `--fix` flag 后，引入第二个 agent `gsd-code-fixer`（`code-review.md:25-28`）：

| 模式 | 行为 |
|------|------|
| 默认 | review → REVIEW.md（仅报告，人工修） |
| `--fix` | review → REVIEW.md → fixer 应用 Critical+Warning 修复 → REVIEW-FIX.md |
| `--fix --all` | 同上但纳入 Info 修复 |
| `--fix --auto` | **fix + re-review 迭代环，上限 3 轮** |

#### code-fixer 的工程级保护

`gsd-code-fixer` 是 GSD 整个体系工程实现最硬核的 agent。它的设计前提：**fixer 是后台进程，会做 commit**，必须不能撞上前台用户工作。具体（`gsd-code-fixer.md:212-356`）：

1. **强制 git worktree 隔离**：`mktemp -d "/tmp/sv-${padded_phase}-reviewfix-XXXXXX"` + 创建临时分支 `gsd-reviewfix/${padded_phase}-$$`，attach worktree 到该新分支（不能两个 worktree 同时 checkout 同一分支，#2990 真实 bug 反推）；
2. **Recovery sentinel**：worktree 创建成功后才写 `${phase_dir}/.review-fix-recovery-pending.json`，记录 `{worktree_path, branch, reviewfix_branch, padded_phase, started_at}`。任何中断（OOM/重启）下次运行能检测并清理；
3. **transactional cleanup tail**：四步严格顺序——`merge --ff-only` 主分支 → `worktree remove --force` → 临时分支 `branch -D`（仅 ff-only 成功才删） → `rm sentinel`。倒序就是 #2839 bug 重现；
4. **per-finding rollback** = `git checkout -- {file}`（绝不用 Write 工具回滚，部分写入会损坏文件，`gsd-code-fixer.md:62-91`）；
5. **3 层 verification**（`gsd-code-fixer.md:93-141`）：
   - Tier 1（必须）：重读修复区域、确认改动落地、周围未污染；
   - Tier 2（首选）：跑语法检查（node -c / tsc --noEmit / python ast.parse）；**关键工程细节**——只 fail 如果错误是修复后才出现的，pre-existing error 忽略；
   - Tier 3（兜底）：无 syntax checker 时接受 Tier 1；
   - **逻辑 bug 标记**：syntax 检查不能验证语义，逻辑类修复在 REVIEW-FIX.md 标 `"fixed: requires human verification"`；
6. **每个 finding 原子 commit**：`fix({padded_phase}): {finding_id} {short_description}`，多文件 finding 一次 commit 列全部路径。

#### 多轮收敛机制

`code-review.md --fix --auto` 触发的是 `code-review-fix.md` workflow（与本文 Tier 1 范围不重叠，但模型相同）：fixer 跑完 → re-review → 比对新 REVIEW.md，新增 finding 没下降则 stall 升级。**3 轮上限是 GSD 全体系的硬规约**（appears in plan-checker, verify-work, plan-review-convergence, code-review-fix）。

### 3.3 eval-review + eval-auditor

这是 AI 系统专用的元层审计。**评估方法本身被审计**——你定义了什么 eval 维度（faithfulness、hallucination、tone、safety），代码里到底实现了没。

`gsd-eval-auditor`（`gsd-eval-auditor.md`）：

1. 读取 AI-SPEC.md Sections 5-7（planned eval 策略）+ 所有 SUMMARY.md + PLAN.md；
2. 扫描代码（`gsd-eval-auditor.md:66-87`）：测试文件、tracing 工具（langfuse/langsmith/arize/phoenix/braintrust/promptfoo）、eval 库（ragas/braintrust）、guardrail 实现、引用数据集、CI/CD 配置；
3. 每个 dimension 评分 COVERED / PARTIAL / MISSING（`gsd-eval-auditor.md:90-100`）；
4. 5 个基础设施组件评分（tooling / dataset / cicd / guardrails / tracing）；
5. **加权分**：`overall = coverage × 0.6 + infra × 0.4`（`gsd-eval-auditor.md:111-123`）；
6. 4 档判决：80-100 PRODUCTION READY / 60-79 NEEDS WORK / 40-59 SIGNIFICANT GAPS / 0-39 NOT IMPLEMENTED。

**对抗立场**（`gsd-eval-auditor.md:19-33`）：典型软化失败模式被显式列出：
- "PARTIAL 而非 MISSING 因为有些测试存在"——批判：partial 覆盖关键 eval 维度仍是 MISSING，必须量化 gap；
- "metric logging = evaluation"——批判：要验证 logged metric 真的驱动决策；
- "AI-SPEC.md 文档算实现证据"——批判：文档是意图，代码是实现；
- "downgrade MISSING 为 PARTIAL 软化报告"——批判：评分必须基于事实而非情绪。

`gsd-eval-planner`（`gsd-eval-planner.md`）是配套的——它在 `/gsd-ai-integration-phase` 时写 AI-SPEC.md 的 eval section（rubric / tooling / dataset / guardrails），auditor 才有契约可对照。这是元层："设计 eval 的人 + 审计 eval 的人 + 用 eval 的代码"三方分立。

### 3.4 secure-phase / security-auditor

#### 触发与 enforcing gate

`secure-phase.md` 是 enforcing gate（`secure-phase.md:125-134`）：

> ENFORCING GATE: If `threats_open > 0` after all options exhausted ... GSD > PHASE {N} SECURITY BLOCKED ... Do NOT emit next-phase routing. Stop here.

唯一关闭方式：要么修缓解措施再跑，要么把威胁文档化为"accepted risk"放进 SECURITY.md 的 accepted risks 段。

#### 检测什么

`gsd-security-auditor`（`gsd-security-auditor.md`）的关键设计：**它不扫漏洞，它验证 PLAN.md `<threat_model>` 中声明的每个威胁是否真有缓解**。三类 disposition（`gsd-security-auditor.md:62-71`）：

| Disposition | 验证方法 |
|------------|---------|
| `mitigate` | grep 缓解 pattern 出现在 mitigation_plan 引用的文件 |
| `accept` | SECURITY.md 的 accepted risks 段是否有该条目 |
| `transfer` | 是否有 transfer 文档（保险/供应商 SLA） |

**对抗立场**（`gsd-security-auditor.md:24-38`）：
- "单个 grep 命中算缓解"——批判：要检查 ALL entry points；
- "transfer 当作不关我们事"——批判：必须验证 transfer 文档存在；
- "SUMMARY.md `## Threat Flags` 是新威胁的全集"——批判：还要扫实施期间引入的 unregistered_flag。

#### 与普通 review 的层级关系

| 层 | 关注 | 时机 |
|----|------|------|
| code-review | 通用 bug + 安全反模式（grep eval/innerHTML/SQL 注入 pattern） | phase 完成后（深度可调） |
| security-auditor | **PLAN 声明威胁的实施验证**（契约层） | secure-phase 命令 |
| ui-auditor 的 registry safety（`gsd-ui-auditor.md:277-325`） | 第三方 shadcn block 是否引入恶意 pattern（fetch / process.env / eval / new Function / 动态 import） | UI review |

**三者非冗余**：code-review 找通用问题，security-auditor 验契约，ui-auditor 防供应链。CCG 当前只有一层 verify-security。

### 3.5 audit-fix / audit-milestone / audit-uat

#### 三个 audit 的职责切分

| 命令 | 时机 | 输入 | 输出 | 干什么 |
|------|------|------|------|--------|
| `audit-uat` | 任意时刻（批量盘点） | 所有 phase 的 UAT.md + VERIFICATION.md | UAT 审计报告 | 跨 phase 找未完成 / blocked / human_needed / stale 项，按 testable / 需前置条件 / 已过时分组，输出"人工 UAT 测试计划" |
| `audit-fix` | UAT 审计后 | audit-uat 的输出 | 自动修复报告 | 把 finding 分类 auto-fixable / manual-only / skip，对 auto-fixable spawn executor 自动改、跑测试、原子 commit；测试失败立即 stop pipeline（不继续）；commit 信息**必须含 finding ID** F-01/F-02 |
| `audit-milestone` | 归档前 | 所有 phase VERIFICATION.md + REQUIREMENTS.md + integration-checker | MILESTONE-AUDIT.md | **3-source cross-reference**：traceability 表 / VERIFICATION 状态 / SUMMARY frontmatter `requirements-completed`，按矩阵决定每个 REQ-ID 最终状态；orphan 检测；硬性 fail gate |

#### audit-fix 的关键工程细节（`audit-fix.md:93-143`）

1. **分类启发式倾向 manual-only**（`audit-fix.md:73`）："When uncertain, always classify as manual-only"——保守原则；
2. **测试失败立即停 pipeline**（`audit-fix.md:136-143`）：不像普通 fixer 跳到下一项，audit-fix 一失败全停，因为代码可能已被破坏，继续会引发级联问题；
3. **commit ID 强制 traceability**：commit message 必须含 finding ID，事后可反查每个修复的来源；
4. **--dry-run 输出分类表**（`audit-fix.md:88-91`）：可单独跑分类，作为人工评审依据，不动代码。

#### audit-milestone 的 3-source cross-reference（`audit-milestone.md:97-140`）

最严的需求完成度审计。每个 REQ-ID 的最终状态由以下矩阵决定：

| VERIFICATION.md 状态 | SUMMARY frontmatter | REQUIREMENTS.md `[x]/[ ]` | 最终状态 |
|---------------------|---------------------|---------------------------|---------|
| passed | listed | `[x]` | **satisfied** |
| passed | listed | `[ ]` | **satisfied**（自动 update checkbox） |
| passed | missing | any | **partial** （需要人工核） |
| gaps_found | any | any | **unsatisfied** |
| missing | listed | any | **partial**（验证 gap） |
| missing | missing | any | **unsatisfied** |

**FAIL gate**（`audit-milestone.md:135`）："Any unsatisfied requirement MUST force gaps_found status on the milestone audit."

**Orphan detection**（`audit-milestone.md:139`）：traceability 表里有但任何 phase VERIFICATION 都没出现的 REQ-ID = orphaned，被分配但从没被验证，直接当 unsatisfied。

---

## 4. plan-review-convergence（多轮收敛）

这是 GSD 的高级特性，需要 `workflow.plan_review_convergence=true` 配置才能用（`plan-review-convergence.md:43-60`）。

#### 解决什么问题

普通 plan-checker 已经有 max-3-loop，但**它是同一个 model 自审**。plan-review-convergence 把审查者换成**外部 AI CLI**（codex / gemini / claude / opencode / ollama / lm-studio / llama-cpp / `--all`，`plan-review-convergence.md:25-49`），用跨 AI 反馈消除 anchoring bias。

orchestrator 的角色（`plan-review-convergence.md:24`）：only does init / config gate / loop control / parse CYCLE_SUMMARY for HIGH count / stall detection / escalation。

#### 几轮 / 终止条件

- 默认 `--max-cycles 3`（`plan-review-convergence.md:36`）；
- 终止条件 #1：**HIGH count == 0**（converged，`plan-review-convergence.md:213-232`）；
- 终止条件 #2：**HIGH count >= prev_high_count**（stall，`plan-review-convergence.md:240`）；
- 终止条件 #3：达到 max cycles，用户三选 force / manual review / 退出。

#### 每轮做什么

每轮（`plan-review-convergence.md:124-313`）：

1. **5a. Review**：spawn Agent → Skill('gsd-review' + reviewer flags)。**关键契约**：review agent 必须返回 `CYCLE_SUMMARY: current_high=<N>`（机器可读）+ `## Current HIGH Concerns` 段（人类可读，列每个未解 HIGH）；
2. **5b. Extract HIGH count**：**禁止 grep REVIEWS.md**——它跨 cycle 累积历史，已解 HIGH 残留会虚增 count 导致假 stall。从 agent 返回消息提取（`plan-review-convergence.md:185-211`）；
3. **5c. Stall + max check**：HIGH 不下降 = stall；
4. **5d. Replan**：spawn Agent → Skill('gsd-plan-phase --reviews --skip-research')，把 review 反馈喂回 planner，planner 修订；
5. 回到 5a。

#### 收敛判定

`CYCLE_SUMMARY: current_high=<N>` 的计数规则（`plan-review-convergence.md:154-168`）严格定义：

INCLUDE（计入）：
- 本轮新增 HIGH
- **PARTIALLY RESOLVED**：已认知缓解中但未验证完成
- 之前轮的 HIGH 仍未解

EXCLUDE（不计）：
- **FULLY RESOLVED**：缓解 + 验证完成（关闭工单 / 验证日志 / 评审签字）
- 比较表里的 HIGH 提及
- 引用历史 review 的 quote

收敛 = `HIGH_COUNT == 0`，无 partial（partial 也算未解）。

---

## 5. post-merge build & test gate

`execute-phase.md:813-885` 调用 `execute-phase/steps/post-merge-gate.md`。它在每个 wave 全部 worktree 合并后跑（parallel mode）或最后一个 plan 完成后（serial mode）。

#### 8 类项目类型自动检测顺序

`post-merge-gate.md` 的 build 命令决议（`post-merge-gate.md:8-39`）：

| 顺序 | 判据 | 命令 |
|------|------|------|
| 1（最优）| `gsd-sdk query config-get workflow.build_command` 已配置 | 用配置 |
| 2 | `*.xcodeproj` 存在 | `xcodebuild build -scheme '<scheme>' -destination 'platform=iOS Simulator,name=iPhone 16'`（用 `xcodebuild -list -json` 自动取首个 scheme） |
| 3 | `Makefile` 含 `^build:` target | `make build` |
| 4 | `Justfile` / `justfile` | `just build` |
| 5 | `Cargo.toml` | `cargo build` |
| 6 | `go.mod` | `go build ./...` |
| 7 | `pyproject.toml` 或 `requirements.txt` | `python -m py_compile <find py 文件>` |
| 8 | `package.json` 含 `"build"` script | `npm run build` |
| 兜底 | 都未命中 | `BUILD_CMD=""`，跳过 build gate（warning） |

test 命令决议（`post-merge-gate.md:62-95`）几乎对称，但第 8 类直接 `npm test`（无需 script 检测），Python 跑 `python -m pytest -x -q --tb=short` 或降级 `uv run python -m pytest`。

#### 每类的检测条件

每个判据都是**文件存在 + 关键 pattern grep**（不是只看文件名），例如 `Makefile` 必须 `grep -q "^test:"`，避免空 Makefile 触发 false positive。

#### 失败处理

- `BUILD_EXIT=0`（pass）→ 进 test gate；
- `BUILD_EXIT=124`（timeout，5 分钟硬上限）→ warning，**继续**进 test gate（非阻塞）；
- 其他非零 → `WAVE_FAILURE_COUNT++`，呈现失败输出，AskUserQuestion "Fix now / Continue"；
- test gate 同样三档处理。

`execute-phase.md:835-851` 关键设计：**只有 TEST_EXIT=0 才更新 plan 完成状态**。timeout 和 failure 都让 plan 留在 in-progress，**绝不在测试失败下推进 wave**：

```
# Guard: only update tracking if post-merge tests passed
if [ "${TEST_EXIT}" -eq 0 ]; then
  ...mark complete
elif [ "${TEST_EXIT}" -eq 124 ]; then
  echo "⚠ Skipping tracking update — test suite timed out"
else
  echo "⚠ Skipping tracking update — post-merge tests failed"
fi
```

#### 串行 vs 并行模式的差异

- **并行（worktree）**：每个 plan 在独立 worktree 跑自己的 self-check，全部 self-check pass 后合并 wave，post-merge gate 才能抓出"独立 pass 但合并冲突"的问题（`execute-phase.md:881-886`）：

> Worktree isolation means each agent's Self-Check passes in isolation. But when merged, add/add conflicts in shared files (models, registries, CLI entry points) can silently drop code. The post-merge gate catches this before the next wave builds on a broken foundation.

- **串行**：post-merge gate 仍在最后一个 plan 完成后跑一次，确保最终聚合状态可构建可测试。

---

## 6. CCG v3.0.0 质量体系现状

CCG 当前的质量门组件（`templates/skills/tools/` + `templates/commands/agents/` + `templates/commands/`）：

| CCG 组件 | 文件 | 职责 |
|---------|------|------|
| `verify-change` skill | `templates/skills/tools/verify-change/` | git diff 分析 + 文档同步检测 |
| `verify-quality` skill | `templates/skills/tools/verify-quality/` | 复杂度 / 重复 / 命名 |
| `verify-security` skill | `templates/skills/tools/verify-security/` | OWASP / 注入 / 敏感信息 |
| `verify-module` skill | `templates/skills/tools/verify-module/` | 模块结构完整性 |
| `verify-work` 命令（编排） | `templates/commands/verify-work.md` | 4 子门 + verifier agent，按变更性质决策矩阵选门 |
| `verifier` agent | `templates/commands/agents/verifier.md` | 三层校验 + 8 类项目构建测试 |
| `nyquist-auditor` agent | `templates/commands/agents/nyquist-auditor.md` | （存在但 v3.0.0 specialist） |
| `integration-checker` agent | `templates/commands/agents/integration-checker.md` | 跨模块集成 |
| `eval-auditor` agent | `templates/commands/agents/eval-auditor.md` | AI 评估审计 |
| `assumptions-analyzer` agent | `templates/commands/agents/assumptions-analyzer.md` | 假设结构化（需求阶段） |
| `framework-selector` / `pattern-mapper` agent | 同目录 | 框架/模式选择 |
| `/ccg:review` 命令 | `templates/commands/review.md` | 双模型代码审查（含 `--adversarial` flag 推测） |
| `/ccg:enhance` 命令 | `templates/commands/enhance.md` | 模糊需求 → 结构化任务（需求侧） |
| `/ccg:spec-research/plan/impl/review` 系列 | `templates/commands/spec-*.md` | OPSX 封装 |
| `/ccg:context` 命令 | `templates/commands/context.md` | 决策日志归档 |

#### 功能完整度对照表

| CCG 现有 | 对应 GSD | 完整度 | 缺什么 |
|---------|---------|--------|--------|
| `verify-change` | （GSD 没有等价独立 skill；嵌入在 verifier 的 Step 7 anti-patterns 扫描）| 7/10 | GSD 把变更分析嵌进 verifier 主流程，CCG 单独 skill 简洁但缺与 must_haves 的 binding |
| `verify-quality` | （GSD 没有显式等价）| 8/10 | GSD 这块由 code-review 的 standard / deep depth 承担，CCG 独立更清晰，但缺**深度可配置**（quick/standard/deep） |
| `verify-security` | secure-phase + security-auditor | **5/10** | 缺**契约层验证**：CCG 当前是漏洞扫描，GSD 是验证 PLAN.md 声明威胁是否被缓解（disposition: mitigate/accept/transfer），缺 enforcing gate 阻断推进 |
| `verify-module` | （独立设计）| 8/10 | GSD 没有此层，CCG 这块更完善 |
| `verify-work` 编排器（v3.0.0 新）| `verify-work.md` workflow | **6/10** | 缺：(1) **会话式 UAT**（show expected, ask if matches）；(2) **cold-start smoke 注入**；(3) **session 持久化 UAT.md** 跨 /clear 恢复；(4) **自动 diagnose → plan_gap_closure → checker 收敛环**；(5) **Playwright-MCP 自动 UI 验证** |
| `verifier` agent + 8 类构建检测门 | `gsd-verifier` agent | **7/10** | 已有 4 层校验思想 + 8 类构建检测，已经接近；缺：(1) **Level 4 数据流追踪**（区分 fetch 真返回 vs 静态兜底 vs 硬编码 prop）；(2) **Step 9b deferred items 过滤**（gap 在后续 phase 覆盖时不算 gap）；(3) **Step 3b override 机制**（VERIFICATION.md frontmatter overrides）；(4) **goal-backward 的 must_haves frontmatter 输入契约**（artifacts: [{path, provides, min_lines}], key_links: [{from, to, via}]） |
| `nyquist-auditor` agent | `gsd-nyquist-auditor` | **5/10** | CCG 有 agent 但**不会写测试**，GSD 会自动生成 + 跑通 + 失败升级（implementation files READ-ONLY）；缺 Wave 0 概念 |
| `integration-checker` agent | `gsd-integration-checker` | 7/10 | 大体一致；GSD 多了 **Requirements Integration Map**（每个 REQ-ID 的跨 phase 接线状态） |
| `eval-auditor` agent | `gsd-eval-auditor` | 7/10 | 大体一致；GSD 配套有 `gsd-eval-planner` 在 ai-integration-phase 写 AI-SPEC.md eval section，CCG 缺这个**配套规划层**——没有 spec 就没有契约可对照 |
| `/ccg:review` 双模型审查 | `code-review.md` | **5/10** | 缺：(1) `--depth=quick/standard/deep`（CCG 是模型差异，不是审查深度差异）；(2) **`--fix` 模式 + gsd-code-fixer**（worktree 隔离 + 3 层 verify + 原子 commit + transactional cleanup + recovery sentinel）；(3) **`--auto` 多轮收敛**；(4) **输出严格 frontmatter 契约**（status / files_reviewed / findings counts），CCG 是模型自由叙述 |
| `/ccg:enhance` 命令 | `discuss-phase.md` | **3/10** | enhance 只做"模糊→结构"的一次性增强，缺：(1) **灰区识别算法**（领域具体名词，禁通用类别）；(2) **prior CONTEXT.md / DECISIONS-INDEX 加载避免重问**；(3) **scope creep 自动捕获到 Deferred Ideas**；(4) **CONTEXT.md 4 段结构**（Decisions / Discretion / Deferred / Canonical Refs）下游消费；(5) **DISCUSS-CHECKPOINT.json 中断恢复** |
| `/ccg:spec-research/plan/impl/review` | （类似但 spec 走 OPSX 路线） | 6/10 | OPSX 提供了完整 SPEC 流程，但缺 **plan-checker 12 维度** 的等价物（特别是 Scope Reduction Detection 7b、Architectural Tier 7c、Pattern Compliance 12）和 **plan-review-convergence** 跨 AI 收敛 |
| post-merge build & test gate | `post-merge-gate.md` | **8/10** | CCG verifier 的 8 类构建检测已经覆盖项目类型，缺：(1) **timeout=124 视为非阻塞**而不是 fail；(2) **wave-level WAVE_FAILURE_COUNT 累计跨 wave 报告**；(3) "Fix now / Continue" 用户交互而不是直接 fail |

**总评**：CCG 在"组件"层已经有 70% 同类产物，但在"工程级保护"和"契约结构化"两块明显落后：
- 工程级保护：worktree 隔离 + recovery sentinel + transactional cleanup + 多轮收敛 + 3 层 verify Tier 几乎都缺；
- 契约结构化：frontmatter YAML 输入输出契约（must_haves / threats / overrides / gaps / deferred）几乎全缺，CCG 的 agent 多依赖模型自由叙述，下游不可机器消费。

---

## 7. 需求完成度对照

GSD 的需求完成度三段（discuss + plan-checker + verifier+verify-work）与 CCG 现状：

#### CCG 同类组件

| GSD | CCG 同类 | 同 / 异 |
|-----|---------|---------|
| `discuss-phase` 灰区识别 | `/ccg:enhance` | **不同**：enhance 是单次"模糊→结构"，没有"识别多个灰区→选择讨论→记决策→中断恢复→拒绝 scope creep"完整流程 |
| `discuss-phase` 加载 prior CONTEXT.md / DECISIONS-INDEX | `/ccg:context log` | **不同**：context log 是被动归档，没有主动加载历史决策避免重问的机制 |
| `discuss-phase` SPEC.md 锁定后跳过 WHAT-only 类灰区 | `/ccg:spec-research → spec-plan` | 部分**相同**：spec 流程通过 OPSX 锁需求，但 spec-plan 没有显式"locked req 不再问 WHAT 类灰区"的指令 |
| `gsd-plan-checker` 12 维度 | （CCG 没有完整等价） | **缺失**：CCG `/ccg:spec-plan` 多模型分析后没有结构化 verification 阶段，issue 反馈不进收敛环 |
| `gsd-verifier` goal-backward + 4 层 | `verifier` agent | **接近但不到位**：CCG verifier 有三层（存在/实质/联通）+ 数据流意识，但缺 Level 4 严格区分 + Step 3b override + Step 9b deferred + frontmatter 契约 |
| `verify-work` 会话式 UAT + 自动 diagnose+plan-fix 收敛 | `/ccg:verify-work` 编排 | **缺失**：CCG 编排只调子门，没有用户对话流，也没有 issue → diagnose → plan-fix → checker 自动收敛 |

#### 还差什么

3 个"完整防线"中：

1. **discuss 阶段防线**：CCG 几乎没有 — `/ccg:enhance` 只触及表面；
2. **plan-checker 防线**：CCG 几乎没有 — spec-plan 流程缺结构化检查；
3. **verifier+verify-work 防线**：CCG 已 70% 完成，但缺会话式 UAT、cold-start smoke、自动 diagnose-plan-fix 收敛。

最大缺口：**plan-checker 等价物**。这是 GSD 体系最技术性的部分，也是 CCG 现在完全空缺的部分。Scope Reduction Detection（7b）、Context Compliance（7）、CLAUDE.md Compliance（10）、Research Resolution（11）、Pattern Compliance（12）这些维度，CCG 的多模型审查没有任何对应物——它们检测的是"plan 是否在偷工减料 / 是否违反用户决策 / 是否遗漏研究问题 / 是否遵守已有模式"，全是需求完成度的硬骨头。

---

## 8. ROI 排序：移植到 CCG 的最高价值 5 项

按"用户痛点 / 实施成本 / 风险"综合评估：

### 第 1 项：Scope Reduction Detection（plan-checker 维度 7b）

- **GSD 实现位置**：`gsd-plan-checker.md:346-389`（Dimension 7b）
- **用户痛点对应**：✅ "scope 被偷偷砍 / 灰区被自动决定" — 这条**正中**，GSD 这条规则就是从真实事故反推的（D-26 静态硬编码 v1 事件）
- **CCG 移植路径**：
  - 在 `templates/commands/agents/team-reviewer.md` 或 `templates/commands/spec-plan.md` 里，加一条扫描规则：plan 输出文本中扫描"v1 / v2 / 简化 / 静态先 / 未来增强 / placeholder / 太复杂 / 太困难 / 暂时硬编码 / 后续连接 / 不连接"等关键词；
  - 命中后交叉对比对应的 SPEC.md / ENHANCE 输出的需求条目，判断是否削减；
  - 命中即 BLOCKER（不接受 warning 降级），输出选项："完整实现 / 拆分阶段（建议分组）"
- **最小路径成本**：约 80-120 行 prompt 修改，无新文件
- **风险**：可能对合理的"v1 渐进交付"误报。缓解：要求扫描结果与原始需求条目做对比才阻断，纯关键词不阻断
- **完整度评分提升**：spec-plan 5/10 → 7.5/10

### 第 2 项：会话式 UAT + cold-start smoke + 自动 diagnose-plan-fix 收敛

- **GSD 实现位置**：`verify-work.md:88-168, 462-696`
- **用户痛点对应**：✅ "实现了但漏了边角" + ✅ "看起来对但有边界 bug" — UAT 的"show expected, ask if matches"模式是抓边角 case 最有效的；cold-start smoke 专抓"环境正常时跑通但全新启动崩溃"
- **CCG 移植路径**：
  - 改造 `templates/commands/verify-work.md`：从纯编排器变成有 UAT.md 状态文件的会话工作流；
  - 加 cold-start smoke 注入逻辑：扫 git diff / 修改文件，命中 server.ts/database/migrations/startup/docker-compose 等即注入"杀进程 → 清临时态 → 冷启动 → 主查询非空"测试；
  - 加 issue → diagnose（spawn 子 agent 找根因）→ planner gaps mode（spawn 子 agent 写修复计划）→ plan-checker（验证修复计划）→ max-3-loop 收敛环
- **最小路径成本**：约 300-500 行（新写整个 UAT.md template + 工作流），需要 verifier agent 配套支持 frontmatter `gaps:` YAML
- **风险**：会话式 UAT 在 codeagent-wrapper 体系下需要适配（GSD 用 AskUserQuestion，CCG 需要简化为消息往返）。缓解：CCG 自己已有 `--text` 模式经验，沿用即可
- **完整度评分提升**：verify-work 6/10 → 9/10

### 第 3 项：code-review --fix --auto 模式 + worktree 隔离 + transactional cleanup

- **GSD 实现位置**：`gsd-code-fixer.md:212-356`（worktree 隔离 + recovery sentinel + transactional cleanup） + `code-review.md:25-28`（CLI flags）
- **用户痛点对应**：✅ "看起来对但有边界 bug" + ✅ "测试通过但功能错" 的修复闭环 — review 找出问题后**自动改 + 测试 + 多轮收敛**才是解决方案，不止给报告
- **CCG 移植路径**：
  - 在 `templates/commands/review.md` 加 `--fix` flag（仅修 Critical+Warning） + `--all`（含 Info） + `--auto`（多轮收敛）；
  - 新建 `templates/commands/agents/code-fixer.md` agent，包含 worktree 隔离、3 层 verify Tier、per-finding rollback、原子 commit；
  - **重头**：transactional cleanup tail 4 步顺序 + recovery sentinel 设计（非常工程化，不能简化）
- **最小路径成本**：约 600-900 行（worktree 部分必须按 GSD 那样工程化，否则会撞前台用户）
- **风险**：worktree 兼容性问题（git submodule、detached HEAD、Windows 路径）。缓解：直接照抄 GSD 的处理逻辑（GSD 已踩过 #2686 #2839 #2990 三个真实 bug）
- **完整度评分提升**：/ccg:review 5/10 → 8/10

### 第 4 项：plan-checker 等价物（多维度 plan 验证 + 结构化 issue 反馈到 planner-checker 收敛环）

- **GSD 实现位置**：`gsd-plan-checker.md:103-641`（12 维度） + `verify-work.md:611-666`（收敛环模式）
- **用户痛点对应**：✅ "scope 被偷偷砍" + ✅ "实现了但漏了边角" 的**预防**——在 plan 阶段就杜绝
- **CCG 移植路径**：
  - 新建 `templates/commands/agents/plan-checker.md`（命名 ccg-plan-checker），定义验证维度——可分级移植：先实现 Dimension 1（Requirement Coverage）+ 2（Task Completeness）+ 5（Scope Sanity）+ 7b（Scope Reduction Detection）+ 10（CLAUDE.md Compliance），覆盖痛点最大的 5 维度；
  - 改造 `/ccg:spec-plan` 或 `/ccg:plan` 在生成计划后自动 spawn plan-checker；
  - 实现 max-3-loop revision 环（GSD 通用模式，可参考 `verify-work.md:611-666` 直接套用）
- **最小路径成本**：约 500-800 行（agent prompt + workflow 改造）
- **风险**：12 维度全做太重，建议先 5 维度增量。Dimension 8（Nyquist）需要 RESEARCH.md，Dimension 12（Pattern）需要 PATTERNS.md，CCG 暂无这两类 artifact，跳过
- **完整度评分提升**：spec-plan 5/10 → 8/10

### 第 5 项：verifier 升级（Level 4 数据流追踪 + override 机制 + deferred items 过滤）

- **GSD 实现位置**：
  - Level 4 数据流：`gsd-verifier.md:264-319`
  - Step 3b override：`gsd-verifier.md:184-215`
  - Step 9b deferred filtering：`gsd-verifier.md:521-548`
- **用户痛点对应**：✅ "测试通过但功能错" 中的硬骨头 — UI 渲染空数据、prop 硬编码 `[]`、fetch 静态兜底 → Level 4 直接抓；override 让"用户认可的偏离"不需要每次重报；deferred filtering 避免把后续 phase 的 gap 算到当前 phase
- **CCG 移植路径**：
  - 升级 `templates/commands/agents/verifier.md` 已有的 3 层校验为 4 层，重点加数据流追踪：识别动态渲染 artifact（含 useState/useQuery）→ 追溯数据源 → 检查 API 真返回数据 vs 静态兜底 → 检查 prop 硬编码空值；
  - 加 override 解析：读取 `.context/verifications/<...>.md` frontmatter 的 `overrides:`，80% token 重叠匹配，命中标 PASSED (override)；
  - 加 deferred 过滤：读取 ROADMAP / TODO / 后续阶段计划文件，对识别到的 gap 做关键词匹配，命中即标 deferred 不算 gap
- **最小路径成本**：约 200-300 行 prompt 增强
- **风险**：Level 4 数据流追踪需要语言特异 grep pattern（React/Vue/Angular），多语言项目需要扩展。缓解：先 React/Vue 两个最常见栈
- **完整度评分提升**：verifier 7/10 → 9/10

---

#### 综合排序（最终建议）

| Rank | 项目 | 痛点对应 | 实施周期 | 收益 |
|------|------|---------|---------|------|
| #1 | Scope Reduction Detection | scope 被偷偷砍 ★★★ | 0.5 天 | 高 |
| #2 | 会话式 UAT + cold-start smoke + 自动收敛环 | 漏边角 + 边界 bug ★★★ | 2-3 天 | 高 |
| #3 | code-review --fix --auto + worktree | 边界 bug 闭环修复 ★★ | 3-4 天 | 高 |
| #4 | plan-checker 等价物（5 维度增量） | scope 偷砍预防 ★★★ | 2 天 | 高 |
| #5 | verifier Level 4 + override + deferred | 测试通过但功能错 ★★ | 1 天 | 中 |

如果用户只能拿一项最快价值，我会选 **#1 Scope Reduction Detection**——0.5 天工作量，一行加进 `team-reviewer.md` 或 `spec-plan.md` 的扫描规则，命中 BLOCKER。这条规则正中"scope 被偷偷砍"这条用户痛点的核心。

如果用户能投 1 周，则 **#1 + #4** 形成完整的"plan 阶段防线"——预防比补救成本低一个数量级。

如果用户能投 2-3 周，**#1 + #4 + #2** 把"plan 防线"和"verify 防线"都补齐，剩下 **#3 + #5** 是锦上添花。
