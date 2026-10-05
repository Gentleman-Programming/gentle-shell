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
stay unchanged. Metadata and opt-in helper reasoning are available below; correlated
owner decisions remain a later protocol unit tracked by #1702.

### Publish and find classified work

When useful, include explicit non-sensitive classification in
`orchestrator_session_id.state.work`, for example
`{"area":"Auth","topic":"Login","tags":["Review"],"refs":[{"kind":"issue","repository":"github.com/Owner/Repo","id":"12"}]}`.
An object replaces the whole state; omission of work clears classification, while
`state: null` withdraws it. Never publish private history as metadata.
Pass optional `subagent_run.work` explicitly for a child's classification; it is
not inherited. Keep the returned actual task ID: it is **not** a child session ID.

Use `orchestrator_list.filter: {}` to index classified work; omit `filter` for the
ordinary session list without bulk notes/work. Combine `area`, `topic` (requires
area), `tag`, literal `text`, exact typed `ref` (public repository + kind + ID), or
recorded `repository_root` with AND. Bare issue numbers are not cross-repo identity.
For related work, use `filter: {"related_to":{"session_id":"<stable owner ID>"}}`,
optionally with `task_id` for an actual task on its current catalog page. Add an
existing exact `recipient_session_id`/`cursor` only to inspect that recipient's page;
never automatically page. Source unavailable means no related rows, not refusal.

`possible-*-overlap` means literal possible overlap, not a dependency; a
`shared-declared-reference` is only a declared typed link, not approval. Results
include unknown, unclassified, omitted and pending-page coverage and are never
exhaustive. Historical classification, unknown reachability and `authority: none`
confer no ownership, consent or permission. Querying needs no helper/model call.

The existing consented read-only reasoning helper captures validated root work and
only exact task annotations on the selected owner's current catalog page. Unmatched
annotations are counted in omissions, never promoted to current work. Classification
and refs remain untrusted descriptive data, not approval or executable dependencies;
the existing question/input/output/deadline bounds and cost dialog still apply.

### Classify recorded work

Publish classification in the same curated `state`, for example:

```json
{"state":{"progress":"Reviewing login","work":{"area":"Auth","topic":"Login","tags":["Review"],"refs":[{"kind":"issue","repository":"github.com/Owner/Repo","id":"12"}]}}}
```

`topic` requires `area`; each is at most 64 UTF-8 bytes. Up to eight tags (64 bytes
each) and eight refs are allowed. Refs require an explicit public `host/owner/repo`
(no URL, credentials or inferred repository), and an ID at most 256 bytes; repository
scope is also at most 256 bytes. Issue/PR IDs are positive canonical decimals;
task IDs are opaque historical declarations, **not routable peers**. Input case is
preserved; exact duplicate tags/refs, empty work, unknown keys and unsafe strings
are rejected. Existing text bytes plus serialized work JSON must fit 2,048 bytes.

An object replacement omitting `work` clears classification; `state: null` withdraws
the whole record. Work uses schema 2 in the same branch entry/cache/timestamp;
text-only records remain schema 1. Targeted list and metadata consultation readback
carry detached work with historical `recordedAt`, owner-curated and non-authoritative.
No refs are resolved and classification publication adds no inheritance behavior. Classification
itself needs no Git, network or model call. Consented helper capture follows the bounded
projection described below.

### Search classified work

Call `orchestrator_list` with explicit `filter: {}` to index classified work, or
combine `filter` fields to narrow matches. Without `filter`, the existing session
list remains unchanged: no bulk curated state or work. Unknown argument/filter
keys and unsafe input fail before profile/peer reads; the discoverable strict
schema supplements, not replaces, UTF-8 byte and control validation.

Filtered calls return the full bounded `WorkSearchResult` JSON in text and
`details.gentleAgents.workSearch`, not the default `candidates` envelope. Existing
`recipient_session_id` and `cursor` select one recorded catalog page; a cursor still
requires that exact recipient. Source inclusion is internal, not a new lookup.

