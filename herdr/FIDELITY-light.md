# Gentle Shell Desktop — light theme (S14)

LuisSarmientoM (PR feedback): "Falta tema light". The window now follows the appearance Herdr
shows: the system's light or dark mode, or settings.json `appearance` (`"light"` / `"dark"`).
There is no light artboard: the light palette below is derived from `design/system.md` (the
Gentleman tokens: ink `--bg #1a1218`, rose `--accent`, the muted/faint ramp) and checked for WCAG
contrast. The dark appearance is the artboard, unchanged.

## How it switches (the choice)

Herdr's layout root `colors` apply in **both** appearances (Herdr's AGENTS.md, "The look"), so the
old root `colors` forced the dark palette everywhere. A layout cannot vary `colors` per appearance,
but its root `theme` can be a pair. So:

- `herdr/layouts/gentle-shell.json` root: `"theme": { "light": "gentle-shell-light", "dark":
  "gentle-shell-dark" }`, and no root `colors`.
- `herdr/themes/gentle-shell-dark.json`: Herdr's `graphite` palette (background, foreground,
  selection, the 16 ANSI colours: what the terminals showed before) plus, in its `colors`, exactly
  the former root `colors`. Herdr resolves a theme file's `colors` the same way as layout `colors`
  (herdr-app 0.1.15 `settings.rs`: `resolve(palette, theme colors + settings colors + layout
  colors)`), so every `theme()` role in dark is the value it was. Live check: a `herdr-app shot`
  before and after the change is pixel-identical (1890×2014) except the new "Add machine" row.
- `herdr/themes/gentle-shell-light.json`: the light palette and its terminal colours.
- The mods read roles through `theme()`; the colours with no Herdr role (user bubble, accent-soft,
  error, text on the accent, the button line) come from `tokens.js` `HEX` (dark) or `HEX_LIGHT`
  (`gentle-tokens/tokens.js`, byte-identical in nine mods) and `LIGHT` (`gentle-chat/tokens.js`),
  picked by `settings().dark`. A theme pick in Herdr's Settings still overrides the layout (Herdr's
  rule) and the mods follow its roles.
- `gentle-shell desktop` installs both theme files into `<herdr home>/themes/` (recorded in
  `state.json` as ours; a file of the same name that was not ours is kept in `originals` and put
  back by `--uninstall`).

Rejected: two layouts (`gentle-shell` / `gentle-shell-light`) do not follow the system and double
the layout to keep in sync; colours computed only in the mods leave Herdr-drawn parts (canvas,
borders, pane frames, terminals, dividers) dark.

## Palette

Contrast is WCAG 2.x against the surfaces text sits on (canvas = the window and the centre card,
chrome = sidebar, tab bar, inspector, status bar, selected = the highlighted row). AA for text is
4.5:1.

| Token | Theme role | Dark (artboard) | Light | Light contrast |
|---|---|---|---|---|
| canvas | `canvas`, `background` | `#060407` | `#fbf7f9` | — |
| chrome | `chrome` | `#100A0F` | `#f4ecf0` | — |
| surface | `surface` | `#20161e` | `#efe6eb` | — |
| raised | `raised` | `#241822` | `#eadfe5` | — |
| popover | `popover` | `#241822` | `#ffffff` | — |
| selected / hover | `selected`, `hover` | `#28121E` | `#f9e1ee` | — |
| user bubble | (none) | `#2A1523` | `#f8e6ef` | — |
| line | `border` | `#2A1720` | `#eadbe3` | — |
| line-strong | `input` | `#563040` | `#cdb3c1` | — |
| text | `foreground` | `#f6eff3` | `#1a1218` (the Gentleman ink) | 17.3 canvas · 15.8 chrome · 14.9 selected |
| muted | `muted`, `idle` | `#a78e9b` | `#5f4a56` | 7.6 · 7.0 · 6.6 |
| faint | `dim` | `#76616b` | `#86707c` | 4.3 · 3.9 · 3.7 (decorative only, as in dark: 3.6 · 3.4 · 3.1) |
| accent (neon rose) | `accent`, `solid` | `#f095c8` | `#be1d7d` | 5.4 · 4.9 · 4.7 |
| accent-soft | (none) | `#ffb1dd` | `#9c1867` | 7.2 · 6.6 · 6.2 |
| on accent | `accent_foreground`, `solid_foreground` | `#1a1218` | `#ffffff` | 5.7 on the accent |
| ok | `done` | `#b4e7c7` | `#1d6b43` | 6.1 · 5.6 · 5.3 |
| warn | `blocked` | `#e0c27a` | `#7f5300` | 6.3 · 5.8 · 5.4 |
| err | (none) | `#ff718f` | `#b3203f` | 6.2 · 5.7 · 5.3 |
| info | `working` | `#a9c7ee` | `#22589c` | 6.7 · 6.2 · 5.8 |
| button line | (none) | `#ffffff17` | `#1a12181f` | — |
| selection | `selection` | `#f095c84d` | `#be1d7d33` | — |

The accent keeps the artboard's hue (326°) and drops its lightness until rose text clears 4.5:1 on
canvas, chrome and selected (on `raised`, used for bars and avatars, not text, it is 4.4).
`tests/gentle-shell-desktop.test.ts` checks the theme files parse as Herdr theme files, that the
dark one equals graphite plus the former root `colors`, and that every light text role is ≥ 4.5:1
on canvas, chrome, selected, background and popover.

### Terminal colours (light)

Background `#fbf7f9`, foreground `#1a1218`, cursor `#be1d7d`, selection `#f3c9df`. ANSI: Herdr's
`paper` set (readable on white; bright white is ink) with magenta and bright magenta in the
Gentleman rose (`#be1d7d`, `#9c1867`). On `#fbf7f9` every colour but bright black (`#7b7e87`, 3.8),
bright green (4.3) and bright cyan (4.6) is ≥ 4.7:1, as in `paper`.

## Live check (herdr-app 0.1.16, macOS, 2026-11-15)

Appearance switched only through settings.json `"appearance": "light"` and then the original
file put back byte for byte (same SHA-256). Light shot: sidebar, tabs, chat card, inspector and
status bar all in the light palette; badges, the Super-YOLO pill, the Changes counts and the Send
button readable; no dark block left. Idle CPU with a session shown: dark 0.19–0.30 %, light 0.25 %,
Herdr's `main` layout 0.47 % (herdr/PERF.md method, 20 s).

## Not checked

- No light artboard exists, so there is no side-by-side render: the values above are the spec.
- Markdown in the chat (`TextView.markdown`) uses Herdr's theme colours, so it follows the theme;
  code blocks use Herdr's own highlighter colours.
