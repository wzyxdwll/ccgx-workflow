# invoke-model 接口规范（Node shim 替换 codeagent-wrapper 依据）

提取自：`codeagent-wrapper` v5.10.0 的 Go 实现 + 22 个模板的真实调用样例。

> 范围说明：CCG 模板里 51 处调用全部走单任务（含 `resume`）形态，**不使用** `--parallel`、`--cleanup`、`--lite`、`--full-output`。Node shim **只需要覆盖单任务形态**（含 stdin、resume、`--progress`、`--gemini-model`、`ROLE_FILE` 注入）。下文标注 `[OUT-OF-SCOPE]` 的功能可不实现。

---

## 1. 命令行接口

### 1.1 调用形态（模板真实使用）

```bash
# 形态 A：新会话 + stdin
~/.claude/bin/codeagent-wrapper --progress --backend <codex|gemini|claude> [--gemini-model <name>] - "<workdir>" <<'EOF'
ROLE_FILE: <path>            # 可选，会被替换为文件内容
<TASK>                       # 任务正文
...
EOF

# 形态 B：恢复会话 + stdin（注意是位置子命令 resume，不是 --resume）
~/.claude/bin/codeagent-wrapper --progress --backend <name> [--gemini-model <name>] resume <SESSION_ID> - "<workdir>" <<'EOF'
<TASK>
...
EOF
```

### 1.2 Flag 表（Node shim 必须支持的全部）

| Flag | 必需 | 取值 | 含义 |
|------|------|------|------|
| `--backend <name>` | 是 | `codex` / `gemini` / `claude` | 选择下层 CLI。默认 `codex`，但模板每次都显式传。 |
| `--gemini-model <name>` | 否 | 例：`gemini-3.1-pro-preview` | 仅 `--backend gemini` 生效；非 gemini 时输出 `logWarn` 但不报错（main.go:370）。也接受 `--gemini-model=NAME`。也读 `GEMINI_MODEL` 环境变量（CLI 优先）。 |
| `--progress` | 否 | bool flag | 向 stderr 输出 `[PROGRESS] ...` 紧凑事件行（见 §3.2）。模板基本上每次都加。 |
| `--lite` / `-L` | 否 | bool flag | 关 WebServer + 缩短 post-message delay（5s→1s）。模板里只在 `{{LITE_MODE_FLAG}}` 开关时出现，**Node shim 可视为永远 lite**（Web UI 没人用）。 |
| `--skip-permissions` / `--dangerously-skip-permissions` | 否 | bool 或 `=true/false` | 仅 `--backend claude` 生效，附加 `--dangerously-skip-permissions` 给底层 claude CLI。模板**未使用**。 |
| `--version` / `-v` | 否 | — | 打印版本字符串后退出 0。Node shim 应输出兼容字符串如 `codeagent-wrapper version 5.10.0` 以骗过任何启动检查。 |
| `--help` / `-h` | 否 | — | 打印 help。Node shim 可写一个简版。 |

### 1.3 [OUT-OF-SCOPE] 不需要实现

- `--parallel` / `--full-output`（并行多任务、`---TASK---` / `---CONTENT---` 协议、依赖拓扑、worker 限流、structured report 提取）。**模板没人用**。
- `--cleanup`（清理过期日志）。
- WebServer / SSE 流（`server.go`）。
- 异步 buffered Logger 写文件 + 日志滚动（`logger.go`）。Node shim 直接放弃产物日志文件即可，模板从未消费。
- 输出 metrics 提取（coverage / files changed / tests），仅 `--parallel` 摘要用。
- ASCII 模式（`CODEAGENT_ASCII_MODE`），仅 `--parallel` 用。

### 1.4 位置参数

`parseArgs()`（config.go:197）按 **filtered args**（去掉所有 flag 后）解析：

- 形态 A（new）：
  - `args[0]` = task 文本（若为字面 `-` → `ExplicitStdin=true`，从 stdin 读）
  - `args[1]` = workdir（可选，默认 `.`）
