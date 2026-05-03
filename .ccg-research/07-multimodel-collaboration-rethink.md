# 多模型协作"生硬"问题重审 + v4.1 motivation

> 文件目的：把 dogfood Phase 1 期间用户提出的"多模型协作没有完全发挥优势，搭配生硬"洞察做事实归档，对照 CCG v3.0.0 现状给出根因诊断，并起草 v4.1 改进方向。
>
> 范围：仅审视 **CCG 自己**怎么用多模型——不写代码、不给 patch、不改任何模板。
>
> 数据基线：`D:/workflow/ccg-workflow/templates/commands/*.md`、`templates/prompts/{codex,gemini,claude}/*.md`，以及 `.ccg-research/04-ecosystem-scan.md`、`05-roadmap-v3.1-to-v4.0.md`。

---

## 0. 用户原话

> "感觉现在多模型协作没有完全发挥优势，感觉搭配的很生硬"

这话戳中 4 个具体毛病（下面逐一拆开），是 v4.1 主轴 motivation。

---

## 1. 现状审计：CCG v3.0.0 多模型协作的 4 个真实模式

### 1.1 Pattern 1：双模型并行独立分析 + concat 综合

**最常见，6 个核心命令都用这个**：

| 命令 | 文件 | 双模型并行调用位置 |
|------|------|-------------------|
| `/ccg:plan` | `templates/commands/plan.md:114` | line 118-124 |
| `/ccg:analyze` | `templates/commands/analyze.md:96` | line 96-101 |
| `/ccg:debug` | `templates/commands/debug.md:33` | line 33-48 |
| `/ccg:optimize` | `templates/commands/optimize.md` | 类似 pattern |
| `/ccg:test` | `templates/commands/test.md` | 类似 pattern |
| `/ccg:review` | `templates/commands/review.md:53` | line 31 起 |

实际流程统一为：

```
主线读上下文
  ↓
并行 spawn:
  ├─ codeagent-wrapper --backend {{BACKEND_PRIMARY}} (with codex/analyzer.md)
  └─ codeagent-wrapper --backend {{FRONTEND_PRIMARY}} (with gemini/analyzer.md)
  ↓
两个模型各自跑完，各产出一份独立报告
  ↓
主线读两份报告，concat + 加 header"综合"
  ↓
输出
```

**关键观察**：两个模型从不知道对方在写什么。它们独立分析同一个问题，主线把两份独立产物拼在一起。

### 1.2 Pattern 2：模型路由按"前端/后端"二分

`templates/commands/plan.md:50-51` 直接列：
```
| 分析 | ~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/analyzer.md | ~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/analyzer.md |
```

`templates/commands/analyze.md:19-20` 直接定义：
```
- {{BACKEND_PRIMARY}} – 后端/系统视角（后端权威）
- {{FRONTEND_PRIMARY}} – 前端/用户视角（前端权威）
```

`templates/commands/debug.md:18-19`、`review.md:53-54` 同样。

这些行**默认了一个二分**：每个任务必有"后端视角"和"前端视角"，对应到 codex 和 gemini。

### 1.3 Pattern 3："角色"prompt 已存在但没用上协作维度

`templates/prompts/` 现有 19 个专家 prompt：

| 模型 | 角色 |
|------|------|
| codex/ (6) | analyzer / architect / debugger / optimizer / reviewer / tester |
| gemini/ (7) | analyzer / architect / debugger / frontend / optimizer / reviewer / tester |
| claude/ (6) | analyzer / architect / debugger / optimizer / reviewer / tester |

**6 个角色 × 3 个模型 = 18 种角色实例**。但模板里**没有按角色路由**——`/ccg:plan` 只用 analyzer + architect，`/ccg:debug` 只用 debugger，`/ccg:review` 只用 reviewer。**6 个角色定义了，模板里同时只用 1-2 个**。

而且每个命令里"角色"和"前后端"是**1:1 绑死**的——`/ccg:plan` 永远是 `codex/analyzer + gemini/analyzer`，从不是 `codex/architect + claude/critic`。

### 1.4 Pattern 4：`--adversarial` 是单模型，不是真对辩

`templates/commands/review.md:10`：

> `--adversarial` 模式下额外触发第三层"敌对视角"审查，由官方 codex plugin 的 `Agent(codex:rescue)` 在 fresh context 中专门挑前两轮意见的漏洞

