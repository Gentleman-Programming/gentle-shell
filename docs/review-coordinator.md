# Experimental ordinary review coordinator

Enable `GENTLE_PI_EXPERIMENTAL_REVIEW_COORDINATOR=1` before loading the extension to register `gentle_review_run` in a parent session. The tool is absent by default and in managed child sessions. It is model-only and follows the existing direct-call restriction; it is not a codemode entry point.

The coordinator calls the existing wrapped review facade executors. Native mode, host consent, session identity, workspace/base selection, opaque bindings and native admission remain authoritative. It never parses binding strings, invents results, retries a failed capture or authorizes delivery.

For a fresh ordinary review, provide pertinent `lenses` and `lensesReason`, optionally `workspaceRoot`, a committed selector (`baseRef` together with `committedOnly: true`), and an existing `requestContextPath`. [Frozen request intent](review-request-context.md) is accepted only for a fresh transaction. Unresolved consent returns to the host.

The loop follows the native next_transition kind. It runs supported facade execute offers, captures the exact ordered opaque bindings, returns authored input to the model, and surfaces stop unchanged. It never reads native states, reason codes, binding contents or capture closure variants. Facade operations that require additional maintenance authorization return to the caller.

Native correction_request explicitly identifies a plan that needs authored input. The coordinator returns that request to the model without deriving requiresInput metadata from submission domains or changing ordinary STATUS output. Unsupported capture responses return control to the caller. Correction-plan authoring and edits remain explicit handoffs; after an authorized edit, resume with the same lineage and workspace/base selection. Native decides which opaque capture comes next.

The existing capture facade presents the model-run forecast before execution. Every observed forecast is also preserved losslessly in the final forecasts array, including when a later operation refuses. The primary model must relay every entry in the user’s language, preserving all fields and counts. These forecasts are informational, not review consent. A missing display, changed session or disabled mode prevents the run. Accepted captures refresh bound STATUS for the next transition; failed or reoffered captures never retry.

Approval closes through the offered facade acknowledgement. The verified ACK envelope identifies the frozen target and burned authority. There is no post-ACK STATUS, ASSESS or replay, and closure makes no claim about subsequent edits or permission to commit, push or publish.

## Validation and rollout

```sh
node --experimental-strip-types --test tests/review-coordinator.test.ts tests/review-coordinator-runtime.test.ts tests/review-last-event-closure.test.ts tests/rdd-off-native-refusal.test.ts
```

Unit and registered-runtime tests cover opaque binding order, authored input, native stop, state/reason independence, consent, cancellation, mode/session changes, failed or repeated captures, identity drift and terminal ACK without follow-up queries. Runtime fixtures are in-memory authority simulations; they do not claim real native approval.

Historical measurements, candidate identities and their limitations live in [issue #2881](https://github.com/Gentleman-Programming/gentle-shell/issues/2881) and [PR #2884](https://github.com/Gentleman-Programming/gentle-shell/pull/2884). Benchmark data is not shipped in the npm package and does not certify this candidate.

SDK event accounting sees the outer coordinator call. Its returned metrics.steps describe internal facade calls; those direct calls emit no additional tool_call/tool_result or timing events.

Related delivery: [issue #2881](https://github.com/Gentleman-Programming/gentle-shell/issues/2881). Keep the feature default-off until independent security/reliability review and an opt-in real-use pilot complete.
