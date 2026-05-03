---
name: ccg:verify-work
description: 会话式 UAT 工作流 - UAT.md 状态文件 + cold-start smoke 自动注入 + 自动 diagnose-plan-fix 收敛环（v4.0 P9）
argument-hint: "[task-id]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - AskUserQuestion
  - Agent
---

# Verify Work — 会话式 UAT 工作流（v4.0 Phase 9）

v3.0 的 verify-work 是纯**编排器**——按变更性质开 verify-{module,security,quality,change} 子门，跑完聚合报告。但它**没法做真正的 UAT**：

1. 用户得自己拿着报告人肉对照"这事儿到底验没验过"；
2. `/clear` 后所有上下文丢失，UAT 进度归零；
3. 只看代码不跑冷启动——race condition / silent seed failure / 缺环境变量在生产才暴露；
4. 用户报 issue 后没有自动收敛环——靠用户手动来回贴报告。

v4.0 把 verify-work 改造成**有状态的会话工作流**：

- **UAT.md frontmatter 状态文件**：跨 `/clear` 持久化，下次进入命令自动 resume；
- **逐项核对**（show expected → ask if matches）：每条期望行为都明示问，不让模糊滑过；
- **Cold-start smoke 自动注入**：扫 git diff 命中关键路径即注入"杀进程 → 清临时态 → 冷启动 → 主查询返回数据"测试；
- **自动 diagnose → planner --gaps → plan-checker 收敛环**（max 3 轮）：用户报 issue 立即触发，无需手动调度。

**与 v3.0 的关系**：v3.0 的多门聚合不删，迁移为 Step 2（verify-* 子门作为静态扫描）。v4.0 的会话循环裹在外层（Step 0/1/3/4/5）。

---

## 使用方法

```bash
/ccg:verify-work                      # 自动按 git diff / .context/state.md 推断 task-id
/ccg:verify-work phase-09-uat-session # 显式指定 task-id
```

**第一次跑** → 新建 `.context/uat/<task-id>/UAT.md` 状态文件。
**再次跑** → Read 状态文件，从 `pending_checks` 头部继续问。

---

## UAT.md frontmatter schema（跨会话状态文件）

```yaml
---
task_id: phase-09-uat-session
started_at: 2026-05-03T22:47:00Z
cold_start_injected: true
gaps:
  - { symptom: "list empty after refresh", severity: high, status: open, loop_count: 1, plan_ref: ".context/uat/<id>/fix-G-01.md" }
completed_checks:
  - { id: C1, expected: "login button visible", matched: true }
  - { id: C2, expected: "list shows 5 items", matched: false, gap_ref: G-01 }
pending_checks:
  - { id: C3, expected: "logout works" }
---
```

字段约定：

| 字段 | 类型 | 含义 |
|------|------|------|
| `task_id` | string | 与 `.context/uat/<task-id>/` 路径同源；缺失 = 文件损坏，重建 |
| `started_at` | ISO 8601 | 起始时间，用于跨会话审计 |
| `cold_start_injected` | bool | 防止重复注入 |
| `gaps[]` | list | 用户报告的偏离 / 失败，含 `symptom / severity / status / loop_count / plan_ref` |
| `completed_checks[]` | list | 已问过的 check（matched=true/false）|
| `pending_checks[]` | list | 待问的 check（顺序就是问的顺序）|

`severity ∈ {critical, high, medium, low}`，`status ∈ {open, fixed, deferred}`。

**调用方算法以 `src/utils/uat-session.ts` 中的 `parseUatFrontmatter` / `renderUatFrontmatter` 为权威。** Node 脚本可直接 `import`，LLM 在会话中按本表手写也行——schema 一致即可。

---

## 工作流程（lifecycle）

### Step 0 — Resume 检测

```bash
TASK_ID="${1:-$(detect-task-id)}"  # detect-task-id 见下
UAT_DIR=".context/uat/${TASK_ID}"
UAT_FILE="${UAT_DIR}/UAT.md"
```

`detect-task-id` 优先级：
1. 命令参数 `$ARGUMENTS`（用户显式给）
2. `.context/state.md` 当前 phase 字段
3. `git rev-parse --abbrev-ref HEAD` 分支名（取最后一段）
4. 用 `verify-work-$(date +%Y%m%d-%H%M)` 兜底

```bash
if [ -f "$UAT_FILE" ]; then
  echo "Resume mode: existing UAT session for ${TASK_ID}"
else
  mkdir -p "$UAT_DIR"
  # 新建 UAT.md（Step 1 完成后写入）
fi
```

**Resume 时**：
- Read UAT.md → 解析 frontmatter
- 显示当前进度：`X/Y checks done, Z gaps open`
- 跳到 Step 4，继续问 `pending_checks` 头部

