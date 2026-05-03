# CCG Deprecation Plan

本文档记录命令面板的瘦身决策。v3.0.0 仅打 deprecated 标签做迁移预告；v4.0.0 完成首波收敛（删 5 + 合并 4）；后续 v5.0 计划清理已硬下线的 verify-* 入口。

---

## v4.0.0 实际删除清单（破坏性变更）

### A. 直接删除的 5 个命令

| 命令 | 删除原因 | 替代方案 |
|------|---------|---------|
| `/ccg:frontend` | 与 `/ccg:workflow` 智能路由前端任务等价，单独维护重复 | `/ccg:workflow <前端任务>`（自动路由到 frontend primary） |
| `/ccg:backend` | 与 `/ccg:workflow` 智能路由后端任务等价，单独维护重复 | `/ccg:workflow <后端任务>`（自动路由到 backend primary） |
| `/ccg:feat` | 与 `/ccg:workflow` 重叠（"智能识别+规划+实施"已是 workflow 默认行为） | `/ccg:workflow <功能描述>` |
| `/ccg:forensics` | 用例稀缺，复盘可由 `/ccg:context log` + `/ccg:health` 组合完成 | `/ccg:context log` + `/ccg:health` |
| `/ccg:extract-learnings` | 用例稀缺，已被 `/ccg:context` 历史归档机制覆盖 | `/ccg:context history` |

### B. 模板文件操作

- ✅ 删除 `templates/commands/{frontend,backend,feat,forensics,extract-learnings}.md`
- ✅ 从 `src/utils/installer-data.ts` 命令注册表移除 5 项
- ⚠️  老用户 `~/.claude/commands/ccg/{frontend,backend,feat,forensics,extract-learnings}.md` 在下次 `update` 时由 `uninstallWorkflows` 清理

### C. 用户迁移指引

老用户运行 `npx ccg-workflow update` 后，旧命令将从 `~/.claude/commands/ccg/` 中清除。如有自动化脚本/快捷键引用这 5 个命令，请按上表替换为新命令。

---

## v4.0.0 verify-* 合并清单

| 旧命令 (skill-generated, BC 保留) | 新统一入口 |
|-----------------------------------|-----------|
| `/ccg:verify-change [path]`       | `/ccg:verify --gate=change [path]` |
| `/ccg:verify-quality [path]`      | `/ccg:verify --gate=quality [path]` |
| `/ccg:verify-security [path]`     | `/ccg:verify --gate=security [path]` |
| `/ccg:verify-module <path>`       | `/ccg:verify --gate=module <path>` |
| **新增**                          | `/ccg:verify --gate=all [path]`（等价 `/ccg:verify-work`） |

**v4.0.0 行为**：
- 4 个旧 verify-* 命令仍由 Skill Registry 自动生成（保留 BC）
- 4 个 SKILL.md frontmatter `deprecated_in: v4.0` + `replaced_by: /ccg:verify --gate=<name>`
- 新增 `/ccg:verify` 主命令作为统一路由入口
- `/ccg:verify-work` 编排器保留独立（决策矩阵显著区别于子门）

**v5.0 计划清理**：
- 4 个旧 SKILL.md 的 `user-invocable` 设为 false（保留 SKILL.md 本身，不再生成 slash command）
- 4 个旧 skill-generated commands 从 `~/.claude/commands/ccg/` 卸载

---

## v3.0.0 历史决策（已被 v4.0 取代）

> v3.0.0 时仅打 deprecated 标签，未实际删除/合并。本节保留为历史记录。

策略：把"前缀同族 + 行为相关"的多个独立命令合并为"单命令 + 子动作 flag"形式，对齐 GSD v1.39.0 的 86 → 59 整合实践。

收益：
- 命令列表瘦身（用户认知负担降低）
- frontmatter 维护点减少
- 共享逻辑（鉴权、路径解析、报告格式）可下沉到主命令

代价：
- BC 风险（51 处 hooks/rules/i18n/用户肌肉记忆引用具体命令名）
- 子命令路由分发逻辑

### 1. `/ccg:verify-*` 系列 → `/ccg:verify --gate=<name>`（v4.0 已落地）

| 现有命令 | 整合后 | 调用语义 |
|----------|--------|----------|
| `/ccg:verify-change` | `/ccg:verify --gate=change [path]` | 变更影响分析 |
| `/ccg:verify-quality` | `/ccg:verify --gate=quality [path]` | 代码质量检测 |
| `/ccg:verify-security` | `/ccg:verify --gate=security [path]` | 安全漏洞扫描 |
| `/ccg:verify-module` | `/ccg:verify --gate=module [path]` | 模块完整性校验 |
| **新增** | `/ccg:verify --gate=all [path]` | 等价 `/ccg:verify-work`（全门） |

**保留独立的**：`/ccg:verify-work`（编排器，自动按变更类型选门，逻辑显著区别于子门）

### 2. `/ccg:spec-*` 系列 → 暂不整合

OPSX 工作流的 5 个 spec-* 命令（spec-init / spec-research / spec-plan / spec-impl / spec-review）虽前缀同族，但每个对应 OPSX 的独立工作阶段，**已是合理的最小命令面**。整合为 `/ccg:spec --research/--plan/...` 不带来认知收益，反而破坏与 OPSX 概念的 1:1 对应。

**结论**：不整合。

### 3. `/ccg:team*` 系列 → 暂不整合

`/ccg:team` 是统一 8 阶段工作流（独立），`/ccg:team-research/plan/exec/review` 是单阶段工具（手动控制粒度时使用）。两者职能不同，整合反而模糊边界。

**结论**：不整合。

---

## v5.0.0 真正切换 verify 时的检查清单（前瞻）

- [ ] 4 个旧 SKILL.md 的 `user-invocable` 设为 false（保留 SKILL.md 本身，不再生成 slash command）
- [ ] `installer-data.ts` 命令注册表保持 `verify` 主命令
- [ ] 全 22 个模板 grep 旧命令名 → 替换为新形式
- [ ] `templates/rules/ccg-skills.md` 触发规则改写为 `/ccg:verify --gate=<name>`
- [ ] i18n 字符串更新
- [ ] 迁移脚本：`update` 时检测旧 frontmatter，提示用户 mute 提醒或显式 OK 切换

---

**最后更新**：2026-05-03（v4.0.0 落地）
