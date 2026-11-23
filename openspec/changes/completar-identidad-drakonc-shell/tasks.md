# Tasks

> El proyecto no tiene agentes locales `backend` ni `frontend` en `.claude/agents/`; según las reglas globales, esas tareas se implementan en la sesión principal con las mismas reglas.

## 0. Referencias externas (bloqueante, antes de ejecutar el launcher o instalar nada)

- [x] 0.1 [backend] Comprobar con `npm view <pkg> maintainers repository` y `git ls-remote` (solo lectura) la existencia y propiedad de `drakonc-engram`, `drakonc-pi`, `github.com/Drakoncman-Programming/{engram,drakonc-stream}` y `github.com/drakoncman-programming/drakonc-ai`; restaurar el nombre original (`gentle-engram`, `gentle-pi`, …) cuando no exista o sea ajeno; verificar con un informe en el scratchpad por referencia.
- [x] 0.2 [backend] Fijar versiones en instalaciones automáticas: `ENGRAM_COMPANION_SOURCE` (`lib/drakonc-shell-bundled.ts:278`, usado en `bin/drakonc-shell.mjs:459`) con versión fija y el repositorio de `extensions/drakonc-music.ts:25` con commit fijo como `scripts/bundled-install.mjs:33`; no cambiar hashes SHA-256 de `scripts/installer-downloads.mjs`, `scripts/drakonc-ai-installer.mjs` ni `scripts/bundled-wizard.mjs` sin checksum firmado; verificar con pruebas del launcher e instalador (`pnpm test`).

## 1. Barra de uso y contrato de fuentes

- [x] 1.1 [backend] Añadir `LEGACY_USAGE_SOURCE_EVENT`/`LEGACY_USAGE_SOURCE_SCHEMA` en `lib/shell-usage.ts` y hacer que `parseUsageSource` reciba el esquema esperado por evento (cada evento solo acepta su esquema); verificar con pruebas en `tests/shell-usage.test.ts` para esquema propio, heredado, esquemas cruzados, `provider` inválido, `fetch` ausente y re-registro del mismo proveedor (`node --experimental-strip-types --test tests/shell-usage.test.ts`).
- [x] 1.2 [backend] Suscribir `extensions/drakonc-shell.ts` a ambos eventos; verificar con una prueba que emite `gentle-pi:usage-source/v1` con una fuente `opencode-go` simulada (ventanas `5h` 0 %, `week` 11 %, `30d` 5 %) y comprueba que la barra renderiza `usage 5h … 0% · week … 11% · 30d … 5% · alt+u`.
- [x] 1.3 [backend] Hacer que `UsageSourceRegistry` rechace proveedores de `SUPPORTED_USAGE_PROVIDERS`; verificar con una prueba que registra `anthropic` por ambos eventos y comprueba que la fuente integrada sigue activa y que la función ajena nunca recibe la clave.
- [x] 1.4 [backend] En `lib/shell-usage-view.ts`/`lib/shell-usage.ts`, añadir para `opencode` y `opencode-go` sin fuente una línea de cómo habilitarla con `npm:gentle-opencode-go@0.1.2`, avisando de que es de terceros y recibe la clave (comando validado con `node bin/drakonc-shell.mjs --help`); verificar con prueba de render del panel que no contiene porcentajes, URL ni claves.
- [x] 1.5 [backend] Añadir pruebas de regresión: Codex, Anthropic y NaN conservan etiquetas y notas; fuente que lanza error muestra `fetch failed · r to retry` sin el texto del error; ventana única no muestra `week`/`30d`; atajo redefinido con `DRAKONC_PI_SHELL_USAGE_KEY` se refleja en la barra; modelo sin esfuerzo omite `· esfuerzo`.
- [x] 1.6 [backend:ligero] Actualizar la sección de fuentes de uso de `docs/drakonc-shell.md` con el alias heredado y la recomendación del contrato propio; verificar que el ejemplo documentado coincide con el esquema aceptado.

## 2. Glifo de marca en la TUI

