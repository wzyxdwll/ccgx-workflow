# ccgx-workflow — Claude × Codex × Gemini 多模型协作

<div align="center">

[![npm version](https://img.shields.io/npm/v/ccgx-workflow.svg)](https://www.npmjs.com/package/ccgx-workflow)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Compatible-green.svg)](https://claude.ai/code)
[![Tests](https://img.shields.io/badge/Tests-1309%20passed-brightgreen.svg)]()

简体中文 | [English](./README.md)

</div>

> **项目沿革**
>
> `ccgx-workflow` 由 [`ccg-workflow`](https://www.npmjs.com/package/ccg-workflow) v3.x
> 深度 rewrite 而来。原项目在 2026-05 后停止更新且作者主页失联，社区用户
> 依赖的多模型协作工作流面临断维风险。本项目从 v4.0 起完全重新设计：
> fresh-context subagent 协议、Plan-Critic-Verify 三档质量门、OS 级三层
> 进程隔离、broker tx_id 防漂移、8 处 plugin patch 与一键 repatch 脚本。
>
> `/ccg:*` 命令面板对老用户**手势兼容**，但底层架构已完全不同。
> 原项目 MIT 许可下的代码与版权完整保留，详见 [LICENSE](./LICENSE)。

---

## 这是什么

Claude Code 编排 Codex（后端）+ Gemini（前端）的多模型协作开发系统。前端任务自动路由 Gemini，后端任务自动路由 Codex，Claude 负责编排决策与代码审核。

外部模型**无写入权限**——它们只返回 patch，由 Claude 审核后落地。

```
Claude Code (编排)
       │
   ┌───┴───┐
   ↓       ↓
Codex   Gemini
(后端)   (前端)
   │       │
   └───┬───┘
       ↓
  Unified Patch
```

## 核心特性

- **零配置模型路由** — 前端 → Gemini / 后端 → Codex，按 phase frontmatter 的 `Type:` 字段自动派发，无需手动切换
- **~30 个 `/ccg:*` 斜杠命令** — 从规划到执行、Git 工作流到代码审查、自治长跑、异步任务三件套
- **三档质量门** — `--quality=fast|triple|debate` 单一开关切换 Plan-Critic-Verify 协作深度
- **fresh-context subagent 协议** — `phase-runner` / `code-fixer` / `debug-session-manager` 把主线 context 压在 ≤15%，主线只接 ≤200 token 摘要
- **OS 级三层进程隔离** — `Bash(claude -p --agent ccg/phase-runner)` 替代主进程内 sidechain，治理主进程 RSS 泄漏
- **OPSX 规范驱动** — 集成 [OPSX](https://github.com/fission-ai/opsx)，把模糊需求变成可验证约束，让 AI 没法自由发挥
- **plugin 优先 + wrapper fallback** — codex/gemini 官方 plugin 装了走 plugin spawn，没装回退 `codeagent-wrapper`

---

## 快速开始

### 前置条件

| 依赖 | 必需 | 说明 |
|------|------|------|
| **Node.js 20+** | 是 | `ora@9.x` 要求 Node ≥ 20 |
| **Claude Code CLI** | 是 | [安装方法](#安装-claude-code) |
| **jq** | 是 | 自动授权 Hook 依赖（[安装方法](#安装-jq)） |
| **codex 接入** | **二选一** | `codex@openai-codex` plugin（推荐）**或** `npm i -g @openai/codex` |
| **gemini 接入** | **二选一** | `gemini@google-gemini` plugin（推荐）**或** `npm i -g @google/gemini-cli` |

> **为什么是「二选一」**：ccgx-workflow 优先走 plugin（Claude Code 一键装、内置鉴权）。
> plugin 没装时降级到 `~/.claude/bin/codeagent-wrapper` shim 启动独立 CLI。两条路
> **任一**没装的，对应 `/ccg:*` 命令在调 codex/gemini 时会以 exit 127 退出并打印
> 安装提示。

### 一键安装

```bash
npx ccgx-workflow
```

首次运行会提示选择语言（简体中文 / English）、API 提供方、MCP 工具，全部交互式完成。CLI 命令名仍为 `ccg`（保持老用户肌肉记忆）。

### 安装 jq

```bash
# macOS
brew install jq

# Linux (Debian/Ubuntu)
sudo apt install jq

# Linux (RHEL/CentOS)
sudo yum install jq

# Windows
choco install jq   # 或: scoop install jq
```

### 安装 Claude Code

```bash
npx ccgx-workflow menu  # 选择「安装 Claude Code」
```

支持 npm / homebrew / curl / powershell / cmd。

---

## 启用多模型协作（codex / gemini 接入）

ccgx-workflow 需要 codex + gemini 接入，每个走 **两条路之一**：

### 路径 A — Claude Code plugin（推荐）

在 Claude Code 内执行：

```
/plugin install codex@openai-codex
/plugin install gemini@google-gemini
```

一键安装，鉴权由 Claude Code 接管。模板直接 spawn plugin agent
（`Agent(codex:codex-rescue)` / `Agent(gemini:gemini-rescue)`），不经过 shim。

### 路径 B — 独立 CLI fallback

```bash
# codex CLI
npm i -g @openai/codex
codex login

# gemini CLI
npm i -g @google/gemini-cli
gemini auth login
```

plugin 没装时，模板通过 `~/.claude/bin/codeagent-wrapper`（一个调 `codex` /
`gemini` 的 Node shim）落地。鉴权 key 自己配。

### 混搭

可以 codex 走 plugin、gemini 走 CLI，反之亦然。ccgx-workflow 每次调用独立检测，
按可用路径择优。

`@` 后是 marketplace identifier。如果提示 marketplace 未配置，在 Claude Code 里执行 `/help plugin` 查看本地 marketplace 管理命令，或参考 [Claude Code plugin 官方文档](https://docs.claude.com/en/docs/claude-code/plugins)。

> 上游 plugin 仓库地址（用于排错 / 提 issue）：
> - **codex**: `openai-codex` marketplace（Claude Code 官方）
> - **gemini**: [sakibsadmanshajib/gemini-plugin-cc](https://github.com/sakibsadmanshajib/gemini-plugin-cc)

### 验证安装

```bash
ls ~/.claude/plugins/cache/openai-codex/codex/
ls ~/.claude/plugins/cache/google-gemini/gemini/
# 应能看到版本目录（如 1.0.4 / 1.0.1）
```

### ⚠️ Gemini plugin Windows 已知问题（强烈建议 patch）

`gemini@google-gemini` v1.0.1 在 Windows 上有 **8 处 spawn 缺 `windowsHide: true`** 的 bug，会导致：

- 调用时短暂闪现 cmd 黑窗、抢应用焦点（高频）
- 底层 ACP broker spawn `gemini.cmd` 时 ENOENT 报错（被 plugin 错误处理路径序列化为 `[object Object]`）
- broker daemon 启动 / `gemini --version` 健康检查 / `taskkill` / `where gemini` 等环节都会闪框

**ccgx-workflow 内置一键 repatch 脚本**（幂等，可重复运行）：

```bash
node ~/.claude/.ccg/scripts/repatch-gemini-plugin.mjs
```

脚本行为：
1. 自动定位 plugin 版本目录
2. 检查每处 patch 状态（probe 字符串匹配）
3. 已 patch 的 [SKIP]，未 patch 的 [APPLY]
4. 完成后提示重启 broker daemon 命令

⚠️ **重要**：每次 `claude plugin update gemini@google-gemini` 后 plugin update 会覆盖 cache，**必须重跑 patch 脚本**。

⚠️ **patch 后重启 broker daemon**（旧 daemon 仍跑未 patch 代码）：

```powershell
# Windows PowerShell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'acp-broker' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

或简单点：`/plugin disable gemini@google-gemini` 然后 `/plugin enable gemini@google-gemini`。

8 处 bug 的根因 + 临时 patch + 永久路径全部归档在 [`.ccg-migration/PLUGIN-PATCHES.md`](./.ccg-migration/PLUGIN-PATCHES.md)。上游 PR 准备中，合并后此 patch 自动失效。

---

## 与 ccg-workflow 的关系

ccgx-workflow **不是 fork**——上游 `ccg-workflow` 公开版本截止在 v3.x，2026-05 后停更；本项目的 v1.0 是基于 v3.x 之上从零重新设计的独立产品（内部经历约 3 天 / 92 commit / 1141 个新测试的密集迭代后定稿）。

### 新增功能与特性

#### 🆕 新增命令（vs v3.x）

| 命令 | 说明 |
|------|------|
| `/ccg:debate` | **多轮辩论原语**——codex propose ↔ gemini challenge ↔ codex respond，cap N 轮，schema 硬校验 retry protocol |
| `/ccg:status [job-id]` | **异步任务三件套之一**——dashboard 模式聚合多 phase 进度 / `--wait --timeout-ms` 阻塞 / `--tail` 流式 + 3 类卡点警告 |
| `/ccg:status --cancel <phase-id>` | 单 phase cooperative cancel + grace + kill-tree 强杀（Windows `taskkill /T /F` + POSIX `setsid` 进程组） |
| `/ccg:result <job-id>` | 取最终 verdict / summary / artifacts，主线接 ≤200 token 摘要 |
| `/ccg:cancel <job-id>` | 中止活跃 job，写 `cancel.flag` cooperative → 5s grace → kill-tree |
| `/ccg:verify --gate=<name>` | **统一 verify 入口**——合并 v3.x 的 `verify-{change,quality,security,module}` 4 个独立命令，加 `--gate=all` 自动多门串联 |
| `/ccg:verify-work` | **会话式 UAT + cold-start smoke 注入**——UAT.md 跨 `/clear` 持久 frontmatter + git diff 扫 server/db/migrations 自动注入冷启动测试 |

#### 🚀 增强命令（vs v3.x）

| 命令 | v3.x | ccgx-workflow |
|------|------|---------------|
| `/ccg:autonomous` | 串行 phase | **wave 拓扑分波并行** + cascade skip + max-concurrent batching；`--quality=fast/triple/debate` 三档质量门 + per-phase frontmatter override |
| `/ccg:review` | 双模型审查 | 加 `--fix --auto` worktree 隔离闭环修复（4 步事务清理：merge/remove/branch -D/rm sentinel） |
| `/ccg:debug` | 单步诊断 | manager + debugger **双层 fresh-context**——多轮 falsifiable hypothesis + 持久 session 在 `.context/debug/<slug>.md` |
| `/ccg:team` | 4 独立命令 | 8 阶段统一工作流（research→plan→exec→review→fix→integrate）+ 7 角色自动编排 + Evaluator-Optimizer 反馈环（最多 2 轮自动修复 Critical） |

#### 🤖 新增 Agent（vs v3.x 的 7 个）

**fresh-context 协议组**（4 个，主线只接 ≤200 token 摘要）：

| Agent | 职责 |
|-------|------|
| `phase-runner` | 自治长跑 phase 实施者——`Bash(claude -p --agent ccg/phase-runner)` 启 OS 级子进程，stream-json 流式输出落 `.context/jobs/<id>/progress.jsonl` |
| `code-fixer` | review --fix 闭环修复——git worktree 隔离 + 3 层 verification + 原子 commit |
| `debug-session-manager` | debug 多轮编排——隔离 context 跑 hypothesis 调试循环，主线接 ≤200 token 摘要 |
| `debugger` | 科学方法 hypothesis 构造——受 manager 调度的纯诊断 specialist |

**specialist 矩阵**（8 个，role × layer 2D 分发）：

| Agent | 职责 |
|-------|------|
| `assumptions-analyzer` | 假设审问官——强制 first-principles，列无证据推断 + 证据缺口 |
| `pattern-mapper` | 模式映射——实施前扫描代码库现有模式，给 builder "照抄哪里"的精确锚点 |
| `plan-checker` | 计划核验——5 维度强校验 GSD 高 ROI 子集 + max-3-loop 收敛环；BLOCKER 退回 planner |
| `nyquist-auditor` | 深度审计——专攻边界、并发竞争、错误传播链、资源泄漏 |
| `verifier` | 交付核验——逐条对照需求清单，输出 PASS/FAIL/PARTIAL 矩阵 + Level 4 数据流（FLOWING/STATIC/DISCONNECTED/HOLLOW_PROP） |
| `integration-checker` | 跨模块接口契约——找格式漂移 / 调用方未更新 / 孤立导出 |
| `framework-selector` | 技术选型评审——现状 vs 提案对比，强制验证现状不能解决才能进 |
| `eval-auditor` | 评估闭环审计——抽样 / 对照 / 指标博弈 / 结论可证伪性审计 |

加上 v3.x 已有的 7 个核心 agent（planner / ui-ux-designer / init-architect / get-current-datetime / team-architect / team-qa / team-reviewer），ccgx-workflow 共 **19 个 subagent**。

#### 🔧 新增机制 / 基础设施

| 机制 | 说明 |
|------|------|
| **三档质量门** | `--quality=fast`（2 wave / impl + verify）/ `triple`（4 wave / plan + critic + impl + verify，默认）/ `debate`（7 wave / + 3 round propose-challenge-respond，cap 3） |
| **wave 拓扑调度** | Kahn 拓扑分波 + cascade skip + max-concurrent batching，墙钟压缩 30-40%，`--sequential` opt-out |
| **OS 级三层进程隔离** | 主 claude.exe → `Bash(claude -p)` 子进程 → 可选 plugin 进程组；治理 v3.x 主进程 RSS 泄漏（uni-iam 实测撞 23GB → ccgx 设计目标 < 8GB） |
| **broker tx_id 防漂移** | 每次 spawn 注入 `CCG_BROKER_TX_ID` (crypto.randomUUID)，broker.log 8 字段强 schema；100k spawn 0 碰撞 / 2k concurrent 0 misattribution（实测） |
| **`context_budget` frontmatter 硬约束** | 4 主编排器声明 `context_budget: orchestrator-15`，禁止 slurp builder stdout |
| **`.context/<phase>/{CONTEXT,SUMMARY}.md`** | phase-scoped 状态机，主线只读 frontmatter（< 200 tokens/phase） |
| **`.context/codebase/` 七文件契约** | codebase-mapper agent 4 路并行扫描产出（STACK/INTEGRATIONS/ARCHITECTURE/STRUCTURE/CONVENTIONS/TESTING/CONCERNS） |
| **silent fallback 治理** | verify wave Bash 直调（架构性消除）+ debate retry protocol schema 硬校验（4 类违规枚举：parse-failed / insufficient-attempts / missing-reason / silent-success） |
| **scope reduction detection** | plan-checker 维度 7b——识别 "v1 / 简化 / 静态先 / 后续连接" 关键词 + 与原始需求 80% 重叠匹配，BLOCKER 拦截 |
| **commit-msg-review git hook** | opt-in pre-commit-msg hook，3 启发式（文件名 ⊆ staged / phase tag ↔ staged paths / 操作类型 ↔ diff） |
| **ground-truth-sampler** | autonomous 启动时动态采样 plugin/skill/agent 列表写 `.context/ground-truth/latest.json`，phase-runner prompt 强约束必须 Read 之 |
| **interface-auditor specialist** | autonomous verify wave triple/debate 档加 3rd spawn——5 检查清单 SSoT-violation / leftover / magic-string-vs-ground-truth / 未验证假设 / API drift |
| **Gemini plugin Windows repatch** | `~/.claude/.ccg/scripts/repatch-gemini-plugin.mjs` 一键 patch 8 处 spawn bug，幂等可重跑 |
| **fixtures 自动生成** | `scripts/regen-fixtures.ts` + `tests/fixtures/ground-truth/*.sample.json`，防 inline mock 偏离真实接口 |
| **pipeline-check helper** | `pnpm pack` + tarball audit + 漏文件检测，防"templates 在 git 但 npm 包漏装"事故 |

#### 📦 Skill 体系

ccgx-workflow 沿用 v3.x 引入的 **Skill Registry**（SKILL.md frontmatter 驱动自动命令生成），技能体系为：

- **质量关卡** 4 个：verify-{change, quality, security, module}（合并到 `/ccg:verify` 后仍可作 skill 单独触发）
- **工具 skill** 6 个：gen-docs / health / map-codebase / extract-learnings / forensics / override-refusal
- **域知识秘典** 10 大领域 ~21 个 SKILL.md（security / architecture / devops / ai / development / frontend-design 等，全 `user-invocable: false`，关键词路由触发自动 Read）
- **Impeccable UI/UX 工具集** 20 个（adapt / animate / arrange / audit / bolder / clarify / colorize / critique / delight / distill / extract / harden / normalize / onboard / optimize / overdrive / polish / quieter / typeset 等，可选安装）
- **scrapling**：网页抓取 skill，支持 Cloudflare / WAF 绕过
- **orchestration/multi-agent**：多 agent 协作 SKILL

合计 **47 个 SKILL.md** + 50 余个辅助 md = 100+ 技能文件。

### 总览对比表

下表是核心差异：

| 维度 | 原版 `ccg-workflow` v3.x | `ccgx-workflow` v1.0 |
|------|--------------------------|----------------------|
| 维护状态 | 2026-05 起停更，作者主页失联 | 持续维护，接受 PR |
| 主线 context 治理 | 无显式约束 | `context_budget` frontmatter 硬约束 + fresh-context subagent 协议 |
| 多模型质量门 | 单一编排 | **三档可调** `--quality=fast/triple/debate` (Plan-Critic-Verify) |
| 自治长跑 | 串行 phase | **wave 拓扑分波并行** + cascade skip + cap 调度 |
| 进程隔离 | 主进程内 sidechain | **OS 级三层** (`Bash(claude -p)` 子进程 + plugin 进程组) |
| broker 防漂移 | — | **broker tx_id** 加密签 + 8 字段强 schema |
| Gemini Windows patch | 用户手动改 8 处源码 | **内置一键 repatch 脚本**，幂等可重跑 |
| Silent fallback 治理 | — | verify wave Bash 直调 + debate retry protocol schema 硬校验 |
| 测试规模 | 168 | **1309** |
| 命令面板 | 35（含已弃用） | ~30（合并 + 收敛） |
| Subagent | 7 | **19**（fresh-context 协议 4 个 + specialist 矩阵 8 个） |
| 二进制依赖 | Go binary 16.3 MB | **Node 单文件 ~200 KB** |
| 协议 | MIT | MIT（保留原作者署名 + 维护人双 copyright） |
| `/ccg:*` 命令面板 | — | **完全兼容**，老用户零迁移成本 |

### 老用户迁移

详见 [MIGRATION-FROM-CCG-WORKFLOW.md](./MIGRATION-FROM-CCG-WORKFLOW.md)。一句话版：

```bash
npm uninstall -g ccg-workflow            # 如有全局安装
npx ccgx-workflow                        # 重新初始化
```

`/ccg:*` 命令、`.context/` 状态、`.ccg/roadmap.md` 全部兼容，无需改代码或重建项目状态。

---

## 命令清单

### 开发工作流

| 命令 | 说明 | 模型 |
|------|------|------|
| `/ccg:workflow` | 完整 6 阶段工作流（智能路由前端/后端） | Codex + Gemini |
| `/ccg:plan` | 多模型协作规划（Phase 1-2） | Codex + Gemini |
| `/ccg:execute` | 多模型协作执行（Phase 3-5） | Codex + Gemini + Claude |
| `/ccg:codex-exec` | Codex 全权执行计划（plan → code → review） | Codex + 多模型审核 |
| `/ccg:autonomous` | 跨 phase 自治长跑（`--quality=fast/triple/debate`） | phase-runner + Plan-Critic-Verify |
| `/ccg:context` | 项目上下文管理（.context/ 初始化、日志、压缩、历史） | Claude |
| `/ccg:enhance` | 内置 Prompt 增强 | Claude |

### 分析与质量

| 命令 | 说明 | 模型 |
|------|------|------|
| `/ccg:analyze` | 技术分析 | Codex + Gemini |
| `/ccg:debug` | 问题诊断 + 修复（manager + debugger 双层 fresh-context） | debug-session-manager |
| `/ccg:optimize` | 性能优化 | Codex + Gemini |
| `/ccg:test` | 测试生成 | 智能路由 |
| `/ccg:review` | 代码审查（自动 git diff + `--fix --auto` worktree 闭环修复） | Codex + Gemini + code-fixer |
| `/ccg:verify --gate=<change\|quality\|security\|module\|all>` | 统一 verify 入口 | Claude |
| `/ccg:verify-work` | 编排器 + 会话式 UAT + cold-start smoke | Claude |
| `/ccg:debate` | 多轮 propose/challenge/respond 原语（cap N 轮） | Codex + Gemini |

### 异步任务三件套

| 命令 | 说明 |
|------|------|
| `/ccg:status [job-id]` | 列表 / 单查 job（`--wait --timeout-ms` 阻塞；dashboard 模式聚合多 phase 进度） |
| `/ccg:status --tail <job-id>` | stream-json 流式 + 单行覆盖 + 3 类卡点警告 |
| `/ccg:status --cancel <phase-id>` | 单 phase cooperative cancel + grace + kill-tree |
| `/ccg:result <job-id>` | 取最终 verdict / summary / artifacts |
| `/ccg:cancel <job-id>` | 中止活跃 job |

### OPSX 规范驱动

| 命令 | 说明 |
|------|------|
| `/ccg:spec-init` | 初始化 OPSX 环境 |
| `/ccg:spec-research` | 需求 → 约束集 |
| `/ccg:spec-plan` | 约束 → 零决策可执行计划 |
| `/ccg:spec-impl` | 按规范执行 + 归档 |
| `/ccg:spec-review` | 双模型交叉审查 |

### Agent Teams 并行实施

| 命令 | 说明 |
|------|------|
| `/ccg:team` | **统一工作流（推荐）** — 8 阶段 7 角色全流程 |
| `/ccg:team research <args>` | 需求 → 约束（子命令） |
| `/ccg:team plan <args>` | 约束 → 并行实施计划 |
| `/ccg:team review [git-range]` | 双模型交叉审查 |
| `/ccg:team-exec` | spawn Builder teammates 并行写代码 |

> **前置**：`settings.json` 启用 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`。

### Git 工具

| 命令 | 说明 |
|------|------|
| `/ccg:commit` | 智能 conventional commit |
| `/ccg:rollback` | 交互式回滚 |
| `/ccg:clean-branches` | 清理已合并分支 |
| `/ccg:worktree` | Worktree 管理 |

### 项目初始化

| 命令 | 说明 |
|------|------|
| `/ccg:init` | 初始化项目 CLAUDE.md |

---

## 配置

### 目录结构

```
~/.claude/
├── commands/ccg/       # ~30 斜杠命令
├── agents/ccg/         # 19 子智能体
├── skills/ccg/         # 质量关卡 + 10 域知识 + impeccable + 编排
├── bin/codeagent-wrapper  # fallback 路径（plugin 未装时启用）
└── .ccg/
    ├── config.toml
    ├── scripts/
    │   └── repatch-gemini-plugin.mjs   # ⭐ 一键 patch
    └── prompts/
        ├── codex/      # 6 个 Codex 专家提示词
        └── gemini/     # 7 个 Gemini 专家提示词
```

### 环境变量

`~/.claude/settings.json` 的 `"env"` 段：

| 变量 | 说明 | 默认 | 何时调整 |
|------|------|------|----------|
| `CODEAGENT_POST_MESSAGE_DELAY` | Codex 完成后等待秒数 | `5` | Codex 进程挂起时设为 `1` |
| `CODEX_TIMEOUT` | wrapper 执行超时（秒） | `7200` | 长任务时增大 |
| `BASH_DEFAULT_TIMEOUT_MS` | Claude Code Bash 超时（ms） | `120000` | 命令超时时增大 |
| `BASH_MAX_TIMEOUT_MS` | Claude Code Bash 最大超时（ms） | `600000` | 长 build 时增大 |

### MCP

```bash
npx ccgx-workflow menu  # 选择「配置 MCP」
```

**代码检索**（择一）：
- **fast-context**（推荐）— Windsurf Fast Context，AI 驱动搜索，免索引
- **ace-tool** — `search_context` 代码搜索（[官方](https://augmentcode.com/) / [第三方代理](https://acemcp.heroman.wtf/)）
- **ContextWeaver** — 本地混合搜索，需要 SiliconFlow API Key（免费）

**可选**：Context7（自动安装，库文档）/ Playwright（浏览器自动化）/ DeepWiki / Exa。

---

## 升级 / 卸载

```bash
# 升级
npx ccgx-workflow@latest             # npx 用户
npm install -g ccgx-workflow@latest  # npm 全局用户

# 卸载
npx ccgx-workflow                    # 选「卸载」
npm uninstall -g ccgx-workflow       # npm 全局用户额外执行
```

---

## FAQ

### Codex CLI 0.80.0 进程不退出

`--json` 模式下 Codex 输出完成后不会自动退出。

**修复**：`CODEAGENT_POST_MESSAGE_DELAY=1`。

### 我之前用 ccg-workflow，能直接用 ccgx-workflow 吗

可以。`/ccg:*` 命令面板完全兼容，`.context/` 状态、`.ccg/roadmap.md` 全部兼容。详见 [MIGRATION-FROM-CCG-WORKFLOW.md](./MIGRATION-FROM-CCG-WORKFLOW.md)。

### 为什么 CLI 命令叫 `ccg` 不叫 `ccgx`

保留 `ccg` 是为了让老用户的 alias / 脚本 / 文档零成本迁移——`/ccg:*` 命令面板和 `ccg` CLI 都是肌肉记忆。包名 `ccgx-workflow` 用于消歧 npm 命名空间，CLI 名字仍是 `ccg`。

### Gemini plugin patch 上游修了之后我怎么办

ccgx-workflow 会持续跟踪上游 plugin 版本。修复合并到上游后，repatch 脚本会通过 probe 检测自动跳过已修复条目（[SKIP]），无副作用。届时也会发布 ccgx-workflow 版本注明"上游已修，patch 转 no-op"。

---

## 贡献

欢迎 PR / issue。本项目 MIT 协议，提交即视为同意以 MIT 发布。

- **Issues**: [GitHub Issues](https://github.com/wzyxdwll/ccgx-workflow/issues)
- **Discussions**: [GitHub Discussions](https://github.com/wzyxdwll/ccgx-workflow/discussions)

## Credits

ccgx-workflow 站在 ccg-workflow 之上，对原作者 fengshao1227 与上游贡献者致谢。

- [ccg-workflow](https://github.com/fengshao1227/ccg-workflow) v1.x – v3.x 原项目（fengshao1227）
- [gsd-build/get-shit-done](https://github.com/gsd-build/get-shit-done/) — fresh-context subagent 协议、context monitor、code-fixer worktree 闭环、debug session manager 等多处架构灵感
- [cexll/myclaude](https://github.com/cexll/myclaude) — codeagent-wrapper 灵感
- [UfoMiao/zcf](https://github.com/UfoMiao/zcf) — Git 工具灵感
- [GuDaStudio/skills](https://github.com/GuDaStudio/skills) — 路由设计

## License

MIT — 详见 [LICENSE](./LICENSE)（保留原作者 fengshao1227 与 fork 维护人 wangzy 双 copyright）

---

v1.0.0 | [Issues](https://github.com/wzyxdwll/ccgx-workflow/issues) | [Migration from ccg-workflow](./MIGRATION-FROM-CCG-WORKFLOW.md)
