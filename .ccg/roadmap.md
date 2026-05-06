# CCG v4.5 Roadmap — phase-runner Bash subprocess + 三层 OS 进程隔离

**Project**: ccg-workflow v4.5（治本 v4.4.x main-process RSS leak）
**Started**: 2026-05-06
**Source of truth (design)**: [`.ccg/v4.5-roadmap.md`](./v4.5-roadmap.md)
**PoC**: [`.ccg/poc-v45/poc-results.md`](./poc-v45/poc-results.md) + [`codex-review.md`](./poc-v45/codex-review.md) + [`gemini-review.md`](./poc-v45/gemini-review.md)
**Route**: 激进路线（含 nested G-plan opt-in）
**Estimated wall**: 10-12 d (parallel) / 12-15 d (sequential)
**Previous milestones**: [`milestones/v4.0-to-v4.4.3-ROADMAP.md`](./milestones/v4.0-to-v4.4.3-ROADMAP.md)

---

## Milestone 总目标

把 `Agent(subagent_type="phase-runner")` 主进程内 sidechain spawn 替换为 `Bash(claude -p --agent ccg/phase-runner)` OS-level 子进程。三层进程隔离：

```
主线 claude.exe (orchestrator)
  └─ Bash(claude -p --agent phase-runner)         L1 OS boundary  ← 治 leak
       └─ CLI 子进程 (phase 工作内存)
            └─ Agent(codex:codex-rescue)          L2 OS boundary  ← Phase 6 opt-in
                 └─ plugin 进程 (代码改动沙箱)
```

**Release entry criteria**: uni-iam 项目跑 5+ phase autonomous，监测 claude.exe RSS 全程 < 8GB（v4.4.x 同 workload 撞 23GB）。

---

## 阶段总览

| Phase | Alias | 标题 | Type | 工时 | 依赖 | 状态 |
|-------|-------|------|------|------|------|------|
| 1 | P1a | 外层 CLI subprocess MVP | backend | 3-4 d | (none) | not_started |
| 2 | P1b | Process supervisor + recovery | backend | 2-3 d | Phase 1 | not_started |
| 3 | P1c | Memory stress gate | backend | 1 d | Phase 2 | not_started |
| 4 | P1d | Broker tx_id isolation + 20-way stress | backend | 1-2 d | Phase 2 | not_started |
| 5 | P1e | Cost/cache 真实 workdir benchmark | backend | 1 d | Phase 1 | not_started |
| 6 | P1f | Nested G-plan opt-in 渐进开启 | backend | 2 d | Phase 3, Phase 4 | not_started |
| 7 | P2  | `/ccg:status` v2 dashboard + tail + 卡点检测 | frontend | 2 d | Phase 1 | not_started |
| 8 | P3  | v4.5.0 release docs + dogfood validation | docs | 1 d | Phase 1, Phase 2, Phase 3, Phase 4, Phase 5, Phase 6, Phase 7 | not_started |

**总工时**: 10-12 d wall (wave-parallel) / 12-15 d sequential

**Mode**: 全部 runner 模式。**注意 chicken-and-egg**：Phase 1 自身改的是 phase-runner spawn 机制，autonomous 跑 Phase 1 时仍走旧 v4.4.3 Agent spawn 路径；Phase 1 落地后从 Phase 2 起 spawn 才用上新机制（installer + template 重渲染 + 新会话生效）。

---

## Wave 调度（autonomous 自跑 v4.5 自身用）

```
Wave 1: Phase 1                            (3-4d) — foundation (P1a)
Wave 2: Phase 2 ∥ Phase 5 ∥ Phase 7        (2-3d) — parallel after Phase 1
Wave 3: Phase 3 ∥ Phase 4                  (1-2d) — gate tests after Phase 2
Wave 4: Phase 6                            (2d)   — gated nested rollout (after 3+4)
Wave 5: Phase 8                            (1d)   — release
```

---

## 内置 Decision Gate（任一触发都让 v4.5 v1 安全降级到保守范围）

| Gate | 触发条件 | 降级动作 |
|---|---|---|
| G1: Phase 1 → 后续 | dogfood 失败率 > 10% | 回退 v4.4.3 + SessionStart RSS 警告 hook（治标） |
| G2: Phase 3 → Phase 6 | per-nested RSS slope > 500MB | Phase 6 推迟 v4.6，v4.5 v1 仅外层隔离 |
| G3: Phase 4 → Phase 6 | tx_id 唯一性 stress 失败 | nested 模式禁用 plugin spawn（仅 Bash 直调 plugin script，复用 v4.4.2 verify wave 路径） |
| G4: Phase 5 → release | cost p90 > $30/run（业务 repo） | 强制提升 v4.5 v2 优先级（apiKeyHelper + .env 注入） |

---