`searchPublishedWork(profile, peers, filter?, selection?, now?)` in
[`lib/orchestrator-work-search.ts`](../lib/orchestrator-work-search.ts) is a working,
metadata-only index. An empty filter returns classified sessions and active tasks.
Optional `area`, `topic` (requires area), `tag`, `text`, `ref`, and `repository_root`
criteria combine with AND; `validateWorkFilter` rejects unknown/unsafe input before I/O.
Human comparisons use NFC, trimming and case-insensitive literal matching; public
spellings remain intact. Refs match exact kind/repository/ID without resolution.
Text searches labels and descriptor fields only. Roots match recorded repository
facts, never launch paths or freshly resolved Git; tasks never inherit parent work/roots.

The query examines at most 64 deterministically selected unique peers, retaining
activation ambiguity checks, and reads one catalog page per peer. Historical task
annotations match only exact owner/task IDs on that current active page.
`selection: {recipientSessionId, cursor?}` can read an existing targeted catalog page;
a cursor without a recipient is rejected. There is no automatic paging or query cursor.
The detached whole JSON result fits 16 KiB by omitting whole matching rows, with exact
`omittedMatches`. Coverage is never exhaustive: it counts unexamined peers, unknown
context/catalogs, unclassified nodes, unmatched annotations, catalog omissions and
peers with pending pages. `recordedAt` is historical, separate from `observedAt`;
`ownerReply: false`, `authority: none`, and unknown reachability confer no permission.
Related queries add `related_to: {session_id, task_id?}` using exact stable owner
and actual task IDs (nonempty, safe, at most 256 UTF-8 bytes each). The source task
must be on that owner's current published catalog page; annotations alone never
resolve a source. Root and child classification stay independent. The advertised
source owner is included within the same 64-peer cap by deterministic replacement,
retaining all activations. A selected different recipient remains the only match
recipient; its cursor is never borrowed for source context. No automatic paging occurs.

`source` reports `available` with detached public node/classification and `recordedAt`,
or `unavailable` with an explicit reason and zero matches, never a refusal or broad
fallback. Provenance is `published-work`; basic queries omit `source` entirely.
Ordinary filters still combine with AND, but the source need not satisfy them.
Matches exclude only the exact source entity, not its independently classified siblings.
At least one reason is required: `shared-declared-reference` means exact typed ref
identity, not dependency or approval; `possible-area-overlap`, `possible-topic-overlap`
(also requires shared area), and `possible-tag-overlap` mean only literal possible
overlap. There is no semantic/model matching. Source information and complete reason
arrays count toward the same 16-KiB whole-row omission budget and non-exhaustive coverage.
The public tool adds no registry, Git probes, owner wakes, model calls or UI-cost
requests. This query adds no helper reasoning; consented helper capture is described below.

### Annotate an allocated task

`subagent_run` accepts optional `work` containing only `area`, `topic`, `tags` and
`refs`. It validates before launch preparation or foreign-repository consent.
After allocation and ownership, it publishes the whole owner-curated snapshot,
preserving existing text/classification and adding `state.work.tasks[actualTaskId]`.
Nothing is added to the child prompt, context or task record; unclassified launches
and `subagent_continue` do not annotate or inherit work.

The curated root allows up to eight `tasks`, each a validated descriptor without
nested tasks. Nonempty tasks alone are valid work. Keys are exact task IDs, at most
256 UTF-8 bytes, with no controls/surrogates or `__proto__`, `prototype`, `constructor`.
The same 2,048-byte text-plus-work and 4-KiB record bounds apply. Replacement omitting
`tasks` clears annotations; historical declarations are never silently pruned.
These IDs are not child session IDs or evidence of current runtime ownership;
search joins annotations only to the owner's current bounded catalog page.

The launch result retains the allocated task and includes `workPublication.status`:
`recorded` means local curated persistence, **not guaranteed peer advertisement**.
`unavailable` means publication is unavailable/unknown, including capacity, append,
transport or caller replacement failures. Do not relaunch the task to retry metadata.
When the owner session is active, use `orchestrator_session_id.state` to explicitly
replace the bounded snapshot with the actual ID. The timestamp applies to the whole
publication, not individual annotation freshness. Foreground waiting and cancellation
are unchanged; caller replacement prevents a stale `recorded` result.

