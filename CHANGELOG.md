# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.1.1] - 2026-05-12 — 🛡 helper 加 idle/wall 双层超时 + auto-cleanup symlink 防护 + review.md 跨平台路径修复

### 🐛 修复

- **`review.md` 7 处 `/tmp/ccg-review-*` → `.context/tmp/ccg-review-*`**。原 `/tmp/` 在 Windows + Git Bash + Node 三方解析不一致——Claude Code Write tool / Git Bash MSYS mount / Node `fs.readFileSync` 各自把 `/tmp/` 解到不同实际路径，导致 helper 报 EX_NOINPUT (66) "prompt file read failed"。workspace-relative `.context/tmp/` 三方解析一致。
- **helper auto-cleanup symlink 边界安全**（codex 审计必修）。原版 `resolve()` 是词法解析，`.context/tmp` 是 symlink/junction 时可绕过白名单。改用 `realpathSync()` 物理路径解析 candidate + safeRoot 双方，再做前缀比对，杜绝 symlink 穿透。

### ✨ 新功能

- **helper idle + wall 双层超时**（架构修正）。`--timeout-ms <N>`（默认 7200000ms = 2h）总 wall-time 安全网；新增 `--idle-timeout-ms <N>`（默认 600000ms = 10min）监控 stdout/stderr 任何 chunk，N ms 静默 → 判定 hung。正确的 "stuck" 信号是输出停滞，不是 wall-time 上限——之前 600s 默认在另一台机器误杀健康长任务。两者各传 `0` 禁用。
- **prompt-file auto-cleanup**。helper 读完 prompt 后自动删除 `<cwd>/.context/tmp/ccg-*` 白名单内的文件。配合 `.gitignore` 加 `.context/tmp/` 双重保险，避免 review/audit 类任务留下大量 prompt 残留。

### 📦 依赖（推荐升级）

- **`gemini@gemini-ccgx` 1.1.1+** — 同步加 idle/wall 双层超时 + Windows 进程树 kill (`taskkill /T /F`)，防 SIGTERM 单杀产生 `cmd.exe → gemini.cmd → node` 孙子孤儿。

---

## [2.1.0] - 2026-05-12 — ✨ gemini 改走 batch 直调（绕开 ACP），孤儿进程归零

### 🎯 为什么 2.1.0（一句话）

ACP broker 路径在 Windows + gemini-cli 0.40+ 实测稳定 hang（trivial 任务 5 分钟无输出），改走 gemini-cli `batch` 直调 entry，trivial 任务 29s 干净返、**新增孤儿进程 0**。

### ✨ 新功能

- **`gemini` 改走 `gemini-batch.mjs` 入口（绕开 ACP）**。`ccgx-call-plugin.mjs` 新增 `VENDOR_ENTRY_SCRIPTS` 注册表，gemini 优先走 fork plugin 新加的 `gemini-batch.mjs`（v1.1.0+ 的 gemini-plugin-cc），fallback 仍是 `gemini-companion.mjs`。BC 友好：旧 plugin 版本自动走老路径。
  - 实测：trivial 任务 ACP 5+ 分钟 hang → batch 29.4s 返回。
  - 孤儿进程：每次失败 5-10 个 MCP/broker 子进程 → **0**。
  - 治本机制：`gemini-cli` 直接子进程跑完 prompt 后干净退出，整条进程树自然 die；`--allowed-mcp-server-names __ccgx_no_mcp__` 让 settings.json 里的 MCP 不被加载，无 MCP children 可漏。
- **codex 单 cwd 跨仓库审计支持**。`--cwd <path>` flag 透传到 `codex-companion.mjs` 的 `task -C` 参数，让单次 helper 调用能审计 caller process.cwd 之外的仓库。

### 🐛 修复（1.0.5 回归）

- **`ccgx-call-plugin.mjs` 恢复 `--write` / `--model` / `--effort` flag 透传**。1.0.5 的"收敛 LLM 命令构造表面"过度精简，把这些必需 flag 也吃掉了，导致 codex 默认走 read-only sandbox（连 `Get-Content` / `rg --files` 这类只读命令都被 declined），任何审计/review 任务都立即 exit 1。
  - `--write`：默认开（保持 1.0.4 行为），传 `--no-write` 显式切回 read-only review 模式。
  - `--model <name>`：codex 主模型切换（gpt-5.5 等）。
  - `--effort <level>`：reasoning effort 控制（minimal/low/medium/high/xhigh）。
  - `--cwd <path>`：codex sandbox 是 cwd-bound 的，本 flag 让跨仓库审计可行（codex-companion 本身不暴露 `--add-dir`）。

### 🗑️ 清理

- **删除 `.ccg/` 下 28 个 v3.x/v4.x 内部 dogfood 残留文件**（roadmap、milestones、poc-v45）。这些是 rebrand 前从未发布到 npm 的开发期 artifact，权威归档在 `.ccg-migration/INTERNAL-DEV-LOG.md`。副作用：`SessionStart` hook 不再注入 "Project: ccg-workflow v4.5 | Phases: 8/8 completed" 这条让新会话困惑的横幅。

### 📦 依赖（推荐升级）

