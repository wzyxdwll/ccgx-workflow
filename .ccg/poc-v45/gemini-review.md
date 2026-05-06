# CCG v4.5 PoC UX + Cost Review

## 1. 观测降级分析

PoC 假设“长跑用户不盯 sidechain”只在宏观层成立，但在微观干预场景下，观测降级会带来显著的体验落差：

1. **进度与阶段感知（早上醒来查岗）**：
   失去了可视化的 sidechain，用户完全变成了黑盒。此时依赖 `/ccg:status`，如果只是拉取原始 log，用户难以判断“现在在干嘛”。必须从 stream 中提取业务语义：第几个 wave、当前正在编辑哪个文件。
2. **卡死与死循环 Debug（发现停滞）**：
   在 sidechain 中，模型反复修改同一个错字的死循环肉眼可见。如果转为文件轮询，`status` 命令必须提供“卡点检测”能力，例如连续 N 次相似的 tool_call，或者某个 bash 命令执行超过了 15 分钟，应该在 CLI 中高亮警告。
3. **取消/干预粒度（精确中断）**：
   当前 PoC 未明确子进程的取消逻辑。如果只靠 OS 杀进程，可能导致 `progress.jsonl` 中断，主线拿不到 `result/success` 从而整个 autonomous 崩溃。需要设计平滑的取消路径（如写入 `cancel.flag` 触发子进程 phase-runner 优雅退出，返回中断状态），才能复刻 sidechain 中随时暂停当前子任务的 UX。
4. **实时 Tool Call 的平替**：
   无法 100% 复刻 Web UI 的精美卡片，但在 CLI 环境下，用户需要的是“透明度”而不是“动画”。可以通过解析 `stream-json`，在终端输出类似 `Spinning: [Agent] running tool 'grep_search' on src/**/*.ts` 的单行更新效果。

## 2. Cost 估算补全

PoC 的 Token Cost 估算基本合理，但漏掉了几个关键的系统性成本：

1. **撞墙重跑的工作丢失成本（Sunk Cost）**：
   Autonomous 如果在第 18 个 phase 撞墙失败，独立进程模式下该阶段的 transcript 被丢弃。如果不设计中间状态保存机制，用户只能重跑，这不仅浪费了前 17 个 phase 的 Token，还浪费了时间。
2. **用户教学与心智成本（OAuth vs --bare）**：
   D9 决定 v1 放弃 `--bare` 妥协于 OAuth。这意味着默认用户承担了更高的成本（因为每次 spawn 都会带入根目录巨大的 `CLAUDE.md`）。要让用户明白“配个 apiKeyHelper 能省 70% 钱”，需要很高的教学成本。大部分用户会默默承担高账单，然后认为系统“变贵了”。
3. **Cold Start 累积延迟**：
   PoC 估算增加 ~10 分钟。在 7.5 小时的长跑中，10 分钟只占 ~2%，对体验几乎没有负面影响。这部分成本可以忽略。反而更干净的 Context 能带来推理质量的提升，这是一个正向对冲。

## 3. Status Command UX 设计规范

主线轮询 `stream-json` 必须配备一个强大的 CLI 查看器。`/ccg:status --tail <job-id>` 的输出格式应遵循以下规范：

1. **多相聚合（Dashboard 模式，不带 --tail）**：
   显示所有当前 active 的 phase 和 wave 进度，使用 Mini ASCII 进度条。
   ```text
   [JOB: ccg-nightly-run]
   Phase 1 (Setup)     [====================] 100%  (4m 12s)
   Phase 2 (Refactor)  [==========>         ] 50%   (Running codex-rescue...)
   ```
2. **Tail 模式（事件流过滤）**：
   - **过滤噪音**：丢弃 `system/init`、逐字 Token 流 (`content_block_delta`)。
   - **保留高优信号**：`tool_use`、`hook_started`、`assistant` 的总结输出、`rate_limit_event`（转换为警告）。
3. **具体展现（单行覆写 + 阶段固定）**：
   ```text
   [Phase 2] 08:15:22 🤖 Analyzing auth logic...
   [Phase 2] 08:15:30 🛠️  Running tool: read_file (src/auth/oauth.ts)
   [Phase 2] 08:15:32 ⏳  Waiting for tool result...
   ```
   如果一个工具执行超过 30s，添加警告后缀 `(taking longer than usual...)`。

## 4. D9 回退路径分析

PoC D9 决策“v4.5 v1 不使用 `--bare`，默认依靠 OAuth 开箱即用”，这是从体验优先视角的合理妥协，但其带来的高成本问题不能长期搁置。

1. **成本落差（v1 vs v2）**：
   不使用 `--bare` 的代价是每次 spawn 都可能加载根目录的 Context，单次 spawn 成本飙升 3-4 倍（从 $0.13 到 $0.41）。
2. **中间过渡方案（CLI 提示与自动注入）**：
   - **方案 A（Install-time 检测）**：在 v4.5 升级或首次运行 `autonomous` 时，弹出一个交互式提示：“检测到您正在使用 OAuth，配置 API Key 可以降低高达 70% 的子进程开销。是否现在配置？[Y/n]”。
   - **方案 B（临时环境变量注入）**：如果用户已经有了 `.env` 中的 API 密钥，主进程可以读取并直接通过 `ANTHROPIC_API_KEY` 注入给 Bash 子进程，同时带上 `--bare`。这样无需等待官方修复，就能隐式达到省钱的目的。
3. **长期建议**：
   如果 CCG 官方未能很快支持 `apiKeyHelper` 配置项，必须采用方案 B，否则部分大仓用户的 Token 账单将导致大量客诉。