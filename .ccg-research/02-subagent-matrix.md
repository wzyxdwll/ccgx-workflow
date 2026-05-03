# GSD Subagent 矩阵（33 个）

> 文件目的：把 GSD 33 个 `gsd-*` subagent 拆开做事实归档，搞清楚每个的职责边界、调用上下文、产出契约，并对照 CCG 当前 15 个 agent 找出可移植目标。
>
> 数据基线：`D:\workflow\get-shit-done\agents\gsd-*.md`（33 个 frontmatter + 头部段落）；调用方扫自 `D:\workflow\get-shit-done\get-shit-done\workflows\*.md` 与 `D:\workflow\get-shit-done\commands\gsd\*.md`。
>
> 不写代码、不给改进建议——只做事实归档。

---

## 1. 总览表（按职能分类）

### 1.1 Research / Mapping（探索、映射）— 9 个

| Agent name | 职能定位（一句话） | 主要 tools | 调用方 | 读取的状态文件 | 产出 |
|---|---|---|---|---|---|
| gsd-codebase-mapper | 按 focus（tech/arch/quality/concerns）扫码库写 6 类分析文档 | Read, Bash, Grep, Glob, Write | `map-codebase.md`、`scan.md`、`execute-phase\steps\codebase-drift-gate.md` | （无强依赖） | `.planning/codebase/STACK.md` 等 6 文件 |
| gsd-pattern-mapper | 把"待新建文件"映射到"最像的现有代码" | Read, Bash, Glob, Grep, Write | `plan-phase.md` 第 743 行 | CONTEXT.md / RESEARCH.md | `.planning/phases/N/PATTERNS.md` |
| gsd-phase-researcher | 单 phase 技术调研，写 RESEARCH.md 给 planner | Read, Write, Bash, Grep, Glob, WebSearch, WebFetch, context7, firecrawl, exa | `plan-phase.md:428`、`explore.md:65`、`quick.md:440` | ROADMAP.md 当前 phase | `.planning/phases/N/RESEARCH.md` |
| gsd-project-researcher | 项目立项时的 4 维并行调研（stack/features/arch/pitfalls） | Read, Write, Bash, Grep, Glob, WebSearch, WebFetch, context7, firecrawl, exa | `new-project.md`（4 路并行）、`new-milestone.md` | （新项目无前置） | `.planning/research/{STACK,FEATURES,ARCHITECTURE,PITFALLS}.md` |
| gsd-research-synthesizer | 把 4 路研究产出合成 SUMMARY.md | Read, Write, Bash | `new-project.md:943`、`new-milestone.md:359` | 4 个 research .md | `.planning/research/SUMMARY.md` |
| gsd-advisor-researcher | 单一灰区决策的对比表 + 推荐 | Read, Bash, Grep, Glob, WebSearch, WebFetch, context7 | `discuss-phase\modes\advisor.md`（每灰区一份） | （由 prompt 注入） | 结构化 markdown 块返回主线 |
| gsd-assumptions-analyzer | 单 phase 的代码库假设分析 + 证据 | Read, Bash, Grep, Glob | `discuss-phase-assumptions.md:257` | ROADMAP.md / 历史 CONTEXT.md | 结构化假设清单返回主线 |
| gsd-domain-researcher | AI 系统的业务领域专家视角调研 | Read, Write, Bash, Grep, Glob, WebSearch, WebFetch, context7 | `ai-integration-phase.md` | AI-SPEC.md / CONTEXT.md / REQUIREMENTS.md | AI-SPEC.md §1b |
| gsd-ui-researcher | 前端 phase 的设计契约 UI-SPEC.md | Read, Write, Bash, Grep, Glob, WebSearch, WebFetch, context7, firecrawl, exa | `ui-phase.md:161` | REQUIREMENTS.md / CONTEXT.md | `.planning/phases/N/UI-SPEC.md` |

### 1.2 Planning（规划、roadmap）— 4 个

| Agent name | 职能定位 | 主要 tools | 调用方 | 读取的状态文件 | 产出 |
|---|---|---|---|---|---|
| gsd-roadmapper | 需求 → phase 结构 + 成功判据 + STATE.md | Read, Write, Bash, Glob, Grep | `new-project.md:1160/1248`、`new-milestone.md:493`、`ingest-docs.md:249` | REQUIREMENTS.md / SUMMARY.md | ROADMAP.md / STATE.md |
| gsd-planner | phase → PLAN.md（任务分解 + 依赖 + 可执行波次） | Read, Write, Bash, Glob, Grep, WebFetch, context7 | `plan-phase.md:874/930/974/1247`、`quick.md:498/611`、`verify-work.md:548/645` | CONTEXT.md / RESEARCH.md / PATTERNS.md | `.planning/phases/N/PLAN.md` |
| gsd-eval-planner | AI phase 的评估策略 + 守护栏 + 监控 | Read, Write, Bash, Grep, Glob, AskUserQuestion | `ai-integration-phase.md` | AI-SPEC.md（§1/1b/2/3-4）+ CONTEXT.md | AI-SPEC.md §5–§7 |
| gsd-framework-selector | ≤6 题决策矩阵选 AI 框架 | Read, Bash, Grep, Glob, WebSearch, AskUserQuestion | `ai-integration-phase.md`、`/gsd-select-framework` | （codebase 信号扫描） | 结构化推荐返回主线 |

### 1.3 Execution（实施）— 3 个

| Agent name | 职能定位 | 主要 tools | 调用方 | 读取的状态文件 | 产出 |
|---|---|---|---|---|---|
| gsd-executor | 原子化执行 PLAN.md，每任务一 commit | Read, Write, Edit, Bash, Grep, Glob, context7 | `execute-phase.md:494`、`audit-fix.md:100`、`execute-plan.md`、`quick.md:757` | PLAN.md / STATE.md / CONTEXT.md | 代码 + commits + SUMMARY.md |
| gsd-code-fixer | 把 REVIEW.md 里的 finding 落地成 fix 提交 | Read, Edit, Write, Bash, Grep, Glob | `code-review-fix.md:192/309` | REVIEW.md | 源码 fix + REVIEW-FIX.md |
| gsd-debugger | 科学方法调试 + 持久 debug session | Read, Write, Edit, Bash, Grep, Glob, WebSearch | `/gsd-debug` 命令、`diagnose-issues.md:101` | `.planning/debug/{slug}.md` | 更新 debug 文件 + ROOT CAUSE 报告 |

### 1.4 Quality / Verification（质量、校验、审计）— 9 个

