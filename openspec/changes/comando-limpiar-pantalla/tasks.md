# Tasks

> Sin agentes locales `frontend`/`backend`: se implementa en consolas Pi (preferencia del usuario).

## 1. Investigación y mecanismo

- [ ] 1.1 [frontend] Localizar cómo se pinta la conversación en pantalla completa e inline (contenedor de chat de Pi en `node_modules/@earendil-works/pi-coding-agent` y lo que envuelven `extensions/drakonc-shell.ts`, `lib/native-fullscreen-interaction.ts`, `lib/shell-page.ts`) y elegir el mecanismo según D1; verificar con un informe que cite archivo:línea y explique por qué no toca la sesión. Si no hay mecanismo viable, detenerse e informar.

## 2. Comando

- [ ] 2.1 [frontend] Registrar `/drakonc:clear` con el mecanismo elegido y el aviso en español; verificar con pruebas que la vista queda vacía, que los mensajes de la sesión y lo enviado al modelo no cambian, y que un turno posterior se muestra solo.
- [ ] 2.2 [frontend:ligero] Añadir la entrada a `lib/command-palette-catalog.ts` y a `docs/readme-reference.md`; verificar con `tests/command-palette.test.ts`.

## 3. Verificación

- [ ] 3.1 [code-reviewer] Revisar el diff.
- [ ] 3.2 [qa] Verificar los escenarios de `specs/session-view-clear`, incluida una prueba real en una terminal herdr (pantalla completa) y la reanudación de la sesión.
