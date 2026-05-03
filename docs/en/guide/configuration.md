# Configuration

## Where things live after install

```
~/.claude/
├── commands/ccg/       # 28 command templates
├── agents/ccg/         # 4 sub-agents
├── skills/ccg/         # Quality checks + multi-agent orchestration
├── bin/codeagent-wrapper
└── .ccg/
    ├── config.toml     # CCG config
    └── prompts/
        ├── codex/      # 6 Codex role prompts
        └── gemini/     # 7 Gemini role prompts
```

## Environment variables

Set these in `~/.claude/settings.json` under `"env"`:

| Variable | What it does | Default | When to change |
|----------|-------------|---------|----------------|
| `CODEAGENT_POST_MESSAGE_DELAY` | Seconds to wait after Codex finishes | `5` | Process hangs? Set to `1` |
| `CODEX_TIMEOUT` | Total wrapper timeout (seconds) | `7200` | Very large tasks |
| `BASH_DEFAULT_TIMEOUT_MS` | Bash command timeout (ms) | `120000` | Commands timing out |
| `BASH_MAX_TIMEOUT_MS` | Bash max timeout (ms) | `600000` | Slow builds |

::: details Full settings.json example

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

## What's hardcoded

Since v1.7.0, these are fixed:

- Frontend model = Gemini (genuinely better at UI/CSS)
- Backend model = Codex (genuinely better at logic/debugging)
- Collaboration mode = smart
- All 28 commands installed

We locked these down because testing showed this combo works best. If you disagree, open an Issue — happy to discuss.

## Utilities

```bash
npx ccg-workflow menu  # Select "Tools"
```

- **ccusage** — See how much your Claude Code sessions cost
- **CCometixLine** — Git info + usage tracking in your status bar

## FAQ

**Codex finishes but the process won't exit**

Set `CODEAGENT_POST_MESSAGE_DELAY` to `1`. Known issue with Codex CLI 0.80.0 in `--json` mode.

**Node 18 throws SyntaxError**

Upgrade to Node 20+. `ora@9.x` uses Node 20 syntax.

**MCP tools not responding**

Run `npx ccg-workflow diagnose-mcp`.

**Can't find Agent Teams commands**

Add `"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"` to your settings.json env. It's still experimental.
