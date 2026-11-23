# Design

## Context

Ver `proposal.md`. Hechos verificados:

- `gentle-opencode-go@0.1.2` (instalado en `~/.gentle-shell/agent/npm/node_modules/gentle-opencode-go`, MIT, autor Jesús Rosales) contiene `src/extension.ts` (28 líneas: registra en `session_start`) y `src/usage.ts` (135 líneas: `parseOpenCodeGoUsage`, `reportsLimitReached`, `fetchOpenCodeGoUsage` contra `https://opencode.ai/zen/go/v1/usage` con `redirect: "error"`). El tarball no incluye las pruebas (`test/` no está en `files`).
- `package.json` declara `"pi": { "extensions": ["./src/extension.ts"] }`, `peerDependencies` `@earendil-works/pi-coding-agent: "*"` y solo usa `import type` de ese paquete.
- `npm view drakonc-opencode-go` devuelve 404: el nombre está libre.
- Pi admite `pi install ./ruta`, `git:github.com/usuario/repo@v1` y fija etiquetas y commits (`docs/packages.md` de pi-coding-agent 1.6.0). `drakonc-shell install …` pasa el subcomando a Pi en el hogar de Drakonc (`PI_SUBCOMMANDS` en `lib/drakonc-shell-launcher.ts`).
- En Drakonc, `lib/shell-usage.ts` expone `OPENCODE_USAGE_SOURCE_PACKAGE = "npm:gentle-opencode-go@0.1.2"` y `usageSourceHint(provider)`; el panel ya oculta la guía si hay fuente registrada o si el último refresco falló (implementado en el grupo 1 de `completar-identidad-drakonc-shell`).

## Goals / Non-Goals

**Goals:**
- Paquete mínimo derivado del original, con el contrato propio y pruebas sin dependencias instaladas.
- Que el panel de Drakonc recomiende el paquete propio con una referencia fija.

**Non-Goals:**
- Reescribir la lógica de lectura ni añadir métricas, cachés o configuración.

## Decisions

### D1. Derivar del tarball 0.1.2 instalado
Se copia el código exacto de `0.1.2` (el que ya funciona en Gentle Shell) en lugar de clonar el repositorio remoto, para no depender de red ni de cambios posteriores del autor. Se cambian solo el evento, el esquema, los comentarios que nombran Gentle y `/gentle:usage`, y el manejo de errores: toda la llamada `fetchFn(...)` y la lectura del cuerpo van dentro de un `try/catch` que devuelve `undefined` sin volver a lanzar (revisión `security`, S3: undici puede incluir el valor de la cabecera en algunos errores). Opcionalmente se rechaza una `content-length` mayor de 64 KB (S5).

- Alternativa: clonar `github.com/jesusrosales17/gentle-opencode-go` en su etiqueta para recuperar las pruebas originales. Descartada como base; las pruebas se escriben nuevas según la spec.

### D2. Solo el contrato propio
El paquete emite únicamente `drakonc-pi:usage-source/v1`. Emitir también el heredado no aporta nada (Drakonc acepta ambos y Gentle Shell ya tiene su paquete) y duplicaría el registro.

### D3. Pruebas sin instalar dependencias
`test/*.test.ts` con `node --experimental-strip-types --test`, usando un `fetchFn` simulado y un `pi` simulado con `events.emit` y `on`. Como el paquete solo hace `import type` de Pi, no hace falta instalar nada para ejecutar las pruebas. `typescript` y `@earendil-works/pi-coding-agent` quedan declarados como `devDependencies`/`peerDependencies` igual que el original, pero no se instalan sin aprobación; la comprobación de tipos con `tsc` se reporta como no verificada si no está disponible.

### D4. Repositorio aparte
`~/Desarrollo/FullStack/drakonc/drakonc-opencode-go` con `git init` local (sin remoto ni push). Archivos: `package.json` (`name: drakonc-opencode-go`, `version: 0.1.0`, `keywords` con `pi-package` y `drakonc-shell`, `repository` pendiente), `src/`, `test/`, `README.md`, `LICENSE` (aviso original + el del usuario), `CHANGELOG.md`.

### D5. Recomendación en Drakonc
`OPENCODE_USAGE_SOURCE_PACKAGE` pasa a `git:github.com/<propietario>/drakonc-opencode-go@<sha40>`: una etiqueta se puede mover y Pi reconcilia el clon a ella, mientras que un commit SHA no cambia (revisión `security`, S1). La etiqueta `v0.1.0` queda solo como referencia legible en el README, que documenta el SHA. Nunca se recomienda `npm:` porque el nombre está libre y cualquiera podría publicarlo (S2). Mientras el usuario no confirme remoto y SHA, la guía del panel no muestra comando de instalación y remite a la documentación; nunca se publica un marcador sin resolver. La instalación desde carpeta local se documenta solo para desarrollo, porque carga el árbol de trabajo en vivo (S6). La línea de aviso de terceros cambia a "receives your OpenCode Go key" sin mencionar terceros, porque el paquete es del usuario. `docs/brand-exceptions.md` mantiene `gentle-opencode-go` solo como paquete compatible por el alias.

### D6. Coordinación con el cambio en curso
`lib/shell-usage.ts` y `docs/drakonc-shell.md` también los toca `completar-identidad-drakonc-shell` (grupos 1, 2 y 5). Este cambio se implementa después de que ese cambio cierre el grupo 2 (glifos en `lib/shell-usage.ts`), o en la sesión principal sin consolas en paralelo sobre esos archivos.

## Seguridad

- Amenaza: fuga de la clave hacia otro origen. Control: origen fijo, `redirect: "error"`, sin logs; prueba de redirección.
- Amenaza: payload malicioso o inesperado. Control: validación campo a campo, ventanas inválidas omitidas, cuerpo no JSON devuelve `undefined` sin propagar el contenido.
- Amenaza: suplantación del paquete al instalar en otras máquinas. Control: referencia git con etiqueta fija; el nombre npm libre no se usa en la recomendación mientras no se publique.
- Amenaza: el paquete registra otro proveedor. Control: proveedor constante `opencode-go`; Drakonc ya rechaza proveedores integrados.
- Amenaza: scripts de ciclo de vida al instalar desde git (S4). Control: manifiesto sin `dependencies` ni `prepare`/`install`/`postinstall`, con prueba estática.
- Riesgo residual documentado: cualquier extensión cargada puede registrar `opencode-go` y gana el último registro (`lib/shell-usage.ts`), así que recibiría la clave; con dos paquetes instalados también gana el último. Se documenta en el README de ambos proyectos.

## Risks / Trade-offs

- [Cambios futuros del endpoint no documentado de OpenCode] → La lectura devuelve `undefined` y Drakonc muestra la nota de fallo; se revisa al detectar.
- [Divergencia con el original] → El README indica la versión de origen (`0.1.2`) para comparar.
- [Sin `tsc` instalado] → Se ejecutan pruebas con strip-types; la comprobación de tipos queda como no verificada o se usa el `tsc` del repositorio drakonc-shell si está disponible.

## Migration Plan

Quien use `gentle-opencode-go` puede seguir usándolo; para cambiar al propio: `drakonc-shell remove npm:gentle-opencode-go` y `drakonc-shell install <ruta o git@v0.1.0>`. Tener ambos instalados registra la misma fuente dos veces y gana la última; el README recomienda dejar solo uno.

## Open Questions

- Propietario y URL del remoto git (`github.com/<propietario>/drakonc-opencode-go`); hasta confirmarlos, la guía del panel usa la instalación desde carpeta local.
