---
name: ccg:autonomous
description: 跨 phase 自治长跑：roadmap → wave 并行（默认）spawn phase-runner，仅 blocker 暂停
argument-hint: "[--from N] [--to N] [--only N] [--quality=fast|triple|debate] [--interactive] [--offload] [--sequential] [--max-concurrent N]"
context_budget: orchestrator-15
subagent_freshness: required
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - AskUserQuestion
  - Task
  - Agent
  - TodoWrite
---
<!-- CCG:AUTONOMOUS:START -->

# Autonomous - 跨 Phase 自治长跑

## 职能定位

`/ccg:autonomous` 是**编排层之上的编排层**：读 `.ccg/roadmap.md` 一次性跑完整个 milestone 的所有 phase，每个 phase 内部委托给 `/ccg:team`（或 `/ccg:spec-impl`）完成 8 阶段流程，仅在 blocker / 灰区接受 / 用户决策点暂停。

> **v4.1 调度模型变更**：默认行为从 v4.0 的"逐 phase 顺序串行"升级为 **wave 并行**。
> autonomous 用 Kahn 拓扑排序把 EXEC_QUEUE 划分成 wave，wave 内 phase 一次性并行
> spawn `Agent(phase-runner)`（max-concurrent 默认 4），wave 之间顺序执行——这与
> v3.0 起的 `team-exec` wave 调度心智模型对齐，墙钟时间通常压缩 30-40%。
> v4.0 的串行行为通过 `--sequential` flag 保留作为调试 / API 限额场景的降级路径。

**与 `/ccg:team` 的边界**：

| 维度 | `/ccg:team` | `/ccg:autonomous` |
|------|-------------|-------------------|
| 范围 | 单个任务的 8 阶段全流程 | 多个 phase 顺序串联 |
| 调用对象 | 直接 spawn Architect / Dev / QA / Reviewer | 调用 `/ccg:team` 或 `/ccg:spec-impl` |
| 状态文件 | `.ccg/state.md`（任务 wave 维度） | `.ccg/roadmap.md`（phase 维度） |
| 暂停条件 | Critical 未修、Phase 6 之后用户确认 | blocker / 灰区 / 跨 phase 依赖断裂 |
| 适合 | 一次性完整开发任务 | 长程 milestone（重构、迁移、多阶段功能） |

简言之：autonomous 写 `.ccg/roadmap.md`（phase 进度），team-exec 写 `.ccg/state.md`（wave 任务进度），两份文件分工明确互不交叉。

---

## 触发场景

**适合**：
- 长程重构（如 monolith → 微服务，分 5 phase 拆分）
- 多阶段功能开发（认证体系：先后端 schema → API → 前端登录页 → SSO 集成）
- 迁移项目（React 16 → 18、CommonJS → ESM、Jest → Vitest）
- 周末/夜间无人值守跑长链路任务
- 已有清晰 roadmap、各 phase 间依赖明确的项目

**不适合**：
- 一次性任务（直接用 `/ccg:team`）
- 紧急修复（直接用 `/ccg:debug`）
- 探索性需求未定型（先 `/ccg:spec-research`）
- 单 phase 内的并行实施（用 `/ccg:team-exec`）

---

## 前置条件

1. **`.ccg/roadmap.md` 必须存在**。若不存在，autonomous 第一步引导用户创建（见 Step 1）。
2. **Agent Teams 已启用**（`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`），因为内部要调 `/ccg:team`。
3. **WORKDIR**：通过 Bash `pwd`（Unix）或 `cd`（Windows）获取当前工作目录绝对路径，禁止从 `$HOME` 推断。

---

## 工作流程

### Step 1: Roadmap 解析与初始化

1. 通过 Bash 执行 `pwd` 获取 WORKDIR。
2. Read `<WORKDIR>/.ccg/roadmap.md`：
   - **存在** → 解析所有 `## Phase N: <name> (<status>)` 标题，抽出 `goal` / `depends on` / `started` / `completed` / `outcome` 字段。
   - **不存在** → 用 `AskUserQuestion` 询问用户：
     ```
     未发现 .ccg/roadmap.md。autonomous 需要 roadmap 列出所有 phase。请选择：
     1. 我来口述 milestone 拆分，由你生成 roadmap.md
     2. 我自己写好 roadmap.md 后再跑 /ccg:autonomous
     3. 跑 /ccg:spec-research <需求> 自动生成 roadmap.md 草案
     ```
   - 选项 1 → 通过对话补全所有 phase，写入 roadmap.md，请用户确认后继续。
   - 选项 2/3 → 终止当前调用。

3. **解析校验**：
   - 每个 phase 必须有唯一序号（Phase 1、Phase 2、...）
   - `Depends on` 引用的 phase 序号必须存在
   - 状态值合法：`pending` / `in_progress` / `completed` / `failed` / `skipped`
   - 任一不合法 → 终止，列出问题清单要求用户修正

