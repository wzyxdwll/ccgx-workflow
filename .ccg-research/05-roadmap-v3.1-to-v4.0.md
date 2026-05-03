# CCG v3.1 → v4.0 重塑路线图

> 基于 `.ccg-research/0{1,2,3,4}-*.md` 4 份 findings 综合产出。
> 决策：跳过 v3.1/v3.2 中间 npm publish，单一分支连续跑到 v4.0 一次性发布。
> 内部仍按 v3.1/v3.2/v4.0 分里程碑组织 phase。

---

## 总览

CCG **强在多模型协作 + 三端同步 + Hook 体系**，**弱在主线 context 治理 + 命令边界 + 与官方 plugin 协同**。

GSD 强项可移植 ~12 项，但**不要全照抄**——CCG 应保留多模型独有优势，砍掉边界模糊和与官方 plugin 重复造轮子的部分。

---

## 目标形态（数字锚点）

| 维度 | v3.0.0 当前 | v4.0 目标 | 锚点 |
|------|-------------|-----------|------|
| 斜杠命令 | 35 | **20** | SpecKit 5 / Anthropic 官方 ≤ 5 / TaskMaster 7 核心 |
| 子智能体 | 15 | **10-12** | claude-plugins-official 多数 0-3 / feature-dev 3 |
| 用户可见 skill | 100+ | **40-50** | Anthropic Skills 1% 上下文预算 8000 字符 cap |
| 隐藏 skill | 0 | 100+ 可保 | domains/ 61 文件全转 user-invocable: false |
| 主线 context skill body 预算 | 未约束 | **≤ 25000 tokens** | Anthropic auto-compaction 官方预算 |
| 与官方 plugin 重复 | 4 处 | **0** | 全砍或差异化 |
| Output style | 8 | 3 默认 + 5 可选 | abyss-* 真差异化保留 |

---

## 三大架构决策（v3.1 必做）

### A. 主线 ≤15% 硬约束 + Phase Decision Freeze

**来源**: 01-context-architecture.md ROI #1 + #2

把 GSD `execute-phase.md:30` "Context budget: ~15% orchestrator, 100% fresh per subagent" 落到 CCG 4 个核心命令模板（workflow / execute / team-exec / autonomous）的 frontmatter——**不是写在文档里，是写在执行约束里**。

引入 phase-scoped 状态文件：
- `.context/<phase>/CONTEXT.md` — discuss 阶段冻结决策（消除歧义后产出）
- `.context/<phase>/SUMMARY.md` — execute 完成后机器可读 frontmatter 摘要

**收益**：主线只读 SUMMARY.md frontmatter（< 200 tokens/phase），不接 builder 全部 stdout。10 phase milestone 主线占用从 60% 降到 ~10%。

### B. Spawn 默认 fresh，不再 resume

**来源**: 01 ROI #1（fresh subagent 约束）

GSD `execute-phase.md:984-994` 明文："Spawn continuation agent (NOT resume) — resume 在并行 tool calls 场景会坏掉"。

CCG 现在 `execute.md:46-107` 把 `resume <SESSION_ID>` 当主路径——反模式。改成默认 fresh + 显式状态注入。

### C. 异步任务三件套（status / result / cancel）

**来源**: 04-ecosystem-scan.md ROI #4 + openai-codex plugin 现成模式

每个 background 任务 job-id 化，存 `.context/jobs/<id>/`。新增 3 命令：
- `/ccg:status [job-id]` — 列表 / 单查
- `/ccg:result <job-id>` — 取产出
- `/ccg:cancel <job-id>` — 中止

v3.0.0 已加的 `--offload` 是这套机制的第一个用例。

---

## 命令收敛 35 → 20

| 操作 | 现状 | 目标 | 理由 |
|------|------|------|------|
| **删** | `frontend` / `backend` / `feat` | 合并到 `/ccg:workflow --mode=frontend/backend/feat` | 04 审计 C 级，路由重叠 |
| **降级** | `team-research` / `team-plan` / `team-review` | 折到 `/ccg:team` 内部步骤 | 独立调用率低 |
| **删** | `extract-learnings` / `forensics` | 砍 | 04 审计 D 级，使用罕见 |
| **合并** | `verify-{change/quality/security/module}` 4 skill | `/ccg:verify --gate=<name>` | v3.0.0 已标 deprecated_in: v3.1 |
| **加** | `status` / `result` / `cancel` | 异步三件套（决策 C） | 长任务可观测必备 |
| **加** | `plan-check` 独立调用 | 封装 plan-checker agent 多维度 | 03 ROI #4 |
| **改造** | `map-codebase` | 升级为 `/ccg:map`，整合 codebase-mapper agent | 02 ROI #1 |

---

## Agent 矩阵 15 → 12

**保留 7**: planner / init-architect / get-current-datetime / team-architect / team-qa / team-reviewer / verifier

**待验证 4**: pattern-mapper / assumptions-analyzer / plan-checker / nyquist-auditor — 30 天内 < 5 次/agent 调用直接砍

**砍 4**: integration-checker / framework-selector / eval-auditor 重定位为 plan-checker 内部维度（不独立 spawn）；ui-ux-designer 用官方 frontend-design plugin 替代

**新增 4**（02 ROI 移植）: codebase-mapper / code-fixer / debug-session-manager / phase-researcher

---

## 质量门三道防线

### 防线 1: discuss/enhance 升级（v3.1）

升级 `/ccg:enhance` 到 GSD discuss-phase 标准：
- 灰区识别（领域具体名词，禁通用类别）
- 加载 prior CONTEXT.md / DECISIONS-INDEX 避免重问
- Deferred Ideas 自动捕获 scope creep
- 4 段 CONTEXT.md 输出（Decisions / Discretion / Deferred / Refs）
- DISCUSS-CHECKPOINT.json 中断恢复

