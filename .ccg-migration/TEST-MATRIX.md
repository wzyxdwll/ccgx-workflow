# invoke-model.mjs — Wrapper Equivalence Test Matrix

Goal: prove the Node shim at `templates/scripts/invoke-model.mjs` is behaviourally equivalent to `codeagent-wrapper` (Go binary v5.10.0) for all 51 single-task call sites used by the 22 templates.

Comparison strategy: for each behaviour run **the same input** through both binaries and diff the relevant output channel(s). Where the Go binary writes a log file, ignore that (the shim does not). Some checks need a stub backend (a tiny shell script that emits canned JSON-line output) to keep tests hermetic.

Conventions:
- `WRAPPER` = `~/.claude/bin/codeagent-wrapper` (or platform-specific binary)
- `SHIM`    = `node templates/scripts/invoke-model.mjs`
- `STUB`    = test fixture that prints prepared JSON-line events on stdout
- For each row: pass = the listed expectation holds for both `WRAPPER` and `SHIM`.

---

## 1. CLI surface

| # | Test | Input | Expected | How to compare |
|---|------|-------|----------|----------------|
| 1.1 | Version flag | `--version` | stdout: `codeagent-wrapper version 5.10.0`; exit 0 | exact-match diff |
| 1.2 | Short version | `-v` | same as 1.1 | exact-match diff |
| 1.3 | Help flag | `--help` | exit 0; non-empty stdout containing `Usage:` | both exit 0; both mention `Usage:` |
| 1.4 | Missing args | (no args) | exit 1; stderr mentions `task required` (or help) | both exit 1 |
| 1.5 | Unknown backend | `--backend foo - "."` | exit 1; stderr contains `unsupported backend` | both exit 1, both mention `unsupported backend` |
| 1.6 | `--backend=` form | `--backend=codex - "."` (stub) | runs codex backend | both stderr banner shows `Backend: codex` |
| 1.7 | `--gemini-model=` form | `--backend=gemini --gemini-model=gemini-3.1-pro-preview - "."` | gemini argv contains `-m gemini-3.1-pro-preview` | parse stderr `Command:` line; both contain `-m gemini-3.1-pro-preview` |
| 1.8 | Gemini model with non-gemini backend | `--backend codex --gemini-model x - "."` | warning logged; codex runs as normal (no `-m`) | both stderr contain `--gemini-model parameter is only effective` |
| 1.9 | `--progress` flag | new task with stub emitting events | stderr contains `[PROGRESS] session_started id=...` and `[PROGRESS] message text=...` | both stderr have matching set of `[PROGRESS] ...` lines (event types and order) |
| 1.10 | Resume parse | `resume abc-123 - "/tmp"` (stub) | mode=resume; codex argv has `resume abc-123 -`, no `-C` | parse stderr `Command:`; both contain `resume abc-123` and **do not** contain `-C` |
| 1.11 | Resume missing id | `resume "" task` | exit 1 | both exit 1 |
| 1.12 | Skip-permissions for claude | `--backend claude --skip-permissions - "."` | claude argv has `--dangerously-skip-permissions` and `--setting-sources ""` | parse stderr Command line |
| 1.13 | Skip-permissions for codex | `--backend codex --skip-permissions - "."` | codex argv unchanged (flag ignored at backend level) | parse stderr Command line — must not contain `--dangerously-skip-permissions` |

## 2. Argv shape per backend

