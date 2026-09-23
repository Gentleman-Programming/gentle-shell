import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { shellEnabled } from "../lib/shell-bar.ts";
import {
	mergeDisabledTools,
	PI_PRETTY_SUPPRESSED_TOOL_NAMES,
	quietToolsEnabled,
} from "../lib/quiet-tools-config.ts";

type PiPrettyExtension = (pi: unknown, deps?: unknown) => unknown;

let piPrettyExtensionPromise: Promise<PiPrettyExtension> | undefined;

async function loadPiPrettyExtension(): Promise<PiPrettyExtension> {
	return piPrettyExtensionPromise ??= import("@heyhuynhgiabuu/pi-pretty").then(
		(piPrettyModule) => {
			const moduleCandidate: unknown = piPrettyModule;
			const extension =
				typeof moduleCandidate === "function"
					? moduleCandidate
					: piPrettyModule.default;
			if (typeof extension !== "function") {
				throw new TypeError("pi-pretty must export an extension function");
			}
			return extension as PiPrettyExtension;
		},
	);
}

export default async function gentlePiPrettyExtension(
	pi: unknown,
	deps?: unknown,
	bundled?: PiPrettyExtension,
	env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
	if (quietToolsEnabled()) {
		process.env.PRETTY_DISABLE_TOOLS = mergeDisabledTools(
			process.env.PRETTY_DISABLE_TOOLS,
			PI_PRETTY_SUPPRESSED_TOOL_NAMES,
		);
	}
	const extension = bundled ?? await loadPiPrettyExtension();
	if (!shellEnabled(env)) return extension(pi, deps);
	const api = pi as ExtensionAPI;
	// Scope interception to this bundled dependency, never to the shared host UI.
	// Its tools/autocomplete/status APIs pass through; prompt ownership stays with
	// Gentle Shell (or a genuine third-party editor). This also blocks stale restores.
	const owned = new Set(["setEditorComponent", "setWorkingIndicator", "setWorkingMessage", "setWorkingVisible"]);
	const delegated = new Proxy(api, {
		get(target, key) {
			if (key !== "on") return Reflect.get(target, key);
			return (event: Parameters<ExtensionAPI["on"]>[0], handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
				api.on(event, ((event: unknown, ctx: ExtensionContext) => {
					if (ctx.mode !== "tui") return handler(event, ctx);
					const ui = new Proxy(ctx.ui, {
						get(target, key) {
							return owned.has(String(key)) ? () => {} : Reflect.get(target, key);
						},
					});
					return handler(event, new Proxy(ctx, { get: (target, key) => key === "ui" ? ui : Reflect.get(target, key) }));
				}) as never);
			};
		},
	});
	// pi-pretty's hidden-thinking API is global. Its best-effort private per-row
	// patch can miss the host's actual component class and then animate every
	// historical Thinking row. Gentle Shell chooses the robust presentation:
	// keep collapsed labels static while preserving the separate working frame.
	const previousThinkingIndicator = process.env.PRETTY_THINKING_INDICATOR;
	process.env.PRETTY_THINKING_INDICATOR = "off";
	let result: unknown;
	try {
		result = await extension(delegated, deps);
	} finally {
		if (previousThinkingIndicator === undefined) delete process.env.PRETTY_THINKING_INDICATOR;
		else process.env.PRETTY_THINKING_INDICATOR = previousThinkingIndicator;
	}
	// GentlePromptEditor already carries the live working state in its frame.
	// Hide Pi's separate loader row to avoid repeating Thinking above the input;
	// transcript thinking blocks remain untouched as historical reasoning markers.
	api.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setWorkingVisible(false);
	});
	api.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWorkingVisible(true);
		ctx.ui.setWorkingIndicator();
		ctx.ui.setWorkingMessage();
	});
	return result;
}
