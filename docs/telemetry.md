# Telemetry

Runtime usage telemetry is best effort: an available usage event gets at most one
asynchronous attempt through `gentle-ai telemetry runtime send --json`. Busy,
failed, disabled, or cancelled attempts are discarded silently. There is no
metrics disk storage, outbox, retry, backoff, cooldown, daemon, or session reconstruction.

The production encoder uses the byte-identical [native schema mirror](../contracts/telemetry/runtime-aggregate-v1.schema.json).
[The synthetic fixture](../tests/fixtures/runtime-metrics-native-batches.json) pins its
SHA-256 and exact one-shot stdin bytes. No old intake fallback is used. These are
fake-subprocess tests, not a live collector or deployment verification.

## Runtime usage flow

1. A finalized primary assistant message or child completion supplies available usage.
   Child-host extensions do not independently consume primary usage.
2. Pi builds event-local sanitized rows, not cumulative session totals. An occupied
   attempt slot discards the event; it never queues it for later.
3. One cancellable immediate defers binary verification and subprocess launch beyond
   the provider callback. The native command owns fresh policy and exactly one POST.
4. Only `stored`, `duplicate`, `discarded`, or `disabled` results are recognized.
   All are terminal. `stored` and `duplicate` reflect collector acknowledgement,
   not client persistence; Pi retains nothing and never retries.

There is no policy or capability subprocess before send, and no ingest or flush call.
The packaged binary is verified; development overrides are refused for runtime usage.
Missing binaries and unsupported commands discard without installation or fallback.

Replacement and shutdown cancel an unstarted attempt or request termination of its
child immediately, without a wait loop or final send. The process slot remains busy
until actual close, preventing overlap even if a cancelled process is slow to exit.
A one-second process timeout requests termination; it is not a retry timer or a hard
bound on synchronous binary verification or event-loop stalls.

## Data and source limits

Wire fields are the schema/registry, host, public model with evidence, available
selected/effective effort, orchestrator or known built-in subagent class, source
launch/response occurrence coverage, six token coverages, explicitly reported typed
duration, and a sanitized error category. Occurrences never represent sessions.
Prompts, responses, code, paths, private names, source IDs, and raw errors never enter
the payload. There is no `batch_id`; native creates the remote `delivery_id`.

One event produces 1–32 rows within 16 KiB. Oversized or invalid events discard
whole rather than splitting into multiple sends. Child launch selection is a separate
row with zero response-token coverage, never substituted for per-response evidence.

- Token coverage distinguishes reported, unavailable, and unsupported values. Pi's
  SDK-positive counters are usable; zero defaults and absence do not prove reported zero.
- Selected model/effort is captured at the request hook, separately from response
  model and effective-effort evidence. Ambiguous request sequences discard selection.
- Pi hooks do not correlate requests/retries reliably, so this adapter does not infer duration.
- Child configuration classification uses packaged built-in definitions, not agent names.
  Launch configuration is not proof of the model or selected effort of each child response.
- Bounded live child observations remain in RAM until completion. No completed child
  event is retained for forwarding. A completion without usage creates no usage send.
- Primary object deduplication uses weak tombstones; copied objects are distinct.
  Child completion tombstones are capped at 256 per extension session. Source IDs
  stay local and are never exported. No session history is read or reconstructed.

## What Gentle Pi does

On activation of a primary session (never for a named agent or an SDD phase executor), Gentle Pi resolves the package-local `gentle-ai` binary (honoring a registered dev-binary override, same as every other native call) and spawns:

```text
gentle-ai telemetry trigger --json
```

- detached, with stdout/stderr discarded (`stdio: "ignore"`);
- a 3 s deadline: a runaway process is killed, but Gentle Pi never waits for it to exit;
- at most once per process, regardless of how many sessions or sub-agents run afterward.

Rate limiting, enrollment, and every opt-out live entirely in `gentle-ai`; calling the trigger once per session start is safe by construction. A missing binary, an older binary without the `telemetry` verb (which prints `unknown telemetry command` and exits non-zero), or a spawn failure are all treated as "nothing to do" and never affect activation or surface an error to the user.

Install counts for `gentle-pi` and `gentle-engram` come from npm download statistics; neither package emits an install event of its own.

## The trigger contract

`gentle-ai telemetry trigger --json` always exits `0` and prints one line of JSON:

```json
{"schema":"gentle-ai.telemetry-trigger/v1","decision":"enrolled|sent_install|sent_heartbeat|rate_limited|backoff|disabled","source":"<deciding source>"}
```

`gentle-ai telemetry status|enable|disable|preview [--json]` exist for the opt-out flow; `status --json` prints `gentle-ai.telemetry-status/v1`. Gentle Pi's `/gentle:telemetry` slash command runs these in the foreground (bounded to 5 s) through the same binary resolver and relays the result.

## Opting out

Any of the following disables the nudge or the underlying telemetry:

- `/gentle:telemetry disable` — asks the local `gentle-ai` binary to disable telemetry. `/gentle:telemetry status` and `/gentle:telemetry preview` inspect it without leaving Pi.
- `DO_NOT_TRACK=1` — Gentle Pi does not spawn the trigger at all; `gentle-ai` also honors this standard independently.
- `GENTLE_AI_TELEMETRY=0` — same effect, `gentle-ai`'s own environment switch.
- `CI=true` — Gentle Pi does not spawn the trigger in automated/CI runs, since they are not a real usage signal.
