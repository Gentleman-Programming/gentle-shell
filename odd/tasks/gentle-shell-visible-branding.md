# Gentle Shell visible branding

## Objective and scope
Replace Gentle-Pi with Gentle Shell in the startup ASCII logo and sidebar title, retaining the rose, pink palette, animation and responsive behavior. Package names, commands and other branding surfaces are excluded. User explicitly approved the real interface in the local gentle-pi repository. Preserve unrelated dirty lib/shell-card.ts and tests/shell-card.test.ts.

## Tasks and acceptance
- [x] T1: Update sidebar title and startup artwork with matching animation spans; add focused regressions. Both surfaces display Gentle Shell without altering styling or package identity. Shell must match Gentle's dense connected script rhythm: neighboring entry/exit strokes meet, with a normal word gap after Gentle rather than expanded internal tracking. The user accepted spacing and general artwork; the remaining correction is a recognizable lowercase e in Shell, with a loop/counter, crossbar and clear boundary before l. Do not widen the word or alter other glyphs. Acceptance of the corrected e remains the user's.
- [x] T2: Run focused checks and inspect final diff; report actual proof and limitations. Parent spot check and independent verifier each observed 9 passes, 0 failures; git diff --check passed. Parent inspected the scoped final diff.

## Checks
Strict TDD verified directly in openspec/config.yaml: strict_tdd: true; runner pnpm test. No configuration conflict. Observe focused RED before implementation, then GREEN and refactor if needed.
Focused command: node --experimental-strip-types --test tests/startup-banner.test.ts tests/shell-sidebar-banner.test.ts
Final check: git diff --check

## Authorized edit surfaces
extensions/startup-banner.ts
lib/shell-sidebar-banner.ts
tests/startup-banner.test.ts
tests/shell-sidebar-banner.test.ts
tests/shell-sidebar-layout.test.ts
odd/tasks/gentle-shell-visible-branding.md

## Progress
T1 corrected after parent readback rejected the initial five-row block font as a design mismatch. Using the original HEAD artwork and supplied screenshot as the visual baseline, the original Gentle script and descending G are restored across eleven rows. Only the old -Pi suffix is replaced with a handcrafted slanted Shell suffix, including looped ascenders and dark ▒ shadows. After the latest connected-script adjustment, eleven variable-width animation regions cover the 117-column ink bounds (columns 3–119). Sidebar literal remains ✿ Gentle Shell ✿. Rose artwork, palettes, commands, package identity and responsive rendering logic are unchanged.

The logo width is now 120 columns (previously 126, initially 140); the eleven-row height is unchanged. It uses the existing stacked layout at 160 columns and side-by-side layout at 200 columns. No new responsive policy was introduced. Final visual acceptance remains with parent readback; no live terminal screenshot was captured.

Observed focused RED: node --experimental-strip-types --test tests/startup-banner.test.ts tests/shell-sidebar-banner.test.ts exited 1 with 3 intended branding failures and 6 passes before source edits.
Initial focused GREEN: the same command exited 0 with 9 passes, 0 failures, but parent readback subsequently rejected the artwork style.

Correction RED: the focused command exited 1 with 1 intended failure (5 rows instead of the required original 11) and 8 passes before the script correction. A further span-bound regression exposed the final shadow column (last span 12 instead of 13); corrected before final GREEN.
Correction GREEN: the focused command exited 0 with 9 passes, 0 failures. Regressions protect original Gentle prefixes, eleven-row silhouette, Shell stroke signatures, dark shadows, looped l ascenders and exact variable-width span coverage. Runtime checks cover dark pink shadow rendering, rose/logo toggles, cyan styling, widths 40/80/160/200, resize modes and animation cleanup; sidebar tests cover exact-fit and below-fit widths plus theme changes. No unrelated refactor was performed.
Final git diff --check exited 0. Full pnpm test and live visual testing were not run; only the authorized focused checks were executed. Worker model: gpt-6-astra; effort: low.

