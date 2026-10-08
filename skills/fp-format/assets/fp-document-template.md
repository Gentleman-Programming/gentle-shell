# <ID FP existente o aprobado> — <Resultado funcional>

**Belongs to:** `<código padre confirmado>`
**Work unit prefix:** `FP-`

<!-- Contrato de prefijo: conservar el literal inglés **Work unit prefix:** y
     sustituir FP- solo por el prefijo confirmado, sin renumerar los IDs.
     Sin declaración, el mapa espera FP-. Se leen todas las líneas, quitando
     espacios exteriores y un marcador de lista opcional; los dos puntos pueden
     ir dentro o inmediatamente después de la negrita. La primera declaración
     legible gana para este documento, no para los demás.
     La coincidencia es literal y sensible a mayúsculas: prefijo seguido de
     dígitos y grupos opcionales de guion y dígitos. Con T, T1 es fila y TR-1
     es paso. Las continuaciones con letra Unicode o punto (T1b, T1.2) son
     subelementos, nunca filas, incluso si falta su padre.
     Ambas omisiones nombran el documento y no cambian la resolución: una
     declaración sin span entre comillas invertidas, con varios, con valor
     vacío, espacios en blanco o una comilla invertida es ilegible y se ignora;
     toda declaración legible posterior es duplicada y se ignora, aunque sea
     idéntica. Una ilegible no impide que gane otra legible posterior. -->

<!-- Reemplazar el marcador solo por un código padre existente o aprobado y
     confirmado para este documento. No inferirlo. Si la declaración original
     está mal formada o es ambigua, informar y preguntar antes de modificarla. -->

> Plantilla para el documento de funcionalidad ODD autoritativo, no para una
> copia paralela. Sustituir marcadores solo con información aprobada. Conservar
> IDs, estados y literales existentes; esta plantilla no autoriza conversiones.

## Contexto del punto funcional

**Estado:** <Estado original o aprobado; no inferir avance>

**Objetivo:** <Resultado para el usuario; si falta, indicar dato faltante>

**Problema:** <Situación que motiva el FP; si falta, indicar dato faltante>

**Justificación:** <Razón respaldada por la entrada aprobada; no inventar>

**Alcance:** <Qué incluye y qué excluye>

**Dependencias:** UNKNOWN — falta declaración en la entrada.
<!-- Sustituir solo con dependencias explícitas o ausencia explícitamente confirmada. -->

## Lista de tareas

<!-- Repetir con los IDs y marcadores originales, sin renumerar ni cambiar estados. -->
- [ ] **<ID tarea existente o aprobado> — <Resultado de la tarea>**
  **Allowed edit surfaces:** `<ruta relativa confirmada>`
  <!-- Mantener la declaración en el cuerpo indentado de esta unidad, en una
       sola línea. Sustituir el marcador únicamente con rutas aprobadas.

### Contrato de superficies

Cada entrada contiene una ruta entre comillas invertidas, precedida opcionalmente
por `superficie:`. Leer de izquierda a derecha: el nombre abre un grupo para esa
ruta y las siguientes sin nombre hasta el próximo nombre, válido o no.
Separar entradas con comas. El parser lee entradas reconocidas, no valida la
sintaxis completa de la línea. Vocabulario exacto y sensible a mayúsculas:
`productUx`, `web`, `api`, `data`, `security`, `operations`, `tests`.
Un nombre canónico asigna la superficie a su grupo sin consultar la tabla;
una ruta anterior al primer nombre usa `surfaceForDeclaredPath` y la tabla canónica del harness (gana el
prefijo más largo). Conservar el marcador `**Allowed edit surfaces:**` en inglés.

Un nombre desconocido invalida su grupo: cada ruta hasta el próximo nombre genera
su propia omisión que identifica la capability, el documento fuente, el nombre
infractor y la ruta; no asigna superficie ni recurre a la tabla. Una ruta anterior
al primer nombre y sin coincidencia también genera una omisión, nunca una suposición.
Las rutas en las omisiones llevan el span declarado sin prefijo de superficie;
el lector del documento normaliza el espacio en blanco antes del parsing, por lo
que las secuencias de espacios o tabulaciones dentro de una ruta se colapsan.
Si faltan datos, informarlo.

Para delegar, el padre transforma esta declaración en rutas relativas al
repositorio, una por línea, dentro de `## Allowed edit surfaces`. Nunca copiar
la forma ``superficie: `ruta` `` a ese bloque: `lib/bounded-writer-admission.ts`
solo admite rutas simples o íntegramente entre comillas invertidas y bloquea
cualquier otra forma. Esta declaración no autoriza por sí sola una delegación.
  -->

## Explicación de tareas

### <ID tarea existente o aprobado> — <Resultado de la tarea>

**Explicación:** <Qué cambia y por qué contribuye al FP; indicar si falta>

**Alcance técnico:** <Rutas, comandos y nombres de API exactos suministrados>

**Dependencias:** UNKNOWN — falta declaración en la entrada.

**Criterios de aceptación:**

- <Condición observable aprobada; si falta, indicar criterio faltante>

**Verificación prevista:**

- <Comprobación o comando exacto autorizado; si falta, indicar dato faltante>
- Resultado esperado: <Comportamiento aprobado que debe comprobarse>

**Evidencia:** Pendiente — no se ha realizado la comprobación prevista.
Registrar aquí el resultado observado y su referencia cuando existan; no marcar
la tarea como completada por haber redactado este documento.

## Datos faltantes y decisiones pendientes

- <Información ausente o decisión por confirmar; no completar por suposición>

## Próximo paso

<Acción acordada, sin afirmar ejecución, aprobación ni verificación inexistentes>

<!-- Belongs to es una convención documental adoptada, no una garantía de que
     el mapa de la versión 4.0.0 consuma este campo. -->
