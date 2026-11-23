# Design

## Context

Ver `proposal.md` (Why) para el diagnóstico. Estado relevante del código:

- Fuentes de uso: `lib/shell-usage.ts` define `USAGE_SOURCE_EVENT = "drakonc-pi:usage-source/v1"`, `USAGE_SOURCE_SCHEMA`, `parseUsageSource` y `UsageSourceRegistry`; `extensions/drakonc-shell.ts:2293` se suscribe con `pi.events.on(USAGE_SOURCE_EVENT, …)`. En `HEAD` ambos valores eran `gentle-pi:…`; el renombrado local los cambió.
- Barra: `lib/shell-bar.ts` ya pinta `modelo · esfuerzo │ ctx │ $ │ usage … · alt+u` (`executionSegment`, `usageSegmentText`, cascada de degradación en `headerContent`). Sin fuente, el segmento queda en `usage · alt+u`. El panel (`lib/shell-usage-view.ts`) usa `UNSUPPORTED_NOTE`.
- Atajo: `lib/keymaps.ts` define `usage` con `alt+u` y `DRAKONC_PI_SHELL_USAGE_KEY`.
- Paquete de terceros instalado en Gentle Shell: `gentle-opencode-go@0.1.2` (MIT), que emite `gentle-pi:usage-source/v1` con ventanas `5h`, `week`, `30d` desde `https://opencode.ai/zen/go/v1/usage`.
- Glifos de flor: `lib/shell-bar.ts` (`SHELL_BAR_BRAND`, `HEADER_BRAND`), `lib/shell-prompt.ts` (`PROMPT_PETAL`, `PETAL_FRAMES`), `lib/shell-card.ts`, `lib/shell-panel.ts`, `lib/shell-todo.ts`, `lib/agents-widget.ts`, `lib/agents-view.ts`, `lib/stats-view.ts`, `lib/shell-usage.ts` (`ACTIVE_MARK`), `lib/shell-usage-view.ts`, `lib/drakonc-ai-renderer.ts`.
- Banner: `extensions/startup-banner.ts` (`ROSE_LARGE_RAW` contiene hoy un dragón de líneas de 13 filas; la rosa original era Braille de 17 filas y ~37 columnas), con modos `full`, `minimal`, `skip`, disposición lado a lado si `width >= roseBase.width + 3 + logoBase.width + 4` y apilada si `width >= roseBase.width + 2`. Configuración en `lib/banner-config.ts` (`showRose`, `showTextLogo`, `color`).
- Tema: `themes/Drakonc.json` ya usa `#0d1526`, `#e6edf7` y acento `#ff4d5e`. Tower: `web/tower/src/style.css` ya usa `#0d1526`, pero `web/tower/src/art.ts` (constante `C`) conserva el neón rosa (`#ff76c3`, `#f095c8`, `#ffb1dd`). Hay temas de herdr en `herdr/themes/`.
- Versión: `package.json` declara `5.0.0`; varias pruebas e instalador derivan textos de la versión (`tests/package-manifest.test.ts`, `tests/main-channel.test.ts`, `tests/drakonc-ai-installer.test.ts`, `scripts/drakonc-ai-installer.mjs`, `docs/readme-reference.md`).
- Referencias externas renombradas a verificar: `github.com/drakoncman-programming/drakonc-ai`, `github.com/Drakoncman-Programming/engram`, `github.com/Drakoncman-Programming/drakonc-stream`, paquetes `npm:drakonc-pi`, `drakonc-engram`.
- `runtime/` contiene módulos generados desde TypeScript (`pnpm run build:runtime-modules`, `check:runtime-modules`).

## Goals / Non-Goals

**Goals:**
- Que la barra muestre las ventanas de OpenCode Go reutilizando el paquete existente, con el mínimo cambio en el contrato.
- Un único glifo de marca y una ilustración de dragón con variante compacta, sin cambiar el algoritmo de animación ni de centrado.
- Un barrido de marca reproducible con un registro de excepciones.

**Non-Goals:**
- Cliente propio de la API de OpenCode Go, cambios en la cascada de degradación de la barra, nuevas opciones de configuración, renombrar claves persistidas.

## Decisions

### D1. Alias del contrato de fuentes de uso
`parseUsageSource` recibe el esquema esperado según el evento: `drakonc-pi:usage-source/v1` solo acepta `drakonc-pi.usage-source/v1` y `gentle-pi:usage-source/v1` solo acepta `gentle-pi.usage-source/v1`. Se añaden constantes `LEGACY_USAGE_SOURCE_EVENT` y `LEGACY_USAGE_SOURCE_SCHEMA` junto a las actuales. El registro sigue siendo por proveedor, así que un paquete que emita en ambos nombres no duplica fuentes.

