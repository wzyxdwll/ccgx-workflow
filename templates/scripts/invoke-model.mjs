#!/usr/bin/env node
// =============================================================================
//  invoke-model.mjs
//  ----------------------------------------------------------------------------
//  Node ESM replacement for `codeagent-wrapper` (Go binary v5.10.0).
//
//  ⚠️ DEPRECATED in v4.1 (2026-05-04, Phase 20)
//  ----------------------------------------------------------------------------
//  Replaced by `Agent(subagent_type="codex:codex-rescue")` and
//  `Agent(subagent_type="gemini:gemini-rescue")` in the 6 core CCG commands
//  (plan / execute / analyze / optimize / test / review).
//
//  Why: v4.0.1 nested-spawn validation + objective comparison showed plugin
//  rescue agents win 7 / 8 metrics (main-thread context drift, summary
//  protocol, error recovery, etc); the only metric codeagent-wrapper wins
//  ("full sandbox bypass") is unused in advisor scenarios.
//
//  Status: Kept as **BC fallback** when the user has not installed
//  `codex@openai-codex` and/or `gemini@google-gemini` plugins. Templates
//  detect plugin availability and route to the right path automatically.
//
//  Removal target: v5.0 (after 2 minor releases of dual-path coexistence).
//
//  Migration helper: `src/utils/plugin-detection.ts` exposes
//  `bothPluginsInstalled()` and per-plugin probes used by command
//  templates' fallback decision narrative.
//  ----------------------------------------------------------------------------
//
//  Source of truth: `.ccg-migration/INVOKE-MODEL-SPEC.md`
//  Cross-checked against `codeagent-wrapper/main.go`, `executor.go`,
//  `parser.go`, `backend.go`, `config.go`, `utils.go`, `filter.go`.
//
//  Equivalence with v5.10.0 (single-task path; --parallel/--cleanup/WebServer
//  intentionally omitted — see spec §1.3 / §8.6):
//    - CLI flags: --backend, --gemini-model[=], --progress, --lite/-L,
//      --skip-permissions / --dangerously-skip-permissions[=], --version/-v,
//      --help/-h
//    - Positional args: form A `[task|-] [workdir]`
//                       form B `resume <session_id> [task|-] [workdir]`
//    - Stdin auto-detection (explicit `-`, piped, special chars, len > 800)
//    - ROLE_FILE: line replacement (with ~ + Windows /c/ -> C:/ normalisation)
//    - codex `e --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check
//      --json [resume <id>] [-C <workdir>] <task|->`
//    - claude `-p [--dangerously-skip-permissions] --setting-sources ""
//      [-r <id>] --output-format stream-json --verbose <task|->`
//    - gemini `[-m <model>] -o stream-json -y [-r <id>]
//      [--include-directories <wd>] [-p <task>]` (Windows: omit -p, pipe stdin)
//    - JSON-line streaming parse for codex/claude/gemini events with
//      camelCase + snake_case session_id, codex item.text string|array
//      normalisation, MCP-prefix tolerant init line
//    - SESSION_ID emitted on stderr (early `  Session-ID: <id>`) AND on stdout
//      tail (`\n---\nSESSION_ID: <id>\n`)
//    - post-message delay (5s default, 1s lite, env override 0..60s) before
//      force-killing a backend that delivered agent_message but not
//      turn.completed
//    - stderr noise filter (10 substrings)
//    - `~/.claude/settings.json` env injection
//    - Cross-platform process termination (Windows taskkill /T /F /PID, Unix
//      SIGTERM + 5s SIGKILL fallback)
//    - Exit codes: 0 ok, 1 generic, 124 timeout, 127 not-found, 130 SIGINT,
//      passthrough otherwise
//    - --version prints `codeagent-wrapper version 5.10.0` (matches
//      installer.ts EXPECTED_BINARY_VERSION check)
//
//  Out of scope (intentionally NOT ported, see spec §1.3 / §8.6):
//    - --parallel / --full-output / ---TASK--- ---CONTENT--- protocol
//    - --cleanup / log file generation / async logger / log rotation
//    - WebServer / SSE streaming
//    - Structured report extraction (coverage / files / tests metrics)
//    - ASCII mode, wrapper symlink alias
//
//  Dependencies: Node.js built-in modules only.
// =============================================================================

import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';