- **`gemini@gemini-ccgx` 1.1.0+** — 提供本版本依赖的 `gemini-batch.mjs` 入口。装的是 1.0.x 版本仍可工作（fallback 到 `gemini-companion.mjs`，但会撞 ACP hang）。

### 🔧 仅内部

- `ccgx-call-plugin.mjs` `discoverCompanion` 改为按 `VENDOR_ENTRY_SCRIPTS` 优先级链搜，首个 existing 文件胜出。

---

## [2.0.0] - 2026-05-11 — ✨ 主推 `gemini@gemini-ccgx` fork（ccgx-maintained）+ 完全向后兼容上游

### 🎯 产品策略转向（为什么 2.0.0）

技术上 fully backward-compatible —— 仍用 `gemini@google-gemini` 上游 + repatch 脚本的老用户**零改动继续工作**。但 ccgx 推荐路径从"上游 + repatch"转向"用 ccgx fork"，这是显著的架构信号，所以 major bump。

**fork**: <https://github.com/wzyxdwll/gemini-plugin-cc>（marketplace name `gemini-ccgx`）
- 把 P-1..P-21 + W1/W2/I1 全部 patch 作为永久 commit 合进源码
- 不需要 repatch 脚本
- 用 `claude plugin update gemini@gemini-ccgx` 拉新 patch
- 自带 6 个集成测试（tests/ccg-patches.test.mjs：cancel passthrough / cleanup / W1 fake-success regression）

### ✨ 优先级路由（核心改动）

`src/utils/plugin-bash-codegen.ts` 的 `VENDOR_MARKETPLACE_KEYS` 从单 key 改成 ordered list：

```ts
const VENDOR_MARKETPLACE_KEYS: Record<Vendor, string[]> = {
  codex: ['codex@openai-codex'],
  gemini: ['gemini@gemini-ccgx', 'gemini@google-gemini'],  // fork 优先 + 上游 fallback
}
```

`discoverCompanion` 遍历 keys，第一个在 `installed_plugins.json` 找到的赢。
`templates/scripts/ccgx-call-plugin.mjs` runtime helper 同步实现。

`buildPluginMissingFallback` 错误消息推荐 fork 安装路径：

```
# CCG: gemini plugin not installed at CCG install time.
# Install with:
#   claude plugin marketplace add wzyxdwll/gemini-plugin-cc
#   claude plugin install gemini@gemini-ccgx
```

### 📋 兼容性矩阵

| 用户场景 | 2.0.0 行为 |
|---|---|
| 装了 `gemini@gemini-ccgx`（推荐） | 自动用 fork，1 步安装，patch 永久 |
| 装了 `gemini@google-gemini`（上游） | Fallback 到上游，slash command 仍 work，需配 repatch 脚本 |
| 装了**两个**（罕见） | fork 优先 |
| 都没装 | fallback 错误消息推荐 fork |

### 🛠 文档 + 提示更新

- `templates/commands/{analyze,execute,optimize,plan,review}.md`：双 plugin 选项描述（fork 推荐 / 上游 BC）
- `src/commands/init.ts` 安装提示：推荐 fork + 上游 BC 提示
- `templates/scripts/invoke-model.mjs` exitMissingBackend：fork-first install hint
- `.ccg-migration/PLUGIN-PATCHES.md`：新加"2.0.0+ 推荐路径"章节 + fork vs 上游对比表
- README 等：（next minor，先保证核心 codepath 切换）

### 🧪 测试更新

`src/utils/__tests__/pluginBashCodegen.test.ts`：
- 现有 26 个测试 BC（上游路径 fallback 通过）
- 新增 3 个 fork-priority 测试：
  - "prefers gemini-ccgx fork over google-gemini upstream when both installed"
  - "fork-only install discovers correctly"
  - "upstream-only install still works (BC for non-fork users)"
- 共 29 个测试，0 fail

全套：50 文件，1358 测试，0 fail。

### 🔄 plugin-detection.ts

`PLUGIN_PREFIXES.gemini` 加 `'gemini-ccgx@'`，让 `challenger-orchestrator` 也认识 fork。

### 📦 repatch-gemini-plugin.mjs 状态

**保留**，专门给仍用上游 `gemini@google-gemini` 的用户。Plugin update 后他们继续跑这个脚本即可。CCG 2.0.0 不删除这条路径，**完全 BC**。

如果用户切到 fork，repatch 不需要再跑（fork 已自带所有 patch）。脚本会显示 `1 applied, 9 already-patched`（fork 已 patched）。

### 💡 升级建议

**新用户**：直接装 fork
```bash
claude plugin marketplace add wzyxdwll/gemini-plugin-cc
claude plugin install gemini@gemini-ccgx
```

**老用户（已装 `gemini@google-gemini`）**：可继续用，或迁移到 fork：
```bash
claude plugin disable gemini@google-gemini   # 避免 slash command 撞
claude plugin marketplace add wzyxdwll/gemini-plugin-cc
claude plugin install gemini@gemini-ccgx
```

ccgx 自动识别两种，slash command `/ccg:review` `/ccg:plan` 等都正常。

---

## [1.0.10] - 2026-05-11 — ✨ B2: gemini broker 真复用（治根因 R2）+ kill-orphans --stuck 兜底