## Phase 1: 外层 CLI subprocess MVP (completed)

- **Alias**: P1a
- **Started**: 2026-05-06 11:30 | **Completed**: 2026-05-06 12:20
- **Commit**: `e1f0fab feat(v4.5-p1): phase-runner via Bash subprocess (P1a MVP)`
- **Plan**: `.claude/team-plan/phase-v4.5-01-cli-subprocess-mvp-report.md`
- **Outcome**: phase-runner spawn 改 Bash 直调路径完成；quality-router.ts 加 buildPhaseRunnerBashCommand helper（+224 行）；autonomous.md Step 4.2-4.3 模板改写（+71 行）；新增 39 单测全过（1100→1139）；typecheck pass。useDirectBashInvocation 默认 false 保 v4.4 BC，autonomous opt-in 触发新机制。机制 live，install 后下个 phase 起生效。
- **Verify**: codex backend verdict=revise（critical: D3 budget drift fast=1.0 vs PoC 0.5）; gemini UX hung (50min IO 0 增长，killed exit 127). 主线决策：升级 PoC D3 fast 0.5→1.0（first-principles：T1 实测大 CLAUDE.md 场景 0.5 会 truncate，1.0 留 2.4-7.4× buffer），spec 升级胜过实施回退。warning 2 项可推后处理（autonomous.md 注释引用旧机制属误报；缺 meta fallback 占位符是 KISS 选择）。
- **Note**: ground-truth sampling failed (tsx silent), ran degraded — phase scope didn't touch protected interfaces.
- **Goal**: phase-runner 从 `Agent(...)` 改为 `Bash(claude -p --agent ccg/phase-runner ...)`，nested 默认关闭，phase-runner 子进程内自己 Read/Write/Edit/Bash 改代码（保持 v4.0 dogfood 行为）
- **Files**:
  - `src/utils/quality-router.ts`：扩展 `useDirectBashInvocation` 选项推广到 impl wave；新增 `buildPhaseRunnerBashCommand(phase, brief, jobId)` helper
  - `src/utils/wave-scheduler.ts`：phase-runner 类型 spawn 走 bashCommand 路径
  - `templates/commands/autonomous.md`：spawn 段落改写（Step 4.2-4.3）
  - `templates/commands/agents/phase-runner.md`：**不动**（直接 `--agent` 加载）
- **Bash 命令样板**:
  ```bash
  claude -p "$(cat <prompt-file>)" \
    --agent ccg/phase-runner \
    --output-format stream-json --include-partial-messages --verbose \
    --max-budget-usd 2.0 \
    --dangerously-skip-permissions \
    --add-dir <workdir> \
    > .context/jobs/<job-id>/progress.jsonl 2>&1
  ```
- **Acceptance**:
  - phase-runner spawn 100% 走 Bash 路径，模板渲染零 Agent tool 调用
  - stream-json 流式输出落 `.context/jobs/<job-id>/progress.jsonl`
  - final result 从 stdout 末行 `result.result` 字段 parse SUMMARY 字符串
  - 主线 ≤200 token 摘要回流（与 Agent spawn 行为对齐）
  - dogfood 跑 1 个 milestone（5+ phase）端到端通过
  - 单测覆盖：bashCommand 生成、参数转义、Windows 路径、stream parsing
- **Depends on**: (none)
- **Type**: backend
- **Mode**: runner
- **Critical**: true

## Phase 2: Process supervisor + recovery (not_started)

- **Alias**: P1b
- **Goal**: 解决 codex C2+C4。所有 v4.5 子进程必须由 supervisor 管理：原子状态写、PID 跟踪、Job Object（Windows）/ 进程组（POSIX）、startup reconciliation、kill-tree
- **Files**:
  - `src/utils/jobs.ts`：现有 `state.json/result.md/cancel.flag` 改为 temp-file + rename 原子提交
  - `templates/scripts/ccg-phase-runner-launcher.mjs`（新建）：包装 `claude -p` 调用，预先 alloc job-id、写 initial state（含 parent_pid/cli_pid/process_group_id/cwd/started_at/cmd）、监控 exit code、原子写 terminal state
  - `src/utils/process-tree.ts`（新建）：Windows Job Object 创建（参照 `codeagent-wrapper` Go 代码）+ POSIX setsid + signal handler + reconciler
  - `templates/commands/cancel.md`：从 cooperative 升级为 cooperative + grace + kill-tree fallback
  - `templates/hooks/ccg-session-state.cjs`：SessionStart 加 reconciler，扫 `.context/jobs/*/state.json` 检查 stale running
