# Notifications: saved sounds library and Ctrl+S

Feature de la issue #1896 (Slice 2 reducida): biblioteca de sonidos propios persistida, guardado con `Ctrl+S`
desde el campo de ruta, y ciclo de `Enter` que la recorre. Autorizada por el usuario el 2026-10-08.

Alcance explícito: **sin volumen por sonido** y **sin tocar el esquema `gentle-shell.notifications/v1`**.

## Specs

S1. En el campo inline de ruta (`f`) de una fila de sonido, `Ctrl+S` guarda el sonido tecleado en la
biblioteca persistida, y esa biblioteca es lo que el ciclo de `Enter` recorre además de silencio y los tonos
incluidos. Requisito literal del usuario: «Lo que quiero es que aparezca ahí, si no le das ctrl + s no guardará
en el ciclo de enter» y «El uso de las notificaciones para comprobar si se guarda con ctr + s y con enter pueda
cambiar entre las demás .wav que guarde».

S2. El hint del campo inline muestra `Ctrl+S save` junto a `Enter confirm · Esc cancel`. El usuario lo señaló
sobre esa línea exacta de la captura: «Lo que quiero es que aparezca ahí».

S3. `Enter` en el campo sigue asignando el sonido a la fila **sin** agregarlo a la biblioteca.

S4. `Ctrl+S` guarda en la biblioteca **y** asigna el sonido a la fila (decisión de diseño, L3).

S5. La biblioteca vive en un archivo aparte (`notifications-sounds.json`) en el config home. `notifications.json`
y su esquema `/v1` no cambian (decisión de diseño, L2).

S6. La biblioteca sobrevive a cerrar y reabrir `/gentle:customize` y a reiniciar Pi; el ciclo de la fila la
recorre en cada apertura de la tarjeta.

S7. Ingreso a la biblioteca: solo rutas que pasan la misma validación y la misma política de path absoluto que
asignar; sin duplicados (comparación canónica, case-insensitive en Windows); tope de entradas; escritura
atómica `0600`; y si el archivo existente está ilegible o malformed se **rechaza** el guardado en vez de pisarlo.

S8. Un archivo de biblioteca ausente es una biblioteca vacía, sin crear archivo ni advertir.

## Tasks

| ID | Specs | Ruta | Commit |
| --- | --- | --- | --- |
| T1 | S5, S7, S8 | inline: `lib/notification-sounds.ts` + `tests/notification-sounds.test.ts` | `ebb9faea0` |
| T2 | S2 | inline: `lib/visual-customize-view.ts` + `tests/visual-customize-view.test.ts` | `c1e74ec6a` |
| T3 | S1, S3, S4, S6 | inline: `lib/notification-customize.ts` + `tests/notification-customize.test.ts` + docs (`docs/sound-notifications.md`, `README.md`, `docs/readme-reference.md`) | `7fe52d6d7` |
| T4 | S1-S8 | inline: focused + typecheck + comparación de fallos pre-existentes | este cierre |

## Log

L1 — Pedido original del usuario, literal: «Será que hacemos la issue que creamos en gentle-shell?». Alcance
elegido por el usuario en la ronda siguiente: **Solo Slice 1** («Actualizar el checkout a main, rama propia,
ciclo de Enter que no pierda el file: + las 2 filas de timing, con RED primero. Commits locales, sin push.»).
Esa Slice 1 quedó entregada en `ade003126` y verificada manualmente por el usuario («Funciona bien, ya le di
enter y el ciclo funciona»).

