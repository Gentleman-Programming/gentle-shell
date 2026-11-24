# Gentle Desktop RPC

Gentle Shell exposes a structured control channel for Gentle Desktop without changing or patching `pi-coding-agent`. It uses Pi's public extension-command and Extension UI RPC mechanisms.

## Activation

Start Pi in RPC mode with the interactive-host marker:

```sh
GENTLE_SHELL_INTERACTIVE_HOST=1 pi --mode rpc
```

The channel is inactive in the TUI and in headless RPC children. It does not register an agent-callable tool.

A Desktop that shows the design canvas itself also sets `GENTLE_DESIGN_OPEN_BROWSER=0`, so `gentle_design {action: "open"}` never launches the system browser. The canvas still starts, the `open` transition still reaches the `design_canvas` event, and the tool answers `opened: false, browserDisabled: true` with the URL.

## Transport

Desktop sends an ordinary Pi `prompt` command. Its `message` contains `/gentle:desktop` followed by one JSON request:

```json
{
  "id": "pi-42",
  "type": "prompt",
  "message": "/gentle:desktop {\"schema\":\"gentle-shell.desktop-rpc/v1\",\"requestId\":\"desktop-42\",\"method\":\"capabilities\",\"params\":{}}"
}
```

Pi's response to this command only reports prompt disposition:

```json
{
  "id": "pi-42",
  "type": "response",
  "command": "prompt",
  "success": true,
  "data": { "disposition": "handled" }
}
```

The domain response arrives independently as an `extension_ui_request` with `method: "setWidget"`, `widgetKey: "gentle-desktop-rpc"`, and one JSON string in `widgetLines`. Its `requestId` correlates it with the Desktop request, not with the outer Pi prompt ID.

Registered extension commands are consumed by Pi. The real-runtime maintainer probe also verifies that this transport leaves `get_messages` empty rather than adding control traffic to the conversation.

## Requests

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "requestId": "desktop-42",
  "method": "get_snapshot",
  "params": {}
}
```

Requests are limited to 64 KiB. `requestId` is required and limited to 128 characters. Method names use lowercase snake case and are limited to 64 characters.

### `capabilities`

Returns the currently implemented contract; clients must not infer support from a later specification version:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "command": "gentle:desktop",
  "widget": "gentle-desktop-rpc",
  "methods": ["capabilities", "get_snapshot", "get_config", "set_config", "get_permission_mode", "set_permission_mode", "get_subscription_usage", "refresh_subscription_usage", "get_design_canvas", "list_jobs", "cancel_job", "get_job_output", "apply_profile", "list_subagents", "cancel_subagent", "get_subagent_thread", "list_sessions", "switch_session", "get_changes", "get_change_diff", "get_review_mode", "set_review_mode", "get_usage_stats", "get_update_status", "list_agent_definitions", "get_status", "get_background_subagents", "set_background_subagents", "get_profile_binding", "clear_profile_binding", "get_auth_status", "reload_credentials"],
  "events": ["config_changed", "permission_mode_changed", "rate_limit", "design_canvas", "jobs_update", "profile_applied", "agents_update", "review_mode_changed", "profile_binding_changed", "session_snapshot"]
}
```

The permission methods, the bounded config read and write, the subscription-usage read and refresh, the design-canvas read, the background-jobs list, cancel, and output read, the profile apply, the subagents list, cancel, and thread read, the review-mode read and change, the cross-session usage-stats read, the update-status read, and the `config_changed`, `permission_mode_changed`, `rate_limit`, `design_canvas`, `jobs_update`, `profile_applied`, `agents_update`, and `review_mode_changed` events are advertised because this extension wires them. `set_config` and `config_changed` are advertised only because the config bridge actually implements that writer — advertising is not a forward-looking wish list. The design slice advertises exactly its one read method and its one transition event, not the canvas `open`/`stop` actions, which stay the `gentle_design` tool's job. The jobs slice advertises exactly its list, cancel, and output-read methods and its one registry-change event, not the `bash_background`/`monitor` start tools, which stay agent tools. The profiles slice advertises exactly its one apply method and its one applied event; profile edits stay `set_config`. The subagents slice advertises exactly its list, cancel, and thread-read methods and its one transition event, not the agent dispatch tools, which stay agent tools. `session_snapshot` is the one entry that depends on the session: it is listed only while the feed owner seam (`extensions/gentle-desktop-feed.ts`) is wired for this session, and absent otherwise; the `get_snapshot` method itself is always listed. The review slice advertises exactly its read and change methods and its one change event; review start, skip, and consent stay terminal-only. The stats slice advertises exactly its one read method and no event: usage stats are an explicit read. The updates slice advertises exactly its one read method and no event; running an update stays the launcher's job. The agent-definitions slice advertises exactly its one read method and no event; editing definitions stays a file edit. The package-status slice advertises exactly its one read method and no event; `/gentle:doctor` stays terminal-only. The background-subagents slice advertises exactly its read and change methods and no event; every answer carries the state. Method availability is not a claim that every dependency is loaded — see [Permission limits](#permission-limits), [Configuration limits](#configuration-limits), [Usage limits](#usage-limits), [Design limits](#design-limits), [Jobs limits](#jobs-limits), [Profiles limits](#profiles-limits), [Subagents limits](#subagents-limits), [Review limits](#review-limits), [Stats limits](#stats-limits), [Updates limits](#updates-limits), [Agent definitions limits](#agent-definitions-limits), [Status limits](#status-limits), and [Background subagents limits](#background-subagents-limits).

### `get_snapshot`

Returns the current event sequence and a bounded state projection:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "sequence": 0,
  "state": {
    "config": {
      "stores": [
        { "store": "profiles", "scope": "global", "readOnly": false, "status": "ok", "revision": "sha256:1f0c…" },
        { "store": "models", "scope": "global+project", "readOnly": true, "status": "ok", "revision": "sha256:9a42…" },
        { "store": "profile_fallbacks", "scope": "global", "readOnly": false, "status": "missing", "revision": "sha256:3c11…" },
        { "store": "subagents", "scope": "global+project", "readOnly": true, "status": "ok", "revision": "sha256:77be…" },
        { "store": "pins", "scope": "local+repo", "readOnly": false, "status": "ok", "revision": "sha256:0d19…" },
        { "store": "managed_assets", "scope": "global", "readOnly": true, "status": "ok", "revision": "sha256:be05…" },
        { "store": "persona", "scope": "global+project", "readOnly": false, "status": "ok", "revision": "sha256:41aa…" },
        { "store": "banner", "scope": "global", "readOnly": false, "status": "missing", "revision": "sha256:9c02…" },
        { "store": "notifications", "scope": "global", "readOnly": false, "status": "ok", "revision": "sha256:d317…" }
      ]
    }
  }
}
```

The projection carries only store identity, scope, mutability, status, and revision — never store content, never a path. It is the cheap way for a client to notice that one of the nine revisions moved and then call `get_config` for that store. `state` is `{}` when no Desktop command has bound a session context yet, or when that context has no working directory: without one, the project and pin layers cannot be read truthfully, so nothing is projected instead of a guess.

This snapshot does not project permission state: use `get_permission_mode` for that. `sequence` is the number of delivered events, so a client that saw `seq: 4` expects `sequence: 4` from a fresh snapshot unless it missed an event.

#### Session sections

`get_snapshot` accepts one optional param, `sections`: the session state the TUI sidebar and the Herdr feed show, read live from the feed owner's projection (`buildDesktopFeedSnapshot`, schema `gentle-shell.desktop-feed/v1`) through an in-process seam, never from the feed's file.

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "requestId": "desktop-43",
  "method": "get_snapshot",
  "params": { "sections": ["todo", "changes", "activity"] }
}
```

Without a `sections` key the request is the legacy read above, byte-for-byte (other params stay ignored as before). With it, params are exactly `{ "sections": [...] }`: a non-empty array of unique names from `project`, `model`, `context`, `cost`, `usage`, `profiles`, `permission`, `todo`, `changes`, `agents`, `jobs`, `review`, `stats`, `activity`, `pendingQuestion`, `commands`. Any other shape, an unknown or repeated name, or an extra key is `invalid_request`, before any owner work. The answer keeps `state.config` exactly as the legacy read and adds `state.session` with the requested sections in that canonical order:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "sequence": 4,
  "state": {
    "config": { "stores": ["…as above…"] },
    "session": {
      "todo": { "items": [{ "id": 2, "title": "Build feed", "state": "in_progress", "note": null }], "progress": { "done": 1, "total": 2, "open": 1 }, "current": "Build feed", "truncated": false },
      "changes": {
        "files": [{ "path": "lib/a.ts", "root": "root-70e56188b8da", "status": "modified", "added": 3, "deleted": 1 }],
        "summary": { "files": 1, "added": 3, "deleted": 1 },
        "worktrees": [{ "root": "root-70e56188b8da", "branch": "feat/x", "files": 1 }],
        "truncated": false
      },
      "activity": { "state": "working", "streaming": true, "phase": "implementing", "phaseLabel": "implementing…", "blockedLabel": null, "agents": 0, "jobs": 0, "label": "Working" }
    }
  }
}
```

Each section is the feed's own shape (see `DesktopFeedSnapshot` in `lib/desktop-feed.ts`) with two path-free changes: `project` is `{ "name", "branch", "dirty" }`, where `name` is the basename of the working directory (`null` for a filesystem root such as `/` or a drive root such as `C:\`), and in `changes` every worktree `root` is an opaque, stable label (`root-` plus 12 hex characters) while every file carries a `path` relative to its worktree plus that worktree's `root` label (`null`, with the bare file name, for a path no worktree holds). Windows-style roots (a drive letter or backslashes) match their files case- and separator-insensitively; POSIX roots match case-sensitively. A worktree whose root is `/` or a bare drive gets `root: null` and never relativizes a path: its files cross as bare file names with `root: null`. A section the session has nothing for is `null`, as in the feed (`changes` before the first scan, `review` before a review, `pendingQuestion` with no open question). When the feed is not running for this session (the extension is not loaded, the process is not Gentle Shell, or the session is not live) the answer is `session_unavailable`; `get_snapshot` without `sections` is unaffected. A read never emits an event.

### `get_config`

Reads one existing configuration store through the owner that already reads it. Desktop names a store identifier, never a path: the request accepts exactly one param.

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "requestId": "desktop-46",
  "method": "get_config",
  "params": { "store": "profiles" }
}
```

| Param | Required | Type | Meaning |
| --- | --- | --- | --- |
| `store` | yes | one of the nine store identifiers below | The store to read. |

Any other key — including `scope`, `path`, `file`, or `physical_path` — is rejected as `invalid_request`. A string that is not a known store identifier is rejected as `unknown_store`. Neither case reads anything.