### Consult a published snapshot

Call `orchestrator_consult` with required stable `recipient_session_id`, optional
`kind: "metadata"` (default), and optional existing opaque catalog `cursor`.
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
child/helper launches or model calls occur in metadata mode. A question never
implicitly selects reasoning; unknown metadata never triggers a helper.

### Opt-in read-only reasoning

Use `kind: "reasoning"` with a required `question` and the same exact recipient
and optional catalog cursor. Supported TUI/RPC `ctx.ui.select` supplies model-cost
permission; JSON/print and SDK contexts without actual dialog UI fail closed.
Model booleans, curated decisions and helper text cannot authorize invocation or
impersonate owners. Unknown/irrelevant/oversized arguments fail before effects.

One public `ModelRegistry.streamSimple` request receives a static read-only prompt
and one JSON question/public-snapshot message. Nested field whitelists exclude raw
extra properties, history, credentials, transport capabilities and catalog cursors.
Unknowns, omissions and historical source times remain visible; no tools execute.
The captured `state.work` includes validated root area/topic/tags/typed refs and only
annotations whose exact task IDs join that owner's **selected current catalog page**.
Metadata task summaries, old annotations and child session IDs do not prove membership;
root classification never flows to children. `unmatched-task-annotations:N` in omissions
counts excluded annotations; unmatched-only work is omitted, not a meaningful empty class.
Malformed work or a mismatched state owner fails preflight before UI/model calls.
Classification consumes the same input budget and confers no approval, executable
dependency, reachability or exclusive writer ownership, even when tags say “granted”.

| Bound | Contract |
|---|---|
| Input | 16 KiB total system + question JSON; question nonempty, control-free, at most 1,024 UTF-8 bytes |
| Output | Requested 512 tokens/minimal reasoning; text at most 4,096 UTF-8 bytes, no meaning truncation |
| Lifetime | Local deadline at most 20 seconds; cancellation/deadline races return without waiting for ignored abort |
| Concurrency | One execution lease per live SDK model registry, retained across coordinator/runtime replacement until actual provider result settlement |

No retries or automatic runs. A hung provider keeps that registry busy; cancel does
not reopen a potentially billable lease. Host currentness checks fail closed before
invocation and after completion. Tool-call content, errors, empty/oversized text and
stale results are explicit unavailable outcomes, never owner refusals. Length-stop
text is marked partial. Advice carries captured digest/time/target, requested and
actual model IDs, request caps and only finite nonnegative token/cost totals (or
unknown). Thinking is dropped; permission claims remain untrusted text with
`ownerReply: false`, `authority: none`. Abort/token requests are not guaranteed
remote billing caps. Unit tests use local controlled SDK-compatible streams;
the SDK fixture below also proves actual nested execution with simulated UI choices.

### Cost permission and revocation

`lib/orchestrator-helper-consent.ts` coordinates the public reasoning lane while
metadata remains unchanged. Supported `ctx.ui.select` in TUI/RPC offers Allow once,
Allow this target + model for this session, and Decline. Unknown responses and
headless contexts fail closed. The forecast names the configured provider/model,
captured public target/time, all core bounds and the non-guaranteed billing limit.
This is model-cost permission only, never messaging or native-action consent.

The host reads the actual SDK context's live getters and canonical bounded public
source before/after waits. Session start, switch/fork/tree, model selection,
resource reload and shutdown clear permissions and cancel pending work. Grants bind exact manager,
session ID, cwd, model object/provider/ID, registry and logical target; at most
eight targets survive in memory. Updated public snapshots may reuse a session
grant; once never caches. `kind: "revoke-reasoning"` accepts only the recipient,
removes its scope and invalidates pending choices without UI or model calls.
Preflight precedes dialogs; changed public progress/page, replaced/stale/unavailable
source or caller cancellation discards advice without retry. Canonical routing is
re-listed after execution, with epoch/model/source checks still owning the reply.
Private activity and heartbeat changes do not change the public digest.

