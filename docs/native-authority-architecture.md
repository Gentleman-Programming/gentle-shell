# Native Authority Architecture After #191

← [Back to README](../README.md)

U8 closed the U1-U7 slimming work. New ordinary review authority is native; Pi retains permanent consumer infrastructure and explicit graph-v1 Judgment Day. Delivery commands remain ordinary repository-policy operations, not review gates.

## Current Ownership

| Surface | Owner after #191 |
| --- | --- |
| Ordinary START, FINALIZE, target status, validation, recovery, and reconciliation | Package-local Gentle AI v2.4.0 through `gentle-ai.review-integration/v2` (migration complete, see below) |
| Canonical consumer identities | Permanent Pi module `lib/review-canonical.ts` |
| Git common-directory and repository identity | Permanent Pi module `lib/review-repository.ts` |
| Immutable reviewer candidate views | Permanent Pi module `lib/review-candidate-view.ts` |
| Dangerous-command safety | Pi; independent of review authority and delivery decisions |
| Explicit Judgment Day and historical graph semantic replay | Pi graph-v1 until a separately proven replacement exists |
| Historical graph receipt validation | Pi graph-v1 transaction, reachable only for historical graph authority and explicit Judgment Day |

Pi no longer owns an ordinary compact store, compact gate, compatibility facade, supersession writer, graph bundle transport, mirror, checkpoint, reset writer, graph reducer mirror, or standalone revision/HEAD transaction backend.

## Naming note: "compact-v2" is not contract v2

