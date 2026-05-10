---
name: map-codebase
description: 扫描代码库结构 → mermaid 图 + 模块清单 + 关键依赖矩阵，写入 .context/codebase-map.md。当用户提到代码库结构 / 项目地图 / mermaid 图 / 模块依赖 / 大型 brownfield / 陌生代码库时使用。建议在 /ccg:init 之前运行。
license: MIT
user-invocable: true
disable-model-invocation: false
allowed-tools: Read, Glob, Grep, Bash, Write
argument-hint: "[--fast] [focus-area]"
---

# 🗺 制图关卡 · 代码库结构图

为陌生项目 / 大型 brownfield 项目快速画一张"地图"：哪些模块、模块间怎么依赖、关键技术栈、入口点在哪。输出三件套：

1. **mermaid 模块依赖图**（可视化）
2. **模块清单表**（每个模块的职责 + 入口文件）
3. **关键依赖矩阵**（A 用了 B 的什么）

写入 `.context/codebase-map.md`，作为 `/ccg:init` / `/ccg:plan` / `/ccg:team` 的预读材料。

## 使用方法

```bash
/ccg:map-codebase             # 完整扫描（默认）
/ccg:map-codebase --fast      # 快扫，只输出顶层模块图，不深入
/ccg:map-codebase frontend    # 聚焦某子领域（不影响其他区域生成清单）
```

## 与 /ccg:init 的关系

- `/ccg:init` 关心 **CLAUDE.md 索引文档**（人类阅读的项目档案）
- `/ccg:map-codebase` 关心 **结构化机器可读地图**（mermaid + 表格，给 AI 后续命令读）
- 两者互补：建议先 `/ccg:map-codebase` 再 `/ccg:init`，init 可引用 map 产物

## 工作流程

### Step 1：识别项目骨架

并行：

```bash
# 顶层入口
ls package.json tsconfig.json Cargo.toml go.mod pyproject.toml 2>/dev/null
# 主要源码目录
ls src/ lib/ pkg/ app/ packages/ apps/ 2>/dev/null
# CI/部署
ls .github/workflows/ .gitlab-ci.yml Dockerfile docker-compose.yml 2>/dev/null
```

### Step 2：模块识别

按"含 index 文件 / 单独 package.json / 子目录有大量 .ts/.js" 三个启发式找出顶层模块。每个模块产出：

- 名称（目录基名）
- 入口文件（index.ts / mod.rs / main.go / __init__.py / lib.rs ...）
- 文件总数（quick `find` 计数）
- 估算职责（从入口文件 1-2 行 docstring 或顶部注释）

### Step 3：依赖关系挖掘

对每对模块跑 `grep -rl "from.*<other-module>"` 或 `grep -rl "import.*<other-module>"`。命中即建立 A→B 边。

### Step 4：关键技术栈识别

从 package.json `dependencies`、Cargo.toml `[dependencies]`、go.mod `require` 选出：

- Web 框架（Express/Fastify/Hono/Actix/Gin/Django/Flask…）
- DB 驱动（pg/mysql2/sqlx/diesel/sqlalchemy…）
- 测试框架（jest/vitest/pytest/cargo-test…）
- 关键 SaaS（stripe / openai / anthropic / aws-sdk…）

### Step 5：写报告

输出到 `.context/codebase-map.md`：

```markdown
# Codebase Map

**生成时间**: <ISO>
**项目类型**: TypeScript / Node ESM
**入口**: bin/ccg.mjs → src/cli.ts

## 模块依赖图（mermaid）

\`\`\`mermaid
graph TD
  cli["src/cli.ts"]
  cli --> commands["src/commands/*"]
  commands --> utils["src/utils/installer*"]
  utils --> templates["templates/"]
\`\`\`

## 模块清单
| 模块 | 入口 | 文件数 | 职责 |
|------|------|--------|------|
| ...

## 关键依赖
| A | B | 通过什么 |
|---|---|--------|
| commands/init.ts | utils/installer.ts | installWorkflows() |

## 技术栈
- Web: 无（CLI 工具）
- 测试: vitest
- ...
```

### --fast 模式

跳过 Step 3 的 grep 联动，只输出顶层模块的 placeholder 边（不画依赖箭头）。适合 1k+ 文件的大库初次扫描。

## 输出契约

- 主输出：`.context/codebase-map.md`
- 终端：mermaid 块 + 模块表
