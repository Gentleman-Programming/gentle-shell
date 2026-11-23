# Tasks

> Sin agentes locales `backend`/`frontend`: se implementa en la sesión principal o en consolas Pi si el usuario lo pide. El grupo 1 es urgente y no depende de publicar nada.

## 1. Aislamiento del binario companion (urgente)

- [x] 1.1 [backend] En `lib/drakonc-ai-binary.ts` emitir `GENTLE_*` junto a `DRAKONC_*` según D1, incluido `standaloneDrakoncAiEnv` (modo aislado por defecto: `*_AI_HOME` dentro del hogar aislado y `*_NO_SELF_UPDATE=1`), con las carpetas hijas definidas en D1; revisar `lib/drakonc-shell-bundled.ts` y `buildSetupEnv`; verificar con pruebas de entorno en modo empaquetado, aislado y `--link` (`*_NO_SELF_UPDATE=1` en los tres) y que Pi no hereda esas variables.
- [x] 1.2 [backend] Prueba de integración de no escritura (D2) en modo aislado por defecto y empaquetado: binario simulado que escribe en las rutas recibidas o en las por defecto de `gentle-ai`, `HOME` temporal sembrado; verificar que `~/.pi`, `~/.gentle-ai` y `~/.gentle-shell` quedan idénticos y que la política escrita por el binario es la que lee drakonc-pi.
- [x] 1.5 [backend] `sharedPersonaPath` (`bin/drakonc-shell.mjs:1035-1036`) cubre `~/.pi/drakonc-ai/persona.json` y `~/.pi/gentle-ai/persona.json` mientras el binario sea `gentle-ai`; verificar con prueba de copia y restauración de ambas.
- [ ] 1.6 [backend] La extensión de historial usa el hogar del agente resuelto (`resolveDrakoncPiAgentHome`) en lugar de `~/.pi/agent` fijo (`extensions/history/index.ts:127`); verificar con prueba de que con `PI_CODING_AGENT_DIR` el historial se escribe en ese hogar y nunca en `~/.pi/agent`.
- [ ] 1.7 [backend] Las pruebas no escriben en el HOME real: `scripts/run-test-suite.mjs` ejecuta la suite con `HOME`/`USERPROFILE` temporales, y `tests/drakonc-shell.test.ts`, `tests/drakonc-agents.test.ts`, `tests/odd-phase-loader.test.ts`, `tests/request-context-append-only.test.ts` y `tests/todo-request-append-only.test.ts` usan un hogar temporal aunque se ejecuten sueltos; verificar ejecutándolos con un HOME trampa y comprobando que no aparece `.pi/agent/{agents,chains,drakonc-ai,drakonc-agents}`.
- [x] 1.3 [backend] Regenerar `runtime/` (`pnpm run build:runtime-modules`) y comprobar `pnpm run check:runtime-modules` y `pnpm typecheck`.
- [x] 1.4 [backend:ligero] Registrar las variables `GENTLE_*` como contrato del binario en `docs/brand-exceptions.md`; verificar que la entrada cita archivo y motivo.

## 2. Carpeta de configuración propia

- [x] 2.1 [backend] Hacer que todos los lectores de la carpeta de configuración (`scripts/pi-update.mjs`, políticas en `lib/`) usen la carpeta del hogar aislado en modo por defecto y no creen `~/.pi/drakonc-ai`; dejar intacta una existente; verificar con pruebas de instalación nueva y de carpeta heredada existente.
- [x] 2.2 [backend:ligero] Documentar en el README qué carpeta se usa, la existencia posible de `~/.pi/drakonc-ai` y `~/.gentle-ai` de versiones anteriores y cómo revisarlas sin borrarlas.

## 3. Fuentes centralizadas y transición de nombres

- [x] 3.1 [backend] Inventario exportado de fuentes de instalación y `scripts/check-install-sources.mjs` (sin dependencias) que valida pinning (incluida la excepción documentada de `pi install npm:gentle-pi` del binario) y que cada nombre `drakonc-*` figure en la sección "Publicados" de `docs/brand-exceptions.md` con propietario verificado y fecha; engancharlo a `pnpm test`; verificar con casos positivo y negativo.
- [x] 3.2 [backend] Detección dual `gentle-pi`/`drakonc-pi` en `lib/drakonc-shell-launcher.ts` (D6) solo para deduplicar y excluir, sin instalar `npm:drakonc-pi` mientras no esté publicado y con detección por ruta limitada a `packageRoot` o versión fijada; verificar con pruebas de nombre heredado sin duplicado y de que nunca se ejecuta `pi install npm:drakonc-pi` sin publicar.

## 4. Guía de publicación

- [ ] 4.1 [backend:ligero] Escribir `docs/publicar-paquetes.md` con las fases D5 y los requisitos D7 (2FA, trusted publishing, ramas protegidas, minisign para drakonc-ai; qué crear, verificación de propiedad con `npm view`/`git ls-remote`, constante a cambiar, entrada del registro, pruebas) y enlazarla desde el README; verificar que cada constante citada existe.

## 5. Verificación

- [ ] 5.1 [code-reviewer] Revisar el diff de este cambio.
- [ ] 5.2 [security] Modo `cambio` en paralelo con 5.1: entorno del binario, no escritura, inventario de fuentes; sin `CRÍTICA` ni `ALTA`.
- [ ] 5.3 [qa] Verificar los escenarios de `specs/companion-isolation` y `specs/package-distribution`; veredicto `APTO` y lo no verificado (binario real, Windows, macOS).

## Workflow follow-up

- Fases de publicación 1 a 5: las ejecuta el usuario siguiendo `docs/publicar-paquetes.md`; las fases 3 y 4 abren su propio cambio OpenSpec.
- Archivar con `/opsx:archive` cuando se cumplan los criterios.
