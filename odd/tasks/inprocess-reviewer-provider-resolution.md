# In-Process Reviewer: Provider Resolution Through the Composed Provider

## Objective

Fix the live defect reported as #1304: a reviewer lens routed to an extension-registered provider
(`claude-bridge/*`) can never complete, because `runInProcessReviewer` dispatches through pi-ai's
`completeSimple`, which resolves against pi-ai's builtin-only `apiProviderRegistry` instead of pi's
composed provider. RDD is unusable for every user whose models come from a pi extension.

This closes #1304, #1190, #757 and #831 — four reports of the same root cause across two different
transports.

## Problem

`lib/inprocess-reviewer.ts:250` completes through the injected `deps.complete`, typed as pi-ai's
`completeSimple` (`:20`, `:79`). The registry seam (`:31-37`) exposes only `find` and
`getApiKeyAndHeaders`, so the composition layer is never consulted.

pi-ai `dist/compat.js` then resolves the call against its own module-level registry:

```
streamSimple(model, ...)
  -> getBuiltinProviderForModel(model)   // undefined: claude-bridge is not builtin
  -> resolveApiProvider(model.api)
       -> getApiProvider(api)            // reads apiProviderRegistry (registerApiProvider only)
       -> throw `No API provider registered for api: ${api}`   // compat.js:165
```

Two registries never meet:

| Registry | Populated by | Read by |
| --- | --- | --- |
| pi `ModelRegistry` composed provider | `pi.registerProvider` (extensions) | the interactive agent loop |
| pi-ai `apiProviderRegistry` | `registerApiProvider` (builtins only) | `completeSimple` |

The throw is synchronous, which is why the reported failure carries `elapsed_ms: 1` and
`exit_code: null` — no network, no auth attempt.

The composed provider does honor extensions
(`@earendil-works/pi-coding-agent/dist/core/provider-composer.js:316`:
`if (extension?.streamSimple && model.api === extension.api)`), and the real object already passed as
`reviewerRegistry` at `extensions/gentle-ai.ts:8888` and `:8931` is `ctx.modelRegistry`, which exposes
`getProvider(provider): Provider | undefined`
(`dist/core/model-registry.d.ts:32`, present in 0.85.1). Only the narrowed TypeScript interface hides it.

The provider side cannot fix this: `pi-claude-bridge` 0.8.0 registers through `pi.registerProvider`,
which is exactly what an extension provider is supposed to do.

### This is a design bug, not a slip

The module header at `lib/inprocess-reviewer.ts:3-7` states that the child transport it replaced
"dropped extension-registered providers", and `odd/tasks/inprocess-reviewer-completion.md` names
extension-registered providers in both its objective and its acceptance criterion. The acceptance
test passed only because the fake registry had no composition layer. The chosen primitive,
`completeSimple`, is structurally incapable of reaching an extension provider.

The header phrase "no extension hooks" (`:12`) means no tool/skill/prompt hooks. It was read as
"no extension providers". That misreading is the origin of the defect and must be corrected in place.

## Constraints

- Strict behavioral TDD: a focused failing test precedes every behavior change.
- Peer floor stays `>=0.85.1`. `ModelRegistry.getProvider` exists on 0.85.1; `ModelRegistry.streamSimple`
  is 0.86.1-only and is therefore forbidden here.
- `ModelRegistry.complete()` is forbidden: it routes through the full `ApiStreamOptions` path and
  resolves auth itself, which would silently bypass the `AUTH_UNAVAILABLE` typed refusal.
- All ten `INPROCESS_REVIEWER_FAILURE` codes (`:39-50`) keep their current semantics and evidence.
- Abort classification stays signal-based (`abortRefusal`, `:238-246`) on both settlement paths.
- `getApiKeyAndHeaders` stays: the composed provider forwards `options` verbatim and resolves no
  credentials.
- The existing 30 tests in `tests/inprocess-reviewer.test.ts` and the maintainer matrix must keep
  passing without structural rewrites.
- No secret logged, rendered or persisted. No new network call.
- No delivery action (push, PR) without an explicit user decision.

## Authorized edit surfaces

- `odd/tasks/inprocess-reviewer-provider-resolution.md`
- `lib/inprocess-reviewer.ts`
- `lib/review-host-relay.ts`
- `tests/inprocess-reviewer.test.ts`
- `docs/review-integration.md` (only if wording requires it; the file is byte-pinned in
  `scripts/verify-package-files.mjs` and its hash must be re-pinned when touched)

Out of scope for this change: `extensions/gentle-ai.ts` (no change expected — the widened interface
stops hiding a method the real object already has), `ResolvedRequestAuth.baseUrl` being dropped by the
narrow seam (pre-existing, follow-up issue).

