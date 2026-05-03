# Phase 30 — v4.3.0 Release docs + bump

**Status**: completed
**Phase ID**: phase-30-v43-release
**Phase Type**: docs
**Baseline SHA**: 1602f0e (P28 fixtures auto-gen)
**Workdir**: D:\workflow\ccg-workflow

---

## v4.3 整体落地总结

v4.3 是 **CCG 动态防御机制**版本——5 个 phase（P25-P29，加 P30 收尾）针对 v4.2.x 三连 hotfix（4.2.1 / 4.2.2 / 4.2.3）暴露的根因（基于静态文档 / 未验证假设的路由 / package.json 漏文件），系统性补齐自动化防御。**没有引入新用户面 feature，全是工程闭环加固**。

### 5 项防御机制（commit ↔ 防御对象映射）

| Phase | Commit | 防御对象（v4.2.x 真事故） | 机制 |
|-------|--------|---------------------------|------|
| P25 | `6378a6e` | v4.2.2 `templates/commands/debate.md` 漏 `package.json` `files` 白名单 → 三个版本 `/ccg:debate` 不可用 | `pipeline-check` helper：`pnpm pack` + tarball audit + 漏文件检测 |
| P26 | `fbf7c3c` | v4.2.0-2.2 假设 `codex:codex-rescue` plugin subagent_type（实际 `codex:rescue`）→ 三档分级在真用户 spawn 失败 | `ground-truth-sampler`：启动时动态采样 plugin / skill / agent 列表写 `.context/ground-truth/latest.json`，prompt 强约束 phase-runner 必须 Read 之 |
| P27 | `af31f68` | 跨 phase 接口债（v4.2 P22 `buildVerifyWave` 与 P21 `planVerifyWave` 95% 重复 / `parseFindings` 假设字段名 / 路由 magic string） | `interface-auditor` specialist：5 检查清单 SSoT-violation / leftover / magic-string-vs-ground-truth / 未验证假设 / API drift；triple/debate verify wave 必跑（fast 不跑） |
| P28 | `1602f0e` | inline mock 漂移真实接口（如 `RoadmapPhase` 字段改名后单测仍通过但集成挂） | fixtures 自动化：`scripts/regen-fixtures.ts` + `tests/fixtures/ground-truth/*.sample.json` + 替换 challenger/debate/verify 三个测试 inline mock |
| P29 | `e6b6db0` + `89034a7` | commit message ↔ diff 不一致（如 `fix(p27)` 但 staged `phase-29/*` → 历史记录失真） | `templates/hooks/ccg-commit-msg-review.cjs` opt-in git pre-commit-msg hook，3 启发式检查（文件名 / phase tag / 操作类型 ↔ diff） |

5 项落地后，**v4.2.x 全部 3 类 release-blocker 都拥有自动化拦截路径**，未来同型事故在 CI / 安装期 / commit 期被捕获。

---

## 新 race 形态记录（v4.3 dogfood wave 1 暴露）

### 现象

P25-P29 5 phase 在 wave 1 并行 dogfood 跑（多个 `phase-runner` 同时实施不同 phase），完成顺序大致是：

1. P26 先 commit 完成（baseline `fbf7c3c`）
2. P27 / P28 / P29 后续陆续 commit，但出现 **commit 归属错配**：
   - P27 报告标 commit `af31f68`，但实际 diff 含**部分 P29 staged 的 `templates/hooks/` 文件**（`af31f68` 引入了 `interface-auditor.md` 同时也带走了 `ccg-commit-msg-review.cjs` 的部分修改）
   - P29 后续两个 commit (`e6b6db0` + `89034a7`) 实际是把 P27 commit 漏带的、和真正 P29 写的 wire-in 修改各算一个，第二个 fix commit 就是补 `installer-hooks.ts` 数组——这个 wire 应该 P29 一次完成

### 与 v4.1 src/index.ts race 的区分

