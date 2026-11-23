# Proposal

## Why

El usuario quiere vaciar la vista de la conversación en Drakonc Shell sin perder el contexto del agente, como un "limpiar pantalla" de terminal. Hoy no hay comando para eso: Pi solo ofrece `ctrl+c` para limpiar el editor, y su API de extensiones no expone ninguna operación para vaciar el chat visible. A diferencia de `/clear` de Claude Code, que inicia una conversación nueva, aquí el agente debe conservar todo lo hablado.

## What Changes

- Nuevo comando `/drakonc:clear` que deja la vista de la conversación vacía, con solo el encabezado y el prompt, sin modificar los mensajes de la sesión ni el contexto que recibe el modelo.
- Un aviso breve tras limpiar indica que el contexto se conserva y cómo volver a ver el historial.
- El comando aparece en la paleta `/drakonc:commands` y en la ayuda.

## Capabilities

### New Capabilities

- `session-view-clear`: limpieza de la vista de la conversación sin alterar la sesión ni el contexto del modelo.

### Modified Capabilities

Ninguna.

## Out of scope

- Borrar mensajes, compactar o iniciar una sesión nueva (para eso ya existen `/new` y la compactación de Pi).
- Cambiar el estilo del cuadro de entrada (pospuesto por el usuario).
- Atajo de teclado por defecto: se valora en el diseño, pero no se asigna uno que choque con los existentes (`ctrl+l` ya abre el selector de modelos).

## Seguridad

No toca autenticación, datos personales, secretos, entradas externas ni dependencias. No requiere revisión de diseño de `security`.

## Impact

- `extensions/drakonc-shell.ts` (registro del comando y vista), módulo de render del chat en pantalla completa (por determinar en la investigación), `lib/command-palette-catalog.ts`, `docs/readme-reference.md`, pruebas asociadas.