### 🐛 治本: P-12 patch — `CLAUDE_PLUGIN_DATA` env 串台

**症状**：自 1.0.x 起 dogfood 上 gemini broker daemon **永远不复用**——每次 task 新建 broker，旧的全成孤儿。多会话调试发现 PID 30456 (gemini broker) 把 broker session 文件写到了 codex 的 plugin data dir：

```
C:\Users\Administrator\.claude\plugins\data\codex-openai-codex\state\<workspace>\acp-session\broker.pid
                                              ^^^^^^^^^^^^^^^^^^ 应该是 gemini-google-gemini
```

**根因**：`gemini/lib/state.mjs:51-54`（codex `state.mjs:41-42` 字面一致）信任上层 `CLAUDE_PLUGIN_DATA` env 算 stateRoot。Claude Code 主进程在 plugin 切换时不重设 env → 上次调 codex 留下的 env 串到下次调 gemini → broker 写到 codex 目录 → 下次 gemini-companion 找不到 broker session → 永远新建。

**修复**（已进 `repatch-gemini-plugin.mjs` P-12）：`gemini-companion.mjs` 在最后一个 import 之后插入 patch 块，从脚本物理路径反推 plugin data dir，无条件覆写 env：

```javascript
{
  const _scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const _versionDir = path.dirname(_scriptDir);
  // ... 5 层 dirname 上推到 plugins/
  process.env.CLAUDE_PLUGIN_DATA = path.join(_pluginsDir, "data", _pluginName + "-" + _marketplaceName);
}
```

block scope 包裹避免污染 module 作用域。verification: 跑 `repatch-gemini-plugin.mjs` 后 `Summary: 1 applied, 9 already-patched, 0 unmatched`，路径解析正确指向 `gemini-google-gemini`。

完整设计与上下文见 `.ccg-migration/PLUGIN-PATCHES.md` P-12。

### 🛠️ 兜底: `ccg kill-orphans --stuck` + `taskkill /F /T` 级联

**新增 `--stuck` 选项**：仅命中 stuck broker daemon（CPU/wall < 1% 且 wall > 5min），故意排除 companion / MCP（它们等远程 API 必然低 CPU）。判定限定在 `acp-broker | app-server-broker | broker-lifecycle` cmdline 命中的进程。

```
ccg kill-orphans --stuck             # dry-run，列卡死 broker
ccg kill-orphans --stuck --kill      # 真杀
```

**Windows kill 路径升级**：把 `taskkill /F /T` 提到第一位（级联杀子进程组），原来 `Stop-Process -Force` 不级联，broker 死了 ACP child 还活着。POSIX 同款 `kill -TERM -- -<pid>` 杀整组。

**采集 CPU 时间**：listNodeProcessesWindows 的 PowerShell 脚本加 `KernelModeTime + UserModeTime`（100ns 单位 / 1e7 → 秒）；POSIX 用 `ps -eo pid,etime,time,command` 多取一列 `time`。

新增 `src/commands/__tests__/killOrphans.test.ts`（13 用例）覆盖 isStuck 边界（5min/1% 阈值）+ isBrokerProcess 分支（broker 命中 / companion 不命中 / MCP 不命中 / dev-server 不命中）。

### 📋 文档化: P-14（broker idle timeout 缺失）

`acp-broker.mjs` / `app-server-broker.mjs` **两边都没** idle watchdog——broker 卡在 IPC syscall 后永远不退出。B2 决策下不进 repatch 脚本（multi-region 改动跟 P-10 同级 regex 风险），写到 `PLUGIN-PATCHES.md` P-14 等观察。如果 1.0.10 ship 后两周内仍频繁见 broker 卡死，1.0.11 再做。当前由 `ccg kill-orphans --stuck` 兜底。

### 🔍 诊断修正

之前 dogfood 报告说"`sendBrokerShutdown` 全仓无人调"——**错的**。`gemini/scripts/session-lifecycle-hook.mjs:118` 已经在 session 退出时调用，跟 codex `session-lifecycle-hook.mjs:13` 同款 hook 模式。"R3"实际不存在，本次不修改。

### 📊 多模型协作选型

1.0.10 范围用 codex + gemini plugin 各自独立评审拍板：
- codex 推 B3（治本，R1 + R2 一起做）
- gemini 推 B2（YAGNI，先修 R2 看实测）
- 最终采纳 B2 — 两边都同意 R2 必修；R1 multi-region patch 风险高，先验证 R2 修复后 broker 复用率再决定

---

## [1.0.9] - 2026-05-11 — 🐛 fix(kill-orphans): PowerShell 脚本拼接坏掉，listNodeProcesses 永远返空

### 🐛 1.0.5 起的隐藏 bug

`ccg kill-orphans` 自 1.0.5 ship 起在 Windows 上**完全无效**——dry-run 永远显示 `No node processes found`，且不会真杀任何东西。

**根因**（`src/commands/kill-orphans.ts:60-67`）：

```js
const ps = `Get-CimInstance ... | ForEach-Object {
    $cd = $_.CreationDate
    $h = if ($cd) { ... } else { 0 }
    $cmd = if ($_.CommandLine) ...
    "$($_.ProcessId)|$h|$cmd"
}`
out = execSync(`powershell -NoProfile -Command "${ps.replace(/\n\s+/g, ' ')}"`, ...)
```

