import {
	createCodemodeExtension,
	keyHint,
	type AgentToolResult,
	type CodemodeToolDetails,
	type ExtensionAPI,
	type ExtensionFactory,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text, getCapabilities, imageFallback, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { CARD_TONE, cardBottom, cardInnerWidth, cardLine, cardTop, type CardTheme, type CardTone } from "./shell-card.ts";
import { sanitizeTerminalText, stripAnsi } from "./terminal-theme.ts";

const CALL_STATUS = {
	RUNNING: "running",
	OK: "ok",
	ERROR: "error",
	CANCELLED: "cancelled",
} as const satisfies Record<string, CodemodeToolDetails["calls"][number]["status"]>;
const COLLAPSED_CALL_LIMIT = 8;

interface ObservedCall {
	name?: string;
	status?: CodemodeToolDetails["calls"][number]["status"];
	durationMs?: number;
	error?: string;
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : {};
}

function safe(value: string): string {
	return sanitizeTerminalText(value)
		.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
		.replace(/\t/g, "    ");
}

function singleLine(value: string): string {
	return safe(value).replace(/[\r\n\t]/g, " ");
}

function observedCalls(details: unknown): ObservedCall[] {
	const calls = record(details).calls;
	if (!Array.isArray(calls)) return [];
	return calls.map((value) => {
		const call = record(value);
		return {
			name: typeof call.name === "string" ? singleLine(call.name) : undefined,
			status: Object.values(CALL_STATUS).includes(call.status as ObservedCall["status"] & string)
				? call.status as ObservedCall["status"] : undefined,
			durationMs: typeof call.durationMs === "number" && Number.isFinite(call.durationMs) && call.durationMs >= 0
				? call.durationMs : undefined,
			error: typeof call.error === "string" ? safe(call.error) : undefined,
		};
	});
}

function duration(ms: number | undefined): string {
	if (ms === undefined) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function failed(call: ObservedCall): boolean {
	return call.status === CALL_STATUS.ERROR || call.status === CALL_STATUS.CANCELLED || Boolean(call.error);
}

function childLine(call: ObservedCall, theme: CardTheme): string {
	const status = call.status ?? "status unavailable";
	const tone = failed(call) ? CARD_TONE.ERROR : call.status === CALL_STATUS.OK ? CARD_TONE.SUCCESS : CARD_TONE.WARNING;
	const time = duration(call.durationMs);
	// Arguments are deliberately never read. Error payloads belong in expansion.
	return `${theme.fg(tone, status)} · ${call.name || "name unavailable"}${time ? ` · ${time}` : ""}${call.error && call.status !== CALL_STATUS.ERROR ? " · error reported" : ""}`;
}

class CodemodeCard implements Component {
	private readonly theme: CardTheme;
	private readonly tone: CardTone;
	private readonly rows: readonly string[];
	private readonly top: boolean;
	private readonly expanded: boolean;
	private readonly phase?: string;
	private readonly hint?: string;

	constructor(theme: CardTheme, tone: CardTone, rows: readonly string[], top: boolean, expanded: boolean, phase?: string, hint?: string) {
		this.theme = theme;
		this.tone = tone;
		this.rows = rows;
		this.top = top;
		this.expanded = expanded;
		this.phase = phase;
		this.hint = hint;
	}

	render(width: number): string[] {
		const target = Math.max(0, Math.floor(width));
		if (target === 0) return [];
		const innerWidth = cardInnerWidth(target);
		const body = this.rows.flatMap((row) => this.expanded
			? new Text(row, 0, 0).render(innerWidth)
			: [truncateToWidth(row, innerWidth, "…")]);
		return [
			...(this.top ? [cardTop({ title: "Code", subtitle: this.phase, body: [], tone: this.tone }, this.theme, target, this.hint)] : []),
			...body.map((line) => cardLine(line, this.tone, this.theme, target)),
			...(!this.top ? [cardBottom(this.tone, this.theme, target)] : []),
		];
	}

	invalidate(): void {}
}

/** Replace presentation only: execute, schema and every loadout/exposure field retain their references. */
export function decorateCodemodeTool(tool: ToolDefinition): ToolDefinition {
	return {
		...tool,
		renderShell: "self",
		renderCall(args, theme, context) {
			const phase = context.isError ? "failed" : context.isPartial
				? context.executionStarted ? "running" : undefined : "finished";
			const tone = context.isError ? CARD_TONE.ERROR : context.isPartial ? CARD_TONE.WARNING : CARD_TONE.INFO;
			const code = record(args).code;
			const rows = context.expanded && typeof code === "string" ? [safe(code)] : [];
			const hint = stripAnsi(keyHint("app.tools.expand", context.expanded ? "to collapse" : "to expand"));
			return new CodemodeCard(theme, tone, rows, true, context.expanded, phase, hint);
		},
		renderResult(result, options, theme, context) {
			const calls = observedCalls(result.details);
			const isError = context.isError || record(result).isError === true;
			const failures = calls.filter(failed).length;
			const tone = isError || failures > 0 ? CARD_TONE.ERROR : options.isPartial ? CARD_TONE.WARNING : CARD_TONE.INFO;
			const shown = options.expanded ? calls : calls.slice(0, COLLAPSED_CALL_LIMIT);
			const rows = shown.flatMap((call) => [
				childLine(call, theme),
				...(options.expanded && call.error ? [theme.fg("error", call.error)] : []),
			]);
			if (shown.length < calls.length) {
				rows.push(theme.fg("muted", `${failures} errors/cancellations reported · ${calls.length - shown.length} more calls · expand to inspect`));
			}
			if (isError) rows.push(theme.fg("error", "Script failed"));
			if (calls.length === 0) rows.push(theme.fg("muted", "No observed child calls"));
			if (options.expanded) {
				// The public render context owns the exact args for this call, including replay.
				// renderCall displays its JS; result content retains the real final wall-time header.
				rows.push(...textOutput(result, context.showImages).map((text) => theme.fg(isError ? "error" : "toolOutput", text)));
				const path = record(result.details).fullOutputPath;
				if (typeof path === "string") rows.push(theme.fg("muted", `Full output: ${safe(path)}`));
			}
			return new CodemodeCard(theme, tone, rows, false, options.expanded);
		},
	};
}

function textOutput(result: AgentToolResult<unknown>, showImages: boolean): string[] {
	const showImageFallback = !getCapabilities().images || !showImages;
	return result.content.flatMap((item) => item.type === "text" ? [safe(item.text)]
		: item.type === "image" && showImageFallback ? [imageFallback(safe(item.mimeType))] : []);
}

/** Run the public factory once, intercepting only its registration; all other API access passes through. */
export function registerCompactCodemode(pi: ExtensionAPI, factory: ExtensionFactory = createCodemodeExtension()): ReturnType<ExtensionFactory> {
	const decoratedAPI = new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") return (tool: ToolDefinition) => pi.registerTool(tool.name === "codemode" ? decorateCodemodeTool(tool) : tool);
			return Reflect.get(target, property, receiver);
		},
	});
	return factory(decoratedAPI);
}
