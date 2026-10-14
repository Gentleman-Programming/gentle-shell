> Leer en inglés: [English](README.md)

<a id="top"></a>

<div align="center">
  <img src="docs/assets/brand/gentle-shell-banner.gif" width="1200" alt="gentle-shell — Ecosistema, agente, un solo shell">
</div>

<p align="center"><a href="README.md">English</a> · <strong>Español</strong></p>

<h1 align="center">gentle-shell™</h1>

<p align="center"><strong>Tu agente de código para el desarrollo controlado en el espacio de trabajo que lideras.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/gentle-pi"><img src="https://img.shields.io/npm/v/gentle-pi?style=for-the-badge&labelColor=1A1218&color=F095C8" alt="npm"></a>
  <a href="https://pi.dev/packages/gentle-pi"><img src="https://img.shields.io/badge/Pi-native-F095C8?style=for-the-badge&labelColor=1A1218" alt="Paquete nativo de Pi"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/gentle-pi?style=for-the-badge&labelColor=1A1218&color=F095C8" alt="Licencia MIT"></a>
  <a href="https://github.com/Gentleman-Programming/gentle-shell/stargazers"><img src="https://img.shields.io/github/stars/Gentleman-Programming/gentle-shell?style=for-the-badge&labelColor=1A1218&color=F095C8" alt="Estrellas de GitHub"></a>
  <a href="https://github.com/Gentleman-Programming/gentle-shell"><img src="https://img.shields.io/github/last-commit/Gentleman-Programming/gentle-shell?style=for-the-badge&labelColor=1A1218&color=D7A0B8" alt="Último commit"></a>
</p>

<p align="center">
  <strong>
    <a href="https://gentle-ai.gentlemanprogramming.com/">Sitio web</a>
    &nbsp;·&nbsp;
    <a href="#get-started">Inicio rápido</a>
    &nbsp;·&nbsp;
    <a href="#documentation">Documentación</a>
    &nbsp;·&nbsp;
    <a href="https://gentle-ai-wiki.gentlemanprogramming.com/">Wiki</a>
  </strong>
</p>

<br>

<p align="center">Tu terminal puede ejecutar un agente. Tu espacio de trabajo debería ayudarte a dirigirlo.<br><strong>gentle-shell es tu agente de código, que reúne tus cambios, tareas y flujo de ingeniería — creado para Pi.</strong></p>

<div align="center">
 <h3>🎬 Míralo en acción</h3>

    <p>
    Una sola instrucción, de la idea al commit revisado: memoria, flujo de trabajo y evidencia en una sesión real.
    </p>

https://github.com/user-attachments/assets/fa5c0cfe-06e7-4c0d-bd6e-8ac7cb934339


<details>
<summary><kbd>Ver</kbd> <strong>¿Prefieres subtítulos en español?</strong> — la misma demo con subtítulos en español</summary>

<br>

https://github.com/user-attachments/assets/6d2bc422-a4dd-4ecf-a04b-fcd3bea7fea9


</details>

</div>

<p align="center"><strong>HECHO PARA PI</strong> &nbsp;·&nbsp; Conformado por Gentle-AI &nbsp;·&nbsp; Espacio de trabajo de agente de código &nbsp;·&nbsp; Agentes especializados &nbsp;·&nbsp; ODD</p>

<p align="center">
  <img src="docs/assets/brand/terminal-divider.svg" width="480" alt="">
</p>

<a id="whats-new-in-v41"></a>

## ✨ Novedades en v4.1

