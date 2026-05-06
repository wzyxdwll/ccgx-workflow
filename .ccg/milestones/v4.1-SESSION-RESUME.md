# Session Resume — v4.1 Dogfood Kickoff

> 此文件是**手动版 SessionStart hook**（v4.1 Phase 1 自动化前的过渡）。
> 新会话第一动作：Read 此文件，按"启动指令"行事。

---

## 当前状态（2026-05-04）

- **Version**: 4.0.1（package.json 仍是 4.0.0，未 bump，等 v4.1 收尾时一并 bump）
- **Branch**: master
- **Last commit**: `da75b7b docs(v4.1-plan): plugin-first multi-model design + Phase 8 codeagent retirement`
- **Tests**: 516/516 passing
- **Typecheck**: pass
- **v4.0 dogfood**: ✅ 12 phase 全完（commit 256beb3 → 4973600）
- **v4.0.1 校正**: ✅ G plan 双层架构真相校正（commit aac3770），phase-runner 文档/测试/plan 全部对齐"单层 fresh-subagent 自实施"现状
- **v4.1 plan**: ✅ 已写到 `.claude/plan/v4.1-roadmap.md`（plugin-first，8 phase + 1.5 = 9 phase 共 15d）

## v4.1 路线（按依赖顺序）

| Phase | 名称 | 工时 | 依赖 |
|-------|------|------|------|
| **1** | SessionStart hook + 项目记忆自动注入（**最高优先**——做完才能 clear 不忘）| 1d | — |
| 2 | autonomous wave 并行调度 | 2d | — |
| 3 | specialist matrix 路由（role × layer） | 2d | — |
| 4 | dedicated challenger 主线扁平编排（Critical 字段触发）| 1d | 3 |
| 5 | 原生 debate 原语 `/ccg:debate` | 3d | 3 |
| 6 | 命令面板 31→22 + 清理 v3 残留 | 1.5d | — |
| 7 | Skill 体系优化（context:fork / paths / impeccable 翻译）| 1.5d | — |
| **8** | **codeagent-wrapper → plugin 迁移（核心命令路径升级）** | 3d | — |

## 启动指令（新会话第一句话推荐复制）

```
Read .ccg/SESSION-RESUME.md 完整理解项目当前状态，然后：

1. Read .claude/plan/v4.1-roadmap.md Phase 1 段
2. spawn Agent(subagent_type="phase-runner") 跑 Phase 1
3. 完成后改 .ccg/roadmap.md 把 Phase 1 标 completed，启动 Phase 2

注意：
- v4.1 Phase 1 实施完成后，未来新会话能自动 Read .ccg/state + roadmap，不再需要这份 SESSION-RESUME.md
- 当前会话上下文起点应该 < 10%（新会话状态），可以承载整个 v4.1 dogfood
- 如果只想做单 phase 不连续跑全 v4.1，spawn phase-runner 时 prompt 里说明
```

## 关键文件位置

| 文件 | 用途 |
|------|------|
| `.claude/plan/v4.1-roadmap.md` | v4.1 完整 8 phase 计划（含 Phase 8 codeagent 迁移）|
| `.ccg/roadmap.md` | v4.0 已完成 12 phase 状态机 + Milestone Summary |
| `.ccg-research/01-context-architecture.md` | GSD context 治理研究（v4.1 Phase 1 SessionStart hook 参考）|
| `.ccg-research/04-ecosystem-scan.md` | 开源生态扫描（v4.1 Phase 6/7 命令瘦身/skill 优化参考）|
| `.ccg-research/07-multimodel-collaboration-rethink.md` | 多模型生硬 motivation（v4.1 Phase 3/4/5/8 全部基于这个）|
| `templates/commands/agents/phase-runner.md` | 已校正：subagent 不能嵌套 spawn Agent，自实施模式 |
| `src/utils/phase-runner.ts` | helper：parsePhaseRunnerSummary / routePhaseType / decideNextAction |

## 已知引擎约束（v4.0.1 实测确认）

- **任何 subagent 启动后工具列表不含 Agent/Task** —— Claude Code 引擎硬限制，frontmatter 声明无效
- → v4.1 challenger / debate **必须主线扁平化编排**，不能让 subagent 内部嵌套
- → codeagent 路径不解决这问题（也是同样限制），但 codeagent **本身**也不需要嵌套

## v4.1 Phase 1 acceptance（直接 spawn phase-runner 用）

```
phase_id: phase-v4.1-01-session-start-hook
phase_n: 1
phase_name: SessionStart hook + 项目记忆自动注入
phase_type: backend
phase_goal: |
  新会话启动时 Claude Code 自动 Read .ccg/roadmap.md + .ccg/state.md +
  active phase 的 .context/<phase>/SUMMARY.md，注入精简摘要到主线 context。
  这是 GSD gsd-session-state.sh 在 CCG 的对应物。
phase_acceptance: |
  - 新建 templates/hooks/ccg-session-state.js（参考 GSD gsd-session-state.sh 但用 Node）
  - 输入：SessionStart hook stdin 的 JSON（含 cwd / session_id）
  - 行为：检测 .ccg/roadmap.md 存在 → 读头部 20 行 + 当前 in_progress phase 段 + 注入 additionalContext
  - 输出：JSON envelope 含 hookEventName / additionalContext / state_present / active_phase
  - settings.json 集成：installer.ts 在 hooks 段加 SessionStart 注册（跟现有 PostToolUse 同模式）
  - 单测 src/utils/__tests__/sessionStartHook.test.ts，至少 8 用例
    - mock stdin 含 cwd, 验证 hook 找到 .ccg/roadmap.md
    - mock 没有 .ccg/roadmap.md 场景, 验证 hook 静默退出
    - mock active phase = in_progress, 验证摘要含 active_phase 字段
    - mock state.md 存在, 验证 wave 进度被注入
- 全量 pnpm test pass + typecheck pass
phase_depends_on: (none, this enables everything else)
workdir: D:/workflow/ccg-workflow
baseline_sha: da75b7b
report_path: .claude/team-plan/phase-v4.1-01-session-start-hook-report.md
commit_prefix: feat(v4.1-p1):
Critical: false
```

## v4.0 dogfood 实测数据（用于 v4.1 baseline 对比）

- 主线 context 漂移：T0=31% → T11=49%（+18% / 12 phase）
- 平均 +1.5%/phase（含 Phase 1.5 +10% foreground spike + Phase 12 +2% docs spike）
- 纯 runner 模式 phase（2-11）平均 +0.6%/phase
- 总测试 168 → 515（+347）
- 总耗时 2h24min

**v4.1 期望**：主线漂移 ≤ +1%/phase × 8 phase = +8%（含 Phase 1 hook 自身 + Phase 8 codeagent 迁移）

## 主线 context 警戒线

CCG v3.0 移植的 context-monitor hook 阈值：
- ≤35% remaining → WARNING（注入提醒）
- ≤25% remaining → CRITICAL（建议立即停下保存状态）

新会话从 ~5% used 起步，跑完 v4.1 8 phase 预估到 ~25%——远低于警戒线。

---

**Last Updated**: 2026-05-04 00:30
**Created by**: previous session @ context 67% （为避免 v4.1 dogfood 撞警戒线而提前归档）
