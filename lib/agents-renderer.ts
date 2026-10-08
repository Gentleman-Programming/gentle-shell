import { keyHint, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { taskLabel } from "./agents-protocol.ts";
import {
	CARD_TONE,
	cardBottom,
	cardInnerWidth,
	cardLine,
	cardTop,
	type Card,
	type CardTheme,
	type CardTone,
} from "./shell-card.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";

export interface GentleAgentRenderTheme extends CardTheme {
	bg?(color: string, text: string): string;
}

export interface GentleAgentRenderState {
	lifecycleComponent?: boolean;
	finished?: boolean;
	failed?: boolean;
	liveDetail?: string;
}

export interface GentleAgentRenderContext {
	argsComplete?: boolean;
	executionStarted?: boolean;
	isPartial?: boolean;
	isError?: boolean;
	expanded?: boolean;
	lastComponent?: unknown;
	state?: unknown;
	invalidate?: () => void;
}

export const AGENT_LIFECYCLE_STATUS = {
	PREPARING: "preparing",
	RUNNING: "running",
	COMPLETED: "completed",
	FAILED: "failed",
} as const;

export type AgentLifecycleStatus = (typeof AGENT_LIFECYCLE_STATUS)[keyof typeof AGENT_LIFECYCLE_STATUS];

const STATUS_TONE: Record<AgentLifecycleStatus, CardTone> = {
	[AGENT_LIFECYCLE_STATUS.PREPARING]: CARD_TONE.WARNING,
	[AGENT_LIFECYCLE_STATUS.RUNNING]: CARD_TONE.WARNING,
	[AGENT_LIFECYCLE_STATUS.COMPLETED]: CARD_TONE.SUCCESS,
	[AGENT_LIFECYCLE_STATUS.FAILED]: CARD_TONE.ERROR,
};

const CARD_TITLE = "Gentle AI";
const CARD_GLYPH = "❀";
const DETAIL_ROLE = "dim";
const HIDDEN_ROLE = "dim";
const passthroughTheme: CardTheme = { fg: (_color, text) => text };

function safeKeyHint(id: string, label: string): string | undefined {
	try {
		return keyHint(id as never, label);
	} catch {
		return undefined;
	}
}

export function getGentleAgentRenderState(state: unknown): GentleAgentRenderState | undefined {
	if (!state || typeof state !== "object" || Array.isArray(state)) return undefined;
	const rowState = state as Record<string, unknown>, existing = rowState.gentleAgentRender;
	if (existing && typeof existing === "object" && !Array.isArray(existing)) return existing as GentleAgentRenderState;
	return (rowState.gentleAgentRender = {} as GentleAgentRenderState);
}

export function formatLiveTaskActivity(task: { turns: number; toolCalls: number; lastStep?: string }, thread?: { items: Array<{ kind: string; name?: string; args?: Record<string, unknown>; running?: boolean }> }): string {
	let action = "";
	if (thread && thread.items.length > 0) {
		const items = thread.items;
		for (let i = items.length - 1; i >= 0; i--) {
			const item = items[i];
			if (item.kind === "tool" && item.running) {
				const args = item.args ?? {};
				if (item.name === "bash" && typeof args.command === "string") {
					action = `$ ${args.command}`;
				} else if ((item.name === "read" || item.name === "edit" || item.name === "write") && typeof args.path === "string") {
					action = `${item.name} ${args.path}`;
				} else if ((item.name === "grep" || item.name === "find") && typeof args.pattern === "string") {
					action = `${item.name} "${args.pattern}"`;
				} else if (item.name) {
					action = item.name;
				}
				break;
			}
		}
	}

	if (!action) {
		if (task.lastStep === "starting") action = "starting subprocess";
		else if (task.lastStep === "pi ready") action = "agent runtime ready";
		else if (task.lastStep === "prompt accepted") action = "prompt accepted";
		else if (task.lastStep === "writing") action = "writing response";
		else if (task.lastStep) action = task.lastStep;
		else action = "working";
	}

	const parts = [`↳ ${action}`];
	const metrics = `(turn ${task.turns + 1}${task.toolCalls > 0 ? ` · ${task.toolCalls} ${task.toolCalls === 1 ? "tool" : "tools"}` : ""})`;
	parts.push(metrics);
	return parts.join(" ");
}

export function agentOperationSubtitle(
	toolName: string,
	args: Record<string, unknown>,
	status: AgentLifecycleStatus,
): string {
	const cleanTool = toolName.startsWith("subagent_") ? toolName.slice("subagent_".length) : toolName;

	if (cleanTool === "run") {
		const agent = typeof args.agent === "string" && args.agent ? args.agent : "worker";
		const label = typeof args.label === "string" && args.label
			? args.label
			: typeof args.task === "string" && args.task
				? taskLabel(args.task)
				: "";
		return `${status} · ${agent}${label ? ` · ${label}` : ""}`;
	}

	if (cleanTool === "continue") {
		const taskId = typeof args.task_id === "string" ? args.task_id : "";
		const label = typeof args.label === "string" && args.label
			? args.label
			: typeof args.prompt === "string" && args.prompt
				? taskLabel(args.prompt)
				: "";
		return `${status} · continue${taskId ? ` · ${taskId}` : ""}${label ? ` · ${label}` : ""}`;
	}

	const taskId = typeof args.task_id === "string" ? args.task_id : "";
	const action = cleanTool.replace(/_/g, " ");
	return `${status} · ${action}${taskId ? ` · ${taskId}` : ""}`;
}

export class GentleAgentCallCard {
	private card: Card = { title: CARD_TITLE, body: [], tone: CARD_TONE.WARNING };
	private theme: CardTheme = passthroughTheme;
	private details: string[] = [];
	private hint: string | undefined;
	private open = true;
	public status: AgentLifecycleStatus = AGENT_LIFECYCLE_STATUS.RUNNING;
	public tone: CardTone = CARD_TONE.WARNING;

	update(status: AgentLifecycleStatus, subtitle: string, theme: CardTheme, details: string[] = [], hint?: string): void {
		this.status = status;
		this.tone = STATUS_TONE[status];
		this.card = { title: CARD_TITLE, subtitle, body: [], tone: this.tone, glyph: CARD_GLYPH };
		this.theme = theme;
		this.details = details.filter((d) => d.length > 0);
		this.hint = hint;
		this.open = status === AGENT_LIFECYCLE_STATUS.RUNNING || status === AGENT_LIFECYCLE_STATUS.PREPARING;
	}

	render(width: number): string[] {
		const lines = [cardTop(this.card, this.theme, width, this.hint)];
		for (const detail of this.details) {
			lines.push(cardLine(this.theme.fg(DETAIL_ROLE, detail), this.card.tone, this.theme, width));
		}
		if (this.open) lines.push(cardBottom(this.card.tone, this.theme, width));
		return lines;
	}

	invalidate(): void {}
}

export class GentleAgentResultCard {
	private readonly text: string;
	private readonly expanded: boolean;
	public readonly tone: CardTone;
	private readonly theme: CardTheme;
	private readonly partial: boolean;
	private readonly isError: boolean;

	constructor(text: string, expanded: boolean, tone: CardTone, theme: CardTheme, partial = false, isError = false) {
		this.text = text;
		this.expanded = expanded;
		this.tone = tone;
		this.theme = theme;
		this.partial = partial;
		this.isError = isError;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		if (this.partial) {
			if (this.text.length > 0) {
				const innerWidth = cardInnerWidth(width);
				const first = this.text.split("\n")[0] ?? "";
				for (const line of wrapTextWithAnsi(first, innerWidth)) {
					lines.push(cardLine(this.theme.fg(DETAIL_ROLE, line), this.tone, this.theme, width));
				}
			}
			return lines;
		}

		if (this.text.length > 0) {
			const innerWidth = cardInnerWidth(width);
			if (this.expanded || this.isError) {
				const role = this.isError ? "error" : "text";
				for (const raw of this.text.split("\n")) {
					for (const line of raw === "" ? [""] : wrapTextWithAnsi(raw, innerWidth)) {
						lines.push(cardLine(this.theme.fg(role, line), this.tone, this.theme, width));
					}
				}
			} else {
				const firstLine = this.text.split("\n").find((l) => l.trim().length > 0) ?? "";
				lines.push(cardLine(this.theme.fg(HIDDEN_ROLE, firstLine), this.tone, this.theme, width));
			}
		}

		lines.push(cardBottom(this.tone, this.theme, width));
		return lines;
	}

	invalidate(): void {}
}

export function renderGentleAgentCall(
	toolName: string,
	args: Record<string, unknown>,
	theme: CardTheme,
	context?: GentleAgentRenderContext,
	extraDetails?: string[],
): GentleAgentCallCard {
	const state = getGentleAgentRenderState(context?.state);
	const finished = (context?.executionStarted === true && context.isPartial !== true) || state?.finished === true;
	const failed = context?.isError === true || state?.failed === true;
	const status: AgentLifecycleStatus = failed
		? AGENT_LIFECYCLE_STATUS.FAILED
		: finished
			? AGENT_LIFECYCLE_STATUS.COMPLETED
			: context?.argsComplete === false
				? AGENT_LIFECYCLE_STATUS.PREPARING
				: AGENT_LIFECYCLE_STATUS.RUNNING;

	const component = context?.lastComponent instanceof GentleAgentCallCard && (!state || state.lifecycleComponent === true)
		? context.lastComponent
		: new GentleAgentCallCard();
	if (state) state.lifecycleComponent = true;

	const subtitle = agentOperationSubtitle(toolName, args, status);
	const details: string[] = [];
	if (extraDetails && extraDetails.length > 0) {
		details.push(...extraDetails);
	} else if (state?.liveDetail) {
		details.push(state.liveDetail);
	}
	const hint = finished ? safeKeyHint("app.tools.expand", context?.expanded ? "to collapse" : "to expand") : undefined;
	component.update(status, subtitle, theme, details, hint);
	return component;
}

export function renderGentleAgentResult(
	result: AgentToolResult<unknown>,
	options: { expanded?: boolean; isPartial?: boolean; isError?: boolean },
	theme: CardTheme = passthroughTheme,
	context?: GentleAgentRenderContext,
): GentleAgentResultCard {
	const textItems = result.content.flatMap((content) => (content.type === "text" ? [sanitizeTerminalText(content.text)] : []));
	const text = textItems.some((item) => item.length > 0) ? textItems.join("\n") : "";
	const isError = options.isError === true || context?.isError === true;
	const tone = isError ? CARD_TONE.ERROR : options.isPartial ? CARD_TONE.WARNING : CARD_TONE.SUCCESS;
	const state = getGentleAgentRenderState(context?.state);

	if (state) {
		if (options.isPartial) {
			state.liveDetail = text;
		} else {
			const changed = state.finished !== true || state.failed !== isError;
			state.finished = true;
			state.failed = isError;
			if (changed) queueMicrotask(() => context?.invalidate?.());
		}
	}

	return new GentleAgentResultCard(text, options.expanded === true, tone, theme, options.isPartial === true, isError);
}