// ---------------------------------------------------------------------------
// Constants (mirror codeagent-wrapper/main.go:16, executor.go:28,
// parser.go:57, filter.go:9).
// ---------------------------------------------------------------------------
const VERSION = '5.10.0';
const WRAPPER_NAME = 'codeagent-wrapper';
const DEFAULT_WORKDIR = '.';
const DEFAULT_TIMEOUT_SEC = 7200;            // 2h, matches Go defaultTimeout
const DEFAULT_BACKEND = 'codex';
const STDIN_SPECIAL_CHARS = '\n\\"\'`$';      // utils.go:22
const STDIN_LENGTH_THRESHOLD = 800;           // utils.go:54
const POST_MESSAGE_DELAY_DEFAULT_MS = 5_000;  // executor.go:36
const POST_MESSAGE_DELAY_LITE_MS = 1_000;     // executor.go:31
const POST_MESSAGE_DELAY_MAX_SEC = 60;        // executor.go:45
const FORCE_KILL_DELAY_MS = 5_000;            // main.go:67 forceKillDelay=5s
const FALLBACK_EXIT_GRACE_MS = 2_000;         // executor.go:1200 (+2s)
const STDOUT_DRAIN_TIMEOUT_MS = 100;          // main.go:31
const JSON_LINE_MAX_BYTES = 10 * 1024 * 1024; // parser.go:59
const PROGRESS_SNIPPET_MAX_RUNES = 120;       // parser.go:272
const MAX_CLAUDE_SETTINGS_BYTES = 1 << 20;    // backend.go:39
const STDERR_TAIL_BYTES = 4 * 1024;           // main.go:23

// filter.go:9-23
const STDERR_NOISE_PATTERNS = [
  '[STARTUP]',
  'Session cleanup disabled',
  'Warning:',
  '(node:',
  '(Use `node --trace-warnings',
  'Loaded cached credentials',
  'Loading extension:',
  'YOLO mode is enabled',
  '[WARN] Skipping unreadable directory',
  'supports tool updates. Listening for changes',
];

const IS_WINDOWS = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Tiny utilities
// ---------------------------------------------------------------------------
function envFlagEnabled(key) {
  const raw = process.env[key];
  if (raw === undefined) return false;
  const v = String(raw).trim().toLowerCase();
  return !(v === '' || v === '0' || v === 'false' || v === 'no' || v === 'off');
}

function parseBoolFlag(val, fallback) {
  const v = String(val ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function safeProgressSnippet(s, maxLen = PROGRESS_SNIPPET_MAX_RUNES) {
  let str = (s ?? '').replace(/\n/g, ' ');
  str = str.split(/\s+/).filter(Boolean).join(' ');
  const runes = [...str];
  if (maxLen <= 0 || runes.length <= maxLen) return str;
  if (maxLen <= 3) return runes.slice(0, maxLen).join('');
  return runes.slice(0, maxLen - 3).join('') + '...';
}

function quoteForProgress(s) { return JSON.stringify(s ?? ''); }

function normalizeWindowsPath(p) {
  // utils.go:125 — only invoked when running on Windows.
  let out = p.replace(/\\/g, '/');
  const m = /^\/([a-zA-Z])\//.exec(out);
  if (m) out = m[1].toUpperCase() + ':' + out.slice(2);
  return out;
}

// Mirror Go exec.LookPath: Node child_process.spawn does not consult PATHEXT
// on Windows, so `spawn('codex')` ENOENTs even when codex.cmd is in PATH.
// Replace bare command names with their resolved absolute path before spawn.
function lookPath(cmd, opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const stat = opts.statFn || statSync;
  if (platform !== 'win32') return cmd;
  if (path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) return cmd;
  const pathExt = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';').map((s) => s.trim()).filter(Boolean);
  // Mirror Go exec.LookPath: on Windows, an extensionless name like `codex` is
  // never executable on its own — must match PATHEXT. Only when the name
  // already contains a dot do we additionally try the raw form.
  const hasDot = cmd.includes('.');
  const candidates = hasDot
    ? [cmd, ...pathExt.map((e) => cmd + e)]
    : pathExt.map((e) => cmd + e);
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = (env.PATH || env.Path || '').split(sep).filter(Boolean);
  // Windows searches current directory first (CreateProcess), then PATH.
  for (const dir of ['', ...dirs]) {
    for (const c of candidates) {
      const full = dir ? path.join(dir, c) : c;
      try {
        const info = stat(full);
        if (info && info.isFile && info.isFile()) return full;
      } catch { /* not found, continue */ }
    }
  }
  return cmd; // let spawn surface ENOENT
}

// Resolve `cmd` against PATH (POSIX) or PATH+PATHEXT (Windows).
// Returns null when the binary is not found, giving callers a chance to emit
// a friendly install hint before spawn raises ENOENT.
function resolveOnPath(cmd, opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const stat = opts.statFn || statSync;
  if (path.isAbsolute(cmd) || cmd.includes('/') || (platform === 'win32' && cmd.includes('\\'))) {
    try { const info = stat(cmd); if (info && info.isFile && info.isFile()) return cmd; }
    catch { /* fallthrough */ }
    return null;
  }
  if (platform === 'win32') {
    const resolved = lookPath(cmd, opts);
    return resolved !== cmd ? resolved : null;
  }
  const dirs = (env.PATH || '').split(':').filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, cmd);
    try { const info = stat(full); if (info && info.isFile && info.isFile()) return full; }
    catch { /* keep scanning */ }
  }
  return null;
}

