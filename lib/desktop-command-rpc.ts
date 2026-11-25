/**
 * Gentle Shell's own extension commands that work from an RPC client.
 *
 * Pi's command registry (`pi.getCommands()`) carries only name, description,
 * source and sourceInfo (agent-session.js `getCommands`), so a flag passed to
 * `registerCommand` never reaches the Desktop feed; this list is the
 * declaration instead, keyed by exact invocation name. Pi renames duplicated
 * names (`name:1`, `name:2`), so a renamed duplicate never matches an entry.
 *
 * A command is listed only when its handler, read in full, answers through
 * what Pi's RPC mode forwards to the client (modes/rpc/rpc-mode.js
 * `createExtensionUIContext`: select, confirm, input, editor and notify become
 * `extension_ui_request` lines; `custom()` resolves undefined and raw terminal
 * input is ignored), through plain messages, or through side effects, on
 * every path the bare command or its documented arguments reach. In RPC mode
 * `ctx.hasUI` is true (runner.js `hasUI`: the UI context is not the no-op
 * one) and `ctx.mode` is "rpc". A handler that uses `ui.custom`, an overlay
 * or a TUI component, refuses when `ctx.mode !== "tui"`, or reads the TUI
 * editor draft is left out, and so is everything this list does not name:
 * undeclared means `rpc: false`.
 *
 * `terminal` is a different property (Herdr types commands into the TUI and
 * shows the Terminal afterwards); this list never changes it.
 */
const RPC_CAPABLE_EXTENSION_COMMANDS: ReadonlySet<string> = new Set([
	// extensions/gentle-ai.ts `gentle:install-${owner}`: installs assets, then notify.
	"gentle:install-delegation",
	"gentle:install-review",
	// extensions/gentle-ai.ts "gentle:persona" -> handlePersonaCommand: ui.select, then notify.
	"gentle:persona",
	// extensions/gentle-ai.ts "gentle:dev-binary": status | <path> | off, notify only.
	"gentle:dev-binary",
	// extensions/gentle-ai.ts "gentle:status-timing" -> lib/status-timing-diagnostics.ts `command`: notify only.
	"gentle:status-timing",
	// extensions/gentle-ai.ts "gentle:rdd" -> openRddSelector: bindRddOwner accepts mode "tui" or "rpc"; ui.select, then notify.
	"gentle:rdd",
	// extensions/gentle-ai.ts "gentle:review-mode": status | enable | disable, notify only.
	"gentle:review-mode",
	// extensions/gentle-ai.ts "gentle:telemetry": runs the gentle-ai telemetry trigger, notify only.
	"gentle:telemetry",
	// extensions/gentle-ai.ts "gentle:background-subagents": ui.select when hasUI (true in RPC), then notify.
	"gentle:background-subagents",
	// extensions/gentle-ai.ts "gentle:status": notify only.
	"gentle:status",
	// extensions/gentle-design.ts DESIGN_COMMAND_NAME ("gentle:design"): opens the browser canvas,
	// sends the design skill as a user message, or notifies; no TUI component.
	"gentle:design",
	// extensions/gentle-shell.ts "gentle:vim": ui.select when hasUI, writes the policy, notify.
	"gentle:vim",
	// extensions/gentle-shell.ts "gentle:animations": ui.select when hasUI, writes the policy, notify.
	"gentle:animations",
	// extensions/gentle-shell.ts DOUBLE_ESC_CANCEL_COMMAND_NAME ("gentle:double-esc-cancel"): notify only.
	"gentle:double-esc-cancel",
	// extensions/gentle-tower.ts "gentle:tower": starts the tower, opens the browser, notify.
	"gentle:tower",
	// extensions/session-scratch.ts "gentle:scratch": list | clean; clean asks ui.confirm when hasUI, then notify.
	"gentle:scratch",
	// extensions/skill-registry.ts "skill-registry:refresh": regenerates the registry, notify only.
	"skill-registry:refresh",
	// extensions/startup-banner.ts registerBannerCommand / registerToggleCommand / registerColorCommand:
	// ui.select (or a direct toggle), writes the banner config, notify.
	"gentle:banner",
	"gentle:toggle-rose",
	"gentle:toggle-text-logo",
	"gentle:banner-color",
]);

/** Whether a registry extension command is declared to work from an RPC client (undeclared: false). */
export function extensionCommandWorksOverRpc(name: string): boolean {
	return RPC_CAPABLE_EXTENSION_COMMANDS.has(name);
}
