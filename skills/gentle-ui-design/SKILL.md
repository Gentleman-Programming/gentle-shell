---
name: gentle-ui-design
description: "Trigger: product interface design, web UI, design critique, browsing experience, responsive layout. Guide usable interfaces for the current project."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## Activation Contract

Use for web and product interfaces when shaping, implementing, or assessing a user experience. Use `gentle-design` for its HTML artboard workflow and `gentle-ai-tui-design` for terminal interfaces.

## Hard Rules

- Keep a read-only critique read-only; do not install tools or dependencies for this guidance.
- Establish the user's job and success condition before appearance. Ask only when missing intent would materially change a decision.
- Reuse the project's brand, components, and platform conventions; avoid universal aesthetic bans.
- Do not invent evidence or conceal inaccessible controls. Model real content ranges and states; this guidance adds no hooks, detectors, or mandatory tool chains.

## Decision Gates

| Need or symptom | Load and apply |
| --- | --- |
| Unclear purpose, weak copy, or generic direction | `references/task-and-content.md` |
| Search, large collections, or difficult comparison | `references/browse-and-compare.md` |
| Flat hierarchy, clutter, or weak feedback | `references/composition-and-feedback.md` |
| Narrow screens, input access, or missing states | `references/adaptive-interfaces.md` |

## Execution Steps

1. Identify the audience, primary job, constraints, and likely content sizes; inspect existing project conventions when available.
2. Load only the relevant references and select defaults or justified exceptions for the task.
3. Apply the project's visual language and account for touch, keyboard, focus, contrast, and reduced motion.
4. Inspect visually when useful and authorized; report observations rather than implying an inspection occurred.

## Output Contract

Summarize design choices and tradeoffs, files changed if any, checks actually performed, and important unknowns.

## References

- `references/task-and-content.md` — purpose, information architecture, art direction, and truthful copy.
- `references/browse-and-compare.md` — search, collection scale, comparison, and navigation state.
- `references/composition-and-feedback.md` — hierarchy, density, color, type, and visual feedback.
- `references/adaptive-interfaces.md` — responsive behavior, accessible interaction, and states.
