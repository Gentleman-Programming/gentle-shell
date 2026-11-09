# Canvas UX quick wins: clearer for users with basic computer knowledge

Objective: the first round of the UX review: comment inside a direction, hide technical detail by default, plain wording, and one Comments tab. The structural reorganization (steps indicator, panel regrouping, first-run guide) comes after, designed with gentle-design.
Branch: `feat/canvas-ux-quick-wins` (from local `main` d0f62d289). Work-unit commits only; push/PR are the user's decision.

## Specs

- **S1 Comment inside a direction.** Approved review (verbatim, L2): "Vista general = comparar. Un clic en una propuesta la abre en modo foco, como ya hace hoy en modo Navegar. Dentro de la propuesta = revisar. Ahí, a tamaño real, aparecen «Comentar» y «Añadir a la mezcla». Si alguien pulsa Comentar en la vista general, el primer clic abre esa propuesta en foco en lugar de elegir un elemento minúsculo." Comment mode stays on after entering focus, so the next click picks an element. Hover in overview + comment mode shows no element box or inspector (only the shield hint naming what a click does). Picking in focus mode, sizes view and Compare keeps working as today.
- **S2 Technical details off by default.** (verbatim, L2): "El inspector técnico solo bajo petición: un interruptor «Detalles técnicos», apagado por defecto y guardado en el navegador." Off: no token inspector panel on hover, and no CSS selector chips on comment, resolved, check and mix cards (the excerpt/label stays). On: everything as today. A toggle button in the top bar (aria-pressed, icon + label "Technical details" / «Detalles técnicos»), saved in `localStorage` `gentle-design:technical` (tolerate storage that throws), applies at once.
- **S3 Plain wording.** (verbatim, L2): "«A11y ✓» lo cambiaría por «Accesible ✓». «Encargo», «Acumular» y «Artboards» no los entiende un usuario básico. Propongo «Petición original», «Guardar para enviar luego» y «Propuestas»." EN: "Accessible ✓", "Original request", "Save to send later", "Directions". Plus the footer (verbatim, L2): "Le pondría una frase visible: «Tus comentarios se envían al agente para que cambie el diseño», con el estado: «2 pendientes de enviar»." EN: "Your comments go to the agent so it changes the design" and "{n} waiting to be sent" (plural-safe; hidden at 0). Agent-bound messages stay English and unchanged.
- **S4 One Comments tab.** (verbatim, L2): "Comentarios (abiertos y resueltos en una sola lista con filtro)". The Resolved tab goes away; the Comments tab gets a two-option filter "Open (n)" / "Resolved (n)" («Abiertos» / «Resueltos»), Open by default; everything the Resolved tab did (reopen, counts, a pin click landing on its card) still works through the filter. The tab count shows open comments.
- **S5 Docs, i18n, a11y, tests.** Both catalogs (neutral Spanish, tú forms); docs/gentle-shell.md and README Gentle Design row follow the new words and behavior; tokens only; keyboard reachable; tests through the fake DOM; existing tests updated only where these specs change the expected behavior or text.

## Tasks

- [x] T1 S1-S2, S5 — comment opens focus, technical details toggle. Route: gentle-ai-worker (context backstop). Commit: 9821caccd
- [x] T2 S3-S5 — plain wording, footer sentence, one Comments tab. Route: same worker after T1. Commit: 9821caccd
- [x] T3 — parent: suites, browser check, commits. Route: inline. Commit: 9821caccd

## Log

- L1 (user, verbatim): "quiero que hagas una investigacion de como mejorar la usabilidad ux para cualquier usuario con conocimientos basicos o avanzados de informatica y ux. me da la sensacion de que vio algo lioso que se puedan poner comentarios desde aqui … no seria mejor añadirlos cuando se este dentro de la propuesta?que opinas si fueses un usuario basico con conocimientos de informatica?que te falta o que ves lioso?"
- L2: Heuristic review delivered (quoted in S1-S4). User (verbatim): "adelante con los arreglos rapidos y luego vamos a por la propuesta de reorganizacion".
- L3: Worker mvuzlsaz-5-wrd6: RED T1 5 tests, T2 4 tests (+2 docs tests); GREEN 556/556 across canvas/server/gentle-design/handoffs/comments, typecheck no regressions. Accepted decisions: overview chip «Haz clic en una propuesta para abrirla y comentar · Esc»; system board also opens focus in Comment mode; «artboard» stays in frame titles and error sentences; popover title keeps file · selector. Parent: 556/556, diff --check clean; browser check (Spanish): Propuestas · 3, shield hint opens focus with Comment kept on, Detalles técnicos toggle in the bar shows/hides card selectors and persists, Abiertos/Resueltos filter with Reabrir, footer sentence. T1 and T2 share files, committed together. Minor: «Guardar para enviar luego» nearly touches the segmented control edge in a 350px panel.
