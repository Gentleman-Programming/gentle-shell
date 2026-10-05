import {
	createCodemodeExtension,
	keyHint,
	type AgentToolResult,
	type CodemodeToolDetails,
	type ExtensionAPI,
	type ExtensionFactory,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, imageFallback, type Component } from "@earendil-works/pi-tui";
import {
	CARD_TONE, cardAwaitingResult, cardBodyRows, cardBottom, cardLine, cardRunningLine, cardTop, floatRows, markCardResult,
	type CardRowContext, type CardTheme, type CardTone,
} from "./shell-card.ts";
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
	// Arguments are deliberately never read; error payloads have their own bounded preview.
	return `${theme.fg(tone, status)} · ${call.name || "name unavailable"}${time ? ` · ${time}` : ""}${call.error && call.status !== CALL_STATUS.ERROR ? " · error reported" : ""}`;
}

class CodemodeCard implements Component {
	private readonly theme: CardTheme;
	private readonly tone: CardTone;
	private readonly body: (width: number) => string[];
	private readonly top: boolean;
	private readonly hint?: string;
	// Whether the call card above this result already drew body rows (the script).
	private readonly afterBody: boolean;
	// The call card's render context: until a result exists, the call closes the frame.
	private readonly row?: CardRowContext;

	constructor(theme: CardTheme, tone: CardTone, body: (width: number) => string[], top: boolean, hint?: string, afterBody = false, row?: CardRowContext) {
		this.theme = theme;
		this.tone = tone;
		this.body = body;
		this.top = top;
		this.hint = hint;
		this.afterBody = afterBody;
		this.row = row;
	}

	render(width: number): string[] {
		const target = Math.max(0, Math.floor(width));
		if (target === 0) return [];
		const running = this.top && this.row !== undefined && cardAwaitingResult(this.row);
		return floatRows(this.tone, this.theme, target, (inner) => ({
			head: this.top ? [cardTop({ title: "Code", glyph: "λ", body: [], tone: this.tone }, this.theme, inner, this.hint)] : [],
			body: running ? [...this.body(inner), cardRunningLine(this.tone, this.theme, inner)] : this.body(inner),
			bottom: this.top && !running ? undefined : cardBottom(this.tone, this.theme, inner),
			afterHeading: !this.top && !this.afterBody,
		}));
	}

	invalidate(): void {}
}

/** Replace presentation only: execute, schema and every loadout/exposure field retain their references. */
export function decorateCodemodeTool(tool: ToolDefinition): ToolDefinition {
	return {
		...tool,
		renderShell: "self",
		renderCall(args, theme, context) {
			const tone = context.isError ? CARD_TONE.ERROR : context.isPartial ? CARD_TONE.WARNING : CARD_TONE.INFO;
			const code = record(args).code;
			const rows = context.expanded && typeof code === "string" ? [safe(code)] : [];
			const hint = stripAnsi(keyHint("app.tools.expand", context.expanded ? "to collapse" : "to expand"));
			return new CodemodeCard(theme, tone, (width) => cardBodyRows(rows, tone, theme, width, { expanded: true }), true, hint, false, context);
		},
		renderResult(result, options, theme, context) {
			markCardResult(context?.state);
			const calls = observedCalls(result.details);
			const isError = context.isError || record(result).isError === true;
			const failures = calls.filter(failed).length;
			const tone = isError || failures > 0 ? CARD_TONE.ERROR : options.isPartial ? CARD_TONE.WARNING : CARD_TONE.INFO;
			const shown = options.expanded ? calls : calls.slice(0, COLLAPSED_CALL_LIMIT);
			const output = textOutput(result, context.showImages).flatMap((text) => {
				const rows = text.split("\n");
				// Pi prefixes final script output with status/wall-time bookkeeping.
				// Keep it in expansion, but spend the collapsed budget on the payload.
				const marker = rows.indexOf("Output:");
				return !options.expanded && /^Script (?:completed|failed)/.test(rows[0] ?? "") && marker >= 0
					? rows.slice(marker + 1) : rows;
			});
			const path = record(result.details).fullOutputPath;
			// Mirrors renderCall: an expanded call shows the script as its body.
			const callHasBody = options.expanded && typeof record(context?.args).code === "string";
			return new CodemodeCard(theme, tone, (width) => {
				const rows = shown.flatMap((call) => [
					childLine(call, theme),
					...(options.expanded && call.error ? [theme.fg("error", call.error)] : []),
				]);
				if (shown.length < calls.length) rows.push(theme.fg("muted", `${failures} errors/cancellations reported · ${calls.length - shown.length} more calls · expand to inspect`));
				if (isError) rows.push(theme.fg("error", "Script failed"));
				if (calls.length === 0) rows.push(theme.fg("muted", "No observed child calls"));
				// Each child gets one collapsed physical row, preserving the observed order.
				const body = options.expanded
					? cardBodyRows(rows, tone, theme, width, { expanded: true })
					: rows.map((row) => cardLine(row, tone, theme, width));
				if (!options.expanded) {
					const errors = calls.filter((call) => call.error).map((call) => `${call.name || "name unavailable"}: ${call.error}`);
					body.push(...cardBodyRows(errors.map((error) => theme.fg("error", error)), tone, theme, width, { expanded: false, previewRows: 2 }));
				}
				body.push(...cardBodyRows(output.filter((row) => options.expanded || row.trim().length > 0).map((row) => theme.fg(isError ? "error" : "toolOutput", row)), tone, theme, width, { expanded: options.expanded, previewRows: 3 }));
				if (typeof path === "string") body.push(...cardBodyRows([theme.fg("muted", `Full output: ${safe(path)}`)], tone, theme, width, { expanded: options.expanded, previewRows: 1 }));
				return body;
			}, false, undefined, callHasBody);
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
