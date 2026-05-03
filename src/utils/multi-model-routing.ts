/**
 * Multi-Model Routing — Single Source of Truth (CCG v4.2 Phase 21).
 *
 * v4.1 收尾审计揭示 4 个独立路由模块（specialist-router / challenger-orchestrator /
 * debate-orchestrator / phase-runner）各自定义 layer / model / availability 类型，
 * 类型并集相同但 export 路径不同，导致：
 *   - 跨模块 import 时类型不互通（PluginAvailability 重复定义即一例）
 *   - 任一模块新增 layer 时其他模块不会同步
 *   - 路由假设无法集中审计
 *
 * 本模块作为 SSoT 把 4 个路由共用的核心 union types 全部上提到此处，
 * 由各路由模块 re-export 给业务消费者。本模块**不实现路由逻辑**，
 * 只统一类型；逻辑仍在各 router/orchestrator 中。
 *
 * 设计原则：
 *   - 纯类型 + 极少量纯函数辅助；不读文件、不 spawn
 *   - union string literal 类型（不引入 enum，与 v4.1 风格一致）
 *   - 各 router 通过 re-export 暴露给 src/index.ts，外部消费者不感知拆分
 *
 * 不做：
 *   - 不替代各 router 的具体路由表（routeSpecialist / planChallengerSpawns / debateStateMachine）
 *   - 不暴露已退役的 SpecialistLayer / DebateLayer / PhaseType 别名（v4.2 起统一为 Layer）
 */

// ---------------------------------------------------------------------------
// 1. Layer — 跨 4 个路由共用
// ---------------------------------------------------------------------------

/**
 * 实施 / 对辩 / challenger / phase-runner 路由共用的 layer union。
 *
 * v4.1 历史：specialist-router 用 'backend' | 'frontend' | 'fullstack'，
 * debate-orchestrator 同；phase-runner 多了 'docs' | 'generic'。v4.2 起统一为
 * 5 项并集——具体路由模块按需在 switch 里覆盖各自支持的子集。
 */
export type Layer =
  | 'backend'
  | 'frontend'
  | 'fullstack'
  | 'docs'
  | 'generic'

/** 所有合法 Layer 的运行期数组（保持与 type 同步） */
export const ALL_LAYERS: readonly Layer[] = [
  'backend',
  'frontend',
  'fullstack',
  'docs',
  'generic',
] as const

/** 类型守卫：运行期 layer 校验 */
export function isLayer(value: unknown): value is Layer {
  return typeof value === 'string' && (ALL_LAYERS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// 2. Model — 底层模型选择
// ---------------------------------------------------------------------------

/**
 * CCG 路由可达的底层模型 union。
 *   - codex / gemini：plugin subagent（`codex:codex-rescue` / `gemini:gemini-rescue`）
 *   - claude：主线 Claude，无 external prompt
 *   - general-purpose：plugin 缺失降级（debate-orchestrator）；CCG 自家 prompt 模板兜底
 */
export type Model = 'codex' | 'gemini' | 'claude' | 'general-purpose'

// ---------------------------------------------------------------------------
// 3. Plugin availability
// ---------------------------------------------------------------------------

/**
 * Plugin 可用性。由 plugin-detection 模块在 orchestrator 启动前探测填充。
 *
 * 历史：plugin-detection.ts 与 challenger-orchestrator.ts 各定义一份完全相同的
 * interface 各自 export 给 src/index.ts（`PluginAvailability` +
 * `PluginDetectionAvailability` 两个名字）。v4.2 起合并为单一定义。
 */
export interface PluginAvailability {
  codex: boolean
  gemini: boolean
}

// ---------------------------------------------------------------------------
// 4. Role — Specialist / challenger 共用的角色 union
// ---------------------------------------------------------------------------

/**
 * 跨 specialist-router / challenger 共用的语义角色 union。
 *
 * 历史：specialist-router 用 5 项 (architect|critic|implementer|tester|writer)，
 * challenger-orchestrator 隐式用 advisor/critic 区分。v4.2 SSoT 收并到
 * 一个 7 项并集，各路由按需子集消费。
 *
 * 角色含义（参考 v4.1 各 module 注释）：
 *   - architect:    建设性视角（propose/build）
 *   - critic:       对抗性视角（adversarial review）
 *   - implementer:  实施代码改动；v4.2 起 specialist-router 不再借用 architect.md
 *   - tester:       撰写测试
 *   - writer:       撰写文档 / 文案；主线 Claude 接管多数场景
 *   - advisor:      challenger 中的 plugin 角色（codex/gemini rescue）
 *   - verifier:     verify-work 编排里的校验角色（v4.2 P22 预留）
 */
export type Role =
  | 'architect'
  | 'critic'
  | 'implementer'
  | 'tester'
  | 'writer'
  | 'advisor'
  | 'verifier'

// ---------------------------------------------------------------------------
// 5. Re-export 标识（仅供 src/index.ts 文档化）
// ---------------------------------------------------------------------------

/**
 * SSoT 模块版本号。任何 union 调整时 bump，触发依赖模块在 type-check 阶段
 * 显式 import 此常量做兼容声明（可选；目前未强制）。
 */
export const ROUTING_SCHEMA_VERSION = '4.2.0' as const
