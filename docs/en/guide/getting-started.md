# Getting Started

## What is CCG

In short: **Codex and Gemini analyze. Claude writes the code. Fully transparent.**

```
Your request
   │
   ↓
Claude Code (orchestration + code writing)
   │
   ├── Backend related → sent to Codex for analysis
   ├── Frontend related → sent to Gemini for analysis
   │
   ↓
Codex/Gemini return analysis (patches / proposals)
   │
   ↓
Claude synthesizes and writes the code ← you see every change
```

**The key point**: by default, Claude is the one writing code — not a black box. You see the full process in Claude Code. Codex and Gemini are "advisors" that never directly touch your files.

There's also **codex-exec mode**: Codex writes the code instead, then Claude + Gemini do multi-model cross-review. Good for well-defined tasks with lower token cost. See [Workflow Guide](/en/guide/workflows).

## What you need

- **Node.js 20+** — Below 20 will break (`ora@9.x` requires it)
- **Claude Code CLI** — Nothing works without this
- **jq** — For the auto-authorization hook
- **Codex CLI** — Optional. Enables backend routing
- **Gemini CLI** — Optional. Enables frontend routing

## Install

```bash
npx ccg-workflow
```

First run asks you to pick a language. After that, it remembers.

### Installing jq

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
# or
scoop install jq
```

:::

### Installing Claude Code

```bash
npx ccg-workflow menu  # Look for "Install Claude Code"
```

Works with npm, homebrew, curl, powershell, and cmd.

## Try it out

After installing, type this in Claude Code:

```
/ccg:frontend add a dark mode toggle to the login page
```

If you see Gemini being called, you're good.

## Updating and uninstalling

```bash
# Update
npx ccg-workflow@latest

# Uninstall
npx ccg-workflow  # Select "Uninstall"
```

## What's next

- [Command Reference](/en/guide/commands) — All 28 commands
- [Workflow Guide](/en/guide/workflows) — Which workflow for which scenario
- [MCP Configuration](/en/guide/mcp) — Smarter code search