### Step 2: 应用 flag 过滤

按以下优先级生成执行队列 `EXEC_QUEUE`：

| 场景 | 行为 |
|------|------|
| `--only N` 提供 | `EXEC_QUEUE = [Phase N]`，其余全跳过 |
| `--from N` 提供 | 从 Phase N 开始，含 N |
| `--to N` 提供 | 跑到 Phase N 结束，含 N，不推进 N+1 |
| 都未提供 | 从第一个非 `completed` phase 开始，跑到末尾 |
| 同时给 `--only` 和 `--from`/`--to` | `--only` 优先，其余忽略并提示 |
| `--interactive` | 每个 phase 内的 plan 阶段保留与用户问答（不自动判定灰区） |
| `--offload` | **重型 phase 自动外包给 codex plugin**（fresh context + 后台 + 主线只 poll status），默认开启自动判定，flag 显式时强制开启 |
| `--sequential` | **降级为 v4.0 行为**：禁用 wave 并行，单 phase 一波顺序串跑。调试 / API 限额场景使用 |
| `--max-concurrent N` | 单 wave 内最大并发 phase 数，默认 4。`--max-concurrent 1` 等价 `--sequential` |
| `--quality=fast\|triple\|debate` | **v4.2 P22 旗舰**：单 phase 内的质量档分级。`fast`=v4.1 单波 + 1 路 verify；`triple`=Plan-Critic-Verify 4 wave（**默认**）；`debate`=triple + codex↔gemini 多轮对辩。详见 Step 4.0 |

附加规则：
- 状态已是 `completed` 的 phase 默认跳过（除非 `--only N` 强制重跑）
- 状态为 `failed` 的 phase 进入队列时询问用户：重跑 / 跳过 / 终止
- `EXEC_QUEUE` 为空 → 输出"所有 phase 已完成 ✅"并退出

### Step 3: 用户确认

用 `AskUserQuestion` 展示执行计划：

```
🛣 即将自治执行 Milestone: <project name>

执行队列（共 N phase）：
- Phase 2: 实现 user API（依赖 Phase 1 ✅）
- Phase 3: 前端登录页（依赖 Phase 2）
- Phase 4: SSO 集成（依赖 Phase 3）

预计调用：
- /ccg:team × 3（每个 phase 一次完整 8 阶段）
- 暂停条件：Critical 未修 / 用户决策点 / 跨 phase 依赖断裂

模式：<auto | interactive>

确认开始？
```

`--interactive` 模式下，每个 phase 的 plan 阶段保留与用户问答（不自动判定灰区），其余阶段照常自治。

### Step 4: Phase 主循环（v4.1 wave 并行 + v4.2 P22 质量档分级）

#### 4.0 Ground-Truth 采样（v4.3 P26 / v4.4 P32 集成）

**进入主循环前**，主线必须采样真实外部接口状态，写入 `.context/ground-truth/<ISO timestamp>.json` + 软链 `latest.json`。
phase-runner 的 prompt 强约束 "写涉及 plugin subagent_type / hook event / settings.json schema / skill 名 等代码前必须 Read latest.json"，避免 v4.2.0 `codex:codex-rescue` 同型猜接口事故重演。

**主线动作**（伪码）：

```js
import { sampleAll, summarizeGroundTruth } from 'src/utils/ground-truth-sampler'

const gt = sampleAll({ workdir: process.cwd() })
const ts = gt.sampledAt.replace(/[:.]/g, '-')   // 文件名安全
const dir = '.context/ground-truth'

mkdirSync(dir, { recursive: true })
writeFileSync(`${dir}/${ts}.json`, JSON.stringify(gt, null, 2))

// 软链 latest.json（POSIX symlinkSync；Windows 退化为复制写入）
try { unlinkSync(`${dir}/latest.json`) } catch {}
try { symlinkSync(`${ts}.json`, `${dir}/latest.json`) }
catch { writeFileSync(`${dir}/latest.json`, JSON.stringify(gt, null, 2)) }

console.log(summarizeGroundTruth(gt))   // ≤500 token brief 写入主线对话以便 phase-runner 拷贝
```

**容错**：若采样抛错，主线打印警告但**不阻塞推进**——单 phase 仍可工作（degraded：phase-runner prompt 走"无 ground truth"分支，凭 spec 文档猜，恢复至 v4.2 行为）。

**phase-runner 注入路径**：每次 spawn phase-runner 时，主线在 prompt 里加一行 `ground_truth_path: <workdir>/.context/ground-truth/latest.json`，并要求子 agent 在动外部接口代码前必须 Read 该文件。

#### 4.0a 质量档解析（v4.2 P22 新增，单 phase 内调度）

每个 phase 进入主循环前，主线先确定**该 phase 内部使用什么质量档**——这决定单个 phase 的 wave 编排（不是整个 milestone 的 wave 拓扑，那是 4.0b）。

