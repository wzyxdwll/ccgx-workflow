#!/usr/bin/env node
/**
 * repatch-gemini-plugin.mjs — Idempotent Windows-spawn patch for
 * gemini@google-gemini plugin (v1.0.1+). Adds `windowsHide: true` (and
 * `shell: process.platform === "win32"` where needed) to all 8 known
 * spawn points so plugin operations don't flash console windows on
 * Windows. Safe to run repeatedly.
 *
 * Reference: <ccg-workflow>/.ccg-migration/PLUGIN-PATCHES.md
 *
 * Usage:
 *   node ~/.claude/.ccg/scripts/repatch-gemini-plugin.mjs
 *   node /path/to/repatch-gemini-plugin.mjs   # standalone
 *
 * Re-run after every `claude plugin update gemini@google-gemini`.
 *
 * Patches use regex (not string includes) so they tolerate CRLF/LF line
 * endings and minor whitespace variations between plugin versions.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const PLUGIN_BASE = join(
  homedir(),
  ".claude",
  "plugins",
  "cache",
  "google-gemini",
  "gemini",
);

function findPluginVersion() {
  if (!existsSync(PLUGIN_BASE)) {
    throw new Error(
      `gemini plugin not found at ${PLUGIN_BASE}. Install via: claude plugin install gemini@google-gemini`,
    );
  }
  const versions = readdirSync(PLUGIN_BASE).filter((d) => {
    try {
      return statSync(join(PLUGIN_BASE, d)).isDirectory();
    } catch {
      return false;
    }
  });
  if (versions.length === 0) {
    throw new Error(`No gemini plugin version found under ${PLUGIN_BASE}`);
  }
  versions.sort();
  return versions[versions.length - 1];
}

const VERSION = findPluginVersion();
const SCRIPTS = join(PLUGIN_BASE, VERSION, "scripts");

console.log(`Patching gemini plugin ${VERSION} at:\n  ${SCRIPTS}\n`);

/**
 * Each patch defines:
 *   id          — patch ID for reporting
 *   file        — relative to scripts/
 *   description — human-readable
 *   guard       — regex; if matches → already patched (skip)
 *   match       — regex; locates spawn call options block
 *   replace     — replacer function/string for String.replace
 *
 * Regex patterns are CRLF/LF-tolerant via `\r?\n` and `[ \t]+`.
 */
