# Estado del trabajo — Drakonc Shell

Última actualización: 2026-11-22.

Memoria del proyecto para retomar el trabajo entre sesiones. Los detalles de cada cambio están en `openspec/changes/<cambio>/` (proposal, design, specs y tasks). El progreso real se consulta con `openspec instructions apply --change <cambio> --json`.

## Cambios OpenSpec

| Cambio | Avance | Pendiente principal |
|---|---|---|
| `completar-identidad-drakonc-shell` | 19/31 | barrido de nombres (5.1–5.2), versión 0.1.0 (5.3), runtime (5.4), arranque limpio por defecto (5.5), contrato `gentle-ai.*` (5.6, en curso), imagen y README (4.4, 6.1), licencia (6.2), verificación (7.x) |
| `publicar-paquetes-drakonc` | 9/13 | guía `docs/publicar-paquetes.md` (4.1) y verificación (5.x) |
| `crear-drakonc-opencode-go` | 0/14 | paquete propio en `~/Desarrollo/FullStack/drakonc/drakonc-opencode-go`, repo público `github.com/drakonc` |
| `comando-limpiar-pantalla` | 0/5 | `/drakonc:clear` (en curso) |

## Hecho

- Barra de uso: alias del contrato heredado `gentle-pi:usage-source/v1`; los proveedores integrados no pueden ser suplantados; guía para activar OpenCode Go.
- Identidad visual: dragón Braille realista (amplio 38×17 y compacto 20×8) generado desde una imagen; glifo de marca 🐉 (🔥 al trabajar); "Drakonc" en rojo; paleta `#0d1526` / `#e6edf7` / `#ff4d5e` en TUI, temas, Tower y asistente; Tower con rótulo de dragón.
- `/drakonc:guide` en español; `/drakonc:toggle-rose` sustituido por `/drakonc:toggle-dragon`.
- Seguridad de instalación: nombres `drakonc-*` inexistentes restaurados a los reales con versión fija; inventario `lib/install-sources.ts` y `scripts/check-install-sources.mjs`; el instalador se detiene mientras `drakonc-pi` no esté publicado.
- Aislamiento: el binario companion recibe `GENTLE_*` y `DRAKONC_*` con rutas de Drakonc y `NO_SELF_UPDATE=1`; la configuración por defecto vive en `~/.drakonc-shell/drakonc-ai`.
- `contracts/` restaurado a sus bytes verificados por digest.

## Decisiones

- Paquetes nuevos en `~/Desarrollo/FullStack/drakonc/<nombre>`, repos públicos en la cuenta GitHub `drakonc`; npm `drakonc` con 2FA `auth-and-writes`. Publicar solo con confirmación explícita.
- Nombres heredados que son contrato real (binario `gentle-ai`, `gentle-engram`, `gentle-pi`, `showRose`) se conservan y se registran en `docs/brand-exceptions.md` hasta publicar los equivalentes propios.
- Las tareas se implementan en consolas Pi de herdr con `pi -ne -na --model opencode-go/deepseek-v4.1-flash:high`.
- Commit al llegar al 95 % de la ventana de uso de 5 horas, en rama `feature/`.

## Tareas pendientes (en orden)

Consolas detenidas por el usuario el 2026-11-22 (~19:30). Qué hizo cada una y qué le faltó (sus sesiones se pueden reanudar con `pi -ne -na --model opencode-go/deepseek-v4.1-flash:high --session <archivo>` desde `~/.pi/agent/sessions/--home-jcastro-Desarrollo-FullStack-drakonc-shell--/`):

