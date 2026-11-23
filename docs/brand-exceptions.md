# Excepciones de marca

Registro de los nombres heredados o externos que se conservan (o se restauran) en
Drakonc Shell porque son contratos reales de Pi, de npm, de GitHub o de un paquete
de terceros. Todo lo que aparece aquí es intencional: el resto de la marca usa el
espacio de nombres `/drakonc:`, el ejecutable `drakonc-shell` y el prefijo
`drakonc-`.

Cada entrada indica el nombre conservado, dónde aparece, a qué contrato pertenece y
por qué es necesario. Al añadir una excepción nueva, incluye también la comprobación
de solo lectura que la justifica (`npm view`, `git ls-remote`, `git show HEAD:`).

Regla aplicada en esta revisión: existir no basta. Una referencia renombrada a
`drakonc-*` solo se conserva si el paquete o repositorio existe y pertenece al
proyecto según sus `maintainers` o `repository`; si no existe, se restaura el nombre
real que la integración necesita o se desactiva, y el caso queda aquí.

## Publicados

Nombres `drakonc-*` que ya existen en su registro (npm o GitHub) y pertenecen al
proyecto. Es la única lista que autoriza a una fuente de instalación a usar un
nombre propio: mientras un nombre no esté aquí, el código usa el nombre heredado y
reconoce el propio solo para deduplicar y excluir (ver «Inventario de fuentes de
instalación» y «Detección dual del paquete Pi» más abajo).

Cada entrada necesita las dos líneas de verificación, sin excepción; si falta una,
`node scripts/check-install-sources.mjs` falla y con él `pnpm test`. Plantilla:

```md
- **`drakonc-ejemplo`** — qué es (paquete npm, repositorio o release).
  - Propietario: `npm view drakonc-ejemplo maintainers repository --json` (AAAA-MM-DD) → <salida literal>.
  - Fecha: AAAA-MM-DD.
  - Fuente: constante que hay que cambiar (archivo) y entrada de `lib/install-sources.ts`.
```

Vacía a fecha 2026-11-22: `npm view drakonc-pi`, `npm view drakonc-engram` y
`git ls-remote https://github.com/Drakoncman-Programming/drakonc-shell` no existen
todavía, así que ningún nombre propio está publicado y ninguna fuente puede usarlo
(fase 2 de `docs/publicar-paquetes.md`).

Pendiente conocido, decidido fuera de esta tarea: `scripts/installer-runner.mjs`
(`SHELL_PACKAGE`) instala el paquete Pi de la Shell desde el registro y solo puede
hacerlo cuando el nombre exista. Mientras tanto el instalador estándar se detiene
antes de cualquier `npm install` con
«drakonc-pi aún no está publicado en npm; instala Drakonc Shell desde el repositorio
github.com/drakonc/drakonc-shell (ver README)», sin caer al `gentle-pi` original,
y la única fuente que funciona es el paquete heredado `npm:gentle-pi` que instala el
binario companion (que el launcher después excluye y borra). El runner devuelve el
motivo `shell-not-published` con ese texto, y el asistente web muestra la misma
frase como guía de ese motivo (`scripts/installer-server.mjs`,
`guidance.blocked["shell-not-published"]`).

## `gentle-pi` (paquete npm)

- **Nombre conservado:** `npm:gentle-pi`, y `"gentle-pi"` como nombre del paquete en
  `settings.json` y en el listado de Pi.
- **Dónde:** `lib/drakonc-shell-launcher.ts` (`settingsDeclareDrakoncPi`,
  `postInstallRemovals`, `findDrakoncPiDeclaration`, `LAUNCHER_EXCLUDED_PI_PACKAGES`,
  ayuda de `install`), `bin/drakonc-shell.mjs`,
  `lib/update-status.ts` (canal `drakonc-ai-managed`), `lib/desktop-rpc-updates.ts`.
- **Nombre reconocido además:** `drakonc-pi`, solo en esas funciones de detección y
  exclusión, nunca como fuente instalable (ver «Detección dual del paquete Pi» más
  abajo y `DRAKONC_PI_PACKAGE_PUBLISHED`).
- **Contrato:** Identidad npm del Pi empaquetado que declara el stack gestionado de
  Drakonc AI y que Pi escribe en `settings.json`. El launcher lo detecta para tomar
  el control y lo excluye para que nunca sobreviva a `setup`.
