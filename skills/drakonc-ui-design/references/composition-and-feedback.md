# Composition and feedback

## Establish hierarchy

Give each text role a job: page title identifies the place, section headings describe groups,
body text carries information, and labels name controls. Make these roles visibly distinct using the existing type system.
When every line is bold and oversized, users cannot tell which element leads; reserve the strongest emphasis for the current task or heading.
A dense incident list may need compact headings; a long policy explanation needs more comfortable measure and line-height.
Do not replace the project's fonts merely to follow a trend.

Use alignment to make relationships visible. Align comparable numeric columns consistently,
and keep units and precision understandable; do not make `9`, `12`, and `105` difficult to compare through inconsistent placement.
Use a consistent left edge for related labels and values unless the content or reading direction calls for another arrangement.
Allow headings to wrap naturally instead of forcing an arbitrary line count.

For a hypothetical interface, a 16px body with a 24px line-height and a modestly larger section heading can be a starting example,
not a brand token or universal scale. Check the actual font, content, platform, and viewport.
Likewise, repeated 8px and 16px spacing might create a useful rhythm in one project;
use existing tokens first and adjust the relationship when the content needs it.
Optically balance the whole composition: a short title and a dense table need different surrounding space,
without enforcing arbitrary percentages or symmetrical empty areas.

## Group without visual noise

Place related elements closer together than unrelated groups; use headings and alignment before adding containers.
Nested cards around each label, value, and action make the structure harder to scan and consume space.
Replace them with one meaningful group and aligned content. A nested boundary is useful when it separates a distinct interactive region or changes the interpretation of the contents.

Use borders, surfaces, and shadows to reveal actual boundaries or elevation, not to make every element equally prominent.
A clear table header and row separators may be enough for comparison; a card may be useful when each item is a standalone task.
Match density to frequency and consequence: repeated expert work often benefits from compact rows,
while infrequent or consequential choices may need more explanation and spacing.

Decorative KPI tiles can push the task off screen while answering no question.
For a room-booking tool, show **Next available: 14:30** if it changes a decision;
do not add invented trend tiles merely to make the page look like a dashboard.
An overview metric is appropriate when users can act on it and understand its scope and freshness.
Avoid turning every word into a pill, badge, or icon: use these for meaningful state or recognition,
and retain labels when icons alone would be ambiguous. An icon-only control needs an accessible name.

## Color and feedback

Use color roles to distinguish actions, information, and states within the existing palette.
Do not convey status only by color: add a readable label, shape, or other cue.
As accessibility targets, normal text generally needs at least 4.5:1 contrast;
large text generally needs 3:1, and visual information needed to identify controls and states generally needs 3:1 against adjacent colors, subject to applicable exceptions.
These ratios alone do not establish accessibility or standards conformance. Decorative elements are not the same as required control boundaries.
Tiny, low-contrast metadata is especially easy to lose; increase contrast or make the information less prominent by placement rather than making it unreadable.

Show selected, disabled, hover, and keyboard focus as distinct states. Focus must remain visible against its surroundings and must not be confused with selection.
Explain why an action is unavailable when the reason is not apparent and give a path to resolve it when possible.
Use the platform's disabled behavior intentionally: a disabled control may not receive keyboard focus, so put necessary explanation where it can be found.

Use movement to clarify a change or preserve orientation, not to delay routine work.
Avoid animating every row or adding a pause merely to suggest polish; a short transition can be useful when it makes a change easier to follow.
Honor reduced-motion preferences and keep the result understandable without animation.