- `pi-g5c` (identidad 5.6, contrato con el binario): hecho — `contracts/` restaurado a sus bytes (la comprobación del contrato pasa) y todos los identificadores de esquema de `lib/` y `extensions/` vuelven a `gentle-ai.*` (0 restos `drakonc-ai.*/vN`). Faltó: terminar la ejecución completa de la suite que tenía en curso, probar en un arranque real que desaparecen los avisos `schema-incompatible` y `routing/pi.md`. Tarea 5.6 sin marcar.
- `pi-inv` (diagnóstico de escrituras en `~/.pi/agent`): estaba ejecutando cada archivo de pruebas con HOME temporal y bwrap para aislar `~/.pi`. Faltó: la conclusión y la tabla de responsables. No cambió el repo. Hasta tenerla, no volver a borrar `~/.pi/agent/{agents,chains,drakonc-agents,drakonc-ai}`.
- `pi-clear` (`comando-limpiar-pantalla`): hecho — investigación (Pi encadena `headerContainer`, `loadedResourcesContainer` y `chatContainer`; la API de extensiones no ofrece limpiar), módulo `lib/session-view-clear.ts`, registro en `extensions/drakonc-shell.ts`, entrada en la paleta y en `docs/readme-reference.md`; 58 pruebas pasan (`session-view-clear` y `command-palette`). Faltó: la prueba real en terminal (se cortó mientras la hacía) y el informe final. Tareas sin marcar.
- `pi-readme` (README, parte de 6.1): hecho — secciones Requisitos, Instalación en otro equipo (Linux, macOS, Windows), Uso básico y Actualizar y desinstalar. Faltó: el enlace a `docs/readme-reference.md` que exige `tests/package-manifest.test.ts` (fallo previo) y el informe final.

Siguientes, cuando terminen:

1. Identidad 5.1–5.2: barrido de nombres (`Drakoncman-Programming/*` → `drakonc/*`, `DISTRIBUTION_RELEASES` del instalador, tema por defecto en pruebas, id de memoria `drakonc-engram` → `gentle-engram`, `✿` en `docs/drakonc-shell.md`, comentarios con pétalo/rosa, menciones a `~/.pi/drakonc-ai` en docs) y completar `docs/brand-exceptions.md`.
2. Identidad 5.3 y 5.5: versión `0.1.0` en todo el paquete; `quietStartup: true` por defecto en hogares nuevos.
3. Publicación 4.1: `docs/publicar-paquetes.md` (fases, verificación de propiedad, 2FA, trusted publishing, minisign para drakonc-ai).
4. `crear-drakonc-opencode-go` grupo 1: crear el paquete y su repo público; grupo 2: el panel de uso recomienda el paquete propio fijado a un SHA.
5. Identidad 4.4 y 6.1: imagen realista del dragón para el README (regenerar desde la imagen de Canva) y reescritura completa del README con la versión 0.1.0; 6.2 comprobar licencias intactas.
6. Identidad 5.4: regenerar `runtime/` al final.
7. Verificación de los cuatro cambios: `code-reviewer` y `security` en paralelo, luego `qa`; corregir hallazgos bloqueantes; archivar con `/opsx:archive`.
8. Publicación (con el usuario): PR de `feature/identidad-drakonc-shell`, `npm publish` de `drakonc-pi@0.1.0` (lo ejecuta el usuario por la 2FA), activar los nombres `drakonc-*` publicados; más adelante bifurcar `drakonc-engram` y `drakonc-ai` en cambios propios.

Pendientes menores anotados: traducir el resto de la interfaz (paleta, keymaps) si el usuario lo pide; estilo de cuadro de entrada tipo Claude Code (pospuesto); persona `gentleman` frente a `drakoncman` en `persona.json`; una prueba de `agents-widget` con desfase de una columna.

## Problemas abiertos

- Algo escribe en `~/.pi/agent` (`agents/`, `chains/`, `drakonc-agents/`, `drakonc-ai/`) aunque el launcher usa el hogar aislado; diagnóstico en curso.
- Engram del sistema actualizado a 3.7.2 (copia en `~/.engram.backup-3.0.0-20261122`).
- Fallos de pruebas pendientes de los grupos siguientes: versión 5.0.0, URLs `Drakoncman-Programming`, tema por defecto, README.
