# Design

## Context

Ver `proposal.md`. La API de extensiones de Pi 1.6.0 no ofrece una operación para vaciar el chat (`ctx.ui` expone `notify`, `custom`, `setWidget`, `setHeader`, `setFooter`, `setEditorComponent`, etc.). Drakonc controla la pantalla completa mediante `lib/native-fullscreen-interaction.ts`, `lib/shell-page.ts` y `extensions/drakonc-shell.ts` (por ejemplo ~2335: el layout de pantalla completa accede a `tui.mode` y `tui.terminal`). Las teclas por defecto ya ocupan `ctrl+l` (selector de modelos) y `ctrl+c` (limpiar editor / salir).

## Goals / Non-Goals

**Goals:** vaciar la vista sin tocar la sesión; implementación mínima apoyada en lo que Drakonc ya controla del render.

**Non-Goals:** cambiar la API de Pi, borrar mensajes, compactar.

## Decisions

### D1. Investigar antes de elegir mecanismo
Primera tarea: localizar cómo se pinta la lista de mensajes en modo pantalla completa e inline (contenedor de chat de Pi y lo que Drakonc envuelve) y elegir, por este orden de preferencia:
1. Un mecanismo existente del contenedor (por ejemplo vaciar sus hijos visibles o un desplazamiento del inicio de la vista) accesible desde la extensión sin parches frágiles.
2. Un marcador de "inicio de vista" mantenido por Drakonc, de forma que el render de pantalla completa omite lo anterior al marcador.
3. Si ninguno es viable sin modificar Pi, detener la implementación e informar con alternativas.

El mecanismo nunca modifica `sessionManager` ni las entradas de sesión, y el hook `context` no se toca.

### D2. Sin atajo por defecto
Solo el comando. Se puede asignar un atajo propio desde la sección de atajos de `/drakonc:customize` si el sistema de keymaps lo admite para este comando.

## Risks / Trade-offs

- [Pi no expone el contenedor] → D1.3: se informa y se replantea.
- [El modo inline deja el historial en el scrollback de la terminal] → en inline se limpia la región que Drakonc controla y se documenta la diferencia.

## Open Questions

- Mecanismo concreto (D1), a resolver con la primera tarea sin cambiar specs ni alcance.
