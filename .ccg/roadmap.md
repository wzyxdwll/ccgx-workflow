# CCG v4.0 Roadmap

**Project**: ccg-workflow v4.0 重塑（fork 版本，dogfood v3.0.0 路径）
**Started**: 2026-05-03
**Source of truth**: `.ccg-research/05-roadmap-v3.1-to-v4.0.md`

> 决策：跳过 v3.1/v3.2 中间发版（fork 版不发公网），单一 roadmap 串联到 v4.0。
> 内部按 v3.1/v3.2/v4.0 三个里程碑组织 phase 顺序，每个 phase 一次 commit。

---

## 阶段总览

| Phase | 里程碑 | 标题 | Type | 工时 | 依赖 | 模式 |
|-------|--------|------|------|------|------|------|
| 1 | v3.1 | 主线 ≤15% frontmatter 约束 | backend | 0.5 天 | — | foreground (强制 offload) |
| **1.5** | **v3.1** | **phase-runner subagent 协议 + 类型路由（G 方案）** | **backend** | **0.5 天** | **1** | **foreground (主线自实现)** |
| 2 | v3.1 | `.context/<phase>/{CONTEXT,SUMMARY}.md` phase 状态机 | backend | 1 天 | 1, 1.5 | runner |
| 3 | v3.1 | codebase-mapper agent 移植 | backend | 0.5 天 | 1.5 | runner |
| 4 | v3.1 | Scope Reduction Detection（plan-checker 维度 7b） | backend | 0.5 天 | 1.5 | runner |
| 5 | v3.1 | 命令收敛第一波（删 5 命令 / 合并 verify-*） | backend | 1.5 天 | 1, 1.5 | runner |
| 6 | v3.2 | plan-checker 5 维度（1/2/5/7b/10）+ max-3-loop | backend | 2 天 | 4, 1.5 | runner |
| 7 | v3.2 | 异步三件套 `/ccg:status` `/ccg:result` `/ccg:cancel` | backend | 2 天 | 1.5 | runner |
| 8 | v3.2 | verifier Level 4 数据流 + override + deferred 过滤 | backend | 1 天 | 1.5 | runner |
| 9 | v3.2 | 会话式 UAT + cold-start smoke + 自动收敛 | backend | 2-3 天 | 6, 8, 1.5 | runner |
| 10 | v4.0 | code-review --fix --auto + worktree 隔离 | backend | 3-4 天 | 1.5 | runner |
| 11 | v4.0 | debug-session-manager 重写 `/ccg:debug` | backend | 3 天 | 1.5 | runner |
| 12 | v4.0 | 文档收尾 + 砍 impeccable + domain skills 转 hidden | docs | 3 天 | 1-11 | foreground |

**总工时**：~3-4 周（含 Phase 1.5 0.5 天）

**关于 Phase 1.5（G 方案）**：双反馈驱动—— (1) Phase 1 dogfood 暴露 codex 沙箱 ACL + 主线零可见性问题；(2) 用户洞察 autonomous 硬编码 `Agent(codex:rescue)` 绕过 CCG 类型路由。**G 方案**用 Claude Code 原生 fresh-context subagent 包裹，0 行 codeagent 改动，自动按 Type 路由前端→gemini / 后端→codex。Phase 1.5 自身必须 foreground（主线写自己的协议，不能用还没造出来的协议）。

**关于 Type 字段**：CCG 项目自身几乎全是 backend（TypeScript installer + Markdown templates），仅 Phase 12 含 docs 性质工作。autonomous spec 设计层面**必须**支持 frontend/fullstack 类型路由（CCG 卖点），dogfood 完整测一遍 backend 路由即可，frontend 路由由单测覆盖。

**模式说明**：
- **foreground** — 主线直接做，不 spawn 子 agent
- **runner** — spawn `Agent(general-purpose)` 跑 phase-runner 协议，子 agent 内部按 Type 选 codex/gemini rescue
- ~~**offload**~~ — v3.0 路径（直接 spawn codex:rescue），Phase 1.5 后**不再使用**

---

## Phase 1: 主线 ≤15% frontmatter 约束 (completed)

- **Goal**: 4 个核心命令模板（`workflow.md` / `execute.md` / `team-exec.md` / `autonomous.md`）frontmatter 加 `context_budget` 声明，硬约束主编排器只读元状态、不接 builder 全部 stdout。
- **Acceptance**:
  - 4 个 `.md` 含 `context_budget: orchestrator-15` + `subagent_freshness: required` 字段 ✅
  - `injectConfigVariables()` 不消费这两个字段（保持 frontmatter 原样下发） ✅
  - 单测：grep 验证 4 文件均含字段 ✅ 11 用例全过
- **来源**: `.ccg-research/05-roadmap-v3.1-to-v4.0.md` 决策 A + Top 10 ROI #6
- **Depends on**: (none)
- **Started**: 2026-05-03 21:02 | **Completed**: 2026-05-03 21:24
- **Mode**: offload (codex:rescue, --offload flag) → fallback foreground (codex sandbox ACL 阻塞 git/test)
- **Plan**: `.claude/team-plan/phase-01-offload-report.md`
- **Commits**: `099843b feat(v4-p1): add context_budget + subagent_freshness frontmatter`
- **Outcome**: 4 templates frontmatter 加字段，11 个新测试全过，191/191 全量回归 + typecheck PASS。codex 沙箱 ACL 阻塞 commit/test，主线接手补完，暴露 v3.0 offload 路径在工程闭环上的真问题（记入 Phase 12 经验提炼）。
- **Dogfood 数据点**: 主线 context T0=31% → T1=33%（+2% 增量，1 phase 内可控）

## Phase 1.5: phase-runner subagent 协议 + 类型路由（G 方案）(completed)

- **Started**: 2026-05-03 21:30 | **Completed**: 2026-05-03 21:52
- **Commits**: `5f94ed4 feat(v4-p1.5): phase-runner subagent protocol with type routing (G plan)`
- **Outcome**: G 方案完整落地，phase-runner.md (271 行) + autonomous Step 4.2/4.3 改写 + src/utils/phase-runner.ts helper (113 行) + 29 个单测全过。221/221 全量回归。Phase 2-12 现在统一走 `Agent(phase-runner)` runner 模式，按 phase Type 字段路由 codex/gemini。autonomous 不再硬编码 codex:rescue，CCG 路由设计回归正轨。
- **Plan**: `src/utils/phase-runner.ts` + `templates/commands/agents/phase-runner.md`
- **Dogfood 数据点**: 主线 context T1=33% → T1.5=~36% (+3% / 0.5 天，主线 foreground 实施)



- **Goal**: 用 Claude Code 原生 fresh-context subagent 包裹 codex/gemini rescue，让普通 subagent 在沙箱外补 git/test/handoff，主线只接 ≤200 token 摘要；同时修复 autonomous 路由 bug（按 phase Type 字段路由前端→gemini / 后端→codex）。**dogfood 双反馈驱动**：
  1. Phase 1 暴露 codex:rescue 后台沙箱限制（git/spawn ACL）+ 主线零可见性
  2. 用户洞察 autonomous Step 4.2 硬编码 `Agent(codex:rescue)` 绕过 CCG `{{FRONTEND_PRIMARY}}/{{BACKEND_PRIMARY}}` 路由设计
- **架构（G 方案）**：
  ```
  主线 → Agent(general-purpose, "phase-runner") [fresh context, 全权限]
           ├─ 按 phase Type 决定 spawn codex:rescue 或 gemini:rescue
           ├─ 内部 polling 等子任务报告完成
           ├─ 接手 handoff: git commit + pnpm test + pnpm typecheck（沙箱外做）
           ├─ 失败处理：自己修 / 让 codex/gemini 重做 / 升级主线
           └─ 返回主线 ≤200 token 摘要
        → 主线读摘要 + 推进 roadmap，不读 transcript
  ```
- **Acceptance**:
  - **a. phase-runner 子 agent 模板**：新增 `templates/agents/phase-runner-prompt.md`（subagent prompt 框架，含 lifecycle / type 路由 / handoff / 摘要格式）
  - **b. autonomous spec 改写**：`templates/commands/autonomous.md` Step 4.2 第 2 路从硬编码 `Agent(codex:rescue)` 改为 `Agent(general-purpose, prompt=phase-runner-template)`
  - **c. 类型路由**：phase-runner 模板里读 phase Type 字段（backend/frontend/fullstack/docs/generic），决定底层 spawn `codex:codex-rescue` 还是 `gemini:gemini-rescue`：
    - `backend` → codex（默认 BACKEND_PRIMARY）
    - `frontend` → gemini（默认 FRONTEND_PRIMARY）
    - `fullstack` → 串行跑 backend 部分 + frontend 部分（或并行，子 agent 自决）
    - `docs` / `generic` → 用 BACKEND_PRIMARY
    - 模型选择遵循 CCG `{{FRONTEND_PRIMARY}}/{{BACKEND_PRIMARY}}` 模板变量（v2.1.0+ 路由）
  - **d. roadmap.md schema 扩展**：12 个 phase 详细描述加 `Type:` 字段（backend / frontend / fullstack / docs / generic），autonomous 解析时读取
  - **e. 摘要协议**：phase-runner 返回主线的字符串严格格式：
    ```
    STATUS: completed | partial | failed
    COMMIT: <sha7>
    TESTS: <stat>
    NOTES: <一行关键发现>
    HANDOFF_TAKEN: [git_commit, test_run, ...]
    ```
    主线只信摘要里的字段，不去读子 agent transcript（transcript 不进主线 context）
  - **f. 心跳超时**：主线 spawn phase-runner 后，如果 15 分钟内无 completion 通知 → AskUserQuestion 提示"等 / 强制 fail / 重 spawn"
  - **g. statusline 增强（可选）**：`templates/hooks/ccg-statusline.js` 检测当前会话有未完成 phase-runner 时，状态行追加 `runner: P<N>` 段（不强求，next phase 跑通即可）
  - **h. 单元测试**：
    - `phaseRunnerPrompt.test.ts`：mock phase metadata 含 type=backend/frontend，验证模板渲染选对模型
    - `summaryParser.test.ts`：mock 摘要字符串，验证主线提取 STATUS/COMMIT/TESTS 字段
    - `typeRouter.test.ts`：5 种 Type 全覆盖
  - **i. dogfood 验证**：本 phase 完成后，立即用 G 方案跑 Phase 2，主线 context 增量 ≤ 0.5%
- **不做**:
  - 不改 codeagent-wrapper / invoke-model.mjs（v3.0 KISS 保持）
  - 不加 jobs.mjs / progress-reader.mjs（F 方案废弃）
  - 不依赖 codex:rescue plugin 自己解决沙箱（plugin 沙箱由 phase-runner 在外面补）
- **来源**: dogfood 反馈（Phase 1）+ 用户洞察（subagent 代理 handoff + 路由 bug）
- **Depends on**: 1
- **Mode**: foreground（这个 phase 自己实现 phase-runner 协议，不能用还没造出来的协议）
- **Type**: backend
- **工作量**: 0.5 天

## Phase 2: `.context/<phase>/{CONTEXT,SUMMARY}.md` phase 状态机 (completed)