| `store` | Owner reader | `scope` | `readOnly` | Content |
| --- | --- | --- | --- | --- |
| `profiles` | `readProfilesFileResult` over `<configHome>/profiles.json` | `global` | `false` | Normalized `AgentProfilesFile`: `kind`, `version`, optional `active`, `profiles`, optional `workflow`. Writable — see [`set_config`](#set_config). |
| `models` | `readSavedModelConfig` over `<configHome>/models.json` + `<cwd>/.pi/gentle-ai/models.json` | `global+project` | `true` | Saved routing map, global winning per agent, kept to safe agent keys. |
| `profile_fallbacks` | `readFallbacksFile` over `<configHome>/profile-fallbacks.json` | `global` | `false` | Normalized `FallbacksFile`: per-profile, per-agent ordered chains. Writable — see [`set_config`](#set_config). |
| `subagents` | `parseAgentsConfig` over `<agentHome>/subagents.json` + `<cwd>/.pi/subagents.json` | `global+project` | `true` | Normalized `AgentsConfig` the runtime would launch with. A layer that cannot be parsed is skipped and the remaining layer still merges, exactly like the runtime reader. |
| `pins` | `readProfilePinStatus` + `evaluateProfilePin` over the local pin and the repo declaration | `local+repo` | `false` | `resolved`, the winning layer and profile, plus the `invalid` and `stale` layers. Writable per layer — see [`set_config`](#set_config). |
| `managed_assets` | `readManagedAssetsManifestResult` over `<agentHome>/gentle-ai/managed-assets.json` | `global` | `true` | The installer's ownership manifest (`schemaVersion`, `assets`), filtered to ownership-shaped entries: relative asset paths below the agent home and 64-hex sha256 digests. Anything else is omitted, never echoed. |
| `persona` | `readPersonaLayer` + `resolvePersonaMode` over `<configHome>/persona.json` + `<cwd>/.pi/gentle-ai/persona.json` | `global+project` | `false` | `{ mode }`: the persona in effect, the project layer winning. |
| `banner` | `readBannerConfigSync` over `<configHome>/banner.json` | `global` | `false` | `{ showRose, showTextLogo, color }`. |
| `notifications` | `parseNotificationSettingsFile` over `<configHome>/notifications.json` | `global` | `false` | The validated settings without `schema`, every `file:` sound replaced by `"file"`. |

Success:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-46",
  "ok": true,
  "data": {
    "store": "profiles",
    "scope": "global",
    "readOnly": false,
    "status": "ok",
    "revision": "sha256:1f0c8c0f5bd34a1e27f4ba6d0f9c2f5b",
    "value": {
      "kind": "gentle-pi.agent_model_profiles",
      "version": 1,
      "active": "team",
      "profiles": { "team": { "explore": { "model": "anthropic/claude-sonnet-4" } } }
    },
    "layers": [{ "source": "global", "status": "ok" }],
    "writeTargets": [{ "target": "global", "status": "ok", "writeRevision": "sha256:8f2a…" }]
  }
}
```

| Field | Meaning |
| --- | --- |
| `store` | The store identifier that was read. |
| `scope` | Which owner layers this store is assembled from: `global`, `global+project`, or `local+repo`. |
| `readOnly` | `false` for the six writable stores (`profiles`, `profile_fallbacks`, `pins`, `persona`, `banner`, `notifications`); `true` for the three derived or installer-owned stores (`models`, `subagents`, `managed_assets`). |
| `status` | `ok` (normalized content follows), `missing` (no layer produced content because no layer file exists), or `invalid` (layers exist but none of them produced content). See [Layer semantics](#layer-semantics). |
| `revision` | Opaque read-time digest of the canonical normalized content. See [Revision limits](#revision-limits). |
| `value` | Normalized owner content, present when the store produced one. Absent when a layer is missing or invalid. |
| `layers` | Per-layer status, `global` then `project`, or `local` then `repo`. Each entry is `ok`, `missing`, or `invalid` for the file that layer owns. |
| `writeTargets` | Present only for the three writable stores. One entry per file the owner rewrites, with that file's own `writeRevision` — the token `set_config` requires. See [Write targets](#write-targets). |

#### Layer semantics

`status` answers for the store; `layers` answers for each file it is assembled from. For a merged store the two are different questions:

- `profiles`, `profile_fallbacks`, `managed_assets`, `banner`, and `notifications` have one layer, so `status` is that layer's status.
- `persona` has a `global` layer (`persona.json` in the Gentle config home) and a `project` layer (`<cwd>/.pi/gentle-ai/persona.json`); `value` is `{ "mode": "gentleman" | "neutral" }`, the mode in effect (the project layer wins), exactly as the prompt build resolves it.
- `banner` is `{ showRose, showTextLogo, color }` from `banner.json`. A file without those three valid settings is `invalid` and is never repaired by a read; extra keys are ignored, as the `/gentle:banner` editor ignores them, and a Desktop write keeps only the three settings.
- `notifications` is the owner's validated `notifications.json` without its `schema` key. Every `file:` sound is replaced by the marker `"file"`, so no sound path crosses the wire.
- `subagents` mirrors the runtime reader: a layer that cannot be parsed is skipped and the remaining layer still merges. `status` is `ok` as soon as one layer is usable, and `layers` still names the broken one.
- `models` keeps the owner's merge rule, which rejects the saved routing when a layer it reads is malformed; there `status` is `invalid` even if the other layer is fine.
- `missing` means every layer file is absent. `invalid` means layer files exist but none produced content; in that case the owner would fall back to its own defaults, which are not the content of this store, so no `value` is returned.

A malformed project `subagents.json` next to a valid global file therefore still returns content:

```json
{
  "store": "subagents",
  "scope": "global+project",
  "readOnly": true,
  "status": "ok",
  "revision": "sha256:77be0c3c1f7e4b0d9a2d6a6c5d1f8e34",
  "value": { "defaultMode": "task", "modelProfiles": { "explore": { "model": { "provider": "anthropic", "id": "claude-sonnet-4" } } } },
  "layers": [
    { "source": "global", "status": "ok" },
    { "source": "project", "status": "invalid" }
  ]
}
```

Missing and malformed stores are reported, never repaired:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-47",
  "ok": true,
  "data": {
    "store": "models",
    "scope": "global+project",
    "readOnly": true,
    "status": "invalid",
    "revision": "sha256:5a61d4d3f5ab4f7f2f2f2cbb8ac7e2b1",
    "layers": [
      { "source": "global", "status": "invalid" },
      { "source": "project", "status": "ok" }
    ]
  }
}
```

`pins` always carries a `value` describing what the layers amount to, because a broken or stale pin is exactly the state an operator needs to see:

```json
{
  "store": "pins",
  "scope": "local+repo",
  "readOnly": false,
  "status": "ok",
  "revision": "sha256:0d19c0b7f0a94c29d5c33a0b1c9e6d21",
  "value": {
    "resolved": true,
    "winner": { "source": "repo", "profile": "team" },
    "invalid": [],
    "stale": [{ "source": "local", "profile": "retired" }]
  },
  "layers": [
    { "source": "local", "status": "ok" },
    { "source": "repo", "status": "ok" }
  ]
}
```

Outside a resolvable Git worktree there are no pin layers to report, so `pins` answers `status: "invalid"` with `value.reason: "worktree_unresolved"` and an empty `layers` array. No layer path is ever returned: the owner reports paths for the TUI panel, and this projection drops them.

`pins.status` has exactly three meanings:

- `ok` — a layer named a profile the global profiles store still defines; `value.winner` says which layer and profile.
- `missing` — neither pin file exists, so there is nothing to resolve.
- `invalid` — pin files exist but no layer resolves (all `invalid` or `stale`), or the session cwd is not a resolvable Git worktree. Only this status carries `value.reason`, and only the non-worktree case has an empty `layers` array.

A single broken or stale layer does not make the store `invalid` while another layer resolves: that layer is named under `value.invalid` (a file that is not a pin) or `value.stale` (a name the profiles store dropped), and its `layers` entry keeps the per-file status.

Reads have no side effect. A `get_config` request never creates, rewrites, repairs, or re-serializes a store, never writes the permission default, and emits no event. A reader that finds a malformed file reports it as `invalid` in `layers` — and as the store `status` only when no layer is usable — while leaving the bytes untouched.

#### Write targets

A write target is one file, not one store, with one exception: `persona`'s `global` target. `get_config` reports targets only for a writable store, and `set_config` requires the revision of the exact target it is about to replace:

| `store` | `target` values | File |
| --- | --- | --- |
| `profiles` | `global` | `<configHome>/profiles.json` |
| `profile_fallbacks` | `global` | `<configHome>/profile-fallbacks.json` |
| `pins` | `local`, `repo` | `<git-common-dir>/gentle-ai/profile-pin.json`, `<worktree-root>/.pi/gentle-ai/profile.json` |
| `persona` | `global` | `<configHome>/persona.json`, plus `<cwd>/.pi/gentle-ai/persona.json` when it already exists |
| `banner` | `global` | `<configHome>/banner.json` |
| `notifications` | `global` | `<configHome>/notifications.json` |

`persona`'s `global` target covers both persona files, because the owner rewrites the project file too when it exists: its `writeRevision` digests both layers (so a project edit makes a token stale even while the global file is missing), and its `value` is `{ global, project }` layer states rather than one file. Each file is replaced atomically, but the two-file write is not a transaction: a failure after the global file is written can leave the project file unchanged, and the answer reports the layers as they are.

`writeRevision` is the digest of that one target's state: `sha256` over canonical JSON of `{store, target, status, value}`. When the target reads `ok`, `value` is the owner-normalized file content (for a pin layer, the profile name it holds), so any content change moves the digest. When the target reads `missing` or `invalid`, `value` is absent and the digest covers **only `{store, target, status}`** — the owner produced no content to hash, and this contract does not hash raw bytes. Two consequences follow, and they are limits rather than incidents:

- a target that is missing and a different target state can never collide, because `status` differs;
- two **different** broken files of the same target share one `writeRevision`, so replacing one `invalid` file with another produces no detectable conflict. `expectedRevision` proves "this target is currently broken", not "this target is currently broken in exactly this way".

It is deliberately a different token from the store's `revision`, which for `pins` describes the merged evaluation of both layers and therefore cannot identify the file a write replaces. A missing target has a write revision of its own (`status: "missing"`), which is what makes a first, creating write possible without inventing a token.

Outside a resolvable Git worktree `pins` reports `writeTargets: []`: there is no truthful pin file for the session, so no target is offered and no pin write is accepted.

### Revision limits

`revision` is a `sha256` digest over canonical JSON (sorted keys, `undefined` members dropped) of `{store, status, value}` for that read. It is stable across equivalent reads: reformatting a file, reordering its keys, or touching its mtime does not move it, while any change to normalized content does. The same caveat as `writeRevision` applies: a read that produced no content (`missing`, `invalid`) digests only `{store, status}`, so two different broken files for one store share a read revision. It is deliberately not a transaction token:

- it is computed **at read time**, after the owner normalized the content, not from file bytes and not from an owner-maintained counter;
- there is no cross-process lock, and the only change notification is the best-effort external `config_changed` event (see [`config_changed`](#config_changed)), so two processes can each see a different revision at the same wall-clock moment, and when a watcher is missing nobody is told that the other one wrote;
- a multi-layer store (`models`, `subagents`, `pins`) can change between the individual layer reads that make up one projection; that projection is still a truthful report of the layers that were read;
- it orders nothing, so it must never be compared between sessions or used as a precondition for a write. `expectedRevision` is the only precondition this contract accepts, and it is compared against `writeTargets[].writeRevision` — never against `revision`.

### `set_config`

Writes one existing, owner-maintained store. Desktop names a store and, for `pins`, the layer; it never names a path, and there is no generic physical-file target.

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "requestId": "desktop-48",
  "method": "set_config",
  "params": {
    "store": "profiles",
    "data": {
      "kind": "gentle-pi.agent_model_profiles",
      "version": 1,
      "active": "team",
      "profiles": { "team": { "explore": { "model": "anthropic/claude-sonnet-4" } } }
    },
    "expectedRevision": "sha256:8f2a0c5e2d7b4319a6f80e1c93b4d271"
  }
}
```

| Param | Required | Type | Meaning |
| --- | --- | --- | --- |
| `store` | yes | `profiles` \| `profile_fallbacks` \| `pins` | The one store to write. |
| `data` | yes | store-specific object (below) | The **complete** new content of that store, not a patch. |
| `expectedRevision` | yes | string | `writeTargets[].writeRevision` of the target as the client last read it. |

Exactly these three keys are accepted. Any other key — including `scope`, `path`, `file`, or `physical_path` — is rejected as `invalid_request` before anything is read or written. An unknown store string is `unknown_store`. A write to `models`, `subagents`, or `managed_assets` is `read_only`, rejected before its `data` is inspected, because the reason the write cannot happen is the store, not the payload.

#### `data` for `profiles`

The complete `AgentProfilesFile`, exactly as the owner serializes it:

```json
{
  "kind": "gentle-pi.agent_model_profiles",
  "version": 1,
  "active": "team",
  "profiles": {
    "team": {
      "explore": { "model": "anthropic/claude-sonnet-4" },
      "orchestrator": { "model": "openai/gpt-5" }
    }
  },
  "workflow": { "team": { "orchestratorMode": "full-delegation" } }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `kind` | yes | Exactly `gentle-pi.agent_model_profiles`. |
| `version` | yes | Exactly `1`. |
| `active` | no | Name of the globally active profile. Omitting it clears the marker. |
| `profiles` | yes | Profile name → routing map (agent name → `{model?, thinking?, tier?}`). Agent keys and model ids must satisfy the owner's safe-key policy. |
| `workflow` | no | Profile name → `{orchestratorMode: "organic" \| "full-delegation"}`. Non-default modes only; an all-organic map is not persisted. |

#### `data` for `profile_fallbacks`

The complete `FallbacksFile`, exactly as the owner normalizes it:

```json
{
  "kind": "gentle-pi.profile_model_fallbacks",
  "version": 1,
  "profiles": {
    "team": {
      "*": [{ "model": "openai/gpt-shared" }],
      "worker": [{ "model": "openai/gpt-fallback", "thinking": "low" }]
    }
  }
}
```

`*` is the profile-wide default chain. Each chain is at most 8 steps, each step is `{model, thinking?}`, and a model appears at most once per chain.

#### `data` for `pins`

One selected layer and what it should hold — a profile to pin, or `null` to clear it:

```json
{ "source": "local", "profile": "team" }
```

```json
{ "source": "repo", "profile": null }
```

| Field | Required | Meaning |
| --- | --- | --- |
| `source` | yes | `local` (clone-wide, Git common dir) or `repo` (committable, per worktree). The layer is chosen by this field, never by which file happens to exist. |
| `profile` | yes | Name of a profile the `profiles` store currently defines, **or `null` to remove this layer's pin file**. |

`source` must be `local` or `repo`; there is no default and no inference. Exactly `{source, profile}` is accepted — the layer is never inferred from a path, and one request never touches both layers. A name the profiles store does not define is rejected, so this channel can never write the stale pin the owner's precedence rule would then skip; a clear names no profile, so the profiles store is not consulted.

`profile: null` is the explicit clear and goes through the owner's own `clearProfilePinSync`. It removes that one pin file and leaves the other layer exactly as it is, so the next read falls back to the lower layer and then to the global routing. Clearing a layer whose file does not exist is already the desired state: the response is `changed: false` and no event is emitted. Clearing a layer whose file exists but is not a readable pin still removes it — the request proved it saw that `invalid` layer through `writeRevision`, so this is an explicit removal, not a silent repair.

A layer whose file currently reads `invalid` is likewise a valid target for a set: replacing a broken pin with a valid one is an explicit operation.

#### Validation and revision guard

The checks below run in this order, and the first one that fails answers the request. Nothing is read or written after a rejection.

1. **Envelope** (`invalid_request`): exactly the keys `store`, `data`, and `expectedRevision`; `store` must be a string; `data` must be present. A request missing `data` is malformed whatever store or revision it names, so this check comes before the store rules — a `models` write without `data` is `invalid_request`, not `read_only`. Store contents are not looked at here.
2. **Store identity** (`unknown_store`): the string must be one of the nine store identifiers.
3. **Mutability** (`read_only`): `models`, `subagents`, and `managed_assets` are rejected before their `data` is inspected or their revision is compared, so any payload gets the same answer.
4. **Usable revision** (`revision_conflict`): `expectedRevision` must be a non-empty string. Absent, empty, and non-string tokens are all "the client did not prove it saw the current state", and this is decided before the payload is validated.
5. **Session roots** (`config_unavailable`): the bound session must have a working directory.
6. **Payload** (`invalid_data`): `data` is validated by the owner's own normalizer (`normalizeProfilesFile`, `normalizeFallbacksFile`, the pin name and store rules). A value the owner would reject is `invalid_data`. So is any value the owner's normalizer would **rewrite or silently drop** — an illegal profile or agent name, a stale `active` marker, an unknown workflow mode, an empty fallback chain, the `effort` alias, an organic workflow entry, an unknown routing member. A write is applied complete or not at all, so a client can never delete or silently reshape content by sending it: send exactly the canonical form `get_config` returned. For `pins`, `profile` must be a defined profile name or the literal `null`; a missing, empty, non-string, or unknown `profile`, an extra `data` key, and a `source` other than `local`/`repo` are all `invalid_data`, and a pin request outside a resolvable Git worktree is `config_unavailable`.
7. **Revision comparison** (`revision_conflict`): the target's current `writeRevision` is read from disk and compared with `expectedRevision`. A mismatch means **no write and no removal**. Remember the coarse case: two different broken files share one revision, so a broken-to-broken change is not caught here.
8. **Owner write** (`write_failed`): if the target already holds exactly this content the request is a no-op — nothing is written, `changed` is `false`, and no event is emitted; identical content is never re-serialized, so its bytes and mtime stay untouched, and a clear of an already-absent layer is the same no-op. Otherwise the owner's validated atomic writer performs the change (`writeProfilesFileSync`, `writeFallbacksFile`, `writeProfilePinSync`, or `clearProfilePinSync` — the writers go through a `0600` sibling temp file and a rename; the clear unlinks only a file that exists). If that writer throws, the answer is `write_failed` with a fixed message, no path, no OS code, no event, and the store left exactly as the owner's cleanup found it.
9. **Report**: the store is re-read and the response reports the result.

Steps 7–8 run in one synchronous block, with no `await` between the check and the rename or unlink. Pi dispatches Desktop prompts concurrently, but only an `await` can interleave another request, so **within this process** two `set_config` calls cannot both pass the check with the same `expectedRevision` — the second sees the first's revision and answers `revision_conflict`. This is not a cross-process transaction: there is no lock and no OS-level compare-and-swap, so another `pi` process (or `/gentle:profiles`, or the installer) can still write between the check and the rename. `expectedRevision` narrows that window; it does not remove it.

#### Success

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-48",
  "ok": true,
  "data": {
    "store": "profiles",
    "scope": "global",
    "readOnly": false,
    "status": "ok",
    "revision": "sha256:1c8065f530f01fb3c8e1dc33a2001b63",
    "value": {
      "kind": "gentle-pi.agent_model_profiles",
      "version": 1,
      "active": "team",
      "profiles": { "team": { "explore": { "model": "anthropic/claude-sonnet-4" } } }
    },
    "layers": [{ "source": "global", "status": "ok" }],
    "writeTargets": [{ "target": "global", "status": "ok", "writeRevision": "sha256:c4b0afed3b2375ee0fb10e45a9545c78" }],
    "writeTarget": "global",
    "writeRevision": "sha256:c4b0afed3b2375ee0fb10e45a9545c78",
    "changed": true
  }
}
```

The payload is the same `get_config` projection of the store **after** the write — `store`, `scope`, `readOnly`, `status`, `revision`, `value`, `layers`, `writeTargets` — plus two fields:

| Field | Meaning |
| --- | --- |
| `writeTarget` | The target this request named: `global`, `local`, or `repo`. |
| `writeRevision` | That target's resulting revision, to use as `expectedRevision` on the next write. |
| `changed` | `true` only if this request actually changed the target's content. A no-op answers `false` with the unchanged state and no event. |

Every value is re-read from the owner after the attempt, never an echo of `data`, so a normalizing write reports what the store really holds.

#### Failures

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-49",
  "ok": false,
  "error": { "code": "revision_conflict", "message": "Config changed since expectedRevision was read" }
}
```

A rejected write leaves every byte, mtime, and file in place: no store is created, repaired, truncated, or reformatted. Invalid `data` cannot create a file, and a `revision_conflict` cannot modify one. An owner write that throws (the store path is a directory, a permission failure, a read-only filesystem) answers `write_failed`, whose message is fixed and never carries a path or an OS error; its temp file is removed and the store is left as the owner found it.

### `get_permission_mode`

Reads the live permission owner. Params must be an empty object. A read has no effect on stored preferences: it never writes the default store, never changes a permission mode this session already established, and never emits an event.

The owner initializes a session lazily and this read is one of the entry points that does it. The first permission call in a session (a read or a set) resolves the session identity and pins this session's live mode to the trusted default in effect at that moment; that is why a read can be the call that materializes the session's mode. Later default changes therefore affect new sessions, not the one already initialized.

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-43", "method": "get_permission_mode", "params": {} }
```

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-43",
  "ok": true,
  "data": { "mode": "normal", "default_mode": "normal" }
}
```

`mode` is the session mode in effect now; `default_mode` is the trusted default a new primary session would start from. Both are one of `normal`, `auto`, `yolo`, `super-yolo`.

### `set_permission_mode`

Applies a session mode immediately through the existing permission owner (`YoloSessionController`). No restart, no reload, and no separate store: this is the same controller that answers `/gentle:mode` and `/gentle:yolo`.

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "requestId": "desktop-44",
  "method": "set_permission_mode",
  "params": { "mode": "auto", "persist": true }
}
```

| Param | Required | Type | Meaning |
| --- | --- | --- | --- |
| `mode` | yes | `normal` \| `auto` \| `yolo` \| `super-yolo` | Session mode to apply now. |
| `persist` | no | boolean, default `false` | Also save `mode` as the trusted default for new primary sessions. |

Only these two params are accepted. Any other key, a non-string `mode`, a non-boolean `persist`, or an unknown mode string is rejected as `invalid_request` with no state change and no event.

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-44",
  "ok": true,
  "data": { "mode": "auto", "default_mode": "auto", "persisted": true, "changed": true }
}
```

`mode` and `default_mode` are re-read from the owner after the attempt, so they are the actual resulting state, not an echo of the request. `persisted` reports whether this request actually saved the default. `changed` reports whether the session mode or the default differs from the state read before the call; a rejected or unchanged request returns `changed: false` and emits no event.

Persistence is delegated to the owner's validated writer, which keeps the file private (`0600`), writes atomically, and refuses to repair a malformed or unreadable preference. A failed save does not roll back the live session change:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-45",
  "ok": true,
  "data": {
    "mode": "auto",
    "default_mode": "normal",
    "persisted": false,
    "changed": true,
    "persist_error": { "code": "default_unchanged", "message": "Default permission mode unchanged" }
  }
}
```

### `get_subscription_usage`

Reads the subscription usage windows the existing usage owner has already recorded, projected into a safe wire shape. Params are optional: an empty object reads the whole current scope, and `{ "provider": "nan" }` reads exactly one provider.

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-50", "method": "get_subscription_usage", "params": {} }
```

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-51", "method": "get_subscription_usage", "params": { "provider": "openai-codex" } }
```

| Param | Required | Type | Meaning |
| --- | --- | --- | --- |
| `provider` | no | string | Narrow the answer to one provider. Unknown names answer `unavailable`, never an error. |

Only the `provider` key is accepted; any other key, a non-string `provider`, or an empty string is `invalid_request`. A read has no side effect: it never fetches, never writes, and never emits an event.

Success:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-51",
  "ok": true,
  "data": {
    "providers": [
      {
        "provider": "openai-codex",
        "status": "ok",
        "fetchedAt": 1788600000000,
        "plan": "pro",
        "limits": [
          {
            "name": "codex",
            "limitReached": false,
            "windows": [
              { "label": "week", "usedPercent": 40, "windowSeconds": 604800, "resetAt": 1788777491000 }
            ]
          }
        ]
      }
    ]
  }
}
```

Each entry carries only the safe fields of the owner's recorded snapshot:

| Field | Meaning |
| --- | --- |
| `provider` | The provider identifier. |
| `status` | One of `ok`, `pending`, `stale`, `failed`, `unavailable` — see below. |
| `fetchedAt` | When the snapshot was recorded, present when there is a snapshot. |
| `plan` | The plan name the owner already recorded, present only when public; never enriched from auth or account state. |
| `limits` | Safe windows: `name`, `limitReached`, and per-window `label`, `usedPercent`, `windowSeconds`, `resetAt`, plus NaN's raw `used`/`budget` allowance numbers when the provider reports them. |

`status` is derived only from facts the owner already holds:

- `ok` — a snapshot is recorded and fresh.
- `stale` — a snapshot is recorded but older than the 5-minute refresh window (refreshable providers only).
- `pending` — no snapshot yet, the provider is supported, and its latest refresh did not fail.
- `failed` — no snapshot and the latest refresh settled empty.
- `unavailable` — the provider is not supported (no built-in fetcher and no registered usage source).

A header-only provider (Anthropic) is `pending` until its first response, and its snapshots never age into `stale` because they arrive with responses rather than through a fetch cycle. A retained snapshot keeps `ok`/`stale` even after a failed refresh; its `fetchedAt` is the age signal. No account id, URL, access token, key material, raw provider error, or auth-resolution detail ever crosses the wire.

### `refresh_subscription_usage`

Delegates a forced refresh to the existing `refreshUsage` closure, with exactly the same API-key and auth logic the panel uses. It never resolves credentials, reads `auth.json`, or implements a second fetcher.

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-52", "method": "refresh_subscription_usage", "params": { "provider": "openai-codex" } }
```

Params are the same optional `provider` filter as `get_subscription_usage`. The response reports the post-refresh statuses in the same `providers` shape. A provider with no fetch endpoint (Anthropic — its windows arrive with provider responses) is a truthful typed no-op: it answers `refresh: "unsupported"` with its current `pending`/`ok` status and performs no fetch and emits no event. No Claude usage endpoint is invented.

A refreshable provider that is **outside the current session scope** is also a truthful no-op: the owner resolves the scope before delegating, so it never attempts the fetch, keeps the current snapshot and status, and answers `refresh: "out_of_scope"` — an explicit signal instead of an ambiguous `pending`.

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-54",
  "ok": true,
  "data": {
    "providers": [
      { "provider": "openai-codex", "status": "pending", "refresh": "out_of_scope" }
    ]
  }
}
```

`refresh` appears only on a refresh answer and is one of `unsupported` (supported provider with no fetch endpoint) or `out_of_scope` (refreshable provider the current scope does not target). Either is a no-op: no fetch, no event, and the snapshot and status are left exactly as they were.

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-53",
  "ok": true,
  "data": {
    "providers": [
      { "provider": "anthropic", "status": "pending", "refresh": "unsupported" }
    ]
  }
}
```

When a refresh actually changes a snapshot, the response is followed by exactly one `rate_limit` event carrying every changed snapshot (`source: "refresh"`). A no-op, unsupported, throttled, or failed refresh changes nothing and emits no event. The response line always precedes the event line.

### `get_design_canvas`

Reads the live design canvas state the existing design owner already owns (the single `DesignCanvas` from `createDesignCanvas`, plus `listDesigns`). Params are optional: an empty object omits the tokenized URL, and `{ "includeUrl": true }` explicitly requests it.

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-55", "method": "get_design_canvas", "params": {} }
```

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-56", "method": "get_design_canvas", "params": { "includeUrl": true } }
```

| Param | Required | Type | Meaning |
| --- | --- | --- | --- |
| `includeUrl` | no | boolean | Include the tokenized canvas URL. Only honored for an interactive RPC host (the trust gate below); omitted by default. |

Only the `includeUrl` key is accepted; any other key, or a non-boolean `includeUrl`, is `invalid_request`. A read has no side effect: it never starts a canvas server, never opens a browser, and never emits an event.

Success:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-56",
  "ok": true,
  "data": {
    "running": true,
    "slug": "login",
    "connectedClients": 1,
    "designs": [
      { "slug": "login", "title": "Login screen", "mtime": 1788600000000 },
      { "slug": "pricing", "title": "Pricing page", "mtime": 1788500000000 }
    ],
    "url": "http://127.0.0.1:4100/<token>/d/login/"
  }
}
```

| Field | Meaning |
| --- | --- |
| `running` | Whether the session's canvas server is actually running, as the owner reports it. |
| `slug` | The slug the canvas last showed, or `null` for the system-only root. `null` is not "stopped": `running` answers that. |
| `connectedClients` | How many canvas pages the running server has connected (live-reload streams). `0` when stopped. |
| `designs` | The designs under `<cwd>/design` the owner's `listDesigns` reports (`slug`, `title`, `mtime`), most recent first. Empty when none exist. |
| `url` | Present only after `includeUrl: true` **and** the interactive-host trust check. The tokenized canvas URL is a capability; it is never a default field and never a bare token. |

When the design owner is absent (the extension that owns the canvas is not loaded), the answer is `design_unavailable` — never a fabricated `running: false`:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-57",
  "ok": false,
  "error": { "code": "design_unavailable", "message": "Design canvas owner unavailable for this session" }
}
```

A request with `includeUrl: true` from a host that is not an interactive RPC host simply gets the same state **without** `url`; the capability is omitted, not rejected. There is no `open`/`stop` method on this channel — those stay the `gentle_design` tool's actions, and this slice only observes their results.

### `list_jobs`

Reads the live background jobs the existing jobs owner already owns (the single parent-session `JobRegistry`), projected into the safe wire shape. Params must be an empty object.

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-58", "method": "list_jobs", "params": {} }
```

Only an empty params object is accepted; any other key is rejected as `invalid_request`. A read has no side effect: it never starts, stops, or polls a job, and never emits an event.

