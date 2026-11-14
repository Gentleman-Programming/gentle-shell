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
- T1 S1 sprite frames via `.frames()` — inline — in progress (sbix colour font fails; next: layered monochrome glyph fonts)
- T2 S2 painted PNG crispness at ×2 — inline — pending
- T3 S5 overlays + keyboard — inline — pending
- T4 S6 Markdown (`TextView.markdown`) + Mermaid as SVG/PNG — inline — pending
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
