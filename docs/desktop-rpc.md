# Gentle Desktop RPC

Gentle Shell exposes a structured control channel for Gentle Desktop without changing or patching `pi-coding-agent`. It uses Pi's public extension-command and Extension UI RPC mechanisms.

## Activation

Start Pi in RPC mode with the interactive-host marker:

```sh
GENTLE_SHELL_INTERACTIVE_HOST=1 pi --mode rpc
```

The channel is inactive in the TUI and in headless RPC children. It does not register an agent-callable tool.

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
  "methods": ["capabilities", "get_snapshot", "get_config", "set_config", "get_permission_mode", "set_permission_mode"],
  "events": ["config_changed", "permission_mode_changed"]
}
```

The permission methods, the bounded config read and write, and the `config_changed` and `permission_mode_changed` events are advertised because this extension wires them; a later slice adds its own methods and events here. `set_config` and `config_changed` are advertised only because the config bridge actually implements that writer — advertising is not a forward-looking wish list. Method availability is not a claim that every dependency is loaded — see [Permission limits](#permission-limits) and [Configuration limits](#configuration-limits).

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
        { "store": "managed_assets", "scope": "global", "readOnly": true, "status": "ok", "revision": "sha256:be05…" }
      ]
    }
  }
}
```

The projection carries only store identity, scope, mutability, status, and revision — never store content, never a path. It is the cheap way for a client to notice that one of the six revisions moved and then call `get_config` for that store. `state` is `{}` when no Desktop command has bound a session context yet, or when that context has no working directory: without one, the project and pin layers cannot be read truthfully, so nothing is projected instead of a guess.

This snapshot does not project permission state: use `get_permission_mode` for that. `sequence` is the number of delivered events, so a client that saw `seq: 4` expects `sequence: 4` from a fresh snapshot unless it missed an event.

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
| `store` | yes | one of the six store identifiers below | The store to read. |

Any other key — including `scope`, `path`, `file`, or `physical_path` — is rejected as `invalid_request`. A string that is not a known store identifier is rejected as `unknown_store`. Neither case reads anything.