L2 — Corrección de alcance y decisión de persistencia. El usuario pidió lo que el issue llama Slice 2 sin
volumen: «Lo que quiero es que aparezca ahí, si no le das ctrl + s no guardará en el ciclo de enter». El
bloqueante declarado por el issue sigue vigente: `lib/notification-policy.ts` valida las claves de `audio` de
forma exacta (`keysMatch(audio, ["backend","minimumIntervalMs","coalesceWindowMs","events"])`) y
`NotificationSound` es un escalar, así que cualquier clave nueva hace que una build que no la conozca clasifique
la config como malformed y ofrezca *"Replace invalid audio configuration?"*. Decisión: la biblioteca vive en un
**archivo aparte** `notifications-sounds.json` (schema `gentle-shell.notification-sounds/v1`), de modo que
`notifications.json` sigue siendo `/v1` intacto y ninguna build vieja ve la clave nueva. La propuesta del issue
(`audio.sounds` dentro del esquema con `/v2`) queda para la decisión del maintainer; migrar desde el archivo
aparte es un cambio acotado.

L3 — Decisiones de diseño de la biblioteca (revisables): (1) `Ctrl+S` guarda **y asigna**, porque el sonido
recién tecleado es el que el usuario quiere usar; (2) entradas como objetos `{ "path": "..." }` para poder
agregar metadatos después sin romper el archivo; (3) tope de 8 entradas para que el ciclo de `Enter` siga siendo
recorrible; (4) el hint `Ctrl+S save` aparece solo en el campo que ofrece guardar, nunca en filas que no lo
hacen; (5) una biblioteca ilegible bloquea el guardado con aviso, no se sobrescribe en silencio.

L4 — Evidencia de partida (medida antes de escribir): el entorno de reproducción del usuario funciona; la ruta
real de producción (`NotificationPlayer.play` con el host fijo de Windows) reprodujo los tres tonos incluidos
(`resolved OK`, `permit=true`, ~1,3 s cada uno). `matchesKey(data, "ctrl+s")` acepta `\x13` y la secuencia kitty
`\x1b[115;5u`, y `Key.ctrlS` no existe en pi-tui, así que el atajo se escribe como la cadena `"ctrl+s"`.

L5 — Commit `9c1a0772a` (doc), `ebb9faea0` (T1), `c1e74ec6a` (T2), `7fe52d6d7` (T3). RED observado en cada
unidad antes de escribir fuente: T1 con el módulo ausente (`ERR_MODULE_NOT_FOUND`), T2 con 3 fallos en el view,
T3 con 7 fallos en la tarjeta (el octavo caso, «Enter assigns without adding it to the library», ya pasaba y
queda como guarda).

L6 — Bug real que encontró el test del ciclo, no una preferencia: con la biblioteca insertada *después* de la
memoria de la fila (`[owned, current, ...saved]`), al pasar por un sonido guardado la fila adoptaba ese archivo
como «propio» y el orden pasaba a `[null, s, e, a, error.wav, success.wav]`, así que el último guardado saltaba
al primero y nunca se llegaba a silencio. Corregido a `[...saved, owned, current]`: la lista guardada primero y
lo no guardado al final. El ciclo de la Slice 1 (un archivo no guardado) no cambia de comportamiento.

L7 — Verificación (Windows, node 22.23.0): `tests/notification-sounds.test.ts` 9/9; `tests/visual-customize-view.test.ts`
42/42; `tests/notification-customize.test.ts` 50 tests con un solo fallo, el pre-existente `f opens an inline
field ...`; grupo notification completo 24 fallos / 170 pass / 194 tests contra 24 / 146 / 170 antes del feature,
con los 23 fallos en archivos que este cambio no toca más ese caso conocido, y los 20 tests nuevos en verde;
`pnpm run typecheck` 186 diagnósticos registrados sin regresiones.

L8 — Pendiente y fuera de alcance declarado: el volumen por sonido y el traslado de la biblioteca a
`audio.sounds` con esquema `/v2` siguen sin decidir; la pregunta abierta del grupo mixto (hoy `Enter` sobre un
tipo mixto aplica el tono recomendado y descarta las excepciones por evento) sigue igual. Sin push ni PR: el
parche se aplicó al checkout instalado solo para la prueba manual del usuario.