**优先级（高 → 低）**：

1. **phase frontmatter `Quality:` 字段**（roadmap.md 单 phase 覆盖全局 flag）
   ```markdown
   ## Phase 22: schema migration (pending)
   - **Goal**: ...
   - **Quality**: debate    ← phase 自带，优先级最高
   ```
2. `--quality=<tier>` CLI flag（autonomous 命令行参数）
3. 默认 `triple`（**v4.2 行为变化**：v4.1 默认是单波 phase-runner = `fast`）

主线引用 `src/utils/quality-router.ts` 的 `buildQualityPlan()` helper（实际逻辑已落地为单元测试覆盖；本模板只描述 LLM 主线该做什么）：

```
qualityPlan = buildQualityPlan(
  { cliArgs: <user args>, phaseQuality: <从 frontmatter 读> },
  { phaseId, phaseType, quality },
  pluginAvailability,
)
// qualityPlan.tier  → 'fast' | 'triple' | 'debate'
// qualityPlan.waves → WavePlan[] (kind ∈ plan|critic|impl|verify|debate)
// qualityPlan.degraded / degradedTo  → plugin 缺失自动降阶
```

**三档对照（dogfood + SOTA 实测预算）**：

| 档 | wave 序列 | 壁钟膨胀 | token 膨胀 | 质量档（dogfood 估测） |
|----|----------|---------|-----------|----------------------|
| `fast` | impl → verify | +30% | +20% | 6.5/10 → 7.5/10 |
| `triple` | plan → critic → impl → verify | +60-90% | +80% | →8.5/10 |
| `debate` | plan → debate×3 → critic → impl → verify | +100-150% | +150% | →9/10 |

**降级路径**（plugin 缺失自动）：

| 用户请求 | plugin 状态 | 实际执行 |
|---------|------------|---------|
| `debate` | 双 plugin 都缺 | → `fast`（debate/triple 失去对辩多样性） |
| `debate` | 单 plugin 缺 | → `triple` |
| `triple` | 双 plugin 都缺 | → `fast` |
| `triple` | 单 plugin 缺 | 不降阶，但缺失方向走 `general-purpose` + CCG prompt 模板 |
| `fast`  | 双 plugin 都缺 | 主线 reviewer fallback（main-thread Claude 自审） |

降级时主线在 roadmap.md 该 phase 标 `Note: quality degraded from <X> to <Y> — <reason>`。

**设计哲学（基于市面 SOTA Plan-Critic-Verify 实测）**：

- **Plan 阶段 lateral diversity**（codex+gemini+claude 3 路并行）—— 不同视角生成不同侧重点
- **Critic 阶段 angle-based**（assumptions-analyzer + nyquist-auditor）—— 不是按模型而是按"审视角度"分工
- **Implementer 单 strong model**（phase-runner 全权 Bash）—— 一致性 > 多样性，避免多 implementer 的 merge 痛苦
- **Verify cross-vendor**（codex + gemini）—— 抓 race condition / commit drift / 半成品状态

#### 4.0b 拓扑分波（Kahn 算法）

**默认行为**：把 `EXEC_QUEUE` 按 `Depends on` 字段构建有向无环图，Kahn 拓扑排序分波——
没有未满足依赖的 phase 进 wave 1，依赖 wave 1 的进 wave 2，依次类推。同 wave 的 phase
之间无依赖关系，可在主线一个 message 里并行 spawn 多个 `Agent(phase-runner)`，由 Claude
Code 引擎并发执行；不同 wave 之间顺序执行。

主线引用 `src/utils/wave-scheduler.ts` 的 `parseRoadmap` + `schedule` helper（实际算法
已落地为单元测试覆盖，本模板只描述 LLM 主线该做什么）：

```
phases     = parseRoadmap(roadmap.md content)
waves, skipped, batches = schedule(phases, {
  maxConcurrent: <user --max-concurrent N or 4>,
  skipCompleted: true,
})
```

**`--sequential` 降级**：等价 `maxConcurrent = 1`，每 phase 单独成一批，顺序执行。
调试 / 复现历史 v4.0 行为 / API 限额场景使用。

**Cascade skip**：若某 phase 状态为 `failed` 或 `skipped`，所有（直接 / 间接）
依赖它的 phase 自动标 `skipped`，从 EXEC_QUEUE 移除并在 roadmap.md 写
`skipped (cascade from Phase X)`，不进入任何 wave。这避免了下游 phase 在
依赖断裂时仍尝试 spawn phase-runner 浪费 token。

**用户确认**：进入 Step 4.1 前 `AskUserQuestion` 展示 wave 划分：

```
🌊 Wave 划分（共 W wave）：
  Wave 1: Phase 1, 3, 4, 7, 8, 10, 11    ← 并行 spawn 7 phase-runner（max-concurrent=4 → 分 2 批）
  Wave 2: Phase 2, 5, 6                   ← 等 Wave 1 完成
  Wave 3: Phase 9                         ← 等 Wave 2 完成
  Wave 4: Phase 12                        ← 等 Wave 3 完成

预计墙钟压缩：~35% vs 顺序执行
模式：parallel | sequential
```

