# 配置说明

## 装完之后文件在哪

```
~/.claude/
├── commands/ccg/       # 28 个命令模板
├── agents/ccg/         # 4 个子智能体
├── skills/ccg/         # 质量检查 + 多 Agent 协同
├── bin/codeagent-wrapper
└── .ccg/
    ├── config.toml     # CCG 配置文件
    └── prompts/
        ├── codex/      # 6 个 Codex 角色提示词
        └── gemini/     # 7 个 Gemini 角色提示词
```

## 环境变量

在 `~/.claude/settings.json` 的 `"env"` 里配：

| 变量 | 干什么 | 默认值 | 什么时候改 |
|------|--------|--------|-----------|
| `CODEAGENT_POST_MESSAGE_DELAY` | Codex 跑完后等几秒 | `5` | 进程卡住不退出就改成 `1` |
| `CODEX_TIMEOUT` | wrapper 总超时 | `7200` | 特别大的任务改大点 |
| `BASH_DEFAULT_TIMEOUT_MS` | Bash 命令超时 | `120000` | 命令跑超时就改大 |
| `BASH_MAX_TIMEOUT_MS` | Bash 最大超时 | `600000` | 构建特别慢就改大 |

::: details 完整 settings.json 示例

```json
{
  "env": {
    "CODEAGENT_POST_MESSAGE_DELAY": "1",
    "CODEX_TIMEOUT": "7200",
    "BASH_DEFAULT_TIMEOUT_MS": "600000",
    "BASH_MAX_TIMEOUT_MS": "3600000"
  }
}
```
:::

## 哪些不能改

v1.7.0 之后这些写死了：

- 前端模型 = Gemini（它 UI/CSS 确实强）
- 后端模型 = Codex（算法和调试它擅长）
- 协作模式 = smart
- 命令 = 全部安装

不提供自定义是因为测下来这个组合效果最好。如果你觉得不对，欢迎开 Issue 讨论。

## 实用工具

```bash
npx ccg-workflow menu  # 选「实用工具」
```

- **ccusage** — 看看你的 Claude Code 花了多少钱
- **CCometixLine** — 状态栏上显示 Git 信息 + 用量

## 常见问题

**Codex 跑完了但进程不退出**

`CODEAGENT_POST_MESSAGE_DELAY` 设成 `1`。这是 Codex CLI 0.80.0 在 `--json` 模式下的已知问题。

**Node 18 报 SyntaxError**

升级到 Node 20+。`ora@9.x` 用了 Node 20 的语法。

**MCP 工具没反应**

跑一下 `npx ccg-workflow diagnose-mcp`。

**Agent Teams 命令找不到**

在 settings.json 里加 `"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"`。这还是实验特性。
