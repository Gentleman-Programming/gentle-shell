# Motion and spatial interfaces

## Justify motion and 3D by the job

| Brief | Motion or 3D earns its cost when | Prefer instead |
| --- | --- | --- |
| Product page | People must inspect a physical product from several angles before buying | A few well-lit stills when one view answers the question |
| Explanation | Spatial relationships or a sequence are the content, such as how parts fit or data flows | A labeled diagram when the order is simple |
| Narrative or launch | The story is the product and visitors expect to watch it | Static sections with a clear path to the primary action |
| Dashboard or tool | Rarely; motion only confirms a change the user caused | Instant updates with a visible state change |

Decoration alone does not justify a scene, a camera journey, or a timeline. State the job the motion serves in the direction's tradeoff.

## Keep content independent of WebGL and animation

Essential content and actions stay in the DOM: headings, prices, labels, and the primary action are readable and operable without the canvas or the animation running.
A 3D view has a designed fallback poster: a composed still with the same information, shown while the scene loads, when WebGL is unavailable, or when the context is lost.
Text that a scene reveals is also present as text, not only painted into pixels.

## Respect reduced motion

Under `prefers-reduced-motion: reduce`, snap to the composed end state of each transition and keep the same information and order.
Replace scroll-driven camera journeys with the sequence of their key frames as static sections.
Do not remove a state change; remove only its travel. Parallax, auto-rotation, and looping background motion stop entirely.

## Budget for modest hardware

Motion and 3D have a cost in download size, battery, and frame rate; name it in the direction's tradeoff.
Keep one live scene per view, pause it when off screen or in a hidden tab, and keep geometry and textures proportionate to the screen they fill.
Animate `transform` and `opacity` rather than layout properties, and keep interaction feedback within about 100 ms.
Prefer durations and easings from the project's motion tokens in `design/system.md` over invented values.

## Never use motion as the only signal

A state change also changes text, an icon, or a persistent visual state, so it is perceivable when motion is reduced or missed.
Loading, success, and error keep the guidance in `adaptive-interfaces.md`; an animation can accompany them, never replace them.
Focus moves to new content deliberately, not because an animation finished.