#### 4.1 准备 phase（按 wave 迭代 + 单 phase 质量档子 wave）

**两层 wave 概念**（v4.2 P22 起）：

- **外层 wave**（4.0b 拓扑）：milestone 级别，按 phase 间 Depends on 关系分波，wave 内 phase 并行
- **内层 wave**（4.0a 质量档）：单 phase 内部，按 fast/triple/debate 分 2/4/7 个子 wave，**子 wave 之间顺序执行**

主循环结构（伪码）：

```
for outerWave in milestoneWaves:
    batches = chunk(outerWave, max-concurrent)        # 单 wave 拆批
    for batch in batches:
        # 每个 phase 独立按其质量档跑内层 wave
        results = spawn_parallel(batch, lambda phase:
            runPhaseWithQualityPlan(phase, buildQualityPlan(...)))
    # 整 wave 完成后批量更新 roadmap.md，处理 cascade
    update_roadmap_for_wave(outerWave, results)

# 单 phase 内层 wave 处理（fast/triple/debate 共用骨架）：
runPhaseWithQualityPlan(phase, plan):
    designBrief = null
    verifyFindings = null
    for innerWave in plan.waves:
        switch innerWave.kind:
            case 'plan':       # 仅 triple/debate
                contributions = spawn_parallel(innerWave.spawns)  # 3 路并行
                designBrief = aggregatePlans(contributions)
            case 'critic':     # 仅 triple/debate
                criticReports = spawn_parallel(innerWave.spawns)
                if any critical → mark phase requiring revise BEFORE impl
            case 'debate':     # 仅 debate（共 3 子 wave）
                debateRound = spawn_parallel(innerWave.spawns)
                # 复用 debate-orchestrator.shouldStop 提前收敛
            case 'impl':
                # spawn phase-runner，prompt 注入 design_brief / verify_findings
                phaseSummary = spawn(phase-runner, prompt={
                    ...basePromptFields,
                    design_brief: serializeBriefForPrompt(designBrief),
                    verify_findings: verifyFindings,
                })
            case 'verify':
                # P27: triple/debate verify wave 现在 3 路并行：
                #   - codex:codex-rescue   — cross-vendor verify (race / commit drift)
                #   - gemini:gemini-rescue  — cross-vendor verify (UX / 半成品)
                #   - interface-auditor — 跨 phase 接口审计（SSoT / leftover /
                #                         magic-string vs ground truth /
                #                         commit-diff drift / mock-drift）
                # fast 模式不加 interface-auditor（fast 优先速度）。
                #
                # ⛔ v4.4.2 verify wave 强制 Bash 直调 plugin script：
                #   verifyWave = planVerifyWave(tier, layer, plugins,
                #                               { useDirectBashInvocation: true })
                #   for each spawn entry where invocationMode === 'bash-direct':
                #     主线用 Bash 工具跑 spawn.bashCommand（而非 Agent(subagent_type=...)）。
                #     — 绕开 plugin sonnet wrapper，避免 broker 故障 / 空答时的
                #       silent contamination（sonnet 自答冒充 cross-vendor 视角）。
                #     — Bash exit≠0 OR stdout 字节<阈值 → 失败信号 loud，主线据此重试。
                #   interface-auditor 仍走 Agent(subagent_type="interface-auditor")
                #     —— CCG 自家 agent 无 sonnet wrapper 风险。
                verifyReports = spawn_parallel(innerWave.spawns)
                # 主线综合：原 verifier critical 任一 + interface-auditor critical
                # 任一 → revise（synthesizeVerifyResults 已统一处理 STATUS/FINDINGS
                # 协议；interface-auditor 摘要复用同 schema，无需特判）
                decision = synthesizeVerifyResults(verifyReports)
                if decision === 'revise' && retryCount < 1:
                    verifyFindings = synthesizeVerifyFeedback(verifyReports)
                    retry impl wave once
                elif decision === 'escalate':
                    AskUserQuestion → blocker path
```

**impl wave 的 phase-runner prompt 增量**（v4.2 P22）：

triple/debate 模式 plan wave 完成后，主线把 `aggregatePlans` 输出经
`serializeBriefForPrompt()` 序列化（≤500 token）注入 phase-runner prompt 的
`design_brief` 字段（参考 `templates/commands/agents/phase-runner.md` 输入契约）。

verify wave 后若 decision='revise'，主线再 spawn 一次 phase-runner，
`verify_findings` 字段填 `synthesizeVerifyFeedback()` 输出。
**修订仅一轮**（避免无限循环）；二次失败标 `partial` 进 blocker。

针对**每个**进入并发的 phase，spawn 前做：

