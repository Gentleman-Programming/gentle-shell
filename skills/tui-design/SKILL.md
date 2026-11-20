---
name: gentle-ai-tui-design
description: "Trigger: terminal UI design, TUI redesign, Gentle Shell look, IDE in a terminal, sidebar/status bar polish, critique TUI. Refine terminal UIs with visual proof."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## Activation Contract

Use for designing, reviewing or refining a terminal interface (panels, rails, status bars, cards, prompts), especially Gentle Shell. The target feel is an IDE inside a terminal: dense, calm, developer-first, never a costume of retro TUI chrome. Not for web pages (use `gentle-design`).

## Hard Rules

- Never judge a terminal UI from code or memory: capture it (`references/visual-loop.md`) and look at the PNG before and after every change.
- Read `references/terminal-craft.md` before any UI edit; it is the floor, not a suggestion.
- Operate mode: familiarity beats expression. Use IDE vocabulary (panes, tree, tabs, status bar, command palette); the brand lives in palette, density and one signature move.
- Every row costs. Hierarchy comes from color role, weight and alignment, never from blank rows or nested boxes.
- Say each fact once per screen. Data shown in the header never repeats in a panel.
- One command, one target. Refinement preserves the system; redesign replaces it. Never polish a look being thrown away.
- Rendering stays cheap: no I/O or recomputation in render paths, cache keyed on everything that changes output (style, width, theme).
- Mockups (via `gentle-design`) must be terminal-expressible: monospace cell grid in `ch` units, only fg/bg colors, bold/dim/italic/underline/strikethrough, box-drawing and glyphs.

## Decision Gates

| Ask | Command | Load |
|-----|---------|------|
| No product/design context yet | `document` | `references/design-doc.md` |
| New surface or redesign | `shape`, then mockups, then implement | `references/commands.md` |
| "How does it look / what is wrong" | `critique` | `references/critique.md` |
| Too busy, wasted space, redundant | `distill` / `layout` / `quieter` | `references/commands.md` |
| Flat, no hierarchy, unreadable | `typeset` / `colorize` / `bolder` | `references/commands.md` |
| Edge cases, narrow terminals, long text | `harden` / `adapt` | `references/commands.md` |
| Final pass before commit | `polish` | `references/commands.md` |

## Execution Steps

1. Load `DESIGN.md` context if the project has one; otherwise propose `document` first.
2. Capture the current state with the visual loop at the shipped sizes (wide 180x50, breakpoint 140, narrow 80x24).
3. Run the chosen command against one named target; write findings before changing code.
4. Change, re-capture, compare against the previous PNG and the brief; iterate at most 3 rounds, then report.
5. End every refine command with `polish` checks and the repository's focused tests (render counts, overflow).

## Output Contract

Return: target, command run, before/after PNG paths, findings fixed with P0-P3 tags, findings left open, and checks run.

## References

- `references/terminal-craft.md`: floor rules and terminal anti-patterns.
- `references/commands.md`: command playbooks adapted to terminals.
- `references/critique.md`: scored critique and severity rubric.
- `references/design-doc.md`: DESIGN.md shape for a terminal product.
- `references/visual-loop.md`: screenshot harness and comparison loop.
- `NOTICE.md`: attribution.
