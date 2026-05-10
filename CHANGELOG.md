# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