- 在 `.ccg/roadmap.md` 中将该 phase 状态改为 `in_progress`，写入 `Started: <时间戳>`。
  整 wave 一次性写 roadmap（避免多次磁盘写穿透），用 batch update 模式。
- 用 TodoWrite 维护一个跨 phase 进度列表（每 phase 一项），便于用户随时看进度。
- 检查依赖：所有 `Depends on` 列出的 phase 必须为 `completed`（Step 4.0 已保证；
  这里是 belt-and-suspenders 校验）。失败进入 **blocker 路径**（Step 5）。

#### 4.2 路由：调 `/ccg:spec-impl` / `phase-runner` / `/ccg:team`

按以下优先级判定（**前序匹配后短路**）：

1. **phase 标题含 `opsx://` 引用** → 走 OpenSpec 路径，调 `/ccg:spec-impl` 并传入 change_id
2. **runner 模式 phase**（`--offload` flag 或 phase 标 `[offload]` tag 或满足重型自动触发）→ 调 `Agent(subagent_type="phase-runner")`，把 phase 完整定义 + Type 字段传给它（**v4.0 G 方案**）
3. **默认** → 走 Agent Teams 路径，调 `/ccg:team <phase goal>`

##### runner 模式判定（决定走第 2 路）

**显式触发**：
- `--offload` flag 提供（强制走 phase-runner，所有 phase 都走）
- 用户在 roadmap.md 里手动标 `[offload]` 或 `Mode: runner`（例 `## Phase 5: 命令收敛 [offload] (pending)`）

**自动触发**（满足任一即可）：
- phase goal 含关键词：`重构 / 迁移 / 全量改 / refactor / migrate / rewrite`
- phase 预估涉及 > 20 个文件
- 上一个 phase 的 plan 文件 > 800 行

##### phase-runner 调用方式（G 方案）

phase-runner 是 CCG v4.0 引入的**单 phase 全权代理子 agent**——它包裹 codex/gemini rescue 子任务，按 phase Type 字段路由到对应模型，沙箱外补 git/test/typecheck handoff，最终返回主线 ≤200 token 摘要。详见 `~/.claude/agents/ccg/phase-runner.md`。

```
Agent({
  subagent_type: "phase-runner",
  description: "Phase <N> runner",
  prompt: `
phase_id: phase-<N>-<slug>
phase_n: <N>
phase_name: <从 roadmap.md 标题提取>
phase_type: <backend | frontend | fullstack | docs | generic>  # 从 roadmap.md Type 字段读取
phase_goal: |
  <Goal 段全文>
phase_acceptance: |
  <Acceptance 段全文>
phase_depends_on: <已 completed 的 phase 列表 + 它们的产物路径>
workdir: <WORKDIR>
baseline_sha: <最近一次 baseline commit sha7>
report_path: .claude/team-plan/phase-<N>-<slug>-report.md
commit_prefix: feat(v4-p<N>):
enable_challenger: false  # v4.1 接入点，v4.0 默认关
`
})
```

phase-runner 子 agent 内部完整 lifecycle（spawn rescue → 等报告 → 接 handoff → 验 acceptance → 摘要返回），主线**不参与中间步骤**。

**模型路由委派给 phase-runner**：autonomous 主线不再硬编码 codex/gemini，phase-runner 根据 prompt 里的 `phase_type` 字段决定 spawn `codex:codex-rescue` 还是 `gemini:gemini-rescue`。这修复了 v3.0 路由 bug（autonomous 绕过 `{{FRONTEND_PRIMARY}}/{{BACKEND_PRIMARY}}` 配置）。

**降级路径**：若 `Agent(phase-runner)` 调用失败（v3.0 旧版未装该 subagent），输出告警 + fallback 到第 3 路 `/ccg:team`，roadmap.md 备注 `Note: phase-runner unavailable, fell back to team`。

#### 4.3 监控 phase 内信号

**走 team / spec-impl 路径**（4.2 第 1/3 路）：

- team 会在 `.ccg/state.md` 写 wave-level 任务进度（这是 team-exec 的职责，autonomous 不重写它）。
- team 完成后产出 `.claude/team-plan/<task-id>-report.md`。
- autonomous 读取该 report：
  - **Phase 完成且 Critical = 0** → 进入 4.4 推进
  - **Phase 完成但 Critical > 0**（用户在 team 内选了"接受失败"） → 进入 **blocker 路径**
  - **Phase 失败**（team 异常退出 / 测试不可恢复地失败） → 进入 **blocker 路径**

**走 phase-runner 路径**（4.2 第 2 路，G 方案）：

- phase-runner 是个普通 subagent，它返回时 Claude Code 自动通知主线——主线**不轮询、不读 transcript、不读报告全文**
- 主线只读 phase-runner 返回的 ≤200 token 摘要：
  ```
  STATUS: completed | partial | failed | degraded
  COMMIT: <sha7> | none
  TESTS: <pass>/<total> passed (delta +<n>)
  TYPECHECK: pass | fail
  HANDOFF_TAKEN: [git_commit, test_run, ...]
  CONTEXT_DELTA: <一句话>
  NOTES: <一行关键发现 / 灰区决策点>
  ```