Success:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-58",
  "ok": true,
  "data": {
    "jobs": [
      { "id": "job-1", "label": "CI for PR 42", "status": "running", "startedAt": 1788600000000 },
      { "id": "job-2", "label": "Deploy staging", "status": "exited", "startedAt": 1788599000000, "endedAt": 1788599500000, "exitCode": 0 }
    ]
  }
}
```

Each entry carries only the whitelisted fields of the owner's `JobRecord`:

| Field | Meaning |
| --- | --- |
| `id` | The owner's opaque job identifier. |
| `label` | The label the agent gave the job. A job started without one shows a fixed `Background job` (or `Background monitor` for a monitor): no part of its command, program name, arguments or paths crosses the wire, because a command can hide a secret in more shell forms than a parser could safely strip. |
| `status` | One of `running`, `exited`, `stopped`, or `failed`. |
| `startedAt` | When the job started, in milliseconds. |
| `endedAt` | When a non-running job ended, present only after it ends. |
| `exitCode` | The job's own exit code, present only when the owner recorded one (`null` for an exit without a code). |

No command text, working directory, output path or tail, environment, owner session id, monitor counters, or error string ever crosses the wire in a list entry; a job's output tail is available only through the separate, owner-verified [`get_job_output`](#get_job_output) read. The list is bounded: running jobs first (newest start first), then recently-finished jobs (newest end first) within a 60-second linger, capped at 50 entries, so the answer can never grow with the process lifetime. When the jobs owner is absent (the owning extension is not loaded), the answer is `jobs_unavailable` — never a fabricated empty list.

### `cancel_job`

Stops one running background job through the same owner stop path as `job_stop`: the monitor controller's `cancel` (dropping its timers and pending lines) followed by the registry's `stop` (aborting the process tree). Params are exactly `{ id }`.

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-59", "method": "cancel_job", "params": { "id": "job-1" } }
```

| Param | Required | Type | Meaning |
| --- | --- | --- | --- |
| `id` | yes | non-empty string | The job to stop, as reported by `list_jobs`. |

Only the `id` key is accepted; any other key, a non-string or empty `id`, or a request shaped like `job_stop`'s `job_id` is `invalid_request`. The id is resolved against the active owner session, exactly like `job_stop`'s ownership check: an unknown id or a job owned by another session is a typed `not_found`, never a stop of someone else's job.

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-59",
  "ok": true,
  "data": {
    "job": { "id": "job-1", "label": "CI for PR 42", "status": "stopped", "startedAt": 1788600000000, "endedAt": 1788601000000 }
  }
}
```

The response is the **actual post-action state**, re-read from the owner — never an echo of the request. A job that was already terminal (an `exited`, `stopped`, or `failed` job) answers that terminal state with `status` unchanged and no `changed` marker, and emits no event; there is no race-driven error for a job that finished just before the cancel. The response line always precedes its `jobs_update` event.

### `get_job_output`

Reads one background job's bounded output tail from the existing jobs owner: the registry's own in-memory tail (the last 20 lines, at most 2 000 characters per line — `TAIL_LINES`/`MAX_TAIL_LINE_CHARS` in `lib/background-jobs.ts`). It is a pollable read: it never starts, stops, or changes a job, never reads the job's log file, and emits no event. Params are exactly `{ id }`.

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-60", "method": "get_job_output", "params": { "id": "job-1" } }
```

| Param | Required | Type | Meaning |
| --- | --- | --- | --- |
| `id` | yes | non-empty string | The job to read, as reported by `list_jobs` or `jobs_update`. |

Only the `id` key is accepted; any other key, a non-string or empty `id`, or a `job_id` key is `invalid_request`, answered before any owner work. The id is resolved against the active owner session with the same ownership rule `list_jobs` and `cancel_job` apply: an unknown id or a job owned by another session is a typed `not_found`, never another session's output.

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-60",
  "ok": true,
  "data": {
    "job": { "id": "job-1", "label": "CI for PR 42", "status": "running", "startedAt": 1788600000000 },
    "output": "✓ lint\n✓ typecheck\nrunning tests 100%",
    "truncated": true
  }
}
```

| Field | Meaning |
| --- | --- |
| `job` | The same whitelisted projection as one `list_jobs` entry (`id`, `label`, `status`, `startedAt`, `endedAt?`, `exitCode?`), so a poller knows when the job has ended. |
| `output` | The tail as one plain-text field: the kept lines joined by `\n`, oldest first. Empty when the job has printed nothing yet. |
| `truncated` | `true` once the tail stopped being the job's whole output: earlier lines were dropped, or a line longer than 2 000 characters was shortened to its newest characters after a leading `…`. |

**Terminal control sequences are stripped server-side; the text is plain.** The owner tail keeps raw job output (it only joins chunks and strips a trailing CR), so progress bars and colored output carry ANSI escape sequences. This method removes CSI sequences (colors, cursor moves, 7- and 8-bit), OSC sequences (window titles, hyperlinks; BEL- or ST-terminated, or unterminated to the end of the line), DCS/SOS/PM/APC strings, and the remaining two-character escapes; a line that redraws itself with carriage returns shows only its last non-empty segment, which is what a terminal would leave visible; every other control character except tab is removed. A consumer renders `output` as plain text and must not expect, or interpret, escape sequences in it. Truncation is multi-byte safe: a half UTF-16 character left by a fixed-length cut is removed, never sent.

**The tail is not sanitized for content.** The wire carries no command, working directory, output path, environment, owner session id, monitor counter, or error string as a field, and nothing is inferred from the label. But `output` is arbitrary process output, and it can legitimately contain whatever the job printed: echoed commands, paths, tokens, or other secrets. That content is the job owner's own data; requesting it is the consumer session's standing decision. A consumer should treat it like terminal output — show it to the session owner, never log or forward it as if it were redacted.

The answer is bounded by construction: at most 20 lines and 40 019 UTF-16 code units (20 × 2 001 plus 19 newlines). The bridge re-validates the owner's answer, re-applies that bound (keeping the newest output and setting `truncated`), and re-normalizes it before it reaches the wire. When the jobs owner is absent, or the loaded owner adapter predates the output read, the answer is `jobs_unavailable`; a throwing or malformed owner answer is also `jobs_unavailable`, with no raw error on the wire. There is no `job_output` event: a client that shows a live tail polls this method.

### `list_subagents`

Reads the live subagents the existing agents owner already owns (the single parent-session `TaskStore`), projected into the safe wire shape. Params must be an empty object.

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-60", "method": "list_subagents", "params": {} }
```

Only an empty params object is accepted; any other key is rejected as `invalid_request`. A read has no side effect: it never starts, stops, or spawns a subagent, and never emits an event.

Success:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-60",
  "ok": true,
  "data": {
    "agents": [
      {
        "id": "m3a1-worker",
        "agent": "worker",
        "status": "completed",
        "model": "anthropic/claude-sonnet-4",
        "modelSource": "binding",
        "fallbackFrom": "anthropic/claude-opus-4",
        "thinking": "high",
        "lastStep": "answered",
        "usage": { "total": 15234, "cost": 0.0421, "input": 12000, "output": 3234, "cache": 5000, "reasoning": 4000 }
      }
    ]
  }
}
```

Each entry carries only the whitelisted fields of the owner's `TaskRecord`:

| Field | Meaning |
| --- | --- |
| `id` | The owner's opaque task identifier. |
| `agent` | The helper's agent name. |
| `status` | One of `queued`, `running`, `waiting`, `completed`, `failed`, `cancelled`, or `timed_out`. |
| `model` | The routed model the helper launched with (or moved to). |
| `modelSource` | The launch-layer token that supplied `model` (`binding`, `frozen:*`, `pin:*`, `declaration`, `profile`, `definition`, or `default`), present only when the launch recorded one. |
| `fallbackFrom` | The model the run moved away from, present only after a fallback switch. |
| `thinking` | The thinking level the helper ran at, present only when one was resolved. |
| `lastStep` | A closed phase label derived from the task status, never the raw owner step text: `queued`, `waiting`, `running`, a fixed safe active step (`starting`, `writing`, `cleaning up`, `generating tool arguments`, `question dismissed`, `answered`, `interrupted`), or the generic terminal reason (`completed`, `failed`, `cancelled`, `timed_out`). Raw `TaskRecord.lastStep` text can carry an error message, a stderr tail, or a provider body, so it is mapped into this closed vocabulary and never forwarded. |
| `turns`, `toolCalls` | Progress inside the run: turns finished and tool calls started so far. Absent only from an owner that predates them. |
| `activeTool` | The name of the tool running right now, only while the task is active and only when the name is a plain identifier (`[A-Za-z0-9_.:-]`, at most 64). Its arguments and output never cross; read them with `get_subagent_thread`. |
| `usage` | The helper's accumulated usage: `total` tokens, `cost`, and — once the run settled — the final-assistant `input`, `output`, `cache` (read + write), and `reasoning` token breakdown. The breakdown fields are absent for an in-flight task whose breakdown is not recorded yet, and for a restored finished task whose run never recorded one. |

No prompt text, tool arguments or output, working directory, session path, result, error text, or full session internals ever cross the wire in a list entry; tool arguments, tool output, and thread text are only readable, bounded, through [`get_subagent_thread`](#get_subagent_thread). The list is bounded: active tasks first (recency order), then recently-finished tasks (newest end first), capped at 50 entries, so the answer can never grow with the process lifetime. When the agents owner is absent (the owning extension is not loaded), the answer is `agents_unavailable` — never a fabricated empty list.

### `cancel_subagent`

Stops one subagent through the same owner stop path the agents panel uses: `runner.cancel`. Params are exactly `{ id }`.

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-61", "method": "cancel_subagent", "params": { "id": "m3a1-worker" } }
```

| Param | Required | Type | Meaning |
| --- | --- | --- | --- |
| `id` | yes | non-empty string | The subagent to cancel, as reported by `list_subagents`. |

Only the `id` key is accepted; any other key, a non-string or empty `id`, or a request shaped like `subagent_status`'s `task_id` is `invalid_request`. The id is resolved against the active owner session: an unknown id or a subagent owned by another session is a typed `not_found`, never a cancel of someone else's task. No cancellation is done by asking the model — it is always the owner's own `runner.cancel` path.

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-61",
  "ok": true,
  "data": {
    "agent": { "id": "m3a1-worker", "agent": "worker", "status": "cancelled", "model": "anthropic/claude-sonnet-4", "lastStep": "cancelled", "usage": { "total": 15234, "cost": 0.0421 } }
  }
}
```

The response is the **actual post-action state**, re-read from the owner — never an echo of the request. The owner honors `runner.cancel`'s boolean result and the store's actual synchronous transition:

- A **queued** task is finished synchronously: `runner.cancel` returns `true` and the store transitions to `cancelled`, so the response reports `cancelled` and is followed by one `agents_update` event.
- A **running** task is cancelled asynchronously: `runner.cancel` returns `true` but the store has not transitioned yet, so the response reports the still-`running` state and emits **no immediate event**. The real transition (the child exit to `cancelled`) arrives later through the normal `agents_update` path. A repeated in-flight cancel is likewise `changed: false` with no event.
- An already-terminal task returns its terminal state with no event; there is no race-driven error for a task that finished just before the cancel. An unknown or foreign id is a typed `not_found`. The response line always precedes any `agents_update` event.

### `get_subagent_thread`

Reads one subagent's bounded activity thread from the same `TaskStore` the `gentle-agents.activity/v1` widget projects, so a client can show what a finished or background subagent did. Params are `{ id, sinceVersion? }`.

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-62", "method": "get_subagent_thread", "params": { "id": "m3a1-worker", "sinceVersion": 41 } }
```

| Param | Required | Type | Meaning |
| --- | --- | --- | --- |
| `id` | yes | non-empty string | The subagent to read, as reported by `list_subagents`. |
| `sinceVersion` | no | non-negative integer | The `version` of the client's last read of this thread. |

Only the `id` and `sinceVersion` keys are accepted; any other key, a non-string or empty `id`, or a `sinceVersion` that is not a non-negative integer is `invalid_request`, rejected before the owner is reached. The id is resolved with the same ownership rule as `list_subagents` and `cancel_subagent`: only a subagent whose parent session is the calling session is readable; an unknown id, a subagent of another session, or a finished subagent the store has already evicted is a typed `not_found`. When the agents owner is not loaded, the answer is `agents_unavailable`. A read has no side effect and never emits an event.

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-62",
  "ok": true,
  "data": {
    "id": "m3a1-worker",
    "version": 57,
    "items": [
      { "kind": "text", "text": "Mapping the repository layout." },
      { "kind": "tool", "name": "read", "args": "{\"path\":\"README.md\"}", "running": false, "isError": false, "output": "# Project…" },
      { "kind": "note", "text": "retrying (2/3)" }
    ],
    "dropped": 0,
    "truncated": false
  }
}
```

| Field | Meaning |
| --- | --- |
| `id` | The subagent the thread belongs to. |
| `version` | The store's thread version. It grows with every change to the thread, including in-place changes to an existing item. |
| `items` | The thread, oldest first, in the exact projection and bounds of `gentle-agents.activity/v1`: the last 40 items; `text`, `thinking`, and `note` items carry `text` (at most 2 000 characters); `tool` items carry `name`, `args` (the JSON-encoded arguments, at most 500 characters), `running`, `isError`, and `output` (at most 500 characters). A cut field ends with `…`. The list is then bounded to 256 KB by the same halving the widget applies. |
| `dropped` | How many older items the store itself evicted from this thread (beyond its own 400-item retention). They are gone and no read can return them. |
| `truncated` | `true` when the store still holds more items than `items` carries (the 40-item window or the byte bound cut older ones). |

`sinceVersion` makes polling cheap. When it equals the current `version`, nothing changed since that read: `items` is empty and `truncated` is `false`. Any other value returns the whole bounded window. The store keeps one version per thread, not per item, and an item can change after it first appears (streamed text merges into the last text item; a tool item receives its output and end state later), so the whole window is the smallest answer guaranteed to contain every changed item. A client replaces its view with the returned items.

Tool args and output are the subagent's own data: they contain whatever its tools received and printed, which can include file contents, command output, or anything else the subagent read. They are bounded, not redacted. Text, thinking, and note items are likewise the subagent's own output (a note can carry an error message). Prompt text, the working directory, the session path, the tool call id, and the result are not part of a thread item.

### `get_usage_stats`

Reads cross-session usage — the same history `/gentle:stats` shows — through the stats owner's own loader and the same `aggregateStats` aggregation the panel runs, so the panel and Desktop never disagree. Params are optional `range` and `scope`.

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-61", "method": "get_usage_stats", "params": { "range": "30d", "scope": "all" } }
```

| Param | Required | Values | Meaning |
| --- | --- | --- | --- |
| `range` | no | `7d` (default), `30d`, `all` | The local calendar days counted: the last 7 or 30 days including today, or everything. |
| `scope` | no | `project` (default), `all` | `project` counts only sessions whose working directory is this session's; `all` counts every session. |

Any other key, or any other value (including `null`), is rejected as `invalid_request` before the owner is asked. A read has no side effect: it never writes, and never emits an event.

Success:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-61",
  "ok": true,
  "data": {
    "range": "30d",
    "scope": "all",
    "totals": { "sessions": 3, "messages": 4, "inputTokens": 1310, "outputTokens": 155, "cacheReadTokens": 1000, "cacheWriteTokens": 200, "totalTokens": 2665, "cost": 1.76 },
    "byModel": [
      { "model": "claude-opus-5-5", "messages": 2, "tokens": 1365, "cost": 0.51, "share": 0.512 },
      { "model": "gpt-5.5", "messages": 2, "tokens": 1300, "cost": 1.25, "share": 0.488 }
    ],
    "byDay": [{ "day": "2026-09-20", "tokens": 1000, "cost": 1 }, { "day": "2026-10-08", "tokens": 300, "cost": 0.25 }, { "day": "2026-10-09", "tokens": 1365, "cost": 0.51 }],
    "byProvider": [{ "provider": "anthropic", "messages": 4, "tokens": 2665, "cost": 1.76, "share": 1 }],
    "byProject": [
      { "name": "alpha", "sessions": 2, "messages": 3, "tokens": 2365, "cost": 1.51 },
      { "name": "beta", "sessions": 1, "messages": 1, "tokens": 300, "cost": 0.25 }
    ],
    "truncated": { "byModel": false, "byDay": false, "byProvider": false, "byProject": false }
  }
}
```

| Field | Meaning |
| --- | --- |
| `totals` | Sessions with at least one assistant usage record in range, those records (`messages`), their token counts, `totalTokens` (each record's own total, or the sum of its parts when it has none), and `cost` in the provider's currency units. Totals always cover the whole range, even when an array below is truncated. |
| `byModel` | One row per model id, largest `tokens` first; `share` is the model's fraction of `totals.totalTokens`. At most 50 rows. |
| `byDay` | Tokens and cost per local calendar day (`YYYY-MM-DD`) with any usage, oldest first. At most 400 rows: the most recent days are kept. |
| `byProvider` | One row per provider id (as Pi records it on each assistant message, `unknown` when missing), largest `tokens` first; `share` is the provider's fraction of `totals.totalTokens`. At most 50 rows. |
| `byProject` | Present only for `scope: "all"`. One row per working directory, shown by its display name (the last path segment, never the path), largest `tokens` first. Two directories with the same last segment stay two rows. At most 50 rows. |
| `truncated` | `true` for each array that had more rows than its bound. `byProject` appears only with `byProject`. |

Model ids, provider ids, and project names longer than 128 characters are cut. No session id, path, prompt, or message text ever crosses the wire. The panel's other figures (streaks, most active day, longest session) are not part of this answer. When no sessions root can be read, or the stats owner is not loaded, the answer is `stats_unavailable` — never a fabricated zero.

### `apply_profile`

Applies one saved profile through the `/gentle:profiles` screen's own actions: `mode: "default"` runs **Make default for new sessions**, and `mode: "session"` runs **Use in this session**. There is no second apply implementation, so the diff confirmation, the pinned-repository rule, and the rollback are the screen's own.

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-62", "method": "apply_profile", "params": { "profile": "team", "mode": "default" } }
```

| Param | Required | Type | Meaning |
| --- | --- | --- | --- |
| `profile` | yes | string, 1–128 characters | A saved profile name in `profiles.json`. |
| `mode` | yes | `"default"` or `"session"` | `default` makes the profile the global default; `session` binds it to this RPC session only. |
| `confirmation` | no | string, 1–128 characters | The `token` from a previous `confirmation_required` answer for the same `profile` and `mode`. |

Any other key or a malformed value is `invalid_request`. A name that is not a saved profile is `unknown_profile`, and no routing, settings, agents, or pins are written. Like the screen on first open, a missing `profiles.json` is first seeded with a `current` profile from the routing in effect; that is the only write an `apply_profile` can make before its checks.

When the screen would ask before writing (`Apply profile "<name>"?`, `Apply empty profile?`, `Apply orchestrator-only profile?`), the answer is that same dialog, and nothing has been written:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-62",
  "ok": true,
  "data": {
    "profile": "team",
    "mode": "default",
    "status": "confirmation_required",
    "confirmation": {
      "title": "Apply profile \"team\"?",
      "message": "Profile \"team\" has agent routing entries. Applying it will replace global routing in … with this profile's routes: worker: openai/alpha (added). Continue?",
      "token": "3f1c…"
    }
  }
}
```

Desktop must show `title` and `message` to the human. Only when the human approves does it resend the request with `confirmation` set to `token`. Declining means not resending; nothing was written.

- **The token is bound to what was shown.** It hashes the mode, the profile name, the exact title and message, and the exact saved profile content the apply uses. If the diff, the current routing, or the saved profile changed since it was shown, the old token no longer matches, and the request answers `confirmation_required` again with the new text and a new token. Editing the profile asks again even when the dialog lists no routes (for example the empty, orchestrator-only, or unreadable-routing dialogs).
- **The token is not authentication.** Whoever can write Pi's RPC stdin can read the token and resend it. Getting a human to confirm is Desktop's job; the token only guarantees that the apply runs against the text that was shown.
- **Not every apply asks.** A pinned repository applies repo-scoped (it re-pins this clone and writes no global routing or orchestrator) and never asks. A profile that already matches the current global routing and orchestrator never asks: as on the screen, it still claims the profile and re-materializes the same routing, reports `applied`, and its `notes` start with the "already matches" line. `session` never asks.

Otherwise the answer is the outcome, with the screen's notices as `notes` (`level` is `info`, `warning`, or `error`):

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-63",
  "ok": true,
  "data": {
    "profile": "team",
    "mode": "default",
    "status": "applied",
    "notes": [{ "level": "info", "text": "el Gentleman applied profile \"team\" — 1 agent updated. …" }]
  }
}
```

`applied` is followed by one `profile_applied` event. The status follows the screen's last notice: `applied` when it ended with an `info` notice, `not_applied` when it ended with a warning or with no notice; `notes` lists every notice in order, including a first-run seeding notice. For `not_applied` they say why, and when a write failed after the profile was claimed, the screen's rollback has already restored what it could. `not_applied` emits no event.

