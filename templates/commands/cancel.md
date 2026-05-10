---
description: '中止活跃后台任务：先写 cancel.flag（cooperative）→ grace 5s → kill-tree 强制'
argument-hint: "<job-id> [--force]"
allowed-tools:
  - Read
  - Write
  - Bash
---

# Cancel - 中止活跃后台任务

写一个**协作式**取消信号到 `.context/jobs/<job-id>/cancel.flag`，并在 grace period（默认 5s）后**强制 kill 进程树**作为兜底。后台子任务（codex:codex-rescue / phase-runner / autonomous loop）每次推进步骤前轮询 cancel.flag，发现存在则清理并退出。卡在 OS-level 不可中断 syscall 的子进程由 kill-tree fallback 兜底。

> ⚠️ 当前模式为 **协作 + 强制兜底**（supervisor + cli_pid + process_group_id）。如果 phase-runner 已通过 `ccg-phase-runner-launcher.mjs` 启动，state.json 会含 `cli_pid`，本命令在 grace period 后调用 kill-tree（POSIX：`kill -TERM -<pgid>` → `kill -KILL`；Windows：`taskkill /T /F /PID`）。

## 使用方法

```bash
/ccg:cancel <job-id>          # 默认：cancel.flag + 5s grace + kill-tree
/ccg:cancel <job-id> --force  # 跳过 grace，立即 kill-tree（紧急停机）
```

## 工作流程

### Step 1：校验 job 存在 + 状态可取消

1. Read `.context/jobs/<job-id>/state.json`
2. 不存在 → "Job not found: <id>，run /ccg:status to list all jobs"，退出
3. `status` ∈ `{done, failed, canceled}` → "Job <id> already <status>，nothing to cancel"，退出（**不报错**）
4. `status` ∈ `{queued, running}` → 进入 Step 2

### Step 2：写 cancel.flag + 更新 state.json

1. 写文件 `.context/jobs/<job-id>/cancel.flag`，内容：

   ```
   cancel-requested-at: <ISO timestamp>
   requested-by: /ccg:cancel
   ```

   `src/utils/jobs.ts` 的 `requestCancel` 走 `atomicWriteFileSync`（temp + rename），cancel.flag 永远不会半写。

2. 更新 state.json：把 `cancel_requested` 设为 `true`（**status 仍保持 running/queued** —— 真实 status 转 `canceled` 由子任务退出时自己写或由 Step 4 兜底写）

### Step 3：grace period（默认 5s，`--force` 跳过）

观察子任务是否自己退出：每秒 Read `state.json.status`，如果在 5s 内变成 `canceled` / `failed` / `done` → 跳过 Step 4，输出"协作取消生效"。

### Step 4：kill-tree fallback（grace 超时后）

读取 state.json 中的 `cli_pid` + `process_group_id`：

- **没有 cli_pid**（legacy job 或非 launcher 路径）：保持原有协作行为，提醒用户"无 PID 记录，请手动 `kill -9` 残留进程"。
- **有 cli_pid**：用 Bash 执行 kill-tree：
  - **POSIX**: 优先 `kill -TERM -<pgid>` 走进程组（含 nested plugin 子进程）；失败回退 `kill -TERM <cli_pid>`；再 grace 1s 后 `kill -KILL`。
  - **Windows**: `taskkill /T /F /PID <cli_pid>` 杀整棵进程树（含 nested plugin）。

  生成的 Bash（示例）：

  ```bash
  # POSIX
  kill -TERM -42 2>/dev/null || kill -TERM 42 2>/dev/null
  sleep 1
  kill -0 42 2>/dev/null && (kill -KILL -42 2>/dev/null || kill -KILL 42 2>/dev/null)

  # Windows
  taskkill /T /F /PID 1234
  ```

- 写终态 state.json：`status=canceled`，`summary="canceled by /ccg:cancel + kill-tree fallback"`。

### Step 5：通知用户

输出（协作取消生效）：

```
✓ Job <id> canceled cooperatively (status: canceled, no kill-tree needed)
```

输出（kill-tree 兜底）：

```
⚠ Cooperative grace period (5s) elapsed without exit.
✓ Issued kill-tree on cli_pid=<N> (pgid=<M>): step1=SIGTERM, step2=SIGKILL after 1s
Status: canceled (forced via kill-tree)
```

## 严格约束

- ✅ **协作优先**——总是先写 cancel.flag 给子进程自己退的机会，避免半写文件
- ✅ **强制兜底**（supervised job）——grace 后 kill-tree 防 hang 死循环
- ✅ 幂等——多次调用不报错，不重写 flag
- ✅ 已终态的 job 调用 cancel 也不报错（友好降级）
- ✅ atomic write——cancel.flag 永远不会半写
- ❌ **不要**直接把 status 改成 `canceled`——会与子任务退出时的写入产生竞态（除非 kill-tree 生效后）
- ❌ **不要**删除 `.context/jobs/<id>/` 目录——历史可观测性必须保留

## 子任务侧契约（开发者参考）

后台子任务必须周期性检查 cancel.flag 才能让协作路径生效（避免 kill-tree 兜底）。最小契约：

```typescript
import { isCancelRequested, writeJobState, getJob } from '~/.claude/.ccg/utils/jobs'

// 每个推进步骤前
if (isCancelRequested(workdir, jobId)) {
  const cur = getJob(workdir, jobId)!
  writeJobState(workdir, { ...cur, status: 'canceled', summary: 'canceled by user' })
  // optional: write result.md with "STATUS: canceled\nNOTES: aborted at <step>"
  process.exit(0)
}
```

phase-runner / codex:codex-rescue / autonomous loop 全部接入此契约。

## 与其他命令的协作

| 时序 | 命令 | 作用 |
|------|------|------|
| t0 | `/ccg:autonomous` | spawn launcher + child；写 state.json (running, cli_pid, pgid) |
| t1 | `/ccg:status` | 用户看到 running 太久 |
| t2 | `/ccg:cancel <id>` | **本命令**——写 cancel.flag |
| t3a | (子任务下次轮询) | isCancelRequested → 自己写 state.json (canceled) |
| t3b | (grace 5s 超时, t3a 未发生) | 本命令 kill-tree → 写 state.json (canceled, forced) |
| t4 | `/ccg:result <id>` | 看到 canceled 摘要 |

## 实现锚点

- `src/utils/jobs.ts` 的 `requestCancel` 是后端真相源（atomic write）
- `src/utils/process-tree.ts` 的 `killProcessTree` 是 kill-tree 真相源（POSIX pgid + Windows taskkill）
- `templates/scripts/ccg-phase-runner-launcher.mjs` 的 launcher 是 cli_pid / pgid 的写入者
- 失败模式：见 `src/utils/__tests__/jobs.test.ts`（atomic write）+ `processTree.test.ts`（kill-tree 13 种 failure mode 覆盖）
