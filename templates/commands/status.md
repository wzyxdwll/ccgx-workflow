---
description: '后台任务观测：列表 / 单查 / 阻塞等待 / dashboard / tail 流式 / 卡点检测 / 单 phase cancel'
argument-hint: "[<job-id>] [--wait --timeout-ms <ms>] [--tail <job-id>] [--cancel <phase-id>]"
allowed-tools:
  - Read
  - Bash
  - Glob
---

# Status — 后台任务观测（dashboard + tail）

phase-runner 走 Bash subprocess（`claude -p --output-format stream-json ...`），stream 落盘到 `<workdir>/.context/jobs/<job-id>/progress.jsonl`。失去 sidechain inline UI 后，本命令是用户**唯一**的微观干预入口，必须复刻这四个长跑场景：

| 场景 | 模式 |
|------|------|
| 早上查岗 | `/ccg:status` 无参数 → dashboard |
| 死循环 debug | tail 模式自动叠加 stuck warnings |
| 单 phase cancel | `--cancel <phase-id>` 写 `cancel.flag` + grace-kill |
| 实时 tool call | `--tail <job-id>` 单行覆写 |

## 状态文件契约

| 文件 | 写者 | 内容 |
|------|------|------|
| `state.json` | 主线 / phase-runner | `{ task_id, kind, status, phase_id, started_at, last_update, summary, cancel_requested }` |
| `progress.jsonl` | phase-runner Bash subprocess | stream-json ndjson（D6） |
| `result.md` | phase-runner | ≤ 200 token 摘要 |
| `cancel.flag` | `/ccg:cancel` 或 `/ccg:status --cancel` | 协作退出哨兵 |

## 使用方法

```bash
/ccg:status                                  # 模式 A：列表 / dashboard
/ccg:status <job-id>                         # 模式 B：单查详情
/ccg:status <job-id> --wait --timeout-ms <ms>  # 模式 C：阻塞等待
/ccg:status --tail <job-id>                  # 模式 D：流式 tail
/ccg:status --cancel <phase-id>              # 模式 E：单 phase 协作 cancel
```

## 模式 A：Dashboard（无参数）

聚合所有 active job + 多 phase ASCII 进度条：

```
[JOB: ccg-nightly-run]
Phase 1 (Setup)     [====================] 100%  (4m 12s)  ✅
Phase 2 (Refactor)  [==========>         ]  50%  (2m 35s)  🤖 codex-rescue
Phase 3 (Tests)     [                    ]   0%  (queued)

[JOB: phase-07-async-1730]   ⚠ stuck warning
Phase 7 (Status v2) [============>       ]  60%  (12m 04s) 🛠️  edit_file
```

实施：

1. `Bash`: `ls -d .context/jobs/*/ 2>/dev/null` 找所有 job 目录
2. 对每个 job 读 `state.json`（按 `started_at` DESC）
3. 用 helper 解析 progress（**用 Node 调 ts 帮手** —— 见下方"参考实现"）：
   - 进度估算：phase status `done`=100% / `failed`=100% / `running`=50% / `queued`=0%
   - elapsed = `last_update - started_at`
   - stuck 警告：调 `detectStuck(jsonl)` 看是否非空
4. 用 ASCII-7 安全字符渲染进度条（`=` / `>` / 空格），**禁用 unicode block char**（Windows cmd cp936 不支持）

## 模式 B：单 job 详情

1. Read `.context/jobs/<job-id>/state.json` pretty-print
2. 如存在 `result.md`，附在末尾
3. 如存在 `cancel.flag`，标 `⚠ Cancel requested at: <flag-content-first-line>`
4. 调 `detectStuck(progressJsonl)`，有 warning 显眼输出
5. 不存在 → "Job not found: <id>"

## 模式 C：阻塞等待（`--wait --timeout-ms <ms>`）

1. 解析 `--timeout-ms`（默认 60_000，上限 600_000）
2. 每 2 秒轮询 `state.json.status` ∈ `{done, failed, canceled}`
3. 终态 → 切到模式 B
4. 超时 → "⏱ Timeout after <X>s — job still in <status>，retry with longer --timeout-ms 或 /ccg:cancel <id>"
5. 超时退出码 0（不视为失败）

## 模式 D：Tail 流式

`/ccg:status --tail <job-id>` 持续读 `progress.jsonl`，单行覆写：

```
[Phase 2] 08:15:22 🤖 Analyzing auth logic...
[Phase 2] 08:15:30 🛠️  Running tool: read_file (src/auth/oauth.ts)
[Phase 2] 08:15:32 🔗 Hook: PreToolUse
```

**事件过滤**（renderEvent 内置）：

| 丢弃 | 保留 |
|------|------|
| `system/init` | `tool_use` |
| `content_block_delta`（逐 token） | `hook_started` |
| `message_start/delta/stop` | `assistant`（短摘要 ≤ 80 字） |
| `stream_event` | `rate_limit_event` |
|  | `result/success` `result/error*` |

**渲染契约**：

| 类型 | 输出 |
|------|------|
| `tool_use` | `🛠️  Running tool: <name> (<args summary>)` |
| `assistant` 文本 | `🤖 <第一段非空文本 ≤ 80 字>` |
| `hook_started` | `🔗 Hook: <name>` |
| `rate_limit_event` | `⚠️  Rate limit hit (retrying...)` |
| `result/success` | `✅ Phase <N> completed` |