Defensa en profundidad (revisión `security`, S4): hoy una fuente externa tiene prioridad sobre la integrada (`extensions/drakonc-shell.ts:2176-2180`) y recibe la clave de `ctx.modelRegistry.getApiKeyForProvider` (`:2172`). `UsageSourceRegistry.register` rechaza los proveedores de `SUPPORTED_USAGE_PROVIDERS` (`openai-codex`, `anthropic`, `nan`) por ambos eventos.

- Alternativa descartada: cliente integrado de OpenCode Go en `lib/shell-usage.ts`. Añade un endpoint autenticado y lógica que ya existe y mantiene un tercero.
- Alternativa descartada: bifurcar y publicar `drakonc-opencode-go`. Requiere publicar (fuera de alcance).

### D2. Estado sin fuente y guía de activación
La barra no cambia (ya muestra `usage · alt+u`). El panel, para `opencode` y `opencode-go` sin fuente, añade una línea que indica instalar `npm:gentle-opencode-go@0.1.2` (versión fija) en el hogar de Drakonc y avisa de que es un paquete de terceros que recibe la clave de OpenCode Go. El comando exacto se valida contra la ayuda del launcher durante la implementación (paso de argumentos a Pi tras `--`). El texto no incluye endpoints ni datos de cuenta.

### D3. Glifo de marca: emoji 🐉 (decisión del usuario, 2026-11-22)
El usuario eligió el emoji de dragón `🐉` (2 celdas) en lugar de un carácter Braille de 1 celda, aceptando que en terminales sin fuente de emoji se vea como un cuadro. Los fotogramas de trabajo alternan `🐉` y `🔥`. Lo siguiente queda como alternativa descartada:
El glifo de marca y los fotogramas de animación del prompt se toman del bloque Braille (U+2800–U+28FF): el banner ya depende de él, siempre mide una celda y no es emoji. Se centraliza en una sola constante exportada (un módulo pequeño en `lib/`, por ejemplo `lib/brand-glyph.ts`) que reemplaza `✿`/`❀` en todos los módulos listados; `PETAL_FRAMES` pasa a fotogramas de llama de igual ancho. Los nombres internos (`petal*`) se renombran solo donde el archivo ya se toca.

- Alternativa descartada: `⚡` u otros símbolos con presentación emoji; ancho ambiguo en Windows Terminal.

### D4. Ilustración del dragón
Se genera fuera del repositorio, a partir de `docs/assets/brand/drakonc-dragon.svg`, con un script desechable en el scratchpad (rasterizado y umbral a celdas Braille 2×4). Solo se versionan las cadenas resultantes, sin nuevas dependencias:

- `DRAGON_LARGE_RAW`: máximo 38 columnas × 17 filas, para conservar los umbrales actuales de disposición.
- `DRAGON_COMPACT_RAW`: máximo 20 columnas × 8 filas.

En `extensions/startup-banner.ts` la rama apilada elige la variante amplia si `width >= large.width + 2`, la compacta si `width >= compact.width + 2` y ninguna en otro caso. La animación del logotipo y `padLines`/`normalizeAscii` no cambian. El color sigue `BANNER_PALETTES[color].rose` (por defecto `red`). `showRose` se conserva como clave; la UI la presenta como "dragón".

### D5. Paleta en Tower y herdr
En `web/tower/src/art.ts` la constante `C` (`neon`, `acc`, `accS`) pasa a la familia roja de marca derivada de `#ff4d5e`, manteniendo los demás colores de estado. Se revisan `style.css` y `herdr/themes/*.json` para el mismo trío fondo/texto/acento. Tower se recompila con `pnpm run build:tower`. Los temas opcionales `Drakoncman-Cute` y `Drakoncman-Sexy` se conservan como variantes no predeterminadas.

### D6. Versión 0.1.0
Se cambia `package.json` y cualquier versión literal propia; las pruebas que fijan `5.0.0` se ajustan para derivar la versión de `package.json`, como ya hace el último commit (`be74d44ce`). Las comprobaciones de versión de Pi y de companions (por ejemplo `0.4.2` de Engram en `bin/drakonc-shell.mjs`) no se tocan porque pertenecen a otros paquetes.