| 特征 | v4.1 src/index.ts race（已知） | P27/P28/P29 commit 吸收 race（v4.3 wave 1 新发） |
|------|-------------------------------|----------------------------------------------------|
| 内容正确性 | ❌ 内容互相覆盖（A 写完 B 全文 overwrite） | ✅ 内容正确（每个 phase 自己的修改不丢） |
| 归属正确性 | N/A | ❌ 文件被错的 commit 带走，message ↔ diff 错配 |
| 触发点 | 多 phase 并行写**同一文件** | 多 phase 并行 `git add <自己的文件>` 后下一个 phase 的 `git commit` 把已 staged 的 index 一并带走 |
| 现有防御 | 文件边界 prompt 约束 | **无** |
| v4.3 P29 hook 是否能检测 | ❌（不是 commit-msg 问题） | ✅ 部分（hook 第二启发式 phase-tag ↔ staged paths 在 P27 commit 中会触发，因为 staged 含 phase-29/* 路径） |

### 推荐 v4.4 修复方向

- **首选**：worktree 隔离 phase-runner——每个 phase-runner 拿独立 worktree（参考 GSD `code-fixer` v4.0 P10 review-fix 已有的 4 步 transactional cleanup 模式：merge / remove / branch -D / rm sentinel）
- 备选：autonomous Step 4 内加 inter-phase mutex（一次只允许一个 phase-runner 进入 commit phase），但牺牲 wave 并行墙钟收益

---

## Acceptance verification matrix

| Acceptance | Status | Evidence |
|------------|--------|----------|
| a. 新建 `phase-30-v43-release-report.md` 含 v4.3 总结 + race 记录 + dogfood 5 步 | PASS | 本文件 |
| b. `package.json` 4.2.3 → 4.3.0 | PASS | 单行 version 字段修改 |
| c. CHANGELOG.md 顶部加 `## [4.3.0] - 2026-05-04` 段含 ✨ / 🔄 / 🐛 已知 race 三段 | PASS | CHANGELOG.md 顶部新段 |
| d. README.md `## What's New in v4.2` 段后插入 v4.3 段（≤30 行） | PASS | README.md L176 前插入新段 |
| e. 根 CLAUDE.md 顶部 Last Updated 改 v4.3.0 + 变更记录加 2026-05-04 (v4.3.0) 条目 | PASS | CLAUDE.md L5 + 新 changelog 条目 |
| f. 新建 `.ccg-migration/v4.2-to-v4.3.md` | PASS | 含默认行为变化 / 新 hook / phase-runner 强约束 / 5 步 cold-start 验证 |
| g. installer.test.ts 等 hook 计数门更新 | N/A | 检查 `installer.test.ts` 没有硬编码的 hook count assertion，HOOK_FILES 数组已含 4 个条目（P29 已加），无需新增 |
| h.1 不真 spawn plugin | PASS | 本 phase 是 docs 类型，无 spawn |
| h.2 不改 src/utils/* helper | PASS | 仅 docs / package.json / 报告 |
| h.3 不改 templates/commands/* | PASS | 仅根 docs 与 migration guide 与报告 |

---

## Files modified / created

### Created
- `.claude/team-plan/phase-30-v43-release-report.md` (本文件)
- `.ccg-migration/v4.2-to-v4.3.md`

### Modified
- `package.json`：`version` 4.2.3 → 4.3.0
- `CHANGELOG.md`：顶部新增 `## [4.3.0] - 2026-05-04` 段
- `README.md`：`## What's New in v4.2` 段前插入 `## What's New in v4.3` 段
- `CLAUDE.md`（根）：Last Updated 行 + 变更记录加 v4.3.0 条目（覆盖 P25-30）

### 严格未触动
- `src/utils/*` 全部 helper（P25-P29 已稳定）
- `templates/commands/*` / `templates/hooks/*` / `templates/skills/*` / `templates/prompts/*`（P25-P29 已稳定）
- `tests/fixtures/`（P28 范围）
- `.ccg/roadmap.md`（主线管，P30 完成后由主线写状态）
- 历史 CHANGELOG 段（v4.2.x 及之前保留原文）
- 历史 migration 文档（`.ccg-migration/v4.0/v4.1/v4.2` 不动）

---

## Dogfood 5 步骤验证清单（cold-start 后跑）

> 这 5 步是用户首次安装 v4.3.0 后**应该**执行的真验证（CI 跑不到 plugin spawn，与 v4.2 cold-start 验证语义一致）。

### Step 1：覆盖装新模板
```bash
ccg init --skip-prompt --skip-mcp --force
```
**期望**：`~/.claude/hooks/` 含 4 个文件（`ccg-context-monitor.js` / `ccg-statusline.js` / `ccg-session-state.cjs` / `ccg-commit-msg-review.cjs`）；`~/.claude/agents/ccg/interface-auditor.md` 落地。

### Step 2：跑 ground-truth-sampler 真采样
```bash
node ~/.claude/skills/ccg/tools/ground-truth-sampler/scripts/sample.mjs
cat .context/ground-truth/latest.json | head -40
```
**期望**：`installed_plugins` / `installed_skills` / `installed_agents` 三段 schema 正确，含真实安装的 codex / gemini plugin（如已装），time-stamped。

### Step 3：跑 pipeline-check
```bash
pnpm pack --dry-run | tee /tmp/ccg-pack-audit.log
node scripts/pipeline-check.ts  # 或 helper 路径，按 P25 实现位置
```
**期望**：`templates/commands/` 列表与 `package.json` `files` 白名单**一致**——若 v4.3 后再有人加 `templates/commands/<new>.md` 而漏白名单，pipeline-check 立即报错。

### Step 4：interface-auditor mock spawn（CI 模拟）
```bash
pnpm test src/utils/__tests__/interfaceAuditor.test.ts
```
**期望**：18 用例全过，覆盖 5 类 finding（SSoT-violation / leftover / magic-string / 未验证假设 / API drift）+ severity helpers + lenient parser。

### Step 5：commit-msg-review hook 反例验证
```bash
# 在一个干净 repo 内试一次故意 message↔diff 不一致的 commit
cd /tmp && mkdir hook-test && cd hook-test && git init
ln -s ~/.claude/hooks/ccg-commit-msg-review.cjs .git/hooks/commit-msg
chmod +x .git/hooks/commit-msg
echo "x" > a.txt && git add a.txt
# 故意写错 phase tag
git commit -m "fix(v4.3-p99): bogus phase tag for unrelated file"
```
**期望**：hook 拒绝（exit 1），stderr 列出"phase-99 不存在 staged paths"或类似提示，含 `--no-verify` 逃生说明。

---

## Pending handoff（沙箱外）

- `git_commit` — 由 phase-runner 接手：`chore(v4.3-p30): v4.3.0 release docs + bump + dogfood report`
- `pnpm typecheck` — 自检
- `pnpm test` — 自检（baseline 1078 应保持，本 phase 无新测试）
- `pnpm build` — 自检

---

## Notes

v4.3 的设计哲学是"**把 v4.2 三连事故的根因变成永久基础设施**"——pipeline-check / ground-truth-sampler / interface-auditor / fixtures auto-gen / commit-msg-review 五件套，不增加用户面 surface（除可选 git hook 外），但工程闭环显著加固。这与 v4.0 的"context drift 治理"、v4.1 的"使用体验精修"、v4.2 的"多模型协作深度"形成系统性互补。

**v4.3.0 ready for release**。剩余 race 留给 v4.4（worktree 隔离 phase-runner）。
