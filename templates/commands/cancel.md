---
description: '中止活跃后台任务：写 .context/jobs/<id>/cancel.flag，子任务下次轮询时自检退出（v4.0 异步三件套）'
argument-hint: "<job-id>"
allowed-tools:
  - Read
  - Write
  - Bash
---

# Cancel - 中止活跃后台任务

写一个**协作式**取消信号到 `.context/jobs/<job-id>/cancel.flag`。后台子任务（codex:codex-rescue / phase-runner / autonomous loop）每次推进步骤前轮询此文件，发现存在则清理并退出，把 `state.json.status` 改为 `canceled`。

> ⚠️ 这是**协作式**取消而非强制 kill。如果子任务卡在不可中断的 syscall（如远程 LLM 推理），cancel.flag 要等本次推理返回后才生效。需要立即停掉的极端情况，自行 `kill -9` 后用 `/ccg:status` 检查残留 job 目录。

## 使用方法

```bash
/ccg:cancel <job-id>
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

2. 更新 state.json：把 `cancel_requested` 设为 `true`（**status 仍保持 running/queued** —— 真实 status 转 `canceled` 由子任务退出时自己写）

### Step 3：通知用户

输出：

```
✓ Cancel signal sent to job <id>.
Status: <current-status> (cancel_requested=true)

Child task will pick up the flag on its next polling tick (typically < 30s for codex:codex-rescue / phase-runner).
Run /ccg:status <id> --wait --timeout-ms 60000 to confirm transition to 'canceled'.
```

### Step 4：可选幂等保护

如果 `cancel.flag` 已存在（用户多次调用），直接输出：

```
ℹ Cancel was already requested at: <existing-flag-content>
Run /ccg:status <id> 查看当前状态。
```

不报错，不重写 flag（避免覆盖更早的请求时间戳）。

## 严格约束

- ✅ **协作式取消**——只写 flag + 翻 cancel_requested，不强制改 status
- ✅ 幂等——多次调用不报错，不重写 flag
- ✅ 已终态的 job 调用 cancel 也不报错（友好降级）
- ❌ **不要** `kill` 任何进程——CCG 不持有子进程 PID
- ❌ **不要**直接把 status 改成 `canceled`——会与子任务退出时的写入产生竞态
- ❌ **不要**删除 `.context/jobs/<id>/` 目录——历史可观测性必须保留

## 子任务侧契约（开发者参考）

后台子任务必须周期性检查 cancel.flag 才能让本命令生效。最小契约：

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

phase-runner / codex:codex-rescue / autonomous loop 在 v4.0 Phase 7 落地后会逐步接入此契约。

## 与其他命令的协作

| 时序 | 命令 | 作用 |
|------|------|------|
| t0 | `/ccg:autonomous` | spawn job，写 state.json (running) |
| t1 | `/ccg:status` | 用户看到 running 太久 |
| t2 | `/ccg:cancel <id>` | **本命令**——写 cancel.flag |
| t3 | (子任务下次轮询) | isCancelRequested → 写 state.json (canceled) |
| t4 | `/ccg:result <id>` | 看到 canceled 摘要 |

## 实现锚点

- `src/utils/jobs.ts` 的 `requestCancel` 是后端真相源
- 失败模式：见 `src/utils/__tests__/jobs.test.ts` 中 `requestCancel` 用例
