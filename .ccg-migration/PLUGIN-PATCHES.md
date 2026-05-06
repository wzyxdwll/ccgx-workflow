# Plugin Patches — 上游 Claude Code plugin known issue 持续维护

CCG v4.4+ 通过 plugin 路径调用 codex / gemini（替代 v3.0 之前的 codeagent-wrapper）。CCG 自身代码无法控制 plugin 行为，但用户机器上的 plugin 偶尔会有可被本地修补的 bug。本文档是这类问题的持续清单 + workaround，**不是 CCG release notes**。

> **维护原则**：每条 issue 必须包含 (1) 症状 / (2) 根因 / (3) 受影响 plugin 版本 / (4) 临时 patch (本地手改) / (5) 永久路径 (上游 PR/issue 链接)。

> **plugin update 风险**：所有手动 patch 在 `claude plugin update <name>` 后都会被覆盖。用户每次 update 后需要重新检查这些 issue 是否已上游修复，没修则重新 patch。

---

## P-1: gemini plugin v1.0.1 — Windows spawn 抢焦点（隐形 cmd 弹窗）

**状态**: 未修（上游待 PR），本地 patch 可立即缓解
**首次发现**: 2026-05-06（v4.5 release 后用户反馈）
**受影响**: `gemini@google-gemini` v1.0.1 on Windows
**未受影响**: `codex@openai-codex` v1.0.4（同型代码加了 `windowsHide: true`，对照参考）

### 症状

调用 gemini plugin（`/ccg:review` / verify wave / `--background` task）时，Windows 偶尔短暂闪现一个隐形 cmd 窗口，抢走当前应用焦点几毫秒后消失。用户在打字 / 浏览其它应用时被打断。

### 根因

`~/.claude/plugins/cache/google-gemini/gemini/1.0.1/scripts/gemini-companion.mjs` 的 `spawnBackgroundWorker()` 函数（line 699-708）在 `child_process.spawn` 调用时**漏写 `windowsHide: true` 选项**：

```javascript
// gemini-companion.mjs:699-708 (有 bug)
function spawnBackgroundWorker(workspaceRoot, jobId) {
  const scriptPath = fileURLToPath(import.meta.url);
  const child = spawn("node", [scriptPath, "task-worker", jobId], {
    cwd: workspaceRoot,
    detached: true,
    // 缺 windowsHide: true ← 这里
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env
  });
  child.unref();
}
```

Windows 下 `detached: true` 没有 `windowsHide: true` 配合时，Node 默认行为是创建一个新的 console subsystem 进程，**短暂拥有焦点**，然后立即 detach。视觉上即"隐形 cmd 闪现"。

对照 codex plugin 同款代码（`codex-companion.mjs:643-648`）有 `windowsHide: true`，所以不抢焦点：

```javascript
// codex-companion.mjs:643-648 (无 bug 参考)
const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
  cwd,
  detached: true,
  stdio: "ignore",
  windowsHide: true        // ← 关键
});
```

### 临时 patch（本地手改 1 行）

```bash
# 编辑 ~/.claude/plugins/cache/google-gemini/gemini/1.0.1/scripts/gemini-companion.mjs
# 在 line 703 (detached: true,) 下方加一行：
#     windowsHide: true,
```

完整修改后的 spawn 块：

```javascript
const child = spawn("node", [scriptPath, "task-worker", jobId], {
  cwd: workspaceRoot,
  detached: true,
  windowsHide: true,                       // ← 新增
  stdio: ["ignore", "ignore", "ignore"],
  env: process.env
});
```

立即生效，下次 spawn 用 patch 后代码（不需要重启 Claude Code）。

### 验证 patch 生效

```bash
# 手动触发一次 background spawn
node ~/.claude/plugins/cache/google-gemini/gemini/1.0.1/scripts/gemini-companion.mjs task -p "say hi" --background

# 应该 0 焦点抢走（patch 前会闪现 cmd 窗口）
```

### 永久路径

