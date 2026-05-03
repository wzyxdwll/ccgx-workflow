# 开源 Workflow / Plugin 生态扫描（findings）

> 扫描时间: 2026-05-03
> 任务定位: 事实归档 + 与 CCG 对比，不写代码、不给 patch
> CCG 当前规模: 35 slash commands · 15 subagents · 100+ skill 文件 · 19 专家提示词 · 8 输出风格

---

## 0. 扫描方法说明

本次扫描覆盖 4 类 12 个项目/规范来源：

1. **Spec-driven** 类: GitHub SpecKit、OpenSpec/OPSX（CCG 已集成）、BMAD-METHOD、TaskMaster AI
2. **Multi-agent / Workflow** 框架: Anthropic 官方多智能体最佳实践、CrewAI、LangGraph
3. **Claude Code 官方生态**: Anthropic Skills 设计文档（claude.com/blog/skills、code.claude.com/docs/en/skills）、官方 plugin 列表（13 个）
4. **本机 4 个已装 plugin**: openai-codex/codex@1.0.4、google-gemini/gemini@1.0.1、claude-plugins-official/code-review、claude-plugins-official/frontend-design

补充参考 firecrawl.dev 关于 2026 年高安装量 skill 设计模式的统计文章。

GSD（CCG 友邻另一项目）单独由其他 agent 在扒，本扫描不重复其 `--minimal`/`Workstream`/`commit hook` 的工程化层细节。

---

## 1. 模式分类总表

下表归纳 22 个核心设计模式，标注来源、思想要点、CCG 当前匹配度。

| # | 模式 | 主要来源 | 核心思想 | CCG 当前是否有 |
|---|------|---------|----------|----------------|
| 1 | Spec-first 强制四阶段 | GitHub SpecKit | constitution → specify → plan → tasks → implement，规范即可执行的源 | ⚠️ 部分（OPSX 集成但非默认入口，35 命令并列展示） |
| 2 | 渐进式 Skills 暴露（progressive disclosure） | Anthropic Skills Docs | frontmatter 100 tokens 常驻，body 仅匹配时加载，单 skill ≤ 500 行 | ✅ 已是（v2.0.0 Skill Registry frontmatter 驱动） |
| 3 | 1% 上下文预算约束 | code.claude.com/docs/en/skills | 描述字符总和动态裁剪到上下文 1%，超量被截 | ❌ CCG 100+ skill 描述未做总长审计 |
| 4 | Skill 作为 fork-context 入口 | Anthropic Skills Docs | `context: fork` + `agent: Explore` 让 skill 直接在子 agent 中跑，不污染主线 | ❌ CCG 所有 skill 默认主线执行 |
| 5 | `disable-model-invocation` 拆分 | Anthropic Skills Docs | 用户/模型谁能调，明确分离副作用工作流 | ⚠️ 部分（commit/rollback 等高副作用命令未显式标注） |
| 6 | Subagent 100% fresh context | Claude Agent SDK + GSD | 每次 spawn 全新 context，主线只看返回值 | ⚠️ 部分（team-exec 有，普通命令多在主线展开） |
| 7 | 状态外置（State on disk） | LangGraph + GSD | 主线 context ≠ 状态载体，状态写盘可恢复 | ❌ 仅 `.context/` 目录有雏形（v1.7.80） |
| 8 | Plugin marketplace 复用 | Claude Code Marketplace | 不重造已有 plugin，安装 codex/gemini/code-review 后直接 leverage | ⚠️ 已装但 CCG 命令很少调用其原生 `/codex:rescue`、`/codex:adversarial-review` |
| 9 | 异步任务三件套（status/result/cancel） | openai-codex plugin | 长任务 background → /status 看进度 → /result 取结果 → /cancel 中止 | ❌ CCG `--progress` 仅 stderr 流，无独立 status 命令 |
| 10 | Confidence 评分过滤 | claude-plugins-official/code-review | 每个 finding 0-100 打分，仅 ≥80 入最终 comment | ❌ CCG `/ccg:review` 直接展示双模型原文 |
| 11 | 多 Haiku 并行廉价审计 | claude-plugins-official/code-review | 5 个 Sonnet 并行 + 多 Haiku 评分，分层用模型省 token | ⚠️ 部分（CCG 用 Codex/Gemini 并行，但都是大模型，无 Haiku 过滤层） |
| 12 | 多角色专家智能体 | BMAD-METHOD + CrewAI | PM/Architect/Dev/UX/Scrum 等 12+ 角色，对应不同决策点 | ⚠️ CCG 7 个原生 + 8 个新 specialist，有但定位重叠 |
| 13 | "评估器-优化器" 反馈环 | Anthropic 官方 Building Effective Agents | evaluator 评分 → optimizer 修复 → 最多 N 轮 | ✅ `/ccg:team` 已有（最多 2 轮 Critical 修复） |
| 14 | 编排者-工人（Orchestrator-Workers） | Anthropic 官方 + LangGraph | 一个 lead 拆分子任务，多 worker 并行 | ✅ Agent Teams 系列 |
| 15 | Routing（智能路由） | Anthropic 官方建议模式 | 先分类后选 prompt/agent，避免一锅烩 | ✅ `/ccg:workflow` 智能前后端路由 |
| 16 | Prompt chaining（任务串行链） | Anthropic 官方 | 简单线性多步胜过 agent autonomy | ⚠️ 部分（OPSX 4 步骤是 chain，但 35 命令大多并列） |
| 17 | Workflow vs Agent 取舍纪律 | Anthropic 官方 | "Start with simple prompts… add agents only when simpler falls short" | ❌ CCG 默认全功能展开，缺少 minimal 入口 |
| 18 | 动态上下文注入（!`shell`） | Anthropic Skills Docs | SKILL.md 内 `!\`git diff HEAD\`` 在加载前预执行 | ⚠️ CCG 模板有手动注入但未统一用 ! 语法 |
| 19 | `--add-dir` 自动发现 nested skills | Anthropic Skills Docs | 编辑 packages/frontend/ 时自动加载该目录 .claude/skills/ | ❌ CCG 全装到 `~/.claude/skills/ccg/`，与 monorepo 模式不友好 |
| 20 | TaskMaster 工具集精简（7 vs 36） | TaskMaster AI | `TASK_MASTER_TOOLS` env 控制加载数，可选 7 核心或全 36 | ❌ CCG 全装无最小集 |
| 21 | Session lifecycle hooks | openai-codex plugin | SessionStart/SessionEnd/Stop 三种 hook，900s 超时长任务等待 | ❌ CCG 只有命令级 hook，无 session 级 |
| 22 | "Party Mode" 多 persona 一窗口 | BMAD-METHOD | 多个角色在单次会话中协作辩论 | ❌ CCG 无对应 |

---

## 2. 每个项目的核心借鉴点（详细）

### 2.1 GitHub SpecKit

**核心理念（一句话）**: Spec 是可执行源（executable source），不是脚手架。