- **Motivo:** `npm view drakonc-pi` → `E404 Not found`. Declarar un nombre
  inexistente rompe el take-over y la exclusión, y deja el nombre libre para que un
  tercero lo registre (typosquatting). `npm:gentle-pi@5.0.0` sí existe y su
  `repository` es el proyecto original.
- **Comprobado:** `npm view drakonc-pi name version maintainers repository --json`
  (2026-11-22, E404) y `npm view gentle-pi …` (5.0.0, `alan_buscaglia`).

## `gentle-engram` (paquete npm y proveedor de memoria)

- **Nombre conservado:** `npm:gentle-engram`, y `"gentle-engram"` como `name` del
  paquete instalado y como ruta `npm/node_modules/gentle-engram`.
- **Dónde:** `lib/drakonc-shell-bundled.ts` (`ENGRAM_COMPANION_SOURCE`,
  `supportsEngramStartupPolicy`), `bin/drakonc-shell.mjs`
  (`LEGACY_ENGRAM_COMPANION_SOURCE` y toda la migración del companion).
- **Contrato:** paquete Pi de terceros que aporta la memoria persistente; su
  `package.json` es la fuente de verdad de `engram.startupPolicy`.
- **Motivo:** `npm view drakonc-engram` → `E404 Not found`. El companion real es
  `gentle-engram` (0.8.0, `repository` en `Gentleman-Programming/engram`).
- **Versión fija:** `ENGRAM_COMPANION_SOURCE = "npm:gentle-engram@0.8.0"` cumple el
  requisito de que ninguna instalación automática use un nombre sin versión. El pin
  es la versión del companion cuyo `runtime-contract` conoce esta Shell, así que
  subirla es una decisión de release, no de Pi. Consecuencia asumida: Pi ya no
  actualiza ese paquete con `drakonc-shell update --extensions` (una fuente fijada se
  salta el chequeo de actualizaciones de Pi); la actualización llega con una nueva
  versión de Drakonc Shell. `LEGACY_ENGRAM_COMPANION_SOURCE` sigue siendo
  `npm:gentle-engram@0.4.2`, la selección que el launcher antiguo registraba.
- **Pendiente (fuera de este grupo):** el identificador de proveedor
  `"drakonc-engram"` de `lib/auto-permission-memory.ts` y
  `lib/auto-permission-classifier.ts` es el mismo contrato externo (la extensión de
  Engram se registra como `gentle-engram`) y debe revisarse en el barrido de marca.
- **Comprobado:** `npm view drakonc-engram … --json` (E404) y
  `npm view gentle-engram … --json` (0.8.0, `Gentleman-Programming/engram`).

## `github.com/Gentleman-Programming/engram` (descargas con SHA-256)

- **Nombre conservado:** la URL de release del núcleo de Engram.
- **Dónde:** `scripts/installer-downloads.mjs` (`engram` pin 3.7.2), consumida por
  `scripts/bundled-install.mjs` y el instalador del bundle.
- **Contrato:** origen de los archivos `engram_<versión>_<plataforma>.tar.gz`
  verificados con el `sha256` y el tamaño fijados en el pin.
- **Motivo:** `git ls-remote https://github.com/Drakoncman-Programming/engram` →
  `Repository not found`. Se restaura el origen real; **no se cambió ningún hash ni
  tamaño**, porque no hay un `checksums.txt` firmado nuevo que los respalde y los
  valores actuales son los del release publicado.
- **Comprobado:** `git ls-remote` de ambos repositorios (2026-11-22).

## `gentle-stream` (repositorio, proyecto y ejecutable)

- **Nombre conservado:** `gentle-stream`, con el commit
  `381290451544ad2ca3348a68a81b3056bdac73b7` fijado.
- **Dónde:** `extensions/drakonc-music.ts` (`DRAKONC_STREAM_SPEC`, `which`,
  `--from`, mensajes del reproductor), `scripts/bundled-install.mjs`
  (`MUSIC_PLAYER_ARCHIVE`, `musicSpec`, `music/bin/gentle-stream`).
- **Contrato:** proyecto Python publicado en
  `github.com/Gentleman-Programming/gentle-stream`; `uv tool install` exige que el
  nombre del requisito coincida con el `name` de los metadatos, y el ejecutable que
  instala se llama `gentle-stream`. El comando propio sigue siendo `/drakonc:music`.
