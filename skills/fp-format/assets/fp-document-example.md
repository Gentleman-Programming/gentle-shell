# FP-1 — Consultar el horario de una biblioteca ficticia

**Belongs to:** `BIB-PLAN`

> Ejemplo íntegramente ficticio. Los IDs, requisitos y dependencias ilustran una
> entrada aprobada imaginaria; no describen un repositorio real. No se ejecutaron
> comprobaciones ni se produjeron evidencias de éxito. En esta entrada imaginaria,
> BIB-PLAN es el código padre confirmado del documento: el plan de servicios de
> la biblioteca ficticia.

## Contexto del punto funcional

**Estado:** Pendiente.

**Objetivo:** Permitir que una persona consulte el horario semanal de la
biblioteca sin solicitarlo por teléfono.

**Problema:** En este escenario ficticio, el horario solo se comunica por teléfono.

**Justificación:** Mostrarlo junto al nombre de la biblioteca reduce la necesidad
de consultar a otra persona para planificar una visita.

**Alcance:** Presentar días y franjas horarias, incluidos los días cerrados.
No incluye reservas ni cambios de horario desde la interfaz.

**Dependencias:** UNKNOWN — la entrada ficticia no declara dependencias del FP.

## Lista de tareas

- [ ] **HOR-01 — Mostrar el horario semanal**
- [ ] **HOR-02 — Mostrar el estado sin horario publicado**

## Explicación de tareas

### HOR-01 — Mostrar el horario semanal

**Explicación:** Presentar los siete días en orden permite reconocer el horario
sin reconstruirlo a partir de avisos separados.

**Alcance técnico:** La entrada ficticia no especifica rutas, comandos ni APIs.

**Dependencias:** Sin dependencias, según declaración explícita de la entrada ficticia.

**Criterios de aceptación:**

- Se muestran los siete días de lunes a domingo junto al nombre de la biblioteca.
- Cada día muestra una franja horaria o el texto «Cerrado».

**Verificación prevista:** Inspeccionar una vista con horario completo y otra
con un día cerrado; comprobar orden, franjas y texto contra los datos de entrada.
No se ha definido un comando de prueba.

**Evidencia:** Pendiente — las vistas no se han implementado ni inspeccionado.
Registrar el resultado y una referencia a las vistas comprobadas cuando existan.

### HOR-02 — Mostrar el estado sin horario publicado

**Explicación:** Distinguir la falta de publicación de un día cerrado evita
interpretar datos ausentes como una confirmación de cierre.

**Alcance técnico:** La entrada ficticia no especifica rutas, comandos ni APIs.

**Dependencias:** HOR-01 — reutiliza la presentación junto al nombre de la biblioteca.

**Criterios de aceptación:**

- Si no hay horario publicado, aparece «Horario pendiente de publicación».
- La ausencia de datos no se representa como siete días cerrados.

**Verificación prevista:** Inspeccionar una vista sin horario y confirmar el
mensaje y la ausencia de cierres inferidos. Falta definir el comando de prueba.

**Evidencia:** Pendiente — no se ha comprobado el estado sin horario.
Registrar el resultado observado, incluidos los fallos, cuando se realice.

## Datos faltantes y decisiones pendientes

- Dependencias del FP: UNKNOWN, no equivale a ausencia confirmada.
- Rutas, APIs y comandos de prueba: no suministrados en este escenario.
- No faltan explicaciones ni criterios en esta entrada ficticia; si faltaran en
  una entrada real, se declararían faltantes en lugar de completarlos por intuición.

## Próximo paso

Confirmar los datos técnicos faltantes antes de planificar la implementación.
El campo `Belongs to` expresa la convención documental adoptada; no garantiza
que el mapa de la versión 4.0.0 interprete estas relaciones.
