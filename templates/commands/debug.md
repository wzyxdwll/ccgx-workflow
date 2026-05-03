---
description: '多模型调试（v4.0 manager + debugger 双层 fresh-context）：科学方法 hypothesis 链 + 持久 session + cap 3 升级'
argument-hint: "<问题描述> [--mode=find_root_cause_only|find_and_fix] [--role=architect|critic|implementer|tester|writer]"
---

# Debug - 多模型调试（v4.0 重写）

## Role-based routing（v4.1 specialist matrix）

可选 `--role=<name>` 叠加 role 维度路由（debug-session-manager 内 spawn 的 debugger 用 role 选 prompt）：

| Role × Layer  | architect      | critic              | implementer | tester        | writer          |
| ------------- | -------------- | ------------------- | ----------- | ------------- | --------------- |
| **backend**   | codex/architect.md | codex/reviewer.md (adversarial) | codex/debugger.md | codex/tester.md | claude  |
| **frontend**  | gemini/architect.md | gemini/reviewer.md (adversarial) | gemini/debugger.md | gemini/tester.md | gemini/analyzer.md |
| **fullstack** | codex+gemini/architect.md | both reviewer.md (adversarial) | runner 决 | runner 决 | claude |

**未传 --role 时按 v4.0 manager + debugger 双层流程**（debugger.md 默认 implementer 角色）——完全兼容。`--role=critic` 触发"反向假设"调试（强制构造反证），适合定位概率性 bug。详见 `src/utils/specialist-router.ts`。

---

**v4.0 重大变更**：从单次双模型并行调用 → **manager + debugger 双层 fresh-context** 模式。

主线（你）只 spawn `debug-session-manager` 一次，manager 在隔离 context 内跑完整 hypothesis 多轮循环，最终返回 ≤ 200 token 的紧凑摘要。**主线 context 不再被多轮调试 transcript 污染**——这是 GSD ROI #3 (`02-subagent-matrix.md` Section 2.6) 的核心模式。

## 使用方法

```bash
/ccg:debug <问题描述>                          # 默认 find_and_fix 模式
/ccg:debug <问题描述> --mode=find_root_cause_only  # 仅找根因，不修
/ccg:debug <问题描述> --mode=find_and_fix         # 找根因 + 应用修复 + 跑验证
```

---

## 你的角色

你是**调试启动器**，**不**直接做调试。你的工作就 3 步：

1. 解析参数 → 提取 `symptoms` + `mode` + 生成 `slug`
2. **Spawn 一次** `debug-session-manager`（fresh context）
3. 接收 manager 返回的紧凑摘要，向用户呈现

主线**不读** manager 的中间 transcript——所有 hypothesis 链 / evidence / fix 应用都在 manager 隔离 context 完成。session 文件 `.context/debug/<slug>.md` 用户可事后审计。

---

## 执行工作流

### 阶段 0：参数解析

**问题描述**：$ARGUMENTS

1. 从 $ARGUMENTS 提取核心症状（错误信息 / 复现步骤 / 期望行为）
2. 解析 `--mode` 参数：
   - `find_root_cause_only` — 仅找根因，找到立即返回
   - `find_and_fix`（**默认**）— 找根因 + 应用修复 + 跑测试验证
3. 生成 `slug`：从症状提取 3-5 个 kebab-case 关键词（如 `login-csrf-cookie` / `react-strict-double-init`）
4. 用 Bash `pwd`（Unix）或 `cd`（Windows CMD）拿到工作目录绝对路径，**禁止**从 `$HOME` 推断

### 阶段 1：（可选）Prompt 增强

如症状描述模糊（如"登录有 bug"），按 `/ccg:enhance` 逻辑补全为结构化输入：
- 错误信息全文
- 复现步骤
- 期望行为 vs 实际行为
- 已尝试的修复

如已结构化则跳过。

### 阶段 2：Spawn debug-session-manager

**关键**：**只 spawn 一次**。manager 内部多轮循环 + 调度 debugger，主线不参与。

```
Agent({
  subagent_type: "debug-session-manager",
  prompt: <见下方 prompt 模板>
})
```

**Prompt 模板**：

