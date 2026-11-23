# Spec Delta

## Purpose

Define de dónde instala Drakonc Shell sus paquetes y binarios companion, cómo se fijan y cuándo un nombre heredado se sustituye por uno propio `drakonc-*`.

## ADDED Requirements

### Requirement: Fuentes fijadas
Toda fuente que el launcher o los instaladores instalen automáticamente SHALL estar fijada a una versión exacta de npm, un commit SHA de 40 caracteres o una descarga con checksum SHA-256.

#### Scenario: Inventario de fuentes
- **WHEN** una prueba recorre las constantes de fuentes de instalación
- **THEN** cada una tiene versión exacta, SHA de 40 caracteres o checksum

### Requirement: Nombre propio solo cuando existe y es del usuario
Una fuente SHALL usar un nombre `drakonc-*` solo cuando el paquete, repositorio o release exista y su propietario (`maintainers`, `repository` u organización) sea el del proyecto Drakonc. Hasta entonces SHALL usar el nombre real heredado, registrado en `docs/brand-exceptions.md`.

#### Scenario: Nombre propio sin publicar
- **WHEN** una fuente de instalación apunta a un nombre `drakonc-*` que no figura como publicado en el registro de excepciones
- **THEN** la comprobación automatizada falla

#### Scenario: Paso a nombre propio
- **WHEN** el usuario publica `drakonc-engram@X.Y.Z` y lo registra como publicado
- **THEN** cambiar la constante de la fuente y su entrada del registro es suficiente, y las pruebas pasan

### Requirement: Guía de publicación
El repositorio SHALL incluir una guía con las fases de publicación (repo `drakonc-shell`, `drakonc-pi`, `drakonc-engram`, `drakonc-ai`, `drakonc-stream` opcional), qué crea el usuario en cada una, los comandos de verificación de propiedad y el cambio de código asociado.

#### Scenario: Fase completa
- **WHEN** el usuario sigue una fase de la guía
- **THEN** sabe qué repositorio o paquete crear, cómo comprobar su propiedad con `npm view` o `git ls-remote`, qué constante cambiar y qué pruebas ejecutar

### Requirement: Compatibilidad durante la transición
Mientras convivan fuentes heredadas y propias, la detección de paquetes declarados (por ejemplo el paquete Pi de la Shell en `settings.json`) SHALL reconocer ambos nombres para que una instalación existente no quede duplicada ni huérfana.

#### Scenario: Instalación previa con nombre heredado
- **WHEN** `settings.json` declara `npm:gentle-pi` y la fuente actual es `drakonc-pi`
- **THEN** el launcher reconoce la declaración existente y no instala el paquete dos veces
