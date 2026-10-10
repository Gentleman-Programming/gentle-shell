# Find related published work without waking its owner

## Goal
Turn flat session/task metadata into useful work discovery: repository scope,
area → topic, bounded tags, and explicit work references. User authorized
implementation and nondestructive delivery; no new main merge is authorized.

## Contract
- Extend existing explicit published state and derived projections, not a new registry.
- Preserve legacy activity and older published-state reads; invalid optional data must not hide peers.
- Classification is owner-declared public metadata, never extracted from private history.
- Same labels suggest possible overlap; explicit references explain declared links, not authority.
- Reuse repository/session/task identities; do not confuse child task IDs with peer session IDs.
- Search/filter locally over bounded published data; disclose unknowns and incomplete coverage.
- No model calls, owner wakes, Git probes during discovery, or implicit execution/dependency grants.
- No paid model runs, main pushes/merges, runtime reload, or installed-checkout source changes.

## Delivery
Sequential stacked feature-parent PRs, individually useful and ≤400 additions + deletions,
including tests/docs/tracker. Use nonclosing `Refs #1702` (approved coordination tracker).
Do not close owner-decision coverage or duplicate ODD-file indexing/automatic agent routing.

## Work units (forecast pending scoped exploration)
- [x] Publish bounded classification with compatible persistence and regression tests.
- [x] Annotate actual allocated owned child task IDs explicitly, without child-prompt inheritance.
- [x] Provide bounded basic work indexing/filter queries over existing discovery.
- [x] Extend queries with exact related-work source joins and declared/possible match reasons.
- [x] Wire the existing public list tool and cover real public SDK search boundaries.
- [x] Extend the helper's explicit bounded whitelist for root work and active-page task notes.

## Evidence
- Baseline: `653dad90fe2072929e8fb722e0b95ce35e827f9e` (all prior coordination PRs merged).
- Dedicated root: `work-classification`, branch `feat/work-classification`.
- Dependencies: frozen local `pnpm install --frozen-lockfile --ignore-scripts` succeeded.
- Root `AGENTS.md` absent; inherited global preferences and repository skills apply.
- Duplicate-class search: 185 orchestrator / 59 classification matches, not saturated.
- Related but separate: #1160 ODD file index, #1025 launch routing, #1168 automatic routing.
- #1702: OPEN with `status:approved`; no issue/label mutation performed.
- Publication RED: valid `work` rejected by the original `decodeCuratedState`; 0/1 passed.
- Publication GREEN: 199 focused + 20 regression tests passed; type baseline 186, no regressions.
- Runtime check: eight modules match; orchestrator code remains loaded directly as TypeScript.
- Native assessment after staging: medium/large, 293 A+D, under budget; native outcome unknown.
- Publication independent verification: 219 passed; PR #1779, `bc7624a2`, 301 A+D, CI green.
- Annotation RED: missing status and invalid metadata reached preparation; two intended failures.
- Annotation GREEN: 231 affected tests passed, type baseline 186 unchanged, runtime eight unchanged.
- Independent inspection reproduced same-manager reentrant owner-cache replacement despite 230 passing tests.
- Guard fix RED: missing expected exception; GREEN pins captured owner and preserves new-owner notes.
- Fixed annotation slice: 223 A+D before tracker; fresh independent verification 231 passed, no drift.
- Annotation independent verification: 231 passed; PR #1780, `520cab8b`, 232 A+D, CI green.
- Full query forecast was 430–540 A+D; one final behavior split keeps each slice ≤400.
- Basic filter library, related-source queries, then public SDK wiring are separate useful units.
- Basic projection RED failed against old discovery; focused GREEN: seven query tests.
- Empty recipient RED broadened to all peers; GREEN preserves direct empty selection and rejects invalid query targets before reads.
- Eight affected suites: 46 passed; type baseline 186 and runtime eight unchanged.
- Independent basic-library verification: 254 passed, no source/index drift; public wiring and related-source mode remain separate.
- Basic library independent verification: 254 passed; PR #1785, `da374c32`, 376 A+D.
- Related-source RED rejected the new field; GREEN resolves exact source and scoped match reasons.
- Related library: 55 regression tests passed; type baseline 186 and runtime eight unchanged.
- Source beyond the first 64 replaces one examined peer; targeted candidate scope remains exact.
- Source/rows/reasons share the whole 16-KiB bound; unrelated/unavailable sources never broaden to an index.
- Independent related verification: 259 passed, no source/index drift; PR #1786, `c494f726`, 270 A+D.
- Public filter/SDK wiring and explicit helper capture are separate useful behavior units.
- Public-tool RED returned old text rather than the query envelope; focused GREEN passed.
- Writer public/SDK/query/budget tests: 250 passed; broader transport/runner group: 248 passed (overlap).
- Actual SDK metadata queries added zero owner/helper calls, cost dialogs or caller Git probes; ordinary caller driver turns still occur.
- Replacement/withdrawal, scoped ref collisions, ghost sources and private-history exclusion exercised through production tools.
- At the public-wiring boundary, type baseline 186/runtime eight were unchanged; helper capture was intentionally text-only.
- Original public-wiring independent verification: 452 passed, no source/index drift; PR #1789, `2e5de12f`, originally 229 A+D.
- CI exposed the separate lazy-module guard: 21,595 bytes exceeded its unchanged 20,000-byte cap.
- Guard RED: eight passed, one failed; full-suite packaging RED: 4,780 passed, one failed, 44 skipped.
- Full work guidance is preserved verbatim in the human guide; repeated routing now names one canonical rule.
- Reference-resolution negatives retain fallback order and stop requirements; neither byte guard was raised.
- Parent correction GREEN: 316 focused passed; full suite 4,781 passed, zero failed, 44 skipped; provider contract and runtime harness passed.
- Parent asset: 19,496 bytes; core 8,192-byte guard unchanged. Native assessment: medium/runtime-large, under budget, unknown outcome; writer self-verification stands.
- Parent correction delivered on PR #1789 at `63d4b293`, 299 A+D, with fresh CI green.
- Helper RED omitted valid area; GREEN preserves explicit root and exact active-page task descriptors only.
- Historical/ghost annotations become bounded omissions; malformed/foreign work fails preflight with unchanged caps.
- Writer helper/consent/SDK/query/budget: 66 passed; broader group: 422 passed (overlap).
- Production SDK publication/captured helper payload proves root refs and no ghost notes, retaining five runs/dialog counts.
- Original helper implementation: PR #1795, `c392c803`, 193 A+D; type baseline 186/runtime eight/core 8192 unchanged; independent verification: 473 passed, no source/index drift.
- No human/TUI/RPC wire-client consent or real OS agent-child execution is claimed.
- Integration preserves both full human-guide blocks verbatim and the parent classification/routing outline.
- Integrated GREEN: 336 focused passed; full suite 4,785 passed, zero failed, 44 skipped; provider contract and runtime harness passed.
- Integrated delegation asset: 19,769/20,000 bytes; rendered core 8,110/8,192 bytes, with core source unchanged.
- Type baseline 186 has no regressions; eight runtime modules match; package check passed (159 files, 69 pinned artifacts).

- Helper integration committed and pushed as `ce23a1d3`, with feature parents `c392c803` and `63d4b293`; no main merge occurred.

## Remaining
Confirm fresh CI for the published stack. Runtime activation is not part of delivery.