- **Motivo:** el repositorio `Drakoncman-Programming/drakonc-stream` no existe
  (`Repository not found`) y `drakonc-stream` no es un proyecto publicado. Además el
  spec no fijaba commit; ahora usa el mismo commit que ya fijaba
  `MUSIC_PLAYER_ARCHIVE` (archivo `.tar.gz`, sin hash que re-pinear).
- **Comprobado:** `git ls-remote https://github.com/Gentleman-Programming/gentle-stream HEAD`.

## `gentle-ai` (releases firmados, mirror y módulo Go)

- **Nombre conservado:** `Gentleman-Programming/gentle-ai` para los releases
  firmados y el módulo Go `github.com/gentleman-programming/gentle-ai/v5`; el mirror
  `Gentleman-Programming/gentle-pi` bajo la etiqueta `gentle-ai-mirror-v5.0.0`; los
  nombres de archivo `gentle-ai_5.0.0_<plataforma>_<arquitectura>.tar.gz`; el
  miembro `gentle-ai` dentro del archivo; y el banner `gentle-ai 5.0.0` que imprime
  el binario al pedirle `version`.
- **Dónde:** `scripts/drakonc-ai-installer.mjs` (`RELEASE_BASE_URL`,
  `DRAKONC_AI_MIRROR_RELEASE_BASE_URL`, `DRAKONC_AI_WINDOWS_SOURCE_*`,
  `DRAKONC_AI_RELEASE_ASSETS`, `drakoncAiAssetForm`,
  `RELEASE_ARCHIVE_EXECUTABLE`, `assertExactDrakoncAiVersion`).
- **Contrato:** origen de los binarios de Drakonc AI y de su build desde la SumDB de
  Go. Los `sha256` de archivo y de binario siguen siendo los del release publicado:
  **no se modificó ninguno**.
- **Motivo:** `github.com/Drakoncman-Programming/drakonc-ai` y
  `github.com/drakoncman-programming/drakonc-ai` no existen (`Repository not
  found`), y el nombre de archivo forma parte de la URL. Se restaura el origen real
  y se mantiene el nombre local del binario instalado (`.drakonc-ai/v5.0.0/drakonc-ai`),
  que es lo que `lib/drakonc-ai-binary.ts` resuelve.
- **Comprobado:** `git ls-remote` de ambos repositorios (2026-11-22).
- **Riesgo abierto (fuera de este grupo):** el binario restaurado se llama
  `gentle-ai` aguas arriba y, entre otras cosas, imprime `gentle-ai 5.0.0` y usa sus
  propias variables (`GENTLE_PI_CONFIG_HOME`, `~/.gentle-ai`), mientras el launcher le
  pasa las de Drakonc y lo instala como `drakonc-ai`. Ese desacople es anterior a este
  cambio y necesita una decisión de producto (fork publicado o adaptador), no un
  renombrado de cadenas. Lo urgente ya está contenido: ver la sección «Variables
  `GENTLE_*` del binario companion».

## Variables `GENTLE_*` del binario companion

- **Nombres conservados:** `GENTLE_AI_HOME`, `GENTLE_AI_PI_CONFIG_DIR`,
  `GENTLE_AI_ENGRAM_BIN`, `GENTLE_AI_NO_SELF_UPDATE` y `GENTLE_PI_CONFIG_HOME`,
  junto a sus equivalentes `DRAKONC_*`, con el mismo valor cada par.
- **Dónde:** `lib/drakonc-ai-binary.ts` (`drakoncAiIsolationEnv`,
  `standaloneDrakoncAiEnv`, `drakoncAiIsolationVariables`), que es el entorno que
  recibe el companion desde `bin/drakonc-shell.mjs` (`buildSetupEnv`),
  `lib/review-host-relay.ts`, `lib/telemetry-trigger.ts`,
  `lib/runtime-metrics-native.ts` y `lib/native-review-cli.ts`. Nunca se ponen en
  el entorno de Pi ni en el de su shell.
- **Contrato:** nombres de entorno del binario `gentle-ai` 5.0.0, la versión fijada
  por `sha256` en `scripts/drakonc-ai-installer.mjs` e instalada como
  `.drakonc-ai/v5.0.0/drakonc-ai`. Ese binario **solo** lee `GENTLE_*` (y
  `GENTLE_PI_CONFIG_HOME`/`GENTLE_PI_AGENT_HOME`/`GENTLE_PI_CONFIG_ROOT`), y le
  añade `gentle-ai` a la carpeta que `GENTLE_PI_CONFIG_HOME` nombra.
