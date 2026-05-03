# MCP 配置

MCP 工具让 Claude Code 的代码搜索更聪明。不配也能用，配了体验好很多。

```bash
npx ccg-workflow menu  # 选「配置 MCP」
```

## 代码检索工具（选一个就行）

### ace-tool

基于 Augment Code 的语义搜索。搜代码的时候不是傻找关键字，而是理解你想找什么。

需要 Augment Code 账号。没有的话可以用[第三方中转](https://acemcp.heroman.wtf/)。

### fast-context

Windsurf 的 Fast Context。不需要给整个仓库建索引就能搜，速度快。

需要 Windsurf 账号。

### ContextWeaver

完全本地运行的混合搜索（Embedding + Rerank）。不用联网，但需要硅基流动 API Key（免费注册就有）。

## 辅助工具（可选）

- **Context7** — 查最新的库文档。初始化时自动装好，不用管。
- **Playwright** — 浏览器自动化和测试。
- **DeepWiki** — 知识库查询。
- **Exa** — 搜索引擎，需要 API Key。

## MCP 同步

配好 MCP 之后，CCG 会自动把配置同步到 Codex 和 Gemini：

- Codex 同步到 `~/.codex/config.toml`
- Gemini 同步到 `~/.gemini/settings.json`

这样 `/ccg:codex-exec` 的时候 Codex 也能直接用 MCP 搜索代码，不用你单独配。

## 自动授权

CCG 装好后会自动配一个 Hook，让 `codeagent-wrapper` 的命令不用每次都手动确认。需要装 [jq](https://jqlang.github.io/jq/)。

::: details v1.7.71 之前需要手动配

在 `~/.claude/settings.json` 里加：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_input.command' 2>/dev/null | grep -q 'codeagent-wrapper' && echo '{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"permissionDecision\": \"allow\", \"permissionDecisionReason\": \"codeagent-wrapper auto-approved\"}}' || true",
            "timeout": 1
          }
        ]
      }
    ]
  }
}
```
:::

## 出问题了？

```bash
npx ccg-workflow diagnose-mcp
```

这个命令会检查你的 MCP 配置哪里不对。
