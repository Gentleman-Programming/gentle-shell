# T6 fidelity: everything around the centre column

Reference: `design/herdr-desktop/01-inspector.html` (direction A, S7/S8). Line numbers below are
lines of that file. Scope: sidebar (1a-1d), session tabs (2), inspector (5, 5a-5f), status bar (6)
and the layout. The centre column (4, `gentle-chat`) is T5.

## Method

1. Headless render: Chrome `--headless=new --force-device-scale-factor=1 --window-size=1600,1060
   --screenshot` of the artboard, once per inspector tab (`#changes` … `#session`, a scratch copy
   with a script that clicks the tab). The `.window` (1600×1000) starts at page y 53.5, so the
   window crop is `y = 53…1053`. Crops: window, sidebar, brand, projects, agents, usage, tabs,
   status, and the inspector for each of the six tabs (scratch folder, not committed).
2. Measurements: the same scratch copy, run with `--dump-dom`, writes `getBoundingClientRect()`
   and the computed font, colour, padding, gap, radius and border of every region's selectors,
   relative to the `.window` box. All px values below come from it.
3. Mods: `herdr-app check <mod> --print-spec` on every folder, and the same mods in a scratch
   harness that swaps the `herdr` module for a stub carrying artboard data (the T5 question
   session: 7 changes, todo 3/6, three subagents, three jobs, review ready, 18 turns), a
   snapshot with every nullable section null, and no snapshot at all. Every run passes, and the
   printed specs carry the values below.
4. The live side-by-side: see "Live side-by-side" at the end.

Artboard frame: `.window` has a 1px `--line-strong` border (l.58) that belongs to the page, not to
the app (the macOS window has no such border). Inside it the app is 1598×998, so the artboard
coordinates below are given relative to the inner edge (x − 1, y − 1). In a 1600×1000 Herdr
window the two flexible regions (the views stack and the agents list) take the extra 2 px.

## Layout (`herdr/layouts/gentle-shell.json`)

