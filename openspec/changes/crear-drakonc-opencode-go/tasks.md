# Tasks

> El proyecto no tiene agentes locales `backend` ni `frontend`; esas tareas se implementan en la sesión principal (o en consolas Pi si el usuario lo pide) con las mismas reglas. Este cambio se implementa después de que `completar-identidad-drakonc-shell` cierre su grupo 2 (D6).

## 1. Paquete drakonc-opencode-go

- [ ] 1.1 [backend] Crear `~/Desarrollo/FullStack/drakonc/drakonc-opencode-go` con `git init` local (sin remoto) y copiar desde `gentle-opencode-go@0.1.2` instalado `src/extension.ts`, `src/usage.ts`, `LICENSE`, `README.md` y `CHANGELOG.md`; verificar con `diff -r` contra el original antes de modificar.
- [ ] 1.2 [backend] Ajustar `package.json` (`name: drakonc-opencode-go`, `version: 0.1.0`, descripción, `keywords` con `pi-package` y `drakonc-shell`, `files` con `src/**/*.ts`, `README.md`, `LICENSE` y `CHANGELOG.md` (sin `test/`), `pi.extensions`, sin instalar dependencias); verificar con `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` y revisión de campos.
- [ ] 1.3 [backend] Cambiar `src/extension.ts` al evento `drakonc-pi:usage-source/v1` y esquema `drakonc-pi.usage-source/v1`, y los comentarios a Drakonc Shell y `/drakonc:usage`; verificar con `grep -rn gentle src` sin resultados.
- [ ] 1.4 [backend] En `src/usage.ts`, envolver toda la llamada `fetchFn(...)` y la lectura del cuerpo en un `try/catch` que devuelva `undefined` sin volver a lanzar, sin tocar origen, cabecera ni `redirect: "error"`, y rechazar `content-length` > 64 KB; verificar con las pruebas de 1.5 y 1.6.
- [ ] 1.5 [backend] Escribir `test/usage.test.ts` y `test/extension.test.ts` con `fetchFn` y `pi` simulados: respuesta completa (5h 0 %, week 11 %, 30d 5 %), ventana parcial, `resetsAt` inválido, sin clave sin petición, 401/500, cuerpo no JSON, redirección rechazada, `status` distinto de ok, sin `status`, porcentaje ≥ 100, registro en cada `session_start` con el contrato propio y sin evento heredado, nota sin clave ni URL; verificar con `node --experimental-strip-types --test test/*.test.ts`.
- [ ] 1.6 [backend] Pruebas de seguridad de la revisión de diseño: `fetchFn` que rechaza con un error que contiene la clave → `undefined` sin lanzar; clave con `\n` → `undefined`; petición exacta a `https://opencode.ai/zen/go/v1/usage` con `redirect: "error"` y sin `signal` propio; `globalThis.fetch` sustituido por uno que lanza nunca se llama; `package.json` sin `dependencies` ni scripts `preinstall`/`install`/`postinstall`/`prepare` y peers `"*"`; verificar con `node --experimental-strip-types --test test/*.test.ts`.
- [ ] 1.7 [backend:ligero] Actualizar `LICENSE` (aviso original + `Copyright (c) 2026 Jose Castro`), `README.md` (origen 0.1.2, qué hace, instalación git fijada a SHA con la etiqueta como referencia legible, ruta local solo para desarrollo, riesgo residual de que el último registro de `opencode-go` gana, desinstalar `gentle-opencode-go` si estaba, aviso de que recibe la clave) y `CHANGELOG.md` (`0.1.0`); verificar que `LICENSE` conserva íntegro el aviso original.
- [ ] 1.8 [backend] Comprobar tipos con el `tsc` de `drakonc-shell/node_modules` si existe (`node_modules/.bin/tsc --noEmit -p` con un tsconfig temporal en el scratchpad); si no es posible, reportarlo como no verificado.

## 2. Recomendación en Drakonc Shell

- [ ] 2.1 [backend] Cambiar `OPENCODE_USAGE_SOURCE_PACKAGE` y `usageSourceHint` en `lib/shell-usage.ts` para recomendar `drakonc-opencode-go` desde git fijado a un commit SHA de 40 caracteres (solo cuando el usuario confirme remoto y SHA; mientras tanto, sin comando de instalación y remitiendo a la documentación), con el aviso de que recibe la clave; verificar con `tests/shell-usage.test.ts` (SHA de 40 hex o ningún comando, sin `npm:`, sin `<`, sin `gentle-opencode-go`, sin porcentajes, URL ni claves).
- [ ] 2.2 [backend] Añadir prueba de regresión de que una fuente emitida por el evento heredado (como `gentle-opencode-go`) sigue mostrándose; verificar con `node --experimental-strip-types --test tests/shell-usage-events.test.ts`.
- [ ] 2.3 [backend:ligero] Actualizar `docs/drakonc-shell.md`, `docs/brand-exceptions.md` y la sección de OpenCode Go del `README.md` de Drakonc con el paquete propio y el original como compatible; verificar que los comandos documentados coinciden con el texto del panel.

## 3. Verificación

- [ ] 3.1 [code-reviewer] Revisar el paquete nuevo y el diff de Drakonc de este cambio; sin hallazgos bloqueantes.
- [ ] 3.2 [security] Revisión en modo `cambio` en paralelo con 3.1, con foco en el manejo de la clave y el JSON externo; sin hallazgos `CRÍTICA` ni `ALTA`.
- [ ] 3.3 [qa] Verificar los escenarios de `specs/opencode-go-usage-source` con las pruebas del paquete y de Drakonc; veredicto `APTO` y lista de lo no verificado (endpoint real, instalación desde git en otra máquina, Windows y macOS).

## Workflow follow-up

- El usuario crea el remoto git, sube el paquete y crea la etiqueta `v0.1.0`; después se confirma la referencia del panel.
- Instalación real en el hogar de Drakonc solo cuando el usuario lo pida.
- Archivar con `/opsx:archive` cuando se cumplan los criterios.
