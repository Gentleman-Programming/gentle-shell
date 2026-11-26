# Gentle Shell on Herdr — "The Tower"

Build brief for a graphical Gentle Shell that runs as a Herdr layout + mod, for people who do not use the terminal. The chosen look and behaviour are in `11-tower-painted.html` (open it in a browser). This document says what to build, what it maps to in Gentle Shell, and what must be proven first.

Status: design chosen, nothing built. Everything marked **spike** is unproven.

## 1. Principles

1. **Calm first.** Few things move, nothing blinks fast, and every detail is on demand: a summary first, the list on click, the full view on a second click.
2. **Every number counts something real; every button runs a real command.** If Gentle Shell cannot do it today, it is listed in §8 as new work, never faked.
3. **Fast.** One click per action. No character has to walk somewhere before you can act.
4. **Gentleman Programming identity.** Only brand elements: the curly neon mustache, neon pink and VODS violet, the Engram elephant, the Gentle AI rose. Pixel art painted like early-90s adventure games, lo-fi vaporwave dusk.

## 2. The model

| World | Gentle Shell |
| --- | --- |
| Building | A project (one repo or folder). The switcher on top changes building; a `?` marks projects where someone waits for you. |
| Floor | A session in that project. Each floor has a name, a shortcut (`⌘1…`) and a colour. |
| Orchestrator (bowler hat in the floor colour) | The session's main agent. |
| Helpers (role hats) | Subagents: `explore` (teal cap), `worker` (hard hat), `verify` (goggles, lab coat). Named by role; when a floor has two of the same role, the name adds a task word: `worker-tests`, `explore-memory`. |
| Rooms (the same on every floor) | What the agent is doing right now (§3). People move between rooms as their work changes. |
| Lobby | Global state shared by every floor (§4). |

## 3. Rooms

| Room | Meaning | Who is there | On click |
| --- | --- | --- | --- |
| MAP | Explore and plan. The corkboard notes are the floor's tasks (§5). | explorers, the orchestrator while planning | the floor's task list |
| WORKSHOP | Build. | workers | changes |
| LAB | Check with tests (red, then green). | verifiers, workers running tests | test results |
| REVIEW | Outside review with the four lenses (risk, resilience, readability, reliability). Dark when review mode is off. | reviewers, only for high-risk changes | review status |
| ENGRAM | Memory. The elephant is the librarian. | anyone saving or searching memory | memories of this session |
| GENTLE AI | Engine room: models, skills, integrations. The rose reactor powers the floor; the electricity meter shows this session's cost. | nobody | model and profile, skills, integrations, session cost |
| LOUNGE | Finished agents rest here. | done agents | session cost |

## 4. Lobby and HUD (global)

| Thing | Means | Data |
| --- | --- | --- |
| Door + bouncer | Permission mode: normal (rope closed), auto (rope half open), yolo (bouncer gone, "BRB"), super-yolo (door open, red OPEN sign). Click opens the choice. | `/gentle:customize` permission modes; desktop RPC `get_permission_mode` / `set_permission_mode` |
| Marble bust, neon mustache | Persona gentleman / neutral (mustache on or off). | `/gentle:persona` |
| Wall switch | Review mode on / off for every floor. | `gentle-ai review mode status` / `enable` / `disable` |
| PLAN meter (top left) | Plan usage left this week. | desktop RPC `get_subscription_usage` |
| PAUSE ALL (Space) | Pause every agent. | **new** (§8) |

## 5. Tasks per floor

- Under each floor in the left list: a segmented bar, one segment per task (done green, in progress pink, blocked amber, pending dim), plus `2/4 · now: <task>` or `blocked: <task>`.
- Click the bar or the MAP corkboard: the full list with state, who works on it, the blocking note and the commit.
- States are the `todo` tool's: `pending`, `in_progress`, `blocked` (with note), `done`, `dropped` (struck through).

## 6. Talking to a floor