| Agent name | 职能定位 | 主要 tools | 调用方 | 读取的状态文件 | 产出 |
|---|---|---|---|---|---|
| gsd-plan-checker | 执行前 goal-backward 校验 PLAN | Read, Bash, Glob, Grep | `plan-phase.md:1132`、`import.md:196`、`quick.md:564`、`verify-work.md:599` | PLAN.md / ROADMAP.md / CONTEXT.md | BLOCKER/WARNING 反馈给 planner |
| gsd-verifier | phase 完成后 goal-backward 校验代码 | Read, Write, Bash, Grep, Glob | `execute-phase.md:1379`、`quick.md:952` | SUMMARY.md / PLAN.md / 源码 | VERIFICATION.md |
| gsd-code-reviewer | 对抗式 review 源码（bug/security/quality） | Read, Write, Bash, Grep, Glob | `code-review.md:350`、`code-review-fix.md:275`、`quick.md:915` | git diff / SUMMARY.md / 源码 | REVIEW.md（BLOCKER/WARNING） |
| gsd-integration-checker | 跨 phase 集成 + E2E 流校验 | Read, Bash, Grep, Glob | `audit-milestone.md:84` | 多 phase 源码 + ROADMAP.md | 集成报告 |
| gsd-security-auditor | 验证 PLAN 中威胁缓解是否在代码里实现 | Read, Write, Edit, Bash, Glob, Grep | `secure-phase.md:93` | PLAN.md `<threat_model>` + SUMMARY.md `## Threat Flags` | SECURITY.md |
| gsd-nyquist-auditor | 给 phase 校验缺口生成可失败的行为测试 | Read, Write, Edit, Bash, Glob, Grep | `validate-phase.md:103` | VALIDATION.md / PLAN.md / SUMMARY.md / 测试基础设施 | 测试文件 + VALIDATION.md 更新 |
| gsd-ui-checker | 校验 UI-SPEC.md 完整性（read-only） | Read, Bash, Glob, Grep | `ui-phase.md:214` | UI-SPEC.md / CONTEXT.md / RESEARCH.md | BLOCK/FLAG/PASS verdict |
| gsd-ui-auditor | 实现完成后的 6 维 UI 视觉审计 | Read, Write, Bash, Grep, Glob | `ui-review.md:104` | UI-SPEC.md + 实现源码 + 截图 | UI-REVIEW.md |
| gsd-eval-auditor | AI phase 评估覆盖度逆向审计 | Read, Write, Bash, Grep, Glob | `eval-review.md` | AI-SPEC.md / SUMMARY.md(s) | EVAL-REVIEW.md |

### 1.5 Documentation（文档）— 4 个

