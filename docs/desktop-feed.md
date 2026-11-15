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

`agentDir` is the session's isolated Pi agent directory
(`GENTLE_PI_AGENT_HOME`, then `PI_CODING_AGENT_DIR`; by default
`~/.gentle-shell/agent`). A session id that is not a plain `[A-Za-z0-9_-]` name
is stored under its SHA-256 instead.

The file is replaced atomically (exclusive temp file in the same folder, then
rename), at most once per 250 ms burst of changes, and only when its content
changed: an idle session never rewrites it and arms no timer. It is removed when
the session shuts down (quit, `/new`, `/resume`, reload). A crashed session can
leave its file behind; the next session start drops files whose publisher pid is
gone or that were not updated for a day. The folder is created `0700` and files
`0600`; symlinked folders or files are refused.

## Format: `gentle-shell.desktop-feed/v1`

| Field | Content |
|---|---|
| `identity` | `sessionId`, exact `sessionFile`, `sessionName`, `cwd`, `realCwd`, `pid`, `ppid`, `ancestors` (nearest first, best effort), `mode`, `herdr` (`paneId` from `HERDR_PANE_ID`, `env`) or `null` |
| `project` | `cwd`, `branch`, `dirty` (changed files, `null` before the first scan) |
| `model` | `id`, `provider`, `effort` (thinking level when the model reasons), `profile` `{ name, tier }` |
| `persona` | always `null` (no reachable owner yet) |
| `context` | `percent`, `tokens`, `window` |
| `cost` | `total` (session spend), `subscription` |
| `usage` | active provider's plan usage: `provider`, `status`, `plan`, `fetchedAt`, `limits[].windows[]` (`label`, `usedPercent`, `windowSeconds`, `resetAt`) |
| `permission` | `mode` (`normal`, `auto`, `yolo`, `super-yolo`), `defaultMode`, `yolo`, `detail` |
| `statuses`, `integrations` | always `null` (pi exposes extension statuses only to the footer owner) |
| `todo` | `items[]` (`id`, `title`, `state`, `note`), `progress` (`done`, `total`, `open`), `current`, `truncated` |
| `changes` | `files[]` (`path`, `status`, `added`, `deleted`), `summary`, `worktrees[]`, `truncated`; `null` before the first scan. An untracked file's `added` is its line count (git's numstat never lists it); a binary file, a file over 1 MiB, an unreadable file or one past 200 untracked files per scan has `added` and `deleted` `null` (no count) |
| `agents` | `items[]` (`id`, `name`, `role` = `null`, `state`, `step`, `model`, `thinking`, `spend`), `active`, `spend` |
| `jobs` | `running[]` and `recent[]` (finished tail) with `startedAt`, `endedAt`, `exitCode`, `elapsedMs` at write time |
| `review` | `state`, `label`, `scope` |
| `stats` | `turns`, `toolCalls`, `toolErrors`, `cost`, token counts, `cacheHitRate`, `durationMs`, `models[]` |
| `activity` | `state` (`working`, `blocked`, `idle`), `streaming`, ODD `phase` and `phaseLabel`, `blockedLabel` |
| `pendingQuestion` | the open question or `null` (below) |
| `commands` | the session's slash commands for the desktop palette and the composer's `/` menu: `items[]` (`name`, `description`, `args`, `terminal`, `source`) and `truncated` (below) |

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

`commands.items` lists pi's built-in commands first (`source` `builtin`: `new`,
`resume`, `fork`, `clone`, `tree`, `compact`, `name`, `export`, `session`, `copy`,
`model`, `thinking`, … — every built-in but `/quit`, which is typed, never one click
away), then pi's command registry in its own order: extension commands
(`extension`), prompt templates (`prompt`) and skills (`skill`). `terminal` is `true`
when the command answers with a screen of the TUI (a picker, a panel, a status
report), so the desktop shows the Terminal after sending it; prompt templates and
skills answer in the conversation. `args` names the argument a command needs
(`/name <name>`): the desktop puts it in the composer instead of sending it. The
desktop RPC's own `gentle:desktop` channel is never listed; source paths never
reach the file.

Arrays are capped (200 changes, 100 todo items, 50 jobs, 50 agents, 20 models,
4 questions, 10 options, 200 commands); command descriptions are cut at 200
characters; free text is cut at 500 characters (questions at 2000,
paths at 1000/4096) and stripped of control characters. Readers should ignore an
unknown `schema`.

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

The session refuses, removes and answers (code in `error.code`) a file that is a
link, not a private regular file (`unsafe_file`), over 16 KiB (`too_large`), older
than 60 s or dated ahead (`stale`), of another kind (`unknown_kind`), for another
session (`wrong_session`), malformed or with other args (`invalid_action`), already
run (`duplicate`), a question that is no longer open (`question_mismatch`), a
stop while the agent is idle (`not_working`), or a permission escalation written
while the session was busy (`escalation_while_busy`).
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
`cancel_*` actions are always accepted. The desktop's confirmation dialog stays
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

What the desktop does without this inbox, as the person would: it sends prompts
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

Inside the chat, without that merge: ⌘K opens the palette, ⌘J shows the Terminal,
Esc Esc stops the agent (Esc first closes the `/` menu), and `/` in the composer
opens the command menu (↑/↓ move, Enter runs, Tab completes, Esc closes).