| # | Test | Mode | Expected argv | How to compare |
|---|------|------|---------------|-----------------|
| 2.1 | Codex new | `--backend codex - "/proj"` | `codex e --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C /proj --json -` | stderr `Command:` line |
| 2.2 | Codex new + CODEX_REQUIRE_APPROVAL=true | env on; `--backend codex - "/proj"` | argv omits `--dangerously-bypass-approvals-and-sandbox` |
| 2.3 | Codex new + CODEX_DISABLE_SKIP_GIT_CHECK=true | env on | argv omits `--skip-git-repo-check` |
| 2.4 | Codex resume | `--backend codex resume abc - "/proj"` | `codex e ... --json resume abc -` ; **no** `-C` |
| 2.5 | Claude new | `--backend claude - "/proj"` | `claude -p --setting-sources "" --output-format stream-json --verbose -` ; cwd=`/proj` |
| 2.6 | Claude resume | `--backend claude resume xyz - "/proj"` | `claude -p --setting-sources "" -r xyz --output-format stream-json --verbose -` |
| 2.7 | Gemini new (non-Windows) | `--backend gemini -m gemini-3.1-pro-preview - "/proj"` | `gemini -m gemini-3.1-pro-preview -o stream-json -y --include-directories /proj -p <task text>` ; cwd=`/proj` ; **no** stdin pipe |
| 2.8 | Gemini new (Windows) | same | argv omits `-p`; task text written to child stdin pipe ; cwd=`/proj` |
| 2.9 | Gemini resume (non-Windows) | `--backend gemini resume sid - "/proj"` | argv: `-o stream-json -y -r sid -p <task>` ; **no** `--include-directories` |
| 2.10 | Gemini new without model | `--backend gemini - "/proj"` | argv has no `-m` flag |

## 3. Stdin handling

| # | Test | Input | Expected | Compare |
|---|------|-------|----------|---------|
| 3.1 | Explicit `-` reads heredoc | `... - "/proj" <<EOF\nhello\nEOF` | task `hello\n` flows to backend (codex via `-` argv + stdin) | dump stub-received stdin; both byte-equal |
| 3.2 | Length > 800 → stdin mode | new task argv `<800-char text>` (no newlines/special) | argv last token is `-`; full text on stdin | stub-received argv last token == `-` |
| 3.3 | Newline in task text → stdin mode | `... "first\nsecond" "/proj"` | argv last token is `-`; both lines on stdin | argv last token == `-` |
| 3.4 | Backtick / `$` triggers stdin | `... 'echo $X' "/proj"` | argv last token is `-` | argv last token == `-` |
| 3.5 | Short plain text → no stdin mode | `... "do thing" "/proj"` | argv last token is the literal text | argv last token == `do thing` |

## 4. ROLE_FILE injection

| # | Test | Input | Expected | Compare |
|---|------|-------|----------|---------|
| 4.1 | `~/...` expansion | first stdin line `ROLE_FILE: ~/.claude/.ccg/prompts/codex/debugger.md` | line replaced with file contents (verified by checking the stub backend received contents, not the literal line) | byte-diff stub-received task body |
| 4.2 | Missing file falls back | `ROLE_FILE: /nonexistent/path` | original line preserved; warning to stderr | both stderr contain `Failed to read ROLE_FILE`; stub task body contains the literal `ROLE_FILE:` line |
| 4.3 | Windows `/c/Users/...` form | on Windows, `ROLE_FILE: /c/Users/...` | path normalised to `C:/Users/...` and read | stub-received body equals file content |
| 4.4 | Multiple ROLE_FILE lines | two lines with different paths | each replaced independently | full-body byte diff |
| 4.5 | Mid-text ROLE_FILE (multi-line mode) | `<text>\nROLE_FILE: x\n<text>` | only the matching line replaced; surrounding text preserved | full-body byte diff |

## 5. JSON-stream parsing

Use stubs that emit pre-recorded line streams.

