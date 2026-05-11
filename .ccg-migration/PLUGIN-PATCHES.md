# Plugin Patches — 上游 Claude Code plugin known issue 持续维护

CCG 通过 plugin 路径调用 codex / gemini。CCG 自身代码无法控制 plugin 行为，但用户机器上的 plugin 偶尔会有可被本地修补的 bug。本文档是这类问题的持续清单 + workaround，**不是 CCG release notes**。

> **维护原则**：每条 issue 必须包含 (1) 症状 / (2) 根因 / (3) 受影响 plugin 版本 / (4) 临时 patch (本地手改) / (5) 永久路径 (上游 PR/issue 链接)。

> **plugin update 风险**：所有手动 patch 在 `claude plugin update <name>` 后都会被覆盖。用户每次 update 后需要重新检查这些 issue 是否已上游修复，没修则重新 patch。

---

## 2.0.0+ 推荐路径：用 ccgx fork（`gemini@gemini-ccgx`），不再 repatch

ccgx 2.0.0 起官方推荐用 **wzyxdwll/gemini-plugin-cc** fork（在 marketplace 注册名 `gemini-ccgx`）。这个 fork 把 P-1..P-21 + W1/W2/I1 全部 patch 作为永久 commit 合进源码，**不需要 repatch 脚本**。

```bash
# 推荐：用 fork（含全部 patch）
claude plugin marketplace add wzyxdwll/gemini-plugin-cc
claude plugin install gemini@gemini-ccgx

# 兼容：仍可用上游 + repatch 脚本（BC，不推荐）
claude plugin marketplace add sakibsadmanshajib/gemini-plugin-cc
claude plugin install gemini@google-gemini
node ~/.claude/.ccg/scripts/repatch-gemini-plugin.mjs  # 每次 plugin update 后重跑
```

ccgx 2.0.0 的 `plugin-bash-codegen.ts` / `ccgx-call-plugin.mjs` 在 `installed_plugins.json` 里**优先**找 `gemini@gemini-ccgx`，找不到 fallback 到 `gemini@google-gemini`。用户什么都不改也能 work，但切到 fork 收益：

| 维度 | 上游 + repatch | ccgx fork |
|------|----------------|-----------|
| 安装步骤 | 2 步（install + repatch） | 1 步（install） |
| update 后 | 必须重跑 repatch | 自动包含 patch |
| Windows pipe 隔离（P-19） | 需 patch | 已 commit |
| ACP timeout（P-15/18） | 需 patch | 已 commit |
| broker idle watchdog（P-14） | 需 patch | 已 commit |
| interrupt passthrough（P-17） | 需 patch | 已 commit |
| broker.log 启用（I1） | 需 patch | 已 commit |
| 集成测试覆盖（I2） | 上游无 | fork tests/ccg-patches.test.mjs |
| 升级新 patch | 跑 repatch 脚本 | `claude plugin update gemini@gemini-ccgx` |

repatch 脚本（`templates/scripts/repatch-gemini-plugin.mjs`）保留，专门给仍用上游的用户。**新用户建议直接用 fork**。

---

---

## P-1: gemini plugin v1.0.1 — Windows spawn 抢焦点（隐形 cmd 弹窗）

**状态**: 未修（上游待 PR），本地 patch 可立即缓解
**首次发现**: 2026-05-06
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
**首次发现**: 早期发现（未正式归档），现已补档
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

## P-9: gemini plugin v1.0.1 — JSON-RPC 错误吞没（`[object Object]` 遮蔽真因）

**状态**: 未修（上游待 PR），本地 patch 立即生效
**首次发现**: 2026-05-10（CCG 1.0.4 dogfood，broker 死后用户看不到任何有用错误信息）
**受影响**: `gemini@google-gemini` v1.0.1

### 症状

- broker daemon 死亡 / auth 过期 / IPC 异常时，主线只看到 `Error: [object Object]`
- gemini agent 报 "Likely auth expiry or broker connectivity issue" 类**模糊推测**——它能给的最具体诊断
- 卡 700+ 分钟无任何信号；CCG 主线无法判断 broker 是死了、auth 过期、还是 RPC 协议失配
- **诊断完全瘫痪**——这是 P-1~P-8 之上更上游的可观测性问题

