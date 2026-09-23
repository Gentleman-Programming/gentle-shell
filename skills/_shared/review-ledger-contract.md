# Compact Causal Review Contract

The local orchestrator and same-user process are trusted to execute selected actors and submit their exact outputs. Reviewer and validator outputs remain semantically untrusted inputs: native code owns scope, risk, IDs, canonicalization, ordinary state, and legal lifecycle transitions, and rejects malformed or causally inconsistent results. The Git common-directory authority is the only authorization source; summaries and prose ledgers are untrusted data. Legacy Pi mirror and bundle transport is retired.

Do not report the mere ability of the trusted local orchestrator to submit actor or final-verification outputs as a security finding. Report concrete bypasses where untrusted repository content, malformed inputs, stale authority, path drift, or external callers can produce approval contrary to this boundary. Malicious same-user host/process authenticity is a non-goal because it can replace the extension or mutate local authority; external attestation requires a separately privileged signer or service and is not claimed.

## Ordinary facade

Use `gentle_review` as `start -> finalize -> validate` for every new ordinary review.

`start` derives the repository root, complete Git snapshot, untracked set, lineage, risk tier, selected lenses, original authored changed lines, and correction budget. The tier, scope, original lines, and budget never change after start.

Risk routing is deterministic:

| Tier | Route |
|---|---|
| `low` | Zero lenses; only proven docs/comments/format/typo-string work with no executable or configuration change |
| `medium` | One dominant lens for ordinary changes |
| `high` | Canonical 4R for auth, update, security, payments, data exposure/loss, permissions, shell/process, or more than 400 authored lines |

Generated files matching `testdata/golden/**` remain in snapshot identity but do not count as authored risk lines. Ordinary tests, fixtures, and snapshots are never broadly excluded. The correction budget is frozen as `min(200, ceil(original_changed_lines / 2))`.

Before status/START, consult effective review mode. `off` creates no authority or authorization and yields organic `disabled/unmanaged`, never approval. Ordinary START declares `--consent relay`; low risk stays silent. A medium/high `consent/v3` result carries the complete raw two-choice provider envelope plus an opaque in-memory candidate binding. In an eligible interactive parent Pi session, the host displays both provider labels and effects unchanged plus one clearly separate host-owned action: **Run this review and allow reviews for this Pi session**. The first two actions stay candidate-only. Direct human selection of the third action executes that fresh envelope's exact existing `granted` invocation through `answer-consent`, then grants only future fresh validated envelopes for the same live SessionManager object, exact nonempty session ID, and canonical Git worktree root. Every envelope is consumed once before provider mutation and rechecks repository, target, projection, lineage, answer binding, and live session identity; ambiguity reconciles through STATUS and never replays.

The host grant lives only in a schema-checked `globalThis[Symbol.for(...)]` WeakMap registry. Reload preserves the SessionManager and reconnects the grant; quit, new, resume, fork, explicit revoke, or process restart removes it. `/tree` retains it. Child-agent processes, headless/RPC/unsupported UI, explicit cross-repository `workspaceRoot`, model prose, and tool arguments cannot offer, create, or consume it. It grants no provider mode, verdict, cost forecast, acknowledgement, maintenance, delivery, or cross-repository authority. If host UI is cancelled, fails, or cannot prove current Git/session identity, the original unresolved provider envelope is returned unchanged. If that envelope reaches the parent, localize and present its original two choices losslessly; never append the host action to the decoded provider contract. Decline creates no lineage, authority, standing grant, latch, or pending authorization; the next candidate asks again. Old Pi clone latch files are inert, and Pi writes no asked latch.

Reviewer, refuter, and validator verdicts are admitted natively, never Pi-authored. `finalize` follows the provider's negotiated `next_transition` and supplies only the negotiated collection answers: a lens `review.capture-result` collect input rendered with `--agent=pi --materialize=true` is satisfied by the gentle-pi host relay, which prints the exact Go-materialized opaque prompt, launches a fresh locked-down print-mode `pi` subprocess in an empty scratch directory with every discovery surface disabled, and submits the untouched raw output bytes through the provider-owned submission form. The adversarial roles do not go through that relay: `review.capture-refuter` and `review.capture-validation` collect inputs render as self-contained authority-advancing vectors (binding tokens plus `--agent=pi --execute=true`, no submission descriptor); executing the exact rendered invocation makes Go materialize the role prompt, spawn its own locked-down `pi` process, and admit the raw verdict. Native Go owns validation, canonicalization, missing lens/finding ID assignment, persistence, and hashing, and performs only the legal transition from the current compact state. The five states are `reviewing`, `correction_required`, `validating`, `approved`, and `escalated`.

### Concurrent Reviewer Group (MANDATORY)

When one fresh `collect.inputs` set contains multiple distinct independent `review.capture-result` reviewer slots, call `gentle_review_capture_group` once with the complete ordered provider bindings and its forecast acknowledgement. Before any materialization it validates the whole current group, its common binding fields, unique slot identities, and every provider submission descriptor; then it starts all reviewers before waiting. For canonical 4R, preserve `review-risk`, `review-resilience`, `review-readability`, `review-reliability` order.