## Decisions

- **Optional `getProvider` on the seam, with fallback to `deps.complete`.** A required method would
  break all 30 existing tests and the `registerFauxProvider`-based maintainer matrix, which injects
  into compat's registry and would be invisible to a composed-provider path.
- **Complete via `provider.streamSimple(model, context, options).result()`.** `SimpleStreamOptions`
  is identical between both paths; only the return type differs (stream vs promise). `.result()` is
  exactly what compat itself does, and it preserves both settlement conventions the module already
  handles.
- **Incoherence guard.** When `registry.getProvider` exists but returns `undefined` for a model
  `find()` just resolved, that combination is incoherent and must refuse, not fall back silently.
  The fallback is reserved for "the seam has no `getProvider` at all", i.e. test doubles.
- **The incoherence guard reuses `MODEL_NOT_FOUND`; no eleventh code is added.** Two reasons, one of
  them a hard blocker. Blocker: `lib/review-host-relay.ts:579` closes its refusal-code switch with
  `const unreachable: never = code`, so an eleventh member makes that assignment fail
  (verified: `lib/review-host-relay.ts(579,10): error TS2322: Type '"provider-unresolved"' is not
  assignable to type 'never'`), and `review-host-relay.ts` carries zero recorded diagnostics, so the
  `scripts/check-types.mjs` ratchet would reject it. Merit: `MODEL_NOT_FOUND` already means "the
  registry cannot resolve this selection into a dispatchable target", and `getProvider` returning
  `undefined` is the second half of that same resolution failing for the same reason — the provider is
  not present in this pi. It maps to `REVIEWER_MODEL_NOT_FOUND`, a configuration-actionable relay kind,
  whereas `PROVIDER_FAILED` maps to `PI_FAILED`, the generic bucket, which reads as a transient upstream
  error and would invite retries that can never succeed. The existing branch keeps its message and its
  absent evidence byte-for-byte; the new branch carries its own message plus
  `{ provider, api }` evidence so the two causes are distinguishable in logs.
- **Env-API-key delta: settled in IRP-4 as redundant, not a regression.** compat wraps every dispatch
  in `withEnvApiKey(model, options)` and `provider.streamSimple` does not, but that wrapper cannot
  rescue anything this module has not already been handed: `getApiKeyAndHeaders` runs first, and pi's
  own auth resolution reads the same `process.env` through the same variable names before returning.
  The earlier "a builtin provider authenticated purely by an env var with no stored credential is
  rescued by compat today" reading is wrong — that provider resolves an `apiKey` through the registry.
  See "Settled: the env-API-key delta" below for the evidence. The case still gets its own tests,
  because the module's *own* contract (never invent an `apiKey`, never read `process.env`) is worth
  pinning on both dispatch paths regardless of what pi-ai does upstream.
- **Do not upgrade the local pi runtime for this change.** `getProvider` is present across the whole
  supported range (verified on 0.85.1 locally, and on 0.86.1 and 0.87.0 from the published
  declarations), so the fix needs no upgrade. Staying on 0.85.1 is deliberate: it is the declared peer
  floor, so validating there proves the fix for every supported user, whereas validating on 0.87.0
  would only prove the ceiling. Upgrading mid-change would also add a variable to IRP-7: a failing e2e
  could no longer be attributed to the fix alone.
- **`ModelRegistry.streamSimple` stays out of scope even though it is the better primitive.** It routes
  through `ModelRuntime.prepareRequest` (composed provider + auth + `baseUrl` + merged headers) and
  would incidentally close the dropped-`baseUrl` gap. It is 0.86.0+, so adopting it forces the peer
  floor from `>=0.85.1` to `>=0.86.0` and breaks every 0.85.x user. That is a maintainer decision and
  a breaking change, not part of this fix. Raise it in the PR as a follow-up option only.

## Tasks

- [x] IRP-0 — Sanitize the local pi install so an e2e check is meaningful: `~/.pi/agent/npm/package.json`
      pins `gentle-pi` to a `file:` tarball that no longer exists, and the installed build is stock
      3.2.1 (subprocess relay, `--no-extensions`, no allowlist). Record the resulting versions.
- [x] IRP-1 — RED: a focused failing test asserting that a registry exposing `getProvider` routes the
      completion through the returned provider's `streamSimple`, with the extension `api` reaching it,
      and that `deps.complete` is never called.
- [x] IRP-2 — GREEN: widen `InProcessReviewerRegistry` with optional `getProvider`, dispatch through
      `provider.streamSimple(...).result()`, keep `deps.complete` as the no-`getProvider` fallback.
- [x] IRP-3 — RED/GREEN: the incoherence guard (`getProvider` present, returns `undefined` for a
      resolved model) refuses with a typed code instead of falling back.