// Print install guidance and exit 127 when the requested backend CLI is not
// on PATH. Prefers Claude Code plugins (one-click) over manual CLI install.
function exitMissingBackend(backend) {
  const pluginInstall = backend === 'codex'
    ? '/plugins install codex@openai-codex'
    : backend === 'gemini'
      ? '/plugins install gemini@gemini-ccgx (ccgx 2.0.0 fork, recommended) — or /plugins install gemini@google-gemini (upstream)'
      : null;
  const npmInstall = backend === 'codex'
    ? 'npm i -g @openai/codex'
    : backend === 'gemini'
      ? 'npm i -g @google/gemini-cli'
      : null;
  process.stderr.write([
    '',
    `❌ ccgx-workflow fallback: '${backend}' CLI not found on PATH.`,
    '',
    'Pick one of:',
    pluginInstall
      ? `  • Plugin (recommended): in Claude Code run  ${pluginInstall}`
      : `  • Plugin route is unavailable for backend "${backend}".`,
    npmInstall
      ? `  • CLI fallback: ${npmInstall}   then  ${backend} login / auth`
      : '',
    '',
    'After installing, start a new Claude Code session.',
    '',
  ].filter(Boolean).join('\n') + '\n');
}

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(homedir(), p.slice(2));
  }
  return p;
}

function logWarn(msg) { process.stderr.write(`[WARN] ${msg}\n`); }
function logError(msg) { process.stderr.write(`[ERROR] ${msg}\n`); }

// ---------------------------------------------------------------------------
// ROLE_FILE injection (utils.go:75)
// ---------------------------------------------------------------------------
function injectRoleFile(taskText) {
  return taskText.replace(/^ROLE_FILE:\s*(.+)$/gm, (match, rawPath) => {
    let filePath = rawPath.trim();
    filePath = expandHome(filePath);
    if (IS_WINDOWS) filePath = normalizeWindowsPath(filePath);
    try {
      return readFileSync(filePath, 'utf8');
    } catch (err) {
      logWarn(`Failed to read ROLE_FILE '${filePath}': ${err.message}`);
      return match; // preserve original line on read failure (utils.go:108)
    }
  });
}