- 上游 plugin 仓库: <https://github.com/sakibsadmanshajib/gemini-plugin-cc>
- 修复: line 701-706 `spawnBackgroundWorker` 加 `windowsHide: true`，**字面对照** codex-plugin-cc 同款实现
- 状态: 待 PR / issue（用户可代提）
- CCG 上游 PR 后该条目移到下方 "Resolved" 节

### plugin update 后重补

`claude plugin update gemini@google-gemini` 会覆盖 cache 目录所有文件，包含本 patch。**update 后必须重新 patch**，或检查是否上游已修复。

---

## P-2: gemini plugin v1.0.1 — Windows 调底层 `gemini --acp` CLI 时 ENOENT + 闪 cmd 黑窗

**状态**: 本地已 patch（`.bak` 备份存在），上游待 PR
**首次发现**: v4.5 之前（早期发现，未正式归档）— 现 v4.5.1 补档
**受影响**: `gemini@google-gemini` v1.0.1 on Windows
**触发频率**: 每次 ACP broker 启动 + 每个 ACPClient 实例化（高频）
**与 P-1 区别**: P-1 spawn 的是 Node task-worker（不需 shell），P-2 spawn 的是底层 `gemini` CLI（npm 装的 .cmd 脚本，必须 shell:true）

### 症状

Windows 上 plugin 调用底层 gemini CLI 时：

1. **ENOENT 报错**：`spawn gemini ENOENT`，错误对象被 plugin 错误处理路径序列化为 `[object Object]`，用户看到无意义的错误信息
2. **闪 cmd 黑窗**：用 `shell: true` 修复 ENOENT 后，每次 spawn 短暂闪现 cmd 控制台窗口，抢焦点

根因是 npm 全局装的 `gemini` CLI 在 Windows 上是 `.cmd` 脚本（不是 `.exe`）。Node `child_process.spawn("gemini", ...)` 不会自动尝试 `.cmd` 后缀，必须经过 cmd shell 解析才能找到。但 `shell: true` 默认会创建可见 console，需配套 `windowsHide: true` 抑制。

### 根因

两个独立 spawn 点都缺 `shell: process.platform === "win32"` + `windowsHide: true`：

1. **`scripts/acp-broker.mjs:85-95`** `spawnAcpProcess(cwd)` — ACP broker daemon 启动主进程
2. **`scripts/lib/acp-client.mjs:243-250`** ACPClient 内部 spawn — 多 client 路径

### 临时 patch（本地手改 2 处，每处 +3 行）

#### Patch 1: `~/.claude/plugins/cache/google-gemini/gemini/1.0.1/scripts/acp-broker.mjs:85`

```javascript
function spawnAcpProcess(cwd) {
  const child = spawn("gemini", ["--acp"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    // Windows 兼容性：gemini 是 .cmd 脚本，Node.js spawn 必须 shell:true 才能找到
    // 否则抛 ENOENT 被序列化为 [object Object]
    shell: process.platform === "win32",
    // 抑制 shell:true 在 Windows 上闪 cmd 黑窗（Linux/macOS 忽略此选项）
    windowsHide: true
  });
  // ...
}
```

#### Patch 2: `~/.claude/plugins/cache/google-gemini/gemini/1.0.1/scripts/lib/acp-client.mjs:243`

```javascript
this.proc = spawn("gemini", ["--acp"], {
  cwd: this.cwd,
  stdio: ["pipe", "pipe", "pipe"],
  // Windows 兼容性：gemini 是 .cmd 脚本，Node.js spawn 必须 shell:true 才能找到
  shell: process.platform === "win32",
  // 抑制 shell:true 在 Windows 上闪 cmd 黑窗
  windowsHide: true
});
```

### 验证 patch 已生效

```bash
# 检查两个 spawn 点都有 shell + windowsHide:
grep -A 6 "spawn(\"gemini\", \[\"--acp\"\]" \
  ~/.claude/plugins/cache/google-gemini/gemini/1.0.1/scripts/acp-broker.mjs \
  ~/.claude/plugins/cache/google-gemini/gemini/1.0.1/scripts/lib/acp-client.mjs

# 都应包含 shell: process.platform === "win32" + windowsHide: true
```

