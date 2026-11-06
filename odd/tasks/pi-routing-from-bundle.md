# Pi ODD steps from the provider-contract bundle

Objective: Gentle Shell takes its ODD routing steps from gentle-ai's published provider-contract bundle
(`routing/pi.md`, contract 1.4.0) instead of hand-copied text, with the primary-session prompt unchanged byte for byte.
Branch `feat/pi-routing-from-bundle` from `eebaf274e`. Delivery: single PR. Runner: `pnpm test`.
Upstream: gentle-ai `feat/pi-routing-canon-bundle` (`5aa0b887`, `9e6f24f6`), not released yet (release gentle-ai first).

## Specs

- S1 (roadmap R3, verbatim): "One source for the canon. The ODD routing canon lives in gentle-ai
  (`internal/components/agentguidance/routing.go`) and is copied into gentle-shell by hand (harness step text, assets)
  plus a vendored fixture; a change in one repo must reach the other without manual mirroring."
- S2 Mirror 1.4.0: the strict bundle decoder (`lib/provider-contract-bundle.ts`) accepts the `routing` manifest field,
  required from contract minor 4 and rejected before it, with `routing/<runtime>.md` entries counted in the exact
  inventory and the raw-entry bound; the mirror (`scripts/mirror-provider-contract.mjs`) vendors a 1.4.0 archive built
  from the gentle-ai branch the way goreleaser builds it, and `scripts/check-provider-contract.mjs` verifies it offline.
  1.3.0 behavior stays valid where the decoder claims backward compatibility.
- S3 Single source for steps: the harness ODD step lines 1-7, the phase-reporting line, and the resume line in
  `extensions/gentle-ai.ts` (lines ~1403-1413) come from the mirrored `routing/pi.md`, not from string literals; the
  rendered primary-session prompt is byte-identical to `eebaf274e` (prove it with a test that builds the prompt and
  compares against a golden captured from the base). Blank lines between step 7, phase reporting, and resume in the
  bundle are not carried into the prompt.
- S4 Remove the hand mirror: `scripts/mirror-odd-routing.mjs` and the `mirror:odd-routing` package script are removed;
  `fixtures/odd-routing-canonical.md` is replaced by the mirrored `routing/pi.md` as the canonical reference (the
  ratchet `tests/odd-routing-canonical-ratchet.test.ts` and literal tests compare against it); the
  `assets/orchestrator*.md` modules stay Pi's own and keep their anchor checks.
- S5 Unchanged: all other prompt content, package file list rules (update `scripts/verify-package-files.mjs` for the new
  mirror path), and runtime behavior.

## Tasks

| ID | Specs | Work | Route | Status |
|---|---|---|---|---|
| T1 | S1-S5 | decoder + mirror 1.4.0, harness steps from the bundle, remove the hand mirror | delegated (context backstop) | done: `2c8c64dc5` (S2), slice-2 commit `feat(prompt): render…` (S1, S3-S5); see L2-L3 |

## Log

- L1 (user, 2026-10-15): "Vamos a hacer todos empezando por la t5"; T10 decision "(a) con cláusulas Pi en gentle-ai";
  PR strategy "Un solo PR (excepción)". Phase 1 verified in gentle-ai with no blockers; the verifier listed the
  decoder changes S2 needs (`requireExactKeys` l.246-248/357, exact inventory l.542-547, mirror output l.778).
