---
phase: v4.4.1-subagent-name-correction
plan: .claude/plan/v4.4.1-subagent-name-correction.md
goal: 修复 CCG 全仓 Agent(subagent_type) magic string 反向 + 跟进 fixture / 文档 / 反例 / version bump
type: docs
critical: true
quality: triple
decisions:
  - 真名锚定：Agent → 双前缀 codex:codex-rescue / gemini:gemini-rescue；Skill → 单前缀 codex:rescue / gemini:rescue
  - 195 处分类替换（spawn-target 改 / skill 引用保留 / 历史叙述加修正注释）
  - 5 wave：production 字符串 → fixtures+测试 → 模板 → 历史校正 → bump+verify
  - bump 4.4.0 → 4.4.1（hotfix）
  - fix-forward：fb40937 debate.md 4 处错名在 Wave 3 T9 一并修复
  - 不引入 normalization helper（YAGNI）
constraints:
  - skill 路径调用保留单前缀（命名空间分离合法）
  - 历史叙述标注保留 + 加 "(error string)" 注释
  - 不动 plugin-detection.ts 探测算法（正确）
  - 不动 codeagent-wrapper backend flag 路径
files:
  - src/utils/quality-router.ts
  - src/utils/debate-orchestrator.ts
  - src/utils/specialist-router.ts
  - src/utils/multi-model-routing.ts
  - src/utils/challenger-orchestrator.ts
  - src/utils/verify-orchestrator.ts
  - src/utils/phase-runner.ts
  - src/utils/jobs.ts
  - src/utils/plugin-detection.ts
  - src/utils/ground-truth-sampler.ts
  - tests/fixtures/ground-truth/agent-summaries.sample.json
  - tests/fixtures/ground-truth/README.md
  - 13 个 src/utils/__tests__/*.test.ts
  - 14 个 templates/commands/*.md
  - templates/commands/agents/interface-auditor.md
  - templates/commands/agents/phase-runner.md
  - templates/CLAUDE.md
  - templates/scripts/invoke-model.mjs
  - CLAUDE.md
  - CHANGELOG.md
  - package.json
created_at: 2026-05-04
---

# CONTEXT — v4.4.1-subagent-name-correction

## 关键事实（实测 ground truth）

| Tool | 真名 | 证据 |
|------|------|------|
| `Agent(subagent_type=...)` | `codex:codex-rescue` / `gemini:gemini-rescue` | acms phase 9.x 实测 + 本会话 system 顶部 agent 列表 |
| `Skill(skill=...)` | `codex:rescue` / `gemini:rescue` | 本会话 system 顶部 skill 列表 |
| Plugin install dir | `codex@openai-codex` / `gemini@google-gemini` | plugin-detection.ts:88-91 |

## 总体策略

**5 wave 拓扑**：
1. production 字符串（src/utils/*.ts，10 文件）
2. fixtures + 测试断言（fixture 1 + readme 1 + tests 13）
3. 模板文档（templates/*.md 14 + interface-auditor 反例反向）
4. 历史叙述校正（CLAUDE.md v4.3 段 + CHANGELOG v4.4.1）
5. version bump + typecheck/test + interface-auditor 兜底扫 + final grep

## 验证命令

```bash
# Wave 1+2 后
pnpm typecheck && pnpm test

# Wave 5 最终
grep -rn 'Agent(subagent_type="codex:rescue"|Agent(subagent_type="gemini:rescue"|subagent_type: "codex:rescue"|subagent_type: "gemini:rescue"' templates/ src/ | wc -l   # 期望 0

grep -rcn "codex:codex-rescue\|gemini:gemini-rescue" templates/ src/ tests/ | head -5   # 期望约 195
```

## 风险点（需要逐 occurrence 判断的语义）

| 模式 | 怎么判 | 例子 |
|------|--------|------|
| `Agent(subagent_type="codex:rescue")` | spawn target → 改双前缀 | `templates/commands/debate.md:65` |
| `~/.claude/commands/codex/rescue.md` | skill 路径 → 不动 | 文档引用 |
| `v4.0.1 实测 phase-runner 不能 spawn codex:codex-rescue` | 史实，记录的是史实里的真名 → 保留 | CLAUDE.md v4.0.1 段 |
| `v4.2.0 codex:codex-rescue 同型事故` | 反向叙述（说错名是双前缀，实际错名是单前缀）→ flip | ground-truth-sampler.ts:16 |
| `subagentTypeHints=['codex:rescue']` 反例数据 | interface-auditor 锚定的 ground truth → 改双前缀 | interface-auditor.md:83 |

## fb40937 处理

我刚 commit 的 debate.md 修复含 4 处错名（line 64-66, 68）。Wave 3 T9 把它们一并修，不 revert，fix-forward。
