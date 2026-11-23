# Spec Delta

## Purpose

Garantiza que el launcher de Drakonc Shell y los instaladores o binarios companion que ejecuta escriben solo en los hogares de Drakonc y nunca en la configuración de Pi compartida ni en la de otros productos.

## ADDED Requirements

### Requirement: Variables reales del binario companion
Al ejecutar el binario companion, el launcher SHALL pasarle las variables de aislamiento que ese binario reconoce, con rutas dentro de los hogares de Drakonc. Mientras el binario sea el `gentle-ai` original, SHALL incluir `GENTLE_AI_HOME`, `GENTLE_AI_PI_CONFIG_DIR`, `GENTLE_AI_ENGRAM_BIN` (si aplica), `GENTLE_AI_NO_SELF_UPDATE=1` y `GENTLE_PI_CONFIG_HOME`, además de sus equivalentes `DRAKONC_*`.

#### Scenario: Entorno del instalador
- **WHEN** el launcher construye el entorno para el binario companion en modo aislado
- **THEN** `GENTLE_AI_HOME` y `DRAKONC_AI_HOME` apuntan a la misma carpeta dentro de `~/.drakonc-shell`, y `GENTLE_AI_NO_SELF_UPDATE` vale `1`

#### Scenario: Instalación empaquetada
- **WHEN** el launcher se ejecuta desde una instalación empaquetada con prefijo
- **THEN** las variables `GENTLE_*` apuntan dentro del prefijo, igual que las `DRAKONC_*`

#### Scenario: Sin autoactualización en ningún modo
- **WHEN** el launcher construye el entorno del binario en modo empaquetado, aislado por defecto o `--link`
- **THEN** `GENTLE_AI_NO_SELF_UPDATE` y `DRAKONC_AI_NO_SELF_UPDATE` valen `1` y `GENTLE_AI_HOME` apunta dentro del hogar de Drakonc

#### Scenario: Escritura y lectura en la misma carpeta
- **WHEN** el binario escribe la política de subagentes con las variables recibidas
- **THEN** drakonc-pi la lee desde la misma carpeta

#### Scenario: Pi y su shell no las heredan
- **WHEN** el launcher inicia Pi después de la configuración
- **THEN** el entorno de Pi no contiene `GENTLE_PI_CONFIG_HOME` ni `DRAKONC_PI_CONFIG_HOME` puestos para el binario

### Requirement: Sin escrituras fuera de los hogares de Drakonc
Ninguna ejecución del launcher, de su configuración inicial ni del binario companion MUST crear, modificar ni borrar archivos en `~/.pi`, `~/.gentle-ai` ni `~/.gentle-shell` en el modo aislado por defecto.

#### Scenario: Primer arranque aislado
- **WHEN** se ejecuta la configuración inicial con un `HOME` temporal que contiene `~/.pi`, `~/.gentle-ai` y `~/.gentle-shell` con archivos conocidos
- **THEN** después de la ejecución esas carpetas tienen exactamente los mismos archivos, contenidos y fechas

#### Scenario: Modo link explícito
- **WHEN** el usuario elige `--link`
- **THEN** el comportamiento documentado de `--link` se mantiene y no se amplía a `~/.gentle-ai`

### Requirement: Carpeta de configuración propia
En el modo aislado por defecto, la carpeta de configuración de Drakonc SHALL estar dentro de `~/.drakonc-shell`. Una carpeta existente `~/.pi/drakonc-ai` MUST respetarse sin migrarla ni borrarla, y su uso SHALL documentarse.

#### Scenario: Instalación nueva
- **WHEN** no existe ninguna carpeta de configuración de Drakonc
- **THEN** la configuración se crea dentro de `~/.drakonc-shell` y no se crea `~/.pi/drakonc-ai`

#### Scenario: Carpeta heredada existente
- **WHEN** ya existe `~/.pi/drakonc-ai`
- **THEN** no se modifica ni se borra, y la documentación explica cómo dejar de usarla
