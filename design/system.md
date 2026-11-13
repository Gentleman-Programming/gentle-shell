# Gentle Shell design system

Captured (read-only) from the project's design source:

- `assets/install-wizard/wizard.css` — installation wizard, gentlemanprogramming.com tokens (`:root`).

Each token row names the file that declares it. The wizard is dark only (`color-scheme: dark`) and uses local font stacks only (no web fonts, no external resources). Every state also has a text label; never color alone (`assets/install-wizard/wizard.css` header comment).

## Colors

| Token | Value | Usage | Source |
| --- | --- | --- | --- |
| `--bg` | `#1a1218` | Page background; text on accent (primary button, current stage dot, skip link) | `assets/install-wizard/wizard.css` |
| `--bg-deep` | `#000000` | Deepest background: detail code, log and command boxes | `assets/install-wizard/wizard.css` |
| `--surface` | `#20161e` | Stage dots, cards, alerts, progress box | `assets/install-wizard/wizard.css` |
| `--surface-1` | `#241822` | Raised surface: channel options, consent box | `assets/install-wizard/wizard.css` |
| `--surface-2` | `#342230` | Scrollbar thumb | `assets/install-wizard/wizard.css` |
| `--border` | `#342230` | Borders of panel, cards, alerts, stage dots, log; stage connector lines | `assets/install-wizard/wizard.css` |
| `--border-soft` | `#ffffff17` | Soft borders: code, pills, top bar note, ghost buttons, separators | `assets/install-wizard/wizard.css` |
| `--text` | `#f6eff3` | Primary text | `assets/install-wizard/wizard.css` |
| `--text-muted` | `#a78e9b` | Secondary text: lead, card body, hints, meta, stage labels | `assets/install-wizard/wizard.css` |
| `--text-faint` | `#76616b` | Decorative only (below AA for body text): pending step outline | `assets/install-wizard/wizard.css` |
| `--accent` | `#f095c8` | Links, focus outline, primary button, current stage dot, eyebrow, wordmark | `assets/install-wizard/wizard.css` |
| `--accent-strong` | `#ff76c3` | Pressed primary button | `assets/install-wizard/wizard.css` |
| `--accent-soft` | `#ffb1dd` | Code text, accent pills, ghost button hover, running step | `assets/install-wizard/wizard.css` |
| `--success` | `#b4e7c7` | Success alerts, done stages and steps | `assets/install-wizard/wizard.css` |
| `--warning` | `#e0c27a` | Warning alerts, stages with an issue, blocked steps | `assets/install-wizard/wizard.css` |
| `--error` | `#ff718f` | Error alerts, failed steps, invalid consent | `assets/install-wizard/wizard.css` |
| `--info` | `#a9c7ee` | Default alert border, progress bar, log status | `assets/install-wizard/wizard.css` |

## Colors — wizard literal values (not tokens)

Hex values written inline in `assets/install-wizard/wizard.css` rules, recorded for reference. They are not custom properties; new designs use the tokens above.

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
| `--font-sans` | `Inter, "SF Pro Text", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` | All text; body 16px/1.6 | `assets/install-wizard/wizard.css` |
| `--font-mono` | `"IosevkaTerm NF", "Iosevka Term", "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, "DejaVu Sans Mono", monospace` | Code, eyebrows, stage labels and pills | `assets/install-wizard/wizard.css` |

Sizes in use (no size tokens), from `assets/install-wizard/wizard.css`: h1 clamp(34px, 4.6vw, 58px) 800 / 1.08; lead clamp(17px, 1.6vw, 18px); section title 18 700; wordmark 18 800; body and card title 16 (700); buttons 600 15; meta 13; eyebrow and stage labels 600 12 mono uppercase (.1em–.12em).

## Spacing

No spacing tokens. Values in use in `assets/install-wizard/wizard.css`: gap / padding 8, 10, 12, 16, 20, 24, 28, 36 px; panel padding clamp(24px, 4.2vw, 52px).

## Layout

No layout tokens. Page content width `min(1040px, 100% - 32px)`; background dot grid of #ffffff0d at 26 px fading out by 70 % height (`assets/install-wizard/wizard.css`).

## Radius

| Token | Value | Usage | Source |
| --- | --- | --- | --- |
| `--radius-sm` | `8px` | Buttons, skip link, wordmark mark, detail code | `assets/install-wizard/wizard.css` |
| `--radius-md` | `12px` | Cards, alerts, channel options, consent, progress, log, command | `assets/install-wizard/wizard.css` |
| `--radius-lg` | `16px` | Panel | `assets/install-wizard/wizard.css` |
| `--radius-pill` | `999px` | Pills, top bar note, progress bar | `assets/install-wizard/wizard.css` |

## Shadows and motion

| Token | Value | Usage | Source |
| --- | --- | --- | --- |
| `--glow` | `0 10px 30px #f095c84d` | Primary button, current stage dot | `assets/install-wizard/wizard.css` |
| `--glow-hover` | `0 14px 36px #f095c86b` | Hovered primary button | `assets/install-wizard/wizard.css` |
| `--shadow-panel` | `0 24px 60px #00000073, 0 0 40px #f095c81a` | Panel | `assets/install-wizard/wizard.css` |
| `--ease` | `cubic-bezier(.4, 0, .2, 1)` | Transitions (.2s), panel rise, loader pulse | `assets/install-wizard/wizard.css` |

Motion: animations are cancelled under `prefers-reduced-motion: reduce`.

## Component rules

From `assets/install-wizard/wizard.css`:

- **Stage indicator** (`.stages`): ordered list in one row, gap 8px; each stage a 28px round dot (1px `--border`, `--surface`, 12px number) plus a 600 12px mono uppercase label (.1em), joined by 1px `--border` lines. Current: `--accent` dot with `--bg` number, 4px accent halo and `--glow`, `--text` label. Done: `--success` label, success-tinted dot. Issue: `--warning` label, warning-tinted dot.
- **Brand buttons**: min-height 46px, padding 13px 24px, `--radius-sm`, 600 15px; primary `--accent` on `--bg` with `--glow`, lifts 2px with `--glow-hover` on hover; secondary transparent with `--border`; ghost `--border-soft` + `--text-muted`; hover border `--accent`, text `--accent-soft`; disabled .55 opacity, no glow.
- **Panel**: `--radius-lg`, 1px `--border`, `linear-gradient(180deg, #241822f2, #20161ef2)` (surface-1 to surface at 95 %), `--shadow-panel`, padding clamp(24px, 4.2vw, 52px).
- **Cards**: padding 22px 24px, `--surface`, 1px `--border`, `--radius-md`; 16px 700 title, 15px muted body.
- **Alerts**: padding 16px 20px, `--surface`, 1px `--border` with a 3px left border in `--info` (default), `--success`, `--warning` or `--error`; 700 title in the same color; actions row below.
- **Pills**: 600 12px mono, padding 3px 10px, 1px `--border-soft`, pill radius.
- **Eyebrow**: `--accent` 600 12px mono uppercase, .12em.
