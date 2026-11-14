# Herdr tower spikes
Prove, in a real Herdr app, that the chosen tower design (`design/herdr-gentle-shell/11-tower-painted.html`, brief in `design/herdr-gentle-shell/SPEC.md`) can be built as a Herdr mod.
Branch `design/herdr-gentle-ui`. Spike code lives in `~/.config/herdr-app/mods/tower-spike/` (user-authorized local install of Herdr 0.1.15 + hc 0.1.21); findings are recorded in `design/herdr-gentle-shell/SPIKES.md`.

## Specs
- S1 "Sprite frame animation: strip image in an `overflow_hidden` box stepped by `cx.timer`, or a colour bitmap font with `.frames()`" — pass when "15 animated characters at 8 fps stay smooth, low CPU".
- S2 "Painted PNG quality: ×2 scaling stays crisp (no smoothing)" — pass when "`herdr-app shot` matches the artboard".
- S3 "Data feed: the mod reads a session's tasks, subagents, questions and cost" — pass when "live updates within 1 s, no busy polling".
- S4 "Talking: the intercom sends text and choices to the right pi session and shows replies" — pass when "a question answered from the intercom resumes the agent".
- S5 "Overlays: intercom, task list, viewer and question panel as `openOverlay` windows" — pass when "open, focus, Esc to close, keyboard 1–9".
- S6 "Viewer: render a Mermaid diagram and Markdown inside a mod" — pass when "the token-refresh diagram and `plan.md` display correctly".

## Tasks
- T1 S1 sprite frames via `.frames()` — inline — done: mechanism pass, CPU fail (L10)
- T2 S2 painted PNG crispness at ×2 — inline — done: pass with pre-scaled ×4 nearest assets (L11)
- T3 S5 overlays + keyboard — inline — pending
- T4 S6 Markdown (`TextView.markdown`) + Mermaid as SVG/PNG — inline — done: pass with notes (L12)
- T5 S3 data feed from Gentle Shell — inline — pending
- T6 S4 intercom → pi session — inline — pending
- T7 Record evidence in SPIKES.md, commit — inline — pending

## Log
- L1 (user, 2026-11-14): "dale" to "Siguiente paso: correr las 6 pruebas técnicas en un Herdr real… ¿Lo hacemos?", then "dale, instalame herdr desktop".
- L2: Herdr app 0.1.15 installed via the official install.sh (sha256 + Developer ID Herdr, Inc. verified); `herdr-app status` shows no errors.
- L3: AGENTS.md: "Animate natively, never with a timer"; `.frames()` is text-only and stepped; `.loop()` is continuous (~30 fps). So S1 must use a colour font with `.frames()`; `TextView.markdown` exists for S6.
- L4: First font lacked name IDs 3/4/6; GPUI panics in `CTFont::display_name` (`expect_failed`) and Herdr aborted 3 times (crash reports 22:18:49, 22:19:24, 22:19:54). Root cause proven: CoreText cannot open that font at all. Fix: full name table (family, full, PostScript, unique id, version). Faulty font quarantined in /tmp/tower-spike/quarantine.
- L5: With the fixed font Herdr stays up through 3 focus cycles, `herdr-app status` errors [] , overlay + 15 `.frames()` + 8 `.loop("left")` run at ~9–12% CPU of the app process. But glyphs render as missing-glyph boxes although CoreText finds glyph U+E000 and reports the colour-glyphs trait: GPUI does not draw sbix colour glyphs from a non-emoji mod font. S1 option (a) as built fails.
- L6: Next attempt: layered monochrome glyph fonts (one outline glyph per frame per colour layer: outline, skin, hair, shirt, pants), each layer an element tinted with `text_color` and animated with `.frames()` on the shared clock, stacked absolutely. Then compare CPU with a no-animation baseline.
- L7: Layered monochrome font (TowerPix, 6 colour layers × 12 frames, outline glyphs) with PUA codepoints: still missing-glyph boxes. Control test: the win98 mod's "PxPlus IBM VGA 8x16" renders in the same overlay, so mod fonts do load in overlays. Remapped the 72 glyphs to ASCII 0x21–0x68: layers now render tinted per element, but several characters fall back to the UI font (letters like R, M, ")" appear), so GPUI's per-character font choice is not reliable for this font yet. Cause unknown; next check: which codepoints fall back, cmap formats, glyph names, and whether `.frames()` text keeps `font_family`.
- L8: CPU of the Herdr app process (8 s samples): 15 layered sprites animated (90 `.frames` layers + 8 `.loop`) ≈ 15–20 %; same overlay static ≈ 0.1–0.3 %; no overlay ≈ 0.1 %. Animation cost is real; the final design must cap animated sprites or lower the frame rate.
- L9: Probe grid showed every TowerPix character falling back to the UI font: Herdr/GPUI ignored the fontBuilder-made TTF entirely. Rebuilding the same glyphs on top of the win98 template (PxPlus IBM VGA 8x16, renamed TowerPix, glyphs scaled to its 1600 UPM) makes all 72 glyphs render. Scripts: design/herdr-gentle-shell/spikes/{mklayers.py,fromtemplate.py,main.layers.js}.
- L10: S1 verdict — mechanism PASS: 15 characters × 6 tinted layers stepped natively by `.frames()` (walk 8 f @125 ms, type 4 f @170 ms) render in colour and animate (two shots 0.4 s apart differ), one font for every shirt colour. Cost criterion FAIL: 14–18 % app CPU vs 0.1 % static. Design rule: animate only the shown floor, ≤3 layers per sprite or ≤6 fps, idle poses static.
- L11: S2 verdict — `image()` upscales with linear filtering: a 360×225 PNG shown at ×2 (720×450 logical, ×4 device on retina) is blurred. Pre-scaling the PNG ×4 with nearest-neighbour and drawing it 1:1 in device pixels is crisp (dither pixels sharp in `herdr-app shot`). PASS with the rule: ship art pre-scaled to device resolution, never let GPUI upscale.
- L12: S6 verdict — PASS with notes: a Mermaid-style diagram saved as SVG renders fully through `image()` (boxes, arrows, text, pink fix path); `TextView.markdown` renders headings and lists but uses the Herdr theme colours, ignoring the container's `text_color`, so it must sit on a theme surface (not the parchment page) or be styled. Converting real Mermaid source to SVG (e.g. mermaid-cli through `exec`) is not tested yet.
- L13: Pending after this session: T3 (S5 overlays + keyboard), T5 (S3 data feed), T6 (S4 intercom → pi), T7 (SPIKES.md). Local test artefacts outside the repo: ~/.config/herdr-app/mods/tower-spike/, ~/.config/herdr-app/fonts/TowerPix.ttf, /tmp/tower-spike/.
