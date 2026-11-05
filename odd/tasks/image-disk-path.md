# Pasted images: give the chips a disk path the agent can use

Estado: **spec abierta**. No hay implementación en esta rama: el intento anterior
se revirtió (ver *Intento descartado*). Las decisiones de retención y limpieza son
requisito previo al código.

Riesgo: **ítem 1** (datos nuevos que persisten y no se reconstruyen). Requiere
decisión explícita de retención antes del primer write.

## Specs

- S1: Tomado de `ISSUE-pasted-image-disk-path.md`: "Some agents/tools need a **filesystem path** (`file://` or absolute path) to process images" — modelos locales (Ollama, llama.cpp), OCR (tesseract, paddleocr), pipelines que esperan un path, tools que hacen multipart con file paths, y utilidades de CLI.
- S2: Hoy los bytes viven "**entirely in memory**" como base64 y "No file is ever written to disk". El chip `[Image#N]` sigue siendo la unidad atómica del draft (gentle-shell#2464): borrar el chip no lo manda, los chips presentes se adjuntan al enviar.
- S3: La ruta debe ser accesible para el agente sin romper el contrato de chips: `base64` sigue siendo la fuente de verdad del envío; el path es información adicional.
- S4: Nada de esto puede cambiar el comportamiento actual cuando la feature está apagada.

## Decisiones abiertas (bloqueantes)

1. **Retención**: ¿cuánto vive el archivo? ¿Se borra al enviar el draft, al cerrar la sesión, al hacer GC del historial, o nunca?
2. **Limpieza**: ¿quién la ejecuta — `dispose()` de la sesión, un barrido al arrancar, o el mismo GC del historial (`history-gc`)?
3. **Ubicación**: ¿`$XDG_CACHE_HOME/gentle-shell/images/<session>/`? ¿Qué pasa si no hay `XDG_CACHE_HOME` (fallback a `~/.cache`)?
4. **Exposición al modelo**: ¿el path viaja en el mensaje del usuario, en metadatos del tool, o solo queda disponible para que un tool lo lea?
5. **Privacidad**: una imagen pegada puede contener datos sensibles. Persistirla en disco es una decisión de seguridad, no un detalle de implementación.
6. **Multi-tenant / sesiones concurrentes**: el directorio debe ser por sesión y con permisos `0700`, archivos `0600`.

## Intento descartado (2026-11-05)

Se escribió un parche de 113 líneas (`/tmp/gs-wip/image-disk-path.patch`, fuera del
repo) que:

- agregaba `diskPath?: string` a `ImageAttachment`;
- cacheaba en disco con `mode 0o600` en un directorio `0o700`;
- cambiaba el constructor a **`constructor(sessionId: string)` — requerido**.

**Por qué se revirtió**: los 9 call sites seguían llamando `new ImageAttachments()`
sin argumentos, incluido el de producción (`extensions/gentle-shell.ts:2035`), así
que `sessionId` llegaba `undefined` y `resolveCacheDir(undefined)` armaba una ruta
basura. El resultado eran 8 tests de contrato en rojo (`image-attachments`), no por
un cambio deliberado del contrato sino por el cableado faltante.

Evidencia de la reversión: `tests/image-attachments.test.ts` 9/9 y
`tests/image-paste-chips.test.ts` 18/18 en verde después de revertir.

## Decisiones tomadas (2026-11-05)

1. **Retención**: la vida de la sesión. El directorio se borra en el cierre; un barrido al arrancar limpia restos de sesiones que crashearon (más de 7 días).
2. **Activación**: apagada por defecto, opt-in por configuración (`images.diskCache: off | session`). Nadie persiste imágenes sin pedirlo.
3. **Exposición**: solo por comando (`/gentle:images`). El path **nunca** se inyecta en el prompt ni viaja al proveedor.
4. **Ubicación y permisos** (técnico): `${XDG_CACHE_HOME:-~/.cache}/gentle-shell/images/<session>/`, directorio `0700`, archivos `0600`.

## Hecho

- `lib/image-disk-cache.ts`: `ImageDiskCache` (`write`, `dispose`, `sweepStale` estático), `defaultCacheRoot()` con XDG, y saneamiento del id de sesión (un `../../etc` cae dentro del root). El barrido solo toca directorios que contienen archivos propios (`image-<id>.<ext>`), así que un root equivocado no puede borrar datos ajenos.
- `lib/image-attachments.ts`: constructor opcional `constructor(cache?: ImageDiskCache)`, campo `diskPath?` y `dispose()`. Sin cache el comportamiento es **idéntico** al anterior (los 9 tests de contrato y los 18 de chips siguen verdes).
- `tests/image-disk-cache.test.ts`: 9 tests (root XDG, escape de sesión, bytes y permisos, extensión por mime, degradación sin disco, dispose aislado, barrido, barrido seguro, contrato de la clase).

## Cableado (hecho)

- `GENTLE_PI_IMAGES_DISK_CACHE=session` activa el cache; cualquier otro valor lo deja apagado (default).
- En `session_start` se barre lo viejo (>7 días) y se construye el cache con `ctx.sessionManager.getSessionId()`.
- En `session_shutdown` se suelta el cache y se borra el directorio de la sesión.
- `/gentle:images` lista `[Image#N] <path>` del draft actual; si el cache está apagado, lo explica en vez de fallar.
- El path nunca se inyecta en el prompt: el envío sigue usando `base64`.

## Tasks

- T1: S1/S4 — decisiones de retención y limpieza ✅
- T2: S3 — `diskPath` opcional y contrato de chips intacto ✅
- T3: S1 — cableado del call site con id de sesión real ✅
- T4: S2 — tests: contrato, permisos, degradación y barrido seguro ✅ (9 nuevos)
- T5: S1 — documentar en la ayuda: el comando explica cómo se activa ✅

## Verificación

```
tsc --noEmit                      exit 0
tests/image-disk-cache.test.ts    9/9
tests/image-attachments.test.ts   9/9
tests/image-paste-chips.test.ts   18/18
runtime-harness (carga extensions/) exit 0
```

## Log

- L1: El usuario tenía un WIP en `lib/image-attachments.ts` (+59/−1) que rompía 8 tests de contrato. Detectado en la verificación de la rama.
- L2: "Aúnque me parece que el b es cuestionable y debíamos de darle trámite" → se diagnosticó (constructor requerido + call sites sin actualizar) y se revirtió con el parche preservado.
- L3: Decisión del usuario: "Revertir y abrir como trabajo propio" → esta ficha es el punto de partida.
