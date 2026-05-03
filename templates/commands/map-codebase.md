---
name: ccg:map-codebase
description: 扫描代码库结构 → mermaid 图 + 模块清单 + 关键依赖矩阵，写入 .context/codebase-map.md
argument-hint: "[--fast] [focus-area]"
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Write
---

# Map Codebase - 代码库结构图

为陌生项目 / 大型 brownfield 项目快速画一张"地图"：哪些模块、模块间怎么依赖、关键技术栈、入口点在哪。输出三件套：

1. **mermaid 模块依赖图**（可视化）
2. **模块清单表**（每个模块的职责 + 入口文件）
3. **关键依赖矩阵**（A 用了 B 的什么）

写入 `.context/codebase-map.md`，作为 `/ccg:init`、`/ccg:plan`、`/ccg:team-research` 的预读材料。

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
- 本命令为**独立命令**，但 `/ccg:init` 可视为更高层封装；不强制依赖

## 工作流程

### Step 1：识别项目骨架

```bash
# 顶层目录
Glob "*" | head -30

# 项目类型识别
ls package.json pyproject.toml Cargo.toml go.mod pom.xml 2>/dev/null

# Monorepo 检测
ls pnpm-workspace.yaml lerna.json turbo.json nx.json Cargo.toml 2>/dev/null
Glob "packages/*/package.json"
Glob "apps/*/package.json"
```

输出：单包 / monorepo（含子包数量）。

### Step 2：模块切片

按以下规则切：

| 项目类型 | 切片粒度 |
|---------|---------|
| Monorepo | 每个 `packages/*` / `apps/*` 一个模块 |
| `src/` 多顶层目录 | 每个一级子目录一个模块 |
| Domain Driven 风格 | 按 `domains/` / `modules/` 子目录 |
| 扁平项目 | 按文件命名前缀聚类（auth-*, user-*） |

每个模块抽取：
- **入口文件**（index/main/mod 文件）
- **行数总量**（`Bash: find <module> -name "*.<ext>" | xargs wc -l | tail -1`）
- **是否有 README/CLAUDE.md**

### Step 3：依赖关系挖掘

从每个模块的入口文件出发：

```bash
# JS/TS：import / require
Grep -E "^import .* from ['\"](\.|@/)" --glob "*.{ts,tsx,js,jsx}"

# Python：from … import
Grep -E "^from \.|^from <pkg>\." --glob "*.py"

# Go：import 块
Grep -A 20 "^import \(" --glob "*.go"

# Rust：use crate::
Grep -E "^use crate::|^pub use" --glob "*.rs"
```

聚合：A 模块 import 了 B 模块的哪些符号 → 依赖矩阵单元 `A→B: [Foo, Bar, Baz]`。

`--fast` 模式：跳过此步，只画"模块存在 + 顶层目录关系"。

### Step 4：识别外部关键依赖

读 `package.json` / `Cargo.toml` / `go.mod` / `pyproject.toml`：

- 列前 10 个生产依赖（按使用频率，用 Grep 统计 import 次数）
- 标识"基石依赖"（被 5+ 模块 import 的）

### Step 5：生成 mermaid 图

规则：
- 节点标签含模块名 + 行数估算
- 用 `subgraph` 分类（前端/后端/共享/基础设施）
- 仅画强依赖（import 次数 ≥ 3），弱依赖留给依赖矩阵表
- 节点 > 25 → 折叠子图，避免视觉爆炸

示例片段：`graph LR; Web --> UI; Web --> API; API --> DB`（含 subgraph + LOC 标签）。

### Step 6：写入 `.context/codebase-map.md`

文件结构（按顺序）：

1. **元信息块**：Generated 日期 / Project Type / 总模块数 / 总 LOC
2. **架构总览**：Step 5 的 mermaid 图块
3. **模块清单表**：列 `模块 / 路径 / 入口 / LOC / 文档 / 职责`
4. **关键依赖矩阵**：列 `上游→下游 / 引用符号 / 引用次数`，仅取 top N
5. **外部基石依赖表**：列 `包 / 版本 / 被引用模块数`
6. **入口点**：应用入口 / API 路由入口 / 配置入口 三个 bullet
7. **缺失文档的模块**：列出 LOC 大但无 README/CLAUDE.md 的模块，作为后续 `/ccg:gen-docs` 候选清单

### Step 7：与 .context 集成

- 在 `.context/state.md` 追加：`Codebase Map: see codebase-map.md (generated <date>)`
- 如检测到 codebase-map 与现实严重不符（>30% 模块不存在），提示用户重跑

## 硬性约束

- **read-only 扫描**：仅读不写源码，写出物只允许 `.context/codebase-map.md` 和 `.context/state.md`
- **不依赖外部分析工具**：核心使用 Glob + Grep + Bash，不强制要求 ast-grep / tree-sitter
- **大项目分批**：> 1k 文件项目，按 Step 2 模块切片 后逐模块扫描，避免单次输出爆炸
- **`--fast` 必须 < 10s 完成**：仅画顶层结构，跳过 import 矩阵
