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

## Phase 4: Scope Reduction Detection (pending)

- **Goal**: 在 `team-reviewer.md` / `spec-plan.md` / `plan-checker.md` 加扫描规则——命中 "v1 / 简化 / 静态先 / 未来增强 / placeholder / 暂时硬编码 / 后续连接 / 不连接" 关键词即 BLOCKER（不接受 warning 降级）。
- **Acceptance**:
  - 3 个目标 `.md` 含明确扫描规则段
  - 必须与原始需求条目对比才阻断（避免合理 v1 渐进交付误报）
  - 单测：构造含 "v1 静态" 的 plan + 完整 SPEC，验证 BLOCKER 输出
- **来源**: `.ccg-research/03-quality-gates.md` ROI #1（GSD 真实事故 D-26 反推）
- **Depends on**: (none)

## Phase 5: 命令收敛第一波 [offload] (pending)

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

## Phase 6: plan-checker 5 维度 [offload] (pending)

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

## Phase 7: 异步三件套 status/result/cancel (pending)

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

## Phase 8: verifier Level 4 升级 (pending)

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

## Phase 9: 会话式 UAT + cold-start smoke [offload] (pending)

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

## Phase 10: code-review --fix + worktree [offload] (pending)

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

## Phase 11: debug-session-manager 重写 `/ccg:debug` [offload] (pending)

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

## Phase 12: 文档收尾 + 砍 impeccable + domain skills 转 hidden (pending)

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

**Last Updated**: 2026-05-03
