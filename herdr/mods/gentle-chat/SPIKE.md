# gentle-chat — T1 spike (read side + prompt)

> T5 (2026-11-14) turned this spike into the centre column of
> `design/herdr-desktop/01-inspector.html`: `ui.js` draws it, `tokens.js` holds the design
> tokens, the header and question card read the T4 snapshot. `FIDELITY.md` lists every matched
> value and what Herdr cannot draw. The notes below are the T1 record.

Spec: `odd/tasks/herdr-desktop.md` T1 (S1, S5, S6). Write path (`hc send` → session JSONL) proven in L6.

## What is here

- `main.js` — the chat view. Picks a Gentle Shell terminal (`agents()` app / `terminals()`
  agent/report = `gentle-shell` or `pi`; `props.terminal` wins, then the focused one, then the
  shown tab's), reads its session, draws it, sends prompts with `hc(["send", address, text])`.
- `session.js` — `sessionFileFor(terminal, memo)`: **the only mapping** terminal → session file
  (T4: the publisher's snapshot in `~/.gentle-shell/agent/desktop/sessions/*.json` matched by the
  terminal's pid / foreground pid against the snapshot's pid, ppid and ancestors, or by Herdr pane
  id, gives the exact `sessionFile`; fallback: cwd → `pwd -P` real path →
  `~/.gentle-shell/agent/sessions/--<path, / and : as ->--/`, newest `*.jsonl` by name =
  timestamp). The match also returns the snapshot (`feed`) for T5/T6. Also `readAfter`
  (complete lines after a byte offset) and a UTF-8 decoder (the runtime has no TextDecoder).
- `feed.js` — pure JSONL → chat items: user, assistant (text / thinking / toolCall blocks,
  `usage.cost.total`, model, error/aborted), tool results joined to their call by
  `toolCallId`, displayed `custom_message` as notes; `model_change`, `thinking_level_change`,
  `session_info` feed the header. Bad lines are skipped.
- `../../layouts/gentle-shell.json` — Herdr's `main` layout with the centre `main` block put in a
  `stack` (`views`): child `chat` (this mod, props `{stack, self, other}`) over child `main`
  (the tab's terminals, titled "Terminal"), with the built-in `"header": "tabs"` strip.

## Why a layout

The Chat/Terminal switch is `run("layout.select", {stack, child})` (herdr-zoo claude-chat
pattern): it needs a stack node in the shown layout. A mod alone cannot place itself over the
tab's terminals. The chat's header has its own Chat | Terminal segment; once the Terminal is
shown, the chat is hidden, so the way back is the stack's `"tabs"` header.

## Refresh

- `watchFolder(sessionDir)` loop in `cx.spawn` (wakes on any change, including a new session
  file) + `cx.timer.every(2000)` fallback. Both call `refresh`, which re-resolves the file and
  reads only new complete lines; a concurrent load just flags "again".
- Incremental: `pos` is a byte offset; only bytes after it are decoded and `JSON.parse`d. A
  half-written last line waits. A shrunk file restarts the feed. Slices are capped at 2 MiB.
- Animation is native only (`.frames` spinner while the agent works); timers are for data.

## Proven

- `herdr-app check herdr/mods/gentle-chat` → `check passed` (empty state: "No Gentle Shell
  terminal…", header `$0`, composer with `Input`).
- A scratch fixture app (outside the repo, a copy of these files subclassing the view and
  ingesting hand-written JSONL lines in pi's shape) passed `herdr-app check --print-spec`: user
  bubble, collapsed/expanded thinking, tool cards (✓ / ✕ with red border, args as fenced JSON,
  result), per-message `$0.246` / `$0.010` with model, `⚠ boom` for an error stop, displayed
  custom message note; an invalid JSON line was skipped.
- The same fixture check showed `utf8()` decodes 1-, 2-, 3- and 4-byte sequences (`añ…🚀`)
  and maps a stray `0xff` to U+FFFD.
- Mapping by hand: `/tmp/gs-spike.GAB6` → `pwd -P` `/private/tmp/gs-spike.GAB6` → the session
  folder holding `2026-11-14T21-45-22-371Z_<uuid>.jsonl` (the L6 session).

## Not proven yet (needs the running Herdr window)

- `check` renders once and does not run async tasks, so `readAfter` on a real file, the
  `watchFolder` loop, the 2 s fallback, auto-scroll (`ScrollHandle.scroll_to_item` on the last
  row) and the `hc send` from the composer are unexercised. Next: install the mod + layout,
  `layout.switch {name: "gentle-shell"}`, open the chat on t2, `herdr-app shot`.
- The stack `"header": "tabs"` and the block `radius`/`background` in the layout are from the
  AGENTS.md layout docs; there is no layout checker.

## Open issues

- Several sessions in one folder: resolved by the T4 snapshot; only the fallback (no snapshot
  matches) still picks the newest file. The pid/pane matching is unproven in a running Herdr
  window (`terminals()` fields `pid`, `foreground.pid`, `address` assumed from herdr-app source).
- `~/.gentle-shell/agent` is hard-coded; an overridden agent dir is not followed. (Later fixed:
  `snapshot.js` `agentRoots()` reads `~/.pi/agent` and listed homes too, docs/desktop-feed.md.)
- Remote terminals (`machine/tN`) are not read (`readFile` is local); they show a notice.
- The runtime has no ranged read or stat: every refresh fetches the file's bytes whole and
  slices them (only the new part is decoded/parsed). Fine for MB-sized sessions; a large one
  wants the publisher's snapshot or a byte-range `exec`.
- The whole visible log (last 150 items, "Show earlier" for more) is rebuilt per render; a
  virtual list is the T5 answer for long sessions.
- No subagent cards, diffs, questions, images or slash menu yet (T5/T7). Thinking blocks and
  tool cards are expanded per copy (not persisted).
- `herdr-app check` writes `gpui-kit.d.ts` and `jsconfig.json` next to the mod; they are
  ignored by the mod's `.gitignore`.
