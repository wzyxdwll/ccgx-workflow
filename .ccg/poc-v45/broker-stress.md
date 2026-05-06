# v4.5 Phase 4 — broker.log stress report

**Generated**: 2026-05-06T04:55:05.747Z
**Platform**: win32 (x64)
**Node**: v24.9.0
**Verdict**: PASS — G3 gate cleared

## tx_id collision resistance
- N: 100,000
- Unique: 100,000
- Collisions: 0
- Duration: 227 ms

## 20-way concurrent stress (real OS processes)
- Outers × Nested × Iters: 4 × 500 (≈)
- Total tx spawns: 2,000
- Total broker events: 5,021
- Unique tx_ids declared: 2,000
- tx_id collisions: 0
- Forced failures: 597
- Successes: 1403
- Misattributions (cross-tx contamination): 0
- Inconsistent terminals: 0
- Duration: 79159 ms

## G3 gate
- ✅ tx_id 100 % unique
- ✅ 0 cross-tx misattribution
- ✅ Per-tx terminal status consistent
→ Phase 6 may enable nested plugin spawn