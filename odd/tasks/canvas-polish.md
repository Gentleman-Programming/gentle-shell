# Canvas polish (impeccable)

Polish pass over the Gentle Design canvas (`assets/design-canvas/`) with the impeccable skill, before the chained PRs.
Refinement only: the Gentle identity in `design/system.md` stays (brand fonts, palette, layout); behavior and copy stay unless a defect.

## Specs

- S1: "usa la skill impleccable para corregir todos los detalles que veas, esta parte le he dedicado mucho amor y quiero que se aprecie asi cuando la gente lo utilice"
- S2: Every fix keeps the existing tests green and adds a test when it changes observable behavior; docs follow any visible change.

## Tasks

- T1 [S1] Evidence: walk the canvas at 1728, 1280 and 1024 wide (overview, focus, comment, panel tabs, help, menus, dialogs, compare, history, offline, error) and list every defect by priority. Route: inline. Commit: none (findings in Log).
- T2 [S1, S2] Fix the findings, one commit per area. Route: inline. Done: cbf6b9fee (F2), 07dbaa287 (F1, F3, F6-F8), 57c9c43e1 (F4, F5).
- T3 [S1, S2] Run the impeccable detector once over the changed files, re-walk the path, full gentle-design tests, typecheck. Route: inline. Done: detector fix in b37c59bfd; 641/641 gentle-design tests, typecheck clean, console clean.

## Log

- L1 (user, 2026-10-31): "mientras preparamos la pr, usa la skill impleccable para corregir todos los detalles que veas, esta parte le he dedicado mucho amor y quiero que se aprecie asi cuando la gente lo utilice"
- L2: impeccable context: no PRODUCT.md / DESIGN.md; scoped polish on existing code proceeds with `design/system.md` as the visual authority. Mode: Operate.
- L3 (T1 findings, screenshots in odd/checks/canvas-polish/, design canvas-features with a chosen implemented direction):
  - F1 P0 Top bar: every item shrinks below its text and overflows into its neighbor (design select over the steps, Compare with app over Comments, Connected over Compare) at 1728 with a chosen direction, and always at 1280 and 1024. No responsive rule exists in canvas.css.
  - F2 P1 Console: the canvas CSP frame-src lists `http://[::1]:*` and `https://[::1]:*`, which Chrome rejects as invalid (2 errors per load); IPv6 literals are not valid CSP host sources, so they were already ignored.
  - F3 P1 Focus: a discarded direction stays dimmed and grayscale while you review it in focus (the overview dimming applies to the focused board).
  - F4 P1 Focus: the canvas cannot pan in focus mode, so the right part of an artboard wider than the viewport (a 1440 desktop on a 1280 laptop) is unreachable. Needs a product decision (scale to fit, pan, or narrower frame).
  - F5 P2 Compare side by side at 1280 shows only the design; the app pane is off screen unless Fit to window is checked.
  - F6 P2 The mode chip collides with Back to canvas (focus, panel open, 1280) and hides under the minimap (overview, 1024).
  - F7 P2 Browser surfaces not themed: default gray scrollbars (nav, panel), default checkbox in Compare, default text selection.
  - F8 P2 Quality header count pill ("2 comprobaciones") wraps to two lines.
  - F9 P3 Comment popover header ("Comentar en <file> · <selector>") is cut without an ellipsis.
  - F10 P3 Help card: an uppercase eyebrow above the heading (impeccable craft floor bans eyebrows); the step count can live in the card's footer.
  - F11 P2 Overview at 1024: Fit leaves the right artboards under the review panel edge (to confirm after F1). Dropped: it is the 5% zoom floor, not a fit error.
  - F10 dropped: the help card's eyebrow comes from the approved canvas-reorg artboard (the brief wins over the craft floor).
- L4: commits cbf6b9fee (CSP [::1], F2) and 07dbaa287 (F1, F3, F6, F7, F8 and a name on the custom width field). Slice boundary: these two commits close the first canvas-polish slice; the branch as a whole ships as the planned chained PRs.
- L5 (user decisions, 2026-10-31): F4 "Escalarla para que quepa (Recomendado)": in focus, an artboard wider than the room keeps its real width and is drawn smaller (like All sizes), the zoom shows the percentage; at 100% when it fits. F5 "Sí, ajustar solo cuando no caben (Recomendado)": Compare starts with Fit to window on only when the two panes do not fit at 100%, and it can be unchecked.
- L6 (T3): impeccable detect over index.html and canvas.css: 5 warnings. Fixed: side-tab on .gd-comment-reply and .gd-version-reply (colored 2px left stripe on callouts) -> wash card, green label kept. Kept: .gd-nav-item-chosen 3px inset edge (specified in design/system.md, part of the identity); broken-image is the attach-screenshot preview filled at runtime inside a hidden figure (from upstream); flat-type-hierarchy is unreliable here (the detector could not resolve the {{BASE}} stylesheet) and the 14/16 px scale is the system's. Re-walk: bar measured at 1024-1920 with and without a feature path and with Not connected (no overlap, Show never cut); focus fits a 1440 artboard (83% at 1280, 57% with the panel); Compare starts fitted; console clean.
