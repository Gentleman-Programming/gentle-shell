# Spec Delta

## Purpose

Permite vaciar la vista de la conversación de Drakonc Shell sin perder los mensajes de la sesión ni el contexto que el agente envía al modelo.

## ADDED Requirements

### Requirement: Limpiar la vista sin perder contexto
El comando `/drakonc:clear` SHALL dejar vacía la vista de la conversación, mostrando solo el encabezado, la barra y el prompt. Los mensajes de la sesión y el contexto enviado al modelo MUST quedar exactamente igual.

#### Scenario: Limpiar tras varios turnos
- **WHEN** el usuario ejecuta `/drakonc:clear` después de varios intercambios
- **THEN** la vista de la conversación queda vacía y el siguiente turno del agente recibe los mismos mensajes previos que habría recibido sin limpiar

#### Scenario: Sesión intacta
- **WHEN** se compara el archivo de sesión antes y después de `/drakonc:clear`
- **THEN** no se ha eliminado ni modificado ningún mensaje

### Requirement: Solo se muestra lo posterior
Tras limpiar, la vista SHALL mostrar únicamente los mensajes nuevos, hasta que el usuario reanude la sesión o vuelva a cargarla, momento en que puede verse el historial completo.

#### Scenario: Nuevo turno tras limpiar
- **WHEN** el usuario envía un mensaje después de `/drakonc:clear`
- **THEN** la vista muestra ese mensaje y la respuesta, sin los anteriores

#### Scenario: Reanudar la sesión
- **WHEN** el usuario reanuda la sesión con `/resume` o al reabrir Drakonc
- **THEN** el historial completo vuelve a estar visible

### Requirement: Aviso tras limpiar
Tras limpiar, el sistema SHALL mostrar un aviso breve en español que indique que el contexto se conserva y cómo volver a ver el historial.

#### Scenario: Aviso
- **WHEN** termina `/drakonc:clear`
- **THEN** aparece un aviso que menciona que el agente conserva el contexto

### Requirement: Descubrible
El comando SHALL aparecer en la paleta `/drakonc:commands` y en la documentación de comandos.

#### Scenario: Paleta
- **WHEN** el usuario abre `/drakonc:commands`
- **THEN** encuentra la entrada para limpiar la pantalla
