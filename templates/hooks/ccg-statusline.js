#!/usr/bin/env node
// ccg-hook: statusline
// Claude Code Statusline - CCG Edition
// Shows: model | context usage | git branch | session id (last 4)
//
// Crucial side effect: writes context metrics to
//   {os.tmpdir()}/claude-ctx-{session_id}.json
// which the ccg-context-monitor.js PostToolUse hook reads to inject
// agent-facing warnings when context usage is high. The two hooks form
// a producer/consumer pair on the bridge file.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// --- git branch (best-effort, silent on failure) ----------------------------

/**
 * Read the current git branch for the given directory. Returns '' on failure
 * (not a repo, git not installed, detached HEAD with no branch, etc).
 * Wrapped tightly so a slow/missing git never breaks the statusline.
 */
function readGitBranch(dir) {
  if (!dir || typeof dir !== 'string') return '';
  try {
    // --short prints the symbolic ref name without `refs/heads/` prefix.
    // Returns non-zero exit when detached; we catch and return ''.
    const out = execSync('git symbolic-ref --short HEAD', {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 500,
      windowsHide: true,
    }).toString().trim();
    if (!out) return '';
    // Defensive sanity bound: branch names rarely exceed 60 chars in practice.
    if (out.length > 80 || /[\s\\"<>]/.test(out)) return '';
    return out;
  } catch {
    return '';
  }
}

// --- core renderer ----------------------------------------------------------

function runStatusline() {
  let input = '';
  // Timeout guard: if stdin doesn't close within 3s (e.g. pipe issues on
  // Windows/Git Bash), exit silently instead of hanging.
  const stdinTimeout = setTimeout(() => process.exit(0), 3000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    clearTimeout(stdinTimeout);
    try {
      const data = JSON.parse(input);
      const model = data.model?.display_name || 'Claude';
      const dir = data.workspace?.current_dir || process.cwd();
      const session = data.session_id || '';
      const remaining = data.context_window?.remaining_percentage;

      // Context window display (shows USED percentage scaled to usable context).
      // Claude Code reserves a buffer for autocompact. By default this is ~16.5%
      // of the total window, but users can override it via CLAUDE_CODE_AUTO_COMPACT_WINDOW
      // (a token count). When the env var is set, compute the buffer % dynamically so
      // the meter correctly reflects early-compaction configurations.
      const totalCtx = data.context_window?.total_tokens || 1_000_000;
      const acw = parseInt(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '0', 10);
      const AUTO_COMPACT_BUFFER_PCT = acw > 0
        ? Math.min(100, (acw / totalCtx) * 100)
        : 16.5;
      let ctx = '';
      if (remaining != null) {
        // Normalize: subtract buffer from remaining, scale to usable range
        const usableRemaining = Math.max(
          0,
          ((remaining - AUTO_COMPACT_BUFFER_PCT) / (100 - AUTO_COMPACT_BUFFER_PCT)) * 100,
        );
        const used = Math.max(0, Math.min(100, Math.round(100 - usableRemaining)));

        // Write context metrics to bridge file for the context-monitor PostToolUse hook.
        // The monitor reads this file to inject agent-facing warnings when context is low.
        // Reject session IDs with path separators or traversal sequences to prevent
        // a malicious session_id from writing files outside the temp directory.
        const sessionSafe = session && !/[/\\]|\.\./.test(session);
        if (sessionSafe) {
          try {
            const bridgePath = path.join(os.tmpdir(), `claude-ctx-${session}.json`);
            // used_pct written to the bridge must match CC's native /context reporting:
            // raw used = 100 - remaining_percentage (no buffer normalization applied).
            // The normalized `used` value is correct for the statusline progress bar but
            // would inflate the context monitor warning messages by ~13 points.
            const rawUsedPct = Math.round(100 - remaining);
            const bridgeData = JSON.stringify({
              session_id: session,
              remaining_percentage: remaining,
              used_pct: rawUsedPct,
              timestamp: Math.floor(Date.now() / 1000),
            });
            fs.writeFileSync(bridgePath, bridgeData);
          } catch (e) {
            // Silent fail -- bridge is best-effort, don't break statusline
          }
        }

        // Build progress bar (10 segments)
        const filled = Math.floor(used / 10);
        const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);

        // Color based on usable context thresholds
        if (used < 50) {
          ctx = ` \x1b[32m${bar} ${used}%\x1b[0m`;
        } else if (used < 65) {
          ctx = ` \x1b[33m${bar} ${used}%\x1b[0m`;
        } else if (used < 80) {
          ctx = ` \x1b[38;5;208m${bar} ${used}%\x1b[0m`;
        } else {
          ctx = ` \x1b[5;31m! ${bar} ${used}%\x1b[0m`;
        }
      }

      // Compose CCG-style status line:
      //   <model> | <ctx> | <branch> | <sid4>
      const branch = readGitBranch(dir);
      const sid4 = session && session.length >= 4 ? session.slice(-4) : '';

      const segments = [`\x1b[2m${model}\x1b[0m`];
      if (ctx) segments.push(ctx.trim());
      if (branch) segments.push(`\x1b[36m${branch}\x1b[0m`);
      if (sid4) segments.push(`\x1b[2m#${sid4}\x1b[0m`);

      process.stdout.write(segments.join(' │ '));
    } catch (e) {
      // Silent fail - don't break statusline on parse errors
    }
  });
}

// Export helpers for unit tests. Harmless when run as a script.
module.exports = { readGitBranch };

if (require.main === module) runStatusline();
