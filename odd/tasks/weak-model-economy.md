# Weak-model economy: close three small-path gaps and narrow high-risk item 1

Objective: port the bench candidates C-econ and C-risk (gentle-shell-bench `odd/tasks/model-economy.md`, commit
`1321c60` on `exp/model-economy`) into gentle-pi and the gentle-ai routing canon. Branches: `feat/weak-model-economy`
in gentle-pi (worktree `.worktrees/weak-model-economy`, base `fd29abd0b`) and gentle-ai (worktree
`~/work/gentle-ai-weak-model-economy`, base origin/main `42edf9a90`). Delivery: one PR per repo, user decides push.
Runner: gentle-pi `npm test` (focused: `node --experimental-strip-types --test <file>`); gentle-ai `go test ./...`.

## Specs

- S1 Todo block (gentle-pi `lib/shell-todo.ts` TODO_PROMPT_BLOCK): starts with "A small task (Task Size) uses no todo
  list: do it and report. For tracked or multi-step work, keep it current with the `todo` tool: mark ..." (bench
  C-econ wording, verbatim). The rest of the block is unchanged.
- S2 Differential check (gentle-pi `extensions/gentle-ai.ts` harness principle): "Before finishing, run a differential
  check: for each existing command that shares the code you changed," becomes "Only when your diff changes shared code
  (options, parsers, helpers) that an existing command the request did not name also uses, run one differential check
  before finishing, as a single script: for each such command," (verbatim). Same change wherever the same sentence is
  gentle-pi-owned (e.g. `assets/agents/gentle-ai-worker.md` if it carries it).
- S3 Small path (gentle-pi `assets/orchestrator.md` Task Size): "run the focused test and the suite inline, once each."
  becomes "read only the files you will change and the helpers they call, in one batch, and stop reading once you know
  what and where to change; observe RED inline before the fix; run the focused test and the suite inline in one
  command." (verbatim, inserted as in the bench pin `p43-econ`).
- S4 High-risk item 1, in gentle-pi `assets/orchestrator.md` and in the gentle-ai canon
  (`internal/components/agentguidance/routing.go` and every rendered copy/testdata it owns): "(1) data or irreversible
  effects (migrations, rewriting or deleting stored data, format changes, writing data without validation; not saving
  new records);" becomes "(1) data or irreversible effects on data someone cannot rebuild (migrations, rewriting or
  deleting stored data, format changes, writing data without validation on production or shared data; not saving new
  records, and not a development or test database that a seed, fixture, or backup rebuilds: that is ordinary work);"
  (verbatim; adapt only surrounding punctuation where a copy words item 1 differently).
- S5 Tests and goldens that pin the old sentences are updated to the new ones; add one test per spec asserting the new
  sentence is present in the rendered prompt. Mirrored provider-contract bundles (`contracts/review-provider-contract-
  mirror/**`, `tests/fixtures/provider-contract-bundle/**`) are gentle-ai-owned and are NOT hand-edited in gentle-pi.
- S6 Evidence gate: Sol 6.1 low on the candidate pin must not regress against Sol on base (bench run `econ2`).

## Tasks

| ID | Spec | Work | Route | Status |
|---|---|---|---|---|
| T1 | S1-S3, S4 (gentle-pi copy), S5 | gentle-pi edits + tests, one work-unit commit | delegated (parallel with T2; context backstop), then parent compaction | done `8f8666b62` (full suite: 0 new failures vs base fd29abd0b, 37 env failures on both) |
| T2 | S4, S5 | gentle-ai canon edit + tests, one work-unit commit | delegated (parallel with T1) | pending |
| T3 | S6 | Sol arm econ2 (risk vs base), compare | bench | done (L3: no regression) |
| T4 | S1-S5 | Independent verifier (high risk item 3: mirrored canon) over both commits | delegated | gentle-pi PASS (L6); gentle-ai pending |

## Log

- L1 (user, 2026-10-22): "dale" — approving: port C-econ and C-risk to gentle-pi and the item-1 canon to gentle-ai,
  and run the Sol arm on the candidate pins before merging.
- L2 Evidence (bench, DeepSeek V4 Flash, 2 runs, all accepted with full regression): x2 204 s/44 calls -> 155/33,
  x5 357/44.5 -> 273/31, d1 dev-SQLite rename 209/34/1.5 verify -> 66/18.5/0 verify. Risk: item 3 (canon mirrored
  into gentle-pi and consumed by gentle-ai orchestrators).
- L3 S6 Sol gate (Sol 6.1 low uniform, background on; all 9 cells accepted round 0, full regression): x2 base 70 s/14
  calls (n=1) -> candidate 75.5/15; d1 49.5/13.5 -> 62.5/19.5; x5 169/32 (n=1) -> 155.5/24.5. Quality unchanged;
  Sol was already lean, d1 slightly slower (+13 s, within n=2 noise but noted). About USD 0.93.
- L4 Writer T1 returned partial: verbatim S3/S4 text put getOrchestratorPrompt() at 9347 B over the 9,100 B budget
  (tests/orchestrator-budget.test.ts, orchestrator-rdd-ownership.test.ts); the budget is a user decision by
  convention (raised 8,192 -> 8,400 -> 9,100 for measured rules). Parent compacted S3/S4 keeping every pinned
  clause ("inline in one command", "No explore, worker, or verifier", "(1) data or irreversible effects") and fixed
  a new contradiction (small path "`todo` optional" vs S1) with "; no `todo`": now 9168 B (9227 B at a 128-char
  assets root), 127 B over. Final S3: "read only what you change and its helpers, in one batch; ... run the focused
  test and the suite inline in one command. ... no `todo`." Final S4 item 1: "(1) data or irreversible effects that
  cannot be rebuilt (...; not saving new records, nor a dev or test database a seed or backup rebuilds);". The
  gentle-ai canon (T2) should take the same compact item-1 wording.
- L5 (user, 2026-10-22): chose "Subir budget a 9,250 B" with a comment citing the bench evidence. Done in
  tests/orchestrator-budget.test.ts and tests/orchestrator-rdd-ownership.test.ts; focused suites 107/107 pass.
- L6 gentle-pi verifier (fresh read-only, no writer context) on fd29abd0b..d5d63d959: PASS S1-S5, no blockers;
  focused 107/107; rendered prompt has no remaining small-task todo, unconditional differential check, or dev/test
  database high-risk sentence; mirrored bundles untouched. Advisory follow-up: assets/orchestrator-delegation-
  reference.md:55,80 still say "once each" for the small path checks (compatible, pre-existing wording). Native
  assess: medium, reviewDue false. PR gentle-shell#2457 (Refs #1494, type:bug).