### 根因

`~/.claude/plugins/cache/google-gemini/gemini/1.0.1/scripts/lib/acp-client.mjs:95` 经典 JS 错误处理反 pattern：

```javascript
// acp-client.mjs:88-100 (有 bug)
if ("id" in message && message.id !== null) {
  const pending = this.pending.get(message.id);
  if (pending) {
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(message.error);  // ← 直接 reject 一个 plain object {code, message, data}
    } else {
      pending.resolve(message.result);
    }
  }
  return;
}
```

JSON-RPC 错误 schema 是 `{code: number, message: string, data?: any}` 普通对象，**不是 Error 实例**。上层调用方做 `try { await ... } catch (e) { e instanceof Error ? e.message : String(e) }` 时：
- `e instanceof Error` → `false`
- `String({code: -32603, message: "..."})` → `"[object Object]"`
- **真错误信息全部丢失**

### 临时 patch

把 plain error object 包装成 Error 实例 + 保留 JSON-RPC code/data 作为附加属性：

```javascript
// acp-client.mjs:88-100 (patched)
if ("id" in message && message.id !== null) {
  const pending = this.pending.get(message.id);
  if (pending) {
    this.pending.delete(message.id);
    if (message.error) {
      // CCG P-9 patch: wrap JSON-RPC error object in Error instance.
      const _err = message.error;
      const _wrapped = Object.assign(
        new Error(typeof _err === "object" && _err !== null && _err.message
          ? String(_err.message)
          : String(_err)),
        {
          jsonrpcCode: typeof _err === "object" && _err !== null ? _err.code : undefined,
          jsonrpcData: typeof _err === "object" && _err !== null ? _err.data : undefined,
        },
      );
      pending.reject(_wrapped);
    } else {
      pending.resolve(message.result);
    }
  }
  return;
}
```

效果：
- `e instanceof Error` → `true`（上层 catch 逻辑正常工作）
- `e.message` → 真实错误描述（"Auth token expired" / "Broker not responding" / "Parse error" 等）
- `e.jsonrpcCode` → 可程序化判断（-32001 auth-expired / -32603 internal / -32700 parse-error 等）
- `e.jsonrpcData` → 调试上下文（验证细节 / 字段路径等）

### 验证 patch 生效

P-9 是**诊断使能 patch**，验证方法是触发故障看错误信息是否变可读：

```bash
# 1. 应用 patch（手动或跑 repatch 脚本）
node ~/.claude/.ccg/scripts/repatch-gemini-plugin.mjs

# 2. 重启 broker daemon（让 patch 生效）
claude plugin disable gemini@google-gemini
claude plugin enable gemini@google-gemini

# 3. 故意触发 auth 失败（让 token 过期或人为破坏 ~/.gemini/auth.json）
# 4. 调 gemini 看错误信息

# Patch 前: "Error: [object Object]"
# Patch 后: "Error: <真实错误> (code -32xxx)"
```

### 永久路径

- 上游仓库：`gemini@google-gemini` plugin（待找 issue tracker）
- 修复方向：`pending.reject()` 前包 Error 实例
- 状态：待提 PR

### 价值（meta）

P-9 是所有 P-* 的**可观测性前提**。修了它，未来其他 plugin bug 至少能拿到真错误信息去诊断——这就是为什么列为最高优先级而不是按时间序号。

---

## P-10: gemini plugin v1.0.1 — broker init 期 client 请求被吞（无 pendingQueue）

**状态**: 已知 manual patch 在用户机器上工作，**未进 CCG repatch 脚本**（多行结构变更，regex guard 风险高，需进一步评估）
**首次发现**: 2026-05-04（CCG 1.0.4 dogfood，`.bak` 与当前 acp-broker.mjs 对比时显形）
**受影响**: `gemini@google-gemini` v1.0.1 原版

### 症状

broker daemon 启动后约 1-3 秒内 ACP 子进程还在初始化（`acpReady === false`），这期间到达的 client 请求**直接被 reject 或丢弃**——下游主线收到无效响应（配合 P-9 修复前会显示成 `[object Object]`）。

