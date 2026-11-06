# Native notification audio backend — own Node Pulse client

Locator: `odd/tasks/native-audio-backend.md`
Worktree: `../gentle-shell-native-audio` (linked worktree of the main clone,
sibling of the repository root)
Branch: `feat/native-notification-audio`, base `9a1f8a75`. Worktree setup did
**no install of its own** (real `node_modules` retained as ignored linked
entries). The later **N5 verification incident** separately auto-installed an
ignored local Go release binary — a package-local artifact, not an audio
dependency (L9); it does not change the initial no-install fact.
N0 plan committed at **`9282b002`** [x] (399 lines); N1a codec committed at
**`b2bdee09`** [x] (518 authored lines); N1b client committed at **`7ea3e15a`**
[x] (684 authored lines); N2 stream committed at **`597e4d27`** [x] (525 authored
lines); N3 bridge+worker committed at **`e368e74a`** [x] (~489 authored lines);
N4 routing+docs committed by the parent at **`7f1b87ac`** [x]. **N5 is [x]**
(functionally verified at L13). P1 Windows adapter committed at **`0c6eaea6`**
[x]; P2 WSL Windows-interop derivation at **`57fbe506`** [x]; P3 default routing
at **`fe8d8fc3`** [x] (current HEAD). The historical L9 whole-suite **BLOCKED**
result is preserved as history, superseded by the L13 current-candidate run.

**Status: CROSS-PLATFORM PREPARED (P3 DEFAULT ROUTING), N5 FUNCTIONALLY
VERIFIED.** The
protocol appendix below was read from the locally downloaded official
PulseAudio **v17.0** references (read-only, hashes verified) and corrected by the
**L2 independent document verification** (B1–B3, see the Log). N1a is the pure
tagstruct/frame codec (`lib/notification-pulse-protocol.ts`); N1b adds the Unix
client transport and the read-only GET_SERVER_INFO probe (`lib/notification-pulse-client.ts`,
real WSLg probe returned `{available:true, formats:["wav"]}`, no stream/samples);
N2 adds strict WAV PCM parse plus the CREATE/REQUEST/DRAIN/DELETE playback flow
against a **fake Unix server only** (`lib/notification-pulse-stream.ts`); N3 adds
the lazy Linux-only bridge (`lib/notification-audio-native.ts`) and the owned
`process.execPath` worker (`lib/notification-pulse-worker.ts`) as source `.ts`
(built-in type stripping; no generated runtime, runtime stays 8 and the 69 pins
are unchanged). N4 integrates routing: on Linux the native WAV backend is
preferred with the CLI retained as the OGG/FLAC fallback, capabilities are
aggregated, the scheduler permit is called once, and no real audio is played.
RED/GREEN are in L3/L4/L5/L6/L7 and L12; N5 closure evidence is in L8/L9
(historical, superseded) and L13 (current).
**No physical playback is claimed; the WSL and native Windows `SoundPlayer`
routes and the macOS `afplay` route are prepared, and none has audible
evidence.** The P3 default-routing wiring is in L12.

## Objective

Give Gentle Shell's existing notification audio an opt-in, dependency-free
**native Linux/WSLg backend**: a minimal PulseAudio-wire v13 client written in
our own Node code (built-in `node:net` Unix socket), replacing the external CLI
player only where the native path is proven. Cross-platform targets are now
**prepared** using only included system output: Windows PowerShell `SoundPlayer`
(direct and via the WSL `/mnt/c` interop host `C:\Windows`) and the macOS
`afplay` CLI, with no compiled CoreAudio/WASAPI helper and no installer. There
is **no universal-support claim**: a non-default Windows root and a missing
`/mnt/c` mount fail closed to the trusted external/CLI fallback. The native path
must never shadow the working external OGG/FLAC backend or overstate physical
support.

## Approval log (parent-relayed, not independently re-confirmed here)

- User: **"go"** to proceed.
- Phasing answer: **"IN PHASES"** — Linux/macOS/Windows staged; this turn started
  Linux/WSLg. (Superseded by L10: all three platforms are now prepared without a
  physical-evidence requirement, never claimed as universally supported.)
- Package answer: **"CLIENTE PROPIO SIN NUEVOS PAQUETES"** — own client, no new
  packages, no `pulseaudio.js` dependency, no new npm, no CLI player/system
  library install, no global config/activation, no physical play claim, no push
  PR. The user **authorized the parent's local per-unit commits and delegation**.
- **Delegated-worker constraint, NOT a user prohibition:** the worker was told
  not to spawn subagents, not to commit, and not to run review itself. That scope
  limit applies to the delegated writer only; the parent still commits locally
  per unit and owns review.
- Source artifact to respect: user-provided `[ruta local anonimizada]`
  (reported 5.58 s) is intentionally rejected by the unchanged 5 s limit; it is
  not cropped, not raised.

## Measured baseline (this session, `9a1f8a75`)

- `node scripts/verify-package-files.mjs` → **174 required files, 69 byte-pinned
  contract artifacts** (passes).
- Generated runtime modules: **8** (`runtime/*.mjs`, `scripts/build-runtime-modules.mjs` sources).
- Node `v24.20.0`. Notification modules/tests present: `lib/notification-*.ts`,
  `tests/notification-*.test.ts` (7 files).
- Server evidence (existence only, no cookie content read):
  `/run/user/1000/pulse/native` → `/mnt/wslg/runtime-dir/pulse/native` (socket),
  sibling `pid`. **No cookie found** at `/run/user/1000/pulse/cookie`,
  `/mnt/wslg/runtime-dir/pulse/cookie`, `~/.config/pulse/cookie`,
  `~/.pulse-cookie`, and no `/etc/pulse/*`. Cookie resolution is therefore an
  open item (see U2), not an assumption.
- Historical baseline counts may drift; do not re-assert without re-measuring.

## Risks and mitigations (lead)

| # | Risk | Mitigation |
|---|---|---|
| R1 | Wire opcode/token/field mismatch vs modern Pulse or PipeWire-Pulse | Resolved by the local PulseAudio **v17.0** reference read (below) and the verified wire/appendix tables; N1b's real read-only AUTH + ServerInfo probe still proves the server accepts our bytes before any stream code. |
| R2 | Native path silently shadows working external OGG/FLAC | Capabilities are **aggregated**, never replaced; native phase 1 advertises **WAV PCM only**; external backend keeps OGG/FLAC; routing is truthful; no `backend` schema change (`"auto"` stays). |
| R3 | Cookie exposure or creation | Read existing regular file only, `O_NOFOLLOW`, bounded ≤256 bytes, never create, never log contents, never send it anywhere but the local socket AUTH. |
| R4 | Accidental TCP / network / SHM / ancillary-FD surface | Explicit denial: Unix `SOCK_STREAM` only, no TCP, no network, no shared memory, no `SCM_RIGHTS`. **REQUEST is expected, not refused**: for non-SHM PCM it is handled by matching the current stream and accumulating bounded bytes; only SHM/memfd flag frames, refund/revoke control frames, and ancillary FDs fail closed. |
| R5 | Worker spawn overlap, leak, orphan, or lingering process | Reuse existing `permit.start()` **synchronous** gate immediately before spawn with no await; parent SIGKILL timeout 6000 ms; settle only on `close` + cleanup; single-flight reservation in the owner. |
| R6 | Packaging/binary creep (Addon, prebuilt, postinstall download, ABI) | Pure Node in the owned source worker `lib/notification-pulse-worker.ts` (`process.execPath`, built-in type stripping, engine `node >=22.19.0`): **no generated `runtime/*.mjs`**, runtime stays **8**. No Addon, binary, ABI, compiler or audio install step; the pre-existing npm `postinstall` Go step is unchanged and the audio work adds no new dependency. `verify-package-files.mjs` keeps runtime/sources/requiredPaths in sync. |
| R7 | WSLg path divergence | Resolve `/run/user/<uid>/pulse/native` first, then `/mnt/wslg/runtime-dir/pulse/native`; missing socket → unavailable → fallback preserved. |
| R8 | Physical-support overreach | Linux/WSLg, Windows (direct + WSL interop) and macOS are prepared by default (P3); only Linux/WSLg has a real read-only probe. Non-default Windows roots / missing `/mnt/c` fail closed; no "supported"/universal claim, and no physical-evidence requirement without manual listening. |
| R9 | Regression of 9a1 (`878`-restored) UI or OGG/FLAC behavior | Preserve the six-control basic card and existing validators/fallback verbatim; changes limited to routing/lifecycle and additive native capability. |
| R10 | Bulk/protocol sprawl and code golf | Minimal v13 subset only (AUTH, SET_CLIENT_NAME, GET_SERVER_INFO/default-sink probe, CREATE_PLAYBACK_STREAM, PLAYBACK_STREAM writes, DRAIN, DELETE); small appendix; ~400-line advisory per unit with tests kept with behavior. |

## Specs

- **S1 — Scope and authorization.** Now **implemented/prepared for Linux/WSLg
  (N1a–N4), Windows (`0c6eaea6`), the derived WSL Windows-interop target
  (`57fbe506`) and macOS `afplay`; default routing at `fe8d8fc3`.** Prepared
  without physical evidence and without any universal-support claim. Own Node
  client. Forbidden: new
  packages, `pulseaudio.js` dependency, new npm, CLI player/system library
  install, global config/activation, physical-play claim, push/PR. The parent
  commits locally per unit and owns review; the delegated writer's
  no-subagents/no-commit/no-review rule was a **worker-local constraint**, not a
  user prohibition.
- **S2 — Isolation.** The native client runs as its own standalone Node worker
  (`lib/notification-pulse-worker.ts`, owned source `.ts`) launched with
  `process.execPath`, argv only, `shell:false`, built-in type stripping. No
  generated `runtime/*.mjs`; no Addon, precompiled binary, or ABI dependency; and
  no postinstall download added by this work. It is a directed parent→child
  helper, not an SDK agent, and it never loads the agent extension graph.
- **S3 — Transport.** Built-in `node:net` Unix `SOCK_STREAM` to the resolved
  Pulse socket. Explicitly no TCP, no network, no shared memory, no ancillary
  file descriptors. Packet framing is bounded and length-checked; malformed or
  oversized frames fail closed.
- **S4 — Protocol subset (v13).** Tagged tagstruct codec plus AUTH,
  SET_CLIENT_NAME, GET_SERVER_INFO/default-sink probe. **No streams and no
  samples** during probe, and no probe ever on import/render/off — only when the
  owner scheduler actually needs to play or an explicit preview happens.
- **S5 — PCM flow.** After a trusted snapshot, stream raw WAV PCM frames
  (mono/stereo, 8/16/24/32-bit, 8k–192k, ≥44-byte RIFF, ≤2 MiB, ≤5 s already
  enforced) then DRAIN and DELETE. Support cancel and socket close at any stage.
- **S6 — Snapshot and cleanup.** A trusted private snapshot is revalidated
  (content magic + limits) immediately before streaming, then drained and
  deleted. Abort/socket close are graceful; timeout is parent-driven SIGKILL at
  6000 ms; the promise settles only after `close` **and** cleanup, mirroring the
  existing `NotificationPlayer.run` contract.
