# Smoke Test v3.0.0 + Resume 指令

## 1. /clear 后新会话第一步

把以下整段 paste 到新 Claude Code 会话开头：

---

```
我之前在做 CCG v4.0 重塑（dogfood v3.0.0 路径）。请：

1. Read 以下文件恢复上下文：
   - D:/workflow/ccg-workflow/.ccg-research/01-context-architecture.md
   - D:/workflow/ccg-workflow/.ccg-research/02-subagent-matrix.md
   - D:/workflow/ccg-workflow/.ccg-research/03-quality-gates.md
   - D:/workflow/ccg-workflow/.ccg-research/04-ecosystem-scan.md
   - D:/workflow/ccg-workflow/.ccg-research/05-roadmap-v3.1-to-v4.0.md
   - D:/workflow/ccg-workflow/.ccg-research/06-smoke-test-and-resume.md (本文件)
   - D:/workflow/ccg-workflow/CHANGELOG.md (顶部 v3.0.0 条目)
   - D:/workflow/ccg-workflow/CLAUDE.md (顶部"变更记录")

2. 当前状态：
   - v3.0.0 代码已就绪（package.json bumped，168/168 测试过，build 246KB）
   - 没 npm publish
   - 决策走 dogfood 路径：用 v3.0.0 自己驱动 v4.0 开发

3. 下一步：
   - 先做 v3.0.0 端到端 smoke test（按 06 文件第 2 节走）
   - smoke 通过 → npm publish v3.0.0 → /ccg:init 装 v3.0.0
   - 写 .ccg/roadmap.md（按 05 路线图的 v3.1+v3.2+v4.0 phase 拆分）
   - /ccg:autonomous --offload 跑完 v4.0
```

---

paste 完我会读所有文件，把状态完整恢复回来。

## 2. v3.0.0 Smoke Test（~1-2 小时）

### Step 1: 本地 link 安装

```bash
cd D:/workflow/ccg-workflow
npm link
```

验证：
```bash
which ccg-workflow      # Unix
where ccg-workflow      # Windows
# 应指向你的本地仓库
```

### Step 2: 初始化到测试目录

**重要**: 不要在你已有的 `~/.claude/` 上覆盖装。新建测试目录避免污染。

```bash
mkdir -p ~/test-ccg-v3
cd ~/test-ccg-v3
git init
echo "# test" > README.md
```

然后跑 init（应该装 v3.0.0 的 commands + agents + skills + hooks + shim launcher）：
```bash
npx ccg-workflow init --skip-prompt --frontend gemini --backend codex
```

**期望产出**：
- `~/.claude/commands/ccg/` 含 35 个 .md（含 autonomous.md / verify-work.md 等 v3.0.0 新加）
- `~/.claude/agents/ccg/` 含 15 个（含 8 specialist）
- `~/.claude/.ccg/scripts/invoke-model.mjs` ✓
- `~/.claude/bin/codeagent-wrapper`（Unix shell）/ `codeagent-wrapper.cmd`（Windows）✓
- `~/.claude/hooks/ccg-context-monitor.js` ✓
- `~/.claude/hooks/ccg-statusline.js` ✓

### Step 3: 验证 shim 能调通

```bash
~/.claude/bin/codeagent-wrapper --version
# 期望: codeagent-wrapper version 5.10.0

# 极简任务（看模型真的被调起）
echo "用一句话说今天天气" | ~/.claude/bin/codeagent-wrapper --backend codex - "$PWD"
echo "用一句话说今天天气" | ~/.claude/bin/codeagent-wrapper --backend gemini - "$PWD"
```

**红旗**：
- 卡住 30s+ → 可能 stdin 没正确传递，模型没收到 prompt
- "command not found" → shim 没安装好
- "Cannot find module 'invoke-model.mjs'" → installer 路径错（v3.0.0 已修过，但要确认）
- session_id 不输出到 stderr → SESSION_ID 解析逻辑炸

### Step 4: 在 Claude Code 跑 3 个最小命令

打开新 Claude Code 会话（不要在 ccg-workflow 仓库根目录，去 `~/test-ccg-v3`）：

1. `/ccg:enhance "测试 enhance 能跑"` → 看是否产出结构化任务
2. 在 README.md 加一行 git diff，跑 `/ccg:review` → 看双模型并行 + 综合
3. `/ccg:workflow "改 README，把 # test 改成 # test ccg v3.0.0"` → 完整 6 阶段流程

