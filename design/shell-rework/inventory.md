# Gentle Shell capability inventory

Everything the shell shows today, taken from code, so a redesign moves each piece instead of losing it.
Priority: **1** always visible and glanced at constantly, **2** visible while relevant, **3** on demand.

## 1. Editor (the primary element)

| Element | Data and states | Freq | Prio | Today | Source |
|---|---|---|---|---|---|
| Input text | multi-line draft, cursor, scroll indicators top/bottom | constant | 1 | framed editor at the bottom | `lib/shell-prompt.ts` |
| Placeholder | `type, or / for commands` | idle | 1 | inside the input | `PROMPT_HINT` |
| Agent state | `waiting for input` / `working…` / ODD phase (`exploring…`, `checking…`) / `queued` | constant | 1 | row below the input, with an animated petal | `PROMPT_STATE`, `workingLabel` |
| Petal glyph | idle, working (spins 4 flowers), queued, warning tones | constant | 2 | left of the state label | `petalGlyph` |
| Vim mode | `INSERT` / `NORMAL` | constant when vim on | 1 | state row | `vim-editor-adapter.ts` |
| Esc hints | `esc again to cancel`, `esc again to clear` | transient | 2 | state row | `DOUBLE_ESC_CANCEL_HINT` |
| Image chips | `[Image#N]` atomic chips in the draft | occasional | 2 | inline in the input | `image-attachments.ts` |
| Queued follow-up | text typed while the agent works, sent next turn | occasional | 2 | merged into the draft | `gentle-shell.ts:496` |
| Logo | 4-row braille mark | always | 3 | left of the editor | prompt layout |

## 2. Header bar (top, one row today)

| Element | Data | Freq | Prio | Notes |
|---|---|---|---|---|
| Brand | `✿ Gentle Shell` | always | 3 | |
| Location | cwd, branch, dirty count | constant | 1 | dropped first when narrow |
| Model | model id, effort | constant | 1 | `modelDetails` toggle |
| Profile | `claude (session)` | occasional | 2 | dropped first when narrow |
| Context | gauge + `%` | constant | 1 | |
| Cost | `$0.000` (subscription aware) | constant | 2 | `usageCost` toggle |
| Usage | provider windows (`week ▰▰▱ 40%`) + `alt+u` | constant | 2 | opens the usage view |
| Jobs count | `N jobs` | while jobs run | 2 | only when the rail is absent |

## 3. Status panel (rail, `lib/shell-bar.ts:214`)

| Group | Data | Freq | Prio | Notes |
|---|---|---|---|---|
| Project | cwd, branch, session name, profile | rare | 3 | **duplicates the header** |
| Changes | `22 files · +802 −352` or `No captured changes`, `/gentle:changes` | after each turn | 2 | `changes` toggle |
| RDD review | `Reviewers running…`, `Review in progress`, `✓ Approved`, `Fixing findings…`, `Needs your consent`, `Outdated · code changed`, … + scope | while reviewing | 1 when `consent` | `rdd` toggle |
| Integrations | free-form extension statuses: memory (`gentle-pi · saved #N`), permissions (`SUPER-YOLO`), auto-usage | rare | 2-3 | opaque strings from other extensions |

## 4. Live work (rail cards)

| Card | Row data | States | Prio | Controls |
|---|---|---|---|---|
| Jobs | glyph, label, elapsed; counts in subtitle | running, done, failed | 2 | collapse (click, key) |
| Agents | status glyph, agent, task summary, model·effort, tokens, cost, elapsed | queued `○`, running `◐`, **waiting for answer `?`**, done `✓`, failed `✗`, cancelled `–`, timed out | 1 when waiting, else 2 | collapse, rows ordered: questions and running first |
| Todos | status glyph, title, linked job, `done of planned`, `stale · N turns` | pending, in progress, done, blocked, dropped | 2 | collapse (click, `ctrl+shift+t`), scroll (`alt+shift+↑/↓`) |

## 5. Transcript

User message, assistant text, `Thinking…`, tool cards (`ok · read · 11ms`, bash with command and timeout, `ctrl+o` expand), agent answer cards, codemode cards, notices (`Update Available`, dev binary override, SUPER YOLO notice, context warning). Card style neon/float applies here too.

## 6. Overlays and views (on demand)

Command palette (`/`), Changes view (`/gentle:changes`, per-file diff), Usage view (`alt+u`), Agents modal, History, Customize (`/gentle:customize`), Profiles, Persona, Review mode, consent prompts (`ask_user` choices), model selector.

## 7. Settings that change the layout

Card style `neon`/`float`; density `comfortable`/`compact`/`minimal` (default comfortable, the main source of blank rows); status placement `auto`/`right`/`bottom`/`hidden`; header placement `top`/`below-input`; visibility toggles: changes, rdd, agents, todo, usageCost, modelDetails, contextWarning. Rail: 50 columns, fullscreen only, at 140+ columns.

## Presets (validated with the user)

Priority 1 is confirmed: input and its state, vim mode, location (cwd, branch), model, context, and "needs you" alerts (agent waiting for an answer, RDD consent). Every element stays individually switchable in `/gentle:customize`, which also offers three presets:

| Preset | Shows | For |
|---|---|---|
| Light | priority 1 only: editor, one status bar row, alerts; rail hidden | focus, small screens |
| Neutral (default) | priority 1-2: adds changes, live work (agents, jobs, todos) while active, cost and usage | everyday use |
| Power user | everything: model details, usage windows, integrations, RDD scope, finished work on demand | long multi-agent sessions |

## What the first artboards missed

Editor states (working, ODD phase, queued, vim, esc hints, chips), RDD review states, context warning, agents running or waiting for an answer, failed jobs, blocked or stale todos, overlays, narrow widths.
