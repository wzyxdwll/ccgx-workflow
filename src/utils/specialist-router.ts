/**
 * Specialist matrix router (CCG v4.1 Phase 15)
 *
 * 6 core commands (`/ccg:plan`, `/ccg:analyze`, `/ccg:debug`, `/ccg:review`,
 * `/ccg:optimize`, `/ccg:test`) accept an optional `--role=<name>` flag that
 * selects a specialized prompt file from `templates/prompts/{codex,gemini,
 * claude}/<role>.md`. Combined with the implicit *layer* derived from file
 * type (backend / frontend / fullstack), this forms a 5×3 routing matrix.
 *
 * This module is the **single source of truth** for the matrix. Command
 * templates (markdown) reference it conceptually via documentation; tests
 * pin its behavior so future refactors stay in sync. Templates themselves
 * remain plain markdown — Claude reads the `--role` flag and picks the
 * prompt file path documented in the template's "Role-based routing"
 * section, which in turn is generated to mirror this matrix.
 *
 * v4.0 backward compatibility: when `role` is omitted (`null`), callers fall
 * back to the legacy `{{BACKEND_PRIMARY}} / {{FRONTEND_PRIMARY}}` template
 * variable routing — i.e. nothing changes for existing users.
 */

export type SpecialistRole =
  | 'architect'
  | 'critic'
  | 'implementer'
  | 'tester'
  | 'writer'

export type SpecialistLayer = 'backend' | 'frontend' | 'fullstack'

/**
 * Which underlying model owns a given (role, layer) intersection.
 * `claude` here means "main thread / no external model spawn".
 */
export type SpecialistModel = 'codex' | 'gemini' | 'claude'

export interface SpecialistRoute {
  /**
   * Resolved model(s). For `fullstack` × {architect, critic} this is two
   * models running in parallel (codex + gemini). For other slots a single
   * model is returned.
   */
  models: SpecialistModel[]

  /**
   * Path-relative (under `~/.claude/.ccg/prompts/<model>/`) prompt file name
   * for each model in `models`, in the same order. `null` entries mean the
   * main thread (Claude) handles the slot directly without an external
   * prompt file (e.g. `writer × backend`).
   */
  promptFiles: (string | null)[]

  /**
   * `true` for the `critic` role — caller must inject "adversarial review"
   * framing (deliberately hunt for flaws / contradict majority view).
   */
  adversarial: boolean

  /**
   * `true` when the underlying spec leaves the call site to runner-decided
   * (e.g. fullstack implementer/tester picks codex OR gemini per file).
   * Caller falls back to v4.0 layer-based routing in that case.
   */
  runnerDecides: boolean
}

/**
 * Map a specialist role to its prompt file name (without directory prefix).
 *
 * Note `critic` is not a separate prompt file — it reuses `reviewer.md`
 * with the adversarial flag set (see `adversarial: true` in the route).
 * This keeps the prompt library at the existing 6 files per model.
 */
function rolePromptFile(role: SpecialistRole): string | null {
  switch (role) {
    case 'architect':
      return 'architect.md'
    case 'critic':
      return 'reviewer.md'  // reused with adversarial framing
    case 'implementer':
      // implementer reuses architect.md per existing prompt library;
      // execute.md / codex-exec.md path uses architect for "build it".
      return 'architect.md'
    case 'tester':
      return 'tester.md'
    case 'writer':
      return null  // main-thread Claude; no external prompt file
  }
}

/**
 * Resolve the (role × layer) intersection to one or more model invocations.
 *
 * Routing matrix (mirrors phase-15-specialist-matrix acceptance a):
 *
 * | Role × Layer  | architect      | critic              | implementer | tester        | writer |
 * | backend       | codex          | codex (adversarial) | codex       | codex         | claude |
 * | frontend      | gemini         | gemini (adversarial)| gemini      | gemini        | gemini |
 * | fullstack     | codex+gemini   | both debate         | runner 决   | runner 决     | claude |
 */
export function routeSpecialist(
  role: SpecialistRole,
  layer: SpecialistLayer,
): SpecialistRoute {
  const adversarial = role === 'critic'
  const promptFile = rolePromptFile(role)

  // writer × any: main thread handles directly
  if (role === 'writer') {
    // exception: frontend writer leverages gemini's UX writing prompt set
    if (layer === 'frontend') {
      return {
        models: ['gemini'],
        promptFiles: ['analyzer.md'],  // gemini's analyzer covers UX writing
        adversarial: false,
        runnerDecides: false,
      }
    }
    return {
      models: ['claude'],
      promptFiles: [null],
      adversarial: false,
      runnerDecides: false,
    }
  }

  // fullstack × {implementer, tester} → runner decides per file
  if (layer === 'fullstack' && (role === 'implementer' || role === 'tester')) {
    return {
      models: ['codex', 'gemini'],
      promptFiles: [promptFile, promptFile],
      adversarial: false,
      runnerDecides: true,
    }
  }

  // fullstack × {architect, critic} → both models in parallel
  if (layer === 'fullstack') {
    return {
      models: ['codex', 'gemini'],
      promptFiles: [promptFile, promptFile],
      adversarial,
      runnerDecides: false,
    }
  }

  // backend × {architect, critic, implementer, tester} → codex only
  if (layer === 'backend') {
    return {
      models: ['codex'],
      promptFiles: [promptFile],
      adversarial,
      runnerDecides: false,
    }
  }

  // frontend × {architect, critic, implementer, tester} → gemini only
  return {
    models: ['gemini'],
    promptFiles: [promptFile],
    adversarial,
    runnerDecides: false,
  }
}

/**
 * Parse a `--role=<name>` CLI flag fragment, tolerant of whitespace and
 * surrounding text. Returns `null` if no recognized role flag is present
 * (caller should then fall back to v4.0 layer-only routing).
 */
export function parseRoleFlag(args: string): SpecialistRole | null {
  const m = args.match(/--role[=\s]+([a-z]+)/i)
  if (!m) return null
  const candidate = m[1].toLowerCase() as SpecialistRole
  if (!['architect', 'critic', 'implementer', 'tester', 'writer'].includes(candidate)) {
    return null
  }
  return candidate
}

/**
 * Build the absolute prompt file path that command templates reference.
 * Returns null entries unchanged (writer × backend → main-thread).
 */
export function promptFilePath(
  model: SpecialistModel,
  promptFile: string | null,
): string | null {
  if (promptFile === null || model === 'claude') return null
  return `~/.claude/.ccg/prompts/${model}/${promptFile}`
}
