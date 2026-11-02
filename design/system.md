# Gentle Shell design system

Synced from the project's design sources (read only). Every value below is copied from the named source path; rules marked **design rule** are usage guidance derived from those values for design work, not new tokens.

Sources read:

- `themes/Gentle.json`, `themes/Gentleman-Cute.json`, `themes/Gentleman-Sexy.json` — the terminal palettes the real Gentle Shell TUI renders with (Pi theme schema: `vars` hold values, `colors` map TUI roles to vars).
- `lib/shell-card.ts`, `lib/shell-gauge.ts`, `lib/gauge-theme.ts`, `lib/card-style-policy.ts` — card chrome, gauge glyphs and thresholds, card styles.
- `assets/install-wizard/wizard.css` — the web install wizard (fonts, radius, shadows, motion).
- `assets/design-canvas/canvas.css` — the design canvas chrome (not product UI; recorded for completeness).

`lib/terminal-theme.ts` holds only ANSI sanitizing, no tokens.

## 1. TUI palettes (primary system for terminal UIs)

### 1.1 Theme values (`vars`)

| Token | Gentle | Gentleman-Cute | Gentleman-Sexy |
| --- | --- | --- | --- |
| `bg` | `#06080f` | `#060407` | `#060407` |
| `bgPanel` / `bgElement` | `#06080f` | `#100A0F` | `#100A0F` |
| `bgSubtle` | `#0d0f14` | `#100A0F` | `#100A0F` |
| `userMessageBg` | `#161D2E` | `#2A1523` | `#2E0F1F` |
| `selection` | `#232A40` | `#28121E` | `#28121E` |
| `border` | `#313342` | `#563040` | `#563040` |
| `borderSubtle` | `#232A40` | `#2A1720` | `#2A1720` |
| `text` | `#F3F6F9` | `#F6EFF3` | `#F6EFF3` |
| `muted` | `#5C6170` | `#A78E9B` | `#A78E9B` |
| `dim` | `#5C6170` | `#76616B` | `#76616B` |
| `accent` (var) | `#E0C15A` | `#F095C8` | `#F43888` |
| `warning` | `#DEBA87` | `#F2B86D` | `#F2B86D` |
| `red` / `error` | `#CB7C94` | `#FF718F` | `#FF718F` |
| `toolSuccessBg` | `#1a2e1a` | `#151316` | `#151316` |
| `toolPendingBg` | `#0d0f14` | `#100A0F` | `#100A0F` |
| `toolErrorBg` | `#2e1a1a` | `#261019` | `#261019` |
| `infoBg` | `#0d0f14` | `#100A0F` | `#100A0F` |

Theme-specific hues:

- Gentle (`themes/Gentle.json`): `blue #7FB4CA`, `secondary #A3B5D6`, `heading #B5B2D0`, `green #B7CC85`, `brightBlack #8394A3` (= `syntaxComment`), `brightGreen #D1E8A9`, `brightYellow #DEBA87`, `brightPurple #B99BF2` (= `syntaxFunction`), `brightMagenta #C99AD6` (= `syntaxKeyword`), `brightBlue #8FB8DD` (= `syntaxType`), `syntaxString #DFBD76`, `syntaxNumber #A4DAA7`, `syntaxPunctuation #96A2B0`, `surfaceLine #0d0f14`, `disabled #5C6170`.
- Gentleman-Cute (`themes/Gentleman-Cute.json`): `deepPink #C96AA2`, `activePink #FFB1DD`, `champagne #E0C27A`, `pearl #D2CBD0`, `softRose #D7A0B8`, `powderBlue #A9C7EE`, `mint #B4E7C7`, `peach #F2B86D`, `sky #C4DAF6`.
- Gentleman-Sexy (`themes/Gentleman-Sexy.json`): `deepPink #BF0F50`, `activePink #FF4F9A`, `champagne #E0C27A`, `violet #C49BFF`, `pearl #D2CBD0`, `softRose #D7A0B8`, `powderBlue #A9C7EE`.

### 1.2 TUI roles (`colors` → resolved value)