**新建时**：进 Step 1。

### Step 1 — 收集 expected behaviors（生成 pending_checks）

读取以下来源（按可用性逐个 fallback）：

| 来源 | 字段 |
|------|------|
| `.ccg/roadmap.md` 当前 phase | `acceptance` 段每条独立 bullet |
| OpenSpec proposal `proposal.md` | "Success criteria" / "Acceptance" |
| PRD / SPEC.md | 用户可观察行为 |
| git commit message 主语 | 主语转 expected（兜底） |

每条转一个 `UatCheck`：

```yaml
{ id: C<n>, expected: "<人类可观察行为>" }
```

**只允许"用户可观察行为"**——禁止 "bcrypt installed" / "function exists"，必须是 "user can reset password" / "list shows correct count"。

### Step 2 — 静态门 + cold-start smoke 注入

#### 2a. 静态扫描（v3.0 多门保留）

按 git diff 性质开门（v3.0 决策矩阵）：

| 变更性质 | 触发判据 | 门组 |
|---------|---------|------|
| 新模块 | `git status` 显示新增目录 | verify-module → verify-security → verify-quality |
| 小改动 | diff ≤ 30 行 | verify-quality → verify-change |
| 常规改动 | diff 30-200 行 | verify-change → verify-quality → verifier agent |
| 安全敏感 | 触及 auth/crypto/input/secret/sql 关键字 | verify-security → verify-change → verifier agent |
| 重构 | 含 `refactor:` commit | verify-change → verify-quality → verify-security |

每门返回结构化 `{ gate, status, counts, top_findings, artifacts }`，**FAIL with critical** 立即 short-circuit 用户先修，进 Step 5 前不继续问 UAT。

#### 2b. Cold-start smoke 自动注入

```bash
CHANGED=$(git diff --name-only HEAD)
```

按 `src/utils/uat-session.ts:shouldInjectColdStart()` 等价规则扫：

```
触发正则（任一命中即注入）：
- (^|/)server\.(ts|js|mjs|cjs|tsx)$
- (^|/)app\.(ts|js|mjs|cjs|tsx)$
- (^|/)main\.(ts|js|mjs|cjs|tsx|go|py|rs)$
- (^|/)bootstrap\.(ts|js|mjs|cjs)$
- (^|/)startup[._-]?[a-z]*
- (^|/)database/
- (^|/)db/
- (^|/)migrations?/
- (^|/)seeds?/
- (^|/)docker-compose[a-z0-9._-]*\.ya?ml$
- (^|/)Dockerfile[a-z0-9._-]*$
- (^|/)\.env(\..+)?$
- (^|/)k8s/
- (^|/)kubernetes/
```

命中即把以下模板**作为 C0 插入 pending_checks 头部**（先问 cold-start，再问其他 expected）：

```markdown
### Cold-Start Smoke Test (auto-injected)

**Trigger**: changes touched cold-start critical paths: `<file-list>`

**Why this matters**: Race conditions / silent seed failures / missing env vars
only surface on a fresh boot. Skipping this leaves prod cold-start bugs unverified.

**Steps**:
1. Kill any running process: `pkill -f <pattern>; docker compose down -v`
2. Clear ephemeral state (caches/sockets/lock files; KEEP volumes/data unless required)
3. Cold-boot from scratch: `pnpm dev` / `docker compose up -d` / `make run`
4. Issue the primary query — expected non-empty payload, status 200, no 5xx/timeout
```

更新 `cold_start_injected: true`，禁止重复注入。

### Step 3 — Persist UAT.md（首次写入）

Render frontmatter（按上文 schema）+ 主体段："## Session Log"（每条 check 的 Q&A 时间戳追加于此）。Write 到 `${UAT_DIR}/UAT.md`。

### Step 4 — 会话式 UAT（show expected → ask if matches）

主循环（每轮处理 pending_checks 头部一条）：

```
1. 取 pending_checks[0]
2. 向用户呈现：
   "Check ${id}: ${expected}
    Did this behave as expected? (y / n / skip / abort)"
   使用 AskUserQuestion 工具
3. 收到回答：
   - y → completed_checks.push({ ...check, matched: true })
   - n → 进入 Step 5（自动 diagnose）
   - skip → completed_checks.push({ ...check, matched: undefined, note: "skipped" })
   - abort → 写报告 + 退出
4. 写回 UAT.md（每答一条都持久化，避免会话中断丢进度）
5. pending_checks.shift(); 回到 1
```

所有 pending 答完 → 进 Step 6。

### Step 5 — 自动 diagnose → planner --gaps → plan-checker 收敛环

用户答 `n` 时：

#### 5a. 推断严重度 + append gap