- 形态 B（resume）：
  - `args[0]` = `"resume"`（关键字）
  - `args[1]` = session_id（必须非空）
  - `args[2]` = task 或 `-`
  - `args[3]` = workdir（可选）

模板里 100% 的位置参数顺序都是 `... - "<workdir>"`（即 `task=-`，`workdir` 是带引号的绝对路径）。**Node shim 只需稳健支持这一种**，但要对 `args[0]` 不是 `-` 时也做兜底（直接 task 文本传入）。

---

## 2. 输入协议

### 2.1 stdin

- 多行 UTF-8 任务文本，由调用方用 heredoc (`<<'EOF'`) 喂入。
- 触发 stdin 模式的条件（utils.go:50, `shouldUseStdin`）：
  1. `args[0] == "-"`（`ExplicitStdin=true`），或
  2. stdin 不是 tty（piped），或
  3. taskText 含 `\n` `\\` `"` `'` `` ` `` `$` 中任意一个，或
  4. taskText 长度 > 800 字符。
- Node shim 简化：模板永远走 (1)，可直接判定 `args[0] === '-'` 即从 stdin 读全部内容。

### 2.2 ROLE_FILE 注入（utils.go:75）

任务文本里允许 `^ROLE_FILE:\s*<path>$`（行级正则，多行模式）。被匹配到的整行替换为文件内容：

- `~/...` 展开为 `os.UserHomeDir()`
- Windows 上：`/c/Users/...` → `C:/Users/...`，`\\` → `/`（`normalizeWindowsPath`）
- 文件读不到 → `logWarn` + 保留原行（不报错退出）

**Node shim 必须实现这个**，否则 22 个模板里的 `ROLE_FILE: ~/.claude/.ccg/prompts/codex/debugger.md` 会被原样发给下层 CLI，模型行为完全错乱。

### 2.3 工作目录处理

| backend | workdir 传递方式 |
|---------|------------------|
| codex | `-C <workdir>` flag（仅 new 模式），**不**设 `cmd.Dir`（避免冲突） |
| gemini | `cmd.Dir = workdir` + `--include-directories <workdir>`（new 模式）。**注意**：早期版本曾用 `cmd.Dir=$HOME` 隔离 `.env`，v5.10.0 已改回 `cmd.Dir=workdir`，因为 `$HOME` 让 Gemini 在长 prompt 上 hang（executor.go:993-1007 注释）。`.env` 隔离改靠 `cmd.SetEnv()` 注入 `~/.claude/settings.json` 的 env 字段。 |
| claude | `cmd.Dir = workdir`（claude CLI 不支持 `-C`） |

resume 模式：忽略 workdir（codex 的 resume 子命令本身不接受 `-C`，gemini 的 `-r` 也不需要 `--include-directories`）。

---

## 3. 输出协议

### 3.1 stdout

成功（exit 0）：

```
<模型最终回复正文>

---
SESSION_ID: <id>
```

最后两行（空行 + `---\nSESSION_ID: <id>\n`）由 main.go:489-492 在 `result.SessionID` 非空时附加。**模板用正则 `SESSION_ID:\s*(\S+)` 提取**。

失败（exit ≠ 0）：stdout 一般为空（错误进 stderr 的 `Recent Errors` 段落）。

### 3.2 stderr

启动 banner（main.go:432-436，**所有调用都打**）：

```
[<wrapper-name>]
  Backend: <backend>
  Command: <command-name> <args...>
  PID: <pid>
  Log: <log-file-path>
```

`Session-ID` 早期输出（executor.go:1083-1090，`session_started` 事件触发，仅非 silent 模式）：

```
  Session-ID: <id>