// ---------------------------------------------------------------------------
// `~/.claude/settings.json` env loader (backend.go:43)
// ---------------------------------------------------------------------------
function loadMinimalEnvSettings() {
  let home;
  try { home = homedir(); } catch { return {}; }
  if (!home) return {};
  const settingsPath = path.join(home, '.claude', 'settings.json');
  let info;
  try { info = statSync(settingsPath); } catch { return {}; }
  if (!info || info.size > MAX_CLAUDE_SETTINGS_BYTES) return {};
  let data;
  try { data = readFileSync(settingsPath, 'utf8'); } catch { return {}; }
  let parsed;
  try { parsed = JSON.parse(data); } catch { return {}; }
  const env = {};
  if (parsed && typeof parsed === 'object' && parsed.env && typeof parsed.env === 'object') {
    for (const [k, v] of Object.entries(parsed.env)) {
      if (typeof v === 'string') env[k] = v;
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// Argument parsing (config.go:197)
// ---------------------------------------------------------------------------
function parseCliArgs(argv) {
  let backend = DEFAULT_BACKEND;
  let geminiModel = (process.env.GEMINI_MODEL || '').trim();
  let progress = false;
  let lite = envFlagEnabled('CODEAGENT_LITE_MODE');
  let skipPermissions = envFlagEnabled('CODEAGENT_SKIP_PERMISSIONS');
  const filtered = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lite' || a === '-L') { lite = true; continue; }
    if (a === '--progress') { progress = true; continue; }
    if (a === '--backend') {
      if (i + 1 >= argv.length) throw new Error('--backend flag requires a value');
      backend = argv[++i];
      continue;
    }
    if (a.startsWith('--backend=')) {
      const v = a.slice('--backend='.length);
      if (!v) throw new Error('--backend flag requires a value');
      backend = v;
      continue;
    }
    if (a === '--gemini-model') {
      if (i + 1 >= argv.length) throw new Error('--gemini-model flag requires a non-empty model name');
      const v = (argv[++i] || '').trim();
      if (!v) throw new Error('--gemini-model flag requires a non-empty model name');
      geminiModel = v;
      continue;
    }
    if (a.startsWith('--gemini-model=')) {
      const v = a.slice('--gemini-model='.length).trim();
      if (!v) throw new Error('--gemini-model flag requires a non-empty model name');
      geminiModel = v;
      continue;
    }
    if (a === '--skip-permissions' || a === '--dangerously-skip-permissions') { skipPermissions = true; continue; }
    if (a.startsWith('--skip-permissions=')) {
      skipPermissions = parseBoolFlag(a.slice('--skip-permissions='.length), skipPermissions);
      continue;
    }
    if (a.startsWith('--dangerously-skip-permissions=')) {
      skipPermissions = parseBoolFlag(a.slice('--dangerously-skip-permissions='.length), skipPermissions);
      continue;
    }
    filtered.push(a);
  }

  if (filtered.length === 0) throw new Error('task required');

  const cfg = {
    mode: 'new',
    task: '',
    sessionId: '',
    workDir: DEFAULT_WORKDIR,
    explicitStdin: false,
    backend: (backend || DEFAULT_BACKEND).toLowerCase().trim(),
    skipPermissions,
    geminiModel,
    progress,
    lite,
  };

  if (filtered[0] === 'resume') {
    if (filtered.length < 3) throw new Error('resume mode requires: resume <session_id> <task>');
    cfg.mode = 'resume';
    cfg.sessionId = (filtered[1] || '').trim();
    if (!cfg.sessionId) throw new Error('resume mode requires non-empty session_id');
    cfg.task = filtered[2];
    cfg.explicitStdin = filtered[2] === '-';
    if (filtered.length > 3) cfg.workDir = filtered[3];
  } else {
    cfg.task = filtered[0];
    cfg.explicitStdin = filtered[0] === '-';
    if (filtered.length > 1) cfg.workDir = filtered[1];
  }

  if (!['codex', 'gemini', 'claude'].includes(cfg.backend)) {
    throw new Error(`unsupported backend "${cfg.backend}"`);
  }
  return cfg;
}

function shouldUseStdin(taskText, piped) {
  if (piped) return true;
  if (taskText.length > STDIN_LENGTH_THRESHOLD) return true;
  for (const c of STDIN_SPECIAL_CHARS) if (taskText.includes(c)) return true;
  return false;
}

function resolveTimeoutSec() {
  const raw = (process.env.CODEX_TIMEOUT || '').trim();
  if (!raw) return DEFAULT_TIMEOUT_SEC;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    logWarn(`Invalid CODEX_TIMEOUT '${raw}', falling back to ${DEFAULT_TIMEOUT_SEC}s`);
    return DEFAULT_TIMEOUT_SEC;
  }
  return n > 10000 ? Math.floor(n / 1000) : n;
}

function resolvePostMessageDelayMs(lite) {
  if (lite) return POST_MESSAGE_DELAY_LITE_MS;
  const raw = (process.env.CODEAGENT_POST_MESSAGE_DELAY || '').trim();
  if (!raw) return POST_MESSAGE_DELAY_DEFAULT_MS;
  const v = Number.parseInt(raw, 10);
  if (!Number.isFinite(v) || v < 0) {
    logWarn(`Invalid CODEAGENT_POST_MESSAGE_DELAY=${JSON.stringify(raw)}, falling back to 5s`);
    return POST_MESSAGE_DELAY_DEFAULT_MS;
  }
  if (v > POST_MESSAGE_DELAY_MAX_SEC) {
    logWarn(`CODEAGENT_POST_MESSAGE_DELAY=${v} exceeds 60s, capping at 60s`);
    return POST_MESSAGE_DELAY_MAX_SEC * 1000;
  }
  return v * 1000;
}

// ---------------------------------------------------------------------------
// Backend argv builders (backend.go + executor.go:757 buildCodexArgs)
// ---------------------------------------------------------------------------
function buildCodexArgs(cfg, targetArg) {
  const args = ['e'];
  if (!envFlagEnabled('CODEX_REQUIRE_APPROVAL')) args.push('--dangerously-bypass-approvals-and-sandbox');
  if (!envFlagEnabled('CODEX_DISABLE_SKIP_GIT_CHECK')) args.push('--skip-git-repo-check');
  if (cfg.mode === 'resume') {
    args.push('--json', 'resume', cfg.sessionId, targetArg);
    return args;
  }
  args.push('-C', cfg.workDir, '--json', targetArg);
  return args;
}

function buildClaudeArgs(cfg, targetArg) {
  const args = ['-p'];
  if (cfg.skipPermissions) args.push('--dangerously-skip-permissions');
  args.push('--setting-sources', '');
  if (cfg.mode === 'resume' && cfg.sessionId) args.push('-r', cfg.sessionId);
  args.push('--output-format', 'stream-json', '--verbose', targetArg);
  return args;
}

function buildGeminiArgs(cfg, targetArg) {
  const args = [];
  const model = (cfg.geminiModel || '').trim();
  if (model) args.push('-m', model);
  args.push('-o', 'stream-json', '-y');
  if (cfg.mode === 'resume' && cfg.sessionId) args.push('-r', cfg.sessionId);
  if (cfg.mode !== 'resume' && cfg.workDir) args.push('--include-directories', cfg.workDir);
  if (targetArg !== '') args.push('-p', targetArg);
  return args;
}

function backendCommandAndArgs(cfg, targetArg) {
  switch (cfg.backend) {
    case 'codex': return { command: 'codex', args: buildCodexArgs(cfg, targetArg) };
    case 'claude': return { command: 'claude', args: buildClaudeArgs(cfg, targetArg) };
    case 'gemini': return { command: 'gemini', args: buildGeminiArgs(cfg, targetArg) };
    default: throw new Error(`unsupported backend "${cfg.backend}"`);
  }
}

// ---------------------------------------------------------------------------
// Stderr noise filter (filter.go) — line-buffered.
// ---------------------------------------------------------------------------
function makeStderrFilter(target) {
  let pending = '';
  const tail = []; let tailLen = 0;
  const appendTail = (s) => {
    tail.push(s); tailLen += Buffer.byteLength(s, 'utf8');
    while (tailLen > STDERR_TAIL_BYTES && tail.length > 1) {
      tailLen -= Buffer.byteLength(tail.shift(), 'utf8');
    }
  };
  const shouldFilter = (line) => STDERR_NOISE_PATTERNS.some((p) => line.includes(p));
  return {
    write(chunk) {
      pending += chunk;
      let idx;
      while ((idx = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, idx + 1);
        pending = pending.slice(idx + 1);
        appendTail(line);
        if (!shouldFilter(line)) target.write(line);
      }
    },
    flush() {
      if (!pending) return;
      appendTail(pending);
      if (!shouldFilter(pending)) target.write(pending);
      pending = '';
    },
    tail() { return tail.join('').slice(-STDERR_TAIL_BYTES); },
  };
}

// ---------------------------------------------------------------------------
// JSON-line stream parser (parser.go).
//
// Yields a parsed { message, sessionId } and emits side-effect callbacks
// (onMessage / onComplete / onProgress / onSession) similar to
// parseJSONStreamInternalWithContent.
// ---------------------------------------------------------------------------
function makeJsonStreamParser({ onProgress, onSession, onMessage, onComplete }) {
  let pending = Buffer.alloc(0);
  let totalEvents = 0;
  let codexMessage = '';
  let claudeMessage = '';
  const geminiBuffer = [];
  let sessionId = '';

  const emitProgress = (event, fields) => {
    if (!onProgress) return;
    const parts = [event];
    if (fields) {
      for (const key of ['id', 'text', 'cmd', 'exit', 'total_events']) {
        const v = fields[key];
        if (v !== undefined && String(v).trim() !== '') parts.push(`${key}=${v}`);
      }
    }
    onProgress(`[PROGRESS] ${parts.join(' ')}`);
  };

  const emitSession = (id) => {
    if (!id) return;
    if (!sessionId) sessionId = id;
    if (onSession) onSession(id);
  };

  // codex agent_message text may be string or []string (parser.go:522)
  const normalizeText = (t) => {
    if (typeof t === 'string') return t;
    if (Array.isArray(t)) return t.filter((x) => typeof x === 'string').join('');
    return '';
  };

  const handleLine = (rawLine) => {
    let line = rawLine.trim();
    if (!line) return;
    if (Buffer.byteLength(line, 'utf8') > JSON_LINE_MAX_BYTES) {
      logWarn(`Skipped overlong JSON line (> ${JSON_LINE_MAX_BYTES} bytes)`);
      return;
    }
    totalEvents++;

    let evt;
    try { evt = JSON.parse(line); }
    catch (_) {
      // Gemini init line may be prefixed with MCP banner text (parser.go:178)
      const idx = line.indexOf('{');
      if (idx > 0) {
        try { evt = JSON.parse(line.slice(idx)); }
        catch (_e2) { return; }
      } else { return; }
    }
    if (!evt || typeof evt !== 'object') return;

    // Session id from snake_case OR camelCase (parser.go:97)
    const evtSession = evt.session_id || evt.sessionId || '';
    if (evtSession && !sessionId) emitSession(evtSession);

    const itemType = evt.item && typeof evt.item === 'object' ? evt.item.type : '';
    const isCodex = !!evt.thread_id || evt.type === 'turn.completed' || evt.type === 'turn.started' || (evt.item && itemType);
    const isClaude = (evt.subtype !== undefined && evt.subtype !== '') || (evt.result !== undefined && evt.result !== '')
      || (evt.type === 'result' && evtSession && evt.status === undefined);
    const isGemini = (evt.role !== undefined && evt.role !== '')
      || evt.delta !== undefined
      || (evt.status !== undefined && evt.status !== '')
      || (evt.type === 'init' && evtSession);

    if (isCodex) {
      switch (evt.type) {
        case 'thread.started':
          if (evt.thread_id) emitSession(evt.thread_id);
          emitProgress('session_started', { id: sessionId });
          break;
        case 'turn.started':
          emitProgress('turn_started');
          break;
        case 'thread.completed':
        case 'turn.completed': {
          if (evt.thread_id && !sessionId) emitSession(evt.thread_id);
          const ev = evt.type === 'thread.completed' ? 'session_completed' : 'turn_completed';
          emitProgress(ev, { total_events: totalEvents });
          if (onComplete) onComplete();
          break;
        }
        case 'item.completed': {
          if (itemType === 'agent_message' || itemType === 'reasoning') {
            const text = normalizeText(evt.item && evt.item.text);
            if (text) {
              if (itemType === 'agent_message') {
                codexMessage = text;
                if (onMessage) onMessage();
                emitProgress('message', { text: quoteForProgress(safeProgressSnippet(text)) });
              } else {
                emitProgress('reasoning', { text: quoteForProgress(safeProgressSnippet(text)) });
              }
            }
          } else if (itemType === 'command_execution') {
            const cmdItem = evt.item || {};
            const fields = { cmd: quoteForProgress(safeProgressSnippet(cmdItem.command || '')) };
            if (cmdItem.exit_code !== undefined && cmdItem.exit_code !== null) fields.exit = cmdItem.exit_code;
            emitProgress('cmd_done', fields);
          } else if (itemType === 'mcp_tool_call') {
            emitProgress('mcp_call');
          }
          break;
        }
      }
      return;
    }

    if (isClaude) {
      if (typeof evt.result === 'string' && evt.result !== '') {
        claudeMessage = evt.result;
        if (onMessage) onMessage();
      }
      if (evt.type === 'result' && onComplete) onComplete();
      return;
    }

    if (isGemini) {
      if (typeof evt.content === 'string' && evt.content !== '') geminiBuffer.push(evt.content);
      if (evt.status) {
        if (onMessage) onMessage();
        if (evt.type === 'result' && ['success', 'error', 'complete', 'failed'].includes(evt.status) && onComplete) onComplete();
      }
      return;
    }
    // unknown event — ignore
  };

  return {
    feed(buf) {
      pending = pending.length === 0 ? buf : Buffer.concat([pending, buf]);
      let nlIdx;
      while ((nlIdx = pending.indexOf(0x0a)) !== -1) {
        const lineBuf = pending.subarray(0, nlIdx);
        pending = pending.subarray(nlIdx + 1);
        handleLine(lineBuf.toString('utf8'));
      }
    },
    end() {
      if (pending.length > 0) {
        handleLine(pending.toString('utf8'));
        pending = Buffer.alloc(0);
      }
    },
    result() {
      let message;
      if (geminiBuffer.length > 0) message = geminiBuffer.join('');
      else if (claudeMessage) message = claudeMessage;
      else message = codexMessage;
      return { message, sessionId };
    },
  };
}

// ---------------------------------------------------------------------------
// Process termination (executor.go:1421 killProcessTree, terminateCommand).
// ---------------------------------------------------------------------------
function killWindowsTree(pid) {
  try {
    const r = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
      stdio: 'ignore',
      windowsHide: true,
    });
    r.on('error', () => {});
  } catch { /* ignore */ }
}