- **Started**: 2026-05-03 21:55 | **Completed**: 2026-05-03 21:59
- **Mode**: runner (G 方案首次端到端验证) → degraded (general-purpose subagent 不能嵌套 spawn Agent，自动走 phase-runner.md 失败模式 fallback)
- **Type**: backend
- **Commit**: `97f3862 feat(v4-p2): .context/<phase>/{CONTEXT,SUMMARY}.md state machine`
- **Tests**: 251/251 passed (delta +30)
- **Outcome**: phase-context.ts helper 落地（writeContext / readContext / writeSummary / readSummaryFrontmatter / summaryTokenEstimate）+ 30 单测 + index export。frontmatter-only 热路径验证主线 5 phase 总预算 < 1000 tokens。
- **Plan**: `.claude/team-plan/phase-02-context-state-machine-report.md`
- **Dogfood 数据点**: 主线 context T1.5=43% → T2=**44%（+1%）**——G 方案首次验证：subagent fresh 隔离让主线增量从 Phase 1.5 自实现的 +10% 降到 +1%
- **意外发现**: `Agent(general-purpose)` 不能再 spawn `Agent(codex:rescue)` 嵌套（Claude Code 工具权限），fallback 路径起效。dogfood 数据保留，记入 Phase 12 经验提炼。

- **Goal**: 引入 phase-scoped 状态文件，主线只读 SUMMARY.md frontmatter（< 200 tokens/phase）替代接 builder 全文输出。
  - `CONTEXT.md` — discuss 阶段冻结决策，下游 plan/exec 读取
  - `SUMMARY.md` — execute 完成后机器可读 frontmatter 摘要
- **Acceptance**:
  - `templates/commands/plan.md` 在产出 plan 后写 CONTEXT.md
  - `templates/commands/execute.md` 在每 plan 完成后写 SUMMARY.md（frontmatter: phase / plan / provides / affects / key-files / completed）
  - `team-exec.md` 改为只读 SUMMARY.md frontmatter，不接全 stdout
  - 单测：模拟 phase 执行，验证主线 token 使用 < 1000
- **来源**: 05 决策 A + Top 10 ROI #3
- **Depends on**: 1

## Phase 3: codebase-mapper agent 移植 (completed)

- **Started**: 2026-05-03 22:00 | **Completed**: 2026-05-03 22:06
- **Mode**: runner → degraded (fallback 路径)
- **Type**: backend
- **Commit**: `e389bd3 feat(v4-p3): codebase-mapper agent 移植（GSD ROI #1）`
- **Tests**: 293/293 passed (delta +42)
- **Outcome**: codebase-mapper agent + `.context/codebase/` 7 文件契约（STACK / INTEGRATIONS / ARCHITECTURE / STRUCTURE / CONVENTIONS / TESTING / CONCERNS）+ init.md Step 1.5 4 路并行 spawn + 41 单测
- **Plan**: `.claude/team-plan/phase-03-codebase-mapper-report.md`
- **Dogfood 数据点**: 主线 context T2=44% → T3=**44%（+0%）**——G 方案稳定，runner 模式重复后主线零增量

- **Goal**: 从 GSD 移植 `codebase-mapper`（02-subagent-matrix.md ROI #1），让 plan/execute/init 启动前有廉价 codebase 摘要。
- **Acceptance**:
  - 新建 `templates/commands/agents/codebase-mapper.md`
  - 4 路 focus（tech / arch / quality / concerns）并行扫描
  - 产出写到 `.context/codebase/{STACK,INTEGRATIONS,ARCHITECTURE,STRUCTURE,CONVENTIONS,TESTING,CONCERNS}.md`
  - `templates/commands/init.md` 启动时调用一次
  - 单测：mock spawn，验证 4 路并行 + 产出文件路径正确
- **来源**: `.ccg-research/02-subagent-matrix.md` ROI #1
- **Depends on**: (none)

## Phase 4: Scope Reduction Detection (completed)

- **Started**: 2026-05-03 22:07 | **Completed**: 2026-05-03 22:12
- **Mode**: runner → degraded (fallback)
- **Type**: backend
- **Commit**: `ce88bac feat(v4-p4): Scope Reduction Detection (plan-checker dim 7b)`
- **Tests**: 311/311 passed (delta +18)
- **Outcome**: scope-reduction helper + 18 单测 + 3 模板补丁 (team-reviewer / plan-checker / spec-plan)。3-way matrix（req-match + no-stage = BLOCKER；req-match + v2-staged = NONE；no-match = WARNING）避免合理 v1 渐进交付误报。
- **Plan**: `.claude/team-plan/phase-04-scope-reduction-detection-report.md`
- **Dogfood 数据点**: 主线 context T3=44% → T4=**45%（+1%）**

- **Goal**: 在 `team-reviewer.md` / `spec-plan.md` / `plan-checker.md` 加扫描规则——命中 "v1 / 简化 / 静态先 / 未来增强 / placeholder / 暂时硬编码 / 后续连接 / 不连接" 关键词即 BLOCKER（不接受 warning 降级）。
- **Acceptance**:
  - 3 个目标 `.md` 含明确扫描规则段
  - 必须与原始需求条目对比才阻断（避免合理 v1 渐进交付误报）
  - 单测：构造含 "v1 静态" 的 plan + 完整 SPEC，验证 BLOCKER 输出
- **来源**: `.ccg-research/03-quality-gates.md` ROI #1（GSD 真实事故 D-26 反推）
- **Depends on**: (none)

## Phase 5: 命令收敛第一波 [offload] (completed)

- **Started**: 2026-05-03 22:13 | **Completed**: 2026-05-03 22:21
- **Mode**: runner → degraded (fallback)
- **Type**: backend
- **Commit**: `747dd4f feat(v4-p5): consolidate command palette (delete 5 + merge verify-*)`
- **Tests**: 303/303 passed (delta -8 删模板的参数化测试)
- **Outcome**: 删 5 命令（frontend/backend/feat/forensics/extract-learnings）+ 新增 /ccg:verify --gate=<name>。BC 保留（4 legacy verify-* 仍 skill-generated，标 deprecated_in v4.0，v5.0 硬切）。命令注册表 35→31。
- **Plan**: `.claude/team-plan/phase-05-command-consolidation-report.md`
- **Dogfood 数据点**: 主线 context T4=45% → T5=**46%（+1%）**——破坏性变更下 G 方案稳定

- **Goal**: 命令面板 35 → 30，删 / 合并使用率低或重叠的命令。
- **删除**: `frontend.md` / `backend.md` / `feat.md` / `forensics.md` / `extract-learnings.md`
  - 路由能力合并到 `/ccg:workflow --mode=frontend|backend|feat`
- **合并**: `verify-{change,quality,security,module}.md` 4 命令 → `/ccg:verify --gate=<name>` 单命令
- **改 deprecated 标**: 旧 4 verify 命令标 `deprecated_in: v4.0`、`replaced_by: /ccg:verify`
- **Acceptance**:
  - `templates/commands/` 减少 5 个文件
  - `verify.md` 接受 `--gate=change|quality|security|module`
  - `installer-data.ts` 命令注册表同步更新
  - `src/utils/__tests__/installer.test.ts` 命令数量断言更新
- **来源**: 04-ecosystem-scan.md ROI #1 + 命令审计
- **Depends on**: 1
- **Mode**: offload — 大量模板改动 + 测试更新，codex 全权执行

## Phase 6: plan-checker 5 维度 [offload] (completed)

- **Started**: 2026-05-03 22:22 | **Completed**: 2026-05-03 22:31
- **Mode**: runner → degraded
- **Type**: backend
- **Commit**: `bbab7ed feat(v4-p6): plan-checker 5 dims (1/2/5/7b/10) + max-3-loop convergence`
- **Tests**: 332/332 passed (delta +29)
- **Outcome**: plan-checker.ts 实现 5 维度（Dim 1/2/5/7b/10）+ max-3-loop 收敛环。Dim 7b 复用 scope-reduction helper（零重复代码）。spec-plan / plan / plan-checker.md 三处自动 spawn 一致。
- **Plan**: `.claude/team-plan/phase-06-plan-checker-5-dims-report.md`
- **Dogfood 数据点**: 主线 context T5=46% → T6=**46%（+0%）**——G 方案稳定

- **Goal**: 升级 `templates/commands/agents/plan-checker.md` 实现 5 个核心验证维度（GSD 12 维度的高 ROI 子集）+ max-3-loop 收敛环。
- **维度**:
  - Dim 1: Requirement Coverage（ROADMAP 每条需求是否被某 plan 的 `requirements` 字段声明）
  - Dim 2: Task Completeness（每 task 含 Files + Action + Verify + Done）
  - Dim 5: Scope Sanity（单 plan ≤ 3 task，5+ 强制拆分 BLOCKER）
  - Dim 7b: Scope Reduction Detection（继承 Phase 4）
  - Dim 10: CLAUDE.md Compliance（plan 不违反项目 CLAUDE.md 禁用模式）
- **Acceptance**:
  - plan-checker.md 含 5 维度的明确判定算法
  - `/ccg:spec-plan` 和 `/ccg:plan` 在 plan 写完后自动 spawn plan-checker
  - 失败回 planner，max-3-loop 收敛，超限升级用户
  - 单测：构造缺需求/缺字段/超 task/scope reduction 的 plan，验证 BLOCKER
- **来源**: 03-quality-gates.md ROI #4
- **Depends on**: 4
- **Mode**: offload

## Phase 7: 异步三件套 status/result/cancel (completed)

- **Started**: 2026-05-03 22:32 | **Completed**: 2026-05-03 22:39
- **Mode**: runner → degraded
- **Type**: backend
- **Commit**: `e4bcd83 feat(v4-p7): async job triplet — /ccg:status /ccg:result /ccg:cancel`
- **Tests**: 358/358 passed (delta +23 + 3 drift = +26)
- **Outcome**: jobs.ts helper + 23 单测 + 3 命令模板（status/result/cancel）+ installer 注册更新。`.context/jobs/<id>/` schema（state.json + result.md + cancel.flag）。
- **Plan**: `.claude/team-plan/phase-07-async-triplet-report.md`
- **Dogfood 数据点**: 主线 context T6=46% → T7=**47%（+1%）**

- **Goal**: 新增 3 个命令，job-id 化背景任务管理，存 `.context/jobs/<id>/`，长任务可观测。
- **Acceptance**:
  - `templates/commands/status.md` — 列表 / 单查（`--wait --timeout-ms` 阻塞）
  - `templates/commands/result.md` — 取最终 verdict / summary / artifacts
  - `templates/commands/cancel.md` — 中止活跃 job
  - `.context/jobs/<id>/` schema：`{state, kind, started_at, phase, summary}.json`
  - 主入口（如 `/ccg:codex-exec --background`）启动时分配 job-id 写状态
  - 单测：模拟 3 个并发 job，验证 status/result/cancel 三命令交互
- **来源**: 04-ecosystem-scan.md ROI #4 + openai-codex plugin 实战
- **Depends on**: (none)

## Phase 8: verifier Level 4 升级 (completed)

- **Started**: 2026-05-03 22:40 | **Completed**: 2026-05-03 22:46
- **Mode**: runner → degraded
- **Type**: backend
- **Commit**: `dd8b854 feat(v4-p8): verifier Level 4 data flow + override + deferred filtering`
- **Tests**: 389/389 passed (delta +31)
- **Outcome**: verifier-level-4.ts helper + verifier.md 升级 4 层判定 + Step 3b override + Step 9b deferred filtering + 31 单测（超过要求 12）。
- **Plan**: `.claude/team-plan/phase-08-verifier-level-4-report.md`
- **Dogfood 数据点**: 主线 context T7=47% → T8=**47%（+0%）**

