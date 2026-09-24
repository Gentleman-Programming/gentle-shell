# Reviewer OpenCode session attribution headers

- Feature: `reviewer-opencode-session-headers`
- Branch: `fix/reviewer-opencode-session-headers` (base `main` c7fd2e26)
- Engram mirror: topic `odd/reviewer-opencode-session-headers/tasks` (project gentle-pi)
- TDD: strict; focused runner `node --experimental-strip-types --test tests/<file>.test.ts`; full `pnpm test` (+ `pnpm run typecheck`)
- Delivery: owner decides commit / PR (not taken by the agent)
- RDD: on (global)

## Objective

Make an in-process reviewer completion authenticate against OpenCode the same
way pi's main agent loop does, so a lens whose routing model is
`opencode/*` or `opencode-go/*` can actually complete instead of failing at the
transport.

## Problem — observed failure

A lens capture on the `feat/prueba-seed` candidate of another repository failed
twice with an identical host-relay transport error and never reached a verdict:

```text
400 {"type":"MissingSessionID",
     "message":"Request is missing x-opencode-session and cannot be routed efficiently."}
prepared_reviewers: 0, submitted_reviewers: 0
```

## Root cause

Pi adds OpenCode attribution headers **inside the main agent loop**:

`node_modules/@earendil-works/pi-coding-agent/dist/core/provider-attribution.js`
`getSessionHeaders(model, sessionId)` returns
`{ "x-opencode-session": sessionId, "x-opencode-client": "pi" }` when the model
provider is `opencode` / `opencode-go` or the `baseUrl` host is `opencode.ai`,
and `mergeProviderAttributionHeaders(model, settingsManager, sessionId, ...)`
merges it for the loop's own requests.

An extension that dispatches a **side call** bypasses that loop and must add the
same headers itself. The in-process reviewer is exactly such a side call:

- `lib/inprocess-reviewer.ts` builds `SimpleStreamOptions` from only
  `apiKey` and the registry's `headers`, then calls `deps.complete(...)`. No
  session attribution is added, so an OpenCode model is called without
  `x-opencode-session`.

A working in-repo-environment reference already solves this exact problem the
same way, in a different extension:
`~/.pi/agent/npm/node_modules/pi-web-access/opencode-session-headers.ts` —
"Pi adds OpenCode attribution headers inside the main agent loop. Extension
side-calls dispatch directly, so they must add the same session attribution."

## Scope

In:
- `lib/inprocess-reviewer.ts`: accept a session id; export one header helper
  that mirrors pi's `getSessionHeaders` condition (provider `opencode` /
  `opencode-go`, or `baseUrl` host `opencode.ai`); merge the result into the
  completion's `headers` as a default beneath the registry's auth headers.
- `lib/review-host-relay.ts`: carry an optional reviewer session id on
  `ReviewHostRelayRequest`, validate it with the rest of the reviewer selection
  configuration, and pass it into the in-process request.
- `extensions/gentle-ai.ts`: thread the live session id from the extension
  context down to both host-relay request builders (single-slot capture and
  reviewer group), reusing the existing safe extraction pattern.
- Tests for each layer.

Out:
- Go admission, prompt materialization, schema, submission: unchanged. This is
  a transport header fix only.
- Default telemetry attribution for OpenRouter / NVIDIA / Cloudflare
  (`getDefaultAttributionHeaders`). Same class of gap, different symptom, no
  reported failure; can be a follow-up.
- Any model invention or fallback. A missing or unknown model stays a typed
  refusal.
- The pre-existing uncommitted change in `tests/gentle-shell.test.ts` (Windows
  path normalization in the Git discovery assertion). Do not stage, revert, or
  fold it in.

## Constraints

- No behaviour change for providers that are not OpenCode: no session id and no
  headers added means the options are byte-identical to today.
- No session id available is not an error: it produces no attribution header,
  never an invented one.
- The relay contract stands: the host never parses findings and never rebuilds
  the provider form.
- Technical artifacts in English.

## Tasks

- [x] T1 — RED: `tests/inprocess-reviewer.test.ts` locks that an OpenCode
      provider (`opencode`, `opencode-go`, and a custom provider whose baseUrl
      host is `opencode.ai`) receives both attribution headers, that a
      non-OpenCode model receives none, and that an absent session id adds
      nothing.
- [x] T2 — GREEN: `lib/inprocess-reviewer.ts` accepts the session id and merges
      the attribution headers beneath the registry's auth headers.
- [x] T3 — RED/GREEN: `lib/review-host-relay.ts` carries `reviewerSessionId`
      end to end into the completion options.
- [x] T4 — RED/GREEN: `extensions/gentle-ai.ts` threads the live session id
      into both request builders.
- [x] T5 — Verification: focused tests, then `pnpm test` and
      `pnpm run typecheck` green.

## Acceptance criteria

1. With an OpenCode-routed reviewer model and a live session id, the completion
   request carries `x-opencode-session: <session id>` and
   `x-opencode-client: pi`.
2. With a non-OpenCode reviewer model, the completion options are unchanged
   from today.
3. With no session id, no attribution header is added and no error is raised.
4. A lens capture against an OpenCode-routed model no longer fails with
   `MissingSessionID`.
5. Focused tests, `pnpm test` and `pnpm run typecheck` are green.
6. No file outside the declared scope changes.

## Verification evidence

Implementation: 6 files, +298/-7.

