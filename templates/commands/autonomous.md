---
name: ccg:autonomous
description: 跨 phase 自治长跑：roadmap → 多 phase 自动循环 research→plan→exec→review，仅 blocker 暂停
argument-hint: "[--from N] [--to N] [--only N] [--interactive] [--offload]"
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

### Step 4: Phase 主循环

**对 EXEC_QUEUE 中每个 phase 顺序执行**：

#### 4.1 准备 phase

- 在 `.ccg/roadmap.md` 中将该 phase 状态改为 `in_progress`，写入 `Started: <时间戳>`。
- 用 TodoWrite 维护一个跨 phase 进度列表（每 phase 一项），便于用户随时看进度。
- 检查依赖：所有 `Depends on` 列出的 phase 必须为 `completed`，否则进入 **blocker 路径**（Step 5）。

#### 4.2 路由：调 `/ccg:team` / `/ccg:spec-impl` / Plugin Offload

按以下优先级判定（**前序匹配后短路**）：

1. **该 phase 描述含 `opsx://` 引用** → 走 OpenSpec 路径，调 `/ccg:spec-impl` 并传入 change_id
2. **重型 phase 判定（offload 路径）** → 调 `Agent(subagent_type="codex:rescue")` 在 fresh context 后台执行
3. **默认** → 走 Agent Teams 路径，调 `/ccg:team <phase goal>`

##### 重型 phase 判定（决定走第 2 路）

**显式触发**：`--offload` flag 提供（强制走 plugin offload，所有 phase 都走）。

**自动触发**（满足任一即可）：
- phase goal 描述含关键词：`重构 / 迁移 / 全量改 / refactor / migrate / rewrite`
- phase 预估涉及 > 20 个文件（通过 phase 标题或备注里的"涉及 N 文件"提示）
- 上一个 phase 的 plan 文件 > 800 行（重型 phase 的强信号，说明 PRD 复杂）
- 用户在 roadmap.md 里手动标 `[offload]` tag（例 `## Phase 3: 微服务拆分 [offload] (pending)`）

**Plugin offload 调用方式**：

```
Agent({
  subagent_type: "codex:rescue",
  description: "Phase <N> offload",
  prompt: `--background --write

请完整执行以下 phase 的 research → plan → implementation → test 全流程：

Phase <N>: <phase goal>
Depends on: <已完成 phase 的产物索引>

工作目录：<WORKDIR>
本 phase 的 PRD/约束（如有）：<roadmap.md 里的 phase 描述全文>

完成时请输出结构化报告：
1. 变更文件清单
2. Critical/Major 问题清单（如有）
3. 测试运行结果摘要
4. 是否需要主线介入决策（灰区）

不要修改 .ccg/roadmap.md（autonomous 主线管），只产出代码 + 报告到 .claude/team-plan/<phase-id>-offload-report.md
`
})
```

收到 codex:rescue 返回的 task_id 后，主线**不阻塞等待**，进入 4.3 状态轮询循环。

**降级**：若用户未装 `codex@openai-codex` plugin（`Agent(codex:rescue)` 调用失败），输出告警 + 自动 fallback 到第 3 路（普通 `/ccg:team`），并在 `.ccg/roadmap.md` 该 phase 备注 `Note: offload requested but codex plugin missing, fell back to team`。

#### 4.3 监控 phase 内信号

**走 team / spec-impl 路径**（4.2 第 1/3 路）：

- team 会在 `.ccg/state.md` 写 wave-level 任务进度（这是 team-exec 的职责，autonomous 不重写它）。
- team 完成后产出 `.claude/team-plan/<task-id>-report.md`。
- autonomous 读取该 report：
  - **Phase 完成且 Critical = 0** → 进入 4.4 推进
  - **Phase 完成但 Critical > 0**（用户在 team 内选了"接受失败"） → 进入 **blocker 路径**
  - **Phase 失败**（team 异常退出 / 测试不可恢复地失败） → 进入 **blocker 路径**

**走 plugin offload 路径**（4.2 第 2 路）：

- 主线轮询 codex:rescue 任务状态：每 30 秒调一次 `Agent(codex:rescue --status <task_id>)`，读返回的 progress / done / failed
- 主线**不读 stdout 全文**（避免吃 context），只看状态字段；任务 done 时调 `Agent(codex:rescue --result <task_id>)` 取结构化报告摘要
- 用户主对话里看到的：`⏳ Phase <N> 后台运行中（codex:rescue task <id>），已 <耗时>，状态 <进度信息>`，每 1 分钟刷新
- 任务 done 后读 `.claude/team-plan/<phase-id>-offload-report.md`，进入与 team 路径一致的 Critical/Major 判断逻辑
- **用户中途想停**：`AskUserQuestion` 提供选项"停止当前 phase（cancel codex task）/ 继续等"，选停就调 `Agent(codex:rescue --cancel <task_id>)`
- offload 路径**不写** `.ccg/state.md`（state.md 是 team-exec 的私域），只在 roadmap.md 该 phase 备注 `Mode: offload (codex:rescue task <id>)`

#### 4.4 Phase 推进

- 在 `.ccg/roadmap.md` 中将该 phase 状态改为 `completed`，写入 `Completed: <时间戳>`、`Outcome: <一句话总结>`、`Plan: .claude/team-plan/<task-id>/`。
- 输出 phase 完成提示：
  ```
  ✅ Phase 2/4: 实现 user API → completed
  → 推进 Phase 3: 前端登录页
  ```
- 进入下一 phase。

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
