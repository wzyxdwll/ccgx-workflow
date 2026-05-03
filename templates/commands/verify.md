---
description: '统一校验关卡：按 --gate=change|quality|security|module 子门路由到对应 skill，--all 等价 verify-work'
argument-hint: '--gate=<change|quality|security|module|all> [path]'
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Agent
---

# /ccg:verify - 统一校验关卡（v4.0+）

替代 v3.x 时代的 4 个独立命令 `/ccg:verify-{change,quality,security,module}`，统一入口 + 子门路由，降低命令面板认知负担。

## 使用方法

```bash
/ccg:verify --gate=change [path]      # 变更影响分析（diff/doc 同步）
/ccg:verify --gate=quality [path]     # 代码质量（复杂度/重复/命名）
/ccg:verify --gate=security [path]    # 安全漏洞扫描
/ccg:verify --gate=module <path>      # 模块完整性（README/DESIGN/结构）
/ccg:verify --gate=all [path]         # 等价 /ccg:verify-work（自动按变更类型选门）
```

如未提供 `--gate`，默认 `--gate=all`。

## 参数解析

```
$ARGUMENTS
```

从 `$ARGUMENTS` 解析：
- 提取首个 `--gate=<value>` 或 `--gate <value>`
- 剩余非 flag 参数作为 `<path>`
- 未指定 gate → 默认 `all`

## 路由规则

| --gate | 实际调用 | 说明 |
|--------|---------|------|
| `change` | 读取并执行 `~/.claude/skills/ccg/tools/verify-change/SKILL.md` | 沿用旧 verify-change skill 的脚本 |
| `quality` | 读取并执行 `~/.claude/skills/ccg/tools/verify-quality/SKILL.md` | 沿用旧 verify-quality skill 的脚本 |
| `security` | 读取并执行 `~/.claude/skills/ccg/tools/verify-security/SKILL.md` | 沿用旧 verify-security skill 的脚本 |
| `module` | 读取并执行 `~/.claude/skills/ccg/tools/verify-module/SKILL.md` | 沿用旧 verify-module skill 的脚本 |
| `all` | 调用 `/ccg:verify-work` 编排器 | 按 git diff 变更类型自动选门 |

## 兼容性

旧的 `/ccg:verify-change` / `/ccg:verify-quality` / `/ccg:verify-security` / `/ccg:verify-module` 仍可工作（由 Skill Registry 自动生成），但 SKILL.md 已标记 `deprecated_in: v4.0`、`replaced_by: /ccg:verify --gate=<name>`。建议新工作流使用本统一命令。

## 执行流程

1. **解析参数** - 提取 `--gate` 与 `path`
2. **路由分发** - 按 gate 值读取对应 SKILL.md，加载脚本/知识
3. **执行子门** - 沿用对应 skill 的脚本与报告格式（不重新实现）
4. **聚合输出** - 沿用子门原报告格式，无修饰

## 注意事项

- 本命令不**重新实现**校验逻辑，纯路由层。所有逻辑仍在 4 个 verify-* SKILL.md 中维护。
- `--gate=all` 是 `/ccg:verify-work` 的别名，未来可能合并。
- 如脚本需要传 `--mode`（如 verify-change 的 `--mode staged`），通过 `path` 之后的额外参数透传：`/ccg:verify --gate=change -- --mode staged`。

---
