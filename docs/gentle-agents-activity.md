# Gentle Agents activity schema (`gentle-agents.activity/v1`)

An interactive RPC host — a client that runs `pi --mode rpc` itself, such as the Gentle Shell desktop app — receives live Gentle Agents subagent state as one bounded JSON document per coalescing window, so it can render a per-chat Helpers view without polling `subagent_status`.

Source map: [publisher](../lib/agents-rpc-publisher.ts), [wiring](../extensions/gentle-agents.ts), [store](../lib/agents-protocol.ts).

## Same-profile orchestrator discovery (Refs #1701)

`orchestrator_list` keeps stable raw routing session IDs and adds recorded display
labels, session workspaces, and up to eight currently owned, unfinished child task
labels/statuses/launch workspaces. This is a metadata-only view, not the RPC payload
below: it exports no prompts, transcripts, thinking, or tool output and makes no
model calls or messaging requests.

Metadata lives in an optional private, 16-KiB derived sidecar, bound to the existing
session hash, presence incarnation/generation, and listener activation. Schema-1
headers are unchanged: missing or invalid sidecars never hide existing activity peers.
Only currently runtime-owned active tasks (running, queued, waiting) are published,
not finished tasks or restored running history: those are not potential future writers.

The transport registry selects its newest advertised activation per session (ties
use its existing deterministic token order). Context joins only that exact routing
snapshot, never another activation sharing its ID. Multiple matching presence headers,
malformed records, missing metadata, or an incomplete bounded scan leave context
unknown without hiding advertised peers. Recent means the existing 15-second presence
heartbeat window, not verified reachability. Stale records expose no context.
Reachability remains unknown even with recent metadata.

Paths longer than 120 characters or requiring control-character normalization are
unknown rather than misleadingly shortened. Labels are sanitized and bounded to
120 characters; duplicate labels do not merge IDs. Additional child tasks are
counted as omitted. Task workspaces are recorded launch directories, not proof of
isolation, ownership locks, or exclusive access.

### Declare a recognizable subject

When starting a task or delegation, call `orchestrator_session_id` with a short,
non-sensitive `subject`; no peer survey or additional model call is needed. The tool
returns the stable routing ID and current canonical alias. It uses Pi's
`setSessionName` only when the canonical name is empty, preserving existing names
and later human renames. Subjects are control-stripped, whitespace-normalized, and
bounded to 120 Unicode characters. Do not supply arbitrary prompts or secrets.
Aliases are display hints, never authentication or routing identities.

Presence reads the current canonical Pi name on its existing five-second heartbeat,
including idle `/name` or session-picker renames; declaration refreshes it immediately.
An unnamed session retains its workspace-basename display fallback. Session replacement
or shutdown disposes the previous publisher; a stale name source stops publication.
Headers remain unchanged; the optional sidecar now also carries `scope`.

### Publish curated state (Refs #1702; first slice)

`orchestrator_session_id` also accepts optional `state`: strings named `objective`,
`progress`, `decisions`, and `blockers` (2,048 UTF-8 bytes total). An object replaces
all fields, `null` withdraws, and omission leaves the current record unchanged.
Extra keys, controls, and oversized input are rejected before naming or persistence;
records additionally fit 4 KiB. Never include credentials, internal instructions,
or raw prompts. Whitelisting is not automatic secret redaction.

Pi's public `appendEntry` persists a non-context custom record on the active branch.
Only that branch's latest typed record is restored on start/reload/tree navigation;
malformed or foreign records suppress older notes. Manager replacement and shutdown
clear the cache. Conversation bodies, system prompts, results, and compaction summaries
are never inspected to derive these notes. Stable reads/heartbeats do not scan history.

Targeted `orchestrator_list` readback exposes detached historical notes, generated
stable owner ID, recorded cwd (or null), and `recordedAt`, not heartbeat freshness.
Cwd must be native absolute, control/surrogate-free, at most 1,024 UTF-8 bytes,
and free of the 15 normalized Unicode separators listed below. Invalid generated
cwd becomes null; malformed non-null readback withholds the note, never rewrites paths.
Source is `owner-curated`, `ownerReply: false`, `authority: none`: even `decisions`
is data, never a grant or human consent. Missing/invalid/over-budget notes are unknown;
withdrawal remains explicit null. Advertising is best-effort; legacy headers/activity
stay unchanged. Direct metadata consultation is available below; reasoning and correlated
owner decisions remain later units. Public-SDK acceptance is recorded below. Neither issue is closed.

### Consult a published snapshot