- [x] IRP-4 — RED/GREEN: lock the env-API-key behavior for a provider with no stored credential, so
      the `withEnvApiKey` delta is a decision on record rather than a silent regression.
- [x] IRP-5 — Correct the module header: "Only `find` and `getApiKeyAndHeaders` are needed here"
      (`:25-26`) is now false, and "no extension hooks" (`:12`) must state that it excludes
      tool/skill/prompt hooks, not extension-registered providers.
- [x] IRP-6 — Verify: focused tests, `pnpm test`, `pnpm run typecheck`, and the maintainer matrix
      (`pnpm run test:maintainer`) with observed results recorded below.
- [x] IRP-7 — E2E from pi: a real RDD lens routed to `claude-bridge/*` completes and is admitted.
- [ ] IRP-8 — PR upstream against `Gentleman-Programming/gentle-shell`, linking #1304, #1190, #757,
      #831, and naming the design-bug framing so the failure class does not return through a third door.

## Acceptance criteria

- A lens routed to `claude-bridge/claude-opus-5` completes in-process and is admitted, with no
  `No API provider registered for api: claude-bridge`.
- A registry without `getProvider` still completes through `deps.complete` — existing tests unedited.
- A registry with `getProvider` returning `undefined` for a resolved model refuses with a typed code.
- All ten failure codes keep their current messages and evidence shape.
- `pnpm test`, `pnpm run typecheck` and `pnpm run test:maintainer` pass with no regressions.
- The peer floor stays `>=0.85.1` and nothing references `ModelRegistry.streamSimple`.

## Verification plan

- Focused: `node --experimental-strip-types --test tests/inprocess-reviewer.test.ts`
- Relay: `node --experimental-strip-types --test tests/review-host-relay.test.ts`
- Full: `pnpm test`
- Types: `pnpm run typecheck`
- Maintainer matrix: `pnpm run test:maintainer`
- E2E: new pi session (not `/reload`), RDD lens routed to `claude-bridge/*`.

TDD mode: **on**. Source: this repository's ODD convention (every `odd/tasks/*` document declares
strict behavioral TDD). Runner: `node --experimental-strip-types --test tests/<file>.test.ts` for
focused runs, `pnpm test` for the suite.

## Delivery

Forecast: well under the ~400 authored changed line budget (roughly 15 production lines plus tests and
comment corrections). Strategy `ask-on-risk`; a single PR is expected and no chain is planned. Push and
PR remain the user's decision.

## Progress

- 2026-09-21: Exploration completed and the #1304 hypothesis confirmed against the real code and the
  installed runtime (`@earendil-works/pi-coding-agent` 0.85.1, `@earendil-works/pi-ai` 0.85.1).
  `getProvider` verified present at `dist/core/model-registry.d.ts:32`; `streamSimple` verified absent
  from `ModelRegistry` on 0.85.1. No upstream fix in flight (40 commits reviewed, zero hits).

## Verification evidence

