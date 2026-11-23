<div align="center">
  <img src="docs/assets/brand/drakonc-dragon.svg" width="720" alt="Drakonc Shell: dragón rojo sobre fondo oscuro">

  # Drakonc Shell

  **Un entorno de desarrollo con agentes, desde tu terminal.**

  [Funciones](#funciones) · [Primeros pasos](#primeros-pasos) · [Configuración](#configuración-y-datos) · [Desarrollo](#desarrollo) · [Licencia](#licencia)
</div>

Drakonc Shell reúne una interfaz de terminal, agentes especializados, herramientas y vistas de seguimiento para trabajar en proyectos con Pi. Su identidad utiliza un fondo oscuro, rojo eléctrico y el dragón de Drakonc.

> **Estado del proyecto:** esta bifurcación está en transformación. Algunos componentes y direcciones externas se han renombrado durante la transición, pero todavía necesitan sus servicios o paquetes equivalentes y una verificación integral. No se ha publicado una versión independiente.

## Funciones

- **Terminal con agentes:** conversación, herramientas y seguimiento de tareas dentro de una sesión.
- **Agentes especializados:** exploración, implementación y verificación mediante roles enfocados.
- **Tower:** vista local de proyectos y sesiones, accesible con `/drakonc:tower` o `drakonc-shell tower`.
- **Comandos:** el espacio de nombres de la aplicación usa `/drakonc:`; consulta `/drakonc:commands` o `/drakonc:guide` en una sesión.
- **Memoria, extensiones y perfiles:** integraciones heredadas que forman parte del proyecto y que siguen pendientes de validación completa en esta bifurcación.

## Primeros pasos

El proyecto requiere una versión de Node.js compatible con la indicada en [package.json](package.json), pnpm y las dependencias declaradas. Desde una copia local:

```sh
pnpm install --frozen-lockfile
node bin/drakonc-shell.mjs --help
```

El comando de ayuda permite inspeccionar las opciones sin iniciar una sesión. El ejecutable declarado en el paquete es `drakonc-shell`. La instalación completa y el arranque interactivo dependen de los componentes externos configurados; verifica su disponibilidad antes de usarlos.

## Configuración y datos

Por defecto, el launcher selecciona `~/.drakonc-shell/agent` como hogar aislado y usa directorios propios bajo `~/.drakonc-shell` para configuración y estado. No elimina los datos anteriores. Puedes consultar las opciones de selección de hogar y de importación con `drakonc-shell --help`.

La integración de memoria Engram todavía utiliza un mecanismo de servidor compartido; **su aislamiento independiente está pendiente**. Evita migrar o sobrescribir almacenes existentes hasta que ese flujo esté validado.

## Carpetas de configuración y datos

Drakonc Shell escribe únicamente dentro de su propio hogar, `~/.drakonc-shell` (o el prefijo de una instalación empaquetada), y nunca en la configuración compartida de Pi. Estas son las carpetas que usa:

- `~/.drakonc-shell/agent`: el hogar aislado de Pi (sesiones, credenciales, extensiones y `settings.json`). Es el que el launcher selecciona por defecto.
- `~/.drakonc-shell/drakonc-ai`: la carpeta de configuración de Drakonc, donde viven `profiles.json`, `persona.json`, `banner.json`, `models.json`, las políticas de subagentes y del doble `Esc`, el canal de actualización (`channel.json`), las compilaciones del canal `main` y el binario de desarrollo (`dev-binary.json`).
- `~/.drakonc-shell/drakonc-ai-home`: el estado propio del binario companion mientras ese binario sea el `gentle-ai` original; queda dentro de `~/.drakonc-shell` para no tocar su carpeta habitual.

Las carpetas `<proyecto>/.pi/drakonc-ai` (perfil declarado en el repositorio, superposición de herramientas por proyecto, política de subagentes por proyecto) son del proyecto, no de tu hogar: se versionan o se ignoran con el proyecto y no dependen de las rutas anteriores.

### Restos de versiones anteriores

Versiones anteriores de este proyecto (y las de Gentle Shell) pudieron crear, antes de este cambio, carpetas fuera de los hogares de Drakonc:

- `~/.pi/drakonc-ai`: la antigua carpeta de configuración compartida con Pi.
- `~/.pi/gentle-ai`: la carpeta que el binario companion original escribe por su cuenta.
- `~/.gentle-ai`: el estado global de ese binario (por ejemplo `state.json` y archivos `pi-codegraph-*.json`).

Drakonc Shell ya no usa esas rutas: no las lee, no las migra, no las copia y no las borra. La única excepción es la importación inicial de ajustes del hogar aislado, que copia una vez los archivos de `~/.pi/drakonc-ai` a `~/.drakonc-shell/drakonc-ai` sin modificar el origen. Si quieres revisarlas antes de decidir qué hacer con ellas, puedes listarlas sin abrirlas ni cambiarlas:

```sh
ls -la ~/.pi/drakonc-ai ~/.pi/gentle-ai ~/.gentle-ai
```

Consérvalas si otro producto (Pi, Gentle AI) las sigue usando; bórralas tú mismo solo cuando estés seguro de que nada más las necesita. `drakonc-shell self-uninstall` las deja intactas y las enumera como «Not touched».

### Elegir otra carpeta de configuración

`DRAKONC_PI_CONFIG_HOME` fija la carpeta de configuración de Drakonc para todos sus lectores (extensiones, políticas, canal de actualización y desinstalador). Si vienes de una versión anterior y prefieres seguir usando `~/.pi/drakonc-ai`, expórtala antes de arrancar:

```sh
export DRAKONC_PI_CONFIG_HOME="$HOME/.pi/drakonc-ai"
```

Un valor vacío cuenta como no definido, y un valor relativo se ignora. En una instalación empaquetada con prefijo, la carpeta del prefijo (`<prefijo>/config/drakonc-ai`) tiene prioridad sobre la variable.


## Desarrollo

Los comandos del repositorio están definidos en [package.json](package.json):

```sh
pnpm test
pnpm typecheck
pnpm run check:runtime-modules
pnpm run build:tower
```

Cuando cambies los módulos TypeScript que alimentan `runtime/`, regenera sus equivalentes con `pnpm run build:runtime-modules` y comprueba que ambos coincidan. La compatibilidad con Linux, macOS y Windows requiere pruebas en cada plataforma.

Para más detalles sobre la implementación y los comandos, consulta la [documentación del proyecto](docs/drakonc-shell.md). Algunas páginas y recursos heredados todavía pueden requerir actualización.

## Licencia

Drakonc Shell deriva de Gentle Shell y conserva los avisos de copyright y la [licencia MIT](LICENSE) del código original. Los recursos individuales pueden incluir licencias adicionales, como [assets/sounds/LICENSE.md](assets/sounds/LICENSE.md).