按 `inferIssueSeverity(report)` 等价规则：critical → high → medium → low 顺序扫关键词，命中即定级，不命中默认 medium。

```yaml
gaps:
  - { symptom: "<用户原话>", severity: <inferred>, status: open, loop_count: 0 }
```

#### 5b. 并行 spawn diagnose

```
Agent(subagent_type="ccg:debug", task=<symptom>, run_in_background=true)
```

debug agent 找根因，输出 `.context/uat/<task-id>/diagnose-G-<n>.md`。

#### 5c. spawn planner --gaps

```
Agent(subagent_type="planner", mode="--gaps", input=diagnose_report)
```

输出修复 plan：`.context/uat/<task-id>/fix-G-<n>.md`。

#### 5d. spawn plan-checker（复用 Phase 6 helper）

```
Agent(subagent_type="plan-checker", plan=<fix-plan>)
```

返回 `{ findings, hasBlocker, counts }`。

#### 5e. max-3-loop 收敛

```
loop_count += 1
if not hasBlocker:
  - gap.status = fixed; gap.plan_ref = <fix-plan-path>
  - apply fix（spawn codex/gemini-rescue 或 user 手改）
  - 回到 Step 4 主循环（继续下一条 pending_check）
elif loop_count >= 3:
  - escalate to user via AskUserQuestion:
    "Convergence loop exhausted (3/3). Choose:
     (a) force-accept partial fix
     (b) provide guidance & retry one more loop
     (c) abort and roll back this gap"
else:
  - 把 plan-checker findings 喂回 planner --gaps，回到 5c
```

**3 轮上限是硬规约**——与 plan-review-convergence / code-review-fix 一致。

### Step 6 — 终态报告

所有 check 已答（含 skip）+ 所有 gap 状态 ∈ {fixed, deferred}：

```markdown
# Verify Work Final Report — <task-id>

## Summary
- Checks: <pass>/<total> matched, <skip> skipped
- Gaps: <fixed>/<total> fixed, <deferred> deferred, <open> still open
- Cold-start smoke: <PASS|FAIL|N/A>
- Static gates: <verify-module|security|quality|change> 各自 status
- Convergence loops triggered: <n>

## 综合判决
| 维度 | 状态 |
|------|------|
| 阻断项 | <n> |
| 告警项 | <n> |
| 修复优先级 | <列表> |

**建议**: ✅ 可交付 | ⚠ 建议处理 N 项告警 | ❌ 阻断项需先修
```

报告写到 `.context/uat/<task-id>/REPORT.md`，UAT.md 保留作为审计 trail。

---

## 与 .context / roadmap 集成

- 报告 + UAT.md 落 `.context/uat/<task-id>/`，不是临时目录
- `.context/state.md` 追加引用：`UAT: see uat/<task-id>/REPORT.md`
- 不修改 `.ccg/roadmap.md`（autonomous 主线管）

## 与各 verify-* skill 的契约

| Skill | 在本工作流的角色 |
|-------|-----------------|
| verify-module | Step 2a 静态门，新模块场景必跑 |
| verify-security | Step 2a 静态门，安全敏感场景必跑 |
| verify-quality | Step 2a 静态门，30+ 行变更必跑 |
| verify-change | Step 2a 静态门，常规改动必跑 |
| verifier agent | Step 2a 末尾兜底，做需求矩阵反向溯源（v4 Phase 8 加 Level 4 数据流） |

## 与 v4.0 helper 的契约

| Helper | 用途 |
|--------|------|
| `src/utils/uat-session.ts:shouldInjectColdStart` | Step 2b 触发判定 |
| `src/utils/uat-session.ts:buildColdStartSmokeTemplate` | Step 2b 测试模板 |
| `src/utils/uat-session.ts:parseUatFrontmatter` / `renderUatFrontmatter` | UAT.md 状态文件 IO |
| `src/utils/uat-session.ts:inferIssueSeverity` | Step 5a 严重度推断 |
| `src/utils/uat-session.ts:decideConvergence` | Step 5e max-3-loop 判定 |
| `src/utils/plan-checker.ts:runPlanChecker` | Step 5d 修复计划静态校验 |

## 硬性约束

- **不重复实现已有 skill 的检测逻辑**：Step 2a 完全复用 verify-* skill
- **UAT.md 必须每条 check 答完即持久化**：避免 `/clear` 丢进度
- **Cold-start smoke 不重复注入**：`cold_start_injected: true` 后跳过
- **3 轮收敛上限严格执行**：不允许"再来一轮"，必须升级用户三选
- **失败 short-circuit**：Step 2a 任一门 FAIL with critical 立即停 UAT 询问
- **不修改 `.ccg/roadmap.md` / `.ccg-research/` / `templates/scripts/invoke-model.mjs`**