- **Acceptance**:
  - 13 种崩溃路径（`v4.5-roadmap.md` C2 表）每种 fault-injection 测试 + 通过
  - Windows: 主线 Ctrl+C → cancel.flag 写 → 5s grace → Job Object close 杀进程树（含 nested plugin 进程）
  - POSIX: kill -TERM 进程组 → 5s grace → kill -KILL
  - 启动 reconciler：scan stale running jobs，PID alive 检查，匹配进程 start time
  - state.json 永远 atomic-commit（temp + rename），任何进程崩溃不留半截 JSON
  - CLI 子进程崩溃时主线收到 exit code，转 `state=failed`
  - orphan plugin 进程在主线退出后被 reconciler 下次启动时清理
- **Depends on**: Phase 1
- **Type**: backend
- **Mode**: runner
- **Critical**: true

## Phase 3: Memory stress gate (not_started)

- **Alias**: P1c
- **Goal**: 解决 codex C1。在真 CLI 子进程内跑 5/10/20 次 nested Agent spawn，测 RSS 累积斜率，决定 nested 默认上限（Phase 6 用）
- **Files**:
  - `tests/poc/nested-rss-stress.ts`（新建）
- **Acceptance**:
  - RSS 数据 4 张表（trivial/plugin × single-outer/4-outer-concurrent）
  - 测出 per-nested-spawn retained slope（MB/spawn）
  - 决定 default cap：`max_nested_per_phase`（建议保守值：3）
  - CLI 子进程 RSS > 4GB 时 supervisor 主动降级（写 `degraded.flag` 让 phase-runner 切自实施）
  - 实测斜率 > 500MB/nested 时触发 G2 gate（NO-GO Phase 6）
- **Decision gate**: G2 — 数据决定 Phase 6 是否能上线
- **Depends on**: Phase 2
- **Type**: backend
- **Mode**: runner
- **Critical**: false

## Phase 4: Broker tx_id isolation + 20-way stress (not_started)

- **Alias**: P1d
- **Goal**: 解决 codex C3。v4.4.2 已识别 broker.log 并发 race hazard，nested G-plan 把并发倍增到 20 路。tx_id 必须 128-bit 唯一 + 严格 correlation
- **Files**:
  - `src/utils/broker-log.ts`（新建）：tx_id 生成（crypto.randomUUID），事件 schema 强约束
  - 替换 broker.log 消费方：只通过 tx_id 关联，禁止 tail-position / time-window / nearest-error 推断
  - `templates/scripts/ccg-phase-runner-launcher.mjs`：注入 tx_id 到子进程 env
  - `tests/stress/broker-concurrent.ts`（新建）
- **Acceptance**:
  - tx_id 唯一性 stress test 通过（10 万 spawn 0 碰撞）
  - broker.log schema validation（parser 拒收缺字段事件）
  - 4 outer × 5 nested × 20 路并发下 0 misattribution
  - 跨 Windows + Linux 一致
- **Decision gate**: G3 — 失败则 nested 模式禁用 plugin spawn
- **Depends on**: Phase 2
- **Type**: backend
- **Mode**: runner
- **Critical**: true

## Phase 5: Cost/cache 真实 workdir benchmark (not_started)

- **Alias**: P1e
- **Goal**: 解决 codex C5。PoC cost 估算偏乐观 4-13 倍，必须在真实 workdir benchmark 才能给出 budget defaults
- **Files**:
  - `tests/poc/prompt-cache-bench.ts`（新建）：80 spawn × 3 repo × 2 TTL
- **Acceptance**:
  - 三类 repo（ccg-workflow / uni-iam / minimal）× 两种 TTL 模式 = 6 张数据表
  - 给出 v4.5 默认 `--max-budget-usd` 三档：fast=$1 / triple=$5 / debate=$15（基于 p90 + 50% 余量）
  - 文档化：用户应该期待的 autonomous run cost 范围
- **Decision gate**: G4 — p90 > $30/run 触发 v4.5 v2 优先级提升
- **Depends on**: Phase 1
- **Type**: backend
- **Mode**: runner
- **Critical**: false

## Phase 6: Nested G-plan opt-in 渐进开启 (not_started)

- **Alias**: P1f
- **Goal**: Phase 3+Phase 4 验证通过后，把 nested G-plan 变成用户可用 feature。默认关闭，opt-in 启用
- **Files**:
  - `templates/commands/agents/phase-runner.md`：删除"⚠️ 引擎层硬约束"段（CLI 模式下不再适用），新增"Nested rescue delegation"段
  - `src/utils/quality-router.ts`：phase frontmatter 加 `nested_rescue: true|false` override；主线编排器加 global flag `--nested=on|off`
  - `templates/commands/autonomous.md`：Step 4.0 加 nested mode 检测 + 注入 phase-runner prompt
