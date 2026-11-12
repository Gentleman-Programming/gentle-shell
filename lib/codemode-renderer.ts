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
	CARD_TONE, cardAwaitingResult, cardBodyRows, cardBottom, cardLine, cardRunningLine, cardStyle, cardTop, floatRows, markCardResult,
	type CardRowContext, type CardStyle, type CardTheme, type CardTone,
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
	// Content and expansion belong to this component; only layout and row state can change.
	private cachedFrame?: { width: number; style: CardStyle; running: boolean; lines: string[] };

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
		const style = cardStyle();
		if (this.cachedFrame?.width === target && this.cachedFrame.style === style && this.cachedFrame.running === running) {
			return this.cachedFrame.lines;
		}
		const lines = floatRows(this.tone, this.theme, target, (inner) => ({
			head: this.top ? [cardTop({ title: "Code", glyph: "λ", body: [], tone: this.tone }, this.theme, inner, this.hint)] : [],
			body: running ? [...this.body(inner), cardRunningLine(this.tone, this.theme, inner)] : this.body(inner),
			bottom: this.top && !running ? undefined : cardBottom(this.tone, this.theme, inner),
			afterHeading: !this.top && !this.afterBody,
		}));
		this.cachedFrame = { width: target, style, running, lines };
		return lines;
	}

	invalidate(): void {
		this.cachedFrame = undefined;
	}
}

/** Replace presentation only: execute, schema and every loadout/exposure field retain their references. */
/**
 * Appended after Pi's own codemode guideline, which only says to batch calls.
 * Pi adds a tool's guidelines to the system prompt while the tool is active, so
 * these rules cost nothing when codemode is off and reach delegated children too.
 */
export const CODEMODE_GUIDELINES: readonly string[] = [
	"gentle_review* tools are model-only: use direct tool calls, never tools.gentle_review(...) in codemode. ALL_TOOLS lists only callable tools; absence there does not mean the direct tool is unavailable.",
	"Use codemode as a thin orchestration layer that cuts model/tool round trips, not a place for the whole task: give each script one coherent objective (gather context, prepare one change, run checks, or save evidence) and never mix uncertain exploration, file mutations, and remote publishing in one script.",
	"In codemode, parallelize by independence, not by count: run independent calls together with Promise.allSettled() and label each result so partial failures stay attributable; run dependent steps (read, decide, edit, verify) sequentially and never parallelize writes that can overlap.",
	"In codemode, a fulfilled promise is not success: check each result's own failure fields (bash exit_code, MCP isError, truncation flags) and throw or report the failure instead of assuming the call worked. Await every tool call before the script ends.",
	"Codemode side effects are not transactional: a change made before a later failure stays made. Validate prerequisites before mutating, never repeat a side effect merely because the script failed afterward, and inspect the real state after a partial failure.",
	"From codemode, return decision-relevant evidence: affected files, exit codes, test totals, relevant errors, truncation indicators, and full-log paths. Filter noise, never evidence; a summary must never turn a failure into success.",
	"Keep long waits out of codemode: run builds, CI, servers, and long suites with the background tools when they are available and continue on their completion event; when they are not, use one bounded direct foreground call with an explicit timeout. Never poll inside a script.",
	"In codemode, discover unfamiliar tools with searchTools() and describeTool() before calling them instead of inventing names or arguments; respect direct-only tools, permissions, consent, and sandbox boundaries, which codemode never bypasses; prefer a direct tool call when a script adds no real benefit.",
];

export function decorateCodemodeTool(tool: ToolDefinition): ToolDefinition {
	return {
		...tool,
		promptGuidelines: [...(tool.promptGuidelines ?? []), ...CODEMODE_GUIDELINES],
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