`session` binds the profile to the RPC session through the same session-profile path as the screen's Enter: it writes no global routing, no pins, no materialized stores, and does not change the active marker in `profiles.json`.

Only one apply runs at a time in a Pi process, across sessions. A request that arrives while another apply is running answers `profile_apply_busy` and changes nothing. While an apply runs, `set_config` for `profiles`, `profile_fallbacks`, and `pins` also answers `profile_apply_busy` and writes nothing: the apply rewrites the profiles store (and restores it on failure) from the snapshot it read, so an edit accepted mid-apply would otherwise be lost. Retry after the apply answers. The `/gentle:profiles` screen's Use in this session and Make default (including the save they make first) take the same gate, so they never run alongside a Desktop apply and a Desktop apply answers `profile_apply_busy` while one of them runs.

### `list_sessions`

Lists saved Pi sessions through Pi's own session owner (`SessionManager.list` / `listAll`), newest first, so a client can offer a "resume session" list without reading Pi's session files or settings.

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-70", "method": "list_sessions", "params": { "scope": "project", "limit": 20 } }
```

| Param | Required | Type | Meaning |
| --- | --- | --- | --- |
| `scope` | no | `"project"` or `"all"` | `project` (default) lists the active project's sessions; `all` lists every project's. |
| `limit` | no | integer 1–50 | Page size; default 20. |
| `cursor` | no | string | The opaque `nextCursor` of the previous page. |

Any other key, a non-integer or out-of-range `limit`, an unknown `scope`, or a cursor this slice did not issue is `invalid_request`, answered before any session is read. The session directory is resolved exactly as Pi's `/resume` resolves it, from the live session manager: `project` is `list(cwd, sessionDir)`, and `all` is `listAll()` for the default directory or `listAll(sessionDir)` for a custom `sessionDir` (settings, `--session-dir`, or `PI_CODING_AGENT_SESSION_DIR`). A read has no side effect and never emits an event.

Success:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-70",
  "ok": true,
  "data": {
    "sessions": [
      { "id": "0b5c9a12-7d4e-4f3a-9c1e-2a6b8d0f4e31", "name": "Release prep", "modified": 1793577600000, "messageCount": 14, "firstMessage": "Prepare the 1.4 release notes", "project": "gentle-shell", "current": true },
      { "id": "5e21f0aa-3b7c-4d18-8f6e-91c2d4b7a053", "modified": 1793491200000, "messageCount": 3, "firstMessage": "Why does the build fail on Windows?", "project": "gentle-shell", "current": false }
    ],
    "nextCursor": "WzE3OTM0OTEyMDAwMDAsIjVlMjFmMGFhIl0"
  }
}
```

| Field | Meaning |
| --- | --- |
| `id` | Pi's session id; pass it to `switch_session`. |
| `name` | The name the user gave the session, present only when set; at most 200 characters. |
| `modified` | Last activity (latest message time, else the session start), in milliseconds. |
| `messageCount` | Messages in the session file, as Pi counts them. |
| `firstMessage` | The first user message with whitespace collapsed, at most 200 characters; a cut ends with `…`. Pi reports `(no messages)` for an empty session. |
| `project` | The display name of the session's project: the last segment of its working directory, or `unknown`. Never a path. |
| `current` | `true` for the session this Pi process is running. |

No file path, working directory, parent-session path, or full message text ever crosses the wire. `nextCursor` is present only when more sessions follow; it is a keyset position (last time and id), so sessions saved between pages never shift or repeat entries. When no Desktop command has bound a session context, or the context has no session manager or session directory (an in-memory session), the answer is `sessions_unavailable`.

### `switch_session`

Switches this Pi process to a saved session by id. The id is resolved through Pi's owner (`SessionManager.findById`, plus the exact id in Pi's all-sessions listing for `scope: "all"`), and the switch is the command context's own `switchSession`. The session file path never crosses the wire, in either direction.

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-71", "method": "switch_session", "params": { "id": "5e21f0aa-3b7c-4d18-8f6e-91c2d4b7a053" } }
```

| Param | Required | Type | Meaning |
| --- | --- | --- | --- |
| `id` | yes | non-empty string, at most 256 characters | A session id from `list_sessions`. |
| `scope` | no | `"project"` or `"all"` | Where the id is resolved: `project` (default) or every project. Pass the scope the id was listed with. |

Any other key (including a Pi-style `sessionPath`), a missing or empty `id`, or an unknown `scope` is `invalid_request`. An id that does not resolve in the requested scope is `not_found`, and nothing is switched. When no Desktop command has bound a session context, or that context cannot switch, the answer is `sessions_unavailable`.

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-71",
  "ok": true,
  "data": { "id": "5e21f0aa-3b7c-4d18-8f6e-91c2d4b7a053", "changed": true }
}
```