| # | Test | Stub emits | Expected stdout | Compare |
|---|------|-----------|-----------------|---------|
| 5.1 | Codex happy path | `thread.started{thread_id:"t-1"}`, `turn.started`, `item.completed{item:{type:"agent_message",text:"hi"}}`, `turn.completed{thread_id:"t-1"}` | stdout: `hi\n---\nSESSION_ID: t-1\n` ; exit 0 | byte diff on stdout |
| 5.2 | Codex `text` is array | `agent_message item.text:["a","b","c"]` | stdout: `abc...` | byte diff on stdout |
| 5.3 | Claude happy path | `result{result:"yo",session_id:"sess-1"}` | stdout: `yo\n---\nSESSION_ID: sess-1\n` |
| 5.4 | Gemini camelCase id | `init{sessionId:"g-1"}`, `assistant{role:"model",content:"part1"}`, `assistant{role:"model",content:"part2"}`, `result{type:"result",status:"success"}` | stdout: `part1part2\n---\nSESSION_ID: g-1\n` |
| 5.5 | Gemini init prefixed with MCP banner | `MCP issues detected. Run /mcp list for status.{"type":"init","sessionId":"g-2"}` | session id captured; no parse warning beyond first attempt | both stderr eventually print `Session-ID: g-2` |
| 5.6 | Empty agent_message | only `turn.completed`, no message | exit 1; stderr mentions `completed without agent_message output` |
| 5.7 | Overlong JSON line | one event > 10 MiB | line skipped with warn; subsequent events still parsed | both stderr contain `Skipped overlong JSON line` |
| 5.8 | Mixed binary on stderr | stub writes `(node:123) Warning: deprecation` on stderr | line filtered (not echoed to wrapper stderr) | parent stderr does NOT contain that string |
| 5.9 | Non-noise stderr passes through | stub writes `[error] something happened` on stderr | line preserved | parent stderr contains it |

## 6. Session ID emission

| # | Test | Stub emits | Expected | Compare |
|---|------|-----------|----------|---------|
| 6.1 | Early Session-ID stderr line | `thread.started{thread_id:"abc"}` immediately | stderr contains `  Session-ID: abc\n` BEFORE `agent_message` block | tail-grep stderr; both have line at first id |
| 6.2 | Session-ID stable across events | multiple events with same thread_id | `Session-ID:` printed once | exact count = 1 in both |
| 6.3 | Stdout SESSION_ID block | success path | stdout ends with `\n---\nSESSION_ID: <id>\n` | regex match |
| 6.4 | No SESSION_ID block on missing id | stub never sends id | stdout has no `SESSION_ID:` line | both: no match |

## 7. Post-message delay + force-kill

| # | Test | Behaviour | Expected | Compare |
|---|------|-----------|----------|---------|
| 7.1 | Default 5s window | stub emits `agent_message`, then `turn.completed` 200 ms later, then exits cleanly | wrapper exits 0, stdout ok | both exit 0, both elapse < 5 s |
| 7.2 | Lingering stub | stub emits `agent_message` + `turn.completed` then sleeps 60 s | wrapper kills child after delay window (default 5 s) and still exits 0 with message | both exit 0; both elapse 5 s ± 1 s |
| 7.3 | `--lite` shrinks delay | env CODEAGENT_LITE_MODE=true; stub same as 7.2 | wrapper exits within 1.5 s | both elapse ~1 s |
| 7.4 | `CODEAGENT_POST_MESSAGE_DELAY=2` override | stub same as 7.2 | wrapper exits within ~2.5 s | both elapse ~2 s |
| 7.5 | Cap at 60 s | env=999 | warning printed; capped; same outcome as 7.2 with 60 s window |
| 7.6 | Invalid env value | env=`abc` | warning + falls back to 5 s |

## 8. Exit codes

| # | Test | Setup | Expected | Compare |
|---|------|-------|----------|---------|
| 8.1 | Backend missing | PATH without `codex` | exit 127 | both 127 |
| 8.2 | Backend exits non-zero before message | stub exits 3, no `agent_message` | exit 3 | both 3 |
| 8.3 | Backend exits non-zero after message | stub emits agent_message then exits 3 | exit 3 ; stdout still printed (or 0 if forced after complete is true). **Verify against Go binary** — current spec text §3.3 + executor.go:1286 says forced-after-complete returns 0; raw non-zero exit from a backend that delivered a message but was NOT force-killed by us still returns the backend code | record actual behaviour from both |
| 8.4 | Timeout | env CODEX_TIMEOUT=2; stub sleeps 60 s | exit 124 | both 124 |
| 8.5 | SIGINT | start, send SIGINT | exit 130 ; child terminated | both 130 |
| 8.6 | Resume id missing | `resume "" - .` | exit 1 | both 1 |