这只是**第三个 codex 实例**做事后挑刺——**不跨模型对辩**。Codex 自己挑自己（前两轮也是 codex+gemini 独立产出，第三轮 codex 看前两份报告挑刺）。

**真对辩**应该是：模型 A 提论点 → 模型 B 反驳 → 模型 A 修订 → 收敛或主线裁决。CCG 没有任何命令实现这个。

---

## 2. 四个具体毛病（first-principles 诊断）

### 毛病 1：模型分工是"文件类型"维度切，不是"能力"维度切

**前后端**只是 1 个分类轴。其他真正有差异的能力轴：

| 能力轴 | 真擅长 | CCG 当前路由 |
|--------|--------|-------------|
| 复杂逻辑 / 算法 / 系统设计 | GPT-5 (codex) reasoning xhigh | 一律分给 codex（巧合对了）|
| 视觉 / UI / 创意 / 文案 | Gemini | 分给 gemini（巧合对了）|
| 长上下文综合 / 编排 | Claude Opus（1M context）| 当主线，但 Claude 自己也能做实施工作 |
| 挑刺 / 反例 / 边界条件 | 任一 + adversarial prompt | 没单独抽成路由维度 |
| 测试设计 | 任一 + tester role | tester.md 存在但只在 `/ccg:test` 用一次 |

**CCG 当前模式 = 一刀切。前后端命中率高的任务（如 React 组件）感觉合理，但实际不少任务**模型选择不是按文件类型决定**：

- "重构数据库 schema 同时改前端表单" → 现在 codex+gemini 各跑一份，但其实应该 codex 主导（schema 是核心）+ gemini 仅校 UI 反馈
- "评估某第三方库要不要引入" → 应该 advisor 角色对辩，不是前后端视角
- "写架构 ADR" → 应该 architect 角色 + critic 角色 debate，不是前后端

### 毛病 2：双模型只独立分析后 concat，不是协作

GSD 借鉴文档（`.ccg-research/03-quality-gates.md` Section 4）已经指出 GSD 的 `gsd-code-reviewer` 是"对抗式 review—假设有 bug 直到证伪"。CCG 的 `/ccg:review` 只是 codex 和 gemini **同看一个 diff，各写各的 finding 列表**。

具体后果：
- Codex 看不到 Gemini 提到了什么，无法"补充 / 驳斥 / 修订"
- 主线"综合"实际上是 concat + 去重 + 重排，没真融合
- **两个模型的盲点不会被对方覆盖**——共同遗漏的问题永远不会被发现

### 毛病 3：没有真对辩（adversarial debate）

参考 `.ccg-research/04-ecosystem-scan.md` 7.7 节："BMAD Party Mode 多 persona 在单次会话中协作辩论"。CCG 没对应。

GSD 的 `gsd-plan-checker` Dimension 7b（Scope Reduction Detection）也是单模型自审。**真对辩**——A 论证 → B 反驳 → A 修订 → 收敛——CCG 0 个命令实现。

### 毛病 4：模板写死，不按任务复杂度分级

Anthropic 官方 Building Effective Agents：
> "Start with simple prompts ... add multi-step agentic systems only when simpler solutions fall short."

CCG 当前所有命令默认走双模型并行，**不论任务复杂度**。改 1 个 typo 的小 bug 也跑双模型分析。这违反 Anthropic 第一原则。

应该：

| 任务复杂度 | 协作模式 |
|-----------|---------|
| 1（typo / 单文件 1 行）| 单模型，一句话 |
| 2（单 phase / 多文件）| 双模型独立分析（现状）|
| 3（跨模块 / scope 不清）| 双模型 debate + specialist critic |

CCG 现在 1 / 2 / 3 全用第 2 档。

---

## 3. 改进方向（4 个 pattern，按 ROI）

### 改进 A：specialist matrix 路由（多维路由）

**核心**：从 1 维路由（前/后端）升级到 2 维（角色 × 模型）。

设计：

```
/ccg:plan --role=architect [--frontend|--backend|--fullstack]
/ccg:review --role=critic
/ccg:analyze --role=analyzer
```

| Role × Layer | architect | critic | implementer | tester | writer |
|--------------|-----------|--------|-------------|--------|--------|
| backend | codex+xhigh | codex+adversarial-prompt | codex | codex+tester | claude |
| frontend | gemini | gemini+adversarial | gemini | gemini+tester | gemini |
| fullstack | codex+gemini debate | codex+gemini debate | runner 选 | runner 选 | claude |