- **S7 — Start gate.** `permit.start()` is called synchronously immediately
  before spawning the worker, with no `await` between the gate and the spawn, so
  the scheduler TTL/generation remains the final authority.
- **S8 — Context silence.** Child agents, headless mode, and all RPC remain
  silent via the existing `notificationContextAllowed` guard; only the
  interactive parent TUI can play.
- **S9 — Capability routing.** Aggregate native + external capabilities; native
  phase 1 = WAV only. External player detection and OGG/FLAC routing stay
  intact. No configuration schema change; `backend: "auto"` remains the only
  value. Native codec expansion (OGG/FLAC decode) is a future separate unit.
- **S10 — Cookie handling.** Read an existing regular cookie file only;
  `O_NOFOLLOW`, bounded ≤256 bytes, single bounded read, never created, never
  logged, never included in diagnostics. AUTH always carries **exactly 256
  bytes** (`PA_NATIVE_COOKIE_LENGTH`); when no cookie file exists we send 256
  zero bytes and rely on the local Unix peer credential (`SO_PEERCRED`
  `uid == getuid()`) for authorization. If the server rejects
  (`PA_COMMAND_ERROR`/`PA_ERR_ACCESS`), fail closed to the external backend.
- **S11 — Platform phases.** Linux/WSLg, Windows (direct and WSL
  Windows-interop) and macOS are all **prepared** now; only Linux/WSLg has a real
  read-only probe. Windows uses the included PowerShell `SoundPlayer` from the
  fixed `C:\Windows` host (never `PATH`/config-redirected); macOS uses the
  included `afplay` CLI. No compiled CoreAudio/WASAPI helper, no installer, no
  new dependency, and no newly claimed physical support; physical listening is
  future optional work.
- **S12 — Budget and evidence discipline.** Forecast **~1,350–1,600 authored
  lines total** (code + tests + runtime pack checks + docs; vendor 0), no code
  golf. Units N0–N5, ~400 advisory cap, tests stay with the behavior they
  protect; split once honestly if an indivisible unit exceeds the cap. RED/GREEN
  are **active per unit** (L3–L7); the earlier plan-only stance is superseded and
  already-shipped evidence stands.
- **S13 — Protocol provenance.** The local PulseAudio **v17.0** references are
  read-only: no dependency, not executed, not vendored. We derive the protocol
  declaration only (LGPL-2.1+ upstream implementation is not copied).
  `janakj/pulseaudio.js` 1.3.4 (ISC) remains an unread JS cross-check; if used,
  cite its pinned revision and human derivation, no code copy, credit if
  substantial borrow (disallowed without clear provenance).

## Protocol references (read-only, verified this turn)

Local set under `/tmp/gentle-native-audio-reference/`: official
`pulseaudio/pulseaudio` tag **v17.0**, fetched from
`https://raw.githubusercontent.com/pulseaudio/pulseaudio/v17.0/<path>` (read-only,
not a dependency, not executed, not vendored; upstream implementation is
LGPL-2.1+ and is not copied). Local SHA-256 verified equal to the parent list:

| Upstream path | SHA-256 (prefix) |
|---|---|
| `PROTOCOL` | `c84919fbec…dad0a22` |
| `src/pulsecore/native-common.h` | `17b6f9d7…6d587844` |
| `src/pulsecore/tagstruct.h` | `f6eeb000…e2afa318c` |
| `src/pulsecore/tagstruct.c` | `79e87b41…9dfb99b640` |
| `src/pulse/stream.c` | `c0c1eced…3b4478123` |
| `src/pulse/context.c` | `f2192d1f…398153b0` |
| `src/pulsecore/protocol-native.c` | `534873cd…d12d1871b25` |
| `src/pulsecore/pstream.h` | `9de05d0f…9f906279` |
| `src/pulsecore/pstream.c` | `318e43f2…ec9a5e7e` |
| `src/pulse/sample.h` | `ec2e621b…bd1571a9` |

Reading followed the parent's bound: targeted function bodies / tag defs / enum,
not the full large C files. The protocol declaration is derived from those
anchors; no upstream code is reproduced in this plan or copied into the client.

## Protocol appendix (verified, PulseAudio v17.0)

Citations are `file:line` in the set above. Numeric command values are the
C-enum order of `native-common.h:27+` (the enum *is* the wire value).

### Wire frame (20-byte descriptor)

Every frame begins with a descriptor of **5 big-endian `u32`**: `Length,
Channel, OffsetHi, OffsetLo, Flags` (`pstream.h:57-62,76`;
`PA_PSTREAM_DESCRIPTOR_SIZE` = 5×4 = 20 bytes). `Length` is the payload byte
count. Two frame kinds are distinguished by `Channel`:

| Frame kind | Channel | Flags | Payload | Source |
|---|---|---|---|---|
| Control/command | `0xffffffff` | `0` | tagstruct `[u32 command][u32 tag][args]` | `pstream.c:627-632,985-991` |
| PCM memblock | current stream index (≠ `0xffffffff`) | seek mode (`0` = relative) | raw PCM bytes only | `pstream.c:641-726,991-1010` |

Decode rejects a control frame whose flags ≠ 0, a memblock whose seek mode >
`PA_SEEK_RELATIVE_END`, and SHM/memfd flag frames (`pstream.c:985-1010`). PCM
write frames carry no tagstruct wrapper.

### Tagstruct codec

| Element | Layout | Source |
|---|---|---|
| `u32` | `'L'` + 4 bytes BE | `tagstruct.c:129,212-216` |
| `u8` | `'B'` + 1 byte | `tagstruct.c:219-223` |
| `string` | `'t'` + NUL-terminated bytes | `tagstruct.c:196-210` |
| `string NULL` | `'N'` | `tagstruct.c:209` |
| `arbitrary` | `'x'` + **raw BE `u32` length** + bytes | `tagstruct.c:236-242` |
| `boolean` | one byte `'1'`/`'0'` | `tagstruct.c:245-248` |
| `usec` | `'U'` + two BE `u32` | `tagstruct.c:261-264,147-150` |
| `proplist` | `'P'` + entries + `'N'`; each entry = `string` key + **tagged `u32` (`'L'`) valueLength** + `arbitrary` (`'x'` + **raw BE `u32`** valueLength + bytes). Both length fields carry the same value; do not confuse the tagged `u32` with the raw `arbitrary` length. | `tagstruct.c:313-335`, decoder `tagstruct.c:586-616` |

Tags (`tagstruct.h`): `STRING='t'`, `STRING_NULL='N'`, `U32='L'`, `U8='B'`,
`ARBITRARY='x'`, `BOOLEAN_TRUE='1'`/`FALSE='0'`, `USEC='U'`,
`SAMPLE_SPEC='a'`, `CHANNEL_MAP='m'`, `CVOLUME='v'`, `PROPLIST='P'`. Note the
upstream constraint: a proplist may only be at the end of a packet or before a
`STRING` (`tagstruct.h:26-28`).

Command values (enum order): `ERROR=0, TIMEOUT=1, REPLY=2,
CREATE_PLAYBACK_STREAM=3, DELETE_PLAYBACK_STREAM=4, AUTH=8, SET_CLIENT_NAME=9,
DRAIN_PLAYBACK_STREAM=12, GET_SERVER_INFO=20, REQUEST=61`.

Sample formats (`sample.h:134-183`): `U8=0`, `ALAW=1`, `ULAW=2`, `S16LE=3`,
`S16BE=4`, `FLOAT32LE=5`, `FLOAT32BE=6`, `S32LE=7`, `S32BE=8`, `S24LE=9`
(**packed** 24-bit LE), `S24BE=10`, `S24_32LE=11`, `S24_32BE=12`. WAV PCM maps
8→`U8`, 16→`S16LE`, **24→`S24LE` (packed, value 9) — not `S24_32LE` (11)**, 32
→`S32LE`; endianness follows the WAV container (LE).

### Message layouts (protocol v13)

| Message | Payload (after `u32 command, u32 tag`) | Source |
|---|---|---|
| AUTH (c→s) | `u32 version`, `arbitrary cookie` of exactly **256** bytes | `protocol-native.c:2576`, `native-common.h` (`PA_NATIVE_COOKIE_LENGTH 256`) |
| AUTH reply (s→c) | `u32 server_version \| flags` (`0x80000000` SHM, `0x40000000` memfd; top 16 bits reserved, stripped by `PA_PROTOCOL_VERSION_MASK`) | `protocol-native.c:2708`, `context.c:507-535` |
| SET_CLIENT_NAME (c→s, v13) | `proplist` (**not** a string; the client name is `PA_PROP_APPLICATION_NAME` inside the proplist) | `protocol-native.c:2763`, `context.c:578` |
| SET_CLIENT_NAME reply (v13) | `u32 client_index` | `protocol-native.c:2782` |
| GET_SERVER_INFO (c→s) | empty | `protocol-native.c:3685` |
| GET_SERVER_INFO reply (v13) | `string server_name`, `string server_version`, `string user`, `string host`, `sample_spec`, `string default_sink`, `string default_source`, `u32 cookie`; **v≥15 adds `channel_map` (excluded at v13)** | `protocol-native.c:3695-3730` |
| CREATE_PLAYBACK_STREAM (c→s, v13) | `sample_spec`, `channel_map`, `u32 sink_index`, `string sink_name`, `u32 maxlength`, `bool corked`, `u32 tlength`, `u32 prebuf`, `u32 minreq`, `u32 syncid`, `cvolume volume`, 7×`bool` (no_remap, no_remix, fix_format, fix_rate, fix_channels, no_move, variable_rate), `bool muted`, `bool adjust_latency`, `proplist` | `protocol-native.c:1909-1966` |
| CREATE_PLAYBACK_STREAM reply (v13) | `u32 stream_index`, `u32 sink_input_index`, `u32 missing` (**initial requested bytes**), v≥9 `u32 maxlength,tlength,prebuf,minreq`, v≥12 `sample_spec, channel_map, u32 sink_index, string sink_name, bool suspended`, v≥13 `usec configured_sink_latency` | `protocol-native.c:2077-2113` |
| PLAYBACK_STREAM write (c→s) | **PCM memblock frame** (not a tagstruct): descriptor `Channel = stream index`, `Flags = 0`, `Length = PCM bytes`; payload is raw PCM only | `pstream.c:641-726`, `stream.c:1538,1572` |
| DRAIN_PLAYBACK_STREAM (c→s) | `u32 stream_index`; empty `REPLY` when drained | `protocol-native.c:2828-2845` |
| DELETE_PLAYBACK_STREAM (c→s) | `u32 stream_index`; empty `REPLY` (simple ack) | `protocol-native.c:2141-2188` |
| ERROR (s→c) | `u32 error_code` and EOF | `context.c:448-459` |
| REPLY (s→c) | handler-defined body, matched by `tag` | `context.c:487-503` |
| REQUEST notification (s→c) | `u32 tag = 0xffffffff`, `u32 stream_index`, `u32 bytes`; the server pulls PCM from a **non-SHM** client | `protocol-native.c:686`, `playback_stream_request_bytes` `protocol-native.c:1117-1141`; client `context.c:75`, `stream.c:826-870` |
| SUBSCRIBE_EVENT / UNDERFLOW / … | unsolicited and **interspersed**; demultiplex by command/tag | `protocol-native.c:3739`, `context.c:355` |