```
你是 debug-session-manager。完整执行多轮 hypothesis 循环，最终返回 ≤ 200 token 紧凑摘要。

## 输入

slug: <生成的 slug>
mode: <find_root_cause_only | find_and_fix>
workdir: <pwd 输出>
symptoms: |
  <增强后的症状描述全文>

## 工作要求

1. 在 .context/debug/<slug>.md 维护持久 hypothesis 链
2. 每个 hypothesis 必须 falsifiable（有可观察的 fail 条件，不接受"代码可能有 bug"空话）
3. spawn debugger subagent 提出 / 验证 hypothesis
4. cap 3 hypothesis refuted → CHECKPOINT_REACHED 升级
5. find_root_cause_only 模式：找到 confirmed hypothesis 立即返回 ROOT_CAUSE_FOUND
6. find_and_fix 模式：找到 root cause → 应用 fix → 跑测试验证 → DEBUG_COMPLETE
7. 不修改 .ccg/roadmap.md / .ccg-research/

## 摘要格式（严格三选一）

ROOT_CAUSE_FOUND:
  STATUS: ROOT_CAUSE_FOUND
  SLUG: <slug>
  ROOT_CAUSE: <一句话>
  SUGGESTED_FIX: <一段建议>

DEBUG_COMPLETE:
  STATUS: DEBUG_COMPLETE
  SLUG: <slug>
  ROOT_CAUSE: <一句话>
  FIX_APPLIED: <修了哪个文件做了什么>
  VERIFICATION: <跑了什么测试，结果如何>

CHECKPOINT_REACHED:
  STATUS: CHECKPOINT_REACHED
  SLUG: <slug>
  HYPOTHESES_TRIED: <数字>
  REASON: <为什么放弃 + 建议用户怎么介入>
```

### 阶段 3：解析摘要 + 向用户呈现

manager 返回后，解析 `STATUS:` 第一行决定显示模板：

#### STATUS=ROOT_CAUSE_FOUND

```markdown
## 🎯 找到根因（未修）

**SLUG**: <slug>
**根因**: <root_cause>
**建议修复**:
<suggested_fix>

📁 完整调试记录: `.context/debug/<slug>.md`

---

是否要应用修复？
1. 应用修复（再跑 `/ccg:debug "<原症状>" --mode=find_and_fix`）
2. 仅记录，手动修复
3. 继续调查（提供新线索）
```

用 `AskUserQuestion` 询问。

#### STATUS=DEBUG_COMPLETE

```markdown
## ✅ 调试完成

**SLUG**: <slug>
**根因**: <root_cause>
**已应用修复**: <fix_applied>
**验证**: <verification>

📁 完整调试记录: `.context/debug/<slug>.md`

建议跑回归测试确认无副作用。
```

#### STATUS=CHECKPOINT_REACHED

```markdown
## ⚠️ 调试达到检查点（cap 3 hypothesis 失败）

**SLUG**: <slug>
**已尝试 hypothesis 数**: <hypotheses_tried>
**原因**: <reason>

📁 完整调试记录（含已 refuted 假设链）: `.context/debug/<slug>.md`

---

manager 的 3 轮 hypothesis 都被证伪。这通常意味着：
- 假设方向不对（试试切换 mode 或换角度描述症状）
- 缺关键证据（提供更多日志 / 复现步骤）
- bug 在 manager 看不到的地方（环境 / 第三方依赖）

下一步选项：
1. 继续手动调试（参考 session.md 已 refuted 链，避免重复）
2. 切换 mode（find_root_cause_only ↔ find_and_fix）
3. 提供新症状信息后重启 `/ccg:debug`
4. 终止
```

用 `AskUserQuestion` 询问。

---

## 关键规则

1. **只 spawn manager 一次**：禁止主线自己跑多轮 hypothesis 循环（违反 fresh-context 隔离的 GSD ROI #3 设计）
2. **不读 manager transcript**：主线只读返回的 ≤ 200 token 摘要 + （用户需要时）`.context/debug/<slug>.md` 文件
3. **mode 默认 find_and_fix**：与 v3.0 行为一致（用户期待修好），仅在 `--mode=find_root_cause_only` 时仅找根因
4. **cap 3 = 升级**：CCG 全体系硬规约，manager 不会偷偷继续；主线尊重 CHECKPOINT_REACHED 不重 spawn
5. **session 文件持久**：中断恢复 / 用户审计的唯一通道
6. **科学方法守门**：每个 hypothesis 必须 falsifiable（manager 会拒收 debugger 给的空话）

---

## 与 v3.0 的差异

| 维度 | v3.0（已废） | v4.0（当前） |
|------|-------------|-------------|
| 调用模式 | 双模型并行单次诊断 | manager + debugger 双层 fresh-context |
| 多轮 | ❌ 没有（一次性） | ✅ hypothesis 链，cap 3 |
| 持久 session | ❌ 没有 | ✅ `.context/debug/<slug>.md` |
| 科学方法 | ❌ 接受空泛假设 | ✅ falsifiable_test 强制 |
| 主线 context 占用 | 高（吃两条诊断 stdout） | 极低（≤ 200 token 摘要） |
| 修复模式 | 用户手动 | mode=find_and_fix 自动应用 + 验证 |
| 中断恢复 | ❌ 无 | ✅ session 文件持久 |

---

## 工程参考

- 子 agent 协议：`templates/commands/agents/debug-session-manager.md` + `templates/commands/agents/debugger.md`
- helper schema / 决策树：`src/utils/debug-session.ts`
- 移植来源：GSD `gsd-debug-session-manager` + `gsd-debugger`（`.ccg-research/02-subagent-matrix.md` Section 2.6）
