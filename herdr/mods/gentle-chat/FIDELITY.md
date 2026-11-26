# gentle-chat: fidelity to design/herdr-desktop/01-inspector.html (T5, S8)

The centre column of the chosen artboard (A · Inspector, region 4: `4a` header, `4b` log, `4c`
composer) as built by `main.js` + `ui.js` + `tokens.js`. "l.N" is the line in
`design/herdr-desktop/01-inspector.html`.

## How this was checked

- Artboard: headless Chrome at 1600×1100 (`--headless=new --screenshot`), centre column cropped
  at its measured box. Measured with `getBoundingClientRect` in the same render (CSS px):

  | Box | Size |
  |---|---|
  | `.views` (the chat card, with its 1px border) | 950 × 912 |
  | `.chat-head` | 948 × 76 (row 1 30, row 2 26) |
  | `.log` | 948 × 728 |
  | `.composer` | 948 × 107 |
  | `.field` | 780 × 60 |
  | `.seg` (Chat \| Terminal) | 161 × 30 |
  | `.perm > summary` | 84 × 26 |
  | `.send` | 75 × 32 |
  | `.ask`, `.sub`, `.tool` | 724 wide (780 lane − 2 × 28) |

- Mod: `herdr-app check herdr/mods/gentle-chat` (the real mod, empty state) and, in a scratch
  copy outside the repo, a fixture subclass fed the artboard's demo session (user message,
  thinking, 2 reads + 1 grep, markdown, an edit with a patch, bash, a `subagent_run`, the
  snapshot with model/context/cost/permission/question) through `herdr-app check --print-spec`,
  once with the live theme and once with `palette({})` to print the artboard hexes. Every value
  below was read back from that spec. A second fixture checked the answered question
  (pressed option, others at 0.55, "Answer sent: 2. The agent continues."), the Super-YOLO pill
  (`#e0c27a` text, `#e0c27a99` border, `#e0c27a14` fill) and the empty context ("—").
