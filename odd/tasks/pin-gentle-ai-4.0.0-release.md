# Pin Gentle AI v4.0.0 and release Gentle Shell

Repository-relative locator: `odd/tasks/pin-gentle-ai-4.0.0-release.md`.

## Objective and rationale
Release Gentle Shell with the newly published Gentle AI v4.0.0 instead of its v3.7.0 pin, shipping the merged Pi 1.0.0 support (#1642). Approved issue: https://github.com/Gentleman-Programming/gentle-shell/issues/1643. Upstream: https://github.com/Gentleman-Programming/gentle-ai/releases/tag/v4.0.0.

## Scope and constraints
- Branch `feat/pin-gentle-ai-4.0.0`, starting from `main` `afb45498`.
- Authorized: GitHub repositories Gentleman-Programming/gentle-ai (reads) and Gentleman-Programming/gentle-shell (issue, PR, merge, tag, release, `publish.yml`) through the configured `gh` CLI session over HTTPS. No ambient SSH, no local npm publication, no retagging.
- Pin only published signed v4.0.0 assets and the SumDB Windows source; regenerate derived runtime modules, never hand-edit generated files.
- Delivery: ask-on-risk. Forecast 200–300 authored lines for T1 (generated runtime excluded); single PR expected.

## Verified upstream evidence (parent)
- `checksums.txt` verifies all four archives and the provider contract tarball.
- Archive SHA-256: darwin_amd64 `b5b74f22b38ec3339b38e8c68f797dc76ff12ed6580826a6e425d5c718da80c1`, darwin_arm64 `d2159caf6d68f367b18830ece6af71ef26963d5f5320d7df6a794773f45cc7e9`, linux_amd64 `5f4417cf29c969c86da4799942fd673368840901be1bb09c779a12d7ed6096ea`, linux_arm64 `1383b040c95cfc69206660d73c21907b14ad70ab913f410917c54f43d3147e57`.
- Extracted `gentle-ai` binary SHA-256: darwin_amd64 `d4a5b16ff70e65331e17a62356941bb0c75ecb9dbe3a0d98a6b54cfbd76cd6b0`, darwin_arm64 `18a9f7fae55d85c95684b6d512a4a148d0cb24a856325f72573c34caf65159eb`, linux_amd64 `50ba217b5138c1a9c7d5bf2f79931b1bb89b89c4cf650dcd7ee037657c88158d`, linux_arm64 `6703704f0c4a5b70c36fbdc44db641e810871cab16bc28040d06aa1d10704ad3`.
- Windows source: `go mod download -json github.com/gentleman-programming/gentle-ai/v4@v4.0.0` (GOSUMDB=sum.golang.org) → Sum `h1:pZ/XZ2Pk3U9lgXigOTY62zlxxFOHnc9CjQhLgaV/Hfc=`, tag commit `ff77164d4f56f1665b22fb6fac51c2ccbb769400`; `go.mod` declares `github.com/gentleman-programming/gentle-ai/v4`.
- Published linux_amd64 binary reports `gentle-ai 4.0.0`; `review capabilities` returns contract `gentle-ai.review-integration/v2`, schema `capabilities/v2.6` → no new capability identity.
- Provider contract tarball `gentle-ai-review-provider-contract-1.2.0.tar.gz` SHA-256 `547b68e172cc87aa297309d61624e5fc2c24d407a494b53eeb5a2b053904352c` (unchanged from 3.7.0).
- Contract diff v3.7.0..v4.0.0: review-integration v2 unchanged; v1 recover fixtures drop four fields; sdd-integration consent schema/fixture removed; telemetry adds `conductor` agent.

## Tasks
- [ ] T1 — Pin published Gentle AI v4.0.0: installer version, archive/binary digests, Windows `/v4` module path + SumDB checksum, `NATIVE_CLI_CONTRACTS` 4.0.0 row, `/v4` paths in the ODD routing mirror script, regenerated runtime, pin-specific tests and docs. Route: delegated writer (multi-file write + preparation triggers). Risk: high (installer/process boundary) → writer self-checks + independent verifier. Acceptance: RED/GREEN observed; `pnpm test`, `check:runtime-modules`, `verify-package-files`, packed runner against real assets pass; work-unit commit.
- [ ] T2 — PR linked to #1643, merge after required checks, bump package version, tag from exact `main`, GitHub release with canonical notes, `publish.yml` from `main`, verify npm. Route: release coordination.

## Progress
- Issue #1643 created with `enhancement`, `type:chore`, `status:approved` (read back).
- Release version decided by the user: gentle-pi 4.0.0 (mirrors the pinned Gentle AI major.minor, as 3.7.0 did).
- T1 delegated to one writer (route: delegated; multi-file write + preparation triggers). Writer completed: RED `published Gentle AI v4.0.0 is the installer pin` failed (`3.7.0` vs `4.0.0`), GREEN 1/1; focused 5 files 219 pass / 0 fail / 7 skip; `pnpm test` 4570 / 4526 pass / 0 fail / 44 skip (10 extra skips gate on a local `.gentle-ai/v4.0.0` binary not yet installed); runtime modules regenerated and match (8); `verify-package-files` passed (69 byte-pinned contracts); packed runner passed against real published v4.0.0 assets (gentle-pi 3.7.0 + Gentle AI 4.0.0); typecheck 187 / no regressions; diff check clean. 14 files +112/−88 incl. 2 generated runtime modules.
- Parent spot check: every archive/binary digest, SumDB Sum, tag commit and `/v4` module path appears exactly once in the installer; no `/v3` literal remains outside a historical comment; installer + contract tests 68/68 pass.
- Risk: high (installer/process boundary) → independent verifier runs after the T1 commit, including the local v4.0.0 binary install to remove the gated skips.

## Next step
Delegate T1.
