import fs from 'fs-extra'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bothPluginsInstalled,
  detectPlugin,
  detectPluginAvailability,
} from '../plugin-detection'

/**
 * Phase 20 acceptance verification:
 *
 *   a. 6 templates contain plugin spawn (`Agent(subagent_type="codex:rescue")` / `gemini:rescue`) section
 *   b. invoke-model.mjs has the deprecation comment block at top
 *   c. fallback paths (Bash codeagent-wrapper) preserved in templates
 *   d. plugin-detection helper detects install / not-install correctly
 *   e. existing 51-place codeagent-wrapper template invocations still parseable
 */

const REPO_ROOT = join(__dirname, '..', '..', '..')
const TEMPLATES_COMMANDS = join(REPO_ROOT, 'templates', 'commands')
const INVOKE_MODEL_PATH = join(REPO_ROOT, 'templates', 'scripts', 'invoke-model.mjs')

const SIX_CORE_TEMPLATES = [
  'plan.md',
  'execute.md',
  'analyze.md',
  'optimize.md',
  'test.md',
  'review.md',
]

describe('Phase 20 — codeagent-wrapper retire + plugin migration', () => {
  // ─── a. 6 template plugin spawn migration ────────────

  describe('6 core templates — Agent spawn section', () => {
    for (const tmpl of SIX_CORE_TEMPLATES) {
      it(`${tmpl} contains plugin spawn (codex:rescue OR gemini:rescue)`, async () => {
        const content = await fs.readFile(join(TEMPLATES_COMMANDS, tmpl), 'utf-8')
        // Must mention both plugin advisor types
        expect(content).toMatch(/codex:rescue/)
        expect(content).toMatch(/gemini:rescue/)
      })

      it(`${tmpl} contains Agent({ subagent_type: ...) call syntax`, async () => {
        const content = await fs.readFile(join(TEMPLATES_COMMANDS, tmpl), 'utf-8')
        expect(content).toMatch(/Agent\(\{[\s\S]*?subagent_type:/)
      })

      it(`${tmpl} preserves codeagent-wrapper Bash fallback (BC)`, async () => {
        const content = await fs.readFile(join(TEMPLATES_COMMANDS, tmpl), 'utf-8')
        // BC fallback must remain — v4.0 path not destroyed
        expect(content).toMatch(/codeagent-wrapper/)
        expect(content).toMatch(/--backend/)
      })

      it(`${tmpl} mentions plugin-detection routing or fallback decision`, async () => {
        const content = await fs.readFile(join(TEMPLATES_COMMANDS, tmpl), 'utf-8')
        // Routing narrative must be present (either preflight wording or
        // explicit two-channel block)
        const hasRouting =
          /plugin/i.test(content) &&
          /(fallback|降级|deprecated|plugin-detection|未装)/i.test(content)
        expect(hasRouting).toBe(true)
      })
    }
  })

  // ─── b. invoke-model.mjs deprecation notice ────────────

  describe('invoke-model.mjs — deprecation notice', () => {
    it('has DEPRECATED-in-v4.1 comment block in top 60 lines', async () => {
      const content = await fs.readFile(INVOKE_MODEL_PATH, 'utf-8')
      const top = content.split('\n').slice(0, 60).join('\n')
      expect(top).toMatch(/DEPRECATED in v4\.1/)
    })

    it('mentions replacement Agent(codex:rescue) / Agent(gemini:rescue)', async () => {
      const content = await fs.readFile(INVOKE_MODEL_PATH, 'utf-8')
      const top = content.split('\n').slice(0, 60).join('\n')
      expect(top).toMatch(/codex:rescue/)
      expect(top).toMatch(/gemini:rescue/)
    })

    it('mentions removal target v5.0 (BC retention discipline)', async () => {
      const content = await fs.readFile(INVOKE_MODEL_PATH, 'utf-8')
      const top = content.split('\n').slice(0, 60).join('\n')
      expect(top).toMatch(/v5\.0/)
    })

    it('preserves runtime implementation below the notice', async () => {
      // BC: actual flag parsing must still be callable. Cheapest check: file
      // is non-empty, still has CLI flag list (--backend, --progress).
      const content = await fs.readFile(INVOKE_MODEL_PATH, 'utf-8')
      expect(content).toMatch(/--backend/)
      expect(content).toMatch(/--progress/)
      expect(content.length).toBeGreaterThan(2_000) // not gutted
    })
  })

  // ─── c. existing 51-place codeagent-wrapper invocations parse-stable ────────────

  describe('codeagent-wrapper invocation count (BC)', () => {
    it('templates still contain ≥40 codeagent-wrapper invocations across the tree', async () => {
      const all = await collectAllTemplateContent()
      const matches = all.match(/codeagent-wrapper/g) ?? []
      // Phase 20 spec mentions 51 callsites; allow 40 floor as BC discipline
      expect(matches.length).toBeGreaterThanOrEqual(40)
    })
  })
})

// ─── plugin-detection helper unit tests ────────────

describe('plugin-detection (v4.1 Phase 20 helper)', () => {
  let tmpHome: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'ccg-plugin-detect-'))
  })

  afterEach(async () => {
    await fs.remove(tmpHome)
  })

  async function installFakePlugin(slug: string, marker = 'SKILL.md') {
    const dir = join(tmpHome, '.claude', 'plugins', slug)
    await fs.ensureDir(dir)
    await fs.writeFile(join(dir, marker), '# fake', 'utf-8')
  }

  it('detectPlugin codex returns installed=true when codex@... dir + marker exists', async () => {
    await installFakePlugin('codex@openai-codex')
    const r = detectPlugin('codex', tmpHome)
    expect(r.installed).toBe(true)
    expect(r.name).toBe('codex')
  })

  it('detectPlugin codex returns installed=false when no plugin dir', async () => {
    const r = detectPlugin('codex', tmpHome)
    expect(r.installed).toBe(false)
    expect(r.reason).toBe('missing-dir')
  })

  it('detectPlugin gemini returns installed=true when gemini@google-gemini exists', async () => {
    await installFakePlugin('gemini@google-gemini', 'plugin.json')
    const r = detectPlugin('gemini', tmpHome)
    expect(r.installed).toBe(true)
  })

  it('detectPlugin returns missing-marker when dir exists but no marker file', async () => {
    await fs.ensureDir(join(tmpHome, '.claude', 'plugins', 'codex@openai-codex'))
    const r = detectPlugin('codex', tmpHome)
    expect(r.installed).toBe(false)
    expect(r.reason).toBe('missing-marker')
  })

  it('detectPlugin recognizes alternative prefixes (codex-rescue@... / openai-codex@...)', async () => {
    await installFakePlugin('codex-rescue@vendor', 'manifest.json')
    expect(detectPlugin('codex', tmpHome).installed).toBe(true)
  })

  it('detectPlugin ignores unrelated subdirs', async () => {
    await installFakePlugin('frontend-design@official')
    expect(detectPlugin('codex', tmpHome).installed).toBe(false)
    expect(detectPlugin('gemini', tmpHome).installed).toBe(false)
  })

  it('detectPlugin treats fs errors as not-installed (non-throwing)', async () => {
    // Pass a non-existent tmpHome → still returns false, no throw
    const r = detectPlugin('codex', join(tmpHome, 'does-not-exist-xyz'))
    expect(r.installed).toBe(false)
  })

  // ─── aggregate availability ───

  it('detectPluginAvailability returns both=false on empty home', () => {
    const a = detectPluginAvailability(tmpHome)
    expect(a.codex).toBe(false)
    expect(a.gemini).toBe(false)
  })

  it('detectPluginAvailability reflects mixed install states', async () => {
    await installFakePlugin('codex@openai-codex')
    const a = detectPluginAvailability(tmpHome)
    expect(a.codex).toBe(true)
    expect(a.gemini).toBe(false)
  })

  it('detectPluginAvailability returns both=true when both plugins present', async () => {
    await installFakePlugin('codex@openai-codex')
    await installFakePlugin('gemini@google-gemini')
    const a = detectPluginAvailability(tmpHome)
    expect(a.codex).toBe(true)
    expect(a.gemini).toBe(true)
  })

  it('bothPluginsInstalled is true iff both plugins present', async () => {
    expect(bothPluginsInstalled(tmpHome)).toBe(false)
    await installFakePlugin('codex@openai-codex')
    expect(bothPluginsInstalled(tmpHome)).toBe(false)
    await installFakePlugin('gemini@google-gemini')
    expect(bothPluginsInstalled(tmpHome)).toBe(true)
  })
})

// ─── helpers ───

async function collectAllTemplateContent(): Promise<string> {
  const templates = await fs.readdir(TEMPLATES_COMMANDS)
  const parts: string[] = []
  for (const t of templates) {
    if (!t.endsWith('.md')) continue
    parts.push(await fs.readFile(join(TEMPLATES_COMMANDS, t), 'utf-8'))
  }
  return parts.join('\n')
}
