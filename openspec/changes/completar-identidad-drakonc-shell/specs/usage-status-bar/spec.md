# Spec Delta

## Purpose

Define cómo Drakonc Shell obtiene y muestra en la barra de estado y en el panel `/drakonc:usage` el modelo, el esfuerzo, el contexto, el costo y las ventanas de uso de suscripción de cada proveedor, sin inventar métricas.

## ADDED Requirements

### Requirement: Segmento de ejecución y sesión de la barra
La barra de estado SHALL mostrar, en este orden y separados por `│`, el modelo activo con su nivel de esfuerzo (`modelo · esfuerzo`), el medidor de contexto con porcentaje, el costo acumulado de la sesión y el segmento de uso. Cuando el modelo no tiene nivel de esfuerzo, SHALL omitir `· esfuerzo`.

#### Scenario: Modelo DeepSeek con esfuerzo alto
- **WHEN** la sesión usa `deepseek-v4.1-flash` con esfuerzo `high`, 4 % de contexto y costo `$0.006`
- **THEN** la barra comienza con `deepseek-v4.1-flash · high │ ctx` seguido del medidor, `4%`, `│ $0.006 │` y el segmento de uso

#### Scenario: Modelo sin nivel de esfuerzo
- **WHEN** el modelo activo no informa nivel de esfuerzo
- **THEN** la barra muestra solo el identificador del modelo, sin `·` ni texto de esfuerzo

### Requirement: Ventanas de uso informadas por el proveedor
El segmento de uso SHALL mostrar `usage` seguido de cada ventana que entrega la fuente del proveedor activo, con su etiqueta, medidor y porcentaje, en el orden recibido y separadas por `·`. El sistema MUST NOT mostrar ventanas que la fuente no entregó ni calcular porcentajes estimados.

#### Scenario: OpenCode Go con tres ventanas
- **WHEN** la fuente de OpenCode Go entrega `5h` 0 %, `week` 11 % y `30d` 5 %
- **THEN** el segmento muestra `usage 5h ▱▱▱▱▱▱▱▱ 0% · week ▰▱▱▱▱▱▱▱ 11% · 30d ▱▱▱▱▱▱▱▱ 5% · alt+u`

#### Scenario: Proveedor que entrega una sola ventana
- **WHEN** la fuente entrega solo la ventana `5h`
- **THEN** el segmento muestra únicamente `5h` y no muestra `week` ni `30d`

#### Scenario: Ancho insuficiente
- **WHEN** el ancho de la terminal no alcanza para todas las ventanas con medidor
- **THEN** el segmento degrada primero a texto sin medidores y después a la primera ventana, sin truncar a mitad de una etiqueta

### Requirement: Estado explícito sin datos de uso
Cuando el proveedor activo no tiene fuente de uso registrada o integrada, la barra SHALL mostrar solo `usage · <atajo>` sin medidores ni porcentajes, y el panel `/drakonc:usage` SHALL explicar que ese proveedor no entrega ventanas de uso a Drakonc. Para `opencode` y `opencode-go` el panel SHALL indicar además cómo habilitar la fuente. Cuando la fuente existe pero aún no hay datos, SHALL mostrar la nota pendiente de esa fuente.

#### Scenario: Proveedor sin fuente de uso
- **WHEN** el proveedor activo es `opencode-go` y no hay ninguna fuente registrada para él
- **THEN** la barra muestra `usage · alt+u` sin porcentajes y el panel indica que no hay ventanas de uso para ese proveedor y cómo habilitarlas

#### Scenario: Fuente registrada sin primera lectura
- **WHEN** existe una fuente para el proveedor activo pero todavía no devolvió datos
- **THEN** la barra y el panel muestran su nota pendiente (por defecto `no usage yet · r to fetch`)

#### Scenario: Lectura fallida
- **WHEN** la fuente del proveedor activo lanza un error o devuelve `undefined` tras una actualización
- **THEN** el panel muestra `fetch failed · r to retry` y la barra no muestra porcentajes antiguos como si fueran actuales

