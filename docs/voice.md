# Optional local voice dictation

Voice dictation is optional. It transcribes speech locally with NVIDIA Parakeet
through sherpa-onnx, with no API key and no cloud inference. Everything happens
from `/gentle:voice`; nothing described here runs at startup.

## Quick path

1. Run `/gentle:voice` and choose **Download voice dictation**. The
   confirmation lists each component, its size, the destination directory,
   the licenses and the platform limitations. Esc during the download cancels it.
2. Run `/gentle:voice` again and choose **Start dictation**. Speak, then press
   Enter to stop. Esc cancels at any point.
3. The transcript is pasted into the editor draft at the cursor. It is never
   sent automatically. Pi collapses pastes over 1,000 characters or 10 lines into
   a `[paste #N …]` marker; the full text is retained and expanded when you submit.
   Long transcripts are therefore not displayed as editable text in the draft.
4. Or hold Space in the editor: push-to-talk is turned on by a successful
   download. See [Push-to-talk](#push-to-talk-hold-space).

## The command

| Topic | Behavior |
|-------|----------|
| Menu | Built-in select and confirm dialogs. **Show status and notices** reports the target, both components, limitations and licenses. **Disable push-to-talk (hold Space)** appears while it is on; **Enable push-to-talk (hold Space)** appears only when voice is installed. |
| Download | Only after the confirmation; runtime first, then the model. A cancelled download keeps components that already finished. |
| Dictation | A compact overlay shows preparing, recording, transcribing. Enter stops recording; the overlay stays until the transcript is ready. |
| Recording limit | After 2 minutes recording stops by itself, and the transcript is pasted without a key press. |
| Insertion | The recognized text goes through Pi's editor paste pipeline, which may collapse long text into a paste marker. A blank result pastes nothing. |
| One at a time | A second `/gentle:voice` while a download or dictation runs is refused with a notice. A Space hold during either one types spaces as usual. |
| Cancel and shutdown | Esc, reload or session shutdown aborts the download or cancels the session. A transcript that arrives afterwards is dropped. |
| Where it runs | Interactive TUI parent sessions only. RPC, print, JSON and delegated child sessions refuse it. No model-callable tool exists. |
| Errors | Fixed messages with the action to take, such as installing ALSA or the Visual C++ runtime. Gentle AI never runs those installers. |

The command is tested with fake dialogs, downloads and sessions only. No real
download, native load or microphone recording has been exercised through it.

## Push-to-talk (hold Space)

Hold Space in the editor to record; release it to stop. The transcript is
pasted at the cursor and never sent. Esc cancels while recording or
transcribing. A one-line footer status shows preparing, recording and
transcribing; no overlay opens, so the editor keeps the focus.

| Topic | Behavior |
|-------|----------|
| Toggle | Stored as `voice-settings.json` (`gentle-pi.voice-settings/v1`) in the Gentle AI config home. A successful download turns it on; the `/gentle:voice` menu turns it off and on, effective immediately. A missing or malformed file means off. |
| When it is armed | Only with the toggle on, in an interactive TUI parent session. Delegated child sessions, RPC, print and JSON modes never arm it. Reload or shutdown disarms it and cancels a running dictation. |
| Startup | Reads the toggle file only. No voice files are checked, nothing is downloaded or loaded, and no worker starts. |
| First hold | Checks that the runtime and model are installed; the spaces keep typing meanwhile. If voice is not installed, a notice points to `/gentle:voice` and push-to-talk stays off for the session; the saved choice is kept. |
| One at a time | A hold while a download or dictation runs types spaces normally. |

### How a hold is recognized

With Pi's keyboard mode, terminals report Space as plain text and never report
its release, so push-to-talk relies on the operating system's key auto-repeat.
Pi lets an extension drop or replace a key as it arrives, but not type one
later, so every space reaches the editor unchanged:

- **Typing:** a tap, several spaces, an indent or Space then a letter are
  typed exactly as without push-to-talk, with no delay.
- **Hold:** auto-repeat has a long initial delay followed by short, regular
  repeats; typing does not. A hold needs a first gap of 180 to 1000 ms (macOS
  allows at least about 225 ms, X11 defaults to 660 ms), then three repeats
  each at most 250 ms apart and regular (the slowest at most 1.6 times the
  fastest), with the first gap at least 1.5 times the slowest repeat. Each
  space must have added exactly one space to the draft. The following repeats
  are turned into Backspace, through the editor's normal key path, until the
  spaces the hold typed are removed; when the hold followed a word, one space
  stays as the separator before the transcript. Later repeats are dropped.
  While recording starts, those spaces can be seen briefly.
- **Release:** no repeat for 2.5 times the observed repeat interval, between
  150 and 400 ms. The decision waits until input already queued is handled, so
  a repeat delayed by a busy moment is not taken for a release.
- **Guards:** only single-space input counts. Pastes, escape sequences and
  multi-character input pass through and end the attempt. If the draft changes
  in any other way, for example Vim NORMAL mode where Space only moves the
  cursor, autocomplete, or another key, the hold is not confirmed, or erasing
  stops, and nothing else is removed. Spaces that were in the draft before the
  hold are never removed.

Limitations: the timing depends on the keyboard repeat settings. An initial
repeat delay under 180 ms or over 1000 ms, or a repeat interval over 250 ms,
prevents a hold from being recognized. Five or more spaces typed with a pause
and then a very even fast rhythm could still look like a hold. Whether a space
precedes the hold is judged as if typing at the end of the draft; in the
middle of existing spaces the separator may be missing. Esc pressed while
repeats are still arriving, and a release right as the hold is confirmed, can
leave a stray space. Recording starts once the hold is confirmed and the
microphone is open; the model is verified while you speak (see below). A hold
while a dialog or overlay has the focus does not change the draft and is
ignored. Push-to-talk is tested with fake terminals, editors and sessions
only.

## What gets downloaded

All versions, sizes and digests are pinned in `lib/voice-artifacts.ts`.

| Component | Source | Size | Verified by |
|-----------|--------|------|-------------|
| `sherpa-onnx-node@1.13.8` | npm registry | 12 KB | `dist.integrity` (SHA-512) |
| `sherpa-onnx-<platform>-<arch>@1.13.8` | npm registry | 9–14 MB | `dist.integrity` (SHA-512) |
| `node-cpal@1.0.0` (microphone capture) | npm registry | 7.7 MB | `dist.integrity` (SHA-512) |
| Parakeet TDT 0.6B v3, int8 | Hugging Face, commit `2bda32ec70b0` | about 670 MB | per-file size and SHA-256 |

The model is the sherpa-onnx export
`csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`: `encoder.int8.onnx`,
`decoder.int8.onnx`, `joiner.int8.onnx` and `tokens.txt`.

## Where it is stored

Everything lives in `<Gentle AI config home>/voice` (by default
`~/.pi/gentle-ai/voice`; see `gentlePiConfigHome()`):

```text
voice/
  runtime/sherpa-onnx-1.13.8-node-cpal-1.0.0-<target>/node_modules/
    sherpa-onnx-node/
    sherpa-onnx-<platform>-<arch>/
    node-cpal/
  models/parakeet-tdt-0.6b-v3-int8-2bda32ec70b0/
```

The platform package sits next to `sherpa-onnx-node` because its loader resolves
`../sherpa-onnx-<platform>-<arch>/sherpa-onnx.node`. node-cpal loads
`bin/<platform>-<arch>/index.node` from its own directory. The runtime directory
names both native versions, so a runtime installed with other pins is never
reported as the current one.

## How an install stays safe

- **Explicit only.** Importing the voice modules performs no filesystem or
  network access. Status checks never create the voice directory.
- **Streamed and bounded.** Each file is hashed while it streams to disk and is
  cut off as soon as it exceeds its pinned size. A wrong length or digest fails
  the install.
- **Pinned redirects.** npm tarballs are fetched without redirects. Hugging Face
  redirects are followed only over HTTPS to the paths observed for this revision:
  `huggingface.co/api/resolve-cache/...` and `us.aws.cdn.hf.co/xet-bridge-us/...`.
  Any other host, including other CDN regions, is refused.
- **Cancellable and time-bounded.** An install can be aborted. It also stops
  when no data arrives for 60 seconds, or when it runs past 20 minutes for the
  runtime or 2 hours for the model.
- **Checked archives.** Every tarball is validated before anything is
  extracted. Only regular files under `package/` are accepted, within the
  registry's file count and unpacked size. Links, directories, traversal,
  duplicates and Windows device names are refused. No package script runs, and
  no downloaded code is loaded during installation.
- **Atomic publication.** Work happens in a private `.staging-*` directory. The
  install marker is written last, and one rename publishes the component. A
  failure or cancellation removes only that staging directory. An existing
  installation is never partially overwritten: a valid one is kept as is, and an
  invalid one is replaced only by a complete, verified copy.

## Dictation session

`lib/voice-session.ts` records one dictation and returns its text. It never
submits the text or touches the editor; the caller decides what to do with it.

- **Separate process.** `start()` runs `scripts/voice-worker.cjs` with the same
  Node executable, from the runtime directory, with no shell. Microphone
  capture, the model load and the decode all happen in that process, so a
  native crash or a long decode cannot freeze Gentle AI. Importing the module or
  creating a session does nothing until `start()`.
- **Checked before loading.** `start()` first requires both components to be
  reported installed. The worker then checks the files again before it loads
  the native code that uses them: every entry in the runtime and model
  directories must be a plain directory or regular file, owned by the current
  user and not writable by everyone (ownership and modes are not checked on
  Windows). Each required runtime file must be present, and each model file
  must match its pinned size and SHA-256. The digests are recomputed on every
  session, which reads the whole model (about 670 MB). Directories above the
  voice home are not checked. These checks catch broken or swapped installs;
  they cannot stop someone with the same user account from replacing the files,
  which is the same as running code as that user.
- **Order.** So that the first words are recorded, the worker validates the
  runtime files, loads node-cpal and opens the microphone, then reports
  `recording` and verifies the model digests while recording, reading each
  file in chunks so capture keeps running. sherpa-onnx and the model are loaded
  only after every digest matched and recording stopped, because that load is
  synchronous and would stall capture. A mismatch found while recording closes
  the microphone at once and reports the model as invalid; one found after stop
  is reported instead of a transcript. Cancel stops the verification and loads
  nothing. The tradeoff: the recognizer load (about 0.85 seconds measured on an
  Apple Silicon Mac) now happens after stop, so a transcript takes that much
  longer to arrive, and any verification still running when you stop is
  awaited too.
- **Lifecycle.** A session is used once: `start()` resolves when recording
  begins, `stop()` resolves with `{ text, truncated }`, and `cancel()` (or
  `dispose()`) discards everything, including a transcript that arrives late.
  `start()` resolves while the worker keeps recording; `stop()`, `cancel()` and
  a failed `start()` settle only after the worker has exited. A worker that does
  not exit within 2 seconds of finishing or being cancelled is killed. If the parent
  disappears, the worker sees its input close and stops capturing.
- **Bounds.** Recording stops by itself after 120 seconds, and the worker then
  transcribes what it has (`truncated: true`). Starting (runtime checks and
  opening the microphone) and transcribing (the rest of the model
  verification, the model load and the decode) each have a 120-second limit. Audio is kept in memory
  only up to the recording limit. All of these are options.
- **Audio.** The worker opens the default input device through node-cpal,
  preferring 32-bit float samples and otherwise using the device's default
  integer or float format. It mixes all channels down to mono and resamples to
  16 kHz in JavaScript (averaging when downsampling, linear interpolation when
  upsampling). No SoX or FFmpeg is used. Less than 0.1 seconds of audio is
  reported as empty, and a blank transcript as no speech.
- **Errors.** The worker reports a fixed code only, and the session turns it
  into a fixed message. Native error text, file paths and environment values
  are never included, and the worker's stderr is discarded.
- **Environment.** The worker gets only home, temp, locale and audio-session
  variables (`HOME`, `USERPROFILE`, `SystemRoot`, `windir`, `TEMP`, `TMP`,
  `TMPDIR`, `XDG_RUNTIME_DIR`, `PULSE_SERVER`, `PULSE_COOKIE`, `LANG`, `LC_ALL`,
  `LC_CTYPE`). Credentials, `PATH`, `NODE_OPTIONS` and loader variables are
  dropped.
- **Protocol.** JSON lines with schema `gentle.voice/v1`. The parent sends
  `start` (with paths computed from the pinned manifests), then `stop` or
  `cancel`. The worker answers `recording`, `transcribing`, and one final
  `result` or `error`. Any other message, an unknown field, more than 16 lines
  or a line over 64 KB stops the worker.

The session has been tested only with scripted fake workers and with the real
worker driving fake capture and recognizer modules. It has not loaded the real
native modules, opened a real microphone or transcribed real speech.

## Platform support

All five targets get the pinned runtime and a `node-cpal@1.0.0` capture binary
built for their architecture (checked from the binary headers, not by loading).

| Target | Prerequisites (not checked before loading) |
|--------|--------------------------------------------|
| macOS arm64 | macOS 11 or newer |
| macOS x64 | macOS 10.12 or newer |
| Linux x64, glibc 2.34+ | ALSA `libasound.so.2` |
| Linux arm64, glibc 2.34+ | ALSA `libasound.so.2` |
| Windows x64 | Microsoft Visual C++ runtime (`vcruntime140.dll`) |

node-cpal requires Node 22 or newer, and a dictation session refuses to start
on an older Node. Gentle AI never downloads or installs the Visual C++ runtime;
a missing runtime is expected to surface as a runtime load failure, which has
not been observed on hardware. `/gentle:voice` then names the runtime to install.

None of these targets has been verified on real hardware yet: native loading,
library paths and microphone capture have not been executed. Linux with a glibc
older than 2.34 is unsupported and the diagnosis names the version found.
Windows ARM64 has no native sherpa-onnx package and is unsupported. musl Linux
is unsupported. WSL is reported as unproven.

## Licenses and attribution

- **Model:** Parakeet TDT 0.6B v3 by NVIDIA, licensed under CC-BY-4.0. The int8
  sherpa-onnx export is by csukuangfj. The export repository has no license file
  of its own; its license is taken from the upstream NVIDIA model.
- **Runtime:** sherpa-onnx, Apache-2.0. The npm tarballs ship no LICENSE or
  NOTICE file. The platform packages bundle onnxruntime (MIT) without its
  license text.
- **Capture:** node-cpal 1.0.0, ISC. The tarball ships no LICENSE or NOTICE file. Its prebuilt
  binaries link Rust crates whose notices are not included.

These gaps are unresolved and are listed in `VOICE_NOTICES`.
