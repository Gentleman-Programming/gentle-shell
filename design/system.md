# Gentle Shell design system

Captured (read-only) from the project's design sources:

- `assets/install-wizard/wizard.css` — installation wizard, gentlemanprogramming.com tokens (`:root`).
- `assets/design-canvas/canvas.css` — the Gentle Design canvas (`:root`). Same brand set as the wizard, plus derived tokens and layout sizes.
- `lib/design-system-tokens.ts` — no tokens of its own; it defines how the canvas reads this file (a table row whose first cell is a backticked `--name` and whose second cell is its backticked value, grouped by the `##` section), so every token below keeps that shape.

Both stylesheets are dark only (`color-scheme: dark`) and use local font stacks only (no web fonts, no external resources). Every state also has a text label; never color alone (`assets/install-wizard/wizard.css` header comment; `assets/design-canvas/canvas.css` `.gd-status` comment).

## Colors — brand set

| Token | Value | Usage | Source |
| --- | --- | --- | --- |
| `--bg` | `#1a1218` | Page and canvas background; text on accent | both |
| `--bg-deep` | `#000000` | Deepest background: canvas tool rail, wizard code blocks | both |
| `--surface` | `#20161e` | Bars, side panels, menus, popovers, toast | both |
| `--surface-1` | `#241822` | Raised surface: cards, mode chip, dialogs | both |
| `--surface-2` | `#342230` | Higher surface: selected items, pressed tools, counts, dot grid | both |
| `--border` | `#342230` | Borders and separators | both |
| `--border-soft` | `#ffffff17` | Soft borders: chips, tags, kbd, ghost buttons | both |
| `--text` | `#f6eff3` | Primary text | both |
| `--text-muted` | `#a78e9b` | Secondary text | both |
| `--text-faint` | `#76616b` | Decorative only (below AA for body text): pending step outlines, separators | both |
| `--accent` | `#f095c8` | Primary buttons, links, focus outline, pins, selected tab, chosen artboard | both |
| `--accent-strong` | `#ff76c3` | Hovered / pressed primary | both |
| `--accent-soft` | `#ffb1dd` | Code chips, hover text, counts | both |
| `--success` | `#b4e7c7` | Success, done steps, Sent, Implemented, A11y ✓ | both |
| `--warning` | `#e0c27a` | Queued, waiting, advice checks, active pin, minimap view | both |
| `--error` | `#ff718f` | Errors, failed checks, Detached | both |
| `--info` | `#a9c7ee` | In progress, current step, mix picks | both |

## Colors — canvas derived tokens

