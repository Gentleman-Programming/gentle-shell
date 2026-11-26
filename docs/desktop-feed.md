# Read a Gentle Shell session's desktop snapshot

Every live Gentle Shell session keeps one JSON snapshot of what its terminal UI
shows, so another process (the Gentle Shell Desktop mods for Herdr app) can show
the same information without attaching to the session. The packaged
`gentle-desktop-feed` extension loads automatically; it is only active in
interactive top-level Gentle Shell sessions (the TUI or an interactive RPC host).
Subagent children, plain Pi, and print/JSON runs publish nothing.

## Location

```
<agentDir>/desktop/sessions/<sessionId>.json
```

`agentDir` is the session's Pi agent directory (`GENTLE_PI_AGENT_HOME`, then
`PI_CODING_AGENT_DIR`, then `~/.pi/agent`): `~/.gentle-shell/agent` for the
bundled Gentle Shell, `~/.pi/agent` for Gentle AI installed as a Pi extension,
or a custom home. The snapshot names it in `identity.agentDir` (absolute), and
every other path of the session (its action inbox and outbox) is under it. A
session id that is not a plain `[A-Za-z0-9_-]` name is stored under its SHA-256
instead.

### Where readers look

The Herdr app mods read the snapshots of every agent dir they know, bundled
first:

1. `~/.gentle-shell/agent`
2. `~/.pi/agent`
3. each entry of `~/.config/herdr-app/gentle-shell-roots.json`, when that file
   exists: `{ "roots": ["/abs/agent/dir", "~/other/agent"] }` (a bare array works
   too). Entries are absolute or start with `~/`; anything else is ignored, and
   at most 8 agent dirs are read in total.

They watch each existing `desktop/sessions` folder (a 10 s timer catches a
folder created later), match a terminal to a snapshot across all of them, and
send that session's actions to the inbox under its own `identity.agentDir`.

Every live snapshot is a session the desktop shows, wherever it runs: in a
terminal of the Herdr app window (kind **Herdr**), or in any other terminal —
the Herdr TUI, Ghostty, a herdr-core terminal this window does not show (kind
**TUI**). A snapshot counts as live while its publisher's `identity.pid` runs
(one `ps -p` per refresh for the pids not checked in the last 5 s; where `ps`
cannot start or does not answer, as on Windows, one `tasklist` instead). Only a
listing that answered decides: `ps` exiting 0, or 1 with nothing on stderr (a pid
is gone), or `tasklist` exiting 0. A `ps` that rejects its own flags (an MSYS/Git
`ps` on a Windows `PATH`) decides nothing, and when no listing answers every
snapshot counts. A Herdr session takes typed input in its terminal; a TUI
session takes prompts and answers through its inbox (`send_prompt`,
`answer_question` with `via: "session"`, below). A
snapshot from an older Gentle Shell without `identity.agentDir` is treated as
belonging to the agent dir it was found in. Herdr app lets mods read only under
the home folder, so an agent dir outside it is not seen.

The file is replaced atomically (exclusive temp file in the same folder, then
rename), only when its content changed (`updatedAt` and job elapsed counters
are not content): an idle session never rewrites it and arms no timer. Writes
come in two tiers (see Performance below): urgent state within 16 ms, the rest
at most once per second while the session is busy and 250 ms after a change
while it is idle. It is removed when
the session shuts down (quit, `/new`, `/resume`, reload). A crashed session can
leave its file behind; the next session start drops files whose publisher pid is
gone or that were not updated for a day. The folder is created `0700` and files
`0600`; symlinked folders or files are refused.

## Format: `gentle-shell.desktop-feed/v1`

