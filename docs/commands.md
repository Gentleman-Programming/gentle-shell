# Command reference

Every slash command registered by Gentle Shell, with its syntax, subcommands, defaults, in-overlay keys and the exact error strings you will see. Commands live in the `/gentle:` namespace; two others are documented at the end.

**Scope.** This page covers *what each command accepts and does*. For why the harness works the way it does, see [readme-reference.md](readme-reference.md); for the shell's UI surfaces, see [gentle-shell.md](gentle-shell.md).

**Maintenance.** The list below was derived from the `registerCommand(…)` call sites in `extensions/` and `lib/`, then each handler was read for its arguments, defaults and validation messages. Re-derive it after an upgrade with:

```bash
grep -rn 'registerCommand' extensions lib --include=*.ts
grep -rn '_COMMAND_NAME[A-Z_]* = "' extensions lib --include=*.ts
```

Two commands are generated from a template — `gentle:install-delegation` and `gentle:install-review` come from `gentle:install-${owner}` — so a literal grep for the final name finds nothing. Anything not provable from the code was left out rather than guessed.

**Reading the syntax.** `[a|b]` means "optional, one of these literal words". `<x>` means "you supply a value". A command with no bracket section takes no arguments; anything typed after it is ignored.

---

## Command index

### Session and workspace

| # | Command | What it does | TUI only |
|---|---|---|---|
| 1 | `/gentle:panel` | Opens the whole sidebar (todos, jobs, agents, changes, review, integrations) as a full-width sheet | yes |
| 2 | `/gentle:changes` | Browses uncommitted changes — working tree vs `HEAD`, untracked included — across the session's repo and its subagents' worktrees | yes |
| 3 | `/gentle:images` | Lists the on-disk paths of images pasted in the current draft | no |
| 4 | `/gentle:commands` | Opens the command palette: a curated, searchable, grouped menu of Gentle commands (`alt+k`) | yes |
| 5 | `/gentle:agents` | Inspects this session's subagents and, with `a`, the open orchestrators in this profile | yes |
| 6 | `/gentle:jobs` | Lists background jobs, running first, with command, status and output tail | yes |
| 7 | `/gentle:usage` | Shows subscription usage windows for the connected providers (`alt+u`) | yes |
| 8 | `/gentle:scratch` | Lists or cleans this session's scratch directory and the clones/worktrees recorded by it | no |

### Permissions and review

| # | Command | What it does | TUI only |
|---|---|---|---|
| 9 | `/gentle:mode` | Sets permission strictness (`normal`, `auto`, `yolo`, `super-yolo`), plus a saved default for new sessions | session-bound |
| 10 | `/gentle:yolo` | Toggles the standing YOLO permission for this exact session and workspace | session-bound |
| 11 | `/gentle:rdd` | Opens the interactive RDD selector for this repository or an explicitly named machine-wide change | yes |
| 12 | `/gentle:review-mode` | Shows or sets the clone-scoped receipt-driven development kill switch (`status\|enable\|disable`) | no |
| 13 | `/gentle:review-session-permission` | Shows or revokes the process-memory review grant for this exact Pi session and Git repository | TUI required to grant |
| 14 | `/gentle:background-subagents` | Shows or sets the managed background-subagents policy and names the source that decided it | menu needs UI |

### Models and persona

| # | Command | What it does | TUI only |
|---|---|---|---|
| 15 | `/gentle:profiles` | Models screen plus profile file operations: `export`, `import`, `publish`, routing export/restore, `clear` | yes |
| 16 | `/gentle:persona` | Switches the assistant persona between `gentleman` and `neutral` | yes |

### Appearance and input

| # | Command | What it does | TUI only |
|---|---|---|---|
| 17 | `/gentle:customize` | One overlay for appearance, task-summary publishing, audio, Vim, RDD, session permissions, Auto/YOLO defaults, layout, cards, keymaps and history | yes |
| 18 | `/gentle:animations` | Sets animation effort: `quality`, `performance` or `potato` | menu needs UI |
| 19 | `/gentle:vim` | Turns opt-in Vim prompt editing on or off | menu needs UI |
| 20 | `/gentle:double-esc-cancel` | Requires two quick `Esc` presses to cancel a running turn | no |
| 21 | `/gentle:banner` | Configures the startup banner: rose, text logo, color preset | yes |
| 22 | `/gentle:banner-color` | Picks the startup banner color preset (`pink`, `cyan`, `yellow`, `green`) | select needs UI |
| 23 | `/gentle:toggle-rose` | Flips the startup banner rose | no |
| 24 | `/gentle:toggle-text-logo` | Flips the startup banner text logo | no |

### Diagnostics and maintenance