function terminateChild(child, { force } = { force: false }) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (IS_WINDOWS) {
    killWindowsTree(child.pid);
    return;
  }
  try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Read full stdin into a UTF-8 string.
// ---------------------------------------------------------------------------
function readAllStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (d) => chunks.push(d));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function isStdinPiped() {
  try { return !process.stdin.isTTY; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Help / version
// ---------------------------------------------------------------------------
function printHelp() {
  process.stdout.write(`${WRAPPER_NAME} - Node shim for AI CLI backends (replaces Go binary v${VERSION})

Usage:
    ${WRAPPER_NAME} [--backend codex|gemini|claude] [--gemini-model NAME] [--progress] [--lite] "task" [workdir]
    ${WRAPPER_NAME} [flags] - [workdir]                       Read task from stdin
    ${WRAPPER_NAME} [flags] resume <session_id> "task" [workdir]
    ${WRAPPER_NAME} [flags] resume <session_id> - [workdir]
    ${WRAPPER_NAME} --version
    ${WRAPPER_NAME} --help

Exit codes: 0 ok | 1 error | 124 timeout | 127 not-found | 130 SIGINT | else passthrough
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0) { printHelp(); return 1; }
  const first = argv[0];
  if (first === '--version' || first === '-v') {
    process.stdout.write(`${WRAPPER_NAME} version ${VERSION}\n`);
    return 0;
  }
  if (first === '--help' || first === '-h') { printHelp(); return 0; }

  let cfg;
  try { cfg = parseCliArgs(argv); }
  catch (e) { logError(e.message); return 1; }

  if (cfg.geminiModel && cfg.backend !== 'gemini') {
    logWarn('--gemini-model parameter is only effective with --backend gemini');
  }

  const timeoutSec = resolveTimeoutSec();

  // Resolve task text -------------------------------------------------------
  const piped = isStdinPiped();
  let taskText;
  if (cfg.explicitStdin) {
    const data = await readAllStdin();
    if (!data) { logError('Explicit stdin mode requires task input from stdin'); return 1; }
    taskText = data;
  } else if (piped) {
    const data = await readAllStdin();
    taskText = data || cfg.task;
  } else {
    taskText = cfg.task;
  }
  taskText = injectRoleFile(taskText);

  const useStdin = cfg.explicitStdin || shouldUseStdin(taskText, piped);

  // targetArg switch (executor.go:864)
  const geminiDirect = useStdin && cfg.backend === 'gemini' && !IS_WINDOWS;
  const geminiStdinPipe = useStdin && cfg.backend === 'gemini' && IS_WINDOWS;
  let targetArg = taskText;
  if (useStdin && !geminiDirect && !geminiStdinPipe) targetArg = '-';
  if (geminiStdinPipe) targetArg = '';

  const { command, args } = backendCommandAndArgs(cfg, targetArg);

  // Friendly fail when the backend CLI is not installed.
  // Skip for absolute paths — those are already explicit user intent.
  if (!path.isAbsolute(command) && !command.includes('/') && !command.includes('\\')) {
    if (resolveOnPath(command) === null) {
      exitMissingBackend(cfg.backend);
      return 127;
    }
  }

  // Startup banner (main.go:432)
  process.stderr.write(
    `[${WRAPPER_NAME}]\n` +
    `  Backend: ${cfg.backend}\n` +
    `  Command: ${command} ${args.join(' ')}\n` +
    `  PID: ${process.pid}\n` +
    `  Log: <stderr>\n`,
  );

  // Spawn ------------------------------------------------------------------
  const env = { ...process.env, ...loadMinimalEnvSettings() };
  const spawnOpts = {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env,
  };
  // Codex passes workdir via -C flag — don't set Dir (executor.go:1001).
  if (cfg.mode !== 'resume' && cfg.workDir && cfg.backend !== 'codex') {
    spawnOpts.cwd = cfg.workDir;
  }

  let resolvedCommand = lookPath(command);
  let resolvedArgs = args;
  // Windows: spawning .cmd/.bat directly throws EINVAL (Node CVE-2024-27980
  // mitigation). Wrap with cmd.exe /c to keep arg array semantics without
  // tripping DEP0190 (`shell:true + args[]` deprecation in Node 24+).
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(resolvedCommand)) {
    spawnOpts.windowsVerbatimArguments = true;
    resolvedArgs = ['/d', '/s', '/c', `"${resolvedCommand}"`, ...args];
    resolvedCommand = process.env.ComSpec || 'cmd.exe';
  }

  let child;
  try { child = spawn(resolvedCommand, resolvedArgs, spawnOpts); }
  catch (e) {
    logError(`failed to start ${command}: ${e.message}`);
    return 1;
  }

  let spawnErrored = false;
  child.on('error', (err) => {
    spawnErrored = true;
    if (err && err.code === 'ENOENT') {
      logError(`${command} command not found in PATH`);
      mainExitCode = 127;
    } else {
      logError(`failed to start ${command}: ${err && err.message ? err.message : String(err)}`);
      mainExitCode = 1;
    }
  });

  // Stdin -------------------------------------------------------------------
  // For non-gemini-direct stdin path, write taskText then close.
  if (useStdin && !geminiDirect && child.stdin) {
    child.stdin.on('error', () => { /* swallow EPIPE */ });
    child.stdin.end(taskText, 'utf8');
  } else if (child.stdin && !useStdin) {
    // Even when not piping a task, ensure the child's stdin is closed so it
    // does not block waiting for input.
    child.stdin.end();
  }

  // Stderr filter -----------------------------------------------------------
  const stderrFilter = makeStderrFilter(process.stderr);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderrFilter.write(chunk));

  // Stdout JSON parsing -----------------------------------------------------
  let messageSeen = false;
  let completeSeen = false;
  let postMessageTimer = null;
  let fallbackExitTimer = null;
  let forceKillTimer = null;
  let forcedAfterComplete = false;
  let sessionEmitted = false;
  let sessionId = '';

  const onSession = (id) => {
    if (sessionEmitted || !id) return;
    sessionEmitted = true;
    sessionId = id;
    process.stderr.write(`  Session-ID: ${id}\n`);
  };

  const startPostMessageTimer = () => {
    if (postMessageTimer) return;
    postMessageTimer = setTimeout(() => {
      postMessageTimer = null;
      forcedAfterComplete = true;
      // Close stdout BEFORE killing on Windows so cmd.Wait()-equivalent
      // (the 'exit' / 'close' events) is unblocked (executor.go:1190).
      try { child.stdout.destroy(); } catch { /* ignore */ }
      terminateChild(child);
      // Schedule force-kill (5s on Unix; immediate is no-op on Windows since
      // taskkill /F already happened above).
      if (!IS_WINDOWS && !forceKillTimer) {
        forceKillTimer = setTimeout(() => terminateChild(child, { force: true }), FORCE_KILL_DELAY_MS);
      }
      // Fallback exit timer (executor.go:1199): if 'exit' never fires, bail.
      if (!fallbackExitTimer) {
        fallbackExitTimer = setTimeout(() => {
          fallbackExitTimer = null;
          finalize({ forced: true });
        }, FORCE_KILL_DELAY_MS + FALLBACK_EXIT_GRACE_MS);
      }
    }, resolvePostMessageDelayMs(cfg.lite));
  };

  const parser = makeJsonStreamParser({
    onProgress: cfg.progress ? (line) => process.stderr.write(line + '\n') : undefined,
    onSession,
    onMessage: () => { messageSeen = true; },
    onComplete: () => {
      completeSeen = true;
      // post-message delay window opens when we observe completion
      // (executor.go:1210 — but post-delay timer started after the FIRST
      // completion event regardless of message arrival).
      startPostMessageTimer();
    },
  });
  child.stdout.on('data', (chunk) => parser.feed(chunk));
  child.stdout.on('end', () => parser.end());

  // Signal handling ---------------------------------------------------------
  let externalSignal = null;
  const installSignalHandlers = () => {
    const onSig = (sig) => {
      externalSignal = sig;
      terminateChild(child);
      if (!IS_WINDOWS && !forceKillTimer) {
        forceKillTimer = setTimeout(() => terminateChild(child, { force: true }), FORCE_KILL_DELAY_MS);
      }
    };
    process.on('SIGINT', () => onSig('SIGINT'));
    process.on('SIGTERM', () => onSig('SIGTERM'));
  };
  installSignalHandlers();

  // Timeout -----------------------------------------------------------------
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    terminateChild(child);
    if (!IS_WINDOWS && !forceKillTimer) {
      forceKillTimer = setTimeout(() => terminateChild(child, { force: true }), FORCE_KILL_DELAY_MS);
    }
  }, timeoutSec * 1000);

  // Wait for exit + finalize ------------------------------------------------
  let mainExitCode = 0;
  let finalized = false;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  const finalize = ({ forced = false } = {}) => {
    if (finalized) return;
    finalized = true;
    clearTimeout(timeoutHandle);
    if (postMessageTimer) clearTimeout(postMessageTimer);
    if (fallbackExitTimer) clearTimeout(fallbackExitTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);

    // Drain any tail bytes from stdout/stderr.
    parser.end();
    stderrFilter.flush();
    resolveDone(forced);
  };

  child.on('exit', () => {
    // Allow stdout 'end' event to arrive before parsing the result so we don't
    // miss a trailing turn.completed event.
    setTimeout(finalize, STDOUT_DRAIN_TIMEOUT_MS);
  });
  child.on('close', () => setTimeout(finalize, STDOUT_DRAIN_TIMEOUT_MS));

  await done;

  // Determine exit code -----------------------------------------------------
  const { message, sessionId: parsedSession } = parser.result();
  const finalSession = sessionId || parsedSession;

  if (spawnErrored) {
    return mainExitCode || 1;
  }
  if (externalSignal) return 130;
  if (timedOut) return 124;

  const childExit = child.exitCode;
  const childSig = child.signalCode;

  // forcedAfterComplete + non-empty message -> success (executor.go:1286)
  if (forcedAfterComplete && message) {
    process.stdout.write(message);
    if (finalSession) process.stdout.write(`\n---\nSESSION_ID: ${finalSession}\n`);
    return 0;
  }

  if (childExit !== null && childExit !== 0) {
    // Recent stderr tail for diagnostics
    const tail = stderrFilter.tail();
    if (tail) process.stderr.write(`\n=== Recent Errors ===\n${tail}`);
    return childExit;
  }
  if (childSig === 'SIGINT' || childSig === 'SIGTERM') return 130;

  if (!message) {
    logError(`${cfg.backend} completed without agent_message output`);
    return 1;
  }

  process.stdout.write(message);
  if (finalSession) process.stdout.write(`\n---\nSESSION_ID: ${finalSession}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point — only run when invoked as a script, so tests can import helpers.
// ---------------------------------------------------------------------------
const isMainModule = (() => {
  try {
    const entry = process.argv[1] && path.resolve(process.argv[1]);
    const self = new URL(import.meta.url).pathname;
    const selfNorm = process.platform === 'win32'
      ? path.resolve(self.replace(/^\//, ''))
      : path.resolve(self);
    return entry && entry === selfNorm;
  } catch { return true; }
})();

if (isMainModule) {
  main().then((code) => {
    // Flush stdout (Windows Git Bash bug, main.go:496).
    if (process.stdout.write('')) process.exit(code);
    else process.stdout.once('drain', () => process.exit(code));
  }).catch((err) => {
    logError(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}

export { lookPath };
