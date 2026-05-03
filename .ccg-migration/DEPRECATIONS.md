# CCG v3.0.0 Deprecation Plan

本文档列出 v3.0.0 发布时**仅打 deprecated 标签**、**v3.1.0 才真正切换**的命令整合候选。打标的目的是让用户提前看到替换方案，给迁移留窗口期。**v3.0.0 命令调用全部继续工作**。

---

## 整合策略

把"前缀同族 + 行为相关"的多个独立命令合并为"单命令 + 子动作 flag"形式，对齐 GSD v1.39.0 的 86 → 59 整合实践。

收益：
- 命令列表瘦身（用户认知负担降低）
- frontmatter 维护点减少
- 共享逻辑（鉴权、路径解析、报告格式）可下沉到主命令

代价：
- BC 风险（51 处 hooks/rules/i18n/用户肌肉记忆引用具体命令名）
- 子命令路由分发逻辑

---

## v3.1 整合候选清单

### 1. `/ccg:verify-*` 系列 → `/ccg:verify --<gate>`

| 现有命令 | 整合后 | 调用语义 |
|----------|--------|----------|
| `/ccg:verify-change` | `/ccg:verify --change [path]` | 变更影响分析 |
| `/ccg:verify-quality` | `/ccg:verify --quality [path]` | 代码质量检测 |
| `/ccg:verify-security` | `/ccg:verify --security [path]` | 安全漏洞扫描 |
| `/ccg:verify-module` | `/ccg:verify --module [path]` | 模块完整性校验 |
| **新增** | `/ccg:verify --all [path]` | 等价于 `/ccg:verify-work`（全门） |

**保留独立的**：`/ccg:verify-work`（编排器，自动按变更类型选门，逻辑显著区别于子门）

### 2. `/ccg:spec-*` 系列 → 暂不整合

OPSX 工作流的 5 个 spec-* 命令（spec-init / spec-research / spec-plan / spec-impl / spec-review）虽前缀同族，但每个对应 OPSX 的独立工作阶段，**已是合理的最小命令面**。整合为 `/ccg:spec --research/--plan/...` 不带来认知收益，反而破坏与 OPSX 概念的 1:1 对应。

**结论**：不整合。

### 3. `/ccg:team*` 系列 → 暂不整合

`/ccg:team` 是统一 8 阶段工作流（独立），`/ccg:team-research/plan/exec/review` 是单阶段工具（手动控制粒度时使用）。两者职能不同，整合反而模糊边界。

**结论**：不整合。

---

## v3.0.0 落地动作

### A. SKILL.md frontmatter 加字段

为每个 v3.1 计划整合的命令的 SKILL.md / .md 加：

```yaml
---
deprecated_in: v3.1
replaced_by: /ccg:verify --<gate>
deprecation_message: |
  v3.1 起将被 /ccg:verify --<gate> 替代。当前 v3.0.0 仍可正常使用，无需立即迁移。
---
```

**v3.0.0 影响范围**（4 个文件）：
- `templates/skills/tools/verify-change/SKILL.md`
- `templates/skills/tools/verify-quality/SKILL.md`
- `templates/skills/tools/verify-security/SKILL.md`
- `templates/skills/tools/verify-module/SKILL.md`

### B. 用户提示

`skill-registry.ts:generateCommandContent()` 检测到 `deprecated_in` 字段时，在生成的 command.md 顶部插入软提示：

```markdown
> ⚠️ **将在 v3.1 整合**：本命令将被 `<replaced_by>` 替代。当前版本仍正常工作。
```

（v3.0.0 暂不实现，仅记录此机制；v3.0.x 小版本可补丁补上）

### C. CHANGELOG / README

v3.0.0 CHANGELOG 标注："**未来变更预告（v3.1）**：4 个 verify-* 命令将整合为 /ccg:verify --<gate>"。

---

## v3.1.0 真正切换时的检查清单

- [ ] 实现 `/ccg:verify` 主命令路由（按 flag 分发到现有 4 个 SKILL.md scripts）
- [ ] 4 个旧 SKILL.md 的 `user-invocable` 设为 false（保留 SKILL.md 本身，不再生成 slash command）
- [ ] `installer-data.ts` 命令注册表移除旧 4 项
- [ ] 全 22 个模板 grep 旧命令名 → 替换为新形式
- [ ] `templates/rules/ccg-skills.md` 触发规则改写
- [ ] i18n 字符串更新
- [ ] 迁移脚本：`update` 时检测旧 frontmatter，提示用户 mute 提醒或显式 OK 切换

---

**最后更新**：2026-05-03（v3.0.0 规划）
