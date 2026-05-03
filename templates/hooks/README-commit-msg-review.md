# ccg-commit-msg-review — opt-in heuristic commit consistency hook

> Catches the "spec drift" pattern observed in CCG v4.0 P14 / v4.1 P18 where the
> commit message text described one change and `git diff --staged` described a
> different one. Heuristic-only — no LLM round-trip — so it stays under ~50 ms.

## What it does

When invoked as a git `commit-msg` hook, the script reads:

1. The draft commit message (path passed as `argv[2]`, fallback `.git/COMMIT_EDITMSG`)
2. The staged file list (`git diff --cached --name-only`)

…and runs three cheap consistency checks:

| # | Check | Catches |
|---|-------|---------|
| 1 | Every `path/to/file.ext` token mentioned in the message must appear in the staged file list | "feat: refactor `package.json`" when only `src/utils/foo.ts` is staged |
| 2 | A phase tag in the subject (`v4.3-p27` / `phase-29` / `p27`) must be reflected in at least one staged path | `feat(v4.3-p27): ...` when staged files are all under `phase-29-*` paths |
| 3 | A `docs(...)` / `test(...)` type prefix must match the staged file mix | `docs(...)` commit that touches only `src/*.ts` and zero `.md` files |

On a violation the hook exits non-zero and prints the offending heuristic to
stderr. The user can override with `git commit --no-verify`.

## Why opt-in (not auto-registered)

Git hooks are user-owned. The CCG installer ships the script to
`~/.claude/hooks/ccg-commit-msg-review.cjs` so it is available, but does **not**
write to `git config core.hooksPath` and does **not** drop a `commit-msg` file
into any repository's `.git/hooks/`. That keeps existing user workflows intact
(Husky, lefthook, simple-git-hooks, vendor-specific hooks) and makes the
activation explicit.

## Activation — pick one

### Option A: per-repo, single hook (recommended)

```bash
# inside the target repo
ln -sf ~/.claude/hooks/ccg-commit-msg-review.cjs .git/hooks/commit-msg
chmod +x .git/hooks/commit-msg
```

On Windows (PowerShell):

```powershell
# Copy because Windows symlinks need elevated privileges by default
Copy-Item -Force "$HOME\.claude\hooks\ccg-commit-msg-review.cjs" ".git\hooks\commit-msg"
```

> The file does not need a `.cjs` extension under `.git/hooks/`; git invokes it
> directly. The shebang at the top of the script (`#!/usr/bin/env node`) makes
> the symlink work on POSIX systems.

### Option B: cohabit with Husky / lefthook

If you already use a hook manager, add a `commit-msg` step that calls the
script. Example (Husky `.husky/commit-msg`):

```bash
#!/usr/bin/env sh
node "$HOME/.claude/hooks/ccg-commit-msg-review.cjs" "$1"
```

Make sure the file is executable (`chmod +x .husky/commit-msg`).

### Option C: global hooks via core.hooksPath

If you want the check on every repo on this machine:

```bash
mkdir -p ~/.git-hooks
ln -sf ~/.claude/hooks/ccg-commit-msg-review.cjs ~/.git-hooks/commit-msg
chmod +x ~/.git-hooks/commit-msg
git config --global core.hooksPath ~/.git-hooks
```

Note that `core.hooksPath` replaces `.git/hooks/` for **all** repos and is a
heavyweight change — most users prefer Option A or B.

## Bypass

```bash
git commit --no-verify -m "..."
```

The hook is advisory. CI / branch protection rules are the proper place to
enforce policy.

## Limitations (by design)

- Heuristics will miss subtle drift (e.g. wrong-but-real filename mentioned).
  The goal is to catch the obvious mistakes that humans-and-LLMs both make.
- We do not invoke an LLM. Pre-commit must be fast.
- We do not parse the diff content, only the file list. Mentioning a function
  name that is not in the diff is intentionally **not** flagged because that
  produces too many false positives in commits that document broader context.

## Updating

The script is overwritten by `npx ccg-workflow init` and `npx ccg-workflow
update`. If you symlinked from `.git/hooks/commit-msg`, the symlink continues
to point at the latest version automatically.