| Role | Gentle | Cute | Sexy | Usage |
| --- | --- | --- | --- | --- |
| `accent` | blue `#7FB4CA` | `#F095C8` | `#F43888` | Primary accent, card titles (INFO tone) |
| `borderAccent` | blue `#7FB4CA` | activePink `#FFB1DD` | activePink `#FF4F9A` | Focused / active frame |
| `border` | `#313342` | `#563040` | `#563040` | Card frames, empty gauge cells |
| `borderMuted` | `#232A40` | `#2A1720` | `#2A1720` | Quiet rules |
| `success` | green `#B7CC85` | mint `#B4E7C7` | pearl `#D2CBD0` | Done, success cards |
| `warning` | `#DEBA87` | `#F2B86D` | `#F2B86D` | Warning cards, gauge ≥ 80% |
| `error` | red `#CB7C94` | `#FF718F` | `#FF718F` | Errors, gauge ≥ 95% |
| `muted` / `dim` | `#5C6170` | `#A78E9B` / `#76616B` | `#A78E9B` / `#76616B` | Subtitles / hints |
| `thinkingText` | muted `#5C6170` | softRose `#D7A0B8` | muted `#A78E9B` | Model reasoning text |
| `customMessageLabel` / `toolTitle` | blue `#7FB4CA` | champagne `#E0C27A` | champagne `#E0C27A` | Extension message labels, tool names |
| `customMessageBg` | `#0d0f14` | `#100A0F` | `#100A0F` | Extension message background |
| `userMessageBg` | `#161D2E` | `#2A1523` | `#2E0F1F` | The human's messages |
| `selectedBg` | `#232A40` | `#28121E` | `#28121E` | Selected row |
| `mdHeading` | heading `#B5B2D0` | champagne | champagne | Markdown headings |
| `mdCode` | green `#B7CC85` | champagne | champagne | Inline code |
| `mdLink` | blue | accent `#F095C8` | activePink `#FF4F9A` | Links |
| `thinkingMedium` / `thinkingHigh` | blue / blue | powderBlue / softRose | powderBlue / violet | Thinking-level indicator |

Note: in Gentle, the `accent` var (`#E0C15A`) is not mapped to the `accent` role; the role resolves to `blue`.

### 1.3 Contrast (measured on `bg`, WCAG 2.x)

- Passes AA for text: `text` (18.0+), Gentle `brightBlack #8394A3` (6.41), Cute/Sexy `muted #A78E9B` (6.79), every accent/hue listed above (Sexy `accent #F43888` is the lowest at 5.61; 4.79 on `userMessageBg`).
- Fails AA for text: Gentle `muted`/`dim #5C6170` (3.24), Cute/Sexy `dim #76616B` (3.59), Sexy `deepPink #BF0F50` (3.31), every `border` value (≤ 1.84).
- **Design rule:** readable secondary text uses Gentle `brightBlack #8394A3` and Cute/Sexy `muted #A78E9B`. Gentle `thinkingText` (muted `#5C6170`) is replaced by `brightBlack #8394A3` in designs for AA. `dim` and `border` values are for frames, rules and decorative glyphs only, never for text that carries meaning.

## 2. Typography

| Token | Value | Source |
| --- | --- | --- |
| `--font-mono` | `"IosevkaTerm NF", "Iosevka Term", "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, "DejaVu Sans Mono", monospace` | `assets/install-wizard/wizard.css` |
| `--font-sans` | `Inter, "SF Pro Text", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` | `assets/install-wizard/wizard.css` |
| canvas sans | `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` (14px) | `assets/design-canvas/canvas.css` |
| canvas mono | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` | `assets/design-canvas/canvas.css` |
| body | `16px/1.6 var(--font-sans)` | `assets/install-wizard/wizard.css` |
| label caps | `600 12px/1.4 var(--font-mono)`, `letter-spacing: .12em`, uppercase | `wizard.css` `.progress-label` |
| status caps | `600 11px/1.4 var(--font-mono)`, `letter-spacing: .08em`, uppercase | `wizard.css` `.step-status` |
| sizes in use | 10, 11, 12, 13, 14, 15, 16, 18 px | `assets/install-wizard/wizard.css` |
| weights in use | 600, 700, 800 | `assets/install-wizard/wizard.css` |

No `@font-face` or remote fonts exist in any source; all stacks are local names.

**Design rule (terminal artboards):** one monospace grid in `--font-mono`, 13px with a 17px row, measured in `ch` columns and rows; sizes and weights other than regular/700 are not used inside a terminal screen.

## 3. Spacing

No spacing tokens exist. Values observed in `assets/install-wizard/wizard.css` (gap/padding/margin, by frequency): 12, 8, 24, 16, 10, 14, 20, 4, 6, 32, 18, 28 px. In terminal artboards spacing is whole cells (1ch, one row).

## 4. Radius

| Token | Value | Source |
| --- | --- | --- |
| `--radius-sm` | 8px | `assets/install-wizard/wizard.css` |
| `--radius-md` | 12px | `assets/install-wizard/wizard.css` |
| `--radius-lg` | 16px | `assets/install-wizard/wizard.css` |
| `--radius-pill` | 999px | `assets/install-wizard/wizard.css` |

Terminal artboards use no radius; the rounded look comes from `╭╮╰╯`.

## 5. Shadows and motion

| Token | Value | Source |
| --- | --- | --- |
| `--glow` | `0 10px 30px #f095c84d` | `assets/install-wizard/wizard.css` |
| `--glow-hover` | `0 14px 36px #f095c86b` | `assets/install-wizard/wizard.css` |
| `--shadow-panel` | `0 24px 60px #00000073, 0 0 40px #f095c81a` | `assets/install-wizard/wizard.css` |
| `--ease` | `cubic-bezier(.4, 0, .2, 1)` | `assets/install-wizard/wizard.css` |
| caret | `"▍"`, `blink 1.1s steps(1) infinite` | `wizard.css` `.log-empty::after` |
| spinner | `spin .9s linear infinite` | `wizard.css` `.step-running .step-icon` |
| reduced motion | animations reduced to `.001ms`, one iteration | `wizard.css` `@media (prefers-reduced-motion: reduce)` |

