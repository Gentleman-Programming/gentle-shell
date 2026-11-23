# Proposal

## Why

Drakonc Shell es una bifurcación de Gentle Shell con un renombrado local amplio (1 669 archivos sin confirmar) pero incompleto: la barra de estado no muestra las ventanas de uso de OpenCode Go (`5h · week · 30d`) que sí muestra Gentle Shell, la TUI y Tower conservan flores y la paleta rosa heredada, el dragón del banner es un boceto de líneas muy por debajo del nivel de detalle de la rosa original, y varias referencias externas renombradas pueden haber roto integraciones reales. Además el paquete sigue declarando la versión `5.0.0` del original en lugar de la primera versión propia `0.1.0`.

Diagnóstico confirmado de la barra de uso:

- Modelo, esfuerzo, contexto y costo ya se muestran (`lib/shell-bar.ts`, `executionSegment`); lo que falta son las ventanas de uso.
- Drakonc solo trae fuentes de uso integradas para `openai-codex`, `anthropic` y `nan` (`lib/shell-usage.ts`, `SUPPORTED_USAGE_PROVIDERS`). OpenCode Go no es una de ellas.
- En Gentle Shell las ventanas `5h/week/30d` las aporta el paquete externo `npm:gentle-opencode-go`, declarado en `~/.gentle-shell/agent/settings.json`, que consulta `https://opencode.ai/zen/go/v1/usage` y publica la fuente con el evento `gentle-pi:usage-source/v1`.
- `~/.drakonc-shell/agent/settings.json` no declara ese paquete y, aunque lo hiciera, el renombrado cambió el contrato a `drakonc-pi:usage-source/v1`, por lo que el evento del paquete nunca llegaría.
- El atajo `alt+u` ya está definido (`lib/keymaps.ts`) y abre `drakonc:usage`; solo se ve en la barra cuando hay una fuente de uso para el proveedor activo.

## What Changes

- Aceptar, además del contrato propio `drakonc-pi:usage-source/v1`, el contrato heredado `gentle-pi:usage-source/v1` como alias de compatibilidad para que paquetes de la comunidad como `gentle-opencode-go` funcionen sin modificarse. La validación del payload no cambia.
- Cuando el proveedor activo no tiene fuente de uso, la barra y el panel `/drakonc:usage` lo indican explícitamente en lugar de quedar en silencio, sin inventar métricas. El resto de proveedores conserva su comportamiento.
- Documentar cómo habilitar el uso de OpenCode Go en Drakonc (instalar el paquete en el hogar de Drakonc) sin modificar `~/.pi` ni `~/.gentle-shell`.
- Sustituir el glifo de flor (`✿ ❀ ❁ ✾`) por un glifo de dragón/llama coherente en barra, prompt, tarjetas, paneles, agentes, todo, estadísticas y uso, incluida la animación de estado del prompt.
- Rediseñar el dragón del banner con el mismo nivel de detalle que la rosa original (arte Braille/Unicode), con variante compacta para terminales estrechas, sin romper centrado ni animación.
- Alinear el tema `Drakonc`, las variantes, el launcher y Tower con fondo `#0d1526`, texto `#e6edf7` y rojo eléctrico como acento; eliminar la paleta rosa/neón heredada en Tower.
- Recorrer comandos, mensajes, atajos, configuración, documentación, recursos y pruebas para corregir incoherencias de marca, restaurar nombres externos reales que el renombrado rompió y documentar las excepciones en un archivo dedicado.
- Fijar la versión del paquete en `0.1.0` y reescribir el README con la nueva imagen, la versión, la descripción de herramientas, uso e instalación en otras máquinas.
- **BREAKING** (solo para quien dependa de la versión): el paquete pasa de `5.0.0` a `0.1.0`; las comprobaciones de versión del launcher, del canal de actualización y de las pruebas deben seguir funcionando con la nueva numeración.

## Capabilities

### New Capabilities

- `usage-status-bar`: fuentes de uso por proveedor, contrato de registro de fuentes (incluido el alias heredado), segmento de uso de la barra, atajo `alt+u` y estados sin datos.
- `brand-visual-identity`: paleta, glifo de marca, banner de inicio con dragón (amplio y compacto), tema, launcher, vistas de personalización y Tower.
- `brand-naming`: espacio de nombres `/drakonc:` y `drakonc-shell`, excepciones documentadas para contratos externos, versión `0.1.0` y documentación de uso e instalación.

### Modified Capabilities

Ninguna: el proyecto no tenía specs previas en `openspec/specs/`.

## Out of scope

- Implementar dentro de Drakonc un cliente propio para la API de uso de OpenCode Go (se reutiliza el paquete externo existente mediante el alias de contrato).
- Instalar automáticamente paquetes en el hogar del usuario, migrar o sobrescribir `banner.json`, `settings.json`, `auth.json` u otros datos del usuario, y tocar `~/.pi` o `~/.gentle-shell`.
- Publicar en npm, crear releases, etiquetas o despliegues.
- Renombrar claves persistidas del usuario (por ejemplo `showRose` en `banner.json`): se mantienen como contrato y se documentan.
- Aislamiento independiente de Engram y validación integral de servicios externos renombrados más allá de detectar y documentar los rotos.
- Cambios en la licencia MIT o en los avisos de copyright originales.

## Seguridad

El cambio toca **entradas externas** (payloads de eventos que llegan desde otras extensiones por el bus `pi.events`, ahora también con el nombre heredado) y la presentación de datos de **proveedores autenticados** (las fuentes de uso reciben la clave del proveedor). No añade dependencias, endpoints ni almacenamiento de secretos. Requiere revisión del agente `security` en modo `diseño` sobre el alias del contrato.

## Impact

- Código: `lib/shell-usage.ts`, `extensions/drakonc-shell.ts`, `lib/shell-bar.ts`, `lib/shell-usage-view.ts`, `lib/shell-prompt.ts`, `lib/shell-card.ts`, `lib/shell-panel.ts`, `lib/shell-todo.ts`, `lib/agents-widget.ts`, `lib/agents-view.ts`, `lib/stats-view.ts`, `lib/drakonc-ai-renderer.ts`, `lib/visual-customize-view.ts`, `extensions/startup-banner.ts`, `themes/*.json`, `web/tower/src/{art,scene,style.css,…}`, `herdr/themes`, `package.json`, `bin/drakonc-shell.mjs`, scripts de versión e instalador.
- Módulos generados en `runtime/` que se regeneran con `pnpm run build:runtime-modules`.
- Pruebas en `tests/` que fijan glifos, versión, contratos y nombres.
- Documentación: `README.md`, `docs/drakonc-shell.md`, `docs/assets/brand/`, nuevo `docs/brand-exceptions.md`.
- Sin nuevas dependencias.
