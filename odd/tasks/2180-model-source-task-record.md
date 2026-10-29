# gentle-shell #2180 — record the resolved model source in task records

Issue: #2180 (Part of #1064, post-3b-ii follow-up; field report by @zhalker, generalization by @matraket). Branch `feat/2180-model-source-task-record` from origin/main `41a3bcd05`.
Spec of record: the issue body. Quote-verbatim user requirement: Juan said: "comencemos con ese issue ya mismo que es urgente para tapar la cagada que nos madnamos".

## Problem

Since 3b-ii, every parent session freezes its profile at startup and an explicit Enter binding outranks editable layers. Nothing at launch time says which layer won, so disk edits below the frozen layers no-op silently (@zhalker: four relaunches failed on a provider quota error before a cold `loadAgentsConfig` proved the disk layers were already correct).

## Specs

- **S#1** `TaskRequest` gains an optional `modelSource?: string` (host-computed only, same provenance discipline as `extensionPaths`: never derived from tool input or agent definitions).
- **S#2** `TaskRecord` gains `modelSource?: string`, copied from the request at record creation in `lib/agents-runner.ts` (next to `model: formatModelRef(request.model)`).
- **S#3** The launch seam in `extensions/gentle-agents.ts` (the `subagent_run` handler that already resolves `sessionBinding`/`sessionProfile` and builds `config` via `withPinnedModelProfiles` + `sessionProfileRoutingAt` + `resolveAgentProfile`) computes the winning layer as a short stable token and passes it into the request. Tokens, exactly: `binding` (explicit Enter binding won), `frozen:local` / `frozen:repo` / `frozen:global` (a session-profile-freeze inherited snapshot won, with its origin), `pin:local` / `pin:repo` (resolveProfilePin won), `declaration` (non-git repo declaration won), `profile` (config.modelProfiles from the global active layer), `definition` (agent frontmatter), `default` (Pi default). Computed at the point where the winning modelProfiles are already known — no layer is re-resolved to route. `resolveSessionProfile` returns explicit → inherited(with origin) → live; the token reconciles with the existing sessionBinding/resolveProfilePin reads so it reflects the real winner. If a launch has both a sessionBinding and a frozen snapshot, the explicit binding wins per the chain's precedence.
- **S#4** The agents task card (`lib/agents-view.ts` `taskHeader`) shows the source next to the model when present (e.g. `nan/glm5.3 · binding`); absent `modelSource` renders exactly as today.
- **S#5** Docs: the task-card field documented in `docs/readme-reference.md` where the card/model routing is described; one line in the frozen-profiles (#2180-adjacent) section.
- **S#6** Tests (RED first): at minimum — a bound-session launch yields `modelSource: "binding"` on the TaskRecord; a frozen global-active launch (no Enter) yields `frozen:global`; an agent whose model comes from frontmatter with no profile layers yields `definition`; a request without `modelSource` leaves `modelSource` undefined and the card rendering unchanged (S#4 absence contract). Runner-level test that record creation copies the field. Fixtures: `pinFixture`/`launchSession` patterns in `tests/gentle-agents.test.ts`; runner tests in `tests/agents-runner.test.ts`.
- **S#7** This ODD file, mirroring the routing convention of `odd/tasks/1064-inherited-profile-freeze.md`.

## Token mapping (S#3, derived from the seam's own resolution)

`resolveAgentProfile(...).source.model` names how the model was found (`profile | definition | default | unresolved`); the seam names *which* layer supplied the profile routing it already resolved:

- `definition` / `default` → `definition` / `default`; `unresolved` → no token (no model anywhere; the card already shows `default`).
- source `profile` + resolution `explicit` → `binding`.
- source `profile` + resolution `inherited` with a snapshot → `frozen:<snapshot.origin>`.
- source `profile` + resolution `inherited` without a snapshot: the session keeps the materialized config routing → `profile`; a foreign target keeps only its own pin layers (L7/N1 contract), so a winning pin there is named `pin:<source>` from the same `resolveProfilePin` read `sessionProfileRoutingAt` just performed.
- source `profile` + resolution `follow`/`live` → the routing read the target's own defaults; the layer is named from the same target read (`resolveProfilePin` → `pin:local`/`pin:repo`, non-Git declaration → `declaration`, otherwise `profile`).

Known tradeoff, stated rather than hidden: the last two paths re-read only the pin/declaration files that `sessionProfileRoutingAt` itself just read, because `lib/session-profile-freeze.ts` and `lib/agents-config.ts` are outside this task's allowed edit surfaces (no origin-carrying routing helper may be added there). No freeze, binding, or profile resolution runs twice.

