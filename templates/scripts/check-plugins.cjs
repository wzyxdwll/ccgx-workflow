#!/usr/bin/env node
// CCG plugin detection helper (v2.3.1+)
//
// Reads Claude Code's authoritative plugin registry at
// ~/.claude/plugins/installed_plugins.json and reports whether the
// codex and gemini plugins required by ccgx Channel A (plugin spawn)
// are registered.
//
// Exit codes:
//   0 = both plugins ok (use Channel A)
//   1 = at least one missing (use Channel B / wrapper BC fallback)
//   2 = registry missing or unparsable (use Channel B)
//
// stdout (single line JSON):
//   {"codex": "<version>"|null, "gemini": "<version>"|null, "error"?: "<msg>"}

const fs = require('fs');
const os = require('os');
const path = require('path');

const registryPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');

function emit(payload, exitCode) {
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(exitCode);
}

try {
  if (!fs.existsSync(registryPath)) {
    emit({ codex: null, gemini: null, error: 'registry-missing' }, 2);
  }

  const raw = fs.readFileSync(registryPath, 'utf8');
  const data = JSON.parse(raw);
  const plugins = (data && data.plugins) || {};

  const codexKey = Object.keys(plugins).find((k) => k.startsWith('codex@'));
  const geminiKey = Object.keys(plugins).find((k) => k.startsWith('gemini@'));

  const codexEntry = codexKey ? plugins[codexKey] : null;
  const geminiEntry = geminiKey ? plugins[geminiKey] : null;

  const codex = Array.isArray(codexEntry) && codexEntry[0] ? (codexEntry[0].version || 'unknown') : null;
  const gemini = Array.isArray(geminiEntry) && geminiEntry[0] ? (geminiEntry[0].version || 'unknown') : null;

  emit({ codex, gemini }, codex && gemini ? 0 : 1);
} catch (e) {
  emit({ codex: null, gemini: null, error: String(e && e.message || e) }, 2);
}
