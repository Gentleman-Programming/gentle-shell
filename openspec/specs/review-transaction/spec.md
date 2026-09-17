# Review Transaction Specification

## Purpose

Review authority.

## Requirements

### Requirement: Complete immutable snapshot

`SnapshotV1` MUST persist `base_tree`, full `complete_snapshot_tree`, exact `review_projection` (`complete` or resolved `intended-commit`), `initial_review_tree`, route, ordered lenses, and policy hash without index/worktree mutation. Unsupported projections fail closed.

#### Scenario: Mixed working state

- GIVEN supported changes and ignored paths
- WHEN a transaction snapshot is created
- THEN complete content and projected review tree MUST be exact while the real index remains unchanged

### Requirement: Atomic lineage and receipt authority

Each mutation MUST atomically append `{operation, idempotency_key, request_hash, status, authorization?, canonical_result?}` to the persisted journal. Exact key+request replay returns its stored result across revisions/restarts; mismatch or unresolved pending work fails closed. `ReceiptEnvelopeV1` holds body plus `SHA-256(canonical(body))`; the body excludes the hash and binds lineage/mode, base/complete trees, exact `review_projection`, initial/final trees, route/lenses/policy, ledger/evidence hashes, budget/counters, and terminal state. Write/integrity failure preserves prior authority.

#### Scenario: Failed or tampered state

- GIVEN write, hash, or state/receipt inconsistency
- WHEN authority is checked
- THEN detectable corruption MUST fail closed

#### Scenario: Genuine scope change

- GIVEN a parent receipt and changed target tree
- WHEN review is requested
- THEN parent+target MUST identify one claimed child whose explicit fresh budget is created once

#### Scenario: Logical controller authority

- GIVEN same-user actors return data
- WHEN authority is checked
- THEN only controller APIs MAY authorize; local files are not claimed tamper-proof

### Requirement: Negotiated native ordinary authority

The consumer MUST resolve the integrity-verified package-local Gentle AI v3.1.0 executable, independently hash it, negotiate `gentle-ai.review-integration/v2` outside repository context, and cache capabilities only by that digest. Capabilities, START (`start/v3`/`start/v4`), target status (`status/v3`), FINALIZE, validation, bind-sdd, and repair (`repair/v2`) MUST pass the same v2 contract identifier; consent (`consent/v2`) and failure (`failure/v2`) envelopes MUST decode under the same identity. Native compact-v2 MUST be the sole mutable ordinary authority; legacy-v1 and Pi authority remain compatibility-read-only. No `gentle-ai.review-integration/v1` identity MAY remain in `lib/`, `runtime/`, or `tests/`; v1 contract schemas stay on disk only as `$ref` targets for v2 schemas. Unknown mandatory behavior, incompatible protocol/schema identity, or executable drift MUST fail closed, naming the expected pinned version in the failure. Advertised optional additions MAY be ignored without disabling mandatory operations. A test asserting binary-dependent negotiation MUST fail, not silently skip, when the pinned binary is unexpectedly absent.
(Previously: pinned v2.1.11, `gentle-ai.review-integration/v1`, five call sites with no `consent`/`repair` decoders.)

#### Scenario: Explicit v3.1.0 maintenance

- GIVEN a caller supplies one published maintenance operation and its exact binding inputs
- WHEN Pi invokes abandon, quarantine-legacy, reconciliation, or repair-legacy-alias
- THEN Pi requires fresh interactive approval, forwards shell-free exact argv, preserves a native audit record only from a valid response envelope, derives repair repository/revision/diagnostic/disposition from fresh native inventory, and keeps dispose-result unsupported pending design

#### Scenario: Target-scoped restart

- GIVEN a fresh Pi process and existing native authority
- WHEN target status returns a Git/content projection
- THEN Pi reconstructs only its derived candidate view without reading provider-private authority files or selecting a lineage

#### Scenario: Native failure truth

- GIVEN a negotiated mutating operation fails or loses output
- WHEN Pi reconciles an unknown result
- THEN Pi calls target-scoped native status first, preserves the exact failure and status evidence, follows only the provider-declared action, and replays only when native declares the exact request safe

#### Scenario: v2 identity at every call site

