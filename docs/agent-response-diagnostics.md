# Content-free child response observations

`ResponseDiagnostics` projects **SDK-normalized RPC events** into bounded counts.
It is a diagnostic building block, not a verifier, transport tap, or replacement
for the existing task outcome and usage-telemetry paths. The subagent runner feeds
it every child RPC event except command responses, and keeps a private local record when a task does not
complete; see [Local failure records](#local-failure-records).

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

## Local failure records

When a subagent task ends in any status other than `completed`, the runner
calls `RunnerHooks.onResponseDiagnostic` once with a frozen
`gentle-pi.response-diagnostic/v1` record. Gentle Agents writes it, fire and
forget, to `<agent home>/gentle-agents/diagnostics/<epoch-ms>-<task id>.json`.

- Fields: task id, agent name and **requested** model label (allowlisted
  characters, otherwise `null`), status, a closed failure category, the
  runner's closed terminal-error category for an assistant error (for example
  `rate_limit`; otherwise `null`), start/end
  times and duration, the number of assistant responses observed, whether
  `agent_settled` arrived, and the last `ResponseDiagnostic` (or `null`).
- Categories: `empty_report`, `assistant_error`, `assistant_aborted`,
  `start_failed`, `exited_before_settle`, `cleanup_unconfirmed`, `cancelled`,
  `timed_out`, `other_failure`. The error text itself is never stored.
- The directory is `0700` and files are `0600`, written to a temp file and
  renamed. A symlinked directory, an oversized record (over 16 KiB) or any I/O
  error makes the write resolve `false`; it never throws.
- After each write, records older than 7 days are removed, then the oldest
  until the directory holds at most 10 MiB of records. Files the store did not
  name are left alone.
- It is separate from task history, transcripts and usage telemetry: it does
  not depend on metrics consent and is never sent anywhere. Recording never
  changes a task's status, error or waiters; a record is not an approval.

## Offline check

```sh
env -u NODE_TEST_CONTEXT node --experimental-strip-types --test \
  tests/agents-response-diagnostics.test.ts tests/agents-response-diagnostics-store.test.ts
```

Tests use synthetic events, including private-data sentinels, malformed fields,
partial coverage, counter limits and unchanged public task outcomes. No model,
provider, real session history, network connection or filesystem store is used.