- [x] 2.1 [frontend] Crear la constante única del glifo de marca `🐉` (U+1F409, 2 celdas) y los fotogramas de trabajo `🐉`/`🔥`, pintar `drakonc`/`Drakonc` del nombre de marca con el acento rojo y sustituir `✿`, `❀`, `❁`, `✾` en `lib/shell-bar.ts`, `lib/shell-prompt.ts`, `lib/shell-card.ts`, `lib/shell-panel.ts`, `lib/shell-todo.ts`, `lib/agents-widget.ts`, `lib/agents-view.ts`, `lib/stats-view.ts`, `lib/shell-usage.ts`, `lib/shell-usage-view.ts`, `lib/drakonc-ai-renderer.ts`; verificar con `grep -rn "✿\|❀\|❁\|✾" lib extensions` sin resultados.
- [x] 2.2 [frontend] Actualizar las pruebas que fijan los glifos y añadir una que mida con `visibleWidth` que el glifo y cada fotograma ocupan 2 celdas, sin selectores de variación, que ninguna línea con el glifo supera el ancho y que `Drakonc` usa el rol de acento; verificar con `pnpm test`.
- [x] 2.3 [frontend:ligero] Ajustar comentarios y textos de UI que mencionan pétalo/flor/rosa en los archivos ya tocados (por ejemplo `lib/visual-customize-view.ts`, `extensions/drakonc-shell.ts`) para hablar de dragón; verificar con `grep -rni "petal\|flower\|rose" lib extensions` revisando que solo quedan identificadores de contrato (`showRose`) o internos no tocados.

## 3. Dragón del banner

- [x] 3.1 [frontend] Generar en el scratchpad, a partir de `docs/assets/brand/drakonc-dragon.svg`, las variantes Braille `DRAGON_LARGE_RAW` (≤ 38 × 17) y `DRAGON_COMPACT_RAW` (≤ 20 × 8) con detalle comparable a la rosa original; verificar visualmente lado a lado con la rosa de `HEAD` y que ninguna línea tiene tabuladores ni caracteres anchos.
- [x] 3.2 [frontend] Integrar ambas variantes en `extensions/startup-banner.ts` con la selección amplia/compacta/ninguna del diseño D4, sin cambiar la animación del logotipo; verificar con pruebas que renderizan en anchos 30, 50, 80, 120 y 200 y comprueban que ninguna línea supera el ancho, que el centrado es estable entre fotogramas y que el estado final animado coincide con el estático.
- [x] 3.3 [frontend] Mostrar la opción como "dragón" en `lib/visual-customize-view.ts` y su vista previa con la ilustración nueva, leyendo `showRose` sin migrar; verificar con prueba que un `banner.json` con `showRose: false` oculta el dragón y no se reescribe al iniciar.
- [x] 3.4 [frontend] Probar el banner real en terminal estrecha y amplia (`scripts/shell-snapshot.mjs` con `--cols 60` y `--cols 180`, o render directo del componente) y guardar la evidencia en el scratchpad.

## 4. Paleta, launcher y Tower

- [x] 4.1 [frontend] Cambiar en `web/tower/src/art.ts` la familia `neon`/`acc`/`accS` y cualquier rosa heredado de `web/tower/src/*.ts` y `style.css` por el rojo de marca derivado de `#ff4d5e`, con fondo `#0d1526` y texto `#e6edf7`; reemplazar flores en el arte de Tower por el dragón; verificar con `pnpm run build:tower` y revisión visual en navegador.
- [x] 4.2 [frontend:ligero] Alinear `herdr/themes/drakonc-shell-dark.json`, `herdr/themes/drakonc-shell-light.json` y `themes/Drakonc.json` con el trío fondo/texto/acento; verificar con una prueba o script que calcula contraste ≥ 4.5:1 de texto, acento, aviso y error sobre `#0d1526`.
- [x] 4.3 [frontend] Revisar la salida del launcher (`bin/drakonc-shell.mjs`, `lib/drakonc-shell-launcher.ts`, `lib/drakonc-shell-startup-flow.ts`, asistente en `assets/install-wizard`) para colores, iconos y textos heredados; verificar con `node bin/drakonc-shell.mjs --help` y las pruebas del launcher.
- [ ] 4.4 [frontend] Actualizar los recursos de `docs/assets/brand/` (imagen del README, banner, GIF si aplica) para mostrar el dragón sobre `#0d1526` sin flores; verificar abriendo los SVG en navegador.

## 5. Nombres, excepciones y versión

