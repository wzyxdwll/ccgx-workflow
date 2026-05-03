---
phase: v4.1-roadmap
plan: .claude/plan/v4.1-roadmap.md
goal: 综合 v4.0 dogfood + 用户 6 问 + 开源生态扫描，定 v4.1 phase 列表
decisions:
  - 跳过严格双模型并行（meta 设计任务，非代码实施）
  - 7 phase 列表（α 3 个高 ROI + β 2 个中 + γ 2 个收尾）
  - 总工时 12 天（v4.0 基础设施已就位，精度提升占大头）
  - Phase 1 SessionStart hook 是用户 Q6 关键缺口
  - Phase 2 wave 并行直接修复用户 Q2 慢
  - Phase 3 specialist matrix 修复用户 Q3 不智能
  - Phase 6 命令面板 31 → 22 收敛
constraints:
  - 不解决 Claude Code 引擎层限制（subagent 嵌套 / 注册需重启）
  - 保留 v4.0 BC（旧 verify-* deprecated 但仍可用）
  - phase-runner G 方案保留 fallback 路径
files:
  - templates/hooks/ccg-session-state.js (NEW)
  - templates/commands/autonomous.md (--parallel flag)
  - templates/commands/{plan,analyze,debug,review,optimize,test}.md (--role flag)
  - templates/commands/agents/phase-runner.md (challenger 钩子激活)
  - templates/commands/debate.md (NEW)
  - templates/skills/impeccable/*/SKILL.md × 20 (description 翻译 + context: fork)
  - src/utils/installer.ts (--sync 模式)
  - src/utils/skill-registry.ts (新 frontmatter 字段)
created_at: 2026-05-04T00:00:00Z
---

# Phase Context Snapshot — v4.1 Roadmap

主线 Claude 在 /ccg:plan 中综合 .ccg-research/ 4 份文档 + 用户 6 个问题 + dogfood Phase 12 数据，输出 v4.1 7 phase 路线图。

下游 /ccg:execute .claude/plan/v4.1-roadmap.md 时只需 Read 本文件 frontmatter（< 200 tokens）即可获得全部决策。