`\n\s+` 把换行 + 缩进替换成**单个空格**，但 PowerShell 单行多语句必须用 `;` 分隔。结果脚本被 PowerShell 解析为：`$cd = ... $h = if ... $cmd = ...`，第二个 `$h` 被当成独立 token，报 "`$h` 不是内部或外部命令"（GBK 乱码）。错误被 try/catch 吞掉，函数返回空数组。

### ✨ 修复：改用 PowerShell -EncodedCommand

```js
const encoded = Buffer.from(ps, 'utf16le').toString('base64')
out = execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, ...)
```

PowerShell `-EncodedCommand` 接受 Base64 编码的 UTF-16LE 脚本，原样保留所有换行 / `$` / 引号——**完全绕开 cmd.exe 的字符串解析层**。这是 PowerShell 官方推荐的多行脚本传递方式。

顺手 polish：
- 脚本前置 `$ProgressPreference = 'SilentlyContinue'`，消掉首次加载 CimCmdlets 模块时输出到 stderr 的 CLIXML progress stream。
- `execSync` 改 `stdio: ['ignore', 'pipe', 'ignore']`，让残留 stderr 不再 leak 到终端。

### 📋 影响

- 1.0.5 / 1.0.6 / 1.0.7 / 1.0.8 在 Windows 上 `kill-orphans` 全部失效。POSIX 路径不受影响（`ps -eo` 那条没有这个 bug）。
- 没有 dev-server 误杀风险——函数返空 → 0 targets → 0 kills。但用户也没法用工具清理 broker / mcp 残留。

---

## [1.0.8] - 2026-05-11 — 🐛 CI hotfix: tests env-tolerant（1.0.7 已被占用）

1.0.7 npm 实际已 publish 但 CI 后续 push 撞测试 env 假设失败。版本号被 npm 锁，bump 1.0.8 重发。

测试改动：5 处 `bashCommand` assertion 改为 env-tolerant——接受 helper form (`ccgx-call-plugin.mjs`) **或** plugin-missing fallback (`not installed`) 任一，仍严格校验不含旧 glob hack / `<PROMPT>` 占位符。

设计 + 功能完全等同 1.0.7，仅版本号 + 测试修复。

---

## [1.0.7] - 2026-05-11 — 🔄 autonomous verify wave 也切 helper form（与 review 对齐）

### 🐛 1.0.6 遗漏：autonomous 路径还在用旧 glob 模式

1.0.6 修了 `templates/commands/review.md` 但 autonomous 的 verify wave 经过
`src/utils/verify-orchestrator.ts:buildBashDirectCommand` 生成 bashCommand，
该函数还在 emit 老的 inline glob hack：

```js
// 旧（1.0.6 遗漏）：
return `node "$(ls ~/.claude/plugins/cache/${vendor}/${plugin}/*/scripts/${scriptName} | head -1)" task -p "<PROMPT>" --json`
```

LLM 消费这条 bashCommand 时**会**：
1. cargo-cult 不可靠的 `ls | head -1` glob hack
2. 把 `<PROMPT>` 替换为 30KB+ diff → 撞 ARG_MAX

### ✨ 修复：delegate 到 plugin-bash-codegen.ts

`buildBashDirectCommand` 改为单行 delegate：

```ts
function buildBashDirectCommand(plugin: 'codex' | 'gemini'): string {
  return resolvePluginBashCommand(plugin)  // 1.0.5 helper-form
}
```

Helper form 输出：`node '<ccgx-call-plugin.mjs abs path>' codex --json`

LLM 追加 `--prompt-file <tmpfile>` 即可，tmpfile 含小任务描述（≤ 2KB）。

### 改动

- `src/utils/verify-orchestrator.ts`: `buildBashDirectCommand` 一行 delegate
- `src/utils/__tests__/verifyOrchestrator.test.ts`: 4 断言更新（companion.mjs → ccgx-call-plugin.mjs）+ 加 1 个 1.0.7 reverse 断言（不应含 `<PROMPT>` / glob）
- `src/utils/__tests__/qualityRouter.test.ts`: 1 断言对齐

### ✅ 验证

- `pnpm typecheck` ✓
- `pnpm test` ✓ **1342/1342**（+1 reverse 断言）

### 收敛轨迹（钉死）

| 版本 | 修了什么 |
|------|---------|
| 1.0.4 | review.md inline glob → install-time 渲染占位符 |
| 1.0.5 | LLM 替换 prompt → tmpfile + helper invocation |
| 1.0.6 | review.md 不塞 diff，codex/gemini 自己跑 git diff |
| **1.0.7** | **autonomous verify wave 同步切 helper form** |

整个多模型调用路径现在统一走 `ccgx-call-plugin.mjs` helper，无 glob hack、无 LLM 替换、无 ARG_MAX 风险。

---

## [1.0.6] - 2026-05-10 — 🔄 review/verify 不再塞 diff，让 codex/gemini 自己读

### 🐛 1.0.5 dogfood 撞墙：ARG_MAX

1.0.5 ship 后 dogfood 大 PR review 撞 OS argv ~32KB 上限：