| Field | Content |
|---|---|
| `identity` | `sessionId`, exact `sessionFile`, `sessionName`, `cwd`, `realCwd`, `pid`, `ppid`, `ancestors` (nearest first, best effort: `ps` per hop, or on Windows one process-table read per walk; empty when it cannot be read), `mode`, `agentDir` (absolute agent dir the snapshot lives under), `herdr` (`paneId` from `HERDR_PANE_ID`, `env`) or `null` |
| `project` | `cwd`, `branch`, `dirty` (changed files, `null` before the first scan) |
| `model` | `id`, `provider`, `effort` (thinking level when the model reasons), `profile` `{ name, tier }` |
| `persona` | the active persona mode (`"gentleman"` or `"neutral"`, read like `/gentle:persona` does), or `null` when it could not be resolved |
| `context` | `percent`, `tokens`, `window` |
| `cost` | `total` (session spend), `subscription` |
| `usage` | what the TUI usage panel (alt+u, `/gentle:usage`) shows, from the same owner: the session's provider at the top level (`provider`, `status`, `plan`, `fetchedAt`, `note`, `limits[]` with `name`, `limitReached` and every `windows[]` entry: `label`, `usedPercent`, `windowSeconds`, `resetAt`), and every provider the panel lists in `providers[]` (the session's own first, then its subagent routes; same fields). `note` is the panel's own words for a provider without windows (`usage arrives with the first response`, `no usage yet · r to fetch`, `fetch failed · r to retry`, `no subscription usage for this provider`), else `null`. `plan` is the plan name the provider reports (Codex does; Anthropic's headers carry none, so it stays `null` there, as in the panel). `null` before the owner answered |
| `profiles` | the saved model profiles (`/gentle:profiles`' store): `active` (the profile this session routes with), `default` (the store's default for new sessions), `items[]` (`name`, `tier`, `mode`, `orchestrator` `{ model, thinking, tier }` or `null`, `roles[]` `{ agent, model, thinking }` alphabetical, `inherit` when unset, `truncated`), `truncated`; `null` when the store cannot be read |
| `permission` | `mode` (`normal`, `auto`, `yolo`, `super-yolo`), `defaultMode`, `yolo`, `detail` |
| `statuses`, `integrations` | always `null` (pi exposes extension statuses only to the footer owner) |
| `todo` | `items[]` (`id`, `title`, `state`, `note`), `progress` (`done`, `total`, `open`), `current`, `truncated` |
| `changes` | `files[]` (`path`, `status`, `added`, `deleted`), `summary`, `worktrees[]`, `truncated`; `null` before the first scan. An untracked file's `added` is its line count (git's numstat never lists it); a binary file, a file over 1 MiB, an unreadable file or one past 200 untracked files per scan has `added` and `deleted` `null` (no count) |
| `agents` | `items[]` (`id`, `name`, `role` = `null`, `state`, `step`, `model`, `thinking`, `spend`), `active`, `spend` |
| `jobs` | `running[]` and `recent[]` (finished tail) with `startedAt`, `endedAt`, `exitCode`, `elapsedMs` at write time |
| `review` | `state`, `label`, `scope` |
| `stats` | `turns`, `toolCalls`, `toolErrors`, `cost`, token counts, `cacheHitRate`, `durationMs`, `models[]` |
| `activity` | `state` (`working`, `waiting`, `blocked`, `idle`), `streaming`, ODD `phase` and `phaseLabel`, `blockedLabel`; S15: `agents` and `jobs` (the session's subagents and background jobs that still run, the same numbers as `agents.active` and `jobs.running`) and `label`, the words every desktop region shows: "Working · 2 agents" while the turn runs, "Waiting on 2 agents · 1 job" once the turn ended but that work still runs (`waiting`, never `idle`), the blocker's label, else "Idle". Background subagents are the agents owner's, not the jobs registry's: they count in `agents`, never in `jobs` |
| `pendingQuestion` | the open question or `null` (below) |
| `commands` | the session's slash commands for the desktop palette and the composer's `/` menu: `items[]` (`name`, `description`, `args`, `terminal`, `rpc`, `source`) and `truncated` (below) |

`pendingQuestion.kind` is `choice` (`ask_user_choice`), `questionnaire`
(`ask_user_question`), `prompt` (an extension dialog: `promptKind` is `select`,
`confirm`, `input` or `editor`) or `consent` (a blocker without content, such as
review consent; `question` is its label). Ask tool questions carry `tool` and
`toolCallId`, the flattened first `question`, `header`, `options`
(`label`, `description`), `multi`, `custom`, and every question in `questions`.
Opaque answer tokens (`ask_user_choice` option values) are never written.
`terminalOnly` is `true` when the desktop must not pick an answer: prompts,
consent, several questions or a multi-select question, and a provider consent or
maintenance authorization the agent relays through an ask tool (below). The
desktop then shows the options for reading only, with "Answer in Terminal".

`usage` follows the panel's own fetches; the feed never asks a provider itself.
gentle-shell fetches when the session starts (forced) and after each turn (at most
once per provider every 5 minutes), and records the windows Claude and Codex send
with every response. The feed reads the owner's store when the session starts and
after each turn, then again 2 s and 12 s later (the fetch has no event of its own;
its window is 10 s), and takes every response-carried snapshot as it is recorded.
The desktop's refresh is the panel's `r` (`refresh_usage`, below).

`commands.items` lists pi's built-in commands first (`source` `builtin`: `new`,
`resume`, `fork`, `clone`, `tree`, `compact`, `name`, `export`, `session`, `copy`,
`model`, `thinking`, … — every built-in but `/quit`, which is typed, never one click
away), then pi's command registry in its own order: extension commands
(`extension`), prompt templates (`prompt`) and skills (`skill`). `terminal` is `true`
when the command answers with a screen of the TUI (a picker, a panel, a status
report), so the desktop shows the Terminal after sending it; prompt templates and
skills answer in the conversation. `rpc` is `true` when the command works from an RPC
client (Gentle Shell's own declaration in `lib/desktop-command-rpc.ts` for extension
commands, a matching Pi RPC command for built-ins, always for prompt templates and
skills) and `false` otherwise, including every undeclared extension command; it never
changes `terminal`, which keeps its meaning for Herdr, and `send_prompt` still refuses
extension commands (`terminal_command`). `args` names the argument a command needs
(`/name <name>`): the desktop puts it in the composer instead of sending it. The
desktop RPC's own `gentle:desktop` channel is never listed; source paths never
reach the file.