| `store` | Owner reader | `scope` | `readOnly` | Content |
| --- | --- | --- | --- | --- |
| `profiles` | `readProfilesFileResult` over `<configHome>/profiles.json` | `global` | `false` | Normalized `AgentProfilesFile`: `kind`, `version`, optional `active`, `profiles`, optional `workflow`. Writable — see [`set_config`](#set_config). |
| `models` | `readSavedModelConfig` over `<configHome>/models.json` + `<cwd>/.pi/gentle-ai/models.json` | `global+project` | `true` | Saved routing map, global winning per agent, kept to safe agent keys. |
| `profile_fallbacks` | `readFallbacksFile` over `<configHome>/profile-fallbacks.json` | `global` | `false` | Normalized `FallbacksFile`: per-profile, per-agent ordered chains. Writable — see [`set_config`](#set_config). |
| `subagents` | `parseAgentsConfig` over `<agentHome>/subagents.json` + `<cwd>/.pi/subagents.json` | `global+project` | `true` | Normalized `AgentsConfig` the runtime would launch with. A layer that cannot be parsed is skipped and the remaining layer still merges, exactly like the runtime reader. |
| `pins` | `readProfilePinStatus` + `evaluateProfilePin` over the local pin and the repo declaration | `local+repo` | `false` | `resolved`, the winning layer and profile, plus the `invalid` and `stale` layers. Writable per layer — see [`set_config`](#set_config). |
| `managed_assets` | `readManagedAssetsManifestResult` over `<agentHome>/gentle-ai/managed-assets.json` | `global` | `true` | The installer's ownership manifest (`schemaVersion`, `assets`), filtered to ownership-shaped entries: relative asset paths below the agent home and 64-hex sha256 digests. Anything else is omitted, never echoed. |

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
| `readOnly` | `false` for the three authoritative stores (`profiles`, `profile_fallbacks`, `pins`); `true` for the three derived or installer-owned stores (`models`, `subagents`, `managed_assets`). |
| `status` | `ok` (normalized content follows), `missing` (no layer produced content because no layer file exists), or `invalid` (layers exist but none of them produced content). See [Layer semantics](#layer-semantics). |
| `revision` | Opaque read-time digest of the canonical normalized content. See [Revision limits](#revision-limits). |
| `value` | Normalized owner content, present when the store produced one. Absent when a layer is missing or invalid. |
| `layers` | Per-layer status, `global` then `project`, or `local` then `repo`. Each entry is `ok`, `missing`, or `invalid` for the file that layer owns. |
| `writeTargets` | Present only for the three writable stores. One entry per file the owner rewrites, with that file's own `writeRevision` — the token `set_config` requires. See [Write targets](#write-targets). |

#### Layer semantics

`status` answers for the store; `layers` answers for each file it is assembled from. For a merged store the two are different questions:

- `profiles`, `profile_fallbacks`, and `managed_assets` have one layer, so `status` is that layer's status.
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

A write target is one file, not one store. `get_config` reports it only for a writable store, and `set_config` requires the revision of the exact target it is about to replace:

| `store` | `target` values | File |
| --- | --- | --- |
| `profiles` | `global` | `<configHome>/profiles.json` |
| `profile_fallbacks` | `global` | `<configHome>/profile-fallbacks.json` |
| `pins` | `local`, `repo` | `<git-common-dir>/gentle-ai/profile-pin.json`, `<worktree-root>/.pi/gentle-ai/profile.json` |

`writeRevision` is the digest of that one target's state: `sha256` over canonical JSON of `{store, target, status, value}`. When the target reads `ok`, `value` is the owner-normalized file content (for a pin layer, the profile name it holds), so any content change moves the digest. When the target reads `missing` or `invalid`, `value` is absent and the digest covers **only `{store, target, status}`** — the owner produced no content to hash, and this contract does not hash raw bytes. Two consequences follow, and they are limits rather than incidents:

- a target that is missing and a different target state can never collide, because `status` differs;
- two **different** broken files of the same target share one `writeRevision`, so replacing one `invalid` file with another produces no detectable conflict. `expectedRevision` proves "this target is currently broken", not "this target is currently broken in exactly this way".

It is deliberately a different token from the store's `revision`, which for `pins` describes the merged evaluation of both layers and therefore cannot identify the file a write replaces. A missing target has a write revision of its own (`status: "missing"`), which is what makes a first, creating write possible without inventing a token.

Outside a resolvable Git worktree `pins` reports `writeTargets: []`: there is no truthful pin file for the session, so no target is offered and no pin write is accepted.

### Revision limits

`revision` is a `sha256` digest over canonical JSON (sorted keys, `undefined` members dropped) of `{store, status, value}` for that read. It is stable across equivalent reads: reformatting a file, reordering its keys, or touching its mtime does not move it, while any change to normalized content does. The same caveat as `writeRevision` applies: a read that produced no content (`missing`, `invalid`) digests only `{store, status}`, so two different broken files for one store share a read revision. It is deliberately not a transaction token:

- it is computed **at read time**, after the owner normalized the content, not from file bytes and not from an owner-maintained counter;
- there is no watcher, no subscription, and no cross-process lock, so two processes can each see a different revision at the same wall-clock moment and neither is told when the other writes;
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
2. **Store identity** (`unknown_store`): the string must be one of the six store identifiers.
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

Current error codes are `invalid_request`, `unknown_store`, `read_only`, `invalid_data`, `revision_conflict`, `write_failed`, `unsupported_method`, `permission_unavailable`, `permission_denied`, `config_unavailable`, and `internal_error`. A request that cannot supply a valid correlation ID uses `requestId: null`. State/provider failures use the generic `internal_error` message rather than exposing raw paths, credentials, or provider errors. Transport failures from `setWidget` are never retried as a second response.

| Code | Meaning |
| --- | --- |
| `invalid_request` | Malformed envelope, unsupported params (including a physical path, or `set_config` without `data`), or an unknown permission mode. State unchanged. |
| `unknown_store` | A store identifier this slice does not implement. Nothing was read or written. |
| `read_only` | `set_config` named `models`, `subagents`, or `managed_assets`. Rejected before the payload was inspected; nothing was written. |
| `invalid_data` | `set_config` data the owner would reject or would silently drop. Nothing was written, and no file was created. |
| `revision_conflict` | `expectedRevision` was missing, unusable, or no longer current. Nothing was written. |
| `write_failed` | The owner's atomic write threw. State is whatever the owner left; the message stays generic. |
| `unsupported_method` | Method not in `capabilities`. |
| `permission_unavailable` | The permission owner did not answer for this session (extension not loaded, or the session changed). State unchanged. |
| `permission_denied` | The owner refused the change (for example a non-interactive or replaced session). State unchanged. |
| `config_unavailable` | No Desktop command has bound a session context, that context has no working directory, or a pin write was requested outside a resolvable Git worktree. |
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

The event name above is illustrative; `capabilities` is authoritative for implemented events. `seq` starts at 1 after successful delivery in each newly started session and resets on session shutdown or reload. After shutdown the channel does not answer further commands. Clients should fetch `get_snapshot` after connecting and whenever they detect a sequence gap. Responses do not increment the event sequence.

### `permission_mode_changed`

Emitted at most once per successful `set_permission_mode`, always after its response line, and never for rejected, unavailable, or no-op requests:

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

`source` is `desktop` because this slice only publishes events for changes it made itself; `persisted` reports whether that request saved the default. Mode changes made elsewhere in the session (for example a `/gentle:mode` prompt) are visible through `get_permission_mode` but do not emit this event.

### `config_changed`

Emitted at most once per successful `set_config` that actually changed its target, always after its response line, and never for rejected, unavailable, conflicted, or no-op requests:

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

`store`, `scope`, `revision`, and `writeRevision` are the resulting values, identical to the response that precedes the event, so a client that missed the response can reconcile from the event alone. `source` is `desktop` because this slice only publishes events for changes it made itself; a change made by `/gentle:profiles`, by the installer, or by another `pi` process becomes visible on the next read and emits nothing.

## Configuration limits

- **One reader and one writer per store.** Each `get_config` answer and each `set_config` write comes from the module that already owns that file (`agent-profiles.ts`, `model-routing-authority.ts`, `model-fallback-store.ts`, `agents-config.ts`, `agent-profile-pin.ts`, `agent-assets.ts`). There is no second store, no cached copy, no parallel parser, no shadow precedence, and no re-implemented invariant: the merge rules are the owner's own (`readSavedModelConfig`, `parseAgentsConfig`, `evaluateProfilePin`) and the writes are the owner's validated atomic writers (`writeProfilesFileSync`, `writeFallbacksFile`, `writeProfilePinSync`).
- **Bounded write surface.** `set_config` exists only for `profiles`, `profile_fallbacks`, and `pins`, and only as a whole-store replacement, one explicitly selected pin layer, or the explicit clear of one pin layer (`profile: null`). There is no generic physical-file target, no patch operation, no setter for `models`, `subagents`, or `managed_assets`, no way to clear both layers in one request, and no profile application or materialization: a profile write stores the definition, it does not apply it, and nothing else is rewritten as a side effect.
- **Read-only rationale.** `models` and `subagents` are derived: the owners write them when a profile is applied or a route is materialized, so a Desktop write would fight that writer and leave the runtime and the store disagreeing. `managed_assets` is the installer's ownership manifest with hashes it verifies on install, so a client write would silently disable ownership checks. Only the stores whose owners accept validated writes report `readOnly: false`, and that flag describes the store's owner capability, which now matches this slice's write surface.
- **No-op means no write.** Sending the content a store already holds, or clearing a pin layer that has no file, is answered with `changed: false`, no rewrite, no mtime churn, no removal, and no event, so a client can safely reconcile by re-sending what it read.
- **Per-process guard, not a transaction.** The `expectedRevision` check and the owner's atomic rename happen in one synchronous step, so concurrent Desktop requests in one process cannot both commit from the same revision. Across processes there is no lock: another `pi` process, `/gentle:profiles`, or the installer can write between the check and the rename, and this contract cannot detect that. Treat `expectedRevision` as conflict detection, not as mutual exclusion.
- **No paths, no secrets.** Physical paths are rejected as request input and never appear in a response, an event, or an error message. Content is limited to what these stores hold: profile names, routing entries, fallback chains, pin names, layer statuses, and asset ownership keys and hashes. `managed_assets` is additionally filtered to ownership-shaped entries — a relative asset path below the agent home plus a 64-hex sha256 digest — so an absolute path, a traversal segment, or an arbitrary string in the manifest is omitted rather than echoed. No credential, token, auth file, provider error, or conversation content is read or returned.
- **Truthful normalization.** Content is what the owner's normalizer produced. Entries an owner drops (an unsafe agent key, an unknown thinking level, a stale `active` marker) are absent from `value`; if everything was dropped, the store reads `ok` with an empty map rather than being reported as `invalid`. A file the owner cannot parse at all reads `invalid`. A **write** may not rely on that leniency: data the normalizer would drop is rejected as `invalid_data`, so a Desktop write can never delete content it does not understand.
- **No watcher.** Nothing is pushed except this slice's own `config_changed`. A change made by another `pi` process, by `/gentle:profiles`, or by the installer becomes visible on the next read and produces no event.
- **This slice does not implement** permission changes beyond the existing slice, usage, agents, jobs, music, profile application, store materialization, or any Gentle Desktop client change.

## Permission limits

- The methods delegate to the Gentle AI extension's permission owner in the same Pi process. When that extension is not loaded, both methods answer `permission_unavailable` instead of guessing state.
- Session changes require the owner's interactive-host admission: the TUI, or an RPC process with `GENTLE_SHELL_INTERACTIVE_HOST=1`. Headless RPC children and subagent children stay closed exactly as before.
- Permission control is never an agent-callable tool; only `/gentle:desktop` over the interactive RPC channel reaches it.
- This slice adds no filesystem watcher and no second store. Config is limited to the `get_config` and `set_config` contract in [Configuration limits](#configuration-limits); usage, agents, jobs, music, and any Desktop client change are not implemented.
- Requests are not queued. Pi's own RPC loop dispatches prompts concurrently, so overlapping `set_permission_mode` calls reach the owner in whatever order their own reads finish, and one can apply right after the other. What stays guaranteed: every request gets exactly one correlated response, responses never cross, and each response and its optional event are published as an adjacent pair with a monotonic `seq`. Send permission requests one at a time and correlate with `requestId`; the maintainer probe does exactly that.

### Trust boundary

`GENTLE_SHELL_INTERACTIVE_HOST=1` is the only gate, and it is a process marker, not a human confirmation. Any actor able to write this Pi process's RPC stdin — or otherwise drive `/gentle:desktop` in the marker-set process — can request permission elevation, including `super-yolo`, and can make it the saved default with `persist: true`. Two consequences follow:

- `hasUI` in RPC mode means the Desktop app's UI surface exists; it is not proof that a person approved anything. This contract adds no confirmation dialog, so approval belongs to the Desktop client and its user.
- The same write access already implies full control of an interactive agent session, so this is not a privilege escalation beyond stdin access. It is still a capability: treat the Desktop client's stdin channel as trusted input, and never let untrusted content (task text, issues, files, agent output) synthesize `/gentle:desktop` permission requests.

## Verification

```sh
node --experimental-strip-types --test \
  tests/desktop-rpc.test.ts \
  tests/desktop-rpc-permissions.test.ts \
  tests/desktop-rpc-config.test.ts \
  tests/maintainer/desktop-rpc.maintest.ts
```

The permission tests register the real `registerYoloSessionPolicy` owner with an isolated temporary config home and a stub identity resolver; they never read or write the user's own permission store.

The config tests build six stores in a temporary root and inject the worktree identity, so no real user config, agent home, or repository pin is read. On the read side they cover every store, current path precedence, missing and malformed layers, revision stability and change, the read-only split, rejected stores/params/paths, the bounded snapshot projection, and a byte-and-mtime comparison proving a read never mutates a store. On the write side they cover a valid write for each writable store and both pin layers, clearing either pin layer and observing the winner fall back, clearing an already-missing layer as a no-op, clearing and replacing an unreadable layer, creating a missing store, a stale or missing `expectedRevision` (including on a clear), the documented rejection order (envelope, then store identity, then mutability, then revision, then payload), data the owner would drop, malformed pin clear shapes, extra and physical-path keys, every read-only store, a forced owner write failure (the store path is a directory) answering `write_failed` with no path, OS code, or event and an unchanged tree, the no-op path with untouched bytes and mtime, the resulting disk bytes, revision movement and its invalid-state coarseness, the response-then-event order over the real transport, and that a stopped session neither answers nor writes. They also re-check that the config dispatcher still falls through to the permission bridge.

The maintainer probes run the installed Pi runtime with isolated HOME, agent home, config home, session, and temporary directories and no provider or network. They cover:

1. transport only — this extension alone proves slash-command dispatch, correlation, and that capabilities advertise the permission and config domains;
2. config reads — the same isolated runtime reads pre-seeded `profiles.json` and project `models.json` through `get_config`, checks the bounded `get_snapshot` projection, and proves no event is emitted and no store is created or rewritten;
3. config write — the same isolated runtime reads the `profiles` write target, sends a `set_config` with that `expectedRevision`, observes the response plus one ordered `config_changed`, reads the store back with a moved revision, asserts the on-disk bytes are exactly the owner's serialization, and proves no other store was created and `get_messages` stayed empty;
4. live owner — the real `extensions/gentle-ai.ts` owner extension is loaded alongside this extension, and the probe reads the mode, sets `auto` with `persist: false`, observes the response plus one `permission_mode_changed` event, and reads `auto` again in the same process without a restart, while `get_messages` stays empty and no default file is written. Nothing in the probe reimplements the owner.

What this does not prove: a live Desktop conversation approving the request. The probe writes RPC stdin itself, so it demonstrates that the production owner accepts the change and reports it truthfully, not that a person consented. It also does not cover `persist: true` end to end; persistence is covered by the owner and focused unit tests. Nothing in this slice proves a cross-process guarantee either: the probes use one process, which is exactly the scope `expectedRevision` provides.