```
$ node codex-companion.mjs task --json -p "<30KB diff + role prompt>"
/usr/bin/bash: line 5: /d/Program Files/nodejs/node: Argument list too long
```

`CreateProcess`(Win) / `execve`(POSIX) 的 argv size 限制是内核级 hard ceiling，**Node `spawn` 数组 args 也走同一 syscall，没法绕**。这不是 99% 边缘 case，而是任何稍大 PR 必撞的硬墙。

### 🎯 根因：架构错误

review.md 从 v3.x 时代起就在 inline 塞 diff——把"给 plugin 看的数据"作为 prompt body 传输。1.0.4 / 1.0.5 都在优化"**怎么把更大 prompt 塞进去**"，方向错了。

**正确架构**（跟 `/ccg:codex-exec` 同款）：主线给 codex/gemini 一个**小任务描述**（≤ 2KB），它们用自己的 Bash + Read 工具**自己跑 `git diff` 读源文件**——它们 task mode 下完整工具权限。

| | 错（1.0.x） | 对（1.0.6） |
|---|---|---|
| 主线传给 codex 的内容 | git diff 完整 30KB+ 内容 | 任务描述（"审 git diff HEAD"，~500 字节）|
| codex 怎么拿数据 | 从 prompt 读 | **codex 自己跑 git diff** |
| argv 大小 | 30KB → ARG_MAX 撞墙 | 永远 < 1KB |
| codex 工具使用 | 无 | 完整 Bash/Read |

### ✨ 改动

**`templates/commands/review.md`** 重写：
- "调用语法"段加「核心原则：主线不传输 diff 内容给 codex/gemini」前置
- "LLM 工作流"3 步改为：
  1. Write 任务描述（≤ 2KB，**只放说明 + 角色提示词路径 + 输出 schema**）到 tmpfile
  2. Bash `<占位符> --prompt-file <tmpfile>`
  3. Read JSON 解析
- 加"任务描述模板"——明确告诉 codex/gemini 自己跑 git diff
- Adversarial wave 同改：摘要前两轮 critical 项（≤ 500 字）传，不塞完整 review 输出
- Channel B fallback 同改：wrapper 经 stdin pipe 但 prompt 内容仍是任务描述
- Phase 2 实施段简化：从"传 git diff 内容"改"传任务描述 + codex 自读"

**`templates/commands/agents/interface-auditor.md`** 加 rule 6（critical）：
- 检测模板里 inline 嵌入 `<git diff 内容>` / `$(git diff)` / `cat *.diff.patch` 等模式
- 防回归到"塞 diff"反 pattern

**版本里程碑**：1.0.4 codegen + 1.0.5 helper + 1.0.6 task-description = 三步收敛到正确架构。

### ✅ 验证

- `pnpm typecheck` ✓
- `pnpm test` ✓ **1341/1341**
- `pnpm build` ✓
- review.md 实测：任务描述 ≤ 2KB，无 ARG_MAX 风险

### 🎯 设计哲学（First Principles）

> **数据应该被工具拿，不是塞进 prompt**。
>
> LLM 看到 prompt 里有数据 → 它把数据当上下文。LLM 看到 prompt 里有"去拿数据的指令" → 它用工具拿。两种模式 token 消耗差 100×，错误模式（hallucination / overflow）也完全不同。
>
> ccg-exec / phase-runner 一直走对路径。review/verify 我接手时没质疑既有 inline diff 设计，1.0.4/1.0.5 都在错的设计上叠 workaround。1.0.6 才是回归正确架构。

### 🔧 用户已撞 ARG_MAX 的 retry

老 review 用 codeagent-wrapper stdin 通道（Channel B）也是有效绕开方案——继续用没问题。1.0.6 升级后默认 Channel A 也不再撞。

---

## [1.0.5] - 2026-05-10 — 🔄 收敛 LLM 命令构造表面 + ccgx kill-orphans + 内部版本号清理

### 🐛 1.0.4 dogfood 暴露的问题

1.0.4 ship 后几小时 dogfood 撞两个 LLM-constraint 失效：
1. **设计阶段**：1.0.4 review.md 把反例代码当"禁止示例"完整写进模板。LLM 注意力机制对 negation 不可靠——看到完整可执行命令直接 cargo-cult，"禁止"前缀被忽略。
2. **运行阶段**：dogfood 项目里 LLM 在 1.0.x 模板下仍写 `ls $(...) | head -1` glob hack。即使 1.0.4 提供 heredoc + `{{CODEX_BASH_TASK}}` 占位符，只要 LLM 保留命令构造空间，就有 X% 概率自创变体。

**根因**：任何依赖 "LLM 读懂 / LLM 不抄 / LLM 替换正确" 的设计都不稳定。X 永远 > 0。

### ✨ 架构修正：把 LLM 命令构造表面降到接近零

新增 `templates/scripts/ccgx-call-plugin.mjs`（~270 行 Node helper）：
- LLM 调用面：`node <helper> <vendor> --json --prompt-file <tmpfile>`——只有 vendor + 文件路径两个变量
- helper 内部：从 `~/.claude/plugins/installed_plugins.json` SSoT 读 installPath，spawn array args（**完全无 shell**），统一输出 JSON
- 跟现有 `ccg-phase-runner-launcher.mjs` 同款架构

