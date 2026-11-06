# Critique (scored)

Judge from a screenshot, not from code. Write the design assessment first, then check measurable evidence (overflow, contrast, render counts) so the evidence does not anchor the judgment.

## Health score

Score each heuristic 0-4 (0 broken, 2 workable, 4 excellent); mark `n/a` and renormalize to /40 when one does not apply.

1. Visibility of system status (live work, progress, mode, permissions).
2. Match with developer expectations (IDE and terminal conventions).
3. User control (collapse, scroll, escape, undo of view changes).
4. Consistency (glyphs, roles, section shapes, terms).
5. Error prevention (dangerous modes visible, confirmations where needed).
6. Recognition over recall (hints where the action is, palette discoverability).
7. Efficiency for experts (keyboard paths, density, no wasted rows).
8. Minimalist design (each fact once, no decoration).
9. Error recovery (messages with cause and next step).
10. Help and documentation (discoverable keys and commands).

Bands: 36-40 excellent, 28-35 good, 20-27 acceptable, 12-19 poor, under 12 critical.

## Cognitive load check

Single focus, chunks of 4 or fewer, clear grouping, visible hierarchy, one decision at a time, 4 or fewer options per decision, no need to remember across screens, progressive disclosure. 0-1 failures is low load; 4 or more is critical.

## Personas

- Power user: lives on the keyboard, wants density and zero repetition.
- Keyboard/accessibility: contrast, focus visibility, no color-only state.
- Stress tester: long sessions, 50 agents, 200 todos, narrow terminal.

## Severity

- P0 blocking: the task cannot be done or the UI breaks (rail disappears, content unreadable).
- P1 major: significant difficulty or contrast failure. Tie-breaker: would a user report it? Then at least P1.
- P2 minor: a workaround exists.
- P3 polish.

## Report shape

1. Target, sizes captured, PNG paths.
2. Health score table and total.
3. Specificity verdict: could any other TUI ship this unchanged?
4. What works (2-3).
5. Priority issues (3-5): `[P?] what / why it matters / fix / command`.
6. Persona red flags.
7. Minor observations.
8. 2-4 questions with concrete options, last.
