# Canvas check highlight: Show marks the area a check or advice refers to

Objective: the Checks tab's Show makes the element of a check visible at any zoom, so the user sees which area the check or advice is about.
Branch: `feat/canvas-check-highlight` (from `feat/canvas-chosen-direction`). Work-unit commits only; push/PR are the user's decision.

## Specs

- **S1 Canvas-drawn mark.** User-approved proposal (verbatim, L2): "Marca dibujada por el canvas, no dentro del artboard. Sería un anillo a tamaño fijo en pantalla, como los pines numerados de los comentarios, que se ve igual a cualquier zoom. Tendría el color de la severidad (ámbar para «Consejo», rojo para «Fallo») y una etiqueta corta con el título de la comprobación. Se quitaría con Esc, al pulsar fuera o al mostrar otra." The ring follows the element's rect (issue.rect, artboard CSS px) through zoom and pan, drawn in the canvas outside the sandboxed iframe, with a minimum on-screen size so a tiny element stays visible. One mark at a time.
- **S2 Show zooms.** (verbatim, L2): "«Mostrar» amplía además de desplazar. Si el zoom está por debajo del 100 %, sube a un nivel en el que el elemento se vea con claridad y lo centra." Never zooms out; respects the canvas zoom limits; in focus mode it keeps the current behavior plus the mark.
- **S3 Linked card.** (verbatim, L2): "Tarjeta y marca enlazadas. La tarjeta que estás mostrando queda resaltada en el panel, para saber a qué comprobación corresponde la marca." The highlight clears when the mark clears.
- **S4 Invisible elements.** (verbatim, L2): "Si el elemento está oculto o fuera de pantalla, como el «Saltar al contenido», la tarjeta lo dice: «Este elemento está oculto o fuera de pantalla; aparece al recibir foco». Así no parece que «Mostrar» haya fallado." Detected by the artboard's inspector (zero-size, clipped, or outside the artboard's viewport) and reported with the issue; no mark is drawn for it.
- **S5 Docs, i18n, a11y, tests.** Every new string in both catalogs (EN/ES, neutral Spanish); docs/gentle-shell.md (Accessibility checks paragraph) describes it; tokens only; mark animation only under `prefers-reduced-motion: no-preference`; tests through the fake-DOM harness in tests/design-canvas-assets.test.ts.

## Tasks

- [x] T1 S1-S5 — canvas mark, zoom on Show, linked card, hidden-element note, docs, tests. Route: gentle-ai-worker (context backstop). Commit: 50a3fd1ce
- [x] T2 S1-S5 — parent re-run of the suites, browser visual check, commit. Route: inline. Commit: 50a3fd1ce

## Log

- L1 (user, verbatim): "cuando en la parte derecha le doy a mostrar seria bueno que se marcase el area a la que se refiere la comprobacion y el consejo"
- L2: Diagnosis: Show already pans and posts gd:highlight, and inspector.js draws a 2px box inside the iframe, which scales with zoom (invisible at 19%); Show never zooms; `body > a` is an off-screen skip link. Proposal of 4 points (quoted in S1-S4); user (verbatim): "si".
- L3: T1 by gentle-ai-worker (mvuu0lt0-2-rkgg): RED 12/12 new tests; GREEN assets 312/312. Parent re-run: assets+server+gentle-design+handoffs 497/497, diff --check clean. Browser check (scratch design with a skip link and small targets, Spanish): hidden note on both skip-link cards; Show on a 20px button zoomed 21%→100%, centered, red ring with label, card aria-current; advice card gives an amber ring; Esc clears ring and card. Known gap accepted as follow-up: the ring uses the rect measured at check time, so an element scrolled inside a tall artboard can be off the ring.