- **Motivo:** con las variables renombradas a `DRAKONC_*` el binario no reconocía
  ninguna y usaba sus rutas por defecto: el primer arranque real escribió
  `~/.pi/gentle-ai/persona.json`, actualizó `~/.gentle-ai/state.json` y creó
  `~/.gentle-ai/pi-codegraph-*.json`. Tampoco recibía la orden de no
  autoactualizarse, que invalidaría el `sha256` fijado con un release de otro
  proyecto. Cada par se emite con el mismo valor: hoy manda el nombre que el
  binario entiende, y el día que exista un `drakonc-ai` propio que lea `DRAKONC_*`
  el juego `GENTLE_*` se retira con su propia tarea, sin cambiar la lógica.
- **Respaldos contenidos:** fuera del modo empaquetado el companion recibe
  `GENTLE_PI_CONFIG_HOME` = padre de la carpeta de configuración de Drakonc, así
  que una escritura de respaldo cae en `<padre>/gentle-ai` y nunca en
  `~/.pi/gentle-ai`. Su estado (`GENTLE_AI_HOME`) va a `~/.drakonc-shell/drakonc-ai-home`
  (o al valor que el usuario haya definido con `DRAKONC_AI_HOME`/`GENTLE_AI_HOME`,
  nunca una carpeta de `~/.gentle-ai`, `~/.pi` o `~/.gentle-shell`).
- **Persona y estado compartidos:** `sharedDrakoncAiPersonaPaths` y
  `sharedDrakoncAiStatePaths` cubren también `~/.pi/gentle-ai/persona.json` y
  `~/.gentle-ai/state.json`, que es donde escribe este binario, para que un
  `setup` no los deje cambiados. No se borra nada de lo que la versión anterior
  escribió allí.
- **Comprobado (2026-11-22, solo lectura):** `strings .drakonc-ai/v5.0.0/drakonc-ai`
  muestra `GENTLE_AI_HOME`, `GENTLE_AI_PI_CONFIG_DIR`, `GENTLE_AI_ENGRAM_BIN`,
  `GENTLE_AI_NO_SELF_UPDATE` y `GENTLE_PI_CONFIG_HOME`, y ninguna variable
  `DRAKONC_*`. La prueba `tests/companion-no-write.test.ts` ejecuta un sustituto
  del binario con ese contrato sobre un `HOME` temporal y comprueba que `~/.pi`,
  `~/.gentle-ai` y `~/.gentle-shell` quedan idénticos.

## Contrato del binario gentle-ai y bundle del proveedor

- **Nombres conservados:** los identificadores de esquema `gentle-ai.*` que cruzan la
  frontera con el companion instalado y con `contracts/`, y los bytes reales de
  `contracts/` (esquemas, fixtures, bundle espejado, lock y baselines generadas).
- **Dónde:**
  - `lib/native-review-cli.ts`, `lib/review-integration-v2.ts`,
    `lib/review-sidebar-state.ts`, `lib/review-graph-schema.ts`,
    `lib/review-transaction.ts`, `lib/review-object-store.ts`,
    `lib/review-risk-assessment.ts`, `lib/review-snapshot.ts`,
    `lib/review-repository.ts`, `lib/review-canonical.ts`,
    `lib/review-consent-ui.ts`, `lib/review-relay-contract.ts`,
    `lib/provider-contract-bundle.ts`, `lib/background-subagents-policy.ts`,
    `lib/telemetry-trigger.ts`, `lib/runtime-metrics-native.ts`,
    `lib/runtime-metrics-policy.ts`, `lib/desktop-rpc-review.ts`,
    `extensions/drakonc-ai.ts`, `scripts/mirror-provider-contract.mjs`,
    `scripts/maintainer/provider-relay-matrix.mjs`, `scripts/test-packed-runner.mjs`,
    `runtime/*.mjs` (generado) y las pruebas y fixtures que reproducen respuestas del
    binario.
  - `contracts/review-integration/`, `contracts/review-provider-contract-mirror/` y
    `contracts/telemetry/`.
- **Contrato:** el companion instalado en `.drakonc-ai/v5.0.0/drakonc-ai` **es**
  `gentle-ai` 5.0.0 y emite sus envelopes con los esquemas `gentle-ai.*` y
  `gentle-ai.dev/schema/...`; también imprime `gentle-ai <comando>` en las
  continuaciones que renderiza (`gentle-ai review status --cwd <repo> …`,
  `gentle-ai review start --contract …`). El espejo `contracts/` se verifica por
  `sha256` contra su `manifest.json` y su lock, y `docs/review-integration.md` se
  verifica contra la misma línea base de bytes: cualquier cambio de nombre dentro de
  esos archivos rompe la verificación.
