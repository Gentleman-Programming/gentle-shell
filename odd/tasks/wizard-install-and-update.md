# Wizard installs what is missing and updates what exists

Objective: the browser installer works on computers that already have Pi or Gentle Shell, not only clean ones.
Branch: `feat/wizard-install-and-update` (stacked on `fix/install-wizard-main-build-guidance`, PR #1961). Delivery: single PR. Test runner: `node --experimental-strip-types --test <files>`; suite `pnpm test`.

## Specs

- S1. An existing Pi with a compatible version (any package manager) is reused, never reinstalled or downgraded. A missing Pi is installed as today.
- S2. Gentle Shell missing while Pi is present: install only Gentle Shell.
- S3. Gentle Shell present and installed by pnpm or npm: offer to update it to the latest release or to `main`, following the chosen channel, with the package manager that installed it — the same logic as `gentle-shell upgrade`, including switching channel. Already current on the chosen channel: "already set up".
- S4. When the installer cannot tell which package manager installed Gentle Shell, it keeps blocking with an explanation.
- S5. The plan is always shown and nothing changes before consent (unchanged).
- S6. Help text, `docs/install-wizard.md` and README describe the behavior.

Decision source (L2): "Instalar lo que falta y actualizar lo existente (recomendado)" — "Pi existente (cualquier gestor, versión compatible): se reutiliza, nunca se reinstala ni baja de versión. Gentle Shell ausente: instala solo Gentle Shell. Gentle Shell presente (pnpm o npm): ofrece actualizarlo al último release o a main según el canal elegido, con el gestor que lo instaló (la misma lógica que `gentle-shell upgrade`, incluido cambiar de canal). Si no se reconoce quién lo instaló, sigue bloqueando con explicación."

## Tasks

| ID | Specs | Route | Status | Evidence |
|----|-------|-------|--------|----------|
| T1 | S1, S3, S4 (probes: Pi/Shell outside pnpm with version and owner) | inline | done 25ea832d2, f0858ba75 | RED→GREEN probes 26/0; installOwner rule (npm only inside `npm root -g`, linked checkout = unknown) also fixes `gentle-shell upgrade` |
| T2 | S1–S4 (preflight plans) | inline | done f0858ba75 | RED→GREEN preflight 42/0; owner-less Shell observations keep blocking (guards) |
| T3 | S1–S3 (runner variants) | inline | done 57be59485 | RED→GREEN runner 62/0 (shell-only, update release/main, install-pi first, unowned refusal); real probes on the maintainer Mac: pnpm Pi reused, linked Shell owner null → blocked |
| T4 | S3, S5, S6 (server, UI, docs, README) | inline | done 0590bf441 | RED→GREEN server/UI (update kind, steps, guidance); 333/0 installer area; typecheck no regressions |

Route evidence: no Writer trigger (the four tasks share the plan contract, so they are not independent). Risk: item 5 (installer now modifies existing installations) → independent verifier after the change's own checks.

## Log

- L1 (2026-10-08, user): "Pero que feo eso no ? No quiero que sea para solo máquina nuevas"
- L2 (2026-10-08, user decision): option 1, quoted under Specs.
- L3 (evidence): Pi is an optional peer of gentle-pi; `gentle-shell` resolves `GENTLE_SHELL_PI`, then a bundled CLI, then `pi` on PATH (`lib/gentle-shell-launcher.ts:369`). The runner accepts only a clean stack (`requiredActions`, `scripts/installer-runner.mjs:90`) or setup recovery, and blocks `existing-stack`.
- L4 (evidence): the maintainer's own `gentle-shell` is an `npm link` of a source checkout (`~/.local/lib/node_modules/gentle-pi` → `~/work/gentle-pi`). Before this feature, `gentle-shell upgrade` would have treated it as npm-owned and `npm install -g` would replace the link; fixed in 25ea832d2.
- L5 (verification): native assess over cd1c54760..HEAD = medium (17 paths, 664 lines), large writer profile → writer self-verification stands, no independent verifier (the native tier wins while RDD is on). Full `pnpm test`: only the three failures already on main. Not verified: a real update through the wizard on a machine with an npm- or pnpm-owned older Gentle Shell; Windows npm ownership (not detected: npm.cmd needs a shell).

