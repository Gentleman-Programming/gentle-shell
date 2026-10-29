# Propuesta: notificaciones sonoras nativas

**Propuesta histórica aprobada y ejecutada por unidades; ver [estado actual](#estado-actual-sn6).** El texto original debajo conserva las decisiones propuestas, no afirma que sigan sin implementar.

Incorporar a gentle-shell notificaciones sonoras configurables para sesión, agente principal y subagentes. El audio estará **desactivado por defecto** y no alterará la ejecución, las decisiones ni los permisos del harness.

## Decisión propuesta

Crear una capa independiente de notificaciones: los adaptadores observan eventos reales, una política decide si notificarlos y un backend reproduce el sonido sin bloquear el trabajo. La reproducción pertenece a la sesión interactiva padre, nunca a cada proceso hijo.

La primera versión ofrece configuración por origen y transición, sonidos incluidos, archivos propios, prueba de sonido y silencio temporal. No añade notificaciones de escritorio ni un bus de eventos generalista.

## Encaje en la estructura actual

| Punto existente | Papel en la propuesta |
|---|---|
| `extensions/gentle-shell.ts` | Integrar el acceso a configuración; ya observa eventos de sesión y agente principal. |
| `extensions/gentle-agents.ts` | Publicar transiciones de tareas vivas, sin reproducir audio directamente. |
| `lib/agents-protocol.ts` | Fuente del vocabulario de estados de subagentes. No duplicar su máquina de estados. |
| `lib/agent-home.ts` | Resolver el directorio global con `gentlePiConfigHome()`. |
| `lib/visual-customization-policy.ts` | Referencia de configuración validada y escritura atómica; no mezclar audio con ajustes visuales. |

Archivos nuevos orientativos:

- `extensions/gentle-notifications.ts`: ciclo de vida, suscripciones y propietario único del servicio.
- `lib/notification-policy.ts`: esquema, resolución de configuración, selección de sonido, deduplicación y límites.
- `lib/notification-audio.ts`: detección de capacidades y reproducción por plataforma.
- `assets/sounds/`: sonidos breves con licencia redistribuible documentada.
- Pruebas de política, adaptadores y reproducción bajo `tests/`.

La integración usará el mecanismo de eventos existente. Los nuevos eventos internos serán tipados y específicos de notificaciones; no se introducirán dependencias desde los runners hacia audio o UI.

## Qué se puede configurar

Se notifican **entradas en estados o eventos de ciclo de vida**, no snapshots ni cada actualización de texto. Sesión, agente principal y subagentes no comparten necesariamente los mismos estados.

| Origen | Transiciones/eventos propuestos | Condición |
|---|---|---|
| Sesión | `started`, `shutdown` | Inicio interactivo y cierre; el sonido de cierre es de mejor esfuerzo. |
| Agente principal | `started`, `completed`, `failed`, `cancelled`, `attention` | Derivados de evidencia del runtime, no de etiquetas visuales. |
| Subagente | `queued`, `running`, `waiting`, `completed`, `failed`, `cancelled`, `timed_out` | Vocabulario actual de `TASK_STATUS`. |

`attention` significa una petición explícita de intervención, no estar pensando ni ejecutar una herramienta. `waiting` conservará su significado real en el protocolo de subagentes; no se asumirá que todo tiempo de espera requiere al usuario.

**Antes de implementar:** confirmar qué eventos distinguen fallo, cancelación y finalización del agente principal, qué productores representan intervención humana y si `session_start` también cubre cambios de sesión. No interpretar `agent_end` como éxito por sí solo. Si una transición no tiene evidencia fiable, quedará fuera del catálogo inicial y se documentará la limitación.

### Preset recomendado

El interruptor general empieza apagado. Al activarlo con el preset recomendado:

- Finalización de agente principal o subagente: sonido breve de éxito.
- Fallo y timeout: sonido de error.
- Intervención humana explícita: sonido de atención.
- Inicio, ejecución, cancelación y cierre: silencio.

Todos los eventos disponibles pueden asignarse a un sonido o a silencio. El catálogo de la UI mostrará solo eventos realmente soportados.

## Configuración

Archivo global propuesto: `<gentlePiConfigHome()>/notifications.json`; por defecto, `~/.pi/gentle-ai/notifications.json`. Se respeta `GENTLE_PI_CONFIG_HOME`.

Ejemplo ilustrativo del esquema propuesto, no configuración funcional actual:

```json
{
  "schema": "gentle-shell.notifications/v1",
  "enabled": false,
  "audio": {
    "backend": "auto",
    "minimumIntervalMs": 1000,
    "coalesceWindowMs": 300,
    "events": {
      "session.started": null,
      "session.shutdown": null,
      "agent.started": null,
      "agent.completed": "builtin:success",
      "agent.failed": "builtin:error",
      "agent.cancelled": null,
      "agent.attention": "builtin:attention",
      "subagent.queued": null,
      "subagent.running": null,
      "subagent.waiting": null,
      "subagent.completed": "builtin:success",
      "subagent.failed": "builtin:error",
      "subagent.cancelled": null,
      "subagent.timed_out": "builtin:error"
    }
  }
}
```

Reglas:

- `null` significa silencio; un evento omitido también significa silencio. No habilitar sonidos nuevos implícitamente al actualizar.
- `builtin:<id>` selecciona un sonido incluido; `file:<ruta-absoluta>` selecciona un archivo local validado.
- Archivo ausente: configuración desactivada sin escribir archivos ni detectar reproductores.
- Archivo inválido o ilegible: audio desactivado y diagnóstico discreto, una sola vez. La UI no sobrescribe un archivo inválido silenciosamente.
- Escritura atómica, siguiendo el patrón de configuración existente.
- Sin configuración por repositorio en v1: un proyecto no puede activar audio ni seleccionar archivos o ejecutables en la máquina del usuario.
- Silencio temporal en memoria, no persistente. Cambiar de sesión conserva ese silencio mientras viva la misma instancia interactiva; reiniciar el proceso lo elimina.

## Experiencia de usuario

Añadir una sección **Notificaciones** al acceso de personalización/configuración existente, separada de los ajustes visuales:

1. Activar/desactivar audio.
2. Elegir origen y evento; asignar sonido o silencio.
3. Seleccionar sonido incluido o introducir un archivo local.
4. Probar el sonido elegido mediante una acción explícita.
5. Silenciar/reanudar durante esta instancia interactiva.
6. Consultar disponibilidad del backend y restaurar el preset.

La prueba es una excepción explícita al interruptor general: el usuario puede preescuchar sin activar notificaciones automáticas. No reproduce eventos pendientes ni cambia configuración por sí sola.

No se modifica el resultado de herramientas ni se añaden mensajes al contexto del modelo. No se requiere un comando nuevo en v1.

## Fiabilidad, ruido y seguridad

- **Una sola reproducción:** los hijos publican estados; solo el propietario interactivo padre puede reproducir. RPC/headless y procesos de subagentes permanecen silenciosos.
- **Sin replay:** restaurar tareas o historial establece la referencia inicial, pero no genera sonidos. Desactivar o silenciar descarta pendientes; reactivar no reproduce el pasado.
- **Identidad:** deduplicar por sesión, tarea/run y transición. Reinicios o ejecuciones nuevas no reutilizan la identidad anterior.
- **Ráfagas:** agrupar durante 300 ms y reproducir un sonido con prioridad error > atención > éxito > otros. El intervalo mínimo limita la frecuencia global; no acumular una cola que suene después de perder relevancia.
- **Sin solapamiento:** reproducción serial y cola acotada a un candidato pendiente. Un sonido más prioritario puede sustituir al pendiente, no al que ya se está reproduciendo.
- **No bloquear:** procesos asíncronos, timeout acotado y limpieza al cerrar. Ningún fallo de audio cambia el estado del agente.
- **Archivos seguros:** validar archivo regular, formato permitido y tamaño acotado; no aceptar URL, comandos ni expansión de shell. Ejecutar binarios conocidos con argumentos separados, nunca `shell: true`.
- **Diagnósticos discretos:** backend ausente o fallo de reproducción produce una advertencia local limitada, nunca spam ni contaminación del transcript.
- **Sin sonido obligatorio:** no usar BEL como fallback automático; puede producir sonido o aviso visual según el terminal y no permite distinguir los eventos.

## Plataformas

Proponer adaptadores para Linux, macOS y Windows, con detección perezosa al activar o probar audio. No instalar dependencias del sistema automáticamente.

| Entorno | Comportamiento esperado |
|---|---|
| Linux | Elegir un reproductor conocido disponible y probar reproducción local. |
| macOS | Usar reproducción nativa disponible, con el mismo contrato asíncrono. |
| Windows | Usar un mecanismo nativo sin abrir ventanas de consola auxiliares. |
| SSH, contenedores o equipos sin audio | Reproducción en la máquina del proceso; no prometer audio en el equipo cliente. Si no hay backend utilizable, informar y seguir. |

WAV sería el formato base para sonidos incluidos y archivos propios en v1, evitando una matriz de codecs. El backend exacto de cada plataforma y los límites de tamaño/duración se concretarán tras una prueba técnica; no se considerará soportada una plataforma sin verificación real.

## Alcance y no objetivos

**Incluido:** configuración global opt-in, catálogo de transiciones verificables, sonidos incluidos/propios, UI de configuración, prueba, silencio temporal, deduplicación, agrupación y fallos no bloqueantes.

**Fuera de v1:** notificaciones de escritorio, voz, URLs de audio, ejecutables configurables, horarios, reglas por agente individual/proyecto, sincronización entre sesiones independientes, detección de foco de ventana y perfiles visuales con audio.

Dos sesiones independientes pueden sonar a la vez; la política limita cada instancia, no todos los procesos del equipo.

## Criterios de aceptación y verificación

- [ ] Sin archivo de configuración o con `enabled: false`, no hay audio automático, subprocesses de reproducción ni detección de backend.
- [ ] Cada evento soportado puede configurarse independientemente por origen.
- [ ] `agent_end` no genera éxito cuando el resultado indica fallo o cancelación.
- [ ] Una transición duplicada produce como máximo una notificación; una ejecución nueva puede notificar de nuevo.
- [ ] La restauración de historial y tareas no reproduce sonidos.
- [ ] Los hijos y sesiones no interactivas nunca reproducen audio.
- [ ] Silenciar/desactivar limpia pendientes; reanudar no genera replay.
- [ ] Ráfagas respetan prioridad, intervalo mínimo y ausencia de solapamiento.
- [ ] Configuración inválida, archivo ausente y reproductor fallido no bloquean ni alteran el trabajo.
- [ ] Rutas con espacios y caracteres especiales no se interpretan como comandos.
- [ ] La UI permite configurar, probar y silenciar; la prueba no habilita audio automático.
- [ ] El cierre limpia procesos y listeners sin prolongar indebidamente la salida.
- [ ] Se documentan y verifican manualmente las plataformas declaradas como soportadas.

Usar tests deterministas con reloj y reproductor inyectados para política y deduplicación; tests de adaptadores para eventos reales, restauración y resultado del agente; tests de configuración y argumentos del backend. Aplicar RED/GREEN a esas conductas durante implementación. Complementar con pruebas manuales de UI, escucha y cierre por plataforma. Esta propuesta documental no requiere RED/GREEN.

## Unidades de implementación propuestas

1. **Contrato y política:** confirmar productores de eventos, esquema, configuración y tests de deduplicación/ráfagas.
2. **Audio:** adaptadores, sonidos redistribuibles y tests de fallos, timeout y seguridad.
3. **Integración:** propietario padre, eventos de agente/subagentes y pruebas de no replay/headless.
4. **Configuración y entrega:** UI, documentación y matriz de verificación manual por plataforma.

Cada unidad conservará sus tests junto al código. Estimar el diff antes de implementar y dividir la entrega si el volumen dificulta la revisión.

## Próximo paso

Aprobar o ajustar el alcance de v1 y la configuración global. Después, realizar una exploración técnica acotada de productores de estados y reproducción por plataforma antes de fijar el contrato e implementar.

## Estado de ejecución en este worktree

**Estado histórico al copiar esta propuesta: ejecución aprobada; implementación todavía no iniciada en aquel turno.**
El estado inicial y el texto anterior se conservan como propuesta histórica, sin modificar el original de `gentle-shell`. El alcance aprobado, los contratos refinados y las seis unidades futuras se concretan en el [plan ODD](../odd/tasks/sound-notifications.md), que rige la ejecución.
Esta entrega es solo planificación y copia: sin implementación, review, subagentes ni commits. La elección «Por unidades revisables (recomendado)» autoriza para la ejecución posterior commits LOCALES por unidad con sus tests, no push ni PR.

## Estado actual SN6

SN1–SN5 implementados y entregados por el parent; SN5 `c3a20d8e` (548 líneas, contexto confirmado por parent). SN6 añade el panel Notifications desde customize, validación WAV al seleccionar, consentimiento de recuperación estrictamente booleano y documentación de uso. La guía vigente es [sound-notifications.md](sound-notifications.md); el [ODD](../odd/tasks/sound-notifications.md) conserva RED/GREEN y pendientes.

No se declara aceptación completa: SN6 espera commit del parent, full checks/verifier y manuales de UI, escucha, reload y quit. Linux/macOS tienen adaptadores implementados **UNVERIFIED manual listening**; Windows permanece unavailable. `session.shutdown` se excluye del catálogo runtime/UI para no demorar el cierre, aunque la propuesta histórica pedía mejor esfuerzo y el esquema conserva la clave. La sección Plataformas anterior es intención histórica, no una afirmación actual de soporte Windows ni verificación física. No hay review, commits ni subagentes en este turno de implementación.
