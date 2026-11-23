# Design

## Context

Ver `proposal.md`. Hechos verificados:

- `lib/drakonc-ai-binary.ts` construye el entorno del binario con `DRAKONC_AI_HOME`, `DRAKONC_AI_PI_CONFIG_DIR`, `DRAKONC_AI_ENGRAM_BIN`, `DRAKONC_AI_NO_SELF_UPDATE` y `DRAKONC_PI_CONFIG_HOME`; en `HEAD` (`lib/gentle-ai-binary.ts`) eran `GENTLE_AI_*` y `GENTLE_PI_CONFIG_HOME`.
- El grupo 0 de `completar-identidad-drakonc-shell` restauró las descargas al `gentle-ai` 5.0.0 original (checksums sin cambios). Ese binario se identifica como `gentle-ai` y solo lee `GENTLE_*`.
- `bin/drakonc-shell.mjs` `buildSetupEnv` aplica `drakoncAiIsolationEnv`; `lib/drakonc-shell-bundled.ts` documenta el mismo par para instalaciones con prefijo.
- Manifiesto de la copia de `gentle-ai` (`~/.gentle-ai/backups/20261122215432…/manifest.json`): creó `~/.drakonc-shell/agent/{APPEND_SYSTEM.md,mcp.json}`, modificó `~/.drakonc-shell/agent/settings.json`, creó `~/.gentle-ai/pi-codegraph-*.json` y `~/.pi/gentle-ai/persona.json`.
- La configuración por defecto de Drakonc es `~/.pi/drakonc-ai` (`scripts/pi-update.mjs:153`, comentarios en `lib/background-subagents-policy.ts`, `lib/double-esc-cancel-policy.ts`), heredada de `~/.pi/gentle-ai`. Ya existe `~/.pi/drakonc-ai` (creada 2026-11-22 14:26).
- `docs/brand-exceptions.md` registra cada fuente heredada con su comprobación.

## Goals / Non-Goals

**Goals:** cerrar ya la fuga de escrituras; preparar el código para pasar de nombres heredados a propios sin tocar lógica; dar al usuario una guía accionable.

**Non-Goals:** bifurcar o recompilar `gentle-ai` y `gentle-engram` en este cambio; publicar nada.

## Decisions

### D1. Doble juego de variables según el binario
Hallazgo `security` S1 (ALTA): en el modo aislado por defecto, `standaloneDrakoncAiEnv` (`lib/drakonc-ai-binary.ts:137-145`, igual en `HEAD`) solo emite `*_PI_CONFIG_DIR` y `*_PI_CONFIG_HOME`; nunca `*_AI_HOME` ni `*_NO_SELF_UPDATE`. Por eso el modo aislado también emitirá `*_AI_HOME` y `*_NO_SELF_UPDATE=1` en **todos** los modos (empaquetado, aislado y `--link`), lo que también cierra S2 (autoactualización desde releases ajenas que invalidaría el SHA-256 fijado). Implementado: `GENTLE_AI_HOME`/`DRAKONC_AI_HOME` llevan el valor que el usuario haya definido (`DRAKONC_AI_HOME` primero) o, si no hay ninguno, `<prefijo>/drakonc-ai` en empaquetado y `~/.drakonc-shell/drakonc-ai-home` fuera de él; nunca una carpeta de `~/.gentle-ai`, `~/.pi` ni `~/.gentle-shell`.

Carpetas hijas (S4): el binario original añade `gentle-ai` a `GENTLE_PI_CONFIG_HOME`, mientras drakonc-pi lee `<padre>/drakonc-ai` y la condición `basename === "drakonc-ai"` desactiva el padre. Se define explícitamente: `GENTLE_AI_PI_CONFIG_DIR` y `DRAKONC_AI_PI_CONFIG_DIR` apuntan a la carpeta que lee drakonc-pi, y `DRAKONC_PI_CONFIG_HOME` se emite solo si esa carpeta se llama `drakonc-ai` (como hoy) y `GENTLE_PI_CONFIG_HOME` se fija siempre al padre de esa carpeta (empaquetado: `<prefijo>/config`; aislado: `~/.drakonc-shell`), de modo que una escritura de respaldo del binario quede contenida en `<padre>/gentle-ai`. La política de subagentes la escribe con prioridad `GENTLE_AI_PI_CONFIG_DIR`, que es la carpeta que lee drakonc-pi. D2 comprueba que escritura y lectura coinciden.

Persona (S3): `sharedPersonaPath` (`bin/drakonc-shell.mjs:1035-1036`) protege `~/.pi/drakonc-ai/persona.json`, pero el binario original escribe `~/.pi/gentle-ai/persona.json`; mientras el binario sea `gentle-ai`, la copia y restauración cubren ambas rutas, y lo mismo en `state.json` (`~/.drakonc-ai` y `~/.gentle-ai`). Las rutas viven en `lib/drakonc-ai-binary.ts` (`drakoncAiPersonaSnapshotPaths`, `sharedDrakoncAiPersonaPaths`, `sharedDrakoncAiStatePaths`) para poder probarlas sin ejecutar el launcher.