**SHM disabled ≠ no REQUEST.** Our client announces `version = 13` with the SHM
MSB clear, so the server sets `shm_on_remote=false` and `do_shm=false`
(`protocol-native.c:2588-2600`, `context.c:522-539`) and never uses shared
memory. For **non-SHM** PCM the server still pulls data with unsolicited
`PA_COMMAND_REQUEST` notifications (`protocol-native.c:686`;
`playback_stream_request_bytes` `protocol-native.c:1117-1141`). The client must
handle REQUEST: match `stream_index` to the current stream, accumulate `bytes`
into a bounded remaining counter (cap adversarial values), and write PCM via
memblock frames (`stream.c:826-870`). The initial `missing` value in the
CreatePlaybackStream reply is the first request; later REQUEST notifications
continue. The client never sends REQUEST. We never send ancillary FDs; if
SHM/memfd-flag frames or SHM refund/revoke control frames ever arrive, fail
closed.

**Auth with no cookie file.** `PA_NATIVE_COOKIE_LENGTH` is 256, so AUTH always
carries exactly 256 bytes; with no cookie file we send 256 zero bytes. The
server authorizes on the local Unix `SO_PEERCRED` (`creds->uid == getuid()`,
possibly via `auth_group`) or the cookie; otherwise it replies
`PA_COMMAND_ERROR`/`PA_ERR_ACCESS` (`protocol-native.c:2610-2645`) and our
client fails closed to the external backend. A real read-only probe is **N1b**
only; **no probe evidence exists yet**.

## Tasks

| Unit | Intent | Candidate paths | Forecast (authored) | Acceptance / focused checks |
|---|---|---|---|---|
| **N0** | This plan, committed `9282b002` **[x]** (399 lines). | `odd/tasks/native-audio-backend.md` | 399 observed (docs) | Specs → Tasks → Log; measured baseline; L2 verification corrections (B1–B3) applied. RED/GREEN N/A. |
| **N1a** | Tagged tagstruct codec + bounded fake frames (no socket, no server). **[x] committed `b2bdee09`.** | `lib/notification-pulse-protocol.ts` (305), `tests/notification-pulse-protocol.test.ts` (213) | ≤400 forecast; **518 observed** | Round-trip encode/decode of the verified tags (`u32`, `u8`, `string`, `arbitrary`, `boolean`, `usec`, `sample_spec`, `cvolume`, `proplist`); command+tag prefix; bounded small frames; malformed/truncated fields fail closed. Unknown sample-format enum values may remain and block **N2**, not N1a. |
| **N1b** | Client transport: Unix connect, AUTH (v13/256-byte cookie/no-SHM), SET_CLIENT_NAME, GET_SERVER_INFO/default-sink. Real **read-only** probe (no stream/sample). **[x] committed `7ea3e15a`.** | `lib/notification-pulse-client.ts` (+38), `tests/notification-pulse-client.test.ts` (356) | ≤400 forecast; **684 observed** | Fake-server golden tests plus a real read-only probe that returns server info without opening a stream; ERROR/REPLY/timeout/interspersed handling; cookie absent → 256 zero bytes → peer-credential or fail closed. |
| **N2** | PCM flow + DRAIN + DELETE + cancel against a **fake Unix server, no audio**. **[x] committed `597e4d27`.** | `lib/notification-pulse-stream.ts` (212), `tests/notification-pulse-stream.test.ts` (275), `lib/notification-pulse-client.ts` (+38) | ≤600 forecast; **525 observed** | Strict WAV parse/mapping; CREATE v13 golden wire; REQUEST-driven aligned PCM memblocks; early/coalesced/unknown REQUEST; mismatched spec; budget/abort/backpressure; DRAIN+DELETE acks; bounded per-request deadline. |
| **N3** | Bridge + standalone worker via owned `process.execPath` + fixed flags (source `.ts`, **no generated runtime**). **[x] committed `e368e74a`.** | `lib/notification-audio-native.ts` (149), `lib/notification-pulse-worker.ts` (66), `tests/notification-audio-native.test.ts` (246), `scripts/verify-package-files.mjs` (+5), `tests/package-manifest.test.ts` (+~28) | ≤400–600 forecast; **~489 observed** | Lazy no-IO bridge; Linux-only; scrubbed child env; bounded stdout/stderr; JSON `gentle.audio.pulse/v1`; SIGKILL once + settle on close; probe unavailable / play generic reject; real fake-socket worker probe (no CREATE) + fake PCM play (no OS audio); verifier 179. |
| **N4** | Native-first Linux routing + CLI fallback + docs. **[x] committed `7f1b87ac` (parent).** | `lib/notification-audio.ts` (~130 changed), `lib/notification-audio-native.ts` (+20), tests `notification-audio`/`native`/`pulse-stream` (+~152), `README.md`, `docs/sound-notifications.md` | ~500 allowance; **~327 changed** | Aggregate capabilities; native WAV preferred, CLI OGG/FLAC retained; format validated before backend choice; native error never retries CLI; gate called once; all old tests inject a fake native (no real audio); 194 notif / 86 focused. |
| **N5** | Default full / typecheck / package offline functional closure. **[x] functionally verified at L13** (historical L9 BLOCKED preserved as history, not rewritten). | docs + closure records only | 60–120 | Current candidate `env pnpm_config_verify_deps_before_run=false npm_config_verify_deps_before_run=false node scripts/run-test-suite.mjs` → **exit 0: unit 4993 total / 4959 pass / 0 fail / 34 skip**, provider-contract and runtime harness PASS (L13). `check-types` **186** no regressions; runtime **8**; verifier **180/69**; focused `package-manifest` **58**; writer focal **224** + Windows **27** + audio **25** + native **11** (combined **63**). The ordinary installed packed-package `test:packed-package` E2E was **NOT run** (no install). Historical `history-session-scan` L9 failure preserved as history. |

Dependencies: **N1a → N1b → N2 → N3 → N4 → N5**; N0 precedes all. Each unit
is independently committed by the **parent** after its focused checks pass. If a
unit exceeds ~400 authored lines without a clean split, record the honest delta
in the Log rather than trimming tests or code-golfing.

**Generated-slice accounting (N3) — SUPERSEDED, not current source truth.** This
was an early N3 assumption. The actual engine is `node >=22.19.0` with built-in
type stripping, so **no runtime helpers are generated** and the runtime-module
count stays **8** (U5). The historical forecast (3–4 `runtime/*.mjs` helpers,
runtime 8 → 11–12) is retained only as provenance; it is not current source truth.

## Provisional artifacts — HISTORICAL plan (superseded by committed N1a–N4)

- New (delivered as source `.ts`; **no generated `runtime/*.mjs`**):
  `lib/notification-pulse-protocol.ts` (codec), `lib/notification-pulse-client.ts`
  (transport/auth/probe), `lib/notification-pulse-stream.ts` (PCM/drain/delete),
  `lib/notification-audio-native.ts` (bridge), and the owned worker
  `lib/notification-pulse-worker.ts`; plus their tests and the fake-server
  fixture. The generated-runtime list below is a superseded N3 assumption (U5).
- Modified (as planned): `scripts/verify-package-files.mjs`,
  `lib/notification-audio.ts`, `README.md`, `docs/sound-notifications.md`.
  `scripts/build-runtime-modules.mjs`, `lib/notification-service.ts` and
  `lib/notification-customize.ts` needed no native change.
- Explicitly unchanged: `lib/notification-policy.ts` schema (no new `backend`
  value), `lib/notification-scheduler.ts`, `extensions/gentle-notifications.ts`
  context guards, the six-control basic card, and the 9a1 OGG/FLAC validators.

## Uncertainties and open items

- **U1 — Sample-format enum: RESOLVED.** `sample.h:134-183` gives `U8=0`,
  `S16LE=3`, `S32LE=7`, `S24LE=9` (packed), `S24BE=10`, `S24_32LE=11`. Packed
  24-bit WAV maps to `S24LE` (9), **not** `S24_32LE` (11). No remaining gap.
- **U2 — Native packet header: RESOLVED.** `pstream.h:57-62,76` gives the
  20-byte descriptor = 5 BE `u32` `Length, Channel, OffsetHi, OffsetLo, Flags`;
  `pstream.c:612-730,985-1010` gives the frame/decode rules. No remaining gap.
- **U3 — Cookie/auth on WSLg.** No cookie file exists at the usual paths and no
  `/etc/pulse/*` config is present. Plan: send 256 zero bytes and rely on
  `SO_PEERCRED` same-uid auth; otherwise fail closed. Never read/log cookie bytes.
- **U4 — SHM/REQUEST: corrected.** `[PA_COMMAND_REQUEST]=NULL` in the server
  table is the **inbound** (client→server) dispatch only; the server still
  **emits** REQUEST outbound for non-SHM PCM. Client handling is specified in
  the appendix; no ancillary FDs are ever used and SHM/memfd frames fail closed.
- **U5 — Worker packaging model: RESOLVED by the actual Node engine.** The
  `package.json` engine is `node >=22.19.0`, which supports built-in type
  stripping, so the worker runs as owned source `.ts` under `process.execPath`
  with `--experimental-strip-types` and `--max-old-space-size=32`. No generated
  `runtime/*.mjs`, no `build-runtime-modules.mjs` edits, runtime stays 8 and the
  69 byte pins are unchanged; the owned TS lib is legitimate and no addon/C
  toolchain is involved.
- **U6 — Physical evidence.** The real probe is N1b (read-only, no sound); it
  returned available/`wav` on WSLg, but that is **not** physical proof. Audible
  output on WSLg and any Linux desktop variant remains pending manual
  verification, and no support is claimed until then.
- **U7 — Baseline drift: re-measured.** Runtime count stayed **8**; resources
  moved to **179** with **69** pins after N3 (the 174/8 figures were the
  `9a1f8a75` baseline). Typecheck diagnostics stayed **186** (no regressions).
- **U8 — Native review unavailable: resolved for the doc stage.** The managed
  assets remain outdated and the sync was not executed, so **native review is
  still unavailable**. The independent document verifier did run on the staged
  plan and returned the B1–B3 corrections now applied; a staged passive
  structural ASSESS needs no independent run. Tooling state, not a source risk.

## Log

### N0 — Planning turn (this document)

- Approval relayed by the parent: "go"; phases "IN PHASES"; own client "SIN
  NUEVOS PAQUETES"; start Linux/WSLg. Logged as relayed, not re-litigated.
- Read (bounded): `lib/notification-audio.ts`, `lib/notification-service.ts`,
  `lib/notification-policy.ts`, `lib/notification-customize.ts` (guard/row
  context), `extensions/gentle-notifications.ts`, `odd/tasks/sound-notifications.md`
  (S9/S12/S14–S17 + L7/L9), `docs/sound-notifications-proposal.md`,
  `scripts/build-runtime-modules.mjs`, `scripts/verify-package-files.mjs`.
- Measured: `node scripts/verify-package-files.mjs` → 174 files / 69 pins
  (exit 0); runtime modules 8; tree clean at `9a1f8a75`; pulse socket symlink
  exists; no cookie at standard paths; Node v24.20.0.
