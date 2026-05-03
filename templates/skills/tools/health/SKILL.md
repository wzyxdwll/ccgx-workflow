---
name: health
description: 项目健康度报告。一次性盘点项目工程层面卫生指标：依赖陈旧度 / 已知漏洞 / 文档与代码同步度 / 堆积的 TODO / CLAUDE.md 是否反映现状 / 测试覆盖率。当用户提到 health / 健康度 / 体检 / 项目卫生 / 依赖陈旧 / 漏洞扫描 / 文档同步时使用。
license: MIT
user-invocable: true
disable-model-invocation: false
allowed-tools: Bash, Read, Grep, Glob, Write
argument-hint: "[--repair]"
---

# 🏥 健康度关卡 · 项目体检

> v4.1-p18：从 `/ccg:health` 命令迁移为 skill。`/ccg:health` 自动生成路由保留。

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

每条发现 5+ 个 major 落后视为"严重老化"。

#### 维度 B：已知漏洞

| 项目 | 命令 |
|------|------|
| Node | `pnpm audit --audit-level=moderate` |
| Rust | `cargo audit`（需安装） |
| Python | `pip-audit`（如可用） |

记录 high/critical 数量。

#### 维度 C：文档同步度

`git log --since='30.days.ago' -- src/ \| wc -l` vs `git log --since='30.days.ago' -- '*.md' \| wc -l` 比值。代码改动 >> 文档改动 → 文档可能过期。

#### 维度 D：堆积 TODO/FIXME

```bash
grep -rn -E "TODO|FIXME|XXX|HACK" --include="*.{ts,js,py,rs,go,java}" \| wc -l
```

按目录聚合 top 5。

#### 维度 E：CLAUDE.md 现状

读 `CLAUDE.md` 末尾 `Last Updated`，超 90 天 → 黄牌；超 180 天 → 红牌。检查列出的命令/Agent 数与现在 `npx ccg-workflow` 暴露的是否一致。

#### 维度 F：测试覆盖率（可选，如已配 coverage 工具）

读 `coverage/lcov-report/index.html` 或 `coverage/coverage-summary.json` 总行覆盖率。

### Step 3：生成报告

写入 `.context/health-report.md`：

```markdown
# Project Health Report — <项目名>

**生成时间**: <ISO 时间>
**总评**: A / B / C / D / F

## 维度汇总
| 维度 | 状态 | 严重项 |
|------|------|-------|
| 依赖陈旧 | A | 0 |
| 已知漏洞 | C | 2 high |
| 文档同步 | B | - |
| TODO 堆积 | C | 47 |
| CLAUDE.md | A | - |
| 测试覆盖 | B | 78% |

## Top 5 修复优先级
1. `pnpm audit fix` — 解决 2 个 high vuln
2. ...
```

### Step 4（可选）：--repair 模式

仅对以下场景询问后执行：

- CLAUDE.md `Last Updated` 字段更新
- 重新 spawn `init-architect` 子代理刷新 CLAUDE.md（用户确认后）
- 自动跑 `pnpm dedupe` 等纯清理命令

**绝不**自动跑 `pnpm update` / `cargo update` / `pip install -U`，这类需要人工 review changelog。

## 输出契约

- 主输出：`.context/health-report.md`
- 终端打印：1 行总评 + 每维度 1 行状态 + 修复优先级