- [ ] 5.1 [backend] Ejecutar el barrido de marca del diseño D7 sobre el resto de referencias (las de instalación ya se cerraron en el grupo 0), aplicando la misma prueba de propiedad; verificar que `pnpm test` pasa tras cada restauración.
- [ ] 5.2 [backend:ligero] Crear `docs/brand-exceptions.md` con cada nombre heredado o externo conservado (incluidos `gentle-pi:usage-source/v1`, `gentle-opencode-go`, `showRose`, avisos de licencia y `TRADEMARKS.md`), su ubicación, contrato y motivo; verificar que cada coincidencia restante de `grep -rni gentle` fuera de `node_modules` aparece en el registro.
- [ ] 5.3 [backend] Cambiar la versión a `0.1.0` en `package.json` y en literales propios; adaptar las pruebas que fijan `5.0.0` para derivar la versión de `package.json`; revisar `scripts/main-channel.mjs` y `upgrade` para comparaciones semver; verificar con `node bin/drakonc-shell.mjs --version` y `pnpm test`.
- [ ] 5.4 [backend] Regenerar `runtime/` con `pnpm run build:runtime-modules` y comprobar `pnpm run check:runtime-modules`, `pnpm typecheck` y `node scripts/verify-package-files.mjs` (actualizando hashes solo si lo exige).
- [ ] 5.5 [backend] Arranque limpio por defecto: al crear un hogar aislado nuevo, el launcher escribe `"quietStartup": true` en su `settings.json` sin sobrescribir un valor existente (decisión del usuario, 2026-11-22); verificar con prueba de hogar nuevo (se añade) y de hogar con valor previo (se respeta).
- [ ] 5.6 [backend] Restaurar el contrato real con el binario `gentle-ai` y el bundle del proveedor: (a) devolver a `gentle-ai.*` los identificadores de esquema que cruzan la frontera con el binario (188 apariciones en 21 archivos de `lib/`, `extensions/`, `runtime/`, `scripts/`, `bin/` y sus pruebas), (b) restaurar `contracts/` a los bytes reales verificados por digest y (c) registrar ambas excepciones en `docs/brand-exceptions.md`; verificar con `node scripts/check-provider-contract.mjs`, las pruebas de revisión nativa, RDD y telemetría, y sin el aviso `schema-incompatible` ni el error de `routing/pi.md` (detectado por el usuario al arrancar, 2026-11-22).

## 6. README

- [ ] 6.1 [frontend:ligero] Reescribir `README.md` en español con la imagen del dragón, versión `0.1.0`, descripción de herramientas y comandos (`/drakonc:usage`, `/drakonc:tower`, `/drakonc:guide`, `/drakonc:commands`, agentes, revisión, memoria, personalización, banner), uso básico, instalación en otras máquinas para Linux, macOS y Windows, activación opcional de OpenCode Go y aviso de origen MIT; verificar ejecutando en una copia limpia los comandos documentados que no instalan nada globalmente y comprobando que no tocan `~/.pi` ni `~/.gentle-shell`.
- [ ] 6.2 [qa] Comprobar que `LICENSE`, `assets/sounds/LICENSE.md` y los avisos de copyright no cambiaron (`git diff HEAD -- LICENSE assets/sounds/LICENSE.md` sin cambios del cambio actual).
- [x] 6.3 [frontend:ligero] Traducir al español la guía `/drakonc:guide` (títulos y textos de los pasos en `lib/drakonc-guide.ts` y textos de navegación de `extensions/drakonc-guide.ts`), conservando comandos, atajos e identificadores; petición del usuario 2026-11-22; verificar con `tests/drakonc-guide.test.ts` actualizado y revisión de que no queda texto visible en inglés.

## 7. Verificación

- [ ] 7.1 [code-reviewer] Revisar el diff del cambio (excluyendo los cambios locales previos no relacionados) y resolver hallazgos bloqueantes.
- [ ] 7.2 [security] Revisión en modo `cambio` en paralelo con 7.1, con foco en el alias de fuentes de uso, mensajes de error y referencias externas; sin hallazgos `CRÍTICA` ni `ALTA` abiertos.
- [ ] 7.3 [qa] Verificar los escenarios de `specs/usage-status-bar`, `specs/brand-visual-identity` y `specs/brand-naming` con `pnpm test`, `pnpm typecheck`, `pnpm run check:runtime-modules`, `pnpm run build:tower` y las capturas del banner; veredicto `APTO` y lista explícita de lo no verificado (macOS, Windows, fuentes concretas, API real de OpenCode Go).

## Workflow follow-up

- Archivar con `/opsx:archive` cuando `code-reviewer`, `security` y `qa` cumplan los criterios.
- No publicar en npm ni crear releases como parte de este cambio.