Arrays are capped (200 changes, 100 todo items, 50 jobs, 50 agents, 20 models,
4 questions, 10 options, 200 commands, 8 usage providers, 20 profiles of 40 roles); command descriptions are cut at 200
characters; free text is cut at 500 characters (questions at 2000,
paths at 1000/4096) and stripped of control characters. Readers should ignore an
unknown `schema`.

## Performance

S13 (`odd/tasks/herdr-desktop.md`): every write wakes every desktop reader, and
every flush runs on pi's event loop, so the publisher keeps both rare and cheap.

- **Urgent tier (≤ 16 ms):** a question opening or closing (`pendingQuestion`),
  a permission mode change, an `activity.state` transition (idle ↔ working ↔
  waiting ↔ blocked; S15: the last subagent or job ending moves `waiting` to
  `idle` at once) are written at once; a desktop prompt being held or released flushes
  at once too (the snapshot has no field of its own for it, so it writes only
  what changed with it). A pending routine write rides along.
- **Routine tier:** everything else (stats, context, changes, usage, commands,
  agents and jobs progress, streaming) coalesces: at most one write per 1000 ms
  while the agent, a job or a subagent works, 250 ms after the change while
  idle. A flush whose content did not change writes nothing.
- **Cheap flushes:** session stats fold only the entries added since the last
  flush (`lib/desktop-feed-stats.ts`; pi's `getEntryCount()` skips the read
  when nothing was added); pi's command registry is read at the first flush
  after `session_start` and after `resources_discover`, not per flush;
  untracked files are counted again only when their size or mtime changed.

