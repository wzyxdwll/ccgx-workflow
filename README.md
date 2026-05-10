# ccgx-workflow — Claude × Codex × Gemini Multi-Model Collaboration

<div align="center">

[![npm version](https://img.shields.io/npm/v/ccgx-workflow.svg)](https://www.npmjs.com/package/ccgx-workflow)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Compatible-green.svg)](https://claude.ai/code)
[![Tests](https://img.shields.io/badge/Tests-1309%20passed-brightgreen.svg)]()

[简体中文](./README.zh-CN.md) | English

</div>

> **Project Lineage**
>
> `ccgx-workflow` is a deep rewrite of [`ccg-workflow`](https://www.npmjs.com/package/ccg-workflow) v3.x.
> The original project went unmaintained after 2026-05 (the original author's
> GitHub homepage went offline), leaving its multi-model collaboration users
> exposed to drift. This project re-architected from the ground up:
> fresh-context subagent protocols, Plan-Critic-Verify quality tiers,
> OS-level three-layer process isolation, broker tx_id anti-drift,
> and 8 plugin patches with a one-shot repatch script.
>
> The `/ccg:*` slash command palette is **gesture-compatible** with the
> original — but the underlying architecture has been completely replaced.
> Original copyright is preserved under MIT, see [LICENSE](./LICENSE).

---

## What Is It

A multi-model collaboration system where Claude Code orchestrates Codex (backend) and Gemini (frontend). Frontend tasks auto-route to Gemini, backend tasks to Codex, Claude handles orchestration and code review.

External models have **no write access** — they only return patches; Claude reviews before applying.

```
Claude Code (Orchestrator)
       │
   ┌───┴───┐
   ↓       ↓
Codex   Gemini
(Backend) (Frontend)
   │       │
   └───┬───┘
       ↓
  Unified Patch
```

## Core Features

- **Zero-config model routing** — Frontend → Gemini / Backend → Codex, dispatched by phase frontmatter `Type:` field. No manual switching.
- **~30 `/ccg:*` slash commands** — Planning, execution, git workflow, code review, autonomous long-runs, async job triplet.
- **Three-tier quality gates** — `--quality=fast|triple|debate` toggles Plan-Critic-Verify collaboration depth.
- **Fresh-context subagent protocol** — `phase-runner` / `code-fixer` / `debug-session-manager` keep main-thread context ≤15%; the orchestrator only consumes ≤200-token summaries.
- **OS-level three-layer process isolation** — `Bash(claude -p --agent ccg/phase-runner)` replaces in-process sidechain; treats main-process RSS leak.
- **OPSX spec-driven** — Integrates [OPSX](https://github.com/fission-ai/opsx) to convert vague requirements into verifiable constraints, eliminating AI improvisation.
- **Plugin-first with wrapper fallback** — Uses official codex/gemini plugins when available; falls back to `codeagent-wrapper`.

---

## Quick Start

### Prerequisites

| Dependency | Required | Notes |
|------------|----------|-------|
| **Node.js 20+** | Yes | `ora@9.x` requires Node ≥ 20 |
| **Claude Code CLI** | Yes | [Install guide](#install-claude-code) |
| **jq** | Yes | Used for auto-authorization hook ([install](#install-jq)) |
| **codex access** | **One of** | `codex@openai-codex` plugin (recommended) **OR** `npm i -g @openai/codex` |
| **gemini access** | **One of** | `gemini@google-gemini` plugin (recommended) **OR** `npm i -g @google/gemini-cli` |

> **Why "one of"**: ccgx-workflow prefers the plugin path (one-click install in Claude Code,
> integrated auth). When the plugin is absent it falls back to spawning the standalone CLI
> via `~/.claude/bin/codeagent-wrapper`. Without **either**, `/ccg:*` commands that invoke
> codex/gemini fail with exit 127 + a friendly install hint.

### Installation

```bash
npx ccgx-workflow
```

First run prompts for language (English / Chinese), API provider, MCP tooling — all interactive. CLI command name remains `ccg` (preserves muscle memory for legacy users).

### Install jq

```bash
# macOS
brew install jq

# Linux (Debian/Ubuntu)
sudo apt install jq

# Linux (RHEL/CentOS)
sudo yum install jq

# Windows
choco install jq   # or: scoop install jq
```

### Install Claude Code

```bash
npx ccgx-workflow menu  # Select "Install Claude Code"
```

Supports npm / homebrew / curl / powershell / cmd.

---

## Enabling Multi-Model Collaboration (codex / gemini access)

ccgx-workflow needs codex + gemini access via **one of two paths** for each:

### Path A — Claude Code plugins (recommended)

Run inside Claude Code:

```
/plugin install codex@openai-codex
/plugin install gemini@google-gemini
```

One-click install, integrated auth via Claude Code. Templates spawn plugin
agents (`Agent(codex:codex-rescue)` / `Agent(gemini:gemini-rescue)`) directly,
no shim involved.

### Path B — standalone CLI fallback

```bash
# codex CLI
npm i -g @openai/codex
codex login

# gemini CLI
npm i -g @google/gemini-cli
gemini auth login
```

When the plugin is absent, templates fall back to invoking the CLI through
`~/.claude/bin/codeagent-wrapper` (a Node shim that wraps `codex` / `gemini`).
You handle key configuration manually.

### Mix and match

You can use plugin for codex + CLI for gemini, or vice versa. ccgx-workflow
detects each independently and picks the best available path per call site.

The `@` suffix is the marketplace identifier. If a marketplace isn't configured, run `/help plugin` inside Claude Code to see local marketplace management commands, or refer to [Claude Code plugin docs](https://docs.claude.com/en/docs/claude-code/plugins).

> Upstream plugin repos (for troubleshooting / issue reports):
> - **codex**: `openai-codex` marketplace (Claude Code official)
> - **gemini**: [sakibsadmanshajib/gemini-plugin-cc](https://github.com/sakibsadmanshajib/gemini-plugin-cc)

### Verify

```bash
ls ~/.claude/plugins/cache/openai-codex/codex/
ls ~/.claude/plugins/cache/google-gemini/gemini/
# Should show version directories (e.g. 1.0.4 / 1.0.1)
```

### ⚠️ Gemini plugin Windows Known Issues (patch strongly recommended)

`gemini@google-gemini` v1.0.1 has **8 spawn sites missing `windowsHide: true`** on Windows, causing:

- Brief cmd black flashes that steal application focus on every plugin call (high-frequency)
- ENOENT errors when ACP broker spawns `gemini.cmd` (serialized as `[object Object]` by plugin error handlers)
- Flashes during broker daemon startup, `gemini --version` health checks, `taskkill`, `where gemini`, etc.

**ccgx-workflow ships a one-shot repatch script** (idempotent, re-runnable):

```bash
node ~/.claude/.ccg/scripts/repatch-gemini-plugin.mjs
```

Behavior:
1. Auto-locates plugin version directory
2. Probes each patch site (string match)
3. Already-patched sites: `[SKIP]`; unpatched sites: `[APPLY]`
4. Prints broker-daemon-restart command on completion

⚠️ **Important**: After every `claude plugin update gemini@google-gemini`, the plugin update overwrites cache — **rerun the patch script**.

⚠️ **Restart broker daemon after patching** (old daemon still runs unpatched code):

```powershell
# Windows PowerShell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'acp-broker' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Or simpler: `/plugin disable gemini@google-gemini` then `/plugin enable gemini@google-gemini`.

Root causes, temporary patches, and upstream paths for all 8 issues are documented in [`.ccg-migration/PLUGIN-PATCHES.md`](./.ccg-migration/PLUGIN-PATCHES.md). Upstream PR is in progress; once merged, the patch becomes a no-op.

---

## Relationship to ccg-workflow

ccgx-workflow is **not a fork**. The upstream `ccg-workflow` public release line stopped at v3.x and has been unmaintained since 2026-05. ccgx-workflow v1.0 was redesigned from scratch on top of v3.x (~3 days / 92 commits / 1141 new tests of dense iteration before stabilization).

### What's New (vs v3.x)

#### 🆕 New Commands

| Command | Description |
|---------|-------------|
| `/ccg:debate` | **Multi-round debate primitive** — codex propose ↔ gemini challenge ↔ codex respond, cap N rounds, schema-enforced retry protocol |
| `/ccg:status [job-id]` | **Async job triplet** — dashboard mode aggregates multi-phase progress / `--wait --timeout-ms` blocking / `--tail` streaming + 3-class stuck warnings |
| `/ccg:status --cancel <phase-id>` | Single-phase cooperative cancel + grace + kill-tree (Windows `taskkill /T /F` + POSIX `setsid` process group) |
| `/ccg:result <job-id>` | Final verdict / summary / artifacts; main thread receives ≤200-token summary |
| `/ccg:cancel <job-id>` | Abort active job: write `cancel.flag` cooperative → 5s grace → kill-tree |
| `/ccg:verify --gate=<name>` | **Unified verify entry** — consolidates v3.x's 4 separate `verify-{change,quality,security,module}` commands; `--gate=all` orchestrates all gates |
| `/ccg:verify-work` | **Session-based UAT + cold-start smoke injection** — UAT.md persists across `/clear` via frontmatter; git diff scans server/db/migrations to auto-inject cold-start tests |

#### 🚀 Enhanced Commands

| Command | v3.x | ccgx-workflow |
|---------|------|---------------|
| `/ccg:autonomous` | Sequential phases | **Wave topological parallelism** + cascade skip + max-concurrent batching; `--quality=fast/triple/debate` three-tier gates + per-phase frontmatter override |
| `/ccg:review` | Dual-model review | Adds `--fix --auto` worktree-isolated closed-loop fix (4-step transactional cleanup) |
| `/ccg:debug` | Single-step diagnosis | Manager + debugger **two-tier fresh-context** — multi-round falsifiable hypotheses + persistent session in `.context/debug/<slug>.md` |
| `/ccg:team` | 4 separate commands | 8-phase unified workflow + 7-role orchestration + Evaluator-Optimizer feedback loop (up to 2 auto-fix rounds for Critical) |

#### 🤖 New Agents (vs v3.x's 7)

**Fresh-context protocol group** (4 agents; main thread receives ≤200-token summary):

| Agent | Role |
|-------|------|
| `phase-runner` | Autonomous long-run phase implementer — `Bash(claude -p --agent ccg/phase-runner)` spawns OS-level subprocess; stream-json output flows to `.context/jobs/<id>/progress.jsonl` |
| `code-fixer` | review --fix closed-loop — git worktree isolation + 3-layer verification + atomic commit |
| `debug-session-manager` | Debug multi-round orchestrator — runs hypothesis loop in isolated context |
| `debugger` | Scientific-method hypothesis constructor — diagnostic specialist scheduled by manager |

**Specialist matrix** (8 agents, role × layer 2D dispatch):

| Agent | Role |
|-------|------|
| `assumptions-analyzer` | Assumption interrogator — enforces first-principles, lists evidence-free inferences and gaps |
| `pattern-mapper` | Codebase pattern scanner — gives builders precise "copy from here" anchors before implementation |
| `plan-checker` | Plan validator — 5-dimension GSD-derived strong checks + max-3-loop convergence; BLOCKERs return to planner |
| `nyquist-auditor` | Deep auditor — focuses on boundary conditions, concurrency races, error propagation chains, resource leaks |
| `verifier` | Delivery verifier — line-by-line requirement checklist, PASS/FAIL/PARTIAL matrix + Level 4 data-flow (FLOWING/STATIC/DISCONNECTED/HOLLOW_PROP) |
| `integration-checker` | Cross-module interface contract — finds format drift, stale callers, orphan exports |
| `framework-selector` | Tech stack selection review — current vs proposal contrast, must verify current can't solve before adopting proposal |
| `eval-auditor` | Evaluation closed-loop audit — sampling / control / metric gaming / falsifiability checks |

Plus the 7 core agents inherited from v3.x design (planner / ui-ux-designer / init-architect / get-current-datetime / team-architect / team-qa / team-reviewer), ccgx-workflow has **19 sub-agents total**.

#### 🔧 New Mechanisms / Infrastructure

| Mechanism | Description |
|-----------|-------------|
| **Three-tier quality gates** | `--quality=fast` (2 waves: impl + verify) / `triple` (4 waves: plan + critic + impl + verify, default) / `debate` (7 waves: + 3-round propose-challenge-respond, cap 3) |
| **Wave topological scheduling** | Kahn topological partition + cascade skip + max-concurrent batching; 30-40% wall-clock reduction; `--sequential` opt-out |
| **OS-level 3-layer process isolation** | Main `claude.exe` → `Bash(claude -p)` subprocess → optional plugin process group; treats v3.x main-process RSS leak (uni-iam workload measured at 23GB → ccgx target < 8GB) |
| **Broker tx_id anti-drift** | Each spawn injects `CCG_BROKER_TX_ID` (`crypto.randomUUID`); 8-field strict schema in broker.log; 100k spawns 0 collisions / 2k concurrent 0 misattribution (measured) |
| **`context_budget` frontmatter hard-cap** | 4 main orchestrators declare `context_budget: orchestrator-15`; forbidden to slurp builder stdout |
| **`.context/<phase>/{CONTEXT,SUMMARY}.md`** | Phase-scoped state machine; main thread reads frontmatter only (< 200 tokens/phase) |
| **`.context/codebase/` 7-file contract** | codebase-mapper agent 4-way parallel scan (STACK/INTEGRATIONS/ARCHITECTURE/STRUCTURE/CONVENTIONS/TESTING/CONCERNS) |
| **Silent fallback governance** | verify wave Bash-direct invocation (architectural elimination) + debate retry protocol schema enforcement (4 violation classes: parse-failed / insufficient-attempts / missing-reason / silent-success) |
| **Scope reduction detection** | plan-checker dim 7b — detects "v1 / simplified / static-first / wire-up-later" keywords + 80% overlap match against original requirements; BLOCKER on mismatch |
| **commit-msg-review git hook** | Opt-in pre-commit-msg hook with 3 heuristics (filename ⊆ staged / phase tag ↔ staged paths / op type ↔ diff) |
| **ground-truth-sampler** | autonomous startup samples plugin/skill/agent list to `.context/ground-truth/latest.json`; phase-runner prompt enforces Read |
| **interface-auditor specialist** | autonomous verify wave (triple/debate tiers) adds 3rd spawn — 5 checks: SSoT-violation / leftover / magic-string-vs-ground-truth / unverified assumption / API drift |
| **Gemini plugin Windows repatch** | `~/.claude/.ccg/scripts/repatch-gemini-plugin.mjs` — one-shot patch for 8 spawn bugs, idempotent and re-runnable |
| **Auto-generated fixtures** | `scripts/regen-fixtures.ts` + `tests/fixtures/ground-truth/*.sample.json`; prevents inline mock drift from real interfaces |
| **pipeline-check helper** | `pnpm pack` + tarball audit + missing-file detection; prevents "templates in git but missing from npm tarball" incidents |

#### 📦 Skill Ecosystem

ccgx-workflow inherits the **Skill Registry** mechanism (frontmatter-driven auto command generation) with:

- **Quality gates** — 4: verify-{change, quality, security, module} (still callable as skills after merging into `/ccg:verify`)
- **Tool skills** — 6: gen-docs / health / map-codebase / extract-learnings / forensics / override-refusal
- **Domain knowledge bundles** — 10 categories, ~21 SKILL.md (security / architecture / devops / ai / development / frontend-design, etc.; all `user-invocable: false`, keyword-routed auto-Read)
- **Impeccable UI/UX toolkit** — 20 (adapt / animate / arrange / audit / bolder / clarify / colorize / critique / delight / distill / extract / harden / normalize / onboard / optimize / overdrive / polish / quieter / typeset, etc.; optional install)
- **scrapling**: web scraping with Cloudflare / WAF bypass
- **orchestration/multi-agent**: coordination SKILL

Total: **47 SKILL.md files** + 50+ supporting markdowns = 100+ skill files.

### Comparison Table

Core differences at a glance:

| Dimension | `ccg-workflow` v3.x | `ccgx-workflow` v1.0 |
|-----------|----------------------|----------------------|
| Maintenance | Stalled after 2026-05; author offline | Actively maintained; PRs welcome |
| Main-thread context | No explicit budget | `context_budget` frontmatter hard-cap + fresh-context subagent protocol |
| Multi-model gates | Single orchestration | **Three-tier flag** `--quality=fast/triple/debate` (Plan-Critic-Verify) |
| Autonomous long-runs | Sequential phases | **Wave topological parallel** + cascade skip + cap scheduling |
| Process isolation | In-process sidechain | **OS-level 3 layers** (`Bash(claude -p)` subprocess + plugin process group) |
| Broker anti-drift | — | **broker tx_id** crypto sign + 8-field strict schema |
| Gemini Windows patch | Manual edit of 8 source sites | **Built-in one-shot repatch script**, idempotent |
| Silent fallback | — | verify wave Bash-direct invocation + debate retry protocol schema enforcement |
| Test count | 168 | **1309** |
| Command palette | 35 (incl. deprecated) | ~30 (consolidated) |
| Subagents | 7 | **19** (4 fresh-context + 8 specialist matrix + others) |
| Binary dependency | Go binary 16.3 MB | **Node single-file ~200 KB** |
| License | MIT | MIT (dual copyright: original author + maintainer) |
| `/ccg:*` palette | — | **Fully compatible** — zero migration cost |

### Migration

See [MIGRATION-FROM-CCG-WORKFLOW.md](./MIGRATION-FROM-CCG-WORKFLOW.md). One-liner:

```bash
npm uninstall -g ccg-workflow            # if installed globally
npx ccgx-workflow                        # reinitialize
```

`/ccg:*` commands, `.context/` state, `.ccg/roadmap.md` are all preserved — no code changes or project state rebuild required.

---

## Commands

### Development Workflow

| Command | Description | Models |
|---------|-------------|--------|
| `/ccg:workflow` | Full 6-phase workflow (auto-routes frontend/backend) | Codex + Gemini |
| `/ccg:plan` | Multi-model planning (Phase 1-2) | Codex + Gemini |
| `/ccg:execute` | Multi-model execution (Phase 3-5) | Codex + Gemini + Claude |
| `/ccg:codex-exec` | Codex full execution (plan → code → review) | Codex + multi-model review |
| `/ccg:autonomous` | Cross-phase long-run (`--quality=fast/triple/debate`) | phase-runner + Plan-Critic-Verify |
| `/ccg:context` | Project context management (.context/ init, log, compress, history) | Claude |
| `/ccg:enhance` | Built-in prompt enhancement | Claude |

### Analysis & Quality

| Command | Description | Models |
|---------|-------------|--------|
| `/ccg:analyze` | Technical analysis | Codex + Gemini |
| `/ccg:debug` | Diagnosis + fix (manager + debugger fresh-context two-tier) | debug-session-manager |
| `/ccg:optimize` | Performance optimization | Codex + Gemini |
| `/ccg:test` | Test generation | Auto-routed |
| `/ccg:review` | Code review (auto git diff + `--fix --auto` worktree closed loop) | Codex + Gemini + code-fixer |
| `/ccg:verify --gate=<change\|quality\|security\|module\|all>` | Unified verify gate | Claude |
| `/ccg:verify-work` | Orchestrator + session-based UAT + cold-start smoke | Claude |
| `/ccg:debate` | Multi-round propose/challenge/respond primitive (cap N rounds) | Codex + Gemini |

### Async Job Triplet

| Command | Description |
|---------|-------------|
| `/ccg:status [job-id]` | List or query job (`--wait --timeout-ms` blocking; dashboard mode) |
| `/ccg:status --tail <job-id>` | stream-json + single-line overwrite + 3-class stuck warnings |
| `/ccg:status --cancel <phase-id>` | Single-phase cooperative cancel + grace + kill-tree |
| `/ccg:result <job-id>` | Final verdict / summary / artifacts |
| `/ccg:cancel <job-id>` | Abort active job |

### OPSX Spec-Driven

| Command | Description |
|---------|-------------|
| `/ccg:spec-init` | Initialize OPSX environment |
| `/ccg:spec-research` | Requirements → constraints |
| `/ccg:spec-plan` | Constraints → zero-decision plan |
| `/ccg:spec-impl` | Execute plan + archive |
| `/ccg:spec-review` | Dual-model cross-review |

### Agent Teams

| Command | Description |
|---------|-------------|
| `/ccg:team` | **Unified workflow (recommended)** — 8-phase 7-role end-to-end |
| `/ccg:team research <args>` | Requirements → constraints |
| `/ccg:team plan <args>` | Constraints → parallel impl plan |
| `/ccg:team review [git-range]` | Dual-model cross-review |
| `/ccg:team-exec` | Spawn Builder teammates for parallel coding |

> **Prerequisite**: Enable `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in `settings.json`.

### Git Tools

| Command | Description |
|---------|-------------|
| `/ccg:commit` | Smart conventional commit |
| `/ccg:rollback` | Interactive rollback |
| `/ccg:clean-branches` | Clean merged branches |
| `/ccg:worktree` | Worktree management |

### Project Setup

| Command | Description |
|---------|-------------|
| `/ccg:init` | Initialize project CLAUDE.md |

---

## Configuration

### Directory Layout

```
~/.claude/
├── commands/ccg/       # ~30 slash commands
├── agents/ccg/         # 19 sub-agents
├── skills/ccg/         # Quality gates + 10 domain bundles + impeccable + orchestration
├── bin/codeagent-wrapper  # Fallback path (when plugins absent)
└── .ccg/
    ├── config.toml
    ├── scripts/
    │   └── repatch-gemini-plugin.mjs   # ⭐ one-shot patch
    └── prompts/
        ├── codex/      # 6 Codex expert prompts
        └── gemini/     # 7 Gemini expert prompts
```

### Environment Variables

In `~/.claude/settings.json` under `"env"`:

| Variable | Description | Default | When to change |
|----------|-------------|---------|----------------|
| `CODEAGENT_POST_MESSAGE_DELAY` | Wait after Codex completion (sec) | `5` | Set to `1` if Codex hangs |
| `CODEX_TIMEOUT` | wrapper execution timeout (sec) | `7200` | Increase for very long tasks |
| `BASH_DEFAULT_TIMEOUT_MS` | Claude Code Bash timeout (ms) | `120000` | Increase if commands time out |
| `BASH_MAX_TIMEOUT_MS` | Claude Code Bash max timeout (ms) | `600000` | Increase for long builds |

### MCP

```bash
npx ccgx-workflow menu  # Select "Configure MCP"
```

**Code retrieval** (pick one):
- **fast-context** (recommended) — Windsurf Fast Context, AI-powered, no full-repo indexing
- **ace-tool** — `search_context` ([official](https://augmentcode.com/) / [community proxy](https://acemcp.heroman.wtf/))
- **ContextWeaver** — Local hybrid search, requires SiliconFlow API Key (free)

**Optional**: Context7 (auto-installed, library docs) / Playwright / DeepWiki / Exa.

---

## Update / Uninstall

```bash
# Update
npx ccgx-workflow@latest             # npx users
npm install -g ccgx-workflow@latest  # global npm users

# Uninstall
npx ccgx-workflow                    # select "Uninstall"
npm uninstall -g ccgx-workflow       # global npm users need this extra step
```

---

## FAQ

### Codex CLI 0.80.0 process does not exit

In `--json` mode, Codex doesn't auto-exit after output completion.

**Fix**: Set `CODEAGENT_POST_MESSAGE_DELAY=1`.

### I'm coming from ccg-workflow — does ccgx-workflow drop in?

Yes. `/ccg:*` palette is fully compatible. `.context/` state and `.ccg/roadmap.md` are preserved. See [MIGRATION-FROM-CCG-WORKFLOW.md](./MIGRATION-FROM-CCG-WORKFLOW.md).

### Why is the CLI command `ccg` and not `ccgx`?

Preserving `ccg` keeps legacy aliases, scripts, and docs working with zero changes — `/ccg:*` palette and the `ccg` CLI are both muscle memory. The package name `ccgx-workflow` exists to disambiguate the npm namespace; the CLI binary remains `ccg`.

### What happens to the Gemini patch when upstream fixes it?

ccgx-workflow tracks upstream plugin versions. Once fixes land upstream, the repatch script auto-skips already-fixed sites via probe detection (`[SKIP]`) — no side effects. A ccgx-workflow release will mark "upstream fixed, patch is now a no-op" at that point.

---

## Contributing

PRs and issues welcome. This project is MIT-licensed; submitting code constitutes consent to release under MIT.

- **Issues**: [GitHub Issues](https://github.com/wzyxdwll/ccgx-workflow/issues)
- **Discussions**: [GitHub Discussions](https://github.com/wzyxdwll/ccgx-workflow/discussions)

## Credits

ccgx-workflow stands on the shoulders of ccg-workflow. Thanks to fengshao1227 and the original contributors.

- [ccg-workflow](https://github.com/fengshao1227/ccg-workflow) v1.x – v3.x — original project (fengshao1227)
- [gsd-build/get-shit-done](https://github.com/gsd-build/get-shit-done/) — fresh-context subagent protocol, context monitor, code-fixer worktree closed loop, debug session manager — multiple architectural inspirations
- [cexll/myclaude](https://github.com/cexll/myclaude) — codeagent-wrapper inspiration
- [UfoMiao/zcf](https://github.com/UfoMiao/zcf) — git tooling inspiration
- [GuDaStudio/skills](https://github.com/GuDaStudio/skills) — routing design

## License

MIT — see [LICENSE](./LICENSE) (dual copyright: original author fengshao1227 + maintainer wangzy).

---

v1.0.0 | [Issues](https://github.com/wzyxdwll/ccgx-workflow/issues) | [Migration from ccg-workflow](./MIGRATION-FROM-CCG-WORKFLOW.md)
