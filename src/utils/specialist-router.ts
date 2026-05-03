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

// v4.2 P21: layer / model 收敛到 multi-model-routing SSoT
import type { Layer } from './multi-model-routing'

export type SpecialistRole =
  | 'architect'
  | 'critic'
  | 'implementer'
  | 'tester'
  | 'writer'

/**
 * Specialist 路由识别的 layer 子集。
 * SSoT `Layer` 5 项中 specialist-router 仅消费 backend/frontend/fullstack。
 * docs / generic 在 specialist-router 上下文不适用——由调用方在 v4.0 fallback 路由覆盖。
 */
export type SpecialistLayer = Extract<Layer, 'backend' | 'frontend' | 'fullstack'>

/**
 * Which underlying model owns a given (role, layer) intersection.
 * `claude` here means "main thread / no external model spawn".
 *
 * v4.2 P21 起继承自 multi-model-routing SSoT 的 Model union（取 codex/gemini/claude 子集）。
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
 *
 * v4.2 P21 (assumption purge):
 *   - `implementer` 历史借用 `architect.md` 是未验证假设；改 return null 让
 *     主线（writer-style）直接接管，不向 codex/gemini plugin 发送伪装 prompt。
 *     实际 implementer 的工作由 phase-runner / autonomous 编排具体落地，
 *     不属 specialist-router 的职责。
 *   - 其余 role 与 v4.1 保持不变。
 */
function rolePromptFile(role: SpecialistRole): string | null {
  switch (role) {
    case 'architect':
      return 'architect.md'
    case 'critic':
      return 'reviewer.md'  // reused with adversarial framing
    case 'implementer':
      // v4.2 P21: 删除"借用 architect.md"假设。implementer 无专属 prompt，
      // 主线（或 phase-runner spawn 的 codex:rescue）按 phase 上下文
      // 自行决定实施策略，不再走 specialist 路由。
      return null
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

  // writer × any: main thread handles directly.
  // v4.2 P21 (assumption purge): 删除 "frontend writer 借 gemini analyzer.md" 假设
  // ——analyzer.md 与 UX writing 不对应，是未验证联想。改为统一 main-thread Claude。
  if (role === 'writer') {
    return {
      models: ['claude'],
      promptFiles: [null],
      adversarial: false,
      runnerDecides: false,
    }
  }

  // implementer × any: v4.2 P21 起 specialist-router 不路由 implementer。
  // 主线（或 phase-runner）按 phase Type 自行 spawn codex/gemini rescue。
  // 返回 main-thread slot 让调用方走 v4.0 fallback。
  if (role === 'implementer') {
    if (layer === 'fullstack') {
      // 保留 fullstack runnerDecides 语义：调用方自行选 codex/gemini per file
      return {
        models: ['codex', 'gemini'],
        promptFiles: [null, null],
        adversarial: false,
        runnerDecides: true,
      }
    }
    return {
      models: ['claude'],
      promptFiles: [null],
      adversarial: false,
      runnerDecides: false,
    }
  }

  // fullstack × tester → runner decides per file
  if (layer === 'fullstack' && role === 'tester') {
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

  // backend × {architect, critic, tester} → codex only
  if (layer === 'backend') {
    return {
      models: ['codex'],
      promptFiles: [promptFile],
      adversarial,
      runnerDecides: false,
    }
  }

  // frontend × {architect, critic, tester} → gemini only
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
