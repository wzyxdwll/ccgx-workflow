---
name: extract-learnings
description: 从近期开发会话中萃取可复用的模式 / 决策 / 教训。当用户提到提取教训 / 复盘 / lessons learned / 知识沉淀 / 经验萃取 / 提炼模式时使用。会扫 .context/ 决策日志 + git log 提交语义。
license: MIT
user-invocable: true
disable-model-invocation: false
allowed-tools: Read, Bash, Grep, Glob, Write
argument-hint: "[--since=30d]"
---

# 📚 复盘关卡 · 经验萃取

> v4.1-p18：作为 skill 暴露（v3.0 曾有 `/ccg:extract-learnings` 命令规划，v4.0/v4.1 收敛到 skill 化触发）。

从最近的开发活动中萃取**可复用知识**，写入 `.context/learnings/<日期>-extract.md`，避免反复踩同坑。

## 使用方法

```bash
/ccg:extract-learnings              # 默认萃取最近 30 天
/ccg:extract-learnings --since=14d  # 自定义时间窗口
```

## 工作流程

### Step 1：收集原料

```bash
# 决策日志
ls .context/sessions/ 2>/dev/null
# git 提交（含 commit message）
git log --since='30.days.ago' --pretty='%h %s' --no-merges
# 已归档的 phase 报告
ls .claude/team-plan/*-report.md 2>/dev/null
```

### Step 2：分类萃取

按以下五个桶过滤：

1. **模式（Pattern）** — 反复出现的好做法（"phase 都用 fresh-context subagent 隔离"）
2. **反模式（Anti-pattern）** — 反复犯的错（"沙箱里跑 git commit 总被拒"）
3. **决策记录（ADR-like）** — 重要架构决定 + 为什么这么决定
4. **工具陷阱（Tooling pitfall）** — 工具实际行为 != 文档（"Claude Code subagent 不能嵌套 spawn"）
5. **痛点 / 改进点（Pain point）** — 还没解决的待办 / 流程瓶颈

### Step 3：写报告

```markdown
# Learnings Extract — <日期范围>

**会话数**: N · **commits**: M · **完成 phase**: K

## 模式（建议固化）
1. ...

## 反模式（建议警告）
1. ...

## 决策记录
- **D1: 用 SessionStart hook 注入 roadmap** — 原因：v4.0 主线零项目记忆痛点

## 工具陷阱
- **subagent 不能 spawn 子 agent**（commit a7cdffd 实测）

## 痛点
- ...
```

### Step 4：（可选）建议 PR

每条"模式"标记 `→ promote to rules?`，让用户决定是否上升为 `~/.claude/rules/*.md`。

## 输出契约

- 主输出：`.context/learnings/<YYYY-MM-DD>-extract.md`
- 终端：每桶 1-3 条精选摘要
