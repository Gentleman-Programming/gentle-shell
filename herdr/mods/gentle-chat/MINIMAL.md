# gentle-chat: the minimal view (T12, S11)

> "agrega algo, vista mnimia de todo en el chat, como hacemos con gentle shell y que pueda
> expandirse cualquier cosa"

The chat opens in the same minimal view the Gentle Shell TUI uses. Every item that is not the
conversation's own text is one line, and any line opens and closes again.

## How the TUI does it (read from the source)

| TUI piece | Rule | Source |
|---|---|---|
| Tool cards (`read`, `bash`, `grep`, `find`, `ls`, `edit`, `write`) | With the default **Card content: minimal** (`lib/card-content-policy.ts`, `DEFAULT_CARD_CONTENT = minimal`), a collapsed card shows only the command, on one row: glyph, tool, argument and the expand hint in the top rule. A failed card still shows its error tail, so a red card always says why. Expanded, it shows the whole result. | `extensions/quiet-tools.ts` `COMMAND_ONLY_TOOLS`, `renderResult` |
| `bash` | The collapsed row is the command's first line without leading `cd … &&`, plus "… +N lines" for the rest. | `quiet-tools.ts` `bashSummary` |
| Expand / collapse | One window-wide toggle, `app.tools.expand` (**ctrl+o**, "Toggle tool output"). It flips every expandable item at once: tool cards, subagent cards, custom message cards, compaction and branch summaries, skill blocks. New items take the current state. There is no per-card state for tools. | pi `interactive-mode.js` `toggleToolOutputExpansion` / `setToolsExpanded`; `keybindings.js` |
| Thinking | `hideThinkingBlock` (pi setting; this machine has it `true`) draws each thinking run as one italic label instead of its text. A click on a run flips that run only. **ctrl+t** (`app.thinking.toggle`) flips the setting and writes it to settings. Consecutive thinking blocks of a message are one run. ctrl+o does not touch thinking. | pi `assistant-message.js` (`thinkingVisibilityOverrides`, `hiddenThinkingLabel`), `settings-manager.js` |
| Subagent card (`subagent_run`) | Collapsed: state pill, task label, last step. Expanded adds the workspace, the error and the answer. | `extensions/gentle-agents.ts` `statusCardRows`, `agentResultPreview` |
| Custom messages | A renderer gets `{ expanded }`; Gentle's (review preflight, subagent output, …) show a 3-row preview collapsed and everything expanded. | `extensions/gentle-shell.ts` `REVIEW_PREFLIGHT_TYPE`, pi `custom-message.js` |
| Compaction | Collapsed: "[compaction] Compacted from N tokens (ctrl+o to expand)"; expanded: the summary. A click flips it. | pi `compaction-summary-message.js` |
| Skill invocation | Collapsed: "[skill] name"; expanded: the skill text. The message typed with it is a normal user message. | pi `skill-invocation-message.js`, `parseSkillBlock` |
| Assistant text, user messages | Always whole. The TUI never folds a reply or a code block. | pi `assistant-message.js` |
| Questions | Always open (a dialog, not a transcript card). | `extensions/ask-user-question.ts` |
| Task summary | `herdr-task-summary.json` `enabled` (Customize → Layout → Task summary on/off) is the summary published to terminal tools (Herdr's sidebar), not a transcript fold. Not part of the chat. | `odd/tasks/task-summary-toggle.md` |

## How the chat does it

| Item | Minimal (default) | Open |
|---|---|---|
| Tool call | One `.tool` row: ✓ / ✕ / a still • while it runs, name, what the call does in words (path relative to the project, "· N lines", "· N matches"; S15, `feed.js summarize`: todo "write · 3 tasks, 1 in progress" / "update #2 → done", ask_user_choice / ask_user_question the question, subagent_run "agent · label", bash_background / monitor the label, job_* the job id, web_search the query, fetch_content the URL, mem_* the title or query, codemode the first line of code, gentle_review* the operation; any other tool its first string value; **never the JSON of the arguments**), the bash outcome or the **error's last line in red**, the duration, chevron | Arguments (when they say more than the row) and the output, up to 6000 characters |
| Two or more reads / searches in a row | "✓ Explored · 2 reads, 1 search 0.9s" | The tool rows, each one minimal or open on its own |
| Thinking run (consecutive blocks are one run) | "Thought for Ns" (italic, chevron) when the session hides thinking; **open** when it does not | The thinking text |
| Edit with a patch | One `.tool` row: ✓, edit, file, +N −M | The artboard's diff card: hunk, Next hunk, Open in Changes |
| Subagent run | One `.tool` row: ROLE, task, state dot + label, model, spend | The artboard's `.sub` card (title row closes it; View / Stop while it runs; last step; its answer) |
| Custom message (subagent output, notices) | One short line stays as it is; longer: one row with its type and first line | The whole message (markdown) |
| Compaction | One row: "compaction · Compacted from 182,345 tokens" | The summary |
| Branch summary | One row with its first line | The summary |
| Skill invocation | One row: "skill · name"; the typed message is its own bubble | The skill text |
| Assistant text, user bubbles, the pending question, "Working" | Always whole | — |

- **Expand all / Collapse all**: the composer's hint "⌘O expand all" (it reads "collapse all"
  while everything is open), **⌘O** (in the chat, and in `herdr/keys.json` under
  `layout:gentle-shell` as `gentle-chat.expand`), the palette's View rows "Expand all" /
  "Collapse all", and the mod commands `gentle-chat.expand` (toggle), `gentle-chat.expand-all`,
  `gentle-chat.collapse-all` (`herdr-app do gentle-chat.expand-all`). Like ctrl+o it is one
  window-wide state; new items take it. Unlike ctrl+o it also opens thinking runs: the
  desktop's promise is "expand anything".
- **Per item**: a click on any row (or its chevron) opens it, another closes it. That flip
  wins over Expand all until the next Expand all / Collapse all, which starts every row over.
  The flips live in the view by row id (entry id + block index), so they survive new lines,
  re-reads of the file and switching to another session and back (the last 30 sessions).
- **hideThinkingBlock**: read from the shown session's own settings (`<agentDir>/settings.json`,
  overridden by `<cwd>/.pi/settings.json`, as pi merges them) when the session shows and again
  when one of those two files changes (a watch on their folders); ctrl+t in its TUI is picked up
  then. Missing or unreadable: not set (pi's default, false).
- **Cost**: a closed row builds no body (bodies are built only while open), so the minimal view
  is also the cheap one. One ⌘O reaching both the chat's key and the layout's key toggles once
  (a 300 ms guard). No animation while a session works (S13, `herdr/PERF.md`): the running dot
  and a running tool's mark are still; only the Send button's spinner runs, for the second a
  send takes.

## Where the desktop differs from the TUI, and why

| TUI | Desktop | Why |
|---|---|---|
| ctrl+o toggles tool output only; ctrl+t toggles thinking | ⌘O toggles everything, thinking included; a click flips one thinking run (as in the TUI) | "que pueda expandirse cualquier cosa" |
| ctrl+t writes `hideThinkingBlock` | The desktop only reads it | The setting belongs to the session; the desktop never writes its files |
| Custom message renderers decide their own preview | One line (type + first line) unless the message is one short line | The desktop has no renderer per message type |
| Collapsed failed card: up to 3 error lines | The error's last line, in red, in the row | One line per item |
| Card content "default" (previews) | Not followed: always minimal | `card-content.json` is the TUI's own drawing choice; the desktop's rows always have the counts |