### 永久路径

- 上游 plugin 仓库: <https://github.com/sakibsadmanshajib/gemini-plugin-cc>
- 修复方向: 两处 spawn 都加 `shell: process.platform === "win32"` + `windowsHide: true`
- 状态: 本地已 patch（用户机器 cache 中 `.bak` 备份保留原版），上游 PR 待提
- 与 P-1 同 PR 一并提

### plugin update 后重补

`claude plugin update gemini@google-gemini` 会用 `.bak` 同款（无 patch）原版覆盖 cache。**update 后必须重新 patch 两处**。可以写个本地脚本一键重补（建议 `~/.claude/.ccg/scripts/repatch-gemini-plugin.sh`）。

---

## P-4: gemini plugin v1.0.1 — broker daemon 启动闪框

**状态**: 未修，待本地 patch
**受影响**: `gemini@google-gemini` v1.0.1 on Windows
**触发频率**: 高（每次 plugin 首次启动 / broker daemon 重启）
**关联**: 与 P-1 同款 `detached: true + 缺 windowsHide` bug，但在不同 spawn 点

### 症状

第一次调用 gemini plugin（任何 task）时闪一次 cmd 黑窗——broker daemon 长跑进程的启动 spawn。

### 根因

`scripts/lib/broker-lifecycle.mjs:137-152` `spawn("node", [BROKER_SCRIPT, "serve", ...])` 缺 `windowsHide: true`：

```javascript
const child = spawn("node", [BROKER_SCRIPT, "serve", ...], {
  cwd,
  detached: true,
  // 缺 windowsHide: true ← 加这行
  stdio: ["ignore", "ignore", "ignore"],
  env: { ... }
});
```

### 临时 patch

加 `windowsHide: true,` 在 `detached: true,` 之后。

---

## P-5: gemini plugin v1.0.1 — `runCommand` spawnSync 闪框

**状态**: 未修
**受影响**: 同上
**触发频率**: 中（每次 `gemini --version` 健康检查 + git 命令）
**关联**: P-2 同型 — `gemini.cmd` 必须 shell 找到，但 `runCommand` 是通用 helper 不只用于 gemini

### 症状

调用 plugin 任何 git 操作（`git diff`、`git rev-parse` 等）或 `gemini --version` 健康检查时闪框。

### 根因

`scripts/lib/process.mjs:18-24` `spawnSync(command, args, ...)` 缺 `windowsHide: true`，被 `gemini.mjs:190` 调（`gemini --version`）+ `git.mjs:16` 调（git 命令路径）。

```javascript
const result = spawnSync(command, args, {
  cwd: options.cwd,
  maxBuffer: ...,
  encoding: "utf8",
  env: ...,
  stdio: ["pipe", "pipe", "pipe"]
  // 缺 , windowsHide: true ← 加这行
});
```

### 临时 patch

`stdio: [...]` 后加 `, windowsHide: true`。

---

## P-6: gemini plugin v1.0.1 — `taskkill` spawnSync 闪框

**状态**: 未修
**受影响**: 同上
**触发频率**: 低（仅 cancel task 时）

### 症状

`/ccg:cancel` 或 ACPClient close 时调 `taskkill /T /F` 杀进程树闪框。

### 根因

`scripts/lib/process.mjs:103`：

```javascript
spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
// 缺 windowsHide: true
```

### 临时 patch

改为 `{ stdio: "ignore", windowsHide: true }`。

---

## P-8: gemini plugin v1.0.1 — `binaryAvailable` (where/which) 闪框

**状态**: 未修
**受影响**: `gemini@google-gemini` v1.0.1 on Windows
**触发频率**: 中（每次 plugin 健康检查 binary 是否在 PATH）
**关联**: 与 P-5 同型，但用 `where`/`which` 命令检查 PATH

