# DESIGN.md for a terminal product

Keep it at the project root or `design/DESIGN.md`. Describe first, then give the exact value in parentheses, and say where and why each token is used. Add 1-3 named rules per section (`**The One Fact Rule.** ...`). Never overwrite an existing file silently; propose a diff.

## Frontmatter tokens

```yaml
colors:      # roles mapped to theme color keys, not hex literals
  canvas: ...
  rail: ...
  text: { primary: ..., secondary: ..., muted: ... }
  accent: ...
  state: { success: ..., warning: ..., error: ..., info: ... }
  border: ...
roles:       # type roles as attribute combinations
  title: bold + accent
  value: normal
  label: dim
  meta: dim italic
glyphs:      # one family, by meaning
  done: ✓
  running: ●
  pending: ○
  expanded: ▾
  collapsed: ▸
spacing:     # in cells and rows
  inset: 1 col
  group-gap: 1 row
  section-gap: 1 row
widths:
  rail: 50
  breakpoint: 140
```

## Sections (fixed order)

1. Overview: product, users, and a one-line north star metaphor (for example "an IDE inside a terminal").
2. Colors: roles and where each appears.
3. Type roles: hierarchy and where each role applies.
4. Layout: panes, rail, status bar, widths and breakpoints.
5. Surfaces: canvas vs rail vs elevated; how regions separate.
6. Glyphs: the family and meaning table.
7. Components: each panel/bar/card with its states.
8. Do's and Don'ts: named rules and refusals specific to this product.
