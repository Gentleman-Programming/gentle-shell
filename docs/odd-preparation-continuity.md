# Reuse continuity during specified work

Refs #3078. This is a bounded instruction improvement, not a reproduction or closure of the reported multi-hour preparation delays.

The Shell-owned lazy memory guidance previously required reading both persisted copies back after every task-transition save, even when the save explicitly succeeded. An Engram full-observation read emits the feature document again. Initial implementation/recovery still needs reconciliation; an intact continuation should reuse its established task, route and applicable proof.

After a successful local update and an explicit, complete save acknowledgement, the guidance now permits targeted inspection of the changed local task/log lines without routinely rereading both full copies. It still saves the full mirror at the existing task-transition cadence. Missing, partial, truncated, failed or uncertain acknowledgements require checking which writes applied before retrying. A payload the memory tool cannot preserve remains pending instead of being resent unchanged. External edits, new scope, stale evidence or lost context require inspecting affected state; recovery still reads the actual file and full observation. A progress question does not restart discovery or planning.

## Bounded read-volume accounting

Source: `42c68c46859f1724ce9179d8781dd4ee35c13a00`, `odd/tasks/review-one-call.md`. Read its exact Git blob as UTF-8 bytes; it has existing Specs and Tasks sections. Its body is **22,837 bytes**. For one already specified unit, starting and finishing are two mirror transitions:

| Quantity | Before | After explicit complete acknowledgements |
| --- | ---: | ---: |
| Required routine full-mirror readbacks | 2 | 0 |
| Repeated document-body bytes from those readbacks | 45,674 | 0 |

This accounts only for removed mandatory mirror reads, excluding protocol envelopes. Targeted local inspection, full mirror writes and initial/recovery reads remain. Tools may expose extra bytes or clip outputs. This is instruction-volume accounting, **not an observed agent run, model-compliance result, token-cost measurement or latency benchmark**. It does not establish the cause or duration of the original incidents. Available local project sessions predate the November reports and were not treated as reproductions.

No new telemetry, framework, budget, agent, tracking artifact, approval or authority layer was introduced. No memory records were created for the accounting fixture. Existing consent, verification, delivery and correction limits are unchanged.

## Validation

The existing prompt-diet and work-continuity suites pass (17 tests). They check instruction contracts and parent prompt delivery, not model choices. The always-on prompt and provider-owned mirrored routing are unchanged. A representative real task trace is still needed to measure time to the first useful edit, repeated reads/consultations and redundant verification, and to decide whether other causes remain.
