# T11 fidelity: every Gentle Shell session, and the same values as its TUI (S10)

`odd/tasks/herdr-desktop.md` T11, S10 (with S2, S5, S7, S8). Checked live on 2026-11-15 with
Herdr app 0.1.15, the `gentle-shell` layout, and `herdr-app shot` (window brought to the front
with `osascript … set frontmost`; no synthetic keys or clicks: sessions were shown with
`herdr-app do gentle-status.session-next`, views with `gentle-status.toggle` and `layout.hide` /
`layout.toggle`, all restored afterwards).

## What changed

| Area | Before | Now |
|---|---|---|
| Discovery | Sessions came from herdr-core terminals of the window; a session in another terminal was invisible. | Every live snapshot is a session (`snapshot.js allSessions`); live = its publisher pid runs (`liveFeeds`, one `ps -p` per refresh for pids unchecked for 5 s). A terminal of this window that matches a snapshot (`matchFeed`) hosts it. |
| Shown session | Herdr's focus only. | `targetSession`: a session picked in a list (shared `gentle-shell.session`) until Herdr's focus moves to another terminal; else Herdr's focus, as before. |
| Kinds | — | `SESSION_KINDS` / `sessionKind` (snapshot.js): **Herdr** (a terminal of this window) and **TUI** (any other terminal, including a herdr-core terminal this window does not show). |
| Chat | Read only a Herdr terminal's session. | Reads the exact `identity.sessionFile` of any session (outside home through the existing `exec` fallback). TUI sessions: messages, prompt templates and skills through `send_prompt`; answers through `answer_question { via: "session" }`; other commands say "Open that session's terminal to run /commands." |
| Terminal view | Herdr's plain pane header; no way back but ⌘J. | `gentle-pane` header: name, Herdr badge, folder, state and the same **Chat \| Terminal** switch (Terminal active; icon-only under 420 px). |
| Cost format | `$0.25` (artboard cents). | A session's own spend as its TUI footer writes it (`formatCost`): `$33.46`, `$0.247`; sums keep cents. "sub" on a subscription. |

## Kind design (user: "diferenciar claramente" / "separar en el sidebar… dos secciones")

