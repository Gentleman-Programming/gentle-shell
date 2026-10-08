# Session profile record format

`lib/session-profile-persistence.ts` defines the optional session profile v1
record format and its decoder. Adding this module does not change Enter,
startup, routing, shared defaults, or live orchestrator behavior.

## Payloads

A custom entry uses `customType: "gentle-pi.session-profile/v1"` and one payload:

```json
{"kind":"bind","origin":"user","name":"work","modelProfiles":{"worker":{"model":"provider/model"},"orchestrator":{"thinking":"high"}}}
{"kind":"clear"}
```

The decoder accepts the closed origin set `user`, `local`, `repo`, and
`global`; this does not implement inherited startup persistence or follow
mode. A bound empty snapshot is not a clear. Snapshots are detached, known
invalid fields reject the whole binding, and unknown extra fields carry no
routing meaning. Existing route normalization supports legacy model strings
and `effort`; valid `thinking` takes precedence.

## Decoding one entry

`readSessionProfileEntry` classifies one supplied entry. It neither reads disk
nor establishes that the entry was persisted:

| Result | Meaning |
| --- | --- |
| `absent` | Not a profile-family custom entry. |
| `bound` | A detached, validated binding, including an empty snapshot. |
| `cleared` | An explicit clear; fallback is a later consumer's decision. |
| `invalid` | Invalid v1 data. |
| `unsupported` | Unknown profile-family identifier, regardless of payload. |

The encoder and the active-branch replay rule are a subsequent slice.