**模板占位符语义改写（破坏性兼容）**：

```
旧 1.0.4 heredoc form (LLM 替换 %PROMPT%):
  node 'C:/.../codex-companion.mjs' task --json -p "$(cat <<'CCG_PROMPT_EOF' ... CCG_PROMPT_EOF)"

新 1.0.5 helper form (LLM 追加 --prompt-file):
  node 'C:/.../ccgx-call-plugin.mjs' codex --json
```

LLM 工作流变为严格 3 步（review.md 已重写）：
1. Write tool 把 prompt 写入 `/tmp/ccg-codex-$JOB.txt`
2. Bash `<placeholder> --prompt-file /tmp/ccg-codex-$JOB.txt`
3. Read tool 取 stdout JSON，parse `result.stdout`

消除掉的 LLM 失误空间：抄旧 inline 风格 / 漏 heredoc 单引号 EOF / 路径硬编码错版本 / shell escape 全部不存在。

### ✨ 新命令：`ccgx kill-orphans`

清理 Claude Code 主 session 退出后残留的孤儿 node 进程（MCP server / codex CLI / gemini CLI / phase-runner）。

```
ccgx kill-orphans                        # dry-run，列 orphan 类别 + PID + 年龄
ccgx kill-orphans --kill                 # 实际终止
ccgx kill-orphans --min-age-hours 4      # 只清 >4h 的
```

3 层 kill 策略（Windows）：`Stop-Process -Force` → `taskkill /F` → `wmic process delete`（绕开 Stop-Process 在 IPC syscall 卡死时的 Access denied）。

**安全过滤**：自动跳过 dev-server 类（pnpm/npm/yarn run dev、vite、quasar、webpack、next、nuxt、astro、svelte-kit）——不杀用户真实 dev 进程。

根因：Claude Code 在 Windows 上没用 `JobObject + KILL_ON_JOB_CLOSE`，主进程死亡后 child 全部成孤儿。这是 Claude Code 上游 bug，CCG 提供这个工具作为 user-side 缓解。

### 🧹 内部版本号清理

`v3.x / v4.x` 是开发期内部 dogfood 里程碑代号，**从未发布到 npm**。这次清理：

- **CHANGELOG.md 公私拆轨**：CHANGELOG.md 只留 1.0.x 公共发布；v3.x / v4.x dogfood 历史归档到 `.ccg-migration/INTERNAL-DEV-LOG.md`（3678 行）
- **删除 5 个内部 migration docs**：`.ccg-migration/v*-to-v*.md`（git 历史保留，不再 ship）
- **templates 全清**：~33 文件中 200+ v[34].x 引用清理——保留 design rationale 删版本号 stamp
- **interface-auditor 反例代码删除**：rule 5 描述里的完整 inline 命令删除，改抽象描述（防 LLM cargo-cult）
- **review.md 反例代码删除**：1.0.4 写进去的"禁止示例"完整命令删除
- **DEPRECATIONS.md 简化** / **PLUGIN-PATCHES.md 局部清理** / **根 CLAUDE.md 变更记录段大瘦身**（400+ 行 → 5 行指针）

### ✅ 验证

- `pnpm typecheck` ✓
- `pnpm test` ✓ **1341/1341**
- `pnpm build` ✓

### 🎯 设计哲学（First Principles）

> 任何依赖"LLM 读懂、LLM 不抄、LLM 替换正确"的设计都有 X% 失败率，X > 0。
>
> 1.0.4 install-time 渲染 placeholder + heredoc 解决了**部分**问题（shell escape）但留 LLM 替换 `%PROMPT%` 的空间，dogfood 撞翻。
>
> 1.0.5 把 LLM 命令构造空间收到**接近零**——只有 vendor + tmpfile 路径两个变量，所有路径解析、参数构造、shell escape 由 Node helper 内部完成。helper 内部用 spawn array args，**完全没有 shell 层**。
>
> 跟 `ccg-phase-runner-launcher.mjs`（autonomous 长跑用）同款架构——**架构一致性最高**的方案。

---

## [1.0.4] - 2026-05-10 — 🛡 plugin Bash codegen + P-9 错误透出 + P-10/P-11 文档化

### ✨ 架构升级（核心）