const PATCHES = [
  {
    id: "P-1",
    file: "gemini-companion.mjs",
    description: "spawnBackgroundWorker (Node task-worker)",
    guard: /spawn\("node"[\s\S]{0,300}windowsHide:\s*true/,
    match: /(spawn\("node",\s*\[scriptPath,\s*"task-worker",\s*jobId\],\s*\{[\s\S]*?detached:\s*true,)/,
    replace: '$1\n    windowsHide: true,',
  },
  {
    id: "P-2a",
    file: "acp-broker.mjs",
    description: "spawnAcpProcess (gemini --acp CLI)",
    guard: /spawn\("gemini",\s*\["--acp"\][\s\S]{0,400}windowsHide:\s*true/,
    match: /(spawn\("gemini",\s*\["--acp"\],\s*\{[\s\S]*?env:\s*process\.env)(\r?\n\s*\}\);)/,
    replace: '$1,\n    shell: process.platform === "win32",\n    windowsHide: true$2',
  },
  {
    id: "P-2b",
    file: "lib/acp-client.mjs",
    description: "ACPClient.spawn (gemini --acp CLI)",
    guard: /this\.proc\s*=\s*spawn\("gemini"[\s\S]{0,400}windowsHide:\s*true/,
    match: /(this\.proc\s*=\s*spawn\("gemini",\s*\["--acp"\],\s*\{[\s\S]*?stdio:\s*\["pipe",\s*"pipe",\s*"pipe"\])(\r?\n\s*\}\);)/,
    replace: '$1,\n      shell: process.platform === "win32",\n      windowsHide: true$2',
  },
  {
    id: "P-4",
    file: "lib/broker-lifecycle.mjs",
    description: "broker daemon spawn (node serve)",
    guard: /spawn\("node",\s*\[\s*BROKER_SCRIPT[\s\S]{0,500}windowsHide:\s*true/,
    match: /(spawn\("node",\s*\[\s*BROKER_SCRIPT[\s\S]*?detached:\s*true,)/,
    replace: '$1\n    windowsHide: true,',
  },
  {
    id: "P-5",
    file: "lib/process.mjs",
    description: "runCommand spawnSync (general helper)",
    guard: /spawnSync\(command,\s*args,\s*\{[\s\S]*?windowsHide:\s*true/,
    match: /(spawnSync\(command,\s*args,\s*\{[\s\S]*?stdio:\s*\["pipe",\s*"pipe",\s*"pipe"\])(\r?\n\s*\}\);)/,
    replace: '$1,\n      windowsHide: true$2',
  },
  {
    id: "P-6",
    file: "lib/process.mjs",
    description: "taskkill spawnSync (terminate tree)",
    guard: /spawnSync\("taskkill"[\s\S]*?windowsHide:\s*true/,
    match: /(spawnSync\("taskkill",\s*\["\/pid",\s*String\(pid\),\s*"\/T",\s*"\/F"\],\s*\{\s*stdio:\s*"ignore")(\s*\})/,
    replace: '$1, windowsHide: true$2',
  },
  {
    id: "P-7",
    file: "lib/process.mjs",
    description: "spawnDetached helper",
    guard: /nodeSpawn\(command,\s*args[\s\S]*?windowsHide:\s*true/,
    match: /(nodeSpawn\(command,\s*args,\s*\{[\s\S]*?detached:\s*true,)/,
    replace: '$1\n    windowsHide: true,',
  },
  {
    id: "P-8",
    file: "lib/process.mjs",
    description: "binaryAvailable (where/which)",
    guard: /spawnSync\(command,\s*\[name\][\s\S]*?windowsHide:\s*true/,
    match: /(spawnSync\(command,\s*\[name\],\s*\{\s*encoding:\s*"utf8",\s*stdio:\s*"pipe")(\s*\})/,
    replace: '$1, windowsHide: true$2',
  },
  {
    id: "P-9",
    file: "lib/acp-client.mjs",
    description: "JSON-RPC error swallowing (reject with bare {code,message} → caller sees '[object Object]')",
    // Guard: any patched marker present
    guard: /CCG P-9 patch/,
    // Match: the bare reject(message.error) inside the response branch
    match: /(if \(message\.error\) \{\s*\r?\n\s*)pending\.reject\(message\.error\);(\s*\r?\n\s*\} else \{)/,
    replace: `$1// CCG P-9 patch: wrap JSON-RPC error object in Error instance.\n          // Without this, callers doing \`e instanceof Error ? e.message : String(e)\`\n          // get "[object Object]" — losing real error info (auth-expired, broker-dead,\n          // parse-error, etc). See .ccg-migration/PLUGIN-PATCHES.md P-9.\n          const _err = message.error;\n          const _wrapped = Object.assign(\n            new Error(typeof _err === "object" && _err !== null && _err.message\n              ? String(_err.message)\n              : String(_err)),\n            {\n              jsonrpcCode: typeof _err === "object" && _err !== null ? _err.code : undefined,\n              jsonrpcData: typeof _err === "object" && _err !== null ? _err.data : undefined,\n            },\n          );\n          pending.reject(_wrapped);$2`,
  },
];

let applied = 0;
let alreadyPatched = 0;
let notMatched = 0;
const seenFiles = new Map(); // file -> latest content (so multiple patches per file accumulate)

for (const patch of PATCHES) {
  const path = join(SCRIPTS, patch.file);
  if (!existsSync(path)) {
    console.log(`  [SKIP] ${patch.id} ${patch.description}: ${patch.file} not found`);
    continue;
  }

  const content = seenFiles.get(path) ?? readFileSync(path, "utf8");

  if (patch.guard.test(content)) {
    console.log(`  [OK]    ${patch.id} ${patch.description} (already patched)`);
    alreadyPatched++;
    continue;
  }

  if (!patch.match.test(content)) {
    console.log(`  [MISS]  ${patch.id} ${patch.description}: regex did not match (plugin version mismatch?)`);
    notMatched++;
    continue;
  }

  const next = content.replace(patch.match, patch.replace);
  if (next === content) {
    console.log(`  [MISS]  ${patch.id} ${patch.description}: replace produced no change`);
    notMatched++;
    continue;
  }

  seenFiles.set(path, next);
  console.log(`  [APPLY] ${patch.id} ${patch.description}`);
  applied++;
}

// Flush all modified files at once (avoids partial writes on multi-patch files like process.mjs)
for (const [path, content] of seenFiles) {
  writeFileSync(path, content, "utf8");
}

console.log(`\nSummary: ${applied} applied, ${alreadyPatched} already-patched, ${notMatched} unmatched`);

if (platform() === "win32" && applied > 0) {
  console.log("\nIMPORTANT — restart broker daemon for new patches to take effect:");
  console.log("  Option A: claude plugin disable gemini@google-gemini && claude plugin enable gemini@google-gemini");
  console.log("  Option B (PowerShell): Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |");
  console.log("           Where-Object { $_.CommandLine -match 'acp-broker|broker-lifecycle' } |");
  console.log("           ForEach-Object { Stop-Process -Id $_.ProcessId -Force }");
}

if (notMatched > 0) {
  console.log("\nWARNING — some patches did not match. Plugin version may have changed.");
  console.log("Inspect spawn points manually and update PLUGIN-PATCHES.md.");
  process.exit(1);
}
