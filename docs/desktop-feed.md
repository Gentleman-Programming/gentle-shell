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

`pendingQuestion.kind` is `choice` (`ask_user_choice`), `questionnaire`
(`ask_user_question`), `prompt` (an extension dialog: `promptKind` is `select`,
`confirm`, `input` or `editor`) or `consent` (a blocker without content, such as
review consent; `question` is its label). Ask tool questions carry `tool` and
`toolCallId`, the flattened first `question`, `header`, `options`
(`label`, `description`), `multi`, `custom`, and every question in `questions`.
Opaque answer tokens (`ask_user_choice` option values) are never written.

Arrays are capped (200 changes, 100 todo items, 50 jobs, 50 agents, 20 models,
4 questions, 10 options); free text is cut at 500 characters (questions at 2000,
paths at 1000/4096) and stripped of control characters. Readers should ignore an
unknown `schema`.

## Privacy

The snapshot holds workspace paths, the session file path, todo titles and notes,
changed file names, and open question text. It never holds prompts, tool
arguments other than an open question, tool output, or job commands. Do not
expose the folder through a public server.
