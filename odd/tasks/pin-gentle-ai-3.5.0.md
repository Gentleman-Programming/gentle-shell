# Feature: Pin Gentle AI v3.5.0 and Prepare Gentle-Pi 3.4.0 (#1332)

## Problem
gentle-pi currently pins gentle-ai `v3.4.0` in `scripts/gentle-ai-installer.mjs` and `package.json` (at `3.3.0`). gentle-ai `v3.5.0` was released from commit `0b335e430546e8ca590c62d83722d745f18ef259` with RDD enabled by default. Until the pin moves, a fresh gentle-pi install provisions a v3.4.0 runtime while published documentation, advisory, and package declarations describe v3.5.0.

## Solution
1. Pin gentle-ai `v3.5.0` in `scripts/gentle-ai-installer.mjs`:
   - `INSTALLER_VERSION = "3.5.0"`
   - `GENTLE_AI_WINDOWS_SOURCE_MODULE_CHECKSUM = "h1:3y+Nb7CtgGB3ne3bSNxkzV6j19etkOnGDXIiuv7tMp8="`
   - Signed archive digests and extracted binary SHA-256 for all 4 platforms (darwin/amd64, darwin/arm64, linux/amd64, linux/arm64).
2. Add `3.5.0` contract row in `lib/native-review-cli.ts` (NATIVE_CLI_CONTRACTS) and regenerate `runtime/native-review-cli.mjs` via `pnpm run build:runtime-modules`.
3. Bump `package.json` to `3.4.0`.
4. Update `scripts/verify-package-files.mjs` version expectations.
5. Update tests:
   - `tests/gentle-ai-installer.test.ts`
   - `tests/gentle-ai-binary.test.ts`
   - `tests/package-manifest.test.ts`
   - `tests/native-review-capability-contract.test.ts`
6. Update documentation:
   - `docs/gentle-shell.md`
   - `docs/readme-reference.md`
   - `openspec/specs/review-transaction/spec.md`
7. Run verification (`pnpm test`, `check:runtime-modules`, `verify-package-files.mjs`, `npm pack --dry-run`).

## Tasks
- [x] Task 1: Create ODD feature tracking document
- [x] Task 2: Update installer and native CLI contracts with v3.5.0 pin and SHA-256 digests
- [x] Task 3: Bump package.json to 3.4.0 and regenerate runtime modules
- [x] Task 4: Update test assertions for installer, binary, package-manifest, and capability contract
- [x] Task 5: Update documentation and OpenSpec references to v3.5.0 / 3.4.0
- [x] Task 6: Verify full test suite, package verification, and pack dry-run
- [ ] Task 7: Commit work unit and prepare PR