### 症状

每次 plugin 启动 / 健康检查时调 `where gemini` (Windows) 或 `which gemini` (POSIX)，spawnSync 没 windowsHide 在 Windows 上闪 cmd 黑窗。

### 根因

`scripts/lib/process.mjs:84` `binaryAvailable(name)` helper：

```javascript
const result = spawnSync(command, [name], { encoding: "utf8", stdio: "pipe" });
// 缺 , windowsHide: true
```

### 临时 patch

改为 `{ encoding: "utf8", stdio: "pipe", windowsHide: true }`。

---

## P-7: gemini plugin v1.0.1 — `spawnDetached` 公共 helper 闪框

**状态**: 未修
**受影响**: 同上
**触发频率**: 中（任何调用 spawnDetached 的地方都继承 bug）
**关联**: 这是个 helper，**修一处管所有调用方**

### 症状

不可预知的间歇性闪框——取决于哪些 spawn 点用了这个 helper。

### 根因

`scripts/lib/process.mjs:134-148`：

```javascript
export function spawnDetached(command, args, options = {}) {
  const stdio = options.logFile ? [...] : [...];
  const child = nodeSpawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    // 缺 windowsHide: true ← 加这行
    stdio
  });
  child.unref();
  return child;
}
```

### 临时 patch

加 `windowsHide: true,` 在 `detached: true,` 之后。

---

## ⚡ 关键：patch 后必须重启 broker daemon

`acp-broker` 是 long-running daemon（启动后一直跑直到用户退出 Claude Code）。**已 patch 的代码只对将来新启的 daemon 生效**。如果旧 daemon 仍在跑，它继续用未 patch 的代码 → 仍闪框。

### 重启 broker daemon（Windows PowerShell）

```powershell
# 杀所有 acp-broker daemon
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'acp-broker' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

### 或重启 plugin（更稳）

```bash
claude plugin disable gemini@google-gemini
claude plugin enable gemini@google-gemini
```

下次 plugin 调用时会重新启动 broker daemon，用 patch 后的代码。

---

## 一键 repatch 脚本（推荐）

CCG v4.5.1+ ships `~/.claude/.ccg/scripts/repatch-gemini-plugin.mjs` （幂等，可重复运行）：

```bash
node ~/.claude/.ccg/scripts/repatch-gemini-plugin.mjs
```

脚本会：
1. 自动找 plugin 版本目录
2. 检查每处 patch 状态（`probe` 字符串匹配）
3. 已 patch 的 [SKIP]，未 patch 的 [APPLY]
4. 完成后提示重启 broker daemon 命令

**未装 CCG 的机器**：直接从 [`templates/scripts/repatch-gemini-plugin.mjs`](../templates/scripts/repatch-gemini-plugin.mjs) 复制脚本到目标机器跑：

```bash
# 在目标机器
node /path/to/repatch-gemini-plugin.mjs

# 或一行 scp
scp templates/scripts/repatch-gemini-plugin.mjs <other-host>:/tmp/
ssh <other-host> 'node /tmp/repatch-gemini-plugin.mjs'
```

---

## Resolved（上游已修复）

（暂无）

---

## 提交新 issue 检查清单

发现新的 plugin 问题时，按以下模板加入本文档：

```markdown
## P-N: <plugin-name>@<marketplace> v<X.Y.Z> — <一句话症状>

**状态**: 未修 / 上游 PR pending / 已修复
**首次发现**: <日期>（<触发场景>）
**受影响**: <plugin name + 版本>
**未受影响**: <对照 plugin 如有>

### 症状
<用户视角描述>

### 根因
<代码定位 + 文件:line + 简短代码片段>

### 临时 patch
<最小修改步骤 + 修改后代码块>

### 验证
<怎么确认 patch 生效的命令>

### 永久路径
- 上游仓库链接
- 修复方向
- 状态（待 PR / 已 PR / 已 release）
```

---

**Last Updated**: 2026-05-06 (v4.5.1 hotfix release)