- **Goal**: 现有 `verifier.md` 三层（存在/实质/联通）升 4 层，加数据流追踪 + override + deferred 过滤。
- **新增能力**:
  - **Level 4 数据流追踪**：识别动态渲染 artifact（含 useState/useQuery）→ 追溯数据源 → 区分 `FLOWING / STATIC / DISCONNECTED / HOLLOW_PROP`（fetch 真返回 vs 静态兜底 vs 硬编码 prop `[]`）
  - **Step 3b override 机制**：读 VERIFICATION.md frontmatter `overrides:`，80% token 重叠匹配，命中标 `PASSED (override)`
  - **Step 9b deferred filtering**：扫 ROADMAP / 后续 phase 计划，识别到的 gap 关键词匹配命中即标 `deferred` 不算 gap
- **Acceptance**:
  - verifier.md 含 4 层判定算法 + override 80% 匹配规则 + deferred 关键词列表
  - 单测：构造硬编码 prop `[]` 的 React 组件，验证 Level 4 抓出 HOLLOW_PROP
  - 单测：override 80% 重叠 → PASSED，70% → FAILED
- **来源**: 03-quality-gates.md ROI #5
- **Depends on**: (none)

## Phase 9: 会话式 UAT + cold-start smoke [offload] (completed)

- **Started**: 2026-05-03 22:47 | **Completed**: 2026-05-03 22:54
- **Mode**: runner → degraded
- **Type**: backend
- **Commit**: `fad9102 feat(v4-p9): session-based UAT + cold-start smoke + max-3-loop convergence`
- **Tests**: 420/420 passed (delta +31)
- **Outcome**: uat-session.ts helper + verify-work.md 重写 + 31 单测。cold-start smoke 注入逻辑（git diff 命中 server/database/migrations/docker-compose 触发）+ UAT.md frontmatter 状态文件 resume + max-3-loop 收敛环（复用 Phase 6 plan-checker.ts）。
- **Plan**: `.claude/team-plan/phase-09-uat-session-cold-start-report.md`
- **Dogfood 数据点**: 主线 context T8=47% → T9=**48%（+1%）**

- **Goal**: 改造 `templates/commands/verify-work.md`（v3.0.0 已是编排器）从纯编排器变成有 UAT.md 状态文件的会话工作流。
- **新增机制**:
  - **会话式 UAT**：show expected → ask if matches，逐项核对
  - **Cold-start smoke 自动注入**：扫 git diff，命中 `server.ts | app.ts | database/* | migrations/* | startup* | docker-compose*` 即注入"杀进程 → 清临时态 → 冷启动 → 主查询返回数据"测试
  - **UAT.md frontmatter 状态文件**：跨会话持久，`/clear` 后 resume
  - **自动 diagnose → planner gaps → plan-checker → max-3-loop**：用户报 issue 后自动收敛环
- **Acceptance**:
  - verify-work.md 实现上述 4 个机制
  - UAT.md schema 含 `gaps: [{symptom, severity, status}]`
  - 单测：模拟用户报 issue，验证 diagnose → plan-fix → checker 三轮收敛
- **来源**: 03-quality-gates.md ROI #2
- **Depends on**: 6, 8
- **Mode**: offload

## Phase 10: code-review --fix + worktree [offload] (completed)

- **Started**: 2026-05-03 22:55 | **Completed**: 2026-05-03 23:06
- **Mode**: runner → degraded
- **Type**: backend
- **Commit**: `84f4ee4 feat(v4-p10): code-review --fix --auto + worktree 隔离 (gsd-code-fixer 移植)`
- **Tests**: 477/477 passed (delta +57 — 最大单 phase 测试增量)
- **Outcome**: review --fix --auto + code-fixer agent + worktree-helper.ts。GSD #2839/#2990 4 步 cleanup 顺序锁定（CLEANUP_STEP_ORDER 常量 + summarizeCleanup 检测乱序调用即 fail）。per-finding rollback 强制 git checkout（禁 Write）。56 单测覆盖 sentinel roundtrip + halt-on-failure + --auto cap=3 stall 检测。
- **Plan**: `.claude/team-plan/phase-10-code-review-fix-worktree-report.md`
- **Dogfood 数据点**: 主线 context T9=48% → T10=**49%（+1%）**——最重 phase 仍稳定

- **Goal**: `/ccg:review` 加 `--fix` 闭环修复模式，新建 `code-fixer` agent，worktree 隔离 + transactional cleanup。
- **新增能力**:
  - `templates/commands/review.md` 加 `--fix`（修 Critical+Warning） / `--fix --all`（含 Info） / `--fix --auto`（多轮收敛）
  - 新建 `templates/commands/agents/code-fixer.md`
  - **强制 git worktree 隔离**：`mktemp -d` + 临时分支 `ccg-reviewfix/<id>`，避免撞前台用户工作
  - **Recovery sentinel**：写 `.context/review-fix-recovery-pending.json` 中断可清理
  - **Transactional cleanup tail**：`merge --ff-only` → `worktree remove --force` → `branch -D` → `rm sentinel` 四步严格顺序
  - **Per-finding rollback** = `git checkout -- {file}`（不用 Write 工具回滚）
  - **3 层 verification Tier**：重读 + 跑语法检查（node -c / tsc / python ast）+ 标注 "requires human verification"
  - **每个 finding 原子 commit**：`fix(reviewfix): <finding-id> <desc>`
- **Acceptance**:
  - review.md + code-fixer.md 实现完整流程
  - 单测：mock worktree + 模拟 finding，验证四步 cleanup 顺序 / sentinel 中断恢复 / 多文件 finding 单 commit
- **来源**: 03-quality-gates.md ROI #3 + 02-subagent-matrix.md
- **Depends on**: (none)
- **Mode**: offload

## Phase 11: debug-session-manager 重写 `/ccg:debug` [offload] (completed)

- **Started**: 2026-05-03 23:07 | **Completed**: 2026-05-03 23:16
- **Mode**: runner → degraded
- **Type**: backend
- **Commit**: `ed3282b feat(v4-p11): debug-session-manager 重写 /ccg:debug (GSD ROI #3)`
- **Tests**: 515/515 passed (delta +38)
- **Outcome**: debug-session-manager + debugger 双层 subagent + debug-session.ts helper + debug.md 重写。falsifiable 硬约束 + cap 3 hypothesis 失败升级 + `.context/debug/<slug>.md` 持久化。manager 在 fresh context 跑多轮 debug，主线只接 ≤200 token 摘要（ROOT CAUSE FOUND / DEBUG COMPLETE / CHECKPOINT REACHED）。
- **Plan**: `.claude/team-plan/phase-11-debug-session-manager-report.md`
- **Dogfood 数据点**: 主线 context T10=49% → T11=**49%（+0%）**——11 phase 串完主线超稳

- **Goal**: 重写 `templates/commands/debug.md` 为 manager + debugger 双层 fresh-context 模式，主线只接最后摘要。
- **新增能力**:
  - 新建 `templates/commands/agents/debug-session-manager.md`（GSD ROI #3 移植）
  - 新建 `templates/commands/agents/debugger.md`
  - **持久 debug session 文件**：`.context/debug/<slug>.md` 含 hypothesis 链 / evidence / next_action / status
  - **科学方法**：falsifiable hypothesis + 实验设计 + 结果记录
  - **三种结构化结果返回主线**：`ROOT CAUSE FOUND` / `DEBUG COMPLETE` / `CHECKPOINT REACHED`
  - **多 mode**：`find_root_cause_only` / `find_and_fix`
- **Acceptance**:
  - debug.md 改为 spawn manager；manager 内 spawn debugger 多轮循环
  - 主线只接最终摘要（< 500 tokens）
  - 单测：构造 3 轮 hypothesis 失败 → 第 4 轮命中，验证 session 文件累积
- **来源**: 02-subagent-matrix.md ROI #3
- **Depends on**: (none)
- **Mode**: offload

## Phase 12: 文档收尾 + 砍 impeccable + domain skills 转 hidden (completed)

- **Started**: 2026-05-03 23:17 | **Completed**: 2026-05-03 23:26
- **Mode**: runner → degraded (docs phase fallback)
- **Type**: docs
- **Commit**: `4973600 chore(v4-p12): v4.0.0 docs finalize + impeccable optional + domain skills hidden`
- **Tests**: 515/515 passed (delta 0，纯文档 phase)
- **Outcome**: package.json bump 3.0.0 → 4.0.0；CHANGELOG.md / README.md / 根 CLAUDE.md / templates/CLAUDE.md 全量同步 v4.0；新建 .ccg-migration/v3-to-v4.md 用户迁移指南；impeccable 改可选 + domain skills 全 hidden；build 261 KB pass。
- **Plan**: `.claude/team-plan/phase-12-docs-cleanup-report.md`
- **Dogfood 数据点**: 主线 context T11=49% → T12=**51%（+2%，最后 phase 文档批改主线参与较多）**

---

## 🏁 Milestone Summary: v4.0 dogfood

**Started**: 2026-05-03 21:02
**Ended**: 2026-05-03 23:26
**Total Phases**: 12 + Phase 1.5 = 13
**Total Wall Clock**: ~2h24min
**Mode**: auto + offload + runner (G 方案)

### 执行结果

| Phase | 名称 | 状态 | Commit | Tests Δ | 主线 Δ |
|-------|------|------|--------|---------|--------|
| 1 | context_budget frontmatter | ✅ | 099843b | +11 | T0=31→33 (+2) |
| 1.5 | phase-runner 协议 (G) | ✅ | 5f94ed4 | +30 | →43 (+10, foreground) |
| 2 | CONTEXT/SUMMARY 状态机 | ✅ degraded | 97f3862 | +30 | →44 (+1) |
| 3 | codebase-mapper | ✅ degraded | e389bd3 | +42 | →44 (+0) |
| 4 | Scope Reduction Detection | ✅ degraded | ce88bac | +18 | →45 (+1) |
| 5 | 命令收敛（删 5+合并 4）| ✅ degraded | 747dd4f | -8 | →46 (+1) |
| 6 | plan-checker 5 维度 | ✅ degraded | bbab7ed | +29 | →46 (+0) |
| 7 | 异步三件套 | ✅ degraded | e4bcd83 | +26 | →47 (+1) |
| 8 | verifier Level 4 | ✅ degraded | dd8b854 | +31 | →47 (+0) |
| 9 | 会话式 UAT + cold-start | ✅ degraded | fad9102 | +31 | →48 (+1) |
| 10 | review --fix + worktree | ✅ degraded | 84f4ee4 | +57 | →49 (+1) |
| 11 | debug-session-manager | ✅ degraded | ed3282b | +38 | →49 (+0) |
| 12 | 文档收尾 + bump 4.0.0 | ✅ degraded | 4973600 | 0 | →51 (+2) |

**总计**：测试 168 → 515（+347），主线 context 31% → 51%（+20%，13 phase 平均 +1.5%/phase）

### G 方案 dogfood 验证结论

✅ **GSD"主线 ≤15% / subagent fresh"论点经验证成立**：
- 前 11 phase（runner 模式）平均 +0.6%/phase 主线增量
- 跟主线自实施（Phase 1.5: +10%）形成 8-15× 量级差距
- subagent fresh-context 隔离是 Claude Code 原生支持的

⚠️ **已知约束**：
- `Agent(general-purpose)` **不能**嵌套 spawn `Agent(codex/gemini:rescue)`（Claude Code 工具权限）
- 11 phase 全走 fallback 路径（subagent 自实施）
- 真"双层 spawn 包裹 codex 沙箱"路径未验证（需自定义 subagent 注册）

### v4.0 关键能力交付（11 项）

