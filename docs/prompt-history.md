# Prompt history

Prompt history stores captured prompts per pi instance, can import older
history and project session transcripts, and lets you delete prompts from the
history selector. Opted-in sessions consolidate a project's files at shutdown
(see "Compaction" below).

## Capture is opt-in

Recording is **off by default**. Delivered prompts can contain secrets, so
nothing is stored unless you explicitly opt in:

```bash
GENTLE_PI_HISTORY_CAPTURE=1 pi
```

- Enabled by `1`, `true`, or `on` (case-insensitive). Unset, empty, or any other
  value means **off** — the same switch is the disable path.
- The check runs per prompt: unsetting the switch (or setting it to `0`) stops
  new captures immediately, no pi restart needed.
- With capture off the extension is inert: no registry entry, no files, and
  prompts are never written. The history selector only warns; it reads,
  imports, and deletes nothing.

## Legacy migration and seeding are opt-in

Importing past prompts is part of capture: an opted-in session attempts legacy
migration and one-time bootstrap from project session transcripts shortly
after the extension loads, or at its first delivered prompt if that comes
first. The selector reads the store but does not initiate import.
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
- `projects/<hash>/compact-<pid>-<ts>.jsonl` — older capture files merged by
  compaction.
- `history-global.jsonl` — imported legacy editor-history prompts.
- `hidden.json` — deletion records (tombstones); see "Delete" below.

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

A delete removes the prompt by its identity: whitespace runs collapsed,
leading and trailing whitespace trimmed, letter case ignored. Only that exact
prompt is affected — prompts that merely share a beginning stay.

1. **Store copies are removed.** In the project scope, every copy in the
   current project's files (`<instance>.jsonl` and `seed.jsonl`) is removed;
   in the global scope, every copy in every project's files and in
   `history-global.jsonl`. Each affected file is rewritten atomically (temp
   file + rename). Files are never removed, even when they end up empty.
   Lines that another pi instance appends while a file is being rewritten
   are carried over into the new file.
2. **A tombstone is written** to `hidden.json`, so the prompt stays hidden
   everywhere the selector reads, and a later transcript bootstrap does not
   import it again. The session transcripts themselves are never modified.

Deletes only run from the selector, so they need capture enabled.

### What `hidden.json` contains

`hidden.json` is a JSON array of strings, oldest first. Each deletion adds
`sha256:` followed by the SHA-256 hex digest of the normalized prompt, so the
file does not hold the text of deleted prompts. Plain-text entries written by
earlier builds (a prompt's first 120 normalized characters) are still read
and keep their original meaning: an entry shorter than 120 characters hides
that exact prompt, and a 120-character entry hides every prompt that begins
with it. They are kept as they are, and new deletions never add them.

A tombstone hides every copy of its prompt, including one you type again
later: that prompt is captured, but it stays hidden while the tombstone
exists.

The file is a bounded cache, not a retention guarantee: it holds at most
**1000 entries** in recency order, and deleting the same prompt again moves
its entry to the end. Past the cap, the oldest entry is dropped. Its prompt
can reappear if a copy is still on disk (for example, in a file that could
not be rewritten), and can be deleted again.

### Failures

Failures surface an error notification and never report a clean delete:

- If the store delete fails before touching any file, nothing is removed and
  no tombstone is written ("Store delete failed; nothing was removed.").
- If some files cannot be read or rewritten, the others are still cleaned,
  temp files are removed, and the tombstone is still written ("Some history
  files could not be rewritten; the prompt is hidden, but copies may remain
  on disk.").
- If the tombstone write fails after store copies were removed, the prompt
  may reappear from session transcripts ("Deleted from the store, but
  hiding failed — the prompt may reappear from session transcripts.").

`hidden.json` fails closed: if it exists but cannot be trusted (unreadable,
corrupt, or not an array), history is blocked with a recovery warning
instead of resurfacing hidden prompts, transcript bootstrap waits, and
deletes refuse to rewrite it. Recovery is explicit — restore the file or
delete it yourself (hidden prompts may then reappear).

## Compaction

Compaction keeps the number of files per project small. It is housekeeping,
**not a retention limit**: it consolidates files and never drops a visible
prompt because of its age or of any count.

It runs when an opted-in pi session shuts down, for the current project only.
With capture off, shutdown does nothing to the store. The project is compacted
when its directory holds **more than 50 files** or **more than 5000 entries**
in total. Then:

- The **10 newest files** stay as they are. "Newest" is the most recent entry
  timestamp in a file (the file's modification time when it has none), so a
  file rewritten by a delete does not jump ahead.
- Every older file is merged, oldest first, into one new
  `compact-<pid>-<ts>.jsonl`, which is written completely (temp file + rename)
  before any merged file is removed. Earlier compact files are merged again
  like any other file.
- Never merged: `seed.jsonl` (while it exists, the transcript import does not
  run again) and the capture file of the session that is shutting down.
  `history-global.jsonl` sits outside the project directories and is never
  touched.
- Prompts with a tombstone in `hidden.json` are not copied into the compact
  file, so they cannot reappear from it later, even after their tombstone
  leaves the 1000-entry cache. If `hidden.json` cannot be trusted, compaction
  is skipped.

Other pi instances may still be appending to the files being merged. Each
file is renamed to a claim name before it is read (`<name>.gc-<pid>-<ts>.jsonl`),
so a later append by path starts a fresh file under the original name, and
bytes written to the claimed file after it was read are moved into the
compact file once the claim is removed.

Failures never lose prompts: a file that cannot be read is left untouched,
and if the compact file cannot be written, the claimed files stay on disk and
are still read like any other store file. A claimed file that cannot be
removed stays too; its prompts appear once, because the selector drops
duplicates.

Prompts leave the store only through the delete flow above, or when you remove
files manually.