## 9. Workdir / env injection

| # | Test | Setup | Expected | Compare |
|---|------|-------|----------|---------|
| 9.1 | Codex `-C` and no cwd | `--backend codex - "/proj"` | child cwd = wrapper's cwd; argv has `-C /proj` | inspect stub `pwd` output + argv |
| 9.2 | Gemini cwd = workdir | `--backend gemini - "/proj"` | child cwd = `/proj` | stub `pwd` |
| 9.3 | Claude cwd = workdir | `--backend claude - "/proj"` | child cwd = `/proj` | stub `pwd` |
| 9.4 | env from `~/.claude/settings.json` injected | settings.json `{"env":{"FOO":"bar"}}` | child env contains `FOO=bar` | stub `printenv FOO` |
| 9.5 | settings.json missing | no file | no error; child still spawns | both exit 0 |
| 9.6 | settings.json non-string value | `{"env":{"FOO":123}}` | non-string skipped; no error | child env lacks `FOO` |

## 10. Cross-platform process termination

| # | Test | Setup | Expected | Compare |
|---|------|-------|----------|---------|
| 10.1 | Unix SIGTERM → SIGKILL | stub traps SIGTERM and ignores | wrapper sends SIGTERM, then SIGKILL after 5 s | child exits within ~5 s |
| 10.2 | Windows taskkill /T | stub spawns a node child holding stdout | wrapper kills the entire tree | both: no orphan process under `wmic process where parentprocessid=<pid>` |
| 10.3 | Force-kill on parent SIGINT | stub running; press Ctrl+C twice | wrapper exits ≤ 5 s |

## 11. Banner / log line

| # | Test | Expected | Compare |
|---|------|----------|---------|
| 11.1 | Banner format | stderr begins with: `[codeagent-wrapper]\n  Backend: <b>\n  Command: ...\n  PID: <n>\n  Log: ...\n` | regex check; both have all five lines |
| 11.2 | Backend reflects flag | use each of codex/claude/gemini | line shows correct backend |

## 12. Stdin auto-detection edge cases

| # | Test | Setup | Expected | Compare |
|---|------|-------|----------|---------|
| 12.1 | Piped stdin without `-` | `echo task \| WRAPPER --backend codex "fallback" "/proj"` | Go: piped task wins; argv last token = `-` | shim parity |
| 12.2 | TTY stdin without `-` and short text | `WRAPPER "do x" "/proj"` | argv last token = `do x` | shim parity |

---

## Suggested fixture layout

```
.ccg-migration/
  fixtures/
    stubs/                # synthetic backends emitting prepared JSON streams
      codex-happy.sh
      codex-array-text.sh
      claude-happy.sh
      gemini-init-mcp-prefix.sh
      gemini-multi-content.sh
      lingering-trap.sh
      noisy-stderr.sh
      tree-spawner.{sh,cmd}
    cases/                # YAML or JSON case definitions consumed by a runner
    runner.mjs            # diff harness: runs WRAPPER vs SHIM with same fixture
```

Runner contract (rough):
1. For each case, set env, launch `WRAPPER` and `SHIM` with identical args + stdin.
2. Capture stdout, stderr, exit code, child cwd (via stub `pwd`), wall time.
3. Normalise volatile fields (PID, log path, timestamps, port numbers from stderr banner).
4. Diff stdout exactly (byte-equal). Diff stderr loosely (line-set after dropping volatile lines). Compare exit codes.
5. Mark fail on any diff.

## Out-of-scope

Per spec §1.3 / §8.6, **do not** test:
- `--parallel`, `--full-output`, `---TASK--- / ---CONTENT---` parser
- `--cleanup`
- WebServer / SSE
- ASCII mode
- Wrapper symlink alias (`codex-wrapper`)
- Async logger / log files / log rotation
- Structured report extraction (coverage / files-changed / tests-passed)

These rows would only validate code paths the shim deliberately does not implement; touching them would create false negatives.