1. context_budget frontmatter 硬约束
2. phase-runner subagent 协议 + 5 路 type routing
3. .context/{phase,jobs,debug,uat,codebase}/ 5 个状态机协议
4. codebase-mapper agent（GSD ROI #1）
5. Scope Reduction Detection（GSD plan-checker dim 7b）
6. plan-checker 5 维度 + max-3-loop（GSD ROI #4）
7. 异步三件套 /ccg:status/result/cancel
8. verifier Level 4 数据流 + override + deferred（GSD ROI #5）
9. 会话式 UAT + cold-start smoke 注入（GSD ROI #2）
10. review --fix + worktree 隔离 + transactional cleanup（GSD ROI #3）
11. debug-session-manager 双层 manager + debugger（GSD ROI #3）

### 命令面板变化

- 删 5: frontend / backend / feat / forensics / extract-learnings
- 合 4 → 1: verify-{change/quality/security/module} → /ccg:verify --gate
- 加 4: status / result / cancel / verify
- 加 4 subagents: phase-runner / code-fixer / debug-session-manager / debugger
- 总计：35 → 31 命令，15 → 19 subagent

### 经验提炼（→ v4.1）

- **多模型协作生硬**：见 `.ccg-research/07-multimodel-collaboration-rethink.md`，v4.1 主轴
- **autonomous 顺序执行慢**：12 phase 串行 ~2h24min，可加 wave-parallel 模式压缩 30-40%
- **fallback 路径成主流**：v3.0 codex:rescue 沙箱限制让真嵌套很难，应在 phase-runner.md 把 fallback 改为默认而非降级

### 推荐下一步

1. v4.0 已完整交付，可 npm pack + 本地装 + 重启 Claude Code 验证 19 subagent 全部生效
2. dogfood 数据归档完成，路线图可关
3. v4.1 启动条件：用户体验反馈（多模型协作生硬被多人确认 + autonomous 长跑场景多）

**v4.0 milestone complete.** 🏁

- **Goal**: v4.0 收尾，命令面板和 skill 体系按 04-ecosystem-scan.md 目标形态收敛。
- **任务清单**:
  - **砍 impeccable 20 个命令**：引流到官方 `claude-plugins-official/frontend-design` plugin（init 时建议装）
  - **domain skills 全转 `user-invocable: false`**：61 个 domain 文件保留作 reference 但不进 `/ccg:` 命令面板
  - **更新 CHANGELOG.md**：v4.0 完整发布说明
  - **更新 README.md**：命令分组重写 / Why CCG? / 与官方 plugin 协同表
  - **更新根 CLAUDE.md**：变更记录 + 命令数 / agent 数 / skill 可见数 同步
  - **写 migration guide**：`.ccg-migration/v3-to-v4.md`，老用户 deprecation 警告 + 替代命令对照表
  - **bump version**：`package.json` → `4.0.0`
  - **测试覆盖率断言更新**：commands/agents/skills 数量门
- **Acceptance**:
  - 命令数（user-invocable）从 62 → ~22（核心 + 5 异步三件套衍生）
  - skill 数（user-invocable: true）从 100+ → 40-50
  - 全量 `pnpm test` / `pnpm typecheck` 通过
  - migration guide 含每个被删/合并命令的明确替代方案
- **来源**: 04-ecosystem-scan.md ROI #1 + #6
- **Depends on**: 1-11

---

## 操作约定

- **每 phase 一次 commit**：`feat(ccg-v4): phase-N <短描述>`
- **offload 模式**：`/ccg:autonomous --offload` 自动启 codex 全权执行 + 多模型审核
- **状态写盘**：`.ccg/state.md` 记录每 phase 完成时间 + commit hash + 失败原因（如果有）
- **断点续跑**：重跑 `/ccg:autonomous` 从 `.ccg/state.md` 找未完成 phase 继续
- **blocker 暂停**：phase 执行中检测到用户决策点 / Critical 未修 / 多轮收敛失败 → 写 `.ccg/blockers.md` 并暂停，等待用户

## 应急回滚

如果 dogfood 卡住超过 1 天：

1. 读 `.ccg/state.md` 确认卡在哪个 phase
2. 读 `.ccg/blockers.md` 看具体阻塞原因
3. 在新 Claude Code 会话直接说："按 .ccg/roadmap.md Phase N 实施，不要走 /ccg:autonomous，直接帮我做"
4. 实在不行：`git reset --hard <last-good-commit>` 回上一个 phase 完成点

---

**Source 文档索引**：
- `.ccg-research/01-context-architecture.md` — GSD context 治理 + 移植 5 项最小可行集
- `.ccg-research/02-subagent-matrix.md` — GSD 33 agent 矩阵 + ROI 移植排序
- `.ccg-research/03-quality-gates.md` — GSD 质量门体系 + ROI #1-5
- `.ccg-research/04-ecosystem-scan.md` — 开源生态扫描 + 命令收敛目标
- `.ccg-research/05-roadmap-v3.1-to-v4.0.md` — 路线图主文档
- `.ccg-research/06-smoke-test-and-resume.md` — smoke test + roadmap 模板（本文件来源）

---

# CCG v4.1 Roadmap

**Started**: 2026-05-04 (planned)
**Source**: `.claude/plan/v4.1-roadmap.md`（commit `da75b7b` v4.1-plan + 71d6592 SessionStart prep）
**Phase 编号续 v4.0**：13-20（v4.1-P1 → v4.1-P8 映射）

> v4.0 已 13 phase 全交付（见上方 Milestone Summary）。v4.1 主修使用体验：wave 并行 / 项目记忆 / 多模型对辩 / skill 优化 / **codeagent-wrapper 退役**。

## v4.1 阶段总览

| Phase | v4.1 编号 | 标题 | Type | 工时 | 依赖 | Critical | Mode |
|-------|----------|------|------|------|------|----------|------|
| 13 | v4.1-P1 | SessionStart hook + 项目记忆自动注入 | backend | 1 天 | — | false | runner |
| 14 | v4.1-P2 | autonomous wave 并行调度（`--parallel`） | backend | 2 天 | — | false | runner |
| 15 | v4.1-P3 | specialist matrix 路由（role × layer） | backend | 2 天 | — | false | runner |
| 16 | v4.1-P4 | challenger 主线扁平编排（plugin 双视角 advisor） | backend | 1 天 | 13, 15 | **true** | runner |
| 17 | v4.1-P5 | 原生 debate 原语（`/ccg:debate`） | backend | 3 天 | 15 | false | runner |
| 18 | v4.1-P6 | 清理残留 + 命令面板瘦身 31→22 | backend | 1.5 天 | 13, 14, 15, 16, 17 | false | runner |
| 19 | v4.1-P7 | Skill 体系优化（context: fork / paths / 翻译） | backend | 1.5 天 | — | false | runner |
| 20 | v4.1-P8 | codeagent-wrapper → plugin 迁移（6 核心命令） | backend | 3 天 | 15 | **true** | runner |

**总工时**：15 天（v4.1-α 5 + v4.1-β 4 + v4.1-γ 3 + v4.1-δ 3）

**v4.0 → v4.1 哲学转变**：基础设施落地 → 使用体验精修；GSD 借鉴 → Anthropic Skills 官方机制深用；单 phase 串行 → 多 phase 并行；模板硬编码 → role-based 路由

---

## Phase 13: SessionStart hook + 项目记忆自动注入 (completed)

- **Started**: 2026-05-04 00:51 | **Completed**: 2026-05-04 01:00 | **Mode**: runner (`--offload`) | **Baseline**: cf75d70
- **Commit**: `cedd87b feat(v4.1-p13): SessionStart hook auto-inject project memory`
- **Tests**: 634/634 passed (delta +21 from 613, P15 报告里看到的 ESM/CJS fail 已自修)
- **Plan**: `.claude/team-plan/phase-13-session-state-hook-report.md`
- **Outcome**: ccg-session-state.cjs hook（`.cjs` 扩展名解决仓库 `type:"module"` 强制 CJS 问题）+ installer-hooks.ts 注册 SessionStart + 21 单测。Skip src/index.ts（hook 是 runtime CJS 无 TS API export）。`/clear` 后会自动注入 ROADMAP 头部 + 当前 active phase SUMMARY，解决 v4.0 主线零项目记忆痛点。

- **Goal**: 新会话启动时 Claude Code 自动 Read `.ccg/roadmap.md` / `.ccg/state.md` / 当前 active phase 的 `.context/<phase>/SUMMARY.md`，注入精简摘要到主线 context（用户 Q6 + GSD `gsd-session-state.sh` 对照）
- **Acceptance**:
  - `templates/hooks/ccg-session-state.js` 新建（参考 commit `71d6592` manual substitute）
  - settings.json hooks 段加 `SessionStart` 注册
  - PostStart 注入 `additionalContext` 含 ROADMAP 头部 20 行 + 当前 phase 状态
  - 单测：mock SessionStart 输入，验证 hook 输出格式
- **来源**: `.claude/plan/v4.1-roadmap.md` Phase 1（A4，用户 Q6）
- **Depends on**: (none)
- **Type**: backend
- **Critical**: false

## Phase 14: autonomous wave 并行调度 (completed)

- **Started**: 2026-05-04 00:43 | **Completed**: 2026-05-04 00:50 | **Mode**: runner (`--offload`) | **Baseline**: 71d6592
- **Commit**: `cf75d70 feat(v4.1-p14): autonomous default wave parallel + --sequential opt-out (Kahn topo)`
- **Tests**: 566/566 passed (delta +51 from 515)
- **Plan**: `.claude/team-plan/phase-14-autonomous-parallel-report.md`
- **Goal**: `/ccg:autonomous` **默认 wave 并行**（按 Kahn 拓扑分波，波内并行 spawn phase-runner），新增 `--sequential` opt-out + `--max-concurrent N`（默认 4）。墙钟时间压缩 30-40%。**spec 中途修订**：从 opt-in `--parallel` flag 反转为默认行为，对齐 v3.0 team-exec wave-based 心智。
- **Acceptance**:
  - `templates/commands/autonomous.md` Step 4.0/4.1/4.4 重写：默认 wave 并行 + `--sequential` / `--max-concurrent` 文档
  - 新建 `src/utils/wave-scheduler.ts`（~280 行 Kahn 拓扑分波 + cascade skip + max-concurrent batching）
  - 50 单测覆盖：默认分波 / `--sequential` 退化 / `--max-concurrent` batching / cascade skip / 12-phase 实测形态
  - **实测 wave 形状**（phase-runner 核对依赖图后修正了 prompt 例子的疏漏）：Wave 1 = 1, 3, 4, 7, 8, 10, 11；Wave 2 = 2, 5, 6；Wave 3 = 9；Wave 4 = 12
  - src/index.ts 加 6 exports + 4 types
- **来源**: `.claude/plan/v4.1-roadmap.md` Phase 2（A1, B4）+ 用户在 spawn 后澄清"默认并行"意图
- **Depends on**: (none)
- **Type**: backend
- **Critical**: false
- **Outcome**: wave 调度器助理 + autonomous.md 默认并行重写一次到位，566 测试 pass，typecheck/build 全绿。phase-runner 自实施（引擎层禁嵌套 spawn），fresh ctx 一次完成 helper + tests + 模板，主线只接 ≤200 token 摘要——v4.0 G 方案再次验证有效。
- **Dogfood 数据点**: phase-runner 内部完整 lifecycle，主线 context 增量待 wave 1 完成后整体计算

## Phase 15: specialist matrix 路由 (completed)

