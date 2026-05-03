---
name: ccg:verify-work
description: 验收编排器 - 按变更类型自动选择 verify-{module,security,quality,change} 子门 + verifier agent，输出聚合报告
argument-hint: "[scope-path]"
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Agent
---

# Verify Work - 多门验收编排器

CCG 已有四个 verify-* 校验关卡：`verify-module` / `verify-security` / `verify-quality` / `verify-change`，外加 `verifier` agent 做需求矩阵核验。它们各自专精，但用户面对"我刚改完一坨代码该跑哪些门"时不该自己去拼。

本命令是**编排器**：根据变更性质自动决定开哪些门、按什么顺序、最后聚合成一张体检表。

## 使用方法

```bash
/ccg:verify-work                    # 自动判定 scope 和门类
/ccg:verify-work src/auth           # 仅核验某路径
```

## 决策矩阵：根据变更类型自动选门

| 变更性质 | 触发判据（自动检测） | 门组 |
|---------|--------------------|------|
| **新模块** | `git status` 显示新增目录 + 含 README/DESIGN 期望位 | verify-module → gen-docs（如缺）→ verify-security → verify-quality |
| **小改动** | git diff <= 30 行且无新文件 | verify-quality → verify-change |
| **常规改动** | git diff 30-200 行 | verify-change → verify-quality → verifier agent |
| **安全敏感** | diff 触及 auth/crypto/input/secret/sql 路径关键字 | verify-security → verify-change → verifier agent |
| **重构** | git log message 含 `refactor:` 或大量改动无新增功能 | verify-change → verify-quality → verify-security |
| **未知** | 无法判定 | 全开（所有门 + verifier agent）|

## 工作流程

### Step 1：scope 与变更性质识别

```bash
# 收集变更面
git status --short
git diff --stat HEAD
git log -1 --pretty=format:"%s%n%b"
```

判定逻辑：

```
1. $ARGUMENTS 给了路径 → scope = 该路径，仅看其内变更
2. 检查 git status 是否有新增目录 → 命中"新模块"分支
3. 计算 diff 行数总和 → 落入小/常规/重构区段
4. Grep 变更文件名关键字（auth|login|crypto|password|token|sql|input|secret）→ 命中安全敏感分支
```

输出：选中的门类 + 执行顺序，向用户展示再开跑（如有 5+ 门则 AskUserQuestion 确认）。

### Step 2：依次调用各门

调用方式（皆通过 Skill / 子命令，**不直接调 codeagent-wrapper**）：

| 门 | 调用 |
|----|------|
| verify-module | 调用 `verify-module` skill，传 scope 路径 |
| verify-security | 调用 `verify-security` skill，传 scope 路径 |
| verify-quality | 调用 `verify-quality` skill，传 scope 路径 |
| verify-change | 调用 `verify-change` skill，默认 working 模式 |
| verifier agent | 通过 `Agent(subagent_type="verifier")` 调用，传需求清单 + 变更范围 |

每个门**收集结构化结果**（不要让模型自由叙述），固定字段：

```yaml
gate: verify-quality
status: PASS | WARN | FAIL
counts: { critical: 0, high: 1, medium: 3, low: 7 }
top_findings:
  - file: src/x.ts
    line: 42
    severity: high
    msg: 函数复杂度 18 > 阈值 10
artifacts: [报告文件路径]
```

### Step 3：失败短路策略

- 任意门返回 **FAIL with critical** → 立即停止后续门，警示用户先修
- 门返回 WARN → 继续，但在最终报告中聚合警告
- 门内部出错（脚本崩溃）→ 不阻断，标记 `[gate-error]`，附错误信息

### Step 4：聚合输出

```markdown
# 综合验收报告

## 决策记录
- **变更性质**: 常规改动（diff 87 行，触及 src/api/）
- **选定门组**: verify-change → verify-quality → verifier
- **执行顺序**: ↓

## 各门结果

### ① verify-change
- 状态：✅ PASS
- 变更文件：5
- 文档同步：⚠ DESIGN.md 需更新
- 报告：<路径>

### ② verify-quality
- 状态：⚠ WARN
- 复杂度警告：1
- 命名问题：0
- Top finding：`src/api/users.ts:42` 函数行数 67 > 50

### ③ verifier (agent)
- 状态：✅ PASS
- 需求矩阵：3/3 PASS
- 构建测试：✅ pnpm typecheck + pnpm test 通过
- 报告：见 verifier 输出

## 综合判决

| 维度 | 状态 |
|------|------|
| 阻断项 | 0 |
| 告警项 | 2 |
| 修复优先级 | High → DESIGN.md 同步 / 函数拆分 |

**建议**: ✅ 可交付，但建议处理 2 项告警。
```

### Step 5：与 .context 集成

- 报告写入 `.context/verifications/<YYYY-MM-DD-HHMM>.md`
- `.context/state.md` 追加引用：`Verification: see verifications/...`

## 与各 verify-* skill 的契约

| Skill | 输入 | 输出 |
|-------|------|------|
| verify-module | 模块路径 | README/DESIGN 完整性 + 推荐目录结构 |
| verify-security | 扫描路径 | Critical/High/Medium/Low 漏洞计数 + 文件清单 |
| verify-quality | 扫描路径 | 复杂度/命名/异味指标 + 问题清单 |
| verify-change | mode flag | 变更摘要 + 文档同步状态 |
| verifier agent | 需求清单 + 代码变更 | PASS/FAIL/PARTIAL 矩阵 + 构建测试结果 |

本命令**只编排，不实现**：所有检测能力来自上述子组件。

## 硬性约束

- **不重复实现已有 skill 的检测逻辑**：仅按决策矩阵选门 + 调用 + 聚合
- **变更性质判定必须明示**：决策记录要写清楚为何选这组门
- **失败 short-circuit 必须明显**：用户应一眼看出"在哪一门挂了"
- **报告路径固定**：始终落 `.context/verifications/`，便于历史比对