| Region | Artboard (measured) | Layout node |
|---|---|---|
| Sidebar | `.sidebar` 252 incl. 1px right border, bg `--chrome` (l.225) | `column sidebar` `px 251` + root `divider 1 border` = 252; `background chrome`, `resizable false` |
| 1a Brand | `.brand` h 46 (l.226) | `block brand` `px 46`, `window_drag`, `gentle-sidebar {part: brand}` |
| traffic lights | `.lights` left 14, top 17 (l.227) | root `traffic_lights [14, 17]` |
| 1b Projects | `.sb-sec` 200.25 for 3 spaces: pad 10 + header 38 + 3 × 48.75 + pad 6 (l.231-233) | `block spaces` `px 200.25`; `gentle-spaces` resizes it to its rows (`layout.resize`, up to 6 rows, then it scrolls) |
| 1c Agents | `.sb-sec` takes the rest (l.231) | `block agents` `weight 1`, `gentle-agents` |
| 1d Plan usage | `.sb-foot` 111.15: border 1 + pad 10 + 15.4 + 3 × (7 + 17.25) + pad 12 (l.244) | `block sidebar-footer` `px 111`, `gentle-sidebar {part: usage}` (the legend's "92 px" is not what the artboard renders) |
| 2 Tabs | `.tabs` h 42 incl. 1px bottom border (l.251) | `block tabs` `px 42`, `window_drag`, `gentle-tabs` |
| 3 Work body | `.body` padding 8, gap 8 (l.257) | `row work-body` `padding 8`, `gap 8` |
| 4 Views | `.views` flex 1, border 1 `--line`, radius 10, bg `--canvas` (l.258) | `stack views` unchanged (chat block over the `main` terminal block, T5's) |
| 5 Inspector | `.inspector` w 372, border 1 `--line`, radius 10, bg `--chrome` (l.271) | `column panel` `px 372`, `min 280`, `max 900`, `radius 10`, `border 1 border`, `background chrome` → `block inspector` `gentle-inspector` |
| 6 Status | `.status` h 28 incl. 1px top border (l.281) | `block status` `px 28`, `gentle-status` |

The old `panel-body` stack (Herdr's `files` / `changes` mods, hidden) is gone: the inspector is
always shown, as in the artboard, and `gentle-tabs` has no Files/Changes toggles. `"header":
"tabs"` is not used on any stack (Herdr 0.1.15 rejects it, L7); the inspector draws its own strip.

## Colours

(S14: these values now live in `herdr/themes/gentle-shell-dark.json` `colors`, chosen by the layout
root `"theme": { "light": "gentle-shell-light", "dark": "gentle-shell-dark" }`; the resolved roles
are the same. See `FIDELITY-light.md`.) The layout root `colors` sets the Herdr theme roles to the artboard values, so the mods read
`theme()` names; `gentle-tokens/tokens.js` `HEX` is the fallback and holds the colours with no
role. Values equal T5's `LAYOUT_COLORS` (`herdr/mods/gentle-chat/tokens.js`) role by role (checked
by script: 20/20 identical); the layout adds `idle` and `selection`.

| Token | Hex | Theme role (layout `colors`) | Artboard |
|---|---|---|---|
| canvas | `#060407` | `canvas` (behind the cards: window, work body, active tab) and `background` (inside the centre card: chat, terminal) | `--canvas` l.15 |
| chrome | `#100A0F` | `chrome` | `--chrome` l.16 |
| surface | `#20161e` | `surface` | `--surface` l.17 |
| raised | `#241822` | `raised`, `popover` | `--raised` l.18 |
| user | `#2A1523` | — (hex) | `--user` l.19 |
| selected | `#28121E` | `selected`, `hover` | `--selected` l.20 |
| line | `#2A1720` | `border` | `--line` l.21 |
| lineStrong | `#563040` | `input` | `--line-strong` l.22 |
| text | `#f6eff3` | `foreground` | `--text` l.23 |
| muted | `#a78e9b` | `muted`, `idle` | `--muted` l.24 |
| faint | `#76616b` | `dim` | `--faint` l.25 |
| accent | `#f095c8` | `accent`, `solid` | `--accent` l.26 |
| accentSoft | `#ffb1dd` | — (hex) | `--accent-soft` l.27 |
| ok | `#b4e7c7` | `done` | `--ok` l.28 |
| warn | `#e0c27a` | `blocked` | `--warn` l.29 |
| err | `#ff718f` | — (hex) | `--err` l.30 |
| info | `#a9c7ee` | `working` | `--info` l.31 |
| onAccent | `#1a1218` | `accent_foreground`, `solid_foreground` | `.btn.primary` l.94 |
| btnLine | `#ffffff17` | — (hex) | `.btn` border l.92 |
| selection | `#f095c84d` | `selection` | `::selection` l.42 |

Name map for T5: **`canvas`** is the surface behind the cards (root `background`, the work body,
the active session tab); **`background`** is the inside of the centre card (the chat block and
the terminal pane frame). Both are `#060407` (`--canvas`). `tokens()` exposes them as `canvas`
and `card`.

## Typography

| | Artboard | Mods |
|---|---|---|
| Sans | `--sans` Inter → SF Pro Text → system-ui (l.32); Inter is not installed on the reference machine, so the render is the system UI font | stack `Inter, SF Pro Text, SF Pro, .SystemUIFont`, first installed wins (same stacks as T5) → `.SystemUIFont` here |
| Mono | `--mono` "IosevkaTerm NF" (l.33), installed (family name read from the font's name table) | stack `IosevkaTerm NF, Iosevka Term, JetBrains Mono, SF Mono, Menlo` |
| Body | 13px/1.5 (l.38) | `text_size(13)`, explicit px line heights (`line_height("19.5px")`; a bare number is a multiplier, gpui-kit.d.ts l.1362) |

## Matched values by region

### 1a Brand (`gentle-sidebar`, part brand)
- Row 46 high, `padding 0 14px 0 78px`, gap 10, items centred (l.226); full screen: left 14.
- Mark: 26 px, `--accent`, the `i-mark` path (l.289) as `icons/mark.svg` (l.229).
- "Gentle Shell": 700 13px/19.5 `--text` (l.230).

### 1b Projects (`gentle-spaces`)
- Section padding 10 10 6 (l.231); header padding 0 6 6, eyebrow left, 32 px icon button right (l.232, `.icon-btn` l.181: 32×32, radius 8, muted, hover `--selected` + text).
- Eyebrow "PROJECTS": 600 11px/15.4 mono, uppercase, `--muted` (l.100).
- Row: 231 wide, 48.75 high (6 + 19.5 + 17.25 + 6), padding 6, gap 10, radius 6 (l.233); hover and current `--selected`; current: 2 px `--accent` left edge (l.235).
- Avatar: 22×22, radius 6, `--raised`, 700 10.5px mono, `--muted`; current `--accent-soft` (l.236-237). Two letters: "gentle-pi" → "gp".
- Name 13px/19.5 `--text`; second line 11.5px/17.25 `--muted` (l.239).
- Needs-you count: 600 11px mono `--warn` (l.240).
- Plus icon 13 px (`svg.i.s` l.44).

### 1c Agents (`gentle-agents`)
- Header: eyebrow "AGENTS" left, "Needs you first" 11.5px `--muted` right (l.344).
- Row: 48.75 high, padding 6, radius 6, title 13px/19.5 left, state right, gap 8, second line 11.5px `--muted` "app · space · address" (l.241-243); hover / focused `--selected`.
- Order: needs you, done, working, idle, then the latest change (Herdr `agents` priority sort); `setAgentOrder` keeps agent.next/prev in that order.
- State (l.79-87): 12px label, gap 6, 7 px dot; idle a 5 px ring with a 1.5 px border; working pulses opacity 1 → .35 every 1.6 s with the native `.loop` (no timer).

### 1d Plan usage (`gentle-sidebar`, part usage)
- `border-top 1 --line`, padding 10 16 12, gap 7, 12px (l.244).
- "PLAN USAGE · <plan>" eyebrow; rows 22 | 1fr | 36, gap 8 (l.245); label 11px mono `--muted` (l.246); bar 4 px pill on `--raised`, first window `--accent`, second `--muted` (l.89-90); value 11.5px mono right (l.247).
- Reset line 11.5px `--muted`, space-between, gear 13 px → `app.settings` (l.248, l.355).

### 2 Session tabs (`gentle-tabs`)
- Bar: `--chrome`, 1 px bottom `--line`, padding 0 10, gap 2, tabs on the bottom edge (l.251).
- Tab: 34 high, padding 0 12, gap 8, top radius 8, 12.5px, max 260, `--muted`, hover `--text` (l.252).
- Active: `--canvas` fill, `--text`, 2 px `--accent` top edge, 1 px `--line` sides (l.254).
- State dot as in 1c, the word as tooltip (the artboard puts it in a `.sr` span).
- Add: 32×32 icon button, margin 0 0 4 4 (l.256), plus 13 px; starts a `gentle-shell` tab.
- Measured: first tab x 262 (10 + inner), y 7, h 34; add button y 5…37.

### 5 Inspector (`gentle-inspector`)
- Strip: padding 6 6 0, gap 2, 1 px bottom `--line` (l.272); six tabs flex 1 (58 px each at 370 inner), column, gap 2, padding 6 2 7, top radius 6, 11px/16.5, 15 px icon, count 600 10.5px mono (l.273, l.276); total 66 high (6 + 59 + 1).
- Selected: `--text` and a 2 px `--accent` bottom edge (l.275); hover `--text` on `--selected` (l.274).
- Count colours: `--warn` (needs you), `--info` (running), else `--muted` (l.277).
- Panel: padding 14, scrolls (l.278); title 600 13px/19.5, margin-bottom 10, space-between (l.279).
- 5a Changes: `.pn` gap 10, 12.5px (l.191); summary "N files" 600 13px, `+N` `--ok` / `−N` `--err` mono, gap 10, baseline (l.192); note 12px `--muted` with the worktree in mono (l.194); rows 28 min, padding 5 6, gap 8, radius 6, hover `--selected` (l.196); status letter 16 wide, 600 11px mono, M `--warn`, A `--ok` (l.199); folder `--muted`, file `--text` (l.200); "Open diff viewer" `.btn` (l.92: padding 5 10, radius 8, 1 px `#ffffff17`, 12px `--muted`, hover `--accent` / `--accent-soft`).
- 5b Todo: "3 of 6" 600 13px + 4 px `--ok` bar, centred (l.192, l.89); items padding 4 6, gap 8, top aligned (l.201); tick 16, radius 4, 1.5 px `--line-strong` (l.202); done: `--ok` border and 13 px check, text `--muted` struck (l.203-204); current: `--warn` border and a 6 px radius-2 `--warn` square (l.205-206); second line 11.5px `--warn` (l.208).
- 5c Agents: title right "$0.49 spent" mono 400 `--muted`; cards padding 8, radius 8, 1 px `--line`, 6 apart (l.209-210); role 600 10.5px mono `--accent` uppercase (l.211); facts gap 10, 12px `--muted` (l.212); View / Stop (danger) buttons, margin-top 4, gap 6 (l.213), Stop with the 13 px stop icon.
- 5d Jobs: "RUNNING" / "FINISHED" subheads, margin 6 0 2, 600 11px mono (l.219); job padding 6, radius 6, gap 2 8 (l.214); label 12px mono `--text`, one line (l.215); facts state, elapsed `m:ss` mono, "N min ago" (l.216); Cancel (danger) on running, Output on failed.
- 5e Review: state box padding 10, gap 10, 1 px `--line`, radius 8, 15 px shield icon, label 600 13px, scope `--muted` (l.220-221); key/value rows gap 4 12, key `--muted`, value mono right (l.217-218); "Start review" `.btn.primary` (`--accent` fill, `#1a1218` 600, l.94) and "Skip for this change".
- 5f Session: key/value Turns, Tool calls, Duration, Cost, Subagent spend; "BY MODEL" subhead + "model · N turns" rows; "INTEGRATIONS" block 14 below (l.595).

### 6 Status (`gentle-status`)
- 28 high, padding 0 14, gap 18, 1 px top `--line`, `--chrome`, 12px `--muted` (l.281).
- "ODD" `--text` + phase 600 `--accent` (l.282); work state; needs-you state in `--warn`; "Jobs N running · M done" with mono numbers; spacer (l.283); `⌘K` kbd (1 px `--line-strong`, radius 5, 11px, l.47) + "Commands" → `app.palette`, the key read from `keys()` like Herdr's `workspace-status`.

## Differences Herdr cannot do (or the data does not carry)

Rendering (gpui-kit / Herdr 0.1.15):
1. `letter-spacing` (`.eyebrow` .1em l.100, `.ag .role` .08em l.211, brand −.01em l.230): no GPUI style; text is drawn without tracking, so eyebrows are a little narrower.
2. `text-decoration-color: var(--faint)` on done todos (l.204): `line_through()` takes the text colour (`--muted`).
3. `box-shadow` insets (current space l.235, active tab l.254, selected inspector tab l.275): drawn as 2 px absolute bars and 1 px side borders; same pixels, but the bar is a child, not a shadow.
4. `font-variant-numeric: tabular-nums` (`.num`): no GPUI style; IosevkaTerm is monospaced, so digits line up anyway.
5. `:focus-visible` outline (l.41) and the inspector's arrow-key tab moving (artboard script): not built (no focus handle on the strip).
6. Fractional section heights (48.75, 200.25, 111.15) are kept as fractional px; `sidebar-footer` is 111 (the artboard's 0.15 px goes to the agents list).
7. The sidebar width is `251 + 1 px divider`; if Herdr counts the divider inside `px`, set 252 (live check).

Data (the T4 snapshot has no field for it; shown as an empty state or left out, never invented):
8. Spaces' second line: the artboard says "$4.74 today"; the snapshot has live session spend, not a daily total: the row always says "<n> sessions · $<spend>" ("2 sessions · $5.78"), never the status word.
9. Subagents: no task title and `role` is always null (docs/desktop-feed.md): the card shows the agent name as the role tag and no bold title; no start time, so no "Running · 3m 12s" (shown: "Running · <step>").
10. Status bar TPS ("58 tok/s"): no TPS in the snapshot; shown only if a future snapshot carries `activity.tps`. The streaming item names the session, not the subagent ("writer streaming").
11. "ODD Build · T5 of 9": the snapshot has the ODD phase word (`implementing`, …) and the todo list, not the ODD task id: the bar says "ODD Implementing · todo 4 of 6".
12. Review: the RDD row shows `gentle-ai review mode status` ("on · global") and is the review switch; no lens count ("Reviewers 2 lenses").
13. Integrations and other statuses (Engram, MCP, "music paused", status bar "Engram · MCP 2/3"): `integrations` / `statuses` are always null today; the Session tab says "Engram and MCP status are not published by this session yet" and the status bar leaves the item out.
14. Jobs: a finished job's "Failed · 1 test" detail is not in the snapshot; it says "Failed · exit N".

Actions (T7, `actions.js`, docs/desktop-feed.md "Actions"): Stop subagent and Cancel job are desktop actions through the session's owners; Open diff viewer and change rows type `/gentle:changes`, View `/gentle:agents`, Output `/gentle:jobs` into the terminal and show it; Start review / Skip show the Terminal, where the review consent stays your answer; the RDD value runs `gentle-ai review mode enable|disable --cwd <project>` after a confirmation dialog.

## Token modules

- Canonical: `herdr/mods/gentle-tokens/tokens.js` (palette, fonts, `.state`, `.bar`, `.btn`, `.eyebrow`, `kbd`, formats) and `herdr/mods/gentle-tokens/snapshot.js` (snapshot reader over every agent dir in `agentRoots()`; `gentle-chat/session.js` imports `readFeeds` / `matchFeed` from its copy, `targetTerminal` mirrors `GentleChat.target()`).
- gpui-shell refuses imports outside a mod's folder (`Module ../b/x.js resolves outside the application directory`, observed with `herdr-app check`), so `gentle-sidebar`, `gentle-spaces`, `gentle-agents`, `gentle-tabs`, `gentle-inspector`, `gentle-status`, `gentle-palette` and `gentle-chat` carry byte-identical copies (`cmp` clean). `gentle-tokens` has a small `main.js` (a token swatch, `place: none`) so the folder is a valid mod.
- Each mod folder has a `.gitignore` for the `gpui-kit.d.ts` / `jsconfig.json` that `herdr-app check` writes.
- Data refresh: `watchFolder(<agentDir>/desktop/sessions)` for each agent dir plus a 10 s fallback timer; redraw only when a snapshot changed. Extra timers: the inspector redraws each second only while the Jobs tab shows a running job; the usage footer once a minute (its reset countdown).

## Live side-by-side (1908×1019, S8)

Same method as `herdr/mods/gentle-chat/FIDELITY.md` (headless artboard at 1908×1019 against
`herdr-app shot`, PIL samples at the same logical coordinates). Region edges measured equal:
sidebar 0…251 + 1px rule, work body padding 8 (card 261…1519, inspector 1528…1899), tab bar
0…41 + rule at 41, active tab 7…41 with its 2px accent at 7…9, inspector strip 51…116 + rule,
status 991…1019 with its rule at 991, avatar 22 px at x 16…38, spaces row 48.75 (±0.5 from the
fractional height). Colours equal at every sampled point.

Differences found, and what happened to each:

1. Not a mod bug: after `tab.new` + `pane.focus` the shot showed one tab and t5. `herdr-app
   shot` returns the last drawn frame, and the covered window was not drawing (three shots
   byte-identical across minutes and a mod reinstall). With the window in front, the strip
   listed both tabs and every mod followed the focused tab (t6).
2. Fixed: the + button sat at the far right of the bar; it follows the last tab (l.256).
3. Fixed: tabs and the agents list showed the terminal title `π - herdr-gentle-shell`; they show
   the session name, else the tab's given name, else the title without `π - `.
4. Fixed: Projects row "1 session · idle"; now sessions + live spend ("2 sessions · $5.78").
5. Fixed: Changes showed untracked files as `U +0 −0`. The publisher now counts their lines
   (`lib/desktop-feed-sources.ts` createUntrackedLineCounter: 1 MiB per file, 200 files per
   scan; binary / too large / unreadable / over budget = `added: null`), the letter is `A` in
   `--ok` as the artboard, and a file without counts shows none. Live: the running sessions
   loaded the old publisher, so t5 and t6 still publish `+0` until they restart (not restarted:
   they are the person's sessions).
6. Fixed: subagent role tag was the agent name (`GENTLE-AI-WORKER`); it is the role
   (`WORKER`, `EXPLORE`), as the chat card. Model names are shortened (`Opus 5.5`, not
   `claude-bridge/claude-opus-5-5`), in the Agents tab and the Session tab's By model.
7. Fixed: the current todo used `--info` while the session worked; the artboard's `.now` is
   always `--warn` (tick and second line, l.205-208).
8. Fixed: status bar "ODD — · todo 5 of 10" with no phase; now "ODD · todo 5 of 10" ("ODD —"
   only when there is nothing to say). The palette kbd was 17 px tall and 1 px high; 15.5 px at
   998.5…1014 like the artboard.
9. Data gap (unchanged): plan usage — the live sessions run `claude-bridge`, whose usage is
   `unavailable`, so the footer says "Plan usage unavailable" instead of the 5h / 7d bars.
10. Real binding, not a defect: the palette hint is `⌘⇧P`, read from the person's keys; the
    artboard shows `⌘K`.
11. Not seen live: Jobs (no session had jobs), Review (RDD off in both sessions), a running
    subagent, a needs-you state; Todo, Agents and Session were seen live on t6 through a
    temporary install that fixed the shown tab, then the real mod was installed again.

## T10 parity additions (S9)

- **Status bar "⌘K Commands"** (l.618): the hint reads the binding of `mod.open:gentle-palette`
  (herdr/keys.json binds ⌘K in `layout:gentle-shell`; unbound, it shows the artboard's ⌘K, which
  the chat binds while it has the keyboard). A click opens the Gentle palette instead of Herdr's.
  The bar also takes `gentle-status.toggle` (Chat ↔ Terminal) and `gentle-status.stop`
  (`abort_turn`; a refusal is a toast): it is always mounted, the chat is not (a hidden stack
  child gets no key commands). Seen live: toggle both ways, stop refused while idle.
- **Tab bar "+"**: starts `gentle-shell` in the shown space and its folder (`tab.new {argv, space,
  folder}`). Seen live: the same arguments started gentle-shell in the space's folder (t12,
  closed again); the click itself could not be synthesized (System Events clicks do not reach
  GPUI views).
- **gentle-palette** (new, `mods/gentle-palette`): the "⌘K Commands" palette the artboard
  promises (l.618, l.669-670) but does not draw. A top popup, 620 px wide, 64 px from the top:
  the `.perm-menu` surface (`--raised`, 6px padding), a search field in the `.field` look
  (38 px, radius 12, 1px `--accent`, `--canvas` fill, `i-search`, kbd Esc), `.eyebrow` group
  titles (Needs you in `--warn`, Session, View, Permission, Commands), rows 7px 8px radius 6
  with an 18px icon column, 13px semibold label (commands mono 12.5), 12px muted detail, a kbd
  or a faint mono source tag on the right; a 440 px list; a hints row. Seen live: filtering
  ("gentle:status", "/name"), running `/gentle:status` and `/gentle:changes` (Terminal shown with
  the result), `/name` from the Terminal (Chat shown, "/name " in the composer), Normal and
  Super-YOLO (Herdr's confirm dialog first), Esc. It carries byte-identical copies of tokens.js,
  snapshot.js and actions.js.
