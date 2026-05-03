---
name: ccg:forensics
description: 事故系统复盘 - 时间线重建/触发点/根因/修复/预防，输出到 .context/forensics/<incident-id>.md
argument-hint: "[问题描述或 incident-id]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Grep
  - Glob
---

# Forensics - 事故法医复盘

`/ccg:debug` 解决"代码为什么不工作"，`/ccg:forensics` 解决**"系统为什么会发生这件事 + 下次如何不再发生"**。前者面向 bug，后者面向流程/架构/决策的失败。

不臆测、不甩锅，只信"日志 + 提交 + 文件状态"三类事实证据。输出物是结构化复盘报告，归档到 `.context/forensics/<incident-id>.md`，可作为后续 `/ccg:extract-learnings` 的输入。

## 使用方法

```bash
/ccg:forensics                               # 自由询问问题描述
/ccg:forensics 部署后 prod 503 持续 12 分钟    # 直接传问题描述
/ccg:forensics inc-2026-04-10-deploy-503     # 复盘已存在 incident
```

## 你的角色

你是**事故法医**，read-only 调查员。绝不修改产品代码，只允许写 `.context/forensics/` 报告与 `.context/state.md` 的会话痕迹。

## 工作流程

### Step 1：明确事故边界

向用户或从 $ARGUMENTS 提取四要素：

| 字段 | 说明 |
|------|------|
| **What** | 具体出了什么问题（症状） |
| **When** | 起止时间窗（精确到分钟） |
| **Where** | 影响哪个组件 / 环境 / 用户群 |
| **Severity** | 阻断 / 降级 / 干扰 / 隐患 |

四要素任一缺失 → 用 AskUserQuestion 补齐，禁止"猜"。

生成 incident-id：`inc-YYYY-MM-DD-<short-slug>`。

### Step 2：证据收集（read-only）

按以下优先级搜证：

```bash
# 1. Git 时间线
git log --since="<When start>" --until="<When end>" --pretty=format:"%h %ai %s" --all
git log --since="<When start>" --until="<When end>" --stat
git diff <last-good-commit> <bad-commit>

# 2. 文件系统状态
git status
ls -la <suspect-paths>

# 3. .context 内部状态
Read .context/state.md
Read .context/roadmap.md
Glob .context/decisions/**/*.md   # 决策是否有错？
Glob .context/forensics/*.md      # 历史事故是否相似？

# 4. 日志文件（如有）
Grep -n -i "error|exception|fatal" <log-paths>

# 5. CI/CD 痕迹（如可访问）
gh run list --limit 20 --json status,conclusion,startedAt,name
```

**证据原则**：每个发现都必须 cite 具体 commit hash / 文件:行号 / 日志段落。无证据 → 标 `[未确认]`，不写入根因。

### Step 3：异常类型扫描（至少 4 类）

按已知异常模式快速过一遍：

| 异常类型 | 检测方法 |
|---------|---------|
| **触发性变更** | 时间窗内是否有 deploy / merge / config 变更 |
| **死循环 / 卡死** | 是否同一步骤被反复重试无进展 |
| **静默失败** | 是否有错误被吞 / catch 后未上报 |
| **资源耗尽** | 内存 / 磁盘 / 连接池 / 限流 |
| **依赖故障** | 上游服务 / 第三方 API / 网络 |
| **并发竞争** | race / 死锁 / 顺序假设破裂 |

每类必须给"已检查 / 已排除 / 已确认"三态结论。

### Step 4：撰写报告 → `.context/forensics/<incident-id>.md`

模板：

```markdown
# Incident <incident-id>

## 事故快照
- **What**: …
- **When**: <start> → <end>（持续 N 分钟）
- **Where**: …
- **Severity**: 阻断 / 降级 / 干扰 / 隐患

## 时间线（按分钟重建）
| 时间 | 事件 | 证据 |
|------|------|------|
| 14:02 | merge PR #123 | git log 7a3f1b2 |
| 14:05 | prod 5xx 飙升 | logs/app.log:1042-1080 |
| 14:17 | rollback 完成 | git revert 7a3f1b2 |

## 触发点
- **直接触发**: <commit/事件>
- **必要前提**: <为何此 commit 引发问题>

## 影响范围
- 用户：N 人（来源：<日志/统计>）
- 数据：是否有写坏需要修复 / 否

## 根因（多层）
1. **直接因**: <代码/配置层面>
2. **过程因**: <CR/CI/部署流程>
3. **系统因**: <架构/规范/认知盲区>

## 修复
- **临时**: 已 rollback to <commit>
- **永久**: <PR/issue 链接>

## 预防措施（按可执行性排序）
- [ ] 加 CI 检查：…
- [ ] 加监控告警：…
- [ ] 改规则 / 流程：…

## 不确定项
- [未确认] …（原因：缺日志/无访问权）
```

### Step 5：交叉引用

- 在 `.context/state.md` 追加：`Incidents: see forensics/<incident-id>.md`
- 如根因可推动规则改进 → 提议下一步运行 `/ccg:extract-learnings`

## 硬性约束

- **read-only 调查**：禁止改源码，仅可写 `.context/forensics/` 与 `.context/state.md` 会话段
- **证据为王**：每个根因结论必带 commit hash / 文件行号 / 日志段
- **敏感信息脱敏**：报告中绝对路径转 `~`、API key / token 一律打码
- **无证据宁可标未确认**：禁止"按经验推测"得出根因
