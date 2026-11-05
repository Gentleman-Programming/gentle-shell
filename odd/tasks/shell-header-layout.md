# Shell header layout, density and transparent chrome

Objective: fix issue #2890 and the layout feedback around Header, Density, rail margin and a transparent chrome.
Branch: `fix/shell-header-layout-2890` (worktree `../gentle-pi-2890`, removed with the branch after delivery). Delivery: single PR. Runner: `node --experimental-strip-types --test tests/<file>.test.ts`; suite `pnpm test`.

## Specs

- S1 (#2890): "With **Customization › Layout › Header = `top`**, the header row (model, effort, ctx, cost, usage) still renders **below the input**" / "Expected: The header row sits above the conversation. YOLO shows in the header with its fire icon."
- S2: "el nuevo Layout -> Header -> top no me gustó como quedó. Se ve desordenado y divide la información entre arriba y abajo. Se veía mejor antes, como la versión below-input". Decision (user, 2026-11-05): `top` = full header row (same content as below-input) above the conversation inside its column; the split IDE chrome stays available as a new Header value `split`. Narrow (<140 cols) and Light (Status bottom) keep the compact chrome.
- S3: "Y no hay margen en el top del panel derecho" — the rail gets a plain top margin row under a `top` header.
- S4: "no hay opción de above input o sea, como el below input pero arriba / Pero no del input si no del chat como tal pero dentro de su caja actual. Así se tendría el mismo efecto que el Classic" — covered by S2's `top`.
- S5: "Respecto de Layout->Density, funciona solo para la barra lateral, y no para el contenido de la ventana principal como era antes, compact y minimal no tienen diferencia." Evidence: density never touched the transcript (`git log -S density`); Pi owns message spacing. Decision: minimal differs from compact (no rail top margin, no rail hint row). Assumption: comfortable adds one blank row between the top header and the conversation, and above a bottom status bar ("la barra de arriba y la de abajo no tienen ni un espaciado arriba o abajo y queda muy pegado").
- S6: "me gustaria hacer una version \"transparent\" donde los background se eliminen del sidebar topbar y bottom bar para que esten flotando los elementos, lo que si tenemos que pensar como distinguir los selectores con sus espaciados para que no quede todo asi nomas."
- S7 (report only): on desktop `/gentle:panel` with a terminal background image, part of the background is lost (a dark band top-right). Investigate; fix only if it shares code with this change.
- Constraint: "No hubiera sido mejor poder escoger entre Classic version y IDE version? esto ultimo no lo quiero hacer, tiene que ser lo suficientemente customizable".

## Tasks

- T1 S1,S2,S3,S4 (commit 6822afa94): `split` header value; `top` renders the full header inside the conversation column; rail plain top margin. Route: inline. Status: done (RED 2/3 new layout tests, 2 integration tests; GREEN). Risk tier: medium (adds a config value).
- T2 S1: status bar mode badge keeps its glyph (🔥 YOLO, 💥 SUPER-YOLO). Route: inline. Status: done (RED 2 in shell-panel; GREEN).
- T3 S5: density spacing (minimal: no rail top margin, no hints row; comfortable: blank row under a top header). Route: inline. Status: done (RED 1; GREEN). Split chrome spacing unchanged (user likes it).
- T4 S6,S7 (commit ab0c68e82): Layout → Surface tinted|transparent (`surface`, stored only when transparent in visual-customization.json and profiles). Route: inline. Status: done (RED: policy, layout, gentle-shell, profiles; GREEN).
- T5: Customize copy, layout preview, docs. Route: inline. Status: done for T1-T3.
- T6 S7: investigate panel background report. Route: inline. Status: done — cause is the opaque `customMessageBg` (PANEL_SURFACE_ROLE) painted by `surfaceOpener` in lib/shell-bar.ts:321 (title row/status bar), lib/shell-panel.ts:70 (panel sheet) and lib/shell-sidebar-layout.ts:327 (rail); a terminal background image cannot show through. T4's transparent surface removes it.

## Log

- L1 (user, 2026-11-05): "en un nuevo worktree que luego borraras junto con la rama mira este issue : #2890 tambien esto reporto otra persona: [S2, S5 quotes] Otro user: Opino igual, la versión Classic era más cómoda de ver en la separación de las cosas. Y no hay margen en el top del panel derecho / Y no hay opción de above input [...] No hubiera sido mejor poder escoger entre Classic versión y IDE versión? esto ultimo no lo quiero hacer, tiene que ser lo suficientemente customizable"
- L2: exploration: wide `top` is the intentional IDE split (commit 60dabc22c); YOLO banner is hidden by `statusBarShowsMode` and the status bar paints the raw mode.
- L3 (user): chose "top = header completo + nuevo valor split" and "Hacer minimal distinto + corregir textos".
- L4 (user): S7 report; S5 spacing remark; S6 transparent request; "hazlo todo tu no delegues".
- L5: T1-T3+T5 implemented inline; focused files green (layout 59/59, gentle-shell 321/321, shell-panel 25/25, visual-* 92/92). Wide `top` keeps the titled-rule editor (`panelChrome`), narrow/Light keep the compact chrome for top and split.
- L6: T6 finding recorded above; T4 design: Layout → Surface tinted|transparent stored as `surface` in visual-customization.json (missing → tinted); transparent drops the PANEL_SURFACE_ROLE backgrounds and keeps a blank row between rail sections unless density is minimal; hover stays the orange fg role.
- L7: suite (both slices): 8503 tests, 36 fail only in tests/agent-home, gentle-agents, notification-audio-native, notification-pulse-client, notification-pulse-stream, orchestrator-scope — environmental (GENTLE_PI_CONFIG_HOME in the shell; isolated run identical to origin/main: 4 fail). Typecheck 0 diagnostics after adding `surface` to profile fixtures; runtime modules match.
- L8: rebased on origin/main 5904d8099 (#2892 merged meanwhile). Suite 8515 tests / 8391 pass / 36 fail, identical files and count to origin/main's own run (8505 / 8381 / 36); typecheck 0 diagnostics; runtime modules match. Delivery: single PR (~450 authored lines, two work-unit commits).
- L9: independent verifier (Risk: item 3) found one S6 blocker: with Cards=float the header chrome kept `toolSuccessBg` (floatHeaderPaint, lib/shell-bar.ts) under Surface=transparent. Correction: floatHeaderPaint yields to the outlined path when the surface is transparent; verifier probes committed as tests/shell-surface-transparent.test.ts; orphan JSDoc above storedVisualSettings moved back to writeVisualSettings.
- L10 (user, 2026-11-05): "hay espacio abajo eso es con header below-input y tinted, esto es en transparent misma config [no tiene margenes], en top no esta alineado el sidebar con el top y ademas quiero que tenga el mismo diseño visual que en split solo qeu con los margenes y la misma info, en top se mantiene el espacio abajo del input". Live tmux capture: the two rows under a wide top editor are the titled-rule editor's own bottom row plus the float footer's exterior dock row (extensions/gentle-shell.ts, "Preserve a shrinkable exterior dock row"). Changes: transparent keeps the float header geometry and drops only its background; the wide top header is renderShellTopHeader (panel surface, padding rows, whole header row) and the rail's painted top padding lines up with it; the footer drops its exterior row under a wide top header.