### 根因

原版 `acp-broker.mjs` 的 `handleClientMessage` 在 `acpReady === false` 时直接报错或丢请求，没有 pending queue 缓冲：

```javascript
// acp-broker.mjs (有 bug 原版)
function handleClientMessage(socket, raw) {
  // ...
  // Check if ACP process is ready.
  if (!acpReady) {
    // 直接报错或丢，没缓冲
  }
  // ...
}
```

### 临时 patch（多行结构变更，比 P-1~P-8 复杂）

3 处协同修改：

1. 文件顶部加缓冲：
   ```javascript
   const pendingQueue = []; // requests queued while ACP is initializing
   ```

2. ACP ready 时 drain：
   ```javascript
   // 在 acpReady = true 后立即
   const _queued = pendingQueue.splice(0);
   for (const { socket: _qs, message: _qm } of _queued) {
     handleClientMessage(_qs, JSON.stringify(_qm));
   }
   ```

3. handleClientMessage 改 queue：
   ```javascript
   // Check if ACP process is ready; queue the request if still initializing.
   if (!acpReady) {
     if (acpProcess && !acpReady) {
       // ACP is starting up — queue for up to 30s
       pendingQueue.push({ socket, message });
     } else {
       // 原报错路径
     }
     return;
   }
   ```

### 永久路径

- 上游待提 issue 给 `gemini@google-gemini` plugin
- 修复方向：原 spec 应当包含 init queue 机制
- **CCG repatch 脚本暂不收**：multi-region 编辑、regex guard 难以鲁棒匹配，rollback 风险高于 P-1~P-8

---

## P-11: gemini plugin v1.0.1 — ACP `initialize` 缺 `protocolVersion`

**状态**: 已知 manual patch，**未进 CCG repatch 脚本**（同 P-10 理由）
**首次发现**: 2026-05-04 manual patch；2026-05-10 由 P-9 之后真错误透出确认
**受影响**: `gemini@google-gemini` v1.0.1 原版

### 症状

broker spawn `gemini --acp` 后发送的 `initialize` 请求被 gemini-cli 0.39.1 拒绝：

```json
{"code": -32603, "message": "Internal error",
 "data": [{"expected": "number", "code": "invalid_type",
           "path": ["protocolVersion"],
           "message": "Invalid input: expected number, received undefined"}]}
```

`acpReady` 永不变 true，所有后续 RPC 全失败。配合 P-9 修复前，错误显示成 `[object Object]`。

### 根因

原版 `acp-broker.mjs` initialize 调用漏 `protocolVersion` 字段：

```javascript
// acp-broker.mjs (有 bug 原版)
sendToAcp({
  jsonrpc: "2.0",
  id: initId,
  method: "initialize",
  params: {
    // 缺 protocolVersion ← 这里
    clientInfo: {
      name: "gemini-plugin-cc-broker",
      version: "1.0.0"
    }
  }
});
```

gemini-cli 0.39.1 的 ACP schema 要求 `params.protocolVersion: number`，原版 plugin 没发，被 zod schema validator 拒绝。

### 临时 patch（1 行）

```javascript
sendToAcp({
  jsonrpc: "2.0",
  id: initId,
  method: "initialize",
  params: {
    protocolVersion: 1,  // ← 加这行
    clientInfo: {
      name: "gemini-plugin-cc-broker",
      version: "1.0.0"
    }
  }
});
```

### 永久路径

- 上游待提 issue 给 `gemini@google-gemini` plugin
- 修复方向：跟 ACP 协议规范对齐 `protocolVersion`
- **CCG repatch 脚本暂不收**：跟 gemini-cli 版本耦合（不同 cli 版本可能要 0/1/2 不同值），regex 添加要谨慎；待 gemini-cli + plugin 双方 spec 稳定后再纳入

---

## P-12: gemini plugin v1.0.1 — `CLAUDE_PLUGIN_DATA` env 串台导致 broker 永远孤儿化

