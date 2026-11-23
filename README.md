<div align="center">
  <img src="docs/assets/brand/drakonc-dragon.svg" width="720" alt="Drakonc Shell: dragón rojo sobre fondo oscuro">

  # Drakonc Shell

  **Un entorno de desarrollo con agentes, desde tu terminal.**

  [Funciones](#funciones) · [Requisitos](#requisitos) · [Instalación](#instalación-en-otro-equipo) · [Uso básico](#uso-básico) · [Configuración](#configuración-y-datos) · [Desarrollo](#desarrollo) · [Licencia](#licencia)
</div>

Drakonc Shell reúne una interfaz de terminal, agentes especializados, herramientas y vistas de seguimiento para trabajar en proyectos con Pi. Su identidad utiliza un fondo oscuro, rojo eléctrico y el dragón de Drakonc.

> **Estado del proyecto:** esta bifurcación está en transformación. Algunos componentes y direcciones externas se han renombrado durante la transición, pero todavía necesitan sus servicios o paquetes equivalentes y una verificación integral. No se ha publicado una versión independiente.

## Funciones

- **Terminal con agentes:** conversación, herramientas y seguimiento de tareas dentro de una sesión.
- **Agentes especializados:** exploración, implementación y verificación mediante roles enfocados.
- **Tower:** vista local de proyectos y sesiones, accesible con `/drakonc:tower` o `drakonc-shell tower`.
- **Comandos:** el espacio de nombres de la aplicación usa `/drakonc:`; consulta `/drakonc:commands` o `/drakonc:guide` en una sesión.
- **Memoria, extensiones y perfiles:** integraciones heredadas que forman parte del proyecto y que siguen pendientes de validación completa en esta bifurcación.

## Requisitos

- **Node.js `^22.19.0 || >=23.6.0`**: el rango exacto que declara `engines` en [package.json](package.json).
- **pnpm 11**: el repositorio fija `pnpm@11.1.1` en `packageManager`, y su `pnpm-workspace.yaml` usa opciones de pnpm 11.
- **git**: para clonar el repositorio.
- **Pi**: no hace falta instalarlo aparte, porque `pnpm install` deja `@earendil-works/pi-coding-agent` en `node_modules` y el launcher lo usa desde ahí. También vale un `pi` en el `PATH` o la variable `DRAKONC_SHELL_PI` con la ruta al ejecutable.
- **Un proveedor de modelos**: inicia sesión con `drakonc-shell auth login <proveedor>` (o con `/login` dentro de una sesión), o reutiliza las credenciales de tu Pi con `drakonc-shell home import-pi`.
- **Engram 3.4.0 o posterior, solo si quieres memoria**: Shell reutiliza un servidor Engram en `127.0.0.1:7437` únicamente cuando ese servidor responde `/compatibility`. Con una versión anterior la memoria queda desactivada para ese arranque y la sesión funciona igual. La versión que empaqueta Shell es la 3.7.2, y desde 3.7.0 el servidor se inicia con su ciclo de vida de daemon.

## Instalación en otro equipo

La instalación es una copia del repositorio más `pnpm install`; todavía no hay paquete publicado en npm (`npm install -g drakonc-pi` responde 404). Cuando `drakonc-pi` se publique, ese será el camino corto; hasta entonces, clona el repositorio.

### Linux

```sh
git clone https://github.com/drakonc/drakonc-shell.git
cd drakonc-shell
pnpm install --frozen-lockfile
node bin/drakonc-shell.mjs --version
```

El `postinstall` del paquete descarga el binario local de Drakonc AI v5.0.0, que usan las revisiones nativas. Si no lo quieres, `DRAKONC_PI_SKIP_DRAKONC_AI_INSTALL=1 pnpm install --frozen-lockfile` lo omite y las operaciones de revisión nativa fallan con `package-local-binary-missing` hasta que reinstales.

Para tener el comando `drakonc-shell` a mano sin instalar nada globalmente, enlaza el ejecutable en una carpeta de tu `PATH`:

```sh
mkdir -p ~/.local/bin
ln -sf "$PWD/bin/drakonc-shell.mjs" ~/.local/bin/drakonc-shell
drakonc-shell --version
```

Si `~/.local/bin` no está en tu `PATH`, usa otra carpeta que sí lo esté. La alternativa con gestor de paquetes es `pnpm link --global` desde la copia, que deja el comando en el `bin` global de pnpm (la carpeta que `pnpm setup` añade al `PATH`). Y siempre funciona la forma explícita, sin enlaces: `node bin/drakonc-shell.mjs`.

### macOS

Los pasos son los mismos que en Linux:

```sh
git clone https://github.com/drakonc/drakonc-shell.git
cd drakonc-shell
pnpm install --frozen-lockfile
node bin/drakonc-shell.mjs --version
```

Para el comando corto, enlaza el ejecutable en una carpeta que ya esté en tu `PATH` (por ejemplo `/opt/homebrew/bin` en Apple Silicon, `/usr/local/bin` en Intel, o `~/.local/bin` si la añadiste):

```sh
ln -sf "$PWD/bin/drakonc-shell.mjs" /usr/local/bin/drakonc-shell
drakonc-shell --version
```

`pnpm link --global` y `node bin/drakonc-shell.mjs` funcionan igual que en Linux.

### Windows (PowerShell)

```powershell
git clone https://github.com/drakonc/drakonc-shell.git
cd drakonc-shell
pnpm install --frozen-lockfile
node bin\drakonc-shell.mjs --version
```

Para el comando corto, define una función en tu perfil de PowerShell y abre una terminal nueva (o recarga el perfil con `. $PROFILE`):

```powershell
Add-Content $PROFILE 'function drakonc-shell { node "$HOME\drakonc-shell\bin\drakonc-shell.mjs" @args }'
```

`pnpm link --global` también funciona en Windows y deja `drakonc-shell` en el `bin` global de pnpm. La forma explícita, sin configuración, es `node bin\drakonc-shell.mjs`.

### Primer arranque

```sh
drakonc-shell
```

La primera ejecución prepara el hogar aislado `~/.drakonc-shell/agent`: crea su `settings.json` con el tema Drakonc y la interfaz a pantalla completa, siembra una vez `~/.drakonc-shell/drakonc-ai` desde `~/.pi/drakonc-ai` (solo lectura, sin tocar el origen) e instala los paquetes del companion Drakonc AI, así que necesita red y puede tardar un poco. Los arranques siguientes no repiten ese trabajo salvo que cambie la versión del paquete. Si una parte falla, la sesión arranca igual y el aviso queda en pantalla.

### Reutilizar tus credenciales de Pi

Si ya usas Pi en ese equipo, copia sus inicios de sesión y sus servidores MCP al hogar aislado:

```sh
drakonc-shell home import-pi
```

`home import-pi` lee `auth.json` y `mcp.json` de `~/.pi/agent` y, cuando el hogar aislado no tiene ninguno, también el proveedor, el modelo y el nivel de razonamiento predeterminados. Nunca sobrescribe un archivo ni un ajuste existente, no copia paquetes, extensiones ni cachés, y no cambia tu hogar de Pi. Antes de escribir nada puedes ver el plan con `--dry-run`:

```sh
drakonc-shell home import-pi --dry-run
```

### Verificar la instalación

```sh
drakonc-shell --version
drakonc-shell --help
```

`--version` imprime la versión de Drakonc Shell, la de Pi que va a ejecutar y el hogar resuelto, por ejemplo:

```text
drakonc-shell 5.0.0
pi 1.6.0
home isolated /home/tu-usuario/.drakonc-shell/agent
```

`--help` lista los comandos y las variables de entorno sin iniciar ninguna sesión.

## Uso básico

Arranca una sesión con `drakonc-shell` y escribe los comandos con el prefijo `/drakonc:`; todo lo demás es Pi y sus propias órdenes (`/model`, `/login`, `/quit`).

Comandos clave:

- `/drakonc:guide`: recorrido guiado por las partes de la pantalla, con el texto de cada paso en español.
- `/drakonc:commands` (o `alt+k`): paleta de comandos agrupada por configuración, sesión y diagnóstico.
- `/drakonc:usage` (o `alt+u`): ventanas de consumo de las suscripciones conectadas.
- `/drakonc:tower`: abre la Drakonc Tower en el navegador, con cada sesión abierta como un piso. En una copia del repositorio el Tower necesita su compilación una vez: `pnpm run build:tower`.
- `/drakonc:customize`: apariencia, notificaciones de audio, Vim, revisión guiada por recibos y permisos de sesión.
- `/drakonc:persona`: alterna la persona entre el Drakoncman y el modo neutral.
- `/drakonc:profiles`: pantalla de modelos y perfiles, con exportación e importación de perfiles.
- `/drakonc:toggle-dragon`: muestra u oculta el dragón del banner de arranque.

Fuera de una sesión también sirven `drakonc-shell tower` y los comandos de Pi sobre el hogar aislado: `drakonc-shell install <fuente>`, `remove`, `list`, `update`, `config`, `auth`, `mcp`.

### Cambiar de modelo

`/model` abre la lista: `Enter` cambia el modelo solo para la sesión actual, `Ctrl+S` lo guarda como predeterminado y `Esc` cancela. Para conjuntos de modelos y perfiles completos, usa `/drakonc:profiles`.

### Activar el uso de OpenCode Go

OpenCode Go no entrega ventanas de uso por sí mismo; las publica un paquete de terceros, que recibe tu clave de OpenCode Go como cualquier otra fuente:

```sh
drakonc-shell install npm:gentle-opencode-go@0.1.2
```

Con eso, `/drakonc:usage` muestra las ventanas de 5 horas, semana y 30 días. Es la vía disponible hasta que exista el paquete propio `drakonc-opencode-go`; sin fuente instalada, el panel lo dice y repite este comando.

### Arranque limpio

Para ocultar la cabecera de arranque y el listado de recursos cargados, añade `"quietStartup": true` al `settings.json` de tu hogar (`~/.drakonc-shell/agent/settings.json` en el modo aislado). Es un ajuste de Pi: `"header"` conserva la cabecera y oculta el resto.

## Actualizar y desinstalar

En una copia del repositorio, actualiza con git y vuelve a instalar las dependencias:

```sh
git pull
pnpm install
```

El comando `drakonc-shell upgrade` pertenece al instalador publicado y a la instalación empaquetada, no a una copia del repositorio.

Para desinstalar, primero mira el plan sin borrar nada:

```sh
drakonc-shell self-uninstall --dry-run
```

En una copia clonada, ese plan explica lo que se quitaría (los datos propios de Drakonc Shell, el hogar aislado y el paquete `drakonc-pi` si está instalado) y luego se detiene: nadie gestiona la copia como paquete, así que responde `uninstall-owner-unknown`, no borra nada y sale con código 1. Para desinstalar de verdad basta con borrar la carpeta que clonaste, y el hogar `~/.drakonc-shell` si no piensas volver a usarlo.

En un equipo donde `drakonc-pi` sí se instaló como paquete, el plan incluye el comando exacto del gestor que lo quitará. La ejecución real pide confirmación (`--yes` la omite) y conserva siempre la configuración de `~/.pi/drakonc-ai` de versiones anteriores; la carpeta compartida `~/.drakonc-shell/drakonc-ai` solo se borra si aceptas el aviso o pasas `--include-shared`. Nunca toca tu hogar de Pi ni hogares `--home` personalizados.

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