Each grouped launch runs only its own provider-issued `review.capture-result` binding, and admission remains in provider order. A typed terminal or nonterminal closure returns directly; a later stop after earlier admission reports bounded partial progress and never claims no mutation. If every submission returns without closure, reconcile fresh bound STATUS and return its declared action rather than inferring group success. On `correction_required`, continue only through exact bound STATUS and the provider-issued `review.capture-correction-plan` binding.

`validate` is informational and runs with zero actors. It never mutates compact authority or controls delivery.

## Causal findings

Every finding supplies `evidence_class`, `causal_disposition`, and concrete proof. Concrete proof is one of `changed-hunk`, `candidate-created-path`, `differential-test`, or `before-after`.

| Field | Values |
|---|---|
| `severity` | `BLOCKER` \| `CRITICAL` \| `WARNING` \| `SUGGESTION` |
| `evidence_class` | `deterministic` \| `inferential` \| `insufficient` |
| `causal_disposition` | `introduced` \| `behavior-activated` \| `worsened` \| `pre-existing` \| `base-only` \| `unknown` |
| `proof_refs` | Prefixed concrete proof references |

Only severe `introduced`, `behavior-activated`, or `worsened` findings with valid proof can enter `correction_ids`. Deterministic candidate-caused blockers need no refuter. All inferential candidate-caused blockers share exactly one complete read-only refuter batch, executed through the provider-rendered self-contained `review.capture-refuter` vector: Go materializes the refuter prompt, runs its own locked-down `pi` process, and admits the raw verdict. Pi never authors, edits, batches, or re-scores a refuter row.

Refuter rows may cite independent concrete proof and do not need to repeat reviewer `proof_refs`. `pre-existing` and `base-only` findings become non-blocking follow-ups. `unknown`, insufficient evidence, malformed severe claims, empty/malformed proof, missing/duplicate/extra refuter rows, and inconclusive severe outcomes escalate. `WARNING` and `SUGGESTION` remain informational.

Actor output cannot authorize transitions, corrections, or delivery.

## Correction

Ordinary review permits one correction transaction within the original budget. It consists of one correction, one targeted validator, and final verification.

Before editing, `finalize` requires a positive correction-line forecast. A forecast above the budget escalates. After editing, native authority derives actual correction lines from Git.

Initial lenses never rerun. The correction preserves frozen findings and genesis scope: the original candidate tree, paths, untracked set, and correction IDs. It cannot add scope.

The targeted validator runs through the provider-rendered self-contained `review.capture-validation` vector — Go materializes its prompt, runs its own locked-down `pi` process, and admits the raw verdict — and checks only the original criteria and one correction regression for the exact correction IDs. It cannot add findings, request another correction, launch actors, persist authority, or request another attempt. Failure escalates. Later observations are inert follow-ups.

Final verification evidence is supplied and hashed only during finalization. Failure escalates and never reopens review.

## Authority and compatibility

The negotiated native provider owns compact-v2 storage and its private paths. Pi consumes only typed START, FINALIZE, target status, validation, recovery, reconciliation, and SDD-binding results. Content-derived revisions, compare-and-swap replacement, exact retry idempotency, stale/semantic retry rejection, semantic validation, terminal immutability, atomic publication, and receipt readback remain provider guarantees.

Existing graph-v1 ordinary lineages remain readable for compatibility but reject new mutation. Legacy graph bundle export/import is retired. Judgment Day remains mutable on graph-v1. Pre-graph numbered authority remains destructive-reset-only, while native target status owns mixed-authority ambiguity and the required maintainer action.

Permanent Pi-owned consumer infrastructure is limited to canonical identity primitives, repository/common-directory binding, and immutable candidate views. These modules are not authority mirrors.

## Delivery boundary

Commit, push, pull-request creation, and release creation are not RDD gates. Review outcomes and receipt state are informational and never authorize, consume, rewrite, or block a Bash delivery command; ordinary repository policy owns delivery. Pi does not inspect RDD mode or native authority for those commands.

Dangerous-command confirmation/safety and destructive-review-maintenance consent remain independent. Review transactions, validation, and SDD never perform delivery commands themselves.

## Judgment Day

Judgment Day is independent: it neither enables nor replaces ordinary review; a separately requested ordinary review remains independent.

Judgment Day starts with exactly two blind judges and zero refuters.

Judgment Day alone may iterate discovery and scoped re-judgment, for at most two rounds.

Findings surviving round two escalate; no third-round transition exists.

A standalone `jd-fix-agent` dispatch requires no graph-v1 or native review lineage and is accepted only with this exact Markdown shape. The correction batch contains only one round (`1 of 2` or `2 of 2`) and one lowercase SHA-256. The exact frozen finding rows are one JSON object per line, use only the canonical row fields, and exactly match the authorized IDs.

```markdown
## Judgment Day activation
User explicitly requested Judgment Day.
## Exact authorized severe IDs
- `JD-A-001`
## Judgment Day correction batch
Round: 1 of 2.
Frozen ledger SHA-256: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
## Exact frozen finding rows
{"id":"JD-A-001","lens":"judgment-day","location":"path/to/authorized-file.ts:1","severity":"CRITICAL","status_at_freeze":"open","evidence_class":"deterministic","evidence_claim":"Concrete user-impact claim supported by the frozen location."}
## Allowed edit surfaces
path/to/authorized-file.ts
```

Judgment Day stays mutable on graph-v1. Its reducer, replay, object-store, lock, snapshot, and graph receipt-validation dependencies remain live even though ordinary authority is native.
