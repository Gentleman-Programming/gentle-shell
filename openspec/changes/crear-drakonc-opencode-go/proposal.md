# Proposal

## Why

Las ventanas de uso de OpenCode Go (`5h · week · 30d`) solo llegan a Drakonc Shell a través del paquete de terceros `gentle-opencode-go@0.1.2`, que usa el contrato heredado `gentle-pi:usage-source/v1` y recibe la clave de OpenCode Go del usuario. El usuario quiere un paquete propio, `drakonc-opencode-go`, que use el contrato de Drakonc, cuyo código controle y que pueda instalar en otras máquinas sin depender de versiones futuras de un tercero.

## What Changes

- Crear el paquete Pi `drakonc-opencode-go` `0.1.0` en un repositorio aparte (`~/Desarrollo/FullStack/drakonc/drakonc-opencode-go`), derivado de `gentle-opencode-go@0.1.2` (MIT), conservando el aviso de copyright original.
- El paquete registra la fuente de uso de `opencode-go` con el contrato propio `drakonc-pi:usage-source/v1` y conserva la lectura del endpoint oficial, el rechazo de redirecciones y la validación defensiva del payload.
- Pruebas propias del paquete, ejecutables sin instalar dependencias.
- En Drakonc Shell, el panel `/drakonc:usage` recomienda el paquete propio con una referencia git fija en lugar de `npm:gentle-opencode-go@0.1.2`. El alias heredado `gentle-pi:usage-source/v1` se mantiene para quien use el paquete original.
- Documentar instalación del paquete (carpeta local y git con etiqueta) en su README y en la documentación de Drakonc.

## Capabilities

### New Capabilities

- `opencode-go-usage-source`: paquete que obtiene las ventanas de uso de OpenCode Go y las registra en Drakonc Shell mediante el contrato de fuentes de uso.

### Modified Capabilities

Ninguna en `openspec/specs/` (aún sin specs archivadas). La guía del panel para OpenCode se define en el cambio en curso `completar-identidad-drakonc-shell` (spec `usage-status-bar`, requisito "Estado explícito sin datos de uso"); este cambio sustituye el paquete recomendado y se coordina con ese cambio (ver design.md).

## Out of scope

- Publicar en npm, crear el repositorio remoto, etiquetas en GitHub o releases: los hace el usuario cuando lo decida.
- Instalar el paquete en `~/.drakonc-shell`, `~/.pi` o `~/.gentle-shell` como parte de la implementación.
- Cambiar el comportamiento de `gentle-opencode-go` o retirar el alias heredado de Drakonc.
- Nuevas métricas que el endpoint no entregue (por ejemplo saldo o costo).
- Instalar dependencias de desarrollo (`typescript`, `@earendil-works/pi-coding-agent`) en el nuevo repositorio sin aprobación.

## Seguridad

Toca **secretos** (el paquete recibe la clave de OpenCode Go y la envía como `Bearer`), **entradas externas** (JSON del endpoint) e **integraciones** (endpoint de terceros y contrato de eventos). Requiere revisión del agente `security` en modo `diseño`.

## Impact

- Nuevo repositorio `~/Desarrollo/FullStack/drakonc/drakonc-opencode-go/` (`package.json`, `src/extension.ts`, `src/usage.ts`, `test/*.test.ts`, `README.md`, `LICENSE`, `CHANGELOG.md`).
- Drakonc Shell: `lib/shell-usage.ts` (`OPENCODE_USAGE_SOURCE_PACKAGE`, `usageSourceHint`), `tests/shell-usage.test.ts`, `docs/drakonc-shell.md`, `docs/brand-exceptions.md`, `README.md`.
- Sin dependencias nuevas en Drakonc Shell.