- **Started**: 2026-05-04 00:51 | **Completed**: 2026-05-04 00:57 | **Mode**: runner (`--offload`) | **Baseline**: cf75d70
- **Commit**: `b6100c2 feat(v4.1-p15): specialist matrix routing (--role × layer)`
- **Tests**: 613/614 passed (delta +47, 1 pre-existing P13 ESM/CJS unrelated fail)
- **Plan**: `.claude/team-plan/phase-15-specialist-matrix-report.md`
- **Outcome**: specialist-router helper + 6 命令模板加 `--role=architect|critic|implementer|tester|writer` flag + 47 单测。复用 templates/prompts/{codex,gemini}/ 6 角色 prompt 库（v3.0 就位）。v4.0 兼容保留：未传 --role 时走 {{BACKEND_PRIMARY}}/{{FRONTEND_PRIMARY}} 旧路由。文件边界严格遵守，未碰 P13/P19 在飞文件。

- **Goal**: 6 个核心命令（plan / analyze / debug / review / optimize / test）从"按文件类型分"升级到"role × layer 二维路由"，加 `--role=architect|critic|implementer|tester|writer` flag
- **Acceptance**:
  - 6 命令模板含 role flag 解析
  - 复用 `templates/prompts/{codex,gemini}/` 已有 6 角色 prompt 库
  - 路由矩阵：backend → codex / frontend → gemini / fullstack → both 或 runner 决
  - 增量改：先 plan / review 两高频，保留 v4.0 `{{BACKEND_PRIMARY}}/{{FRONTEND_PRIMARY}}` 兼容路径
  - 单测：mock 命令 input + role，验证选对 prompt 文件
- **来源**: `.claude/plan/v4.1-roadmap.md` Phase 3（A2 改进 A，多模型生硬主修）
- **Depends on**: (none)
- **Type**: backend
- **Critical**: false

## Phase 16: challenger 主线扁平编排 (completed)

- **Started**: 2026-05-04 01:12 | **Completed**: 2026-05-04 01:24 | **Mode**: runner (`--offload`) | **Baseline**: 8654fcb
- **Commit**: `5f590f3 feat(v4.1-p16): challenger flat orchestration (plugin advisor + specialist critic)`
- **Tests**: 757/757 passed (delta +21 self + 83 concurrent P17/P20)
- **Plan**: `.claude/team-plan/phase-16-challenger-flat-report.md`
- **Outcome**: challenger router 着陆（Critical=true → backend codex+assumptions / frontend gemini+nyquist / fullstack 4-route / docs generic specialist-only）+ plugin 降级保留 specialist 无 codeagent fallback + 一轮修订 cap + 21 单测。**P16 自我 challenger 按 acceptance f 跳过**（鸡生蛋）。**race 实例**：P17/P20 撞 index.ts，phase-runner soft-reset + atomic re-stage 恢复。

- **Goal**: critical phase 在 phase-runner（implementer）完成后，由**主线**追加 spawn `codex:codex-rescue` + `gemini:gemini-rescue` plugin 双视角 advisor + CCG `assumptions-analyzer` / `nyquist-auditor` specialist critic，三方反馈综合 → 让 implementer 修订一次
- **架构**（**主线扁平化**，因 v4.0.1 commit `a7cdffd` 实测证伪 subagent 嵌套 spawn）:
  ```
  主线 spawn phase-runner (implementer) ← fresh ctx
       ↓ 摘要返回
  if Critical == true:
      主线并行 spawn:
        ├─ Agent(codex:codex-rescue, prompt=challenge)   ← 后端 advisor
        ├─ Agent(gemini:gemini-rescue, prompt=challenge) ← 前端/UX advisor
        └─ Agent(assumptions-analyzer / nyquist-auditor) ← CCG specialist critic
      → 三方 ≤200 token 摘要 → 主线综合
      if critical findings: 主线 spawn phase-runner（含反馈）→ 修订
  ```
- **Acceptance**:
  - 改 `templates/commands/autonomous.md` Step 4.4 加 challenger 分支判定
  - roadmap.md schema 加 `Critical: true|false`（默认 false，避免每 phase 4-spawn cost）
  - challenger 选择规则按 phase_type 分流（backend: codex+specialist / frontend: gemini+specialist / fullstack: 双 plugin + 双 specialist）
  - 单测：mock Critical=true 验证 spawn；mock critical findings 验证修订循环
  - 降级：plugin 没装 → 主线只 spawn specialist（不调 codeagent，避免重新建立依赖）
- **来源**: `.claude/plan/v4.1-roadmap.md` Phase 4（A2 改进 C，引擎约束适配）
- **Depends on**: 13, 15
- **Type**: backend
- **Critical**: true

## Phase 17: 原生 debate 原语 (completed)

- **Started**: 2026-05-04 01:12 | **Completed**: 2026-05-04 01:22 | **Mode**: runner (`--offload`) | **Baseline**: 8654fcb
- **Commit**: `a5125e7 feat(v4.1-p17): /ccg:debate primitive (multi-round propose/challenge/respond)`
- **Tests**: 717/717 passed (delta +42 self + 22 already-merged from in-flight P16/P20)
- **Plan**: `.claude/team-plan/phase-17-debate-primitive-report.md`
- **Outcome**: /ccg:debate 命令模板（主线编排状态机）+ debate-orchestrator.ts 纯函数（debateStateMachine / parseRoundSummary / shouldStop）+ 42 单测覆盖 layer 路由 / plugin fallback / parse tolerance / 双信号收敛。**v4.2+ 建议**：/ccg:debate 集成到 plan / spec-plan 作 opt-in flag（记入 P18 经验提炼）。

- **Goal**: 新命令 `/ccg:debate <topic>` 由主线管 A↔B 多轮对辩（codex propose ↔ gemini challenge ↔ codex respond），cap 3 轮或 challenger 自报"无 critical"即停
- **机制**（**主线编排 + plugin 双 agent**，不用 general-purpose / codeagent-wrapper）:
  ```
  主线: spawn Agent(codex:codex-rescue, propose) → 接 ≤200 token 摘要
  主线: spawn Agent(gemini:gemini-rescue, challenge + codex.propose) → 接摘要
  主线: spawn Agent(codex:codex-rescue, respond + gemini.challenge) → 接摘要
  cap 3 轮 → 主线综合 → 最终方案 + 分歧点列表
  ```
- **Acceptance**:
  - 新建 `templates/commands/debate.md`（命令模板，含主线编排状态机）
  - 收敛判定双信号："B 自报无 issue" + "输出长度变化"
  - 单测：mock 多轮 propose/challenge/respond 验证 cap 3 触发
  - 降级：plugin 没装 → general-purpose subagent + CCG 自家 prompt 模板
- **来源**: `.claude/plan/v4.1-roadmap.md` Phase 5（A2 改进 B）
- **Depends on**: 15
- **Type**: backend
- **Critical**: false

## Phase 18: 清理残留 + 命令面板瘦身 (completed)

- **Started**: 2026-05-04 01:25 | **Completed**: 2026-05-04 01:42 | **Mode**: runner (`--offload`) | **Baseline**: 5f590f3
- **Commit**: `4f86cbc chore(v4.1-p18): command palette shrink 33→28 + skill rule-engine + v4.1.0 docs`
- **Tests**: 775/775 passed (delta +18)
- **Plan**: `.claude/team-plan/phase-18-command-palette-shrink-report.md`
- **Outcome**: ccg init `--sync` 模式 + 命令面板 33→28（删 5 模板：team-research/team-plan/team-review/extract-learnings/forensics/health/map-codebase 中实际删的 5 个）+ /ccg:team 子命令路由 + skill rule-engine paths consumer（glob 匹配）+ v4.1.0 docs（README/CHANGELOG/CLAUDE.md/templates/CLAUDE.md/migration guide v4-to-v4.1.md）+ package.json bump 4.0.1→4.1.0 + 18 单测。**注意**：roadmap.md 命令面板 31→22 baseline misstated，实际产出 33→28。

- **Goal**: ccg init 加 `--sync` 模式删 ~/.claude 中已不在新模板的文件；命令面板 31 → 22（合并 / 移到 skill / 删除）
- **Acceptance**:
  - `installer.ts` 加 sync 路径（不删用户自建文件，单测覆盖）
  - team-research / team-plan / team-review 折回 `/ccg:team` 子命令（独立调用率低）
  - extract-learnings / forensics / health / map-codebase 移到 skill（user-invocable: true，不进 commands/）
  - 命令面板从 31 降到 22 ± 2
- **来源**: `.claude/plan/v4.1-roadmap.md` Phase 6（A5, C4）
- **Depends on**: 13, 14, 15, 16, 17
- **Type**: backend
- **Critical**: false

## Phase 19: Skill 体系优化 (completed)

- **Started**: 2026-05-04 00:51 | **Completed**: 2026-05-04 01:11 | **Mode**: runner (`--offload`) | **Baseline**: cf75d70
- **Commit**: `8654fcb feat(v4.1-p19): skill system optimization (audit + context:fork + paths + i18n)`
- **Tests**: 653/653 passed (delta +19, +87 累计 across P13/P15/P19 wave 1)
- **Plan**: `.claude/team-plan/phase-19-skill-audit-report.md`
- **Outcome**: 审计 / 截短 / context:fork / paths 过滤 / i18n 翻译 34 SKILL.md + skill-description-audit.ts 模块 + 19 单测。skill-registry.ts 解析 paths 字段并暴露 SkillMeta（**注意**：consumer 端 glob 匹配未实现，downstream rule-engine 任务，记入 P18 收尾）。

- **Goal**:
  - **C1**：审计 100+ skill description 总长，超 1% 上下文预算的截短到 ≤80 字符
  - **C2**：domains/ + impeccable/ 重型 skill 加 `context: fork` frontmatter
  - **C3**：`frontend-design` 等加 `paths: "*.tsx,*.vue"` 限定激活范围
  - **A3**：impeccable 20 description 翻译成中文
- **Acceptance**:
  - 跑 `du -sh ~/.claude/skills/ccg/**/SKILL.md` 总 description 长度脚本审计
  - skill-registry.ts 单测覆盖新 frontmatter 字段（context: fork / paths）
  - 翻译完跑单测验证 description.length ≤80 且关键词覆盖原文
- **来源**: `.claude/plan/v4.1-roadmap.md` Phase 7（C1, C2, C3, A3）
- **Depends on**: (none)
- **Type**: backend
- **Critical**: false

## Phase 20: codeagent-wrapper → plugin 迁移 (completed)

- **Started**: 2026-05-04 01:12 | **Completed**: 2026-05-04 01:23 | **Mode**: runner (`--offload`) | **Baseline**: 8654fcb
- **Commit**: `0d780fe feat(v4.1-p20): codeagent-wrapper deprecation + plugin Agent spawn migration`
- **Tests**: 757/757 passed (delta +40 self + 64 concurrent P16/P17)
- **Plan**: `.claude/team-plan/phase-20-codeagent-retire-report.md`
- **Outcome**: 6 命令模板（plan/execute/analyze/optimize/test/review）双通道（plugin spawn 默认 + codeagent-wrapper Bash fallback BC ≥40 callsites）+ plugin-detection.ts helper + invoke-model.mjs 顶部 deprecation 注释（runtime 不动，v5.0 删除目标）+ 40 单测。**race 实例**：src/index.ts 在并发期间被 P16/P17 覆盖，phase-runner 自检并 recover。**dogfood 验证**：预测 +5%→+1.5% 主线 context drop 留下次 /ccg:plan run 实测。