- 摘要解析后路由：
  - `STATUS: completed` → 进入 4.4 推进
  - `STATUS: partial` → AskUserQuestion 暂停（"重试 / 接受部分 / 跳过 / 终止"）
  - `STATUS: failed` → AskUserQuestion 暂停（"重试 / 跳过 / 终止"），下游依赖 phase 自动 cascade 标 blocked
  - `STATUS: degraded` → 警告但继续（rescue plugin 不可用但 phase-runner 已 fallback 完成）
- **心跳超时**：spawn phase-runner 后 30 分钟内无 completion 通知 → AskUserQuestion 提示"等 / 强制 fail / 重 spawn"
- runner 路径**不写** `.ccg/state.md`（state.md 是 team-exec 私域），只在 roadmap.md 该 phase 写 `Mode: runner` + `Plan: .claude/team-plan/<phase-id>-report.md`

**主线 context 不漂移的关键**：autonomous 主线只接 ≤200 token 摘要，phase-runner 子 agent 的 transcript（包括 codex/gemini rescue 报告全文）都在子 agent 的 fresh context 里，**不进主线**。这正是 GSD"主线 ≤15% / subagent fresh"原则的 Claude Code 原生实现。

#### 4.4 Phase 推进（wave 级批处理）

- **4.4.a Critical phase challenger 编排（v4.1 Phase 16）**：
  当 phase 摘要 `STATUS: completed` 时，主线先读 phase frontmatter `Critical:` 字段
  （默认 `false`）。若 `Critical: true` 且**未进入修订轮**，主线**不立即推进**，
  改为 spawn 一组 challenger agents 做"双视角对辩 + 假设/边界审计"：

  路由（由 `src/utils/challenger-orchestrator.ts` 的 `planChallengerSpawns` 决定，
  本模板只描述 LLM 该做什么）：

  | phase Type | spawn 计划（adversarial=true）|
  |-----------|------------------------------|
  | `backend`  | `Agent(codex:codex-rescue)` + `Agent(assumptions-analyzer)` |
  | `frontend` | `Agent(gemini:gemini-rescue)` + `Agent(nyquist-auditor)` |
  | `fullstack`| `Agent(codex:codex-rescue)` + `Agent(gemini:gemini-rescue)` + `Agent(assumptions-analyzer)` + `Agent(nyquist-auditor)` |
  | `docs`/`generic` | `Agent(assumptions-analyzer)` 单兵 |

  **plugin 缺失降级**（acceptance d）：installer 检测不到 `codex:codex-rescue` 或
  `gemini:gemini-rescue` 命令时，主线只 spawn specialist（CCG 自家 agent，必装），
  **不 fallback** 到 codeagent-wrapper（避免重新建立 v3.0 已退役的依赖）。
  roadmap.md 备注 `Note: challenger degraded — plugin <name> missing`。

  spawn 范式（一个 message 内并行）：

  ```
  Agent({ subagent_type: "codex:codex-rescue",
          description: "Phase <N> challenger (codex)",
          prompt: <挑战 phase 改动 + 引用 phase-runner 的 commit sha7> })
  Agent({ subagent_type: "assumptions-analyzer",
          description: "Phase <N> assumption critic",
          prompt: <审视 plan 假设、隐藏依赖、未验证前提> })
  ```

  challenger 摘要协议（每路 ≤200 token）：

  ```
  STATUS: complete | error
  FINDINGS: [{severity:critical|major|info, category:..., message:...}, ...]
  NOTES: <≤80 字>
  ```

  主线综合（由 `decideFromSummaries` helper 决定）：

  - **任一 critical finding** → spawn implementer phase-runner **修订一轮**，
    prompt 里嵌入 `synthesizeRevisionFeedback()` 输出的 critical 反馈块，
    要求"仅修复 critical 项，不重做整个 phase"。修订仅一轮（避免无限循环）；
    第二轮失败标 `partial` 进 blocker 路径。
  - **无 critical** → 推进（与非 Critical phase 路径合流）。
  - **任一 error** → AskUserQuestion 暂停（"重试 challenger / 跳过 challenger 直接推进 / 终止"）。

  **跳过条件**：phase frontmatter `Critical: false`（或未声明）→ 跳过 4.4.a，
  直接进 4.4.b 状态写入。

- **4.4.b 状态写入**：单个 phase 完成时，在 `.ccg/roadmap.md` 中将该 phase 状态改为 `completed`，
  写入 `Completed: <时间戳>`、`Outcome: <一句话总结>`、`Plan: .claude/team-plan/<task-id>/`。
