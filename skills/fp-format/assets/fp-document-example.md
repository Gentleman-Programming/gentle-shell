# FP-1 — Consultar el horario de una biblioteca ficticia

**Belongs to:** `BIB-PLAN`
**Work unit prefix:** `FP-`

<!-- Contrato de prefijo del ejemplo: **Work unit prefix:** conserva su literal
     inglés y contiene exactamente un valor entre comillas invertidas. Sin
     declaración, el mapa espera FP-. Se leen todas las líneas, quitando
     espacios exteriores y un marcador de lista opcional; los dos puntos pueden
     ir dentro o inmediatamente después de la negrita. La primera declaración
     legible gana solo para este documento.
     La coincidencia es literal y sensible a mayúsculas: prefijo seguido de
     dígitos y grupos opcionales de guion y dígitos. Aquí FP-1 es fila y HOR-01
     y HOR-02 son pasos, sin renumerarlos. Con T, T1 sería fila y TR-1 seguiría
     siendo paso. Las continuaciones con letra Unicode o punto (T1b, T1.2)
     son subelementos, nunca filas, incluso sin su padre.
     Ambas omisiones nombran el documento y mantienen la resolución: una
     declaración sin span entre comillas invertidas, con varios, con valor
     vacío, espacios en blanco o una comilla invertida es ilegible y se ignora;
     toda declaración legible posterior es duplicada y se ignora, aunque sea
     idéntica. Una ilegible no impide que gane una legible posterior. -->

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

- [ ] **FP-1 — Consultar el horario de una biblioteca ficticia**
  **Allowed edit surfaces:** web: `apps/web/horario/**`, `web/horario-compartido.ts`, tests: `apps/web/horario/horario.test.ts`
  La entrada ficticia aprueba estas rutas para el punto funcional; HOR-01 y
  HOR-02 describen sus dos casos de presentación.
- [ ] **HOR-01 — Mostrar el horario semanal**
- [ ] **HOR-02 — Mostrar el estado sin horario publicado**

<!--
## Contrato de superficies del ejemplo

La declaración está en el cuerpo indentado de FP-1, inmediatamente debajo de su
checkbox, y todas las entradas ocupan una sola línea. El marcador literal
`**Allowed edit surfaces:**` permanece en inglés. Cada entrada es un nombre
opcional seguido de `:` y exactamente una ruta entre comillas invertidas;
el nombre abre un grupo para esa ruta y las siguientes sin nombre hasta el
próximo nombre, válido o no, leyendo de izquierda a derecha. El parser lee
entradas reconocidas, no valida la sintaxis completa de la línea.

Los nombres canónicos exactos son `productUx`, `web`, `api`, `data`, `security`,
`operations`, `tests`. Aquí `web` asigna tanto `apps/web/horario/**` como
`web/horario-compartido.ts` sin consultar la tabla. `tests` abre otro grupo y
asigna la ruta de prueba sin reinterpretarla por su ubicación. Solo las rutas
anteriores al primer nombre usan `surfaceForDeclaredPath` y la tabla canónica
del harness (prefijo más largo).

Un nombre desconocido, como `mobile`, invalida su grupo: cada ruta hasta el
próximo nombre produce su propia omisión que identifica la capability, el
documento fuente, el nombre infractor y la ruta, sin asignación ni recurso a la
tabla. Una ruta anterior al primer nombre sin coincidencia también produce una omisión;
no se adivina. Las rutas en las omisiones llevan el span declarado sin prefijo
de superficie; el lector del documento normaliza el espacio en blanco antes del
parsing, por lo que las secuencias de espacios o tabulaciones dentro de una ruta
se colapsan.

Si el padre delega este trabajo, transforma la declaración en rutas relativas
al repositorio, una por línea, en `## Allowed edit surfaces`. Nunca copia
``superficie: `ruta` `` al bloque: `lib/bounded-writer-admission.ts` bloquea
cualquier entrada que no sea una ruta simple o íntegramente entre comillas
invertidas. La declaración no autoriza por sí sola una delegación.
-->

## Explicación de tareas

### FP-1 — Consultar el horario de una biblioteca ficticia

**Explicación:** Reunir el horario publicado y el caso sin publicación bajo el
mismo resultado funcional, sin cambiar los IDs HOR-01 y HOR-02.

**Criterios de aceptación:** Se cumplen los criterios de HOR-01 y HOR-02.

**Verificación prevista:** Inspeccionar ambos casos como se detalla abajo.

**Evidencia:** Pendiente — no se han implementado ni comprobado los casos.

### HOR-01 — Mostrar el horario semanal

**Explicación:** Presentar los siete días en orden permite reconocer el horario
sin reconstruirlo a partir de avisos separados.

**Alcance técnico:** Las rutas se declaran en FP-1; la entrada ficticia no
especifica comandos ni APIs.

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

**Alcance técnico:** Las rutas se declaran en FP-1; la entrada ficticia no
especifica comandos ni APIs.

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
- APIs y comandos de prueba: no suministrados en este escenario.
- No faltan explicaciones ni criterios en esta entrada ficticia; si faltaran en
  una entrada real, se declararían faltantes en lugar de completarlos por intuición.

## Próximo paso

Confirmar los datos técnicos faltantes antes de planificar la implementación.
El campo `Belongs to` expresa la convención documental adoptada; no garantiza
que el mapa de la versión 4.0.0 interprete estas relaciones.