实施成本：低。`templates/prompts/` 已经有 6 角色 prompt 库（19 个文件就位），只需把命令模板的路由从 `<{{BACKEND_PRIMARY}}|{{FRONTEND_PRIMARY}}>` 升级到 `<role>/<layer>`。

### 改进 B：原生 debate 原语

**核心**：让两个模型直接对话，不是各自写报告。

新命令草案：

```
/ccg:debate <topic>
/ccg:plan --debate
/ccg:review --debate

执行流程：
  1. 模型 A 提案（含主张 + 论据）
  2. 模型 B 用 challenger prompt 挑战（找反例 / 质疑假设 / 驳斥论据）
  3. 模型 A 收到 B 的挑战后修订
  4. cap 3 轮（或 cap 直到 B 找不到挑战）
  5. 输出：最终方案 + 分歧点列表（如果 cap 用尽未收敛）
```

实施成本：中。要写 prompt 模板让模型互相喂上一轮输出 + 主线管轮次状态。但 GSD 的 `plan-review-convergence` workflow（已扒过，见 03-quality-gates.md Section 4）就是这个，可参考。

### 改进 C：dedicated challenger（专职挑刺）

**核心**：v3.0 specialist 矩阵的 `assumptions-analyzer` / `nyquist-auditor` / `eval-auditor` 当前**只在 `team-architect` 启动时一次性并行调用**，事后 phase 实施期不参与。

让它们参与每个 phase 的内部循环：

```
phase-runner 内部 lifecycle:
  spawn implementer (codex 或 gemini)
    ↓ 实施完成
  spawn challenger (assumptions-analyzer / nyquist-auditor 任一)
    ↓ 找到 critical 问题？
  让 implementer 修订
    ↓ 收敛
  返回主线
```

实施成本：低（只需 phase-runner prompt 模板加几行）。这是 G 方案的自然扩展。

### 改进 D：分级触发

**核心**：autonomous 主线（或命令模板）按任务大小决定协作模式。

简单启发式（可以扣自动判定）：

```
主线读用户意图 + git diff 范围
  ↓ 估算复杂度
  ├─ Tier 1 (≤10 行 / 单文件 / 明确)：单模型跑，输出一句话
  ├─ Tier 2 (≤100 行 / 多文件 / 单 phase)：双模型并行（现状）
  └─ Tier 3 (跨模块 / scope 不清 / 破坏性变更)：debate + critic
```

实施成本：中。要主线判定 + 路由到不同 pattern。

---

## 4. 短期融入点（v4.0 内不打断 dogfood）

v4.0 已经定 12 phase 跑完，多模型协作大改不应在 v4.0 内重构（会拆乱节奏）。但有 2 个轻量融入：

### 融入点 1：Phase 1.5 phase-runner 协议预留 `--challenger` 钩子

phase-runner 子 agent prompt 模板里加一段：

```
（可选）实施完成后 spawn 一次 specialist critic：
  - backend phase → assumptions-analyzer
  - frontend phase → nyquist-auditor
  - fullstack → 都跑
challenger 找到 critical → implementer 修订一次
```

只是 prompt 模板加 5-10 行，0 新代码。当 v4.1 改进 C 启用时，这个钩子已经在了。

### 融入点 2：Phase 12 经验归档明确记录这些观察

v4.0 Phase 12 "文档收尾"里加一节"v4.1 改进项**", 把本文档作为正式输入：

```
v4.1 motivation:
  1. 多模型协作生硬（07-multimodel-collaboration-rethink.md）
  2. specialist matrix 路由
  3. 原生 debate 原语
  4. 分级触发
```

---

## 5. v4.1 路线草案（不进 v4.0）

```
v4.1 = "多模型协作大改"
预估工时：2-3 周

Phase A: specialist matrix 路由（改进 A）
  - 重设计命令模板的 role × layer 二维路由
  - 改 6 个核心命令（plan/analyze/debug/review/optimize/test）
  - 工时：3-5 天

Phase B: /ccg:debate 原语（改进 B）
  - 新命令 + 多轮 debate prompt 模板
  - 工时：3 天

Phase C: phase-runner 内置 challenger（改进 C）
  - phase-runner 协议扩展（v4.0 Phase 1.5 已留钩子）
  - 工时：1 天

Phase D: 分级触发（改进 D）
  - 主线判定 + 路由
  - 工时：2 天

Phase E: 文档 + 命令面板重组
  - README 更新
  - 命令分组重写
  - migration guide
  - 工时：3 天
```