- No code, tests, runtime generation, assets, dependency, package, or global
  config was written. RED/GREEN are not active for a documentation-only turn;
  no RED/GREEN evidence is claimed. No implementation/support/physical claim.
- Protocol references (read before implementation): official PulseAudio **v17.0**
  `PROTOCOL`, `src/pulsecore/native-common.h`, `tagstruct.h/.c`,
  `protocol-native.c`, `src/pulse/stream.c`, `src/pulse/context.c`; JS
  `janakj/pulseaudio.js` 1.3.4 (ISC, unread cross-check only, no dependency/copy).
- Next: begin **N1a** (codec + bounded fake frames) with focused RED/GREEN and a
  local parent commit.

### N0b — Reference read, protocol appendix (this turn)

- Local read-only set `/tmp/gentle-native-audio-reference/` = PulseAudio tag
  **v17.0**; all seven SHA-256 digests re-computed and equal to the parent list.
  Not a dependency, not executed, not vendored; upstream is LGPL-2.1+ and no
  implementation code was copied.
- Targeted reads only (function bodies / tag defs / enum): `tagstruct.c:90-380`,
  `native-common.h` command enum + cookie constants, `protocol-native.c`
  AUTH/CREATE_PLAYBACK_STREAM/DELETE/DRAIN/GET_SERVER_INFO/set_client_name,
  `context.c` AUTH/SET_CLIENT_NAME/ERROR dispatch.
- Verified and recorded: 20-byte command frame header; payload prefix
  `u32 command, u32 tag`; ASCII tag tokens and BE `u32`; AUTH = `u32 version` +
  exactly 256-byte cookie; v13 SHM MSB clear ⇒ SHM/memfd off (the outbound
  REQUEST handling was corrected in L2: the server still emits REQUEST for
  non-SHM PCM); SET_CLIENT_NAME
  v13 uses a **proplist** (client name is `PA_PROP_APPLICATION_NAME`);
  GET_SERVER_INFO v13 fields (no `channel_map`); CREATE_PLAYBACK_STREAM v13
  request and reply (`missing` requested bytes); DRAIN/DELETE shapes; ERROR =
  `u32 error_code`; interspersed REPLY/EVENT handling.
- Doc changes: N1 blocker (upstream unread) removed; protocol appendix replaced
  with the verified wire/message tables + citations; N1 split into **N1a** and
  **N1b** (each ≤400); N2 ≤400; N3 generated slice accounted separately; U-items
  rewritten (U1 = sample-format enum blocks N2 not N1a); native-review/untracked
  state recorded (U8).
- Still DOCS ONLY: no code, no tests, no source execution, no audio, no server
  connect, no global config, no cookie content read. RED/GREEN not active; none
  claimed. N1a was ready to start pending staging/verification.

### L2 — Independent document verification corrections

Independent document verifier ran on the staged plan and returned **3
substantive corrections (B1–B3)**, and **2 open items (U1, U2) closed** now that
`pstream.h/.c` and `sample.h` are in the reference set (3 new files; the original
7 digests preserved). Applied:

- **B1** — "no SHM" ≠ "no REQUEST". The server emits `PA_COMMAND_REQUEST` for
  non-SHM PCM (`protocol-native.c:686`, bytes at `:1117-1141`); the client
  matches the stream and accumulates (`context.c:75`, `stream.c:826-870`). Fixed
  R4, the SHM paragraph, U4, and the appendix REQUEST row; the initial `missing`
  value **and** later REQUEST notifications are both required.
- **B2** — PCM is a memblock frame (descriptor `Channel=stream index`, `Flags=0`,
  `Length=bytes`, raw PCM payload), never a tagstruct packet; control frames use
  `Channel=0xffffffff`, `Flags=0` (`pstream.c:612-730,985-1010`;
  `stream.c:1538,1572`). Fixed the write row.
- **B3** — `proplist` entry = string key + tagged `u32` (`'L'`) valueLength +
  arbitrary value (its own **raw BE `u32`** length, same value) + `'N'`
  terminator (`tagstruct.c:313-335`, decoder `:586-616`). Fixed before N1a.

Auth v13 / no-SHM sources were confirmed correct; no sample read/play; the
cookie-absent plan is 256 zero bytes → local peer credential / authAnonymous,
else fail. Still DOCS ONLY: no tests, code, source execution, audio, server
connect, global config, or cookie content read. Passive doc close; ~399 lines,
within the 400 planning allowance (no shrink/code-golf). N1a is ready after
these fixes; **no source implementation until the parent's explicit follow-up**.

### L3 — N1a codec: RED before source, GREEN, triangulation

- Route: single writer, focused. Surfaces: `lib/notification-pulse-protocol.ts`,
  `tests/notification-pulse-protocol.test.ts`, this doc.
- **RED observed before any production source**: `node --experimental-strip-types
  --test tests/notification-pulse-protocol.test.ts` → exit 1, `ERR_MODULE_NOT_FOUND`
  for `lib/notification-pulse-protocol.ts`, 0 pass / 1 fail. The test file was
  written first and the module did not exist (honest first-creation RED).
- **GREEN**: the same command after the pure module → 16/16, exit 0.
- **TRIANGULATE**: added memblock nonzero-offset/seek, binary proplist value,
  encoder oversize/channel rejection, empty push → **19/19, exit 0**.
- **Surrounding (proportionate, no full suite)**: `node --experimental-strip-types
  --test tests/*notification*.test.ts` → 141/141 pass, exit 0.
  `node scripts/check-types.mjs` → exit 0, **186 recorded diagnostics, no
  regressions**, 12 pairs improved (baseline 186 unchanged; no `--update`).
  `git diff --check` clean.
- **IO zero**: the module is pure — no `node:fs`/`node:net`/timers/process/spawn;
  the tests touch no fs, network, clock, or process.
- **Cost (honest overage)**: source 305 + tests 213 = **518 authored lines**, over
  the 350–400 forecast by ~118–168; cohesive golden vectors and the full verified
  primitive set, deliberately not code-golfed. Reported before any extra scope.
- API delivered for N1b/N2: `NATIVE_PROTOCOL_VERSION`, `CONTROL_CHANNEL`,
  `PulseCommand`, `MAX_CONTROL_PAYLOAD`, `MAX_FRAMES_PER_PUSH`,
  `boundedPulseTagWriter/Reader`, `encodePulseFrame`, `boundedPulseFrameDecoder`
  (readable generic errors, no values echoed).
- N1a stays **unchecked** until the parent commits it. Next: **N1b** (client
  transport, AUTH, real read-only probe), not started.

### L4 — N1b client: RED before source, GREEN, real read-only probe

- Route: single writer, focused. Surfaces: `lib/notification-pulse-client.ts`,
  `tests/notification-pulse-client.test.ts`, this doc. N1a committed at
  `b2bdee09`; the upstream protocol errors B1–B3 remain corrected.
- **RED observed before any production source**: `node --experimental-strip-types
  --test tests/notification-pulse-client.test.ts` → exit 1,
  `ERR_MODULE_NOT_FOUND` for `lib/notification-pulse-client.ts`, 0 pass / 1 fail.
- **GREEN**: same command after the pure client → 18/18, exit 0.
- **TRIANGULATE**: symlinked socket path (WSLg style, followed without rewrite)
  and zero-cookie-from-missing-path with no file creation → **20/20, exit 0**.
- **Surrounding (no full suite)**: `node --experimental-strip-types --test
  tests/*notification*.test.ts` → 161/161 pass, exit 0. `node scripts/check-types.mjs`
  → exit 0, **186 recorded diagnostics, no regressions** (baseline 186, no
  `--update`). `git diff --check` clean.
- **Real read-only WSLg probe (permitted after GREEN)**: `PulseClient().probe()`
  → `{"available":true,"formats":["wav"]}`, exit 0. AUTH v13 with a 256-zero
  cookie was accepted (local peer credentials / anonymous), SET_CLIENT_NAME and
  GET_SERVER_INFO returned a default sink. **No stream was created, no samples
  sent, no config/UI activation, no cookie file created** (standard paths still
  absent), and only `available`/`formats` were printed — no cookie, user, host or
  path.
- **IO surface**: `node:fs`, `node:fs/promises`, `node:net`, `node:os` only; no
  packages, addons or third-party code; no logging; lazy — import/constructor do
  no IO and only `connect()`/`probe()` dial the socket.
- **Cost (honest overage)**: source 328 + tests 356 = **684 authored lines**, over
  the 400–500 forecast by ~184–284; cohesive golden vectors, independent
  fake-server replies, and the full safety matrix (socket/cookie guards, bounds,
  abort/close, fragments, SHM, multiplex/timeout) were kept, not code-golfed.
  Reported before any extra scope.
- API for N2: `PulseClient` (`connect`, `request`, `authenticate`, `serverInfo`,
  `probe`, `sendDataFrame`, `close`, `onEvent`), `resolvePulseSocketPath`,
  `resolvePulseCookiePath`, `loadPulseCookie`, `PulseCookieError`; generic
  value-free errors.
- N1b stays **unchecked** until the parent commits it. Next: **N2** PCM flow
  (fake Unix server, drain/cancel), not started.

### L5 — N2 stream: RED before source, GREEN, no real playback

- Route: single writer, focused. Surfaces: `lib/notification-pulse-stream.ts`,
  `lib/notification-pulse-client.ts`, `tests/notification-pulse-stream.test.ts`,
  this doc. N1b committed at `7ea3e15a`.
- **RED observed before any new stream/client source**: `node --experimental-strip-types
  --test tests/notification-pulse-stream.test.ts` → exit 1,
  `ERR_MODULE_NOT_FOUND` for `lib/notification-pulse-stream.ts`, 0 pass / 1 fail
  (tests written first; the two type-level client gaps — `setTimeout` option and
  `sendDataFrame: Promise<void>` — were part of the same RED).
- **GREEN**: `node --experimental-strip-types --test tests/notification-pulse-stream.test.ts
  tests/notification-pulse-client.test.ts tests/notification-pulse-protocol.test.ts`
  → **52/52, exit 0** (stream 13, client 20, protocol 19). No old client/protocol
  test changed.
- **TRIANGULATE**: strict WAV rejections (invalid/short/3-channel/low-rate/5.58 s/>2 MiB),
  tiny unaligned REQUEST accumulation, huge `0xffffffff` REQUEST bound, early
  coalesced REQUEST, unknown-stream REQUEST, mismatched reply spec, truncated
  transport, ERROR-on-drain, budget/mand, abort best-effort DELETE, and the
  extended DRAIN deadline via an injected clock — all green.
- **Surrounding (no full suite)**: `node --experimental-strip-types --test
  tests/*notification*.test.ts` → 174/174 pass, exit 0. `node scripts/check-types.mjs`
  → exit 0, **186 recorded diagnostics, no regressions** (baseline 186, no
  `--update`). `git diff --check` clean.
- **No real playback**: all stream tests use a fake Unix server that emits no OS
  samples; the module performs no real Pulse stream, no DRAIN/DELETE against the
  live server, and no audio. No console/process output. The read-only probe was
  not repeated as physical proof.
- **Cost (within budget)**: stream 212 + stream tests 275 + client delta 38 =
  **525 authored lines**, inside the 400–600 forecast (no code-golf). Client
  enhancements: bounded per-request timeout override (≤6000 ms), `sendDataFrame`
  returns `Promise<void>` with drain/abort/close and a bounded waiter, and
  injectable timers for deterministic tests.
