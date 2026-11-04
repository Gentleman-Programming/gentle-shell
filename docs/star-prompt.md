# GitHub star prompt

Gentle Shell can thank engaged users with a single, non-blocking invitation to star the repository — modeled on t3code's `GitHubStarPrompt` courtesies, and engineered to never interrupt active work.

## Behavior

- **Engagement gate.** The offer may appear only after more than five interactive prompts have been sent across sessions (the counter persists in the gentle config home). Prompts 1–5 stay silent.
- **Idle only.** The offer waits for 30 seconds without any keyboard activity and for no running agent before showing anything. Typing at any moment restarts the wait and is never consumed.
- **Once per session.** If the offer goes unanswered, it auto-hides after five minutes and does not return until the next session.
- **Dismissal is forever.** `Alt+D` (or any dismissal path) persists a never-ask-again flag. If state cannot be read or written, the extension never asks at all: a dismissal that cannot be saved must not be replaced by nagging.
- **Already starred.** When the opt-in direct flow is enabled and the authenticated `gh` account already starred the repository, the offer marks itself dismissed without ever showing.

## The offer

When idle conditions are met, a footer status line appears:

```
Enjoying Gentle Shell? Ctrl+G stars github.com/Gentleman-Programming/gentle-shell on GitHub, Alt+D never asks again
```

Only two control chords are intercepted while the offer is visible — plain typing is passed through untouched, so the prompt can never eat a character:

- `Ctrl+G` — star now.
- `Alt+D` — never ask again.

## Starring

By default `Ctrl+G` opens `https://github.com/Gentleman-Programming/gentle-shell` in the browser; nothing touches stored credentials.

To enable the one-chord flow (star directly with the authenticated `gh` account, t3code-style), set `directStar` in `star-prompt.json` inside the gentle config home:

```json
{
	"schema": "gentle-shell.star-prompt/v1",
	"sent": 12,
	"dismissed": false,
	"directStar": true
}
```

With `directStar: true`, the extension reads starred state and stars through `gh api` after the explicit `Ctrl+G` keypress; if `gh` is missing or fails, it falls back to opening the browser instead of dead-ending.
