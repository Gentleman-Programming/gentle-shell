---
name: gentle-design
description: "Trigger: design a screen or page, mockup, landing page, UI directions, artboards, try a different approach, design system sync. Write self-contained HTML design directions under design/<slug>/."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## Activation Contract

Use this skill by default whenever the user asks, in plain words, for a UI design, mockup, screen, landing page, or visual directions, or iterates on artboards under `design/`. Do not use it to implement production code in the project's stack.

The `/gentle:design` commands are optional shortcuts: every action also works from a plain request, through this skill and the `gentle_design` tool (`list`, `open`, `stop`, `implement`, `handoff`).

## Hard Rules

- Every artboard is one self-contained HTML file: inline CSS, JS, and SVG; system font stacks only. Never reference external URLs, CDNs, remote fonts, images, or scripts.
- Use realistic content for the audience; no lorem ipsum or placeholder names.
- Accessible markup: semantic elements and landmarks, WCAG AA contrast, visible focus styles, `prefers-reduced-motion` respected for any motion.
- When `design/system.md` exists, read it first and use only its tokens and component rules; run the Self-check from "Design system sync" before finishing any artboard.
- Ask at most one clarifying question, and only when the brief lacks the goal or the content.
- Iterating edits only the targeted artboard. Never rewrite the others.

## Decision Gates

| Situation | Action |
| --- | --- |
| New brief | Write N clearly different directions (3 by default, or the number asked) to a new `design/<slug>/` |
| Feedback on one artboard | Edit that file only; keep its manifest entry, update `tradeoff` if it changed |
| "Save and try a different approach", or a canvas message "Add another direction to the design …" | Add a new artboard with the next `NN`, starting from the named source artboard when there is one and applying "What should change"; keep previous ones; append it to the manifest |
| A canvas message "Implement only one part of the design artboard …" | Build only that element in the project's real stack (a shared layout or component when the app has one), using the artboard as its visual spec; leave the rest of the artboard unbuilt and do not choose the direction (never call `implement` for it). Report with `action "handoff"`, the message's `target` and `part`: `status: "in_progress"` when you start, `status: "implemented"` with a one-line note on where it lives |
| User wants to tune values (spacing, color, type scale) | Add sliders or controls in the artboard plus a "Copy as prompt" button that copies the chosen values as a prompt |
| `design/<slug>/` already exists for a new brief | Pick a new slug; never overwrite another design |
| A message carries design comments, or the user asks to apply them | Follow "Canvas comments" below |
| `/gentle:design sync`, or the user asks to capture the project's design system | Follow "Design system sync" below |
| The user asks to show, stop, or list designs, or to implement an artboard | Call the `gentle_design` tool (`open`, `stop`, `list`, or `implement` with `<slug>/<artboard>`); follow the handoff text `implement` returns, and report progress with `action "handoff"`: `status: "in_progress"` when you start, `status: "implemented"` when done, with `previewUrl` set to the running app's loopback URL when one is running |

## Before designing

Run this gate before every new brief: call the `gentle_design` tool with `action: "list"`, then:

| `list` reports | Action |
| --- | --- |
| `system.exists` false and `designSources` present | Run "Design system sync" first, tell the user in one line that you synced the project's design system, then design with it |
| No `designSources` | Skip the sync and design freely |
| `system.staleSources` present | Name those sources, say `design/system.md` may be outdated, and offer to sync again before designing; re-sync only with the user's OK, and never use the stale tokens silently |

## Execution Steps

1. Take the brief: goal, layout, content, audience.
2. Load `gentle-ui-design`: read its `SKILL.md` and only the references that match the brief's audience, primary job, and success condition. This skill owns delivery; that one owns UX quality.
3. Choose a kebab-case slug from the brief.
4. Make the directions differ in structure or visual strategy, not only in color. Label each with the tradeoff it makes.
5. Write `design/<slug>/NN-<name>.html` per artboard (`01-…`, `02-…`; kebab-case name).
6. Write `design/<slug>/design.json`:

```json
{
  "title": "Pricing page",
  "brief": "Pricing page for a note-taking app aimed at students",
  "feature": "odd/tasks/pricing-page.md",
  "artboards": [
    { "file": "01-comparison-table.html", "title": "Comparison table", "tradeoff": "Dense and scannable; weaker emotional pull", "width": 1440, "height": 900 },
    { "file": "02-single-plan-hero.html", "title": "Single plan hero", "tradeoff": "Strong focus; hides plan differences", "width": 1440, "height": 900 }
  ]
}
```

7. Set `width`/`height` to the artboard's intended viewport in CSS pixels; keep the manifest in sync with the files on every change. Fields: `title`, `brief`, optional `feature`, and `artboards[]` with `file`, `title`, `tradeoff`, `width`, `height`. The canvas keeps where the user placed each artboard in `design/<slug>/layout.json`; leave that file to the canvas (a new artboard gets a spot of its own).
8. ODD link: when the design comes from a tracked ODD feature (an existing `odd/tasks/<feature>.md` for the current work), set `feature` to that path and append one entry to that document's `## Log` naming `design/<slug>/` and its artboards. When an artboard of that design is handed off to implement, the Log entry also names the chosen artboard (the one handed off; `list` reports it as `Chosen`) and that the others are alternatives. For small untracked work, omit `feature` and leave the design standalone; never create a feature document just to link it.
9. UX self-check, for every artboard you finish: pass it against the `gentle-ui-design` composition-and-feedback (hierarchy, density, feedback) and adaptive-interfaces (narrow screens, input access, states) guidance, and fix every gap before you report.
10. After writing or changing artboards, call the `gentle_design` tool with `action: "open"` and the slug, unless the user said not to. When a canvas tab is already open it refreshes that tab instead of opening a new one, so call it after every change. Report the URL it returns.