- GIVEN Pi negotiates against the pinned v3.1.0 provider
- WHEN capabilities, start, status, finalize, validate, bind-sdd, and repair execute
- THEN every call site pins `gentle-ai.review-integration/v2`, decodes `start/v3`, `start/v4`, `status/v3`, `consent/v2`, `failure/v2`, `operation/v2`, `repair/v2`, and no v1 identity remains in `lib/`, `runtime/`, or `tests/`

#### Scenario: Half-upgraded install fails hard

- GIVEN `.gentle-ai/` holds only pre-v3.1.0 runtimes
- WHEN Pi resolves the pinned executable
- THEN negotiation fails hard, naming the expected v3.1.0 version, rather than degrading to an older runtime

#### Scenario: Loud skip on missing binary

- GIVEN the pinned binary is not installed locally
- WHEN a binary-dependent negotiation test suite runs
- THEN the suite fails instead of self-skipping green

### Requirement: Mode-isolated reducers

Separate reducers MUST keep mode/budget immutable, counters monotonic, and Judgment Day unreachable from ordinary.

#### Scenario: Cross-mode request

- GIVEN an ordinary lineage
- WHEN a Judgment Day operation is requested
- THEN rejection MUST preserve state/counters

### Requirement: One-shot ordinary transaction

Ordinary MUST run selected 0/1/4 lenses once, controller-check deterministic evidence, permit one inferential refuter batch with independent concrete proof, escalate insufficient or malformed evidence, and permit one correction transaction under the original changed-line budget without rerunning initial lenses or refutation.

#### Scenario: Bounded ordinary work

- GIVEN any finding count
- WHEN ordinary runs
- THEN review, refutation, and correction are each one-shot within the frozen budget

### Requirement: Terminal scoped validation

The authoritative ledger MUST retain immutable canonical ID-sorted identity/claim/evidence rows bound by its hash. The correction receives the requested IDs and frozen scope, records its forecast, Git-derived actual changed lines, snapshot, and targeted validation checks, then advances only when original criteria and correction regression both pass. Failed targeted validation MUST escalate and MUST NOT return to `correction_required`. The correction MUST NOT alter claims, add work, launch discovery actors, or rerun initial lenses. No-fix runs no validator; a passing correction runs one final verification to `approved | escalated`.

#### Scenario: Fixed candidate

- GIVEN a correction attempt passes targeted validation
- WHEN advancing
- THEN one final verification MUST run without rerunning initial review

#### Scenario: Unfixed or failed candidate

- GIVEN no fix, a failed targeted validation, or exhausted correction/final verification
- WHEN reduced
- THEN no-fix uses zero validators and every validation, budget, or final-verification failure escalates without another attempt

### Requirement: Explicit Judgment Day replacement

Explicit Judgment Day replaces ordinary, uses two blind judges, zero refuters, and at most two rounds.

#### Scenario: Round exhaustion

- GIVEN findings survive round two
- WHEN evaluated
- THEN no third round runs and the transaction escalates

### Requirement: Review-only boundaries

Review and Judgment Day evidence is scoped to review. Pi MUST NOT mint delivery authority from receipts, lineages, candidate identity, validation, or any other review artifact. Ordinary commit, push, PR, and release always follow the repository's own policy.

#### Scenario: Review evidence is available

- GIVEN an approved receipt and a resolved target
- WHEN review completes
- THEN the receipt remains review evidence only
- AND ordinary delivery follows repository policy without Pi authorization

#### Scenario: Incident after approval

- GIVEN a post-approval incident
- WHEN recovery starts
- THEN the lineage remains closed and has no delivery effect

### Requirement: Ordinary repository delivery remains independent

Pi MUST NOT replace, wrap, validate, authorize, block, or recover direct `git commit`, push, PR, or release operations. Hooks, command retries, failures, and recovery for those operations remain repository-policy concerns and must not consume or depend on Pi review evidence.

#### Scenario: Mutating pre-commit hook

- GIVEN a repository hook that formats and stages content
- WHEN direct commit runs
- THEN the repository hook and commit follow repository policy
- AND Pi review evidence does not authorize or block the commit

#### Scenario: Commit proof or crash

- GIVEN Git returns or the runner restarts after an uncertain delivery boundary
- WHEN repository recovery runs
- THEN repository policy determines reconciliation
- AND Pi review evidence has no publication effect

## Acceptance Criteria

Tests MUST cover every review binding, replay/budget, integrity, reducer, and forbidden-transition invariant without asserting Pi delivery authority.
