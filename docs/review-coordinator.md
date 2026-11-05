# Experimental ordinary review coordinator

Enable `GENTLE_PI_EXPERIMENTAL_REVIEW_COORDINATOR=1` before loading the extension to register `gentle_review_run` in a parent session. The tool is absent by default and in managed child sessions. It is model-only and follows the existing direct-call restriction; it is not a codemode entry point.

The coordinator calls the existing wrapped review facade executors. Native mode, host consent, session identity, workspace/base selection, opaque bindings and native admission remain authoritative. It never parses binding strings, invents results, retries a failed capture or authorizes delivery.

For a fresh ordinary review, provide pertinent `lenses` and `lensesReason`, optionally `workspaceRoot`, a committed selector (`baseRef` together with `committedOnly: true`), and an existing `requestContextPath`. [Frozen request intent](review-request-context.md) is accepted only for a fresh transaction. Unresolved consent returns to the host.

The loop follows the native next_transition kind. It runs supported facade execute offers, captures the exact ordered opaque bindings, returns authored input to the model, and surfaces stop unchanged. It never reads native states, reason codes, binding contents or capture closure variants. Facade operations that require additional maintenance authorization return to the caller.

Public capture metadata exposes only whether authored input is needed, derived from the provider's submission value domains. Unknown metadata returns to the model. Correction-plan authoring and edits remain explicit handoffs; after an authorized edit, resume with the same lineage and workspace/base selection. Native decides which opaque capture comes next.

The existing capture facade presents the model-run forecast before execution. A missing display, changed session or disabled mode prevents the run. Accepted captures refresh bound STATUS for the next transition; failed or reoffered captures never retry.

Approval closes through the offered facade acknowledgement. The verified ACK envelope identifies the frozen target and burned authority. There is no post-ACK STATUS, ASSESS or replay, and closure makes no claim about subsequent edits or permission to commit, push or publish.

## Validation and rollout

```sh
node --experimental-strip-types --test tests/review-coordinator.test.ts tests/review-coordinator-runtime.test.ts tests/review-last-event-closure.test.ts tests/rdd-off-native-refusal.test.ts
```

Unit and registered-runtime tests cover opaque binding order, authored input, native stop, state/reason independence, consent, cancellation, mode/session changes, failed or repeated captures, identity drift and terminal ACK without follow-up queries. Runtime fixtures are in-memory authority simulations; they do not claim real native approval.

The combined experimental implementation was also measured in three alternating original/current correction pairs on Windows, Node 24.14.0, native 4.3.1 and `openai-codex/gpt-6.1-sol` with minimal thinking. The primary drove initial review and corrected resume; consent, inspect/START, correction plan and edit were common scripted actions. All six definitive journeys closed with three real reviewer roles and consumed candidates.

Median paired reductions were 47.07% time, 86.18% tokens and 87.15% runtime-reported model cost. Original/current times were 352.23/186.42, 359.45/184.74 and 358.75/191.44 seconds. Primary calls fell 10 to 2; reviewer count remained three. Seven calibration attempts were excluded and their recorded cost retained separately. These observations are not verified billing or production percentiles.

Those measurements compare the earlier combined prototype (request context, coordinator and Windows ACL batching) against original Shell at `3392d1c6c5230e93dbf0a281765b01162d1f67b8`, on one pinned backend and scenario. They do not measure this coordinator PR alone or certify every path. The published candidate now uses a simpler transition loop, omits the post-ACK readback and restricts the coordinator declaration to model-only; focused checks are tied separately to that candidate. Historical source/result identity: `b19ff9a7ca07222a3e753b56d47af785afdf087df15fee5baf61363f893d1271`.

The [sanitized measurement summary](review-coordinator-experiment.json) preserves all three pairs, aggregate counts, source hashes and the excluded calibration cost without publishing local paths or opaque bindings.

Related delivery: [issue #2881](https://github.com/Gentleman-Programming/gentle-shell/issues/2881). Keep the feature default-off until independent security/reliability review and an opt-in real-use pilot complete.
