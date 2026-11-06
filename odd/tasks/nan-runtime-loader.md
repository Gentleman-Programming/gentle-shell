# NaN Runtime Loader: Coverage, Not a Root-Cause Fix

## Objective and boundary

Cover the cold **real extension loader → registered native provider → consumed stream** path for
`nan/deepseek-v4-flash`. The original interactive missing-module error was **not reproduced**;
production code remains untouched. On the inspected `ab60cb45` baseline, 20 provider tests covered
catalog/auth behavior and a direct extension import, not runtime loader streaming.

Changed files: `tests/nan-provider-runtime.test.ts` and this task record only.
The runtime tests use synthetic transport and credentials; active settings and production modules
remain unchanged. This is coverage-only work, not a production RED/GREEN lifecycle claim.

## Verified cold path

- Six fresh-process cases: text, HTTP 503, and tool calls, each with the default filesystem-cache
  environment (`JITI_FS_CACHE` omitted) and with `JITI_FS_CACHE=false`. The SDK chooses its default
  cache location. `TMPDIR`/`TMP`/`TEMP` confine only the `os.tmpdir()` fallback to the workspace;
  they do not override an SDK-local cache. No isolated or historically clean cache is claimed.
- Real `DefaultResourceLoader` and `SettingsManager.inMemory`, empty packages, explicit local
  `extensions/nan-provider.ts`, automatic extension/resource/context discovery disabled.
- Temporary workspace/agent directory, sanitized child environment, no session/history or auth
  store. Global fetch rejects and counts unexpected calls; only injected synthetic HTTP/SSE
  responses are accepted. Global fetch is restored and only the temporary workspace is cleaned
  in `finally`; cleanup of SDK-local/default cache outside that workspace is not promised.
- Text: split `NAN_OK` deltas, balanced text start/end, input/output/total usage 3/2/5, one terminal
  `done`, stop reason `stop`, and completed message identity.
- HTTP failure: synthetic 503 becomes one terminal `error` with the expected error message;
  exactly one request proves retries stay disabled (`maxRetries: 0`).
- Tools: transcript `toolsAdded` converts to an OpenAI function schema; split JSON arguments
  yield parsed `{ city: "Paris" }`, tool-call start/delta/end, usage, and `toolUse` completion.
- SDK resolution uses `import.meta.resolve('@earendil-works/pi-coding-agent')`, then its stable
  sibling `dist/bundle/index.js` when present; otherwise reports unbundled entry honestly.
  `NAN_RUNTIME_SDK_ENTRY` explicitly selects another SDK file. No hashed chunks, hardcoded machine
  paths in the test, or silent skips. Each case reports SDK version, layout, and entry.

## Original baseline evidence (`ab60cb45`)

- Independent verification corrected a cache-evidence bug: a raw directory path in
  `JITI_FS_CACHE` is invalid JSON for Pi 0.99.2's boolean parser and falls back to enabled, not
  an isolated cache directory. Default cases now omit the variable; disabled cases use `false`.
  This corrects the test/environment claims only, not production behavior.
- Initial focused run: 24/26 passed. Two tool fixtures used `tools` instead of the transcript's
  `toolsAdded`; correcting the fixture resolved them. This was test authoring feedback, not a
  reproduction of the original missing-module error and not production RED evidence.
- `node --experimental-strip-types --test tests/nan-provider.test.ts tests/nan-provider-runtime.test.ts`
  — 26/26 passed, zero skipped, dependency bundled SDK 1.0.0.
- With an explicit SDK override, the same focused command passed 26/26, zero skipped, against
  the principal installed bundled SDK 0.99.2. To repeat against another installed Pi, set
  `PI_BUNDLED_SDK_ENTRY` to its absolute `dist/bundle/index.js` path, then run:
  `NAN_RUNTIME_SDK_ENTRY="$PI_BUNDLED_SDK_ENTRY" node --experimental-strip-types --test tests/nan-provider.test.ts tests/nan-provider-runtime.test.ts`.
- `node scripts/check-types.mjs` — exit 0; 187 recorded diagnostics, no regressions;
  11 file/code pairs improved relative to recorded baseline (baseline untouched).
- Read Pi 0.99.2 `docs/extensions.md` completely, relevant provider/package/configuration/settings/
  SDK references, and provider plus SDK extension/settings examples before implementation.

## Integration and delivery evidence

Work-unit reference: `test/nan-runtime-loader-01a102af`, rebased onto `main` at `6c844d7d`.
This is follow-up streaming coverage for approved issue #1569, not closure of the historical
missing-module report. Only the new runtime test and this record differ from that baseline.

| Check | Result after integration |
| --- | --- |
| Focused provider and runtime tests, bundled SDK 1.0.0 | 30/30 passed, zero skipped |
| Same focused command with the installed SDK 0.99.2 override | 30/30 passed, zero skipped |
| Typecheck baseline ratchet | Exit 0; 186 existing diagnostics, no regressions |
| Provider contract | Passed, contract 1.2.0 |
| Full unit stage | 4,683 tests: 4,637 passed, 2 failed, 44 skipped |
| Full provider-contract and runtime-harness stages | Both passed |

`pnpm test` stopped before running stages because its bootstrap tried to replace the shared
modules link and aborted with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`; no install override
was used. All three stages were then executed by `scripts/run-test-suite.mjs` with a temporary
stage configuration using the package scripts' Node equivalents, without pnpm bootstrap.

The two failures are `tests/agent-home.test.ts:36` (temporary HOME/config-home assertion) and
`tests/gentle-ai-dev-binary-surfacing.test.ts:202` (unexpected startup override announcement).
Both signatures also occur on clean baseline `6c844d7d` under the same inherited environment:
the two-file comparison ran 9 tests, 7 passed and 2 failed, with zero skips. This establishes
baseline occurrence, not their root causes or full baseline-suite health. All six new NaN
runtime cases passed in the full candidate run.

The PR remains a draft while full-suite/CI blockers are unresolved. No suite-green, production
fix, native review closure, or merge authorization is claimed.

## Prior parent evidence (not rerun here)

A separate temporary offline probe loads real bundled SDK loader/settings, registers both
configured local/package extensions, and consumes native provider streaming.
Parent reported passes with default cache and disabled filesystem cache, and both registrations.
Parent separately reported a live response: HTTP 200, exact `NAN_OK`, start/thinking/text/done,
stop reason `stop`, one request with retries disabled. The live script was not read or executed here.
Parent reported provider-contract validation passed (contract 1.2.0, nine entries, two baselines).
Historical logs reported two actual assistant `stopReason: error` events for
`nan/deepseek-v4-flash` on Oct 3 at 16:24:39 and 16:30:58, in a session created Sep 29 at 16:00:33.
Session creation is not process lifetime; these events do not reproduce the missing-module cause.

## Remaining blocker and follow-up

The original error referenced absent `openai-completions-OBX42CLD.js` from absent
`chunk-OJP47DM6.js`. Current loader/stream tests pass; that does not identify why the original
interactive process referenced those paths. Parent's host start time (2026-10-03 16:54) is later
than the current bundle chunk ctime (2026-09-30 20:02), so an update during that process is not
supported by the evidence. Do not assume a stale update or claim a root cause fixed.

The user confirmed the affected original Pi session is already closed: its in-memory state is
unavailable, so there is no active-session inspection pending and no historical reproduction
claim. Current fresh cold paths pass. Further diagnosis requires a future recurrence with
sanitized module-resolution/stack/runtime-version evidence. That unavailable original state and
lack of recurrence are the follow-up blocker; no speculative production patch or cache/settings
cleanup is authorized.