- **Switching to the current session** is a no-op: `{ "id": …, "changed": false }`, no switch, no event.
- **A cancelled switch** (an extension's `session_before_switch` handler cancelled it) answers `{ "id": …, "changed": false, "cancelled": true }`; the session is unchanged.
- **A refused switch** (for example the session's working directory no longer exists) answers `sessions_unavailable` with a fixed message; Pi's error, which names paths, never crosses.
- **The sequence resets.** A switch starts a new session, exactly like Pi's own `switch_session`: the old session receives `session_shutdown`, the new one starts with a fresh channel, and event `seq` starts again at 1. The response is published by the new session, after it started, still correlated by `requestId`; an event of the new session may precede it. Fetch `get_snapshot` after a switch.
- **One switch at a time; nothing is lost.** From the moment a `switch_session` is dispatched until it answers, every other Desktop request (any method, including another `switch_session` and `capabilities`) is answered at once with the retryable `session_switching` error and does nothing. A request that was already waiting on an owner when the switch tears the session down is answered `session_switching` right before the teardown, and a request Pi delivers to the replaced session during the replacement is answered `session_switching` too. Every request gets exactly one response; only the switch itself answers from the new session. This includes `capabilities` and `get_snapshot`: they are refused too, because their answer would describe the session being replaced. Retry every refused request, including those two, after the switch's response arrives. A switch that ends without replacing the session (cancelled, refused, or `not_found`) releases the gate at once. Use a fresh `requestId` per request: the exemption for the in-flight switch is by `requestId`.
- **A streaming turn is aborted.** Pi settles any active response before it replaces the session, so a switch during a streaming turn aborts that turn and persists it to the old session first, as Pi's own `switch_session` does.
- This slice emits no event of its own.

### `get_changes`

Reads the session's uncommitted changes from the same owner `/gentle:changes` uses: the shell's `WorktreeChangesTracker` over the session's roots (its own repository and every worktree its subagents used), each against its `HEAD`, untracked files included. Params must be an empty object.

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-70", "method": "get_changes", "params": {} }
```

Success:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-70",
  "ok": true,
  "data": {
    "roots": [{ "id": "root-1", "label": "gentle-shell" }],
    "files": [
      { "root": "root-1", "path": "lib/shell-changes.ts", "status": "modified", "added": 12, "deleted": 3 },
      { "root": "root-1", "path": "notes.md", "status": "untracked", "added": 4, "deleted": 0 }
    ],
    "truncated": false
  }
}
```

| Field | Meaning |
| --- | --- |
| `roots[].id` | An opaque, session-scoped root identifier (`root-1`, `root-2`, …). It names a root for `get_change_diff`; it is not a path. |
| `roots[].label` | A display name: the root's directory name. Never an absolute path. Two roots can share a label; `id` tells them apart. |
| `files[].root` | The `id` of the root the file belongs to. |
| `files[].path` | The path relative to its root, exactly as Git reports it (`/` separators). |
| `files[].status` | One of `modified`, `added`, `deleted`, `renamed`, or `untracked`. |
| `files[].added`, `files[].deleted` | Line counts from `git diff --numstat HEAD`; an untracked file counts its own lines. |
| `truncated` | `true` when more than 200 files changed across all roots; `files` then holds the first 200 (roots in owner order, paths sorted within each root). |

Only roots with changes are listed, so a clean session answers `roots: []` and `files: []`. A read refreshes the owner's scan the way opening the panel does; it starts, writes, or stages nothing and never emits an event. Any params key is `invalid_request`. `changes_unavailable` answers when the session has no root to scan or when Git failed for any root: a failed scan is never reported as a clean root.

### `get_change_diff`

Reads one changed file's unified diff, the same Git diff the `/gentle:changes` panel shows for it: a tracked file is `git diff HEAD -- <path>`, an untracked file is a diff against an empty file. Unlike the panel, it runs with `--no-textconv --no-ext-diff` and `-c core.fsmonitor=false`, so it never executes a command the repository's configuration names; for a file with a `.gitattributes` textconv driver or an external diff driver the text is Git's plain diff and can differ from the panel. Params are exactly `{ root, path }`, both strings.

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-71", "method": "get_change_diff", "params": { "root": "root-1", "path": "notes.md" } }
```

Success:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-71",
  "ok": true,
  "data": {
    "root": "root-1",
    "path": "notes.md",
    "diff": "diff --git a/notes.md b/notes.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,4 @@\n+…\n",
    "truncated": false
  }
}
```

`path` must be a file in the owner's current change set for that root, matched exactly against the owner's own file list (no normalization, no case folding). Anything else answers `not_found`: an unknown or stale root id, a root's absolute path or label in place of its id, a path outside the set (including a clean tracked file or `.git/config` that exists on disk), `..` traversal, an absolute path, a path whose directory resolves outside the root through a link (Git for Windows lists files behind a junction as part of the tree), or a path whose directory resolves inside the repository's git dir or common dir (for example a junction to `.git` inside the root). The method can never read an arbitrary file.

A diff is file content: it can contain whatever the user's files contain, secrets included, exactly as the panel would show them. Nothing beyond the diff text is added — no absolute path, no Git command. `diff` is capped at 256 KiB of UTF-8, cut after the last whole line inside the bound (or on a character boundary for one very long line), with `truncated: true`. A diff past the panel's own 1 MiB bound, where the panel shows a "too large" notice, still answers its first 256 KiB with `truncated: true`. An empty `diff` means Git reported no difference. Wrong param types or extra keys are `invalid_request`; Git failing or timing out is `changes_unavailable`. A read never emits an event.

### `get_review_mode`

Reads the receipt-driven development (RDD) switch for this session's workspace through the same native review CLI adapter `/gentle:review-mode` uses (`gentle-ai review mode status --json`). It has no side effects and emits no event.

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-70", "method": "get_review_mode", "params": {} }
```

`params` must be empty; any key is `invalid_request`.

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-70",
  "ok": true,
  "data": {
    "effective": "disabled",
    "source": "global",
    "scopes": { "global": "disabled", "clone": "unset" }
  }
}
```

| Field | Values | Meaning |
| --- | --- | --- |
| `effective` | `enabled`, `disabled`, `unknown` | Whether reviews run in this workspace. |
| `source` | `default`, `global`, `clone`, `unknown` | Which setting decided `effective`: no setting (on by default), the machine-wide setting, or this repository's setting. |
| `scopes.global`, `scopes.clone` | `enabled`, `disabled`, `unset`, `unknown` | The stored machine-wide and repository settings. |

A failed, timed-out, or unrecognized read answers `effective: "unknown"` with every other field `unknown`. It fails closed and never guesses. When `gentle-ai` is not installed or does not support the command, the answer is `review_unavailable` instead.

### `set_review_mode`

Changes the switch. Because the switch is the user's, a change takes two calls: the first answers a confirmation and writes nothing, and only a second call carrying that confirmation's token writes.

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-71", "method": "set_review_mode", "params": { "enabled": false, "scope": "global" } }
```

| Param | Required | Type | Meaning |
| --- | --- | --- | --- |
| `enabled` | yes | boolean | `true` turns reviews on, `false` turns them off. |
| `scope` | yes | `"clone"` or `"global"` | `clone` changes this repository's setting; `global` changes the machine-wide setting. |
| `confirmationToken` | no | string, 1–128 characters | The `token` from a previous `confirmation_required` answer for the same `enabled` and `scope`. |

Any other key or a malformed value is `invalid_request`, rejected before the owner is reached. The first call answers the current mode and the dialog to show:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-71",
  "ok": true,
  "data": {
    "status": "confirmation_required",
    "enabled": false,
    "scope": "global",
    "mode": { "effective": "enabled", "source": "default", "scopes": { "global": "unset", "clone": "unset" } },
    "confirmation": {
      "title": "Turn review mode off machine-wide?",
      "message": "Receipt-driven development is currently on (decided by the default). Reviews will be off for every repository on this machine.",
      "token": "9b2e…"
    }
  }
}
```

Desktop must show `title` and `message` to the human and resend with `confirmationToken` only after the human approves. Declining means not resending.

- **The token is bound to what was shown.** It is a sha256 over `enabled`, `scope`, the exact title and message, and the owner state they were computed from (both stored settings, the effective mode, its source, and the owner's revision when it reports one). A wrong token, or a stale one because the switch changed in between (in the TUI, in Herdr, or in another process), answers `confirmation_required` again with the current text and a fresh token, and writes nothing.
- **The token is not authentication.** As with `apply_profile`, whoever can write Pi's RPC stdin can read and resend it; getting a human to confirm is Desktop's job.
- **No confirmation without a known state.** When the current state cannot be read, the answer is `review_unavailable` and nothing is written.

With a matching token the owner writes the setting, re-reads the switch, and answers the re-read state:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-72",
  "ok": true,
  "data": {
    "status": "applied",
    "enabled": false,
    "scope": "global",
    "changed": true,
    "mode": { "effective": "disabled", "source": "global", "scopes": { "global": "disabled", "clone": "unset" } }
  }
}
```

The semantics are the owner's own. A machine-wide off wins over a repository setting, so `enabled: true` with `scope: "clone"` only clears this repository's off setting and cannot override a machine-wide off: it answers `applied` with `effective: "disabled"` and `source: "global"`, and its confirmation message says so before anything is written. `changed` is `true` only when the re-read state differs from the state the confirmation was computed from, in `effective`, `source`, or either scope. A no-op answers `changed: false`. When the re-read itself fails, `mode` is the fail-closed unknown shape and `changed` is `false`. A write whose outcome is unknown (it failed or timed out after starting) answers `review_unavailable` and is never retried; re-read with `get_review_mode`.

Only one `set_review_mode` runs at a time in a Pi process. A request that arrives while another is running answers `review_mode_busy` and changes nothing. `get_review_mode` is never blocked.

### `get_update_status`

Reports whether Gentle Shell, Pi, and Pi's packages have updates, from the sources that already own those answers: Gentle Shell's own channel and version resolution, the release lookup `gentle-shell upgrade` uses, and Pi's own package update check (the one behind its "Package updates are available" notice). The only param is an optional `refresh`.

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-71", "method": "get_update_status", "params": { "refresh": true } }
```

| Param | Required | Values | Meaning |
| --- | --- | --- | --- |
| `refresh` | no | `false` (default), `true` | `false` answers from what is already known and does no network work: the launcher's recorded release lookup (`startupReleaseCheck` in the launcher config) and the result of an earlier refresh in this Pi process. `true` runs the lookups once, all bounded by one 15-second deadline; concurrent refreshes share one run. |

Any other key, or a non-boolean `refresh` (including `null`), is rejected as `invalid_request` before anything is read. A read has no side effect: a refresh result lives only in this process's memory, nothing is written (not even the launcher's cache), and no event is emitted.

Success:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-71",
  "ok": true,
  "data": {
    "refreshed": true,
    "offline": false,
    "gentleShell": { "current": "4.8.0", "latest": "4.9.0", "channel": "release", "state": "update_available", "command": "gentle-shell upgrade", "checkedAt": "2026-11-17T12:00:00.000Z" },
    "pi": { "current": "1.5.2", "latest": null, "state": "unknown", "command": "gentle-shell update", "checkedAt": null },
    "packages": {
      "available": true,
      "items": [
        { "name": "pi-web-access", "kind": "npm", "scope": "user", "current": "1.4.0", "latest": null, "pinned": false, "state": "update_available" },
        { "name": "github.com/user/repo", "kind": "git", "scope": "project", "current": null, "latest": null, "pinned": true, "state": "skipped" }
      ],
      "truncated": false,
      "command": "gentle-shell update --extensions",
      "checkedAt": "2026-11-17T12:00:00.000Z"
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `refreshed` | `true` only when this answer ran the lookups (`refresh: true` and not offline). |
| `offline` | `PI_OFFLINE` is set (any value). Then nothing is looked up, even with `refresh: true`, and every looked-up item of a refresh answers `unknown`. A plain read still shows earlier answers with their `checkedAt`. |
| `gentleShell.channel` | `bundled` (a bundled prefix install), `gentle-ai-managed` (gentle-pi loaded as the `npm:gentle-pi` Pi package, the way the Gentle AI managed stack declares it), `main` or `release` (the channel record `gentle-shell upgrade` keeps; no record means `release`), or `unknown` when that record cannot be read. |
| `gentleShell.latest` | The latest stable `gentle-pi` release; for `main`, the first 12 characters of the latest `main` commit. `null` when unknown. |
| `gentleShell.command`, `pi.command`, `packages.command` | Fixed text for that kind of install: `gentle-shell upgrade` (`release`, `bundled`), `gentle-shell upgrade --channel main` (`main`), `gentle-shell update --extensions` (`gentle-ai-managed`, and packages), and `gentle-shell update` (Pi). `null` for an `unknown` channel. Never built from user input. |
| `state` (Gentle Shell, Pi) | `update_available` when the latest version is newer (the launcher's own stable-version comparison; for `main`, the running version does not carry the latest commit), `up_to_date` only when a successful lookup returned exactly the running version, otherwise `unknown`: never looked up, offline, failed, timed out, or not comparable (a prerelease or a newer local build). |
| `pi.latest` | Only a bundled install can name the latest Pi (its own `publishedPi` lookup). Elsewhere the latest Pi is resolved only through the package manager that owns it while `gentle-shell update` runs, so it stays `null` and `unknown`. |
| `packages.items` | One row per configured Pi package (Pi's own listing), in Pi's order, at most 100. `name` is Pi's display name (npm name or `host/path`) or a local package's last path segment; `current` is an installed npm package's version. |
| `packages.items[].state` | `update_available` when Pi's check reports a newer version; `no_update_reported` when it did not (Pi's check treats a failed lookup like "no update", so this is never claimed as up to date); `skipped` for a package Pi never checks (pinned, local, or not installed); `unknown` when not checked yet, offline, the check failed or timed out, or Pi's parser could not classify the source. |
| `packages.items[].latest` | Pi's check reports only that a newer version exists, not which one: always `null`. |
| `packages.available` | `false` when Pi's package listing could not be read; `items` is then empty. |
| `checkedAt` | When the answer shown was looked up (ISO 8601), per item: a refresh's time, or the launcher's recorded lookup time. `null` when no lookup backs the answer. |

No absolute path, raw package source, registry URL, token, command line, or lookup output crosses the wire. A failed lookup is reported as `unknown`, never by its message. Running an update is out of scope: the client shows the command, and the launcher runs it. `updates_unavailable` answers only when the session is not bound or was replaced during the read, or a source fails unexpectedly.

### `list_agent_definitions`

Lists the agent definitions `/gentle:profiles` can route, the subagent defaults, and Pi's default orchestrator, so a client can build its profile routing table from this answer alone. It reads the same roots `/gentle:profiles` lists, fresh on every call, lowest precedence first: the agents bundled with the package (the installed `pi-subagents` agent folders), `<agent home>/agents`, `<agent home>/subagents`, `~/.agents`, `<cwd>/.agents`, `<cwd>/.pi/agents`, and `<cwd>/.pi/subagents` (a later folder wins a name clash, so a project definition replaces a global one, and a user one replaces a built-in one). Only the `.md` files directly inside each folder are read. It also reads the global and project `subagents.json`, and the three orchestrator keys of Pi's `settings.json` in the agent home. Params must be an empty object; any key is `invalid_request`, and a malformed request reads nothing. It has no side effects and emits no event.

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-90", "method": "list_agent_definitions", "params": {} }
```

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-90",
  "ok": true,
  "data": {
    "agents": [
      { "name": "explore", "description": "Global explorer.", "scope": "global", "source": "user", "model": "openai-codex/gpt-5.6-terra", "thinking": "high", "mode": null, "tools": ["read", "grep"], "toolsTruncated": false },
      { "name": "worker", "description": "Project worker.", "scope": "project", "source": "project", "model": null, "thinking": null, "mode": "background", "tools": [], "toolsTruncated": false }
    ],
    "truncated": false,
    "problems": { "invalid": 1, "notices": 0 },
    "subagentDefaults": { "model": "anthropic/claude-luna", "thinking": null, "mode": "background" },
    "defaultOrchestrator": { "status": "set", "model": "openai-codex/gpt-5.6-terra", "thinking": "medium" }
  }
}
```

| Field | Meaning |
| --- | --- |
| `agents` | The discovered definitions, sorted by name, at most 200. `model`, `thinking`, and `mode` are what the definition declares (`null` when it inherits); the model a launch actually uses can still come from `subagents.json` profiles or a repository profile pin. `tools` is the list after tool overlays, at most 64 names. |
| `agents[].scope` | `global` for the built-in, agent-home, and `~/.agents` folders; `project` for the `<cwd>` folders. |
| `agents[].source` | Where the winning definition came from: `builtin` (bundled with the package), `user` (agent home or `~/.agents`), or `project` (`<cwd>/.agents` or `<cwd>/.pi`). |
| `truncated` | `true` when more than 200 definitions exist. |
| `problems` | Counts of definitions that failed to parse (`invalid`) and of discovery notices such as unknown frontmatter keys or overlays naming unknown agents (`notices`). Their text names files, so only counts cross. |
| `subagentDefaults` | `default_model`, `default_thinking`, and `default_mode` from `subagents.json` (project over global); `mode` defaults to `task`. |
| `defaultOrchestrator.status` | `set` when Pi's `settings.json` names `defaultProvider` and `defaultModel`; `unset` when the file exists without them; `missing` when the file does not exist; `invalid` when it cannot be parsed. `model` is `provider/model` and `thinking` is `defaultThinkingLevel`, both only when `set`. |

No file path, prompt body, or problem text crosses the wire. `agent_definitions_unavailable` answers when the session is not bound or discovery fails (for example an unreadable folder); its message never carries the failure text.

### `get_status`

Reads the facts `/gentle:status` prints for this session's project, through the status owner in `extensions/gentle-ai.ts` (a versioned owner service, like review). Params must be an empty object; any key is `invalid_request`, and a malformed request never reaches the owner. It has no side effects and emits no event.

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-95", "method": "get_status", "params": {} }
```

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-95",
  "ok": true,
  "data": {
    "package": "active",
    "odd": "active",
    "persona": "gentleman",
    "devBinary": { "state": "inactive", "sha256Prefix": null },
    "assets": {
      "delegation": { "stale": 0, "userOverrides": 1, "activeAgentOverrides": 0 },
      "review": { "stale": 0, "userOverrides": 0, "activeAgentOverrides": 0 }
    },
    "modelConfig": { "global": "present", "routing": "valid" },
    "severity": "info"
  }
}
```

| Field | Meaning |
| --- | --- |
| `persona` | The persona in effect: the project `persona.json` wins over the global one; `gentleman` by default. |
| `devBinary` | The `gentle-ai` dev-binary override: `inactive`, `active` (with the first 16 hex characters of its SHA-256), or `invalid` (declared but unusable). The binary is never run, so no version is reported; `/gentle:status` shows it. |
| `assets.<owner>.stale` | Managed `delegation` or `review` assets missing from the agent home or different from the packaged copy. `/gentle:install-<owner> --force` refreshes them. |
| `assets.<owner>.userOverrides` | Installed files the user replaced; preserved, not drift. |
| `assets.<owner>.activeAgentOverrides` | Active non-builtin agents that shadow package agents of that owner. |
| `modelConfig.global` | Whether the global `models.json` exists. |
| `modelConfig.routing` | The saved model routing: `missing`, `invalid`, or `valid`. Per-agent routing is read with `get_config` (`models`). |
| `severity` | `warning` exactly when `/gentle:status` warns: invalid routing, an active or invalid dev binary, stale assets, or active agent overrides. |

No path, command hint, or display text crosses the wire. `status_unavailable` answers when the session is not bound or was replaced during the read, no owner answers (for example inside a subagent process), or the owner's answer fails validation or throws; its message never carries the failure text.

### `get_background_subagents`

Reads the background-subagents policy the way `/gentle:background-subagents status` resolves it for this session's project: the project file `.pi/gentle-ai/background-subagents.json`, then the machine-wide file in the Gentle config home, then `GENTLE_PI_BACKGROUND_SUBAGENTS`, then the default `off`. Params must be an empty object. It has no side effects and emits no event.

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-96",
  "ok": true,
  "data": { "effective": "off", "source": "default", "malformed": false, "projectFile": "absent", "globalFile": "absent", "capability": "ready" }
}
```

| Field | Meaning |
| --- | --- |
| `effective` | `on` or `off`: whether background subagents may be launched. |
| `source` | What decided it: `project`, `global`, `environment`, or `default`. |
| `malformed` | The deciding file exists but is not a valid policy file; the policy is then `off` (fail closed). |
| `projectFile`, `globalFile` | `present` or `absent`. No path crosses the wire. |
| `capability` | `ready` when this session can launch background subagents at all, `absent` otherwise. Read-time only. |

### `set_background_subagents`

Writes the machine-wide policy, exactly as `/gentle:background-subagents enable|disable` does. The policy is a user-owned switch, so a change takes two calls, like `set_review_mode`.

| Param | Required | Type | Meaning |
| --- | --- | --- | --- |
| `policy` | yes | `on` \| `off` | The machine-wide policy to write. |
| `confirmationToken` | no | string (1-128) | The token from the confirmation answer. |

Any other key, including a `scope`, is `invalid_request`: only the machine-wide file is written, never a project file. Without a matching token the answer is `{ "status": "confirmation_required", "policy", "state", "confirmation": { "title", "message", "token" } }` and nothing is written. The message says when this project's file decides instead, so the change would not apply here. The token is bound to the request, the exact text shown, and the state it describes: if the state changes before the second call, the answer asks again. A request dispatched before a session reset is refused, even if a replacement session attached meanwhile.

With a matching token the owner writes the file and re-reads: `{ "status": "applied", "policy", "changed", "state" }`. `state` is the re-read state (so `effective` can stay unchanged when a project file decides), and `changed` reports whether it differs from the state shown.

Errors: `invalid_request`; `background_subagents_busy` while another Desktop change is in progress; `background_subagents_unavailable` when no owner answers (for example inside a subagent process), the state cannot be read, the request predates a session reset, or the write did not complete (re-read the policy).

### `get_profile_binding`

Reads which profile this session routes its subagents with, through the same rule launches, the status bar, and `/gentle:profiles` use (`resolveSessionProfile`). A binding chosen in the terminal, restored on resume, or inherited at the session's start is reported exactly as a launch would apply it. Params must be an empty object. It writes nothing and emits no event; like the status bar and the Desktop feed, the read can freeze the inherited profile of a session that has not frozen it yet, which is the same freeze its first launch would do.

```json
{ "ok": true, "data": { "kind": "explicit", "profile": "fast", "origin": "session" } }
```

| Field | Meaning |
| --- | --- |
| `kind` | `explicit` (chosen for this session), `inherited` (the profile the session started with), `follow` (follows the shared layers live, `GENTLE_PI_PROFILE_FOLLOW`), or `live` (a child session reading the layers). |
| `profile` | The profile name, or `null` for the routing without a profile. |
| `origin` | `session` for an explicit choice; otherwise the layer that supplied it: `local` (the clone pin), `repo` (the repository declaration), or `global`; `null` without a profile. |

Errors: `invalid_request` (any param) and `profiles_unavailable` (no session id or working directory).

### `clear_profile_binding`

Runs `/gentle:profiles clear` for this session: the session goes back to the profile it started with, or to the routing without a session profile. Params must be an empty object. It takes the profile apply slot, so it never runs during an `apply_profile`.

```json
{ "ok": true, "data": { "status": "cleared", "changed": true, "binding": { "kind": "inherited", "profile": null, "origin": null } } }
```

`status` is `not_cleared` whenever the owner warned (for example an unreadable session record or unavailable profile authority), even if the binding moved; otherwise `cleared` when the binding store changed and `unchanged` when there was nothing to clear. The owner's notices are not forwarded. A binding written elsewhere while the clear runs is folded into the one `desktop` event. When the clear ends `busy` or fails, a binding written elsewhere while it ran is published afterwards as one `external` event. `binding` is the state after the call, and `changed` says whether it differs from before. A change also emits `profile_binding_changed` with `source: "desktop"`, after the response. Errors: `invalid_request`, `profile_apply_busy` while an apply runs, and `profiles_unavailable` when no owner answers or the owner predates this method.

Publishing a profile to the repository is not a separate method: it is the repository pin, written with `set_config` on `pins` with `{ "source": "repo", "profile": "<name>" }` (and `profile: null` to unpublish).

### `get_auth_status`

Lists the providers this session knows models for, and whether each has credentials and of which kind. It reads Pi's model registry (`ctx.modelRegistry`) from memory: no file is read and no credential value is ever touched. Params must be an empty object. It has no side effects and emits no event.

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-97",
  "ok": true,
  "data": {
    "providers": [
      { "provider": "anthropic", "displayName": "Anthropic", "configured": true, "type": "oauth", "source": "stored" },
      { "provider": "openai-codex", "displayName": "OpenAI Codex", "configured": false, "type": null, "source": null }
    ],
    "truncated": false
  }
}
```

| Field | Meaning |
| --- | --- |
| `provider` | Pi's provider id; sorted, at most 200. Ids that are not plain names are skipped. |
| `configured` | Pi has credentials it can use for this provider. |
| `type` | `oauth` (a sign-in) or `api_key` when configured, otherwise `null`. |
| `source` | Where Pi found them: `stored` (Pi's credential store), `runtime`, `environment`, `models_json` (a key or a command in `models.json`; which one is not said), or `extension` (a provider extension's fallback). `null` when not configured. |

The registry's status label (an environment variable name or a command) never crosses, nor any value. Errors: `invalid_request` (any param), and `auth_unavailable` (no registry in this session, or the registry read failed).

### `reload_credentials`

Makes this session pick up credentials added or removed elsewhere (another terminal's `/login`, the desktop app's own sign-in). Environment variables are read from the process environment at each lookup, so editing an environment file does not reach a running session without restarting. It calls `modelRegistry.refresh({ allowNetwork: false })`, which rebuilds which providers are configured and which models are available; no model catalog is fetched. Params must be an empty object. Concurrent calls share one refresh.

```json
{ "ok": true, "data": { "reloaded": true, "aborted": false, "failedProviders": [], "providers": [ /* as get_auth_status */ ], "truncated": false } }
```

`failedProviders` lists the ids whose refresh reported an error; the error text never crosses. Errors: `invalid_request`, `auth_unavailable` (no registry in this session, or the session was replaced during the reload), and `reload_failed` (the refresh itself failed).

## Responses

Success:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-42",
  "ok": true,
  "data": {}
}
```

Failure:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-42",
  "ok": false,
  "error": {
    "code": "unsupported_method",
    "message": "Unsupported Desktop RPC method"
  }
}
```

Current error codes are `invalid_request`, `unknown_store`, `read_only`, `invalid_data`, `revision_conflict`, `write_failed`, `unsupported_method`, `permission_unavailable`, `permission_denied`, `config_unavailable`, `usage_unavailable`, `design_unavailable`, `jobs_unavailable`, `agents_unavailable`, `profiles_unavailable`, `unknown_profile`, `profile_apply_busy`, `sessions_unavailable`, `session_switching`, `review_unavailable`, `review_mode_busy`, `stats_unavailable`, `not_found`, and `internal_error`. A request that cannot supply a valid correlation ID uses `requestId: null`. State/provider failures use the generic `internal_error` message rather than exposing raw paths, credentials, or provider errors. Transport failures from `setWidget` are never retried as a second response.

| Code | Meaning |
| --- | --- |
| `invalid_request` | Malformed envelope, unsupported params (including a physical path, `set_config` without `data`, or an `apply_profile` mode other than `default`/`session`), or an unknown permission mode. State unchanged. |
| `unknown_store` | A store identifier this slice does not implement. Nothing was read or written. |
| `read_only` | `set_config` named `models`, `subagents`, or `managed_assets`. Rejected before the payload was inspected; nothing was written. |
| `invalid_data` | `set_config` data the owner would reject or would silently drop. Nothing was written, and no file was created. |
| `revision_conflict` | `expectedRevision` was missing, unusable, or no longer current. Nothing was written. |
| `write_failed` | The owner's atomic write threw. State is whatever the owner left; the message stays generic. |
| `unsupported_method` | Method not in `capabilities`. |
| `permission_unavailable` | The permission owner did not answer for this session (extension not loaded, or the session changed). State unchanged. |
| `permission_denied` | The owner refused the change (for example a non-interactive or replaced session). State unchanged. |
| `config_unavailable` | No Desktop command has bound a session context, that context has no working directory, or a pin write was requested outside a resolvable Git worktree. |
| `usage_unavailable` | The usage owner did not answer for this session (extension not loaded, or the session changed). State unchanged. |
| `design_unavailable` | The design canvas owner did not answer for this session (the owning extension is not loaded, or the session changed). State unchanged. |
| `jobs_unavailable` | The background-jobs owner did not answer for this session (the owning extension is not loaded, or the session changed). State unchanged. |
| `agents_unavailable` | The subagents owner did not answer for this session (the owning extension is not loaded, or the session changed). State unchanged. |
| `changes_unavailable` | The changes owner did not answer for this session (the owning extension is not loaded, or the session changed), the session has no root to scan, or Git failed or timed out. Nothing was changed. |
| `profiles_unavailable` | The profiles owner did not answer for this session (the owning extension is not loaded, the session changed, or no Desktop command bound a session context). Nothing was written. |
| `unknown_profile` | `apply_profile` named a profile that is not saved in `profiles.json`. No routing, settings, agents, or pins were written (a missing `profiles.json` may have been seeded). |
| `profile_apply_busy` | An `apply_profile` is still running; returned to a second `apply_profile` and to `set_config` for `profiles`, `profile_fallbacks`, or `pins`. Nothing was written by this request. |
| `sessions_unavailable` | No Desktop command bound a session context, the context has no session manager, session directory, or `switchSession`, the installed Pi lacks the session owner calls, reading sessions failed, or Pi refused the switch. Nothing was switched. |
| `session_switching` | A `switch_session` was in flight when this request arrived (or the switch tore the session down while this request waited on an owner). Nothing was done; retry after the switch answers. |
| `review_unavailable` | The review-mode owner did not answer for this session (extension not loaded, subagent child, or no Desktop command bound a session context), `gentle-ai` is not installed or does not support `review mode`, `set_review_mode` could not read the current state, or a write's outcome is unknown. The message says which; it never carries a path, CLI output, or a command line. |
| `review_mode_busy` | A `set_review_mode` is still running. Nothing was written by this request. |
| `stats_unavailable` | No sessions root could be read, or the stats owner did not answer for this session (the owning extension is not loaded, or the session changed). Nothing was read. |
| `not_found` | `cancel_job` or `get_job_output` named a job id, or `cancel_subagent` or `get_subagent_thread` named a subagent id, that does not exist, belongs to another session, or was already evicted by the store; or `switch_session` named an id that does not resolve in the requested scope; or `get_change_diff` named a root and path that are not a file in the owner's current change set. Nothing was stopped, read, or switched. |
| `internal_error` | Unexpected failure; message stays generic. |

## Events

Domain events use the same widget channel:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "event",
  "seq": 1,
  "event": "example_event",
  "data": {}
}
```

The event name above is illustrative; `capabilities` is authoritative for implemented events. `seq` starts at 1 after successful delivery in each newly started session and resets on session shutdown, reload, or a session switch (Pi's own `switch_session` or this channel's). After shutdown the channel does not answer further commands. Clients should fetch `get_snapshot` after connecting and whenever they detect a sequence gap. Responses do not increment the event sequence.

### `permission_mode_changed`

Emitted in two ways:

- **`source: "desktop"`**: at most once per successful `set_permission_mode`, always after its response line, and never for rejected, unavailable, or no-op requests.
- **`source: "external"`**: asynchronously, when the session mode or the persisted default changes outside Desktop RPC (for example `/gentle:mode`, `/gentle:mode default`, or `/gentle:yolo`).

A Desktop change:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "event",
  "seq": 1,
  "event": "permission_mode_changed",
  "data": {
    "mode": "auto",
    "previous_mode": "normal",
    "default_mode": "auto",
    "persisted": true,
    "source": "desktop"
  }
}
```

For `source: "desktop"`, `persisted` reports whether that request saved the default. If the owner cannot confirm the state right after a `set_permission_mode` (the session was replaced or revoked meanwhile), the answer is `permission_unavailable` with no event, never an echo of the requested mode.

An external change:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "event",
  "seq": 2,
  "event": "permission_mode_changed",
  "data": {
    "mode": "yolo",
    "previous_mode": "normal",
    "default_mode": "normal",
    "persisted": false,
    "source": "external"
  }
}
```

External changes are driven by the permission owner's existing in-process observer (the one the desktop feed uses); there is no polling and no file watcher. Every owner notification restarts a debounce window of about 250 ms; when it closes, the channel re-reads the owner and emits only when `mode` or `default_mode` differs from the last state this channel reported (a `get_permission_mode` answer, a `set_permission_mode` answer, or an earlier event). `previous_mode` is the mode of that last reported state, and `persisted` is `true` when the persisted default is what changed. Consequences:

- a Desktop `set_permission_mode` is never echoed as an external event: its response records the confirmed state first, and an observer window that closes while a Desktop request is still applying waits for it;
- a burst inside one window is one event with the final state, and a change undone inside the window emits nothing;
- owner-side changes surface the same way, for example the owner revoking YOLO when the workspace or interactive host changes;
- a default written to the policy file by another process does not notify this process's owner, so it becomes visible on the next `get_permission_mode` and emits nothing;
- without the permission owner (extension not loaded), there are no external events and the methods answer `permission_unavailable`.

Observation starts on `session_start` for an interactive RPC host only, and stops on session shutdown and on session switch. Re-read with `get_permission_mode` after reconnecting or switching sessions.

### `config_changed`

Emitted in two ways:

- **`source: "desktop"`**: at most once per successful `set_config` that actually changed its target, always after its response line, and never for rejected, unavailable, conflicted, or no-op requests.
- **`source: "external"`**: asynchronously and best effort, when a store's revision changes outside Desktop RPC (`/gentle:profiles`, an editor saving `profiles.json`, the installer, or another `pi` process).

A Desktop write:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "event",
  "seq": 1,
  "event": "config_changed",
  "data": {
    "store": "profiles",
    "scope": "global",
    "writeTarget": "global",
    "revision": "sha256:1c8065f530f01fb3c8e1dc33a2001b63",
    "writeRevision": "sha256:c4b0afed3b2375ee0fb10e45a9545c78",
    "source": "desktop"
  }
}
```

For `source: "desktop"`, `store`, `scope`, `revision`, and `writeRevision` are the resulting values, identical to the response that precedes the event, so a client that missed the response can reconcile from the event alone.

