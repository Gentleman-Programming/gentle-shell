# Fix #1192: keep the committed-range selector across intended-untracked selection

Locator: `odd/tasks/fix-1192-committed-selector.md` · Engram mirror: `odd/fix-1192-committed-selector/tasks`
Branch: `fix/1192-untracked-submission-base-ref` (worktree `../gentle-pi-1192`, base `origin/main` a9232643)

## Objective

An explicit committed-range review (`baseRef` + `committedOnly: true`) must describe the same
candidate and target identity across the initial STATUS, the intended-untracked selection
submission, the retained selection, and START.

## Problem

`NativeReviewCliV216.targetStatus` built the submitted-selection STATUS argv only from the
provider-issued tokens, which never carry `--base-ref`/`--committed-only` (gentle-ai 3.7.1).
The target identity changed and START failed with `candidate-target-projection-drift`.
The same submitted branch also drops `lineageId`, and the retained pre-lineage selection does
not remember the committed selector.

## Scope / constraints

- Authorized: all four follow-ups from the first fix plus an end-to-end RDD proof.
- Fail closed on conflicting or malformed provider selectors; never rebuild provider vectors.
- TDD: not configured for this project (standard mode). Runner:
  `node --experimental-strip-types --test <file>`; install with `pnpm install --frozen-lockfile`.
- RDD: clone-local `off` (user decision). Verification follows the RDD-off tier from
  `gentle-ai review assess`.
- Delivery: `ask-on-risk`; forecast ~300 authored changed lines (single PR).

## Tasks

- [x] T1 Append forwarded `--base-ref X --committed-only` after submission tokens; skip identical
  provider base-ref; throw on conflicting one. Route: delegated writer (2 files). Evidence:
  commit `c1ecc407`; verifier PASS; 158 tests pass; real binary keeps target identity.
  Assess: high (RDD off → independent verifier ran).
- [x] T2 Submitted branch forwards `--lineage <id>` (unless provider tokens carry the same one;
  conflicting → throw). Route: delegated writer (2 files). Evidence: `providerFlagValue` helper in
  `lib/native-review-cli.ts` `targetStatus`; tests "targetStatus forwards --lineage on the
  submitted branch, skips a matching value, and rejects a conflicting one" and "...forwards
  base-ref and lineage together..." in `tests/review-integration-v2-forward.test.ts`.
- [x] T3 Provider tokens carrying the same base-ref without `--committed-only` → append
  `--committed-only`. Route: delegated writer. Evidence: test "targetStatus appends
  --committed-only when the submission's same base-ref is missing it, and skips it when already
  present"; updated the pre-existing same-value T1 test to expect the appended flag.
- [x] T4 Dangling `--base-ref` (last token, no value) or empty `--base-ref=` → throw. Route:
  delegated writer. Evidence: `providerFlagValue` throws TypeError; test "targetStatus rejects a
  dangling or empty --base-ref/--lineage in the submitted tokens" (4 malformed cases).
