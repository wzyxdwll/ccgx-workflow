# Phase 22 Implementation Report — Quality Tier Orchestration

**Status**: completed
**Phase**: 22 — quality flag 三档 + Plan-Critic-Verify 三段式编排
**Baseline**: 2881798 (P21 SSoT routing)
**Commit prefix**: feat(v4.2-p22):

---

## Files modified

### New helpers (typed code, 3 files)

- `src/utils/quality-router.ts` (~430 lines)
  - `QualityTier` / `WaveKind` / `WavePlan` / `SpawnEntry` / `PhaseMeta` / `QualityPlan`
  - `parseQualityFlag()` / `resolveQualityTier()` / `planWavesForTier()` / `buildQualityPlan()`
  - 三档路由 (fast=2 wave / triple=4 wave / debate=7 wave) + plugin 缺失自动降阶
- `src/utils/plan-aggregator.ts` (~330 lines)
  - `PlanContribution` / `DesignBrief` / `Divergence`
  - `aggregatePlans()` / `serializeBriefForPrompt()` / `estimateBriefLength()`
  - Jaccard token-set 相似度（中文按字 + 英文按词）+ ≥70% 阈值聚类共识
  - high-stakes 关键词识别 (架构/破坏/安全/schema/迁移/breaking/security 等)
- `src/utils/verify-orchestrator.ts` (~220 lines)
  - `VerifyMode` / `VerifyReport` / `VerifyDecision` / `VerifyWavePlan`
  - `planVerifyWave()` / `parseVerifyReport()` / `synthesizeVerifyResults()` / `synthesizeVerifyFeedback()`
  - 单/双 verify 路由 + 复用 challenger-orchestrator parseFindings 鲁棒解析

### New tests (4 files)

- `src/utils/__tests__/qualityRouter.test.ts` (34 tests)
- `src/utils/__tests__/planAggregator.test.ts` (18 tests)
- `src/utils/__tests__/verifyOrchestrator.test.ts` (24 tests)
- `src/utils/__tests__/tripleTierIntegration.test.ts` (11 tests)

### Modified

- `src/index.ts` — append exports for 3 new helper modules (no breaking changes)
- `templates/commands/autonomous.md` — Step 4.0 split into 4.0a (quality tier) + 4.0b (topo Kahn);
  Step 4.1 main loop now describes inner-wave per-phase quality plan; roadmap.md schema docs add
  `Quality: fast|triple|debate` field; argument-hint adds `--quality=` flag
- `templates/commands/agents/phase-runner.md` — input contract adds `design_brief` /
  `verify_findings` optional fields + consumption guide section

---

## Acceptance verification matrix

| Sub-acceptance | Verification | Status |
|----------------|--------------|--------|
| a. quality-router.ts exports + tier resolution + wave planning + degradation | qualityRouter.test.ts × 34 | PASS |
| b. plan-aggregator.ts consensus/divergence/decision-required/serialization ≤500 token | planAggregator.test.ts × 18 | PASS |
| c. verify-orchestrator.ts single/dual verify + parse + synthesize decision | verifyOrchestrator.test.ts × 24 | PASS |
| d. autonomous.md Step 4.x rewrite with quality flag + 4 wave + degradation docs | template diff verified | PASS |
| e. phase-runner.md adds design_brief / verify_findings fields | template diff verified | PASS |
| f. roadmap.md `Quality:` field schema documented | autonomous.md schema section updated | PASS |
| g. Integration tests across 3 helpers | tripleTierIntegration.test.ts × 11 | PASS |

**Total new tests**: 87 (34 + 18 + 24 + 11)
**Suite total**: 891 / 891 passing (was 804 / 804)

---

## Engineering close-out

| Action | Result |
|--------|--------|
| `pnpm typecheck` | pass (no errors) |
| `pnpm test` | 891/891 passing (33 test files) |
| `pnpm build` | pass; dist/index.mjs 47.6 kB chunk; new exports landed |
| git commit | pending — to be done at handoff |

---

## Key design decisions

1. **Layer SSoT compliance**: all 3 new helpers `import type { Layer, Model, PluginAvailability } from './multi-model-routing'` — no parallel type definitions, P21 contract honored.

2. **Plan aggregator algorithm "60% impl"**: deliberately simple (Jaccard token-set + 70% threshold + first-token grouping). P22 ships baseline; P23 dogfood data will inform tuning. No new dependencies.

3. **Degradation policy two-tier**:
   - **Tier-level degrade** (debate→triple→fast) only when ALL plugins missing or specific cross-pairing impossible
   - **Wave-level degrade** (single plugin missing) keeps tier but routes deficient slots to `general-purpose` + CCG prompt template — preserves diversity intent without forcing user-visible tier downgrade

4. **Verify reuses challenger parser**: `parseChallengerSummary` already handles JSON fence stripping / quote normalization / balanced-bracket tokenizer / regex fallback. Verify reports share the same `STATUS / FINDINGS / NOTES` schema, so reusing avoids duplicating ~200 lines of parser code.

5. **Two-layer wave concept in autonomous.md**: outer wave = milestone topo (existing v4.1), inner wave = single-phase quality plan (new v4.2 P22). The two layers are orthogonal — outer chooses which phases run in parallel; inner chooses how each phase is internally orchestrated.

6. **phase-runner backward compat**: `design_brief` / `verify_findings` are optional fields. v4.1 invocations (no quality flag, no triple) skip them entirely — phase-runner falls through to existing self-implementation lifecycle.

---

## Critical issues

None.

---

## Major issues

None.

---

## Notes

三档分级 + Plan-Critic-Verify orchestration ready for P23 dogfood. P23 should:
1. Wire `buildQualityPlan` into autonomous.md Step 4.0a actual call site (currently described, not invoked — autonomous is markdown template, no JS execution)
2. Validate brief aggregation quality on real 3-route plans (P22 unit tests use mocked text)
3. Decide whether to wire quality flag into other commands (`/ccg:plan`, `/ccg:execute`, etc.) — explicit P22 non-goal
4. CHANGELOG / migration guide / version bump

Plugin degradation paths thoroughly tested but not yet exercised in dogfood (no plugin-missing autonomous run during P22). Recommend P23 cold-start cycle on a clean install without plugins to flush any latent integration bugs.