An external change:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "event",
  "seq": 3,
  "event": "config_changed",
  "data": {
    "store": "profiles",
    "scope": "global",
    "revision": "sha256:5f1d0c7a9e2b4d6f8a0c2e4b6d8f0a1c",
    "status": "ok",
    "source": "external"
  }
}
```

`store`, `scope`, `revision`, and `status` match what `get_config` and `get_snapshot` would answer for that store at that moment. There is no `value`, no `writeTarget` or `writeRevision` (an external writer may have touched any layer), and no path; read the store with `get_config` for its content and write targets.

Detection watches the owner files' directories, non-recursively, for an interactive RPC host only: the config home (`profiles.json`, `profile-fallbacks.json`, `models.json`, `persona.json`, `banner.json`, `notifications.json`), the project `.pi/gentle-ai/` directory (`persona.json`), the agent home and its `gentle-ai/` directory (global `subagents.json`, the managed-assets manifest), the session cwd's `.pi/` and `.pi/gentle-ai/` (project `subagents.json` and `models.json`, the `repo` pin), and the Git common dir's `gentle-ai/` (the `local` pin) when the cwd is a resolvable worktree. Only events for those owner file names count. About 250 ms after the last relevant event, every store's revision is recomputed with the same readers `get_config` uses, and an event is emitted only for a store whose revision differs from the last revision this channel reported (a `get_config` answer, a `get_snapshot` projection, a `set_config` answer, or an earlier event). Consequences:

- a Desktop `set_config` is never echoed: its response records the resulting revision before the owner's own rename wakes the watcher;
- reformatting a file, rewriting identical content, or undoing a change inside the window emits nothing, because the revision did not move;
- a burst inside one window yields at most one event per changed store, and `pins` moves too when a `profiles` change makes a pin stale or valid.

`source` says whether the event answers a Desktop write **to that same store**. A Desktop write can change another store's derived state: for example a `set_config` on `profiles` that drops the profile a pin names makes `pins` stale. The `profiles` change is the `source: "desktop"` event that follows the response; the `pins` change arrives later through the watcher, exactly once, as `source: "external"`.

A directory that does not exist yet (for example a project without `.pi/`, or a fresh `<git-common-dir>/gentle-ai/`) is watched through its nearest existing ancestor, non-recursively and only for the creation of the next path segment. When that segment appears the ancestor watcher is closed and the next level is watched, until the owner directory itself is; each step recomputes once, so a pin that `/gentle:profiles` writes into a new directory raises exactly one event. A watched directory that is later removed reports its stores (now `missing`) and falls back to the same ancestor watching, so recreating it and writing the store again raises one event.

When a Desktop command binds a different session cwd, the watchers move with it, and the stores whose layers depend on the cwd (`models`, `subagents`, and `persona` project layers, and `pins`) are re-read at that moment: each one whose revision differs from the last one this channel reported is announced with `source: "external"` and becomes the new baseline, so a later unrelated change never carries stale extra events. If a change was detected but its debounce window had not closed when the cwd moved, every store is re-read instead, so that change is reported rather than dropped with the old watchers.

This is **best effort**, and `get_snapshot` revisions stay the source of truth. A path with no existing ancestor, an unsupported platform, or an exhausted watcher limit simply produces no external events for that directory; the channel keeps working and never reports an error for it. Watchers are created on `session_start` and are disposed, ancestor watchers included, on session shutdown and on session switch. A client that must not miss a change still compares `get_snapshot` revisions after connecting and after a sequence gap.

### `rate_limit`

Carries structured subscription-usage snapshots to subscribed Desktop consumers. It is emitted in two ways:

- **`source: "response"`** — asynchronously, whenever the existing usage owner records a snapshot from provider response headers (`after_provider_response`). Claude's 5h/7d windows arrive here, already parsed by the owner — the Desktop consumer never parses header text.
- **`source: "refresh"`** — after a `refresh_subscription_usage` that actually changed a snapshot's content. It follows the refresh response line and is omitted for a no-op (unsupported, out-of-scope, throttled, or failed) refresh.

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "event",
  "seq": 3,
  "event": "rate_limit",
  "data": {
    "source": "response",
    "snapshots": [
      {
        "provider": "anthropic",
        "status": "ok",
        "fetchedAt": 1788600000000,
        "limits": [
          {
            "name": "claude",
            "limitReached": false,
            "windows": [
              { "label": "5h", "usedPercent": 25, "windowSeconds": 18000, "resetAt": null },
              { "label": "week", "usedPercent": 90, "windowSeconds": 604800, "resetAt": null }
            ]
          }
        ]
      }
    ]
  }
}
```

Each snapshot entry is the same safe projection as `get_subscription_usage` (`provider`, `status`, `fetchedAt`, `plan` when public, `limits`), so a client that missed a response can reconcile from the event alone. `seq` advances exactly once per delivered event, through the same router sequencer as the other events.

### `design_canvas`

Carries the sanitized post-transition state of the session's design canvas whenever the existing design owner actually opens, refreshes, or stops it. It is emitted for **all** canvas transitions, whether they were initiated by the agent (`gentle_design` tool, `/gentle:design`) or anything else — the bridge subscribes to the owner eagerly, so agent-driven canvas work reaches a connected Desktop app even before any `get_design_canvas` request. There is no parsing of `Design canvas:` text anywhere: the owner emits the structured transition directly, and no event is emitted for a no-op or failed action (a refused slug, a browser that could not open, a server that could not start, or a `stop` with nothing running).

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "event",
  "seq": 2,
  "event": "design_canvas",
  "data": {
    "transition": "open",
    "running": true,
    "slug": "login",
    "connectedClients": 0,
    "url": "http://127.0.0.1:4100/<token>/d/login/"
  }
}
```

| Field | Meaning |
| --- | --- |
| `transition` | One of `open` (a canvas was shown: a browser tab opened, or the system browser was skipped because the host set `GENTLE_DESIGN_OPEN_BROWSER=0`), `refresh` (an already-connected page was told to reload), or `stop` (a running server was closed). |
| `running`, `slug`, `connectedClients` | The sanitized post-transition state, exactly as `get_design_canvas` reports it. A `stop` transition carries `running: false`, `slug: null`, `connectedClients: 0`. |
| `url` | Present only for a trusted interactive Desktop client (the same trust gate as `get_design_canvas` `includeUrl`). Sanitized by default — the URL and its embedded token are never a default event field and never a bare token. A `stop` transition has no URL. |

### `jobs_update`

Carries the active session's projected background-job list whenever the existing jobs owner's registry actually changes — a job starting (`bash_background`/`monitor`), settling (exit or failure), being stopped (`job_stop` or a Desktop `cancel_job`), or a monitor stopping itself on its timeout or flood limit. It is emitted for **all** such changes, not only Desktop-initiated ones, so a connected app can live-update its job list.

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "event",
  "seq": 2,
  "event": "jobs_update",
  "data": {
    "jobs": [
      { "id": "job-1", "label": "CI for PR 42", "status": "stopped", "startedAt": 1788600000000, "endedAt": 1788601000000 }
    ]
  }
}
```

`jobs` is the same whitelisted, bounded projection as `list_jobs` (`id`, `label`, `status`, `startedAt`, `endedAt?`, `exitCode?`), so a client that missed a response can reconcile from the event alone. The event is filtered to the active owner session; a foreign-session change emits nothing to this bridge. A no-op or failed cancellation emits nothing: an already-terminal `cancel_job` (or `job_stop` on a job that already ended) changes nothing, so no event follows. When a changed `cancel_job` triggers the event, its response line always precedes the event line through the same router sequencer.

### `agents_update`

Carries the active session's projected subagent list whenever the existing agents owner's `TaskStore` actually transitions — a subagent queued, started, waiting on a question, settled (completed/failed/cancelled/timed out), or having its final usage recorded at completion. It is emitted for **all** such transitions, not only Desktop-initiated ones, so a connected app can live-update its helper list.

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "event",
  "seq": 2,
  "event": "agents_update",
  "data": {
    "agents": [
      { "id": "m3a1-worker", "agent": "worker", "status": "cancelled", "model": "anthropic/claude-sonnet-4", "lastStep": "completed", "usage": { "total": 15234, "cost": 0.0421 } }
    ]
  }
}
```

`agents` is the same whitelisted, bounded projection as `list_subagents` (`id`, `agent`, `status`, `model`, `modelSource?`, `fallbackFrom?`, `thinking?`, `lastStep`, `usage`, `turns?`, `toolCalls?`, `activeTool?`), so a client that missed a response can reconcile from the event alone. The event is filtered to the active owner session; a foreign-session transition emits nothing to this bridge. Bursts of transitions are coalesced into one event per window and byte-identical projected lists are deduped, matching the activity publisher. A no-op or failed cancellation emits nothing: an already-terminal `cancel_subagent` changes nothing, so no event follows. When a changed `cancel_subagent` triggers the event, its response line always precedes the event line through the same router sequencer.

### `profile_applied`

Follows an `apply_profile` answer whose `status` is `applied`, after the response line.

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "event",
  "seq": 3,
  "event": "profile_applied",
  "data": { "profile": "team", "mode": "default", "source": "desktop" }
}
```

`source` is always `desktop`: an apply from the `/gentle:profiles` screen emits nothing on this channel. `confirmation_required`, `not_applied`, and every error emit nothing. Clients that show profile state should re-read `get_config` for `profiles` after this event.

### `session_snapshot`

Carries the session sections whose content changed since the last `session_snapshot` (or since the bridge subscribed at session start), in the same path-free shapes as `get_snapshot`'s `state.session`:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "event",
  "seq": 5,
  "event": "session_snapshot",
  "data": { "sections": { "pendingQuestion": { "kind": "prompt", "question": "Pick one", "terminalOnly": true, "…": "…" } } }
}
```

It is emitted when the feed publishes, on the feed's own tiers: within 16 ms for urgent state (an open or answered question, the permission mode, an idle/working/blocked transition, a held prompt), otherwise after a 250 ms debounce, and at most once per second while the session is busy. A flush that changes nothing emits nothing, and a section is included only when its content changed; a job's `elapsedMs`, which moves on every flush, is not a change (derive it from `startedAt`). A client that needs the whole state reads `get_snapshot` with `sections` after connecting or after a sequence gap. Advertised only while the feed seam is wired.

### `profile_binding_changed`

Emitted when this session's profile binding changes: a `clear_profile_binding` (`source: "desktop"`), or any other write to the binding store for this session (`source: "external"`): the `/gentle:profiles` screen, an `apply_profile` in session mode, or a resume restoring the record. The data is the new `get_profile_binding` answer plus `source`. Writes for other sessions and writes that leave the answer unchanged emit nothing. The event follows writes to the binding store only: in `follow` and `live` kinds the resolved profile also changes when a pin or the global active profile changes, which is not a binding write, so a client re-reads `get_profile_binding` after `config_changed` on `pins` or `profiles`, and also after its own `get_config` read of those stores (that read records the new revision, so the watcher may then emit no `config_changed` for the same external change).

```json
{ "event": "profile_binding_changed", "data": { "kind": "explicit", "profile": "fast", "origin": "session", "source": "external" } }
```

### `review_mode_changed`

Follows a confirmed `set_review_mode` whose re-read state differs from the state the confirmation was computed from, after the response line.

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "event",
  "seq": 4,
  "event": "review_mode_changed",
  "data": {
    "mode": { "effective": "disabled", "source": "global", "scopes": { "global": "disabled", "clone": "unset" } },
    "previousMode": { "effective": "enabled", "source": "default", "scopes": { "global": "unset", "clone": "unset" } }
  }
}
```

`mode` is identical to the response's `mode`. `confirmation_required`, a no-op (`changed: false`), an unreadable re-read, and every error emit nothing. A change made in the TUI, in Herdr, or by another process emits nothing on this channel; re-read with `get_review_mode`.

## Configuration limits

- **One reader and one writer per store.** Each `get_config` answer and each `set_config` write comes from the module that already owns that file (`agent-profiles.ts`, `model-routing-authority.ts`, `model-fallback-store.ts`, `agents-config.ts`, `agent-profile-pin.ts`, `agent-assets.ts`, `persona-config.ts`, `banner-config.ts`, `notification-policy.ts`). There is no second store, no cached copy, no parallel parser, no shadow precedence, and no re-implemented invariant: the merge rules are the owner's own (`readSavedModelConfig`, `parseAgentsConfig`, `evaluateProfilePin`) and the writes are the owner's validated atomic writers (`writeProfilesFileSync`, `writeFallbacksFile`, `writeProfilePinSync`).
- **Settings stores.** `persona` takes `{ "mode": "gentleman" | "neutral" }` and writes like `/gentle:persona`: the global file, plus the project file only when it already exists, so a project override never silently outranks the change (its `writeRevision` covers both layers, and a project file is never created). `banner` takes exactly `{ showRose, showTextLogo, color }`. `notifications` takes the settings as read: an event may keep the `"file"` marker only where its current sound is a file, which keeps that file; a new `file:` path is `invalid_data`, because the Desktop never sees one. All three write atomically, and none waits for a profile apply (`profile_apply_busy` applies only to the profile stores). Telemetry and the Pi theme are not config stores here: telemetry is a consent switch, and Pi persists its theme through an asynchronous settings queue and exports no list of installed themes to validate against.
- **Bounded write surface.** `set_config` exists only for `profiles`, `profile_fallbacks`, `pins`, and the settings stores above, and only as a whole-store replacement, one explicitly selected pin layer, or the explicit clear of one pin layer (`profile: null`). There is no generic physical-file target, no patch operation, no setter for `models`, `subagents`, or `managed_assets`, no way to clear both layers in one request, and no profile application or materialization: a profile write stores the definition, it does not apply it, and nothing else is rewritten as a side effect.
- **Read-only rationale.** `models` and `subagents` are derived: the owners write them when a profile is applied or a route is materialized, so a Desktop write would fight that writer and leave the runtime and the store disagreeing. `managed_assets` is the installer's ownership manifest with hashes it verifies on install, so a client write would silently disable ownership checks. Only the stores whose owners accept validated writes report `readOnly: false`, and that flag describes the store's owner capability, which now matches this slice's write surface.
- **No-op means no write.** Sending the content a store already holds, or clearing a pin layer that has no file, is answered with `changed: false`, no rewrite, no mtime churn, no removal, and no event, so a client can safely reconcile by re-sending what it read.
- **Per-process guard, not a transaction.** The `expectedRevision` check and the owner's atomic rename happen in one synchronous step, so concurrent Desktop requests in one process cannot both commit from the same revision. Across processes there is no lock: another `pi` process, `/gentle:profiles`, or the installer can write between the check and the rename, and this contract cannot detect that. Treat `expectedRevision` as conflict detection, not as mutual exclusion.
- **No paths, no secrets.** Physical paths are rejected as request input and never appear in a response, an event, or an error message. Content is limited to what these stores hold: profile names, routing entries, fallback chains, pin names, layer statuses, and asset ownership keys and hashes. `managed_assets` is additionally filtered to ownership-shaped entries — a relative asset path below the agent home plus a 64-hex sha256 digest — so an absolute path, a traversal segment, or an arbitrary string in the manifest is omitted rather than echoed. No credential, token, auth file, provider error, or conversation content is read or returned.
- **Truthful normalization.** Content is what the owner's normalizer produced. Entries an owner drops (an unsafe agent key, an unknown thinking level, a stale `active` marker) are absent from `value`; if everything was dropped, the store reads `ok` with an empty map rather than being reported as `invalid`. A file the owner cannot parse at all reads `invalid`. A **write** may not rely on that leniency: data the normalizer would drop is rejected as `invalid_data`, so a Desktop write can never delete content it does not understand.
- **Best-effort external events.** A change made by another `pi` process, by `/gentle:profiles`, by an editor, or by the installer produces a debounced `config_changed` with `source: "external"` when the owner directory can be watched and the store's revision really moved (see [`config_changed`](#config_changed)). When a watcher cannot be created, nothing is pushed for that directory and the change becomes visible on the next read. There is no polling and no cached copy: the watcher only decides when to recompute revisions with the owner readers.
- **This slice does not implement** permission changes beyond the existing slice, subscription usage beyond the read/refresh contract below, subagents beyond the list/cancel/thread-read contract below, music, profile application, store materialization, or any Gentle Desktop client change.

## Permission limits

- The methods delegate to the Gentle AI extension's permission owner in the same Pi process. When that extension is not loaded, both methods answer `permission_unavailable` instead of guessing state.
- Session changes require the owner's interactive-host admission: the TUI, or an RPC process with `GENTLE_SHELL_INTERACTIVE_HOST=1`. Headless RPC children and subagent children stay closed exactly as before.
- Permission control is never an agent-callable tool; only `/gentle:desktop` over the interactive RPC channel reaches it.
- Permission state adds no filesystem watcher and no second store: external `permission_mode_changed` events follow the owner's in-process observer. Config is limited to the `get_config` and `set_config` contract in [Configuration limits](#configuration-limits); subscription usage is limited to the `get_subscription_usage` and `refresh_subscription_usage` contract in [Usage limits](#usage-limits); background jobs are limited to the `list_jobs`, `cancel_job`, and `get_job_output` contract in [Jobs limits](#jobs-limits); subagents are limited to the `list_subagents`, `cancel_subagent`, and `get_subagent_thread` contract in [Subagents limits](#subagents-limits); changed files are limited to the `get_changes` and `get_change_diff` contract in [Changes limits](#changes-limits); cross-session usage is limited to the `get_usage_stats` read in [Stats limits](#stats-limits); update status is limited to the `get_update_status` read in [Updates limits](#updates-limits); music and any Desktop client change are not implemented.
- Requests are not queued. Pi's own RPC loop dispatches prompts concurrently, so overlapping `set_permission_mode` calls reach the owner in whatever order their own reads finish, and one can apply right after the other. What stays guaranteed: every request gets exactly one correlated response, responses never cross, and each response and its optional event are published as an adjacent pair with a monotonic `seq`. Send permission requests one at a time and correlate with `requestId`; the maintainer probe does exactly that.

### Trust boundary

`GENTLE_SHELL_INTERACTIVE_HOST=1` is the only gate, and it is a process marker, not a human confirmation. Any actor able to write this Pi process's RPC stdin — or otherwise drive `/gentle:desktop` in the marker-set process — can request permission elevation, including `super-yolo`, and can make it the saved default with `persist: true`. Two consequences follow:

- `hasUI` in RPC mode means the Desktop app's UI surface exists; it is not proof that a person approved anything. This contract adds no confirmation dialog, so approval belongs to the Desktop client and its user.
- The same write access already implies full control of an interactive agent session, so this is not a privilege escalation beyond stdin access. It is still a capability: treat the Desktop client's stdin channel as trusted input, and never let untrusted content (task text, issues, files, agent output) synthesize `/gentle:desktop` permission requests.

## Usage limits