- API for N3: `parsePulseWav(bytes) -> WavPCM`, `playPulseWav(bytes, signal?,
  {client|clientOptions, adjustLatency, budgetMs, requestTimeoutMs})`; stdlib
  imports are `node:child_process`/`node:fs`/`node:os`/`node:path`/`node:url` via
  the reused `validateNotificationWav` (N3 standalone-worker closure must isolate
  or extract that validator; the class ctor is never called and the module is
  import-pure).
- N2 stays **unchecked** until the parent commits it. Next: **N3** standalone
  worker + generated runtime + pack limits, not started. Physical playback
  remains unverified.

### L6 — N3 bridge + worker: RED before source, GREEN, no physical play

- Route: single writer, focused. Surfaces: `lib/notification-audio-native.ts`,
  `lib/notification-pulse-worker.ts`, `tests/notification-audio-native.test.ts`,
  `tests/package-manifest.test.ts`, `scripts/verify-package-files.mjs`, this doc.
  N2 committed at `597e4d27`.
- **Parent design update applied**: with the actual `node >=22.19.0` engine the
  worker is owned source `.ts` run by `process.execPath`, so there is **no
  generated `runtime/*.mjs`** and no runtime-build edit (U5 resolved).
- **RED observed before any source**: `node --experimental-strip-types --test
  tests/notification-audio-native.test.ts` → exit 1, `ERR_MODULE_NOT_FOUND` for
  `lib/notification-audio-native.ts`, 0 pass / 1 fail (tests written first).
- **GREEN**: native 10/10; combined `tests/notification-audio-native.test.ts
  tests/notification-pulse-stream.test.ts tests/notification-pulse-client.test.ts
  tests/notification-pulse-protocol.test.ts` → **62/62, exit 0**.
- **TRIANGULATE**: lazy/no-IO, Linux-only, scrubbed env, bounded stdout/stderr,
  malformed/oversize/schema-wrong, timeout+abort SIGKILL once, settle only on
  close, gate-false no-spawn, private errors, real fake-socket worker probe (no
  CREATE) and real fake PCM play (no OS audio) — all green.
- **Surrounding (no full suite)**: `tests/*notification*.test.ts` → **184/184**
  (174 + 10 native), exit 0. `node scripts/check-types.mjs` → exit 0, **186
  recorded diagnostics, no regressions**. `node scripts/verify-package-files.mjs`
  → exit 0, **179 files / 69 pins** (5 new source paths; pins/runtime unchanged,
  runtime modules 8). `tests/package-manifest.test.ts` → 57/57 (offline packed
  tarball includes the 5 owned TS sources; no new dependency, addon or install
  script). `git diff --check` clean.
- **No physical play**: the bridge/worker only ran against fake Unix test
  sockets; no real Pulse stream and no OS audio. The read-only probe was not
  repeated. Channel positions remain mono(0)/stereo(1,2) — `pulse/channelmap.h`
  is not in the reference set and should be confirmed before any physical phase.
- **Cost (within budget)**: bridge 149 + worker 66 + native tests 246 +
  package-manifest ~28 + verifier 5 = **~489 authored lines**, inside the
  400–600 forecast (no code-golf). Package offline guard accounted as planned.
- API for N4: `NativePulsePlayer` (`supportsTarget`, `probe`, `play(snapshot,
  signal, gate)`, `getNativeFormats`), `NATIVE_PULSE_SCHEMA`; worker contract
  `node --experimental-strip-types --max-old-space-size=32
  lib/notification-pulse-worker.ts <probe|play> [snapshot]` emitting one line of
  `gentle.audio.pulse/v1` JSON.
- N3 stays **unchecked** until the parent commits it. Next: **N4** routing/UI/
  lifecycle, not started (native audio app remains inactive; Linux first phase).

### L7 — N4 routing: RED before production, GREEN, native preferred (no real audio)

- Route: single writer, focused. Surfaces: `lib/notification-audio.ts`,
  `lib/notification-audio-native.ts`, `tests/notification-audio.test.ts`,
  `tests/notification-audio-native.test.ts`, `tests/notification-pulse-stream.test.ts`,
  `README.md`, `docs/sound-notifications.md`. N3 committed at `e368e74a`.
- N3 independent verifier: **PASS** (focused native/pulse 62, notification 184,
  package 57, verifier 179/69, runtime 8, type 186) — incorporated low findings
  **F1** (allowlisted native child env), **F2** (33-early-REQUEST bound test) and
  **F4** (typed not-permitted gate) within N4, proven by tests.
- **RED observed before production edits**: with the new routing tests and the
  `native:` injection absent, `node --experimental-strip-types --test
  tests/notification-audio.test.ts` had the native-preferred test never complete
  (the old class ignored `native` and took the CLI path; 14 pass, file timeout).
  The two type-level gaps (`NativeAudioBackend`/`native`) were part of the same RED.
- **GREEN**: `tests/notification-audio.test.ts tests/notification-audio-native.test.ts
  tests/notification-pulse-stream.test.ts tests/notification-pulse-client.test.ts
  tests/notification-pulse-protocol.test.ts` → **86/86, exit 0**.
- **Surrounding (no full suite)**: `tests/*notification*.test.ts` → **194/194**,
  exit 0. `node scripts/check-types.mjs` → exit 0, **186 recorded diagnostics, no
  regressions**. `node scripts/verify-package-files.mjs` → exit 0, **179 files /
  69 pins**; runtime 8. `tests/package-manifest.test.ts` → 57/57. `git diff --check`
  clean.
- **No real audio**: every old `NotificationPlayer` construction injects
  `native: unavailableNative()` (or a fake) and the service tests inject a fake
  `backend`; no real Pulse probe, stream, spawn or OS audio ran. The read-only
  WSLg probe was not repeated.
- **Cost (within the before-report allowance)**: +271/-56 changed lines across 7
  files (~327 changed); cohesive routing + test-data matrix retained, not golfed.
- Default routing: Linux prefers native WAV; the CLI keeps OGG/FLAC; capabilities
  union `wav,ogg,flac`; a format no backend supports is rejected before snapshot or
  spawn; a native failure after spawn never retries the CLI; the native gate is
  `() => permit.start()` invoked once by the bridge; the native child env is an
  allowlist.
- Docs: README and `docs/sound-notifications.md` now give the Linux/WSLg quick
  answer (native WAV, no player, server+sink required, read-only probe not
  physical proof), the aggregated capability matrix, and the planned macOS
  CoreAudio / Windows WASAPI phases.
- N4 stays **unchecked** until the parent commits it. Next: the mandatory final
  high-risk verifier over N0–N4; physical listening remains unverified; the
  actual Node here is 24 while the logical minimum engine is 22.19.
  *(Superseded: the parent committed N4 at `7f1b87ac`; see the locator and L8.)*

### L8 — N3 independent verification (High PASS) → F1/F2/F4 fixed in N4

- Independent read-only source verification of N3 returned **High PASS**: the
  protocol/client/stream/bridge/worker matured coherently. The new wire client
  uses the existing GET_SERVER_INFO/AUTH protocol (v13, AUTH cookie, SHM
  disabled), Unix socket only (**no TCP**), and owns **no native libraries**.
- Numbers at that point: focused native/pulse **62**, notification **184**,
  package-manifest **57**, verifier **179 files / 69 pins**, runtime **8**,
  `check-types` **186** (no regressions).
- Three low findings were folded into **N4** and proven by tests: **F1**
  allowlist for the native child env, **F2** queue bound against 33 early REQUEST messages, **F4**
  typed not-permitted gate. Physical playback stayed unverified.

### L9 — N5 final focal GREEN; default suite BLOCKED; environment incident

- **Focal proof (GREEN).** Final focal suites **486/486**: protocol 19, client
  20, stream 14, audio 22, native 11, customize 38, UI 13, service 25, palette
  36, visual 39, shell 249. `package-manifest` **57** separate; `check-types`
  **186, no regressions**; runtime **8**; verifier **179 files / 69 pins**.
- **Native availability (read-only).** A real `NotificationPlayer` probe on WSLg
  returned available / capability `wav` (AUTH + server-info only, **no CREATE, no
  samples, no physical audio**).
- **Offline packed-package closure (no npm install).** `npm pack
  --ignore-scripts --offline` produced the exact tarball; the packed TypeScript
  sources were run with the owned Node worker against a **fake Unix server**
  (probe: AUTH/name/info, no CREATE; play: AUTH/name/CREATE/DRAIN/DELETE, 17640
  fake PCM bytes, 100 ms, budget 6142 ms failure expected). All packed TS sources
  resolved. A temp WAV harness failed first then was fixed (temp test only; honest
  note, **not a product bug**). The ordinary `test:packed-package` **install path
  was NOT run** — no full installed packed-package E2E is claimed.
- **Node version.** Node 24 was tested; the logical minimum engine 22.19 was not
  physically exercised. No physical listen occurred.
- **Whole default suite (RED, reported).** `unit` **4962 total / 4926 pass / 2
  fail / 34 skip**; provider contract + runtime harness PASS. The two failures
  are `history-session-scan` **244/582** (blob unchanged, module unchanged vs
  `9a`): baseline `9a` reproduced the **244** 1/3 → confirmed preexisting; the
  **582** was not reproduced 0/3, so causality is **INCONCLUSIVE** — no
  regression proof and **not** declared a known baseline failure. The failure
  timestamp `Date.now()-5` (5 ms window; observed ~1 ms below its lower bound) suggests environment sources but
  does not prove the 582. **No suite retries to green, no suppression, no
  clock-bound raising, and no unrelated fix** (that needs separate user approval).
- **Environment incident (reported, preserved).** A parallel verifier `pnpm` run
  (type/runtime) with default `verifyDepsBeforeRun=install` treated the ignored
  stale farm `node_modules/.modules.yaml`/`.pnpm-workspace-state` symlinks into a
  sibling `sound-notifications` root as needing install. It auto-downloaded the
  **pre-existing Go release v4** binary (17,109,176 bytes, SHA-verified) into the
  native repo's `.gitignored` `.gentle-ai/v4.0.0` (+228 integrity); one local
  install lock/tombstone race failed. The sibling's ignored modules metadata was
  overwritten (mtime 10:51) with symlinks unchanged; store reused 17, downloaded
  0, added 0. Tracked `package.json`/lockfile stayed clean — no new packages,
  dependencies or root CLI. Global npm/pnpmrc/PI settings mtimes unchanged; no
  compiler (system Go) and no audio/player libraries were downloaded. This is
  **package-local to the ignored farm, not a new audio dependency**, and distinct
  from the **pre-existing, unchanged npm `postinstall` Go step**. Nothing was
  cleaned up — preserved as-is for the user's disposition; all later direct Node
  tests ran with no further install or mutation. The user was told of the 2
  historical failures and the implicit local install; no tokens, env values or
  private endpoints are recorded.
- **Verifier/approval state.** No native RDD approval assets (managed assets
  outdated, sync not run); only independent read-only source verification ran
  (native assess combined **High, 16 files / 3143 changed lines**, base `9a`
  unchanged) with **no Lens-clean claim** and **no approved flag**; native review
  remained unavailable.
