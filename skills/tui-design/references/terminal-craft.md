# Terminal Craft Floor

Read before any terminal UI edit. Every item is checkable in a screenshot.

## The medium

- The grid is the cell. Spacing is measured in columns and rows; a blank row is the most expensive spacing unit, a single space column the cheapest.
- Type roles come from bold, dim, italic, case and color role, not size. Keep roles few (3-4) and identical wherever they repeat.
- Glyphs are the icon system. Pick one family (for example geometric: `●○◐✓✗▸▾`) and use it everywhere; never mix flower, emoji and geometric glyphs for the same role.
- Double-width cells (emoji, CJK) break alignment and width budgets; avoid emoji in chrome, measure with `visibleWidth`.

## Hierarchy

- One primary element per panel, 2-3 secondary, everything else muted.
- Labels dim, values normal, the one thing that matters bright or accented.
- Align key/value pairs in a column (`label  value`), not label-above-value stacks.
- Group by proximity first; add a separator only when proximity fails; add a box only when the region is interactive or scrolls independently.
- Squint test: in a blurred screenshot the order primary > secondary > groups must still read.

## Space and density

- Density matches frequency of use: always-visible chrome is dense (one row per fact), rarely used detail goes behind a key or expands.
- Rhythm comes from contrast: tight inside a group, one gap between groups, never the same gap everywhere.
- Panel chrome budget: header row plus content. Padding rows above, below and between header and body must earn their place.
- Truncate with `…` rather than wrap in fixed-width rails; wrap only prose.
- Finished items (done todos, completed agents) collapse to a summary row.

## Color roles

- Build roles, not swatches: canvas, elevated surface, rail surface (a second neutral, slightly tinted), text primary/secondary/muted, accent (action, selection, focus), success/warning/error/info, border.
- Accent only for action, selection and live state; one accent hue.
- Never gray text on a colored background; use a darker shade of the background hue.
- Never encode state by color alone; pair it with a glyph or word.
- Dark is designed, not inverted; check contrast of dim text on tinted surfaces.

## IDE vocabulary (Operate mode)

- Status bar: one row, fixed position, segments separated by thin dividers, most volatile data on the right.
- Side panel: sections with a one-row header (`▾ NAME  count`), collapsible, dense lists below.
- Panes are separated by a single thin rule or a surface tint, not by framed boxes with gaps.
- Keyboard hints live in the status bar or appear on focus/hover, not repeated in every header.
- Command palette and slash commands are the navigation model; do not invent new affordances.

## Refuse (terminal anti-patterns)

- Boxes inside boxes, or a card per tiny fact.
- A colored side bar (`▌`/`┃`) on every item as decoration.
- Blank rows as the main hierarchy tool; monotonous spacing.
- Text flush against a colored band with no inset cell.
- The same fact shown twice on one screen (header and panel).
- Redundant labels repeated 3+ times in one panel; words like "Collapse" where a glyph says it.
- Letter-spaced or ALL CAPS body text.
- Decorative animation; spinners or pulses only for genuinely live work.
- Retro costume: fake function-key bars, ASCII art banners, neon-on-black palettes chosen for vibe.
- Colors outside the theme tokens.
- Copy tells: em-dash chains, marketing words, aphorisms in status text.

## Verify

- Contrast of dim and muted text on every surface it appears on.
- Every interactive row has default, hover, focus, selected, disabled and loading looks.
- Long values (paths, branch names), empty states, 0 and 1000 items, narrow widths.
- No line exceeds its column budget (an overflowing rail line can disable the whole rail in Gentle Shell).
- Render cost: unchanged frames re-render nothing; style and width changes invalidate caches.