Measured with `tests/desktop-feed-performance.test.ts` (virtual clock; real
store writes on the local disk, Apple Silicon):

| Measure | Before | After |
| --- | --- | --- |
| Writes for 100 tool events in 10 s while working | 34 (≈ 204/min) | 10 (≈ 60/min) |
| Writes in a quiet minute | 0 | 0 |
| Question / blocker / state change visible | ≤ 250 ms | ≤ 16 ms |
| Flush, 5,000 entries + 200 changed files, incremental path (median) | 1.46 ms | 0.18–0.30 ms |
| First stats walk of 5,000 entries (once per session start) | every count change | 1.5–2.2 ms once |

The test asserts ≤ 11 routine writes per 10 s burst, writes at least one second
apart, urgent changes within 50 ms, and a median flush under 15 ms.

A command registered at runtime by another extension (no pi event announces it)
appears after the next session start or resource rediscovery.

## Privacy

The snapshot holds workspace paths, the session file path, todo titles and notes,
changed file names, and open question text. It never holds prompts, tool
arguments other than an open question, tool output, or job commands. Do not
expose the folder through a public server.

## Actions: `gentle-shell.desktop-action/v1`

The desktop acts on a session with exactly the authority the person has in its
terminal, never more. Each session that publishes a snapshot also keeps a private
inbox and outbox:

```
<agentDir>/desktop/inbox/<session>/<id>.json    the desktop drops one action
<agentDir>/desktop/outbox/<session>/<id>.json   the session answers it
```

`<session>` is the snapshot's file name without `.json`. The session creates both
folders `0700` when it starts (with its pid in `inbox/<session>/.owner`) and
removes them when it ends; the desktop never creates them (no inbox means the
session takes no actions). The agent's own file and shell tools are denied the
whole `<agentDir>/desktop/` folder like any other sensitive path. An action file is

```json
{ "schema": "gentle-shell.desktop-action/v1", "id": "<[A-Za-z0-9_-], 1-64, = file name>",
  "sessionId": "<this session>", "kind": "<kind>", "args": { }, "createdAt": "<ISO time>" }
```

