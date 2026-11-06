# README premium diagrams

Redesign the README diagrams in the approved ODD prototype style and add the missing feature images.
Worktree: gentle-shell-worktrees/readme-modernize, branch docs/readme-modernize. Commits only when the user asks.

## Specs

- S1 — "Ayudame a mejorar los diagramas que tenemos, se ven de muy baja calidad, muy poco intuitivos, no se ve premium, etc..."
- S2 — "Me ayudas a generar las imagenes que hacen falta en algunas features?"
- S3 — Style approved by the user on the ODD prototype: "Si, me encanta el estilo, esta excelente!" Every diagram follows `docs/assets/diagrams/odd-workflow.svg`: 1000px-wide canvas, dark gradient card with dot grid and corner glow, small letter-spaced eyebrow instead of a big title, line icons, monospace step pills, pink accent only on the focal elements, system-ui font stack, left-to-right reading.
- S4 — Information is unchanged: diagrams keep the facts already in the README or in the previous diagram; `<title>`/`<desc>` stay accurate; README `alt` text describes the new layout.
- S5 — No fabricated UI screenshots: features that need a real screen (Audio, Background jobs, NaN) get a shot list for the user instead of an invented image.

## Tasks

- T1 — S1,S3,S4 — inline — ODD workflow prototype — done — 51cc40ae2
- T2 — S1,S3,S4 — inline — Focused agents (`agent-orchestration.svg`) — done — 51cc40ae2
- T3 — S1,S3,S4 — inline — Native review (`native-review.svg`) — done — 51cc40ae2
- T4 — S1,S2,S3,S4 — inline — el Gentleman (`gentleman-workflow.svg`, currently unused) redesigned and embedded — done — 51cc40ae2
- T5 — S2,S3,S4 — inline — Measured: before/after chart from the README table data (`measured-routing.svg`) — done — 51cc40ae2
- T6 — S2,S3,S4 — inline — Permission modes: Normal / Auto / YOLO diagram from README facts (`permission-modes.svg`) — done — 51cc40ae2
- T7 — S2 — inline — Command palette: embed existing unused `command-palette.png` — dropped: it shows the removed SDD group; moved to T8
- T8 — S5 — inline — shot list for Command palette, Audio, Background jobs, NaN — command-palette.png and audio-notifications.png captured by the user and embedded in 3ea120a6f; background-jobs.png and nan-models.png still pending

## Shot list (T8)

Common setup: Gentle Shell fullscreen, Gentleman-Cute theme, terminal about 160x45, no personal paths, keys, or account names visible. Export PNG about 1600 px wide, cropped to the terminal, to `docs/assets/features/<file>`.

| File | Open | State to show |
| :--- | :--- | :--- |
| `command-palette.png` | `alt+k` | Groups Configuration, Session, Diagnostics, Skills; one entry highlighted; no search text |
| `audio-notifications.png` | `/gentle:customize` → Notifications | Two-column card with the master switch on and Success, Error, Attention types visible |
| `background-jobs.png` | `/gentle:jobs` | At least one running and one completed job, details pane visible |
| `nan-models.png` | `/gentle:models` | NaN models listed (offline fallback or refreshed list) |

## Log

- L1 — User: "Ayudame a mejorar los diagramas que tenemos, se ven de muy baja calidad, muy poco intuitivos, no se ve premium, etc... ¿Se entiende? / Me ayudas a generar las imagenes que hacen falta en algunas features?"
- L2 — Decision: prototype one diagram first (ODD), then apply the style to the rest. User: "Si".
- L3 — Decision: keep system-ui text instead of converting text to paths (smaller files, accessible, no bundled font licence).
- L4 — User approved the ODD prototype: "Si, me encanta el estilo, esta excelente!"
- L5 — Verified: npmjs.com does not render GitHub alerts (npm/documentation#1240), so callouts use emoji-prefixed blockquotes.
- L6 — Generator kept outside the repo (`/tmp/diaggen/gen.py`); diagrams validated with xmllint and rendered in headless Chrome after the user took over the ego-browser space.
- L7 — Found `command-palette.png` outdated (removed SDD group); not embedded, added to the shot list.
- L8 — User: "Solo pude agregarte 2 imagenes en el directorio que me pediste. El generador de diagramas dejemoslo local por ahora. Genera los commit por unidad de trabajo". Captures found in the main checkout `assets/features/` (palette, audio), copied to `docs/assets/features/`.
- L9 — Work-unit commits: ef0c44d47 (README structure), 51cc40ae2 (T1–T6 diagrams), 3ea120a6f (T8 screenshots). Recorded after CodeRabbit review on PR #2192.
