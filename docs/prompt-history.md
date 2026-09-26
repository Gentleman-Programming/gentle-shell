# Prompt history

Prompt history stores captured prompts per pi instance and can import older
history and project session transcripts. Deletion and compaction arrive in
later slices of the chain.

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

## Legacy migration and seeding are opt-in

Importing past prompts is part of capture: the first delivered prompt in an
opted-in session attempts legacy migration and one-time bootstrap from project
session transcripts. The selector reads the store but does not initiate import.
With capture off, both capture and the selector leave the store untouched.
Failed migration reads can be retried on a later session; untrusted deletion
records defer transcript bootstrap until they can be read safely.

An import creates **new searchable copies** under `~/.pi/agent/history`. The
source transcripts stay untouched and read-only. Turning capture off again
does not remove copies that were already imported: delete them manually as
described in "What disabling capture does" below.

## Where the files live

Everything sits under `~/.pi/agent/history/`:

- `registry.json` — advisory map of project hash → cwd, used for display
  labels.
- `projects/<hash>/<instance>.jsonl` — one append-only capture file per pi
  process.
- `projects/<hash>/seed.jsonl` — one-time transcript import for this project.
- `history-global.jsonl` — imported legacy editor-history prompts.

`<hash>` is the first 16 hex chars of the SHA-256 of the canonicalized project
cwd; `<instance>` is a per-process UUID. Each line is one delivered prompt:

```json
{"v":1,"text":"the prompt as delivered","ts":1700000000000}
```

UI command-like prompts (`/name ...`) and empty lines are never captured.
Imported copies remain on disk when capture is turned off; the seed is not
regenerated if it already exists, to avoid resurrecting deleted prompts.

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
