# Desktop RPC: gentle-shell-gpui parity

Objective: add the Desktop RPC methods and events that gentle-shell-gpui needs to stop reading or writing Gentle Shell's private files, sending slash commands as prompt text, or parsing terminal output.
Branches: `feat/desktop-rpc-gpui-parity` (this document, from `origin/main`), plus one branch and worktree per task under `C:\Users\devel\dev\gentle-shell-worktrees\desktop-rpc-<area>`, each branched from this document's commit. Delivery: local work-unit commits only; push and PRs are the user's decision. Test runner: `node --experimental-strip-types --test`.

## Specs

Every spec quotes the accepted proposal (assistant message accepted by the user in L4, verbatim, translated only where noted). The gpui evidence comes from the read-only audit of `gentle-shell-gpui` `ee32231` (release 0.1.26).

- S0 (common rules, from the existing Desktop RPC contract in `docs/desktop-rpc.md`): every new method and event is advertised by `capabilities`, is versioned like its siblings, is documented in `docs/desktop-rpc.md` (a `### method` section with params, result, errors, and a `## <Area> limits` section), delegates to the existing owner instead of copying its logic, carries no secrets, no absolute paths and no raw command lines, and answers typed errors. Writes follow the existing revision or confirmation-token pattern of their area; changes made outside Desktop RPC emit `source: "external"` where the area already has events.
- S1 (proposal item 1, verbatim): "**Binding de perfil de la sesión** (lectura + evento). gpui hoy no ve los perfiles elegidos desde la terminal ni los de una sesión retomada."
  - gpui evidence: `crates/app/src/features/session/state.rs:3303-3306` "The Desktop RPC offers no read of the binding".
- S2 (proposal item 2, verbatim): "**`publish_profile` / `clear_profile_binding`**. Hoy viajan como texto de prompt y gpui no recibe un resultado. Export e import afuera: gpui no los usa."
  - gpui evidence: `profiles/actions.rs:453-464`; `workspace/overlays.rs:302-307` send them as plain prompt text.
- S3 (proposal item 3, verbatim): "**`get/set_background_subagents`**. Hoy gpui manda un slash-command y lee el JSON a mano."
  - gpui evidence: `settings/background.rs:124-135` runs `/gentle:background-subagents enable|disable` and reads `background-subagents.json`.
- S4 (proposal item 4, verbatim): "**Stores nuevos en `get/set_config`** para persona, notifications, banner y theme. Así gpui deja de tocar esos archivos y recibe `config_changed`. Telemetry no: gpui no la usa y cambiarla desde afuera roza el consentimiento del usuario."
  - gpui evidence: `settings/snapshot.rs:101-240` reads `persona.json` (project and global) and `banner.json`; `alerts/policy.rs:12,52` reads and writes `notifications.json`; theme is written to `<agent>/settings.json` `theme`.
- S5 (proposal item 5, verbatim): "**Default persistido en `get_permission_mode`**. Es barato y elimina la lectura de `permission-mode.json`."
  - gpui evidence: `shared/gentle_state.rs:22-38`, `settings/snapshot.rs:168`.
- S6 (proposal item 6 and the login evaluation, verbatim): "**`get_auth_status` + `reload_credentials`**, la versión mínima de login que definimos antes." / "`get_auth_status`: devuelve solo qué proveedores tienen credenciales y de qué tipo, nunca el valor." / "`reload_credentials`: hace que la sesión vuelva a leer las credenciales sin reiniciar." / "Logout lo dejaría afuera también."
  - gpui evidence: `setup/extras.rs:385`, `setup/remote.rs:123` read `auth.json` keys; integrations.md "New credentials are only read when the backend starts".
- S7 (proposal item 7, verbatim): "**Evento de progreso de subagentes** (paso, turnos, tools). Hoy gpui parsea un widget de la terminal."
  - gpui evidence: integrations.md "Desktop RPC carries no helper transcript", live step, turns and tools come from the `gentle-agents` widget.
- S8 (proposal item 8, verbatim): "**Lista de definiciones de agentes** y el orquestador por defecto. Hoy gpui lee esos archivos directamente."
- S9 (proposal item 9, verbatim): "**`get_tower`**, solo lectura de la URL. Hoy gpui lanza el comando y parsea su salida. Arrancar Tower sigue por la línea de comandos."
  - gpui evidence: `tower/mod.rs:20-21` spawns `gentle-shell tower --no-open` and parses `Gentle Tower: <url>`.
- S10 (proposal item 10, verbatim): "**`get_status`**. Doctor no: es un diagnóstico interactivo que hace cambios."
- S11 (proposal item 11, verbatim): "**Datos que faltan en lecturas que ya existen**: costo y proveedor en las estadísticas de uso; versiones de Pi y de paquetes fuera de la instalación bundled; eventos para sessions y changes, en vez de polling."
- S12 (out of scope, verbatim from the accepted evaluation): "`run_command` y design open/stop" are out; "Logout lo dejaría afuera también"; also out: "Peers del orquestador", "MCP", "Mensaje de commit", "Música, voz, scratch, historial y skill-registry", and telemetry in S4.

## Tasks

- T1 [S0-S2] profile binding read + event, `publish_profile`, `clear_profile_binding` — worktree `desktop-rpc-profile-binding` — route: delegated — status: pending
- T2 [S0,S3] background-subagents policy read/write + event — worktree `desktop-rpc-background-subagents` — route: delegated — status: pending
- T3 [S0,S4] persona, notifications, banner, theme config stores — worktree `desktop-rpc-settings-stores` — route: delegated — status: pending
- T4 [S0,S5] persisted default in `get_permission_mode` — worktree `desktop-rpc-permission-default` — route: inline (small) — status: pending
- T5 [S0,S6] `get_auth_status` + `reload_credentials` — worktree `desktop-rpc-auth-status` — Risk: item 2 (credentials) — route: delegated + independent verify — status: pending
- T6 [S0,S7] subagent progress event — worktree `desktop-rpc-subagent-progress` — route: delegated — status: pending
- T7 [S0,S8] agent definitions list + default orchestrator — worktree `desktop-rpc-agent-definitions` — route: delegated — status: pending
- T8 [S0,S9] `get_tower` read-only — worktree `desktop-rpc-tower` — route: delegated — status: pending
- T9 [S0,S10] `get_status` read-only — worktree `desktop-rpc-status` — route: delegated — status: pending
- T10 [S0,S11] stats cost/provider, update versions outside bundled, sessions and changes events — worktree `desktop-rpc-read-gaps` — route: delegated — status: pending

## Log

- L1 (user, verbatim): "quisiera que revisemos qué RPCs faltan en gentle-shell para que el repo gentle-shell-gpui pueda ofrecer todas las capacidades de gentle-shell"
- L2 (user, verbatim): "estaria bueno que implementemos todos esos RPC en gentle-shell para que gpui pueda usarlos"
- L3 (user, verbatim): "evalua si realmente es bueno sumarlos  o si los dejamos fuera" / "ok dale y los demas que sí recomendas sumar cuales son?"
- L4 (user, verbatim, accepting the 11-item proposal and the proposed clone location): "ok hacelos"
- L5: the existing clone `C:\Users\devel\dev\gentle-shell` holds another branch (`fix/engram-companion-integrity`) and stays untouched; work happens in worktrees under `C:\Users\devel\dev\gentle-shell-worktrees`, following the per-area precedent of the earlier Desktop RPC PRs. Delivery stays at local commits because push/PR were not authorized and `gh` is not authenticated.
