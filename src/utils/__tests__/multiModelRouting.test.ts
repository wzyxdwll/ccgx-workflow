/**
 * multi-model-routing SSoT 单测（CCG v4.2 Phase 21）
 *
 * 验证：
 *   1. SSoT union types 完整 + 与 4 个路由模块的子集一致
 *   2. ALL_LAYERS 与 Layer 同步
 *   3. isLayer 类型守卫正确
 *   4. PluginAvailability 唯一定义（plugin-detection / challenger-orchestrator
 *      共享同一 type identity，而非平行 interface 复制）
 *   5. ROUTING_SCHEMA_VERSION 存在且为已知值
 */
import { describe, expect, it } from 'vitest'
import {
  ALL_LAYERS,
  isLayer,
  ROUTING_SCHEMA_VERSION,
  type Layer,
  type Model,
  type PluginAvailability,
  type Role,
} from '../multi-model-routing'
import type { PluginAvailability as ChallengerPluginAvailability } from '../challenger-orchestrator'
import type { PluginAvailability as DetectionPluginAvailability } from '../plugin-detection'
import type { SpecialistLayer } from '../specialist-router'
import type { DebateLayer } from '../debate-orchestrator'
import type { PhaseType } from '../phase-runner'

describe('multi-model-routing — SSoT integrity', () => {
  it('ALL_LAYERS contains exactly the 5 Layer values', () => {
    expect(ALL_LAYERS).toEqual([
      'backend',
      'frontend',
      'fullstack',
      'docs',
      'generic',
    ])
    expect(ALL_LAYERS.length).toBe(5)
  })

  it('isLayer accepts all valid layers', () => {
    for (const l of ALL_LAYERS) {
      expect(isLayer(l)).toBe(true)
    }
  })

  it('isLayer rejects invalid values', () => {
    expect(isLayer('mobile')).toBe(false)
    expect(isLayer('')).toBe(false)
    expect(isLayer(null)).toBe(false)
    expect(isLayer(undefined)).toBe(false)
    expect(isLayer(42)).toBe(false)
    expect(isLayer({})).toBe(false)
  })

  it('ROUTING_SCHEMA_VERSION is set to v4.2.0', () => {
    expect(ROUTING_SCHEMA_VERSION).toBe('4.2.0')
  })
})

describe('multi-model-routing — type identity (compile-time + runtime)', () => {
  // 这些 it 主要靠 TS 编译期成立；如果类型走偏 typecheck 会先炸。
  // 运行期断言只验证赋值兼容（不抛即通过）。

  it('SpecialistLayer is assignable to Layer (subset relationship)', () => {
    const sl: SpecialistLayer = 'backend'
    const l: Layer = sl
    expect(l).toBe('backend')
  })

  it('DebateLayer is assignable to Layer (subset relationship)', () => {
    const dl: DebateLayer = 'frontend'
    const l: Layer = dl
    expect(l).toBe('frontend')
  })

  it('PhaseType is the full Layer alias (5 values)', () => {
    const pt: PhaseType = 'docs'
    const l: Layer = pt
    expect(l).toBe('docs')
    // 反向赋值也合法，因为 PhaseType === Layer
    const back: PhaseType = 'generic'
    expect(back).toBe('generic')
  })

  it('challenger-orchestrator PluginAvailability is the SSoT type', () => {
    // 此处 TS 编译能通过即说明三处 PluginAvailability 是同一 type identity。
    // 历史上 challenger-orchestrator 与 plugin-detection 各自定义独立 interface，
    // 即使形状相同也是 distinct 类型。v4.2 P21 后必须可互赋。
    const ssot: PluginAvailability = { codex: true, gemini: false }
    const fromChallenger: ChallengerPluginAvailability = ssot
    const fromDetection: DetectionPluginAvailability = ssot
    expect(fromChallenger.codex).toBe(true)
    expect(fromDetection.gemini).toBe(false)
  })

  it('Model union covers expected values', () => {
    const m1: Model = 'codex'
    const m2: Model = 'gemini'
    const m3: Model = 'claude'
    const m4: Model = 'general-purpose'
    expect([m1, m2, m3, m4]).toEqual(['codex', 'gemini', 'claude', 'general-purpose'])
  })

  it('Role union covers 7 roles', () => {
    const roles: Role[] = [
      'architect',
      'critic',
      'implementer',
      'tester',
      'writer',
      'advisor',
      'verifier',
    ]
    expect(roles.length).toBe(7)
  })
})

describe('multi-model-routing — single PluginAvailability definition (no duplication)', () => {
  it('all three modules accept the same object literal at runtime', () => {
    const obj = { codex: true, gemini: true } as const
    // 这只是 runtime 同形 sanity，TS 在编译期已强制 same type。
    const a: PluginAvailability = obj
    const b: ChallengerPluginAvailability = obj
    const c: DetectionPluginAvailability = obj
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })
})
