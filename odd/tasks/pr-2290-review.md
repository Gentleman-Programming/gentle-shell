# PR #2290 CodeRabbit review fixes

Objective: address the CodeRabbit findings on gentle-shell#2290 that are real defects with a cheap fix, before merge.
Branch `feat/harness-r1-runtime-checks` (PR #2290). Runner: `pnpm test`.

## Specs

- S1 (user, verbatim): "vamos con todas" — publish and merge R1; CodeRabbit raised findings before merge.
- S2 Privacy (Major, extensions/gentle-agents.ts ~599): automatic todo progress must not publish todo titles to peer
  sessions. Publish counts only: `<done>/<total> done` (and nothing for an empty list); never the title.
- S3 Integrity (Major, extensions/gentle-agents.ts ~1912): when the owner publishes curated state through
  `orchestrator_session_id` without a `progress` field, the last automatic progress is preserved (merged back);
  an explicit `state: null` still withdraws everything and stays withdrawn until the owner publishes again (existing
  rule); an explicit `progress` from the owner wins.
- S4 Prompt accuracy (Minor, assets/orchestrator-verification.md ~16, assets/orchestrator.md ~57): the text must not
  claim the runtime admits a verifier only with `Risk: item N`; it admits it with a `Risk: item N` line, a
  feature-document task line, or past the context backstop. Keep module byte budgets (core at most 9100 B at the
  128-char assets root; check tests/orchestrator-budget.test.ts) and keep regex/text pins in tests passing.
- S5 Commit slice (Minor, lib/commit-slice-signal.ts): (a) resolve the directory for the commit segment when a
  preceding `cd <dir>` is joined by `;`, `&&`, or `||`, not only a leading `cd … &&`; (b) count renames without
  inflating lines (do not pass `--no-renames`; use rename detection) and add a move-only fixture; (c) parse
  NUL-delimited numstat (`-z`) so quoted or unusual paths still match the generated-file filter, with a fixture whose
  lock file path needs quoting.
- S6 Lint (Minor, lib/delivered-test-lint.ts ~41): a relative TMPDIR value (for example `./.tmp`, `.tmp`, `tmp/x`)
  counts as inside the working directory. Absolute paths and `$TMPDIR`-style references to the inherited temp stay
  allowed. Do not loosen anything else.
- S7 Not changed (reply only, no code): `git log <sha>` stays allowed (gentle-pi's own tests use it as example text,
  false positive); partial-edit fragments are a known limitation of a write-time guard.

## Tasks

| ID | Specs | Work | Route | Status |
|---|---|---|---|---|
| T1 | S2-S6 | fixes with tests | delegated (context backstop) | done, uncommitted (L2) |

## Log

- L1 (2026-10-15): CodeRabbit review on #2290 (9 inline comments); CI green before these fixes.
- L2 (2026-10-15): T1 done test-first; RED observed for every new or re-pinned test before the change.
  - S2: todo progress publishes `<done>/<total> done` only; `tests/gentle-agents.test.ts` "todo progress publishes
    merged into the owner's curated state, only for this session" asserts the title never reaches the discovery record.
  - S3: `orchestrator_session_id` merges back the last automatic progress line while it is still the published one;
    explicit `progress` and `null` win, a withdrawn line is not merged back, and a merge over the 2048 B budget publishes
    the owner's state as given. Test: "an owner publication without progress keeps the automatic progress; explicit
    progress and null still win".
  - S4: verification module names the three admission lines; core rule moves "runtime admission" into the module
    pointer. Budgets: core 9095/9100 B at the 128-char root, `orchestrator-verification.md` 7496/7500 B (the redundant
    "a small task needs no separate verifier unless it is high risk" clause was dropped to fit). Pins updated in
    `tests/verifier-admission.test.ts`, `tests/rdd-aware-verification-contract.test.ts`,
    `tests/delegate-for-reason-contract.test.ts` (rule line and normative-section hash).
  - S5: `commitTargetDirectory` walks `cd` segments before the commit (`;`, `&&`, `||`, newline); numstat uses
    `-z -M`. Tests: "commitTargetDirectory follows a cd that precedes the commit through ;, && or ||", "a move-only
    commit counts no authored lines" (plus a move with a one-line edit counting 1), "a lock file whose path Git quotes
    is still excluded" (`packages/café/pnpm-lock.yaml`).
  - S6: TMPDIR values `.tmp`, `./x`, `../x`, `tmp/x` (quoted or not) are violations; absolute, `~`, `$`, `%` values and a
    bare word stay allowed. A bare quoted word (`"reltmp"`) stays allowed because `tests/agents-runner.test.ts:1926`
    uses it as a fixture. Test: "a test that sets TMPDIR to a relative path is a violation".
  - Docs: `docs/gentle-agents-activity.md` (counts-only progress, merge rule), `docs/readme-reference.md` (relative TMPDIR,
    renames, quoted paths, preceding `cd`).
  - Verification: `pnpm -s typecheck` 0 diagnostics; `pnpm test` all stages passed (unit 6934 tests, 6862 pass, 0 fail,
    72 skipped; provider-contract PASS; runtime-harness PASS).
