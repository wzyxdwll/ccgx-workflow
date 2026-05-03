---
name: ccg:extract-learnings
description: Milestone 完成后从 .context / commit 历史 / 决策日志中提炼经验，沉淀到 .context/learnings.md
argument-hint: "[milestone-name]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Grep
  - Glob
---

# Extract Learnings - 经验沉淀

milestone（阶段、版本、Sprint）完成后回头看：哪些决策事后看是对的？哪些走过弯路？哪些模式值得复用？把这些散落在 commit message、`.context/` 决策日志、issue 讨论里的隐性知识，结构化沉淀到 `.context/learnings.md`，让下个 milestone 不再重蹈覆辙。

## 使用方法

```bash
/ccg:extract-learnings [milestone-name]
```

- 不传参数：自动从最近一次 tag / 最近 50 个 commit / 最近一次归档 milestone 推断范围
- 传 milestone 名：以该 milestone 为锚点，圈定时间范围

## 你的角色

你是**经验提炼员**，不写新代码、不评判对错，只做一件事：从已有事实中**抽取可复用的知识颗粒**。

## 工作流程

### Step 1：圈定范围

用 Bash + Read 收集材料：

```bash
# 时间窗口
git log --since="<milestone start>" --until="<milestone end>" --oneline
git log --since="<milestone start>" --until="<milestone end>" --stat
git tag --sort=-creatordate | head -5
```

材料源（按优先级）：
1. `.context/state.md` / `.context/roadmap.md`：milestone 范围 / 完成判据
2. `.context/decisions/` 或 `.context/session.log`：决策日志
3. Git commit messages（特别看 `feat:` / `fix:` / `refactor:` 的 body）
4. PR 描述与讨论（如有 `gh pr list --state merged --search "milestone:X"`）
5. `.context/forensics/`（如有事故复盘）

如材料严重不足（< 5 个 commit + 无 .context/），直接告诉用户"信息不足无法提炼"，不强行编造。

### Step 2：四象限提炼

把材料归到四类（**这是核心**）：

| 类别 | 提炼问题 | 输出格式 |
|------|----------|----------|
| **决策（Decisions）** | 当时选了哪条路？拒绝了什么？理由是什么？现在看对吗？ | "决策 X：选 A 拒 B，因为 …，事后评估：✅ / ⚠ / ❌" |
| **教训（Lessons）** | 哪些坑踩过两次？哪些假设被现实打脸？ | "假设 X 是真，结果是 Y，下次应 Z" |
| **模式（Patterns）** | 哪些写法反复出现且效果好？ | "当 X 场景出现，使用 Y 模式（例：file:line）" |
| **意外（Surprises）** | 哪些事情完全出乎预期？ | "原以为 X 会简单，实际花了 N 倍时间，原因 Y" |

每条记录必须**锚定证据**：commit hash / 文件路径行号 / decision id，禁止"凭印象"。

### Step 3：写入 .context/learnings.md

文件结构（不存在则创建，存在则追加新 milestone 段）：

```markdown
# Project Learnings

## Milestone: <name> (<date range>)

### 决策
- **D-01** [commit abc123] 选 A 不选 B，因为 …。事后评估：✅
- **D-02** [.context/decisions/2026-04-01-auth.md] …

### 教训
- **L-01** [fix: commit def456] 假设 X 真 → 实际 Y → 下次 Z

### 模式
- **P-01** [src/api/*.ts] 反复出现的 X 写法

### 意外
- **S-01** 原以为 …，实际 …
```

### Step 4：交叉引用

追加完成后：
1. 在 `.context/state.md` 的当前 milestone 段落末尾加一行：`Learnings: see learnings.md#milestone-<name>`
2. 如发现重大教训应改造现有规则 / 命令 / 文档，列在输出末尾的"建议下一步"

## 硬性约束

- **只读不改源码**：禁止动 `src/` 任何文件
- **每条提炼必带证据锚点**：commit hash / 文件 / 决策 id 三选一
- **空 milestone 直接说空**：禁止编造经验
- **追加不覆盖**：`.context/learnings.md` 历史段落不得删改

## 输出格式

最终向用户输出：

```markdown
## 提炼完成

- **Milestone**: <name>
- **时间范围**: <start> → <end>
- **材料来源**: N 个 commit / M 条决策 / K 个 PR
- **提炼条目**: 决策 X / 教训 Y / 模式 Z / 意外 W

## 写入位置
- `.context/learnings.md`（追加 milestone 段）
- `.context/state.md`（追加交叉引用）

## 建议下一步
- 如有教训值得固化为规则 → 提议更新 `~/.claude/rules/` 或项目 CLAUDE.md
- 如有模式值得封装为命令 → 提议新建 slash command
```