La [versión v4.1.0](https://github.com/Gentleman-Programming/gentle-shell/releases/tag/v4.1.0) hace instalar Gentle Shell en una máquina limpia y fija Gentle AI v4.1.1:

- **Instaladores para máquina limpia:** un asistente en el navegador e instaladores de doble clic para macOS, Windows y Linux instalan lo que falta, actualizan lo que tienes y preguntan una sola vez antes de cambiar nada. Ver [Inicio rápido](#get-started).
- **Gentle Shell empaquetado:** una instalación nueva mantiene su Pi exacto, su Gentle AI fijo, Engram y su estado en un único prefijo; las instalaciones globales existentes pueden migrar, el lanzador ofrece actualizaciones y `gentle-shell self-uninstall` lo elimina.
- **Trabajos en segundo plano y monitores:** `bash_background` avisa al agente una vez cuando termina un comando, y `monitor` convierte cada línea de salida de un comando largo en un evento. Inspecciónalos con `/gentle:jobs` ([Trabajos en segundo plano](#background-jobs)).
- **Permisos automáticos contextuales:** Auto decide con el contexto de la conversación y la entrada de imagen, reintenta los fallos del proveedor y puede ser el valor predeterminado guardado ([Modos de permiso](#permission-modes--normal-auto-or-yolo)).
- **Coordinación entre sesiones:** las sesiones publican un asunto reconocible, alias de tareas, alcance del repositorio y una clasificación acotada del trabajo que otras sesiones pueden listar, buscar y consultar con permiso de coste explícito.
- **Perfiles vinculados a la sesión:** el perfil activo se vincula a la sesión padre, y el enrutado del orquestador y del revisor se aplica por sesión.
- **Delega con motivo y revisa por riesgo:** ver [Agentes especializados](#focused-agents--context-with-a-return-path), [ODD](#odd--the-everyday-workflow) y [Revisión nativa](#native-review--review-the-exact-change).

<p align="center">
  <img src="docs/assets/brand/terminal-divider.svg" width="480" alt="">
</p>

<a id="features"></a>

<a id="how-it-works"></a>

## 🧠 Cómo funciona

### el Gentleman — Piensa antes de construir

<img width="100%" src="docs/assets/diagrams/gentleman-workflow.svg" alt="flujo de el Gentleman en seis pasos: das la intención; el Gentleman aclara el alcance, elige el siguiente paso razonable, hace el trabajo y recoge evidencia que la gente puede revisar; la decisión final sigue siendo tuya">

Di una vez lo que necesitas y sigue adelante. el Gentleman ayuda a convertir la intención en alcance claro, un siguiente paso razonable y evidencia que la gente puede revisar, sin que cada tarea parezca una reunión de proceso.

**[Documentación →](docs/readme-reference.md#organic-driven-development)**

---

### ODD — El flujo de trabajo cotidiano

<img width="100%" src="docs/assets/diagrams/odd-workflow.svg" alt="Desarrollo orgánico guiado (ODD) como siete pasos numerados en un flujo de izquierda a derecha: Autorizar, Explorar y Resolver la incertidumbre para entender; Clasificar bifurca para que el trabajo pequeño siga ligero mientras el sustancial llega al paso cinco, Registrar, con un documento de funcionalidad; ambas rutas convergen en Implementar tarea por tarea y luego Cerrar con pruebas verificadas, sobre una banda que señala que un documento de funcionalidad reflejado en Engram permite retomar el trabajo entre sesiones">

**El desarrollo orgánico guiado (ODD)** es el camino cotidiano: el agente explora antes de cambiar nada, aclara solo las decisiones reales y mantiene pequeño el trabajo entendido y pequeño. El trabajo autorizado y sustancial obtiene un único documento de funcionalidad recuperable — reflejado en la memoria cuando está disponible — para que el progreso, la evidencia y el siguiente paso sobrevivan a una interrupción; los cambios de comportamiento son dirigidos por pruebas de forma predeterminada cuando aplica una prueba ejecutable.

Las tareas se dimensionan por entendimiento, riesgo y capacidad de reanudación: el trabajo que podrías terminar a partir de la petición y `git diff` solo se ejecuta en línea, sin subagentes ni documento de tareas. El documento de funcionalidad cita tu especificación literalmente, y cada entrega apunta a él en lugar de parafrasearlo, de modo que las cadenas exactas, los mensajes de error y los ejemplos lleguen intactos a los trabajadores.

**[Documentación →](docs/readme-reference.md#organic-driven-development)**

---

### Agentes especializados — Contexto con camino de vuelta

<img width="100%" src="docs/assets/diagrams/agent-orchestration.svg" alt="Diagrama de una sesión padre que envía tareas a un explorador de solo lectura, escritores paralelos y un verificador independiente, cada uno devolviendo su resultado observado al padre, que sigue siendo responsable">

Trae ayuda sin perder el hilo. Los agentes Pi especializados y propios del paquete pueden mapear una base de código, implementar un cambio acotado o verificarlo, mientras una sola instancia padre se mantiene responsable del alcance, las decisiones y el resumen final.

El padre delega por una razón, no por tamaño. El entendimiento que desborda un lote en línea (unas 3 llamadas y 10k tokens) obtiene un explorador de solo lectura; dos o más unidades independientes con superficies de edición disjuntas obtienen escritores paralelos; un cambio de alto riesgo obtiene un verificador independiente; una sesión larga entrega su siguiente unidad a un trabajador nuevo. Sin un motivo nombrado, el padre trabaja en línea: el número de archivos y el tamaño de la tarea nunca deciden la ruta.

**[Documentación →](docs/readme-reference.md#how-the-harness-decides-what-to-do)**

---

### Medido — Lo que cambió el enrutado proporcional

<img width="100%" src="docs/assets/diagrams/measured-routing.svg" alt="Gráfico de barras del tiempo de pared antes y después del enrutado proporcional: un bug de 3 líneas cayó de 335 a 77 segundos en línea, un bug de lógica compartida de 479 a 276 segundos con un explorador, y una migración de datos de alto riesgo pasó de 559 a 539 segundos pero fue aceptada a la primera con un verificador independiente">

Las reglas de enrutado salieron de benchmarks. Estas ejecuciones usan un benchmark local con suites de aceptación ocultas; cada celda es una ejecución única (n=1) y el coste es equivalente al de la API.

| Escenario | Antes | Después |
| :--- | :--- | :--- |
| Bug de 3 líneas en una función | 335 s · 56 turnos · $0,339 | **77 s · 10 turnos · $0,105** — en línea, sin subagentes |
| Bug enraizado en lógica compartida | 479 s · $0,361 | **276 s · $0,207** — un explorador |
| Migración de datos (alto riesgo) | 559 s · $0,403 · necesitó una ronda de retroalimentación | 539 s · $0,555 · **aceptado a la primera** — un verificador independiente |
| Especificación de 73 líneas, 26 comprobaciones ocultas | Entregas parafraseadas: 13 fallos, aún 23/26 tras dos rondas | Passed by reference ([#1718](https://github.com/Gentleman-Programming/gentle-shell/pull/1718)) |

Frente al mismo modelo en Codex CLI, con revisión ciega de cada solución, Gentle Shell fue aceptado a la primera en todas las celdas y quedó por encima en las tareas medias (3 de 3 ejecuciones) y grandes; fue ajustado en la pequeña. La tarea grande aún tardó unas tres veces más (17,5–17,9 min frente a 6,1 min); esa brecha es trabajo pendiente. Fuentes: [#1723](https://github.com/Gentleman-Programming/gentle-shell/pull/1723), [#1794](https://github.com/Gentleman-Programming/gentle-shell/pull/1794), [#1713](https://github.com/Gentleman-Programming/gentle-shell/issues/1713).

---

### Revisión nativa — Revisa el cambio exacto

<img width="100%" src="docs/assets/diagrams/native-review.svg" alt="Diagrama de un candidato congelado que pasa por una revisión acotada por riesgo hasta un resultado evidente, con un camino de corrección acotado de vuelta al candidato, mientras un límite separado mantiene contigo la decisión de qué se envía">

Revisa el cambio exacto, no un objetivo móvil. La revisión nativa mantiene un candidato a la vista, devuelve evidencia acotada por el riesgo y puede mostrar un camino de corrección acotado. Tú sigues decidiendo qué ocurre después en tu repositorio.

La revisión es proporcional: la verificación sigue el nivel de riesgo en cada estado de RDD, una revisión solo es necesaria para trabajo de alto riesgo y el agente reenvía los lentes 4R que encajan con lo tocado — con su motivo — en lugar de pagar los cuatro.

> ℹ️ **RDD es opcional:** activa el desarrollo dirigido por recibos nativo solo mediante una decisión explícita de `/gentle:review-mode enable`. El padre `.git/gentle-ai/candidate-views` debe estar en un sistema de archivos que respete los modos privados POSIX (o los ACL equivalentes en Windows); los montajes WSL DrvFS sin metadatos pueden rechazar START antes de crear la línea base.

<details>
<summary><kbd>Más</kbd> <strong>Transporte del revisor</strong> — cómo siguen las completaciones de la revisión la configuración de transporte de Pi</summary>

<br>

Las completaciones del revisor heredan la preferencia de `transport` efectiva de Pi cuando se ejecuta una captura individual o agrupada reconocida. El host reenvía un valor definido sin modificarlo, con una única instantánea de configuración por grupo; nunca fuerza SSE ni cambia el enrutado de modelos. Una configuración ausente o una API de Pi antigua sin `getSettings()` conserva el valor predeterminado del proveedor. Esta preferencia de completación es independiente de la coordinación nativa `pi_host_relay`, y los proveedores que no la soporten pueden ignorarla.

</details>

<br>

**[Documentación →](docs/review-integration.md)**

<p align="center">
  <img src="docs/assets/brand/terminal-divider.svg" width="480" alt="">
</p>

<a id="your-workspace"></a>

## 🖥️ Tu espacio de trabajo

### gentle-shell — Tu agente de código, en el espacio de trabajo que lideras

<img width="100%" src="https://github.com/user-attachments/assets/5d9eefc2-7b2a-48f8-b212-1439834ce195" alt="gentle-shell ejecutando una sesión de agente en vivo: una fila de cabecera con rama, modelo y medidor de contexto sobre la transcripción, con tarjetas de estado, cambios y tareas pendientes en la barra lateral derecha">

Un terminal desnudo responde a "qué está haciendo el agente" solo con el desplazamiento. gentle-shell convierte tu sesión Pi en un espacio de trabajo: orquestación de agentes, cambios en vivo y estado del entorno, supervisión de uso de las cuentas de proveedor compatibles y vistas de diferencias integradas, para que dirijas el trabajo en lugar de perseguirlo.

<p align="center"><sub>gentle-shell en acción. Captura de <a href="https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/docs/assets/features/gentle-shell.png">Gentle-AI</a>.</sub></p>

**[Documentación →](docs/gentle-shell.md)**

---

### Gentle Changes — Lo que tu sesión dejó sin confirmar

<img width="100%" src="docs/assets/features/changes-view.png" alt="Visor Gentle Changes: acordeón de copias de trabajo con estado por archivo a la izquierda, el diff contra HEAD con recuentos de líneas a la derecha, y una fila de atajos">

No deberías tener que ejecutar `git status` en cada copia de trabajo para saber lo que dejaron tus agentes. Gentle Changes muestra el estado actual de Git — árbol de trabajo contra HEAD, incluidos los archivos no rastreados — del repositorio de tu sesión más cada copia de trabajo que usaron tus subagentes, un grupo por raíz. Confirma un commit y desaparece; elimina una copia de trabajo y se va con ella. Nada se ejecuta al arrancar; `alt+g` abre un visor a pantalla completa de dos paneles con recuento de líneas por archivo y diffs cargados bajo demanda, `F` oculta la lista de archivos para leer el diff a ancho completo y `o` abre el archivo real en tu editor.

**[Documentación →](docs/gentle-shell.md#browse-changes)**

---

### Gentle Agents — Trabajo paralelo con vista en vivo

<img width="100%" src="docs/assets/features/agents-view.png" alt="Superposición Gentle Agents mostrando un hilo de subagente completado con columnas de modelo, tokens y tiempo transcurrido, y la entrega estructurada que devolvió">

Delegar trabajo no debería significar perderlo. Cada subagente se ejecuta como su propio proceso con una tarjeta en vivo sobre el editor — modelo, tokens, coste, tiempo — y `alt+a` abre la vista completa con hilos retenidos, controles de parada e historial restaurado al reanudar. Un hijo puede hacerte una pregunta como un diálogo ordinario, y los resultados en segundo plano vuelven como tarjetas que inician un nuevo turno: nada hace polling.

**[Documentación →](docs/gentle-shell.md#gentle-agents)**

---

### Perfiles y enrutado de modelos — Una decisión deliberada por control

<img width="100%" src="docs/assets/features/profiles-routing.png" alt="Vista de perfiles: lista de perfiles a la izquierda, modelo del orquestador y esfuerzo a la derecha, con enrutado por rol y enrutado efectivo actual">

El modelo, el esfuerzo y quién hace qué deben ser elecciones, no accidentes. Los perfiles con nombre enrrutan el orquestador de forma atómica e independiente de los roles empaquetados y de revisión; un repositorio puede fijar su perfil para que sus subagentes dejen de seguir el activo global, y el panel siempre muestra el enrutado que el entorno realmente usa.

**[Documentación →](docs/readme-reference.md#agent-model-profiles)**

---

### Paleta de comandos — Cada comando, a una tecla de distancia

<img width="100%" src="docs/assets/features/command-palette.png" alt="Paleta de comandos abierta sobre la sesión: una petición de búsqueda sobre entradas agrupadas en Configuración, Sesión y Diagnóstico, con atajos alt+g y alt+a a la derecha y una fila de pistas de tecla debajo">

Los comandos de las extensiones solo son útiles si puedes encontrarlos. `alt+k` abre una paleta curada y agrupada — Configuración, Sesión, Diagnóstico y Skills — buscable por etiqueta, nombre de comando o descripción, mostrando entradas solo cuando están realmente registradas.

**[Documentación →](docs/gentle-shell.md#command-palette)**

---

### Personalizar — Aspecto, diseño y editor en un panel

`/gentle:customize` abre un panel interactivo para ajustar la calidad de la animación, la rosa del banner de arranque, el logotipo de texto y el color o elegir un tema de Pi instalado.

<details>
<summary><kbd>Más</kbd> <strong>Todo lo que controla `/gentle:customize`</strong> — temas, diseño de estado, Vim, historial y perfiles visuales</summary>

<br>

- **Temas:** resaltar un tema previsualiza su paleta de origen sin cambiar el tema activo; pulsa Intro o Espacio para aplicarlo mediante Pi. Si su origen no se puede leer, la previsualización no está disponible.
- **Diseño de estado:** el estado usa de forma predeterminada una barra lateral derecha en terminales a pantalla completa de al menos 140 columnas, y una barra inferior en otros casos. Elige derecha, abajo u oculto (que elimina tanto la barra lateral como la barra de estado inferior en cualquier anchura), mueve la cabecera a pantalla completa por debajo de la entrada (por debajo del límite de 140 columnas solo se pinta una fila de estado: una cabecera superior sustituye a la barra inferior, mientras que con la cabecera por debajo de la entrada solo la barra inferior transporta el contexto, el coste y el uso de la cabecera más los estados de las extensiones), selecciona densidad cómoda/compacta/mínima y conmuta independientemente Changes, Agents, TODO, uso/coste y detalles del modelo. Los cambios de diseño y el restablecimiento surten efecto de inmediato; los cambios de banner aparecen en el próximo arranque.
- **Vim:** la categoría Editor ofrece controles explícitos para activar o desactivar Vim en la preferencia global de petición; resaltar muestra la preferencia persistida y el estado efectivo de la petición sin cambiar ni el uno ni el otro. Intro o Espacio lo guarda y actualiza la petición en vivo; los editores no compatibles siguen con edición ordinaria aunque la preferencia guardada esté activa. Vim no se incluye en los perfiles visuales ni en el restablecimiento visual.
- **Historial:** la categoría History activa o desactiva la captura del historial de peticiones; está desactivada de forma predeterminada, se aplica a la siguiente petición sin reinicio y nunca borra el historial almacenado. Un valor explícito de `GENTLE_PI_HISTORY_CAPTURE` sustituye a la opción guardada, y el panel lo marca (ver [Historial de peticiones](docs/prompt-history.md)).
- **Restablecer y perfiles:** el panel puede restablecer los ajustes visuales, de banner y de animación a los valores predeterminados. Pulsa `p` para los perfiles visuales con nombre: `s` guarda el tema instalado, el banner, la animación y el diseño actuales; selecciona un perfil con ↑/↓ y luego usa `r` para reemplazar, `a` para aplicar o `d` para eliminar. `z` borra solo el catálogo de perfiles. Confirma las acciones destructivas o de aplicación con `y`, o cancela con cualquier otra tecla; Esc regresa sin aplicar una previsualización. La aplicación de almacenes independientes no es atómica: los fallos parciales identifican lo que cambió.

</details>

<br>

**[Estilo de tarjetas y contenido →](docs/gentle-shell.md#card-style)**

---

### Notificaciones de audio — Sonidos opcionales de éxito, error y atención

<img width="100%" src="docs/assets/features/audio-notifications.png" alt="Panel Personalizar con la categoría Notificaciones seleccionada: notificaciones de audio activadas y sin silenciar, tonos de éxito, error y atención, una fila Avanzado para excepciones por evento y una línea de previsualización para el conmutador global">

Abre `/gentle:customize` → **Notifications** (la cabecera de la tarjeta lee **Audio notifications**) y configura el audio directamente en la misma tarjeta de dos columnas, sin menú anidado. El audio empieza desactivado; RPC e hijos permanecen en silencio.

<details>
<summary><kbd>Más</kbd> <strong>Controles y compatibilidad por plataforma</strong> — teclas, sonidos personalizados y reproducción por sistema operativo</summary>

<br>

- **Controles:** Intro conmuta el interruptor maestro o recorre un tipo/evento por silencio/éxito/error/atención, `f` asigna un sonido WAV/OGG/FLAC local literal y absoluto (≤2 MiB, ≤10 segundos) al tipo **Éxito**, **Error** o **Atención** resaltado (cada tipo conserva su propio sonido) y `p` previsualiza su sonido asignado. **Avanzado** pliega las excepciones por evento; las elecciones por tipo se mantienen independientes.
- **Respuesta rápida (Linux/WSLg):** en Linux puro el paquete instalado prefiere el backend WAV nativo y no necesita reproductor externo: habla con un socket Unix local de PulseAudio/PipeWire-Pulse y requiere un servidor en ejecución con un sink predeterminado.
- Dentro de **WSL** se prefiere el `SoundPlayer` del sistema Windows: la instantánea WAV validada se asigna a una ruta UNC `\\wsl.localhost\<distro>\...`, por lo que no se requiere servidor Pulse ni dependencia de audio por RDP; depende del montaje automático predeterminado `/mnt/c` y de la raíz estándar `C:\Windows` y, en caso contrario, recurre al CLI de Linux de confianza antes de cualquier reproducción.
- El WAV en **Windows nativo** usa el mismo `SoundPlayer` del sistema a través del host fijo `C:\Windows\...\powershell.exe`. Aquí se superó una sonda de solo lectura, pero eso no es una afirmación de audio físicamente escuchado.
- OGG/FLAC conserva el backend CLI heredado (`paplay`/`pw-play`/`aplay`) en Linux y WSL; los códecs nativos son una fase futura y OGG/FLAC en Windows no está soportado. macOS conserva `afplay` para WAV y FLAC mientras está planeada una fase propia con CoreAudio.

</details>

<br>

**[Uso, límites y verificación →](docs/sound-notifications.md)**

---

<a id="background-jobs"></a>

### Trabajos en segundo plano — Inspecciona lo que se ejecuta en segundo plano

Usa `/gentle:jobs` para inspeccionar los comandos en segundo plano y monitores de esta sesión. Los trabajos en ejecución aparecen primero; cada grupo se ordena con lo más reciente arriba. Las flechas seleccionan un trabajo, `Tab` abre los detalles en terminales estrechas, `s` detiene un trabajo en ejecución y `q` cierra el modal.

El panel de estado tiene una sección **Jobs** con la descripción de cada trabajo en ejecución. Cuando el panel está oculto o no disponible en el diseño compacto/móvil, la barra superior o inferior muestra solo el número de trabajos en ejecución (`⧗ 1 job`). El número y las descripciones desaparecen cuando no quedan trabajos activos; `/gentle:jobs` conserva los trabajos completados para inspección.

**[Documentación →](docs/gentle-shell.md#background-jobs)**

<p align="center">
  <img src="docs/assets/brand/terminal-divider.svg" width="480" alt="">
</p>

<a id="control"></a>

## 🛡️ Control

### Modos de permiso — Normal, Auto o YOLO

<img width="100%" src="docs/assets/diagrams/permission-modes.svg" alt="Tres modos de permiso, de más a menos preguntas: Normal mantiene los avisos habituales, Auto deja decidir a una comprobación independiente y no ejecuta decisiones no disponibles ni caducadas, YOLO da permiso permanente para el trabajo acotado mientras las acciones destructivas siguen preguntando; en todos los modos se mantienen las restricciones explícitas, las salvaguardas destructivas y el consentimiento independiente">

Elige `/gentle:mode auto` para comprobar las acciones elegibles con una inferencia independiente usando el modelo actual de la sesión. Las comprobaciones ordinarias no usan herramientas; una comprobación elegible de un script puede inspeccionar como máximo dos archivos completos ([límites de inspección](docs/auto-permission-evidence.md)).

<details>
<summary><kbd>Más</kbd> <strong>Cobertura, valores predeterminados y alcance</strong> — qué comprueba Auto, su coste y cómo convertirlo en predeterminado</summary>

<br>

Auto cubre las herramientas principales de archivos/shell/personalizadas/MCP y las llamadas anidadas a través de la canalización del SDK, manteniendo las restricciones explícitas, las salvaguardas destructivas y el consentimiento independiente. Añade por separado coste y latencia de inferencia registrados; las decisiones no disponibles o caducadas no ejecutan la acción. Esto no es un entorno aislado ni una afirmación de paridad con un clasificador propietario.

Guarda `/gentle:mode default auto` o `/gentle:mode default yolo` para usar cualquiera de los modos opcionales en las nuevas sesiones primarias. `/gentle:mode normal` cambia solo esta sesión; `/gentle:mode default normal` cambia las sesiones futuras. Los hijos mantienen sus reglas de delegación existentes, no el modo elevado del padre.

</details>

<br>

**[Comandos, alcance, coste y límites →](docs/permission-modes.md)**

---

### 🚀 YOLO 🔥 — Permiso acotado, salvaguardas destructivas intactas

> 🚀 **Para adelante de verdad, las acciones destructivas siguen preguntando.** YOLO elimina las preguntas repetidas de permiso para el trabajo ordinario ya acotado, lo que encaja con ejecuciones autónomas largas. Las operaciones destructivas siguen exigiendo confirmación reciente.

`/gentle:yolo enable` otorga permiso permanente para la implementación ordinaria ya acotada, las comprobaciones, las confirmaciones, las publicaciones no forzadas y la creación de PR.

<details>
<summary><kbd>Más</kbd> <strong>Cómo se comporta YOLO</strong> — qué sigue preguntando, cómo apagarlo y el conmutador Personalizar</summary>

<br>

- **Predeterminado:** **DESACTIVADO** salvo que se seleccione o guarde como valor global predeterminado, con controles TUI interactivos del primario y vinculación en vivo de sesión/espacio de trabajo; `/gentle:yolo disable` lo revoca y `/gentle:yolo status` lo comprueba.
- **Menú:** sin argumento, `/gentle:yolo` abre un menú (`enable`, `disable`, `status`) que muestra el estado actual; cancelar no cambia nada y, sin menú interactivo, informa del estado.
- **Vida útil:** la recarga y el reemplazo de la sesión revocan las concesiones en vivo; las nuevas instancias primarias pueden aplicar el valor predeterminado global guardado.
- **Estado:** un estado activo más un elemento aparte muestran **🚀 YOLO ON 🔥 — las confirmaciones destructivas siguen activas**.
- **Todavía obligatorio:** las restricciones explícitas, las confirmaciones/bloqueos configurados, las elecciones consecuentes no resueltas, la ambigüedad de destino/credenciales y las decisiones nativas de consentimiento/recuperación siguen siendo obligatorias. Los hijos no obtienen ninguna concesión independiente de entrega. Esto no es un entorno aislado.

- **Desde Personalizar:** o abre `/gentle:customize` → **Editor** y selecciona **YOLO: OFF · solo sesión**, inmediatamente debajo de Vim. Intro o Espacio conmuta el mismo permiso de la sesión en vivo que `/gentle:yolo`; navegar y previsualizar nunca lo activan. Este conmutador en vivo no guarda una preferencia. Las filas independientes **Permisos de sesión** y **Permisos predeterminados** seleccionan respectivamente un modo actual o guardan un valor predeterminado global del usuario; la configuración del repositorio y los perfiles visuales no pueden conceder ninguno de los dos modos.

</details>

<br>

**[Uso y límites →](docs/yolo-mode.md)**

<p align="center">
  <img src="docs/assets/brand/terminal-divider.svg" width="480" alt="">
</p>

<a id="also-in-the-box"></a>

## 📦 También en la caja

| Componente | Qué hace |
| :--- | :--- |
| Arranque y panel de entorno | Un punto de entrada configurable de gentle-shell y estado visible del entorno para Pi. |
| Skills y guía de entrega | Skills del paquete para documentación, trabajo de incidencias, PR, revisiones y unidades de trabajo revisables. |
| Controles de modelo, esfuerzo, persona y perfil | Controles explícitos sobre cómo enrruta y presenta el trabajo Pi. |
| Límites de seguridad | Salvaguardas alrededor de las operaciones destructivas y el manejo de rutas sensibles. |
| Paquetes opcionales acompañantes | Capacidades adicionales que puedes añadir; la memoria persistente **no** va incluida en `gentle-pi`. |
| Diseño de espacio de trabajo a pantalla completa | Fila de cabecera más barra lateral deslizable de Estado → Changes → TODO en terminales anchos. |
| Barra de estado en vivo y pétalo de petición | Medidor de línea, coste y estados; el pétalo muestra `working` y `queued`. |
| Comunicación padre ↔ subagente | Delegar, dirigir, responder y notificación entre sesiones dentro de tu perfil local. |
| Herramientas interactivas nativas | Preguntas, elecciones y capturas de revisión integradas — sin dependencia de terceros. |
| Gentle Todo | Una tarjeta de plan que se vuelve ámbar cuando el modelo deja que se quede obsoleta. |
| Uso de suscripción | Medidores y reinicios por ventana para las cuentas de proveedor compatibles. |
| Gentle Stats | `/gentle:stats` muestra el historial de uso local: mapa de calor de actividad, tokens, coste, rachas y porcentaje por modelo. |
| Avisos de Gentle | Llamadas a Gentle AI y recordatorios de revisión como tarjetas en la transcripción. |

Los mensajes entre orquestadores aparecen como tarjetas compactas `🤖 Remitente → 🤖 Destinatario` con cabeceras de una sola fila. Amplía una tarjeta para inspeccionar los identificadores y motivos disponibles. **Message queued** significa en cola, no entregado ni leído; los nombres largos se recortan para caber en terminales estrechas.

**Cada componente, skill y predeterminado: [Desglose completo →](docs/gentle-shell.md)**

---

<a id="nan-model-provider"></a>

### Proveedor de modelos NaN — Integrado, sin paquete extra

El proveedor `nan` de primera parte está incluido; no se requiere ningún paquete de proveedor de terceros. Define `NAN_API_KEY` antes de iniciar Pi, o usa el `/login` nativo → NaN (también `/login nan`), después Usa `/model` para seleccionar un modelo.

<details>
<summary><kbd>Más</kbd> <strong>Inicio de sesión, descubrimiento de modelos y niveles de razonamiento</strong> — claves de API, modelos disponibles y niveles por modelo</summary>

<br>

- **Inicio de sesión:** ambas rutas de login esperan la entrada explícita de la clave de API; las entradas en blanco o solo espacios fallan sin guardar una credencial, y se recorta el espacio alrededor. Cancelar deja la clave almacenada sin cambios. Las claves guardadas tienen prioridad sobre `NAN_API_KEY`.
- **Streaming:** Pi transmite completaciones de chat a través de su proveedor compatible con OpenAI.
- **Descubrimiento de modelos:** el descubrimiento de modelos interseca la respuesta `/v1/models` del NaN autenticado con un subconjunto mantenido de ID de chat conocidos de la [documentación oficial de modelos](https://nan.builders/docs/models); los ID desconocidos y no conversacionales se omiten. Una respuesta satisfactoria sin ID de chat conocidos queda vacía. Las capacidades documentadas de contexto, razonamiento y texto/imagen se conservan con cotas numéricas conservadoras para límites abreviados; la entrada de audio no se anuncia por Pi.
- **Límites de salida:** la configuración del proveedor establece límites de `maxTokens` en lugar de afirmar máximos no documentados del modelo: 32,768 para GLM 5.3, GLM 5.3 Flash y MiMo; 16,384 para DeepSeek V4 Flash; 65,536 para Gemma 4 y Qwen 3.6; y 131,000 para Qwen 3.8 Flash (NaN documenta 131K). El razonamiento comparte el presupuesto de salida.
- **Reserva sin conexión:** antes de una actualización satisfactoria, los siete modelos de chat documentados están disponibles como reserva sin conexión en `/gentle:models`: `glm5.3`, `deepseek-v4-flash`, `glm5.3-flash`, `qwen3.8-flash`, `mimo-v2.6-flash`, `gemma4` y `qwen3.6`. Esta reserva declara soporte documentado, no prueba de acceso para tu clave. Una vez actualizada, la lista en vivo con ámbito de la clave satisfactoria sigue siendo autorizada (incluida una lista vacía), incluso fuera de línea o tras un fallo de actualización. Cambiar las credenciales restablece el catálogo a la reserva documentada completa hasta que el descubrimiento tenga éxito con la nueva clave.
- **No incluido:** los puentes MCP de búsqueda y medios de NaN no están incluidos.

Los niveles de razonamiento siguen el [contrato de razonamiento](https://nan.builders/docs/models) de NaN:

| Modelos | Niveles de razonamiento de Pi |
| --- | --- |
| GLM 5.3 / GLM 5.3 Flash | `low`, `medium`, `high` y `max` son completamente controlables. Sin `off`; los `minimal` y `xhigh` de Pi se acotan a `low` y `max`. |
| Qwen 3.6 / Gemma 4 | `off` envía `none` y `minimal` también omite el razonamiento; `low`, `medium`, `high` y `max` fijan presupuestos de razonamiento. El `xhigh` de Pi se acota a `max`. |
| DeepSeek V4 Flash / Qwen 3.8 Flash / MiMo | Se aceptan los mismos niveles `off` (`none`), `minimal`, `low`, `medium`, `high` y `max`, pero NaN gestiona su profundidad de razonamiento, así que ningún valor la cambia. El `xhigh` de Pi se acota a `max`. La cabecera informa `effort: auto` para estos tres y un aviso único dice que el nivel no cambia la profundidad. |

</details>

<p align="right"><a href="#top">Volver arriba ↑</a></p>

<p align="center">
  <img src="docs/assets/brand/terminal-divider.svg" width="480" alt="">
</p>

<a id="get-started"></a>

## ⚡ Inicio rápido

> ℹ️ **Transición de nombres:** el producto se llama `gentle-shell`; el paquete de npm y el repositorio siguen siendo `gentle-pi` hasta la migración.

**¿Qué camino es el mío?**

| Si tú… | Usa |
| :--- | :--- |
| Quieres la configuración más sencilla, sin terminal | [Descargar y hacer doble clic](#easiest-download-and-double-click-no-terminal-needed) |
| Trabajas desde un clon de este repositorio | [Ruta C: instalador en navegador desde un checkout](#path-c-browser-installer-from-a-checkout) |
| Te desenvuelves bien con npm y quieres que Pi no se toque | [Ruta A: `gentle-shell` independiente](#path-a-standalone-gentle-shell-recommended-no-pi-changes) |
| Ya usas Pi y quieres el paquete dentro de él | [Ruta B: dentro de un pi existente](#path-b-inside-an-existing-pi) |

### Más sencillo: descargar y hacer doble clic (sin terminal)

Descarga el instalador para tu ordenador, haz doble clic y sigue los pasos en el navegador. Instala todo lo que necesita Gentle Shell (Node.js, pnpm, Pi y Gentle Shell), o actualiza lo que ya tengas, y no instala nada hasta que confirmas el plan que te muestra. (Para mostrar ese plan puede descargar antes Node.js y pnpm en una carpeta temporal, que borra después.)

| Tu ordenador | Descarga | Después |
| --- | --- | --- |
| **macOS** | [gentle-shell-installer-macos.zip](https://github.com/Gentleman-Programming/gentle-shell/releases/latest/download/gentle-shell-installer-macos.zip) | Abre el zip, después haz doble clic en **Install Gentle Shell.command** dentro de la carpeta *Gentle Shell Installer*. |
| **Windows** | [gentle-shell-installer-windows.zip](https://github.com/Gentleman-Programming/gentle-shell/releases/latest/download/gentle-shell-installer-windows.zip) | Haz clic derecho en el zip → **Extract All**. Abre la carpeta extraída, después la carpeta *Gentle Shell Installer* dentro, y haz doble clic en **Install Gentle Shell.cmd**. No se ejecuta desde dentro del zip. |
| **Linux** | [gentle-shell-installer-linux.tar.gz](https://github.com/Gentleman-Programming/gentle-shell/releases/latest/download/gentle-shell-installer-linux.tar.gz) | Extráelo, después haz doble clic en **install-gentle-shell.sh**. Si tu gestor de archivos no ejecuta scripts, ejecuta `sh install-gentle-shell.sh` en esa carpeta. |

Se abre una ventana pequeña, después el instalador aparece en tu navegador. Usa la pestaña que se abre y mantén la ventana pequeña abierta hasta que el instalador diga que ha terminado.

> ⚠️ **Tu ordenador te avisará la primera vez.** Estos instaladores no están firmados con un certificado de desarrollador de Apple ni de Microsoft, así que el sistema no puede verificar quién los hizo. Ese aviso es esperado; así se continúa:
>
> - **macOS:** ves *"Install Gentle Shell.command" Not Opened* (o *cannot be opened because Apple cannot check it*). Pulsa **Done**, abre **Ajustes del sistema → Privacidad y seguridad**, baja hasta el mensaje sobre *Install Gentle Shell.command*, pulsa **Open Anyway** y confirma con tu contraseña. En versiones antiguas de macOS puedes hacer clic derecho en el archivo, elegir **Open** y después **Open** de nuevo. Solo haces esto una vez.
> - **Windows:** ves *Windows protected your PC*: pulsa **More info**, después **Run anyway**. Si en su lugar ves *Open File – Security Warning*, pulsa **Run**.
> - **Linux:** si el doble clic abre el archivo en un editor, ejecuta `sh install-gentle-shell.sh` en esa carpeta.
>
> Descarga solo desde la página de [Releases](https://github.com/Gentleman-Programming/gentle-shell/releases) de este repositorio. Para comprobar una descarga, compara su SHA-256 con [gentle-shell-installers-SHA256SUMS.txt](https://github.com/Gentleman-Programming/gentle-shell/releases/latest/download/gentle-shell-installers-SHA256SUMS.txt).

Una instalación nueva obtiene Gentle Shell como un producto completo y autocontenido. Su propio Node.js, npm, pnpm y Pi viven en `~/.gentle-shell`, y tus propias herramientas no se usan ni se modifican ([instalación empaquetada](docs/install-wizard.md#bundled-installation)).

El instalador es una vista previa: está probado en Linux y en CI, mientras las ejecuciones en máquina limpia en macOS y Windows todavía se están verificando. Cómo funciona y qué cambia: **[asistente de instalación](docs/install-wizard.md)**.

### Ruta C: instalador en navegador desde un checkout

El mismo instalador que la [descarga anterior](#easiest-download-and-double-click-no-terminal-needed), iniciado desde un clon en lugar de una descarga:

```bash
git clone https://github.com/Gentleman-Programming/gentle-shell.git
cd gentle-shell

# macOS y Linux
sh scripts/bootstrap.sh

# Windows (cmd)
scripts\bootstrap.cmd
```

Instala lo que falta (Node.js, pnpm, Pi, Gentle Shell) y actualiza un Gentle Shell existente o un Pi más antiguo; nada cambia hasta que confirmas. El bootstrap introduce Node.js y pnpm en una carpeta temporal si faltan, después abre el asistente en tu navegador en una dirección privada `127.0.0.1`. Usa la pestaña que se abre: el enlace funciona una sola vez y caduca tras 2 minutos. En la pantalla de revisión, elige qué instalar:

- **Última versión** (recomendada): el Gentle Shell publicado con su binario Gentle AI fijo.
- **Último main**: construcciones de desarrollo de Gentle Shell y Gentle AI desde el último commit de `main`, construido en tu ordenador con Go. Si tu Go falta, es antiguo o no se puede comprobar su versión, el instalador descarga su propio Go fijo y verificado solo para esa construcción.

<details>
<summary><kbd>Más</kbd> <strong>Cómo trata el instalador las herramientas que ya tienes</strong> — qué reutiliza, actualiza o deja como está</summary>

<br>

- **Node.js y pnpm:** un Node.js más antiguo o un pnpm incompatible (de mise, nvm, nvm-windows, fnm, Volta o Homebrew, por ejemplo) se deja intacto: el instalador usa su propia copia fija y verificada e la instala bajo `$PNPM_HOME`, y el plan lo dice antes de que confirmes; un gestor de versiones puede seguir poniendo tu propia versión primero en las terminales nuevas. Esto aplica solo a una instalación nueva: con Gentle Shell ya instalado, un Node.js más antiguo o un pnpm incompatible siguen bloqueando. En Windows, `bootstrap.cmd` también usa su propio Node.js cuando no puede verificar dónde vive el tuyo (un enlace simbólico de nvm-windows o un punto de unión de fnm, por ejemplo), sin ejecutar el tuyo.
- **Tu pnpm:** un pnpm en el directorio bin global de pnpm (`$PNPM_HOME/bin`) nunca se reemplaza ni se degrada: se usa tal cual pnpm 11.1.1 o posterior, incluido pnpm 12; uno más antiguo bloquea con el comando `pnpm self-update` que lo actualiza, y uno cuya versión no se pudo comprobar se deja como está mientras el instalador usa su propio pnpm verificado, que el plan dice antes de que confirmes.
- **npm:** un `npm` operativo en tu `PATH` (de Node.js, Homebrew, nvm, nvm-windows, fnm, mise, asdf o Volta, por ejemplo) se usa tal cual; el instalador añade su propio npm solo cuando no funciona ninguno.
- **Windows:** en Windows nunca ejecuta `npm.cmd` ni `pnpm.cmd` a través de un shell: ejecuta lo que ejecuta un shim reconocido, o el propio `.exe`, y trata cualquier otro shim como no utilizable. También comprueba que ninguna otra cuenta pueda cambiar la carpeta principal de pnpm (`PNPM_HOME`), y nunca ejecuta un pnpm desde una carpeta que otra cuenta pueda cambiar (ni uno cuya naturaleza de pnpm no se pueda probar, como el `pnpm.cmd` de Corepack): usa en su lugar su propio pnpm verificado y deja el tuyo como está. Cuando el `%LOCALAPPDATA%\pnpm` predeterminado de pnpm falla en ese control y todavía no contiene nada, usa `%USERPROFILE%\.pnpm` en su lugar y `pnpm setup` lo guarda para terminales nuevas; los comandos de pnpm que ejecutes más tardes siguen conservando la configuración, la caché y el estado de pnpm bajo `%LOCALAPPDATA%`, un riesgo aceptado que el plan indica. Cuando esa carpeta ya contiene archivos, o tu propio `PNPM_HOME` no supera el control, se detiene y nombra la carpeta, la cuenta y sus derechos. El plan lo dice antes de que confirmes.
- **Tus herramientas existentes:** tu Node.js, npm, Go, Pi o gentle-pi instalado con npm se usan como ya los usas; cuando uno vive en una carpeta que otra cuenta puede cambiar, el plan nombra esa carpeta, la cuenta y sus derechos como aviso, sin bloquear.
- **Go:** cuando una construcción necesita Go (el canal main o Windows) y el tuyo falta, es antiguo o no se puede comprobar su versión, el instalador descarga un Go fijo de go.dev, verifica su suma de comprobación y lo usa solo para construir, desde su propia carpeta; tu Go y tu `PATH` quedan intactos, y el plan lo dice antes de que confirmes. Una instalación en versión publicada en macOS o Linux nunca descarga Go.
- **Git:** Git no es necesario para instalar; cuando falta, el plan lo dice antes de que confirmes, con el comando para instalarlo, porque la revisión de código, las copias de trabajo y las funcionalidades del repositorio lo necesitan.
- **Pi:** un Pi existente que cumple el mínimo se reutiliza tal cual. Con pnpm 11, Gentle Shell puede ejecutar un Pi más nuevo que el del instalador que pnpm coloca a su lado (siempre al menos el mínimo); el instalador dice cuál es al terminar. Un Pi más antiguo se actualiza a la versión que instala el instalador, con el gestor de paquetes que lo instaló (pnpm o npm); el plan muestra las versiones encontrada y objetivo antes de que confirmes. Un Pi más antiguo que no gestiona ninguno de los dos (mise, Homebrew o un binario independiente, por ejemplo) se deja intacto, y el instalador añade su propio Pi con pnpm, como cuando falta Pi; Gentle Shell usa ese. Pi nunca se degrada.
- **Gentle Shell:** un Gentle Shell existente se actualiza con el gestor de paquetes que lo instaló (pnpm o npm); uno que no puede atribuirse, como un `npm link` de un checkout de código fuente, se deja intacto y se explica. No se necesitan dependencias del checkout (`pnpm install` no es necesario).

</details>

<br>

Detalles: **[asistente de instalación](docs/install-wizard.md)**.

### Ruta A: `gentle-shell` independiente (recomendada, sin cambios en Pi)

`gentle-shell` abre Pi con el paquete Gentle Shell cargado, sin instalarlo en tu agente pi ni editar su `settings.json`. Requiere Pi 1.2.0 o posterior.

```bash
npm i -g gentle-pi

# Home propio, nunca toca tu instalación de pi
gentle-shell

# Reutiliza en su lugar tus inicios de sesión, modelos y chat de pi
gentle-shell --link
```

`gentle-shell` solo arranca en su propio home, `~/.gentle-shell/agent`, mantiene su configuración en `~/.gentle-shell/gentle-ai` (copiada una sola vez desde `~/.pi/gentle-ai` en el primer arranque que la necesite) y prepara ese home en la primera ejecución: no hay paso aparte. Gentle Shell mantiene su propio home con los paquetes acompañantes de Gentle AI y sin plugins conflictivos; gentle-pi sigue siendo la copia propia de este lanzador, nunca una instalada en el home; tu instalación de pi no se toca. Ese home también usa de forma predeterminada el tema Gentleman-Cute salvo que configures el tuyo. `gentle-shell --link` reutiliza `~/.pi/agent` tal cual, nunca se aprovisiona automáticamente y nunca se toca su tema.

```bash
# Ejecutar el aprovisionamiento a mano, por ejemplo para ver toda la salida de la instalación
gentle-shell setup
```

`gentle-shell setup` instala los mismos paquetes acompañantes que gentle-ai aprovisiona en un Pi ordinario, solo en este home, y después elimina el único paquete que entra en conflicto con la propia herramienta `ask_user_question` de gentle-pi (gentle-ai #4820). El primer arranque de `gentle-shell` en un home ya ejecuta esto automáticamente; `setup` sirve para repetirlo a mano. Ver **[Primer arranque](docs/readme-reference.md#first-run-in-an-isolated-or-custom-home)** para la exclusión (`GENTLE_SHELL_NO_AUTO_SETUP=1`) y el comportamiento ante fallos.

```bash
# Convertir --link en el comportamiento predeterminado
gentle-shell home link

# O mantener el home separado y copiar tus inicios de sesión de pi en él
gentle-shell home import-pi --dry-run
gentle-shell home import-pi
```

`gentle-shell home import-pi` copia `auth.json` (mantenido privado, `0600`) y `mcp.json` desde tu home de pi al home separado, además de tu proveedor, modelo y nivel de razonamiento predeterminados cuando ese home no tiene ninguno. Nunca sobrescribe un archivo o ajuste, nunca copia paquetes, extensiones, cachés ni chats, y nunca cambia tu home de pi. La contrapartida: `--link` comparte un único almacén de credenciales con pi, mientras `import-pi` hace una segunda copia, de modo que un proveedor que rote los tokens de refresco puede cerrar la sesión en uno de los dos; vuelve a ejecutar `/login` ahí.

Cualquier otro argumento se reenvía a pi sin cambios, por ejemplo `gentle-shell --mode rpc` o `gentle-shell -p "..."`. Banderas, variables de entorno y modos completos: **[referencia del lanzador](docs/readme-reference.md#gentle-shell-launcher)**.

### Ruta B: dentro de un pi existente

Instala la versión estable publicada en un agente pi existente, reinicia Pi y después sincroniza los recursos instalados.

```bash
# Versión estable publicada: v4.1.0
pi install npm:gentle-pi@4.1.0

# Reinicia Pi y después ejecuta:
gentle-ai sync

# Inicia Pi en tu proyecto
pi
```

Ver las [notas de la versión v4.1.0](https://github.com/Gentleman-Programming/gentle-shell/releases/tag/v4.1.0) para los cambios específicos de la versión.

<details>
<summary><kbd>Más</kbd> <strong>¿Ves una advertencia de codemode integrado?</strong> — por qué aparece y cómo silenciarla</summary>

<br>

gentle-pi sustituye el `codemode` integrado de Pi por su renderizador compacto, así que Pi avisa al arrancar de que el integrado no se cargó. En tu propio home de Pi (`pi` con este paquete, o `gentle-shell --link`), gentle-pi pregunta una sola vez en el TUI interactivo si se debe añadir `"-builtin:codemode"` a `extensions` en el `settings.json` del agente (normalmente `~/.pi/agent/settings.json`); solo escribe si aceptas, y la advertencia desaparece en el siguiente arranque. Una petición rechazada no se repite. Para silenciarlo a mano, añade la entrada tú mismo, por ejemplo `"extensions": ["-builtin:codemode"]`. Los homes aislados de `gentle-shell` ya la incluyen.

</details>

### Comprueba tu configuración

```text
/gentle:status
/gentle:doctor
```

ℹ️ **Bueno saberlo**

- **Los diagnósticos STATUS son opcionales:** `/gentle:status-timing enable` arma el cronometraje para la siguiente llamada a una herramienta que porta STATUS mediante autorización aparte; `show` consulta el resumen solo en memoria y `disable` lo borra. Nunca invoca ni reintenta STATUS. Ver los [límites de diagnóstico](docs/readme-reference.md#diagnose-status-timing-without-retrying-it).
- **Nota de instalación a pantalla completa:** una instalación global reconocida persiste el ajuste `"tuiMode": "fullscreen"` de Pi. Las rutas de instalación locales al proyecto y otras no reciben ese cambio.
- **Hosts RPC interactivos:** la aplicación de escritorio define `GENTLE_SHELL_INTERACTIVE_HOST=1` automáticamente, sin tocar tu configuración de Pi — ver la [referencia de instalación](docs/readme-reference.md#interactive-rpc-hosts).

### Manténlo al día

**Compatibilidad de versiones:** `upgrade` está disponible a partir de `gentle-pi` v4.1.0 (y en las construcciones de main que incluyen el commit `96ff045a8`). Las versiones hasta v4.0.0 no lo soportan: en esos lanzadores, `gentle-shell upgrade` abre una sesión con `upgrade` como petición en lugar de actualizar.

Para esas instalaciones, descarga el [instalador más reciente](#easiest-download-and-double-click-no-terminal-needed) o usa el [instalador en navegador desde un checkout limpio de main](#path-c-browser-installer-from-a-checkout). Detecta una instalación existente y muestra el plan de actualización antes de que confirmes. Ver el [procedimiento para instalaciones más antiguas](docs/readme-reference.md#updating-an-installation-without-upgrade).

En una construcción de main que soporte `upgrade`:

```bash
# Actualiza por tu canal: la última versión publicada o el último main
gentle-shell upgrade

# Cambia de canal
gentle-shell upgrade --channel main
gentle-shell upgrade --channel release

# Instalación empaquetada: vuelta a la versión anterior
gentle-shell upgrade --rollback
```

`gentle-shell upgrade` usa el gestor de paquetes que posee tu instalación.

<details>
<summary><kbd>Más</kbd> <strong>Canales, instalaciones empaquetadas y vuelta atrás</strong> — qué construye cada canal y cómo funciona la vuelta atrás</summary>

<br>

- **Canal main:** en el canal main reconstruye Gentle AI y Gentle Shell desde los últimos commits de `main` (solo lo que ha cambiado) y necesita pnpm y Go (un Go más antiguo que el mínimo se sustituye, solo para la construcción, por el Go fijo que dejó el instalador en su propia carpeta); volver a release restaura el binario Gentle AI fijo.
- **Tu Pi:** con pnpm 11, el Gentle Shell actualizado puede ejecutar un Pi más nuevo que pnpm coloca a su lado (siempre al menos el mínimo); tu propio Pi nunca se cambia.
- **Instalación empaquetada:** una instalación empaquetada (el propio Node, pnpm y Pi del instalador web) sigue solo el canal de release: instala la versión nueva junto a la actual, la verifica y después cambia, manteniendo la versión anterior para `--rollback`. En release, una vez que la última versión publicada incluya la distribución empaquetada, `upgrade` mueve una instalación global de pnpm o npm a la empaquetada y pregunta una vez antes de eliminar el `gentle-pi` global anterior.
- **`update` frente a `upgrade`:** `gentle-shell update` es un comando distinto: es la propia actualización de paquetes de Pi. En una instalación empaquetada, Pi viene fijo con Gentle Shell, así que actualizar Pi mismo ejecuta `gentle-shell upgrade` en su lugar.

</details>

<br>

Más: **[referencia de upgrade](docs/readme-reference.md#upgrade-subcommand-and-channels)**.

### Elimínalo

```bash
# Muestra lo que se eliminaría, después elimina tras confirmar
gentle-shell self-uninstall --dry-run
gentle-shell self-uninstall
```

`gentle-shell self-uninstall` elimina los propios datos de Gentle Shell, su home aislado con su configuración en `~/.gentle-shell/gentle-ai`, y el paquete `gentle-pi`. Mantiene la configuración compartida de Gentle AI en `~/.pi/gentle-ai` salvo que aceptes o pases `--include-shared`, y nunca toca tu home de Pi ni los homes personalizados con `--home`. En una instalación empaquetada elimina la carpeta empaquetada y la única entrada de `PATH` que registró el instalador ([detalles](docs/bundled-install.md#self-uninstall)). `gentle-shell uninstall` es el alias de Pi para `remove`. Más: **[Eliminar Gentle Shell](docs/gentle-shell-uninstall.md)**.

Para los prerrequisitos, las instrucciones de checkout de código fuente, el comportamiento completo de la instalación y la política de versiones, usa la **[referencia de instalación](docs/readme-reference.md#install)**. Para el trabajo diario, describe el resultado y sigue [ODD](#odd--the-everyday-workflow).

<p align="right"><a href="#top">Volver arriba ↑</a></p>


<p align="center">
  <img src="docs/assets/brand/terminal-divider.svg" width="480" alt="">
</p>

<a id="documentation"></a>

## 📚 Documentación

Empieza por el destino orientado al producto; entra en la referencia operativa solo cuando necesites los detalles.

| Destino | Propósito |
| --- | --- |
| [Referencia de gentle-shell](docs/gentle-shell.md) | Diseño del espacio de trabajo, cambios, uso, agentes e interacciones de tareas pendientes. |
| [Flujo de trabajo ODD](docs/readme-reference.md#organic-driven-development) · [Referencia técnica](docs/readme-reference.md) | Trabajo diario y recuperación, instalación, configuración, comandos y detalle para colaboradores. |
| [Asistente de instalación (vista previa)](docs/install-wizard.md) | Cómo comprueba el instalador en el navegador tu ordenador, qué instala en los canales release y main, su modelo de seguridad y qué sigue verificándose. |
| [Eliminar Gentle Shell](docs/gentle-shell-uninstall.md) | Qué elimina, conserva y nunca toca `gentle-shell self-uninstall`. |
| [Integración de la revisión](docs/review-integration.md) | El límite proveedor/consumidor para la revisión nativa. |
| [Arquitectura de autoridad nativa](docs/native-authority-architecture.md) | Límites de propiedad y arquitectura de revisión. |
| [Verificación delegada](docs/delegated-verification.md) | Guía práctica de verificación. |
| [Telemetría](docs/telemetry.md) | Campos aprobados y limitaciones de la fuente. |
| [Guía de estilo de skills](docs/skill-style-guide.md) | El contrato de las skills del paquete. |

<p align="right"><a href="#top">Volver arriba ↑</a></p>

<p align="center">
  <img src="docs/assets/brand/terminal-divider.svg" width="480" alt="">
</p>

<a id="community"></a>

## 🤝 Comunidad

Este proyecto se construye en público. Trae un flujo de trabajo real, una pregunta afilada, un informe de error o una pequeña mejora que haga más claro el trabajo de la siguiente persona.

<p align="center">
  <a href="https://github.com/Gentleman-Programming/gentle-shell/issues"><img src="https://img.shields.io/badge/Issues-join%20the%20conversation-F095C8?style=for-the-badge&labelColor=1A1218" alt="Incidencias de GitHub"></a>
  <a href="https://github.com/Gentleman-Programming/gentle-shell/graphs/contributors"><img src="https://img.shields.io/badge/Contributors-thank%20you-D7A0B8?style=for-the-badge&labelColor=1A1218" alt="Colaboradores"></a>
  <a href="https://discord.com/invite/gentleman-programming-769863833996754944"><img src="https://img.shields.io/badge/Discord-Gentleman%20Programming-F095C8?style=for-the-badge&labelColor=1A1218" alt="Discord de Gentleman Programming"></a>
</p>

<p align="center">
  <a href="https://github.com/Gentleman-Programming/gentle-shell/graphs/contributors"><img src="https://contrib.rocks/image?repo=Gentleman-Programming/gentle-shell" alt="colaboradores de gentle-shell"></a>
</p>

<p align="center">
  <a href="https://github.com/Gentleman-Programming/gentle-shell/stargazers"><strong>★ Pon una estrella a gentle-shell en GitHub</strong></a>
</p>

<div align="center">

<!--
  sealed_token es un token fino de GitHub cifrado contra la clave pública de Star History, así que solo se publica el valor cifrado. Es necesario porque GitHub anunció el 2026-06-30 que restringiría la API de stargazers a los administradores y colaboradores del repositorio; sin él el gráfico muestra un marcador de error.
  Regenera en https://www.star-history.com/?repos=Gentleman-Programming%2Fgentle-pi&type=date&legend=top-left
-->

<a href="https://www.star-history.com/?repos=Gentleman-Programming%2Fgentle-pi&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Gentleman-Programming%2Fgentle-pi&type=date&theme=dark&legend=top-left&sealed_token=zwrd_DfwYZeJU7nhGYNtREEheKWYEslW_uzrqORlZ36v-JSMepdqGLkKExp1M-xbNq6t-ebVS5iM3WoPDO26tXbSGkjXC2Jo3kHQ3uNzlRkCrWoqRHkPVQXvosKciY109ObiwGV1z8aajyedcloppmekCGrvVKJb6KWxGLXW_mHcRAVIBZUOa4SzW75D" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Gentleman-Programming%2Fgentle-pi&type=date&theme=light&legend=top-left&sealed_token=zwrd_DfwYZeJU7nhGYNtREEheKWYEslW_uzrqORlZ36v-JSMepdqGLkKExp1M-xbNq6t-ebVS5iM3WoPDO26tXbSGkjXC2Jo3kHQ3uNzlRkCrWoqRHkPVQXvosKciY109ObiwGV1z8aajyedcloppmekCGrvVKJb6KWxGLXW_mHcRAVIBZUOa4SzW75D" />
    <img width="620" alt="Star History Chart" src="https://api.star-history.com/chart?repos=Gentleman-Programming%2Fgentle-pi&type=date&theme=light&legend=top-left&sealed_token=zwrd_DfwYZeJU7nhGYNtREEheKWYEslW_uzrqORlZ36v-JSMepdqGLkKExp1M-xbNq6t-ebVS5iM3WoPDO26tXbSGkjXC2Jo3kHQ3uNzlRkCrWoqRHkPVQXvosKciY109ObiwGV1z8aajyedcloppmekCGrvVKJb6KWxGLXW_mHcRAVIBZUOa4SzW75D" />
  </picture>
</a>

</div>

- Abre una [incidencia](https://github.com/Gentleman-Programming/gentle-shell/issues) con el contexto necesario para reproducir o entender la idea.
- Consulta a las personas que dan forma al proyecto en el [gráfico de colaboradores](https://github.com/Gentleman-Programming/gentle-shell/graphs/contributors).
- Sigue a [Gentleman Programming](https://github.com/Gentleman-Programming) para el ecosistema completo.

<p align="right"><a href="#top">Volver arriba ↑</a></p>

<p align="center">
  <img src="docs/assets/brand/terminal-divider.svg" width="480" alt="">
</p>

## Sobre el autor

`gentle-shell` lo construye [Alan Buscaglia](https://github.com/Gentleman-Programming), el creador de Gentleman Programming. Creció a partir de una creencia práctica: los agentes capaces son más útiles cuando la intención del humano, la carga de revisión y el juicio de entrega se mantienen visibles hasta el final del trabajo.

Colaboración en la intro de arranque: gracias a [@aporcelli](https://github.com/aporcelli) y [`pi-gentle-startup`](https://github.com/aporcelli/pi-gentle-startup), que inspiraron la animación de arranque en pantalla limpia, el panel de entorno compacto y el tratamiento visual en rosa.

<p align="center">
  <a href="https://gentlemanprogramming.com/"><img src="https://img.shields.io/badge/Website-Gentleman%20Programming-F095C8?style=for-the-badge&labelColor=1A1218" alt="Sitio web de Gentleman Programming"></a>
  <a href="https://www.youtube.com/c/GentlemanProgramming"><img src="https://img.shields.io/badge/YouTube-Gentleman%20Programming-D7A0B8?style=for-the-badge&labelColor=1A1218" alt="YouTube de Gentleman Programming"></a>
  <a href="https://github.com/Gentleman-Programming"><img src="https://img.shields.io/badge/GitHub-Gentleman--Programming-F095C8?style=for-the-badge&labelColor=1A1218" alt="GitHub de Gentleman Programming"></a>
</p>

<p align="right"><a href="#top">Volver arriba ↑</a></p>

<p align="center">
  <img src="docs/assets/brand/terminal-divider.svg" width="480" alt="">
</p>

<p align="center"><strong>Construido con el flujo de trabajo que lleva a Pi.</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-F095C8?style=for-the-badge&labelColor=1A1218" alt="Licencia MIT"></a>
</p>

> **Aviso de marca:** los nombres gentle-shell™ y gentle-pi™ y los logotipos asociados son marcas de Alan Buscaglia. La licencia MIT se aplica al código; no permite implicar respaldo ni afiliación oficial. Ver [TRADEMARKS.md](TRADEMARKS.md).