**红旗**：
- 任何一步报错 → 修 v3.0.0
- Context Monitor hook 没在 statusline 显示 token 用量 → hook 注册失败
- wave 调度（如果命令触发了）解析 yaml 错 → wave 字段格式有 bug

### Step 5: 长任务 + 后台 + Hook 验证

只有上面都通过才走这步：

```
/ccg:autonomous --offload
```

需要先在 `~/test-ccg-v3` 写 `.ccg/roadmap.md` 含 2-3 个简单 phase，验证：
- autonomous 能解析 roadmap
- offload 路径调起 codex:rescue
- Context Monitor hook 在剩余 ≤35% 时注入警告

## 3. Smoke 通过后

```bash
cd D:/workflow/ccg-workflow

# unlink 测试 link，准备真发
npm unlink

# 发布
npm publish

# 验证
npm view ccg-workflow version    # 应显 3.0.0
```

然后在 `D:/workflow/ccg-workflow` 自身建 roadmap，按 05 路线图开 v4.0：

```bash
mkdir -p .ccg
cat > .ccg/roadmap.md <<'EOF'
# CCG v4.0 Roadmap

**Project**: ccg-workflow v4.0 重塑
**Started**: 2026-05-04

## Phase 1: 主线 ≤15% frontmatter 约束 (pending)
- **Goal**: 4 个核心命令（workflow/execute/team-exec/autonomous）frontmatter 加 Context budget 声明
- **Depends on**: (none)

## Phase 2: CONTEXT.md/SUMMARY.md phase 状态机 (pending)
- **Goal**: 引入 .context/<phase>/CONTEXT.md + SUMMARY.md，替代主线 context
- **Depends on**: Phase 1

## Phase 3: codebase-mapper 移植 (pending)
- **Goal**: 从 GSD 移植 codebase-mapper agent 到 templates/commands/agents/
- **Depends on**: (none)

## Phase 4: Scope Reduction Detection (pending)
- **Goal**: team-reviewer.md / spec-plan.md 加扫描规则（v1/简化/placeholder/暂时硬编码）
- **Depends on**: (none)

## Phase 5: 命令收敛第一波 [offload] (pending)
- **Goal**: 删 frontend/backend/feat/forensics/extract-learnings，合并 verify-*；改 installer-data + 模板
- **Depends on**: Phase 1

## Phase 6: plan-checker 5 维度 [offload] (pending)
- **Goal**: 升级 templates/commands/agents/plan-checker.md 实现 5 维度（1/2/5/7b/10）+ max-3-loop
- **Depends on**: Phase 4

## Phase 7: 异步三件套 status/result/cancel (pending)
- **Goal**: 新增 3 个命令，job-id 化背景任务管理
- **Depends on**: (none)

## Phase 8: verifier Level 4 升级 (pending)
- **Goal**: 加数据流追踪 + override + deferred 过滤
- **Depends on**: (none)

## Phase 9: 会话式 UAT + cold-start smoke [offload] (pending)
- **Goal**: 改造 verify-work.md 为会话流，UAT.md + cold-start smoke 注入 + 自动收敛
- **Depends on**: Phase 6, 8

## Phase 10: code-review --fix + worktree [offload] (pending)
- **Goal**: review.md 加 --fix 模式 + 新建 code-fixer agent + worktree 隔离 + transactional cleanup
- **Depends on**: (none)

## Phase 11: debug-session-manager 重写 [offload] (pending)
- **Goal**: 重写 /ccg:debug 为 manager + debugger 双层 fresh-context 模式
- **Depends on**: (none)

## Phase 12: 文档收尾 + impeccable 砍掉 + domain skills 转 hidden (pending)
- **Goal**: CHANGELOG / README / CLAUDE.md / migration guide；引流官方 frontend-design plugin
- **Depends on**: Phase 1-11
EOF
```

跑 `/ccg:autonomous --offload`，理论上能自己跑完 v4.0。

## 4. 应急回滚

如果 dogfood 卡住超过 1 天（任何 phase）：

```bash
# 回到手动驱动模式
cd D:/workflow/ccg-workflow
git status     # （注意：当前不是 git repo，所以这步会失败——你需要自己处理 git 初始化）

# 在新 Claude Code 会话直接跟 AI 说："按 .ccg/roadmap.md Phase N 实施，不要走 /ccg:autonomous，直接帮我做"
```

---

**最后更新**: 2026-05-03