### D7. Barrido de marca y excepciones
Barrido con `grep -rni "gentle\|✿\|❀\|❁\|✾\|rose\|petal\|flower"` sobre código, recursos, pruebas y documentación. Cada referencia externa renombrada se comprueba con operaciones de solo lectura (`git ls-remote`, `npm view <pkg> maintainers repository`). Existir no basta: hay que demostrar que pertenece al proyecto. Si no existe o es ajena, se restaura el nombre real o se desactiva la referencia. Todo lo conservado se registra en `docs/brand-exceptions.md` (nombre, ubicación, contrato, motivo).

Esta tarea es **bloqueante y va primero** (revisión `security`, S1 CRÍTICA): no se ejecuta el launcher ni ninguna instalación hasta cerrarla. Puntos detectados:
- `lib/drakonc-shell-bundled.ts:278` `ENGRAM_COMPANION_SOURCE = "npm:drakonc-engram"`, instalado sin versión por `bin/drakonc-shell.mjs:459`. Se fija la versión (por ejemplo `@0.4.2`, como `LEGACY_ENGRAM_COMPANION_SOURCE` en `bin/drakonc-shell.mjs:312`) y se restaura `gentle-engram` si `drakonc-engram` es ajeno.
- `npm:drakonc-pi` en `lib/drakonc-shell-launcher.ts:668`, `lib/update-status.ts:6` y `lib/desktop-rpc-updates.ts:28`.
- `extensions/drakonc-music.ts:25`: `git+https://github.com/Drakoncman-Programming/drakonc-stream` sin commit fijo; se fija el commit como en `scripts/bundled-install.mjs:33` o se restaura el origen.
- Descargas con SHA-256 fijo (`scripts/installer-downloads.mjs:94`, `scripts/drakonc-ai-installer.mjs:42,84`, `scripts/bundled-wizard.mjs:17`): se restauran las URL que funcionan y los hashes solo se cambian si hay un checksum firmado.

### D8. Regeneración de módulos
Tras tocar TypeScript que alimenta `runtime/`, se ejecuta `pnpm run build:runtime-modules` y `pnpm run check:runtime-modules`; los hashes de `scripts/verify-package-files.mjs` se actualizan solo si la verificación lo exige.

## Seguridad

- Amenaza: una extensión registra una fuente para un proveedor integrado y recibe su clave. Control: el alias no amplía la superficie (el payload exige una función, solo llega desde código del mismo proceso), pero el registro rechaza los proveedores integrados. Se mantiene el patrón seguro de `provider`, la validación de `fetch`, el `fetchFn` acotado y el aislamiento de excepciones. Se documenta que una fuente recibe la clave de su proveedor.
- Amenaza: instalación automática de paquetes o repositorios con nombres renombrados que pueden no pertenecer al proyecto (CWE-829/494). Control: D7 bloqueante, con prueba de propiedad y versiones fijas.
- Amenaza: recomendar un paquete de terceros sin versión fija. Control: el panel y el README fijan `gentle-opencode-go@0.1.2` y avisan de que recibe la clave.
- Amenaza: filtrado de URL o token en mensajes de error. Control: el panel solo muestra notas genéricas (`USAGE_FETCH_FAILED_NOTE`); prueba específica.
- Amenaza: referencias externas renombradas que apuntan a repositorios o paquetes inexistentes y podrían ser registrados por terceros (typosquatting). Control: D7 restaura o desactiva y registra cada caso.
- Sin nuevas dependencias, endpoints ni almacenamiento de secretos.

## Risks / Trade-offs

- [El alias perpetúa un nombre heredado] → Se registra en `docs/brand-exceptions.md` y se documenta el contrato propio como preferido.
- [El arte Braille se ve distinto según fuente] → Se valida en anchos 60, 80, 120 y 200 con `scripts/shell-snapshot.mjs` o render directo, y en fuentes por defecto de cada sistema cuando sea posible; lo no verificado se reporta.
- [Bajar de 5.0.0 a 0.1.0 confunde comparaciones semver de actualización] → No hay versiones publicadas de Drakonc; se revisan `upgrade`/`main-channel` y sus pruebas.
- [Barrido amplio con 1 669 cambios locales sin confirmar] → No se revierte ni reescribe nada no relacionado; cada edición es puntual.
- [Restaurar nombres externos reintroduce "gentle" en el código] → Es intencional cuando es contrato real y queda registrado.

## Migration Plan

Sin migración de datos. `banner.json` y `settings.json` existentes se leen igual. Reversión: revertir el commit del cambio. Para usar OpenCode Go, el usuario instala el paquete en el hogar de Drakonc siguiendo el README.

## Open Questions

- Sintaxis exacta para instalar un paquete Pi en el hogar de Drakonc (`drakonc-shell -- install npm:…` u otra); se valida con la ayuda real del launcher sin cambiar el enfoque.