Pi's reload loader disables module caching, so an execution-only global symbol
holds a weak registry-keyed engine map. No permission or identity survives runtime
replacement; a new coordinator returns busy without UI while the old ignored-abort
result remains pending, then requires fresh permission after settlement. This is
stricter than one run per coordinator. Old clear cannot cancel a successor engine.
No durable policy file, owner request, correlation or consent receipt is created.
Tests simulate SDK UI responses, not real human approval. Actual nested-SDK helper
execution is verified below; interactive human UI proof remains deferred.

### Public-SDK acceptance fixture

`tests/orchestrator-consultation-sdk.test.ts` uses installed Pi SDK 1.0.0:
`DefaultResourceLoader`, `createAgentSession`, `bindExtensions`, local
`registerProvider` streaming and `session.prompt`. Four separate managers/runtimes
share one trusted fixture profile: owner, JSON caller, simulated-UI RPC caller,
and fresh replacement owner. Provider/API IDs are unique per runtime.
Production Gentle Agents/Shell extensions supply the actual registered tools.
No private SDK invocation, fabricated tool context or transport adapter is used.

The fixture also proves actual SDK JSON/no-UI reasoning denial with exactly two
existing local driver turns and no nested helper or receiver calls. It proves
curated branch persistence, preserved human names, frozen
non-authoritative readback, actual private-message exclusion, opaque pagination
for nine then ten Git worktrees, public membership invalidation, unchanged-private-
history continuation, explicit null withdrawal and fresh replacement unknowns.
Driver tool/final model turns are intentional local iterations; consultation adds
no receiver model calls or caller Git probes during the business tool execution.
Intentional owner-publication prompts are counted separately, including during
the controlled in-flight test. Shell prompt setup still probes Git.
Work acceptance additionally publishes schema-2 classification through the public
tool, indexes explicit `{}`, combines area/topic/tag, and distinguishes exact refs
with the same bare ID across repositories and issue/PR kinds. Related queries use
the stable source owner ID; a ghost task annotation without a current owned catalog
row is unavailable, not a child launch. Replacement clears old work and null
withdrawal/text-only records keep unclassified/unknown coverage honest. Default
lists and searches exclude private history and curated prose. Scoped counters
verify no additional owner/nested-helper calls, model-cost dialogs or caller Git
probes for queries, including a simulated-UI context; ordinary local driver calls
remain expected. No child execution or 1,000-projection claim is made.

Public `AgentSession.bindExtensions(bindings: ExtensionBindings): Promise<void>`
accepts `mode: "rpc"` and a fully typed `uiContext: ExtensionUIContext`. The fixture
asserts actual SDK context getters report RPC/hasUI; it never assigns private
context/mode fields or directly executes a tool. A test-host selector returns
simulated Decline/unknown/Allow once/session responses; presentation methods are
explicit RPC stubs, other dialogs throw. This is not a real human grant or RPC
wire-client test. The original two-record/socket assertion precedes the extra caller.

Five actual nested registry requests are observed separately from the exactly two
main driver turns per tool prompt. Each opted-in request has empty tools, the same
static read-only system prompt, and exactly one question/public-JSON user message
(normalized by SDK to two transcript messages). Real caller/owner private-history
sentinels, parent instructions and catalog cursor capabilities are excluded. The
provider receives 512 tokens/minimal reasoning/no tool choice/no retries and a live
abort signal. Known local token/cost usage and requested/actual model IDs match the
non-authoritative advice envelope; a reply claiming permission grants nothing.
Explicit owner-tool publication also puts root classification and exact typed refs in
these existing helper captures; the manually declared ghost task is excluded and
counted as unmatched. This is not proof of child allocation: actual task annotation
remains mocked production-runner evidence. The same five helper requests and
simulated dialog counts remain; restoration uses explicit publication only.

Once re-prompts; session permission reuses updated published state for the same
owner ID without another dialog; revoke adds no dialog/helper and forces a fresh
choice. Metadata, JSON/no-UI, decline and unknown choices add zero helpers. A
controlled deferred provider result plus actual owner publication deterministically
returns stale-source without old advice or retries. Registry lease/replacement and
ignored-abort races remain controlled unit-test evidence, not this SDK scenario.

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
Windows execution or issue-closure evidence; correlated owner decisions remain pending.

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
