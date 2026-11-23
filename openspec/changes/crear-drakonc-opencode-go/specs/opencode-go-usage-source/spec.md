# Spec Delta

## Purpose

Define el paquete `drakonc-opencode-go`, que obtiene las ventanas de uso de la suscripción OpenCode Go y las registra en Drakonc Shell para la barra de estado y el panel `/drakonc:usage`.

## ADDED Requirements

### Requirement: Registro con el contrato de Drakonc
Al iniciar cada sesión, el paquete SHALL registrar una fuente de uso para el proveedor `opencode-go` emitiendo `drakonc-pi:usage-source/v1` con esquema `drakonc-pi.usage-source/v1`, una nota pendiente y su función de lectura. MUST NOT emitir el evento heredado `gentle-pi:usage-source/v1`.

#### Scenario: Inicio de sesión
- **WHEN** Pi emite `session_start` con el paquete cargado
- **THEN** se emite una sola vez `drakonc-pi:usage-source/v1` con `provider: "opencode-go"` y `schema: "drakonc-pi.usage-source/v1"`

#### Scenario: Varias sesiones
- **WHEN** se producen dos `session_start`
- **THEN** cada uno vuelve a emitir el registro y Drakonc conserva una sola fuente para `opencode-go`

#### Scenario: Pi sin Drakonc
- **WHEN** el paquete se carga en Pi sin Drakonc Shell
- **THEN** la emisión no tiene oyentes y la sesión continúa sin errores

### Requirement: Lectura de ventanas de uso
La función de lectura SHALL consultar el endpoint oficial de uso de OpenCode Go con la clave recibida y devolver las ventanas `5h`, `week` y `30d` con el porcentaje y la hora de reinicio que entrega el servidor, en ese orden. Una ventana ausente o con porcentaje no numérico MUST omitirse sin inventar valores.

#### Scenario: Respuesta completa
- **WHEN** el endpoint responde con `rolling` 0 %, `weekly` 11 % y `monthly` 5 %, cada una con `resetsAt`
- **THEN** la lectura devuelve `5h` 0 %, `week` 11 % y `30d` 5 % con sus horas de reinicio en milisegundos

#### Scenario: Ventana parcial
- **WHEN** el endpoint solo incluye `rolling`
- **THEN** la lectura devuelve únicamente la ventana `5h`

#### Scenario: Reinicio inválido
- **WHEN** `resetsAt` no es una fecha válida
- **THEN** la ventana se devuelve con hora de reinicio `null`

### Requirement: Sin datos fiables
La función de lectura SHALL devolver `undefined` cuando no haya clave, la petición falle por red o redirección, la respuesta no sea correcta, el cuerpo no sea JSON válido o no haya ninguna ventana utilizable. MUST NOT lanzar ni propagar ningún error, de modo que ni el cuerpo ni la clave puedan aparecer en un mensaje.

#### Scenario: Error de red con la clave en el mensaje
- **WHEN** `fetchFn` rechaza con un error cuyo mensaje contiene la clave
- **THEN** la lectura devuelve `undefined` y no lanza ningún error

#### Scenario: Clave con salto de línea
- **WHEN** la clave recibida contiene `\n`
- **THEN** la lectura devuelve `undefined` sin lanzar

#### Scenario: Sin clave
- **WHEN** la clave recibida es `undefined`
- **THEN** no se realiza ninguna petición y se devuelve `undefined`

#### Scenario: Error HTTP
- **WHEN** el endpoint responde 401 o 500
- **THEN** se devuelve `undefined`

#### Scenario: Cuerpo no JSON
- **WHEN** el endpoint responde 200 con un cuerpo que no es JSON
- **THEN** se devuelve `undefined` y no se propaga un error con el contenido del cuerpo

### Requirement: Límite alcanzado
El resultado SHALL marcar el límite como alcanzado cuando alguna ventana informe un `status` distinto de `"ok"` o un porcentaje igual o superior a 100.

#### Scenario: Estado distinto de ok
- **WHEN** `weekly.status` vale `"rate_limited"`
- **THEN** el resultado indica límite alcanzado

#### Scenario: Estado ausente
- **WHEN** ninguna ventana trae `status` y todos los porcentajes son menores que 100
- **THEN** el resultado no indica límite alcanzado

### Requirement: Protección de la clave
El paquete MUST enviar la clave solo al origen fijo `https://opencode.ai` como cabecera `Authorization: Bearer`, MUST rechazar redirecciones y MUST NOT registrar, persistir ni incluir la clave en mensajes o notas.

#### Scenario: Redirección
- **WHEN** el endpoint responde con una redirección a otro origen
- **THEN** la petición falla, la clave no se reenvía y se devuelve `undefined`

#### Scenario: Solo el fetch acotado de Drakonc
- **WHEN** se lee el uso con un `fetchFn` simulado y `globalThis.fetch` sustituido por una función que lanza
- **THEN** la petición va exactamente a `https://opencode.ai/zen/go/v1/usage` con `redirect: "error"`, sin opción `signal` propia, y `globalThis.fetch` nunca se llama

#### Scenario: Nota pendiente
- **WHEN** se inspecciona el payload registrado
- **THEN** la nota pendiente no contiene la clave, la URL ni datos de cuenta

### Requirement: Recomendación en Drakonc Shell
Para `opencode` y `opencode-go` sin fuente, el panel `/drakonc:usage` SHALL recomendar instalar `drakonc-opencode-go` desde git fijado a un commit SHA de 40 caracteres e indicar que recibe la clave de OpenCode Go. La recomendación MUST NOT usar la forma `npm:` ni marcadores sin resolver. El alias heredado SHALL seguir aceptándose.

#### Scenario: Panel sin fuente
- **WHEN** el proveedor activo es `opencode-go` y no hay fuente registrada
- **THEN** el panel nombra `drakonc-opencode-go` con un SHA de 40 caracteres hexadecimales, no contiene `npm:` ni `<`, y no nombra `gentle-opencode-go`

#### Scenario: Remoto sin confirmar
- **WHEN** el usuario aún no ha confirmado la URL del remoto ni el SHA
- **THEN** el panel indica que las ventanas no están disponibles y remite a la documentación, sin mostrar un comando de instalación

#### Scenario: Paquete original instalado
- **WHEN** el usuario tiene instalado `gentle-opencode-go`
- **THEN** sus ventanas se siguen mostrando mediante el alias heredado

### Requirement: Manifiesto sin ejecución en la instalación
El `package.json` del paquete MUST NOT declarar `dependencies` ni scripts `preinstall`, `install`, `postinstall` o `prepare`, y sus `peerDependencies` SHALL usar `"*"`, para que instalarlo desde git no ejecute código ni descargue dependencias.

#### Scenario: Comprobación del manifiesto
- **WHEN** una prueba lee `package.json`
- **THEN** no hay `dependencies` ni esos scripts y las peers valen `"*"`

### Requirement: Licencia y atribución
El paquete SHALL distribuirse bajo MIT conservando el aviso `Copyright (c) 2026 Jesús Rosales` del paquete original, y su README SHALL indicar que deriva de `gentle-opencode-go`.

#### Scenario: LICENSE
- **WHEN** se abre el `LICENSE` del paquete
- **THEN** contiene el aviso original y el texto MIT íntegro