- [x] T5 Retained pre-lineage selection (`extensions/gentle-ai.ts`,
  `RetainedPreLineageNativeUntrackedSelection`) stores `baseRef`/`committedOnly`; a plain START
  adopting it uses the retained selector; an explicit START with a different selector does not
  adopt it (fail closed). Route: delegated writer. Decisions:
  - A conflicting explicit `baseRef` drops adoption of the retained selection for *this* START
    (explicit wins, same precedent as explicit untrackedScope/submission) rather than a hard
    reject, so a differently-scoped explicit START still proceeds; the retained entry is not
    special-cased for preservation beyond that, since a successful START always clears the
    pre-lineage `""` key afterward regardless (gentle-pi#706), so it is moot in the success path
    and only matters if this START itself fails (existing same-candidate retry behavior).
  - "A retained selection without baseRef must not be adopted by an explicit committed-range
    START if that would change the candidate" is already covered by the existing post-negotiation
    `sameNativePreLineageCandidate` mismatch check (rejects with
    `native-start-retained-selection-candidate-mismatch`); no new logic needed for that sub-case.
  - The lineage-scoped retained-selection object stored after START success is now rebuilt as a
    plain `RetainedNativeUntrackedSelection` (no `baseRef`/`targetIdentity`/`candidateTree`),
    since `readRetainedNativeUntrackedSelection` discriminates that key by the absence of a
    `baseRef` field; reusing the pre-lineage object directly would have broken that discriminant
    now that it can carry `baseRef`.
  - `readRetainedPreLineageNativeUntrackedSelection`'s discriminant changed from `!("baseRef" in
    selection)` to `!isRetainedNativeCaptureRoute(selection)`, since the entry can now legitimately
    carry `baseRef` itself.
  Evidence: tests "inspect with a committed-range selector retains baseRef/committedOnly, and a
  plain START adopts it" and "an explicit baseRef that conflicts with a retained committed-range
  selector is not adopted" in `tests/review-controller-native-routing.test.ts`.
- [x] T6 End-to-end RDD proof: load the worktree extension against the real `gentle-ai` binary
  in a temp repo (committed range + unrelated untracked file) and show inspect →
  selection → START creates a lineage without projection drift.
  Route: parent-run headless Pi (`gentle-shell --package-root <worktree> -p --no-session
  --model claude-bridge/claude-opus-5-5`), i.e. Pi + `pi-claude-bridge`, gentle-ai
  3.7.1-0.20260923150940. Temp repo: base commit, feature commit (`add.ts`), untracked
  `notes.txt` + Pi-created `.gitignore`.
  - Baseline (installed gentle-pi, same runtime): inspect with baseRef → `sha256:1c2fdb…`
    `base-diff` [`add.ts`]; inspect + `untrackedScope: exclude` → `sha256:011fb4…`
    `current-changes` [] `empty_candidate_base_ref_required` (bug reproduced).
  - Fixed (this branch, 236192c5): inspect → `sha256:cad755ff…` `base-diff` [`add.ts`]
    `intended_untracked_selection_required`; inspect + exclude → same identity,
    `fresh_target_ready`; plain START `{"mode":"ordinary"}` adopted the retained committed
    selector (`--base-ref`, `--committed-only`, `--untracked-scope=exclude`) → consent granted →
    lineage `review-aef8b8305d59e2ba`, one `review-reliability` host-relay reviewer through
    Claude Bridge → `approved` → acknowledge-approved succeeded (authority burned). No
    diagnostics. Terminal-consumption record on disk names target `cad755ff…` and that lineage;
    `base_tree` a0b17eb equals the base commit tree.

- [x] T7 `select-intended-untracked` preserves the committed-range selector from a plain
  inspect stop through revalidation STATUS and internal START. Route: delegated writer.
  Decision: the stop has no resolved selection yet, so retain its canonical base and exact
  selection binding under the pre-lineage worktree key; reject another binding before STATUS,
  and reject changed target identity before START. Non-committed selections keep their existing
  selectorless route. Evidence: controller tests "committed-range inspect stop carries its binding
  selector into selection STATUS and START, rejecting a mismatched binding" and
  "committed-range selection rejects target-identity drift before START" (coverage of existing
  guard, green immediately); pre-lineage non-committed route tests remain green. RED: missing stop entry.
- [x] T8 Provider-token parsing rejects any non-true `--committed-only=` value, repeated
  `--base-ref`/`--lineage`/`--committed-only` (including mixed bare/equals forms), and split
  values starting with `--`. Route: delegated writer. Decision: validate before native STATUS
  even without a forwarded selector. Evidence: "targetStatus rejects ambiguous or malformed
  provider selectors before executing STATUS" with zero adapter calls; initial RED:
  `--committed-only=false` accepted; correction RED: repeated `--committed-only=true` accepted.

## Acceptance criteria

- Unit tests cover T2–T5 and fail on the previous code.
- Touched test files and `npm run typecheck` show no regressions.
- T6 shows the same target identity from initial STATUS to START and `lineage_created: true`.

## Progress / next step

T1–T5 done (delegated writer). Verification (RDD off, so this report is verification of record):
- `node --experimental-strip-types --test tests/review-integration-v2-forward.test.ts tests/native-review-cli.test.ts tests/review-controller-native-routing.test.ts`: 164 pass, 0 fail.
- `npm run typecheck`: 188 recorded diagnostics, no regressions.
- RED confirmed for T2–T4 and T5 by temporarily reverting each touched source file (via `git diff`/`git apply`, no stash) and re-running the new/updated tests before restoring the fix.

T6 done (see evidence above). Verifier of 236192c5: PASS with two warnings → T7, T8.
T7–T8 done (delegated writer), committed as 86e395e5.
RED: 164 pass, 2 fail (new T7/T8 tests). GREEN: 166 pass, 0 fail on the three-file test command.
`npm run typecheck`: 188 recorded diagnostics, no regressions (10 file/code pairs improved).
Scoped verifier correction: RED 166 pass/1 fail (repeated committed-only); changed-target-identity
coverage green without production edits. GREEN 167 pass/0 fail; `npm run typecheck` unchanged
(188 recorded diagnostics, no regressions, 10 improved pairs).
T7 E2E (Pi + `pi-claude-bridge`, `claude-bridge/claude-opus-5-5`, worktree at 86e395e5, temp repo
with committed `sub.ts` + untracked `notes.txt`): committed-range inspect stopped at
`intended_untracked_selection_required` (`sha256:269d71b2…`, `base-diff` [`sub.ts`]);
`select-intended-untracked` with that exact binding and `[]` → consent granted → lineage
`review-a68904a1d6ee4634` over the same identity → 1 reviewer via Claude Bridge → `approved` →
acknowledge succeeded (a first acknowledge call failed only because the agent passed
controller-only `input`). The native START vector carries `--base-ref=<base tree>`; that is
provider-owned and was identical in the T6 run.
Full suite `npm test`: 3266 tests, 3232 pass, 0 fail, 0 cancelled (exit 0).
Next: push and PR on user decision.