- 整 wave 完成（所有 batch 都返回）后做一次性 cascade 检查：
  - 如果该 wave 内任意 phase status=failed/partial（用户选了"跳过"或"接受失败"），
    重跑 `cascadeSkip()` helper，把新增的 cascade-skipped phase 从后续 wave 移除，
    在 roadmap.md 写 `skipped (cascade from Phase X)`。
- 输出 wave 完成提示：
  ```
  🌊 Wave 1/4 → completed (Phase 1, 3, 4, 7, 8, 10, 11 — 7 phase 并行)
  → 推进 Wave 2/4 (Phase 2, 5, 6)
  ```
- 进入下一 wave。

### Step 5: Blocker 路径

任何 blocker 都通过 `AskUserQuestion` 暂停，向用户报告：

```markdown
⚠️ Autonomous 暂停于 Phase 2

原因: <Critical 未修 / 依赖 Phase 1 失败 / API 配额耗尽 / 用户决策点>

详情:
<具体内容，含 team 的 report 摘要、错误日志、灰区描述>

下一步:
1. 重试本 phase（重新调 /ccg:team）
2. 跳过本 phase（标记 skipped，下游依赖 phase 自动 skipped）
3. 终止 autonomous（保留 roadmap.md 当前进度，下次可续跑）
4. 我来手动处理（暂停 autonomous，用户处理后回复"继续"）
```

用户选择决定后续行为；选 4 时 autonomous 进入挂起态，等用户回到主对话发"继续"信号后从断点恢复。

---

## 暂停条件 / Blocker 定义

必须暂停的场景：

| 触发 | 描述 |
|------|------|
| Critical 未修 | team 完成 Phase 7 后仍有 Critical，且用户在 team 内选了"接受失败"或修复 2 轮仍失败 |
| 依赖断裂 | 当前 phase 的 `Depends on` 中有 phase 状态为 failed/skipped |
| 灰区接受 | team 在某阶段产出灰区决策（多个合理选项无单一最优解），且未运行 `--interactive` 模式 |
| 测试不可恢复地失败 | Phase 5 测试报告显示核心断言失败且 Phase 7 修复无效 |
| API 配额耗尽 | codeagent-wrapper 多次返回 quota/rate limit 错误 |
| 跨 phase 依赖文件被覆写 | Phase N 修改了 Phase N-1 的产出文件（罕见，靠 team-exec 的文件隔离基本可避免） |
| 用户显式中断 | 用户在主对话发 stop / pause / 取消 |

---

## 状态文件 `.ccg/roadmap.md` 格式

autonomous 是 **roadmap.md 的唯一写者**。team-exec 不动它。

```markdown
# CCG Project Roadmap

**Project**: user-auth-system
**Started**: 2026-05-01
**Last Updated**: 2026-05-03 14:30

## Phase 1: 数据库 schema 设计 (completed)
- **Goal**: 为 users / sessions / oauth_accounts 设计 schema 与迁移脚本
- **Depends on**: (none)
- **Started**: 2026-05-01 09:00 | **Completed**: 2026-05-01 11:20
- **Plan**: .claude/team-plan/db-schema-20260501-0900/
- **Outcome**: prisma schema 完成，3 张表 + 7 个索引，迁移脚本通过 dry-run

## Phase 2: 实现 user API (in_progress)
- **Goal**: 实现 register / login / refresh token / logout 四个 endpoint
- **Depends on**: Phase 1
- **Started**: 2026-05-03 10:00
- **Plan**: .claude/team-plan/user-api-20260503-1000/

## Phase 3: 前端登录页 (pending)
- **Goal**: 登录页 + 注册页 + 表单校验 + 错误态
- **Depends on**: Phase 2

## Phase 4: SSO 集成 (opsx://add-google-sso)
- **Goal**: 接入 Google OAuth 2.0
- **Depends on**: Phase 3
- **Note**: 走 OpenSpec 路径，autonomous 调 /ccg:spec-impl
```

**字段约定**：
- 状态括号在标题尾部：`(pending|in_progress|completed|failed|skipped)`
- `Depends on` 缺省值为 `(none)`
- `Plan` 字段指向该 phase 内 team 产出的 plan 目录
- `Outcome` 一句话总结，便于下次回顾
- `opsx://<change-id>` 标记走 OpenSpec 路径
- `Quality: fast|triple|debate`（**v4.2 P22 新增，可选**）：单 phase 覆盖全局 `--quality` flag。例：
  ```markdown
  ## Phase 22: schema migration (pending)
  - **Goal**: 数据库 schema 破坏性变更
  - **Quality**: debate    ← 这步用最高档（多轮对辩）
  - **Depends on**: Phase 21
  ```
  缺省时遵循全局 flag，全局也无时默认 `triple`。详见 Step 4.0a。

---

## 状态文件 `.ccg/state.md` 跨 phase 扩展

`.ccg/state.md` 由 team-exec 写、记录 wave 任务进度。autonomous 不重写它，但**容许它带 phase 维度**：每个 phase 启动 team 时，team-exec 在 state.md 顶部加一节：