- **Intercom** (press `T`, or "Open intercom"): the floor's conversation. Answer questions, give new instructions, and steer a helper with `@worker-tests …`.
- **Questions** from the orchestrator appear as numbered choices (keys `1–9`) in the intercom or in a centred panel.
- **Artifacts live where they were made**: a Mermaid diagram is pinned on the MAP corkboard, a document lies on the WORKSHOP desk, an image hangs framed on the wall. The same artifact is a card in the intercom. Both open a viewer with *Ask about this* and *Download*.

## 7. Rendering inside Herdr

Herdr mods are GPUI views written in JS (`View`, `div()`, `image()`, `svg()`, `PathBuilder`). Source: Herdr Empires `SPEC.md` §16.3 and §18.7.

**Not available:** HTML, CSS, canvas, WebGL, webviews, Node APIs, `setTimeout`. This rules out PixiJS and Phaser inside the mod.

**Available:** absolute-positioned `image()`, `overflow_hidden`, native `.loop("left"|"top"|"opacity", …)`, `.transition()`, `.frames()` (text only), `cx.timer`, overlays (`openOverlay`), the `herdr` data module.

So the art is **pre-rendered**:

| Asset | Made with | Shown with |
| --- | --- | --- |
| Floor background per room and state (lights on/off, review dark) | painted at 720×450 logical, ×2 PNG; lighting baked in | `image()` per room tile |
| Characters: one strip per look × animation (walk 8 frames; idle, type, read, clip, wave, think, sip 4–6 frames) | Aseprite (hand-painted) or the generator in the artboard as a first pass | strip in an `overflow_hidden` box, frame picked by a timer ≤ 8 fps (**spike S1**) |
| Walking | — | paired `left` loops + `top` bob loop (proven by Herdr Empires) |
| Sky, sun, city, street | one painted backdrop | `image()` |
| Neon glow, reactor pulse | baked frames | `opacity` loops |

## 8. New Gentle Shell work this design needs

- **Pause all / resume all** across sessions. Today you can only stop agents one at a time.
- **An Engram browsing view**: memories of this session, search, items waiting for review. No such view exists.
- **Artifact events**: a way for a session to announce "I made a diagram, document or image" with its file, so the world can place it.
- **A per-session feed for the mod**: tasks, subagents (name, role, room), questions, cost, context. Gentle Shell already publishes some state to Herdr (`gentle-herdr-agent.ts`, `gentle-herdr-activity.ts`) and exposes `gentle-desktop-rpc.ts` (snapshot, config, permissions, subscription usage, jobs, subagents). The mod needs one feed it can read (**spike S3**).

## 9. Spikes before building (run in a real Herdr)

| # | Question | Pass when |
| --- | --- | --- |
| S1 | Sprite frame animation: strip image in an `overflow_hidden` box stepped by `cx.timer`, or a colour bitmap font with `.frames()` | 15 animated characters at 8 fps stay smooth, low CPU |
| S2 | Painted PNG quality: ×2 scaling stays crisp (no smoothing) | `herdr-app shot` matches the artboard |
| S3 | Data feed: the mod reads a session's tasks, subagents, questions and cost (via `readTextFile` on a file Gentle Shell writes, `exec`, or `hc`) | live updates within 1 s, no busy polling |
| S4 | Talking: the intercom sends text and choices to the right pi session and shows replies | a question answered from the intercom resumes the agent |
| S5 | Overlays: intercom, task list, viewer and question panel as `openOverlay` windows | open, focus, Esc to close, keyboard 1–9 |
| S6 | Viewer: render a Mermaid diagram and Markdown inside a mod (SVG or pre-rendered image) | the token-refresh diagram and `plan.md` display correctly |

## 10. Milestones

1. **Spikes S1–S6**, with evidence, in `SPIKES.md`.
2. **Read-only tower**: real projects, floors, people in rooms, tasks, costs. No actions.
3. **Actions**: intercom, questions, steer, stop, permission door, review switch, persona.
4. **Artifacts and viewer.**
5. **New Gentle Shell work** from §8 (pause all, Engram view, artifact events).
6. **Hand-painted art pass** replacing generated art.

## 11. Out of scope

- Gentle Cloud / gentle-code: this is a separate, user-first app.
- Any art, names or layouts copied from existing games. Style references only.
