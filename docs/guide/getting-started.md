# 快速开始

## CCG 是什么

一句话：**Codex 和 Gemini 负责分析，Claude 负责写代码。全程透明。**

```
你的需求
   │
   ↓
Claude Code (编排 + 写代码)
   │
   ├── 后端相关 → 发给 Codex 分析
   ├── 前端相关 → 发给 Gemini 分析
   │
   ↓
Codex/Gemini 返回分析结果（Patch / 方案）
   │
   ↓
Claude 综合分析结果，写入代码 ← 你能看到每一行改动
```

**关键点**：默认模式下最终写代码的是 Claude，不是黑盒——你在 Claude Code 里能看到完整的改动过程。Codex 和 Gemini 是"参谋"，不直接碰你的文件。

还有一种 **codex-exec 模式**：让 Codex 来写代码，写完后 Claude + Gemini 多模型交叉审查。适合目标明确的任务，token 消耗更低。详见[工作流指南](/guide/workflows)。

## 需要什么

- **Node.js 20+** — 低于 20 会报错，不要问为什么（`ora@9.x` 的锅）
- **Claude Code CLI** — 没有这个什么都跑不了
- **jq** — 自动授权 Hook 要用
- **Codex CLI** — 可选，装了才有后端路由
- **Gemini CLI** — 可选，装了才有前端路由

## 装上

```bash
npx ccg-workflow
```

第一次跑会让你选语言，选完就不问了。

### jq 怎么装

::: code-group

```bash [macOS]
brew install jq
```

```bash [Debian / Ubuntu]
sudo apt install jq
```

```bash [RHEL / CentOS]
sudo yum install jq
```

```bash [Windows]
choco install jq
# 或者
scoop install jq
```

:::

### Claude Code 怎么装

```bash
npx ccg-workflow menu  # 里面有「安装 Claude Code」选项
```

npm、homebrew、curl、powershell、cmd 都支持。

## 试一下

装完后，在 Claude Code 里输入：

```
/ccg:frontend 给登录页加个暗色模式切换按钮
```

看到 Gemini 被调用，说明一切正常。

## 更新和卸载

```bash
# 更新
npx ccg-workflow@latest

# 卸载
npx ccg-workflow  # 选「卸载工作流」
```

## 然后呢

- [命令参考](/guide/commands) — 28 个命令，总有你用得上的
- [工作流指南](/guide/workflows) — 什么场景用什么工作流
- [MCP 配置](/guide/mcp) — 让代码搜索更聪明
