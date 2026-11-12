import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { gentlePiConfigHome } from "../lib/agent-home.ts";
import { withOverlayRepaint } from "../lib/overlay-repaint.ts";
import {
	buildPluginAudit,
	captureUiSetters,
	formatPluginAudit,
	readPluginOrder,
	replacedUiSetters,
	type PluginAudit,
	type UiSetterSnapshot,
} from "../lib/plugin-audit.ts";
import {
	readContributionReport,
	readContributions,
	setContributionReporter,
	type ContributionReport,
} from "../lib/plugin-contract.ts";

// /gentle:plugins: the audit surface for community contributions. It reads the
// box other packages fill, so it never imports them, and it shows what loaded,
// which ids the contract refused or replaced, which owners `plugins.json`
// placed first, and whether another extension swapped a `ctx.ui` setter.
// Additive only: the command reads and reports, never writes or reorders a
// contribution.

export const PLUGINS_COMMAND_NAME = "gentle:plugins";

export interface GentlePluginsDeps {
	env?: NodeJS.ProcessEnv;
}

interface PluginAuditTheme {
	fg(role: string, text: string): string;
}

interface PluginAuditViewOptions {
	theme: PluginAuditTheme;
	/** Live terminal height, so a resize re-windows instead of overflowing. */
	rows(): number;
	requestRender(): void;
	done(): void;
}

/**
 * The scrollable audit: one window of plain text lines plus a footer, so a box
 * with hundreds of contributions still fits the terminal. It keeps no state
 * beyond the scroll offset and asks the command to close, nothing else.
 */
class PluginAuditView {
	private scrollTop = 0;
	private readonly lines: readonly string[];
	private readonly options: PluginAuditViewOptions;

	constructor(lines: readonly string[], options: PluginAuditViewOptions) {
		this.lines = lines;
		this.options = options;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const body = this.bodyRows();
		const top = Math.min(this.scrollTop, Math.max(0, this.lines.length - body));
		const window = this.lines.slice(top, top + body);
		const footer = this.options.theme.fg("dim", `↑↓ scroll · ${top + window.length}/${this.lines.length} lines · esc close`);
		return [...window, footer].map((line) => truncateToWidth(line, safeWidth));
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.options.done();
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "ctrl+p") || data === "k") this.scrollBy(-1);
		else if (matchesKey(data, "down") || matchesKey(data, "ctrl+n") || data === "j") this.scrollBy(1);
		else if (matchesKey(data, "pageUp")) this.scrollBy(-this.bodyRows());
		else if (matchesKey(data, "pageDown") || data === " ") this.scrollBy(this.bodyRows());
		else if (matchesKey(data, "home") || data === "g") this.scrollTo(0);
		else if (matchesKey(data, "end") || data === "G") this.scrollTo(Number.MAX_SAFE_INTEGER);
	}

	private bodyRows(): number {
		return Math.max(1, this.options.rows() - 1);
	}

	private scrollBy(delta: number): void {
		this.scrollTo(this.scrollTop + delta);
	}

	private scrollTo(top: number): void {
		const next = Math.max(0, Math.min(top, Math.max(0, this.lines.length - this.bodyRows())));
		if (next === this.scrollTop) return;
		this.scrollTop = next;
		this.options.requestRender();
	}
}

/** SAFETY: `ExtensionUIContext` has no index signature, so the setter names are read through a record; `UI_SETTERS` is the exact subset every context provides, and a missing setter reads as `undefined` on both sides. */
const uiRecord = (ctx: ExtensionContext): Record<string, unknown> => ctx.ui as unknown as Record<string, unknown>;

export default function gentlePlugins(pi: ExtensionAPI, deps: GentlePluginsDeps = {}): void {
	const env = deps.env ?? process.env;

	// The last report any read produced, including the reads the customize,
	// sidebar and palette read points run while the audit is open. The command
	// takes its own read first, so this holds that read's report; if another
	// extension installed its own reporter over ours, the command falls back to
	// `readContributionReport()`.
	let observed: ContributionReport | undefined;
	setContributionReporter((report) => {
		observed = report;
	});

	// The first context this extension sees fixes the identity of every
	// `ctx.ui` setter. Best-effort only: a replacement another extension
	// installed *before* that moment is already in place and cannot be
	// detected, so the finding is a hint, never a guarantee.
	let baseline: UiSetterSnapshot | undefined;
	const remember = (ctx: ExtensionContext): void => {
		if (baseline !== undefined) return;
		try {
			baseline = captureUiSetters(uiRecord(ctx));
		} catch {
			// A context without a ui object leaves detection off, never broken.
		}
	};

	const auditNow = (ctx: ExtensionContext): PluginAudit => {
		const order = readPluginOrder({ gentlePiConfigHome: gentlePiConfigHome(env) });
		const contributions = readContributions({ order: order.order });
		const report = observed ?? readContributionReport();
		let replacedSetters: string[] = [];
		if (baseline !== undefined) {
			try {
				replacedSetters = replacedUiSetters(baseline, uiRecord(ctx));
			} catch {
				replacedSetters = [];
			}
		}
		return buildPluginAudit({ contributions, report, order, replacedSetters });
	};

	const show = async (ctx: ExtensionContext, lines: readonly string[]): Promise<void> => {
		const text = lines.join("\n");
		// Headless (print, rpc, a pipe): the same text through a notification.
		if (!ctx.hasUI || ctx.mode !== "tui") {
			ctx.ui.notify(text, "info");
			return;
		}
		await ctx.ui.custom<null>(
			(tui: TUI, theme: PluginAuditTheme, _keybindings, done) => {
				const finish = withOverlayRepaint(tui, done);
				let closed = false;
				const close = (result: null): void => {
					if (closed) return;
					closed = true;
					finish(result);
				};
				return new PluginAuditView(lines, {
					theme,
					rows: () => Math.max(1, tui.terminal.rows),
					requestRender: () => tui.requestRender(),
					done: () => close(null),
				});
			},
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" } },
		);
	};

	pi.registerCommand(PLUGINS_COMMAND_NAME, {
		description: "Audit community plugin contributions: what loaded, which ids were rejected or replaced, and whether another extension replaced a ctx.ui setter.",
		handler: async (_args, ctx) => {
			remember(ctx);
			let lines: string[];
			try {
				lines = formatPluginAudit(auditNow(ctx));
			} catch (error) {
				// A broken box or config file must still answer the command.
				lines = [`The plugin audit failed: ${error instanceof Error ? error.message : String(error)}`];
			}
			await show(ctx, lines);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		remember(ctx);
	});
}