- L2 (writer, T1 slice 1; S2): built the 1.4.0 archive outside every workspace from gentle-ai `9e6f24f6`.
  - `S=$(mktemp -d)` (`/tmp/tmp.mN6MEIy35r`); in the gentle-ai worktree:
    `go run ./internal/providercontractbundlecmd generate --out "$S/stage"`.
  - Packaging with goreleaser itself (v2.15.2, the version `.goreleaser.yaml` provenance pins) in a scratch clone, so
    archives[1] (`review-provider-contract`) applies unchanged: `git clone --no-hardlinks <gentle-ai worktree>
    "$S/gentle-ai"`, then in it `PROVIDER_CONTRACT_SEMVER=1.4.0 MINISIGN_PUBLIC_KEYS_CANONICAL=snapshot
    MINISIGN_SECRET_KEY_FILE=/dev/null HOMEBREW_TAP_TOKEN=snapshot goreleaser release --snapshot --clean
    --skip=sign,publish,validate,homebrew`; copied `dist/gentle-ai-review-provider-contract-1.4.0.tar.gz` to
    `$S/archive/`. Its extracted tree is byte-identical to `$S/stage` (`diff -r`).
  - `go run ./internal/providercontractbundlecmd verify --archive $S/archive/gentle-ai-review-provider-contract-1.4.0.tar.gz`:
    exit 0. Archive SHA-256 `aa3b6bf2d488501594ce985e55326cc86016d54388822477f41b24dbb908299a`.
  - `node scripts/mirror-provider-contract.mjs --bundle $S/archive/gentle-ai-review-provider-contract-1.4.0.tar.gz`:
    mirrored 1.4.0, tree `aab5ab7fe7ee6bb180d8bbce21c034cebb0c0d284afcc8664a9b3bb57323c35d`. Against the 1.3.0 mirror,
    `orchestration/pi.md`, schemas, and vectors are byte-identical; README and manifest change; `routing/pi.md` is new.
  - Decoder: `routing` is parsed by the same runtime-file inventory rule as `orchestration` (required from minor 4,
    rejected before), counted in the exact inventory; the raw-entry bound is 8 + 2 x 64. Generated capability baselines
    gain `routing` (empty before 1.4.0). RED: 11 new decoder tests failed (`manifest has unknown field "routing"`, raw
    bound 72); GREEN: `tests/provider-contract-bundle.test.ts` 42/42. A 1.3.0-shaped bundle still verifies (test).
  - Expected prompt effect of re-mirroring: the review contract fragment heading reads `mirrored provider bundle 1.4.0`
    (its `orchestration/pi.md` body is unchanged); `tests/review-contract-prompt.test.ts` pins the new label.
- L3 (writer, T1 slice 2; S1, S3-S5): the harness renders ODD steps 1-7, phase reporting, and resume from the mirrored
  `routing/pi.md` (lock-digest verified, cached per process, blank lines dropped); `extensions/gentle-ai.ts` keeps no
  step literal. Missing, tampered, or reshaped `routing/pi.md` throws an explicit error, like a missing
  `assets/orchestrator.md`, instead of rendering a harness without its workflow. Removed `scripts/mirror-odd-routing.mjs`,
  the `mirror:odd-routing` script, and `fixtures/odd-routing-canonical.md`; the ratchet and the literal tests
  (`odd-routing-contract`, `no-self-pause-contract`) now read the verified mirrored block or the rendered prompt.
  - Golden: `tests/fixtures/primary-session-prompt/gentleman.golden.md` (SHA-256 `3b332d45…ef161`) captured from
    `eebaf274e` in a scratch clone (`$S/base-pi`), assets root normalized; `tests/primary-session-prompt.test.ts`
    compares it byte for byte. RED: 5 of 6 new tests failed (`readMirroredOddProtocolSteps is not a function`, step
    literals present); GREEN after the change; the golden passed before and after.
  - Differential (scratch scripts in `$S/scripts`): `buildGentlePrompt` at `eebaf274e` vs this branch for 54 inputs
    (2 personas x 3 tool sets x 3 RDD lines x 3 host modes): 0 differing. Full `before_agent_start` appendSystemPrompt
    (RDD unknown, native CLI present): the only difference is the review fragment heading `mirrored provider bundle
    1.3.0` -> `1.4.0` (L2). The base's 1.3.0 mirror tree verifies with the new decoder (9 entries, routing empty, tree
    `a2b95892…c023` = base lock).
  - Checks: `pnpm test` all three stages passed (unit 6851 tests, 6779 pass, 0 fail, 72 skipped); `pnpm -s typecheck`,
    `pnpm run check:provider-contract` (1.4.0, 10 entries), `pnpm run check:runtime-modules`,
    `node scripts/verify-package-files.mjs`: passed.
  - Size: authored changed lines (generated mirror, fixtures, and golden excluded) slice 1 = 379, slice 2 = 615
    (+214/-401, mostly the removed hand mirror and its provenance tests); one PR per L1.
  - Next: release gentle-ai with contract 1.4.0, then re-mirror from the published archive and compare its SHA-256.
- L4 (2026-10-15) gentle-ai v4.2.0 published (contract 1.4.0). Rebased onto origin/main `4372ff2d` (R1 merged) without
  conflicts. Re-mirrored from the published asset `gentle-ai-review-provider-contract-1.4.0.tar.gz` (SHA-256
  `9d2927a84ba9a596f69029e3f854b16f86ca4c8b32cc5d63683764ccf2fb394b`, matches the release `checksums.txt`): tree
  `aab5ab7f...c35d` is identical to the locally built mirror; only `source.archive_sha256` in the lock changed. The
  gentle-ai binary pin stays 4.1.1 (`scripts/gentle-ai-installer.mjs`): the routing block is read from the mirror, not
  from the binary; bumping the pin to 4.2.0 is the separate gentle-pi pin-bump procedure.
