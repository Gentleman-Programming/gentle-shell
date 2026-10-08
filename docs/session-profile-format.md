# Session profile record format

`lib/session-profile-persistence.ts` defines the optional session profile v1
codec and pure replay contract. Adding this module does not change Enter,
startup, routing, shared defaults, or live orchestrator behavior.

## Payloads

A custom entry uses `customType: "gentle-pi.session-profile/v1"` and one payload:

```json
{"kind":"bind","origin":"user","name":"work","modelProfiles":{"worker":{"model":"provider/model"},"orchestrator":{"thinking":"high"}}}
{"kind":"clear"}
```

The encoder creates only explicit `user` selections. The decoder accepts the
closed origin set `user`, `local`, `repo`, and `global`; this does not implement
inherited startup persistence or follow mode. A bound empty snapshot is not a
clear. Snapshots are detached, known invalid fields reject the whole binding,
and unknown extra fields carry no routing meaning. Existing route normalization
supports legacy model strings and `effort`; valid `thinking` takes precedence.

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
`unreadable-file`, `source-changed`, `invalid-json`, `invalid-record`,
`session-header-mismatch`, `duplicate-id`, `missing-header`,
`selected-record-missing`, `selected-record-mismatch`, or
`unserializable-source`. Reasons never carry record contents.
