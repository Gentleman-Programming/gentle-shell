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

## Falta (bloqueado por anclas, no por diseño)

- Construir el cache en el arranque de la extensión con el id de sesión real, leyendo `images.diskCache`.
- Registrar `/gentle:images`, que lista los paths de la sesión actual (el handler puede cerrar sobre `imageAttachments` si se declara junto a los otros `registerCommand`).
- Llamar `imageAttachments.dispose()` en el cierre de sesión y ejecutar el barrido al arrancar.
- Las anclas para hacerlo: import de `resolveDoubleEscCancelPolicy` en `extensions/gentle-shell.ts` (patrón de config por resolver), `pi.registerCommand(<NAME>, { description, handler })` cerca de la línea 2022, y el hook de cierre de sesión (por localizar).

## Tasks (todas pendientes)

- T1: S1/S4 — decidir retención y limpieza (las 6 decisiones abiertas) y dejarlas escritas acá.
- T2: S3 — agregar `diskPath` **opcional** sin tocar el contrato de chips; `base64` sigue siendo la fuente de envío.
- T3: S1 — cablear el call site de producción con el id de sesión real, con camino sin-sesión seguro.
- T4: S2 — tests: el chip conserva su contrato; el path existe, es legible y tiene permisos correctos; sin directorio escribible la feature degrada y no rompe.
- T5: S1 — documentar la feature en la ayuda/README de donde se descubre.

## Log

- L1: El usuario tenía un WIP en `lib/image-attachments.ts` (+59/−1) que rompía 8 tests de contrato. Detectado en la verificación de la rama.
- L2: "Aúnque me parece que el b es cuestionable y debíamos de darle trámite" → se diagnosticó (constructor requerido + call sites sin actualizar) y se revirtió con el parche preservado.
- L3: Decisión del usuario: "Revertir y abrir como trabajo propio" → esta ficha es el punto de partida.