Call `orchestrator_consult` with required stable `recipient_session_id`, optional
`kind: "metadata"` (the only kind), and optional existing opaque catalog `cursor`.
No free-form question, owner request, human picker or read-consent dialog is used
for this profile's explicitly published data. Use `orchestrator_session_id.state`
to publish short updates before delegation or meaningful progress milestones when
helpful; do not add a model turn solely to publish or emit per-tool/token updates.

The JSON receipt is deeply detached and frozen in-process, at most 16 KiB. It
contains public label/workspace, owned task summaries, recorded scope, one catalog
page, historical curated state, observation time and presence freshness. Missing
notes/scope are explicitly unknown; withdrawn notes remain an explicit null record.
Counts and continuation identify listing gaps. Over-budget snapshots are unavailable,
never silently truncated. Missing/stale/ambiguous publications and invalid cursors
are unavailable, not owner refusals. Refresh from page one after public changes.

`digest` binds captured public content to the selected activation and incarnation;
it excludes private activity digests/generation and observation clocks. Heartbeat
recency is not proof of current notes, Git resolution, reachability or global writer
ownership: state `recordedAt` and scope `resolvedAt` keep their historical meaning.
The source is `published_snapshot`, `ownerReply: false`, `authority: none`.
This is not native consent, a review receipt or a correlated owner decision.
No transcripts, prompts, threads, results, instructions, profile credentials or
transport capabilities are exported. No new Git probes, messages, receiver wakes,
child/helper launches or model calls occur. The reasoning helper lane is unavailable.

### Public-SDK acceptance fixture

`tests/orchestrator-consultation-sdk.test.ts` uses installed Pi SDK 1.0.0:
`DefaultResourceLoader`, `createAgentSession`, `bindExtensions`, local
`registerProvider` streaming and `session.prompt`. Two separate managers/cwds
share one trusted fixture profile; a third fresh session tests owner replacement.
Production Gentle Agents/Shell extensions supply the actual registered tools.
No private SDK invocation, fabricated tool context or transport adapter is used.

The fixture proves curated branch persistence, preserved human names, frozen
non-authoritative readback, actual private-message exclusion, opaque pagination
for nine then ten Git worktrees, public membership invalidation, unchanged-private-
history continuation, explicit null withdrawal and fresh replacement unknowns.
Driver tool/final model turns are intentional local iterations; consultation adds
no receiver model calls or Git probes during the business tool execution. Shell
prompt setup still probes Git. No child execution or 1,000-projection claim is made.

Outputs have two explicit ownership selectors: a private OS-temp fixture root
(profile, settings, credentials/model storage, sessions and Git), and production's
unique `/tmp/gentle-pi-<uid>/<profile-hash>` socket leaf. The fixture checks absence
before startup, private ownership/canonical containment, and actual socket paths.
Cleanup aborts sessions and invokes captured production public shutdown handlers
with actual SDK contexts before dispose (dispose alone does not emit shutdown).
It waits boundedly for presence withdrawal/empty sockets, revalidates ownership,
then removes only the exact empty leaf, never its UID parent or historical leaves.
The owned root is removed afterward; post-cleanup absence is checked. Windows is
explicitly skipped. This is not interactive TUI, human consent, native review,
Windows execution, reasoning-helper acceptance or issue-closure evidence.

### Recorded repository scope

Scope reuses `resolveSessionWorktree`: canonical Git root plus a SHA-256 hash of
canonical common-directory identity, with ambient `GIT_*` routing excluded. Sibling
worktrees share a clone hash, not a root; separate clones differ. No remote URL or
credential is read, and neither names nor scope grants authority. Non-Git, missing,
or unsafe paths are unknown, never guessed or shortened (scope paths: 256 bytes).
Literal scope paths containing NBSP, U+2000–200A, U+202F, U+205F or U+3000 are
unknown: the shared spelling resolver maps them to ASCII space and could otherwise
select a different existing repository. Input, resolved-root output and sidecar
readback all reject them. Ordinary spaces and Unicode letters remain supported.

`scope.host`, child `repository` facts keyed by task ID, and up to eight `registered`
facts carry `source: recorded-workspace/git` and `resolvedAt` (resolution attempt
time, not heartbeat age). Registered roots come from the existing session registry's
durable entries, not another registry. Missing/pruned registrations resolve unknown.
One bounded derived snapshot caches successful and unknown resolutions by actual Pi
cwd, admitted launch cwd/membership, and registered roots. Lifecycle changes and
session replacement invalidate it; stable token updates/heartbeats do not probe Git.

`omittedTasks`, `omittedRegistered`, and `complete` describe listing bounds. If the
sidecar byte budget cannot fit scope lists, both lists are withheld with exact
omission counts while retaining host context. Bounded recorded-path continuation
is described below; Git facts beyond the existing prefix remain unknown. #1701 stays open.
New readers accept legacy sidecars without scope. Old strict optional-sidecar
readers may show unknown discovery context; activity visibility is unchanged.
Malformed scope alone falls back to unknown repository facts without hiding IDs.