`drakoncAiEnv` emite ambos juegos (`GENTLE_*` y `DRAKONC_*`) según lo anterior. Es más simple y robusto que detectar la identidad del binario, y no tiene efecto en un binario que no las lee. Cuando exista `drakonc-ai` propio que solo lea `DRAKONC_*`, el juego `GENTLE_*` se retira con su propia tarea. Las variables solo van a los procesos del binario, nunca a Pi (como hoy).

- Alternativa descartada: volver solo a `GENTLE_*`. Rompería un futuro binario propio.
- Alternativa descartada: detectar la versión del binario (`--version`). Añade una ejecución y un punto de fallo.

### D2. Prueba de no escritura con HOME temporal
Prueba de integración que ejecuta la configuración inicial con un binario simulado que escribe en las rutas de las variables recibidas o, si no recibe ninguna, en las rutas por defecto de `gentle-ai`, sobre un `HOME` temporal con `~/.pi`, `~/.gentle-ai` y `~/.gentle-shell` sembrados; compara el árbol antes y después. No usa red ni el binario real.

### D3. Carpeta de configuración propia
En modo aislado por defecto el launcher ya pasa una carpeta propia del hogar (`standaloneConfigHome`); se revisa que todos los lectores (`scripts/pi-update.mjs`, políticas en `lib/`) usen esa carpeta y no caigan en `~/.pi/drakonc-ai`. `~/.pi/drakonc-ai` existente se deja intacta; se documenta en el README cómo comprobar cuál se usa. No se migra.

### D4. Fuentes centralizadas y comprobación
Las fuentes de instalación (`ENGRAM_COMPANION_SOURCE`, el paquete Pi de la Shell, `DRAKONC_STREAM_SPEC`, URLs de descarga del binario) se listan en un único inventario exportado con su forma fijada. Un script `scripts/check-install-sources.mjs` (sin dependencias) valida el pinning y que cada nombre `drakonc-*` esté marcado como publicado en `docs/brand-exceptions.md` (sección "Publicados"). Se engancha a `pnpm test`. El inventario incluye `pi install npm:gentle-pi` que ejecuta el binario sin versión (`bin/drakonc-shell.mjs:1004`, S5) como excepción documentada o fijada. Cada entrada de "Publicados" registra propietario verificado (`npm view <pkg> maintainers repository`) y fecha (S7).

### D5. Fases de publicación
Orden por dependencia y esfuerzo: (1) repo `drakonc-shell` en GitHub; (2) `drakonc-pi` por git fijado a SHA o npm; (3) `drakonc-engram`; (4) `drakonc-ai` con releases y checksums; (5) `drakonc-stream` opcional. Cada fase en `docs/publicar-paquetes.md` con: qué crea el usuario, verificación de propiedad, constante a cambiar, entrada del registro y pruebas. Las fases 3 y 4 requieren un cambio OpenSpec propio cuando el usuario las emprenda.

### D6. Detección dual del paquete Pi
`settingsDeclareDrakoncPi`/`findDrakoncPiDeclaration` aceptan `gentle-pi` y `drakonc-pi` durante la transición, solo para deduplicar y excluir (S6): nunca provocan `pi install npm:drakonc-pi` hasta que D4 lo marque como publicado, y la detección por ruta exige que la carpeta sea `packageRoot` o tenga versión fijada.

### D7. Requisitos de la guía de publicación
Comprobar y reservar pronto el nombre en npm; 2FA en modo `auth-and-writes`; trusted publishing de npm (OIDC) con `--provenance`, como `publish.yml` ya usa (líneas 21 y 236), sin `NPM_TOKEN` de larga duración; rama y entorno de publicación protegidos; para `drakonc-ai`, `checksums.txt` firmado con minisign propio y clave pública fijada en el código; no publicar `drakonc-*` antes de cambiar sus constantes.

## Seguridad

- Amenaza: el binario companion escribe o se autoactualiza fuera del control del launcher. Control: D1 con `GENTLE_AI_NO_SELF_UPDATE=1` y rutas propias; prueba D2.
- Amenaza: cadena de suministro con nombres `drakonc-*` no publicados. Control: D4.
- Amenaza: confusión entre paquete heredado y propio que duplique código con acceso a credenciales. Control: D6 y prueba de no duplicación.

## Risks / Trade-offs

- [El binario `gentle-ai` cambia de variables en otra versión] → La versión está fijada por checksum; la prueba D2 usa el contrato actual y la guía advierte revisar al subir de versión.
- [Pasar variables `GENTLE_*` mantiene nombres heredados] → Se registran en `docs/brand-exceptions.md` como contrato del binario.
- [Usuarios con `~/.pi/drakonc-ai` existente] → No se toca; se documenta.

## Migration Plan

Sin migración. Tras el cambio, un usuario que ya ejecutó el arranque conserva lo escrito en `~/.gentle-ai` (no se borra); el README indica qué archivos crea la versión anterior por si quiere revisarlos.

## Open Questions

- Resuelta (2026-11-22): GitHub `drakonc` (repo `github.com/drakonc/drakonc-shell` ya existe y es público; los nuevos se crean públicos en esa cuenta) y npm `drakonc` (sesión iniciada; 2FA activa en modo auth-and-writes). Las referencias a `Drakoncman-Programming/*` del código deben pasar a `drakonc/*` en la fase 1.