| # | Command | What it does | TUI only |
|---|---|---|---|
| 25 | `/gentle:status` | Reports package assets, persona, delegation/review staleness, ODD state, saved routing and any dev-binary override | no |
| 26 | `/gentle:doctor` | Runs read-only diagnostics for assets, config, tools, guards, skill registry, memory tools and Herdr | no |
| 27 | `/gentle:telemetry` | Shows or changes the local telemetry trigger (`status\|enable\|disable\|preview`) | no |
| 28 | `/gentle:status-timing` | Arms, clears or shows session-only STATUS timing (`enable\|disable\|show`); never invokes STATUS | no |
| 29 | `/gentle:dev-binary` | Registers, inspects or clears a persistent unpinned dev-binary override for Gentle AI | no |
| 30 | `/gentle:install-delegation` | Installs missing global delegation agents and helpers; `--force` refreshes managed copies | no |
| 31 | `/gentle:install-review` | Installs missing global review agents and chains; `--force` refreshes managed copies | no |

### Feature commands

| # | Command | What it does | TUI only |
|---|---|---|---|
| 32 | `/gentle:design` | Writes HTML artboards under `design/<slug>/` and serves them on a local canvas | partly |
| 33 | `/gentle:guide` | Runs the guided tour of Gentle Shell, agent-driven or self-stepped | yes |
| 34 | `/gentle:music` | Plays focus music in a full-screen player, or controls playback with one word | yes |
| 35 | `/gentle:stats` | Local usage stats: activity heatmap, tokens, cost, models and this session | yes |
| 36 | `/gentle:voice` | Local Parakeet dictation that pastes the transcript into the draft and never sends it | yes |

