#!/usr/bin/env node
/**
 * repatch-gemini-plugin.mjs — Idempotent Windows-spawn patch for
 * gemini@google-gemini plugin (v1.0.1+). Adds `windowsHide: true` (and
 * `shell: process.platform === "win32"` where needed) to all 7 known
 * spawn points so plugin operations don't flash console windows on
 * Windows. Safe to run repeatedly.
 *
 * Reference: D:/workflow/ccg-workflow/.ccg-migration/PLUGIN-PATCHES.md
 *
 * Usage (after installing CCG v4.5.1+):
 *   node ~/.claude/.ccg/scripts/repatch-gemini-plugin.mjs
 *
 * Standalone (without CCG install):
 *   curl -fsSL <raw-url-to-this-file> | node
 *
 * Re-run after every `claude plugin update gemini@google-gemini`
 * (plugin update overwrites cache, all patches must be reapplied).
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
 *   file         — relative to scripts/
 *   description  — human-readable patch ID + spawn point
 *   probe        — substring that must EXIST after patch (idempotency check)
 *   find         — exact substring to replace
 *   replace      — replacement
 *
 * If `probe` is already present, patch is skipped (already applied).
 */
const PATCHES = [
  {
    file: "gemini-companion.mjs",
    description: "P-1 spawnBackgroundWorker (Node task-worker)",
    probe: 'detached: true,\n    windowsHide: true,\n    stdio: ["ignore", "ignore", "ignore"]',
    find: 'detached: true,\n    stdio: ["ignore", "ignore", "ignore"]',
    replace: 'detached: true,\n    windowsHide: true,\n    stdio: ["ignore", "ignore", "ignore"]',
  },
  {
    file: "acp-broker.mjs",
    description: "P-2a spawnAcpProcess (gemini --acp CLI)",
    probe: 'shell: process.platform === "win32"',
    find: 'stdio: ["pipe", "pipe", "pipe"],\n    env: process.env\n  });',
    replace:
      'stdio: ["pipe", "pipe", "pipe"],\n    env: process.env,\n    // Windows compat: gemini is .cmd script, requires shell:true\n    shell: process.platform === "win32",\n    // Suppress flash cmd window when shell:true on Windows\n    windowsHide: true\n  });',
  },
  {
    file: "lib/acp-client.mjs",
    description: "P-2b ACPClient.spawn (gemini --acp CLI)",
    probe: 'shell: process.platform === "win32"',
    find: 'stdio: ["pipe", "pipe", "pipe"]\n    });',
    replace:
      'stdio: ["pipe", "pipe", "pipe"],\n      shell: process.platform === "win32",\n      windowsHide: true\n    });',
  },
  {
    file: "lib/broker-lifecycle.mjs",
    description: "P-4 broker daemon spawn (node serve)",
    probe: 'detached: true,\n    windowsHide: true,\n    stdio: ["ignore", "ignore", "ignore"]',
    find: 'detached: true,\n    stdio: ["ignore", "ignore", "ignore"]',
    replace: 'detached: true,\n    windowsHide: true,\n    stdio: ["ignore", "ignore", "ignore"]',
  },
  {
    file: "lib/process.mjs",
    description: "P-5 runCommand spawnSync (general helper)",
    probe: 'stdio: ["pipe", "pipe", "pipe"],\n      windowsHide: true',
    find: 'stdio: ["pipe", "pipe", "pipe"]\n    });',
    replace: 'stdio: ["pipe", "pipe", "pipe"],\n      windowsHide: true\n    });',
  },
  {
    file: "lib/process.mjs",
    description: "P-6 taskkill spawnSync (terminate tree)",
    probe: 'spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })',
    find: 'spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" })',
    replace: 'spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })',
  },
  {
    file: "lib/process.mjs",
    description: "P-7 spawnDetached helper",
    probe: "detached: true,\n    windowsHide: true,\n    stdio\n  });",
    find: "detached: true,\n    stdio\n  });",
    replace: "detached: true,\n    windowsHide: true,\n    stdio\n  });",
  },
];

let applied = 0;
let alreadyPatched = 0;
let notMatched = 0;

for (const patch of PATCHES) {
  const path = join(SCRIPTS, patch.file);
  if (!existsSync(path)) {
    console.log(`  [SKIP] ${patch.description}\n         ${patch.file}: file not found`);
    continue;
  }
  const content = readFileSync(path, "utf8");

  if (content.includes(patch.probe)) {
    console.log(`  [OK]   ${patch.description} (already patched)`);
    alreadyPatched++;
    continue;
  }

  if (!content.includes(patch.find)) {
    console.log(
      `  [MISS] ${patch.description}\n         ${patch.file}: find-string not matched (plugin version mismatch?)`,
    );
    notMatched++;
    continue;
  }

  const next = content.replace(patch.find, patch.replace);
  writeFileSync(path, next, "utf8");
  console.log(`  [APPLY] ${patch.description}`);
  applied++;
}

console.log(`\nSummary: ${applied} applied, ${alreadyPatched} already-patched, ${notMatched} unmatched`);

if (platform() === "win32" && (applied > 0 || alreadyPatched > 0)) {
  console.log("\nIMPORTANT — restart any running broker daemon for new patches to take effect:");
  console.log("  PowerShell: Get-Process node | Where-Object { $_.MainWindowTitle -like '*broker*' -or (Get-CimInstance Win32_Process -Filter (\"ProcessId=\" + $_.Id)).CommandLine -match 'broker.mjs' } | Stop-Process -Force");
  console.log("  or simply: claude plugin disable gemini@google-gemini && claude plugin enable gemini@google-gemini");
}

if (notMatched > 0) {
  console.log("\nWARNING — some patches did not match. Plugin version may have changed.");
  console.log("Check spawn points manually and update PLUGIN-PATCHES.md.");
  process.exit(1);
}