- **Cost.** At N4 `7f1b87ac`, `base..HEAD` = **3091 insertions / 52 deletions**
  incl. ODD docs. Several coupled source+test units exceeded the ~400 advisory;
  overruns are recorded above and an independent High-risk verifier ran. This
  is not a claim the initial line forecast was met. Local node/local-process scope; the native-
  audio UI toggle stayed inactive/off, so existing scheduler guards are unaffected.
- **Open / BLOCKED (historical — superseded by L13).** **N5 stayed [ ] BLOCKED
  at this point**: awaiting explicit user
  approval to repair the two historical-suite failures (optional), and any
  physical `<=5 s` WAV playback test needs explicit permission, not assumed. The
  already-authorized `[archivo de audio local anonimizado]` (5.58 s) stays rejected by the unchanged limit —
  no crop. macOS CoreAudio / Windows WASAPI, Node 22 physical, and manual
  listening remain current/future phases as documented. Final verification
  history is **BLOCKED**; no whole-task "done" is claimed.

### L10 — P1 Windows WAV adapter (standalone, not routed); cross-platform scope authorized

- **New user authorization (parent-relayed, not independently re-confirmed here).**
  The user explicitly authorized preparing **WSL + Windows native + macOS** —
  all three phased platforms are to be *implemented and prepared*; **no physical
  evidence is required** for a phase to be prepared, and none was claimed. The
  P1/P2/P3 outlook is now **~600–900 authored lines** in review units of ~400,
  with an independent final High-risk verifier over the full added range
  afterwards. No new packages, no audio-system install, no compiler, no runtime
  download, no Go, no scripts, no global config, no source-original edits, and no
  other worktree. All physical playback remains **forbidden** in this scope.
- **Prior context preserved.** HEAD `25e6b775`. The N5 whole-suite closure stays
  **[ ] BLOCKED**: the historical `history-session-scan` 244 is a confirmed
  pre-existing base failure and the 582 remains inconclusive; neither was
  re-run or rewritten here. The metadata incident stands: **`pnpm` is never
  invoked again**. The real ignored `node_modules` module farm is available with
  no installs; every command below is direct Node.
- **Deliverable.** `lib/notification-audio-windows.ts` — a **standalone**,
  dependency-free Windows WAV adapter that is **not wired into routing** (P1 is
  deliberately inactive by default; routing follows the parent in P3). It exposes
  the same structural `NativeAudioBackend` surface as the Linux bridge
  (`supportsTarget()`, `probe(signal?)`, `getNativeFormats()`,
  `play(snapshot, signal?, gate?)`) without importing the routing type, so no
  `audio -> windows` cycle exists. Class name is the descriptive
  `NativeWindowsPlayer` (not the generic `NativePulse*`).
- **Trust model.** The executable is the trusted fixed literal
  `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`; `SystemRoot`,
  `windir`, `PATH` and config can never redirect it, and a non-default Windows
  root fails closed (honest P1 limitation). This literal intentionally duplicates
  `lib/windows-session-transport.ts` rather than importing that SDK-heavy module.
  Flags are fixed `-NoLogo -NoProfile -NonInteractive -EncodedCommand`; no `.ps1`
  resource, no `ExecutionPolicy` change, no side effects, no native addon.
- **Injection safety.** The snapshot must be a drive-absolute Windows path; URIs,
  drive-relative paths, UNC shares, alternate data streams and control/NUL bytes
  are denied before any spawn (the P2 WSL `\\wsl$` UNC exception is a documented
  seam, not admitted here). The only dynamic value in the command is the
  snapshot encoded as **base64 of its UTF-8 bytes**; the fixed script decodes it
  at runtime, so apostrophes, backticks, `$`, quotes and semicolons can never
  become PowerShell syntax. The child env is a fixed Windows allowlist with
  `SystemRoot`/`windir` forced to `C:\Windows`; PATH, `NODE_OPTIONS`/`NODE_PATH`,
  debug overlays and all credentials are dropped. No snapshot travels through the
  environment, so no `WSLENV` entry is needed for the P2 WSL interop path.
- **Process contract.** Spawn is `shell:false`, `windowsHide:true`,
  `detached:false`, stdio `["ignore","pipe","pipe"]`; stdout is bounded at 1024
  and stderr at 4096; single SIGKILL on abort/timeout; the promise settles
  **only** on `close` (never `exit`/`error`/`kill`); a synchronous spawn throw
  rejects privately with no pending child; a non-zero close or a malformed,
  multiline or oversized envelope fails with a generic error that never leaks the
  private snapshot path. `probe` (~1200 ms) is read-only and never throws;
  `play` (6000 ms) calls the scheduler gate synchronously before the final spawn.
- **RED/GREEN (TDD active).** RED observed **before** the module existed:
  `node --experimental-strip-types --test tests/notification-audio-windows.test.ts`
  → `ERR_MODULE_NOT_FOUND`, **0 pass / 1 fail**. GREEN after the module:
  the same command → **15/15 pass, exit 0**.
- **Validation (direct Node, no `pnpm`, no physical play).**
  `tests/notification-audio-windows.test.ts` → 15/15.
  `tests/notification-audio.test.ts tests/notification-audio-native.test.ts
  tests/notification-audio-windows.test.ts` → **48/48**.
  `tests/*notification*.test.ts` → **209/209** (was 194). `test/package-manifest.test.ts`
  → **58/58** (was 57). `node scripts/verify-package-files.mjs` → **180 files /
  69 pins** (was 179), runtime still 8, no generated module added.
  `node scripts/check-types.mjs` → **186, no regressions**. `git diff --check`
  clean. No physical playback, no real PowerShell probe and no snapshot read ran
  from the tests (all IO is injected).
- **Cost.** P1 adds one source module (~235 lines) + one test file (~275 lines) +
  one verifier path + a package-manifest assertion and one ODD entry — inside the
  P1 ≤~400-diff-line forecast before the second production module; no code golf,
  no security shortcut.
- **Current default: INACTIVE.** `native-audio-backend` routing still prefers the
  Linux native WAV bridge and the CLI fallback; the Windows adapter is exported
  but unreferenced by `NotificationPlayer`. **Next:** P2 WSL derivation
  (`supportsTarget` + the single WSL UNC allowance), then P3 parent-owned routing,
  then the independent final High-risk verifier. No future phase is claimed here.

### L10b — Parent readback correction to P1 (RED before fix, same unit)

- **Parent readback** of L10 found **2 concrete P1 defects** plus one disposal gap;
  all were fixed in the same P1 surfaces with **RED observed before the fix**.
  No source outside `lib/notification-audio-windows.ts`,
  `tests/notification-audio-windows.test.ts` and this ODD file changed; no real
  probe/play, no `pnpm`, no codegraph, no audio integration (P3 still unwired).
- **Bug 1 — probe ignored the exit code.** `probe()` accepted a valid
  `{ok:true,available:true,formats:["wav"]}` envelope even when PowerShell closed
  nonzero, so a failed process could advertise the backend. **RED**: a new fake
  test emitting the ready JSON with `close 1` expected
  `{available:false, formats:[]}` and failed. **Fix**: `probe()` now rejects on
  `result.code !== 0` (as well as abort/timeout/overflow).
- **Bug 2 — stdout growth was unbounded and overflow was not recorded.** The old
  `stdout += String(chunk)` grew past the 1024 cap; an overflow triggered a kill
  but a subsequent `close 0` still let `trim()` accept the buffered valid JSON,
  for both probe and play. **RED**: new fake tests emitting valid ready/played
  JSON plus >1024 bytes of whitespace (in multiple large chunks) expected
  `available:false` / a generic play rejection on `close 0`, and asserted exactly
  one SIGKILL; both failed. **Fix**: stdout/stderr are now bounded **byte**
  buffers (`toBuffer`, `subarray` before storing, byte counters — not JS UTF-16
  string length); overflow is a **sticky** `RunResult.overflowed`; the sticky flag
  is checked before every parse, so `probe` always returns unavailable and `play`
  throws the private generic failure regardless of `close 0` or a still-valid or
  truncated payload. Kill stays single. stderr is capped by byte slice and stays
  unsurfaced.
- **Bug 3 — `SoundPlayer` was never disposed.** The fixed play script now
  pre-initializes `$player = $null` and disposes it in an explicit `finally`
  (`if ($null -ne $player) { $player.Dispose() }`) after success/catch, with no
  extra stdout event. **RED**: a new decoded-script test required `.Dispose`
  inside `finally` and failed. The script still has **base64 as its only dynamic
  value**, so the injection surface is unchanged.
- **RED/GREEN (this correction).** RED **before** the source fix: the four new
  tests failed on the **15-pass / 4-fail** run (`19 tests`, exit 1). GREEN after
  the fix: `tests/notification-audio-windows.test.ts` → **19/19, exit 0**.
- **Validation after the fix (direct Node).** New windows suite **19/19**;
  `notification-audio + native + windows` → **52/52**; `tests/*notification*.test.ts`
  → **213/213** (was 209); `package-manifest` → **58/58**; `verify-package-files`
  → **180 files / 69 pins**, runtime **8**; `check-types` → **186, no regressions**;
  `git diff --check` clean. No physical audio, real probe, snapshot read, `pnpm`,
  or full suite ran.
- **Cost.** P1 grows to roughly **335 source + ~345 test** authored lines
  (~680 total) — still over the ≤~400 P1 forecast; recorded honestly, with no
  security golf. The parent readback correction adds ~50 test lines + ~70 source
  lines in the same unit.
- **State.** Existing **N5 stays [ ] BLOCKED** and unchanged; L9 history is not
  rewritten. The new untracked files remain unassessed by me (no review,
  commit or subagent was run). The parent stages and obtains a fresh independent
  HIGH assessment over the new process boundary **before** any local commit.

### L11 — P2 WSL Windows-interop derivation (same adapter, still unwired)

- **Scope.** P2 extends the P1 `lib/notification-audio-windows.ts` adapter to the
  derived WSL Windows-interop target. HEAD `0c6eaea6`; only the same two files
  plus this ODD entry changed. No routing change: the adapter stays **inactive by
  default** until P3, and no physical play/probe ran (all IO injected, direct Node).
- **Detection (pure, no IO).** `supportsTarget()` returns true for `win32` and for
  `linux` with a valid `WSL_DISTRO_NAME` plus a `/run/WSL/*_interop` `WSL_INTEROP`
  (`isWslTarget`). Missing distro, relative/malformed/traversal interop paths and
  invalid distro names fail closed before any IO; `darwin` and plain Linux stay
  unsupported.
- **Fixed host and env.** WSL spawns the fixed trusted literal
  `WSL_WINDOWS_POWERSHELL_EXE = /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`
  via the default `/mnt/c` automount; `PATH`, `SystemRoot`, `windir` and injected
  executables cannot redirect it and no WSL path translator is spawned. A
  non-`/mnt/c` mount/custom root fails closed at the `probe()` access check. The
  child env is the P1 allowlist with `SystemRoot`/`windir` forced plus only
  `WSL_INTEROP`/`WSL_DISTRO_NAME`; `PATH`, `WSLENV`, snapshots and credentials drop.
