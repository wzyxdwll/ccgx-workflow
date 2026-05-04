---
description: '后台任务观测：列出所有 job / 单查 job 详情 / 阻塞等待 job 完成（v4.0 异步三件套）'
argument-hint: "[<job-id>] [--wait --timeout-ms <ms>]"
allowed-tools:
  - Read
  - Bash
  - Glob
---

# Status - 后台任务观测

CCG v4.0 起，长任务（codex:codex-rescue / gemini:rescue / phase-runner / autonomous）以**后台 job** 形式运行。状态文件落盘在 `<workdir>/.context/jobs/<job-id>/`：

| 文件 | 内容 |
|------|------|
| `state.json` | 机器可读状态（task_id / kind / status / phase_id / started_at / last_update / summary / cancel_requested） |
| `result.md`  | 任务最终输出（≤ 200 token 摘要） |
| `cancel.flag` | 取消请求哨兵（由 `/ccg:cancel` 写入，子任务自检退出） |

`status` 命令是用户**唯一**的后台观测入口。

## 使用方法

```bash
/ccg:status                                  # 列出所有 job（表格视图）
/ccg:status <job-id>                         # 单查某个 job 的完整详情
/ccg:status <job-id> --wait --timeout-ms 60000  # 阻塞等待该 job 进入终态
```

## 工作流程

### 模式 A：无参数 → 列表视图

1. 检查 `.context/jobs/` 是否存在；不存在则输出"暂无后台任务"
2. 用 `node` 调 `listJobs(workdir)` 等价逻辑读取所有 job：

   ```bash
   ls -d .context/jobs/*/ 2>/dev/null
   ```

   对每个目录读 `state.json`，按 `started_at` DESC 排序

3. 输出表格（每行一个 job）：

   ```
   JOB-ID                          KIND           STATUS    PHASE                ELAPSED   SUMMARY
   ─────────────────────────────── ────────────── ───────── ──────────────────── ───────── ────────────────────────────
   phase-07-async-triplet-1730    codex-rescue   running   phase-07-async       3m 12s    spawning rescue + writing tests
   ```

   ELAPSED = `now - started_at`（活跃 job）或 `last_update - started_at`（终态 job）
   SUMMARY 截断到 60 字符

4. 如有 `cancel_requested=true` 但 status 还是 `running`，标 `(cancel pending)`

### 模式 B：单 job 详情（`/ccg:status <job-id>`）

1. Read `.context/jobs/<job-id>/state.json`，pretty-print 全部字段
2. 如存在 `result.md`，附在末尾打印
3. 如存在 `cancel.flag`，打印 "⚠ Cancel requested at: <flag-content-first-line>"
4. 不存在 → "Job not found: <id>，run /ccg:status to list all jobs"

### 模式 C：阻塞等待（`--wait --timeout-ms <ms>`）

1. 解析 `--timeout-ms`（默认 60_000ms，上限 600_000ms）
2. 每 2 秒轮询 `state.json`，检查 `status` 是否 ∈ `{done, failed, canceled}`
3. 进入终态 → 立即输出模式 B 的详情视图
4. 超时 → 输出 "⏱ Timeout after <X>s — job still in <status> state，retry with longer --timeout-ms 或 /ccg:cancel <id>"
5. 超时**不视为失败**——退出码 0，留给用户决策（cancel / 继续等 / 忽略）

## 严格约束

- ✅ **只读**——本命令绝不修改 `state.json` / `result.md` / `cancel.flag`
- ✅ 列表视图按 `started_at` DESC（最新优先）
- ✅ Schema 校验缺字段时跳过该 job 但不崩溃，列表末尾输出 "⚠ N corrupt jobs skipped (run /ccg:status <id> 直查)"
- ❌ 不轮询 `result.md` 内容；判定终态只看 `state.json.status`
- ❌ 不调用 `pnpm test` / `git status` 等副作用命令
- ❌ 阻塞等待**不要 sleep > 600s**

## 与其他命令的协作

| 命令 | 作用 |
|------|------|
| `/ccg:result <id>` | job 终态后，取走 `result.md` 摘要回主线 |
| `/ccg:cancel <id>` | 主动中止活跃 job，写 cancel.flag |
| `/ccg:autonomous` / `/ccg:phase-runner` | 启动 job，写 `state.json` 初始记录 |

## 参考实现

- `src/utils/jobs.ts` 的 `listJobs / getJob` 是后端真相源
- 当前命令模板用 Bash + Read 做出等价行为；如要写 TS 程序消费，import `~/.claude/.ccg/dist/...`（v4.x 暂不暴露 lib）
