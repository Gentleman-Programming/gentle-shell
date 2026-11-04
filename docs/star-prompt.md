# GitHub star prompt

Gentle Shell can thank engaged users with a single, non-blocking invitation to star the repository — modeled on t3code's `GitHubStarPrompt` courtesies, and engineered to never interrupt active work.

## Behavior

- **Engagement gate.** The offer may appear only after more than five interactive prompts have been sent across sessions (the counter persists in the gentle config home). Prompts 1–5 stay silent.
- **Idle only.** The offer waits for 30 seconds without any keyboard activity and for no running agent before showing anything. Typing at any moment restarts the wait and is never consumed.
- **Once per session.** If the offer goes unanswered, it auto-hides after five minutes and does not return until the next session.
- **Dismissal is forever.** `Alt+D` (or any dismissal path) persists a never-ask-again flag. If state cannot be read or written, the extension never asks at all: a dismissal that cannot be saved must not be replaced by nagging.
- **Already starred.** When the authenticated `gh` account already starred the repositories, the offer marks itself dismissed without ever showing. If `gh` cannot answer, the offer stays silent for that session.

## The offer

When idle conditions are met, a one-line offer appears below the editor, painted in the theme's `success` green (the color of added lines in the changes view) so it stands out, followed by a `[star]` button:

```
Enjoying Gentle Shell? Ctrl+G stars both Gentleman-Programming repos (github.com/Gentleman-Programming/gentle-shell and github.com/Gentleman-Programming/gentle-ai) on GitHub, Alt+D never asks again [star]
```

On narrow terminals the offer text is truncated with `…`; the `[star]` button always stays visible. The button exists only while the offer is visible.

Only two control chords are intercepted while the offer is visible — plain typing is passed through untouched, so the prompt can never eat a character:

- `Ctrl+G` or a left click on `[star]` — star now.
- `Alt+D` — never ask again.

The `[star]` button uses the shell's shared hover treatment, like the sidebar's clickable controls. Mouse reports arrive only in fullscreen mode; under tmux, zellij, and screen clicks work but hover does not, and without mouse support the chords keep working.

## Starring

`Ctrl+G` stars **both sibling repositories**, `Gentleman-Programming/gentle-shell` and `Gentleman-Programming/gentle-ai`, right from the terminal through the authenticated `gh` account, only after that explicit keypress (each PUT is an idempotent no-op when already starred). If `gh` is missing or fails, it falls back to opening both URLs in the browser instead of dead-ending.