- **One owner, no second fetcher or store.** `get_subscription_usage` and `refresh_subscription_usage` reach the existing usage owner (`UsageStore` / `UsageSourceRegistry` / `refreshUsage` / `after_provider_response` closures) through a defensive, versioned owner-service adapter — the usage analogue of the YOLO host-ui seam. There is no second fetcher, no second auth resolver, no `auth.json` access, and no cached copy.
- **Same refresh semantics as the panel.** `refresh_subscription_usage` delegates to the existing `refreshUsage` with the same API-key and auth logic, the same 5-minute throttle (forced here), the same bounded fetch window, and the same per-provider generation guard. The scope is resolved **before** delegation: a refreshable provider outside the current session scope answers `refresh: "out_of_scope"` and never reaches the fetcher. Anthropic has no usage endpoint: a refresh for it is a truthful `refresh: "unsupported"` no-op, never fabricated data.
- **Claude data arrives after provider responses.** Anthropic's 5h/7d windows are header-driven: they appear in a `rate_limit` event (`source: "response"`) only after a provider response, never from a fetch. Before the first response, Anthropic reads `pending`.
- **Safe projection only.** The wire carries provider id, status, `fetchedAt`, the public plan name, and the window percentages/durations/resets (plus NaN's raw allowance numbers). No account id, URL, access token, key material, raw provider error, or auth-resolution detail is ever returned or logged.
- **Session-scoped, disposed on replacement.** The owner adapter is discovered per session and disposed on session replacement or shutdown; a late refresh or header recording for a replaced session is dropped, and the router's own publisher guard drops any superseded response. A refresh response always precedes its `rate_limit` event, and a no-op or failed refresh emits no event.
- **No agent tool.** The usage surface is reachable only through `/gentle:desktop` over the interactive RPC channel, exactly like the permission and config slices.

## Design limits

- **One owner, no second canvas.** `get_design_canvas` and the `design_canvas` event reach the existing design owner — the single `DesignCanvas` returned by `createDesignCanvas`, plus `listDesigns` — through a defensive, versioned owner-service adapter, the design analogue of the usage and YOLO seams. There is no second server, port, canvas store, browser opener, or watcher.
- **Read + observe only.** This slice has exactly one method, `get_design_canvas`, and one event, `design_canvas`. It does not implement `open` or `stop`: those remain the `gentle_design` tool's actions (`/gentle:design open|stop`), and this slice only reports the transitions those actions actually cause.
- **Tokenized URL is a capability.** The canvas URL contains the per-server token. It is omitted by default, is included on a read only for an explicit `{ "includeUrl": true }` **after** the interactive-host trust check, and is included in an event only for a trusted interactive Desktop client. The raw token is never a separate field and never appears in an error or log: a throwing owner answers `design_unavailable` with a fixed message.
- **No-op and failure mean no event.** A refused slug, a browser that could not open, a server that could not start, or a `stop` with nothing running emits nothing. Only actual `open`/`refresh`/`stop` transitions emit.
- **Agent work reaches the app.** The bridge subscribes to the owner eagerly at session start, so a canvas opened or stopped by the agent (or by any other path through the owner) still arrives as a `design_canvas` event. Session replacement or shutdown disconnects the observer and drops late outcomes, and the router's own publisher guard drops superseded events.
- **Truthful absence.** When the owning extension is not loaded, `get_design_canvas` answers `design_unavailable` rather than inventing `running: false`. `slug: null` means the system-only root, not a stopped canvas — `running` answers that.

## Jobs limits

- **One owner, no second registry or process manager.** `list_jobs`, `cancel_job`, `get_job_output`, and the `jobs_update` event reach the existing jobs owner — the single parent-session `JobRegistry` plus the parent `MonitorController` — through a defensive, versioned owner-service adapter, the jobs analogue of the usage and design seams. There is no second registry, no second process manager, no subagent cancellation, and no cached copy.
- **List, cancel, and output read only.** This slice has exactly three methods, `list_jobs`, `cancel_job`, and `get_job_output`, and one event, `jobs_update`. It does not start jobs: `bash_background` and `monitor` stay agent tools, and there is no run/start method on this channel. `cancel_job` is `job_stop`'s exact stop path — the monitor controller's `cancel` (dropping timers and pending lines) followed by the registry's `stop` (aborting the process tree) — not a second stop implementation.
- **Safe projection only.** The wire carries exactly `id`, `label`, `status`, `startedAt`, `endedAt?`, and `exitCode?`. No command text, working directory, output path or tail, environment, owner session id, monitor counters, or error string is ever returned or logged. A foreign field on an owner entry is dropped by the projection, never echoed.
- **Bounded list.** `list_jobs` returns running jobs first (newest start first), then recently-finished jobs (newest end first) within a 60-second linger, capped at 50 entries. Finished jobs older than the linger drop out, so the answer can never grow with the process lifetime. That expiry is time-based and emits no `jobs_update`; a client that shows finished jobs should age them out with the same 60-second linger or re-read `list_jobs`.
- **No-op and failure mean no event.** A `cancel_job` on an already-terminal job answers that terminal state with no event, and a `cancel_job` on an unknown or foreign id answers `not_found` with no event. A `job_stop` that finds the job already terminal likewise changes nothing and emits nothing. Only an actual registry change (start, settle, or a running→stopped transition) emits `jobs_update`.
- **Agent work reaches the app.** The bridge subscribes to the owner eagerly at session start, so a job started or stopped by the agent (or any other path through the owner) still arrives as a `jobs_update` event. Every actual registry change funnels through the owner's single `refreshJobStatus` path, including a monitor's self-timeout/flood stop, so no stop path can bypass the notification. The bridge dedupes byte-identical projected lists, so a stop that also flushes pending lines still emits exactly once. Session replacement or shutdown disconnects the observer and drops late outcomes, and the router's own publisher guard drops superseded events. A changed `cancel_job`'s response always precedes its event.
- **Bounded, plain, owner-verified output.** `get_job_output` returns only the owner's existing in-memory tail (at most 20 lines of at most 2 000 characters), never the job's log file, with terminal control sequences stripped and a `truncated` flag. It applies the same ownership rule as `list_jobs`. The tail is the job's own unsanitized process output and can contain anything the job printed, including secrets; the method does not, and cannot, redact it. It is a read with no event; there is no `job_output` event, so a live tail is polled.
- **Output outlives the list entry.** A finished job leaves `list_jobs` after the 60-second linger, but `get_job_output` keeps answering for it, for the same session, as long as the owner registry still holds it — exactly like `cancel_job`. A client must not treat a missing list entry as proof that the output is gone.
- **A cut can leave escape-parameter text.** The owner shortens a line longer than 2 000 characters to its newest characters before this method sees it. When that cut lands inside an escape sequence, the ESC byte is gone, so a fragment of the sequence's parameters (for example `5;196m`) can remain as visible text after the leading `…`. This is a known cosmetic limit of the owner cut; the answer still never carries an ESC byte or any control character other than tab.
- **Truthful absence.** When the owning extension is not loaded, `list_jobs`, `cancel_job`, and `get_job_output` answer `jobs_unavailable` rather than inventing an empty list, a fake stop, or an empty tail. A job that exists but belongs to another session is indistinguishable from an unknown id at this boundary: both answer `not_found`.

## Subagents limits

- **One owner, no second store or runner.** `list_subagents`, `cancel_subagent`, and the `agents_update` event reach the existing agents owner — the single parent-session `TaskStore` plus the parent `AgentRunner` — through a defensive, versioned owner-service adapter, the agents analogue of the jobs seam. There is no second store, no second runner, no subagent spawning, and no cached copy.
- **List, cancel, and thread read only.** This slice has exactly three methods, `list_subagents`, `cancel_subagent`, and `get_subagent_thread`, and one event, `agents_update`. It does not start subagents: the agent dispatch tools stay agent tools, and there is no run/start method on this channel. `cancel_subagent` is the agents panel's exact stop path — `runner.cancel` — not a second stop implementation and never a request to the model to stop itself.
- **Safe projection only.** A list or cancel entry carries exactly `id`, `agent`, `status`, `model`, `modelSource?`, `fallbackFrom?`, `thinking?`, `lastStep`, `turns?`, `toolCalls?`, `activeTool?`, and `usage` (`total`, `cost`, and the final-assistant `input`/`output`/`cache`/`reasoning` breakdown when recorded). `lastStep` is a closed, status-derived phase label, never the raw owner step text, which can carry an error message, a stderr tail, or a provider body. No prompt text, working directory, session path, result, error text, or full session internals is ever returned or logged, and tool arguments, tool output, and thread text (including a streamed error note) appear only in a bounded `get_subagent_thread` item. A foreign field on an owner entry is dropped by the projection, never echoed.
- **Bounded list.** `list_subagents` returns active tasks first (recency order), then recently-finished tasks (newest end first), capped at 50 entries. The store already evicts finished tasks beyond its own retention, so the answer can never grow with the process lifetime.
- **No-op and failure mean no event.** A `cancel_subagent` on an already-terminal task answers that terminal state with no event, and a `cancel_subagent` on an unknown or foreign id answers `not_found` with no event. A running task's cancel is requested but asynchronous: the response reports the still-`running` state and emits no immediate byte-identical event; only the real store transition (the child exit to `cancelled`) emits through the normal `agents_update` path. A TaskStore transition (add, status change, or the completion-time usage recording) emits `agents_update` at once; progress inside a running task (a turn ends, a tool starts or ends, usage grows) emits it at most once per session every 500 ms, and only when the projected list actually changed.
- **Usage persists across restore.** The completion-time usage breakdown is written to the task's history record, so a restored finished task keeps its final breakdown. A task whose run never recorded a breakdown (no final-assistant observation) has no breakdown fields after restore.
- **Agent work reaches the app.** The bridge subscribes to the owner eagerly at session start, so a subagent started or settled by the agent (or any other path through the owner) still arrives as an `agents_update` event. Bursts of transitions are coalesced into one event per window and byte-identical projected lists are deduped, so a settle that records usage right after its status change still emits exactly once. Session replacement or shutdown disconnects the observer, cancels the pending coalesced flush, and drops late outcomes, and the router's own publisher guard drops superseded events. A changed `cancel_subagent`'s response always precedes its event.
- **Thread read is the widget's projection.** `get_subagent_thread` reuses the `gentle-agents.activity/v1` per-thread projection and bounds (`projectRpcThread`, then `boundRpcThread`, in `lib/agents-rpc-publisher.ts`): the last 40 items, 2 000 characters per text item, 500 for tool args and output, and the 256 KB halving. It is a read behind the `cancel_subagent` ownership check, emits no event, and adds no channel: it is one more read on the existing owner-service adapter. Tool args and output are the subagent's own data — whatever its tools received and printed — bounded but not redacted.
- **`sinceVersion` is thread-level.** The store keeps one version per thread, not per item, and items change in place (streamed text, tool output, tool end), so `sinceVersion` returns either nothing (unchanged) or the whole bounded window, never a partial diff.
- **Tool names are not length-capped.** Like the `gentle-agents.activity/v1` widget, a thread item's tool `name` is forwarded without a length cap, so a single huge tool name can keep one item above the 256 KB halving target (halving never drops below one item). Capping it is a follow-up for the widget and this method together, so the two keep the same projection.
- **Truthful absence.** When the owning extension is not loaded, `list_subagents`, `cancel_subagent`, and `get_subagent_thread` answer `agents_unavailable` rather than inventing an empty list, a fake stop, or an empty thread. A task that exists but belongs to another session is indistinguishable from an unknown id at this boundary: both answer `not_found`.
- **Unproven live-child boundary.** The deterministic tests drive the real owner with a real `TaskStore` and a real `AgentRunner` over a fake child (never a real process), and the maintainer probe lists the owner-loaded empty list without starting a child. This slice does not yet prove a live `cancel_subagent` of a running child over the installed runtime end to end; the in-process real-owner test exercises the real `runner.cancel` path and its eventual `agents_update`, but a real OS child is out of scope.

## Profiles limits

- **One owner, no second apply.** `apply_profile` reaches the `/gentle:profiles` owner in `extensions/gentle-ai.ts` through a defensive, versioned owner-service adapter, like the usage and design seams. The owner runs the screen's own **Use in this session** and **Make default** actions with a UI that records notices and answers confirmations only with a matching token. It never opens a dialog in Pi.
- **Apply, binding, and clear.** `apply_profile` and its `profile_applied` event, plus `get_profile_binding`, `clear_profile_binding`, and `profile_binding_changed`. Creating, editing, or deleting profiles stays `set_config` on the `profiles` store; pins, including publishing a profile to the repository, stay `set_config` on `pins`.
- **One rule for the binding.** `get_profile_binding` and the event read `resolveSessionProfile`, the rule launches use, so they never disagree with a launch. The event follows the in-process binding store; a binding changed by another Pi process is not observed.
- **Confirmation is Desktop's job.** The token binds an apply to the title and message that were shown and to the exact saved profile; it is not a proof that a person saw them.
- **Truthful absence.** When the owning extension is not loaded, `apply_profile` answers `profiles_unavailable` rather than inventing an outcome.

## Session limits

- **One owner, one schema.** `get_snapshot { sections }` and `session_snapshot` read the feed extension's live projection through a defensive, versioned owner-service adapter (`gentle:desktop:session-service`, the session analogue of the jobs seam). There is no second state store, no tool-event replay, and no read of the feed file under the agent home.
- **Path-free projection.** No `identity` block, no `pid`/`ppid`/`ancestors`, no session file, no agent dir, and no absolute path from the projection crosses the wire: `project.cwd` becomes its basename `project.name`, worktree roots become opaque labels, and file paths are relative to their worktree. This rule covers every structural field the projection derives (working directory, worktree roots, file paths, identity).
- **Free text passes as written.** Text a person or the agent wrote (pending question titles and options, todo titles and notes, activity and blocker labels, command descriptions) crosses exactly as the feed shows it, even when it contains a path: redacting inside text would corrupt it. This follows the `list_jobs` label precedent, where an explicit label is the agent's own wording and is kept.
- **Bounded.** Arrays and text keep the feed's own caps (for example 200 changed files, 100 todos, 50 jobs and subagents, 200 commands, 500-character text, 2000-character question text), so the payload never grows with the session's lifetime. The channel has no separate response byte limit; requests stay under 64 KiB.
- **Truthful absence.** When the feed is not running for the session, `sections` answer `session_unavailable` and `capabilities` omit `session_snapshot` rather than inventing an empty state. The feed runs only in Gentle Shell (not plain Pi), in the TUI or an interactive RPC host, and never in subagent children.

## Sessions limits

- **One owner, no second scanner.** `list_sessions` and `switch_session` call Pi's own `SessionManager.list`, `listAll`, and `findById`, with the session directory read from the live session manager, the same calls Pi's `/resume` makes. There is no session index, cache, file parser, or settings reader in this slice, and the session-history and stats scanners are not reused for it.
- **Ids in, ids out.** The wire carries session ids, never a session file path, working directory, or parent-session path. The path Pi resolves stays inside the process and goes straight to the command context's `switchSession`.
- **Bounded projection.** Each entry carries exactly `id`, `name?`, `modified`, `messageCount?`, `firstMessage` (at most 200 characters), `project` (a display name), and `current`. The full conversation text Pi reads for search is never returned. A page holds at most 50 entries.
- **The listing reads files.** Pi reads every session file in scope to build its list, so `scope: "all"` over a large history costs as much as Pi's own `/resume` across all projects. Prefer `project` and page with `limit`.
- **A switch replaces the session.** Every per-session bridge and the router restart with the new session; event `seq` restarts at 1, and Desktop should re-read `get_snapshot` and any state it shows. A switch during a streaming turn aborts that turn first (Pi's behavior). A failure after Pi already tore the old session down cannot be answered by either session.
- **Exactly once across a switch.** Pi dispatches prompts concurrently, so requests sent right after a `switch_session` can reach the session being replaced. The router refuses them with `session_switching` while the switch is in flight, answers any request still waiting on an owner right before the teardown, and the replaced instance answers late deliveries through the UI object it extracted before Pi invalidated its context. The switch's own response comes from the new session.
- **No agent tool.** Sessions are reachable only through `/gentle:desktop` over the interactive RPC channel.

## Changes limits

- **One owner, no second tracker.** `get_changes` and `get_change_diff` reach the existing `/gentle:changes` owner — the shell's `WorktreeChangesTracker` over `sessionChangeRoots` — through a defensive, versioned owner-service adapter, the changes analogue of the usage and jobs seams. There is no second scan, no watcher, and no cached copy. `loadFileDiff` lives in `lib/change-diff.ts`, shared by the panel and this slice, so both run the same Git arguments over the same bounded runner.
- **Read only, no event.** This slice has exactly two methods and no event. It never stages, reverts, commits, or opens a file. Every `get_changes` and every `get_change_diff` rescans the worktree, as the panel does when it opens, which also refreshes the shell's own changes widget.
- **No repository-configured commands in the diff.** `get_change_diff` passes `--no-textconv --no-ext-diff` and `-c core.fsmonitor=false`, so a `.gitattributes` textconv driver, an external diff driver, or an fsmonitor hook configured in the repository never runs for a Desktop read. The panel keeps Git's default behavior, so the two can differ for files with such a driver. The rescan itself is the panel's own `git status` and `git diff --numstat`, unchanged.
- **Confinement.** A diff is served only for a file the owner itself lists for that root, by exact match, and only when the file's directory resolves inside the root and outside the repository's git dir and common dir (resolved through links, so an alias such as a junction to `.git` is refused). Request paths that are absolute or contain `..` segments or control characters are refused before the owner is asked; the owner's exact match is the real boundary. The file entry, its status, and so its Git arguments always come from the owner's list, never from the request.
- **Opaque roots.** A root crosses the wire only as an opaque id and its directory name. Ids are assigned per owner adapter (per session); after a session change, call `get_changes` again before `get_change_diff`.
- **Bounded.** `get_changes` carries at most 200 files with `truncated`, the desktop feed's bound. `get_change_diff` carries at most 256 KiB of diff text with `truncated`; the Git run itself stays under the panel's 1 MiB bound.
- **Content, not metadata.** Diff text is the user's file content and can carry anything those files carry. Errors stay generic: Git output, absolute paths, and Git commands never appear in an error.
- **Truthful absence.** When the owning extension is not loaded, the session has no root to scan, or Git fails for any root, both methods answer `changes_unavailable` rather than an empty list.
- **Same baseline as the panel.** Both methods diff against `HEAD`, like the panel today; when the panel moves to session-baseline diffs (#765), this slice follows it.

## Review limits

- **One owner, no second adapter.** `get_review_mode` and `set_review_mode` reach the `/gentle:review-mode` owner in `extensions/gentle-ai.ts` through a defensive, versioned owner-service adapter, like the profiles seam. Every read and write is that owner's `executeReviewMode` call over the native review CLI adapter, so status-cache invalidation and pending-consent cleanup on a disable are the TUI's own. The Desktop side never spawns `gentle-ai` and keeps no copy of the switch.
- **Fail closed.** A read is bounded by the same timeout as the RDD status line (`GENTLE_PI_RDD_STATUS_TIMEOUT_MS`, 3 seconds by default) and a write by 10 seconds. A failed, timed-out, or unrecognized read is `unknown`, never a guess. A native failure is classified as unavailable (`gentle-ai` missing or the command unsupported), unknown, or failed; its message, exit detail, and paths never cross.
- **User-owned switch.** This slice never changes the switch on its own: only a confirmed `set_review_mode` writes, and subagent children never answer the seam. Review start, skip, and candidate consent stay terminal-only.
- **Token binds, it does not authenticate.** The confirmation token binds a change to the request and the exact state and text that were shown, so a stale or mismatched token never writes. It is not a secret: anyone who can write Pi's RPC stdin can read it and send it back.
- **Desktop-only gate.** The single-flight gate serializes `set_review_mode` requests from Desktop in one Pi process. It does not gate the terminal `/gentle:review-mode` command, Herdr, or another process; a change from one of those between the two calls makes the token stale, and the second call asks again.
- **A reset never writes late.** When the session is replaced or shut down while a confirmed `set_review_mode` is still discovering the owner or reading the current state, the write is not attempted and no event is emitted. That request gets no answer, because the router drops outcomes for a superseded session. A client that got no answer re-reads with `get_review_mode` and asks again.
- **Truthful absence.** When the owning extension is not loaded, both methods answer `review_unavailable` rather than inventing a mode.

## Stats limits

- **One owner, one loader, one aggregation.** `get_usage_stats` reaches the `/gentle:stats` owner in `extensions/gentle-stats.ts` through a defensive, versioned owner-service adapter, the stats analogue of the jobs seam. The owner reads the same sessions roots as the panel (the active home and the user's original Pi home) with the panel's own loader instance, so both share one size/mtime cache: an unchanged session file is never re-read. Totals, models, and days come from the panel's `aggregateStats` with the requested range and scope; each project row is that same aggregation scoped to one project. There is no second parser, cache, or store.
- **Shared in-flight load.** The loader answers concurrent loads of the same roots with one in-flight scan, so overlapping Desktop requests (or a request while the panel is loading) read the history once. The scan is asynchronous and streams files line by line; nothing is persisted.
- **Read only, no event.** This slice has exactly one method and no event. History changes as sessions run; a client re-reads when it wants fresh numbers.
- **Safe, bounded projection.** The wire carries counts, token sums, costs, model ids, provider ids, day keys, and project display names only. Arrays are capped (models 50, days 400, providers 50, projects 50) with a `truncated` flag per array; totals stay complete. A session's id, path, or message text never crosses (provider ids are reported in `byProvider`), and a raw read failure is answered with the fixed `stats_unavailable` message.
- **Truthful absence.** When no sessions root can be read, or the owner is not loaded, the answer is `stats_unavailable`. A readable root with no usage answers zeros, which is the truth.
- **Same numbers as the panel, including its gaps.** Records the panel counts are counted here too: an assistant record with zero usage still counts as a message (see #1921). This slice does not change what the aggregation counts.

## Updates limits

- **One source of truth.** Every fact comes from an existing resolver or check, imported, never copied: `runningBundledPrefix`, Pi's `DefaultPackageManager` listing, and `readChannel` for the channel; `latestRelease` and `resolveMainCommit` (the lookups `gentle-shell upgrade` uses) for Gentle Shell; the launcher's `startupReleaseCheck` record through `parseStartupReleaseCache` for the cached release; `findStartupUpdate`'s stable-version comparison; Pi's exported `VERSION`; `publishedPi` for a bundled Pi; and Pi's own `checkForAvailableUpdates` for packages. Pi's source parser (`parseSource`) is not part of Pi's typed surface; it is called defensively, and a parser that is missing or changed reports the package as `unknown`.
- **Cache only without `refresh`.** A plain read never reaches the network. It reads the launcher config, the channel record, Pi's settings, and installed packages' `package.json`. Pi's listing may ask npm for its global root once when a user package is not in Pi's own install folder, exactly as `pi list` does.
- **Bounded refresh.** One deadline (15 seconds) bounds every lookup; a lookup that ignores cancellation (Pi's package check cannot be cancelled) is dropped when the deadline passes and reported `unknown`. Concurrent refreshes share one run.
- **Never "up to date" by default.** Only a successful lookup that returned exactly the running version is `up_to_date`. Failed, offline, timed-out, or incomparable answers are `unknown`, and a package Pi's check did not list is `no_update_reported`, because Pi's check cannot tell a failed lookup from no update.
- **Memory only.** A refresh result is kept in this Pi process's memory and answers later plain reads (across a session switch too); it is never written, so the launcher's own cache and its startup notice are unchanged.
- **Gaps stated.** Pi's latest version is known only in a bundled install. Package `latest` is always `null`. A git package has no `current`. `gentle-ai-managed` is detected only when the running gentle-pi is the `npm:gentle-pi` package Pi installed.
- **Read only, no event.** This slice has exactly one method and no event, and it never runs an update.

## Agent definitions limits

- **One source of truth.** Discovery, defaults, and the orchestrator come from `discoverAgents`, `loadAgentsConfig`, and `readOrchestratorSettings`, the owners `subagent_list_agents` and `/gentle:profiles` already use; nothing is copied.
- **Declared, not effective, models.** A definition's `model` is what its frontmatter declares. Routing in `subagents.json` and a repository profile pin can override it at launch; read them with `get_config` (`models`, `profiles`, `pins`).
- **Bounded.** At most 200 agents, 64 tools per agent, names cut at 128 characters, descriptions at 512, and model ids over 256 characters reported as `null`.
- **Read only, no event.** Definitions are plain files; a client that needs fresh data reads again. Editing them stays a file edit.

## Status limits

- **One source of truth.** The owner computes every field with the same helpers `/gentle:status` uses (`readPersonaMode`, the package asset audit, `resolveGentleAiDevBinaryOverride`, `readModelRoutingAuthorityAsync`); the bridge only validates and projects.
- **No doctor.** `/gentle:doctor` is interactive and can repair things; it stays in the terminal.
- **No spawn.** The dev-binary override is resolved but never executed, so `get_status` never waits on a process.
- **Cost.** The asset audit reads every managed asset file; read on demand, do not poll.
- **Read only, no event.**

## Background subagents limits

- **Same owner, same writer.** Reads use `resolveBackgroundSubagentsPolicy` and the capability check; writes use the command's own global writer. Nothing is copied.
- **Machine-wide only.** The Desktop writes the global file, like the command. A project file still decides for its project, and the answer shows it.
- **Confirmed.** No write happens without a token bound to the state the user saw.
- **No event.** A change made in the terminal or by editing a file is seen on the next read.

## Credential limits

- **Status, never values.** Only `getAll`, `getProviderAuthStatus`, `isUsingOAuth`, `getProviderDisplayName`, and `refresh` are called. The slice never reads `auth.json` and never calls a registry method that returns a key or a token.
- **No sign-in or sign-out.** Signing in stays with Pi's login flow; removing credentials is out of scope.
- **Offline reload.** `reload_credentials` never allows the network, so it does not fetch model catalogs.
- **No event.** Ask again, or call `reload_credentials`, after a change elsewhere.

## Verification

```sh
node --experimental-strip-types --test \
  tests/desktop-rpc.test.ts \
  tests/desktop-rpc-permissions.test.ts \
  tests/desktop-rpc-config.test.ts \
  tests/desktop-rpc-config-watch.test.ts \
  tests/desktop-rpc-usage.test.ts \
  tests/desktop-rpc-design.test.ts \
  tests/desktop-rpc-jobs.test.ts \
  tests/desktop-rpc-agents.test.ts \
  tests/desktop-rpc-profiles.test.ts \
  tests/desktop-rpc-session.test.ts \
  tests/desktop-rpc-sessions.test.ts \
  tests/desktop-rpc-changes.test.ts \
  tests/change-diff.test.ts \
  tests/desktop-rpc-review.test.ts \
  tests/desktop-rpc-stats.test.ts \
  tests/desktop-rpc-updates.test.ts \
  tests/desktop-rpc-agent-definitions.test.ts \
  tests/desktop-rpc-status.test.ts \
  tests/desktop-rpc-background-subagents.test.ts \
  tests/desktop-rpc-auth.test.ts \
  tests/maintainer/desktop-rpc.maintest.ts
```

The permission tests register the real `registerYoloSessionPolicy` owner with an isolated temporary config home and a stub identity resolver; they never read or write the user's own permission store.

The design tests use only injected fake canvas/server/browser factories and a fake owner service: they cover stopped/running/open/refresh/stop state, slug and connected-client counts, default URL omission, explicit `includeUrl` inclusion only after trust, untrusted omission, malformed adapters and params, owner absence (`design_unavailable`, never a fabricated `running: false`), failed and no-op actions emitting nothing, external (agent-driven) transition events, late-reset disposal and stale-outcome drops, and raw-error/token redaction. One test runs the real `gentleDesign` owner seam in-process to prove the stopped canvas state and the design list arrive from the single owner adapter.

The usage tests use a fake owner service and a fake fetch/modelRegistry only: they cover the five statuses, the safe projection and plan-only-when-public rule, provider filters, unknown-provider `unavailable`, invalid params, refresh delegation with the provider filter forwarded, the response-before-event order over the router, the Anthropic typed `unsupported` no-op, the out-of-scope `out_of_scope` no-op (including the real owner never reaching the fetcher), content-based change detection (a same-millisecond payload change emits once, byte-equivalent data stays a no-op), late-discovery disposal after a reset, no duplicate event on no-op/failed refresh, raw-error and secret redaction, header-driven `rate_limit` events, stale-session disconnects, and the versioned adapter discovery. One test runs the real `gentleShell` owner seam to prove Claude's 5h/7d windows arrive as structured snapshots from response headers, never header text.

The jobs tests use the existing background-job fake (the same fake shell operations and monitor controller as the background-jobs tests) and a fake owner service only: they cover the whitelisted projection and field redaction, the bounded running + recent-finished selection, list/cancel/output param shapes, the active-session filter, owner absence (`jobs_unavailable`, never a fabricated empty list), the `job_stop` stop path (monitor cancel + registry stop), already-terminal idempotency with no event, unknown and foreign-session `not_found`, invalid params rejected before discovery, agent-driven `jobs_update` events with foreign-session filtering, the response-before-event order over the router, session reset disconnecting observers and dropping late outcomes, late-discovery disposal, and the versioned adapter discovery. They also drive the real `job_stop` tool to prove the change descriptor distinguishes a running→stopped stop from a no-op stop. For `get_job_output` they cover the plain-text normalization (CSI, OSC, two-character escapes, carriage-return progress lines, control characters, and half characters left by a cut), the owner's 20-line and per-line bounds and the `truncated` flag, own versus foreign and unknown ids, invalid params rejected before discovery, an absent, outdated, throwing, or malformed owner answering `jobs_unavailable`, no event on a read, the real `gentle-agents` owner answering its own job, and the transport answer without an owner.

The subagents tests use a real `TaskStore` plus a fake runner (never a child process) and a fake owner service only: they cover the whitelisted model/usage/cost projection and field redaction, the `get_subagent_thread` projection matching the activity widget's thread exactly (40-item window, per-field bounds, store `version` and `dropped`, `truncated`, and the byte-bound halving), its `sinceVersion` unchanged and changed answers, its param shapes rejected before discovery, unknown and foreign-session `not_found`, an absent, older, throwing, or malformed owner answering `agents_unavailable` without leaking, and a single response line with no event, the closed `lastStep` vocabulary (raw error/path/secret/provider text never crosses), the bounded active + recent-finished selection, list/cancel param shapes, the active-session filter, owner absence (`agents_unavailable`, never a fabricated empty list), the `runner.cancel` stop path and its boolean result, already-terminal idempotency with no event, unknown and foreign-session `not_found`, invalid params rejected before discovery, agent-driven `agents_update` events with foreign-session filtering, content dedupe and burst coalescing, the response-before-event order over the router, session reset disconnecting observers and dropping late outcomes, late-discovery disposal, and the versioned adapter discovery. They also run the real `gentleAgents` owner seam in-process over a fake child (real `TaskStore` + real `AgentRunner`, never a real process): a truthful empty list, a typed `not_found` cancel, a live-task cancel that honors `runner.cancel`'s result with no immediate event and one eventual `agents_update`, an owned thread read through the activity projection with a foreign-session `not_found`, and the persisted usage breakdown surviving `saveTask`/`loadStoredTask` restore.

The session tests load the real desktop RPC and feed extensions on one fake Pi with fake timers and an isolated agent home: they cover the strict `sections` params, the path-free projection (basename, opaque roots, relative multi-worktree paths), a byte-identical `get_snapshot` without `sections` with and without the feed, `session_unavailable` and the missing `session_snapshot` capability without the feed, reads that emit no event, and `session_snapshot` carrying only changed sections on the feed's routine (250 ms) and urgent (16 ms) tiers, with no event for an unchanged flush.

The changes tests load the real `gentleShell` owner and this extension together over temporary Git repositories (real `git`; a wrapped runner only to force a failure). They cover the opaque root id and directory-name label with no absolute path anywhere on the wire, root-relative paths and statuses, the 200-file cap, `get_change_diff` answering byte-for-byte what the panel's `loadFileDiff` answers for tracked and untracked files (including `/dev/null` on Windows), the 256 KiB cut on a line boundary and the head of a diff past the panel's 1 MiB bound, `not_found` for an unknown root, a root's absolute path or label in place of its id, a clean tracked file and `.git/config` that exist on disk, a missing file, `..` traversal, absolute paths, `./`, backslash, case, and trailing-space aliases, and a file behind a directory link (a junction on Windows), `invalid_request` for wrong shapes with no Git run, `changes_unavailable` without an owner, without a repository, and when Git status or the diff fails (with no Git output on the wire), one response line and no event per read, that the owner answers discovery only for its own live session, that a repository textconv driver never runs for `get_change_diff` while the panel's default call still honors it, that a junction to `.git` inside the root is refused, odd Windows path forms (`file.ts.`, `::$DATA`, short names, `\\?\` and UNC prefixes, trailing `/`), a stale root id from a previous session, and directories swapped to junctions after listing. `tests/change-diff.test.ts` proves the panel's `loadFileDiff` export is the shared lib function and keeps its arguments, bound notice, and failure behavior on real Git.

The profiles tests use a fake owner service only: they cover param validation, owner absence (`profiles_unavailable`), the result shapes, the `profile_applied` event only after `applied`, and that the token changes with the mode, name, title, message, and profile content. The owner itself is covered in `tests/gentle-ai.test.ts`, which drives the real screen actions in a temporary config home: a default apply asks the screen's diff and writes nothing without its token, a wrong or stale token asks again and writes nothing, an unknown profile writes nothing, a session apply binds without writing shared state, and only one apply runs at a time.

The review tests use a fake owner service and a fake native review adapter only; they never run `gentle-ai`, so nothing on the machine is toggled. They cover the wire projection of every source and scope, fail-closed `unknown` on a failed, timed-out, malformed, or throwing read, `review_unavailable` for a missing owner, host, adapter, or unsupported command, strict params rejected before discovery, the first call writing nothing, a matching token writing then re-reading, wrong and stale tokens asking again with a fresh token, the process-wide single-flight gate, clone enable under a global off (dialog text and a `changed: false` no-op), a scope-only change emitting the event, failed writes emitting nothing and carrying no CLI detail, the response-before-event order over the transport, and the versioned adapter discovery. They also load the real `extensions/gentle-ai.ts` owner over a fake adapter to prove the STATUS, write-with-scope, re-read call sequence, the error classification, the bounded read, and that a subagent child never answers.

The stats tests write session files into a temporary sessions root outside the worktree and load the real `gentle-stats` owner with the real Desktop transport: they cover the advertised method with no new event, the 7-day/current-project defaults, every range and scope against `aggregateStats`, project display names and the absence of paths, session ids, providers, and message text, the model/day/project bounds with `truncated` and complete totals, reads through the owner's single loader with concurrent requests sharing one load, invalid params rejected before any load, `stats_unavailable` for unreadable roots and for an absent owner, the owner leaving the bus on shutdown, a session reset dropping an in-flight read, throwing or malformed owner reads, and the versioned adapter discovery. `tests/stats-collector.test.ts` pins the shared in-flight load and the readable-root check.

The update-status tests drive the real Desktop transport with injected sources that count every lookup that would reach the network: they cover the advertised method with no new event, plain reads answering from the launcher's recorded lookup with no network work, a refresh running each lookup once with its check time and later plain reads answering from it, `up_to_date` only for an exact match after a successful lookup, newer local builds and prereleases staying `unknown`, failed lookups answering `unknown` with no error text on the wire while plain reads keep the last good result, the refresh deadline with lookups that never settle, concurrent refreshes sharing one run, `PI_OFFLINE` doing no lookup and claiming nothing, the main-channel commit comparison, each channel's fixed command, Pi without a reachable latest source, every package state, the 100-row bound with `truncated`, an unreadable listing, display names free of paths, URLs, and credentials, params rejected before any source work, and `updates_unavailable` for an unbound session, a throwing source, and a read a reset superseded. Two tests run the real sources against a temporary agent dir, launcher config, channel record, and a fake fetch: Pi's own listing and parser, the launcher's release record, the channel record (missing, `main`, malformed), Pi's `VERSION`, the release lookup's single request, and Pi's own package check reporting nothing under `PI_OFFLINE`.

The config tests build six stores in a temporary root and inject the worktree identity, so no real user config, agent home, or repository pin is read. On the read side they cover every store, current path precedence, missing and malformed layers, revision stability and change, the read-only split, rejected stores/params/paths, the bounded snapshot projection, and a byte-and-mtime comparison proving a read never mutates a store. On the write side they cover a valid write for each writable store and both pin layers, clearing either pin layer and observing the winner fall back, clearing an already-missing layer as a no-op, clearing and replacing an unreadable layer, creating a missing store, a stale or missing `expectedRevision` (including on a clear), the documented rejection order (envelope, then store identity, then mutability, then revision, then payload), data the owner would drop, malformed pin clear shapes, extra and physical-path keys, every read-only store, a forced owner write failure (the store path is a directory) answering `write_failed` with no path, OS code, or event and an unchanged tree, the no-op path with untouched bytes and mtime, the resulting disk bytes, revision movement and its invalid-state coarseness, the response-then-event order over the real transport, and that a stopped session neither answers nor writes. They also re-check that the config dispatcher still falls through to the permission bridge.

The external-change tests inject the directory watcher factory and a fake clock, so no assertion depends on real filesystem notification timing. They cover debounce coalescing and window restart, name filtering in shared directories, the real `fs.watch` watcher closing itself when its directory is removed (on Windows a removed directory otherwise keeps the process alive), watcher-creation failure (one directory and every directory) leaving `get_config`, `get_snapshot`, and `set_config` working with no error and no event, an external `profiles` edit producing one `config_changed` with `source: "external"` and no content or path, unchanged recomputed revisions (reformatting, change-and-undo) emitting nothing, a Desktop `set_config` never echoed as external, pin layers watched in the session worktree and re-targeted when the cwd changes, the cwd-dependent stores re-read and announced once on a re-target, a change still debounced when the cwd moves flushed rather than lost, a removed owner directory re-armed through its ancestor with exactly one event after it is recreated and written, a Desktop `profiles` write that makes a pin stale reported as one external `pins` event, a missing owner directory watched through its nearest existing ancestor and upgraded step by step (and closed on dispose), real `fs.watch` runs (rename-replace, Desktop write without echo, delete, recreate, a late `.pi/` directory, a local pin written into a fresh `<git-common-dir>/gentle-ai/`, nothing after reset), disposal on session shutdown and session switch (watchers closed, pending recompute cancelled, nothing published), no watcher and no owner subscription for TUI or headless hosts, `/gentle:mode` and `/gentle:mode default` producing external `permission_mode_changed` events over the real `registerYoloSessionPolicy` owner, a Desktop `set_permission_mode` never echoed (including an owner window that closes while the set is in flight), an external change right after a Desktop set's response still reported, a throwing emitter never propagating, a re-read in flight across a reset never emitting, `wire()` never rejecting when the owner throws, observation stopping on shutdown and restarting with a fresh sequence, and a missing permission owner leaving config events intact.

The sessions tests write real Pi session files into an isolated root (a custom session directory, and a default agent directory through `PI_CODING_AGENT_DIR`) and run Pi's real `SessionManager` through the Desktop command: they cover the project and all-projects scopes for both a custom and the default session directory, newest-first order, the whitelisted projection (no path, cwd, session file, or full message text), the bounded `firstMessage`, the display-only `project`, `current`, keyset paging and its end, param validation before any owner work, `sessions_unavailable` without a bound context, a late list dropped after a reset, a switch that hands Pi the owner-resolved file and answers from the replacement session with a fresh sequence, the current-session no-op, `not_found` outside the requested scope, a cancelled switch, a refused switch with no raw error, `session_switching` for every request dispatched while a switch is in flight (and the gate's release after a cancelled or failed switch), a request pending on an owner at teardown answered exactly once, a command delivered to the replaced instance answered without touching its stale context, path-, glob-, and prefix-shaped ids that never resolve, another project's entries exposing only its display name, forged cursors, and a backslash name projected unchanged. The router tests cover the gate and `abandonPending` (one answer, the kept request still answered by its outcome, late outcomes dropped).

The maintainer probes run the installed Pi runtime with isolated HOME, agent home, config home, session, and temporary directories and no provider or network. They cover:

1. transport only — this extension alone proves slash-command dispatch, correlation, and that capabilities advertise the permission, config, usage, design, jobs, and subagents domains;
2. config reads — the same isolated runtime reads pre-seeded `profiles.json` and project `models.json` through `get_config`, checks the bounded `get_snapshot` projection, and proves no event is emitted and no store is created or rewritten;
3. config write — the same isolated runtime reads the `profiles` write target, sends a `set_config` with that `expectedRevision`, observes the response plus one ordered `config_changed`, reads the store back with a moved revision, asserts the on-disk bytes are exactly the owner's serialization, and proves no other store was created and `get_messages` stayed empty;
4. live owner — the real `extensions/gentle-ai.ts` owner extension is loaded alongside this extension, and the probe reads the mode, sets `auto` with `persist: false`, observes the response plus one `permission_mode_changed` event, and reads `auto` again in the same process without a restart, while `get_messages` stays empty and no default file is written. Nothing in the probe reimplements the owner;
5. usage owner — the real `extensions/gentle-shell.ts` usage owner is loaded alongside this extension, and the probe reads `get_subscription_usage` for `anthropic` and `openai-codex` and observes truthful offline `pending` answers with no event and no live provider fetch. It never calls `refresh_subscription_usage` against a live provider;
6. design owner — the real `extensions/gentle-design.ts` design owner is loaded alongside this extension, and the probe reads `get_design_canvas` (with and without `includeUrl`) and observes the truthful owner-loaded stopped state (`running: false`, `slug: null`, `connectedClients: 0`, `designs: []`) with no event and no tokenized URL. It never starts a canvas server or opens a browser;
7. jobs owner — the real `extensions/gentle-agents.ts` jobs owner is loaded alongside this extension, and the probe reads `list_jobs` and observes the truthful owner-loaded empty list (`jobs: []`) with no event and no command or output path on the wire. It never starts a job;
8. subagents owner — the real `extensions/gentle-agents.ts` subagents owner is loaded alongside this extension, and the probe reads `list_subagents` and observes the truthful owner-loaded empty list (`agents: []`) with no event and no prompt text, session path, or working directory on the wire. It never starts a child;
9. sessions — with a session pre-seeded in the probe's `--session-dir`, the probe lists it through `list_sessions`, switches to it by id, receives the correlated response from the replacement session, reads `get_snapshot` at sequence 0, sees the session listed as `current`, gets `changed: false` for a second switch, and reads the seeded conversation through Pi's `get_messages`. No session file or absolute path appears on the wire. Three more probes send requests back to back right after a `switch_session` and check that each gets exactly one response and that the session then listed as current matches the switch that answered `changed: true`: another switch plus `list_sessions` (each `session_switching` or a real answer); a second switch to the same id (`session_switching`, final session unchanged); and `get_snapshot`, `capabilities`, and `list_jobs` (each `session_switching`).
10. update status — with `PI_OFFLINE=1`, the probe reads `get_update_status` plainly and with `refresh: true`, and observes `offline: true`, `refreshed: false`, the `release` channel and its fixed command, Pi's real version with an `unknown` latest, an empty package list, no `up_to_date` claim, no event, and no absolute path on the wire. It never reaches the network.

What this does not prove: a live Desktop conversation approving the request. The probe writes RPC stdin itself, so it demonstrates that the production owner accepts the change and reports it truthfully, not that a person consented. It also does not cover `persist: true` end to end; persistence is covered by the owner and focused unit tests. Nothing in this slice proves a cross-process guarantee either: the probes use one process, which is exactly the scope `expectedRevision` provides. The design probe does not prove a live browser canvas: it only proves the owner-loaded stopped state without starting a server, while open/refresh/stop transitions and URL trust are covered by the injected-canvas unit tests. The jobs probe does not prove a live job or a live `cancel_job` kill: it only proves the owner-loaded empty list without starting a job, while the stop path, terminal idempotency, and events are covered by the fake-registry unit tests. The subagents probe does not prove a live subagent or a live `cancel_subagent` of a running child: it only proves the owner-loaded empty list without starting a child, while the runner cancel path, terminal idempotency, and events are covered by the fake-runner unit tests.
