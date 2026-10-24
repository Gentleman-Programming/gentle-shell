# Gentle Music

`/gentle:music` plays [gentle-stream](https://github.com/Gentleman-Programming/gentle-stream) music from inside Gentle Shell.

## Open the player

```text
/gentle:music
/gentle:music rainy lo-fi night
```

The command hands the whole terminal to gentle-stream's own TUI, the same way Pi's external editor (`ctrl+g`) does. Any text after the command is passed as the mood (`--mood`), and the session's current model is passed as `--model provider/id`, so gentle-stream interprets the mood with the model you already use.

Leave the player with:

| Key | Result |
| :-- | :-- |
| `b` | Back to Pi; the music keeps playing. |
| `q` | Back to Pi; the music stops. |

Pi returns exactly as it was: the draft, the transcript, and the layout are redrawn. While the player is open, `ctrl+c` goes to gentle-stream, not to Pi. If gentle-stream exits with an error, Pi shows a short notice.

Opening `/gentle:music` again while music plays attaches to the same music.

## Control the music without leaving Pi

A single control word runs `gentle-stream ctl …` in the background and shows the result as a notice. The terminal stays with Pi.

| Command | Result |
| :-- | :-- |
| `/gentle:music next` | Next track. |
| `/gentle:music pause` | Pause. |
| `/gentle:music play` | Resume. |
| `/gentle:music stop` | Stop the music. |
| `/gentle:music status` | One line, for example `♪ Neon Rain · synthwave · playing`, or `nothing is playing`. |

Only an exact single word is a control word. `/gentle:music next to the sea` opens the player with the mood `next to the sea`.

## Stopping on exit

When you quit Pi after using `/gentle:music`, Gentle Shell runs `gentle-stream ctl stop` so no music outlives the shell. It waits at most about 2 seconds. Starting a new session, resuming, forking, or reloading keeps the music playing.

## Installation

Gentle Shell looks for gentle-stream in this order:

1. `gentle-stream` on `PATH`.
2. `uvx`, running gentle-stream straight from its repository (the first run downloads it).
3. `uv`, through `uv tool run`.

With none of them, `/gentle:music` explains how to install and does nothing else. Install [uv](https://docs.astral.sh/uv/getting-started/installation/), or install gentle-stream permanently:

```bash
uv tool install 'gentle-stream[samples] @ git+https://github.com/Gentleman-Programming/gentle-stream'
```

## Limits

- The player needs the interactive terminal. In RPC, JSON, and print modes, `/gentle:music` shows a notice and does nothing.
- There is no default shortcut.
- gentle-stream starts its own `gentle-shell` process to interpret moods; Gentle Shell does not pass its own launcher path.
