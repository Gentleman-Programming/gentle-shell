# README polish (second slice of #2191)

Feature-section template, readable folded detail, hero pass, and the remaining screenshots.
Branch docs/readme-polish, stacked on docs/readme-modernize (PR #2192). Closes #2191 when merged.

## Specs

- S1 — "En lo que pedimos una review continuemos con el resto": finish the #2191 scope not covered by PR #2192.
- S2 — Presentation only, as the user set for the whole README work: "no quiero que cambies la informacion, solo su presentacion, estructuracion, organizacion y ordenamiento."
- S3 — Feature-section template from #2191: "Apply one template to feature sections (title, image, pitch, link) and turn long folded paragraphs into short lists."
- S4 — Hero from #2191: "Tighten the hero so the tagline appears once." Removing or merging brand lines needs the user's decision.
- S5 — Screenshots from #2191: background jobs and NaN provider, captured by the user (no fabricated UI).

## Tasks

- T1 — S2,S3 — inline — long `<details>` paragraphs into short lists, sentences kept verbatim — done (verified: text identical apart from list markers and labels)
- T2 — S2,S3 — inline — feature template: one link format, link per feature where a doc exists — done (Background jobs link added; Customize links to Card style and content, the only documented customize category; NaN has no doc page)
- T3 — S4 — inline — hero pass — done: user chose to drop the repeated triad line and merge the two Built for Pi lines
- T4 — S5 — inline — embed background-jobs.png and nan-models.png — blocked: waiting for captures

- T5 — S2,S3 — inline — remaining diagnosis items: Customize split from Command palette, feature titles completed, duplicate installer-preview sentence removed — done

## Log

- L1 — User: "En lo que pedimos una review continuemos con el resto"
- L2 — Decision: stacked branch docs/readme-polish so PR #2192 stays unchanged during review.
- L3 — User chose for the hero: "Quitar 3 y fusionar 4+5 (recomendado)".
- L4 — PR #2192 CI: installer (macos-latest) was cancelled at 15m03s with no failed step (job limit is 20 min); all other checks passed.
- L5 — User: "Si, el punto 5. Podemos hacer push apilado entonces?" New titles reuse facts already in each section; anchors #background-jobs and #nan-model-provider kept with explicit ids.
- L6 — CodeRabbit on #2203: Customize lacked a link although docs/gentle-shell.md documents its Cards category; added a precisely labelled link instead of a generic "Docs →".