| Token | Value | Usage | Source |
| --- | --- | --- | --- |
| `--accent-wash` | `#f095c814` | Hover/selection wash, active comment ring | `assets/design-canvas/canvas.css` |
| `--accent-line` | `#f095c899` | Accent borders: work pill, active card, toggle, current version | `assets/design-canvas/canvas.css` |
| `--wash` | `#ffffff0f` | Neutral wash: code chips, agent replies | `assets/design-canvas/canvas.css` |
| `--paper` | `#ffffff` | Artboard frame and thumbnail background | `assets/design-canvas/canvas.css` |
| `--success-halo` | `#b4e7c726` | Status dot halo | `assets/design-canvas/canvas.css` |
| `--success-line` | `#b4e7c766` | Success chip border (A11y ✓, Applied, Implemented) | `assets/design-canvas/canvas.css` |
| `--error-halo` | `#ff718f26` | Error dot halo, failed check ring halo | `assets/design-canvas/canvas.css` |
| `--error-wash` | `#ff718f1a` | Alert background | `assets/design-canvas/canvas.css` |
| `--error-line` | `#ff718f80` | Alert and failed check border, invalid field | `assets/design-canvas/canvas.css` |
| `--info-halo` | `#a9c7ee33` | Current step halo, pulse | `assets/design-canvas/canvas.css` |
| `--info-line` | `#a9c7ee66` | In progress chip border, placeholder status | `assets/design-canvas/canvas.css` |
| `--warning-line` | `#e0c27a66` | Waiting/advice chip border, overflow chip, history warning | `assets/design-canvas/canvas.css` |
| `--warning-halo` | `#e0c27a33` | Advice check ring halo | `assets/design-canvas/canvas.css` |
| `--scrim` | `#000000b3` | Dialog backdrop | `assets/design-canvas/canvas.css` |
| `--selection` | `#f095c84d` | Text selection background (the wizard's `::selection`) | `assets/design-canvas/canvas.css` |

## Colors — wizard literal values (not tokens)

Hex values written inline in `assets/install-wizard/wizard.css` rules, recorded for reference. They are not custom properties; new artboards use the tokens above.

| Rule | Value | Usage |
| --- | --- | --- |
| `::selection` | #f095c84d | Text selection background |
| `.stage-current .stage-dot` | #f095c826 | 4 px halo around the current stage dot |
| `.stage-done .stage-dot` | #b4e7c799 border, #b4e7c726 fill | Done stage dot |
| `.stage-issue .stage-dot` | #e0c27a99 border, #e0c27a26 fill | Stage with an issue |
| `.pill-accent` | #f095c84d border, #f095c81f fill | Accent pill |
| `.alert-error` | 0 10px 30px #ff718f14 | Error alert shadow |

## Typography

| Token | Value | Notes | Source |
| --- | --- | --- | --- |
| `--font-sans` | `Inter, "SF Pro Text", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` | All UI text. Canvas base 14px/1.5; wizard base 16px/1.6 | both |
| `--font-mono` | `"IosevkaTerm NF", "Iosevka Term", "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, "DejaVu Sans Mono", monospace` | Code chips, selectors, sizes, kbd; wizard eyebrows, stage labels and pills | both |

Sizes in use (no size tokens):

| Where | Sizes | Source |
| --- | --- | --- |
| Canvas | 11 (tags, kbd, mini stepper, check kinds), 12 (meta, chips, counts, uppercase section titles with .06em tracking), 13 (cards, alerts, menu items, status), 14 (body, bar title), 15 (Send all button, brief title, compare title), 16 (artboard and dialog titles, 600) | `assets/design-canvas/canvas.css` |
| Wizard | h1 clamp(34px, 4.6vw, 58px) 800 / 1.08; lead clamp(17px, 1.6vw, 18px); section title 18 700; wordmark 18 800; body and card title 16 (700); buttons 600 15; meta 13; eyebrow and stage labels 600 12 mono uppercase (.1em–.12em) | `assets/install-wizard/wizard.css` |

## Spacing

No spacing tokens in either source. Values in use:

| Where | Values | Source |
| --- | --- | --- |
| Canvas gap / padding | 2, 4, 6, 8, 10, 12, 14, 16, 20, 24 px; 8 px is the most common | `assets/design-canvas/canvas.css` |
| Wizard gap / padding | 8, 10, 12, 16, 20, 24, 28, 36 px; panel padding clamp(24px, 4.2vw, 52px) | `assets/install-wizard/wizard.css` |

## Layout

| Token | Value | Usage | Source |
| --- | --- | --- | --- |
| `--rail-width` | `60px` | Tool rail | `assets/design-canvas/canvas.css` |
| `--bar-height` | `56px` | Top bar | `assets/design-canvas/canvas.css` |
| `--nav-width` | `240px` | Artboard list | `assets/design-canvas/canvas.css` |
| `--side-width` | `360px` | Review side (`min(var(--side-width), 40vw)`) | `assets/design-canvas/canvas.css` |

Canvas viewport: `--bg` with a dot grid of `--surface-2` (1 px dots, 22 px spacing). Wizard page: content width `min(1040px, 100% - 32px)`, dot grid of #ffffff0d at 26 px fading out by 70 % height.

## Radius

| Token | Value | Source |
| --- | --- | --- |
| `--radius-sm` | `8px` | both |
| `--radius-md` | `12px` | both |
| `--radius-lg` | `16px` | both: dialogs, wizard panel |
| `--radius-pill` | `999px` | both: chips, tags, counts, mode chip |

Literal radii in `assets/design-canvas/canvas.css`: 6px (code chips, small controls, compare frames), 4px (thumbnails, kbd), 3px (inspector swatch), 2px (minimap blocks), 50% (dots), `13px 13px 13px 2px` (pins), `11px 11px 11px 2px` (pin badges in lists).

## Shadows and motion

| Token | Value | Usage | Source |
| --- | --- | --- | --- |
| `--glow` | `0 10px 30px #f095c84d` | Primary buttons | both |
| `--glow-hover` | `0 14px 36px #f095c86b` | Hovered wizard primary button | `assets/install-wizard/wizard.css` |
| `--shadow-panel` | `0 24px 60px #00000073, 0 0 40px #f095c81a` | Popovers, menus, dialogs, toast, minimap, mode chip, wizard panel | both |
| `--shadow-frame` | `0 2px 16px #00000080` | Artboard frames, pins, chips over artboards | `assets/design-canvas/canvas.css` |
| `--shadow-pop` | `0 4px 16px #00000099` | Floating buttons (Back to canvas) | `assets/design-canvas/canvas.css` |
| `--ease` | `cubic-bezier(.4, 0, .2, 1)` | Transitions 120–200 ms; pulse 1.6 s; breathe 2 s | both |

Motion: canvas animates only under `prefers-reduced-motion: no-preference`; the wizard cancels animations under `prefers-reduced-motion: reduce`.

## Component rules

Canvas (`assets/design-canvas/canvas.css`):

- **Buttons**: inline-flex, min 36×36, padding 4px 12px, gap 8px, 1px `--border`, `--radius-sm`, transparent; hover `--border-soft` border and `--accent-soft` text. Primary (`.gd-primary`): `--accent` fill and border, `--bg` text, 600, `--glow`; hover `--accent-strong`. Small (`.gd-small`): min-height 30px, padding 2px 10px, 12px. Disabled: opacity .5.
- **Toggle** (`.gd-toggle[aria-pressed=true]`): `--surface-2` fill, `--accent-line` border, `--accent` text.
- **Focus**: 2px solid `--accent` outline, offset 2px, on every control.
- **Icons**: 18×18 stroked SVG (stroke 2, round caps), `currentColor`; 15×15 in small controls.
- **Tool rail**: `--bg-deep`, 40×40 icon buttons in `--text-muted`; pressed tool gets `--surface-2`, `--accent` icon and a 3px accent bar on its left edge. Every icon-only button has an accessible name and a title naming its shortcut.
- **Top bar**: `--surface`, 56px, 1px bottom `--border`, gap 12px, padding 0 16px. Breadcrumb in `--text-muted` with a 600 14px title.
- **Work pill** (`.gd-work`): pill with 1px `--accent-line`, 12px; 8px status dot (accent chosen, `--warning` queued, `--info` sent/in progress and pulsing, `--success` implemented), 600 lead and accent title, "·" separators in `--text-faint`, a small Show button.
- **Status line** (`.gd-status`): 13px `--text-muted` with an 8px dot and 3px halo (`--success`/`--success-halo`, error variant `--error`/`--error-halo`).
- **Artboard list**: 240px `--surface`; uppercase 12px title; items with a 56×40 `--paper` thumbnail (4px radius), 600 13px title, 12px muted summary, pill tags 11px 600 (`Chosen` accent with a dot, `A11y ✓` success, `N checks` warning). Current item `--surface-2`; chosen item a 3px inset accent edge; discarded items at opacity .45 and grayscale .6 until hover/focus.
- **Tabs**: `--text-muted`, 2px bottom border; selected `--text` with `--accent` underline; count badge pill `--surface-2` with `--accent-soft`, 12px. A row that overflows scrolls with edge arrows and fades.
- **Cards** (comments, checks, versions, mix picks): `--surface-1`, 1px `--border`, `--radius-md`, padding 10–12px, 13px; active comment `--accent-line` plus a 3px `--accent-wash` ring; failed check `--error-line`, advice `--warning-line`; passed/empty cards dashed.
- **Chips, badges and tags**: pill, 1px border, 11–12px 600; color carried by text plus the matching `*-line` border. Handoff badges: Queued `--warning`, Implementing/In progress `--info` with a pulsing dot, Implemented `--success`; Chosen is a filled accent pill with `--bg` 700 text.
- **Code chips**: `--font-mono` 12px, `--accent-soft` on `--wash`, 1px `--border-soft`, 6px radius.
- **Pins**: 26px min, radius `13px 13px 13px 2px`, 2px `--bg` border, `--accent` fill with `--bg` 700 12px number, `--shadow-frame`; active `--warning`, resolved `--text-muted` at .75, mix picks `--info`. Kept at screen size with inverse zoom.
- **Mini stepper** (`.gd-ministep`): 11px muted labels joined by 10px `--text-faint` lines; 8px dots: done `--success`, current `--info` with a 3px `--info-halo` and 600 `--text` label, pending `--text-faint` outline.
- **Timeline steps**: 10px dot; done `--success`, current `--info` with `--info-halo`, pending `--text-faint` outline; label plus muted detail.
- **Segmented control** (`.gd-sendmode`, `.gd-devices`, the Comments tab's Open / Resolved filter `.gd-comment-filter`): 1px `--border` box, 3px padding; options 30–32px, selected `--surface-2` and `--text`; send-mode labels wrap, centered.
- **Send intro and pending count**: intro 13px `--text`; pending count 12px 600 `--warning`, hidden at 0.
- **Technical details toggle** (`.gd-technical`): top bar button in `--text-muted`, off by default; on it takes the toggle look (`--surface-2`, `--accent-line`, `--accent`).
- **Mode chip**: floating pill at the bottom center of the viewport, `--surface-1`, 1px `--border`, `--shadow-panel`, 13px, an 8px dot (accent while commenting or using an artboard).
- **Back to canvas**: floating accent button at the bottom center, 600, `--shadow-pop`.
- **Menu** (`.gd-menu`): `--surface`, 1px `--border`, `--radius-md`, `--shadow-panel`, 6px padding, min 250px; 36px items 13px, hover/focus `--surface-2`; disabled items muted with a 12px note; 1px `--border` separators.
- **Popover and dialog**: popover `--surface`, 8px radius, `--shadow-panel`, 12px padding, max 360px; dialog `--surface-1`, `--radius-lg`, padding 20px 24px, `--scrim` backdrop, 16px title.
- **Alerts**: flex with an error icon, 1px `--error-line`, `--error-wash`, `--radius-sm`, 13px text, an 11px mono reason code and a 28px dismiss button. Over an artboard they get an opaque `--surface` layer and `--shadow-panel`.
- **Toast**: top center (72px), `--surface`, 1px `--accent` (or `--error`), 8px radius, `--shadow-panel`, 600.
- **Minimap**: bottom right, `--surface`, `--radius-md`, `--shadow-panel`, 11px uppercase title with a kbd; 204×96 map, chosen block accent, view outline 1.5px `--warning`.
- **Check ring**: 2px `--warning` (advice) or `--error` (problem) outline with a 4px halo (`--warning-halo` / `--error-halo`) and an 11px 700 pill label on the same color.
- **Placeholder board**: `--surface-1`, 1px dashed `--accent`, centered `--info` 600 status pill that breathes.
- **Keyboard keys**: `--font-mono` 11px, 1px `--border-soft` with a 2px bottom border, 4px radius, `--text-muted`.

Wizard (`assets/install-wizard/wizard.css`):

- **Stage indicator** (`.stages`): ordered list in one row, gap 8px; each stage a 28px round dot (1px `--border`, `--surface`, 12px number) plus a 600 12px mono uppercase label (.1em), joined by 1px `--border` lines. Current: `--accent` dot with `--bg` number, 4px accent halo and `--glow`, `--text` label. Done: `--success` label, success-tinted dot. Issue: `--warning` label, warning-tinted dot.
- **Brand buttons**: min-height 46px, padding 13px 24px, `--radius-sm`, 600 15px; primary `--accent` on `--bg` with `--glow`, lifts 2px with `--glow-hover` on hover; secondary transparent with `--border`; ghost `--border-soft` + `--text-muted`; hover border `--accent`, text `--accent-soft`; disabled .55 opacity, no glow.
- **Panel**: `--radius-lg`, 1px `--border`, `linear-gradient(180deg, #241822f2, #20161ef2)` (surface-1 to surface at 95 %), `--shadow-panel`, padding clamp(24px, 4.2vw, 52px).
- **Cards**: padding 22px 24px, `--surface`, 1px `--border`, `--radius-md`; 16px 700 title, 15px muted body.
- **Alerts**: padding 16px 20px, `--surface`, 1px `--border` with a 3px left border in `--info` (default), `--success`, `--warning` or `--error`; 700 title in the same color; actions row below.
- **Pills**: 600 12px mono, padding 3px 10px, 1px `--border-soft`, pill radius.
- **Eyebrow**: `--accent` 600 12px mono uppercase, .12em.
