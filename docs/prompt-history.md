# Prompt history

Slice 1 of the prompt-history extension (#819 split) shipped the storage
layer: a per-instance JSONL capture store, project identity, and the
read/write primitives later slices build on. The selector UI and deletion
shipped in later slices; GC is the one part that still arrives later.

## Capture is opt-in

Recording is **off by default**. Delivered prompts can contain secrets, so
nothing is stored unless you explicitly opt in:

```bash
GENTLE_PI_HISTORY_ENABLE=1 pi
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
slices added the rebuildable `seed.jsonl` and the scope drains/deletes behind
the selector; GC is still to come.

## Who can read them

The store is plain JSONL on your local disk, not encrypted. Files are created by
the pi process with default umask permissions (typically `0644` files inside
`0755` directories), so any process running as your OS user can read them, and
other local accounts can too wherever they can traverse your home directory.
Treat the store as sensitive: it holds your prompts verbatim.

## What disabling capture does

Turning the switch off only stops **new** captures. Nothing is deleted: files
already written — and the registry entry — stay on disk until you remove them.
Individual prompts can be deleted from the history selector while capture is
on (see "Delete" below); the store directory itself is removed by hand:

```bash
rm -rf ~/.pi/agent/history            # whole store
rm -rf ~/.pi/agent/history/projects/<hash>   # one project (see registry.json)
```

## Delete

The selector's delete key (`ctrl+shift+backspace`) is a two-step y/n
confirmation:

1. The first press **arms** the delete for the selected row: the footer
   shows "Delete this prompt from history (y/n)? Prompt stays in session
   log" and the row highlights in red.
2. While armed, the next key decides: `y` executes the delete, `n` or
   `Esc` cancels, and any other key is ignored — nothing is typed into the
   search box and the overlay stays open.

What a delete does depends on where the prompt came from:

- **Editor-stored prompts** (captured into the store's `.jsonl` files) are
  deleted: every stored copy is removed from the store in one atomic
  rewrite per affected file. The session transcript keeps the original.
- **Session-derived prompts** (seeded from past transcripts) are
  read-only: a delete press on them does nothing. Session transcripts are
  immutable and owned by Pi core — the extension never writes them.

Failures surface an error toast and never lie about state: a failed store
delete removes nothing and aborts ("Store delete failed; nothing was
removed."), while a failed tombstone write after a store delete leaves the
store row removed but the prompt may reappear from session transcripts
("Deleted from the store, but hiding failed — the prompt may reappear
from session transcripts.").

The tombstone file (`hidden.json`) is a bounded cache, not a retention
guarantee: it holds at most **1000 keys** in recency order (oldest first,
newest last); hiding a 1001st prompt drops the oldest key, and that prompt
may reappear in the list and can be deleted again. The file still fails
closed: if `hidden.json` exists but cannot be trusted (unreadable, corrupt,
wrong shape), history is blocked with a recovery warning instead of
resurfacing hidden prompts, and deletes refuse to silently rewrite it.
Recovery is explicit — restore the file or delete it yourself (hidden
prompts may then reappear).
