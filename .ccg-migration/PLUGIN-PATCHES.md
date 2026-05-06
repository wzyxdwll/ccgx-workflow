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
