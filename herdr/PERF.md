# Gentle Shell Desktop — performance (S13)

What the `gentle-shell` layout costs Herdr app, before and after the S13 pass, measured on the
live window (Herdr app 0.1.15, macOS, window in front, 1890×2014 frame), 2026-11-15.

## How it was measured

- **CPU**: `ps -o %cpu= -p $(pgrep -x herdr-app)` once per second for 20 s, averaged. The window
  was brought to the front with `osascript … set frontmost`; no keys or clicks were sent.
- **Reference**: the same with Herdr's own `main` layout
  (`herdr-app do layout.switch '{"name":"main"}'`, then back to `gentle-shell`).
- **RSS**: `ps -o rss=` of `herdr-app`.
- **Child processes**: every process whose parent is `herdr-app`, sampled with `ps -A` every
  20 ms for 60 s (short-lived ones can be missed, so it is a lower bound; the same sampler before
  and after).
- **Latency**: a scratch agent dir (listed in `gentle-shell-roots.json`) with a copied 8 MB session
  JSONL and a snapshot whose pid was a `sleep`; a user line appended to the copy, then
  `herdr-app shot` every ~25 ms until the chat column changed. Question latency: the scratch
  snapshot's `pendingQuestion` toggled (atomic rename), same timing. Nothing was sent to a real
  session.

## Results

| | Before | After |
|---|---|---|
| CPU, a working session shown in the chat | 40.1 % (39–42) | 0.1 % |
| CPU, an idle session shown, a working one in the sidebar | 9.0 % | 0.0 % |
| CPU, Terminal view (chat hidden) | 7.1 % | 0.1 % |
| CPU, Herdr's `main` layout (reference) | 0.4 % | 0.2–0.4 % |
| RSS | 467–513 MB | 471–506 MB (no real change; Herdr's own) |
| Child processes seen per minute | 44–46 (`ps` ×43) | 2–3 |
| Appended JSONL line → shown in the chat (median) | 127 ms | 122 ms |
| Snapshot question → shown in the chat (median) | 642 ms | 219 ms |
| Bytes read for the first paint of an 8 MB session | the whole file, in 2 MB chunks, each chunk a full read (~4× the file) | one read; only its end decoded (≥ 300 KB and ≥ 300 lines, ≤ 3 MB) |

## What burned the CPU (step A)

Measured by turning things off one at a time:

1. **Native animations** (dominant). Every frame of a `.loop` / `.frames` / `.spin` redraws the
   whole window, and a frame of this layout costs ~35 ms of CPU with a long chat drawn. One
   pulsing "Working" dot (`.loop`, ~30 fps) alone: 41.7 %. With every animation off and a
   working session shown: 0.7 %. A 2 fps text spinner instead: 7.7 % (2.5 % with fewer rows).
   **Fix:** no animation while a session works (the dot and its word say it; the chat and the
   inspector change when the session writes). Only the Send button keeps its spinner, for the
   second a send takes.
2. **Rows drawn** (per-frame cost). The chat drew the last 150 entries; with 30 the same 2 fps
   animation cost 2.5 % instead of 7.7 %. **Fix:** 40 entries at first, "Show earlier" adds 40.
3. Timers and reads (small next to the two above, but they woke Herdr and spawned processes):
   ten FeedSources, each with its own 10 s / 5 s timer, folder watches, a read of every snapshot
   and a `ps` per refresh; the chat's 500 ms request poll and 5 s tick (a whole-file read of the
   session each time); the inspector's 1 s timer.

## What changed

- **One reader** (`snapshot.js`, byte-identical in every mod): only the status bar's FeedSource
  (`gentle-status`, always mounted) watches the snapshot folders, reads them and runs `ps`
  (`tasklist` where `ps` cannot start or does not answer); it
  publishes `gentle-shell.feeds` (`{ digest, at, feeds }`) and then `gentle-shell.feeds.digest`
  in shared state only when the digest (each live session's agent dir, id and `updatedAt`)
  changes. Setting shared state re-renders every mod, so the others have no timer, watch or `ps`:
  they compare the small digest and read the big value only when it changed. A copy in a layout
  without the status bar reads alone, as before. A layout switch starts the mods while `layout()`
  may still be the previous layout, so a follower looks again after 500 ms (and on every tick)
  before reading alone (measured: without that, six copies read alone after a switch).
- **Chat**: no standing timers. Render follows the shared read (a new session, terminal or
  snapshot → one refresh, from a timer callback) and takes a palette request once the chat shows;
  while shown, a look every 5 s covers a missed event (no file read) and a read every 60 s (15 s
  without a folder watch) covers a write made before the watch began. The folder watch reads only
  when the event names the session's own file. A long session opens at its end (`readTail`: at
  least 300 KB and 300 lines, at most 3 MB, so a few huge tool results do not leave three
  messages; "Show earlier messages" reads as much again); a file over 1 MB is read through one
  `sh` (`wc -c` + `tail -c +pos`), which answers "did not grow" without copying the file.
  Where `sh` cannot start (native Windows, #3352), it is read whole, as a smaller file is.
  hideThinkingBlock is read when the session shows and when one of its two settings files
  changes (a watch on their folders), not on every refresh.
- **Inspector**: no 1 s timer. Its render sets a 1 s wake-up only while the Jobs tab shows a
  running job, and a 30 s one while the Review tab shows (the RDD status read).
- **Sidebar**: the usage footer's minute timer redraws only when the reset words changed.

## S14 (remote machines, light theme)

No timer, watch or process was added. The machine headers read Herdr's live `machines()` (no
`hc machine ls` poll), the appearance is `settings().dark` read in render, and "Add machine" is a
click. Measured the same way (2026-11-15, Herdr app 0.1.16, an idle session shown): dark
0.19–0.30 %, light 0.25 %, Herdr's `main` layout 0.47 %.

## S15 (live work, tool summaries, Needs you, Herdr 0.1.16)

No timer, watch, poll or animation was added. "Working · 2 agents" / "Waiting on 2 agents" are
words the publisher already writes in the snapshot (`activity.label`), read in render; the pinned
Needs you section is computed from the shared feeds in gentle-spaces' render; the notification is
the feed leader's (gentle-status): it runs only when its read changed, as the publish does.
Measured the same way (2026-11-16, Herdr app 0.1.16, window in front): an idle Herdr session
shown 0.34 % and 0.14 %, Herdr's `main` layout 0.37 %. While a TUI session wrote a long reply
and a toast showed, 3.6 % (the chat redrawing what the session wrote, not idle).

## Trade-offs

- The artboard's pulsing working dot (S8) is still: the cost was ~40 % CPU for as long as any
  session worked. A deliberate difference from the artboard.
- The shared feeds are persisted by Herdr in `~/.config/herdr-app/shared.json` (~100 KB for four
  sessions), rewritten when a snapshot changes. At startup the followers show the last persisted
  feeds until the status bar's first read (milliseconds).
- A session with a snapshot starts from its tail: a tool result whose call is before the tail is
  not drawn until "Show earlier messages" reaches it. A session without a snapshot (an older Gentle
  Shell) is still read whole, since its header facts (cost, model, name) come from the file.