| Agent name | 职能定位 | 主要 tools | 调用方 | 读取的状态文件 | 产出 |
|---|---|---|---|---|---|
| gsd-doc-writer | 写/更新项目文档（README/architecture/etc.） | Read, Bash, Grep, Glob, Write | `docs-update.md`（多次 spawn） | 源码 + 既有文档 | 一份目标 .md |
| gsd-doc-verifier | 校对生成文档里的事实声明 | Read, Write, Bash, Grep, Glob | `docs-update.md` Phase 4 | 目标 doc + 源码 | per-doc JSON 结果 |
| gsd-doc-classifier | 单 doc 分类（ADR/PRD/SPEC/DOC/UNKNOWN） | Read, Write, Grep, Glob | `ingest-docs.md`（并行） | 单一 doc 文件 | 单 JSON 分类文件 |
| gsd-doc-synthesizer | 多 doc 分类 → 合成 + 冲突报告 | Read, Write, Grep, Glob, Bash | `ingest-docs.md:182` | classifications/*.json + 源 docs | INGEST-CONFLICTS.md + intel |

### 1.6 Specialized（专业化）— 4 个

| Agent name | 职能定位 | 主要 tools | 调用方 | 读取的状态文件 | 产出 |
|---|---|---|---|---|---|
| gsd-debug-session-manager | 在隔离 context 里跑完整 debug 多轮循环 | Read, Write, Bash, Grep, Glob, Task, AskUserQuestion | `/gsd-debug` 命令 | `.planning/debug/{slug}.md` | 紧凑摘要返回主线 |
| gsd-ai-researcher | AI 框架官方文档 → 实现指南（AI-SPEC §3-§4b） | Read, Write, Bash, Grep, Glob, WebFetch, WebSearch, context7 | `ai-integration-phase.md` | AI-SPEC.md / CONTEXT.md | AI-SPEC.md §3–§4b |
| gsd-intel-updater | 写 `.planning/intel/*.json` 结构化代码库知识 | Read, Write, Bash, Glob, Grep | `/gsd-intel` 命令 | 既有 intel JSON | `.planning/intel/{stack,exports,symbols,patterns,deps}.json` |
| gsd-user-profiler | 8 维行为打分用户画像 | Read | profile workflow Phase 3 | session 消息 JSONL | 结构化 JSON 画像 |

---

## 2. 每个 agent 详细卡片

> 调用方说明：路径都是相对于 `D:\workflow\get-shit-done\` 起算。

### 2.1 Research / Mapping

#### gsd-codebase-mapper

**定位**：按 focus 维度（tech/arch/quality/concerns）扫描代码库，直接写 6 类分析文档到 `.planning/codebase/`，让 orchestrator 不必把代码内容拉进自己 context。

**Frontmatter**：
- tools: Read, Bash, Grep, Glob, Write
- color: cyan
- 隐藏的 PostToolUse hook（写后跑 eslint --fix，注释状态）

**何时被调**：
- `commands\gsd\map-codebase.md`、`workflows\map-codebase.md`：4 路并行（tech/arch/quality/concerns）
- `workflows\scan.md`、`workflows\execute-phase\steps\codebase-drift-gate.md`：drift-gate 时按路径增量扫
- 触发条件：项目初始化扫一次 / 大改后重扫 / 执行前 drift 检查

**输入契约**：
- prompt 注入 `focus`（tech | arch | quality | concerns）
- 可选 `--paths` 限定扫描子树
- 读 `.claude/skills/`（项目技能 lightweight 索引）

**输出契约**：
- 直接 Write 到 `.planning/codebase/{STACK|INTEGRATIONS|ARCHITECTURE|STRUCTURE|CONVENTIONS|TESTING|CONCERNS}.md`
- 返回 orchestrator 仅一行确认（不内联文档内容）
- 格式：markdown，带证据文件路径

**fresh context 影响**：主线只接 confirmation，几乎零 token；mapper 自己烧 30k-80k 读源文件。

**CCG 是否有对应物**：❌ 缺失（CCG 没有结构化 codebase mapping agent，靠 `/ccg:context` 手记 / 单次 `/ccg:plan` 临时探索）。

---

#### gsd-pattern-mapper

**定位**：分析"将要新建/修改的文件"，给每个文件找代码库里最像的现有 analog，提取 imports/auth/error pattern 做成 PATTERNS.md，让 planner 可以让 executor 抄。

**Frontmatter**：
- tools: Read, Bash, Glob, Grep, Write
- color: magenta
- 严格 read-only 约束（除了 PATTERNS.md）

**何时被调**：
- `workflows\plan-phase.md:743`：在 research 步骤之后、planning 步骤之前

**输入契约**：
- CONTEXT.md（用户决策中提到的文件清单）
- RESEARCH.md（架构/库决定）
- 读项目 skills

**输出契约**：
- `.planning/phases/N/PATTERNS.md`：per-file 表格，每行：role / data-flow / closest analog 路径 / 代码摘录

**fresh context 影响**：执行前 PATTERNS.md 是 planner 的输入文件，planner 不需自己再 grep 一遍。

**CCG 是否有对应物**：✅ 部分（`templates\commands\agents\pattern-mapper.md` 已存在，是 GSD 移植版本之一）。

---

#### gsd-phase-researcher

**定位**：单 phase 的技术调研——library 选型 / 标准栈 / 已知坑 / pattern——写 RESEARCH.md 让 planner 直接用。

**Frontmatter**：
- tools: Read, Write, Bash, Grep, Glob, WebSearch, WebFetch, mcp__context7__*, mcp__firecrawl__*, mcp__exa__*
- color: cyan
- 必须给每个 claim 标 `[VERIFIED]` / `[CITED]` / `[ASSUMED]` 来源

**何时被调**：
- `workflows\plan-phase.md:428`：`/gsd-plan-phase` 流程的第 1 步
- `workflows\explore.md:65`：单独 phase 探索
- `workflows\quick.md:440`：quick mode 也要研究

**输入契约**：
- ROADMAP.md 当前 phase（goal + requirements）
- 历史 CONTEXT.md（locked decisions）
- 项目 skills

**输出契约**：
- `.planning/phases/N/RESEARCH.md`，含 Standard Stack / Architecture Patterns / Pitfalls / Migration Notes
- claim provenance 标签强制

**fresh context 影响**：吃 web/docs 的 token 不影响主线；主线只读 RESEARCH.md 摘要。

**CCG 是否有对应物**：❌ 缺失（CCG `/ccg:plan` 把 research 和 plan 揉在一个 codex/gemini 双模型调用里）。

---

#### gsd-project-researcher

**定位**：项目立项的并行 4 维调研（stack / features / architecture / pitfalls），每实例写一个产出，4 路并行 spawn。

**Frontmatter**：
- tools: Read, Write, Bash, Grep, Glob, WebSearch, WebFetch, mcp__context7__*, mcp__firecrawl__*, mcp__exa__*
- color: cyan
- 哲学："Training Data = Hypothesis"（必须验证）

**何时被调**：
- `workflows\new-project.md:796/836/876/916`：4 路并行
- `workflows\new-milestone.md:326`：milestone 复用同一 agent

**输入契约**：
- prompt 指定 dimension（stack/features/architecture/pitfalls）
- 用户的项目描述

**输出契约**：
- `.planning/research/{STACK|FEATURES|ARCHITECTURE|PITFALLS}.md`
- 风格"opinionated"——Use X because Y，不是 Options are X/Y/Z

**fresh context 影响**：4 路并行，主线只看到 4 个文件路径。

**CCG 是否有对应物**：❌ 缺失（CCG 立项靠 `/ccg:init` 单 agent，不并行）。

---

#### gsd-research-synthesizer

**定位**：把 4 个 research 文件合成 SUMMARY.md，并 commit 所有 research 文件（researchers 不 commit）。

**Frontmatter**：
- tools: Read, Write, Bash
- color: purple
- 工具最少（3 个），因为只做合成

**何时被调**：
- `workflows\new-project.md:943`、`new-milestone.md:359`：4 个 researcher 全部完成后串行调

**输入契约**：固定读 `.planning/research/{STACK,FEATURES,ARCHITECTURE,PITFALLS}.md`

**输出契约**：
- `.planning/research/SUMMARY.md`（Executive Summary / Key Findings / Implications for Roadmap / Research Flags / Gaps）
- git commit 4 个 research + SUMMARY

**fresh context 影响**：极小，纯合成。

**CCG 是否有对应物**：❌ 缺失。

---

#### gsd-advisor-researcher

**定位**：discuss-phase advisor 模式下，单一灰区决策的对比调研——产出"5 列对比表 + 推荐段落"返回主线。

**Frontmatter**：
- tools: Read, Bash, Grep, Glob, WebSearch, WebFetch, mcp__context7__*
- color: cyan
- 不直接产出给用户——返回结构化 markdown 让 orchestrator 合成

**何时被调**：
- `workflows\discuss-phase\modes\advisor.md`：每个灰区一个 spawn

**输入契约**：
- `<gray_area>`（区域名 + 描述）
- `<phase_context>`、`<project_context>`
- `<calibration_tier>`：full_maturity / standard / minimal_decisive（控制输出形状）

**输出契约**：
- 5 列对比表（option / rec_if / pros / cons / maturity_signals）+ 推荐段落
- 不写文件，直接返回主线

**fresh context 影响**：主线收到结构化文本（~1k tokens），灰区数 × token 可控。

**CCG 是否有对应物**：❌ 缺失（CCG 没有"灰区"概念）。

---

#### gsd-assumptions-analyzer

**定位**：discuss-phase 假设模式下，深扫单 phase 的代码库假设——读 5-15 个相关文件，输出 confidence 分级（Confident/Likely/Unclear）+ 文件路径证据。

**Frontmatter**：
- tools: Read, Bash, Grep, Glob
- color: cyan
- 不联网，纯代码库分析

**何时被调**：
- `workflows\discuss-phase-assumptions.md:257`

**输入契约**：
- `<phase>` / `<phase_goal>` / `<prior_decisions>` / `<codebase_hints>`（scout 结果）
- `<calibration_tier>`

**输出契约**：结构化假设清单（区域 / 假设 / 备选 / 证据文件路径 / confidence）返回主线。

**fresh context 影响**：5-15 文件 in agent context，主线只接结构化清单。

**CCG 是否有对应物**：✅ 部分（`templates\commands\agents\assumptions-analyzer.md` 已存在）。

---

#### gsd-domain-researcher

**定位**：AI 系统的"业务领域"调研（不是技术框架）——回答"领域专家评估这个 AI 系统时关心什么？"，写 AI-SPEC.md §1b。

**Frontmatter**：
- tools: Read, Write, Bash, Grep, Glob, WebSearch, WebFetch, mcp__context7__*
- color: `#A78BFA`
- 必读 `references/ai-evals.md`

**何时被调**：
- `commands\gsd\ai-integration-phase.md`：第 2 个研究 agent（在 framework-selector 之后、eval-planner 之前）

**输入契约**：`system_type`（RAG/Multi-Agent/...）/ `phase_name` / `phase_goal` / `ai_spec_path` / `context_path` / `requirements_path`

**输出契约**：AI-SPEC.md §1b（领域 rubric ingredients）—— eval-planner 接着把它转换成可量化标准。

**fresh context 影响**：领域调研可能 web 重，但写到 AI-SPEC 文件，主线只看路径。

**CCG 是否有对应物**：❌ 缺失（CCG 没有 AI-specific 工作流）。

---

#### gsd-ui-researcher

**定位**：前端 phase 写设计契约 UI-SPEC.md——读上游决策、检测设计系统、只问没回答的问题。

**Frontmatter**：
- tools: Read, Write, Bash, Grep, Glob, WebSearch, WebFetch, mcp__context7__*, mcp__firecrawl__*, mcp__exa__*
- color: `#E879F9`

**何时被调**：
- `workflows\ui-phase.md:161`：phase 是前端时强制 spawn

**输入契约**：
- REQUIREMENTS.md（用户故事 / 验收准则）
- CONTEXT.md（用户决策）
- 项目 skills（设计系统线索）

**输出契约**：`.planning/phases/N/UI-SPEC.md`（颜色/排版/组件/empty-state/error-copy/CTA labels/breakpoints）

**fresh context 影响**：UI 调研产物落地为单文件，planner/executor/auditor 都用同一个 contract。

**CCG 是否有对应物**：✅ 部分（`templates\commands\agents\ui-ux-designer.md` 存在，但更轻量）。

---

### 2.2 Planning

#### gsd-roadmapper

**定位**：requirements → phases。每个 v1 需求映射到唯一一个 phase，每 phase 有 2-5 条可观察成功判据。同时初始化 STATE.md（项目记忆）。

**Frontmatter**：
- tools: Read, Write, Bash, Glob, Grep
- color: purple

**何时被调**：
- `workflows\new-project.md:1160` / `:1248`（revise 模式）
- `workflows\new-milestone.md:493`
- `workflows\ingest-docs.md:249`：从 docs 反推 roadmap

**输入契约**：REQUIREMENTS.md / SUMMARY.md / 历史 ROADMAP.md（merge 模式）

**输出契约**：ROADMAP.md（phase 表 + 成功判据 + 依赖）+ STATE.md 初始化

**fresh context 影响**：ROADMAP.md 是后续所有 phase 命令的入口文件，主线只需在每次工作时读它。

**CCG 是否有对应物**：❌ 缺失（CCG 用 OPSX/spec-research 替代部分功能，但没有显式 phase roadmap）。

---

#### gsd-planner

**定位**：phase → PLAN.md。任务分解（每 plan 2-3 任务）+ 依赖图 + 执行波次 + goal-backward 推导 must-haves + revision 模式。**核心规则：locked decisions 不可改、deferred ideas 不可出现**。

**Frontmatter**：
- tools: Read, Write, Bash, Glob, Grep, WebFetch, mcp__context7__*
- color: green

**何时被调**：
- `workflows\plan-phase.md:874/930/974/1247`（标准 / gaps / revision 多模式）
- `workflows\quick.md:498/611`（quick mode 双 spawn）
- `workflows\verify-work.md:548/645`（验证失败后 replan）

**输入契约**：
- ROADMAP.md（phase 定义）
- CONTEXT.md（`<user_decisions>` tag，locked 决策必现）
- RESEARCH.md / PATTERNS.md
- revision 模式：plan-checker 反馈

**输出契约**：`.planning/phases/N/PLAN.md`，task 行内嵌 D-XX 决策 ID 做溯源；包含 `<threat_model>` block 给 secure-phase 用。

**fresh context 影响**：PLAN.md 是 executor 的"prompt"——不是给人读的文档，是直接执行指令。

**CCG 是否有对应物**：✅ 部分（`templates\commands\agents\planner.md` 存在，但 GSD 版本 revision/gaps 模式更细）。

---

#### gsd-eval-planner

**定位**：AI phase 评估策略——选 eval dimensions（system_type 决定）+ 写 rubric（PASS/FAIL 行为描述）+ 工具推荐 + 监控。写 AI-SPEC.md §5–§7。

**Frontmatter**：
- tools: Read, Write, Bash, Grep, Glob, AskUserQuestion
- color: `#F59E0B`

**何时被调**：
- `commands\gsd\ai-integration-phase.md`：在 domain-researcher 之后

**输入契约**：`system_type` / `framework` / `model_provider` / `phase_name` / `ai_spec_path` / `context_path` / `requirements_path`，rubric 起点是 §1b 而非通用模板

**输出契约**：AI-SPEC.md §5（Evaluation Strategy）/ §6（Guardrails）/ §7（Production Monitoring）

**CCG 是否有对应物**：✅ 部分（`templates\commands\agents\eval-auditor.md` 是审计版本，没有 planner）。

---

#### gsd-framework-selector

**定位**：≤6 题 AskUserQuestion 决策矩阵——扫码库技术信号、避免推荐已被弃的栈、给排序推荐 + rationale。

**Frontmatter**：
- tools: Read, Bash, Grep, Glob, WebSearch, AskUserQuestion
- color: `#38BDF8`

**何时被调**：
- `commands\gsd\ai-integration-phase.md`：第 1 个 agent
- `/gsd-select-framework`：独立命令

**输入契约**：扫 package.json / pyproject.toml / requirements.txt 找已有 AI lib

**输出契约**：评分推荐（结构化）返回主线 + AI-SPEC.md §2（Framework）

**CCG 是否有对应物**：✅ 部分（`templates\commands\agents\framework-selector.md` 已存在）。

---

### 2.3 Execution

#### gsd-executor

**定位**：原子化执行 PLAN.md——每任务一 commit、deviation 自动处理、checkpoint 暂停、产出 SUMMARY.md。CLAUDE.md 是硬约束（违反则按 CLAUDE.md 调整 + 记 deviation）。

**Frontmatter**：
- tools: Read, Write, Edit, Bash, Grep, Glob, mcp__context7__*
- color: yellow

**何时被调**：
- `workflows\execute-phase.md:494`（核心）
- `workflows\audit-fix.md:100`（修审计 finding）
- `workflows\execute-plan.md`（独立 plan 执行）
- `workflows\quick.md:757`

**输入契约**：PLAN.md / STATE.md / CONTEXT.md / CLAUDE.md / 项目 skills

**输出契约**：源代码改动 + per-task atomic commits + `.planning/phases/N/SUMMARY.md`（含 `## Threat Flags` 给 security-auditor 用）+ 更新 STATE.md

**fresh context 影响**：执行 agent 自己烧 100k+，但写代码后主线只看 SUMMARY.md。

**CCG 是否有对应物**：❌ 缺失（CCG `/ccg:execute` / `/ccg:codex-exec` 由 codex 直接做、没有专门 executor agent）。

---

#### gsd-code-fixer

**定位**：把 REVIEW.md 里 BLOCKER/WARNING finding **智能**应用——不是盲目 patch（先读源验证 finding 还在）+ 每修一个 atomic commit + 产出 REVIEW-FIX.md。

**Frontmatter**：
- tools: Read, Edit, Write, Bash, Grep, Glob
- color: `#10B981`

**何时被调**：
- `workflows\code-review-fix.md:192/309`：`/gsd-code-review --fix` 触发，--auto 模式可循环（cap 3）

**输入契约**：REVIEW.md（reviewer 产出）+ 源码

**输出契约**：源码修改 + commits + REVIEW-FIX.md（每条 finding 状态：fixed/skipped/escalated）

**fresh context 影响**：fixer 烧 fix 时间，主线只看 REVIEW-FIX.md。

**CCG 是否有对应物**：❌ 缺失（CCG `/ccg:review` 只产生 review 报告，不自动 fix）。

---

#### gsd-debugger

**定位**：科学方法调试——hypothesis（**falsifiable**）+ 实验 + 持久 debug session 文件 + 多 mode（find_root_cause_only / find_and_fix）。

**Frontmatter**：
- tools: Read, Write, Edit, Bash, Grep, Glob, WebSearch
- color: orange

**何时被调**：
- `commands\gsd\debug.md`：交互调试入口
- `workflows\diagnose-issues.md:101`：UAT 失败时并行调

**输入契约**：bug 描述（包 DATA_START/DATA_END，security 防注入）+ 历史 debug 文件

**输出契约**：更新 `.planning/debug/{slug}.md`（hypothesis 链 / evidence / next_action / status）+ 三种结构化结果（ROOT CAUSE FOUND / DEBUG COMPLETE / CHECKPOINT REACHED）

**CCG 是否有对应物**：✅ 部分（`/ccg:debug` 命令存在但没有持久 session 文件机制——单次双模型分析）。

---

### 2.4 Quality / Verification

#### gsd-plan-checker

**定位**：执行前 goal-backward 校验 PLAN.md——任务真能达成 phase goal？依赖闭环？跟 CONTEXT.md 没冲突？

**Frontmatter**：
- tools: Read, Bash, Glob, Grep
- color: green
- 实现 **Revision Gate** 模式（有界质量循环 + cap 用尽则升级）

**何时被调**：
- `workflows\plan-phase.md:1132`：planner 写完 PLAN 后立即 check
- `workflows\import.md:196`：import 历史 plan 时校验
- `workflows\quick.md:564`、`verify-work.md:599`

**输入契约**：PLAN.md / ROADMAP.md / CONTEXT.md（locked decisions）

**输出契约**：BLOCKER / WARNING 反馈给 planner（revision 循环）

**CCG 是否有对应物**：✅ 完整（`templates\commands\agents\plan-checker.md`）。

---

#### gsd-verifier

**定位**：phase 完成后 goal-backward 校验代码——**不信 SUMMARY.md，只看代码实际行为**。每个 must-have truth 必须 VERIFIED / FAILED / UNCERTAIN。

**Frontmatter**：
- tools: Read, Write, Bash, Grep, Glob
- color: green
- 实现 **Escalation Gate** 模式

**何时被调**：
- `workflows\execute-phase.md:1379`：execute-phase 末尾
- `workflows\quick.md:952`

**输入契约**：SUMMARY.md（不可信）/ PLAN.md（must-haves）/ 源码

**输出契约**：`.planning/phases/N/VERIFICATION.md`（per-truth 状态 + 证据 grep）

**CCG 是否有对应物**：✅ 完整（`templates\commands\agents\verifier.md`）。

---

#### gsd-code-reviewer

**定位**：对抗式 review——假设有 bug 直到证伪。BLOCKER（bug/security/data-loss）+ WARNING（quality/maintainability）+ 不在 v1 范围：performance。

**Frontmatter**：
- tools: Read, Write, Bash, Grep, Glob
- color: `#F59E0B`

**何时被调**：
- `workflows\code-review.md:350`、`code-review-fix.md:275`、`quick.md:915`

**输入契约**：file scope（--files / SUMMARY.md / git diff fallback 三级回退）

**输出契约**：REVIEW.md（finding 行：severity / file:line / type / 描述 / fix suggestion）

**CCG 是否有对应物**：❌ 缺失（CCG `/ccg:review` 是双模型并行调用 codex/gemini 直接对话，没有专门 reviewer agent 写结构化 REVIEW.md）。

---

#### gsd-integration-checker

**定位**：跨 phase 集成验证。**Existence ≠ Integration**——只看连接：exports→imports / API→consumer / form→handler→DB→display。

**Frontmatter**：
- tools: Read, Bash, Grep, Glob
- color: blue

**何时被调**：
- `workflows\audit-milestone.md:84`：milestone 完成时

**输入契约**：多 phase 源码 + ROADMAP.md（预期连接）

**输出契约**：每个预期连接 WIRED / BROKEN，BLOCKER 是断链导致 E2E 不能完成

**CCG 是否有对应物**：✅ 部分（`templates\commands\agents\integration-checker.md` 已存在）。

---

#### gsd-security-auditor

**定位**：**不盲扫漏洞**——只验 PLAN 里 `<threat_model>` 声明的 mitigation 是否存在。每个 threat 必须 CLOSED / OPEN / 文档化 accepted-risk。

**Frontmatter**：
- tools: Read, Write, Edit, Bash, Glob, Grep
- color: `#EF4444`
- 实现文件 READ-ONLY，违规仅写 SECURITY.md

**何时被调**：
- `workflows\secure-phase.md:93`

**输入契约**：PLAN.md `<threat_model>` + SUMMARY.md `## Threat Flags`（执行时新发现的攻击面）+ `<config>`（asvs_level 1/2/3、block_on）

**输出契约**：`.planning/phases/N/SECURITY.md`

**CCG 是否有对应物**：❌ 缺失（CCG 有 skills/verify-security 但走 skill 流程，不是专门 agent，且不绑 threat-model 概念）。

---

#### gsd-nyquist-auditor

**定位**：给 phase 的"validation gap"生成行为测试——必须可失败的真测试，跑、debug（cap 3）、报告。**实现文件只读**，bug 一律 ESCALATE 不修。

**Frontmatter**：
- tools: Read, Write, Edit, Bash, Glob, Grep
- color: `#8B5CF6`

**何时被调**：
- `workflows\validate-phase.md:103`

**输入契约**：PLAN.md（要求 ID 表）/ SUMMARY.md / 测试基础设施信息 / VALIDATION.md（既有覆盖图）

**输出契约**：测试文件 + VALIDATION.md 更新（每 gap：FILLED / ESCALATED / SKIP）

**CCG 是否有对应物**：✅ 部分（`templates\commands\agents\nyquist-auditor.md` 已存在）。

---

#### gsd-ui-checker

**定位**：UI-SPEC.md 完整性预审——CTA 标签是否泛化？empty/error state 缺？accent 颜色是否被滥用？字号 ≤ 4？spacing 是 4 倍数？read-only。

**Frontmatter**：
- tools: Read, Bash, Glob, Grep
- color: `#22D3EE`

**何时被调**：
- `workflows\ui-phase.md:214`：在 ui-researcher 之后

**输入契约**：UI-SPEC.md（主输入）/ CONTEXT.md / RESEARCH.md

**输出契约**：BLOCK / FLAG / PASS verdict + 具体 finding，让 researcher 修

**CCG 是否有对应物**：❌ 缺失（CCG 没有专门 UI 静态契约校验，靠 impeccable skill 在实现期检查）。

---

#### gsd-ui-auditor

**定位**：实现完成后 6 维 UI 视觉审计——可选截图（dev server 跑着才截，否则纯代码）+ 每维度 1-4 分 + Top 3 优先级修复。

**Frontmatter**：
- tools: Read, Write, Bash, Grep, Glob
- color: `#F472B6`

**何时被调**：
- `workflows\ui-review.md:104`

**输入契约**：UI-SPEC.md / 实现源码 / 可选截图

**输出契约**：UI-REVIEW.md（per-pillar 评分 + 具体 finding）

**CCG 是否有对应物**：❌ 缺失（CCG 有 impeccable 的 audit/critique 系列 skill，但没有 phase 级 UI 审计 agent）。

---

#### gsd-eval-auditor

**定位**：实现完成后审 AI phase 的评估覆盖——每个 dimension 必须 COVERED / PARTIAL / MISSING。**不接受 AI-SPEC.md 文档作为实现证据**。

**Frontmatter**：
- tools: Read, Write, Bash, Grep, Glob
- color: `#EF4444`

**何时被调**：
- `commands\gsd\eval-review.md`

**输入契约**：AI-SPEC.md（计划）+ SUMMARY.md（实现声明）+ phase 源码

**输出契约**：EVAL-REVIEW.md

**CCG 是否有对应物**：✅ 部分（`templates\commands\agents\eval-auditor.md` 已存在）。

---

### 2.5 Documentation

#### gsd-doc-writer

**定位**：写/更新项目文档。9 类（readme / architecture / getting_started / development / testing / api / configuration / deployment / contributing / custom）+ 4 mode（create / update / supplement / fix）。

**Frontmatter**：
- tools: Read, Bash, Grep, Glob, Write
- color: purple
- GSD 自带 marker：`<!-- generated-by: gsd-doc-writer -->`
- 不可验证 claim 用 `<!-- VERIFY: {claim} -->` 标

**何时被调**：
- `workflows\docs-update.md`：多次 spawn（不同 doc 类型）

**输入契约**：
- `<doc_assignment>`：type / mode / project_context / existing_content（update/supplement）/ failures（fix 模式从 verifier 来）
- 安全：所有 prompt 字段是 data 不是 directive

**输出契约**：目标 .md 文件（用 Write 不用 cat<<EOF），不返回内容给 orchestrator

**CCG 是否有对应物**：✅ 部分（CCG `/ccg:gen-docs` 是 skill 而不是 agent，且只生成骨架，不维护多种 doc type）。

---

#### gsd-doc-verifier

**定位**：校对生成 doc 里的事实声明——每条 claim 必须 PASS / FAIL / UNVERIFIABLE。**不接受 file 存在 = claim 正确**——还要 grep 验证 claim 描述的内容。

**Frontmatter**：
- tools: Read, Write, Bash, Grep, Glob
- color: orange

**何时被调**：
- `workflows\docs-update.md` Phase 4

**输入契约**：`<verify_assignment>`（doc_path / project_root）

**输出契约**：per-doc JSON 结果（fileCount / claims / passes / fails 列表），fix 模式时 doc-writer 接 `failures` 数组

**CCG 是否有对应物**：❌ 缺失。

---

#### gsd-doc-classifier

**定位**：单 doc 分类（ADR / PRD / SPEC / DOC / UNKNOWN）。在 `/gsd-ingest-docs` 里并行 spawn——每实例处理一个文件。

**Frontmatter**：
- tools: Read, Write, Grep, Glob
- color: yellow

**何时被调**：
- `workflows\ingest-docs.md`：并行 spawn（每发现一个 doc）

**输入契约**：单一 doc 路径（FILEPATH）

**输出契约**：`.planning/intel/classifications/*.json`（type / title / scope_summary / cross_refs / precedence / confidence / locked）

**CCG 是否有对应物**：❌ 缺失。

---

#### gsd-doc-synthesizer

**定位**：吃 classifier 结果 + 源文档 → 应用 precedence（ADR > SPEC > PRD > DOC）→ LOCKED-vs-LOCKED 硬阻塞 → 写 INGEST-CONFLICTS.md（auto-resolved / competing-variants / unresolved-blockers 三桶）。

**Frontmatter**：
- tools: Read, Write, Grep, Glob, Bash
- color: orange

**何时被调**：
- `workflows\ingest-docs.md:182`：所有 classifier 完成后串行调

**输入契约**：CLASSIFICATIONS_DIR / INTEL_DIR / CONFLICTS_PATH / MODE（new/merge）/ EXISTING_CONTEXT(merge mode) / PRECEDENCE

**输出契约**：`.planning/intel/`（合成 intel）+ `.planning/INGEST-CONFLICTS.md`

**CCG 是否有对应物**：❌ 缺失。

---

### 2.6 Specialized

#### gsd-debug-session-manager

**定位**：在隔离 context 跑完整 `/gsd-debug` 多轮 checkpoint+continuation 循环——主线只接最后摘要。Spawns gsd-debugger、处理 checkpoint（AskUserQuestion）、调度 specialist skill、应用 fix。

**Frontmatter**：
- tools: Read, Write, Bash, Grep, Glob, Task, AskUserQuestion
- color: orange
- 注意：**有 Task 工具——可以再 spawn 子 agent**

**何时被调**：
- `commands\gsd\debug.md:163` / `:241`

**输入契约**：slug / debug_file_path / symptoms_prefilled / tdd_mode / goal / specialist_dispatch_enabled

**输出契约**：紧凑摘要返回主线（不返回完整 debug 历史）。

**fresh context 影响**：**这是 GSD 的 context-isolation 关键模式**——主线根本不参与多轮调试循环。

**CCG 是否有对应物**：❌ 缺失（CCG `/ccg:debug` 是单次双模型并行，没有 manager 层抽象）。

---

#### gsd-ai-researcher

**定位**：选定 AI 框架后，调研其官方文档 → 实现指南（quick reference / patterns / pitfalls）。写 AI-SPEC.md §3–§4b。

**Frontmatter**：
- tools: Read, Write, Bash, Grep, Glob, WebFetch, WebSearch, mcp__context7__*
- color: `#34D399`
- 必读 `references/ai-frameworks.md`

**何时被调**：
- `commands\gsd\ai-integration-phase.md`：framework-selector 之后

**输入契约**：framework / system_type / model_provider / ai_spec_path / phase_context / context_path

**输出契约**：AI-SPEC.md §3（Framework Quick Reference）/ §4（Implementation Guidance）/ §4b（AI Systems Best Practices）

**CCG 是否有对应物**：❌ 缺失。

---

#### gsd-intel-updater

**定位**：写 `.planning/intel/*.json` 结构化代码库知识库——files / exports / symbols / patterns / dependencies。**Always include file paths**，每 claim 引证。其他 agent 用它替代昂贵的 codebase 探索。

**Frontmatter**：
- tools: Read, Write, Bash, Glob, Grep
- color: cyan
- 强制：用 Glob/Read/Grep（跨平台）不用 Bash ls/find/cat

**何时被调**：
- `commands\gsd\intel.md`（独立命令）：focus = full | partial --files

**输入契约**：focus 指令 + project root

**输出契约**：`.planning/intel/{stack,exports,symbols,patterns,deps}.json`

**fresh context 影响**：**意义重大**——后续 agent 通过 `gsd-sdk query intel` CLI 查询而不是读源码。

**CCG 是否有对应物**：❌ 缺失（CCG 有 `.context` 但是 markdown 决策日志，不是结构化 JSON 知识库）。

---

#### gsd-user-profiler

**定位**：从 ~100-150 条采样 session message 跨 8 个行为维度评分——给开发者画像（带 confidence + evidence quote）。

**Frontmatter**：
- tools: Read（**唯一一个只有 Read 工具的 agent**）
- color: magenta
- 必读 `references/user-profiling.md`（rubric 不可改）

**何时被调**：
- `workflows\profile-user.md` Phase 3

**输入契约**：JSONL session messages（已截 500 字符 / 已项目均衡 / 已 recency 加权）

**输出契约**：结构化 JSON 画像（per-dimension 评分 + confidence + evidence quotes）

**CCG 是否有对应物**：❌ 缺失（CCG 没有用户画像功能）。

---

## 3. 调用模式归纳

### 3.1 Spawn 工具：Skill() vs Task() vs Agent()

GSD **全部用 Task()** 调 subagent。`Skill(skill="gsd-...")` 用于调 GSD 的 **slash command / workflow**（不是 agent）——例如 `Skill(skill="gsd-plan-phase")` 触发 plan-phase 这个 workflow，workflow 内部再 `Task(subagent_type="gsd-planner")`。

证据：
- `subagent_type` 关键字在 workflow 文件里出现 67 次，**永远绑 `gsd-*` agent name**
- `Skill(skill="gsd-...")` 出现在 autonomous / manager / chain mode，调的是 workflow 不是 agent

少数行为：
- `gsd-debug-session-manager` 的 frontmatter 含 **`Task` 工具**——这是 GSD 里**唯一显式允许子-spawn**的 agent，用来从 manager 内再 spawn `gsd-debugger`。其他 agent 不带 Task 工具就不能再 spawn。

**没有 Agent() 函数**——CCG/Claude Code 文档里 `Agent()` 是别名，GSD 不用。

### 3.2 fresh context 隔离机制

**Task() spawn 在 Claude Code 默认是 fresh context** —— GSD 的所有 33 个 agent 都依赖这个事实。验证信号：

1. **每个 agent frontmatter 都有 "Mandatory Initial Read" 块**——证明它启动时不知道 prompt 之外任何事，必须显式读文件。
2. **Project skills discovery 模式重复出现**——每个 agent 启动都自己跑一遍 `.claude/skills/` 检测，主线不传。
3. **`<required_reading>` 协议**——orchestrator 显式注入 prompt 让 agent 读哪些文件。
4. **"Returns confirmation only"** 反复出现——agent 明确不把内容返回主线，只返回路径 + 一行确认。

GSD 不依赖"inherit context"——靠的是**文件系统作为持久通道**：
- 状态文件：STATE.md / CONTEXT.md / PLAN.md / SUMMARY.md / VERIFICATION.md / REVIEW.md / VALIDATION.md
- 路径化数据：`.planning/phases/N/{*.md}`
- 结构化知识库：`.planning/intel/*.json`（**关键**——避免每次都重读源码）

### 3.3 串行 vs 并行

**显式并行 spawn 的 agent**：

| Agent | 并行场景 | 文件 |
|---|---|---|
| gsd-codebase-mapper | 4 个 focus 并行（tech/arch/quality/concerns） | `map-codebase.md`（`run_in_background=true`） |
| gsd-project-researcher | 4 维并行（stack/features/architecture/pitfalls） | `new-project.md` |
| gsd-doc-classifier | 每发现一个 doc 一个 spawn | `ingest-docs.md`（"single message with multiple tool uses"） |
| gsd-debugger | 多个 UAT 失败并行调 | `diagnose-issues.md` |
| gsd-doc-writer | 多 doc type 并行 spawn | `docs-update.md`（9 个 spawn） |
| gsd-advisor-researcher | 每个灰区一个 spawn | `discuss-phase\modes\advisor.md` |
| gsd-executor | 同一 plan 拆 task 范围并行 | `execute-plan.md`（subagent route） |

**强制串行**：所有 verification/auditor 类（plan-checker / verifier / code-reviewer / security-auditor / ui-checker / ui-auditor / eval-auditor / integration-checker / nyquist-auditor / doc-verifier / research-synthesizer / doc-synthesizer / roadmapper / planner）。理由：要读上一步的具体产出文件。

**revision 循环**：plan-checker → planner（有 cap），ui-checker → ui-researcher（有 cap）——这是 **Revision Gate** 模式（实现于 `gates.md` 引用）。

### 3.4 错误处理

观察到的常见处理：
- **Cap-bounded 重试**：code-fixer --auto 模式 cap 3、nyquist-auditor 调试 cap 3、revision gate cap（plan-checker 反馈循环）
- **Escalation Gate**（verifier 实现）：cap 用尽 → 显式升级给 developer 决策，不静默继续
- **Severity 强制分级**：每个 quality agent 的 finding 必须带 BLOCKER / WARNING——没分级即非有效输出
- **Read-only 锁定**：security-auditor / nyquist-auditor / ui-checker / pattern-mapper 不准改实现代码——发现问题 → ESCALATE
- **Manager 层吸收失败**：debug-session-manager 隔离 debug 循环，主线只接最后状态

---

## 4. CCG 现状对照

### 4.1 CCG 已有的 15 个 agent 对照

CCG 当前 `templates\commands\agents\*.md`：

| CCG agent | 最近的 GSD agent | 备注 |
|---|---|---|
| `planner.md` | gsd-planner | CCG 版本简单，无 revision/gaps mode |
| `ui-ux-designer.md` | gsd-ui-researcher | CCG 没有 UI-SPEC.md 契约概念 |
| `init-architect.md` | gsd-roadmapper（部分）+ gsd-project-researcher（部分） | CCG 是单 agent 揉一起 |
| `get-current-datetime.md` | （GSD 无对应） | CCG 独有，纯工具型 |
| `team-architect.md` | gsd-roadmapper（架构视角） | v1.8.3 引入 |
| `team-qa.md` | gsd-verifier + gsd-nyquist-auditor 部分 | 通用 QA |
| `team-reviewer.md` | gsd-code-reviewer | 通用 code review |
| `pattern-mapper.md` | **gsd-pattern-mapper**（同名） | 直接移植 |
| `assumptions-analyzer.md` | **gsd-assumptions-analyzer**（同名） | 直接移植 |
| `plan-checker.md` | **gsd-plan-checker**（同名） | 直接移植 |
| `nyquist-auditor.md` | **gsd-nyquist-auditor**（同名） | 直接移植 |
| `integration-checker.md` | **gsd-integration-checker**（同名） | 直接移植 |
| `framework-selector.md` | **gsd-framework-selector**（同名） | 直接移植 |
| `eval-auditor.md` | **gsd-eval-auditor**（同名） | 直接移植 |
| `verifier.md` | **gsd-verifier**（同名） | 直接移植 |

**结论**：CCG v3.0.0 specialist 8 个 agent 显然是从 GSD 直接抠出来的同名移植。但**调用方上下文（workflow 编排）没跟过来**——CCG workflow 文件里 grep 不到对这些 specialist 的稳定 spawn。

### 4.2 GSD 有但 CCG 完全没有的（按价值排序）

价值评分维度：解决 CCG 已知痛点 / 移植成本 / 可独立工作。

| # | Agent | 价值（为什么重要） | 在 CCG 哪个工作流可用 | 移植成本 |
|---|---|---|---|---|
| 1 | **gsd-codebase-mapper** | CCG 没有结构化 codebase 映射，每次 plan/execute 都从零探索；mapper 把"扫"和"用"分开，让主线只读 6 个 .md | `/ccg:plan` 启动前置 / `/ccg:init` 增强 / 新增 `/ccg:map` 命令 | **直接拷贝**——只需把 `.planning/codebase/` 路径改成 `.context/codebase/` |
| 2 | **gsd-intel-updater** | CCG `.context` 是手记 markdown，没结构化查询接口；intel-updater 的 JSON + CLI 查询是真正的"persistent codebase memory" | `/ccg:context` 增 `intel` 子命令 / 所有命令前置查询 | **需要适配**——配套需要 `gsd-sdk query intel` 风格 CLI（CCG 可暂时退化为 jq） |
| 3 | **gsd-debug-session-manager** | 这是 GSD 实现"用 GSD 不操心 context"的**核心模式**——manager 在隔离 context 跑完整 multi-turn 循环，主线只接摘要。CCG `/ccg:debug` 是单次双模型，没循环没记忆 | `/ccg:debug` 重写为 manager + debugger 双层 | **几乎重写**——CCG 当前 debug 命令逻辑要换骨架 |
| 4 | **gsd-executor** | CCG 没有 atomic-commit-per-task executor，`/ccg:codex-exec` 是 codex 直接做、不分 task；GSD executor 的 deviation 处理 + checkpoint + STATE.md 更新是工程化关键 | `/ccg:execute` / `/ccg:codex-exec` 重构 | **需要适配**——CCG 多模型路由要改成"executor 内调 codex/gemini"而非外部并行 |
| 5 | **gsd-code-fixer** | CCG `/ccg:review` 出报告但不修；fixer 的"smart re-read 源码 + atomic commit + cap 重试"是闭环 | `/ccg:review --fix`（新增 flag） | **直接拷贝**——加一个 agent + 改命令 |
| 6 | **gsd-doc-classifier + gsd-doc-synthesizer** | CCG 没有从历史散文档反推上下文的能力；GSD 这对组合是 "ingest 老项目 README/ADR" 的关键 | 新增 `/ccg:ingest-docs` 命令 | **需要适配**——两个 agent + 一个 workflow 编排 |
| 7 | **gsd-phase-researcher** | CCG `/ccg:plan` 把 research 揉到双模型对话里，没产出 RESEARCH.md 持久文件供后续步骤复用；phase-researcher 把研究外化、planner 直接读 | `/ccg:plan` 拆成 research + plan | **直接拷贝**——CCG 已经有 codex/gemini，只是没把研究步独立 |
| 8 | **gsd-roadmapper** | CCG 没有 phase-based 项目内存；OPSX 是替代但偏 spec 视角，roadmapper 是"需求 → 阶段 → 成功判据"的工程映射 | 新增 `/ccg:roadmap` 命令 / `/ccg:init` 增强 | **需要适配** |
| 9 | **gsd-security-auditor** | CCG 有 verify-security skill 但是无差别静态扫；GSD security-auditor 绑 PLAN.md `<threat_model>`——只验声明的 mitigation 是否实现，针对性强 | `/ccg:plan` 加 threat_model block + 新增 `/ccg:secure` | **几乎重写**——需要 PLAN 里加 threat_model 协议 |
| 10 | **gsd-doc-writer + gsd-doc-verifier** | CCG `/ccg:gen-docs` 只生骨架；GSD 这对组合是 9 doc type × 4 mode 的成熟矩阵 + 验证闭环 | `/ccg:gen-docs` 升级 | **需要适配**——大量模板内容要补 |
| 11 | **gsd-domain-researcher + gsd-eval-planner + gsd-ai-researcher** | CCG 没有 AI integration 工作流；这 3 个组合是 GSD 处理 AI feature 开发的差异化能力（领域 → 框架 → 评估闭环） | 新增 `/ccg:ai-integration` 命令 | **直接拷贝**——三个独立 agent |
| 12 | **gsd-ui-researcher + gsd-ui-checker + gsd-ui-auditor** | CCG impeccable 是设计技能 skill，没有 phase 级"契约 → 校验 → 审计"工程闭环 | `/ccg:frontend` 升级到契约模式 | **需要适配** |
| 13 | **gsd-research-synthesizer** | 配套 project-researcher 4 路并行的合成器；如果不引入 project-researcher 这个就没必要 | `/ccg:init` 升级 | **直接拷贝** |
| 14 | **gsd-advisor-researcher** | 灰区决策的并行调研——CCG `/ccg:plan` 没有"消除歧义阶段"显式 spawn 多 advisor | spec-research / spec-plan 增强 | **直接拷贝** |
| 15 | **gsd-user-profiler** | 用户画像——非工程刚需，valuable 但不紧急 | 独立可选命令 | **直接拷贝** |

### 4.3 CCG 有但 GSD 没有的

| CCG agent | 说明 |
|---|---|
| `team-architect.md` | v1.8.3 Agent Teams 概念，GSD 用 phase-based 不分"角色团队" |
| `team-qa.md` | 同上，GSD 拆得更细（verifier + nyquist-auditor + integration-checker） |
| `team-reviewer.md` | GSD 直接用 code-reviewer |
| `get-current-datetime.md` | 纯工具 agent，GSD 无（GSD 用 `date` bash） |
| `init-architect.md` | CCG 把 GSD 的 roadmapper + project-researcher 合一 |
| `ui-ux-designer.md` | 比 GSD 的 ui-researcher 更轻量（无 UI-SPEC.md 契约） |

---

## 5. 移植 ROI 排序（前 5）

按"投入 / 产出"排序。

1. **gsd-codebase-mapper** — 直接拷贝改路径，立即给所有命令"廉价 codebase 摘要"，最大幅降低主线探索 token。
2. **gsd-code-fixer**（配 review 升级）— 单文件 agent，让 `/ccg:review` 从"报告"升级到"闭环修"，可视收益最直接。
3. **gsd-debug-session-manager** — context-isolation 核心模式，是用户反馈"用 GSD 不操心 context"的典型代表，重写 `/ccg:debug` 一次到位。
4. **gsd-phase-researcher** — 把 `/ccg:plan` 的研究步外化到文件，下游 plan/execute 直接读，避免一遍遍向双模型重复问背景。
5. **gsd-intel-updater** — 长期价值最高，建立 CCG 的"结构化代码库知识库"基线；短期成本是配套 CLI（可先用 jq 顶）。

---

写完了，文件 ~640 行，CCG 缺失高价值 agent 数量 ≥10（前 5 ROI 已排序，剩余如 doc-classifier/synthesizer、security-auditor、AI integration 三件套、UI 三件套等价值次高需配套 workflow 改造）。
