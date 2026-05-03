# Plugin 摘要格式假设审计（v4.2 P21 → v4.2 P22/P23 实测前置）

**Last Updated**: 2026-05-04
**Phase**: v4.2-p21
**Status**: 文档化研究（不实测，引擎层禁 subagent 嵌套 spawn plugin）

---

## 背景

CCG v4.1 引入 4 个 helper 模块解析"plugin 返回的 ≤200 token 结构化摘要"：

| 文件 | 解析对象 | 解析函数 |
|------|---------|---------|
| `src/utils/phase-runner.ts` | phase-runner subagent 摘要 | `parsePhaseRunnerSummary` |
| `src/utils/challenger-orchestrator.ts` | challenger（plugin advisor / specialist critic）摘要 | `parseChallengerSummary` + `parseFindings` |
| `src/utils/debate-orchestrator.ts` | debate 单轮摘要 | `parseRoundSummary` + `shouldStop` |

**问题**：v4.1 12 phase dogfood 全程**未真正 spawn plugin**（引擎层硬限制：subagent 内不能嵌套 `Agent`/`Task` —— 见 commit `a7cdffd`）。所有 parser 的"目标格式"都是 v4.1 编排器作者**根据约定**写的，而非从真实 plugin 输出反推。

**风险**：v4.2 P22 三段式编排（plan-aggregator / verify-orchestrator / quality-router）若直接复用这些 parser，撞上 plugin 真实格式不匹配会全链路失败。本文档把所有"未验证假设"明示出来，给 P22/P23 真正调用 plugin 时的实测做对照。

---

## 假设清单

### 1. phase-runner.ts — `parsePhaseRunnerSummary`（acceptance契约自定义）

**置信级别**：✅ **已验证**
**验证依据**：v4.0 dogfood 12 phase 全程 spawn `phase-runner` 自定义 subagent，`parsePhaseRunnerSummary` 在 12 个 phase 报告里覆盖率 100%（commit log 12 个 `feat(v4-pX)` / `feat(v4.1-pX)` 提交）。

| 字段 | 假设 | 实测 |
|------|------|------|
| `STATUS:` | 出现一次，值为 `completed/partial/failed/degraded` | ✅ 12 phase 一致 |
| `COMMIT:` | sha7 或 `none` | ✅ |
| `TESTS: <n>/<m> passed (delta +<d>)` | 数字 + slash + 数字 | ✅ |
| `TYPECHECK:` | `pass`/`fail` | ✅ |
| `HANDOFF_TAKEN: [a, b]` | 中括号包列表 | ✅ |
| `CONTEXT_DELTA:` / `NOTES:` | 短文本 | ✅ |

**结论**：parser 风险低，P22/P23 可直接复用。这是 CCG 自有格式，不依赖外部 plugin。

---

### 2. challenger-orchestrator.ts — `parseChallengerSummary`

**置信级别**：⚠️ **未验证（v4.1 dogfood 路径未触发）**
**验证依据**：v4.1 P16 实施 + 21 个单测全 PASS，但 dogfood 12 phase 没有任一 phase 标 `Critical: true` —— 即 `planChallengerSpawns` **从未在生产链路被调用**。所有断言基于编排者写法。

#### 2a. STATUS / NOTES 字段
| 字段 | 假设 | 真实 plugin 行为 |
|------|------|-----------------|
| `STATUS:` 出现一次 | `complete`/`completed`/`error`/`failed` | ❓ 未实测 |
| `NOTES:` 单行 | 短摘要 | ❓ 未实测 |

**风险**：plugin 可能返回多行 JSON（无 `STATUS:` 行内字段），或用 `status:` 小写嵌入 JSON。当前 parser 在 STATUS 缺失时**抛错**——P22 调用前需加 fallback。

**v4.2 P21 已加防御**：`parseFindings` 鲁棒化覆盖了 JSON 块、单/双引号、嵌套 `{}`、```json``` 围栏。FINDINGS 字段值的 5 类格式可解析；STATUS/NOTES 仍假设行级。

#### 2b. FINDINGS schema
| 假设 | 真实 plugin 行为 |
|------|-----------------|
| `[{severity, category, message}]` 数组 | ❓ |
| severity 枚举 `critical/major/info` | ❓ codex/gemini plugin 可能用 `error/warning/suggestion` |
| category 自由文本 | ❓ |

**风险**：severity 枚举不匹配 → 100% 找不到 critical → `decideFromSummaries` 永远返回 `advance`，跳过修订轮。

**P22 实测要求**（写在此处供 P23 实施）：
- 真 spawn 一次 `codex:codex-rescue` adversarial subagent
- dump 完整 stdout
- 对照 schema：检查 severity 字段命名 + 枚举值
- 若不匹配，加 `severity-translator`（`error→critical / warning→major / suggestion→info`）

---

### 3. debate-orchestrator.ts — `parseRoundSummary`

**置信级别**：⚠️ **未验证 + 关键词来源不明**
**验证依据**：v4.1 P17 实施 + 25 个单测全 PASS，`/ccg:debate` 命令在 dogfood 中未实战。

#### 3a. 字段抽取关键词列表
```typescript
extractField(text, ['propose', 'proposal', '提议', '提案'])
extractField(text, ['challenge', 'critique', 'critic', '挑战', '反对'])
extractField(text, ['respond', 'response', 'reply', '回应', '答辩'])
extractField(text, ['notes', 'note', '备注', '说明'])
```

