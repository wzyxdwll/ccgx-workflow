# CCG Deprecation Plan

公共发布版本（npm `ccgx-workflow` 1.0.0+）的 deprecation 当前态。早期内部 dogfood 阶段（v3.x / v4.x，**从未发布到 npm**）的瘦身决策历史归档在 [INTERNAL-DEV-LOG.md](./INTERNAL-DEV-LOG.md)。

---

## 当前已删除的命令（1.0.0 rebrand 时不在命令面板的旧条目）

| 命令 | 删除原因 | 替代方案 |
|------|---------|---------|
| `/ccg:frontend` | 与 `/ccg:workflow` 智能路由前端任务等价 | `/ccg:workflow <前端任务>` |
| `/ccg:backend` | 与 `/ccg:workflow` 智能路由后端任务等价 | `/ccg:workflow <后端任务>` |
| `/ccg:feat` | 与 `/ccg:workflow` 重叠 | `/ccg:workflow <功能描述>` |
| `/ccg:forensics` | 用例稀缺（已迁为 skill） | skill `/ccg:forensics` 仍由 Skill Registry 提供 |
| `/ccg:extract-learnings` | 用例稀缺（已迁为 skill） | skill `/ccg:extract-learnings` |

---

## verify-* 当前状态

| 旧命令 (BC 保留, skill-generated) | 新统一入口 |
|-----------------------------------|-----------|
| `/ccg:verify-change [path]`       | `/ccg:verify --gate=change [path]` |
| `/ccg:verify-quality [path]`      | `/ccg:verify --gate=quality [path]` |
| `/ccg:verify-security [path]`     | `/ccg:verify --gate=security [path]` |
| `/ccg:verify-module <path>`       | `/ccg:verify --gate=module <path>` |
| **新增**                          | `/ccg:verify --gate=all [path]`（等价 `/ccg:verify-work`） |

**当前行为**：
- 4 个旧 verify-* 命令仍由 Skill Registry 自动生成（保留 BC）
- 4 个 SKILL.md frontmatter `deprecated_in: 1.0.0` + `replaced_by: /ccg:verify --gate=<name>`
- `/ccg:verify` 主命令为统一路由入口
- `/ccg:verify-work` 编排器保留独立（决策矩阵显著区别于子门）

**未来计划清理**：
- 旧 SKILL.md 的 `user-invocable` 设为 false（保留 SKILL.md 本身，不再生成 slash command）
- 老用户机器上 `~/.claude/commands/ccg/verify-{change,quality,security,module}.md` 由下次 `update` 中的 `uninstallWorkflows` 清理

---

## 不整合的命令族（设计决策）

### `/ccg:spec-*`（OPSX 工作流）

5 个 spec-* 命令对应 OPSX 独立工作阶段，**已是合理的最小命令面**。整合为 `/ccg:spec --research/--plan/...` 不带来认知收益，反而破坏与 OPSX 概念的 1:1 对应。

**结论**：不整合。

### `/ccg:team*`（Agent Teams 系列）

`/ccg:team` 是统一 8 阶段工作流（独立），`/ccg:team-research/plan/exec/review` 是单阶段工具（手动控制粒度时使用）。两者职能不同，整合反而模糊边界。

**结论**：不整合。

---

## 最终切换 verify 时的检查清单（前瞻）

- [ ] 旧 SKILL.md 的 `user-invocable` 设为 false（保留 SKILL.md 本身，不再生成 slash command）
- [ ] `installer-data.ts` 命令注册表保持 `verify` 主命令
- [ ] 全模板 grep 旧命令名 → 替换为新形式
- [ ] `templates/rules/ccg-skills.md` 触发规则改写为 `/ccg:verify --gate=<name>`
- [ ] i18n 字符串更新
- [ ] 迁移脚本：`update` 时检测旧 frontmatter，提示用户 mute 提醒或显式 OK 切换

---

**最后更新**：2026-05-10 (1.0.5)