- **Motivo:** el renombrado masivo cambió 188 apariciones de esquema a `drakonc-ai.*`
  y los bytes de `contracts/`, con dos consecuencias visibles al arrancar:
  «receipt-driven development status is unavailable: native `drakonc-ai review mode
  status` failed (schema-incompatible)» y «Drakonc Shell cannot render its ODD steps:
  the mirrored provider bundle's routing/pi.md is missing, unreadable, or fails digest
  verification». Los nombres `drakonc-*` de estas posiciones no son una decisión de
  marca: son valores que el binario y el bundle publicado fijan, y escribirlos con
  otro prefijo los hace ilegibles o los invalida por `sha256`. El nombre del
  ejecutable instalado (`drakonc-ai`) sí se conserva en ayudas y mensajes propios,
  porque es el archivo que el usuario tiene en disco.
- **Nombre propio reconocido además:** los eventos y archivos que Drakonc posee por
  completo (`drakonc-pi:usage-source/v1`, `drakonc-pi.session-profile/*`,
  `drakonc-pi.background-subagents/v1`, `drakonc-pi.review-relay/v1` como nombre
  exportado, etc.) siguen con el prefijo propio; solo el **valor** que viaja al
  binario o se valida contra `contracts/` usa el nombre heredado.
- **Comprobado (2026-11-22, solo lectura):**
  `strings -n 10 .drakonc-ai/v5.0.0/drakonc-ai | grep -oE "gentle-ai\.[a-z0-9.-]+/v[0-9]+"`
  lista los 118 esquemas `gentle-ai.*` del binario (entre ellos
  `gentle-ai.rdd-mode-status/v1`, `gentle-ai.provider-transport/v1`,
  `gentle-ai.review-integration.status/v9`, `gentle-ai.review-mode/v1` y
  `gentle-ai.telemetry-trigger/v1`) y
  `grep -aF 'gentle-pi.background-subagents/v1'` y
  `grep -aF 'gentle-pi.review-relay/v1'` confirman los dos contratos `gentle-pi.*`
  que el binario también lee. `node scripts/check-provider-contract.mjs` valida el
  espejo contra su lock y `node scripts/verify-package-files.mjs` los bytes
  empaquetados.
- **Variable de entorno del handshake:** `lib/review-relay-contract.ts` exporta
  `DRAKONC_PI_REVIEW_RELAY_CONTRACT_ENV`, pero su **valor** es
  `GENTLE_PI_REVIEW_RELAY_CONTRACT`: el binario solo admite el relay de Pi cuando
  esa variable vale exactamente `gentle-pi.review-relay/v1`, y con el nombre
  renombrado la sesión se quedaba cerrada (`fail-closed`) antes de cualquier
  STATUS.
- **Pendiente fuera de esta tarea:** el binario también lee
  `gentle-pi.background-subagents/v1` y `gentle-pi.strict-tdd/v1` de su propio
  `config/background-subagents.json`, mientras Drakonc escribe
  `drakonc-pi.background-subagents/v1` en el hogar de configuración de Pi. Son
  archivos distintos (la ruta del binario cuelga de `GENTLE_PI_CONFIG_HOME`), así
  que el nombre propio se conserva; si algún día comparten archivo, el valor tendrá
  que volver al heredado.
- **Pendiente fuera de esta tarea:** el texto del bundle restaurado nombra la fachada
  de Pi como `gentle_review`/`gentle_review_capture`, mientras Drakonc registra
  `drakonc_review`/`drakonc_review_capture`. Renombrar esos bytes rompería el
  `sha256` del espejo; la salida correcta es reescribir esos nombres al componer el
  prompt, no en el archivo espejado (ver el informe de la tarea 5.6).

## `github.com/Gentleman-Programming/gentle-shell/releases/download` (distribución)

- **Nombre conservado:** la base de releases del instalador del bundle.
- **Dónde:** `scripts/bundled-wizard.mjs` (`DISTRIBUTION_RELEASES`).
- **Contrato:** base de `v<versión>/<asset>` que el asistente descarga (manifiesto de
  distribución y lockfile), con tamaños acotados y hosts de redirección permitidos.