| 假设 | 真实 plugin 行为 |
|------|-----------------|
| codex/gemini 会用 `PROPOSE:` / `CHALLENGE:` / `RESPOND:` 行级标签 | ❓ 高度可疑 — plugin 默认更可能输出散文格式 |
| 中文关键词命中（`提议:` `挑战:`） | ❓ 完全是约定 |

**风险**：plugin 输出散文（"I propose using Redis because..."），整个 `parseRoundSummary` 返回 `parsed: false` → debate 退化为长度变化判定（信号 #3），无内容收敛。

**P22 实测要求**：
- spawn `codex:codex-rescue` 一次 + 给"对辩 propose 模板"的 system prompt
- 检查输出**是否真的有** `PROPOSE:` 行
- 若无，必须为 plugin 加**强约束 prompt 模板**（"必须以 `PROPOSE:` 行开头给出建议"），写到 `~/.claude/.ccg/prompts/debate/{codex,gemini}/template.md`

#### 3b. shouldStop "no critical" 关键词
```typescript
const NO_CRITICAL_PATTERNS = [
  'no critical issue',
  'agreement reached',
  'lgtm',
  '无 critical',
  '达成共识',
]
```

**风险**：plugin 可能用其他表达（"No major concerns"、"Looks good to ship"、"approved"）。
**P22 实测要求**：收集真实 plugin 5+ 次完整输出，扩充关键词清单。

---

### 4. specialist-router.ts — prompt 文件路径假设（v4.2 P21 已部分修正）

**置信级别**：🟡 **部分修正**
**v4.2 P21 修正**（commit `phase-21`）：
- 删除 `implementer → architect.md` 假设（路由返回 `null`，主线接管）
- 删除 `writer × frontend → analyzer.md` 假设（同上）

**保留假设**（仍未验证）：
- `architect → architect.md` ✅ prompt 文件存在，但**未实测 plugin 是否真按该 prompt 工作**
- `critic → reviewer.md`（adversarial framing 是 specialist-router 注释里写的，plugin 实际看到的 system prompt 由 `~/.claude/plugins/codex/.../*.md` 决定，CCG 控不了）
- `tester → tester.md` 同上

**P22/P23 实测要求**：
- 验证 plugin 是否真的 read 用户级 `~/.claude/.ccg/prompts/<model>/<role>.md`
- 若否，CCG prompt 文件只是"参考资料"——plugin 只看自家 SKILL.md system prompt
- 必要时把 CCG prompt 内容**通过 spawn 参数 inline 注入**而不是依赖 plugin 自行读

---

### 5. plugin-detection.ts — 安装位置假设

**置信级别**：✅ **代码层验证**（fs probe 行为可控）+ ⚠️ **plugin 命名不确定**
**已知**：
- 路径 `~/.claude/plugins/<dir>/<marker>` ✅
- marker 文件清单 `[SKILL.md, plugin.json, package.json, manifest.json]` ✅（permissive）
- 目录前缀清单 `codex@`/`codex-rescue@`/`openai-codex@` ⚠️

**风险**：v4.1 P20 当时 codex/gemini plugin 还未发布，命名是猜的。可能真实 plugin 用：
- `codex-cli@anthropic`
- `@anthropic/codex-rescue`
- 完全不同的命名空间

**P22 实测要求**：检查真实 marketplace plugin 命名，更新 `PLUGIN_PREFIXES`。

---

## v4.2 P22 / P23 实测协议（建议）

### P22 准备
- 不直接调用 plugin（仍受引擎限制）
- 创建一次性 sandbox 命令 `/ccg:plugin-format-probe <plugin-name>`：
  - 主线（非 subagent 内）spawn plugin
  - 用规范化 prompt（"返回严格按 v4.2 schema 的摘要"）
  - dump 输出原文 + parse 结果到 `.context/plugin-probes/<timestamp>.md`
  - 用户运行 `/ccg:plugin-format-probe codex:codex-rescue` 后人工 review

### P23 实施
- 基于 P22 的 probe 结果，修正 4 个 parser
- 若 plugin 输出与假设差异大 → 引入 `prompt-template` 系统强制约束输出格式
- 否则 → 仅扩充关键词 / severity 枚举映射

---

## 状态汇总

| 模块 | 摘要格式 | 置信 | v4.2 P21 状态 | P22/P23 行动 |
|------|---------|------|--------------|-------------|
| phase-runner | CCG 自定义 STATUS/COMMIT/TESTS/... | ✅ 已验证 | 无变化 | 跳过实测 |
| challenger | STATUS + FINDINGS JSON + NOTES | ⚠️ 未验证 | parseFindings 鲁棒化✅ | severity 枚举实测 |
| debate | PROPOSE/CHALLENGE/RESPOND 行级 | ⚠️ 未验证 | 无变化 | prompt 模板强约束 |
| specialist-router | prompt 文件 borrow | 🟡 部分修正 | 删 implementer/writer 假设✅ | 验证 plugin read 行为 |
| plugin-detection | 目录前缀 | ⚠️ 未验证 | 无变化 | 实测 plugin 命名 |

---

## 关键不变量

无论 P22/P23 实测结果如何，以下 v4.2 P21 已建立的 SSoT 不可回退：

1. **`PluginAvailability` 全局唯一**（`src/utils/multi-model-routing.ts`）
2. **`Layer` 5 项 union 全局唯一**（同上）
3. **`parseFindings` 字符级 balanced tokenizer 替代 `[^}]*` 正则**（嵌套 `{}` 在 message 必须正确切分）
4. **`specialist-router` 删假设性路由**（implementer/writer × frontend 不再借用 architect/analyzer.md）

P22/P23 在此基底上做格式适配，不重新引入接口债。
