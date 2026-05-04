# Phase 32+34 Offload Report

**Phase**: phase-32-34-prompt-constraints (v4.4 P32+P34 合并)
**Status**: completed
**Baseline**: d49fd3a
**Commit**: (see git log post-commit)

## Files modified (本 phase 范围)

- `templates/commands/autonomous.md` — Step 4.0 ground-truth-sampler 集成段（P32）
- `templates/commands/agents/phase-runner.md` — 加 2 条 prompt 约束（外部接口先验 + git add 显式列文件）
- `src/utils/interface-auditor.ts` — 加第 6 项 alien-files-staged + `auditAlienFilesStaged` + `isFileInScope` + `globToRegExp` helper
- `src/utils/__tests__/interfaceAuditor.test.ts` — 加 8 个 alien-files-staged 测试
- `.claude/team-plan/phase-32-34-report.md` — 本报告

## Acceptance verification matrix

| Acceptance | 状态 | 证据 |
|------------|------|------|
| a. autonomous.md Step 4.0 含 sampler 调用段（10-20 行） | PASS | autonomous.md 行 142-170 新增"4.0 Ground-Truth 采样"段，含伪码 sampleAll + writeFileSync + symlinkSync + 容错 + phase-runner 注入路径 |
| b. phase-runner.md 加 "外部接口先验" + "git add 显式列文件" 两条约束 | PASS | phase-runner.md "严格约束"段加 2 个 🔒 块（共 ~25 行） |
| c. interface-auditor.ts CHECKS 加第 6 项 alien-files-staged + 实现函数 | PASS | InterfaceAuditCategory enum + VALID_CATEGORIES 都加 'alien-files-staged'；新增 PhaseScope / isFileInScope / auditAlienFilesStaged / globToRegExp 4 个 export |
| d. interfaceAuditor.test.ts 加 5+ 用例覆盖第 6 检查 | PASS | 加 8 个 it() 用例（clean / detect alien / multi-alien truncation / glob ** / glob * / dir prefix / Windows backslash / empty stdout） |
| e. pnpm typecheck + test + build 全过 | PASS | typecheck 0 error；test 1065 passed (40 files)；build 输出 dist/cli.mjs + dist/index.mjs 两入口完整（与 baseline 一致的 failOnWarn warning 由根 package.json `dist/index.mjs` 缺失提示触发，**非本 phase 引入**） |

## Critical issues
无

## Major issues
无

## Pending handoff
[git_commit] — 接下来主线 phase-runner 接手；约束遵守：显式 git add 5 个本 phase 文件，不动 P33 territory

## Notes
- P33 的 staged 文件（`.claude/team-plan/phase-33-historical-validation-report.md` + `src/utils/__tests__/interfaceAuditorHistorical.test.ts`）在 stash/pop 过程中暂时被反序，已通过 `git reset HEAD` 显式排除——这正是本 phase 实现的 alien-files-staged 检查要拦截的同型场景。
- 测试数 baseline 1048（context 中报告）→ 实测 baseline 1057 含 P33 已落地的 9 个 historical 测试；本 phase 加 8 → 1065 实测通过。
- 所有 git add 显式列文件，0 使用 `-A` / `.` / `-u`——亲身示范本 phase 实现的约束。