实施（Bash 轮询 + Node renderer）：

```bash
# 启动后每 1s 读一次新行，调 renderJsonl 转单行
JOBID="$1"
PROGRESS=".context/jobs/${JOBID}/progress.jsonl"
LAST_OFFSET=0
while true; do
  if [ -f "$PROGRESS" ]; then
    SIZE=$(wc -c < "$PROGRESS")
    if [ "$SIZE" -gt "$LAST_OFFSET" ]; then
      tail -c +$((LAST_OFFSET+1)) "$PROGRESS" | node -e '...renderJsonl from stdin...'
      LAST_OFFSET=$SIZE
    fi
  fi
  STATUS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('.context/jobs/${JOBID}/state.json')).status)")
  case "$STATUS" in done|failed|canceled) break ;; esac
  sleep 1
done
```

每次 tail 前调 `detectStuck` 注入 banner（loop / slow-tool / stalled 三类警告）。

## 模式 E：单 phase 协作 cancel

`/ccg:status --cancel <phase-id>` 流程：

1. 校验 `phase-id` 存在某个 job 下：扫所有 `state.json.phase_id`
2. 写 `.context/jobs/<job-id>/cancel.flag` —— 内容 `phase=<phase-id>\nrequested-at=<iso>`
3. 翻 `state.cancel_requested=true`
4. **5 秒 grace 等待** —— 给 phase-runner 子进程读 cancel.flag 优雅退出
5. 5s 后子进程仍 running → 调用 `killProcessTree({ pid: state.cli_pid, pgid: state.process_group_id, graceMs: 5000 })`（来自 `src/utils/process-tree.ts`）
6. 输出最终结果：`canceled gracefully` / `force-killed pid=N` / `not found`

**实施样板**（主线 LLM 用 Bash + node -e 调用 helper）：

```bash
# Step 5: kill-tree on POSIX/Windows
PID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('.context/jobs/${JOBID}/state.json')).cli_pid || '')")
if [ -n "$PID" ]; then
  node -e "
    const { killProcessTree } = require('~/.claude/.ccg/dist/index.mjs');
    killProcessTree({ pid: ${PID}, graceMs: 5000 }).then(r => {
      console.log(JSON.stringify(r));
    });
  "
fi
```

Windows: `taskkill /T /F /PID <pid>` 内置；POSIX: SIGTERM 进程组 → 5s grace → SIGKILL（详见 `src/utils/process-tree.ts` `killProcessTree()`）。

## 严格约束

- ✅ **只读**——本命令绝不修改 `state.json` / `result.md` / `progress.jsonl`（cancel 例外只写 cancel.flag）
- ✅ 列表视图按 `started_at` DESC（最新优先）
- ✅ ASCII-7 only 进度条（cp936 安全）；emoji 用 utf-8（Windows Terminal / PowerShell / WSL 均支持，cmd 退化为 `?` 不影响功能）
- ❌ 不轮询 `result.md` 内容；判定终态只看 `state.json.status`
- ❌ 不调用 `pnpm test` / `git status` 等副作用命令
- ❌ tail 模式不要无限阻塞——5 分钟无新事件 + 无 stalled detector 触发时退出，提示用户用 `--wait` 替代
- ❌ 阻塞等待 `--wait` 不要 sleep > 600s

## 与其他命令的协作

| 命令 | 作用 |
|------|------|
| `/ccg:result <id>` | job 终态后取走 `result.md` 摘要回主线 |
| `/ccg:cancel <id>` | **整个 job** cancel（与本命令 `--cancel <phase-id>` 区分：phase 级 vs job 级） |
| `/ccg:autonomous` / `phase-runner` | 启动 job，写 `state.json` 初始记录 + progress.jsonl |

## 参考实现

helper 路径（dist 安装位置）：

```javascript
// 解析 progress.jsonl → 渲染行
const { renderJsonl, progressBar, formatElapsed } = require('~/.claude/.ccg/dist/index.mjs')

// 卡点检测
const { detectStuck, hasStuckWarning } = require('~/.claude/.ccg/dist/index.mjs')

// job helper
const { listJobs, getJob, requestCancel } = require('~/.claude/.ccg/dist/index.mjs')
```

源码真相：
- `src/utils/jobs.ts` — `listJobs / getJob / requestCancel`
- `src/utils/stream-renderer.ts` — `renderJsonl / renderEvent / progressBar / formatElapsed`
- `src/utils/stuck-detector.ts` — `detectStuck / hasStuckWarning`
- `src/utils/process-tree.ts` — `killProcessTree / sampleProcessRssMb / writeDegradedFlag / readDegradedFlag / reconcileStaleJobs`

`dist/` 未暴露给命令模板时，主线 LLM 走 Bash + Read 等价行为：

- dashboard：调 `node -e` 读各 state.json + 简单进度推断 + `=`/`>`/空格手动拼字符串
- tail：调 `node -e` 解析 ndjson + 走 `renderEvent` 等价 switch（TS helper 是真相源）
- cancel：直接 `echo > cancel.flag` + sleep 5 + 调 process-tree

历史升级记录见 `.ccg-migration/INTERNAL-DEV-LOG.md`。
