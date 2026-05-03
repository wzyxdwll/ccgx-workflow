/**
 * v4.1-p18: skill rule-engine paths consumer (glob match)
 *
 * Tests `matchSkillPaths` and `filterSkillsByPaths` from skill-registry.ts.
 * Skills with non-empty `paths` only activate when at least one glob matches
 * a file in the project tree.
 */
import fs from 'fs-extra'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { filterSkillsByPaths, matchSkillPaths, type SkillMeta } from '../skill-registry'

function makeSkill(name: string, paths: string[] = []): SkillMeta {
  return {
    name,
    description: `Test skill ${name}`,
    userInvocable: true,
    allowedTools: ['Read'],
    argumentHint: '',
    aliases: [],
    category: 'tool',
    runtimeType: 'knowledge',
    relPath: `tools/${name}`,
    skillPath: `/fake/skills/tools/${name}/SKILL.md`,
    scriptPath: null,
    context: 'inline',
    paths,
  }
}

describe('skill paths consumer (v4.1-p18)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(tmpdir(), 'ccg-paths-'))
  })

  afterEach(async () => {
    await fs.remove(tmpDir).catch(() => {})
  })

  describe('matchSkillPaths', () => {
    it('returns true when patterns array is empty (unconditional skill)', () => {
      expect(matchSkillPaths(tmpDir, [])).toBe(true)
    })

    it('matches *.tsx when project has .tsx files', async () => {
      await fs.writeFile(join(tmpDir, 'App.tsx'), 'export const X = 1')
      expect(matchSkillPaths(tmpDir, ['*.tsx'])).toBe(true)
    })

    it('matches *.tsx in nested subdir', async () => {
      await fs.ensureDir(join(tmpDir, 'src', 'components'))
      await fs.writeFile(join(tmpDir, 'src', 'components', 'Button.tsx'), 'x')
      expect(matchSkillPaths(tmpDir, ['*.tsx'])).toBe(true)
    })

    it('does not match *.tsx when only .ts files exist', async () => {
      await fs.writeFile(join(tmpDir, 'foo.ts'), 'x')
      expect(matchSkillPaths(tmpDir, ['*.tsx'])).toBe(false)
    })

    it('matches package.json at root', async () => {
      await fs.writeFile(join(tmpDir, 'package.json'), '{}')
      expect(matchSkillPaths(tmpDir, ['package.json'])).toBe(true)
    })

    it('matches first hit out of multiple patterns', async () => {
      await fs.writeFile(join(tmpDir, 'Cargo.toml'), '[package]')
      // first pattern misses, second matches
      expect(matchSkillPaths(tmpDir, ['*.tsx', 'Cargo.toml'])).toBe(true)
    })

    it('returns false when no pattern matches anything', async () => {
      await fs.writeFile(join(tmpDir, 'random.txt'), 'hi')
      expect(matchSkillPaths(tmpDir, ['*.tsx', '*.vue'])).toBe(false)
    })

    it('skips node_modules during walk (perf safety)', async () => {
      await fs.ensureDir(join(tmpDir, 'node_modules', 'react'))
      // The .tsx is ONLY inside node_modules → skip → no match
      await fs.writeFile(join(tmpDir, 'node_modules', 'react', 'index.tsx'), 'x')
      expect(matchSkillPaths(tmpDir, ['*.tsx'])).toBe(false)
    })

    it('skips .git, dist, build directories', async () => {
      await fs.ensureDir(join(tmpDir, '.git'))
      await fs.writeFile(join(tmpDir, '.git', 'foo.tsx'), 'x')
      await fs.ensureDir(join(tmpDir, 'dist'))
      await fs.writeFile(join(tmpDir, 'dist', 'bar.tsx'), 'x')
      expect(matchSkillPaths(tmpDir, ['*.tsx'])).toBe(false)
    })

    it('matches Cargo.toml literal (rust project)', async () => {
      await fs.writeFile(join(tmpDir, 'Cargo.toml'), '[package]')
      expect(matchSkillPaths(tmpDir, ['Cargo.toml'])).toBe(true)
    })

    it('handles deep directory tree without crashing', async () => {
      // make 3 levels deep
      const deep = join(tmpDir, 'a', 'b', 'c')
      await fs.ensureDir(deep)
      await fs.writeFile(join(deep, 'page.tsx'), 'x')
      expect(matchSkillPaths(tmpDir, ['*.tsx'])).toBe(true)
    })

    it('returns false for empty project', () => {
      expect(matchSkillPaths(tmpDir, ['*.tsx'])).toBe(false)
    })
  })

  describe('filterSkillsByPaths', () => {
    it('keeps unconditional skills (empty paths) regardless of cwd state', () => {
      const skills = [
        makeSkill('always-on', []),
        makeSkill('frontend', ['*.tsx']),
      ]
      // empty cwd → frontend skill won't activate, but always-on does
      const filtered = filterSkillsByPaths(skills, tmpDir)
      expect(filtered.map(s => s.name)).toEqual(['always-on'])
    })

    it('activates frontend skill when .tsx files exist', async () => {
      await fs.writeFile(join(tmpDir, 'App.tsx'), 'x')
      const skills = [
        makeSkill('always-on', []),
        makeSkill('frontend', ['*.tsx']),
        makeSkill('rust', ['Cargo.toml']),
      ]
      const filtered = filterSkillsByPaths(skills, tmpDir)
      expect(filtered.map(s => s.name).sort()).toEqual(['always-on', 'frontend'])
    })

    it('activates rust skill when Cargo.toml exists', async () => {
      await fs.writeFile(join(tmpDir, 'Cargo.toml'), '[package]')
      const skills = [
        makeSkill('frontend', ['*.tsx']),
        makeSkill('rust', ['Cargo.toml']),
      ]
      const filtered = filterSkillsByPaths(skills, tmpDir)
      expect(filtered.map(s => s.name)).toEqual(['rust'])
    })

    it('activates skill with multiple alternative patterns when any matches', async () => {
      await fs.writeFile(join(tmpDir, 'tsconfig.json'), '{}')
      const ts = makeSkill('typescript', ['*.ts', 'tsconfig.json'])
      const filtered = filterSkillsByPaths([ts], tmpDir)
      expect(filtered).toHaveLength(1)
    })

    it('preserves skill order from input', async () => {
      await fs.writeFile(join(tmpDir, 'App.tsx'), 'x')
      await fs.writeFile(join(tmpDir, 'Cargo.toml'), 'x')
      const skills = [
        makeSkill('rust', ['Cargo.toml']),
        makeSkill('always', []),
        makeSkill('frontend', ['*.tsx']),
      ]
      const filtered = filterSkillsByPaths(skills, tmpDir)
      expect(filtered.map(s => s.name)).toEqual(['rust', 'always', 'frontend'])
    })
  })
})