- **Snapshot mapping.** `play()` validates a POSIX-absolute snapshot
  (`isWslPosixAbsolutePath`): control bytes, backslashes, colons, `//` and
  `.`/`..` segments are denied, and an externally supplied UNC is never admitted.
  `toWslUncPath(distro, path)` maps it purely to one `\\wsl.localhost\<distro>\...`
  UNC value bounded at 4096; conversion happens before the single gate and the
  final fixed PowerShell spawn. `isWindowsAbsolutePath()` is unchanged and still
  rejects every UNC path.
- **RED/GREEN (TDD active).** RED before the source: the new imports did not exist
  → `node --experimental-strip-types --test tests/notification-audio-windows.test.ts`
  → **0 pass / 1 fail** (module export failure). GREEN after the source: the same
  command → **27/27, exit 0** (19 P1 + 8 new WSL tests). A source guard proves no
  path-translator token exists and no routing import cycle was added.
- **Validation (direct Node, no pnpm, no physical audio).** windows suite 27/27;
  `notification-audio + native + windows` → **60/60**; `tests/*notification*.test.ts`
  → **221/221** (was 213); `package-manifest` → **58/58**; `verify-package-files`
  → **180 files / 69 pins**, runtime **8**; `check-types` → **186, no regressions**;
  `git diff --check` clean. No real PowerShell probe, snapshot read or physical
  play ran (all IO injected).
- **Cost.** Actual **+301/-23** lines across the two files (source +145/-23,
  tests +179) plus this entry — marginally over the ≤300 P2 forecast; recorded
  honestly, no security golf.
- **State.** Default routing unchanged and still **INACTIVE**; N5 stays
  **[ ] BLOCKED** and untouched. Not committed here: the parent owns staging,
  the independent final High-risk verification, and P3 routing wiring.
  *(Superseded by L12: P3 makes these adapters the default route for their
  targets.)*

### L12 — P3 default routing: prepared adapters selected by pure platform/env

- **Scope.** P3 wires the P1/P2 Windows adapter and the N3 Linux bridge into the
  default `NotificationPlayer` route. HEAD `57fbe506`; only the P3 surfaces below
  changed. No new source file, no new package, no player/library install, no
  compiler, no bundled Swift/C, no audio sample, no global config, no restart.
- **Status: cross-platform PREPARED.** Native Windows, the derived WSL
  Windows-interop target, plain Linux Pulse, and the macOS `afplay` CLI are all
  prepared and selected by default. **No physical-evidence requirement** applies
  to a prepared phase and none is claimed. Source `NativePulse` on Linux remains
  physically un-heard; the earlier WSLg read-only **DIRECT Sound primitive**
  probe (AUTH + server-info, no CREATE/samples) still stands and is not upgraded
  to a physical claim.
- **API.** `lib/notification-audio.ts` now exports `createDefaultNotificationBackend(platform = process.platform, env = process.env)`. Pure and IO-free: it constructs a `NativeWindowsPlayer({platform, env})` and returns it only when its pure `supportsTarget()` is true (`win32`, or `linux` with a valid WSL interop env), otherwise it returns `NativePulsePlayer({platform, env})` (plain Linux; macOS with `supportsTarget()` false so `afplay` owns playback). Construction does no probe/access/spawn/read. `options.native` still overrides entirely.
- **Routing.** `discover()` no longer hardcodes the Linux platform guard; it gates the native probe on `this.native.supportsTarget()`, so win32/WSL probe the Windows adapter and macOS/plain Linux behave as before. A WSL Windows that is unsupported, has no `/mnt/c` host, or fails its read-only probe yields no native capability and the trusted Linux CLI fallback runs **before** any playback — there is no automatic Pulse fallback on WSL (the known silent Pulse path is avoided). A native play error is still never retried through the CLI. The `isNotificationSound` flavor in `play()` is now `win32` when `(options.platform ?? process.platform) === "win32"`, else `posix`, so a `file:C:\...` sound validates on the native Windows route.
- **RED/GREEN (TDD active).** RED observed before the production change: the new test file import failed (`does not provide an export named 'createDefaultNotificationBackend'`) → `tests/notification-audio.test.ts` **0 pass / 1 fail**, exit 1. GREEN after the source: the same command → **25/25, exit 0** (22 previous + 3 new: pure factory selection; win32 native route through the fake PowerShell host; macOS `afplay` WAV+FLAC).
- **Validation (direct Node, no `pnpm`, no physical audio).** `notification-audio + native + windows` → **63/63** (was 60). `tests/*notification*.test.ts` → **224/224** (was 221; policy/UI/service/customize roles unchanged). `tests/package-manifest.test.ts` → **58/58**. `node scripts/verify-package-files.mjs` → **180 files / 69 pins**, runtime **8**. `node scripts/check-types.mjs` → **186, no regressions**. `git diff --check` clean. No real PowerShell probe, no snapshot read, no Pulse stream and no OS audio ran (all IO injected).
- **Preserved blockers (historical — superseded by L13).** At this point N5 stayed **[ ] BLOCKED**: the historical `history-session-scan` **244** is a confirmed pre-existing base failure and the **582** stays inconclusive; neither was re-run, retried to green, suppressed or rewritten here. The metadata incident stands — `pnpm` was not invoked.
- **Cost (honest).** P3 changed lines are counted in `git diff --stat` (source + tests + docs + this entry), forecast ≤300–400 and kept inside it; security/path tests were not golfed. The whole cross-phase outlay is **P1 = 753** + **P2 = 367** = **1120 changed lines**, already above the 600–900 forecast; recorded honestly rather than trimmed.
- **Boundaries.** No behavior outside the audio route changed; no config/audio-enable/default-preview/after-play/folder/role guard was added. The owner remains the parent TUI only; unused additional-child-mode sources are unchanged.
- **State.** Not committed here: the parent owns staging, the mandatory final High-risk verifier over `25e6b775..candidate`, and any P3 commit.

### L13 — Final independent HIGH verification + current-candidate closure (N5 [x])

- **Range/label (honest).** `25e6b775..fe8d8fc3` = **9 files, +1261/-16 → 1277 diff lines**; sum of per-commit diff lines **P1 753 + P2 367 + P3 207 = 1327** (overlaps on shared surfaces) → correct label **TOTAL range**. Forecast **600–900 NOT met** — observed, not trimmed. Not misrepresented as the 1277 entire feature; Node/Pulse work between `9a1f8a75` and `25e6b775` belongs to the preceding implementation range.
- **Independent HIGH.** Required independent final HIGH read-only assessment over the added range fulfilled. No native RDD receipt/approval: managed assets outdated, sync **NOT RUN** → **no approved flag, no Lens-clean claim**. Residual **Medium** interop cancellation uncertainty was narrowed by the non-audio diagnostic below; **Low** stderr flooding remains byte-bounded under the 6000 ms timeout. Neither establishes audible support.
- **Current candidate (NEW).** `env pnpm_config_verify_deps_before_run=false npm_config_verify_deps_before_run=false node scripts/run-test-suite.mjs` → **exit 0, all PASS**: unit **4993 / 4959 pass / 0 fail / 34 skip**; provider-contract + runtime harness PASS. Both guards parse false (no implicit install); sibling `node_modules`/store fingerprints unchanged, no new global or local Go cache, L9 incident artifact preserved. Includes `package-manifest` **58** and all notification tests. Writer focal **224** + Windows **27** + audio **25** + native **11** (**63**) are writer observations, not an independent rerun. Parent fresh: `check-types` **186** no regressions, runtime **8**, verifier **180/69**, candidate green.
- **Packed-package E2E: NOT RUN** (no install); offline pack **58** inside the full run is positive. Engine logical `22.19`, only Node **24** ran; other hosts never needed, per the user-authorized absence.
- **Supersession.** L13 supersedes the L9 whole-suite RED and the L12 “N5 BLOCKED” as current status, leaving both verbatim as history; **not** a silent clock fix and **not** a same-candidate retry — a fresh candidate at a later HEAD.
- **Optional read-only evidence (no audio).** Real WSL `NativeWindowsPlayer.probe()` → available/caps `wav`, no PlaySync/audio, proving the fixed PowerShell interop/`-EncodedCommand`. A **previous** builtin .NET `SoundPlayer` experiment was manually heard (primitive, pre-integrated-adapter); old WSL Pulse **NO ×3**; new WSL route **not physically played**; macOS/native-Windows hosts unavailable, fakes prepared. Kept distinct, no confusion.
- **MEDIUM interop-cancel residual (non-audio).** Own PowerShell fixed 8 s sleep, same exe/flags/env scrub; read-only own-PID `GetProcess` (own PID only) saw child ALIVE pre-kill; child SIGKILL in 3 tests; Node `close` 2–1951 ms then Windows own PID **DEAD** immediately/+1 s, all 3. No lingering process, no `taskkill`/global/user kills. Reduces uncertainty, does **not** prove `SoundPlayer` thread cancel on all WSL hosts; **no production change** and no universal audio-cancellation claim.
- **N5 [x].** Functional verification is the current full run, **not** a historical fix. Optional manual listens (Node 22, native Windows, macOS, owned WSL new adapter) not blocking. Historical full-N5 **244** proven preexisting (1/3; **582** inconclusive) remains a flaker risk, **not fixed**; audio was not enabled by this work; user 5.58 s `[archivo de audio local anonimizado]` still rejected by the unchanged ≤5 s limit, no crop. macOS builtin `afplay` is platform-prepared only (no compiled CoreAudio). R8 claims no physical listen support but prepared without device evidence, as required.

### L14 — Windows private-snapshot play: bounded bytes → memory `SoundPlayer` (bugfix)

- **Symptom (parent-relayed, not re-observed by the writer).** One user heard
  test 1 (original file) but not test 2 (private copy), repeated through the same
  `NativeWindowsPlayer`, script and environment with byte-identical WAV data.
  Both tests were executed by the parent agent in the same session, not by two
  users. The precise WinMM cause is **unproven**; the filename/private-snapshot
  playback branch is implicated. No additional sound ran during this fix.
- **Scope.** Only `lib/notification-audio-windows.ts`,
  `tests/notification-audio-windows.test.ts` and this entry. The private snapshot,
  its ownership/cleanup, the play gate, the child env, the schema/IPC, routing, the
  UI, the other backends and the `<=5 s`/`2 MiB` limits are unchanged; the user
  original is never played directly and no permission is modified.
- **Fix.** The fixed play script keeps `FromBase64String` as its **only** dynamic
  value (path still opaque), but now reads the snapshot into bounded bytes and plays
  them through a `MemoryStream`-backed `SoundPlayer`, forcing the documented memory
  branch instead of the file-URI one. Script ~31 source lines: pre-init
  `$file`/`$memory`/`$player`; `[IO.File]::Open(...,Read,Read)`; `$file.Length`
  guarded `44..2097152` **before** `[byte[]]::new([int]$count)`; an exact-length read
  loop that throws on a zero/short read and a `ReadByte() -ne -1` growth guard;
  `$file.Close()` **before** playback; `[IO.MemoryStream]::new($raw)` →
  `[System.Media.SoundPlayer]::new($memory)` → explicit `.Load()` then `.PlaySync()`;
  success printed only after `PlaySync`; every error prints the same schema-valid
  `played:false` line; `finally` disposes player, memory and (unclosed) file. No
  `.ps1`, `Add-Type`, reflection, interop compile or new binary.
