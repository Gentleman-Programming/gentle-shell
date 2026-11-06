# Command Playbooks (terminal)

Each command takes one named target (a panel, a bar, a card type). Every refine command finishes with `polish`.

## shape (plan before code)

- Ask 2-3 questions per round: purpose, who uses it and how often, what success looks like; then content ranges, states and width limits.
- Output a brief: goal, users and frequency, content inventory with ranges, states, layout at each width, keyboard/mouse model, open questions. No code.

## distill (remove what does not earn its rows)

- One primary goal per panel; say each fact once per screen.
- Flatten nesting; delete group titles that only restate the content.
- Collapse finished or idle content to a summary row.
- Keep the fixed rail; distill its contents, not its existence.

## layout (spacing and rhythm)

- Squint test first; fix order before decoration.
- Group by proximity, then separators, boxes last.
- Tight inside groups, one consistent gap between groups.
- Align values in a column; use tabular alignment for numbers and durations.
- Predictable structure is the affordance: same section shape everywhere.

## typeset (hierarchy without font sizes)

- Define 3-4 roles: title (bold or accent), value (normal), label (dim), meta (dim italic or muted).
- Apply each role identically everywhere it repeats.
- Prose wraps at 60-80 columns; chrome truncates.

## quieter (tone down)

- Fewer background tints, flatter surfaces, fewer accent uses, no decorative motion.
- Keep a few anchors (the accent on the active item) so it still has a point of view.

## bolder (amplify one thing)

- Touch only the named target; amplify what the system already owns.
- Commit to one move and quiet everything around it.
- Skeleton test: the structure must read with placeholder text.

## colorize (roles, not swatches)

- Map every color to a role from the theme; accents only for action, selection and state.
- Add a second neutral for side panels and bars; check contrast on it.
- Pair every state color with a glyph or word.

## clarify (copy)

- Controls name their action; errors say what failed, why, and how to recover.
- Empty states distinguish first use, nothing yet and failure.
- Loading names the real operation; never fake progress.
- One term per concept across the whole shell.

## harden (edge cases)

- Long paths and branch names, emoji and CJK widths, 0/1/1000 items, very long tasks.
- Missing data, failed commands, permission errors: one failing part never blanks the whole surface.
- Resize during render; collapsed and expanded transitions.

## adapt (other sizes)

- Rethink per width, do not scale: wide (rail visible), breakpoint (exactly at and below it), narrow 80x24.
- Decide what moves to the status bar or a key when the rail disappears.

## polish (final pass)

- Classify each drift: missing token, one-off value, concept mismatch, local defect.
- Triage: broken task, missing states, flow drift, visual, cleanup.
- One glyph family; every control has all its states; no stray colors.
- Re-capture and compare with the brief and the previous PNG.

## document (context)

- Write or update `DESIGN.md` per `design-doc.md`; never overwrite an existing one silently.
