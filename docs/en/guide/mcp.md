# MCP Configuration

MCP tools make Claude Code's code search smarter. Not required, but the experience is noticeably better with them.

```bash
npx ccg-workflow menu  # Select "Configure MCP"
```

## Code retrieval (pick one)

### ace-tool

Semantic code search powered by Augment Code. It doesn't just grep keywords — it understands what you're looking for.

Needs an Augment Code account. No account? Try the [third-party proxy](https://acemcp.heroman.wtf/).

### fast-context

Windsurf's Fast Context. AI-powered search that doesn't need to index your entire repo. Fast.

Needs a Windsurf account.

### ContextWeaver

Fully local hybrid search (Embedding + Rerank). Works offline. Needs a SiliconFlow API Key (free to sign up).

## Optional tools

- **Context7** — Fetches latest library docs. Auto-installed, zero config.
- **Playwright** — Browser automation and testing.
- **DeepWiki** — Knowledge base queries.
- **Exa** — Search engine, needs API Key.

## MCP sync

After you configure MCP, CCG auto-syncs the config to Codex and Gemini:

- Codex: `~/.codex/config.toml`
- Gemini: `~/.gemini/settings.json`

So when you run `/ccg:codex-exec`, Codex can use MCP search directly. No extra setup.

## Auto-authorization

After installation, CCG sets up a Hook so `codeagent-wrapper` commands don't need manual confirmation every time. Requires [jq](https://jqlang.github.io/jq/).

::: details Manual setup (before v1.7.71)

Add to `~/.claude/settings.json`:

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

## Something not working?

```bash
npx ccg-workflow diagnose-mcp
```

This checks what's wrong with your MCP setup.