- **Sidebar**: two sections in the Agents area, each with the artboard's `.eyebrow` and a mono
  count on the right: `HERDR · IN THIS WINDOW` (every agent of this window's terminals) and
  `TUI · OTHER TERMINALS` (Gentle Shell TUIs elsewhere). Needs-you first inside each (blocked >
  working > idle, then most recent). An empty section shows one faint line ("No agent in this
  window yet." / "No Gentle Shell TUI in another terminal."). The artboard's "Needs you first"
  caption gave way to the count; the ordering stays.
- **Badge** (`tokens.js kindBadge`, gentle-chat `ui.js kindBadge`): the kbd's look (1 px
  line-strong border, radius 5, mono 10.5/600) with an 11 px icon and the word: **Herdr**
  (`kind-herdr.svg`, a window with a prompt; info tone) and **TUI** (`kind-tui.svg`, a terminal
  with an outward arrow; accent-soft tone). Word + icon, so colour is never the only cue. Shown on
  every Agents row, every Gentle Shell tab, the chat header after the name, and the Terminal header.
- **Projects**: "1 Herdr · 1 TUI · $33.46"; a project no Herdr space holds is its own row
  ("t11-scratch2.QSR2Jx · 1 TUI · $0.25").
- **Chat header of a TUI session**: the switch's place says "This session runs in another
  terminal" ("Other terminal" under 760 px; the tooltip names where: Herdr pane id or pid).

Shots (this run, `/tmp/t11-shots`, not committed): `05-small-*.png`, `11-small-*.png` (both
sections, both badges, three TUI sessions and one Herdr session), `13-heads.png` (wide headers),
`10-terminal-head.png` (Terminal view header).

## Field-by-field: the user's real session vs its TUI (read only)

Session `01a1dbfd-6fa0-72ba-b4f7-709663be581c` (pid 61686, Herdr TUI pane `wMM:p1`, cwd
`~/work/gentle-ai`), kind **TUI**. TUI values read with `herdr pane read wMM:p1` (its footer and
header lines) at the same time as the desktop shot; nothing was sent to it.

| Field | TUI value | Desktop value | Match |
|---|---|---|---|
| Listed at all | (runs in the Herdr TUI) | `TUI · OTHER TERMINALS` row "Herdr app Gentle Shell pac…", TUI badge, "gentle-ai · $33.46 · herdr wMM:p1" | yes (was missing before T11) |
| Conversation | this conversation | chat shows the same latest messages (the orchestrator's summary of this T11 work) | yes |
| Session name | Herdr app Gentle Shell package | Herdr app Gentle Shell package (chat header, tab, row) | yes |
| Model · effort · profile | `claude-opus-5-5 · medium · claude (session)` | `Opus 5.5 · medium · claude (session)` | yes (same values; the desktop's model label is the artboard's short name) |
| Permission mode | `💥 SUPER-YOLO` | `Super-YOLO` pill, warn tone | yes |
| Context | `ctx 51%` | `Ctx 51%` (50.58 rounded) | yes |
| Cost | `$33.46 sub` | `Cost $33.46 sub`; Agents row `$33.46` | yes (after the format fix; before: `$33.46` without "sub") |
| Plan usage | `usage week 34%` | `7d 34%`, "7d resets in 5d 14h" | yes (the artboard calls Claude's week window "7d") |
| Branch · dirty | `fix/codex-on-demand-… ±1` | `gentle-ai / fix/codex-on-demand- · 1 changed` (wide header) | yes |
| Changes | `1 file · +58 −0 · odd/tasks/5930-antigravity-parity.md` | Changes tab `1 file +58 -0`, `A odd/tasks/5930-antigravity-parity.md +58 -0` | yes |
| Todo | `0/5 todos` (was `0/3` earlier, then 5 tasks) | Todo tab `0/5`; status bar "todo 1 of 5" (the in-progress task) | yes |
| Subagents | `▸ ◐ 1 agent` (one running) | Agents tab `1 run` (30 runs listed, 1 running) | yes |
| Activity | `✿ waiting for input` | `Idle` row state, status bar `idle` | yes |
| Turns | not in the footer (`/gentle:stats`, not opened: read only) | Session tab `277 turns` | not compared live (same owner: `collectSessionStats` over the same entries) |
| Persona | not shown in the TUI footer | "No persona" | yes (the snapshot's `persona` is always null: no owner seam yet, as since T4) |
| TPS | `TPS 77.4 tok/s` on the last turn line | not shown (the snapshot has no tok/s) | gap, listed: the desktop shows nothing rather than a different value |
| Pending question | none | none | yes |

A second session, started with the new publisher in herdr-core (`t1b`, `/tmp/t11-scratch2.QSR2Jx`,
not in this window, so kind **TUI**): TUI `ctx 5% │ $0.247 sub │ usage week 34%`, model
`claude-opus-5-5 · medium · claude`; desktop `Ctx 5%`, `Cost $0.247 sub`, `7d 34%`,
`Opus 5.5 · medium · claude`. Match.

## "Plan usage unavailable" with claude-bridge

The publisher already reads the TUI footer's own source: `usage.get(provider)` of gentle-shell's
UsageStore, through the desktop usage owner service (`DesktopUsageBridge`), and its header-driven
snapshots (`after_provider_response`, which is how pi-claude-bridge reports Claude's windows).
Claude-bridge has no usage endpoint, so a session has usage only after its first response, in the
TUI and in the feed alike: t18/t19 (no turn yet) show nothing in their TUI footer and
"Plan usage unavailable" in the desktop; the user's session shows `week 34%` in both; t1b showed
`week 34%` in both right after its first reply. The desktop said "unavailable" for the user's
session only because it showed t18/t19 instead of it (the discovery bug fixed here); no publisher
change was needed.

## send_prompt, live

`t1b` (new publisher): one action file in its inbox, written as `actions.js sendAction` writes it,
`{ kind: "send_prompt", args: { text: "Reply with exactly one word: ok" } }` → outbox
`{ ok: true, data: { queued: false } }`; its TUI shows `❯ Reply with exactly one word: ok` and the
reply `ok`; the desktop chat of that session shows both. The composer's Send for a TUI session runs
the same `sendAction` call; it was not clicked (no synthetic input). `answer_question` via the
session is covered by tests only: the installed Gentle Shell package's ask tools predate the handle,
so no live question could be answered this way.

## Needs a restart

Sessions keep the publisher they started with. The user's session (started 14:01), t18/t19 and
"Analyze OpenAI premature stops" (gentle-pi) show and read fully, but take desktop messages
(`send_prompt`) and session answers only after a restart: until then a message to them is refused
with `unknown_kind` by their inbox, which the chat words as "This session started before desktop messages: type in its own terminal, or restart it.". The ask tools'
handle reaches a session once the Gentle Shell package that ships it is installed.