- **Motivo:** Drakonc Shell todavía no publica releases propias, así que
  `Drakoncman-Programming/drakonc-shell` no existe (`Repository not found`) y ninguna
  URL de esa base resuelve. Se restaura la única base que resuelve hoy.
- **Acción pendiente:** reapuntar a la distribución real de Drakonc en cuanto exista
  un release publicado (tarea de publicación, fuera de este cambio).

## Inventario de fuentes de instalación

`lib/install-sources.ts` es la lista única de lo que Drakonc Shell instala
automáticamente y de dónde sale cada fuente: el companion de memoria
(`ENGRAM_COMPANION_SOURCE`), el paquete Pi de la Shell en el registro
(`SHELL_PACKAGE` del instalador), el reproductor de música (`DRAKONC_STREAM_SPEC`
y su archivo), el binario companion con sus releases y su espejo
(`scripts/drakonc-ai-installer.mjs`), y las descargas verificadas de Node, pnpm,
Go, uv y Engram (`scripts/installer-downloads.mjs`). Cada entrada declara su forma
de fijación: versión exacta de npm, commit SHA de 40 caracteres o checksum
`sha256`/`sha512`.

La única excepción documentada es `pi install npm:gentle-pi` sin versión, que
ejecuta el binario companion y no acepta argumentos nuestros (ver la sección
«`gentle-pi`» arriba).

Una fuente puede estar **condicionada a la publicación** (`requiresPublication`):
es el caso de `shell-pi-registry`, el paquete Pi de la Shell en el registro.
Mientras `drakonc-pi` no esté publicado, `scripts/installer-runner.mjs` se detiene
antes de cualquier `npm install` y responde que instale Drakonc Shell desde el
repositorio, así que esa fuente no llega a ejecutarse y no se le exige la entrada
en «Publicados»; en cuanto `DRAKONC_PI_PACKAGE_PUBLISHED` pase a `true`, la
comprobación vuelve a exigirla.

`node scripts/check-install-sources.mjs` (paso propio de `pnpm test`) falla si una
fuente pierde su fijación, si una fuente usa un nombre `drakonc-*` que no figura en
«Publicados», o si el flag `DRAKONC_PI_PACKAGE_PUBLISHED` de
`lib/drakonc-shell-launcher.ts` no coincide con esa sección.

## Detección dual del paquete Pi (`gentle-pi` / `drakonc-pi`)

Mientras `drakonc-pi` no esté publicado, `lib/drakonc-shell-launcher.ts` reconoce
los dos nombres del paquete Pi de la Shell **solo para deduplicar y excluir**
(tarea 3.2, D6, hallazgo `security` S6): `settingsDeclareDrakoncPi`,
`findDrakoncPiDeclaration`, `postInstallRemovals` y
`LAUNCHER_EXCLUDED_PI_PACKAGES`.

- Un `settings.json` que declara `npm:gentle-pi` no se duplica: el launcher no
  inyecta una segunda copia.
- Un `npm:drakonc-pi` no publicado se excluye, se borra en `setup` y **no** cuenta
  como declaración propia, así que el launcher sigue cargando su copia; nunca se
  ejecuta ni se propone `pi install npm:drakonc-pi`.
- `DRAKONC_AI_PI_EXCLUDE_PACKAGES` solo lleva fuentes que existen en npm, porque el
  binario companion rechaza cualquier otro valor.
- La detección por ruta admite los dos nombres y, cuando el llamador pasa la raíz
  del paquete, solo cuenta la carpeta que es ese mismo `packageRoot`: una ruta
  ajena sin versión fijada no es una declaración propia.

El día que `drakonc-pi` figure en «Publicados», basta con poner
`DRAKONC_PI_PACKAGE_PUBLISHED = true` y cambiar la constante de la fuente: la
comprobación mantiene las dos cosas en sincronía.

## Excepciones reservadas para el barrido de marca

Estas ya están decididas en `openspec/changes/completar-identidad-drakonc-shell/` y
se documentarán en detalle al ampliar este registro:

- `gentle-pi:usage-source/v1` como alias del contrato de fuentes de uso (el paquete
  de terceros `gentle-opencode-go@0.1.2` lo emite).
- `gentle-opencode-go` como fuente de uso de OpenCode Go (paquete de terceros).
- `showRose` de `banner.json`: clave persistida del usuario que no se migra.
- `LICENSE`, `TRADEMARKS.md`, avisos de copyright y licencias de recursos de
  terceros: se conservan íntegros.