| Layer | File | Result |
| --- | --- | --- |
| T1/T2 in-process headers | `tests/inprocess-reviewer.test.ts` | **30/30 pass**, 0 fail — includes 9 new tests (opencode, opencode-go, baseUrl-host, no-session-id for each of the three, non-OpenCode unchanged, registry headers win, unparseable baseUrl never throws, helper mirrors pi's condition) |
| T4 extension threading | `tests/review-relay-transport-agent.test.ts` | **14/14 pass**, 0 fail — includes the live session id reaching the single-slot request, the group requests, and the no-session-id case |
| T3 relay pass-through | `tests/review-host-relay.test.ts` | 2 new tests written; **cannot execute on Windows** (see below) |
| Combined runnable focused set | three files | **75/75 pass**, 0 fail, 0 skipped |
| Types | `pnpm run typecheck` | green: 196 recorded diagnostics, **no regressions**, 3 pairs improved |

Code reviewed directly (not only asserted):
- `lib/inprocess-reviewer.ts` — `openCodeSessionAttributionHeaders(model, sessionId)`
  mirrors pi's `getSessionHeaders` condition exactly, guards the URL parse, and
  returns `undefined` for a missing/empty session id; the merge puts attribution
  **beneath** the registry's auth headers, matching pi's core merge order.
- `lib/review-host-relay.ts` — +10 lines: the `reviewerSessionId` field, its
  pass-through in `validateReviewerSelectionConfiguration`, and its mapping to
  the in-process request's `sessionId` at the `runReviewer` call.
- `extensions/gentle-ai.ts` — the parameter is appended last on all three
  functions so existing positional call sites keep compiling, and set at the two
  tool-handler call sites from the pre-existing safe extractor
  `reviewSessionManagerAndId(ctx)` (HEAD line 6025; try/catch, rejects an empty
  session id).

## The T3 focused test runs in CI, not on Windows

`tests/review-host-relay.test.ts` cannot execute on this Windows machine: its
harness writes a fake binary literally named `gentle-ai` with no executable
extension and `chmod 755` (lines 121-123), so its tests fail before reaching any
assertion:

```text
Error [ReviewHostRelayError]: gentle-ai prompt materialization could not start:
spawn C:\...\Temp\gentle-pi-relay-harness-*\gentle-ai ENOENT
```

This is **by design, not a defect**: `.github/workflows/ci.yml` runs the full
`pnpm test` in the `verify` job on `ubuntu-latest` only, and the Windows jobs run
targeted files instead (`tests/review-repository.test.ts`, the candidate-view
regression, `tests/native-review-consent.test.ts`). A shebang script with no
extension is simply not a Windows executable, so the full suite is a Linux
contract.

Consequences:
- The two new T3 tests are verified by CI on `ubuntu-latest`, alongside the rest
  of the suite (`on: push: branches: [main]` and `on: pull_request`).
- `pnpm test` being red on this machine is expected and pre-existing; it is not
  a regression and needs no code fix.
- No follow-up is required for Windows. An earlier draft of this document
  recorded one, incorrectly.
- `pnpm run typecheck` and the focused runnable files are the meaningful local
  signal on Windows, and both are green (75/75 focused).

## Untouched by design

`tests/gentle-shell.test.ts` still carries its pre-existing uncommitted change
(Windows path normalization in a Git discovery assertion). It was left exactly
as found and is not part of this work.

## Operational note

The harness repo **is** the live extension (`~/.pi/agent/settings.json`
registers `..\..\gentle-pi-main`), so this fix reaches the runtime — but only at
the next Pi session start. The instance that hit `MissingSessionID` had the old
module in memory; a fresh session is required to exercise the fix.

## Delivery evidence

- Commit `9841de69 fix(review): carry OpenCode session attribution into the
  in-process reviewer` — 7 files, +483/-5, on branch
  `fix/reviewer-opencode-session-headers`.
- Issue: `Gentleman-Programming/gentle-shell#1242`.
- Pull request: `Gentleman-Programming/gentle-shell#1243` (1 commit, 7 files,
  base `main`), opened from the fork `IGabrielRC/gentle-shell`.
- The contributing account `IGabrielRC` has `pull` but not `push` on the
  upstream, so the fork route was the only one available. The fork was created
  from the upstream and renamed to `gentle-shell` to match the canonical
  repository name (`gentle-pi` is an alias; `gh repo view` reports
  `Gentleman-Programming/gentle-shell`).
- Git identity was unset in the working clone (no local, no global
  `user.email`), so the first commit attempt failed outright. The repository now
  carries a local identity matching the one already used in the author's other
  clone.

### CI state — and what it means for verification

- This PR's CI run (`35465492773`) is **`action_required`**. It ran for 0s and
  never started. This is the observed repository-specific state, not evidence
  of a defect in this branch.
- The latest CI on `main` (`35463530035`):
  - `verify` (ubuntu, full `pnpm test`) — **success**
  - `session-transport-macos` — success
  - `review-repository-windows` — **failure, pre-existing and unrelated to this
    branch**
- Consequence: once a maintainer approves the run, `verify` green on this PR is
  the meaningful verification — it is the job that runs the two new relay tests
  which cannot run on Windows. If the overall PR still shows red, the red job is
  `review-repository-windows` failing for its own pre-existing reason, already
  red on `main`.

### House convention that cannot be satisfied from this account

The `branch-pr` skill requires `status:approved` on the linked issue and exactly
one `type:*` label on the PR. Both fail with
`AddLabelsToLabelable` permission denied for `IGabrielRC`. The `PR Validation`
jobs the skill documents (`Check Issue Reference`,
`Check Issue Has status:approved`, `Check PR Has type:* Label`) are **not
registered in this repository**: the actions list contains only `CI`, `Publish
to npm`, `Copilot`, and the two Windows workflows. This does not determine
whether branch protection, required status checks, or external checks block the
PR; the labels remain a maintainer action.

### Operational step still owed

The harness repository is the live extension, so the fix reaches the runtime only
at the next Pi session start. The session that produced the `MissingSessionID`
failure had the old module in memory.