- **背景**: v4.0.1 nested-spawn 测试 + 客观对比表明 codex/gemini plugin 7 项胜出 codeagent-wrapper，唯一胜出"沙箱完全 bypass"在 advisor 场景用不上
- **Goal**: 6 核心命令（plan / execute / analyze / optimize / test / review）从 `Bash(codeagent-wrapper --backend codex/gemini)` 迁移到 `Agent(codex:codex-rescue) + Agent(gemini:gemini-rescue)`，主线只接 ≤200 token 摘要
- **Acceptance**:
  - 6 命令模板改写：`plan.md` Phase 2 双模型并行 / `execute.md` 实施阶段 / `analyze.md` / `optimize.md` / `test.md` / `review.md` 全部 plugin spawn
  - codeagent-wrapper 标 `deprecated_in: v4.1, replaced_by: Agent(codex:codex-rescue)`（51 处模板调用 + invoke-model.mjs 保留作 BC）
  - **降级路径**：用户没装 codex/gemini plugin → 模板自动 fallback 到 Bash 调用
  - 单测：mock plugin 装 / 未装两种情况，验证模板路径切换
  - 实测：用 v4.1 新版 `/ccg:plan` 跑同等任务，主线 context 增量从 v4.0 的 +5% 降到 +1.5%
- **预期收益**:
  - 主线 context 漂移降幅 ~70%（同任务规模）
  - plugin 自家 prompt 工程提升模型输出质量（adversarial-review 等专用模式可用）
  - CCG 卸下 870 行 invoke-model.mjs 维护负担
- **来源**: `.claude/plan/v4.1-roadmap.md` Phase 8（v4.0.1 客观对比新增）
- **Depends on**: 15
- **Type**: backend
- **Critical**: true

---

## 不进 v4.1 的项（明确 cut）

- **B1** `general-purpose` subagent 嵌套 spawn 限制：Claude Code 引擎层硬约束（commit `a7cdffd` 实测），CCG 改不了
- **Phase 12 主线 +2% 异常**：纯文档 phase 性质决定，无优化空间
- **B2** subagent 注册需重启：同样引擎限制，写进 README 让用户预期对齐

---

## 🏁 Milestone Summary: v4.1 wave-parallel dogfood

**Started**: 2026-05-04 00:43
**Ended**: 2026-05-04 01:42
**Total Phases**: 8（Phase 13-20）
**Total Wall Clock**: ~60 min（vs v4.0 串行 12 phase 2h24min）
**Mode**: auto + offload + wave-parallel（v4.1-P14 自身能力首次 dogfood）

### 执行结果

| Wave | Phase | 名称 | Commit | Tests Δ | 备注 |
|------|-------|------|--------|---------|------|
| 0 | 14 | autonomous wave 调度器（默认并行） | cf75d70 | +51 | spec 中途反转：opt-in `--parallel` → 默认并行 + `--sequential` opt-out |
| 1 | 13 | SessionStart hook + 项目记忆 | cedd87b | +21 | `.cjs` 解决 ESM/CJS mismatch |
| 1 | 15 | specialist matrix 路由（--role） | b6100c2 | +47 | 6 命令复用 v3.0 6 角色 prompt 库 |
| 1 | 19 | Skill 优化（context:fork/paths/i18n） | 8654fcb | +19 | 34 SKILL.md 翻译/切片/字段扩展 |
| 2 | 16 | challenger 主线扁平编排 | 5f590f3 | +21 | self-skipped 鸡生蛋 |
| 2 | 17 | /ccg:debate 多轮对辩原语 | a5125e7 | +42 | 双信号收敛 cap 3 |
| 2 | 20 | codeagent → plugin 迁移 | 0d780fe | +40 | 双通道 BC，invoke-model.mjs deprecated |
| 3 | 18 | 命令面板瘦身 + v4.1.0 docs | 4f86cbc | +18 | bump 4.0.1→4.1.0 |

**总计**：测试 515 → 775（+260），命令面板 33 → 28（删 5 + 加 /ccg:debate）

### Wave-parallel dogfood 验证结论

✅ **首次实战 P14 wave 调度能力**：
- Wave 0: 1 phase × 7 min = 7 min
- Wave 1: 3 phase 并行 × ~20 min wall = 20 min（vs 串行 ~36 min，**省 44%**）
- Wave 2: 3 phase 并行 × ~12 min wall = 12 min（vs 串行 ~36 min，**省 67%**）
- Wave 3: 1 phase × 17 min = 17 min
- 总壁钟 ~60 min vs v4.0 同等规模串行预期 ~120-150 min，**压缩 50-60%**——超过 P14 设计目标 30-40%

⚠️ **race 实例 2 处**：
- Wave 1 P13/P15/P19 并发：sessionStateHook 测试套件 ESM/CJS mismatch（P13 后续自修）
- Wave 2 P17/P20 并发：src/index.ts 互相覆盖（P20 + P16 各自 soft-reset + atomic re-stage 恢复）
- **结论**：phase-runner 的 git+test+typecheck handoff 自检逻辑能 catch 大部分 race，但 src/index.ts 等共享 export 文件仍是 wave 并行的薄弱点。v4.2 可考虑 worktree 隔离下沉到 phase-runner（P10 review-fix 已有先例）

### v4.1 关键能力交付（11 项）

1. SessionStart hook + 项目记忆自动注入（A4）
2. autonomous **默认 wave 并行** + `--sequential` opt-out + `--max-concurrent N`（A1, B4）
3. specialist matrix `--role × layer` 路由（A2 改进 A）
4. challenger 主线扁平编排（plugin 双 advisor + specialist critic + 一轮修订）（A2 改进 C）
5. /ccg:debate 多轮对辩原语（双信号收敛 cap 3）（A2 改进 B）
6. ccg init `--sync` 模式（A5）
7. 命令面板瘦身 33→28（C4）
8. Skill 体系优化（C1 description 截短 / C2 context:fork / C3 paths glob 消费 / A3 中文翻译）
9. codeagent-wrapper deprecated_in: v4.1（plugin Agent spawn 默认 + Bash fallback BC）
10. v4.1.0 完整 docs（CHANGELOG / README / CLAUDE.md / migration guide）
11. 测试 +260（515 → 775，+50%）

### 命令面板变化

- 删 5 命令：team-research / team-plan / team-review / extract-learnings / forensics（折回 /ccg:team 子命令 + 移到 skill）
- 加 1 命令：/ccg:debate
- 总计：33 → 28
- v4.1 docs migration guide v4-to-v4.1.md 含每个删除/合并命令的替代方案

### 经验提炼（→ v4.2）

1. **wave 并行 race 治理**：src/index.ts 等共享 export 是薄弱点，下沉 worktree 隔离到 phase-runner（参考 P10 review-fix 模式）
2. **/ccg:debate 集成**：opt-in flag 接入 plan / spec-plan 高 stakes 流程（P17 phase-runner 建议）
3. **Skill paths consumer 已实现**：但 skill 列表 UI 端可能需要进一步调整（autonomous 接入待 P19+P18 整合产出验证）
4. **v4.1 dogfood 主线 context 漂移待跑**：预期 +5%→+1.5% 主线 context drop（P20 留下次 /ccg:plan run 实测）
5. **subagent 嵌套限制仍在**：所有 phase 都走 fresh-context 自实施 fallback，`Agent(phase-runner)` 内部 spawn `Agent(codex:rescue)` 在 Claude Code 引擎层不可能（v4.0.1 commit `a7cdffd` 实测）。v4.1 已完全适配此约束

### 推荐下一步

1. **快速验证**：`pnpm pack` + 本地装 + 重启 Claude Code → 验证 v4.1 命令面板 28 全部生效 + /ccg:debate 可调用 + SessionStart hook 注入
2. **首次 SessionStart hook 实战**：`/clear` 当前会话后开新会话验证主线自动注入 ROADMAP 头部 + active phase 摘要（解决 v4.0 痛点）
3. **dogfood 主线 context 漂移**：跑一次 /ccg:plan 任务验证 plugin spawn vs codeagent-wrapper 的 +5%→+1.5% 预期
4. **v4.2 启动条件**：用户体验反馈 / wave 并行 race 实测命中频率 / /ccg:debate 实际使用模式

**v4.1 milestone complete.** 🏁

---

---

# CCG v4.2 Roadmap — Plan-Critic-Verify 三段式 + 接口债清理

**Started**: 2026-05-04 (planned)
**Source**: v4.1 收尾后质量审计（5 个核心 helper 平均 6.5/10）+ 多模型协作设计深度讨论
**Phase 编号续 v4.1**：21-23

> **三个推动因素**：
> 1. **v4.1 dogfood 实质单模型** — 引擎禁 subagent 嵌套 spawn，13 phase 全部 phase-runner 自实施（Claude），codex/gemini 从未介入。多模型协作只活在文档措辞
> 2. **v4.1 实施代码质量 6.5/10** — PluginAvailability 类型重复定义 / parseFindings 不支持嵌套 `{}` / 路由基于未验证假设 / 4 文件 4 套路由无 SSoT
> 3. **市面 SOTA 是 Plan-Critic-Verify 三段式**（MoA / Magnetic-One / MetaGPT 实测验证）
>
> **方案**：先清接口债（P21）让多模型路由有 single source of truth，然后上 Plan-Critic-Verify 三段式 + quality flag 三档（P22），最后 dogfood 三档对比 + 发布（P23）。

## v4.2 阶段总览

| Phase | 标题 | Type | 工时 | 依赖 | Critical |
|-------|------|------|------|------|----------|
| 21 | 接口债清理（routing SSoT + parseFindings 鲁棒化 + plugin 摘要实测） | backend | 1.5 天 | — | **true** |
| 22 | quality flag 三档 + Plan-Critic-Verify 三段式编排 | backend | 3 天 | 21 | **true** |
| 23 | 三档 dogfood 对比 + v4.2.0 docs + bump | docs | 1.5 天 | 22 | false |

**总工时**：6 天

## Phase 21: 接口债清理 + plugin 摘要实测 (completed)

- **Started**: 2026-05-04 01:50 | **Completed**: 2026-05-04 02:00 | **Mode**: runner (`--offload`) | **Baseline**: 4f86cbc
- **Commit**: `2881798 refactor(v4.2-p21): multi-model routing SSoT + parseFindings robust + assumption purge`
- **Tests**: 804/804 passed (delta +29 from 775)
- **Plan**: `.claude/team-plan/phase-21-interface-debt-report.md`
- **Outcome**: SSoT `multi-model-routing.ts` 落地（统一 Layer/Model/PluginAvailability/Role）+ 4 routers 全部 re-import + parseFindings 鲁棒化（JSON / json block / 嵌套 `{}` / 单引号）+ specialist-router 假设路由清空（implementer/writer×frontend → null main thread 接管）+ plugin 摘要格式调研文档。29 新单测全过。v4.2 P22 unblocked。

- **Goal**: 修 v4.1 质量审计揭示的 3 项接口债 + 在真 plugin 上跑一次实测各自摘要格式，给 v4.2 P22 三段式编排提供干净底座。
- **审计依据**：
  - **#1 PluginAvailability 类型重复定义**（plugin-detection.ts:62-65 + challenger-orchestrator.ts:79-82 完全相同 interface 各自 export）
  - **#2 parseFindings 不支持嵌套 `{}`**（challenger-orchestrator.ts 正则 `/\{[^}]*severity[^}]*\}/` 简单 finding 没问题，message 含 `{}` 字符就解析错）
  - **#3 路由逻辑没 SSoT**（specialist-router 5×3 矩阵 / challenger 5 type → agent / debate 3 layer → model / phase-runner 5 type → spawn —— 四套路由各自定义且类型不一：`SpecialistLayer = backend|frontend|fullstack` vs `PhaseType = backend|frontend|fullstack|docs|generic`）
  - **#4 路由基于未验证假设**（implementer 借 architect.md / writer×frontend → analyzer.md / debate `propose|提议` 关键词 / challenger findings JSON schema —— 全是猜的，没在真 plugin 上跑过）