| `kind` | `args` | Runs through |
|---|---|---|
| `set_permission_mode` | `{ mode }` (`normal`, `auto`, `yolo`, `super-yolo`) | the permission owner, as desktop RPC `set_permission_mode` (the `/gentle:mode` controller decides); an escalation is first checked against the session's activity (below) |
| `cancel_job` | `{ id }` | the background-jobs owner, as desktop RPC `cancel_job` |
| `cancel_subagent` | `{ id }` | the subagents owner, as desktop RPC `cancel_subagent` |
| `answer_question` | `{ toolCallId, option }` or `{ toolCallId, text }` | nothing is answered here: the session checks that `toolCallId` is the open `ask_user_choice` / single-question `ask_user_question` and answers the keys its real list takes (`up` to the top, `down` to the row, `enter`); the desktop presses them in the terminal, then types `text` into the list's own editor |
| `abort_turn` | `{}` | the session's own abort, the one its TUI's Esc Esc runs (in the TUI, queued messages go back to the editor); refused with `not_working` while the agent is idle |
| `send_prompt` | `{ text }` (1-4000 characters, not blank; new lines and tabs, no other control character; a CRLF line end counts as one new line) | pi's `sendUserMessage`, as if typed in the session's editor and submitted: a prompt while the agent is idle, a steer while it works (the TUI's Enter); trimmed like the editor. Refused with `question_open` while a question, an extension prompt or a consent is open. A prompt template or a skill (`/review …`, `/skill:…`) expands as in the editor; a pi built-in command, an extension command (`/gentle:mode`, …) or a `!` shell line is refused with `terminal_command` (they are TUI code with their own authority); a `/word` no command owns is plain text. Answers `{ queued }`. While pi runs a manual compaction (`/compact`) or a `/tree` navigation it refuses prompts, so the session holds the text, as the TUI editor queues it, and submits it once pi takes prompts again; it answers `{ queued: true, after: "compaction" }` (`{ queued: true }` when pi is busy with no agent run the session heard of yet). One prompt is held at a time: another one is refused with `session_compacting`; a held prompt the session ends before submitting is dropped with an error in that session's UI |
| `refresh_usage` | `{}` or `{ provider }` (1-128 characters) | the usage owner's forced refresh, as desktop RPC `refresh_subscription_usage` and the TUI usage panel's `r`; answers `{ providers: [{ provider, status, refresh? }] }` (`refresh`: `unsupported` for a provider whose windows only come with responses, `out_of_scope` for a provider the session does not target); the snapshot's `usage` follows |
| `apply_profile` | `{ name }` or `{ name, confirmation }` (each 1-128 characters) | `/gentle:profiles`' own "Use in this session", as desktop RPC `apply_profile` with mode `session` (never the global default, never another mode): the owner checks the name and binds the profile to this session. Answers `{ profile, mode, status, notes }` (`applied` or `not_applied`, with the screen's notices), or `status: "confirmation_required"` with `confirmation` `{ title, message, token }`: the desktop shows that dialog and, on Confirm, sends the same action with `confirmation: token` (the owner accepts it only while its dialog would still say the same). Owner refusals keep their codes: `unknown_profile`, `profile_apply_busy`, `profiles_unavailable`. Like `/gentle:profiles`, it also runs while the session works |
| `answer_question` with `via: "session"` | `{ toolCallId, option, via }` or `{ toolCallId, text, via }` | the same checks as the key path (still the open question, answerable from the desktop, an existing option or the list's free-text row), then the ask tool's own list takes the answer, exactly as a click or Enter in it would; answers `{ toolCallId, answered: true }`, or `answer_in_terminal` ("Answer this question in that session's terminal.") when the list has no handle (a Gentle Shell older than this one) |

The session refuses, removes and answers (code in `error.code`) a file that is a
link, not a private regular file (`unsafe_file`), over 16 KiB (`too_large`), older
than 60 s or dated ahead (`stale`), of another kind (`unknown_kind`), for another
session (`wrong_session`), malformed or with other args (`invalid_action`), already
run (`duplicate`), a question that is no longer open (`question_mismatch`), a
stop while the agent is idle (`not_working`), a permission escalation written
while the session was busy (`escalation_while_busy`), a prompt while a question is
open (`question_open`), a prompt that is a command or shell line only the terminal
runs (`terminal_command`), a second prompt while one is held for after a
compaction (`session_compacting`), a prompt to a session without a prompt
owner (`unsupported`).

**Prompts are not human evidence.** A `send_prompt` reaches pi with the input
source `extension`, as any extension message does, never `interactive`: Gentle
AI's consent and reply-language rules, which count only interactive input as the
person's own words, never treat a desktop prompt as a typed consent. Consent stays
in the terminal.

**The ask tools' answer handle.** `ask_user_choice` and `ask_user_question`
register, while their TUI list is open, one handle per tool call id in a
process-wide registry (`lib/desktop-feed-answers.ts`; their event-bus traffic is
unchanged). It finishes the list once, with the result a click gives; a finished
list leaves the registry. Only a single single-select question can be answered
through it, and never with a consent token (`granted`, `declined`) as the option
value, label or typed text.
A non-regular entry (a folder, a FIFO, a device) is refused once: an empty
folder is removed, anything that cannot be removed is skipped until it changes.

**Escalations.** Any process of the same user can write the inbox, the agent's
own tools included (the tool guard covers the folder by name, but a shell can
spell a path other ways). So a change to a less restrictive mode (`normal` →
`auto` → `yolo` → `super-yolo`) is refused with `escalation_while_busy`, before
the permission owner is asked, when its file was last written (the later of the
file's `mtime` and `ctime`, never `createdAt`) while the agent worked, a
background job or a subagent of the session ran, within 2 s after that activity
ended, or before the session started. Lowering the mode, `abort_turn` and the
`cancel_*` actions are always accepted. `apply_profile` does not follow this rule:
like `/gentle:profiles` in the TUI, it runs while the session works. The desktop's confirmation dialog stays
the human gate for Super-YOLO; the session does not ask for a dialog nonce,
because a nonce file would be written by the same user the agent runs as and
proves nothing the activity check does not.

Multi-question and multi-select questions, extension prompts and consent are
answered in the terminal (`answer_in_terminal`); consent is never answered from
the desktop. That includes a provider consent or maintenance authorization the
agent relays through `ask_user_choice` / `ask_user_question`: the session treats
an ask call as such a relay when a tool result in the same or the previous agent
run carried a provider decision (a `gentle-ai.review-integration.consent/…` or
`gentle-ai.review-repair-authorization/…` envelope, a consent binding,
`maintainer_authorization`), or when the call's own options carry the consent
answers (`granted` / `declined`) or such an envelope. Every file is removed once
read; a fresh file that does not parse yet is read again 250 ms later (it may
still be written).

The answer is `{ schema: "gentle-shell.desktop-action-result/v1", id, sessionId,
kind, ok, data | error, finishedAt }`, `0600`, `data` at most 4 KiB. Owner errors
keep the owner's code and message (`permission_denied`, `not_found`, …); the
desktop shows them. The session keeps at most 32 answers for 10 minutes and
removes the folder when it ends (Herdr mods may write files only under the app's
own folder, so the desktop leaves answers in place). A session killed without
its shutdown leaves both folders behind; a later session start removes them once
they have not changed for 10 minutes and their session is proven gone: the pid in
`.owner` (or, without one, in its snapshot) no longer runs, or there is neither.
A live session's folders stay however long it is idle.

What the desktop does without this inbox, as the person would, for a session in
a terminal of its window (kind Herdr): it sends prompts
and the TUI's own slash commands (any command typed in the composer or chosen in
the `/` menu or the ⌘K palette, and the views' own `/gentle:changes`,
`/gentle:agents`, `/gentle:jobs`, `/gentle:profiles`, `/gentle:persona`) with
`hc send`, only while no question is open (the composer refuses to send while
one is); it pastes the clipboard with Ctrl+V; and the review switch runs
`gentle-ai review mode enable|disable --scope global --cwd <project> --json`
after a confirmation that says it is global: it changes receipt-driven review for
every repository (a repository's clone-local `off` still wins). Super-YOLO and
the review switch ask in a dialog first (`gentle-confirm`: Confirm runs the
action once; Cancel or Esc forgets it, and an unanswered dialog expires after two
minutes). Right before pressing an answer's keys, the chat reads the snapshot
again and presses nothing if the question changed.

## Desktop keys

The Herdr mods ship `herdr/keys.json`, a `layout:gentle-shell` section for the
person's `~/.config/herdr-app/keys.json` (merged into it, never replacing a key
they already use):

| Key | Command | Does |
|---|---|---|
| ⌘K | `mod.open:gentle-palette` | the Gentle commands palette: needs-you items, session commands, views, permission modes, every command of the session |
| ⌘J | `gentle-status.toggle` | Chat ↔ Terminal |
| ⌘. | `gentle-status.stop` | stops the shown session's turn (`abort_turn`) |
| ⌥⌘1 … ⌥⌘6 | `gentle-inspector.tab-<changes\|todo\|agents\|jobs\|review\|session>` | the inspector tab |

`gentle-status.session-next` and `gentle-status.session-prev` (no default key; run
them with `herdr-app do` or bind them) show the next or previous live session,
wherever it runs.

Inside the chat, without that merge: ⌘K opens the palette, ⌘J shows the Terminal,
Esc Esc stops the agent (Esc first closes the `/` menu), and `/` in the composer
opens the command menu (↑/↓ move, Enter runs, Tab completes, Esc closes).
