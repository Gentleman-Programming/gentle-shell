# Proposal

## Why

Drakonc Shell todavía depende de paquetes y binarios publicados por el proyecto original (`gentle-pi`, `gentle-engram`, el binario `gentle-ai` y el repo `gentle-stream`), porque sus equivalentes `drakonc-*` no existen en npm ni en GitHub (verificado el 2026-11-22, ver `docs/brand-exceptions.md`). Por eso el primer arranque muestra `Installing npm:gentle-pi` / `npm:gentle-engram`.

Además, el primer arranque del usuario (2026-11-22 16:54) escribió fuera de los hogares de Drakonc: creó `~/.pi/gentle-ai/persona.json` (ya eliminado a petición del usuario), actualizó `~/.gentle-ai/state.json` y creó `~/.gentle-ai/pi-codegraph-*.json`. Causa raíz verificada: el renombrado cambió las variables de aislamiento que el launcher pasa al binario (`GENTLE_AI_HOME`, `GENTLE_AI_PI_CONFIG_DIR`, `GENTLE_AI_ENGRAM_BIN`, `GENTLE_AI_NO_SELF_UPDATE`, `GENTLE_PI_CONFIG_HOME`) a `DRAKONC_*`; el binario instalado es el `gentle-ai` original, no las reconoce y usa sus rutas por defecto, e incluso queda sin la orden de no autoactualizarse.

## What Changes

- **Corrección urgente de aislamiento:** mientras el binario instalado sea el `gentle-ai` original, el launcher le pasa sus variables reales (`GENTLE_*`) con las rutas de Drakonc, además de las `DRAKONC_*`; ninguna ejecución del instalador escribe en `~/.pi` ni `~/.gentle-ai`.
- **Ruta de configuración propia:** la carpeta de configuración por defecto de Drakonc (`~/.pi/drakonc-ai`, heredada del diseño original) deja de estar dentro de `~/.pi` en el modo aislado por defecto; se respeta una carpeta existente sin migrarla ni borrarla.
- **Plan de publicación por fases**, cada una con fuente fijada (versión exacta o commit SHA) y cambio de nombre solo cuando el artefacto propio exista y sea del usuario:
  1. Repo `Drakoncman-Programming/drakonc-shell` en GitHub (canal de actualización, `repository`, enlaces).
  2. Paquete Pi `drakonc-pi@0.1.0` (este repo) en npm o por git fijado a SHA.
  3. Bifurcación `drakonc-engram` del companion de memoria.
  4. Bifurcación `drakonc-ai` del binario con releases y checksums propios.
  5. Opcional: `drakonc-stream` para la música.
- Guía paso a paso (`docs/publicar-paquetes.md`) de lo que el usuario debe crear y publicar, con comandos y verificaciones; el código queda preparado para cambiar cada fuente con una constante y su prueba.
- Comprobación automatizada de que ninguna fuente de instalación apunta a un nombre `drakonc-*` sin publicar.

## Capabilities

### New Capabilities

- `companion-isolation`: contrato de entorno entre el launcher y los instaladores/binarios companion, y garantía de que no escriben fuera de los hogares de Drakonc.
- `package-distribution`: fuentes de instalación de los paquetes y binarios companion, su fijación y el paso de nombres heredados a propios.

### Modified Capabilities

Ninguna en `openspec/specs/`. Se coordina con `completar-identidad-drakonc-shell` (grupo 0 y spec `brand-naming`, requisito de excepciones) y con `crear-drakonc-opencode-go`.

## Out of scope

- Crear cuentas, organizaciones, repositorios remotos, publicar en npm, crear releases o firmar binarios: los hace el usuario siguiendo la guía.
- Reescribir el binario `gentle-ai` (Go): la bifurcación se plantea como fase 4 con su propio cambio cuando el usuario la emprenda.
- Migrar o borrar `~/.gentle-ai`, `~/.pi/drakonc-ai` u otros datos del usuario.

## Seguridad

Toca **dependencias y cadena de suministro** (fuentes de instalación, binarios descargados, checksums), **configuración de entorno** de procesos hijos y **datos del usuario** fuera del hogar aislado. Requiere revisión de `security` en modo `diseño`.

## Impact

- `lib/drakonc-ai-binary.ts`, `lib/drakonc-shell-bundled.ts`, `bin/drakonc-shell.mjs`, `lib/agent-home.ts`, `scripts/pi-update.mjs`, módulos generados en `runtime/`, pruebas asociadas.
- `docs/brand-exceptions.md`, nuevo `docs/publicar-paquetes.md`, `README.md` (sección de instalación).
- Sin dependencias nuevas.