- **TDD (strict).** RED **before** production: the new decoded-script test failed on
  the pristine script (`New-Object System.Media.SoundPlayer $path`) →
  `tests/notification-audio-windows.test.ts` **28 tests, 27 pass / 1 fail**, exit 1.
  GREEN after the source → **28/28, exit 0**. TRIANGULATE: the same test drives a
  hostile path (`'; Start-Process; whoami`) and asserts one opaque base64 literal,
  `[byte[]]::new` after the size guard, `$file.Close()` before `.Load()`/`PlaySync`,
  no `New-Object`, and player/memory/file disposal. Existing 27 source-shape cases
  were kept valid (the pre-playback release uses `.Close()`, so the first
  `.Dispose(` stays inside `finally`).
- **Validation (direct Node; no `pnpm`, no full suite, no physical play).** windows
  **28/28**; `tests/*notification*.test.ts` **225/225** (was 224);
  `package-manifest` **58/58**; `check-types` **186, no regressions**; runtime **8**;
  `verify-package-files` **180 files / 69 pins**; `git diff --check` clean. No real
  PowerShell probe/play, snapshot read or `PlaySync` ran from the tests (all IO
  injected); no new full-suite claim.
- **Physical status: NOT PROVEN for this patch.** The earlier file-based
  integrated route was played and the user reported no sound from the private
  copy. The new memory branch has not been played; it awaits a fresh authorized
  listen. The L13 4993-test full run covered the preceding candidate, not this
  changed script; current checks are the focused validations above.
- **Cost (honest).** source **+31/-2** (`lib/notification-audio-windows.ts`), tests
  **+39** (`tests/notification-audio-windows.test.ts`), plus this entry — inside the
  source/test forecast was met; the ODD entry exceeded its ~35-line forecast.
  No security golf.
- **Independent non-audio execution.** A verifier captured the actual encoded
  script and scrubbed environment via a fake child, replaced exactly one
  `PlaySync()` line with `MEMORY_LOAD_COMPLETED`, asserted that no playback call
  remained, then ran that variant on real Windows PowerShell. A private
  0700-directory/0600-file WAV (13272 bytes) opened, loaded through MemoryStream
  and disposed successfully. A 7-byte input failed the size guard, emitted
  `played:false` and never reached the marker. These checks validate real syntax,
  overloads and loading, not audible output. The verifier also reproduced
  27-pass/1-fail RED on an isolated old-module copy and 28/28 GREEN on this patch.
- **Local patch commit.** `c398aadd`; no global settings, installs or restarts.

### L15 — Isolated modal preview run by the parent (GUI observations parent-attributed)
- **Prior physical case (unchanged, narrow).** The user's "¡se escuchó!" confirms
  the **WSL Windows private-snapshot `MemoryStream` `SoundPlayer`** route once
  (`c398aadd`, L14); one Success case only — no Error/Attention, plain WSLg
  Pulse, macOS/Windows-host or Node 22 claim. The writer heard/ran nothing.
- **Parent ran the trusted MAIN with no role-guard override:** new Herdr pane
  `wK:pA` (`audio-modal-check`), isolated `mktemp -d /tmp/gentle-audio-modal.*`
  config/agent dirs, `GENTLE_PI_CONFIG_HOME`/`GENTLE_PI_AGENT_HOME`,
  `pi --no-extensions --session $TMP/agent/modal-session.jsonl -e
  <abs>/extensions/gentle-notifications.ts -e <abs>/extensions/gentle-shell.ts`.
  The empty temp config uses real defaults (no speculative schema written).
- **Observed by the parent (not the writer).** `/gentle:customize` shows six basic
  rows: Off / Unmuted / Success `success` / Error `error` / Attention `attention`
  / Advanced folded; Enter on Mute observed muted, Enter restored unmuted,
  notifications **OFF throughout**; footers `applies 2/3/1 events`, `f assign / p test`.
- **Attempted previews via pasted `p`, once each (3 total) — NOT effective
  previews:** Success 3/6, Error 4/6, Attention 5/6, but Herdr send-text emits
  bracketed paste and the modal's `matchesKey('p')` never consumed it
  (later-discovered testing-method defect). Audibility not established.
- **Scope limits.** Mute was UI-state only — no physical-mute or auto-event
  verification; assignment cycling not independently tested.
- **Global config unchanged:** `~/.pi/gentle-ai/notifications.json` sha256
  `fc7d458ae0665e114a10c4314a21a389c56b0414f2e21bac677464247ae82fec`; `wK:p9`
  untouched. No further tests, sounds, panes, source edits or commits.

### L16 — Direct-route listen confirmed; corrected modal re-run (parent)
- **User "si a los 3" (parent-relayed).** Confirms a physical DIRECT default
  `NotificationPlayer` → `NativeWindowsPlayer` private snapshot → `MemoryStream`
  `SoundPlayer` once each for Success/Error/Attention, `starts 1`/completed;
  authorization separate. Narrow WSL only, **not** modal proof; widens the L15
  Success-only prior case.
- **Old `wK:pA`** had closed by the next read; no actor inferred.
- **User "vamos" authorized the real modal test.** Parent created a NEW trusted
  MAIN `wK:pB` (`wK:t8` Audio check) with a fresh isolated temp
  `/tmp/gentle-audio-modal.UWbfTZ/config`+`agent`, `GENTLE_PI_CONFIG_HOME`/
  `GENTLE_PI_AGENT_HOME` and a temporary `--no-extensions` session plus explicit
  `-e gentle-notifications` + `gentle-shell` (same pattern as L15, not re-listed).
  Roles not overridden; child silent. Modal: six basic, default Off, unmuted,
  3 presets, Advanced folded.
- **Actual `p` (send-keys) once each, 3 s wait each:** Success 3/6, Error 4/6,
  Attention 5/6. Sampled screens showed no busy/unavailable/error text, but there
  is no success receipt/IPC capture and **physical audibility of this new modal
  is pending user confirmation**; no other tones allowed.
- **Explicit preview bypasses enabled/mute by design;** mute only affects
  automatic events and the prior UI toggle only. No extra UI edits, global prefs
  or source changes; global `notifications.json` sha256 unchanged (`fc7d…82fec`,
  same as L15). Observations are parent relayed; the writer heard/ran nothing.

### L17 — Modal preview audibility confirmed by user (parent-relayed)
- **User "si" (parent-relayed)** to "¿Se han oído Success→Error→Attention esta vez?" AFTER the real MAIN modal
  send-keys `p` test in `wK:pB` (L16); supersedes **only** L16's pending physical-audibility note for those
  three previews, L16 otherwise intact. Narrow WSL / current equipment / 3 builtins: real modal PASS via
  private snapshot `MemoryStream` `SoundPlayer`; automatic notifications stayed **OFF** and global prefs
  unchanged in that test. No new sounds authorized. No native Windows host, macOS, Node 22, independent
  assignment/file/Advanced, or manual automatic mute claim. Writer heard/ran nothing.

### L18 — 10 s own-sound limit (5 s → 10 s); play deadlines 6000 → 11000 ms

- **Authorization.** User explicitly asked to raise the limit to 10 seconds for
  own notification sound files ("aumenta el límite a 10 segundos"). Builtin
  defaults, the 2 MiB ceiling, the no-follow/private-snapshot flow and every probe
  deadline are unchanged. L1–L17 keep their historical 5 s statements verbatim;
  `docs/sound-notifications.md` and `README.md` are the current authoritative 10 s
  sources. The original `docs/sound-notifications-proposal.md` is not rewritten.
- **Duration limit.** `MAX_DURATION_MS = 10000` in `lib/notification-audio.ts`;
  `validateNotificationWav` and the shared `validateNotificationAudio` guard reject
  `> 10000` ("Notification audio exceeds 10 seconds"). WAV/OGG/FLAC share the
  decoded-duration guard; exact 10 s is accepted and one unit past is rejected.
- **Deadlines (10 s + 1 s margin).** Playback watchdog 6000 → 11000 ms in the CLI
  (`PLAYBACK_TIMEOUT_MS`), the native Pulse bridge and Windows adapter
  (`DEFAULT_PLAY_TIMEOUT_MS`), the Pulse stream budget
  (`DEFAULT_PLAYBACK_BUDGET_MS`) and the per-request/DRAIN cap
  (`MAX_REQUEST_TIMEOUT_MS`). Probe deadlines (1200/900 ms) are unchanged; no
  unbounded deadline was introduced.
- **RED observed before source.** Focused tests written first.
  `node --experimental-strip-types --test tests/notification-audio.test.ts` →
  **23 pass / 4 fail**; the boundary test failed `TypeError: Invalid notification
  WAV` at the unchanged 5 s limit and the CLI deadline test failed `6000 !== 11000`.
  `notification-pulse-stream` → **13/2** (`parsePulseWav` boundary + default drain
  deadline `true !== false`); `notification-audio-native` and
  `notification-audio-windows` each failed the default deadline `6000 !== 11000`.
- **GREEN after source.** `notification-audio + native + windows + pulse-stream +
  pulse-client + pulse-protocol + customize` → **160/160, exit 0** (was 155).
  `tests/*notification*.test.ts` → **230/230** (was 225). `node scripts/check-types.mjs`
  → exit 0, **186 recorded diagnostics, no regressions**. `git diff --check` clean.
- **Coverage kept.** New tests assert exact-10-s accepted / >10-s rejected per
  container, the previously rejected 5.58 s equivalent now accepted (no crop), the
  2 MiB ceiling retained, and a default 11000 ms play/drain deadline that outlives
  the 10 s maximum for the CLI, native bridge, Windows adapter and Pulse drain.
  Existing security/lifecycle tests (no-follow private snapshot, PCM structure,
  gate-once, native-failure-never-retries-CLI, truthful capabilities) are unchanged
  and green.
- **No physical audio.** All tests inject a fake child/socket/clock; no real Pulse
  stream, PowerShell host or `PlaySync` occurred and no physical
  audibility is claimed. No package, dependency, runtime module or global config
  changed.
- **Stale UI string superseded (message-only).** The deprecated, unwired
  `openNotificationPanel` fallback still advertised `≤5 seconds`;
  `lib/notification-ui.ts` now says `≤10 seconds`. No behavior/validation change:
  the panel delegates to `service.validateFile` (already 10 s + 2 MiB +
  `O_NOFOLLOW`) and `tests/gentle-shell.test.ts` still asserts the extension never
  imports `notification-ui.ts`. The current `/gentle:customize` path
  (`lib/notification-customize.ts`) was already 10 s.
- **Author source validated read-only (no playback).** `[ruta local anonimizada]`
  opened `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, bounded ≤2 MiB, one read → regular file,
  `985352` bytes, pure `validateNotificationAudio` → `wav`, `5580` ms (5.58 s):
  now **accepted** after the 5 s→10 s raise (previously rejected). No crop, no
  play, no probe, no snapshot, no capability assumption (pure codec only). SHA-256
  `b7477a1e52f73df449c126f05a872c276b16471b2874a4c30bb660a8506aef43` and mtime
  unchanged before/after. No audibility is claimed.