### Requirement: Contrato de registro de fuentes de uso
El sistema SHALL aceptar el registro de fuentes de uso de otras extensiones mediante el evento `drakonc-pi:usage-source/v1` con esquema `drakonc-pi.usage-source/v1`. Por compatibilidad, SHALL aceptar también el evento `gentle-pi:usage-source/v1` solo con esquema `gentle-pi.usage-source/v1`, con la misma validación. Cada esquema MUST corresponder a su evento. Un payload inválido MUST ignorarse sin interrumpir la sesión.

#### Scenario: Registro con el contrato propio
- **WHEN** una extensión emite `drakonc-pi:usage-source/v1` con esquema `drakonc-pi.usage-source/v1`, un `provider` válido y una función `fetch`
- **THEN** la fuente queda registrada para ese proveedor y se usa en la barra y el panel

#### Scenario: Registro con el contrato heredado
- **WHEN** el paquete `gentle-opencode-go` emite `gentle-pi:usage-source/v1` con esquema `gentle-pi.usage-source/v1` para `opencode-go`
- **THEN** la fuente queda registrada igual que con el contrato propio y la barra muestra las ventanas que entrega

#### Scenario: Esquema que no coincide con el evento
- **WHEN** llega `gentle-pi:usage-source/v1` con esquema `drakonc-pi.usage-source/v1`, o `drakonc-pi:usage-source/v1` con esquema `gentle-pi.usage-source/v1`
- **THEN** el payload se ignora y no se registra ninguna fuente

#### Scenario: Intento de sustituir un proveedor integrado
- **WHEN** una extensión registra una fuente para `anthropic`, `openai-codex` o `nan` por cualquiera de los dos eventos
- **THEN** el registro se rechaza, la fuente integrada sigue activa y la función ajena nunca recibe la clave del proveedor

#### Scenario: Payload malformado
- **WHEN** llega cualquiera de los dos eventos con `provider` fuera del patrón seguro o sin función `fetch`
- **THEN** el payload se ignora, no se lanza ninguna excepción y la sesión continúa

#### Scenario: Re-registro del mismo proveedor
- **WHEN** el mismo proveedor se registra primero con el evento heredado y luego con el propio
- **THEN** queda una sola fuente activa, la más reciente

### Requirement: Comportamiento de proveedores integrados
Las fuentes integradas de `openai-codex`, `anthropic` y `nan` SHALL conservar su comportamiento actual de obtención, etiquetas de ventana, notas y orden.

#### Scenario: Codex sin cambios
- **WHEN** el proveedor activo es `openai-codex` y entrega ventanas `5h` y `week`
- **THEN** la barra y el panel muestran las mismas ventanas, etiquetas y notas que antes del cambio

### Requirement: Atajo de uso
El atajo por defecto `alt+u` SHALL abrir el panel `/drakonc:usage`, y la barra SHALL mostrar el atajo efectivo al final del segmento de uso. Si el usuario redefine el atajo, la barra SHALL mostrar el valor redefinido.

#### Scenario: Atajo por defecto
- **WHEN** el usuario pulsa `alt+u` sin redefiniciones
- **THEN** se abre el panel de uso y la barra muestra `· alt+u`

#### Scenario: Atajo redefinido
- **WHEN** el usuario define `DRAKONC_PI_SHELL_USAGE_KEY=alt+y`
- **THEN** `alt+y` abre el panel y la barra muestra `· alt+y`

### Requirement: Credenciales de las fuentes de uso
El sistema MUST NOT registrar, mostrar ni persistir la clave del proveedor que recibe una fuente de uso, y los mensajes de error del panel MUST NOT incluir endpoints, claves ni datos de cuenta.

#### Scenario: Error con datos sensibles
- **WHEN** la fuente falla con un error cuyo texto contiene la URL y un token
- **THEN** el panel muestra solo la nota genérica de fallo, sin la URL ni el token