- **plugin Bash 命令 install-time 渲染**（codex 审计 NO-GO 后重做）：模板里 `node "$(ls ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs | head -1)" task -p "..." --json` 这种 inline 拼接 + glob hack 全替换为 4 个 install-time 占位符：
  - `{{CODEX_BASH_TASK}}` / `{{CODEX_BASH_TASK_TEXT}}`
  - `{{GEMINI_BASH_TASK}}` / `{{GEMINI_BASH_TASK_TEXT}}`
  - 安装时从 plugin SSoT (`~/.claude/plugins/installed_plugins.json`) 读真实 installPath，渲染**完整 literal Bash 命令字符串**注入模板
  - 用 heredoc-with-quoted-EOF 包裹 prompt body，LLM 替换 `%PROMPT%` 时**零 escape 负担**（`$ ' " \` 全字面量）
  - plugin 未装时 fallback 到清晰错误命令（exit 1 + stderr "plugin not available"），不静默坏掉
- **新文件 `src/utils/plugin-bash-codegen.ts`**（~180 行 + 26 单测）：
  - `discoverCompanion(vendor, homeDir?)` — 从 SSoT 读取，返回 `{installPath, companionPath, version}`
  - `buildBashCommand(loc, opts?)` — 渲染 literal 命令
  - `shellQuotePosix(s)` — POSIX 单引号 escape（兼容 Git Bash on Win + bash on POSIX）
  - `resolvePluginBashCommand(vendor, opts?, homeDir?)` — 顶层入口（installer 用）
- **`src/utils/installer-template.ts:injectConfigVariables`** 扩展：新增 4 个占位符的 install-time 替换路径
- **`templates/commands/review.md`** 改写 3 处 inline 命令：
  - 阶段 2 backend codex review → `{{CODEX_BASH_TASK}}`
  - 阶段 2 frontend gemini review → `{{GEMINI_BASH_TASK}}`
  - 阶段 2.5 adversarial review → `{{CODEX_BASH_TASK}}`（prompt 内嵌 `--adversarial-review` 前缀）
- **`templates/commands/agents/interface-auditor.md`** 加第 5 项检查 rule（critical）：检测模板里 inline `node ... companion.mjs ... task -p` 命令 → BLOCKER。防回归。

### 🐛 plugin patches（gemini 1.0.1）

- **P-9 已 patch + 已加进 repatch 脚本**（`templates/scripts/repatch-gemini-plugin.mjs`）：
  - `lib/acp-client.mjs:95` 的 `pending.reject(message.error)` 改为 wrap Error 实例 + 保留 `jsonrpcCode/jsonrpcData` 附加属性
  - 修复"`[object Object]` 错误黑洞"——所有 broker 死亡 / auth 过期 / RPC 异常的真错误现在透出
  - 这是**诊断使能 patch**，所有其他 plugin bug 修了它才能拿到真错误
- **P-10 (broker pendingQueue) + P-11 (ACP `protocolVersion`) 文档化**到 `.ccg-migration/PLUGIN-PATCHES.md`：
  - 标"已知 manual patch，未进 repatch 脚本"——multi-region 编辑、regex guard 风险高
  - 等 gemini-cli + plugin 双方 spec 稳定后再纳入

### 📝 设计哲学（First Principles）

> codex 审计第一轮 NO-GO 提案后，根本论点：**模板是 prompt 文本，LLM 看到「helper 函数调用」必然在脑子里"扮演这个 helper"——参数漂移问题没消除，只是从 Bash flag 维度漂移到 helper opts 维度漂移**。
>
> 1.0.4 正确武器：install-time codegen → literal command string 注入模板 → LLM 看到的是「copy 这段 + 替换 %PROMPT%」，**零参数自由发挥空间**。
>
> 跟 CCG 已有的模板变量系统（`{{FRONTEND_PRIMARY}}` / `{{MCP_SEARCH_TOOL}}` 等）哲学一致：**安装时计算、运行时零猜测**。

### ✅ 验证

- `pnpm typecheck` ✓
- `pnpm test` ✓ **1341/1341**（1315 + 26 新增 codegen 用例）
- review.md 实测：placeholder 注入后命令完整可读，heredoc safe pattern

### 📊 改动统计

| 文件 | 类型 | LOC |
|------|------|-----|
| `src/utils/plugin-bash-codegen.ts` | 新增 | ~180 |
| `src/utils/__tests__/pluginBashCodegen.test.ts` | 新增 | ~210 |
| `src/utils/installer-template.ts` | 扩展 | +35 |
| `templates/commands/review.md` | 重写 3 处 inline | +15 / -25 |
| `templates/commands/agents/interface-auditor.md` | 加 rule 5 | +35 |
| `templates/scripts/repatch-gemini-plugin.mjs` | P-9 patch entry | +12 |
| `.ccg-migration/PLUGIN-PATCHES.md` | P-9/P-10/P-11 文档 | +220 |
| `~/.claude/plugins/cache/google-gemini/...acp-client.mjs` | 用户机器 P-9 已应用 | +14 |

### 🎯 下游收益

- 未来 plugin 故障的真错误**能看见**了（不再 `[object Object]`）
- 模板维护者**没机会编 Bash flag** —— install-time 渲染卡死
- multi-version plugin cache 路径解析**确定性**——SSoT 直接给 installPath，不靠 glob
- interface-auditor 守门——回归到 inline 拼接立刻 BLOCKER

---

## [1.0.3] - 2026-05-09 — 💰 phase-runner budget cap ×50 调高（消除"贴顶失败"假阳性）

### 🔄 变更

- **phase-runner `--max-budget-usd` 三档默认 ×50**：
  - `fast`：$1 → **$50**
  - `triple`：$2 → **$100**
  - `debate`：$5 → **$250**
- **背景**：早期 PoC baseline 1/2/5 是按"单次 phase-runner spawn 真实 cost p90 + 50% 余量"算的，但 dogfood 实测有 $1.034 这种**贴顶失败**——比 cap 高 3.4¢ 不是 runaway，是 phase 本身略复杂。1/2/5 把"cap = runaway 抓拍"和"cap = 复杂度上限"两个职责合一，导致正常 phase 误报为 failed。50/100/250 把 cap 拉远到只抓真 runaway（一个 stuck loop 几分钟就能烧 $100+），保留 fail-fast 信号机制不变。
- **首要 first-principles 论点**：cap 不是钱包保护，是**循环失控信号**。给更多预算 ≠ 更可能成功，runaway loop 在 $1 / $50 / $500 都是同样的"原地打转"。提高 cap 后那条信号阈值依然有效，只是 false-positive 大幅降低。

### 📝 改动文件

- `templates/scripts/ccg-phase-runner-launcher.mjs`：`TIER_BUDGET` 常量 + help 文案
- `src/utils/quality-router.ts`：`PHASE_RUNNER_BUDGET_USD` + 文档注释
- `src/utils/__tests__/buildPhaseRunnerBashCommand.test.ts`：5 处 cap 断言更新
- `src/utils/__tests__/launcherSupervisor.test.ts`：`TIER_BUDGET` deepEqual + tier→budget loop expected

### ✅ 验证

- `pnpm typecheck` ✓
- `pnpm test` ✓ **1315/1315**

### 🔧 用户已撞 cap 的 retry 路径

老 cap 下被标 failed 的 phase（如 P5 $1.034 撞 $1）现在直接重跑就行：

```bash
/ccg:autonomous --only=phase-NN-<slug>
```

新 cap $50 留 50× 余量，正常复杂度的 phase 不会再贴顶。

---

## [1.0.2] - 2026-05-09 — 🐛 Hotfix: phase-runner CLI 自我引用循环（2-min idle 零产出）

### 🐛 修复

- **phase-runner CLI 自我引用循环**：launcher 启动的 `claude -p --agent ccg/phase-runner` 子进程会在启动时触发自身的 `SessionStart` hook（`templates/hooks/ccg-session-state.cjs`）。hook 把"主线编排者"视角的 project memory（`Project memory restored / Active phase / Phases X/Y completed`）和 reconciler 摘要注入这个本应聚焦于单 phase prompt 的子进程，导致 LLM 误判"有个 running job 在跑"，跑 `/ccg:status` 看到自己 `cli_pid` 活着 → 阻塞等待 → Claude CLI 默认 2 分钟 idle 无输出 → 自终止零产出。launcher 拿到非零 exit，job 被 reconciler 标 stale。
  - **修复**：hook `main()` 入口检测 launcher 注入的两个 env 标识 `CCG_JOB_ID` + `CCG_PHASE_RUNNER_TIER`，识别为 phase-runner CLI 子进程时直接 emit `{}` 退出，不读 roadmap、不跑 reconciler、不注入 additionalContext。子进程从此只看到 launcher 给的 phase prompt，与主线编排者视角解耦。
  - **defense-in-depth**：`reconcileStaleJobs` 加 `state.cli_pid === process.pid` 自识别 short-circuit。早出 main() 已让常规路径走不到这里，这条仅作未来代码迁移的安全网。
  - 涉及文件：`templates/hooks/ccg-session-state.cjs`（+30 行 / 1 helper `isPhaseRunnerSubprocess`）+ `src/utils/__tests__/sessionStateHook.test.ts`（+50 行 / 6 新 case）

### ✅ 验证

- `pnpm typecheck` ✓
- `pnpm test` ✓（新增 6 case）
- 现存卡死 jobs：reconciler 在下次 SessionStart 自动 stale-mark，无需手动清理

### 📝 设计哲学（First Principles）

SessionStart hook 的「project memory restoration」服务的是**主线编排者**——一个需要跨 `/clear` 跨 session 续接 roadmap 的角色。phase-runner CLI 子进程是「被全权委派单 phase 的执行者」，它的 prompt 已自包含（phase_id / phase_goal / acceptance），不需要也不应该看到 roadmap 视角。**`SessionStart` hook 默认对每个 claude session 无差别 fire，是把「角色感知」职责推给了 hook 自己**——这是这次 bug 的结构性原因。修复用 launcher 已注入的 env 标识做「我是哪个角色」的判定，下游 hooks 应共享这个标识共识。


## [1.0.1] - 2026-05-09 — chore: drop dead Go binary infra + fail-friendly fallback

Dropped the Go-compiled `codeagent-wrapper` infrastructure (binary download, version alignment, CI cross-compilation). `~/.claude/bin/codeagent-wrapper` is now a Node ESM shim forwarding to `~/.claude/.ccg/scripts/invoke-model.mjs` (~870 lines, no external deps). Package size 16.3 MB → ~200 KB.

## [1.0.0] - 2026-05-09 — 🚀 Rebrand to ccgx-workflow

Successor to `ccg-workflow`. Public npm version space starts here. The internal dogfood / development history (v3.x, v4.x) is archived in [`.ccg-migration/INTERNAL-DEV-LOG.md`](./.ccg-migration/INTERNAL-DEV-LOG.md) for engineering reference; those versions were never published to npm and have no upgrade path for users.

---

## 链接

- [GitHub Repository](https://github.com/wzyxdwll/ccgx-workflow)
- [npm Package](https://www.npmjs.com/package/ccgx-workflow)
- [Internal Dev Log (pre-rebrand archive)](./.ccg-migration/INTERNAL-DEV-LOG.md)
