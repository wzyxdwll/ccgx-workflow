# CCG v3 → v4 Migration Guide

**Released**: 2026-05-03 (v4.0.0)

> v4.0 在 v3.0 基础上引入 12 个 phase 的内部重塑（dogfood 验证），命令面板从 35 收敛到 ~30，新增 4 个 fresh-context subagent 协议解决"主线 context 漂移"痛点。**绝大部分变更对调用者透明**——核心命令名 / 调用语法零改动。

---

## TL;DR

| 类别 | 数量变化 | 说明 |
|------|---------|------|
| user-invocable 命令 | 35 → ~30 | 删 5 + 合 4 verify-* + 新增 5（autonomous/status/result/cancel/verify） |
| Subagent | 15 → 19 | 新增 phase-runner / code-fixer / debug-session-manager / debugger |
| 测试 | 168 → 515 | dogfood 12 phase 沉淀 |
| 包体积 | ~200 KB | 与 v3.0 持平 |

---

## 删除的命令 → 替代命令对照表

老用户 `npx ccg-workflow update` 后这些命令会从 `~/.claude/commands/ccg/` 自动卸载。

| 已删除命令 | 替代方案 | 说明 |
|-----------|---------|------|
| `/ccg:frontend` | `/ccg:workflow <前端任务>` | workflow 智能路由覆盖此用例 |
| `/ccg:backend` | `/ccg:workflow <后端任务>` | workflow 智能路由覆盖此用例 |
| `/ccg:feat` | `/ccg:workflow <功能描述>` | workflow 默认即"识别+规划+实施"全流程 |
| `/ccg:forensics` | `/ccg:context log` + `/ccg:health` | 用例稀缺，组合命令足够 |
| `/ccg:extract-learnings` | `/ccg:context history` | context 历史归档已覆盖 |

如有自动化脚本/快捷键引用上述命令，请按表替换。

---

## 合并的 verify-\* → /ccg:verify --gate=

4 个 `verify-*` 命令合并为单一入口：

| v3 旧命令（仍可用，已标 deprecated） | v4 新统一入口 |
|-----|-----|
| `/ccg:verify-change [path]` | `/ccg:verify --gate=change [path]` |
| `/ccg:verify-quality [path]` | `/ccg:verify --gate=quality [path]` |
| `/ccg:verify-security [path]` | `/ccg:verify --gate=security [path]` |
| `/ccg:verify-module <path>` | `/ccg:verify --gate=module <path>` |
| **新增** | `/ccg:verify --gate=all [path]` |

**v4.0 BC 保证**：4 个旧 verify-\* 命令仍由 Skill Registry 自动生成，可继续使用，仅 frontmatter 加 `deprecated_in: v4.0` + `replaced_by: /ccg:verify --gate=<name>` 标签。

**v5.0 计划**：4 个旧 SKILL.md 设 `user-invocable: false`，硬下线旧入口（仅保留新主命令）。

`/ccg:verify-work` 编排器**保留独立**——决策矩阵（按变更类型自动选门）显著区别于子门，没必要折叠。

---

## v4.0 新增的 11 项关键能力（一句话介绍）

