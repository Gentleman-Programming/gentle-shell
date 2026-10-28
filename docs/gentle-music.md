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

gentle-stream runs on macOS and Linux, including Gentle Shell inside WSL. It needs POSIX features native Windows lacks (file locks, a Unix control socket, process groups), so on native Windows `/gentle:music` only says it is not available yet: it never offers, installs, or runs the player.

On macOS and Linux, Gentle Shell looks for gentle-stream in this order:

1. `gentle-stream` on `PATH`.
2. In a bundled Gentle Shell, the gentle-stream it installed inside its own folder (see below).
3. `uvx`, running gentle-stream straight from its repository (the first run downloads it).
4. `uv`, through `uv tool run`.

With none of them, a pnpm or npm install of Gentle Shell explains how to install and does nothing else. Install [uv](https://docs.astral.sh/uv/getting-started/installation/), or install gentle-stream permanently:

```bash
uv tool install 'gentle-stream[samples] @ git+https://github.com/Gentleman-Programming/gentle-stream'
```

### Installed by a bundled Gentle Shell

On macOS and Linux, a bundled Gentle Shell (the one the web installer sets up) offers to install the player for you the first time `/gentle:music` finds none:

> Install the gentle-stream music player inside Gentle Shell? It downloads uv, Python 3.13 and the player (about 150 MB) into the Gentle Shell folder.

Decline and you get the manual hint above; nothing is downloaded. Accept and Gentle Shell shows its progress, installs the player, and starts the music. Later runs use it directly, with no question.

Everything stays inside the Gentle Shell folder (`~/.gentle-shell`). Nothing is added to your `PATH`, and your own Python, uv, and uv settings are never used or changed:

| What | Where | Size on disk |
| :-- | :-- | :-- |
| [uv](https://github.com/astral-sh/uv) 0.13.6, the release archive pinned by sha256 and checked before use | `runtime/uv-0.13.6/` | about 30 MB |
| Python 3.13, managed by that uv | `music/python/` | about 70 MB |
| gentle-stream, from a pinned commit archive of its repository (git is not needed) | `music/tools/`, run from `music/bin/gentle-stream` | about 110 MB |

uv's download cache (`music/cache/`) is emptied after the install. Removing the bundled install removes all of it.

The player is installed with its `samples` extra (pyfluidsynth). If that extra cannot be installed, Gentle Shell says so and installs the player without it. Either way, the sampled instruments need the FluidSynth library from your system (for example `brew install fluid-synth` or `apt install libfluidsynth3`) and the soundfont `gentle-stream setup-samples` downloads; without them gentle-stream plays its synthesized instruments.

## Limits

- Native Windows is not supported yet (see [Installation](#installation)); use WSL.
- The player needs the interactive terminal. In RPC, JSON, and print modes, `/gentle:music` shows a notice and does nothing.
- There is no default shortcut.
- gentle-stream starts its own `gentle-shell` process to interpret moods; Gentle Shell does not pass its own launcher path.
