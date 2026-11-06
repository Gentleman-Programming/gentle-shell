# Cadena de PRs locales — audio de notificaciones (#1829)

Objetivo: preparar LOCALMENTE una cadena de ramas por unidades revisables que reemplace las entregas monolíticas `feat/sound-notifications` y `feat/native-notification-audio` por 24 PRs pequeños, encadenados y revisables, contra `main`.

## Contexto verificado

| Dato | Valor |
|---|---|
| Base de integración | `main` @ `69c9b5ae` (worktree `gentle-shell-audio-chain`, rama `feat/1829-audio-tracker`) |
| Fuente | `feat/native-notification-audio` @ `3d04d14e`, 34 commits desde merge-base `a87192ee` |
| Rama previa relacionada | `feat/sound-notifications` @ `9a1f8a75` |
| Diff fuente | 50 archivos, 9295 adiciones / 38 eliminaciones (assets WAV binarios y licencia aparte) |
| Deriva de `main` desde `a87192ee` | 204 commits; 106 archivos |

`main` evolucionó de forma solapada en `extensions/gentle-agents.ts`, `lib/agents-protocol.ts`, `extensions/gentle-shell.ts`, `scripts/verify-package-files.mjs`, `tests/agents-protocol.test.ts`, `tests/gentle-shell.test.ts`, `tests/package-manifest.test.ts` y `docs/readme-reference.md`. La integración conserva los cambios más recientes de `main` y adapta, con test-first aplicable, solo lo necesario.

## Política de la cadena

- 24 ramas hijas encadenadas: `feat/1829-audio-01-config` … `feat/1829-audio-24-duration`. Cada una parte de su predecesora inmediata; la primera parte de esta rama de tracker.
- Cada rama transpone commits fuente relevantes; no se aplican `ours`/`theirs` en bloque, ni reset duro, ni rebase de ramas originales.
- Todos los 34 commits fuente quedan contabilizados, incluidos evidencia ODD y documentación.
- La rama de tracker solo aporta este documento de planificación: no entra en el diff de la unidad 01 (su base es esta rama), pero sí es la base del PR de la cadena.
- PR tracker y PRs hijas: `Refs #1829`. `Closes #1829` queda reservado para el PR final de integración, para que el merge del tracker no cierre la issue antes de entregar la feature. Estado final de la cadena: draft, sin merge.
- Una etiqueta de tipo planificada por PR (no aplicada). Checklists públicas sin marcar hasta tener prueba.

## Unidades planificadas

| # | Rama | Commits fuente | Neto agrupado (líneas) | Alcance |
|---:|---|---|---:|---|
| 1 | `feat/1829-audio-01-config` | `e82d8ba5`, `19dc3f95` | 578 (4 archivos) | Propuesta ODD y contrato/lectura-escritura de política |
| 2 | `feat/1829-audio-02-scheduler` | `0229cb1a` | 407 (5 archivos) | Scheduler serial acotado, TTL, prioridad y permit |
| 3 | `feat/1829-audio-03-audio-assets` | `2ba613d7` | 386 (7 archivos) | Backend WAV seguro y sonidos incluidos con licencia |
| 4 | `feat/1829-audio-04-events` | `895d7890` | 332 (6 archivos) | Publicación de transiciones de subagentes y eventos |
| 5 | `feat/1829-audio-05-service` | `c3a20d8e` | 548 (4 archivos) | Ciclo de vida interactivo y propietario único |
| 6 | `feat/1829-audio-06-panel` | `dcbb52b6` | 267 (4 archivos) | Panel explícito de configuración y preview |
| 7 | `feat/1829-audio-07-customize` | `da76cc33` | 182 (8 archivos) | Enlace opt-in desde customize y documentación |
| 8 | `feat/1829-audio-08-packaging` | `63e71bc8`, `bebfb37b` | 200 (7 archivos) | npm 12 en `npm pack --json` y evidencia ODD |
| 9 | `feat/1829-audio-09-inline-fields` | `b96318b0` | 386 (2 archivos) | Campos inline seguros en el modal |
| 10 | `feat/1829-audio-10-modal-rows` | `8bccca77` | 445 (2 archivos) | Filas directas de audio en la tarjeta |
| 11 | `feat/1829-audio-11-labels-docs` | `7d4de7d0`, `1f332a57` | 162 (10 archivos) | Etiquetas, hookup, recursos y evidencia |
| 12 | `feat/1829-audio-12-folded-rows` | `4abb84bf` | 94 (2 archivos) | Filas plegables y hints contextuales |
| 13 | `feat/1829-audio-13-groups` | `78953cd4`, `a22e5ac5` | 596 (7 archivos) | Grupos básicos, WAV propio y evidencia |
| 14 | `feat/1829-audio-14-removed-rows` | `878f3bd3`, `9a1f8a75` | 424 (13 archivos) | Retiro de disponibilidad/restore y formatos WAV/OGG/FLAC |
| 15 | `feat/1829-audio-15-native-plan-codec` | `9282b002`, `b2bdee09` | 945 (3 archivos) | Plan de backend nativo y códec PulseAudio |
| 16 | `feat/1829-audio-16-pulse-client` | `7ea3e15a` | 746 (3 archivos) | Cliente PulseAudio autenticado |
| 17 | `feat/1829-audio-17-pulse-stream` | `597e4d27` | 615 (4 archivos) | Streaming PCM acotado |
| 18 | `feat/1829-audio-18-native-worker` | `e368e74a` | 570 (6 archivos) | Worker Node acotado y presencia en paquete |
| 19 | `feat/1829-audio-19-integrated-wav` | `7f1b87ac`, `25e6b775` | 559 (8 archivos) | WAV integrado sin reproductores externos y evidencia |
| 20 | `feat/1829-audio-20-windows-adapter` | `0c6eaea6` | 753 (5 archivos) | Adaptador Windows acotado |
| 21 | `feat/1829-audio-21-wsl-playback` | `57fbe506` | 367 (3 archivos) | Reproducción directa desde WSL |
| 22 | `feat/1829-audio-22-system-routing` | `fe8d8fc3`, `b08d2002` | 272 (6 archivos) | Enrutado Windows/macOS y evidencia |
| 23 | `feat/1829-audio-23-private-snapshot` | `c398aadd`, `2f82cb69`, `ad18b072` | 188 (3 archivos) | Snapshot Windows en memoria acotada y evidencia audible |
| 24 | `feat/1829-audio-24-duration` | `3d04d14e` | 193 (14 archivos) | Duración de notificación hasta diez segundos |

Total neto agrupado: 10 215 líneas (incluye churn entre unidades; el diff neto fuente completo es 9 295/+38). Las unidades que superan ~400 líneas se justifican por acoplamiento real (tests y validadores en el mismo contrato), no por número de commits, y no se recortan tests ni documentación para encajar.

## Fuera de alcance

- Push, apertura de PR, merge, red, `gh`, instalaciones y reproducción de audio.
- Review nativo, subagentes y aprobaciones.
- Cambios en ramas o worktrees originales.
- Reescritura de la propuesta no rastreada `docs/sound-notifications-proposal.md` del worktree `main`.
