# CCG Quality Gates — Auto-trigger Rules

When working in a project, automatically invoke the corresponding quality gate skills based on the scenario below. These skills are installed at `~/.claude/skills/ccg/` and can be called directly.

**v4.0+ NOTE**: The unified entry point `/ccg:verify --gate=<name>` is preferred over the legacy `verify-*` skill names. Both still work in v4.x for BC. Examples below show the new form first, with the legacy alias in parentheses.

## Trigger Rules

### New Module Created

When a new module/package/directory is created with source code:

```
/gen-docs <module-path>                    → Generate README.md + DESIGN.md skeleton
  ↓ (after development)
/ccg:verify --gate=module <module-path>    → Check structure completeness  (legacy: /verify-module)
  ↓
/ccg:verify --gate=security <module-path>  → Scan for security vulnerabilities  (legacy: /verify-security)
```

### Code Changes > 30 Lines

When a single task produces code changes exceeding 30 lines:

```
/ccg:verify --gate=change                  → Analyze change impact, check doc sync  (legacy: /verify-change)
  ↓
/ccg:verify --gate=quality <changed-path>  → Check complexity, code smells, naming  (legacy: /verify-quality)
```

### Security-Related Changes

When changes involve authentication, authorization, encryption, input validation, or secrets management:

```
/ccg:verify --gate=security <changed-path> → Scan for vulnerabilities  (legacy: /verify-security)
```

### Refactoring

When refactoring existing code:

```
/ccg:verify --gate=change                     → Ensure docs reflect the refactoring  (legacy: /verify-change)
  ↓
/ccg:verify --gate=quality <refactored-path>  → Verify quality improved  (legacy: /verify-quality)
  ↓
/ccg:verify --gate=security <refactored-path> → No new vulnerabilities introduced  (legacy: /verify-security)
```

### Auto-orchestration (recommended for "I just changed a chunk of code")

```
/ccg:verify --gate=all [path]              → Auto-pick gates by change type (alias: /ccg:verify-work)
```

## Execution Rules

1. **Non-blocking** — Quality gates produce reports but do NOT block delivery unless Critical issues are found
2. **Chainable** — Run gates in the order specified above; skip if previous gate fails
3. **Silent on pass** — Only report findings; do not output "all clear" messages for every gate
4. **Critical = must fix** — Only `Critical` / `High` severity findings require action before delivery
5. **Idempotent** — Safe to re-run; same input produces same output

## Multi-Agent Coordination

When a task involves 3+ independent files/modules or 2+ parallel workflows, refer to the multi-agent orchestration skill at `~/.claude/skills/ccg/orchestration/multi-agent/SKILL.md` for:

- Agent role assignment (Lead / Scout / Worker / Soldier / Drone)
- File ownership locking (one writer per file at any time)
- Task decomposition strategy (by file, by module, or by pipeline)
