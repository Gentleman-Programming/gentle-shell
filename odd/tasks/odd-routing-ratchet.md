# Feature: ODD routing drift ratchet (gentle-pi mirror of gentle-ai canon)

## Objective

Make the hand-mirrored ODD routing text in gentle-pi fail visibly when the
gentle-ai canonical routing block changes, instead of drifting silently.

## Problem

gentle-pi hand-mirrors the ODD delegation text from gentle-ai
(`internal/components/agentguidance/routing.go` RenderRouting). There is no
automated sync (only the review provider contract is mirrored), so a canonical
change in gentle-ai leaves the pi mirror stale with nothing catching it.

## Design (follows the provider-contract precedent)

- `fixtures/odd-routing-canonical.md` — vendored snapshot of the canonical
  routing block rendered by gentle-ai `RenderRouting`, with a header naming the
  source repo/commit and the fixture digest.
- `scripts/mirror-odd-routing.mjs` — offline regeneration: locates a local
  gentle-ai checkout (default `../gentle-ai`), renders the canonical block
  through a temporary Go entrypoint, verifies, and writes the fixture. Never
  touches the network. Fails closed when the sibling checkout is missing.
- `tests/odd-routing-canonical-ratchet.test.ts` — derives semantic anchors from
  the fixture and asserts the pi mirror (assets/orchestrator-delegation.md,
  assets/orchestrator.md, extensions/gentle-ai.ts) carries each mandatory
  delegation clause. A canonical change that is not re-mirrored fails here.
- `package.json` — `mirror:odd-routing` script entry.

## Constraints

- Offline, no release-pin changes (installer pin untouched).
- Ratchet only makes drift visible; it never auto-rewrites mirror assets.
- Fixture regeneration is deliberate and reviewable (diff shows the change).

## Tasks

- [x] T1. RED: ratchet test fails without fixture/anchors wired.
- [x] T2. Implement mirror script + fixture generation; GREEN.
- [x] T3. Triangulate: simulate drift, observe RED, restore.
- [x] T4. Validation. (Work-unit commit deferred: the delegating task requires
  the change to stay uncommitted.)
- [x] T5. Address approved-review finding R3-NonIdempotentRefresh: derive
  `generated_at` from the source commit's committer date
  (`git show -s --format=%cI HEAD`) instead of wall-clock time, so the same
  source commit renders identical fixture bytes.
- [x] T6. Address approved-review finding R3-DirtySourceProvenance: fail closed
  before rendering when the gentle-ai checkout has uncommitted modifications to
  tracked files (`git status --porcelain --untracked-files=no`), naming the
  offending paths. Untracked files must not block.

## Progress and evidence

- Canonical source: gentle-ai `../gentle-ai` at commit
  `e7729359fd9d6cb691ed2a88e8f72b1372f7c92e` (contains `dcd2fa07`, the mandatory
  delegation triggers).
- Fixture block sha256:
  `16eaa3031d7dd0d7b91e0095d4761d7fc85a1f4a8c596c5f2cfe754213d7aba6`.
- RED: `node --experimental-strip-types --test tests/odd-routing-canonical-ratchet.test.ts`
  failed with `ERR_MODULE_NOT_FOUND` for `scripts/mirror-odd-routing.mjs`.
- GREEN: after `npm run mirror:odd-routing` generated
  `fixtures/odd-routing-canonical.md`, the ratchet passed 5/5.
- Triangulation A (canonical drift, allowed surface): dropping the canonical
  Long-session anchor from the fixture made the ratchet fail with
  `canonical fixture dropped anchor: long-session backstop`; the fixture was
  restored with `npm run mirror:odd-routing`.
- Triangulation B (mirror drift): removing the condensed Long-session row from
  `assets/orchestrator.md` in memory reproduced the exact ratchet message
  `assets/orchestrator.md is missing the mirror of "long-session backstop": ...`.
  The mirror file was not written, to respect the allowed edit surfaces.
- Focused suites: `odd-routing-canonical-ratchet` + `odd-routing-contract` = 17/17 pass.
- `npm run check:provider-contract`: passed (contract 1.2.0).
- `npm run test:harness`: exit 0.
- Full `npm test`: 2706 tests, 2667 pass, 1 fail, 38 skipped. The single failure
  is `tests/opaque-pi-reviewer-adapter.test.ts`, a concurrent working-tree edit
  outside this task's scope (HEAD's committed version does not reference
  `extractPiAssistantText`); the provider-contract and harness stages were run
  separately and passed.

## Approved-review findings (T5, T6)

- R3-NonIdempotentRefresh: `generated_at` used wall-clock time, so re-running
  the mirror over an unchanged gentle-ai produced a date-only diff. Now derived
  from the source commit's committer date; same source commit + same rendered
  block -> identical bytes.
- R3-DirtySourceProvenance: the header declares a source commit, but nothing
  guaranteed the block came from that committed tree. `mirrorOddRouting` now
  resolves provenance (which runs the fail-closed dirty guard) BEFORE rendering;
  untracked files are excluded by `--untracked-files=no` and never block.

### T5/T6 evidence

- RED: `node --experimental-strip-types --test
  tests/odd-routing-canonical-ratchet.test.ts` failed with
  `SyntaxError: The requested module '../scripts/mirror-odd-routing.mjs' does
  not provide an export named 'assertCleanGentleAiCheckout'` before the helpers
  existed.
- GREEN: ratchet suite 7/7 pass after implementing the helpers and the two new
  tests (`fixture rendering is idempotent and derives generated_at from the
  source commit`, `the mirror fails closed on a dirty source checkout and names
  the tracked paths`).
- Idempotency (integration): two consecutive `npm run mirror:odd-routing` runs
  over gentle-ai `e7729359...` produced byte-identical fixtures, both
  `shasum -a 256 = c8293650834991146a88297baa4cc7367724f6a855fe905bdda2c8a477581947`.
- Fixture diff vs HEAD is the `generated_at` header line only
  (`...11:58:20.516Z` -> `...13:49:03+02:00`); `block_sha256` unchanged
  (`16eaa303...`).
- Gentle-ai checkout left untouched: 0 tracked modifications after both runs;
  its 9 untracked files did not block the guard.
- `tests/odd-routing-contract.test.ts` could not run in this worktree: it
  imports `extensions/gentle-ai.ts`, which needs `@earendil-works/pi-tui`, and
  this worktree has no `node_modules` (`ERR_MODULE_NOT_FOUND`). The main worktree
  was not accessed per the task constraint. This is an environment limitation,
  not a regression: the contract test does not import the mirror script or the
  fixture, so T5/T6 cannot affect it.
- Full `npm test` not run for the same missing-dependency reason.

## Acceptance criteria

- `npm run mirror:odd-routing` regenerates the fixture from a local gentle-ai.
- Ratchet test passes on the current mirror and fails when a canonical clause
  is missing from it.
- Full suite stays green (blocked only by the unrelated external test edit).
