# Main channel install and channel-aware upgrade

Objective: let users install the latest `main` of Gentle Shell with a Gentle AI binary built from the latest `main`, and update along their channel.
Branch: `feat/main-channel-install-and-upgrade` (from `main` 6e7e3a18f). Delivery: single-pr with `size:exception` (L5). Test runner: `node --experimental-strip-types --test <files>`; suite `pnpm test`.

## Specs

- S1. "agregues la opcion de instalar lo ultimo de main, eso quiere decir gentle shell, branch main, ultimo commit": the installer offers a `main` channel besides the release channel; it installs Gentle Shell from the latest commit of branch `main` of Gentleman-Programming/gentle-shell, resolved to an exact commit SHA at install time.
- S2. "con el binario de gentle-ai de main, y override": the `main` channel builds Gentle AI locally from the latest commit of `main` of Gentleman-Programming/gentle-ai (`go install github.com/gentleman-programming/gentle-ai/v4/cmd/gentle-ai@<sha>`, verified by Go's checksum database, as the Windows source build already is) and activates it through the existing dev-binary override (`gentle-pi.dev-binary/v1` registration), never silently falling back to the pinned binary. Decision (L2): build locally, no new CI publishing.
- S3. "tambien agrega un updater, si estas en release al ultimo release y si estas en main a lo ultimo de main": an updater command updates a release-channel install to the latest published release and a main-channel install to the latest `main` commits of both Gentle Shell and Gentle AI; it reports when already up to date.
- S4. The chosen channel and installed commits are recorded so the updater knows the channel (assumption: a small versioned state file under the Gentle AI config home).
- S5. Help text and `docs/` describe the channel option and the updater (repository rule).

Assumptions: the main channel requires Go ≥ the Windows minimum on every platform and blocks with clear guidance when missing; the updater is a `gentle-shell` subcommand that does not collide with Pi's `update` subcommand.

## Tasks

| ID | Specs | Route | Status | Evidence |
|----|-------|-------|--------|----------|
| T1 | S2, S4 | inline | done d3fabfd28 | RED: module missing; GREEN tests/main-channel.test.ts 7/0; real smoke built 1f9d5e6 in 10s, override registered |
| T2 | S1, S4 | inline | done d3fabfd28 | GREEN pack test; real smoke packed gentle-pi-4.0.0-main.6e7e3a18f794.tgz; host run gained optional cwd (RED→GREEN) |
| T3 | S1, S2 (wizard channel choice end to end) | inline | done 7df5c3a15 | RED→GREEN preflight (36), runner (55), server (38), wizard UI (29); preview checked in a real browser |
| T4 | S3, S5 (updater command, help, docs) | inline | done 96ff045a8 | RED→GREEN tests/main-channel-upgrade.test.ts 12/0, launcher parse/help; real `gentle-shell upgrade` on release: already latest, exit 0, nothing written |

Route evidence: no Writer trigger (T1–T4 share the channel state module, so they are not independent parallel units); inline, following this logbook.

## Log

- L1 (2026-10-08, user): "quiero que ahora mientras esperas el ci (sin coderabbit), quiero que agregues la opcion de instalar lo ultimo de main, eso quiere decir gentle shell, branch main, ultimo commit con el binario de gentle-ai de main, y override, tambien agrega un updater, si estas en release al ultimo release y si estas en main a lo ultimo de main"
- L2 (2026-10-08, user decision): "Compilar local desde el último commit de main (recomendado)" over publishing main builds from CI.
- L3 (evidence): neither gentle-ai nor gentle-shell publishes main builds (gentle-ai releases are stable only, latest v4.0.0). gentle-shell has no updater; `update` is forwarded to Pi (`runtime/gentle-shell-launcher.mjs:14`). Dev-binary override exists (`runtime/gentle-ai-binary.mjs:57-78`). Runner requires exact stable Shell version (`scripts/installer-runner.mjs:99,268,376,589`).
- L4: forecast well above 400 authored lines; chain strategy asked once before the first commit.
- L5 (2026-10-08, user decision): "una sola pr size exception" — one PR labeled `size:exception`, no chain.
- L6 (evidence): `pnpm add -g github:…#sha` and codeload tarball URLs both run `prepack` (full suite, 2m16s, installs nothing). Working path: download the commit tarball, rewrite version to `<v>-main.<sha12>`, drop prepack/prepare, `pnpm pack`, then `pnpm add -g <tgz>` (34s, no prepack). `pnpm pack` has no `--ignore-scripts`. Go module cache is read-only: `GOFLAGS=-modcacherw` lets the build dir be removed.
- L7 (decision, assumption): the wizard adds main steps only when it installs or completes setup; an already set-up stack switches with `gentle-shell upgrade --channel main` (added to S3's updater as `--channel release|main`). The updater is `gentle-shell upgrade`, because `update` is Pi's own subcommand. Wizard and server texts that recommended `gentle-shell update` for updating Gentle Shell now say `gentle-shell upgrade`.