Terminal artboards use no shadows inside the screen.

## 6. Web (wizard) palette

`assets/install-wizard/wizard.css` `:root`: `--bg #1a1218`, `--bg-deep #000000`, `--surface #20161e`, `--surface-1 #241822`, `--surface-2 #342230`, `--border #342230`, `--border-soft #ffffff17`, `--text #f6eff3`, `--text-muted #a78e9b`, `--text-faint #76616b`, `--accent #f095c8`, `--accent-strong #ff76c3`, `--accent-soft #ffb1dd`, `--success #b4e7c7`, `--warning #e0c27a`, `--error #ff718f`, `--info #a9c7ee`. Focus: `outline: 2px solid var(--accent); outline-offset: 2px`.

`assets/design-canvas/canvas.css` `:root` (canvas chrome only): `--gd-bg #111214`, `--gd-stage #1a1b1e`, `--gd-panel #222327`, `--gd-border #3a3b40`, `--gd-text #ececee`, `--gd-muted #a9abb2`, `--gd-accent #8ab4ff`, `--gd-accent-text #0b1220`, `--gd-danger #ff9b9b`, `--gd-focus #ffd479`, `--gd-pin #8ab4ff`, `--gd-pin-resolved #7d8a7f`, `--gd-success #9be0a8`.

## 7. TUI components

### Card (`lib/shell-card.ts`)

- Two styles, chosen in Gentle → Customize and stored in `card-style.json` (`lib/card-style-policy.ts`); missing file means **float** (default).
- **Neon / outline chrome:** `╭─ ` title … `╮`, sides `│`, bottom `╰ … ╯`. Frame and title use the tone role; INFO tone keeps the frame in `border` and paints the title in `accent`.
- **Float chrome:** left bar `▎`, no rules or right rail, 1-cell margin, background by tone: INFO and SUCCESS `toolSuccessBg`, WARNING `toolPendingBg`, ERROR `toolErrorBg`.
- Tones: INFO, SUCCESS, WARNING, ERROR. Hint (right of the top rule) in `dim`, subtitle in `muted`, body in `text`, parts separated by ` · `. Card glyph `✿`.

### Gauge (`lib/shell-gauge.ts`, `lib/gauge-theme.ts`)

- 8 cells, filled `▰`, empty `▱`.
- Filled cells: `accent` below 80%, `warning` from 80%, `error` from 95%; empty cells in `border`.
- Themes may override per role through `vars` keys `gauge.ok`, `gauge.warning`, `gauge.error`, `gauge.empty`, `gauge.filled`, `gauge.emptyGlyph`; none of the three shipped themes declare them.

### Fleet member digest (`lib/fleet-member.ts`)

- Member status values: `starting | working | idle | waiting-question | exited`.
- One code-built line per member: `name [status] · todo d/t "current" · last tool X · N tok · $c.cc · question: …`.

**Design rules (proposed for fleet designs, values from the themes above):**

- Every state carries a glyph and a text label, never color alone: `◌ starting`, `● working` (`accent`), `◆ waiting on you` (`warning`), `◇ idle` (readable secondary text), `✕ exited` with an error (`error`), `✓ done` (exited cleanly, `success`); todo items `● done`, `◐ current`, `○ pending`.
- Member hues (distinct from `accent`, which marks the fleet orchestrator): Gentle `#E0C15A`, `#B99BF2`, `#A4DAA7`; Cute `#A9C7EE`, `#E0C27A`, `#B4E7C7`; Sexy `#A9C7EE`, `#E0C27A`, `#C49BFF`. With three members, one hue each; with more, the hue marks the front (`api`, `web`, `docs` name prefixes) and members of any other front use `text`, so the name, never the hue, identifies a member.
- Thinking text is prefixed `∴` and uses the theme's `thinkingText`, with the Gentle AA substitution from 1.3.
- Focus ring: `2px solid` `borderAccent`.
