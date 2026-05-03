#!/usr/bin/env node
// ccg-hook: context-monitor
// Context Monitor - PostToolUse hook for CCG Workflow.
// Reads context metrics from the statusline bridge file and injects warnings
// into the agent's conversation when context usage is high. This makes the
// AGENT itself aware of context limits (the statusline only shows the user).
//
// How it works:
// 1. ccg-statusline.js writes metrics to {os.tmpdir()}/claude-ctx-{session_id}.json
// 2. This hook reads those metrics after each tool use
// 3. When remaining context drops below thresholds, it injects a warning
//    as additionalContext, which the agent sees on its next turn
//
// Thresholds:
//   WARNING  (remaining <= 35%): Agent should wrap up current task
//   CRITICAL (remaining <= 25%): Agent should stop immediately and inform user
//
// Debounce: 5 tool uses between warnings to avoid spam.
// Severity escalation (WARNING -> CRITICAL) bypasses debounce so the user
// always sees the elevated alert.

const fs = require('fs');
const os = require('os');
const path = require('path');

const WARNING_THRESHOLD = 35;  // remaining_percentage <= 35%
const CRITICAL_THRESHOLD = 25; // remaining_percentage <= 25%
const STALE_SECONDS = 60;      // ignore metrics older than 60s
const DEBOUNCE_CALLS = 5;      // min tool uses between warnings

let input = '';
// Timeout guard: if stdin doesn't close within 10s (e.g. pipe issues on
// Windows/Git Bash, or slow Claude Code piping during large outputs),
// exit silently instead of hanging until Claude Code kills the process
// and reports "hook error".
const stdinTimeout = setTimeout(() => process.exit(0), 10000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id;

    if (!sessionId) {
      process.exit(0);
    }

    // Reject session IDs that contain path traversal sequences or path separators.
    // session_id is used to construct file paths in tmp — an unsanitized value
    // could escape the temp directory and read or write arbitrary files.
    if (/[/\\]|\.\./.test(sessionId)) {
      process.exit(0);
    }

    // Per-project opt-out via .ccg/config.json:
    //   { "hooks": { "context_warnings": false } }
    // Quick sentinel check: skip config read entirely for non-CCG projects.
    const cwd = data.cwd || process.cwd();
    const ccgDir = path.join(cwd, '.ccg');
    if (fs.existsSync(ccgDir)) {
      try {
        const configPath = path.join(ccgDir, 'config.json');
        if (fs.existsSync(configPath)) {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          if (config.hooks?.context_warnings === false) {
            process.exit(0);
          }
        }
      } catch (e) {
        // Ignore config read/parse errors (config is optional)
      }
    }

    const tmpDir = os.tmpdir();
    const metricsPath = path.join(tmpDir, `claude-ctx-${sessionId}.json`);

    // If no metrics file, this is a subagent or fresh session -- exit silently
    if (!fs.existsSync(metricsPath)) {
      process.exit(0);
    }

    const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
    const now = Math.floor(Date.now() / 1000);

    // Ignore stale metrics
    if (metrics.timestamp && (now - metrics.timestamp) > STALE_SECONDS) {
      process.exit(0);
    }

    const remaining = metrics.remaining_percentage;
    const usedPct = metrics.used_pct;

    // No warning needed
    if (remaining > WARNING_THRESHOLD) {
      process.exit(0);
    }

    // Debounce: check if we warned recently
    const warnPath = path.join(tmpDir, `claude-ctx-${sessionId}-warned.json`);
    let warnData = { callsSinceWarn: 0, lastLevel: null };
    let firstWarn = true;

    if (fs.existsSync(warnPath)) {
      try {
        warnData = JSON.parse(fs.readFileSync(warnPath, 'utf8'));
        firstWarn = false;
      } catch (e) {
        // Corrupted file, reset
      }
    }

    warnData.callsSinceWarn = (warnData.callsSinceWarn || 0) + 1;

    const isCritical = remaining <= CRITICAL_THRESHOLD;
    const currentLevel = isCritical ? 'critical' : 'warning';

    // Emit immediately on first warning, then debounce subsequent ones.
    // Severity escalation (WARNING -> CRITICAL) bypasses debounce so the
    // elevated alert is never missed.
    const severityEscalated = currentLevel === 'critical' && warnData.lastLevel === 'warning';
    if (!firstWarn && warnData.callsSinceWarn < DEBOUNCE_CALLS && !severityEscalated) {
      // Update counter and exit without warning
      fs.writeFileSync(warnPath, JSON.stringify(warnData));
      process.exit(0);
    }

    // Reset debounce counter
    warnData.callsSinceWarn = 0;
    warnData.lastLevel = currentLevel;
    fs.writeFileSync(warnPath, JSON.stringify(warnData));

    // Build advisory warning message (advisory only — never imperative; the
    // user, not the hook, decides how to proceed).
    let message;
    if (isCritical) {
      message = `[CCG] CONTEXT CRITICAL: Usage at ${usedPct}%. Remaining: ${remaining}%. ` +
        'Context is nearly exhausted. Inform the user that context is low and ask how they ' +
        'want to proceed. Avoid starting new complex work, large refactors, or autonomous ' +
        'state-saving unless the user asks for it.';
    } else {
      message = `[CCG] CONTEXT WARNING: Usage at ${usedPct}%. Remaining: ${remaining}%. ` +
        'Context is getting limited. Avoid unnecessary exploration or starting new complex ' +
        'work. Consider wrapping up the current task at the next natural stopping point.';
    }

    const output = {
      hookSpecificOutput: {
        hookEventName: process.env.GEMINI_API_KEY ? 'AfterTool' : 'PostToolUse',
        additionalContext: message,
      },
    };

    process.stdout.write(JSON.stringify(output));
  } catch (e) {
    // Silent fail -- never block tool execution
    process.exit(0);
  }
});
