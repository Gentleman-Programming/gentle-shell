import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";

const WIDGET_KEY = "gentle-shell:program-identity";
const STATES = new Set(["idle", "working", "blocked", "done", "error", "clear"]);

function installIdentity(terminal: Terminal): () => void {
	const original = terminal.setProgramStatus;
	if (typeof original !== "function") return () => {};
	let active = true;
	let latest: ProgramStatus | undefined;
	const wrapped = (status: ProgramStatus) => {
		if (!active) return original.call(terminal, status);
		latest = { ...status };
		original.call(terminal, status.state === "clear" ? status : { ...status, app: "gentle-shell" });
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

	return () => {
		if (!active) return;
		active = false;
		// A later extension may wrap ours. Leave its method installed; our
		// inactive wrapper becomes a transparent pass-through in that chain.
		if (terminal.setProgramStatus !== wrapped) return;
		terminal.setProgramStatus = original;
		if (latest) original.call(terminal, latest);
	};
}

export function createProgramIdentityExtension(env: NodeJS.ProcessEnv = process.env) {
	return (pi: ExtensionAPI): void => {
		if (env.PI_PROGRAM_STATUS_APP !== "gentle-shell" || env.GENTLE_PI_AGENTS_CHILD === "1") return;
		let dispose: (() => void) | undefined;
		pi.on("session_start", (_event, ctx) => {
			dispose?.(); dispose = undefined;
			if (ctx.mode !== "tui" || !ctx.hasUI) return;
			ctx.ui.setWidget(WIDGET_KEY, (tui) => {
				const cleanup = installIdentity(tui.terminal);
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