Kerning correction: the user's latest screenshot showed excessive separation, especially S–h. Shifted S two columns left to modestly reduce the word gap; shifted h a further six columns left, and e/first l/final l a further two columns each. The row-five S–h gap is now two columns instead of eight, and h/e exit strokes meet. The adjacent l shadows overlap by one cell without removing a foreground stroke. Original Gentle, rose, palettes, slant and glyph scale remain unchanged.

Kerning RED: the focused command exited 1 with the intended width failure (140 instead of 126), with 8 passes. During GREEN, the old global l-exit substring count also matched the newly connected h/e stroke; scoped that assertion to the final two l exits. Final focused GREEN: 9 passes, 0 failures. Regressions now protect the 126-column width and compact baseline kerning as well as script/shadow signatures and span coverage. No live rendering or user visual acceptance is claimed.

Connected-script adjustment: the user requested spacing like Gentle rather than another arbitrary reduction. Kept Gentle and the word gap untouched. Shifted h/e two columns left, first l four columns left, and final l six columns left relative to the 126-column version. S now meets h through a foreground entry stroke, e meets the first l, and the two l exits join through a rising flourish with a continuous dark shadow underneath. The existing h/e connection remains. Ascender shadows merge where the letter regions overlap; glyph scale, slant and looped tops remain.

Connected-script RED: focused command exited 1 with the intended missing l-to-l connecting-stroke failure and 8 passes. GREEN: the same command exited 0 with 9 passes, 0 failures. Updated regressions require the S/h, h/e, e/l and l/l connections, 120-column width and exact eleven-span coverage. git diff --check exited 0. No full suite, native review or live visual testing was run. User visual acceptance is still pending; the latest screenshot was inspected as the baseline, not as evidence for these new bytes.

Lowercase-e readability correction: the user accepted compact spacing and general artwork but could not identify Shell's e. Using Gentle's looped e as the reference, changed only columns 93–100 in artwork rows 3–5: replaced the wedge with a loop/counter, crossbar and curved lower exit. A blank cell before l on the upper two rows separates its stem from the e; their lower exit remains connected. All other artwork cells, word gap, glyph positions, shadows outside the e, palettes and animation spans are unchanged. Width stays 120 columns, ink bounds 117 columns, height 11 rows.

Readability RED: focused command exited 1 on the intended e-shape mismatch (old wedge versus loop/crossbar/exit), with 8 passes. GREEN: the same command exited 0 with 9 passes, 0 failures. Existing checks retain connected neighbors, original Gentle, dark pink shadow, responsive layouts and cleanup. No full suite or live visual test was run; the corrected e still requires visual confirmation. The memory mirror remains pending.

T2 completed: parent inspected the scoped final diff and reran focused tests (9 passed) plus git diff --check; independent read-only verification likewise passed with no concrete regression. Unrelated lib/shell-card.ts and tests/shell-card.test.ts changes were preserved. Full suite and latest-e visual acceptance remain unverified. Native assessment returned unavailable (empty output); independent verification ran as required. Native review was not started: inspection included unrelated shell-card changes, which are outside this task's scope. No approval receipt is claimed.

Engram mirror pending: parent reported that the active runtime session belongs to gentle-ai and rejects gentle-pi saves. No replacement session identity was created. User visually approved the corrected e and final artwork ("ahora si!!! me encanta") and authorized PR publication and merge after CI using the current gh session. Approved issue: https://github.com/Gentleman-Programming/gentle-shell/issues/1104. Next: publish scoped PR, merge only after CI passes, and synchronize the mirror in the correct project session. Full local suite remains unrun; CI is the full-suite delivery check.

PR: https://github.com/Gentleman-Programming/gentle-shell/pull/1105. Initial CI failed two integration assertions in tests/shell-sidebar-layout.test.ts because they still expected Gentle-Pi (2609 passed, 2 failed, 38 skipped). Updated only the four old title literals, preserving ordering and geometry assertions. Expanded focused command includes tests/shell-sidebar-layout.test.ts: 25 passed, 0 failed; git diff --check passed. CI rerun remains required before merge.
