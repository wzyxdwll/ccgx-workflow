---
description: '取后台任务最终结果：读取 .context/jobs/<id>/result.md，输出 ≤ 200 token 摘要'
argument-hint: "<job-id>"
allowed-tools:
  - Read
  - Bash
---

# Result - 取后台任务最终结果

`/ccg:status` 看到 job 进入 `done` / `failed` / `canceled` 后，用本命令把 `.context/jobs/<id>/result.md` 内容拉回主线。

result.md 的写入是后台子任务（codex:codex-rescue / phase-runner）退出前的最后动作，约定 ≤ 200 token，包含：

```
STATUS: completed | partial | failed | canceled
COMMIT: <sha7> | none
TESTS: <pass>/<total> passed (delta +<n> from <baseline>)
TYPECHECK: pass | fail
HANDOFF_TAKEN: [git_commit, test_run, ...]
CONTEXT_DELTA: <一句话>
NOTES: <一行>
```

## 使用方法

```bash
/ccg:result <job-id>          # 取该 job 的最终摘要
```

## 工作流程

### Step 1：校验 job 状态

1. Read `.context/jobs/<job-id>/state.json`
2. 不存在 → 输出 "Job not found: <id>，run /ccg:status to list all jobs"，退出
3. `status` ∈ `{queued, running}` → 输出：

   ```
   ⏳ Job <id> still <status>
   Run /ccg:status <id> --wait --timeout-ms 60000 to wait, or /ccg:cancel <id> to abort.
   ```

   并退出（不强制等待）

4. `status` ∈ `{done, failed, canceled}` → 进入 Step 2

### Step 2：读取 result.md

1. Read `.context/jobs/<job-id>/result.md`
2. 不存在但 status 已是终态 → 输出：

   ```
   ⚠ Job <id> reached <status> but result.md is missing.
   Possible cause: child task crashed before writing result. Inspect .context/jobs/<id>/state.json for last summary.
   Last state summary: <state.summary>
   ```

3. 存在 → 进入 Step 3

### Step 3：输出摘要 + 元信息

1. 优先**直接打印** result.md 原文（已是 ≤ 200 token，无需 Claude 重新摘要）
2. 末尾追加来自 state.json 的元信息：

   ```
   ──── Job metadata ────
   Job-ID       : <id>
   Kind         : <kind>
   Phase        : <phase_id or '-'>
   Started      : <started_at>
   Ended        : <last_update>  (status=<status>)
   Duration     : <last_update - started_at> 计算后人类可读
   ```

3. 若 status=failed/canceled，附加建议：
   - failed → "建议：/ccg:status <id> 查看 state.summary，或重跑产生该 job 的命令"
   - canceled → "已用户主动取消，若需重启请重新触发原命令"

## 严格约束

- ✅ **只读**——绝不修改任何文件
- ✅ 不调用 LLM 二次摘要——result.md 已经压到 200 token，再压会丢失信号
- ✅ 缺 result.md 时给出 actionable 提示（last_summary / 重跑建议）
- ❌ 不在 status=running 时阻塞等待——这是 `/ccg:status --wait` 的职责
- ❌ 不修改 state.json（即使 result.md 缺失）

## 与其他命令的协作

```
/ccg:autonomous → spawn phase-runner job
                ↓
            writes .context/jobs/<id>/state.json (running)
                ↓ (any time)
            user: /ccg:status              ← 看进度
            user: /ccg:status <id> --wait  ← 阻塞等终态
                ↓ (eventually)
            child writes result.md + state.json (done)
                ↓
            user: /ccg:result <id>         ← 取 200 token 摘要
```

## 实现锚点

- `src/utils/jobs.ts` 的 `getJob / readJobResult` 是后端真相源
- result.md 的 200 token 约定与 phase-runner 主线返回摘要约定一致（见 `templates/commands/agents/phase-runner.md` Phase G）