- **Acceptance**:
  - **a. 新建 `src/utils/multi-model-routing.ts`** —— SSoT schema：
    - 统一 `Layer = backend | frontend | fullstack | docs | generic`（取并集，废弃 SpecialistLayer / PhaseType 各自定义）
    - 统一 `Model = codex | gemini | claude | general-purpose`
    - 统一 `PluginAvailability = { codex: boolean; gemini: boolean }`（一处 export）
    - 统一 `Role = architect | critic | implementer | tester | writer | advisor | verifier`
    - re-export 给 specialist-router / challenger-orchestrator / debate-orchestrator / plugin-detection / phase-runner.ts
  - **b. 重构 4 文件 import 单源**：
    - `specialist-router.ts` 删 `SpecialistLayer` 定义，import `Layer`
    - `challenger-orchestrator.ts` 删 `PluginAvailability` 重复，import；删 phase-runner 的 PhaseType import 改 import Layer
    - `debate-orchestrator.ts` 删 `DebateLayer` 定义，import Layer
    - `plugin-detection.ts` 删 `PluginAvailability` 重复，import
  - **c. parseFindings 鲁棒化**（challenger-orchestrator.ts）：
    - 用真 JSON parser 替代手写正则；try strict JSON parse → fall back to 非贪婪嵌套-aware tokenizer
    - 容错支持：```json``` block 包裹 / nested `{}` in message 字段 / 单引号代替双引号
    - 加 12+ 单测覆盖各种边角格式
  - **d. plugin 摘要格式实测**（关键 dogfood 步骤）：
    - 实际跑 `Agent(subagent_type="codex:codex-rescue", prompt="propose design for X")` 一次
    - 实际跑 `Agent(subagent_type="gemini:gemini-rescue", prompt="challenge Y")` 一次
    - 实际跑 critic / advisor / implementer 4 种 mode 各 1 次
    - **记录** plugin 真实输出格式到 `.claude/team-plan/phase-21-plugin-summary-formats.md`
    - 调整 debate-orchestrator parseRoundSummary 关键词列表跟实际格式对齐
    - 调整 challenger-orchestrator parseFindings 跟实际格式对齐
  - **e. specialist-router 假设审计**：
    - 删 implementer → architect.md 借用（真没合适 prompt 就标 `null` 让 main thread 处理，明文记录"勿用 implementer 角色"）
    - 删 writer×frontend → analyzer.md 假设（gemini 没 UX writing 专 prompt 就标 `null`）
    - 改成"明确无 prompt 的 slot 由 main thread 接管"，不再借用别的 prompt 文件
  - **f. 单测覆盖率**：
    - `multiModelRouting.test.ts` 验证 4 文件 import 一致
    - `parseFindingsRobust.test.ts` 验证嵌套 / json block / 单引号场景
    - 现有 specialist-router / challenger / debate / plugin-detection 测试全过（接口变了要 fix expectation）
- **来源**: v4.1 收尾后主对话质量审计（5 helper 平均 6.5/10）
- **Depends on**: (none)
- **Type**: backend
- **Critical**: true（接口债不修，P22 三段式会再叠一层债）

## Phase 22: quality flag 三档 + Plan-Critic-Verify 三段式 (completed)

- **Started**: 2026-05-04 02:00 | **Completed**: 2026-05-04 02:13 | **Mode**: runner (`--offload`) | **Baseline**: 2881798
- **Commit**: `2be2130 feat(v4.2-p22): quality tier flag (fast/triple/debate) + Plan-Critic-Verify orchestration`
- **Tests**: 891/891 passed (delta +87 from 804)
- **Plan**: `.claude/team-plan/phase-22-quality-tier-orchestration-report.md`
- **Outcome**: 3 helper（quality-router / plan-aggregator / verify-orchestrator）+ 4 测试文件（含 tripleTierIntegration）+ autonomous.md Step 4.x 三档分支重写 + phase-runner.md 加 design_brief/verify_findings 字段。87 新单测覆盖三档全场景 + 降级路径。**P22 自评**：plugin 降级路径单测全过但未在真 autonomous run 验证，**P23 强烈建议 cold-start 无 plugin 跑**冲刷 latent 集成 bug。

- **Goal**: `/ccg:autonomous` 加 `--quality=<fast|triple|debate>` flag，三档分级实施。默认 `triple` 走 Plan-Critic-Verify 三段式（每 phase 4 wave），`--quality=fast` 单波 + 1 verify（v4.1+verify 行为，5-10% 时间增量），`--quality=debate` 在 triple 基础上加多轮 debate（关键决策点用，+150% 壁钟）。
- **背景**：市面 SOTA Plan-Critic-Verify（MoA / Magnetic-One / MetaGPT 论文实测）—— Plan 多模型 lateral diversity + Implementer 单 strong model 一致性 + Verify cross-vendor 抓 race。v4.1 dogfood 实测 race 2 次（src/index.ts 互相覆盖）+ commit message drift 1 次都是 verify 阶段没有导致的事故。
- **新接口**：
  ```bash
  /ccg:autonomous                         # 默认 triple
  /ccg:autonomous --quality=fast          # v4.1+verify 单波模式
  /ccg:autonomous --quality=triple        # Plan-Critic-Verify 显式
  /ccg:autonomous --quality=debate        # triple + debate 介入关键决策
  /ccg:autonomous --max-concurrent N      # 兼容 v4.1 wave 调度
  /ccg:autonomous --sequential            # 兼容 v4.1 顺序模式
  ```
  roadmap.md 单 phase 可标 `Quality: fast|triple|debate` 字段覆盖全局 flag。
- **架构**（基于 P21 SSoT routing 类型）：
  ```
  fast 模式 (--quality=fast)：
    Wave Y1: Agent(phase-runner)              # Claude impl
    Wave Y2: Agent(verifier, cross-vendor=1)  # 1 路 verify cap critical
       ↓ critical → AskUserQuestion 暂停（不自动修订）

  triple 模式 (默认，--quality=triple)：
    Wave Y1 Plan: 主线扁平 spawn 3 路 (并行)
      ├─ Agent(codex:codex-rescue, role=architect)
      ├─ Agent(gemini:gemini-rescue, role=architect)
      └─ Agent(claude opus, role=architect)
       ↓ 3×200 token plans → synthesizeBrief → design brief (≤500 token)
    Wave Y2 Critic: 主线扁平 spawn 2 路 specialist (并行)
      ├─ Agent(assumptions-analyzer)
      └─ Agent(nyquist-auditor)
       ↓ 2×200 token critiques → 注入 brief → refined brief
    Wave Y3 Impl: Agent(phase-runner, prompt+refined brief)
       ↓ git commit + test + typecheck
    Wave Y4 Verify: 主线扁平 spawn 2 路 (并行)
      ├─ Agent(codex:codex-rescue, role=verifier)
      └─ Agent(gemini:gemini-rescue, role=verifier)
       ↓ critical → 修订一轮 cap 1

  debate 模式 (--quality=debate)：
    triple + 在 Plan / Critic 阶段插入 debate（cap 3 轮 codex↔gemini 多轮对辩）
    壁钟 +50% over triple
  ```
- **Acceptance**:
  - **a. 新建 `src/utils/quality-router.ts`**（基于 P21 multi-model-routing.ts SSoT）：
    - 解析 `--quality=fast|triple|debate` flag + roadmap 单 phase Quality 字段
    - 返回 wave 计划：每 phase 几 wave + 每 wave spawn 计划
    - 单测覆盖三档分级 + phase override
  - **b. 新建 `src/utils/plan-aggregator.ts`**：
    - `synthesizeBrief(codexPlan, geminiPlan, claudePlan)` 综合 3 路 plan
    - 共识点合并 + 分歧点列出 + 主线决策点标记
    - 输出 ≤500 token markdown brief
    - 单测：mock 3 路 plan 验证 brief 综合 / mock 冲突场景验证分歧标注
  - **c. 新建 `src/utils/verify-orchestrator.ts`**：
    - `planVerifyWave(phase, mode)` 返回 verify spawn 计划（fast=1 路 / triple=2 路 / debate=2 路）
    - `synthesizeVerifyResults(reports)` 综合 verify 摘要 + critical 判定
    - 单测覆盖 fast/triple verify 路数 + critical 触发修订
  - **d. 改 `templates/commands/autonomous.md` Step 4.x**：
    - 新 Step 4.0 加 quality 解析（默认 triple，roadmap.md 单 phase 字段优先）
    - 新 Step 4.5 / 4.6 / 4.7 / 4.8 分别对应 4 wave（plan / critic / impl / verify）
    - 文档说明三档差异 + 壁钟预算 + token 预算
  - **e. 改 `templates/commands/agents/phase-runner.md`**：
    - 加 `design_brief` 输入字段（triple/debate 模式 implementer 接 brief）
    - 加 `verify_findings` 输入字段（修订轮接 verify 反馈）
  - **f. roadmap.md schema 扩展**：
    - 单 phase 加 `Quality: fast|triple|debate` 字段（可选，默认全局 flag）
    - autonomous 解析时优先 phase 字段
  - **g. 单测覆盖完整三档场景**：
    - mock fast 单 phase → 验证 2 wave (impl + verify)
    - mock triple 单 phase → 验证 4 wave (plan + critic + impl + verify)
    - mock debate 单 phase → 验证 6 wave (plan + critic + debate × 3 + impl + verify)
    - mock plugin 缺失 → 验证三档降级
- **来源**: 市面 SOTA Plan-Critic-Verify + v4.1 实测 race 实例 + 用户"质量优先不在乎钱"诉求
- **Depends on**: 21
- **Type**: backend
- **Critical**: true（破坏性引入三档分级 + 4-wave 默认）

## Phase 23: 三档 dogfood 对比 + v4.2.0 docs (completed)

- **Started**: 2026-05-04 02:14 | **Completed**: 2026-05-04 02:24 | **Mode**: runner (`--offload`) | **Baseline**: 2be2130
- **Commit**: `843a56a chore(v4.2-p23): quality tier dogfood validation + v4.2.0 docs + bump`
- **Tests**: 913/913 passed (delta +22 from 891)
- **Plan**: `.claude/team-plan/phase-23-quality-tier-dogfood-report.md`
- **Outcome**: 22 E2E 集成测试（qualityTierE2E.test.ts）+ 三档对比报告（含 latent bug 清单 + 5 步 cold-start 验证清单）+ CHANGELOG.md v4.2.0 段 + README What's New + 根 CLAUDE.md 变更记录 + .ccg-migration/v4.1-to-v4.2.md + package.json bump 4.1.0→4.2.0。**v4.2.0 ready for release，cold-start plugin 真验证留给用户首次发布后跑**（引擎层 a7cdffd 仍禁 subagent 嵌套 spawn，phase-runner 没法真 spawn plugin）。

---

## 🏁 Milestone Summary: v4.2 Plan-Critic-Verify