## Design system sync

1. Read only, and never edit project source. Sources: CSS custom properties (`:root`, `@theme`, `[data-theme]`), the Tailwind config or v4 `@theme`, component library folders, existing token files, and the fonts they declare.
2. Write `design/system.md`: colors (token name, value, usage), typography, spacing, radius, shadows, and component rules. Each entry names its source `path`. Record only values found in the sources.
3. Write `design/system.html`: one self-contained artboard, 1440 px wide, that renders those tokens (swatches, type scale, spacing, radius, shadows) and the core components, under the same no-external-URL rules. The canvas shows it as the first board of every design.
4. When no design sources exist, say so and propose a minimal starter system for the user to accept; never present invented values as project tokens.
5. Self-check, for every artboard you finish while `design/system.md` exists: list the colors and font families the artboard uses, compare them with the system tokens, and fix every deviation before you report.

The canvas does the same comparison for the user: its token inspector reads the tokens from `design/system.md` (table rows with a backticked `--name` and value, and tokens written inline in a first cell), so keep that file's tables in that shape. The inspector and the canvas's accessibility checks (text contrast under AA, targets under 24 × 24 px, images without `alt`, unlabeled form fields, skipped heading levels) are heuristics, not a full audit: a clean result does not replace your own review, and a flag can be a false positive.

## Canvas comments

Comments from the canvas are stored in `design/<slug>/comments.json`; the session also receives them as messages that name each comment id.

1. Read the open comments with the `gentle_design_comments` tool (`action: "list"`, optional `slug` and `file`). Without the tool, read `design/<slug>/comments.json` and use the entries whose `status` is `"open"`.
2. Apply each comment by editing only the artboard in its `file`; use `selector` and `excerpt` to find the element. When a comment has a `screenshot`, look at it first: it arrives attached to the comment message, or open `design/<slug>/<screenshot>` with the read tool. It shows what the user saw, often a transient animation or transition state that the static artboard does not show. When a comment has a `viewport`, the user made it with the artboard shown at that width (for example `Phone 390 × 844`): edit the artboard so the change holds at that width, with responsive CSS (media queries or fluid sizes) rather than fixed sizes, and keep the artboard's other widths working.
   A comment that starts with "Fix the values on ..." comes from the token inspector: it lists values that are off the design system with their nearest tokens, so use those tokens. A comment that starts with "Accessibility check on ..." (or "Accessibility advice on ...") comes from the Checks tab: fix the finding it names for WCAG 2.2 AA, with the design's tokens.
3. Mark each applied comment resolved with the tool (`action: "resolve"`, `slug`, `ids`, `note`). `note` is one line, at most 500 characters, saying what you changed (for example "Headline cut to 4 words, 32px"); the canvas shows it as "Agent: <note>" on the comment. Without the tool, set its `status` to `"resolved"` and `resolvedAt` to the current ISO time and, optionally, `resolution` to the same line, keeping every other entry and field as is. Leave comments you did not apply open, and say why.
4. Do not make backup copies of artboards (`*-old.html`, `*-v2.html`); edit the artboard in place, and add a file only for a new direction.

The file format, for agents that only have file access:

```json
{
  "version": 1,
  "comments": [
    { "id": "k3x9p2ab", "file": "02-bold.html", "selector": "body > header > h1", "excerpt": "Ship faster", "comment": "Make the headline shorter.", "createdAt": "2026-10-26T10:00:00.000Z", "status": "open", "sentAt": null, "resolvedAt": null },
    { "id": "m7q2w9cd", "file": "02-bold.html", "selector": "#cta", "excerpt": "Start", "comment": "The button jumps during the hover transition.", "screenshot": ".screenshots/m7q2w9cd.png", "createdAt": "2026-10-26T10:05:00.000Z", "status": "open", "sentAt": null, "resolvedAt": null },
    { "id": "p4t8n1ef", "file": "02-bold.html", "selector": ".card", "excerpt": "Pricing", "comment": "The cards overflow on a phone.", "viewport": { "width": 390, "height": 844 }, "createdAt": "2026-10-26T10:10:00.000Z", "status": "open", "sentAt": null, "resolvedAt": null }
  ]
}
```

`screenshot` is optional: a path relative to the design folder, under `.screenshots/`, present only when the user attached an image.

`viewport` is optional: `{ "width", "height" }` in whole CSS px (width 240 to 4096, height 1 to 20000), present only when the comment was made with the artboard shown at a size other than its own. When you add a comment by hand, leave it out unless you mean a specific width; a value outside those limits makes the file invalid.

Never delete or reorder entries, and keep the file valid JSON: the canvas refuses to overwrite a file it cannot parse.

## Output Contract

Return: the slug, each artboard file with its title and tradeoff, which files changed in this turn, the comment ids resolved in this turn, and any open question. Give the canvas URL from step 10, or mention that `/gentle:design open <slug>` shows the canvas when you did not open it. For a sync, return the source paths read, the token counts per group, and whether the system is a proposed starter; after an automatic sync from "Before designing", say it ran and report it the same way.

## References

- `design/system.md` in the project, when present — the design tokens to follow.
- `gentle-ui-design` skill — UX quality guidance paired with every artboard.
