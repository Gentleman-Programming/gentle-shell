# PR draft: Gentle Shell Desktop

Prepared locally. Nothing pushed or created.

## Delivery facts

| Item | Value |
|---|---|
| Target repo | `Gentleman-Programming/gentle-shell` (local `origin`; the task named `gentle-pi`, and the README links `gentle-shell`. Confirm before opening.) |
| Base | `main` (branch was cut from `origin/main` 3dc902975) |
| Head | `feat/herdr-gentle-shell` (matches the `type/description` branch rule) |
| Linked issue | **Not required.** The repo has no PR template, no `CONTRIBUTING.md`, and no CI issue or label gate (`.github/workflows/ci.yml`). Recent merged PRs (#3240–#3253) link no issue. An optional issue draft is at the end, if the maintainer wants one. |
| Labels | **None required** by documented policy. There is no `type:*` convention in the repo files. Issue templates use `enhancement`; add it only if it exists on the repo and the maintainer wants it. Do not add `size:exception` unless a maintainer asks for it explicitly. Size is explained in the body. |
| Commits | 28 commits, all Conventional Commits, no `Co-Authored-By` trailers |

## Title

```
feat(desktop): Gentle Shell Desktop, a native Herdr app window for Gentle Shell sessions
```

## Body

````markdown
## What this is

**Gentle Shell Desktop** shows your Gentle Shell sessions in a native window. The conversation appears as a chat, everything the TUI sidebar shows sits beside it, and the real TUI is one switch away (`⌘J`).

It is [Herdr app](https://herdr.dev) (Apache-2.0, unmodified, not forked) plus Gentle Shell's own `gentle-*` mods and a `gentle-shell` layout. Gentle Shell ships Herdr the way it ships Pi: one pinned version, a checksum-verified download, and its own files kept separate.

**Why:** the goal was a package people can run, "like we did with gentle shell and pi". It is a modern replica of Gentle Shell that uses Herdr's GPUI engine and shows **all the same information** (header, sidebar sections, status bar, usage/cost, todo, subagents, jobs, changes, review/RDD, permission modes, models/profiles, questions). The layout follows the chosen design direction A, `design/herdr-desktop/01-inspector.html`, and was checked one to one against it.

## Try it

```bash
gentle-shell desktop            # plan → y → installs Herdr 0.1.15 if needed, mods, layout, shortcuts → opens
gentle-shell desktop --status   # versions, Herdr home, what is installed
gentle-shell desktop --uninstall  # removes our files, restores what was there; Herdr stays
```

Inside: `⌘K` palette, `⌘J` Chat ↔ Terminal, `⌘.` stop. Guide: `docs/gentle-shell-desktop.md`.

## Reviewer map

Recommended order: **2 → 3 → 1 → 4**. Security and the installer carry the risk. The mods are mostly view code.

| # | Area | Files | Commits |
|---|---|---|---|
| 1 | **Feed extension**: per-session snapshot publisher | `extensions/gentle-desktop-feed.ts`, `lib/desktop-feed.ts`, `lib/desktop-feed-sources.ts`, `lib/desktop-feed-store.ts`, `tests/desktop-feed.test.ts`, `docs/desktop-feed.md` | 91cca8d54, 36a2ced1d |
| 2 | **Actions + security guard**: desktop actions through the session's own owners, consent stays in the terminal, desktop folder denied to agent tools | `lib/desktop-feed-actions.ts`, `extensions/gentle-ai.ts` (guard), `herdr/mods/gentle-confirm/`, `tests/desktop-feed-actions*.test.ts`, `tests/sensitive-path-tools.test.ts` | c277ab243, 350f066c6, 7e8d41c04, 1ebb4fcef |
| 3 | **Installer**: `gentle-shell desktop` (pinned Herdr + SHA-256 + codesign, mods/layout/keys install, rollback, uninstall, upgrade refresh) | `lib/gentle-shell-desktop.ts`, `runtime/gentle-shell-desktop.mjs` (generated), `bin/gentle-shell.mjs`, `lib/gentle-shell-launcher.ts`, `herdr/keys.json`, `package.json`, `scripts/*`, `tests/gentle-shell-desktop*.test.ts` | 84a5a2289, c508057e5, 1deeacc8b, 78567775b, 5e09abe4d |
| 4 | **Desktop mods / layout**: chat, inspector, sidebar, status, tabs, spaces, palette | `herdr/mods/gentle-*`, `herdr/layouts/gentle-shell.json` | 4be5a614d, 3b6723b87, 7fb683e99, 1c8af1b60, fcb04e7d1 |
| 5 | **Docs / design** | `docs/gentle-shell-desktop.md`, `README.md`, `docs/readme-reference.md`, `herdr/RECIPE.md`, `herdr/FIDELITY-T6.md`, `design/herdr-desktop/*`, `odd/tasks/herdr-desktop*.md` | c5b64549e, 2af0e00e8, ODD log: 6693f750e, e0f6da078, 0b5d14b1b, b2539079d, 7751acaff, 5ddffba6a, 4b6c2e6ec, 435010c18, 702d57d25, 4b4d5676b |

**Skip safely:** `herdr/mods/*/snapshot.js`, `tokens.js` and `actions.js` are byte-identical copies, because a Herdr mod cannot import outside its folder. Review the copy in `gentle-chat/`, or `gentle-inspector/` for `actions.js`. `runtime/*.mjs` is generated from `lib/` by `scripts/build-runtime-modules.mjs`.

## Size exception

**One PR by the maintainer's decision.** The diff is +18,364 / −16 across 136 files (`git diff --numstat 3dc902975..HEAD`):

| Kind | Lines | Files |
|---|---:|---:|
| Hand-written code (TS host: ~3.5k; mod JS/layout: ~3.7k) | 7,188 | 50 |
| Byte-identical mod copies (`snapshot/tokens/actions.js`) | 3,643 | 19 |
| Generated runtime (`runtime/*.mjs`) | 1,322 | 2 |
| Tests | 2,588 | 6 |
| Docs (incl. ODD task log, fidelity notes) | 1,468 | 10 |
| Design artboards (3 directions + `design.json`) | 2,111 | 4 |
| SVG icons | 44 | 44 |
| `herdr/preview.png` | binary | 1 |

That leaves roughly 7.2k lines of unique code to review.

## Verification

**Focused suites**
- `tests/desktop-feed.test.ts` 12/12. In a mutation run, 6 tests fail when debounce, bounds, question clear, shutdown or dedupe is broken.
- E2E pass at 7e8d41c04: 714/714 focused tests across feed, actions, guards, installer, bin and sensitive paths.
- `scripts/check-types.mjs`: 0 diagnostics.

**`npm test`** at 7e8d41c04: 10676 pass / 6 fail.
- Fixed here: 2 package-check failures (missing `runtime/gentle-shell-desktop.mjs` in `requiredPaths`, 5e09abe4d). `package-files` and `verify-package-files` now pass 16/16.
- Pre-existing on base 3dc902975: `review-relay` "capture forwards no selection" (fails alone on base too) and `review-delivery-preflight` #2997.
- Load flakes: `gentle-ai-proxy` "truncated proxy" and `skill-registry` "watcher refresh" pass alone on head and on base.

**Independent verifications and fixed findings**
- T7 actions verify (c277ab243) failed with 2 blockers. Both were fixed in 350f066c6:
  - B1: any same-user process could drop an inbox file that set super-yolo without the dialog. The inbox is now guarded and busy escalations are refused.
  - B2: relayed provider consent could be answered from the desktop. Consent now stays in the terminal.
- The same verify raised advisories: RDD scope wording, a dir named `x.json` re-processed, idle sweep, answer race, and stale nonce. The RDD dialog now says the switch is global (see `docs/gentle-shell-desktop.md`).
- E2E verify (7e8d41c04): the installer's fresh, refresh and uninstall runs are byte-identical, including user conflicts. It found one regression: the guard missed relative and `--opt=`-embedded paths. Fixed in 1ebb4fcef with tests.

**Live checks** (macOS, Herdr app 0.1.15): header, Changes A/M counts, inspector tabs, permission modes, super-yolo confirm dialog, Stop while idle, palette, `/gentle:status`, Chat/Terminal switch, live chat updates through `watchFolder`. Window regions and colours match the artboard side by side (`herdr/FIDELITY-T6.md`).

**Native review:** both high-risk slices were reviewed natively (risk, resilience, reliability lenses) and approved after one bounded correction each: desktop permission escalations now always need an in-session human confirmation, and `--uninstall` restores the original `keys.json` only when it is untouched since the first write. Non-blocking advisories are listed under Known gaps as follow-ups.

## Known gaps

- `persona`, `integrations` and `statuses` are always `null` in the snapshot. Their data is private to `gentle-ai.ts` and the footer owner, so small owner hooks are needed later. `agents[].role` is also missing.
- Plan usage in the sidebar footer with `claude-bridge` sessions: known gap. Providers that report no usage show "Plan usage unavailable".
- Not verifiable live without model turns or synthetic input: answering a live question, stopping a running turn, subagent or job, `/` menu and palette Enter keystrokes, attachments. These paths are covered by unit tests only.
- Windows: Herdr is not installed by us. We print Herdr's official installer command instead. Remote Herdr terminals are not read yet.

## Risks

- **Item 2: security.** Desktop actions must not exceed CLI authority. Every action goes through the session's own owner (`/gentle:mode`, subagents, jobs, abort). Escalation (Super-YOLO, RDD) needs an in-window confirm that expires after 2 min, and raising the mode is refused while the session or its jobs or subagents are busy (and for 2 s after). Consent is never answered from the desktop. The desktop folder is `0700`/`0600` and denied to the agent's file and shell tools. Review focus: `lib/desktop-feed-actions.ts` and the guard in `extensions/gentle-ai.ts`.
- **Item 5: delivery/environment.** The installer adds a third-party desktop app and writes into `~/.config/herdr-app/`. Mitigations:
  - Herdr is pinned to 0.1.15. The SHA-256 comes from Herdr's immutable manifest, macOS requires a Developer ID signature check, and no script is piped into a shell.
  - The installer asks before it changes anything.
  - User `gentle-*` files and `keys.json` bindings are preserved.
  - A failed swap rolls back.
  - `--uninstall` restores the previous state and leaves Herdr installed.

## Checklist

- [x] Conventional commits, no `Co-Authored-By` trailers
- [x] Docs updated: command help, README, `docs/gentle-shell-desktop.md`, `docs/desktop-feed.md`, `herdr/RECIPE.md`
- [x] Tests added for feed, actions, guards, installer and bin
- [ ] `npm test` re-run on final HEAD (after 1ebb4fcef)
- [x] Native review: security and installer slices approved
- [ ] CI green
````

## Optional issue draft (not required by policy)

Use only if the maintainer wants a tracking issue. If one is created, add `Refs #N` to the top of the PR body.

**Title:** `Gentle Shell Desktop: run Gentle Shell sessions in a native Herdr app window`

**Template:** Feature Request (labels applied by the template: `enhancement`, `status:needs-review`)

- **Problem or opportunity:** Gentle Shell exists only as a TUI. People who want a native window with the conversation as a chat and the session state visible at a glance have no packaged option. The community Herdr reskin changes colours but does not show Gentle Shell's information.
- **Proposed outcome:** `gentle-shell desktop` installs a pinned, checksum-verified Herdr app plus Gentle mods and a layout. The window shows every piece of information the TUI shows (header, sidebar, status bar, usage, todo, subagents, jobs, changes, review, modes, models, questions) and has a native chat with a switch to the real TUI. Desktop actions never exceed CLI authority.
- **Alternatives considered:** forking Herdr (rejected: maintenance burden); a webview or Electron app (rejected: Herdr's GPUI mods give native rendering with no extra runtime).
- **Additional context:** Herdr app is Apache-2.0. Mods are GPUI views in JS with no Node or webview.