Recorded launch directories do not prove current child cwd or freedom from shared
artifacts. A shell `cd` does not change Pi's session cwd. Omission counts mean the
child list is incomplete, not an exhaustive writer inventory. This metadata cannot
answer arbitrary reasoning questions (#1702).

### Continue recorded metadata

Call `orchestrator_list` without arguments as before. Each recent peer can also
carry `catalog`: eight child summaries (`id`, `label`, `status`, actual recorded
launch `cwd`) and eight recorded registered-root paths. To continue, pass its exact
`recipient_session_id` and opaque `catalog.cursor` to the same tool. Aliases are
for display, not selection. No human picker or recipient wakeup is involved.

| Bound | Contract |
|---|---|
| Snapshot | One private sibling `gentle-agents/catalog` file per publisher, at most 64 KiB |
| Entries | At most 64 tasks and 64 registered paths; eight of each per page, at most eight pages |
| Overflow | Whole entries omitted; exact `omittedTasks` / `omittedRegistered` counts on every page |
| Paths | Literal absolute recorded facts, at most 256 UTF-8 bytes; controls and normalized separators become `null`, never rewritten |
| Cursor | At most 1,024 characters; pins session hash, incarnation, transport activation and canonical public-catalog digest plus a publisher-minted page token |

Refresh from the first page after a public catalog change or producer replacement.
Private activity/thread/token updates may advance activity generation without
invalidating continuation: only the public catalog fields and omission counts
identify its snapshot. Envelope/header generation must still match on each read.
Wrong-recipient, changed or malformed cursors return unknown catalog context, not
a cached old page. Missing/malformed/oversized/symlink/FIFO snapshots likewise leave
legacy headers and activity visible. Legacy publishers need no catalog. The sibling
storage cannot inflate the existing bounded presence scan; disposal removes only
publisher-owned inodes and leaves replacements alone.

Derivation explicitly selects summary fields from the existing owned unfinished,
non-restored task list and durable session registry entries. It detaches caller
inputs, never reads another task thread, and adds no Git probes, child launches,
messages or model calls. Each paging read is one bounded local snapshot read, with
no Git resolution. `updateDiscovery` is the public catalog source, independently
of activity serialization; production publishes both from the same owned task
list. Direct publisher callers must refresh discovery when public fields or
membership change, not infer them from empty/unrelated activity input. Host aliases
or legacy scope-only changes do not establish a new catalog identity.
Recorded cwd/root paths are **not** canonical Git identities or
an exhaustive global writer inventory; the earlier Git prefix retains its own gaps.
#1702 remains published-status/curated-summary work, not automatic conversation sharing.

## Turning it on

Set `GENTLE_SHELL_INTERACTIVE_HOST=1` on the `pi --mode rpc` process the host spawns directly. `lib/rpc-host.ts`'s `isInteractiveRpcHost(mode, env)` gates the feature on that exact value; any other value, or its absence, keeps RPC headless — the existing subagent-child behavior is byte-identical. `lib/agents-runner.ts` strips the variable from every subagent child's environment, so a subagent spawned by an interactive host never inherits it and stays headless itself.

## Transport

Pi's `setWidget` is the only fire-and-forget RPC push structured enough to carry this: in RPC mode it accepts a `string[]` (sent as `extension_ui_request`) and silently ignores a component-factory function (the shape the TUI card above the editor uses). The publisher and the TUI card therefore share one widget key without colliding on the wire — a plain RPC host or a TUI session only ever sees the factory call, which its own transport ignores or renders locally.

```json
{
  "type": "extension_ui_request",
  "method": "setWidget",
  "widgetKey": "gentle-agents",
  "widgetLines": ["{\"schema\":\"gentle-agents.activity/v1\", ...}"]
}
```

`widgetLines` is always exactly one line: one JSON document, `JSON.stringify`'d, never pretty-printed. Parse it as `gentle-agents.activity/v1`.

## Payload shape

```jsonc
{
  "schema": "gentle-agents.activity/v1",
  "summary": { "running": 1, "queued": 0, "waiting": 0, "finished": 2 },
  "tasks": [
    {
      "summary": {
        "id": "t_abc123",
        "agent": "explore",
        "label": "Map the auth module",
        "prompt": "Explore how authentication works…",
        "status": "running",
        "createdAt": 1732000000000,
        "startedAt": 1732000000100,
        "endedAt": null,
        "lastStep": "reading lib/auth.ts",
        "lastActivityAt": 1732000005000,
        "turns": 2,
        "toolCalls": 3,
        "error": null
      },
      "thread": {
        "version": 7,
        "dropped": 0,
        "items": [
          { "kind": "text", "text": "Looking at the auth flow first." },
          { "kind": "tool", "name": "read", "args": "{\"path\":\"lib/auth.ts\"}", "running": false, "isError": false, "output": "…file contents…" }
        ]
      }
    }
  ]
}
```

`summary` is `TaskSummary` from `lib/agents-protocol.ts`, unchanged. Each task's `summary` is a field whitelist of its `TaskRecord`: `id`, `agent`, `label`, `prompt`, `status`, `createdAt`, `startedAt`, `endedAt`, `lastStep`, `lastActivityAt`, `turns`, `toolCalls`, `error`. Every other `TaskRecord` field — `cwd`, `parentSessionId`, `mode`, `model`, `thinking`, `sessionPath`, `result`, `tokens`, `cost` — is deliberately left out, the same discipline `lib/orchestrator-presence.ts`'s `projectActivity` already applies to same-profile peer discovery.

`thread.items` is a `ThreadItem[]` whitelist too: text/thinking/note items keep `{ kind, text }` (`text` bounded, see below); tool items carry `{ kind: "tool", name, args, running, isError, output }`, where `args` is the tool's argument object `JSON.stringify`'d (never the raw object). `thread.dropped` is the store's own ring-buffer drop counter (unrelated to the per-push item cap below); `thread.version` increments on every thread mutation.

Tasks are ordered `running`, `waiting`, `queued`, then finished tasks by `endedAt` descending (most recently finished first).

## Bounds

Every bound below fails closed: a value that cannot fit is truncated or dropped, and `lib/agents-rpc-publisher.ts`'s `encodeActivityLines` never throws.

| Field | Bound |
|---|---|
| `summary.prompt` | 200 characters, trailing `…` |
| `summary.error`, `summary.label`, `summary.lastStep` | 500 characters, trailing `…` |
| tool `args` (stringified) | 500 characters, trailing `…` |
| tool `output` | 500 characters, trailing `…` |
| text/thinking/note item `text` | 2000 characters, trailing `…` |
| `thread.items` per task | last 40, most recent last |
| whole payload | 256 KiB |

Truncation always keeps the field's prefix and marks the cut with a trailing `…` (never a separate `truncated` flag) — the same convention `projectRpcActivity`'s other bounded fields already use.

When the whole-payload bound is still exceeded after the field- and item-level truncations above, `encodeActivityLines` shrinks the payload in this order:

1. Halve every task's kept `thread.items` (repeatedly, down to one item each).
2. Empty finished tasks' threads entirely.
3. Drop whole finished tasks — oldest-finished first, by `endedAt`.
4. Last resort: once only active (running/waiting/queued) tasks remain, each already down to one thread item, empty every remaining task's thread too — a summary-only payload.

An active task's `summary` (running, waiting or queued) is never dropped; only its `thread.items` shrink. Finished tasks can be dropped whole by step 3, oldest first.

## Generation and watchdog progress

While an active assistant message streams a tool-call block, validated fresh,
nonempty argument deltas renew the runner's idle watchdog independently of
thread/display events. `summary.lastStep` becomes `generating tool arguments`
and `lastActivityAt` advances; no partial argument data is stored in the thread,
diagnostic, or progress tracker. `toolCalls` increments only at execution start.
Token/cost totals still update only from finalized assistant `message_end` usage,
not streaming usage; static totals do not establish inactivity.

The tracker admits blocks announced by current RPC identity fields or older Pi
partial snapshots. It rejects empty/malformed deltas, unannounced or closed
blocks, stale message starts, and duplicate argument fingerprints. RPC provides
no delta sequence number, so identical chunks within one block are conservatively
indistinguishable from replay and do not renew liveness. Only hashes are retained,
with a 4096-fingerprint bound per assistant message; exhaustion fails closed until
a newer message starts. Unrelated UI and unrecognized event traffic do not renew
argument liveness. Existing RPC command-response handling is unchanged.

Idle and in-flight execution watchdog budgets are **renewable silence bounds**,
not absolute run/generation duration limits. Argument generation uses the idle
budget, not the longer announced-execution budget. Later silence still times out;
execution start/end and cancellation retain their existing behavior.

## Coalescing

`createRpcActivityPublisher` subscribes to `TaskStore#subscribeSummary` (task added, removed, or changed status) and to `TaskStore#subscribe(id)` for every known task, including ones added after `start()`. Changes inside a 150 ms window collapse into exactly one `setWidget("gentle-agents", [line])` call; `stop()` tears down every subscription and publishes one final frame.