This document and `gentle_review`'s recovery/maintenance commands use "compact-v2" to name Pi's own internal review-authority storage generation (historically `lib/review-compact.ts`, now only the reduced `lib/review-compact-contract.ts` after gentle-pi#311 P5), predating and unrelated to gentle-ai's negotiated protocol contract `gentle-ai.review-integration/v2`. The two share a digit and nothing else: "compact-v2" is Pi-internal authority-state vocabulary; `review-integration/v2` is gentle-ai's wire contract replacing the Base64 `candidate_diff` transport with immutable `base_tree`/`candidate_tree` and an ordered `changed_path_manifest`. Do not conflate them when reading the maintenance-boundary section below.

## Contract migration status: `review-integration/v1` → `/v2` (complete)

gentle-ai publishes two negotiated contracts side by side: `gentle-ai.review-integration/v1` (the Base64 candidate-diff transport Pi used to speak) and `gentle-ai.review-integration/v2` (immutable `base_tree`/`candidate_tree`, an ordered `changed_path_manifest`, mandatory `artifact_subjects`, and an evidence-first correction lifecycle). gentle-pi negotiates `/v2` only, with no dual-lane fallback — the pinned binary always answers exactly one exact version, so negotiating a version range would buy nothing and double the decoder surface permanently.

The `review-integration/v2` migration landed in two stages:

- **Stage 1 (authorable without an external dependency):** the `lib/review-integration-v2.ts` decoder module, a pure evidence-first correction-lifecycle module, and a field-wise candidate-view manifest check were authored and unit-tested against the mirrored `contracts/review-integration/v2/` fixtures while `lib/native-review-cli.ts` still negotiated `/v1`.
- **Stage 2 (gated on the pinned gentle-ai release advertising contract v2, landed against v2.2.2):** one atomic commit flipped the import, added the net-new negotiated `review repair` and `review capture-evidence` call sites, deleted `lib/review-integration-v1.ts` and its generated runtime and tests, and regenerated `runtime/*.mjs`. `contracts/review-integration/v1/**` stays on disk permanently because the `/v2` JSON schemas `$ref` into its fragments.

Under `/v2`, reviewers inspect the frozen candidate through read-only Git against the exact frozen trees; a runtime that cannot enforce a per-command shell boundary exposes no shell and reports incomplete inspection rather than substituting live files. Pi already satisfies this by materializing a chmod-read-only worktree scoped to the manifest and pointing lens agents at it through `Read` — they get no Git shell at all.

## Dependency Boundary

The permanent modules have direct production consumers after #191:

| Permanent module | Direct production consumers |
| --- | --- |
| `review-canonical.ts` | `extensions/gentle-ai.ts` and eight live review modules |
| `review-repository.ts` | `extensions/gentle-ai.ts`, graph object store, legacy detector, snapshot, and transaction |
| `review-candidate-view.ts` | `extensions/gentle-ai.ts` |

The remaining ordinary reducer is not dead authority. Historical graph event replay calls it to validate semantic adjacency. Deleting it would weaken graph integrity even though controller mutation is read-only.

## Reproducible Metrics

Run from the repository root:

```bash
node scripts/measure-native-authority-slimming.mjs origin/main HEAD WORKTREE
git diff --shortstat origin/main..HEAD
git diff --shortstat HEAD
git diff --shortstat origin/main
wc -l docs/native-authority-architecture.md scripts/measure-native-authority-slimming.mjs
```

The measurement script defines package footprint as unpacked bytes selected by `package.json#files` plus npm's always-included `package.json`, `README.md`, and `LICENSE`. Source LOC is physical lines in `extensions/**/*.ts`, `lib/**/*.ts`, `runtime/**/*.mjs`, and `scripts/**/*.mjs`. Test LOC is physical lines in `tests/**/*.ts` and `tests/**/*.mjs`.

| Snapshot | Package files | Package bytes | Source files / LOC | Test files / LOC | Local import edges | Review import edges |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `origin/main` (`2f00a308`) | 222 | 4,051,652 | 55 / 28,588 | 64 / 23,759 | 130 | 107 |
| U1-U4 `HEAD` (`0c3a87d4`) | 214 | 3,966,197 | 50 / 27,979 | 61 / 23,111 | 109 | 86 |
| U1-#191 worktree at `0c3a87d4` | 208 | 3,706,418 | 48 / 24,604 | 56 / 21,029 | 75 | 53 |

Relative to `origin/main`, U1-#191 removes 14 package files and 345,234 unpacked bytes, 3,984 source LOC, 2,730 test LOC, 55 local import edges, and 54 review import edges. Relative to the committed U1-U4 `HEAD`, the unstaged U5-#191 work removes 6 package files and 259,779 unpacked bytes, 3,375 source LOC, 2,082 test LOC, 34 local import edges, and 33 review import edges.

The committed U1-U4 baseline is `origin/main..HEAD`. U5-U8 and #191 are in the unstaged `HEAD` worktree delta. The complete delivery candidate is `origin/main` versus the worktree.

| Diff boundary | Files | Additions | Deletions |
| --- | ---: | ---: | ---: |
| Committed U1-U4: `git diff --shortstat origin/main..HEAD` | 21 | 770 | 2,027 |
| Unstaged U5-#191, including two untracked delivery artifacts | 33 | 1,591 | 6,940 |
| Accumulated U1-#191, including two untracked delivery artifacts | 46 | 2,302 | 8,908 |

The two unit ranges are intentionally reported separately. `git diff --shortstat` excludes untracked files, so the architecture report and measurement script are outside the tracked shortstat totals. Unit-range additions and deletions are not arithmetically additive because U5-#191 also edits or removes paths already changed by U1-U4; the accumulated comparison is Git's final origin-to-worktree result.

## Retired Modules

U1-U8 retire nine review modules present on `origin/main`:

| Unit range | Retired modules |
| --- | --- |
| U1-U4 | `review-bundle`, `review-checkpoint`, `review-graph-reducer`, `review-mirror`, `review-reset` |
| U5-U8 | `review-authority-supersession`, `review-compact-gate`, `review-compact-store`, `review-facade` |

U8 found no additional zero-consumer code module at the time. gentle-pi#311 P5 later retired the Pi-owned review semantics that had kept several of those modules alive: `review-compact`, `review-refuter-adapter`, and `review-runtime-contract` are deleted (adversarial roles now execute through Go-owned pi processes via provider-rendered self-contained vectors, and FINALIZE follows the provider's negotiated captured-results transition). The reduced `review-compact-contract` keeps only the negotiated collection answers (correction forecast, targeted validation document, final evidence); graph, ordinary-policy, snapshot, trigger, and risk modules retain production, contract, or semantic-replay consumers.

The packaged `contracts/review-integration/v1/` schemas and fixtures plus `docs/review-integration.md` are byte-identical provider artifacts for negotiated contract `review-integration/v1`, not dead Pi compatibility documentation; the newer `contracts/review-integration/v2/` schemas and fixtures are a second byte-identical mirror, for contract `review-integration/v2`, whose schemas `$ref` into the `/v1` fragments — which is why the `/v1` directory stays packaged even after Pi migrates its active decoder. Package verification proves both directories' hashes.

## Published Maintenance Boundary

Gentle AI has exposed explicit, audited maintenance commands outside negotiated ordinary review since v2.1.11; the currently pinned v2.4.0 keeps them available under the same legacy version table. Pi invokes `review abandon`, `review quarantine-legacy`, and `review reconcile-authority` only after fresh interactive approval of exact LF-only authorization text; headless execution and absent, malformed, or stale bindings fail closed.

`abandon` is restricted by native re-derivation to a caller-named non-terminal compact-v2 lineage; its `gentle-ai.review-abandon-authorization/v2` binding additionally names the exact discarded work (captured lens results, findings presence, evidence-record presence) that the native gate re-derives before accepting. `quarantine-legacy` accepts only the published malformed freeze-findings diagnostic and disposition. Reconciliation accepts the exact dual anomaly suffix `anomalies=unchanged_target,malformed_recovery_authorization` only in that order. `repair-legacy-alias` derives repository, revision, diagnostic, and disposition from freshly read native inventory before its own approval and can only quarantine one qualified historical alias chain. `review dispose-result` remains unexposed pending design. Recovery routes only the provider-selected negotiated `action_disposition`.

## Windows Evidence

Current code contains Windows-aware paths but does not prove complete Windows support:

| Surface | Code evidence | Supported claim |
| --- | --- | --- |
| Native binary install | Selects `gentle-ai.exe`, Windows archives, and trusted `System32\\tar.exe` | Installer has an explicit Windows path |
| Repository identity | Uses hard-link no-replace publication and skips unsupported directory fsync on `win32` | Atomic visibility and conflict rejection are designed; no power-loss directory-entry durability claim |
| Graph object store and lock | File publication uses hard links; directory lock movement has a Windows branch; directory fsync is skipped | Fail-closed branches exist, but Linux simulation does not prove NTFS behavior |
| Native diagnostics | Recognizes drive-letter and UNC paths | Windows paths can be normalized and sanitized |
| Candidate views and complete runtime | Uses chmod, symlink, Git worktree, process, and filesystem behavior without an executed Windows acceptance run in this closure | No end-to-end Windows support claim |

The only platform-specific repository test is skipped outside Windows. U8 therefore records Windows as evidence-partial and unverified end to end; it does not close or mutate any Windows issue.

## #191 Outcome

Issue #191 removed Pi-owned delivery authorization and publication-target revalidation from ordinary review. The extension does not import a publication-gate module or consult review authority to decide commit, push, pull-request, or release delivery.

`review-transaction.ts` retains its reducer, replay, object-store, lock, snapshot, and semantic-replay dependencies for explicit graph-v1 Judgment Day and historical compatibility; no additional module deletion is justified.

Review outcomes are informational: commit, push, PR, and release delivery follow ordinary repository policy. Dangerous-command safety and destructive-review consent remain independent.

← [Back to README](../README.md)
