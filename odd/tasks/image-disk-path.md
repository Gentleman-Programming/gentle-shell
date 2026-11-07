# Pasted images: give the chips a disk path the agent can use

Estado: **implementado en esta rama**. Retención, limpieza, ubicación y
permisos resueltos (ver *Decisiones tomadas*); el código está en
`lib/image-disk-cache.ts`, cableado en `extensions/gentle-shell.ts` y cubierto
por `tests/image-disk-cache.test.ts` (14 tests). Lo que sigue abierto, sin
bloquear el merge, está en *Pendientes*.

Riesgo: **datos nuevos que persisten y no se reconstruyen**. Mitigado por:
opt-in apagado por defecto, directorio por sesión con `0700`/`0600`, borrado al
cerrar y barrido de restos.

## Specs

- S1: Tomado de `ISSUE-pasted-image-disk-path.md`: "Some agents/tools need a **filesystem path** (`file://` or absolute path) to process images" — modelos locales (Ollama, llama.cpp), OCR (tesseract, paddleocr), pipelines que esperan un path, tools que hacen multipart con file paths, y utilidades de CLI.
- S2: Hoy los bytes viven "**entirely in memory**" como base64 y "No file is ever written to disk". El chip `[Image#N]` sigue siendo la unidad atómica del draft (gentle-shell#2464): borrar el chip no lo manda, los chips presentes se adjuntan al enviar.
- S3: La ruta debe ser accesible para el agente sin romper el contrato de chips: `base64` sigue siendo la fuente de verdad del envío; el path es información adicional.
- S4: Nada de esto puede cambiar el comportamiento actual cuando la feature está apagada.

## Pendientes (no bloquean el merge)

1. **Exposición al agente (S3)**: hoy el path solo lo ve el usuario con
   `/gentle:images`; todavía no hay tool ni API que se lo entregue al modelo. La
   decisión de *no* inyectarlo en el prompt está tomada (ver *Decisiones tomadas*
   #3), pero cómo lo consume un agente queda por definir.
2. **Cobertura del cableado**: ningún test ejercita el cableado de la extensión
   (alta del cache en `session_start`, borrado en `session_shutdown`, salida de
   `/gentle:images`). Si eso se rompe, no hay test que lo detecte.
3. **Aviso de privacidad en la UI**: activar `GENTLE_PI_IMAGES_DISK_CACHE=session`
   deja imágenes pegadas en disco y hoy eso solo se explica en la ayuda del
   comando, no con una advertencia visible al activarlo.

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
2. **Activación**: apagada por defecto, opt-in por variable de entorno `GENTLE_PI_IMAGES_DISK_CACHE=session` (la extensión no lee un archivo de configuración para esto). Nadie persiste imágenes sin pedirlo.
3. **Exposición**: solo por comando (`/gentle:images`). El path **nunca** se inyecta en el prompt ni viaja al proveedor.
4. **Ubicación y permisos** (técnico): `${XDG_CACHE_HOME:-~/.cache}/gentle-shell/images/<session>/`, directorio `0700`, archivos `0600`. Un `XDG_CACHE_HOME` relativo se ignora y cae al fallback.
5. **Privacidad**: se acepta persistir la imagen solo con opt-in explícito y en
   un directorio privado por sesión; apagada por defecto, ninguna imagen toca el
   disco sin que el usuario lo pida.
6. **Multi-tenant / sesiones concurrentes**: directorio por sesión con id
   saneado (un `../../etc` cae dentro del root), `0700`/`0600`, y borrado
   limitado a la sesión propia.

## Hecho

- `lib/image-disk-cache.ts`: `ImageDiskCache` (`write`, `dispose`, `sweepStale` estático), `defaultCacheRoot()` con XDG, y saneamiento del id de sesión (un `../../etc` cae dentro del root). El barrido solo toca directorios que contienen archivos propios (`image-<id>.<ext>`), así que un root equivocado no puede borrar datos ajenos.
- `lib/image-attachments.ts`: constructor opcional `constructor(cache?: ImageDiskCache)`, campo `diskPath?` y `dispose()`. Sin cache el comportamiento es **idéntico** al anterior (los 9 tests de contrato y los 18 de chips siguen verdes).
- `tests/image-disk-cache.test.ts`: 14 tests (root XDG y fallback, XDG relativo ignorado, escape de sesión, bytes y permisos, extensión por mime, degradación sin disco, dispose aislado, barrido de sesiones viejas, barrido que respeta directorios ajenos, barrido que no sale del root, `setCache` en runtime, `cachedPaths` limitado al draft, chip usable sin path y contrato del adjunto en memoria).

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
- T4: S2 — tests: contrato, permisos, degradación y barrido seguro ✅ (14 nuevos)
- T5: S1 — documentar en la ayuda: el comando explica cómo se activa ✅

## Verificación

```
tsc --noEmit                      exit 0
tests/image-disk-cache.test.ts    14/14
tests/image-attachments.test.ts   9/9
tests/image-paste-chips.test.ts   18/18
runtime-harness (carga extensions/) exit 0
```

## Log

- L1: El usuario tenía un WIP en `lib/image-attachments.ts` (+59/−1) que rompía 8 tests de contrato. Detectado en la verificación de la rama.
- L2: "Aúnque me parece que el b es cuestionable y debíamos de darle trámite" → se diagnosticó (constructor requerido + call sites sin actualizar) y se revirtió con el parche preservado.
- L3: Decisión del usuario: "Revertir y abrir como trabajo propio" → esta ficha es el punto de partida.
