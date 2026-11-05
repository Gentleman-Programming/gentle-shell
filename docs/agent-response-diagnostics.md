# Content-free child response observations

`ResponseDiagnostics` projects **SDK-normalized RPC events** into bounded counts.
It is a diagnostic building block, not a verifier, transport tap, or replacement
for the existing task outcome and usage-telemetry paths. Runner integration and
bounded local persistence are separate work; this module alone enables neither.

## Contract

Create one observer per child and pass parsed RPC records to `observe(record)`.
An assistant `message_end` returns an immutable `ResponseDiagnostic`; other
records return `undefined`. The completed content is measured separately from
streamed text. Streamed text never substitutes for a missing final report.

- `boundary` is always `sdk_rpc`, never upstream HTTP or SSE.
- `stream: null` means no usable streaming observation. A witnessed assistant
  `message_start` permits zero received deltas; updates without a start are
  labelled `partial`. Malformed updates invalidate coverage rather than imply zero.
- Counts measure received RPC updates and UTF-16 code units, not unique provider
  chunks, bytes, tokens, or text quality. Every counter saturates at 1,000,000
  and sets `saturated`; no content is buffered.
- `finalContent` distinguishes text present, empty content, tools without text,
  and other text-free content. Missing/malformed content is `null`. These are
  observations, **not PASS/FAIL verdicts**.
- `sdkStopReason` and `sdkReportedRawStopReason` accept only closed vocabularies.
  The latter is still an SDK field, not independent upstream evidence. Unknown
  strings become `null`; normalized `stop` does not prove an HTTP 200 or an
  intact provider stream.
- HTTP status, transport streaming, terminal marker and upstream stop reason
  remain explicitly unknown. This RPC boundary cannot observe them.

The observer retains numeric counters only and clears them between responses and
at lifecycle boundaries. It does not persist or return prompts, response text,
reasoning, tool arguments, IDs, signatures, errors, model/provider strings,
headers, paths or credentials. It does not duplicate usage-token measurements;
the existing telemetry contract and its treatment of ambiguous zeros stay intact.

## Offline check

```sh
env -u NODE_TEST_CONTEXT node --experimental-strip-types --test tests/agents-response-diagnostics.test.ts
```

Tests use synthetic events, including private-data sentinels, malformed fields,
partial coverage, counter limits and unchanged public task outcomes. No model,
provider, real session history, network connection or filesystem store is used.