**状态**: 本地已 patch，进 repatch 脚本，上游待 PR
**首次发现**: 2026-05-11（CCG 1.0.10 dogfood，跨会话调试发现 PID 30456 gemini broker 把 pid 文件写到了 codex 的 plugin data 目录）
**受影响**: `gemini@google-gemini` v1.0.1（codex 同款代码理论上同问题，未观察到，A1 路径下不修）
**触发频率**: 高（每次 plugin 调用切换时）

### 症状

- `gemini broker daemon` 启动后把 broker session 文件（pid file / endpoint）写到了 **codex 的** plugin data 目录：
  ```
  C:\Users\Administrator\.claude\plugins\data\codex-openai-codex\state\<workspace>\acp-session\broker.pid
  ```
- 下次 `gemini-companion` 启动 → 用 gemini 自己的 plugin data dir 算 `resolveStateDir(cwd)` → 找不到 broker session → **新建 broker** → 旧 broker 成孤儿
- 结果：**broker 永远不复用，每次 task 都新建 broker，孤儿持续累积**
- 配合 P-14（broker 无 idle timeout），孤儿不会自退 → 用户机器堆积 N 个 broker daemon 直到下次 reboot

### 根因

`gemini/scripts/lib/state.mjs:51-54`（codex `state.mjs:41-42` 字面一致）：

```javascript
function stateRootDir() {
  return process.env[PLUGIN_DATA_ENV]
    ? path.join(process.env[PLUGIN_DATA_ENV], "state")
    : FALLBACK_STATE_ROOT_DIR;
}
```

两个 plugin 都信任上层 `CLAUDE_PLUGIN_DATA` env。**Claude Code 主进程在 plugin 切换时不重设这个 env**——上次调 codex 留下的 env 串到了下次调 gemini，gemini-companion 因此把自己的 state 写到 codex 的 data dir。

codex 同问题但因为 ccg-workflow 工作流里 codex 经常先调（env 一开始就是 codex 自己的），没暴露。

### 临时 patch（已进 repatch 脚本）

`gemini-companion.mjs` 在最后一个 import 之后插入 patch 块，从脚本物理路径反推 plugin data dir 并覆写 env：

```javascript
import { createStreamHandler } from "./lib/stream-output.mjs";

// CCG P-12 patch: prevent CLAUDE_PLUGIN_DATA cross-contamination from previous
// plugin invocations (e.g., codex). Recompute from this script's physical path
// so the broker session file lands in our own data dir, enabling broker reuse.
{
  const _scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const _versionDir = path.dirname(_scriptDir);                 // .../1.0.1/
  const _pluginDir = path.dirname(_versionDir);                 // .../gemini/
  const _marketplaceDir = path.dirname(_pluginDir);             // .../google-gemini/
  const _cacheDir = path.dirname(_marketplaceDir);              // .../cache/
  const _pluginsDir = path.dirname(_cacheDir);                  // .../plugins/
  const _pluginName = path.basename(_pluginDir);                // gemini
  const _marketplaceName = path.basename(_marketplaceDir);      // google-gemini
  process.env.CLAUDE_PLUGIN_DATA = path.join(_pluginsDir, "data", _pluginName + "-" + _marketplaceName);
}
```

效果：plugin data dir 永远是 `~/.claude/plugins/data/gemini-google-gemini/`，跟 plugin 自己的身份一致，broker 真能被复用。block scope 包裹避免污染 module 作用域，所有 helper 变量限定在 `{}` 内。

### 验证 patch 生效

```bash
# 1. 应用 patch
node ~/.claude/.ccg/scripts/repatch-gemini-plugin.mjs

# 2. 重启 broker daemon（让 patch 生效）
claude plugin disable gemini@google-gemini
claude plugin enable gemini@google-gemini

# 3. 跑一次 gemini task
node ~/.claude/plugins/cache/google-gemini/gemini/1.0.1/scripts/gemini-companion.mjs task -p "say hi" --json

# 4. 检查 broker pid 写到了哪
ls ~/.claude/plugins/data/gemini-google-gemini/state/*/acp-session/

# Patch 前: 文件在 ~/.claude/plugins/data/codex-openai-codex/state/...
# Patch 后: 文件在 ~/.claude/plugins/data/gemini-google-gemini/state/...
```

