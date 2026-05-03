# Phase 15 Offload Report

**Status**: completed
**Files modified**:
- `templates/commands/plan.md` (added Role-based routing section + argument-hint)
- `templates/commands/analyze.md` (added Role-based routing section + argument-hint)
- `templates/commands/debug.md` (added Role-based routing section + argument-hint)
- `templates/commands/review.md` (added Role-based routing section + argument-hint)
- `templates/commands/optimize.md` (added Role-based routing section + argument-hint)
- `templates/commands/test.md` (added Role-based routing section + argument-hint)
- `src/utils/specialist-router.ts` (NEW — single source of truth, ~155 lines)
- `src/utils/__tests__/specialistMatrix.test.ts` (NEW — 47 tests)
- `src/index.ts` (append exports only, lines 64-73)

## Acceptance Verification Matrix

| Criterion | Status | Notes |
|-----------|--------|-------|
| (a) 6 templates contain `## Role-based routing` section | PASS | Each template documents 5×3 matrix + flag parsing rules + v4.0 BC fallback |
| (a) Routing matrix matches spec (codex / gemini / both / runner / claude) | PASS | Mirrored exactly in `routeSpecialist()` and 6 template tables |
| (a) v4.0 BC preserved (no `--role` → existing `{{BACKEND_PRIMARY}}` flow) | PASS | `parseRoleFlag()` returns `null` on absent/unknown role; templates spell out fallback |
| (b) No new prompt files created | PASS | All 19 existing prompt files referenced by file path only (codex/{architect,reviewer,tester} × gemini/{architect,reviewer,tester,analyzer}) |
| (c) Test file at `src/utils/__tests__/specialistMatrix.test.ts` | PASS | Exists, 47 tests across 5 describe blocks |
| (c) architect × backend → codex/architect.md | PASS | Test "architect × backend" |
| (c) critic × fullstack → codex+gemini debate + adversarial | PASS | Test "critic × fullstack → both models debate adversarially" |
| (c) No --role → fallback (parseRoleFlag returns null) | PASS | Test "returns null when no --role flag is present (v4.0 fallback)" |
| (c) ≥ 8 of 15 routing combinations covered | PASS | All 15 cells covered + extra cases (parsing, adversarial isolation, path builder) |
| (d) Helper or pure-template choice | PASS | Chose helper path (`specialist-router.ts`) — KISS: single source of truth for matrix, mechanical templates reference matrix structure verbally |
| Test count delta | PASS | +47 tests (566 → 613) |
| `pnpm typecheck` | PASS | exit 0 |
| `pnpm build` | PASS | dist size 289 kB; all 3 exports present in `dist/index.mjs` |

## Critical issues

None.

## Major issues

None.

## Pending handoff

- `git_commit`: stage my 9 files only, commit with `feat(v4.1-p15): specialist matrix routing (--role × layer)`
- `test_run`: verified — 613 passed / 1 unrelated failed-suite pre-existing
- `typecheck`: verified pass
- `build`: verified pass

## Notes

- **File boundary respected**: did not touch P13/P19 in-flight files (`installer-hooks.ts`, `skill-registry.ts`, 14 SKILL.md, `sessionStateHook.test.ts`, `skill-description-audit.ts`, `ccg-session-state.cjs`).
- **Pre-existing test failure**: `sessionStateHook.test.ts` (1 suite) fails with `ReferenceError: require is not defined in ES module scope` — caused by P13's `templates/hooks/ccg-session-state.js` ESM/CJS mismatch (the leftover `.cjs` companion file in untracked status hints P13 may be mid-fix). Validated as **unrelated to Phase 15** by stashing my changes: with stash, 2 suites fail / 18 tests fail (installer tests fail due to SKILL.md mods); with my work + leftovers, only the 1 sessionStateHook suite fails. My delta is purely additive (+47 tests, 0 new failures).
- **Design decision (KISS / single-source-of-truth)**: Chose to write the helper `specialist-router.ts` rather than pure template documentation. Reason: the routing matrix is non-trivial (5×3 with adversarial flag and runner-decides flag), and a code helper gives test coverage of the matrix semantics, plus future commands can `import { routeSpecialist }` if they ever become TS-native rather than markdown templates. The helper is **not invoked at runtime by templates** (templates are markdown for Claude to interpret); it documents the matrix as code + provides the test fixture.
- **Non-orthogonal slot mapping**: `implementer` reuses `architect.md` (no separate "implementer.md" prompt file exists in the v3.0 library). `critic` reuses `reviewer.md` with `adversarial: true` flag. `writer × frontend` reuses `analyzer.md` (Gemini's analyzer covers UX writing). These reuse choices are documented in the helper comments and verified by tests.
- **Contract lock**: future changes to the matrix should update `routeSpecialist()` first, then propagate to the 6 template tables. Tests will fail loudly if the two diverge.
