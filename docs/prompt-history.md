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

## Legacy migration and seeding are opt-in

Importing past prompts is part of capture: opening the history selector while
capture is enabled also migrates legacy editor-history stores and runs the
one-time seed bootstrap from past session transcripts. With capture off, the
selector warns and returns before any of that — no migration, no seed, no
store files.

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

## Delete vs hide

The selector's delete key (`ctrl+shift+backspace`) is a two-step
confirmation: the first press **arms** the delete for the selected row and
shows what it will do in the footer (the row highlights); the second press
executes it. Any other key or cancel disarms without deleting.

What a delete does depends on where the prompt came from:

- **Editor-stored prompts** (captured into the store's `.jsonl` files) are
  deleted physically: every copy is removed from the store in one atomic
  rewrite per affected file.
- **Session-derived prompts** (seeded from past transcripts) can only be
  hidden: session transcripts are immutable, so the delete writes a
  **tombstone** (`hidden.json`) that keeps the prompt out of the list. The
  original stays in the transcript file.

Both flows therefore end with a tombstone — otherwise the next merge would
re-supply the prompt from transcripts. Write failures surface an error
toast and never lie about state: a failed store delete removes nothing and
aborts ("Store delete failed; nothing was removed."), while a failed
tombstone write after a store delete leaves the store row removed but the
prompt may reappear from session transcripts.

The tombstone file fails closed: if `hidden.json` exists but cannot be
trusted (unreadable, corrupt, wrong shape), history is blocked with a
recovery warning instead of resurfacing hidden prompts, and deletes refuse
to silently rewrite it. Recovery is explicit — restore the file or delete
it yourself (hidden prompts may then reappear).

## Compaction is not a retention limit

When a project's store grows past the GC thresholds, compaction merges the
small capture files into fewer, larger ones and drops the oldest entries to
bound the file count and line count. This is housekeeping for performance:
it consolidates history but does not remove prompts from the resulting
store, and it is not a data-retention or automatic-deletion policy.

Prompts leave the store only through the delete flow above (or by removing
the files manually). Compaction honors tombstones and never resurrects a
deleted prompt: deleted content stays deleted across compactions.