- IRP-0 (2026-09-21): the phantom `file:` pin was replaced with `gentle-pi@^3.3.0` from the registry;
  `npm ls gentle-pi` reports `gentle-pi@3.3.0`. The installed build now carries
  `lib/inprocess-reviewer.ts` and no longer carries `lib/opaque-pi-reviewer-adapter.ts`, so the local
  baseline reproduces **this** defect (#1304, in-process) rather than the superseded
  `--no-extensions` one (#1337). A repository-wide search for `GENTLE_PI_REVIEW_RELAY_EXTENSIONS` and
  `review-relay.json` in the installed package returns nothing, which confirms no escape hatch exists
  on a stock install.
- IRP-0 aligned versions: `gentle-ai` 3.3.0, `gentle-pi` 3.3.0, `pi` 0.85.1,
  `@earendil-works/pi-coding-agent` 0.85.1, `pi-claude-bridge` 0.8.0. `gentle-pi`'s declared peer is
  `@earendil-works/pi-coding-agent >=0.85.1`.
- IRP-0 consequence for the fix: the live runtime is pi-coding-agent **0.85.1**, where
  `ModelRegistry.streamSimple` does not exist. The `getProvider` route is therefore not a portability
  preference, it is the only route this machine can execute — the e2e check in IRP-7 would fail on
  0.86.1-only API.
- IRP-0 leftovers, dead but harmless, kept rather than deleted (they are user configuration, not
  cruft, and deleting them silently would erase evidence of the earlier workaround):
  `~/.pi/gentle-ai/review-relay.json` (nothing in 3.3.0 reads it) and `~/.pi/agent/pi-env.bak` (the
  env var it set is not read in 3.3.0).

- IRP-1/2/3/5 (2026-09-21), one work unit on `fix/inprocess-reviewer-provider-resolution`, uncommitted
  at hand-back. Diff: `lib/inprocess-reviewer.ts` (+41/−6) and `tests/inprocess-reviewer.test.ts`
  (+72/−0); no other source file was touched.
- IRP-1/2/3 TDD sequence, all foreground:
  - Baseline, before any edit: `node --experimental-strip-types --test tests/inprocess-reviewer.test.ts`
    → `tests 30 / pass 30 / fail 0`.
  - RED, tests only: same command → `tests 33 / pass 30 / fail 3`. Observed failures:
    `dispatches through the composed provider's streamSimple when the registry exposes getProvider` and
    `forwards the same context and options to the composed provider as to deps.complete` both failed with
    `expected text, got refusal provider-failed: Reviewer completion failed for review-risk: complete must
    not be called for this refusal` — that is the `unreachableComplete` canary proving the dispatch still
    went to pi-ai's compat path. `refuses instead of falling back when getProvider returns undefined for a
    model find() resolved` failed with `actual 'provider-failed' / expected 'model-not-found'`.
  - GREEN, after `lib/inprocess-reviewer.ts`: same command → `tests 33 / pass 33 / fail 0`.
- `node --experimental-strip-types --test tests/review-host-relay.test.ts` → `tests 43 / pass 43 / fail 0`.
- `pnpm run typecheck` → `types: 196 recorded diagnostic(s), no regressions; 3 file/code pair(s)
  improved`, byte-identical to the pre-edit run. A direct `tsc -p tsconfig.json` filtered for
  `reviewerRegistry|InProcessReviewerRegistry|inprocess-reviewer|review-host-relay` reports only the two
  pre-existing `tests/review-host-relay-routing.test.ts` diagnostics already in the baseline. That is the
  assignability proof for the widened seam: `ctx.modelRegistry` reaches an `InProcessReviewerRegistry`
  parameter at `extensions/gentle-ai.ts:8888`/`:8931` through `:7397` and `:6766` with no cast and no new
  diagnostic, so the real `ModelRegistry.getProvider` satisfies the optional member and the
  composed-provider path is live in production, not only under the fakes.
- `pnpm test` → exit 0; `tests 3000 / pass 2962 / fail 0 / skipped 38`, plus
  `gentle-pi provider contract mirror check passed (contract 1.2.0, 9 bundle entries, 2 generated
  baselines, acquisition field-test-local)` and the runtime harness.
- The 30 pre-existing tests passed with the `fakeRegistry` helper unedited. The three new tests opt into
  the composed-provider seam by spreading a `getProvider` over it at the call site
  (`{ ...fakeRegistry([...]), getProvider }`), which is exactly what the optional member buys.
- IRP-4 risk confirmed concretely while implementing, not deferred as theory. pi-ai
  `dist/compat.js:190,193` wraps every dispatch in `withEnvApiKey`, and `:145-152` shows it injects only
  when `options.apiKey` is absent or blank. `ModelRegistry.getApiKeyAndHeaders`
  (`dist/core/model-registry.js:30-40`) can legitimately return `{ ok: true, headers }` with **no**
  `apiKey` when `runtime.getAuth` resolves nothing and the compatibility config declares no `authHeader`.
  That exact combination is the regression window: compat rescued it, `provider.streamSimple` will not.
  Second, narrower point for IRP-4: compat reads `getEnvApiKey(model.provider, options?.env)`, and this
  module's narrow seam already drops the real registry's `env` field, so even today's compat path falls
  back to ambient `process.env` rather than registry-resolved env.
  **Superseded by IRP-4:** the first claim is false — see "Settled: the env-API-key delta". The second
  claim stands and is a pre-existing gap on both paths.

- IRP-4 (2026-09-21), `tests/inprocess-reviewer.test.ts` only (+113/−0); **no production file was
  touched**, because Part A proved there is no regression to correct.
- IRP-4 TDD sequence, all foreground:
  - Baseline, before any edit: `node --experimental-strip-types --test tests/inprocess-reviewer.test.ts`
    → `tests 33 / pass 33 / fail 0`.
  - The three new tests passed on first run (`tests 36 / pass 36 / fail 0`): the module already honored
    the contract, so there was no natural RED. Rather than claim one, a **mutation probe** proved the
    tests are not vacuous — `lib/inprocess-reviewer.ts:269` was temporarily changed to
    `...(auth.apiKey === undefined ? { apiKey: process.env.OPENAI_API_KEY } : { apiKey: auth.apiKey })`,
    i.e. exactly the `withEnvApiKey` behavior the superseded reading would have demanded. Observed:
    `tests 36 / pass 33 / fail 3`, all three new tests failing on their own assertion —
    `the module must not invent an apiKey the registry did not resolve, nor read one from the ambient
    environment` / `the fallback path must not invent an apiKey either; compat's own withEnvApiKey is
    pi-ai's business, not this module's` / `neither path may carry an apiKey the registry did not
    resolve`, each `true !== false`. The mutation was reverted with `git checkout --` and the same
    command returned to `tests 36 / pass 36 / fail 0`.
- IRP-4 verification: `node --experimental-strip-types --test tests/review-host-relay.test.ts`
  → `tests 43 / pass 43 / fail 0`. `pnpm run typecheck` → `types: 196 recorded diagnostic(s), no
  regressions; 3 file/code pair(s) improved`, byte-identical to the IRP-1/2/3/5 run. `pnpm test`
  → exit 0, `tests 3003 / pass 2965 / fail 0 / skipped 38` (+3 against the IRP-1/2/3/5 run of 3000/2962,
  exactly the three new tests), plus the provider contract mirror check and the runtime harness.
- The new tests set and restore a single synthetic `OPENAI_API_KEY` placeholder around the call, the
  established save/mutate/restore pattern already used in `tests/gentle-ai.test.ts` and
  `tests/model-routing-authority.test.ts`. The value is asserted **absent** from the forwarded options,
  never printed, and it is the variable name compat would read for the default fake model's provider,
  which is what makes the assertion mean something.

## Audit: is the incoherence guard reachable?

Asked before IRP-4, because a guard that refuses a working configuration would be a regression the
e2e could not see. `getProvider` is keyed by provider id; `completeSimple`'s fallback was keyed by
api (`getApiProvider(model.api)`). Different keys, so the question was real.

**Verdict: not reachable. The guard is safe.** The invariant holds by construction, not by survey:
`ModelRegistry.find` and `ModelRegistry.getProvider` both delegate to one `ModelRuntime` and one
pi-ai `Models` instance, and `getModels(provider)` returns `[]` for a provider id absent from that
map. So `find(p, id) !== undefined` implies `getProvider(p) !== undefined`. There is no second
catalog. Every insertion path (builtins, `models.json`, radius, native extension provider,
`ProviderConfigInput` extension provider, OAuth) keys on the same provider id.

A custom provider id riding a builtin api is representable in `models.json`, but the same declaration
that makes the model findable also registers the provider, and pi's composer falls back to the
identical `getApiProvider(model.api)` internally — so that case is not divergent either.

**Hardening applied anyway (behaviourally identical today):** the lookup now keys on
`parsed.provider`, the key `find` was called with, instead of `model.provider`, a field of the object
`find` returned. `find` filters only on `model.id`, so keying on the returned field would make the
guarantee depend on every provider's `getModels()` echoing its own id — which a native or
OAuth-`modifyModels` extension provider is free not to do. Keying on the call argument makes the
branch unreachable by construction rather than by survey. A `getApiProvider`-style fallback was
explicitly rejected: it would reintroduce exactly the extension-provider blindness this change fixes.

**This audit also revises the IRP-4 risk, and the two sources disagree.** The implementer reported
`withEnvApiKey` as a live regression window; this audit finds it redundant, because pi's own auth
resolvers already read `process.env` through the auth context and `getApiKeyAndHeaders` runs before
the call. IRP-4 settles it with a test, not by picking a side.

## Settled: the env-API-key delta

**The audit was right; the implementer's "real regression window" reading was wrong.** For a builtin
provider whose only credential is an environment variable and which has no stored credential,
`getApiKeyAndHeaders` returns `{ ok: true, apiKey }` — it resolves the key itself. `withEnvApiKey`
therefore has nothing left to rescue on that path, because compat's injection is conditional on
`options.apiKey` being absent or blank (`@earendil-works/pi-ai/dist/compat.js:145-152`), and it is
not absent.

Read path, from the installed bytes:

- `@earendil-works/pi-coding-agent/dist/core/model-registry.js:30-46` — `getApiKeyAndHeaders` calls
  `this.runtime.getAuth(model)` and returns `apiKey: resolution.auth.apiKey` (`:42`) whenever that
  resolves. Only when it resolves nothing (`:33`) does it fall through to the compatibility config
  and return `{ ok: true, headers }` with no key (`:38`).
- `@earendil-works/pi-coding-agent/dist/core/model-runtime.js:339-342` — `getAuth` delegates to
  `this.models.getAuth(...)`, where `this.models` is `createModels({ credentials, modelsStore })`
  (`:71`) with **no** `authContext` override.
- `@earendil-works/pi-ai/dist/models.js:33` — with no override, the auth context defaults to
  `defaultProviderAuthContext()`; `:275-281` routes `getAuth` into `resolveProviderAuth`.
- `@earendil-works/pi-ai/dist/auth/resolve.js:51-54` — the ambient branch: with no stored credential
  it calls the provider's `ApiKeyAuth.resolve` with `credential: undefined`.
- `@earendil-works/pi-ai/dist/auth/helpers.js:21-26` — `envApiKeyAuth` then loops the provider's env
  var names and returns `{ auth: { apiKey: value } }` for the first one set.
- `@earendil-works/pi-ai/dist/auth/context.js:19-24` — that `ctx.env(name)` is `process.env[name]`.
- `@earendil-works/pi-ai/dist/providers/openai.js:10` declares
  `envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"])`, the same name compat's map carries at
  `dist/env-api-keys.js:77`. Sampled matches across the catalog: `groq.js:10`/`GROQ_API_KEY`,
  `google.js:10`/`GEMINI_API_KEY`, `huggingface.js:10`/`HF_TOKEN`,
  `github-copilot.js:14`/`COPILOT_GITHUB_TOKEN`, `deepseek.js:10`/`DEEPSEEK_API_KEY`.

Runtime confirmation (throwaway probe against the installed package, deleted afterwards; it asserted
only on presence/absence and variable names, never on any value, and it scrubbed every candidate name
from its own environment first so no real credential was consulted). For each of the 38
provider/env-var pairs in compat's map (`dist/env-api-keys.js:63-111`), it set that one synthetic
variable, built a `Models` with the builtin providers and an empty credential store, and compared
`models.getAuth(model)` against `getEnvApiKey(provider)`:

- **36 of 38 resolved an `apiKey` through the registry**, each reporting `source` equal to the very
  env var compat would have read.
- The two apparent divergences were both Cloudflare, and both were an artifact of the probe setting
  only `CLOUDFLARE_API_KEY`: Cloudflare auth also requires the account id (and the gateway id for the
  gateway provider), `dist/providers/cloudflare-auth.js:20-32`. With the full set:
  `cloudflare-workers-ai` resolves `apiKey` normally, and `cloudflare-ai-gateway` resolves
  header-only auth (`cf-aig-authorization`, plus explicit `Authorization: null` / `x-api-key: null`)
  — i.e. the registry deliberately authenticates it by header.

Answers to the three questions, precisely:

1. **It returns an `apiKey`.** `{ ok: true }` with no key happens only when `getAuth` resolves
   nothing at all (env var unset — in which case compat finds nothing either) or when the provider
   authenticates by header rather than by key.
2. **No other mechanism is needed, because the key is already there.** In the two header-auth cases
   the credential travels as `headers`, which this module forwards. There is no case where the
   request leaves unauthenticated under the composed provider but authenticated under compat.
3. **Same names, slightly different order, and the registry is the stronger of the two.** For
   `anthropic`, compat deliberately skips `ANTHROPIC_AUTH_TOKEN` (`dist/env-api-keys.js:67-68,123`)
   and takes the first of `ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`; pi's resolver checks
   `ANTHROPIC_AUTH_TOKEN` first and turns it into an `Authorization: Bearer` header
   (`dist/providers/anthropic.js:21-27`) before falling through to the same two key vars. Probed:
   with only `ANTHROPIC_AUTH_TOKEN` set, the registry resolves header auth and compat's
   `getEnvApiKey` finds nothing — the registry is strictly more capable. The one shape difference
   that favors compat is degenerate: a blank-but-set variable. `ctx.env` requires
   `trim().length > 0` (`dist/auth/context.js:23`) while `getProviderEnvValue` is plain truthiness
   (`dist/utils/provider-env.js:37-42`), so a whitespace-only `OPENAI_API_KEY` yields no registry
   auth but would have been injected verbatim by compat (probed: `registryResolved=false`,
   `compatGetEnvApiKeyFound=true`). That "rescue" ships whitespace as a credential and 401s; losing
   it is not a regression.

**Consequence: no production change.** `lib/inprocess-reviewer.ts` was not touched for IRP-4. Adding
an env-key fallback would have contradicted the module's "never reads `process.env`" contract
(`:179`) to solve a problem that does not exist.

**Residual, pre-existing and unchanged by this task:** the narrow seam drops the registry's `env`
field (`model-registry.js:45`), which `cloudflareStreams` needs to materialize the account/gateway
placeholders in the model `baseUrl` (`dist/providers/cloudflare-stream.js:5-9`). Cloudflare models are
therefore undispatchable through this module on **both** paths, before and after this change. Same
follow-up bucket as the dropped `baseUrl`, not a regression introduced here.

## IRP-6 verification (parent-observed, on `eb96a6c0`)

- `pnpm run test:maintainer` — `tests 34 / pass 29 / fail 0 / skipped 5`. The matrix that prompted the
  original concern passes: `registerFauxProvider` injects into pi-ai compat's registry, and the
  maintainer fakes carry no `getProvider`, so they take the `deps.complete` fallback exactly as the
  optional-member design intended. `armed positive-lens: runMatrix completes end-to-end through the
  in-process reviewer registry against a stub gentle-ai binary` passes. The 5 skips are pre-existing
  and env-gated (`GENTLE_PI_MAINTAINER_BASELINE_BINARY`, `GENTLE_PI_MAINTAINER_CAPABLE_BINARY`,
  `provider-relay.maintest.ts:18-32`); they require maintainer-supplied binaries this machine does not
  have and are unrelated to this change.
- `pnpm test` — `tests 3003 / pass 2965 / fail 0 / skipped 38`, plus
  `gentle-pi provider contract mirror check passed (contract 1.2.0, 9 bundle entries, 2 generated
  baselines)`. Baseline before this change was 3000/2962; the +3 are the IRP-4 tests.
- `pnpm run test:harness` — exit 0 (run separately so the exit code was not masked by a pipe).
- `pnpm run typecheck` — exit 0, `196 recorded diagnostic(s), no regressions; 3 file/code pair(s)
  improved`. Byte-identical to the pre-change run.

Every acceptance criterion except the e2e one is now met. What remains unproven is only what fakes
cannot prove: that a real extension provider satisfies `streamSimple(...).result()` at runtime. That is
IRP-7.

## IRP-7 setup (build installed, e2e pending)

- `pnpm run check:runtime-modules` — exit 0, `runtime matches TypeScript sources (6 generated
  modules)`. `lib/inprocess-reviewer.ts` is not a generated module, so no regeneration was needed.
- `node scripts/verify-package-files.mjs` — exit 0, `167 files; 69 exact byte-pinned contract
  artifacts for the v3.4.0 runtime`.
- `pnpm pack` on `e8f20fda` produced `gentle-pi-3.3.0.tgz` (its `prepack` re-ran the full suite, the
  runtime-module check and the package-file check, all green).
- The tarball was moved to `~/.pi/local-builds/gentle-pi-3.3.0-e8f20fda.tgz` **before** installing, and
  `~/.pi/agent/npm` now pins `file:../../local-builds/gentle-pi-3.3.0-e8f20fda.tgz`. This is a
  deliberate correction of the earlier mistake IRP-0 had to clean up: the previous local build was
  packed inside the repository, so a branch switch deleted the tarball and left a pin pointing at
  nothing. A path under `~/.pi` is not touched by repository operations, and the commit sha in the
  filename makes it obvious which build is installed.
- Installed build verified to carry the fix: `lib/inprocess-reviewer.ts:216`
  `deps.registry.getProvider?.(parsed.provider)` and `:295` the `streamSimple(...).result()` dispatch.
- Runtime note: gentle-pi manages its own package-local binary at `.gentle-ai/v3.4.0/gentle-ai`. The
  `gentle-ai` on `PATH` (`~/.local/bin`, v3.3.0) is a separate global install. The extension uses the
  managed one, so the earlier `review assess` runs in this document used the PATH binary and were
  informational only.

**Still pending and only the human can do it:** the e2e needs a **new pi session** — not `/reload`,
because a live session already holds the previously loaded module — and a review whose lens routes to
`claude-bridge/*`.

To roll back: `cd ~/.pi/agent/npm && npm install gentle-pi@3.3.0`.

## IRP-7 result (2026-09-22): e2e passed

New pi session (not `/reload`) on the installed `gentle-pi-3.3.0-e8f20fda` build, host model
`claude-bridge/claude-fable-5-1`, lens routing from `~/.pi/gentle-ai/models.json`
(`review-reliability` → `claude-bridge/claude-opus-5`).

- Candidate: committed range `b6188bef..0f4b59e2` on `fix/inprocess-reviewer-provider-resolution`
  (target `sha256:f3eccf13…`, 3 paths, 695 changed lines, tier **medium**, one lens).
- Lineage `review-a8874051b62f9776`: START → STATUS `collect` → `gentle_review_capture_group`
  forecast (`pi_host_relay`, 1 model run) → acknowledged run → `state: approved`,
  `submitted_reviewers: 1`, prompt 60,980 bytes, result 8,110 bytes → acknowledge-approved,
  authority burned. No `No API provider registered for api: claude-bridge` anywhere.
- Negative control that makes the run meaningful: `~/.pi/agent/auth.json` holds no provider
  credentials and no `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` is set. pi-ai's compat path had nothing
  to fall back to, so the only route that could have completed this lens is the extension-registered
  provider reached through `registry.getProvider(...).streamSimple(...).result()`.
- Advisory findings (non-blocking, review approved): `R3-getprovider-unguarded`
  (`lib/inprocess-reviewer.ts:216`, suggestion), `R3-provider-key-indistinguishable`
  (`tests/inprocess-reviewer.test.ts:503`, warning), `R3-provider-path-failure-untested`
  (`lib/inprocess-reviewer.ts:295`, warning), `R3-seam-contract-comment-contradicts`
  (`lib/inprocess-reviewer.ts:30`, suggestion). The last one was fixed right after the review (the
  seam header now says `find`/`getApiKeyAndHeaders` are required and `getProvider` is optional and
  selects the dispatch path); the other three are candidates for the PR description or a follow-up,
  not for reopening this candidate.

Environment blocker found and cleared on the way (not a defect of this fix):

- `review start`/`status` stopped with `managed_assets_outdated` and `gentle-ai sync --agent pi` did
  not clear it. Root cause: `~/.gentle-ai/state.json` was being rewritten back to
  `installed_binary_version: 3.3.0` after every sync by the **PATH** `gentle-ai` (3.3.0 at
  `~/.local/bin`), invoked by the Claude Code hooks in `~/.claude/settings.json` that pi-claude-bridge
  honors through the Claude Agent SDK. The gentle-pi managed binary is 3.4.0, so the two fought over
  the state file.
- Fix applied: `~/.local/bin/gentle-ai` replaced with the managed 3.4.0 binary (sha256 `309d9aaf…`,
  identical to `.gentle-ai/v3.4.0/gentle-ai`); the 3.3.0 copy is kept at
  `~/.local/bin/gentle-ai-3.3.0.bak`. A full `gentle-ai sync` then left `state.json` at 3.4.0 and it
  stayed there. Roll back with `mv ~/.local/bin/gentle-ai-3.3.0.bak ~/.local/bin/gentle-ai`.

## Native review boundary

Receipt-driven development is **on** (decided by global). Per work-unit commit:

- `aa964db4`, `a0130b50` — documentation only, passive, structural readback only. Boundary advanced.
- `60f9d4e6` — `gentle-ai review assess --base-ref aa964db4 --committed-only` returned `risk: medium`
  (`executable_change` on `lib/inprocess-reviewer.ts`, 3 paths, 193 changed lines). Medium **defers to
  the PR slice**: the candidate is the range accumulated since `aa964db4`, and the native preflight
  STATUS runs at slice close (after IRP-4 and IRP-6), not per commit. Outcome so far:
  **deferred to slice**.

- Slice close (2026-09-22): lineage `review-a8874051b62f9776` over `b6188bef..0f4b59e2`, tier
  medium, `review-reliability` via `pi_host_relay`, **approved and acknowledged**, authority burned.
  Four advisory findings recorded under "IRP-7 result". Outcome: **approved**.

The next reviewed boundary becomes the base for whatever follows the slice.

## IRP-8 audit (2026-09-22): blocked on the issue gate

- Rebased onto `upstream/main` at `ba985f50` (gentle-pi 3.5.0, 28 commits ahead of the old base)
  with no conflicts; none of those commits touch `lib/inprocess-reviewer.ts`,
  `tests/inprocess-reviewer.test.ts` or `lib/review-host-relay.ts`, and none reference #1304. After
  the rebase: focused 36/36, relay 43/43, `pnpm test` 3174/3136 pass/0 fail/38 skipped, typecheck
  byte-identical (196 recorded, no regressions).
- **Issue gate not met.** #1304 carries no `status:approved` label (nor do #1190, #757, #831). The
  branch-pr policy and the PR validation workflow both require it, so the PR is not opened yet. Two
  independent reproductions with root cause are already on the issue (salgozino, marky1987). Next
  humane action: ask a maintainer for approval on #1304, then open the PR.
- **Conflicting authority line: PR #1318** (`fix/1307-deepseek-relay-retry`, carlosmoradev, based
  on the same `b6188bef`). It wraps the very `deps.complete(...)` line this fix replaces in a bounded
  retry loop and edits the same test file; `git merge-tree` reports content conflicts in both files.
  The two are causally independent (retry policy vs dispatch target), so neither supersedes the
  other: whichever lands second rebases, and the retry loop must wrap the composed-provider call,
  not only the fallback. Named in the PR body so the maintainer sequences them.

## Next step

IRP-8: once #1304 is `status:approved`, push the branch and open the PR upstream against `Gentleman-Programming/gentle-shell` linking #1304, #1190, #757
and #831, naming the design-bug framing, and listing the four advisory findings from the slice-close
review as follow-up candidates. Every acceptance criterion, including the e2e one, is now met.
