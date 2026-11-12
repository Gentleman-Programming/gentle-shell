import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";

const WIDGET_KEY = "gentle-shell:program-identity";
const STATES = new Set(["idle", "working", "blocked", "done", "error", "clear"]);

const HERDR_BUSY_CHANNEL = "herdr:busy";

type Installed = { release: () => void; refresh: () => void };
const NOOP: Installed = { release: () => {}, refresh: () => {} };

// gentle-shell#3004: Herdr Core learns state only from OSC 7501, so while owned
// background subagents run (herdr:busy), a native done/idle is reported as
// working. blocked, error and clear are never masked.
function installIdentity(terminal: Terminal, busyLabel: () => string | undefined): Installed {
	const original = terminal.setProgramStatus;
	if (typeof original !== "function") return NOOP;
	let active = true;
	let latest: ProgramStatus | undefined;
	const effective = (status: ProgramStatus): ProgramStatus => {
		if (status.state === "clear") return status;
		const label = busyLabel();
		if (label !== undefined && (status.state === "done" || status.state === "idle")) {
			return { ...status, app: "gentle-shell", state: "working", message: label };
		}
		return { ...status, app: "gentle-shell" };
	};
	const wrapped = (status: ProgramStatus) => {
		if (!active) return original.call(terminal, status);
		latest = { ...status };
		original.call(terminal, effective(status));
	};
	// Re-report the latest native status after a busy edge. Without one, only a
	// raise has anything to say; a lower has nothing to restore.
	const refresh = () => {
		if (!active) return;
		if (latest) original.call(terminal, effective(latest));
		else if (busyLabel() !== undefined) original.call(terminal, effective({ state: "working" }));
	};
	terminal.setProgramStatus = wrapped;

	// Pi reports before session_start. Replay its exact cached state rather than
	// inventing idle and potentially erasing a native blocked/working report.
	// This cache is a guarded Pi implementation detail, not an extension API.
	const cached = (terminal as unknown as { programStatus?: unknown }).programStatus;
	if (cached && typeof cached === "object" && "state" in cached
		&& typeof cached.state === "string" && STATES.has(cached.state)) {
		wrapped(cached as ProgramStatus);
	}

	const release = () => {
		if (!active) return;
		active = false;
		// A later extension may wrap ours. Leave its method installed; our
		// inactive wrapper becomes a transparent pass-through in that chain.
		if (terminal.setProgramStatus !== wrapped) return;
		terminal.setProgramStatus = original;
		if (latest) original.call(terminal, latest);
	};
	return { release, refresh };
}

export function createProgramIdentityExtension(env: NodeJS.ProcessEnv = process.env) {
	return (pi: ExtensionAPI): void => {
		if (env.PI_PROGRAM_STATUS_APP !== "gentle-shell" || env.GENTLE_PI_AGENTS_CHILD === "1") return;
		let dispose: (() => void) | undefined;
		let installed: Installed | undefined;
		let busy: string | undefined;
		pi.events.on(HERDR_BUSY_CHANNEL, (data: unknown) => {
			const d = data as { active?: unknown; label?: unknown } | null;
			if (d?.active === true && typeof d.label === "string") busy = d.label;
			else if (d?.active === false) busy = undefined;
			else return;
			installed?.refresh();
		});
		pi.on("session_start", (_event, ctx) => {
			dispose?.(); dispose = undefined;
			if (ctx.mode !== "tui" || !ctx.hasUI) return;
			ctx.ui.setWidget(WIDGET_KEY, (tui) => {
				const handle = installIdentity(tui.terminal, () => busy);
				const cleanup = () => { handle.release(); if (installed === handle) installed = undefined; };
				installed = handle;
				dispose = cleanup;
				return { render: () => [], invalidate() {}, dispose: cleanup };
			});
		});
		pi.on("session_shutdown", (_event, ctx) => {
			const cleanup = dispose;
			dispose = undefined;
			cleanup?.();
			if (cleanup && ctx.mode === "tui" && ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
		});
	};
}

export default createProgramIdentityExtension();
