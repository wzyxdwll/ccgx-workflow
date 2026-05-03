/**
 * parseFindings 鲁棒化单测（CCG v4.2 Phase 21）
 *
 * 验证 challenger-orchestrator 的 FINDINGS 解析在以下场景正确：
 *   - 严格 JSON 数组
 *   - ```json``` 围栏包裹
 *   - ``` 围栏（无 lang 标识）
 *   - 嵌套 `{}` in message 字段（balanced-bracket tokenizer 关键场景）
 *   - 单引号 → 双引号 normalize
 *   - 裸键名（`{severity: ...}` 无引号）
 *   - 完全坏数据 → 返回空数组（不抛）
 *   - 空数组 / 空字符串
 *   - 部分块格式坏 / 部分好（正确忽略坏块）
 *   - severity 字段大小写
 *   - 多种嵌套 + 转义混合
 */
import { describe, expect, it } from 'vitest'
import {
  parseChallengerSummary,
  type ChallengerSummary,
} from '../challenger-orchestrator'

function findingsFromText(text: string): ChallengerSummary['findings'] {
  return parseChallengerSummary('assumptions-analyzer', text).findings
}

describe('parseFindings — strict JSON', () => {
  it('parses a clean JSON array', () => {
    const text = `STATUS: complete
FINDINGS: [{"severity":"critical","category":"design","message":"race"},{"severity":"info","category":"note","message":"ok"}]`
    const f = findingsFromText(text)
    expect(f).toEqual([
      { severity: 'critical', category: 'design', message: 'race' },
      { severity: 'info', category: 'note', message: 'ok' },
    ])
  })

  it('parses an empty JSON array', () => {
    const text = 'STATUS: complete\nFINDINGS: []'
    expect(findingsFromText(text)).toEqual([])
  })
})

describe('parseFindings — ```json``` fenced blocks', () => {
  // Note: parseChallengerSummary 用 ^...$ 行级 regex 抽 FINDINGS 字段值，
  // 多行 JSON 块会被截断到首行；所以这里测试单行 fenced（合理的实战场景：
  // plugin 单行返回 ```json [...] ```）。
  it('strips ```json``` fence (single line)', () => {
    const text = 'STATUS: complete\nFINDINGS: ```json [{"severity":"major","category":"x","message":"y"}] ```'
    const f = findingsFromText(text)
    expect(f).toEqual([{ severity: 'major', category: 'x', message: 'y' }])
  })

  it('strips bare ``` fence without lang tag', () => {
    const text = 'STATUS: complete\nFINDINGS: ``` [{"severity":"info","category":"a","message":"b"}] ```'
    const f = findingsFromText(text)
    expect(f).toEqual([{ severity: 'info', category: 'a', message: 'b' }])
  })
})

describe('parseFindings — nested {} in message (balanced tokenizer)', () => {
  it('correctly delimits objects when message contains nested braces', () => {
    // 旧 regex `/\{[^}]*severity[^}]*\}/` 会在 message:"err in {x: 1}" 处提前截断，
    // 导致后面对象漏抽。balanced tokenizer 必须算对边界。
    const text = `STATUS: complete
FINDINGS: [{"severity":"critical","category":"design","message":"err in {x: 1}"},{"severity":"info","category":"note","message":"ok"}]`
    const f = findingsFromText(text)
    expect(f).toHaveLength(2)
    expect(f[0]).toEqual({
      severity: 'critical',
      category: 'design',
      message: 'err in {x: 1}',
    })
    expect(f[1].severity).toBe('info')
  })

  it('handles deeply nested braces', () => {
    const text = `STATUS: complete
FINDINGS: [{"severity":"major","category":"data","message":"shape {a:{b:{c:1}}}"}]`
    const f = findingsFromText(text)
    expect(f).toHaveLength(1)
    expect(f[0].message).toBe('shape {a:{b:{c:1}}}')
  })
})

describe('parseFindings — single-quote → double-quote normalize', () => {
  it('parses single-quoted JSON-ish syntax via fallback', () => {
    const text = `STATUS: complete
FINDINGS: [{'severity':'critical','category':'design','message':'r1'}]`
    const f = findingsFromText(text)
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('critical')
    expect(f[0].category).toBe('design')
    expect(f[0].message).toBe('r1')
  })

  it('parses bare-key + single-quote-value', () => {
    // {severity: 'critical', ...} - 裸键名 + 单引号值
    const text = `STATUS: complete
FINDINGS: [{severity: 'critical', category: 'boundary', message: 'off'}]`
    const f = findingsFromText(text)
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('critical')
  })
})

describe('parseFindings — complete bad data fallback', () => {
  it('returns empty array on completely malformed input', () => {
    const text = 'STATUS: complete\nFINDINGS: this is not even close to JSON'
    expect(findingsFromText(text)).toEqual([])
  })

  it('returns empty array on truncated input', () => {
    const text = 'STATUS: complete\nFINDINGS: [{"severity":"crit'
    // 不抛即 OK；具体返回值可能 [] 或 []，正确性取决于 tokenizer 是否平衡
    const f = findingsFromText(text)
    expect(Array.isArray(f)).toBe(true)
    // 不平衡 `{` → 不会抽出完整对象 → []
    expect(f).toEqual([])
  })

  it('skips invalid severity values', () => {
    const text = 'STATUS: complete\nFINDINGS: [{"severity":"BOGUS","category":"x","message":"y"}]'
    const f = findingsFromText(text)
    expect(f).toEqual([])
  })
})

describe('parseFindings — partial parse (mix good + bad)', () => {
  it('keeps good blocks even when one is malformed (regex fallback)', () => {
    // balanced tokenizer 切 3 块；中间一块 severity 缺失会被 extractFindingViaRegex 跳过
    const text = `STATUS: complete
FINDINGS: [{"severity":"critical","category":"a","message":"m1"},{"category":"x","message":"no-sev"},{"severity":"info","category":"c","message":"m2"}]`
    const f = findingsFromText(text)
    // 中间无 severity 的块被跳过；剩 2 个
    expect(f).toHaveLength(2)
    expect(f[0].severity).toBe('critical')
    expect(f[1].severity).toBe('info')
  })
})

describe('parseFindings — case sensitivity', () => {
  it('handles uppercase severity values', () => {
    // 现实中 plugin 摘要可能大小写飘移；规范化为 lower-case
    const text = `STATUS: complete
FINDINGS: [{"severity":"CRITICAL","category":"x","message":"y"}]`
    const f = findingsFromText(text)
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('critical')
  })
})

describe('parseFindings — missing fields default behavior', () => {
  it('defaults category to "unknown" when missing', () => {
    const text = `STATUS: complete
FINDINGS: [{"severity":"major","message":"only sev+msg"}]`
    const f = findingsFromText(text)
    expect(f).toHaveLength(1)
    expect(f[0].category).toBe('unknown')
  })

  it('defaults message to empty string when missing', () => {
    const text = `STATUS: complete
FINDINGS: [{"severity":"info","category":"x"}]`
    const f = findingsFromText(text)
    expect(f).toHaveLength(1)
    expect(f[0].message).toBe('')
  })
})

describe('parseFindings — does not throw on edge inputs', () => {
  it('empty FINDINGS line → empty array', () => {
    const text = 'STATUS: complete\nFINDINGS: \nNOTES: x'
    expect(findingsFromText(text)).toEqual([])
  })

  it('FINDINGS missing entirely → empty array (no throw)', () => {
    const text = 'STATUS: complete\nNOTES: x'
    expect(findingsFromText(text)).toEqual([])
  })
})