---

## 6. ROI 排序

按"用户痛点 / 实施成本"综合：

| # | 改进 | 价值 | 成本 | ROI |
|---|------|------|------|-----|
| 1 | specialist matrix 路由（A）| ★★★ 直接修复"前后端二分"瓶颈 | 中 | 最高 |
| 2 | dedicated challenger（C）| ★★★ 把 v3.0 已有 specialist 真正用上 | 低 | 最高 |
| 3 | 原生 debate（B）| ★★ 跨模型真协作 | 中 | 高 |
| 4 | 分级触发（D）| ★★ 降低小任务的 token 浪费 | 中 | 中 |

如果 v4.1 时间紧，最小可行集 = **A + C**（5-6 天完成"角色路由 + 内置 critic"）。

---

## 7. 设计决策点（开放问题，留给 v4.1 立项时拍）

### 7.1 specialist matrix 与现有路由的兼容性

新加 `--role=critic` flag 但保留 `{{BACKEND_PRIMARY}}/{{FRONTEND_PRIMARY}}` 兼容？还是完全替代？

- 兼容：用户可以选择老式调用，但模板复杂度上升
- 替代：清爽但破坏 BC，需 deprecation 周期

倾向：**v4.1 同时支持**，v4.2/v5.0 真正废弃前后端二分。

### 7.2 debate 收敛判定标准

- "B 找不到挑战" 怎么自动判？让 B 自报"无 issue"还是看输出长度？
- 双方分歧无法收敛时怎么呈现给用户？分歧点列表 + 主线裁决？

### 7.3 fullstack debate vs 单 specialist 的选择

`fullstack` 类型 phase（如改 schema + 前端联动）应该让 codex + gemini 各跑一份还是 debate？

- 各跑一份 = Pattern 1（现状），快
- debate = 慢但更准

倾向：默认快（独立），加 `--debate` flag 升级到对辩。

### 7.4 challenger 是哪个 specialist？

CCG v3.0 有 `assumptions-analyzer` / `nyquist-auditor` / `pattern-mapper` / `plan-checker` / `verifier` / `integration-checker` / `framework-selector` / `eval-auditor` 8 个 specialist。

每个 phase 该选哪个？是固定（按 phase Type 选）还是动态（runner 自决）？

倾向：**初期固定按 phase Type 映射**（backend → assumptions-analyzer，frontend → nyquist-auditor），v4.2 后让 runner 动态选。

---

## 8. 与现有研究文档的关系

| 文档 | 关系 |
|------|------|
| `.ccg-research/04-ecosystem-scan.md` | 7.7 节"BMAD Party Mode" 提过类似洞察，但 04 把它列为 CCG 没有的特性，没深挖 |
| `.ccg-research/05-roadmap-v3.1-to-v4.0.md` | v4.0 路线图，本文档是 v4.1 的对应物 |
| `.ccg-research/03-quality-gates.md` | GSD `plan-review-convergence` workflow 跨 AI 收敛，是 debate 原语的参考 |
| `templates/prompts/` | 6 角色 × 3 模型 = 18 个 prompt 已存在，**v4.1 改进 A 直接复用** |

---

## 9. 总结

CCG v3.0.0 多模型协作的真实形态可以总结为：

> **"双模型并行独立分析 + concat 综合 + 按前后端二分路由 + 没真对辩 + 不分级"**

每个特征单独看都有合理性，叠加在一起就是用户感受到的"生硬"——5 个独立设计决定锁死了协作模式，让多模型成了"给同一问题求两份答案的并行调用"，没真协作。

v4.1 的核心命题：**把"调用多个模型"升级为"多个模型协同解决问题"**。最小可行集是 **specialist matrix 路由（改进 A） + 内置 challenger（改进 C）**，5-6 天可完成。

短期 v4.0 内不重构，只在 Phase 1.5 phase-runner 协议预留 challenger 钩子，Phase 12 经验归档把本文档作为 v4.1 正式 motivation 引入。

---

**最后更新**：2026-05-03
**作者**：dogfood Phase 1 期间用户洞察 + Claude 主线综合
**状态**：v4.1 motivation document，未进入 v4.0 实施范围
