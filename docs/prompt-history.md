# Prompt history

Slice 1 of the prompt-history extension (#819 split) ships the storage layer only:
a per-instance JSONL capture store, project identity, and the read/write
primitives later slices build on. The selector UI, deletion/scope drains, and GC
arrive in later slices of the chain.

## Capture is opt-in

Recording is **off by default**. Delivered prompts can contain secrets, and the
deletion UI is not shipped yet, so nothing is stored unless you explicitly opt in:

```bash
GENTLE_PI_HISTORY_CAPTURE=1 pi
```

- Enabled by `1`, `true`, or `on` (case-insensitive). Unset, empty, or any other
  value means **off** — the same switch is the disable path.
- The check runs per prompt: unsetting the switch (or setting it to `0`) stops
  new captures immediately, no pi restart needed.
- With capture off the extension is inert: no registry entry, no files, and
  prompts are never written.

## Where the files live

Everything sits under `~/.pi/agent/history/`:

- `registry.json` — advisory map of project hash → cwd, used for display
  labels.
- `projects/<hash>/<instance>.jsonl` — one append-only capture file per pi
  process.

`<hash>` is the first 16 hex chars of the SHA-256 of the canonicalized project
cwd; `<instance>` is a per-process UUID. Each line is one delivered prompt:

```json
{"v":1,"text":"the prompt as delivered","ts":1700000000000}
```

UI command-like prompts (`/name ...`) and empty lines are never stored. Later
slices add the rebuildable `seed.jsonl`, scope drains/deletes, and GC.

## Who can read them

The store is plain JSONL on your local disk, not encrypted. Files are created by
the pi process with default umask permissions (typically `0644` files inside
`0755` directories), so any process running as your OS user can read them, and
other local accounts can too wherever they can traverse your home directory.
Treat the store as sensitive: it holds your prompts verbatim.

## What disabling capture does

Turning the switch off only stops **new** captures. Nothing is deleted: files
already written — and the registry entry — stay on disk until you remove them or
the deletion UI ships. To erase the store manually while capture is off (or pi
is not running):

```bash
rm -rf ~/.pi/agent/history            # whole store
rm -rf ~/.pi/agent/history/projects/<hash>   # one project (see registry.json)
```