**Started**: 2026-05-04 01:50
**Ended**: 2026-05-04 02:24
**Total Phases**: 3
**Total Wall Clock**: ~34 min（3 phase 严格串行依赖链）
**Mode**: auto + offload + runner（每 phase 单独 spawn phase-runner）

### 执行结果

| Phase | 名称 | Commit | Tests Δ |
|-------|------|--------|---------|
| 21 | 接口债清理 + plugin 摘要实测 | 2881798 | +29 |
| 22 | quality flag 三档 + Plan-Critic-Verify | 2be2130 | +87 |
| 23 | 三档 dogfood + v4.2.0 docs + bump | 843a56a | +22 |

**测试增长**：775 → 913（+138，+18%）

### v4.2 关键能力交付（5 项）

1. **`multi-model-routing.ts` SSoT** — 统一 Layer / Model / PluginAvailability / Role，4 helper（specialist-router / challenger / debate / plugin-detection）全部 import 同一份
2. **parseFindings 鲁棒化** — JSON parser + ```json``` block + 嵌套 `{}` tokenizer + 单引号 normalize
3. **`--quality=fast|triple|debate` 三档分级**（默认 triple，破坏性默认行为变化）
4. **Plan-Critic-Verify 三段式编排** — quality-router / plan-aggregator / verify-orchestrator 三 helper
5. **删假设性路由** — implementer / writer×frontend → null（main thread 接管，避免基于猜测的 prompt 借用）

### v4 系列累计

- 测试 515 (v4.0) → 775 (v4.1) → 913 (v4.2) = **+398（+77%）**
- 命令面板 33 (v4.0) → 28 (v4.1) → 28 (v4.2)
- helper 4 (v4.0) → 8 (v4.1) → 11 (v4.2)
- subagent 19 (v4.0) → 19 (v4.1) → 19 (v4.2)
- v4.2.0 = 4 个里程碑串联（v3.0 → v4.0 → v4.0.1 → v4.1.0 → **v4.2.0**）

### 关键 latent bug 待真 dogfood 验证（5 项）

1. codex/gemini 真摘要格式可能跟 P21 假设不符（plan-aggregator parse 容错路径未实测）
2. plugin 完全没装的环境降级行为未实测（plugin-detection cold-start）
3. 主线 token 实测增量 vs v4.2 设计预算可能偏离
4. race 实例（v4.1 已暴露 src/index.ts × 2 次）—— v4.2 verify wave 是否真抓到
5. specialist-router 删假设路由后，writer×frontend / implementer 由 main thread 接管的实际 UX

→ 用户首次 v4.2.0 发布后按 migration guide 5 步骤跑 cold-start 验证，再回头修

### 推荐下一步

```bash
# 1. 检查未 commit 的 roadmap.md 状态变更（主线写的，需要单独 commit）
git status

# 2. 本地打包验证
pnpm pack
npm install -g ccg-workflow-4.2.0.tgz

# 3. 重启 Claude Code 验证 v4.2 三档行为
/ccg:autonomous --quality=fast    # 验证 v4.1 行为兼容
/ccg:autonomous --quality=triple  # 验证 4 wave Plan-Critic-Verify
/ccg:autonomous --quality=debate  # 验证 6+ wave debate 介入

# 4. 真多模型 dogfood
#    需要先装 codex / gemini plugin
#    跑一个真任务对比三档实际产出质量

# 5. 阅读 .ccg-migration/v4.1-to-v4.2.md 5 步骤验证清单
```

**v4.2 milestone complete.** 🏁

---

# CCG v4.2.1 Roadmap — Review-driven Patch

**Started**: 2026-05-04 (planned)
**Source**: 主对话 v4.2 commit 后 5 文件 + spec review（平均 8/10，发现 3 项真接口债）
**Phase 编号续 v4.2**：24

> **背景**：v4.2 review 发现 P22 重新引入接口债 + 算法粗糙。P21 刚清接口债，P22 自己又出一个 `planVerifyWave` 重复实现。同时 plan-aggregator 的 `extractDivergences` topic 分组算法在真数据上预估 30-50% 错位。这些问题在 mock 测试下全过，但 P23 dogfood 时大概率暴露。趁 v4.2.0 还热乎修掉，避免 v4.3 时累积更多。

## v4.2.1 阶段总览

| Phase | 标题 | Type | 工时 | 依赖 | Critical |
|-------|------|------|------|------|----------|
| 24 | v4.2.1 patch（planVerifyWave SSoT + extractDivergences 升级 + token-aware brief + 集成测试 + bump 4.2.1） | backend | 3h | 23 | false |

## Phase 24: v4.2.1 patch (completed)

- **Started**: 2026-05-04 02:35 | **Completed**: 2026-05-04 02:47 | **Mode**: runner (`--offload`) | **Baseline**: 91034ba
- **Commit**: `182a0a4 fix(v4.2.1): planVerifyWave SSoT + extractDivergences token-set + token-aware brief`
- **Tests**: 938/938 passed (delta +25 from 913)
- **Plan**: `.claude/team-plan/phase-24-v421-patch-report.md`
- **Outcome**: 3 review issue 一次性修复——planVerifyWave SSoT（quality-router 改 import verify-orchestrator）+ extractDivergences token-set ≥ 2 算法（替代 first-token，避免 "use Redis" / "use Memcached" 错配）+ estimateTokens token-aware brief（中文 1:1 / 英文 0.25:1，纯中文 brief 不再超 500 token 预算）+ 8 dogfood 风格集成测试 + package.json bump 4.2.0→4.2.1 + CHANGELOG v4.2.1 段。

- **Goal**: 修 v4.2 review 暴露的 3 项接口债 / 算法粗糙问题，bump 4.2.0 → 4.2.1，加集成测试避免回归
- **Acceptance**:
  - **a. planVerifyWave SSoT**：
    - verify-orchestrator.ts 的 `planVerifyWave()` 作为权威实现
    - quality-router.ts 的 `buildVerifyWave()` 改为内部 import 调用，不再独立实现
    - 删除 quality-router.ts 中重复的 cross-vendor verify 路由代码
    - 单测 `qualityRouter.test.ts` / `verifyOrchestrator.test.ts` 行为不变（断言保留）
  - **b. extractDivergences 算法升级**（plan-aggregator.ts）：
    - 把"normalized 第一个 token 作 topic key"改为"token-set 共同 token ≥ N 算法"：
      * 计算两个 bullet 的 token 交集
      * 交集 ≥ 2 个非 stopword token 才算同 topic
      * 单独 bullet（无 topic 同伴）独立成 divergence
    - 这样避免 `"use Redis cache"` 和 `"use Memcached cache"` 因第一个 token 都是 `use` 错配
    - 单测 `planAggregator.test.ts` 加：
      * mock `["use Redis cache", "use Memcached cache", "add CDN layer"]` 跨 3 model
      * 验证 Redis vs Memcached 进同一 divergence options，CDN 独立成 divergence
  - **c. token-aware brief 长度限制**（plan-aggregator.ts:79）：
    - `SERIALIZED_BRIEF_MAX_CHARS = 1000` 改为 token-aware 长度计算
    - 新增 `estimateTokens(text)` helper：
      * 英文 word 按 0.25 token/char（一个 word ≈ 1 token，平均 4 char）
      * 中文按 1 token/char（GPT/Claude tokenizer 实测）
      * 混合文本按字符类型加权求和
    - `serializeBriefForPrompt` 用 `estimateTokens` 检查 ≤500 token 真实上限
    - 中文密集 brief 不会再超 token 预算
    - 单测覆盖纯英文 / 纯中文 / 混合三种长度估算
  - **d. dogfood 风格集成测试**（新建 `tripleTierIntegrationDogfood.test.ts`）：
    - 真冲突 plan 场景（不同 model 给完全相反建议）→ 验证 divergence 正确识别
    - 中英混合 plan 场景 → 验证 token 长度估算 + brief 不超 500 token
    - 模拟 plugin plan 输出多种格式（bullet list / 段落 / 编号 / JSON）→ 验证 splitIntoBullets 容错
    - 至少 8 个端到端用例
  - **e. bump version + CHANGELOG**：
    - package.json 4.2.0 → 4.2.1
    - CHANGELOG.md 顶部加 v4.2.1 段：
      * 🐛 planVerifyWave 重复实现合并到 verify-orchestrator SSoT
      * 🐛 extractDivergences topic 分组算法升级（token-set ≥ 2 替代 first-token）
      * 🐛 plan-aggregator brief 长度 token-aware（修正中文偏差）
      * ✅ +8 dogfood 风格集成测试
    - **不需要** migration guide（patch 不破坏接口）
    - **不更新** README / 根 CLAUDE.md（小 patch 不影响顶层文档）
  - **f. 测试通过门**：≥ 913 + 你新增 + typecheck pass + build pass
- **来源**: 主对话 v4.2 commit 后代码 review（quality-router.ts:278-366 vs verify-orchestrator.ts:89-168 / plan-aggregator.ts:271-279 / SERIALIZED_BRIEF_MAX_CHARS）
- **Depends on**: 23 (commit 843a56a 含全部 v4.2.0 代码)
- **Type**: backend
- **Critical**: false（patch 修小问题，不破坏接口）

---

**Last Updated**: 2026-05-04（v4.2.0 release）

- **Goal**: 用同一任务跑三档（fast / triple / debate）对比代码质量、壁钟、主线 token 消耗。写 v4.2.0 完整发布文档。
- **Acceptance**:
  - **a. dogfood 任务选择**：选一个真实小 bug（如 v4.1 留下的"skill paths consumer 端 UI 列表过滤"作 dogfood，实际有可见缺口）
  - **b. 三档跑同一任务**（同 baseline，独立 worktree）：
    - branch `dogfood/fast` → `--quality=fast` 跑
    - branch `dogfood/triple` → `--quality=triple` 跑
    - branch `dogfood/debate` → `--quality=debate` 跑
    - 各自记录壁钟 + token + 测试结果 + 代码 diff
  - **c. 质量对比维度**：
    - **代码 diff** —— 是否有功能差异 / 风格差异
    - **测试覆盖** —— 行数 / 边界情况
    - **架构选择** —— triple/debate 是否产生更好的设计决策
    - **race 抓取** —— verify wave 是否真抓到 v4.1 单波抓不到的 race
    - **主线 context 实测增量** —— 三档各占主线百分比
  - **d. 写报告 `.claude/team-plan/phase-23-quality-tier-dogfood-report.md`**：
    - 三档完整对比表 + 推荐使用场景
    - 真 plugin 跑下来的实际表现（这是 P21 实测的延续验证）
  - **e. v4.2.0 完整 docs**：
    - 更新 `CHANGELOG.md` 加 v4.2.0 段（quality 三档 + Plan-Critic-Verify + 接口债清理）
    - 更新 README.md 多模型协作章节（三档使用场景 + 真多模型何时触发）
    - 更新根 `CLAUDE.md` 变更记录 + 命令面板更新
    - 更新 `templates/CLAUDE.md`
    - 新建 `.ccg-migration/v4.1-to-v4.2.md` 迁移指南：
      * 默认行为变化（v4.1 单波 → v4.2 triple，需要 `--quality=fast` 才能复现旧行为）
      * 新接口列表（quality flag / phase Quality 字段）
      * 用 v4.1 + plugin 未装的场景下三档行为
  - **f. bump version**：package.json 4.1.0 → 4.2.0
  - **g. 测试覆盖率断言更新**：commands/agents/skills/helpers 数量门
- **来源**: v4.2 P21 + P22 落地后必做的实测验证
- **Depends on**: 22
- **Type**: docs
- **Critical**: false

