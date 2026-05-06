# 从 ccg-workflow 迁移到 ccgx-workflow

> 适用于使用过 [`ccg-workflow`](https://www.npmjs.com/package/ccg-workflow) v1.x – v3.x 的老用户。

## TL;DR

```bash
npm uninstall -g ccg-workflow            # 如有全局安装
npx ccgx-workflow                        # 重新初始化
```

`/ccg:*` 命令、`.context/` 状态、`.ccg/roadmap.md` 全部兼容，无需改代码或重建项目状态。**CLI 命令名仍为 `ccg`**，肌肉记忆零成本保留。

---

## 为什么迁移

`ccg-workflow` 公开版本截止在 v3.x（2026-05），原作者 `fengshao1227` 此后停止更新且 GitHub 主页失联。

如果你正在使用：
- **codex / gemini plugin 路径**——上游 v3.x 不支持 plugin 调用，依赖 16.3 MB Go binary `codeagent-wrapper`
- **Windows + Gemini plugin**——v1.0.1 有 8 处 spawn bug，闪 cmd 黑窗 + ENOENT 错误
- **多 phase 自治长跑**——v3.x 串行 phase，没有 wave 并行 / cascade skip / 进程隔离
- **大型项目（5+ phase milestone）**——v3.x 主进程会持续吃内存（uni-iam 实测撞 23GB）

ccgx-workflow 把这些都治了。详见 [README "与 ccg-workflow 的关系" 段](./README.zh-CN.md#与-ccg-workflow-的关系)。

---

## 迁移步骤

### 1. 卸载老版本（可选）

```bash
# npm 全局安装的老用户
npm uninstall -g ccg-workflow

# npx 用户：跳过此步，npx 不会持久安装
```

### 2. 安装 ccgx-workflow

```bash
npx ccgx-workflow
```

首次运行会引导：
- 选语言（中 / 英）
- 选 API 提供方（302.AI / Anthropic 官方 / 跳过）
- 选 MCP 工具（fast-context 推荐 / ace-tool / ContextWeaver）
- 是否安装 Claude Code（npm / homebrew / curl / powershell / cmd）

如果你之前已经配过 `~/.claude/settings.json`，安装器会**保留你的现有配置**，只追加新的 ccgx-workflow 必需项。

### 3. 安装 codex / gemini plugin（强烈推荐）

ccgx-workflow 默认走 plugin spawn 路径（性能 + 隔离都更好）。在 Claude Code 里：

```
/plugin install codex@openai-codex
/plugin install gemini@google-gemini
```

不装 plugin 也能用——会 fallback 到 `codeagent-wrapper`。

### 4. 修补 Gemini plugin Windows 问题（仅 Windows）

```bash
node ~/.claude/.ccg/scripts/repatch-gemini-plugin.mjs
```

详见 [README "Gemini plugin Windows 已知问题" 段](./README.zh-CN.md#️-gemini-plugin-windows-已知问题强烈建议-patch)。

---

## 你不需要改的东西

下列状态文件与目录结构在 ccgx-workflow 中**完全兼容**，迁移后可以直接复用：

| 路径 | 说明 |
|------|------|
| `.ccg/roadmap.md` | 项目 phase milestone 表 |
| `.ccg/state.md` | 自治长跑断点续跑状态 |
| `.context/<phase>/CONTEXT.md` / `SUMMARY.md` | phase 工作记忆 + 元状态 |
| `.context/codebase/` 七文件 | codebase-mapper 产出 |
| `.context/jobs/<id>/` | 异步任务三件套数据 |
| `.context/debug/<slug>.md` | debug session 持久 hypothesis 链 |
| `openspec/` | OPSX 规范状态 |
| `~/.claude/commands/ccg/` | `/ccg:*` 斜杠命令面板 |
| `~/.claude/agents/ccg/` | 子智能体 |
| `~/.claude/skills/ccg/` | 技能文件 |

升级安装器会就地更新对应模板，旧的 phase 状态 / debug session / job 记录全部保留可用。

---

## 你需要注意的破坏性变化

> **没有破坏性变化**。`/ccg:*` 命令面板、文件契约、frontmatter 字段全部兼容 v3.x。

唯一行为差异：

### `/ccg:autonomous` 默认变成 `--quality=triple`

v3.x：单 wave 实施。
ccgx-workflow v1.0：默认 `triple` 档（4 wave：Plan + Critic + Impl + Verify）。

要复现 v3.x 行为：`--quality=fast` 即可。

```bash
/ccg:autonomous --quality=fast      # 等价 v3.x 单 wave
/ccg:autonomous                     # 默认 triple，4 wave
/ccg:autonomous --quality=debate    # 7 wave，含 3 轮辩论
```

per-phase 也可在 `.ccg/roadmap.md` 的 phase frontmatter 加 `Quality: debate` 覆盖 CLI flag。

### 命令面板有 5 个删了

v3.x 里这些命令在 v4.x 内部迭代中已合并 / 退化为 skill：

| 旧命令 | 替代 |
|--------|------|
| `/ccg:frontend` | `/ccg:workflow` 自动路由前端 |
| `/ccg:backend` | `/ccg:workflow` 自动路由后端 |
| `/ccg:feat` | `/ccg:workflow` 智能识别 |
| `/ccg:forensics` | skill 关键词触发，或用 `/ccg:autonomous` 包装 |
| `/ccg:extract-learnings` | skill 关键词触发 |

v3.x 用户如果有自动化脚本调用上述命令，请改写成 `/ccg:workflow`。

### `/ccg:verify-{change,quality,security,module}` 4 个 verify 子命令合并

v3.x：4 个独立命令。
ccgx-workflow：合并为 `/ccg:verify --gate=<change|quality|security|module|all>`。

旧命令仍以 BC 形式保留可用，但 deprecated，建议改用统一入口。

---

## 卸载 ccgx-workflow

```bash
npx ccgx-workflow                    # 选「卸载」交互式清理
npm uninstall -g ccgx-workflow       # 全局 npm 用户
```

卸载会移除：
- `~/.claude/commands/ccg/` 目录
- `~/.claude/agents/ccg/` 目录
- `~/.claude/skills/ccg/` 目录（v1.7.75+ 命名空间隔离，不会误删用户自建 skill）
- `~/.claude/.ccg/` 目录
- `~/.claude/bin/codeagent-wrapper` binary（如有）
- `~/.claude/settings.json` 中由 ccgx-workflow 注入的 hook / 权限白名单条目

不会移除：
- 你的项目 `.ccg/` 与 `.context/` 目录（项目状态自管）
- 你自定义的 `~/.claude/skills/<your-namespace>/` 目录
- 你的 `~/.claude.json` MCP 配置

---

## 反馈

迁移过程遇到问题或遗漏的兼容性项，欢迎在 [GitHub Issues](https://github.com/wzyxdwll/ccgx-workflow/issues) 提交，**附 v3.x 版本号 + 报错信息 + 你的 OS** 最有助于定位。