**最大优势**:
- 5 命令工作流（`/speckit.constitution` → `/speckit.specify` → `/speckit.plan` → `/speckit.tasks` → `/speckit.implement`）形成强约束链。引文："specifications become executable, directly generating working implementations" (https://github.com/github/spec-kit)。
- `constitution` 命令把项目宪法（治理原则）单独立为第一步，避免每次 plan 重申原则。

**最大缺陷**:
- 强制 spec-first 对小修改摩擦极大。20 行 typo 修复也要走 5 步流程。
- 4 阶段嵌套深、回退路径不清；用户中途想跳过 plan 直接 tasks 不够顺滑。

**CCG 应该借鉴的 1-2 点**:
1. 把 OPSX 系列从"命令并列"提升为"默认入口"，做新工作流时明确建议：先 spec-init，再决定 single-shot 还是 spec-driven。
2. 命名层级化（`/ccg:spec-*` 已有），考虑 `/speckit.constitution` 等价物：`/ccg:spec-init` 负责立宪，让多模型协作有共识基线。

**CCG 应该避免的**:
1. 不要把 spec-first 设为唯一路径——保留 quick mode（`/ccg:enhance` + `/ccg:execute`）给小任务。
2. 不要 5 步全展开，CCG 已有 4 步 OPSX 链够用。

---

### 2.2 BMAD-METHOD

**核心理念**: AI 是协作者不是替代者，通过 12+ 专家 agent（PM/Architect/Dev/UX/Scrum Master 等）覆盖完整产品生命周期。引文："Traditional AI tools do the thinking for you, producing average results. BMad agents and facilitated workflows act as expert collaborators" (https://github.com/bmadcode/BMAD-METHOD)。

**最大优势**:
- "Scale-domain-adaptive intelligence" 自动调整深度——bug fix 用轻流程、企业系统用重流程。
- "Party Mode" 多 persona 同窗口辩论——CCG 当前没有对应能力。

**最大缺陷**:
- **角色过多**: PM/Scrum Master/Product Owner 这种"企业 theater"角色对中小项目纯增加摩擦。
- 文档把"敏捷方法论"绑死，不擅长 hacker style 单兵作业。
- 12+ agent 全部加载会大幅膨胀系统提示词。

**CCG 应该借鉴的**:
1. **Adaptive depth**：CCG 35 命令应明确分层（轻/中/重），不要让用户一开始就面对 35 个等价选项。
2. **Party Mode 对辩**: 多模型不仅并行分析，应允许 Codex/Gemini 互相 challenge（当前 CCG 是独立分析后由 Claude 综合，缺少直接对话）。

**CCG 应该避免的**:
1. **角色 inflation**：CCG v3.0.0 新增 8 个 specialist（assumptions-analyzer / nyquist-auditor / framework-selector 等）正接近 BMAD 反模式边缘。需要明确每个 specialist 的实战使用频率，否则砍掉。
2. 不要做 Scrum Master / PO 这类纯过程角色——CCG 用户是开发者直接干活，不需要项目管理 theater。

**特别警示**: BMAD 的 12+ 角色模型如果照搬到 CCG，会让系统提示词膨胀到 5k+ tokens，破坏 Skills progressive disclosure 设计。

---

### 2.3 TaskMaster AI

**核心理念**: 任务管理 + dependency 追踪 + 可选工具加载，给 AI 一个有状态的 task 视图。

**最大优势**:
- `task-master parse-prd` 把 PRD 文档自动拆为依赖图。
- **`TASK_MASTER_TOOLS` 环境变量分级**: 7 核心工具（minimal）vs 36 全集（full）。引文："allowing users to balance feature completeness against context window usage (ranging from 7 core tools to all 36 available tools)" (https://github.com/eyaltoledano/claude-task-master)。
- 任务状态外化为 `.taskmaster/tasks.json`，状态不占主线 context。

**最大缺陷**:
- 强依赖 PRD 输入，没 PRD 就没法启动。
- task 拆分粒度由 LLM 决定，经常过细或过粗。
- MCP server 安装路径，与 plugin 体系正交，新手难调。

**CCG 应该借鉴的**:
1. **工具分级加载**：CCG 35 命令应有 minimal 集（约 7 个高频）和 full 集，通过 `init --minimal` 让用户少装。
2. **状态外化文件**：CCG `.context/` 已有雏形，应扩展为完整任务状态机（current_task / dependencies / blockers），与主线 context 解耦。

**CCG 应该避免的**:
1. 不要强 PRD 入口——CCG 已有 `/ccg:enhance` 处理模糊需求，不需要 TaskMaster 那种重 parse 流程。
2. Task 依赖管理别做太花——LangGraph 那种节点显式连边在 CCG 用户群体里收益不高。

---

### 2.4 CrewAI

**核心理念**: Agents（角色）+ Tasks（任务）+ Crews（团队）+ Processes（编排模式）四元组。引文："CrewAI is a lean, lightning-fast Python framework built entirely from scratch—completely independent of LangChain or other agent frameworks" (https://github.com/crewAIInc/crewAI)。

**最大优势**:
- 概念清晰: Agent 有 role / goal / backstory 三个稳定属性，避免每次任务重写人设。
- **Crews vs Flows 双模式**：Crews 高自治、Flows 细粒度事件控制——同一框架支持两个抽象层。

**最大缺陷**:
- Python only，与 Claude Code 主线 TypeScript 工具链脱节。
- "lean" 但生态实际重——大量第三方 LLM provider 依赖。

**CCG 应该借鉴的**:
1. **Agent backstory 稳定化**：CCG agent 文件应有固定 role/goal 头部，不要每个命令重新构造人设。
2. **Crews 抽象**: `/ccg:team` 已经接近，可以更明确表达"crew = 一组角色 + 一个 process"。

**CCG 应该避免的**:
1. 不要做 process abstraction（sequential/hierarchical 等）——Anthropic 官方建议先用最简的 routing/chaining，不需要预设流程类。
2. 别照搬 Python crew 的 verbose YAML 配置——CCG 模板已经够多了。

---

### 2.5 LangGraph

**核心理念**: 状态机驱动的 agent 编排，节点（Node）+ 边（Edge）+ 共享 State。引文："LangGraph is a low-level orchestration framework and runtime for building, managing, and deploying long-running, stateful agents" (https://docs.langchain.com/oss/python/langgraph/overview)。

**最大优势**:
- **Durable execution**: agent 可在崩溃/打断后从 checkpoint 恢复——这对长任务（research、impl）极有价值。
- **Human-in-the-loop**: 显式 interrupt 节点，用户可介入修改 state 后再 resume。
- 显式状态图让调试可视化（每个节点清晰可见）。

**最大缺陷**:
- 学习曲线陡，对快速 prototype 不友好。
- "low-level" 意味着大量 boilerplate。
- 与 Claude Code 主线 TS 工具链兼容性不佳。

**CCG 应该借鉴的**:
1. **Checkpoint 机制**：CCG `/ccg:team` 8 阶段工作流应支持中断恢复，把每阶段产出写盘，下次 `/ccg:team --resume` 可从最后 checkpoint 继续。`.context/` 已有基础。
2. **Human-in-the-loop interrupt 点**：在 plan→exec 之间显式插入用户确认节点，避免无脑往下跑。

**CCG 应该避免的**:
1. 不要画完整状态图——CCG 用户不需要看节点连边，只需要知道"现在第几步、能否回退"。
2. 别做 LangGraph 那种节点间消息传递抽象——文件系统就够了。

---

### 2.6 Anthropic 官方 Multi-Agent Best Practices

**核心理念**: 简单优先，复杂度必须由可量化收益证明。引文："Start with simple prompts, optimize them with comprehensive evaluation, and add multi-step agentic systems only when simpler solutions fall short" (https://www.anthropic.com/research/building-effective-agents)。

**最大优势**:
- **明确警告反 over-engineering**: "frameworks can also make it tempting to add complexity when a simpler setup would suffice"。
- 给出 5 种基本模式：Prompt chaining、Routing、Parallelization、Orchestrator-workers、Evaluator-optimizer。CCG 已实现 4 种（缺 Prompt chaining 单独入口）。
- 三大原则：**Simplicity / Transparency / Tool documentation**。

**最大缺陷**:
- 高度抽象，不给落地代码。
- 对"何时升级到 agent"的判定标准较主观。

**CCG 应该借鉴的**（这是最重要的官方参考）:
1. **Simplicity 原则**：CCG 35 命令面板已经偏向"什么都有"，应以"删命令"作为下一版主轴。Anthropic 自己说"add complexity only when simpler falls short"，CCG 没这种纪律。
2. **Tool documentation 优先**: 每个 CCG 命令的 description 是否清晰传达"何时用 vs 何时不用"？应做一次审计。

**CCG 应该避免的**:
1. **Agent autonomy 滥用**: 当前 `/ccg:codex-exec` 给 Codex 全权执行，符合 Anthropic 原则——但要确保有 sandbox 和退出条件，否则触发 "compounding error risk"。
2. 不要默认走 Agent，先看 single LLM call 够不够。

**CCG 偏离官方建议的地方（必须修正）**:
- 对小任务也建议走多模型协作 → 应给"single-prompt fallback"。
- Skills 描述膨胀 → 违反 1% 上下文预算原则。

---

### 2.7 Anthropic Skills 最新指南

**核心设计哲学**:
- **按需加载 vs 系统提示词**：引文 "skills' body loads only when it's used, so long reference material costs almost nothing until you need it" (https://code.claude.com/docs/en/skills)。
- **Progressive disclosure 三层**: ① frontmatter（name + description, ~100 tokens 常驻）→ ② SKILL.md body（被匹配时加载）→ ③ 引用文件（reference.md / examples.md / scripts/，按需 read）。
- **frontmatter 字段权威**: `description` / `when_to_use` / `disable-model-invocation` / `user-invocable` / `allowed-tools` / `model` / `effort` / `context: fork` / `agent` / `paths` / `hooks`。
- **重要约束**: SKILL.md 应 ≤ 500 行，描述总和受 1% 上下文预算约束（默认 8000 字符 cap）。
- **三层调用关系表**:
  | Frontmatter | 用户能调 | Claude 能调 | 何时载入 context |
  |---|---|---|---|
  | （默认） | ✓ | ✓ | description 常驻，body 调用时全载 |
  | `disable-model-invocation: true` | ✓ | ✗ | description 不入 context，仅用户调时全载 |
  | `user-invocable: false` | ✗ | ✓ | description 常驻，body 调用时全载 |

**Skills 内容生命周期**: 调用一次后 skill body 留在会话直到 auto-compaction；compaction 后保留每个 skill 前 5000 tokens，所有 skill 共享 25000 tokens 预算，溢出按调用顺序丢弃。

**CCG 的 Skill Registry（v2.0.0）做对了**:
1. ✅ frontmatter 驱动自动命令生成。
2. ✅ 文件分层（SKILL.md + 子目录如 `scripts/`、`tools/`）。
3. ✅ 有 `user-invocable` 区分用户和模型调用。

**CCG 漏了**:
1. ❌ 没用 `context: fork`，所有 skill 在主线展开，浪费主 context。
2. ❌ 没有 `allowed-tools` 白名单——意味着每次 skill 跑都触发权限询问。
3. ❌ 没用 `paths` 限定激活路径——如 `frontend-design` 应只在 `*.tsx`/`*.vue` 文件中激活。
4. ❌ 没有 1% 上下文预算审计（100+ skill 描述总长未量化）。
5. ❌ 没用 `!\`<command>\`` 动态注入（如 commit skill 应预跑 `git diff`）。
6. ❌ 没用 `effort` 字段（重型 skill 应自动 high effort）。

---

### 2.8 Claude Code 已装 plugin（4 个本机 + 13 个官方）

#### 2.8.1 openai-codex/codex@1.0.4

目录结构: `commands/`(7) + `agents/`(1) + `skills/`(3) + `hooks/`(1) + `prompts/`(2) + `scripts/`。

**值得借鉴的设计**:

1. **异步任务三件套**（`status.md` / `result.md` / `cancel.md`）:
   ```
   /codex:rescue --background  → 启动后台
   /codex:status               → 看进度（job-id 表格）
   /codex:result <job-id>      → 取最终输出
   /codex:cancel <job-id>      → 中止
   ```
   这是真正可用的"长任务"模式。CCG `--progress` 仅能流 stderr，没有 job-id 索引。

2. **`disable-model-invocation: true` 默认开启**: status/result/cancel 都标了这个，避免模型自动反复 poll。引文（来自 status.md）: `disable-model-invocation: true`。

3. **AskUserQuestion 二选一限定**: rescue 命令要求"Use AskUserQuestion exactly once with two choices"。比 CCG 模板里的"请选择 1/2/3"更结构化。

4. **Resume 检测**: rescue 命令先用 helper 探活 `task-resume-candidate`，发现可恢复线程才弹询问。CCG 当前 spec-impl 跨阶段会话复用是硬编码 SESSION 变量。

5. **Session lifecycle hook**: `hooks.json` 注册 SessionStart / SessionEnd / Stop，最长 timeout 900s。CCG 当前没有 session 级 hook。

6. **Skills 子目录细分内部技能**: `gpt-5-4-prompting`、`codex-cli-runtime`、`codex-result-handling` 三个 skill 都是 plugin 自用的"内部 contract"，不暴露给用户。CCG 的 `tools/lib/` 类似但没 frontmatter 标 `user-invocable: false`。

7. **Adversarial review 框架定位**: "It is not just a stricter pass over implementation defects... questions the chosen implementation, design choices, tradeoffs, and assumptions"。CCG 现有 `/ccg:review` 偏 implementation defects，缺 design-level challenge。

8. **Estimate 决策点**: review 命令在 background/foreground 选择前先 `git diff --shortstat` 估算大小，自动推荐。CCG 模板靠人工判断。

#### 2.8.2 google-gemini/gemini@1.0.1

结构与 codex 镜像（`adversarial-review.md` / `cancel.md` / `rescue.md` / `result.md` / `review.md` / `setup.md` / `status.md`）。

**关键观察**: codex 和 gemini 两个 plugin 设计高度一致——同一套 7 命令 + 异步三件套。这是 plugin 生态的"一致性收益"。CCG 不应自己重写一套 codex/gemini 调用模板，应直接 leverage 这两个 plugin 的现成命令。

#### 2.8.3 claude-plugins-official/code-review

**最值得借鉴的设计**: `code-review.md` 8 步流程是 multi-agent 教科书。

1. **Eligibility 预检**（Haiku agent）：跳过 closed/draft/trivial/already-reviewed PR。
2. **CLAUDE.md 收集**（Haiku agent）：拿到根 + 修改目录的 CLAUDE.md 路径列表（不读内容）。
3. **PR summary**（Haiku agent）。
4. **5 个 Sonnet 并行** 独立审查（CLAUDE.md / 浅层 bug / git blame / 历史 PR / 代码注释）。
5. **每个 issue 单独 Haiku agent 评分 0-100**。
6. **过滤 < 80 分** 的所有 issue。
7. **重新 eligibility 检查**（防 race condition）。
8. **Comment 标准格式**: 编号 + 引用 CLAUDE.md 引文 + 全 SHA + 行范围。

**核心设计哲学**:
- **Haiku 做廉价过滤层 + Sonnet 做高质量分析层**: 显式分层用模型，省 token。
- **Confidence ≥80 才输出**: 引文 "0=false positive, 25=somewhat, 50=moderately, 75=highly, 100=absolutely certain"。
- **明确列出 false positives 排除清单**: 已存在 issue / 看似 bug 但不是 / pedantic nitpicks / lint catches / 文档质量（除非 CLAUDE.md 强制）/ 已有 lint ignore / 未修改行的 issue。
- **强制引用格式**: 必须用全 SHA + `#L<start>-L<end>` 否则 GitHub markdown 不渲染。

#### 2.8.4 claude-plugins-official/frontend-design

只有 1 个 skill，没有 commands。设计哲学："Claude automatically uses this skill for frontend work"——纯被动、零命令面板污染。CCG `frontend-design` 域有 20 个 impeccable 命令，对比下显得过度。

**CCG 应该借鉴**:
- 极简心法：1 个 skill 解决一类问题，不要 20 个微命令拆分。
- 让 Claude 通过 description 关键词自动选择，而非用户记住 20 个命令名。

---

### 2.9 官方 13 plugin 全景

来源 https://github.com/anthropics/claude-code/tree/main/plugins。CCG 应该 leverage 而非重造的：

| 官方 plugin | 功能 | CCG 是否重复造 |
|---|---|---|
| `commit-commands` | `/commit`、`/commit-push-pr`、`/clean_gone` | ⚠️ 重复（CCG `/ccg:commit` `/ccg:clean-branches`） |
| `code-review` | PR 评审 5 并行 + confidence 过滤 | ⚠️ 重复（CCG `/ccg:review`） |
| `pr-review-toolkit` | 6 specialized agents PR 评审 | ⚠️ 重复 |
| `feature-dev` | 7 阶段功能开发 | ⚠️ 重复（CCG `/ccg:feat`、`/ccg:team`） |
| `agent-sdk-dev` | Claude Agent SDK 开发套件 | 不重复 |
| `claude-opus-4-5-migration` | 模型升级迁移 | 不重复 |
| `hookify` | hook 创建工具 | CCG 无对应（值得借鉴） |
| `ralph-wiggum` | 自循环开发模式 | CCG 无对应 |
| `security-guidance` | PreToolUse 安全提醒 hook | CCG 通过 `verify-security` skill 部分覆盖 |
| `frontend-design` | 单 skill 通用前端设计 | ⚠️ CCG impeccable 20 命令冗余 |

**结论**: CCG 命令面板有 4 处明显与官方重复（commit / review / feature-dev / frontend）。应考虑要么删 CCG 自实现，要么明确"CCG 版的差异化定位"（多模型 / OPSX 集成）。

---

## 3. 反模式（要避免的）

| # | 反模式 | 解释 | CCG 当前是否中招 | 应避免边界 |
|---|--------|------|------------------|-----------|
| 1 | **过度多角色** | BMAD 12+ 专家 / Scrum Master / PO 等过程角色 | ⚠️ 中度（v3.0.0 +8 specialist 后 15 agent） | agent 数应 ≤ 10，每个有可量化使用频率 |
| 2 | **强制 spec-first** | SpecKit 5 步流程对小任务摩擦极大 | ❌ 未中招（CCG OPSX 是可选） | 保留 quick mode |
| 3 | **同步串行多 agent** | 不并行就吃 token + 慢 | ❌ 未中招（CCG 有 Codex∥Gemini） | 必须并行的强制并行 |
| 4 | **过深 ROADMAP 嵌套** | 5+ 层 phase 拆分用户记不住 | ⚠️ `/ccg:team` 8 阶段已接近上限 | 主线流程 ≤ 5 阶段 |
| 5 | **硬编码模型名** | codex-1.0.5 vs gpt-5 类 | ✅ 已修（v2.1.0+ 路由可配） | 持续保持 |
| 6 | **系统提示词膨胀** | >5k tokens 系统提示词 | ⚠️ 100+ skill 描述未审计 | 守住 1% 上下文预算 |
| 7 | **Plugin 重复造轮子** | 已有官方 commit/review 还自造 | ⚠️ 中招（4 处重复） | 优先 leverage 官方 plugin |
| 8 | **命令面板过宽** | 35 命令并列，新用户晕 | ⚠️ 中招 | 命令应 ≤ 20，用 minimal/full 分级 |
| 9 | **Skill 无 fork-context** | 所有 skill 主线展开 | ⚠️ 中招（CCG skill 全主线） | 重型 skill 应 `context: fork` |
| 10 | **状态全在主线 context** | 任务状态污染主对话 | ⚠️ 中招（仅 .context 雏形） | 状态外化文件 |
| 11 | **微命令拆分**（impeccable 20 个） | polish/audit/harden/clarify... 用户记不住 | ⚠️ 中招 | 合并为 1-3 个总命令 + skill 内分流 |
| 12 | **缺乏 confidence 过滤** | 双模型审查直接展示原文 | ⚠️ 中招 | 借 code-review 0-100 评分模式 |
| 13 | **无最小集入口** | init 一次装全 100+ 文件 | ⚠️ 中招 | 借 TaskMaster `--minimal` |
| 14 | **角色 backstory 漂移** | 每命令重写 prompt 角色 | ⚠️ 中度 | 角色固化到 prompts/ 目录 |
| 15 | **手动 background 估算** | 用户自己判断长短 | ⚠️ 中招（spec-impl 等） | 借 codex 自动 shortstat 估算 |

---

## 4. CCG 现状审计（命令 / agent / skill 三层）

### 4.1 35 个命令面板审计

> 评级：**A** 高频核心保留 | **B** 偶尔有用保留但简化 | **C** 重叠或冗余建议合并/删 | **D** 几乎没人用建议废弃

#### 开发工作流（14 个）

| 命令 | 评级 | 判断依据 |
|------|------|----------|
| `/ccg:workflow` | A | 旗舰命令，6 阶段全流程，多模型路由清晰 |
| `/ccg:plan` | A | 高频独立调用，Phase 1-2 |
| `/ccg:execute` | A | 高频独立调用，Phase 3-5 |
| `/ccg:codex-exec` | B | 适合 token 节省场景，但与 `/ccg:execute` 定位重叠 |
| `/ccg:context` | B | `.context/` 管理刚加（v1.7.80），新功能待验证使用频率 |
| `/ccg:enhance` | A | prompt 增强独立工具，新手必备 |
| `/ccg:frontend` | C | 与 `/ccg:workflow` 智能路由功能重叠，建议合并 |
| `/ccg:backend` | C | 同上，与 `/ccg:workflow` 路由重叠 |
| `/ccg:feat` | C | 描述"智能功能开发"——与 `/ccg:workflow` 边界不清 |
| `/ccg:analyze` | A | 仅分析不实施，独立场景明确 |
| `/ccg:debug` | A | 高频独立工具 |
| `/ccg:optimize` | B | 性能优化场景独立但触发频率低 |
| `/ccg:test` | B | 测试生成有用但很多人手写 |
| `/ccg:review` | A | 高频，git diff 自动审查 |

#### 项目管理（1 个）
| `/ccg:init` | A | 初始化 CLAUDE.md 必备 |

#### Git 工具（4 个）
| `/ccg:commit` | A | 高频 |
| `/ccg:rollback` | B | 偶尔用 |
| `/ccg:clean-branches` | B | 偶尔用 |
| `/ccg:worktree` | B | 仅 worktree 用户用 |

#### OPSX（5 个）
| `/ccg:spec-init` | A | OPSX 入口必备 |
| `/ccg:spec-research` | A | 高频 |
| `/ccg:spec-plan` | A | 高频 |
| `/ccg:spec-impl` | A | 高频 |
| `/ccg:spec-review` | B | 独立工具，不一定与 spec 流程绑定 |

#### Agent Teams（5 个，需 EXPERIMENTAL flag）
| `/ccg:team` | A | 8 阶段统一工作流，旗舰但需要更显式定位 |
| `/ccg:team-research` | C | 独立调用使用率低，与 `/ccg:team` 阶段重复 |
| `/ccg:team-plan` | C | 同上 |
| `/ccg:team-exec` | B | 独立 spawn Builder 用得到 |
| `/ccg:team-review` | C | 与 `/ccg:review` 高度重叠 |

#### v3.0.0 新增的（来自 commands 列表中的额外项）
看到 `autonomous.md` / `extract-learnings.md` / `forensics.md` / `health.md` / `map-codebase.md` / `verify-work.md` 共 6 个新增：

| `/ccg:autonomous` | C | 待验证 |
| `/ccg:extract-learnings` | D | 定位不清 |
| `/ccg:forensics` | D | 用例罕见 |
| `/ccg:health` | B | 项目健康检查可以保留 |
| `/ccg:map-codebase` | B | 可以保留但与 `gen-docs` 重叠 |
| `/ccg:verify-work` | C | 与 verify-* skill 重叠 |

**审计统计**:
- A 级（保留+强化）: 14
- B 级（保留但简化）: 10
- C 级（合并或删）: 8
- D 级（废弃）: 3
- **建议命令面板总数: 14（A）+ 6-8（精简后的 B）= 20-22 个**

---

### 4.2 15 个 subagent 审计

| Agent | 评级 | 判断 |
|-------|------|------|
| `planner` | A | 多命令调用，核心 |
| `ui-ux-designer` | B | 仅前端流程用 |
| `init-architect` | A | `/ccg:init` 必需 |
| `get-current-datetime` | A | 工具 agent，多处用 |
| `team-architect` | A | `/ccg:team` 必需 |
| `team-qa` | A | `/ccg:team` 必需 |
| `team-reviewer` | A | `/ccg:team` 必需 |
| `assumptions-analyzer` | 待验证 | v3.0.0 新增 |
| `eval-auditor` | 待验证 | v3.0.0 新增 |
| `framework-selector` | 待验证 | v3.0.0 新增 |
| `integration-checker` | 待验证 | v3.0.0 新增 |
| `nyquist-auditor` | 待验证 | v3.0.0 新增（命名晦涩） |
| `pattern-mapper` | 待验证 | v3.0.0 新增 |
| `plan-checker` | 待验证 | v3.0.0 新增 |
| `verifier` | 待验证 | v3.0.0 新增 |

**风险**: 8 个 v3.0.0 specialist 全是"待验证"，如果 30 天内调用 < 5 次 / agent，应砍掉。BMAD 反模式警示在前。

**建议 agent 总数: 7 核心保留 + 最多 3 个验证后留下 = 10 个**

---

### 4.3 100+ skill 文件审计

#### `tools/`（quality gate）：6 个
- `verify-security` / `verify-quality` / `verify-change` / `verify-module` / `gen-docs` / `override-refusal`
- 全部 A 级（核心质量关卡）
- `lib/` 是内部库不计入

#### `domains/`（10 大域 61 文件）：保留度评估

CCG 把 61 个域文件作为 skill 装到 `~/.claude/skills/ccg/domains/`，每个 SKILL.md 都有 frontmatter。**关键问题**：

1. **会被读到吗？** 根据 `~/.claude/rules/ccg-skill-routing.md`，路由是触发关键词时主动 read，**不是 frontmatter 自动加载**。所以这些是"on-demand reference"，正确。
2. **但** 如果 frontmatter description 也算入 1% 上下文预算（8000 字符 cap），61 个 × 平均 100 字符 description = 6100 字符——已逼近上限！加上其他 50+ skill 的描述会被截断。
3. **建议**: 给 domain skills 加 `user-invocable: false`，让它们不出现在 `/` 菜单，但保留 description 用于路由匹配。

#### `impeccable/`（20 个 UI/UX）：B 级偏 C
- 对应官方 frontend-design plugin 1 个 skill。
- polish / audit / harden / clarify / critique / animate / arrange / bolder / clarify / clean-branches / colorize / delight / distill / extract / harden / normalize / onboard / overdrive / quieter / typeset
- **建议**: 合并为 1-3 个总入口（`/ccg:design-polish` 包子命令模式），或作为 description-only skill 让 Claude 自动选。

#### `orchestration/multi-agent/`：A 级
- 多 agent 编排核心知识。

#### `scrapling/`：B 级
- 网页抓取专项工具，独立场景明确。

#### `override-refusal/`：B 级
- `/hi` 命令对应 skill，定位明确但小众。

**Skill 总规模建议**:
- 当前 100+ → 收敛到 **40-50** 个常驻可见 skill
- domains/ 61 个保留但全部 `user-invocable: false`
- impeccable/ 20 → 合并为 5-8 个

---

### 4.4 8 种 output style 审计

| Style | 类型 | 评级 |
|-------|------|------|
| `engineer-professional` | 核心专业风格 | A |
| `nekomata-engineer` | Entertainment | B |
| `laowang-engineer` | Entertainment | B |
| `ojousama-engineer` | Entertainment | B |
| `abyss-cultivator` | Entertainment | B |
| `abyss-concise` | 真差异化（冷刃简报） | A |
| `abyss-command` | 真差异化（铁律军令） | A |
| `abyss-ritual` | 真差异化（祭仪长卷） | B |

**判断**: 4 个 entertainment style 不应作为默认安装的核心，可以全部归到 `init --with-fun` 可选参数。3 个 abyss 真有差异化（语气强度），应在 `init` 默认列出选择。

---

## 5. "CCG 最佳形态"目标参考

每条目标参考一个被验证的项目作为锚点：

| 维度 | 当前 CCG | 建议目标 | 锚点项目 |
|------|---------|---------|----------|
| Slash 命令总数 | 35 | **18-22** | Anthropic 官方 commit-commands 仅 3 个 / SpecKit 5 个 / 官方 code-review 1 个 |
| Subagent 总数 | 15 | **8-10** | claude-plugins-official 多数 plugin 0-3 agent / feature-dev 3 个 |
| Skill 文件总数（用户可见） | 100+ | **40-50** | TaskMaster 7 核心工具集 / firecrawl 2026 高安装 skill 都是窄定义 |
| Skill 文件总数（含 user-invocable: false 隐藏） | 100+ | 100+ 可保 | Anthropic Skills 文档支持隐藏 background-knowledge skill |
| 单次 init 系统提示词预算 | 未量化 | **≤ 8000 字符总 description** | code.claude.com/docs/en/skills 1% 上下文预算（默认 8000 字符 cap） |
| 主线 context skill body 预留 | 未约束 | **≤ 25000 tokens（auto-compaction 后）** | Anthropic Skills 官方 compaction 预算 |
| 安装到首个 PR 时间（DX） | 未测 | **≤ 15 分钟** | TaskMaster 一键 mcp add / SpecKit 5 命令链 |
| 命令分级 | 无 | **3 级（minimal 7 / standard 15 / full 22）** | TaskMaster TASK_MASTER_TOOLS（7/36） |
| 与官方 plugin 重复度 | 4 处（commit / review / feature / frontend） | **0 处或明确差异化定位** | 官方 plugin marketplace 13 个生态 |
| Skill body 平均行数 | 未量化 | **≤ 500 行** | Anthropic 官方 "Keep SKILL.md under 500 lines" |
| 工作流主线阶段数 | `/ccg:team` 8 阶段 | **≤ 5 阶段（main path）** | SpecKit 5 命令 / Anthropic 5 模式 |

---

## 6. ROI 排序：进 v3.1/v4.0 的最高价值 7 个借鉴

按 ROI（收益 ÷ 成本）排序：

1. **命令面板从 35 收敛到 ~20** ← Anthropic 官方"Simplicity"原则 + SpecKit 5 命令实证
2. **Skill description 总长 1% 预算审计** ← code.claude.com/docs/en/skills 硬约束
3. **重型命令加 `context: fork`** ← Anthropic Skills 官方支持，主线 context 立省 60%+
4. **异步任务三件套（status/result/cancel）** ← openai-codex plugin 现成模式
5. **Confidence 0-100 过滤层** ← claude-plugins-official/code-review 标准做法
6. **`init --minimal` 分级安装** ← TaskMaster `TASK_MASTER_TOOLS` 7-vs-36 模式
7. **leverage 官方 plugin 不重造** ← commit-commands / code-review 现成可用

---

## 7. 关键模式深度解析（补充章节）

本节针对前面表格点到为止的几个高 ROI 模式，给出更具体的源文档对照与落地形态分析。

### 7.1 Progressive Disclosure 三层模型详解

来自 https://code.claude.com/docs/en/skills 的官方表述揭示了 Skills 设计的核心张力：

> "skills' body loads only when it's used, so long reference material costs almost nothing until you need it"

实际运作分三层：

**第 1 层 — Frontmatter 常驻（约 100 tokens/skill）**
- 仅 `name` + `description` + `when_to_use` 进入 context。
- 所有 skill 名称必加，但 description 共享 1% 上下文预算（fallback 8000 字符）。
- 超量时按字母序后置截断，触发 `SLASH_COMMAND_TOOL_CHAR_BUDGET` 调高。
- **CCG 现状**: 100+ skill 描述未量化，存在被截风险。

**第 2 层 — SKILL.md body（按需加载，每次全量进 context）**
- 用户 `/skill-name` 或 Claude 自动匹配后整体注入。
- 单次会话的多次调用不会重新读文件——已在 context 内。
- Auto-compaction 后保留前 5000 tokens，所有 skill 共享 25000 tokens 总预算。
- 官方建议 ≤ 500 行。
- **CCG 现状**: domain/security/red-team.md 等大文件可能超 500 行。

**第 3 层 — 子文件按需读（reference.md / examples.md / scripts/）**
- SKILL.md 中以 markdown link 引用，Claude 用 Read tool 拉取。
- 不计入 skill 自身的 5000-token 预算（被读后是普通对话内容）。
- **CCG 现状**: `tools/lib/` 和 `domains/*/` 子文件结构已对齐这层，但很多大段内容塞在 SKILL.md 主体而非外移。

**落地建议**: 对 100+ skill 做一次审计——SKILL.md 主体只放"路由 + 摘要"，详细操作步骤外移到 `playbook.md`、参考表外移到 `reference.md`。

---

### 7.2 异步任务三件套：openai-codex plugin 实战拆解

CCG 当前的"长任务"机制是 `--progress` 参数让 wrapper 输出 stderr 行。这只解决了"知道还活着"，没解决"在多个会话间追溯"。

openai-codex plugin 的方案（来自 status.md / result.md / cancel.md / hooks.json）：

**核心数据结构**: 每个 background 任务有 `job-id`，存储在仓库本地（推断为 `.codex/jobs/<id>/`）。

**生命周期**:
1. `/codex:rescue --background <task>` → 启动 → 立即返回 job-id。
2. Hook `SessionEnd` 检查 active job，提示用户。
3. `/codex:status` 默认列当前 session 所有 job 表格（job-id / kind / status / phase / elapsed / summary）。
4. `/codex:status <job-id>` 看单个详情。
5. `/codex:status <job-id> --wait --timeout-ms 60000` 阻塞等。
6. `/codex:result <job-id>` 取最终 verdict / summary / findings / artifacts。
7. `/codex:cancel <job-id>` 中止活跃 job。

**hooks.json 关键设计**:
```json
"Stop": [{ "type": "command", "command": "...stop-review-gate-hook.mjs", "timeout": 900 }]
```
- `Stop` hook 900 秒超时——支持长达 15 分钟的等待。
- `SessionStart`/`SessionEnd` 5 秒 timeout——快速生命周期管理。

**对 CCG 的启示**:
- CCG `/ccg:codex-exec` 当前是同步执行，应有"启动后立即给 job-id"的选项。
- CCG `.context/` 已有目录结构基础，可以扩展为 `.context/jobs/<id>/` 存 job 状态。
- 可注册 SessionStart hook 显示"上次 session 还有 N 个 job 未完成"。

---

### 7.3 Confidence 评分过滤层：code-review plugin 的反噪声策略

claude-plugins-official/code-review 的 7 步流程（来自 code-review.md）有一个关键创新：**双层过滤**。

第一层（Step 4）让 5 个 Sonnet agent 独立审查：CLAUDE.md 合规 / 浅层 bug / git blame 历史 / 历史 PR 评论 / 代码注释合规。

第二层（Step 5）让 N 个 Haiku agent **每个 issue 独立评分**：

> "0=Not confident at all (false positive); 25=Somewhat confident; 50=Moderately confident; 75=Highly confident; 100=Absolutely certain"

第三层（Step 6）：**过滤 < 80 分**。

明确列出的 false positive 类型：
- 已存在的 issue（不是 PR 引入的）
- 看起来像 bug 但不是
- pedantic nitpicks
- linter/typechecker 会抓的（认为 CI 会跑）
- 一般代码质量（除非 CLAUDE.md 显式要求）
- 已有 lint ignore 的
- 未修改行的 issue

**对 CCG 的启示**:

CCG `/ccg:review` 当前直接展示双模型原文，平均给出 10-15 个 finding，其中很多是 noise。借鉴这层过滤，可能把展示量降到 3-5 个高质量 finding。

具体落地：双模型分析后增加一步——让 Claude 对每个 finding 0-100 评分（自己当 Haiku 用），过滤 < 80。

---

### 7.4 `context: fork` 的双向使用（Anthropic Skills 文档官方表）

来自 https://code.claude.com/docs/en/skills 的关键表格揭示 Skills 和 Subagents 的两种组合方式：

| 方式 | 系统提示词来源 | Task 来源 | 同时加载 |
|------|---------------|-----------|----------|
| Skill 加 `context: fork` | 来自 agent type（Explore/Plan 等） | SKILL.md 内容 | CLAUDE.md |
| Subagent 用 `skills` 字段 | Subagent markdown body | Claude 的 delegation 消息 | 预加载的 skills + CLAUDE.md |

**第 1 种**：你写 task in skill，挑选 agent type 执行。

官方 deep-research 示例:
```yaml
---
name: deep-research
context: fork
agent: Explore
---

Research $ARGUMENTS thoroughly:
1. Find relevant files using Glob and Grep
2. Read and analyze the code
3. Summarize findings with specific file references
```

**第 2 种**: 自定义 subagent 用 skills 作 reference 材料。

**对 CCG 的启示**:
- CCG `verify-security` / `gen-docs` 这类工具型 skill 应该全部加 `context: fork` + `agent: Explore`。
- 当前所有 skill 在主线展开，意味着大段扫描、Grep 结果污染主对话。
- 加 fork 后主线只看返回摘要，节省 60-80% context。

---

### 7.5 Anthropic 官方 5 大基础模式 vs CCG 实现度

来自 https://www.anthropic.com/research/building-effective-agents：

| 模式 | 描述 | CCG 对应 | 完成度 |
|------|------|----------|-------|
| **Prompt chaining** | 多步线性链，每步处理上一步输出 | OPSX 4 步 / `/ccg:workflow` | ✅ |
| **Routing** | 先分类再选 prompt/agent | `/ccg:workflow` 智能前后端 | ✅ |
| **Parallelization** | 多 agent 并行同任务 | Codex∥Gemini | ✅ |
| **Orchestrator-workers** | Lead 拆任务，多 worker 并行 | Agent Teams | ✅ |
| **Evaluator-optimizer** | 评估器评分→优化器改→循环 | `/ccg:team` 2 轮 fix | ✅ |

CCG 5 种模式都已落地，**问题在哪**？

> 引用 Anthropic："Start with simple prompts, optimize them with comprehensive evaluation, and add multi-step agentic systems only when simpler solutions fall short"

CCG 的偏离：
1. 不论任务大小默认走多模型协作（违反"start simple"）。
2. 没有评估机制看"何时升级到 agent"——没有 KPI 监控简单方案是否够用。
3. 35 命令并列，缺一个明确的"如果你不知道用啥就用 X"的入口。

**修正方向**: 单独立一个 `/ccg:simple` 或让 `/ccg:enhance` 在结尾推荐"是否升级到 multi-model"，而非默认走 multi-model。

---

### 7.6 SpecKit 5 命令链 vs CCG OPSX 4 命令链

SpecKit（5 命令）：
1. `/speckit.constitution` — 项目宪法（治理原则）
2. `/speckit.specify` — 功能规范（user story）
3. `/speckit.plan` — 技术实施策略
4. `/speckit.tasks` — 可操作任务拆分
5. `/speckit.implement` — 系统执行

CCG OPSX（4 命令）：
1. `/ccg:spec-init` — 初始化 + MCP 验证
2. `/ccg:spec-research` — 需求 → 约束集
3. `/ccg:spec-plan` — 多模型分析 → 计划
4. `/ccg:spec-impl` — 执行 + 归档

**差异分析**:
- SpecKit 把"立宪"（项目原则）独立成第一步，CCG 没有对应——CCG 的 CLAUDE.md 起类似作用但不是命令驱动的"check-in"。
- SpecKit 把 plan 和 tasks 分两步（先策略后具体任务），CCG plan 同时输出策略+任务（一锅烩）。
- CCG 多了"研究阶段"输出约束集——这是 SpecKit 没有的优势。
- SpecKit 5 个命令均强制执行，CCG 4 个命令任意位置可入。

**取舍建议**: CCG 不必走到 5 命令，但应考虑把 spec-plan 输出拆成"策略文档 + tasks.md"两文件，对应 SpecKit plan/tasks 拆分的好处。

---

### 7.7 BMAD "Party Mode" 多 persona 对辩

BMAD 文档提到一个 CCG 没有的特性：

> "**Party Mode** — Multiple agent personas collaborate in single sessions"

含义: 用户在同一对话窗口中，可以让多个角色（Architect / Dev / UX）轮流回应或互相质疑。

**与 CCG 多模型协作的差异**:
- CCG 当前: Codex 和 Gemini 独立产出 → Claude 综合。两个模型不直接对话。
- BMAD Party Mode: 多 persona 在主线轮转、可互相 challenge。
- 对辩深度更高（adversarial），适合方案讨论；CCG 更高效（并行），适合分析。

**潜在借鉴**: 在 `/ccg:plan` 后增加可选的 `--debate` flag，触发"Codex 提议→Gemini 反驳→Codex 修正"3 轮限定对话。

---

### 7.8 命令-Skill-Agent 三层关系图（按官方文档梳理）

来自 https://code.claude.com/docs/en/skills 的 Note：

> "Custom commands have been merged into skills. A file at .claude/commands/deploy.md and a skill at .claude/skills/deploy/SKILL.md both create /deploy and work the same way."

**对 CCG 的关键影响**:

CCG 当前同时存在 `templates/commands/` 和 `templates/skills/`，两者在最新 Claude Code 中已经是同等机制。意味着：

1. CCG 35 个 commands 完全可以重写为 skill 形式（带 frontmatter）。
2. Skill 形式的优势: 可以有支持文件目录、可以 `disable-model-invocation`、可以 `paths` 限定激活、可以 `context: fork` 隔离。
3. CCG 现在用 commands 形式，错失了 skill 提供的高级特性。

**长期方向**: v4.0 应该把所有 `commands/*.md` 迁移到 `skills/<name>/SKILL.md` 形式。同时利用 frontmatter 实现命令分级（`user-invocable: false` 隐藏 specialist 用 agent / `paths: "*.tsx"` 限定 frontend 工具）。

---

## 8. 结构对比矩阵（一图概览 CCG vs 5 个生态系统）

| 维度 | CCG | SpecKit | BMAD | TaskMaster | code-review plugin | feature-dev plugin |
|------|-----|---------|------|-----------|------------------|------------------|
| 命令数 | 35 | 5 | "12+ 角色"（命令未明） | 主要 CLI 工具 | 1 | 1 |
| Agent 数 | 15 | 0 | 12+ | 0 | 5+N（运行时） | 3 |
| 强制流程 | 否 | 是 | 部分 | 否 | 否 | 是（7 阶段） |
| 状态外化 | 部分（.context） | 是（spec 文件） | 是（项目目录） | 是（tasks.json） | 否 | 否 |
| 多模型 | ✅（Codex∥Gemini） | ❌ | ✅（多 persona） | ❌ | ❌（多 Sonnet） | ❌ |
| Confidence 过滤 | ❌ | ❌ | ❌ | ❌ | ✅（≥80） | ❌ |
| 异步任务 | 部分（progress） | ❌ | ❌ | ❌ | ❌ | ❌ |
| Skill 数量 | 100+ | 0（命令式） | 0 | 0 | 0 | 0 |
| Hook 数量 | 0 | 0 | 0 | 0 | 0 | 1 |

**观察**: CCG 是这些项目中**最重的**——命令、agent、skill、模型集成都最多。Anthropic 官方"Simplicity"原则警示：当一个工具看起来"什么都有"时，往往意味着没有清晰的核心。

---

## 9. 用户体验视角的反思

### 9.1 新用户首次接触 CCG 的认知负担

假设一个开发者刚装完 CCG，输入 `/ccg:` 触发自动补全：

```
/ccg:analyze        /ccg:autonomous     /ccg:backend       /ccg:clean-branches
/ccg:codex-exec     /ccg:commit         /ccg:context       /ccg:debug
/ccg:enhance        /ccg:execute        /ccg:extract-...   /ccg:feat
/ccg:forensics      /ccg:frontend       /ccg:health        /ccg:init
/ccg:map-codebase   /ccg:optimize       /ccg:plan          /ccg:review
/ccg:rollback       /ccg:spec-impl      /ccg:spec-init     /ccg:spec-plan
/ccg:spec-research  /ccg:spec-review    /ccg:team          /ccg:team-exec
/ccg:team-plan      /ccg:team-research  /ccg:team-review   /ccg:test
/ccg:verify-work    /ccg:workflow       /ccg:worktree
```

**问题**:
- 35 个名字一屏放不下。
- analyze / debug / review / verify-work 边界模糊。
- workflow / feat / plan / execute 工作流类有 4 个入口。
- spec-* 5 个 + team-* 5 个，与主流程对应关系不清。

**对照 SpecKit 用户**: 看到 5 个就完事，立即明白流程。
**对照 code-review plugin 用户**: 1 个命令，零认知负担。

### 9.2 Anthropic 官方对 "Tool documentation" 的强调

> "Three principles: Simplicity, Transparency, Tool documentation as critical as overall prompts"

CCG 35 个命令的 description 是否清晰传达"何时用 vs 不用"？例如：

- `/ccg:feat` "智能功能开发 - 自动识别输入类型，规划/讨论/实施全流程"
- `/ccg:workflow` "多模型协作开发工作流（研究→构思→计划→执行→优化→评审），智能路由前端→gemini、后端→codex"

两者都说"全流程"——用户怎么选？这是命令面板膨胀+描述含糊的双重打击。

### 9.3 Output style 的认知开销

8 种 output style 在 init 时让用户选——但选了之后用户记得改吗？默认 / engineer-professional / nekomata / laowang / ojousama / abyss-cultivator / abyss-concise / abyss-command / abyss-ritual。

新用户体验：选完一次永远不变。Entertainment style（猫娘/老王/大小姐）在专业团队场景违和。建议：

- 默认装 1 种（engineer-professional）。
- entertainment 4 种作为 `init --with-fun` 可选。
- abyss 3 种作为 `init --with-style` 可选。

---

## 附：扫描信息源清单

### 文档来源
- GitHub SpecKit: https://github.com/github/spec-kit
- BMAD-METHOD: https://github.com/bmadcode/BMAD-METHOD
- TaskMaster AI: https://github.com/eyaltoledano/claude-task-master
- CrewAI: https://github.com/crewAIInc/crewAI
- LangGraph: https://docs.langchain.com/oss/python/langgraph/overview
- Anthropic Building Effective Agents: https://www.anthropic.com/research/building-effective-agents
- Anthropic Skills 设计哲学: https://claude.com/blog/skills
- Claude Code Skills 完整文档: https://code.claude.com/docs/en/skills
- 官方 plugin 列表: https://github.com/anthropics/claude-code/tree/main/plugins
- 2026 高安装 skill 模式: https://www.firecrawl.dev/blog/best-claude-code-skills

### 本机已装 plugin（路径仅供 CCG 内部引用）
- `C:\Users\Administrator\.claude\plugins\cache\openai-codex\codex\1.0.4\`（commands/ 7 个、agents/ 1 个、skills/ 3 个、hooks/ 1 个）
- `C:\Users\Administrator\.claude\plugins\cache\google-gemini\gemini\1.0.1\`（结构镜像 codex）
- `C:\Users\Administrator\.claude\plugins\cache\claude-plugins-official\code-review\unknown\commands\code-review.md`
- `C:\Users\Administrator\.claude\plugins\cache\claude-plugins-official\frontend-design\unknown\skills\frontend-design\`

### CCG 现状取样
- `D:\workflow\ccg-workflow\templates\commands\` 35 命令
- `D:\workflow\ccg-workflow\templates\commands\agents\` 15 subagent
- `D:\workflow\ccg-workflow\templates\skills\domains\` 10 域
- `D:\workflow\ccg-workflow\templates\skills\tools\` 6 质量关卡 + 1 override-refusal
- `D:\workflow\ccg-workflow\templates\skills\impeccable\` 20 UI/UX 工具
