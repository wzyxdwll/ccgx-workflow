# Workflow Guide

Different tasks call for different workflows. Don't overthink it — use this decision tree.

## How to choose

```
Got a task
  │
  ├─ Simple, one sentence? ──→ /ccg:frontend or /ccg:backend
  │
  ├─ Want to review the plan first? → /ccg:plan → /ccg:execute
  │
  ├─ Need strict control? ──→ /ccg:spec-* series
  │
  ├─ Splits into 3+ modules? → /ccg:team-* series
  │
  └─ Full end-to-end? ──────→ /ccg:workflow
```

## Plan → Execute (most common)

Codex and Gemini each produce an analysis. Claude combines them into a plan. You review it, tweak if needed, then execute.

```bash
/ccg:plan implement user authentication
# Plan saved in .claude/plan/
# Open it, read it, edit it if you want

# Two ways to execute — pick one:
/ccg:execute .claude/plan/user-auth.md   # Claude handles each step
/ccg:codex-exec .claude/plan/user-auth.md  # Codex does everything, Claude just reviews
```

**When to use which?**

`execute` — Complex tasks where you want Claude steering every step. Uses more tokens.

`codex-exec` — Clear, well-defined tasks. Codex runs the whole thing, Claude reviews at the end. Much cheaper.

## OPSX Spec-Driven (strict control)

For when you don't want the AI making stuff up. Like implementing a permission system where every detail needs to be traceable.

The idea: **turn requirements into constraints, then turn constraints into a zero-decision plan. During execution, there's nothing to decide — every decision was already made during planning.**

```bash
/ccg:spec-init
/ccg:spec-research implement RBAC permission system
# This outputs constraints like:
# - Must support role inheritance
# - Permission check latency < 5ms
# - Must have audit logging

/ccg:spec-plan
# Constraints → zero-decision plan
# Every step: which file, what change, how to verify

/ccg:spec-impl
# Execute step by step, no decisions needed

/ccg:spec-review
# Independent dual-model review, use anytime
```

You can `/clear` between phases — state lives in `openspec/`, it won't disappear.

## Agent Teams (parallel multi-module)

Task splits into independent modules? Like "order CRUD + payment integration + email notifications" — three modules with no dependencies. Let three Builders work at once.

```bash
/ccg:team-research implement order system
# Outputs constraints + success criteria
# /clear

/ccg:team-plan order-system
# Splits into non-overlapping subtasks, each Builder owns their files
# /clear

/ccg:team-exec
# Multiple Builders code in parallel
# /clear

/ccg:team-review
# Codex reviews + Gemini reviews, Critical = must fix
```

**How is this different from the normal workflow?**

Normal workflow keeps a continuous conversation — context accumulates. Team series `/clear`s between steps, passing state through files. Upside: context never blows up. Downside: you can't course-correct mid-stream.

Works best when: the task decomposes into 3+ independent modules with no tight coupling.

## Full Workflow (autopilot)

`/ccg:workflow` runs all 6 phases automatically: research → ideate → plan → execute → optimize → review.

```bash
/ccg:workflow implement full user auth with registration, login, and JWT
```

Good for when you don't want to babysit the process. For big tasks though, `plan + execute` gives you a checkpoint to review the plan before committing to it.
