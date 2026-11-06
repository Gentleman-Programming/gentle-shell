# Adaptive interfaces

## Design the states people encounter

| State | Show | Avoid |
| --- | --- | --- |
| Empty collection | What belongs here and a first action when permitted | Pretending a search failed when no records exist |
| No results | The active query or filters and a clear way to broaden them | Erasing the user's criteria or presenting a blank panel |
| Loading | What is being loaded and stable space for content where useful | A blank screen that looks broken or blocking unrelated tasks |
| Partial or stale | Which information is incomplete or when it was last updated, if known | Presenting an old total as a current fact |
| Error | What failed, whether data was saved, and an available recovery action | A generic error that leaves the outcome ambiguous |
| Zero or missing | A real `0` for zero; a clear missing or unavailable label otherwise | Inventing data or treating missing values as zero |

For example, `No bookings yet` can offer `Create booking`, while `No bookings match “lathe”` can offer `Clear search`.
If a save fails, retain the user's input when possible and say whether a retry is safe.
Do not claim an action succeeded until the result is known.

## Reorganize for the context

A desktop navigation rail squeezed into a phone can leave neither navigation nor content usable.
Replace it with a clearly labeled navigation control or a compact top-level pattern appropriate to the platform;
keep the active location and core action reachable. A persistent rail remains useful when the available width supports it.
For a wide comparison table, prioritize identifying fields and the most important comparison in a stacked mobile row,
or allow clearly indicated horizontal scrolling when preserving column comparison is essential.
Do not silently hide the data required for a decision.

Allow long names, translated labels, and text at 200% zoom to wrap or reflow without clipping essential content.
A fixed-height action button that truncates its label is not a reliable shortcut; allow its height to grow.
Keep meaningful order in the DOM aligned with the reading and keyboard order when layouts rearrange.
Visual inspection at representative sizes can reveal awkward reflow, but no particular tool chain or inspection ceremony is required by this guidance.

## Make interaction accessible

Use semantic links for navigation, buttons for actions, and labeled form controls for input.
Ensure keyboard access to essential actions; do not depend on hover to reveal them.
Keep focus visible and distinct from selection. When an overlay opens, move focus to an appropriate control;
when it closes, return focus to its trigger when possible. Where a dialog supports Escape, make that behavior predictable and avoid discarding work without warning.
Expose errors and status changes to assistive technology in context without repeatedly announcing unchanged content.

A practical touch target goal is approximately 44 by 44 CSS pixels when space permits.
WCAG 2.2 AA's target-size criterion uses a 24 by 24 CSS-pixel minimum with defined spacing and other exceptions;
these dimensions alone do not establish compliance. If a compact control is necessary, preserve adequate separation and an accessible name.
Do not rely on a tiny icon's painted size to imply an equally tiny hit area.

Respect `prefers-reduced-motion` for nonessential movement and avoid making animation the only signal of a state change.
A reduced-motion setting can remove travel or use an immediate state change while preserving the same information and functionality.