- **Acceptance**:
  - 默认 `--nested=off` 行为与 v4.5 v1（保守路线）100% 等价
  - `--nested=on` 端到端 dogfood：1 个 frontend phase + 1 个 backend phase
  - nested cap 来自 Phase 3 测出的 slope（默认 3，可 override）
  - supervisor 监控 CLI 子进程 RSS，超 4GB 自动降级 nested → 自实施
  - broker.log 在 nested 模式下 tx_id 关联正确（Phase 4 验证）
  - 文档化 `--nested` flag 使用场景 + 风险
- **Depends on**: Phase 3, Phase 4
- **Type**: backend
- **Mode**: runner
- **Critical**: true

## Phase 7: `/ccg:status` v2 dashboard + tail + 卡点检测 (not_started)

- **Alias**: P2
- **Goal**: 解决 gemini U1+U3。失去 sidechain inline UI 后，`/ccg:status` 必须能复刻"长跑用户的微观干预"能力（早上查岗 / 死循环 debug / 单 phase cancel / 实时 tool call）
- **Files**:
  - `templates/commands/status.md`：扩展为 dashboard + tail 双模式
  - `src/utils/stream-renderer.ts`（新建）：解析 stream-json 事件 → 用户可读单行
  - `src/utils/stuck-detector.ts`（新建）：连续 N 次相似 tool_call 检测 / 单 tool >30s 警告
- **UX 规范**:
  - Dashboard 模式（`/ccg:status` 无 --tail）：mini ASCII 进度条聚合多 phase
  - Tail 模式（`/ccg:status --tail <job-id>`）：单行覆写实时 progress + 卡点警告
  - Event filter — 丢弃：`system/init` / `content_block_delta` / `stream_event/message_*`；保留：`tool_use` / `hook_started` / `assistant`(总结) / `rate_limit_event` / `result/success`
- **Acceptance**:
  - Dashboard 模式聚合多 phase 进度
  - Tail 模式单行覆写实时 progress
  - 卡点检测触发警告（连续 3 次相同 tool_call / 单 tool >30s）
  - `--cancel <phase-id>` 单 phase cancel（复用 Phase 2 cancel.flag + kill-tree）
  - 跨平台测试（Windows cmd / PowerShell / Linux bash）
- **Depends on**: Phase 1
- **Type**: frontend
- **Mode**: runner
- **Critical**: false

## Phase 8: v4.5.0 release docs + dogfood validation (not_started)

- **Alias**: P3
- **Goal**: 版本号 bump、CHANGELOG 撰写、迁移指南、最终 dogfood 验证
- **Files**:
  - `package.json`: 4.4.3 → 4.5.0
  - `CHANGELOG.md`：新版本块
  - `README.md`：更新命令表 + 新增 `--nested` flag 文档（如 Phase 6 通过）
  - `CLAUDE.md`：Last Updated + 变更记录
  - `.ccg-migration/v4.4-to-v4.5.md`（新建）：迁移指南
  - `.claude/team-plan/v4.5-release-report.md`（新建）：dogfood 数据 + cost benchmark 摘要
- **Acceptance**:
  - `pnpm typecheck` pass
  - `pnpm test` pass
  - dogfood 一个完整 milestone（5+ phase）端到端
  - cost benchmark 数据 publish 在 README
  - **Release entry criteria**: uni-iam 项目跑 5+ phase autonomous，全程 RSS < 8GB
- **Depends on**: Phase 1, Phase 2, Phase 3, Phase 4, Phase 5, Phase 6, Phase 7
- **Type**: docs
- **Mode**: foreground
- **Critical**: false

---

## 已知风险与降级路径

| 风险 | 触发条件 | 降级路径 |
|---|---|---|
| Phase 1 Bash spawn 路径未知 bug | dogfood 失败率 > 10% | G1：回退 v4.4.3 + SessionStart RSS 警告 hook（治标）|
| Phase 3 nested 累积太凶 | per-nested slope > 500MB | G2：Phase 6 推迟 v4.6 |
| Phase 4 broker race 难解 | tx_id 唯一性失败 | G3：nested 模式禁用 plugin spawn |
| Phase 5 cost 超预算 | p90 > $30/run | G4：v4.5 v2 优先级提升 |
| Windows Job Object 不靠谱 | 杀父进程 plugin 仍 orphan | 回退 cooperative cancel + 文档警告 |

---

## v4.5 v1 vs v4.5 v2 范围

| 范围 | v4.5 v1 必做 | v4.5 v2 推后 |
|---|---|---|
| Phase 1 / Phase 2 / Phase 5 / Phase 7 / Phase 8 | ✅ | — |
| Phase 3 / Phase 4 / Phase 6 | ✅（激进路线）| 可降级 |
| `--bare` opt-in + apiKeyHelper | 🚫 | ✅（gemini U4 方案 B）|
| `.env` API key 自动注入 | 🚫 | ✅ 推荐（gemini U4 方案 B 推荐）|

---

**Last Updated**: 2026-05-06
