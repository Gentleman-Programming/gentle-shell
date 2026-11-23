# Spec Delta

## Purpose

Define los nombres propios de Drakonc Shell (comandos, ejecutable, versión, documentación) y las excepciones permitidas cuando un nombre heredado es un contrato real de Pi u otro servicio necesario para que una integración funcione.

## ADDED Requirements

### Requirement: Espacio de nombres propio
Los comandos de la aplicación SHALL usar el prefijo `/drakonc:` y el ejecutable SHALL llamarse `drakonc-shell`. Mensajes, ayudas, atajos, guía y documentación propios MUST NOT referirse a `/gentle:`, `gentle-shell` ni "Gentle Shell" salvo en avisos de origen, licencia o excepciones documentadas.

#### Scenario: Catálogo de comandos
- **WHEN** el usuario ejecuta `/drakonc:commands` o `/drakonc:guide`
- **THEN** todos los comandos listados usan `/drakonc:` y ninguno usa `/gentle:`

#### Scenario: Ayuda del launcher
- **WHEN** el usuario ejecuta `drakonc-shell --help`
- **THEN** la ayuda usa `drakonc-shell` y Drakonc Shell en todos sus textos

#### Scenario: Barrido de marca
- **WHEN** se buscan `gentle` y `Gentle` en código, recursos, pruebas y documentación propios, excluyendo `node_modules`, `LICENSE`, avisos de copyright y el registro de excepciones
- **THEN** cada coincidencia restante figura en el registro de excepciones

### Requirement: Registro de excepciones de marca
El repositorio SHALL mantener un registro de excepciones que liste cada nombre heredado o externo conservado, dónde aparece, a qué contrato pertenece y por qué es necesario. Una referencia externa renombrada que no resuelve a un recurso existente MUST restaurarse a su nombre real o retirarse, y quedar registrada.

#### Scenario: Contrato de evento heredado
- **WHEN** se revisa el registro
- **THEN** incluye el evento `gentle-pi:usage-source/v1` como alias de compatibilidad y el paquete `gentle-opencode-go` como fuente de uso de terceros

#### Scenario: Clave persistida del usuario
- **WHEN** se revisa el registro
- **THEN** incluye `showRose` de `banner.json` como clave conservada para no migrar datos del usuario

#### Scenario: Referencia externa inexistente o ajena
- **WHEN** una URL o paquete renombrado (por ejemplo un repositorio o paquete `drakonc-*`) no existe en su servicio o no pertenece al proyecto según sus `maintainers` o `repository`
- **THEN** se restaura el nombre real que la integración necesita o se desactiva la referencia, y el caso queda en el registro

#### Scenario: Instalaciones con versión fija
- **WHEN** el launcher o un instalador instala un paquete o repositorio externo
- **THEN** la instalación usa una versión, commit o checksum fijo, y ninguna instalación automática usa un nombre no verificado

### Requirement: Versión inicial propia
El paquete SHALL declarar la versión `0.1.0`, y `drakonc-shell --version`, el README y los textos de actualización SHALL mostrar esa versión. Las comprobaciones de versión del launcher y las pruebas MUST seguir pasando con la nueva numeración.

#### Scenario: Versión mostrada
- **WHEN** el usuario ejecuta `drakonc-shell --version`
- **THEN** la salida indica Drakonc Shell `0.1.0`

#### Scenario: Pruebas de versión
- **WHEN** se ejecuta la suite de pruebas
- **THEN** ninguna prueba fija `5.0.0` como versión de Drakonc Shell

### Requirement: Documentación de uso e instalación
El README SHALL mostrar la imagen del dragón, la versión `0.1.0`, una descripción de cada herramienta y comando principal con su propósito, instrucciones de uso básico y la instalación en otras máquinas para Linux, macOS y Windows, incluida la activación opcional del uso de OpenCode Go.

#### Scenario: Instalación en otra máquina
- **WHEN** un usuario sigue la sección de instalación del README en una máquina limpia
- **THEN** encuentra requisitos, comandos por sistema operativo y cómo verificar la instalación, sin pasos que modifiquen `~/.pi` ni `~/.gentle-shell`

#### Scenario: Herramientas descritas
- **WHEN** el usuario lee la sección de herramientas
- **THEN** cada herramienta o comando principal (`/drakonc:usage`, `/drakonc:tower`, `/drakonc:guide`, agentes, revisión, memoria, personalización) tiene una frase sobre para qué sirve y cómo se invoca

### Requirement: Avisos legales preservados
El cambio MUST conservar íntegros `LICENSE`, los avisos de copyright originales y las licencias de recursos de terceros, y el README SHALL indicar que Drakonc Shell deriva de Gentle Shell bajo licencia MIT.

#### Scenario: Licencia intacta
- **WHEN** se compara `LICENSE` y los avisos de copyright con su estado anterior al cambio
- **THEN** no hay diferencias

### Requirement: Datos del usuario y configuración compartida
Ninguna parte del cambio MUST escribir, migrar ni borrar archivos en `~/.pi`, `~/.gentle-shell`, `~/.gentle-ai` ni datos existentes en `~/.drakonc-shell`, salvo acciones explícitas del usuario.

#### Scenario: Primer arranque tras el cambio
- **WHEN** el usuario inicia Drakonc Shell después de actualizar
- **THEN** los archivos de `~/.pi`, `~/.gentle-shell` y los existentes en `~/.drakonc-shell` conservan su contenido y fecha de modificación