- Live side-by-side: see "Live side-by-side" at the end (the person's window, 1908×1019).

## Colours

`tokens.js` reads a Herdr theme role when the token has one and the layout sets it, else the
hex. `LAYOUT_COLORS` is the layout root `"colors"` that makes the roles equal these values (T6).

| Token | Value | Role | Source |
|---|---|---|---|
| background (card surface: root, question options, composer field) | `#060407` | background | `--canvas` l.15 on `.views` l.258, `.ask-opt` l.164, `.field` l.177 |
| canvas (behind the cards; not drawn by the chat) | `#060407` | canvas | l.15 |
| chrome (header, composer) | `#100A0F` | chrome | l.16, `.chat-head` l.259, `.composer` l.175 |
| surface (tool, diff, subagent, question cards) | `#20161e` | surface | l.17, l.135, l.155, l.161 |
| raised (menu, ctx groove, hunk header) | `#241822` | raised | l.18, l.89, l.107, l.151 |
| user (bubble) | `#2A1523` | — | l.19, l.121 |
| selected (pressed seg, hovers, answered option) | `#28121E` | selected / hover | l.20, l.98, l.109, l.137, l.169 |
| line (header/composer rules, tool cards, options) | `#2A1720` | border | l.21 |
| lineStrong (seg, perm pill, bubble, sub, ask, kbd, field) | `#563040` | input | l.22 |
| text | `#f6eff3` | foreground | l.23 |
| muted | `#a78e9b` | muted | l.24 |
| faint (crumb separators) | `#76616b` | dim | l.25, l.264 |
| accent (send, ask edge, eyebrow, role, checked) | `#f095c8` | accent | l.26 |
| accentSoft (option numbers, button hover) | `#ffb1dd` | — | l.27, l.166 |
| ok (✓, +N, added rows) | `#b4e7c7` | done | l.28 |
| warn (YOLO pill) | `#e0c27a` | blocked | l.29, l.106 |
| err (✕, −N, deleted rows, Super-YOLO, Stop hover) | `#ff718f` | — | l.30 |
| info (ctx fill, Running) | `#a9c7ee` | working | l.31 |
| onAccent (Send label) | `#1a1218` | — | l.183 |
| btnLine (`.btn` border) | `#ffffff17` | — | l.92 |
| YOLO pill border / fill | warn `99` / warn `14` | — | l.106 |
| added / deleted row fill | ok `14` / err `14` | — | l.152-153 |

## Type

| Element | Size / weight / line | Source |
|---|---|---|
| Root | 13px, line 1.5, sans | `body` l.38 |
| Sans | first installed of Inter, SF Pro Text, SF Pro, `.SystemUIFont` | `--sans` l.32 |
| Mono | first installed of IosevkaTerm NF, Iosevka Term, JetBrains Mono, SF Mono, Menlo | `--mono` l.33 |
| Session title | 14px semibold | `.who h1` l.262, l.371 |
| Crumbs, facts, seg, perm pill | 12px | l.263, l.265, l.97, l.104 |
| Numbers (ctx %, cost, +N/−N, sub cost) | mono | `.num` l.50 |
| Perm menu label / about | 13px semibold / 12px muted | l.110 |
| Bubble | 14px, line 1.55 | l.121 |
| User meta "You · 14:02" | 11.5px muted | l.122 |
| Reply markdown | 14px, line 1.6 | `.md` l.124 |
| Thinking summary / body | 12.5px italic muted / 13px muted | l.132, l.134 |
| Tool summary / args | 12.5px; name semibold; args mono 12px muted | l.136-139 |
| Tool body | mono 12px, line 1.55 | l.141-142 |
| Tool group summary | 12.5px muted | l.143 |
| Hunk | mono 12px, line 1.6 | l.147 |
| Diff foot | 12px muted | l.154 |
| Subagent title / role / facts / last | 13px semibold / mono 11px accent upper / 12px muted / mono 12px muted | l.156-159 |
| Question eyebrow | mono semibold 11px, line 1.4, accent, upper | l.100, l.455 |
| Question | 14.5px semibold | l.162 |
| Option label / about / number / badge | 13.5px semibold / 12.5px muted / mono semibold 12px accentSoft line 1 / mono semibold 10.5px accent line 1 | l.166-168 |
| Question foot | 12px muted | l.170 |
| Composer text | 14px, line 1.5 | l.179 |
| Send | 13px semibold | l.183 |
| Hints / kbd | 11.5px muted / mono 11px muted | l.184, l.47 |
| State label | 12px | l.79 |

## Sizes, spacing, radii

| Element | Values | Source |
|---|---|---|
| Card corners | root 9 (inside the layout block's 1px border at radius 10); header top 9, composer bottom 9 | `.views` l.258 |
| Header | padding 8 / 14 / 7, gap 4 between rows, 1px bottom rule; rows: space-between, gap 16; row 1 min 30 | l.259-260 |
| Seg | padding 2, gap 2, 1px border, radius 8; buttons 3 / 10 with icon 13 + gap 6, radius 6; pressed: selected fill + 1px lineStrong ring (drawn as a border, padding 2 / 9 so the size stays 24) | l.96-98 |
| Crumbs | gap 6, margin-top 1, icons 13 | l.263 |
| Facts row | gap 14; each fact padding 3 / 4, radius 6, gap 6 | l.265-266 |
| Ctx bar | 46 × 4, pill | l.89, l.269 |
| Perm pill | padding 3 / 9, pill, 1px border, gap 6, icons 13 | l.104 |
| Perm menu | 330 wide, padding 6, radius 12, 6 below the pill, right-aligned; items padding 7 / 8, radius 6, 18px check column, gap 8 / 2 | l.107-108 |
| Log | padding 18 top, 22 bottom; lanes max 780 with 28 sides, centred; gap 14 | l.115-116 |
| Show earlier | padding 3 / 10, radius 6, 12px muted | l.118 |
| User message | right, max 82%, gap 4; bubble padding 9 / 13, radius 12, 1px lineStrong | l.120-121 |
| Reply | blocks gap 10 | l.123 |
| Thinking body | margin 6 top, 6 left, 12 left padding, 2px lineStrong rule | l.134 |
| Tool card | 1px line, radius 8; summary padding 7 / 10, gap 8; body padding 8 / 10 / 10 under a 1px rule | l.135-141 |
| Tool group | summary gap 8, padding 2 / 0; cards gap 6, 8 below | l.143-145 |
| Diff | body padding 0; hunk padding 4 / 0; columns 40 (right, 8 padding) / 16 / rest, 10 right; foot padding 6 / 10, gap 8 | l.146-154 |
| Buttons | padding 5 / 10, radius 8, gap 6 | l.92 |
| Subagent card | 1px lineStrong, radius 12, padding 10 / 12, gap 4 / 12; title gap 8; facts gap 12; actions gap 6; last line 6 top padding, 2 top margin, 1px line rule | l.155-160 |
| Question card | radius 12, 1px lineStrong, 3px accent left edge, padding 12 / 14, gap 8; options gap 6, 2 above | l.161-163 |
| Option | min 44 tall, padding 8 / 10, radius 8, 1px line; number column 26 with a 22 × 22 box, radius 6; gap 10 / 1; badge 8 left | l.164-168 |
| Answered | pressed: accent border + selected fill; others opacity 0.55 | l.169, l.171 |
| Composer | padding 10 / 16 / 12, 1px top rule; inner max 780 centred | l.175-176 |
| Field | padding 8 / 8 / 8 / 12, 1px lineStrong (accent while typing), radius 12, bottom-aligned, gap 8 | l.177-178 |
| Attach | 32 × 32, radius 8, icon 15 | l.181 |
| Textarea | 42 tall (2 rows) | l.179 |
| Send | 32 tall, padding 0 / 12, radius 8, gap 6, icon 13 | l.183 |
| Hints | 6 above, gap 14; kbd padding 0 / 5, radius 5; "Esc Esc stops the agent" pushed right | l.184, l.501 |
| State dot | 7px (pulse 1.6 s, 0.35 ↔ 1, native `loop`); idle/queue ring 8px with a 1.5 border (pseudo-element, outside `* {box-sizing}`), queue dashed | l.79-88 |
| Icons | the artboard's symbols (`icons/*.svg`, stroke 1.75), 13 (`.i.s`) or 15 (`.i`) | l.43-44, l.289-319 |

## States and content

- Header data is the T4 snapshot (`docs/desktop-feed.md`): `identity.sessionName`, `project`
  (cwd basename, branch, dirty), `model` (id shortened `claude-opus-5-5` → "Opus 5.5", effort,
  profile name), `persona`, `context`, `cost.total`, `permission`. Without a snapshot the session
  JSONL gives the name, model, thinking level and summed cost.
- Empty fields never say "null": no persona → "No persona" (muted); no context → empty bar and
  "—"; no model → "—"; no permission → "—"; no branch → the branch crumb is left out;
  `dirty: 0` → "clean"; no project → "No project".
- Thinking: "Thought for Ns" from the reply's write time minus its start (the whole message,
  not only the thinking); "Thinking…" while the newest reply is still streaming.
- Tool group: two or more consecutive `read` / `grep` / `find` / `glob` / `ls` calls become
  "✓ Explored · 2 reads, 1 search  0.9s" (the artboard's "the spike" is model prose we do not
  have). Read and search cards add "· N lines" / "· N matches"; bash adds its last output line
  and the time.
- Diff card: an `edit` whose result carries `details.patch`; open by default; "+N −M" from the
  patch; one hunk at a time, "Next hunk" cycles; 80 rows per hunk, then "… N more lines".
- Subagent card: a `subagent_run` call; live state, step, model and spend from the snapshot's
  `agents.items` matched by the run's `taskId`, else the run's own result. Role = the agent
  name without `gentle-ai-`. No elapsed time or todo count (the snapshot has neither yet).
- Question card: `pendingQuestion` from the snapshot; "(Recommended)" in a label becomes the
  badge; `custom` adds "Something else…"; keys 1–N while the composer does not have the
  keyboard; a questionnaire shows its first question and "· 1 OF N".

## Differences Herdr cannot draw (or that wait for another task)

| Artboard | Here | Why |
|---|---|---|
| `letter-spacing: .1em` / `.08em` on eyebrows, role and badge | none | GPUI has no letter spacing |
| `text-transform: uppercase` | the string is upper-cased in code | same look |
| `font-variant-numeric: tabular-nums` | the mono font's own figures | no font features |
| Chevron rotates 90° in 0.15 s | the chevron swaps to the down chevron | no rotate transform |
| Pressed seg `box-shadow: inset 0 0 0 1px` | a 1px border, 1px less padding | no inset shadow; same box |
| Question card `border-left: 3px accent` with 1px on the other sides | accent fill behind a 3px left inset; the card has top/right/bottom borders | one border colour per element |
| Perm menu `box-shadow: 0 12px 28px #00000080` | `shadow_lg` | preset shadows only |
| `.md code` accent-soft on raised, `.md strong` colour, list indent 22 | Herdr's markdown styles from the theme | `TextView.markdown` uses theme colours (spike constraint) |
| Thinking body text muted | the muted colour is set on the block; markdown may keep the theme foreground | same |
| Textarea placeholder colour muted | the Textarea's own placeholder colour | not styleable from a script |
| Hunk rows `white-space: pre` with ellipsis | one-line truncated text | GPUI truncates with an ellipsis; leading spaces kept |
| `:focus-visible` outline | none | keyboard focus is shown by the field border only |
| Model / Persona open the models and persona screens | type `/gentle:profiles` (the TUI's models screen) or `/gentle:persona` into the terminal and show it; refused while a question is open | there is no `/gentle:models`; `/gentle:profiles` is the models screen |
| Permission items switch mode | a desktop action through the session's permission owner (as desktop RPC `set_permission_mode`); Super-YOLO first asks in a Herdr dialog; a refusal shows under the composer | — |
| View / Stop on a subagent card | View types `/gentle:agents`; Stop is a desktop action through the subagents owner (as `cancel_subagent`) | — |
| Open in Changes | marks the file in the inspector's Changes tab (shared value `gentle-inspector.reveal`) | — |
| Attach image | presses Ctrl+V in the terminal: pi pastes the clipboard image (or files) into its draft, sent with the next message | no file picker for files in Herdr 0.1.15 (only `pickFolder`) |
| "Esc Esc" hint | text only, as in the artboard | — |
| Clicking an option answers it | the session checks the toolCallId is the open question and names the keys its real list takes (the lists ignore digits: ups to the top, downs, Enter); the view presses them with `hc keys`. "Something else…" sends the typed text after the list opens its editor. Multi-question and multi-select questions, prompts and consent: "Open Terminal" | consent is never answered from the desktop |
| Fonts on the reference machine | Inter is not installed, so the artboard renders in the system font; the mod picks the same stack | `fonts()` decides at run time. Under `herdr-app check` it returns an empty list, so the check prints the stacks' last entries (`.SystemUIFont`, `Menlo`); IosevkaTerm NF is installed here, so the window should pick it: confirm in the live shot |

## Live side-by-side (1908×1019, S8)

Method: the artboard rendered by headless Chrome at the window's logical size
(`--force-device-scale-factor=2 --window-size=1908,1019`, a scratch copy whose CSS hides the page
caption and gives `.window` 1908×1019 with no page border) against `herdr-app shot` of the
person's window (2×). Pixels sampled with PIL along fixed rows and columns at the same logical
coordinates. Real data: t5 (this worktree, empty session) and t6 (a 2.2 MB copy of a real
session resumed with `--session /tmp/…`, 52 entries: 19 user messages, 66 thinking blocks, 98
tools, 10 `subagent_run`, 2 edits with patches). Scrolled-back states (diff card, subagent card)
were seen through a temporary install of this mod that cut the log at an entry, then the real
mod was installed again.

Measured equal (logical px, live = artboard): card frame 261…1519 and 528…1252 lanes; header
51…126 with its 1px rule at 126; composer rule 876, field 887…947, hints kbd 954…969.5 ±0.5,
composer bottom 982; tool card 34.5 tall, x 528…1252; subagent card x 528…1252, border
`#563040`; diff hunk header row 19 px on `#241822`, rows 19 px, added `#2c262b`, deleted
`#311d27`; bubble 1 + 9 + 21.7 + 9 + 1; every background (`#060407` log, card gaps and
inspector gap; `#100a0f` header, composer, inspector, sidebar, status).

Differences found, and what happened to each:

1. Fixed: the log was not at the newest entry (scroll_to_item reveals with the least scroll and
   ran before the markdown settled). Now a 1px sentinel after the last row is the target, asked
   again while the last row changes height; scrolling up unpins it; "Show earlier" unpins it.
2. Fixed: a session file outside the home folder was not read at all (Herdr grants mods read
   access to the home folder only: "outside every granted read root"). `readAfter` falls back
   to one `sh` (`wc -c` + `tail -c +N | head -c`, the path as a positional argument) through
   `exec`, still incremental by byte offset. The 2.2 MB copy showed within ~2 s of the mod
   loading. Without `sh` (native Windows, #3352) such a file stays unread.
3. Fixed: the crumb named the folder (`herdr-gentle-shell`); it names the project, the Herdr
   space (`gentle-pi`), as the artboard; the folder is the fallback.
4. Fixed: with no session name the title fell back to "Gentle Shell"; it now uses the
   terminal title without pi's `π - ` prefix (same rule as the tabs and agents list).
5. Fixed: tool and diff paths were absolute; they are relative to the session's project or one
   of its worktrees (`herdr/mods/gentle-chat/main.js`), else `~/…`.
6. Fixed: a finished subagent card showed View / Stop; only a running, waiting or queued one has
   them (the inspector's rule, l.213).
7. Fixed: kbd boxes were 18.5 / 17 px tall; 15.5 (11px content area 13.5 + borders), which also
   brought the composer from 107.5 to the artboard's 106.
8. Fixed: empty state. The artboard has none; it is now a centred block in the log (the mark in
   `--faint`, 14px semibold line, 12.5px muted line), not text pinned to the top-left.
9. Fixed (not seen live: the window was not resized): narrow header. The facts row drops
   Persona, then Ctx, then Model, then Cost when the header is narrower than their estimated
   width plus 180px for the crumbs; the permission menu always stays. Narrow composer: the
   hints row drops Esc Esc, ⌘J, / and ⇧ Enter in that order (Enter send stays); the field keeps
   the artboard's structure.
10. Data / content, not a defect: the artboard's demo content (title, "Opus 5.5 · high ·
    balanced", "Gentleman", 38 %, $3.42, Auto) differs from the live sessions'; the formats
    match ("Opus 5.5 · medium · claude (session)", "No persona", "26%", "$5.78", Super-YOLO pill).
11. Herdr limitation (unchanged): markdown inline code, lists and strong use Herdr's markdown
    styles (`TextView.markdown`), not `.md code` accent-soft on raised; no letter spacing; no
    chevron rotation; Textarea placeholder colour.
12. Not in the artboard: per-message cost (the artboard's replies carry none; the header's Cost
    is the session total) and subagent output notes (`custom_message`), drawn as a note with a
    2px accent edge.
13. Not seen live: the question card (no session had an open question; `ask_user_question` in
    t6's history is a finished tool card), a running subagent (all ten in t6 are finished), the
    Thinking… / spinner states, the Terminal side of the switch, the permission menu open.
    They were checked with the fixture spec above.
14. 1px residual: the subagent card is 62.5 px without its last-step line where the CSS gives
    63.5 (title row 19.5 + facts 18 + paddings).

## T10 parity additions (S9)

The artboard draws these controls closed or not at all; each is built from its own pieces and
keeps the closed state 1:1 (the composer at rest is unchanged: field 887…947, Send, the five
hints).

- **Stop** (not drawn; l.501 only promises "Esc Esc stops the agent"). While the agent works and
  the draft is empty, the Send slot shows Stop: the same 32px height, 12px padding and radius 8
  as Send, in the `.btn.danger` look (l.92-95: 1px `--line-strong`, hover `--err`) with the
  `i-stop` symbol (l.308) in `--err`, 13px semibold. Typing brings Send back (the message is
  queued, as in the terminal). It sends `abort_turn` (docs/desktop-feed.md), the TUI's Esc Esc.
- **Esc Esc**: the first Esc while the agent works shows "Press Esc again to stop the agent."
  under the composer for one second (the TUI's double-Esc window); the second stops it. Idle,
  Esc does nothing here.
- **`/` menu** (not drawn; l.501 promises "/ commands"). Opens above the field while the draft is
  one `/word`: the `.perm-menu` surface (l.107-111: `--raised`, 1px `--line-strong`, radius 12,
  6px padding, shadow), rows 7px 8px radius 6 with the `--selected` fill on the chosen row and
  on hover; `/name` mono 12.5px semibold (`--accent-soft` when chosen), the argument in
  `--faint` mono, the description 12px muted, the `i-term` mark when the result is a TUI
  screen; a hints row (kbd ↑↓ move, Enter run, Tab complete, "n of m"). At most 8 rows show,
  around the chosen one. Its bottom sits 6px above the field.
- Seen live (t11, an empty test session in /tmp/gs-spike.GAB6): `/gentle:st` opened the menu
  (three matches), ↓ + Tab completed `/gentle:status `, Enter sent it and the Terminal showed its
  report; Esc closed the menu and kept the draft. **Not seen live**: Stop and Esc Esc while the
  agent works — a working turn needs a model prompt, which this pass does not send; the
  session's side is covered by tests/desktop-feed-actions.test.ts and the idle refusal was seen
  live ("The agent is not working").
- Herdr behaviour found live: an ambient call (`run`, `props`, `setShared`) made right after an
  await on `hc` or a file read is ignored; the views now show the Terminal from a timer callback
  (`later()` in main.js; the inspector the same). A hidden stack child stays alive but gets no
  key commands, so palette requests reach the chat through a consume-once shared value it looks
  at every 500 ms while shown.

## T12: the minimal view (S11, MINIMAL.md)

The artboard draws the log with the thinking, the tool group and the tool cards closed and the
diff card open (l.411-446). The minimal view keeps every closed look as drawn and starts the
diff, the subagent, notes, compaction, branch summaries and skill blocks closed too, each as a
row in the closed `.tool` look. Nothing new is invented: every row is a `.tool > summary`.

| Row | Look | Source |
|---|---|---|
| Every compact row | 1px `--line`, `--surface`, radius 8; summary padding 7 / 10, gap 8, 12.5px; hover `--selected`; chevron 13 at the right (down when open) | `.tool` l.135-140 |
| Tool | ✓ `--ok` / ✕ `--err` / spinner `--info`; name semibold; argument mono 12px `--muted`, truncated; note `--muted` (a failure's last line in `--err`, at most 300px); duration | l.136-140, l.440 |
| Tool group, thinking | unchanged (`.tool-group` l.143-145, `.think` l.132) | — |
| Diff (closed) | the artboard's open card's summary: ✓, `edit`, path, `+N` `--ok` mono, `−M` `--err` mono, chevron | l.433 |
| Subagent (closed) | role mono 11px `--accent` upper-cased (`.sub .role` l.157), task 12.5px `--text`, the `.state` dot and label 12px (l.79-88), model 12px `--muted`, spend mono 12px `--muted` | l.155-158 in the `.tool` row |
| Subagent (open) | the artboard's `.sub` card unchanged; its title row carries the down chevron (`--muted`) and closes it; the answer below a 1px `--line` rule, 13px | l.155-160 |
| Note / compaction / branch / skill (closed) | leading 13px mark (chat icon `--accent`; ⊟, ⑂ `--muted`; ✦ `--accent`), name semibold, first line mono 12px `--muted` | `.tool` l.136-139 |
| Their body (open) | `.tool-body`: 1px top `--line`, padding 8 / 10 / 10, markdown 13px | l.141 |
| "⌘O expand all" / "collapse all" | the composer hints' look: kbd (mono 11px, 1px `--line-strong`, radius 5, padding 0 / 5) + 11.5px `--muted`, gap 3; hover `--text`; right side, before "Esc Esc stops the agent" | l.184, l.47 |

Composer hints on narrow cards now drop in this order: Esc Esc (< 700), ⌘J (< 540), / (< 450),
⇧ Enter (< 360); Enter send and ⌘O stay. At the artboard's 780 lane every hint shows.

Checked:

- `herdr-app check --print-spec` of a scratch fixture (outside the repo) fed a compaction, a
  skill invocation, a two-block thinking run, 2 reads + 1 grep, markdown, an edit with a patch,
  a passing and a failing bash, a `subagent_run`, a two-paragraph custom message and a last
  reply. Minimal: every item is one `summaryRow` with the values above (`cmp-c1`,
  `skill-u0-skill`, `th-a1-0` "Thought for 14s" as one run, `grp-a1-2` "Explored · 2 reads, 1
  search", `diff-a1-6` +2 −1, `tool-a1-7`, `tool-a1-8` with "AssertionError: expected 3 to
  equal 4 · 2.1s" in `--err`, `sub-a1-9` WRITER · Done · Sonnet 5.5, `note-n1`); the last
  reply and the user bubble whole; no row body built. Expand all: every body is built
  (`cm-c1`, `sk-u0-skill`, `tht-a1-0`, the group's three cards, "Hunk 1 of 1" + Next hunk,
  the `.sub` card with "› bash herdr-app check" and its answer `sr-a1-9`, `n-n1`), 13 down
  chevrons, and the hint reads "collapse all".
- Live (the person's window, 945 × 1007 logical, real sessions, read-only: selected with
  `gentle-status.session-next/prev`, toggled with `gentle-chat.expand-all` /
  `collapse-all`; no prompt, key or click sent): the working session showed its thinking runs
  as "Thought for …" rows and a `read` as one `.tool` row with "⌘O expand all" in the hints;
  after `expand-all` its tool bodies were open and the hint read "⌘O collapse all";
  `collapse-all` brought the rows back. `herdr-app status` errors `[]` throughout.

Differences:

1. Not in the artboard: the ⌘O hint (S11 asks for the toggle), and the closed diff and
   subagent states (the artboard draws them open).
2. Herdr limitation (as before): the chevron swaps glyph instead of rotating.
3. Not seen live: a closed diff, subagent, compaction or skill row in a real session — the
   log is pinned to the newest entry and the live sessions' newest entries were long replies;
   they were checked with the fixture spec above.