| 能力 | 一句话 |
|------|------|
| **context_budget frontmatter** | 4 个核心命令模板硬约束主编排器 ≤ 15% context，禁止接 builder 全部 stdout |
| **phase-runner subagent** | 主线 spawn 普通 subagent 包裹 codex/gemini rescue，沙箱外补 git/test/typecheck，主线只接 ≤200 token 摘要 |
| **.context/<phase>/{CONTEXT,SUMMARY}.md state machine** | phase-scoped 状态文件，主线只读 frontmatter（< 200 tokens/phase），subagent 落盘全状态 |
| **codebase-mapper agent** | init / plan / execute 启动时 4 路并行扫描，产出 `.context/codebase/{STACK,INTEGRATIONS,ARCHITECTURE,STRUCTURE,CONVENTIONS,TESTING,CONCERNS}.md` 7 文件契约 |
| **Scope Reduction Detection** | plan-checker 维度 7b：识别"v1 / 简化 / 静态先 / 后续连接"等关键词 → BLOCKER（与原始需求对比避免误报） |
| **plan-checker 5 维度 + max-3-loop** | Dim 1 Requirement Coverage / Dim 2 Task Completeness / Dim 5 Scope Sanity / Dim 7b Scope Reduction / Dim 10 CLAUDE.md Compliance，失败回 planner 收敛环 |
| **异步三件套 /ccg:status /ccg:result /ccg:cancel** | job-id 化背景任务管理，存 `.context/jobs/<id>/`，长任务可观测 |
| **verifier Level 4 数据流追踪** | 识别动态渲染 artifact → 追溯数据源 → 区分 FLOWING / STATIC / DISCONNECTED / HOLLOW_PROP；Step 3b override；Step 9b deferred filtering |
| **会话式 UAT + cold-start smoke** | UAT.md frontmatter 状态文件跨会话持久；扫 git diff 命中 server/database/migrations 自动注入冷启动测试 |
| **/ccg:review --fix --auto + worktree 隔离** | code-fixer agent 在临时 worktree + 临时分支闭环修复，4 步 transactional cleanup（merge/remove/branch -D/rm sentinel）严格顺序 |
| **debug-session-manager 双层 fresh-context** | manager 在 fresh context 跑多轮 falsifiable hypothesis，主线只接 ROOT CAUSE FOUND / DEBUG COMPLETE / CHECKPOINT REACHED 三种结构化结果 |

---

## 不破坏 BC 的项

- ✅ 模型路由变量 `{{FRONTEND_PRIMARY}} / {{BACKEND_PRIMARY}}` 不变
- ✅ `codeagent-wrapper` shim 路径 + 调用语法不变（v3.0 已迁移到 invoke-model.mjs，v4.0 保持）
- ✅ `~/.claude/.ccg/config.toml` schema 不变
- ✅ `permissions.allow` 规则不变
- ✅ 4 个 verify-\* 命令仍可调（标 deprecated，v5.0 切换）
- ✅ 19 个专家提示词（claude/codex/gemini）不变
- ✅ MCP 三端同步（Claude / Codex / Gemini）逻辑不变
- ✅ `team-*` / `spec-*` 系列命令名不变

---

## Skill 体系变更

- **frontend-design / impeccable**：改为可选安装（init 第 4 步 confirm 提示）+ frontend-design SKILL.md `user-invocable: false`，引流到官方 [`claude-plugins-official/frontend-design`](https://github.com/anthropics/claude-plugins-official/tree/main/skills/frontend-design) plugin
- **domain skills**（10 大领域 61 文件）：全部 `user-invocable: false`，保留作为 reference + `rules/ccg-skill-routing.md` 关键词触发自动 Read，**不进 `/ccg:` 命令面板**

---

## 升级步骤

```bash
npx ccg-workflow update          # 自动迁移 + 卸载 5 个删除的命令 + 安装新 5 个命令
```

或全新装：

```bash
npx ccg-workflow                  # 一键初始化
```

如需查看本地版本：

```bash
npx ccg-workflow --version        # 应显示 4.0.0
```

---

## 反馈渠道

- GitHub Issues: https://github.com/fengshao1227/ccg-workflow/issues
- X (Twitter): [@CCG_Workflow](https://x.com/CCG_Workflow)

---

**dogfood 数据点**：v4.0 12 个 phase 全部用 CCG autonomous 自身长跑完成，主线 context 漂移 31% → 49%（+18% 净增量，+1%/phase 平均）。GSD "subagent 隔离让主线 ≤15%" 论点经验证成立——前 11 phase fresh-context subagent 路径下，主线增量稳定在 +1%/phase，远低于无隔离时的失控漂移。
