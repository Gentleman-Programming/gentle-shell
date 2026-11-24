# Session profile record format

`lib/session-profile-persistence.ts` defines the optional session profile v1
codec and pure replay contract. The record shapes and how each version reads
them are specified in gentle-shell#2742.

## Payloads

A custom entry uses `customType: "gentle-pi.session-profile/v1"` and one payload:

```json
{"kind":"bind","origin":"user","name":"work","modelProfiles":{"worker":{"model":"provider/model"},"orchestrator":{"thinking":"high"}}}
{"kind":"bind","origin":"user","name":"work","modelProfiles":{"worker":{"model":"provider/model"}},"startup":"none"}
{"kind":"bind","origin":"local","name":"team","modelProfiles":{"worker":{"model":"provider/model"},"orchestrator":{"model":"provider/model"}}}
{"kind":"clear"}
{"kind":"clear","startup":"none"}
```

| Payload | Meaning |
| --- | --- |
| `bind`, origin `user` | An explicit choice (Use in this session). An optional `startup` field holds the session's startup state: `{"origin","name","modelProfiles"}` with origin `local`, `repo` or `global`, or `"none"`. |
| `bind`, origin `local`, `repo` or `global` | A startup record: the profile the session started with and the layer it came from. `modelProfiles` is the full normalized definition, `orchestrator` included; launch routing uses its role entries only. |
| `clear` | A legacy clear: no session profile, startup state unknown. |
| `clear` with `startup: "none"` | The session started with no profile in any layer. |

The decoder accepts the closed origin set `user`, `local`, `repo`, and `global`.
A malformed `startup` field is dropped, so the record keeps the routing a v1
reader gives it, and a `startup` on a clear other than `"none"` reads as a
legacy clear. A v1 reader ignores `startup`, reads a startup record as an
explicit choice and a clear with `startup: "none"` as a clear. Launch routing
is the same except in the documented divergences:

| Case | Current version | A v1 reader |
| --- | --- | --- |
| No profile at start, a default appeared since (gentle-shell#2742 section 2) | Keeps no session profile | Routes the default that appeared |
| `follow` mode on a recorded startup bind (gentle-shell#1064 A3) | Ignores the startup bind and resolves the current defaults; an explicit choice still wins | Routes the recorded bind |
| A session recorded at its own start, resumed (gentle-shell#1064 A3) | Resumes on the recorded startup state, origin and full definition included | Reads the same record as an explicit choice and routes it |

A bound empty snapshot is not a clear. Snapshots are detached, known invalid
fields reject the whole binding, and unknown extra fields carry no routing
meaning. Existing route normalization supports legacy model strings and
`effort`; valid `thinking` takes precedence.

## Startup record

A session records its startup state at its own start, at the same moment it
freezes it in memory: the startup bind with its origin and full normalized
definition, orchestrator included, or the `clear` marked `startup: "none"` when
no profile resolves in any layer. Nothing else is a session's start, so a
resume, fork, reload or child session writes no record. A session from before
this record was introduced writes nothing and keeps its previous behavior: it
freezes on resume, and clear appends a legacy clear. A session with no session
file has nothing to append, so only the in-memory freeze carries its state.

A `follow` session never writes a startup record and, when reading, ignores a
startup bind and resolves the current defaults; an explicit choice still wins.
The Fast tier follows the same rule, so a `follow` session reads the default
tier of its own start rather than a recorded startup orchestrator.

On resume the record supplies the startup state reviewers and the Fast tier
read, orchestrator included. The live model is not switched again: Pi restores
the session's model from its own `model_change` entries.

## Replay

`replaySessionProfileBranch` requires entries already corroborated on disk,
ordered oldest to newest on the active branch. Supplying `getBranch()` alone
does not establish persistence. The newest profile-family entry is terminal:

| Result | Meaning |
| --- | --- |
| `absent` | No profile-family entry on the supplied branch. |
| `bound` | A detached, validated binding, including an empty snapshot. |
| `cleared` | An explicit clear; fallback is a later consumer's decision. |
| `invalid` | Invalid v1 data; never resurrect an earlier binding. |
| `unsupported` | Unknown profile-family identifier, regardless of payload. |

Replay neither appends nor publishes bindings and never applies a model or
thinking level. A subsequent disk-reader slice supplies corroboration; this
codec alone cannot establish it.

## Disk corroboration

`readSessionProfileDisk(source)` in `lib/session-profile-disk-reader.ts` is the
stateless synchronous check that supplies the corroboration replay requires.
It reads the session's public active branch and its JSONL file, selects the
newest profile-family entry on the branch (excluding caller-supplied known
failed append IDs), and admits it only when the record on disk is identical.
It performs no writes, fallback policy, caching, ancestry repair or fsync, and
a missing file is conservative: it never restores a profile found only in
memory.

The result is the decoder result plus `entryIndex` and `lineNumber`, or
`indeterminate` with one reason: `missing-source`, `invalid-candidate-metadata`,
`unreadable-file`, `source-changed`, `invalid-record`,
`session-header-mismatch`, `duplicate-id`, `missing-header`,
`selected-record-missing`, `selected-record-mismatch`, or
`unserializable-source` (exported as `DiskProfileIndeterminateReason`).
Reasons never carry record contents.

Malformed JSON lines are skipped, matching Pi's session parser, so a file Pi
opens never becomes permanently indeterminate here; `lineNumber` still counts
physical lines. A malformed selected record is therefore
`selected-record-missing`. `missing-header` means no line parsed at all (an
empty, all-blank or all-malformed file). Pi writes no byte order mark, so a
BOM-prefixed header line is skipped as malformed like any other.
