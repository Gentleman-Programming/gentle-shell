# Visual Loop (eyes)

## Gentle Shell harness

From a Gentle Shell checkout that has `scripts/shell-snapshot.mjs`:

```bash
node scripts/shell-snapshot.mjs --latest-rich                 # newest session with todos and subagents
node scripts/shell-snapshot.mjs --session <file.jsonl> --cols 180 --rows 50
node scripts/shell-snapshot.mjs --latest-rich --cols 139 --rows 40   # just below the rail breakpoint
node scripts/shell-snapshot.mjs --latest-rich --cols 80 --rows 24    # narrow
```

- It forks the session into a `/tmp/gentle-eyes.*` scratch dir (`--fork --session-dir`), so the source session is never written.
- It launches the checkout's own `bin/gentle-shell.mjs` in fullscreen under ttyd and headless Chrome, and prints PNG paths; read them with the image-capable read tool.
- It strips inherited agent variables (`PI_*`, `GENTLE_PI_*`, `GENTLE_SHELL_*`, `HERDR_*`); without that a shell launched from an agent acts as a child and never mounts the rail.
- Never type prompts into the captured shell: it inherits the user's permission mode.
- Remove the scratch dirs it reports when done.

vhs 0.12.0 produced no output on this machine; prefer the harness.

## Loop

1. Capture "before" at the sizes that matter; name files by size and step.
2. Write the critique or brief before editing.
3. Edit, re-capture, read both PNGs, and compare against the brief point by point.
4. Stop after 3 rounds or when no P0-P2 remains; report what is left.
5. Pair visual checks with the repo's focused render tests (render counts, overflow, breakpoints).

## Mockups first

For redesigns, draw directions with `gentle-design` before code. Constrain artboards to the terminal: a fixed monospace grid in `ch` units at the real column count, theme colors only, no font sizes or radii, glyphs from the DESIGN.md family. Then match the implementation screenshot to the chosen artboard.