### 永久路径

- 上游仓库: <https://github.com/sakibsadmanshajib/gemini-plugin-cc>
- 修复方向（任一）：
  - plugin 自检物理路径（patch 当前做法）
  - Claude Code 主进程在 plugin 切换时重设 env（更上游）
- 状态: 待提 PR

---

## P-14: broker daemon 无 idle timeout（已知缺陷，待观察）

**状态**: 已知缺陷，**未进 repatch 脚本**（B2 决策——先验证 P-12 修复后 broker 复用率，若仍频繁卡死再做）
**受影响**: `gemini@google-gemini` v1.0.1 + `codex@openai-codex` v1.0.4 **两边都有**
**触发频率**: 高（任何 broker 卡在 IPC syscall 时）

### 症状

broker daemon `acp-broker.mjs` / `app-server-broker.mjs` 转发 ACP/AppServer RPC 给底层 CLI 子进程后等响应。如果子进程卡死（auth 过期 / 网络限流 / CLI bug），broker 永远等待 → 新进来的 client 被 reject 或排队 → 用户看到 "broker is busy" 或卡死无回。

dogfood 实测：PID 28184 codex broker 跑 51 分钟 CPU=0；PID 30456 gemini broker 跑 6 分钟 CPU=0、RSS 45MB、零子进程——明显挂在 await 上不会自愈。

### 根因

两边 broker 都没 idle watchdog。spawn 时：

```javascript
// broker-lifecycle.mjs (两边代码字面一致)
const child = spawn("node", [BROKER_SCRIPT, "serve", ...], {
  detached: true,
  windowsHide: true,
  stdio: ["ignore", "ignore", "ignore"],
  ...
});
child.unref();
```

`unref()` 后父进程不等它，broker 永远活到机器重启或被人手动杀。**没有 N 分钟 idle 自杀机制**。

### 临时 patch（设计草稿，未进 repatch 脚本）

`acp-broker.mjs` / `app-server-broker.mjs` 加 idle timer：

```javascript
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30min
let idleTimer = setTimeout(() => process.exit(0), IDLE_TIMEOUT_MS);

function resetIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = null;
}

// In handleClientConnection: clear timer when a client connects
function handleClientConnection(socket) {
  resetIdleTimer();
  // ... existing logic ...
  socket.on("close", () => {
    // ... existing logic ...
    if (!activeClient) {
      idleTimer = setTimeout(() => process.exit(0), IDLE_TIMEOUT_MS);
    }
  });
}
```

### 为什么不进 repatch 脚本

- multi-region 改动（顶部加常量、handleClientConnection 注入、socket close 注入），跟 P-10 (pendingQueue) 同级 regex 复杂度
- plugin update 后 anchor 漂移概率高，repatch 静默失败风险大
- B2 决策：先验证 P-12 修复后 broker 真能复用 → 孤儿产生速率应大幅下降 → kill-orphans `--stuck` 兜底可能足够
- 升级条件：1.0.10 ship 后两周内仍频繁见 broker 卡死，或资源耗尽（OOM / fd limit），再上 1.0.11 做 P-14

### 临时 mitigation

`ccg kill-orphans --stuck --kill` 检测 CPU/wall < 1% 且 wall > 5min 的 broker daemon，三级 fallback 强杀（taskkill /F /T 级联 → Stop-Process → wmic delete）。**仅杀 broker 类**（`acp-broker|app-server-broker|broker-lifecycle` cmdline 命中），不动 companion / MCP（companion 等 LLM 响应本来就低 CPU）。

### 永久路径

- 上游仓库（两边都要提）: <https://github.com/sakibsadmanshajib/gemini-plugin-cc> + <https://github.com/openai/codex-plugin-cc>
- 修复方向: broker daemon 加 idle watchdog
- 状态: 待观察 + PR

---

## 一键 repatch 脚本（推荐）

CCG ships `~/.claude/.ccg/scripts/repatch-gemini-plugin.mjs` （幂等，可重复运行）：

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

**Last Updated**: 2026-05-11 (1.0.10)