Of these 36, the [command palette](#4-gentlecommands) lists 21 (`/gentle:panel`, `/gentle:images`, `/gentle:rdd`, `/gentle:music`, `/gentle:stats`, `/gentle:scratch`, `/gentle:mode`, the banner group, the installers and `/gentle:status-timing` are reachable only by typing them).

---

## Details

### Session and workspace

#### 1. `/gentle:panel`

- **Purpose.** See every sidebar section at once, on one full-width sheet.
- **Syntax.** `/gentle:panel` — no arguments; anything typed after it is ignored.
- **No-argument behavior.** Opens the sheet immediately. No menu, no selector.
- **What it does.**
  - Opens a top-center full-width sheet showing the todos, jobs, agents, changes, review and integrations sections together.
  - Keys: `escape` or `q` close, `down`/`j` and `up`/`k` scroll, the mouse wheel scrolls, left-clicking the back affordance closes.
  - Persists nothing; your draft stays visible below the sheet.
- **Errors/warnings.** None.
- **Source.** `extensions/gentle-shell.ts:2372`.

#### 2. `/gentle:changes`

- **Purpose.** Browse this session's uncommitted Git changes, including untracked files.
- **Syntax.** `/gentle:changes` — no arguments.
- **No-argument behavior.** Refreshes the tracker first. A clean tree notifies instead of opening; otherwise the overlay opens.
- **What it does.**
  - Fullscreen overlay over the session repository and its subagents' worktrees.
  - Keys: `j`/`down` and `k`/`up` move between files, `ctrl+j`/`ctrl+k` scroll the preview, `o` or `enter` opens the file in `$EDITOR`, `r` refreshes, `F` toggles diff-only, `q`/`esc` closes.
  - Persists nothing.
- **Errors/warnings.**
  - `No uncommitted changes in this session's repository or its subagents' worktrees.`
  - `Git status failed for <n> roots; their changes are not listed.`
- **Source.** `extensions/gentle-shell.ts:3046`. Shortcut: `alt+g`.

#### 3. `/gentle:images`

- **Purpose.** Find where the images you pasted into the draft live on disk, so you can hand their paths to a tool or a prompt.
- **Syntax.** `/gentle:images` — no arguments.
- **No-argument behavior.** Lists the cached paths, one notification per image, as `<token> <path>`.
- **What it does.**
  - Requires the session image cache: without `GENTLE_PI_IMAGES_DISK_CACHE=session` the command explains how to enable it instead of listing anything.
  - Only images referenced by the current draft are listed; an empty result is reported, not treated as an error.
- **Errors/warnings.**
  - `Image disk cache is off. Set GENTLE_PI_IMAGES_DISK_CACHE=session to enable it.`
  - `No pasted images are cached in this draft.`
- **Source.** `extensions/gentle-shell.ts:3031`.

#### 4. `/gentle:commands`

- **Purpose.** Find and run any Gentle command from one searchable menu.
- **Syntax.** `/gentle:commands` — no arguments.
- **No-argument behavior.** Opens the palette; with nothing registered it notifies instead.
- **What it does.**
  - Centered overlay with curated groups — Configuration, Session, Diagnostics, Skills. Only registered commands appear, each with its live description.
  - Keys: type to search, `up`/`down` or `ctrl+k`/`ctrl+j` move, `enter` runs the selection as `/name`, `tab` captures the next key you press as that item's shortcut (`escape` cancels capture), `backspace`/`ctrl+u` edit the query, `escape`/`ctrl+c` closes.
  - Persists nothing itself, except that a `tab` binding writes `keymaps.json` under the Gentle config home.
- **Errors/warnings.** `No Gentle commands are registered.`
- **Source.** `extensions/gentle-shell.ts:3057`; catalog in `lib/command-palette-catalog.ts`. Shortcut: `alt+k`.

#### 5. `/gentle:agents`

- **Purpose.** Inspect this session's subagents — and the open orchestrators in this profile.
- **Syntax.** `/gentle:agents` — no arguments.
- **No-argument behavior.** Opens the Agents overlay: task list on the left, selected thread on the right.
- **What it does.**
  - Keys: `j`/`k` move between tasks, `ctrl+j`/`ctrl+k` scroll the thread, `f` follows, `o` or `enter` opens a local task's transcript in `$EDITOR`, `a` toggles between this session and all sessions, `s`/`c` stops the selected task, `tab` shows details in narrow mode, `esc` backs out, `q` closes.
  - Peer threads are presentation-only: they never enter the local task store and cannot be cancelled or opened.
  - Persists nothing.
- **Errors/warnings.** `No editor configured. Set $VISUAL or $EDITOR.`
- **Source.** `extensions/gentle-agents.ts:3175`; view in `lib/agents-view.ts`.

#### 6. `/gentle:jobs`

- **Purpose.** Show this session's background jobs with their output tail.
- **Syntax.** `/gentle:jobs` — no arguments.
- **No-argument behavior.** Opens the overlay: running jobs first, newest first inside each group.
- **What it does.**
  - Left column: job glyph, label and elapsed time. Right pane: command, status, output file path and tail.
  - Keys: `j`/`k` or `up`/`down` move, `tab` or `enter` toggles details, `s` stops the selected running job, `esc` backs out or closes, `q` closes.
  - Stopping a job finishes its monitors and queues the exit notice.
- **Errors/warnings.** `The jobs overlay requires TUI mode.`
- **Source.** `extensions/gentle-agents.ts:3144`; view in `lib/jobs-view.ts`.

#### 7. `/gentle:usage`

- **Purpose.** Check subscription usage windows for the connected providers.
- **Syntax.** `/gentle:usage` — no arguments.
- **No-argument behavior.** Opens the overlay immediately: it draws stored values and refreshes underneath.
- **What it does.**
  - Centered overlay titled `✿ Subscriptions`, one row per provider window, with scope and failure notes.
  - Keys: `r` refetches, `escape` or `q` closes. The footer shows `r refresh` and `esc close`.
  - Persists nothing.
- **Errors/warnings.** None.
- **Source.** `extensions/gentle-shell.ts:2398`. Shortcut: `alt+u`.

#### 8. `/gentle:scratch`

- **Purpose.** List or clean this session's scratch directory and the clones and worktrees recorded by it.
- **Syntax.** `/gentle:scratch [list|clean]` — no argument means `list`.
- **No-argument behavior.** `list`.
- **What it does.**
  - `list` reports this session's scratch directory and size, plus scratch from ended sessions and every recorded clone and worktree.
  - `clean` empties this session's scratch, then — after a single confirmation that names what will go and warns that ignored files inside those directories are deleted too — removes recorded worktrees and clones with no uncommitted changes and no unpushed commits.
  - Kept on purpose: protected paths, live subagent directories, other live sessions' scratch, entries touched within the minute before the command started (a running command may be using them), and clones that still have linked worktrees.
  - Worktrees go with `git worktree remove` then prune; clones are deleted recursively at the recorded path only, refused if the path is now a symlink or is no longer the recorded Git root.
  - Without a UI, `clean` removes scratch only and reports the artifacts it did not touch.
- **Errors/warnings.** `Usage: /gentle:scratch [list|clean]`
- **Source.** `extensions/session-scratch.ts:369`.

### Permissions and review

#### 9. `/gentle:mode`

- **Purpose.** Change permission strictness — for this session, or as the saved default for future ones.
- **Syntax.** `/gentle:mode [normal|auto|yolo|super-yolo|status]` and `/gentle:mode default [normal|auto|yolo|super-yolo]`
- **No-argument behavior.** `status`: reports `Permissions: … — default: …`.
- **What it does.**
  - `normal` is the safest default; `auto` adds separate model checks before tool use; `yolo` grants standing permission for ordinary implementation and delivery work while destructive confirmations remain; `super-yolo` asks no permission prompts at all while private paths stay blocked.
  - The live value is bound to this session *and* its canonical workspace, and expires when the session, the working directory or the interactive state changes. It never leaks into a new session.
  - `default …` persists the choice to `permission-mode.json`, which is what new primary sessions start from.
  - Private and sensitive paths stay blocked at every level.
- **Errors/warnings.**
  - `Use /gentle:mode normal|auto|yolo|super-yolo|status or /gentle:mode default normal|auto|yolo|super-yolo. State unchanged.`
  - `Mode unchanged — interactive primary session required or the session changed.`
- **Source.** `lib/yolo-session-policy.ts:354`.

#### 10. `/gentle:yolo`

- **Purpose.** Toggle standing permission for ordinary work in this exact session.
- **Syntax.** `/gentle:yolo [enable|disable|status]`
- **No-argument behavior.** With an interactive selector it opens the menu `🚀 Gentle YOLO 🔥 — standing permission (current: ON|OFF)` with `enable`, `disable`, `status`; without one it behaves as `status`.
- **What it does.**
  - `enable` selects the session-scoped `yolo` mode for the live primary TUI plus its workspace identity; `disable` returns to `normal`; `status` reports.
  - `status` prints `🚀 YOLO ON 🔥 — destructive confirmations remain` or `YOLO OFF`.
  - Same session/workspace expiry as `/gentle:mode`. Destructive confirmations remain even when ON.
  - Persists nothing globally: this is a live-session toggle, not a default.
- **Errors/warnings.**
  - `Use /gentle:yolo enable|disable|status. State unchanged.`
  - `YOLO OFF — activation requires an interactive primary TUI session and an identifiable workspace.`
  - `YOLO unchanged — the session changed while the menu was open.`
- **Source.** `lib/yolo-session-policy.ts:372`.

#### 11. `/gentle:rdd`

- **Purpose.** Choose how receipt-driven development is enforced, through one interactive selector.
- **Syntax.** `/gentle:rdd` — no arguments.
- **No-argument behavior.** Opens the RDD selector: it shows the effective mode and the source that decided it, then offers a repository change or an explicitly named machine-wide change.
- **What it does.**
  - Cancelling changes nothing — both the mode and its source stay as they were.
  - Repository enable only clears a clone-local off; it cannot override a machine-wide off. Machine-wide enable does not clear a clone-local off either.
  - Changing RDD grants no review consent and changes no permission mode: it decides *whether review runs*, never *what may be executed*.
  - `/gentle:review-mode` keeps its clone-scoped `status|enable|disable` behavior; `/gentle:rdd` is the wider control.
- **Errors/warnings.** `Use /gentle:rdd without arguments to open the interactive selector. RDD unchanged.`
- **Source.** `extensions/gentle-ai.ts:13207`.

#### 12. `/gentle:review-mode`

- **Purpose.** Show or set the clone-scoped receipt-driven development kill switch.
- **Syntax.** `/gentle:review-mode [status|enable|disable]`
- **No-argument behavior.** `status`, printing `receipt-driven development: … (decided by …)`.
- **What it does.**
  - Calls the native `gentle-ai review mode <op>` against the current clone scope.
  - `disable` clears pending consents; `enable` only clears a clone-local override.
  - Every sub-action is user-initiated: no automation toggles it.
- **Errors/warnings.**
  - `Unknown /gentle:review-mode sub-action "…". Use status, disable, or enable.`
  - `That did not turn reviews back on: /gentle:review-mode enable only clears a clone-local override, which cannot override a global off. Run \`gentle-ai review mode enable --scope=global\` to turn them back on.`
  - `Gentle AI review mode is not available with the currently negotiated native version.`
- **Source.** `extensions/gentle-ai.ts:13218`.

#### 13. `/gentle:review-session-permission`

- **Purpose.** Show or revoke this session's standing review permission.
- **Syntax.** `/gentle:review-session-permission [status|revoke]`
- **No-argument behavior.** `status`.
- **What it does.**
  - `status` checks the process-memory grant for this exact Pi session ID plus the canonical Git worktree.
  - `revoke` clears it so the next review asks again — without changing provider review mode or review authority.
  - The grant lives in process memory only: it dies with the session and is never written to disk.
- **Errors/warnings.**
  - `Unknown /gentle:review-session-permission sub-action "…". Use status or revoke.`
  - `Review session permission is unavailable: it requires the interactive Pi TUI, a non-child session, a nonempty session ID, and a canonical Git worktree.`
  - `Reviews are allowed for this Pi session and Git repository. Use /gentle:review-session-permission revoke to ask again.`
  - `Review permission revoked for this Git repository in this Pi session. Provider review mode and authority were not changed.`
- **Source.** `extensions/gentle-ai.ts:13045`.

#### 14. `/gentle:background-subagents`

- **Purpose.** Show or set whether background subagents may launch.
- **Syntax.** `/gentle:background-subagents [status|enable|disable]`
- **No-argument behavior.** With a selector it opens the menu `Background subagents policy` (`status`, `enable`, `disable`); otherwise `status`.
- **What it does.**
  - `enable` writes `on`, `disable` writes `off` to the global policy file.
  - Reports the effective policy, the source that decided it, and the `subagent_run` capability.
  - Resolution order: project file, then global file, then `GENTLE_PI_BACKGROUND_SUBAGENTS`, then the built-in default `off`.
  - The policy only decides how `subagent_run` is called; a single-shot mode such as `pi -p` cannot receive a background result and keeps task mode regardless.
- **Errors/warnings.** `Unknown /gentle:background-subagents sub-action "…". Use status, enable, or disable.`
- **Source.** `extensions/gentle-ai.ts:13311`.

### Models and persona

#### 15. `/gentle:profiles`

- **Purpose.** Manage saved model profiles and routing from one screen.
- **Syntax.** `/gentle:profiles [export <name>|import|publish <name>|export-routing|restore-routing|clear]`
- **No-argument behavior.** Opens the models screen on the pinned or active profile.
- **What it does.**
  - `export <name>` writes the profile to `profiles.export.json`; `import` reads it back and asks before overwriting a profile with the same name.
  - `publish <name>` toggles the committed repository declaration at `<worktree-root>/.pi/gentle-ai/profile.json`; run it again to remove the declaration.
  - `export-routing` and `restore-routing` move the saved global `models.json` through `models.export.json`, asking first.
  - `clear` ends this session's profile selection so it resumes on the startup state.
  - Persists to `profiles.json`, `models.json` and the repository pin file.
- **Errors/warnings.**
  - `Usage: /gentle:profiles [export <name> | import | publish <name> | export-routing | restore-routing | clear]`
  - `No profile named "…".`
- **Source.** `extensions/gentle-ai.ts:12936`.

#### 16. `/gentle:persona`

- **Purpose.** Switch the assistant's persona between `gentleman` and `neutral`.
- **Syntax.** `/gentle:persona` — no arguments.
- **No-argument behavior.** Always opens the selector `el Gentleman persona (current: …)` with `gentleman` and `neutral`.
- **What it does.**
  - Writes the choice to the global `persona.json`, and to `.pi/gentle-ai/persona.json` when that project file already exists.
  - Notifies `el Gentleman persona set to: …`. Injected prompts change on the next `/reload`.
- **Errors/warnings.** None.
- **Source.** `extensions/gentle-ai.ts:12943`.

### Appearance and input

#### 17. `/gentle:customize`

- **Purpose.** Change appearance, audio, Vim, RDD, session permissions, Auto/YOLO defaults and history behavior from one menu.
- **Syntax.** `/gentle:customize` — no arguments; they are ignored.
- **No-argument behavior.** Opens the customization overlay.
- **What it does.**
  - Centered overlay with rows for animations, banner, themes, editor, history, notifications, layout, cards, sections, keymaps, task-summary publishing, RDD and profiles.
  - Keys: `up`/`k` and `down`/`j` move, `left`/`right` adjust or preview, `tab` switches panes, `enter`/`space` applies, `escape` closes, `p` opens the profiles/audio preview.
  - Browsing previews without applying, except where a row says otherwise. The RDD row shows the state read when the card opened: applying it closes Customize and opens the `/gentle:rdd` selector, while merely highlighting it changes nothing.
  - Persists per row into the Gentle config home (`animations.json`, `vim.json`, `keymaps.json`, plus the visual/banner/history/profile stores); theme changes are saved by Pi itself.
- **Errors/warnings.** `Customization requires an interactive terminal.`
- **Source.** `extensions/gentle-shell.ts:3113`.

#### 18. `/gentle:animations`

- **Purpose.** Change how much the prompt and startup banner animate.
- **Syntax.** `/gentle:animations [status|quality|performance|potato]`
- **No-argument behavior.** With a selector it opens `Gentle animations (current: …)` with `quality`, `performance`, `potato`, `status`; cancelling changes nothing. Without a selector it reports status.
- **What it does.**
  - `quality`, `performance` and `potato` write that mode; `status` only reports the effective mode and its deciding source.
  - Applies to the prompt immediately; banner motion changes at the next startup.
  - Persists to `animations.json` under the Gentle config home.
- **Errors/warnings.** `Use /gentle:animations status|quality|performance|potato.`
- **Source.** `extensions/gentle-shell.ts:3609`.

#### 19. `/gentle:vim`

- **Purpose.** Turn the prompt's opt-in Vim-style editing on or off.
- **Syntax.** `/gentle:vim [status|enable|disable]`
- **No-argument behavior.** With a selector it opens `Gentle Vim (current: …)` with `enable`, `disable`, `status`; cancelling changes nothing, and without a selector it reports status.
- **What it does.**
  - `enable` writes `on`, `disable` writes `off`; `status` reports the effective policy, its deciding source and whether the live prompt differs.
  - Applies to the running prompt immediately.
  - Persists to `vim.json` under the Gentle config home.
- **Errors/warnings.** `Use /gentle:vim status|enable|disable.`
- **Source.** `extensions/gentle-shell.ts:3585`.

#### 20. `/gentle:double-esc-cancel`

- **Purpose.** Require two quick `Esc` presses to cancel a running turn, so one stray key does not kill it.
- **Syntax.** `/gentle:double-esc-cancel [status|enable|disable]`
- **No-argument behavior.** Toggles the current policy: `on` becomes `disable`, `off` becomes `enable`, and the new value is written and reported.
- **What it does.**
  - `status` reports policy, deciding source and write state without writing; `enable` writes `on`; `disable` writes `off`.
  - Resolution order: global file, then `GENTLE_PI_DOUBLE_ESC_CANCEL`, then the built-in default `off`.
  - Updates the in-memory Esc gate immediately.
  - Persists to `double-esc-cancel.json` under the Gentle config home; reports `double-esc-cancel: <policy> (decided by <source>)` plus `Wrote <value> to the global file <path>.` when it wrote.
- **Errors/warnings.** `Unknown /gentle:double-esc-cancel sub-action "…". Use status, enable, or disable.`
- **Source.** `extensions/gentle-shell.ts:3643`.

#### 21. `/gentle:banner`

- **Purpose.** Configure the startup banner interactively.
- **Syntax.** `/gentle:banner` — no arguments.
- **No-argument behavior.** Opens the select `Startup banner` with the rose toggle, the text-logo toggle and the color row; picking a toggle flips it, picking color opens a second select.
- **What it does.**
  - Reads the config tolerantly (a malformed file falls back to defaults) and writes it back.
  - Notifies `Startup banner: rose=on|off, text logo=on|off, color=…`, the config path, and `Changes apply on the next startup banner render.`
  - Persists to `banner.json`.
- **Errors/warnings.** None.
- **Source.** `extensions/startup-banner.ts:667`.

#### 22. `/gentle:banner-color`

- **Purpose.** Set the startup banner color preset.
- **Syntax.** `/gentle:banner-color [pink|cyan|yellow|green]`
- **No-argument behavior.** Opens the select `Startup banner color` with the four presets.
- **What it does.**
  - With a valid color it applies it directly; with an invalid one it falls back to the select instead of erroring.
  - Writes `banner.json` and notifies the same banner summary. Cancelling returns silently.
- **Errors/warnings.** None (invalid input opens the selector).
- **Source.** `extensions/startup-banner.ts:670`.

#### 23. `/gentle:toggle-rose`

- **Purpose.** Flip the startup banner rose on or off.
- **Syntax.** `/gentle:toggle-rose` — no arguments.
- **No-argument behavior.** Flips `showRose`, writes the config, notifies the banner summary.
- **What it does.** One-key toggle for the same setting `/gentle:banner` exposes; applies at the next startup render.
- **Errors/warnings.** None.
- **Source.** `extensions/startup-banner.ts:668`.

#### 24. `/gentle:toggle-text-logo`

- **Purpose.** Flip the startup banner text logo on or off.
- **Syntax.** `/gentle:toggle-text-logo` — no arguments.
- **No-argument behavior.** Flips `showTextLogo`, writes the config, notifies the banner summary.
- **What it does.** One-key toggle for the same setting `/gentle:banner` exposes; applies at the next startup render.
- **Errors/warnings.** None.
- **Source.** `extensions/startup-banner.ts:669`.

### Diagnostics and maintenance

#### 25. `/gentle:status`

- **Purpose.** Show package and routing health for this project.
- **Syntax.** `/gentle:status` — no arguments; they are ignored.
- **No-argument behavior.** Prints the status report.
- **What it does.**
  - Reports `el Gentleman package is active.`, the active persona, staleness of the global delegation and review assets, whether ODD is active, the global config, the saved routing state, and the dev-binary line when an override is live.
  - Read-only: it never repairs anything. Use `/gentle:install-delegation` or `/gentle:install-review` for that.
- **Errors/warnings.** None.
- **Source.** `extensions/gentle-ai.ts:13339`.

#### 26. `/gentle:doctor`

- **Purpose.** Run read-only health checks for this workspace.
- **Syntax.** `/gentle:doctor` — no arguments; they are ignored.
- **No-argument behavior.** Prints the `el Gentleman doctor` checklist.
- **What it does.**
  - Checks delegation and review asset staleness, the skill registry at `.atl/skill-registry.md`, the model config, the sensitive-path guard, memory tools, any dev-binary override and the Herdr hint.
  - Strictly read-only: it writes nothing.
- **Errors/warnings.** None.
- **Source.** `extensions/gentle-ai.ts:13010`.

#### 27. `/gentle:telemetry`

- **Purpose.** Check or change local telemetry collection.
- **Syntax.** `/gentle:telemetry [status|enable|disable|preview]`
- **No-argument behavior.** `status`, relaying the native `gentle-ai telemetry status --json`.
- **What it does.**
  - Runs the native `gentle-ai telemetry <op> --json` in the foreground and relays the pretty JSON.
  - `disable` reports `Gentle AI telemetry disabled.`
  - The Gentle AI runtime owns the collected data and the opt-out itself.
- **Errors/warnings.**
  - `Unknown /gentle:telemetry sub-action "…". Use status, enable, disable, or preview.`
  - `gentle-ai telemetry … failed (exit …): …`
- **Source.** `extensions/gentle-ai.ts:13261`.

#### 28. `/gentle:status-timing`

- **Purpose.** Time the next *separately authorized* STATUS call without ever rerunning it.
- **Syntax.** `/gentle:status-timing [enable|disable|show]`
- **No-argument behavior.** `show`: prints the last JSON summary, or the armed/off state.
- **What it does.**
  - `enable` arms session-only, memory-only timing that the next authorized STATUS-bearing tool call consumes; calls that never reach STATUS leave it armed.
  - `disable` clears the arm and the in-memory observations; `show` prints the completed summary.
  - It never invokes, retries, replays or authorizes STATUS — the diagnostic only observes.
  - Session replacement, tree navigation, shutdown and reload clear the diagnostic and require a fresh opt-in.
- **Errors/warnings.**
  - `Unknown /gentle:status-timing sub-action. Use enable, disable, or show.`
  - `STATUS timing armed for the next separately authorized STATUS-bearing tool call. No STATUS is invoked or retried. Use /gentle:status-timing show to consult the completed summary.`
  - `STATUS timing disabled; in-memory observations cleared.`
- **Source.** `extensions/gentle-ai.ts:13069`; observer in `lib/status-timing-diagnostics.ts`.

#### 29. `/gentle:dev-binary`

- **Purpose.** Test an unpinned development build of Gentle AI instead of the pinned binary.
- **Syntax.** `/gentle:dev-binary [status|off|<absolute path>]`
- **No-argument behavior.** Same as `status`: reports the active override with version and digest, or that there is none.
- **What it does.**
  - `<absolute path>` is validated — absolute, a regular file, not a symlink, executable — then written as a persistent registration in `dev-binary.json`.
  - `off` deletes the registration and restores the pinned binary.
  - The `GENTLE_PI_GENTLE_AI_DEV_BINARY` environment variable outranks the file.
  - Field-test only: it is a development affordance, not a supported configuration.
- **Errors/warnings.**
  - `Gentle AI dev binary registration removed; the pinned binary is active again.`
  - `No dev binary registration to remove.`
  - `No dev binary override; the pinned Gentle AI binary is active.`
  - Typed validation errors such as `must name an absolute path…`, `which does not exist`, `which is not a POSIX executable`.
- **Source.** `extensions/gentle-ai.ts:12985`.

#### 30. `/gentle:install-delegation`

- **Purpose.** Install missing global delegation agents and their helpers.
- **Syntax.** `/gentle:install-delegation [--force]`
- **No-argument behavior.** Installs only what is missing and reports the counts.
- **What it does.**
  - Owns the `delegation` asset set: global `agents/`, `chains/` and the `gentle-ai/support/` helpers it ships.
  - `--force` refreshes managed copies instead of only filling gaps.
  - A separate command from `/gentle:install-review`; each touches only its own asset set.
- **Errors/warnings.** None.
- **Source.** `extensions/gentle-ai.ts:12923` (registered once per asset owner).
- **Related.** Startup installs and refreshes the same assets; `/gentle:status` and `/gentle:doctor` are how you notice they are missing or stale.

#### 31. `/gentle:install-review`

- **Purpose.** Install missing global review agents and chains.
- **Syntax.** `/gentle:install-review [--force]`
- **No-argument behavior.** Installs only what is missing and reports the counts.
- **What it does.**
  - Owns the `review` asset set: the review agents and their chains.
  - `--force` refreshes managed copies instead of only filling gaps.
  - A separate command from `/gentle:install-delegation`.
- **Errors/warnings.** None.
- **Source.** `extensions/gentle-ai.ts:12923` (registered once per asset owner).

### Feature commands

#### 32. `/gentle:design`

- **Purpose.** Write self-contained HTML artboards under `design/<slug>/` and show them on a local canvas.
- **Syntax.** `/gentle:design <brief>`, `/gentle:design open [slug]`, `/gentle:design stop`, `/gentle:design sync`, `/gentle:design implement <slug>/<artboard>`
- **No-argument behavior.** If a design or a system board exists it opens the most recent one (or the system board); otherwise it prints the usage line.
- **What it does.**
  - `<brief>` — any other text — runs the design skill as a user message.
  - `open [slug]` serves `design/` on a loopback canvas and opens or refreshes the browser tab; `stop` closes the server.
  - `sync` runs the design-system sync, writing `design/system.md` and `design/system.html`.
  - `implement <slug>/<artboard>` validates the manifest, sends the handoff message and records it in `handoffs.json` as sent/chosen.
- **Errors/warnings.**
  - `Usage: /gentle:design <brief>…`
  - `/gentle:design sync takes no arguments.`
  - `No designs in design/ yet.`
  - `No design "…" in design/.`
  - `No artboard "…" in design/<slug>/design.json.`
  - `Name the artboard to implement as <slug>/<artboard>.`
- **Source.** `extensions/gentle-design.ts:119`; argument parsing in `lib/gentle-design.ts`.

#### 33. `/gentle:guide`

- **Purpose.** Take a guided tour of what Gentle Shell can do.
- **Syntax.** `/gentle:guide`, `/gentle:guide local`, `/gentle:guide stop`
- **No-argument behavior.** With a model available it asks the agent to start the tour (`Starting the guided tour with the agent…`), one step per turn; without a model it runs the local tour.
- **What it does.**
  - Agent mode drives the `gentle_guide` tool (`start`, `next`, `previous`, `show`, `end`) and explains each step beside the region it describes.
  - `local` steps through the popover yourself with the arrow keys.
  - `stop` ends the tour; the popover reopens beside a new region when placement changes.
- **Errors/warnings.**
  - `Usage: /gentle:guide [local|stop]`
  - `The guided tour requires an interactive terminal.`
  - `No guided tour is running.`
  - `Guided tour ended.`
  - `Tour finished. Run /gentle:guide any time to see it again.`
- **Source.** `extensions/gentle-guide.ts:114`.

#### 34. `/gentle:music`

- **Purpose.** Play focus music full-screen through `gentle-stream` without leaving Pi.
- **Syntax.** `/gentle:music`, `/gentle:music [mood text]`, `/gentle:music next|pause|play|stop|status`
- **No-argument behavior.** Hands the terminal to `gentle-stream` with the configured model and mood.
- **What it does.**
  - Full-screen player: `b` returns to Pi with the music still playing, `q` stops it.
  - A single control word (`next`, `pause`, `play`, `stop`, `status`) runs the control path instead, captured — it never takes over the terminal.
  - When the bundled shell has no player it offers the install (uv, Python 3.13, a ~150 MB player); otherwise it prints a manual hint.
- **Errors/warnings.**
  - `/gentle:music is not available on Windows yet: the gentle-stream player runs on macOS and Linux. It works when Gentle Shell runs inside WSL.`
  - `/gentle:music needs the interactive terminal.`
  - `/gentle:music needs gentle-stream, and neither gentle-stream nor uv is on PATH. Install uv (https://docs.astral.sh/uv/getting-started/installation/) and run /gentle:music again, or install gentle-stream with: uv tool install 'gentle-stream[samples] @ git+https://github.com/Gentleman-Programming/gentle-stream'`
- **Source.** `extensions/gentle-music.ts:331`.

#### 35. `/gentle:stats`

- **Purpose.** Show local Pi usage stats: activity, tokens, cost, models and this session.
- **Syntax.** `/gentle:stats` — no arguments; they are ignored.
- **No-argument behavior.** Opens the full-terminal overlay.
- **What it does.**
  - Three tabs — Overview (heatmap), Models, Session. Keys `1`/`2`/`3` or `tab` switch view, arrows and `shift+tab` move.
  - `r` cycles the range All / 7 days / 30 days; `s` toggles scope All projects / This project; `q` or `esc` closes.
  - The footer shows `tab view`, `r range`, `s scope`, `q close`.
- **Errors/warnings.**
  - `The stats overlay requires TUI mode.`
  - `Could not read local sessions: …`
  - `No usage recorded yet…`
- **Source.** `extensions/gentle-stats.ts:86`; view in `lib/stats-view.ts`.

#### 36. `/gentle:voice`

- **Purpose.** Local dictation that pastes the transcript into your draft — it is never sent.
- **Syntax.** `/gentle:voice` — no arguments; they are ignored.
- **No-argument behavior.** Opens the selector `Voice dictation · ready|not installed` with Start dictation, Download (~MB), Enable/Disable push-to-talk, and Show status and notices.
- **What it does.**
  - After explicit confirmation it downloads the pinned runtime (`sherpa-onnx`, `node-cpal` from the npm registry) and the Parakeet TDT 0.6B v3 int8 model from Hugging Face, then checks the pinned size and digest.
  - The dictation overlay records and inserts the text into the draft; `Esc` cancels.
  - Push-to-talk is a persisted toggle: hold `Space` to dictate, release to insert; the first hold lazily checks the install.
  - Truncation at the 2-minute limit is announced in the overlay.
- **Errors/warnings.**
  - `Voice dictation is not available in delegated sessions.`
  - `Voice dictation requires TUI mode.`
  - `Voice dictation is already running. Finish or cancel it first.`
  - `Recording reached the 2-minute limit…`
  - `Run /gentle:voice and download it again.`
- **Source.** `lib/voice-command.ts:562`.

---

## Not commands

These strings look like commands and are not: they exist in the source as state keys or event names and never reach `registerCommand`.

| String | What it actually is | Where |
|---|---|---|
| `gentle:activity` | `--source` metadata value for the activity stream | `lib/herdr-activity.ts` |
| `gentle:auto-usage` | status-bar key set by the auto-permission runtime | `lib/auto-permission-runtime.ts` |
| `gentle:runtime-metrics` | internal event name (`gentle:runtime-metrics:child/v1`) | `lib/runtime-metrics-children.ts` |

Two commands exist outside this namespace: `/skill-registry:refresh`, which regenerates `.atl/skill-registry.md`, and `/skill-creation`, which creates or updates a skill using the packaged skill-creator contract.
