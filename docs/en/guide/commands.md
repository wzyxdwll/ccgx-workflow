# Command Reference

28 commands, all prefixed with `/ccg:`. Grouped by purpose.

## The workhorses

The ones you'll use most. Frontend tasks go to Gemini, backend tasks to Codex, automatically.

| Command | What it does | Who does it |
|---------|-------------|-------------|
| `/ccg:workflow` | Full cycle: research → ideate → plan → execute → optimize → review | Codex + Gemini |
| `/ccg:plan` | Just plan, don't touch code | Codex + Gemini |
| `/ccg:execute` | Run a plan file, Claude leads | Codex + Gemini + Claude |
| `/ccg:codex-exec` | Run a plan file, Codex leads, Claude only reviews | Codex |
| `/ccg:feat` | Figures out whether to plan or just do it | Auto |
| `/ccg:frontend` | Frontend work | Gemini |
| `/ccg:backend` | Backend work | Codex |

```bash
# Simplest usage
/ccg:frontend change the card component to grid layout
/ccg:backend add pagination to /api/users

# Plan first, execute later
/ccg:plan implement JWT auth
# Plan saved to .claude/plan/ — review and edit it
/ccg:execute .claude/plan/jwt-auth.md
```

## The investigators

Don't write code, just analyze. Two models cross-verify each other.

| Command | What it does |
|---------|-------------|
| `/ccg:analyze` | Technical analysis |
| `/ccg:debug` | Diagnose bugs + suggest fixes |
| `/ccg:optimize` | Find performance bottlenecks |
| `/ccg:test` | Generate tests |
| `/ccg:review` | Code review — no args means review latest git diff |
| `/ccg:enhance` | Turn vague requests into structured task descriptions |

```bash
# Review recent changes
/ccg:review

# Diagnose a specific issue
/ccg:debug why does the WebSocket connection drop after 30 seconds
```

## OPSX spec-driven

Don't want the AI to improvise? This group turns requirements into constraints first, then executes within those constraints.

| Command | What it does |
|---------|-------------|
| `/ccg:spec-init` | Set up OPSX environment |
| `/ccg:spec-research` | Research requirements, output constraints |
| `/ccg:spec-plan` | Turn constraints into a zero-decision plan |
| `/ccg:spec-impl` | Execute the plan |
| `/ccg:spec-review` | Dual-model review (can use anytime) |

```bash
/ccg:spec-init
/ccg:spec-research implement RBAC permission system
/ccg:spec-plan
/ccg:spec-impl
```

::: tip
State lives in `openspec/`. You can `/clear` between phases without losing anything.
:::

## Agent Teams (parallel)

Task splits into 3+ independent modules? Multiple Builders work at the same time.

| Command | What it does |
|---------|-------------|
| `/ccg:team-research` | Explore codebase in parallel, output constraints |
| `/ccg:team-plan` | Split into tasks that don't step on each other |
| `/ccg:team-exec` | Builders code in parallel |
| `/ccg:team-review` | Codex + Gemini cross-review |

```bash
/ccg:team-research implement order system with CRUD, payment, and notifications
# /clear
/ccg:team-plan order-system
# /clear
/ccg:team-exec
# /clear
/ccg:team-review
```

::: warning
Requires experimental feature flag: `"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"` in settings.json.
:::

## Git tools

| Command | What it does |
|---------|-------------|
| `/ccg:commit` | Analyzes diff, generates conventional commit message |
| `/ccg:rollback` | Interactive rollback |
| `/ccg:clean-branches` | Clean merged branches (dry-run by default, safe to try) |
| `/ccg:worktree` | Worktree management |

## Project management

| Command | What it does |
|---------|-------------|
| `/ccg:init` | Generate CLAUDE.md for the project |
| `/ccg:context` | Manage .context directory: log decisions, compress, view history |

```bash
/ccg:context init
/ccg:context log "Chose PostgreSQL for JSONB support"
```