### 防线 2: plan-check 新增（v3.1）

在 `/ccg:spec-plan` + `/ccg:plan` 后自动 spawn plan-checker，先实现 5 维度：
- Dim 1: Requirement Coverage
- Dim 2: Task Completeness
- Dim 5: Scope Sanity
- Dim 7b: **Scope Reduction Detection**（03 ROI #1，0.5 天可上）
- Dim 10: CLAUDE.md Compliance

max-3-loop 收敛环。

### 防线 3: verify-work 升级（v3.2）

从纯编排器变成有 UAT.md 状态文件的会话工作流：
- 会话式 UAT（show expected → ask if matches）
- cold-start smoke 自动注入（命中 server.ts/database/migrations 即触发）
- issue → diagnose → planner gaps mode → plan-checker → max-3-loop
- verifier 升级 Level 4 数据流追踪 + override + deferred 过滤

---

## 与官方 plugin 协同

| 功能 | CCG 现状 | 官方 plugin | 决策 |
|------|---------|------------|------|
| commit | `/ccg:commit` | commit-commands | **保留**（中文 + 多模型差异化） |
| code review | `/ccg:review` | code-review | **保留**（多模型 + adversarial 差异化） |
| frontend design | impeccable 20 | frontend-design | **砍 impeccable**，init 时建议装官方 plugin |
| codex 执行 | `/ccg:codex-exec` | codex:rescue | **改为引流到 plugin**，CCG 不自己实现 |

净减约 18 skill 文件 + 1 命令。

---

## 分阶段交付

### v3.1（5-7 天）— 架构骨架 + 高 ROI 速胜
1. 决策 A 主线 ≤15% + CONTEXT.md/SUMMARY.md（2 天）
2. 决策 B fresh spawn 改造（半天）
3. 命令收敛第一波（删 frontend/backend/feat/forensics/extract-learnings，合并 verify-*）（1.5 天）
4. ROI #1 Scope Reduction Detection（0.5 天）
5. ROI codebase-mapper 移植（0.5 天）
6. ROI 主线 ≤15% frontmatter 约束（0.5 天）
7. 加 deprecated 标 v3.2 删（半天）

### v3.2（5-7 天）— 质量门 + 异步三件套
1. 决策 C status/result/cancel（2 天）
2. ROI plan-checker 5 维度（2 天）
3. ROI verifier Level 4 + override + deferred（1 天）
4. ROI 会话式 UAT + cold-start smoke（2 天）
5. 收敛第二波：team-* 折叠到 team 内部（1 天）

### v4.0（10-14 天）— 完整重塑收尾
1. ROI code-review --fix --auto + worktree（4 天）
2. ROI debug-session-manager 重写 /ccg:debug（3 天）
3. ROI init --minimal/standard/full 分级（2 天）
4. 砍 impeccable 引流到官方 frontend-design plugin（1 天）
5. domain skills 全转 user-invocable: false（1 天）
6. 文档大重写 / CHANGELOG / migration guide（3 天）

**总工作量**: ~3-4 周。**npm publish 仅 v4.0 一次**（v3.1/v3.2 是内部里程碑）。

---

## Top 10 ROI（合并 4 份 findings 最优集）

| # | 项目 | 来源 | 痛点 | 工时 |
|---|------|------|------|------|
| 1 | Scope Reduction Detection | 03 #1 | scope 偷砍 ★★★ | 0.5 天 |
| 2 | 命令面板 35→20 | 04 #1 | 命令边界模糊 ★★★ | 1 天 |
| 3 | CONTEXT.md/SUMMARY.md phase 状态机 | 01 #2 | 主线 context 爆 ★★★ | 1 天 |
| 4 | codebase-mapper 移植 | 02 #1 | 每命令重复探索 ★★ | 0.5 天 |
| 5 | plan-checker 5 维度 | 03 #4 | 实现漏边角预防 ★★★ | 2 天 |
| 6 | 主线 ≤15% frontmatter 约束 | 01 #1 | 架构基础 ★★★ | 0.5 天 |
| 7 | 会话式 UAT + cold-start smoke | 03 #2 | 漏边角 + 边界 bug ★★★ | 2-3 天 |
| 8 | 异步三件套 status/result/cancel | 04 #4 | 长任务可观测 ★★ | 2 天 |
| 9 | code-review --fix + worktree | 03 #3 | 闭环修复 ★★ | 3-4 天 |
| 10 | debug-session-manager 重写 /ccg:debug | 02 #3 | context 隔离典型 ★★ | 3 天 |

---

## 实施策略：dogfood v3.0.0

**用 CCG v3.0.0 自己跑 v4.0 实施**（吃自己的狗粮）。前置条件：v3.0.0 端到端 smoke 通过。

详见 `.ccg-research/06-smoke-test-and-resume.md`。

---

## 风险与边界

- **BC 破坏**: 删命令走 v3.1 内部里程碑标 deprecated → v4.0 真删。最终用户从 v2.x 直接到 v4.0，看到的是"deprecated 警告 + 替代命令文档" → 一次性迁移。
- **8 个 v3.0.0 specialist 待验证**: 30 天观察窗口，调用 < 5 次/agent 砍
- **官方 plugin 协同**: plugin 升级可能破坏适配，需要监控
- **CONTEXT.md/SUMMARY.md 路径**: `.context/<phase>/` 与 `.ccg/state.md` 并存，需要文档清晰分工
- **dogfood 风险**: v3.0.0 任何 bug 会卡住 v4.0 实施。先 smoke test。

---

**最后更新**: 2026-05-03
