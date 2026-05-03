---
name: ccg:health
description: 项目健康度报告 - 依赖/漏洞/文档同步/TODO/CLAUDE.md/测试覆盖率
argument-hint: "[--repair]"
allowed-tools:
  - Read
  - Bash
  - Grep
  - Glob
  - Write
---

# Health - 项目健康度体检

一次性盘点项目"是不是在烂掉"。不深入业务正确性，只看**工程层面的卫生指标**：依赖陈旧度、已知漏洞、文档与代码同步度、堆积的 TODO、CLAUDE.md 是否还反映现状、测试覆盖率（如可拿到）。输出 markdown 报告，每项打分 + 给出可执行修复建议。

`--repair` 模式：对**安全且确定**的问题（如自动生成的过期文档骨架）询问后修复，绝不擅自动核心代码或依赖。

## 使用方法

```bash
/ccg:health            # 体检 + 报告
/ccg:health --repair   # 体检 + 交互式修复（仅低风险项）
```

## 工作流程

### Step 1：识别项目类型

并行检测：

```bash
ls package.json Cargo.toml go.mod pyproject.toml setup.py Gemfile pom.xml build.gradle 2>/dev/null
```

记录所有命中的清单文件，决定后续要跑哪些工具链查询。

### Step 2：六大维度体检

#### 维度 A：依赖更新状态

按项目类型选命令：

| 项目 | 命令 | 关注 |
|------|------|------|
| Node | `pnpm outdated` 或 `npm outdated` | major 落后数 |
| Rust | `cargo outdated`（如已装） | 同上 |
| Go | `go list -u -m all` | 同上 |
| Python | `pip list --outdated` | 同上 |

打分：major 落后 0 个 = ✅，1-3 = ⚠，>3 = ❌

#### 维度 B：已知漏洞

| 项目 | 命令 |
|------|------|
| Node | `pnpm audit --prod` 或 `npm audit --omit=dev` |
| Rust | `cargo audit`（如已装） |
| Go | `govulncheck ./...`（如已装） |
| Python | `pip-audit`（如已装） |

打分：0 高危 = ✅，1-2 高危 = ⚠，>2 高危或任意 critical = ❌

工具未装 → 标 `[未检测]`，给出安装建议而不阻断。

#### 维度 C：文档同步度

```bash
# README / CLAUDE.md 最后修改时间 vs 代码最近修改时间
git log -1 --format="%ai" -- README.md
git log -1 --format="%ai" -- CLAUDE.md
git log -1 --format="%ai" -- src/
```

判定：
- README 比 src/ 落后 > 90 天 = ⚠
- CLAUDE.md 比 src/ 落后 > 30 天 = ⚠（CCG 项目对 CLAUDE.md 同步要求高）
- 项目里有 README 引用的命令 / 路径不存在 = ❌

抽样验证：从 README 提取代码块里的路径，用 Glob 验存在性。

#### 维度 D：未解决 TODO 堆积

```bash
Grep "TODO|FIXME|XXX|HACK" --glob "src/**/*.{ts,js,py,go,rs}" -n
```

按文件聚合 + 取最老 commit 时间：

```bash
git log --diff-filter=A -- <file> | tail -1   # 文件首次出现日期
```

打分：< 10 条 = ✅，10-30 = ⚠，>30 或有 > 1 年的 = ❌

#### 维度 E：CLAUDE.md 同步度（CCG 项目专项）

如项目根有 `CLAUDE.md`：

- 列出的命令 / 文件路径用 Glob 验存在性
- "Last Updated" 字段距今 > 30 天 → ⚠
- "模块索引" 引用的子模块 CLAUDE.md 是否都存在
- 命令计数（如"29 个命令"）与 `templates/commands/*.md` 实际数量是否一致

#### 维度 F：测试覆盖率（best effort）

| 项目 | 尝试命令（不强制要求装） |
|------|--------|
| Node | `pnpm test --coverage` 或读 `coverage/coverage-summary.json` |
| Rust | `cargo tarpaulin --print-summary`（如已装） |
| Go | `go test -cover ./...` |
| Python | `pytest --cov`（如装了 pytest-cov） |

只读已生成的 coverage 报告 → 不为体检主动跑全量测试（耗时）。无报告 = `[未检测]`。

### Step 3：生成报告

输出到终端 + 写入 `.context/health-<YYYY-MM-DD>.md`，文件包含：

1. **元信息**：Date + 总分（0-100）
2. **维度得分表**：六维度各自得分 + 状态（✅/⚠/❌/未检测）
3. **关键发现**：按严重度排序，先 ❌ 后 ⚠
4. **建议**：按 ROI 排序，每条带预计耗时与收益
5. **--repair 可自动修复项**：候选清单（待用户确认）

### Step 4：--repair 模式（如启用）

仅对以下类型的问题用 AskUserQuestion 后修复：
- 过期 CLAUDE.md 顶部的 `Last Updated` 字段
- 删除已不存在的命令引用（CLAUDE.md 索引表）
- 创建缺失的 `.context/` 目录骨架

**禁止自动**：升级依赖、改源码、删 TODO 注释、动 lockfile。

## 硬性约束

- **read-only 体检**：默认模式下绝不写代码 / 改依赖
- **工具缺失不阻断**：标 `[未检测]` + 给安装建议，不让单点缺失毁掉整个体检
- **报告必须可执行**：每条发现必带"在哪"+"怎么修"
- **--repair 必须交互确认**：禁止静默修改任何文件