## Tasks

- T1 [x] S#1, S#2 — protocol/request field + record creation copy; runner-level test. Route: inline. Commits: `ff15fa6f8` (RED), `03e9ffdb0` (GREEN).
- T2 [x] S#3 — launch-seam token; `tests/gentle-agents.test.ts` seam tests (binding, frozen:global, frozen:local, frozen:repo, definition, profile, pin:local, pin:repo, declaration). Route: inline. Commits: `d9d4f1c2b` (RED), `da22b0c0e` (GREEN).
- T3 [x] S#4 — task card source next to the model; absence contract test. Route: inline. Commits: RED folded into `d9d4f1c2b`... see L6 (card RED committed with the seam RED), GREEN `5bdd9b6f2`.
- T4 [x] S#5, S#7 — docs + this record's log. Route: inline. Commit: this docs commit.

## Log

- L1 (process, 2026-10-06): worktree `/tmp/pr1827-2180` from origin/main `41a3bcd05`; `pnpm install` clean; test-first per commit; no push, no GitHub comments. Baselines: `tests/session-profile-freeze.test.ts` + `tests/session-profile-binding.test.ts` 41/41; `tests/agents-runner.test.ts` + `tests/agents-protocol.test.ts` 105/105; `tests/gentle-agents.test.ts` 247/247; `tests/gentle-shell.test.ts` 273/273; `pnpm run typecheck` clean (0 recorded diagnostics; the committed baseline is zero-diagnostics, the "185" ratchet figure in the task handoff does not appear in `scripts/check-types.mjs`, which reports `types: 0 recorded diagnostic(s), no regressions`).
- L2 (evidence, T1): RED — `record creation copies the launch-layer model source next to the model (#2180)` fails with `the record keeps the host-computed layer next to the resolved model: actual undefined, expected 'binding'` (1 fail / 92 pass). GREEN — field added to `TaskRequest` (host-only provenance comment mirroring `extensionPaths`) and `TaskRecord`, copied in `createTask` with a conditional spread so requests without one record no key; `tests/agents-runner.test.ts` + `tests/agents-protocol.test.ts` 106/106; typecheck clean.
- L3 (evidence, T2): RED — 9 new seam tests fail (`modelSource` undefined; gentle-agents file 247 pass / 9 fail, no other breakage). GREEN — `modelSourceToken` derives the token from the resolution and routing the request already performed (`profile.source.model` + `sessionProfile` kind + the frozen origin; targeted pin/declaration reads only in the foreign-inherited and follow/live paths, matching the reads `sessionProfileRoutingAt` itself just did); `routingTarget` hoisted so routing and token share one resolution; `unresolved` records no token; gentle-agents 256/256; typecheck clean.
- L4 (fixture, T2): the non-Git launch fixture binds a dedicated session directory (session cwd override + copied declaration) instead of writing into the shared fixture cwd, so the declaration cannot leak into other tests' launches through the repo pin layer read.
- L5 (evidence, T3): RED — card test fails with the exact expected header missing the `binding` token. GREEN — `taskHeader` inserts `modelSource` between model and usage; absent renders byte-identical; `tests/agents-view.test.ts` + `tests/agents-widget.test.ts` 48/48 (card consumers untouched); typecheck clean.
- L6 (process, T3): the card RED test was committed together with the seam RED commit `d9d4f1c2b` (same work unit, one RED commit) and its GREEN is `5bdd9b6f2`.
- L7 (evidence, T4): docs paragraph "Task card layer token" added to the frozen-profiles section of `docs/readme-reference.md` (tokens enumerated, staleness rationale); doc-contract tests that read the file re-run (see verification).
- L8 (open, for the user): the `frozen:*` token of a foreign launch under a session frozen WITHOUT a profile (`pin:<source>` via the L7/N1 contract) and foreign `follow` launches are implemented but not seam-tested — the existing foreign-launch fixtures require interactive grants; the code path mirrors the tested `pin:local` derivation.
- L9 (verification, final tree): `tests/gentle-agents.test.ts` 257/257; `tests/agents-runner.test.ts` + `tests/agents-protocol.test.ts` 106/106; `tests/session-profile-freeze.test.ts` + `tests/session-profile-binding.test.ts` 41/41; `tests/gentle-shell.test.ts` 273/273; doc-contract tests reading this file (`tests/odd-routing-contract.test.ts` + `tests/package-manifest.test.ts`) 74/74; `pnpm run typecheck`: `types: 0 recorded diagnostic(s), no regressions`. Changed files are exactly the allowed edit surfaces.