```

**重要**：这一行让 Claude 在任务超时/失败时仍能拿到真实 session_id 用于后续 resume，不能省。

进度行（`--progress` 开启）（parser.go:140 `emitProgress`）：

```
[PROGRESS] <event> [k=v ...]
```

事件名（按 codex 流推断；gemini/claude 流没有进度发射）：
- `session_started id=<id>`
- `turn_started`
- `turn_completed total_events=<n>`
- `session_completed total_events=<n>`
- `message text="<前 120 字 quote 后>"` （agent_message 出现时）
- `reasoning text="..."`
- `cmd_done cmd="<前 120 字 quote 后>" exit=<code>`
- `mcp_call`

字段顺序固定：`id text cmd exit total_events`（parser.go:397）。

噪声过滤（filter.go:9-23，对**所有 backend 的 stderr** 生效）：丢弃含以下子串的行：
- `[STARTUP]` / `Session cleanup disabled` / `Warning:` / `(node:` / `(Use \`node --trace-warnings`
- `Loaded cached credentials` / `Loading extension:` / `YOLO mode is enabled`
- `[WARN] Skipping unreadable directory` / `supports tool updates. Listening for changes`

失败时附加（main.go:166-172）：

```

=== Recent Errors ===
<最近 10 条 ERROR 日志条目>
Log file: <path> (deleted)
```

### 3.3 退出码（main.go 帮助 + executor.go 返回路径）

| code | 含义 |
|------|------|
| 0 | 成功（且 `parsed.message` 非空） |
| 1 | 通用错误：参数缺失 / `agent_message` 为空 / pipe 创建失败 / 其他启动错误 |
| 124 | 超时（context.DeadlineExceeded） |
| 127 | 后端命令不在 PATH（`executable file not found`） |
| 130 | SIGINT/SIGTERM 取消 |
| 其他 | 后端 `*exec.ExitError.ExitCode()` 透传 |

**特殊容错**：若 backend 在 `agent_message` 已收到后才被 force-kill（`forcedAfterComplete && parsed.message != ""`），exit=0，正常打印 message（executor.go:1286）。

---

## 4. Session 复用机制

### 4.1 捕获

由 `parseJSONStreamInternalWithContent`（parser.go:114）从下层 CLI 的流式 JSON 输出中解析：

| backend | 触发字段 | 事件类型 |
|---------|---------|----------|
| codex | `event.thread_id`（snake_case） | `thread.started` 立刻；`thread.completed`/`turn.completed` 兜底 |
| claude | `event.session_id` | 首次出现即捕获 |
| gemini | `event.sessionId`（**camelCase**！）或 `session_id` | `init` 事件 |

`onSessionStartedCallback` 在首次拿到非空 id 时触发，立刻打印 stderr 的 `  Session-ID: <id>`。

**Gemini 容错**：init 事件行可能被前缀脏字符污染（如 `MCP issues detected. Run /mcp list for status.{...}`），parser.go:178-184 会从首个 `{` 重试解析。

**Codex `agent_message` 容错**：`item.text` 可能是 string 也可能是 `[]string`（normalizeText, parser.go:522）—两种都要兼容。

### 4.2 消费（resume 路径）

下层 CLI 的 resume 命令形态（**与 wrapper 自身的 `resume <id>` 子命令不同！**）：

| backend | wrapper 透传给下层 CLI 的参数 |
|---------|-------------------------------|
| codex | `e --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --json resume <id> <task-or-->` （注意：是 `resume <id>` 子命令，**不是** `-r` 也**不是** `--resume`） |
| claude | `-p --setting-sources "" -r <id> --output-format stream-json --verbose <task-or-->` |
| gemini | `[-m <model>] -o stream-json -y -r <id> [-p <task>]` |

resume 模式下：
- codex 不再传 `-C <workdir>`（resume 子命令自身管 workdir）
- gemini 不再传 `--include-directories`

### 4.3 wrapper 自身的 `resume` 关键字

`codeagent-wrapper resume <id> ...` 是 **wrapper 层** 的子命令，不是直接转给 codex CLI。wrapper 解析后设置 `cfg.Mode=resume` + `cfg.SessionID`，再由 `buildCodexArgs/buildClaudeArgs/buildGeminiArgs` 翻译成下层 CLI 各自的 resume 形式。Node shim 必须复刻这层翻译。

---

## 5. 平台差异

### 5.1 Windows

- **Gemini stdin pipe**（issue #129）：当 `useStdin && backend==gemini && isWindows()`，**省略 `-p` flag** 并通过 stdin pipe 喂任务文本。原因：npm 的 `.cmd` 包装器走 cmd.exe，多行 `-p` 参数会被截断到第一行换行。executor.go:864-871 通过 `targetArg=""` 信号让 `buildGeminiArgs` 跳过 `-p`。
- **Gemini macOS/Linux**：直接 `-p "<完整任务文本>"` 走 argv，不用 stdin pipe（execve 保留多行）。代码里 `geminiDirect=true` 时 **不创建 stdin pipe**。
- **进程树终止**：`taskkill /T /F /PID <pid>` 替代 SIGTERM/SIGKILL（Codex 派生 Node 子进程持有 stdout handle，光杀父进程会让 `cmd.Wait()` 永远阻塞）。Node shim 用 `tree-kill` 包或 `taskkill` shell-out 都行。
- **Force-kill fallback timer**：`messageTimer` 触发后开 `forceKillDelay+2 秒` 兜底定时器，若 `cmd.Wait()` 仍未返回就直接 break loop（executor.go:1199-1209）。
- **stdout sync**：main.go:496 `os.Stdout.Sync()`，对 Git Bash 后台执行的 stdout buffering bug 的 workaround。Node 用 `process.stdout.write()` + `process.stdout.uncork()` 即可。
- **隐藏 CMD 窗口**：`hideWindowsConsole(cmd)` 给 taskkill 子进程设 `CREATE_NO_WINDOW=0x08000000`。Node `child_process.spawn` 加 `windowsHide: true`。

### 5.2 macOS / Linux

- SIGTERM → 5s 后 SIGKILL（`forceKillDelay`）
- Gemini 走直接 `-p` argv（execve）

---

## 6. 环境变量与配置注入

### 6.1 wrapper 自身读取的 env

| 变量 | 默认 | 说明 |
|------|------|------|
| `CODEX_TIMEOUT` | 7200s | 单位毫秒（>10000）或秒。Node shim 应保持兼容。 |
| `CODEX_REQUIRE_APPROVAL` | false | true 时**不**给 codex 加 `--dangerously-bypass-approvals-and-sandbox` |
| `CODEX_DISABLE_SKIP_GIT_CHECK` | false | true 时**不**给 codex 加 `--skip-git-repo-check` |
| `CODEAGENT_LITE_MODE` | false | 等价于 `--lite` |
| `CODEAGENT_POST_MESSAGE_DELAY` | 5s | message 后等 turn.completed 的窗口（lite 模式 1s） |
| `CODEAGENT_SKIP_PERMISSIONS` | false | 等价于 `--skip-permissions` |
| `GEMINI_MODEL` | 空 | gemini-model 默认值（CLI 参数覆盖） |
| `CODEAGENT_MAX_PARALLEL_WORKERS` | 0=∞ | [OUT-OF-SCOPE] |
| `CODEAGENT_ASCII_MODE` | false | [OUT-OF-SCOPE] |

### 6.2 env 注入到下层 CLI

`loadMinimalEnvSettings()`（backend.go:43）从 `~/.claude/settings.json` 的顶层 `env` 字段读字符串键值，合并 `os.Environ()` + `cmd.cmd.Env`，注入子进程。这是 **Gemini API key 全局来源**——必须保留。

`SetEnv` 合并优先级（executor.go:117）：`os.Environ()` < `cmd.cmd.Env`（自带的，目前为空）< 用户 settings.json 的 env。

---

## 7. 真实调用样例

### 样例 1：codex 新会话（模板 backend.md:42）

```
~/.claude/bin/codeagent-wrapper --progress --backend codex - "/d/some/proj" <<'EOF'
ROLE_FILE: ~/.claude/.ccg/prompts/codex/architect.md
<TASK>
分析后端架构现状...
EOF
```

### 样例 2：codex resume（codex-exec.md:170）

```
~/.claude/bin/codeagent-wrapper --progress --backend codex resume abc-123 - "/d/some/proj" <<'EXEC_EOF'
<TASK>
You are a full-stack execution agent. Implement the following plan...
EXEC_EOF
```

### 样例 3：gemini + 自定义 model（feat.md:23）

```
~/.claude/bin/codeagent-wrapper --progress --backend gemini --gemini-model gemini-3.1-pro-preview - "/d/some/proj" <<'EOF'
ROLE_FILE: ~/.claude/.ccg/prompts/gemini/frontend.md
<TASK>
...
EOF
```

### 样例 4：team-exec 后台调用（team-exec.md，Bash run_in_background:true，timeout=300000）

```js
Bash({
  command: "~/.claude/bin/codeagent-wrapper --progress --backend codex resume <CODEX_PROTO_SESSION> - \"/d/proj\" <<'EOF'\nReview the implementation changes:\n...\nEOF",
  run_in_background: true,
  timeout: 300000,
})
```

### 样例 5：debug 双模型并行（debug.md:35 + 47）

两条 Bash 调用同消息发出，分别 `--backend codex` 和 `--backend gemini`，都是 stdin + new 会话，workdir = `$(pwd)`。

### 样例 6：spec-impl 并行原型（spec-impl.md:50）

```
codeagent-wrapper --progress --backend codex - "/proj" <<'EOF'
TASK: <task description>
CONTEXT: <relevant code context>
...
EOF
```

（注意没有 `~/.claude/bin/` 前缀——依赖 PATH。Node shim 应该用相同二进制名 `codeagent-wrapper` 让 PATH 兼容。）

---

## 8. Node 重写注意事项（红旗清单）

### 8.1 必须复刻的非显然行为

1. **post-message delay**（默认 5s，lite 1s）：收到 `agent_message` 后**不能**立即 kill 子进程，要等 `turn.completed` / `thread.completed` 在窗口内到达；超时再发 SIGTERM/taskkill。否则 Codex 在 Windows 上 message_completed 事件经常掉，导致 `result.SessionID` 抓不到。
2. **stdout 关闭顺序**（executor.go:1190 注释）：Windows 上必须**先 close stdout pipe** 再 kill 进程，否则 `child.on('exit')` 永不触发（子进程持有 stdout handle）。
3. **Session-ID 提前输出 stderr**（仅非 silent / 单任务模式）：第一次解析到 session id 时立即写 `  Session-ID: <id>\n`，**不要等结束**。
4. **agent_message 为空 = exit 1**（executor.go:1305）：即便子进程 exit 0，没拿到 message 也算失败。
5. **forcedAfterComplete 容错**（executor.go:1286）：被 messageTimer 杀死的进程返回非 0，但 `parsed.message` 已就绪 → 视为成功。
6. **JSON 行 10MB 上限**（parser.go:59）：超长行 truncate 后跳过，**不能**让 `agent_message` 这种动辄几百 KB 的事件被截断。Node 实现要用 `readline` 配合大缓冲，或自己分 chunk。
7. **codex 用 `e` 子命令 + JSON 流**：不是 `codex exec`，是单字母 `e`。`--json` 必传。
8. **claude 子进程必须 `--setting-sources ""`**：防止 wrapper-spawn-claude-spawn-wrapper 死循环。
9. **gemini sessionId 是 camelCase**（parser.go:88）：snake_case 解析对它无效，**两种都要试**。

### 8.2 重试 / 错误透传

Go 实现**没有内置重试**——失败直接退出。模板里那段「Gemini 失败重试 2 次、间隔 5s」（v1.7.87）是 **Claude 编排层** 的逻辑，不是 wrapper 实现。Node shim **不需要做重试**。

### 8.3 信号 / 进程组

- 必须监听 SIGINT、SIGTERM。收到后先 graceful（SIGTERM/taskkill），`forceKillDelay`（5s）后强杀。
- Node：`process.on('SIGINT', ...)` + `child.kill('SIGTERM')`，Windows 用 `taskkill /T /F /PID <pid>`。**不要**依赖 `child.kill()` 在 Windows 上的默认行为（只杀父）。
- 子进程 spawn 选项：`{ stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: false }`。**不要**用 `detached: true` + `process.kill(-pid)`，跨平台不一致；显式 taskkill 更稳。

### 8.4 编码 / Unicode

- Windows console 默认 GBK，但 `child.stdout` 是 raw bytes——必须 `child.stdout.setEncoding('utf8')`，否则 JSON 中文 / emoji 会乱。
- `safeProgressSnippet`（parser.go:405）按 `[]rune` 截断，避免切碎 UTF-8。Node 直接 `[...str].slice(0, 120).join('')` 即可。
- ANSI escape 清理 `sanitizeOutput`（utils.go:308）只在 `--parallel` 摘要用，单任务路径**不**清理。Node shim 不需要做。

### 8.5 文件描述符 / stdin

- `cmd.StdinPipe()` 后必须 **写完即 close**（executor.go:1138-1142），否则 codex/claude 永远等输入。
- gemini macOS/Linux 路径**完全不创建 stdin pipe**（`!geminiDirect`），任务文本走 argv。Node 实现要镜像这个分支。

### 8.6 不需要的复杂物

- **WebServer / SSE**：放弃。
- **logger.go 异步日志 + 滚动**：放弃，改成失败时直写 stderr 即可。
- **`--parallel` 全部基础设施**：拓扑排序、worker 限流、structured report 提取、`---TASK---/---CONTENT---` 解析——全部放弃。
- **`process_check_*.go` 进程存活探测**：仅 logger 内部 cleanup 用，放弃。
- **`wrapper_name.go` symlink 别名**：用单一名字 `codeagent-wrapper` 就够了，不用支持旧名 `codex-wrapper`。

### 8.7 版本字符串兼容

`installer.ts` 有 `EXPECTED_BINARY_VERSION = '5.10.0'` 检查（CLAUDE.md 提到）。Node shim 第一次 `--version` 输出最好是 `codeagent-wrapper version 5.10.0`（或更高）让 update 流程开心。或者干脆把 installer.ts 同步 patch 掉这个检查——更干净。

---

## 9. 验收清单（Node shim 做完前自查）

- [ ] `--backend codex/gemini/claude` + stdin + 新会话：能跑通，`SESSION_ID:` 行存在
- [ ] `resume <id>` 子命令解析正确，下层 CLI 收到 codex `e ... resume <id>` / claude `-r <id>` / gemini `-r <id>`
- [ ] `ROLE_FILE:` 行正确替换为文件内容（含 `~` 展开 + Windows `/c/` 路径）
- [ ] `--gemini-model <name>` 影响 gemini `-m`，对其他 backend 仅 warn
- [ ] `--progress` 能打出 `[PROGRESS] message text="..."` 等行
- [ ] Windows + gemini + 多行任务：走 stdin pipe，**不**带 `-p` flag
- [ ] macOS/Linux + gemini：走 `-p "<text>"` argv，不开 stdin pipe
- [ ] codex 在 new 模式带 `-C <workdir>`，resume 模式不带
- [ ] 噪声 stderr 行被过滤（如 `(node:` warning）
- [ ] SIGINT 能优雅杀子进程（Windows 用 taskkill /T）
- [ ] `agent_message` 后 5s 内若 `turn.completed` 没到，主动 kill，但 message 仍打印 + exit 0
- [ ] 子进程 exit code 透传（127 / 124 / 130 / 其他）
- [ ] `~/.claude/settings.json` 的 `env` 字段被注入子进程
- [ ] 启动 banner（`Backend:` / `Command:` / `PID:` / `Log:`）写 stderr
