# 🚀 Reporte Técnico de Contribuciones: Estabilidad de Runtime, Ciclo de Vida de Subagentes y Fix de Congelamiento en WSL

Hola gente! Estuvimos auditando a fondo la estabilidad del runtime de `gentle-pi`, la orquestación de subagentes y resolviendo un **problema crítico recurrente donde la máquina o la terminal se congelaban/bloqueaban completamente al tener múltiples instancias de `pi` abiertas o subagentes concurrentes corriendo (especialmente en entornos Windows con WSL)**.

Para hacer la revisión clara, atómica y fácil de mergear, dividimos todo en **8 Pull Requests independientes**. Cada uno cuenta con su rama limpia basada en `main`, su Issue vinculado, tests unitarios pasando y contratos formales documentados.

A continuación dejamos el detalle exhaustivo de la causa raíz, impacto y solución técnica de cada uno:

---

## 1. Crash no capturado en `stateCache.load()` con Session Managers incompletos
- **Issue Oficial:** [#1897](https://github.com/Gentleman-Programming/gentle-shell/issues/1897)
- **Pull Request:** [#1898](https://github.com/Gentleman-Programming/gentle-shell/pull/1898)
- **Archivo afectado:** `extensions/gentle-agents.ts`
- **Diagnóstico y Causa Raíz:**
  En los manejadores de eventos del ciclo de vida `session_tree` y `session_start`, se invocaba directamente `stateCache.load(ctx.sessionManager)` sin validar sus capacidades. Por dentro, `stateCache.load()` asume inmediatamente que el objeto expone el método `.getBranch()`:
  ```ts
  const branch = sessionManager.getBranch();
  ```
  Al ejecutar tests unitarios con mocks livianos, herramientas CLI headless, extensiones puente o entornos donde `sessionManager` solo implementa métodos estándar de sesión (`getSessionId()`, `getCwd()`), la propiedad `.getBranch` es `undefined`. Esto detonaba un error fatal no capturado:
  `TypeError: sessionManager.getBranch is not a function`
  que rompía la inicialización completa de la sesión y abortaba el registro de eventos.
- **Solución Implementada:**
  Se agregó una guarda defensiva explícita que comprueba la existencia de la función antes de invocar la carga del estado:
  ```ts
  if (typeof ctx.sessionManager?.getBranch === "function") stateCache.load(ctx.sessionManager);
  ```
  Permite que cualquier harness de testing o sesión alternativa inicialice de forma robusta y a prueba de fallos.

---

## 2. Bloqueo de espacio en TUI: Tareas zombi retenidas en el widget inferior
- **Issue Oficial:** [#1899](https://github.com/Gentleman-Programming/gentle-shell/issues/1899)
- **Pull Request:** [#1900](https://github.com/Gentleman-Programming/gentle-shell/pull/1900)
- **Archivo afectado:** `lib/agents-widget.ts` y `tests/agents-widget.test.ts`
- **Diagnóstico y Causa Raíz:**
  En `lib/agents-widget.ts`, el tiempo de retención de tareas terminadas estaba hardcodeado en 1 minuto:
  ```ts
  const FINISHED_TTL_MS = 60_000;
  ```
  Cuando un subagente finalizaba (sea `COMPLETED`, `FAILED` o `CANCELLED`), el resultado ya había sido impreso en la transcripción y entregado al modelo padre. Sin embargo, la tarjeta inferior (`renderAgentsCard`) mantenía esas filas visibles durante 60 segundos completos. En terminales con altura limitada (como paneles divididos de VS Code o Tmux de 15 a 24 líneas), 2 o 3 tareas terminadas acaparaban hasta el 25% o 30% de la altura útil de la pantalla con información estéril.
- **Solución Implementada:**
  Se modificó `FINISHED_TTL_MS` a `0`. Las tareas salen de la tarjeta inferior de forma instantánea al liquidarse, devolviendo el espacio visual de la terminal de inmediato. Toda la auditoría e historial continúan intactos en la transcripción de la sesión y a través del comando `/gentle:jobs`. Se actualizaron las funciones `widgetTasks`, `widgetExpiryMs` y la suite de pruebas `tests/agents-widget.test.ts`.

---

## 3. Cuelgues silenciosos de CodeGraph por latencia de I/O de Windows en WSL
- **Issue Oficial:** [#1901](https://github.com/Gentleman-Programming/gentle-shell/issues/1901)
- **Pull Request:** [#1902](https://github.com/Gentleman-Programming/gentle-shell/pull/1902)
- **Archivo afectado:** `extensions/codegraph-tools.ts`
- **Diagnóstico y Causa Raíz:**
  Al invocar `codegraph` (`init`, `query`, `explore`), el proceso `execFileAsync` se lanzaba pasando únicamente la señal del usuario, sin ningún límite de tiempo superior interno.
  En entornos WSL 2 que operan sobre directorios montados de Windows (`/mnt/c/...`) o repositorios medianos/grandes, el puente 9P/Plan9 entre Linux y Windows sufre una penalización masiva de I/O en operaciones de indexación y hashing. Como resultado:
  1. El subproceso quedaba congelado indefinidamente bloqueando el turno del agente.
  2. Cuando el proceso finalmente fallaba por cancelación forzada o timeout del SO (`ABORT_ERR` o `TimeoutError`), la función `codeGraphFailureDetails` solo comprobaba `ENOENT` (binario no instalado) y clasificaba todo lo demás como un genérico e inútil `CodeGraph failed to run`. El modelo no sabía por qué había fallado y reintentaba ciegamente.
- **Solución Implementada:**
  1. Se implementó una cota de tiempo máxima de 3 minutos mediante `AbortSignal.timeout(180_000)` combinada con la señal externa mediante `AbortSignal.any`.
  2. Se creó el clasificador `isTimeoutError(error)` para capturar `TimeoutError` y `ABORT_ERR`.
  3. Se diseñó un mensaje de error accionable:
     `"CodeGraph operation timed out (WSL / filesystem latency or oversized workspace). ..."`
     alertando de la latencia de disco y permitiendo al modelo saltar de inmediato a las herramientas de fallback (`grep`, `find`, `read`) sin trabar la sesión.

---

## 4. Consumo de CPU al 100% por polling continuo y comandos `sleep`
- **Issue Oficial:** [#1903](https://github.com/Gentleman-Programming/gentle-shell/issues/1903)
- **Pull Request:** [#1904](https://github.com/Gentleman-Programming/gentle-shell/pull/1904)
- **Archivos afectados:** `extensions/gentle-ai.ts`, `extensions/gentle-agents.ts`, `tests/gentle-ai.test.ts`
- **Diagnóstico y Causa Raíz:**
  Al despachar subagentes en segundo plano (`mode: "background"`), la directiva de diseño de Gentle AI establece que el orquestador debe ceder el turno (`turn-yield`) y esperar a que el resultado llegue asíncronamente como mensaje de sesión.
  Sin embargo, los modelos de lenguaje frecuentemente desobedecían la instrucción en prosa y trataban de esperar activamente la finalización:
  1. Ejecutaban `sleep 10` o `sleep 15` mediante la herramienta `bash`.
  2. Llamaban repetidamente a `subagent_status` y `subagent_result`.
  Como estas herramientas devolvían exitosamente un texto informativo diciendo *"Task is still running"*, el modelo interpretaba que la herramienta funcionaba y continuaba llamándola en bucle turnos tras turno. Esto mantenía múltiples procesos hijos despiertos, saturando núcleos de CPU y consumiendo cuota de tokens inútilmente.
- **Solución Implementada:**
  Se trasladó la restricción desde el prompt hacia la intercepción dura en tiempo de ejecución (`pi.on("tool_call")`):
  1. En `extensions/gentle-ai.ts`, cualquier comando `sleep <segundos>` en `bash` es bloqueado de inmediato con una política de seguridad que le indica al LLM finalizar su turno.
  2. En `extensions/gentle-agents.ts`, cualquier llamada a `subagent_status` o `subagent_result` sobre una tarea cuyo estado sea `RUNNING` o `QUEUED` es rechazada en seco con `{ block: true, reason: ... }`.
  Al recibir el bloqueo, el modelo se ve forzado a soltar el turno y ceder el control al event loop.

---

## 5. Falta de observabilidad en subagentes: Cards de ciclo de vida y streaming en vivo
- **Issue Oficial:** [#1905](https://github.com/Gentleman-Programming/gentle-shell/issues/1905)
- **Pull Request:** [#1906](https://github.com/Gentleman-Programming/gentle-shell/pull/1906)
- **Archivos afectados:** `lib/agents-renderer.ts`, `extensions/gentle-agents.ts`, `tests/agents-renderer.test.ts`, `odd/tasks/subagent-card-ui.md`
- **Diagnóstico y Causa Raíz:**
  Los subagentes son el motor central del desarrollo en Gentle AI (ODD), pero en la pantalla se renderizaban como una simple línea de texto plano desprovista de estilo (`@ agent run · gentle-ai-worker`). Peor aún, durante la ejecución síncrona (`mode: "task"`), el usuario quedaba completamente a ciegas frente a un texto estático `working...`, sin saber si el worker estaba leyendo archivos, aplicando modificaciones o ejecutando una suite de pruebas que pudiera haberse colgado. Los fallos o errores se volcaban como texto plano sucio.
- **Solución Implementada:**
  1. Se construyó el módulo `lib/agents-renderer.ts` integrando `GentleAgentCallCard` y `GentleAgentResultCard` alineados con el sistema de tarjetas oficial (`shell-card.ts`, glifo `❀`, tonos dinámicos según estado: `preparing`, `running`, `completed`, `failed`).
  2. Se conectó `store.subscribe` durante `launch` para canalizar eventos en tiempo real hacia `onUpdate`, mostrando la actividad exacta que ejecuta el subagente en cada instante (por ejemplo: `↳ $ npm test (turn 2 · 3 tools)`, `↳ read src/app.ts`, `↳ edit lib/runner.ts`).
  3. Soporte para expandir y colapsar detalles técnicos con la tecla configurada sin alterar el contenido puro que recibe el modelo.

---

## 6. Dynamic Subagent Specialization (DSS) con Sandbox Monótono de Solo Lectura
- **Issue Oficial:** [#1907](https://github.com/Gentleman-Programming/gentle-shell/issues/1907)
- **Pull Request:** [#1910](https://github.com/Gentleman-Programming/gentle-shell/pull/1910)
- **Archivos afectados:** `lib/agents-protocol.ts`, `lib/agents-runner.ts`, `lib/agents-renderer.ts`, `extensions/gentle-agents.ts`, `tests/dynamic-subagent-specialization.test.ts`
- **Diagnóstico y Causa Raíz:**
  Los agentes disponibles en Gentle Pi están definidos como archivos estáticos en disco (`assets/agents/*.md`). Para tareas de exploración complejas o que requieren un lente analítico específico (por ejemplo: arquitecto ODD para redactar especificaciones, auditor de seguridad, revisor de SQL o inspector de accesibilidad), `gentle-ai-explore` no contaba con las instrucciones del dominio ni con herramientas analíticas complementarias (`read_symbol`, `lens_diagnostics`, `web_search`). El orquestador se veía forzado a:
  - Crear archivos `.md` temporales en disco que quedaban huérfanos y ensuciaban el árbol de trabajo.
  - O realizar el análisis pesado en el hilo principal del chat, rompiendo el presupuesto de tokens (<20k).
- **Solución Implementada:**
  Se introdujo el mecanismo de **Especialización Dinámica de Subagentes (DSS)** mediante derivación efímera en `subagent_run`:
  ```ts
  specialization: {
    label: "ODD Architect",
    instructionsOverlay: "Directivas de arquitectura...",
    extraTools: ["read_symbol", "read_enclosing", "lens_diagnostics"],
    outputContract: "Estructura requerida del reporte..."
  }
  ```
  **Garantía de Seguridad (Invariante Monótono):** Si el agente base es de solo lectura (como `gentle-ai-explore`), el runner valida estrictamente que `extraTools` solo contenga herramientas de la lista blanca de lectura (`ALLOWED_READONLY_EXTENSIONS`). Cualquier intento de inyectar herramientas mutadoras (`write`, `edit`, `bash`) lanza un error de validación antes de spawnear el subproceso. Las especializaciones viven exclusivamente en la memoria del subproceso RPC y se muestran en la TUI como `<agente> ▸ [<especialización>]`.

---

## 7. Guardrails de Runtime para el "Pure Thinker" + Bypass Automático de WSL
- **Issue Oficial:** [#1912](https://github.com/Gentleman-Programming/gentle-shell/issues/1912)
- **Pull Request:** [#1914](https://github.com/Gentleman-Programming/gentle-shell/pull/1914)
- **Archivos afectados:** `extensions/gentle-ai.ts`, `tests/subagent-guardrails.test.ts`, `odd/tasks/*.md`
- **Diagnóstico y Causa Raíz:**
  Este PR ataca directamente el núcleo de los congelamientos y la saturación de memoria:
  1. **Congelamiento de I/O en WSL:** En Windows bajo WSL, `pi-lens` realizaba llamadas continuas a `fs.statSync` para sondear la velocidad del filesystem (`probeSlowFs`). Al trabajar sobre unidades montadas (`/mnt/c/...`), cada llamada cruza el puente DrvFS de Windows. En repositorios con miles de archivos, estas operaciones síncronas bloqueaban el event loop de Node.js por segundos o minutos, emitiendo alertas de degradación (`🐢 Slow filesystem detected`) y frizando toda la interfaz de terminal.
  2. **Violación de la disciplina del orquestador:** A pesar de que el prompt declara al orquestador como un "Pure Thinker y Coordinador", en `main` no había ninguna barrera en el código. Los modelos leían 15 archivos de código en un solo turno, hacían búsquedas globales no filtradas (`grep`/`find` sobre `.`) y modificaban código fuente directamente con `write`/`edit`. Esto llenaba la memoria RAM de Node con buffers masivos de texto y disparaba el contexto a más de 100k tokens.
  3. **Falta de confirmación humana:** El orquestador despachaba workers mutadores sin que el humano tuviera oportunidad de validar las rutas que iban a ser alteradas.
- **Solución Implementada:**
  1. **Optimización WSL Zero-Config:** En el arranque de la extensión, si se detecta Linux en entorno WSL (`/microsoft/i.test(release())`), se auto-configura en memoria `PI_LENS_ALLOW_SLOW_FS_SCAN = "1"`. Se saltea el probe bloqueante de DrvFS de forma transparente para el usuario sin requerir configuraciones manuales en `.bashrc`.
  2. **Bloqueo de mutación inline:** En la sesión principal, `write` y `edit` están terminantemente prohibidos sobre archivos de código fuente. Solo se permiten archivos de tracking y configuración interna (`odd/tasks/**`, `.atl/**`, `.pi/**`, `.git/**`, temporales). Toda modificación de código debe delegarse a `gentle-ai-worker`.
  3. **Cuota de lectura inline:** Se permite un máximo estricto de 2 lecturas de código por turno. Al 3er `read`, la llamada es interceptada exigiendo delegar la exploración a `gentle-ai-explore`. Archivos de configuración (`package.json`, `tsconfig.json`), tracking y documentación markdown no descuentan cuota. El contador se resetea automáticamente en cada `turn_start`.
  4. **Bloqueo de grep/find globales:** Prohíbe barridos masivos de código en la sesión principal para proteger la ventana de contexto.
  5. **Consentimiento interactivo para Workers:** Al despachar un worker acotado en sesiones con UI interactiva, se despliega un diálogo modal (`ctx.ui.confirm`) mostrando el agente, la etiqueta y la lista de rutas autorizadas (`## Allowed edit surfaces`), requiriendo aprobación humana antes de realizar cualquier cambio.

---

## 8. Cross-Repository Subagent Consent Gate y Guía Accionable
- **Issue Oficial:** [#1915](https://github.com/Gentleman-Programming/gentle-shell/issues/1915)
- **Pull Request:** [#1916](https://github.com/Gentleman-Programming/gentle-shell/pull/1916)
- **Archivos afectados:** `lib/session-worktree-registry.ts`, `assets/orchestrator.md`, `tests/odd-routing-contract.test.ts`
- **Diagnóstico y Causa Raíz:**
  Al utilizar `session_worktree_register` con un repositorio Git independiente, el registro fallaba con el mensaje:
  `Select an existing worktree in the same Git clone as this session.`
  El mensaje no le explicaba al modelo qué debía hacer si su intención real era interactuar con un repositorio ajeno. Además, no estaba codificado formalmente el contrato que prohíbe que un agente salte a otro repositorio Git sin consentimiento explícito del usuario.
- **Solución Implementada:**
  1. Se mejoró el error en `lib/session-worktree-registry.ts` para proveer guía accionable:
     `"Select an existing worktree in the same Git clone as this session. For an independent Git repository, pass repository_root instead of workspace_root."`
  2. Se incorporó formalmente en las reglas de seguridad de `assets/orchestrator.md` el `Cross-Repository Consent Gate (HARD CONTRACT)`: el orquestador tiene prohibido despachar subagentes a repositorios externos mediante `repository_root` de forma autónoma sin previa confirmación del humano.

---

## 🧠 Resumen del impacto en rendimiento: ¿Por qué se congelaba Pi con varias sesiones abiertas?

El problema de que la máquina se colgara o quedara en estado de freeze al tener varios Pi abiertos no era por falta de RAM física, sino por la combinación de **3 factores de contención destructiva**:

1. **Polling continuo y procesos en bucle (Solucionado en #1904):** Múltiples instancias de Pi con tareas en background ejecutaban comandos `sleep` o `subagent_status` concurrentes cada pocos segundos. En vez de esperar dormidos a que el sistema operativo les avise por IPC, mantenían la cola de procesos de Node.js saturada al 100% de CPU.
2. **Deadlocks de I/O en WSL / DrvFS (Solucionado en #1902 y #1914):** Al tener 2 o 3 sesiones abiertas sobre `/mnt/c/...`, las llamadas de `pi-lens` a `statSync` sobre directorios masivos y los procesos de `codegraph` sin timeout colapsaban el puente 9P de Windows. Cuando el subsistema de I/O se satura en WSL, los procesos de Node se van a estado `D` (uninterruptible sleep), frizando la terminal por completo. La auto-configuración de `PI_LENS_ALLOW_SLOW_FS_SCAN = 1` y los timeouts en `codegraph` cortan de raíz este cuello de botella.
3. **Consumo de memoria desmedido por tareas inline (Solucionado en #1914):** Orquestadores haciendo lecturas y búsquedas globales inline creaban árboles de objetos masivos en el heap de V8 en cada sesión. Forzar la delegación mediante workers acotados mantiene el proceso principal ultra liviano (<20k tokens de contexto y uso mínimo de heap).

---

Todos los PRs están listos, con código probado y sin conflictos con `main`. Quedamos a disposición para cualquier consulta durante el code review! 🙌
