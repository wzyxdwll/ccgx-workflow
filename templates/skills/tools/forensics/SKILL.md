---
name: forensics
description: 代码事件取证 / 提交考古。给定一个文件 / 函数 / bug 现场，反向溯源 git 历史 + 关联 PR / issue / 改动者，重建事故 timeline。当用户提到 git blame / 谁改的 / 为什么这样写 / 提交考古 / 代码取证 / forensics 时使用。
license: MIT
user-invocable: true
disable-model-invocation: false
allowed-tools: Bash, Read, Grep, Glob, Write
argument-hint: "<file:line> 或 <function-name>"
---

# 🔬 取证关卡 · 代码考古

> v4.1-p18：作为 skill 暴露（v3.0 曾有 `/ccg:forensics` 规划）。

给定一段"问题代码"或"已知 bug 现场"，反向重建事故时间线：

- 这一段最早什么时候引入？哪个 PR？
- 之后被谁改过？每次改的动机？
- 周边 commit 是否有相关 hint？
- 当前形态是否已偏离原始设计意图？

## 使用方法

```bash
/ccg:forensics src/foo.ts:42        # 锁定具体行
/ccg:forensics handleAuth           # 锁定函数名
/ccg:forensics "TODO: fix race"     # 锁定特征字符串
```

## 工作流程

### Step 1：定位现场

如参数是 `file:line` → `git blame -L line,line file`。
如是函数名 → `grep -rn "<name>" --include="*.{ts,js,py,go,rs}"` 定位首次出现。
如是特征字符串 → `git log -S "<string>" --pretty='%h %ai %an %s'`（pickaxe）

### Step 2：完整 commit 链

```bash
git log --follow --pretty='%h %ai %an %s' -- <file>
git log -L <line>,+1:<file>      # 行级 history
```

### Step 3：关联 PR / issue（如有 GitHub）

```bash
# 从 commit message 提取 (#123) PR 引用
git log --grep '(#[0-9]\+)' --pretty='%h %s'
# 如装了 gh CLI:
gh pr view <num> --json title,body,author,mergedAt
```

### Step 4：周边语义聚类

对每个相关 commit `git show --stat <sha>`，看是否同 commit 改了相邻文件 → 有助于推断"当时的工作上下文"。

### Step 5：重建 timeline 报告

```markdown
# Forensics Report — <现场标识>

**调查时间**: <ISO>
**当前现场**: src/foo.ts:42 (HEAD)

## Timeline

| 日期 | commit | author | 动作 | PR | 备注 |
|------|--------|--------|------|----|------|
| 2026-01-15 | abc1234 | Alice | 引入 | #45 | 原始设计，handle null |
| 2026-02-03 | def5678 | Bob | 修改 | #67 | 加 retry 逻辑 |
| 2026-03-12 | ghi9abc | Carol | 修改 | #88 | 改成异步，**疑似引入 race**|

## 当前与原意偏离度
- 原始：同步 + null check
- 现在：异步 + 无 mutex → race condition 高风险

## 推断 root cause
**ghi9abc** 把同步改异步时未补 mutex。**修复建议**：加 `pLimit(1)` 或 `Mutex`。
```

### Step 6（可选）：写到 .context

报告写到 `.context/forensics/<YYYY-MM-DD>-<slug>.md` 持久化，方便后续 `/ccg:debug` 快速复用。

## 输出契约

- 主输出：`.context/forensics/<YYYY-MM-DD>-<slug>.md`（如 dest 已存在则 append）
- 终端：timeline 表 + root cause 推断