```markdown
# CCG Team Execution State

**Plan**: .claude/team-plan/user-api-20260503-1000.md
**Phase**: 2 / 4 (user-auth-system roadmap)
**Team**: user-api-team
**Started**: 2026-05-03 10:00
...

## Wave 1 (completed)
- [x] T1: ...
```

新增的 `**Phase**:` 行让用户从 state.md 一眼看出当前在 milestone 的哪一步；这是约定，不强制——老 team-exec 不写 Phase 行也兼容。

**写入时机分工**：

| 文件 | 写入者 | 写入时机 |
|------|--------|---------|
| `.ccg/roadmap.md` | autonomous | 每个 phase 进入 in_progress / completed / failed / skipped 时 |
| `.ccg/state.md` | team-exec | 每个 wave 结束时（与 W2c 行为完全一致） |
| `.claude/team-plan/<task>-*.md` | team 各阶段 teammate | PRD / 蓝图 / 计划 / 报告产出时 |

---

## 退出报告格式

EXEC_QUEUE 全部跑完后（无论全成功还是含失败/跳过），输出 milestone 收尾报告到主对话，**并将精简版追加到 `.ccg/roadmap.md` 末尾的 `## Milestone Summary` 节**。

```markdown
# 🏁 Milestone Summary: <project name>

**Started**: 2026-05-01 09:00
**Ended**: 2026-05-03 18:42
**Total Phases**: 4
**Mode**: auto

## 执行结果
| Phase | 名称 | 状态 | 耗时 | 产物 |
|-------|------|------|------|------|
| 1 | 数据库 schema | ✅ completed | 2h20 | prisma/schema.prisma + 3 迁移 |
| 2 | user API | ✅ completed | 3h15 | src/api/auth/* (8 文件) |
| 3 | 前端登录页 | ⚠️ completed (1 Critical 接受) | 4h10 | src/pages/Login.tsx + Signup.tsx |
| 4 | SSO 集成 | ❌ failed | 1h30 | (无完整产出) |

## 经验提炼
- Phase 2 的 token 刷新机制设计值得复用到 Phase 4（被忽略）
- Phase 3 灰区：表单校验位置（前端/后端/双端），用户选了双端
- Phase 4 失败原因：Google OAuth callback URL 配置缺失，需 IT 协助

## 未解决项
- [Critical-3.2] Login 表单未做 rate limit（接受到下一 milestone）
- [Failure-4] Google SSO 集成阻塞，等 IT 提供 client_id

## 推荐下一步
1. 处理 Phase 4 阻塞后重跑：`/ccg:autonomous --only 4`
2. 创建新 milestone 处理 rate limit 项
3. 提交 Phase 1-3 产出：`/ccg:commit`

## 产出物索引
- PRD: .claude/team-plan/*-prd.md (4 份)
- 蓝图: .claude/team-plan/*-blueprint.md (4 份)
- 计划: .claude/team-plan/*-plan.md (4 份)
- 报告: .claude/team-plan/*-report.md (4 份)
- 代码变更: 见各 report 的"变更摘要"节
```

---

## 与 OpenSpec 协同

如果项目使用 OpenSpec，roadmap.md 的 phase 可以引用 OPSX proposal id：

```markdown
## Phase 4: SSO 集成 (opsx://add-google-sso)
- **Goal**: 接入 Google OAuth 2.0
- **Depends on**: Phase 3
```

autonomous 检测到 `opsx://` 前缀时：
- 不调 `/ccg:team`，改调 `/ccg:spec-impl <change-id>`
- 由 spec-impl 负责完整的 Plan → Impl → Review → Archive 流程
- spec-impl 完成后写入 OpenSpec 的归档目录，autonomous 仍在 roadmap.md 写 `completed` + `Plan: openspec/archive/<change-id>/`
- Critical 处理与失败暂停逻辑与普通 phase 一致

混合 milestone（有 phase 走 team、有 phase 走 spec-impl）受支持，autonomous 按 phase 标题里有无 `opsx://` 自动路由。

---

## Exit Criteria

- [ ] `.ccg/roadmap.md` 已存在且解析无误
- [ ] EXEC_QUEUE 中所有 phase 已尝试执行（completed / failed / skipped 状态明确）
- [ ] 每个 phase 都通过 `/ccg:team` 或 `/ccg:spec-impl` 间接执行，autonomous 自身未直接 spawn Architect/Dev/QA/Reviewer
- [ ] roadmap.md 反映最终各 phase 状态
- [ ] 发生 blocker 时已通过 `AskUserQuestion` 暂停并记录用户决策
- [ ] Milestone Summary 已输出到主对话并追加到 roadmap.md
- [ ] 所有 team / state.md 由各 phase 内的 team-exec 自行清理，autonomous 不越权

<!-- CCG:AUTONOMOUS:END -->
