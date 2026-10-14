import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	matchesKey,
	SelectList,
	Text,
	type SelectItem,
	type SelectListTheme,
} from "@earendil-works/pi-tui";

const EMPTY_HISTORY_MESSAGE =
	"No hay comandos de bash en el historial de esta sesión.";
const NON_TUI_MESSAGE = "Comando /history solo disponible en modo TUI.";
const GENERIC_ERROR_MESSAGE = "gentle-pi /history: error inesperado";
const PICKER_TITLE = "🔍 [gentle-pi] Selecciona un comando";

const HISTORY_COMMAND_DESCRIPTION =
	"Buscar en el historial de comandos de terminal de la sesión";
const HISTORY_ALIAS_DESCRIPTION = "Alias rápido para /history";

export type SessionEntry = {
	type?: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	message?: unknown;
};

type BashExecutionMessage = {
	role: "bashExecution";
	command: string;
};

type ToolCallBlock = {
	type: "toolCall";
	name?: string;
	arguments?: Record<string, unknown> | null;
};

type AssistantMessage = {
	role: "assistant";
	content?: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function readBashCommandFromEntry(entry: SessionEntry): string | null {
	if (!entry || entry.type !== "message") return null;
	const message: unknown = entry.message;
	if (!isObject(message)) return null;

	const role: unknown = message.role;
	if (role === "bashExecution") {
		const candidate: unknown = (message as BashExecutionMessage).command;
		return isString(candidate) && candidate.length > 0 ? candidate : null;
	}

	if (role === "assistant") {
		const content: unknown = (message as AssistantMessage).content;
		if (!Array.isArray(content)) return null;
		for (const block of content) {
			if (!isObject(block)) continue;
			if (block.type !== "toolCall") continue;
			const toolCall = block as ToolCallBlock;
			if (toolCall.name !== "bash") continue;
			const args = toolCall.arguments;
			if (!args || !isObject(args)) continue;
			const command = args.command;
			if (isString(command) && command.length > 0) return command;
		}
	}

	return null;
}

export function collectBashCommands(
	entries: readonly SessionEntry[],
): string[] {
	const out: string[] = [];
	for (const entry of entries) {
		const command = readBashCommandFromEntry(entry);
		if (command !== null) out.push(command);
	}
	return out;
}

export function dedupeNewestFirst(commands: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (let i = commands.length - 1; i >= 0; i--) {
		const command = commands[i];
		if (typeof command !== "string") continue;
		if (seen.has(command)) continue;
		seen.add(command);
		result.push(command);
	}
	return result;
}

export function scoreMatch(query: string, command: string): number {
	if (query.length === 0) return 1;
	if (command.length === 0) return 0;

	const haystack = command.toLowerCase();
	const needle = query.toLowerCase();

	const indexOf = haystack.indexOf(needle);
	if (indexOf === 0) return 100;
	if (indexOf > 0) return 50 - Math.min(indexOf, 49);

	let qi = 0;
	let ci = 0;
	let consecutive = 0;
	let lastMatch = -2;
	while (qi < needle.length && ci < haystack.length) {
		if (needle[qi] === haystack[ci]) {
			if (ci === lastMatch + 1) {
				consecutive += 1;
			}
			lastMatch = ci;
			qi += 1;
		}
		ci += 1;
	}

	if (qi < needle.length) return 0;
	let score = 10 + consecutive * 2;
	const coverage = needle.length / Math.max(haystack.length, 1);
	score += Math.round(coverage * 10);
	return score;
}

export function filterByQuery(
	commands: readonly string[],
	query: string,
): string[] {
	const filtered: { command: string; score: number }[] = [];
	for (const command of commands) {
		const score = scoreMatch(query, command);
		if (score <= 0) continue;
		filtered.push({ command, score });
	}
	filtered.sort((a, b) => b.score - a.score);
	return filtered.map((entry) => entry.command);
}

export function applySelection(
	ctx: ExtensionCommandContext,
	command: string,
): void {
	ctx.ui.setEditorText(command);
}

export function applyCancel(ctx: ExtensionCommandContext): void {
	void ctx;
}

function isPrintable(data: string): boolean {
	if (data.length !== 1) return false;
	const code = data.charCodeAt(0);
	return code >= 0x20 && code !== 0x7f;
}

type PickerTheme = {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
	bg: (color: string, text: string) => string;
};

function createPickerTheme(theme: PickerTheme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("dim", text),
	};
}

type PickerDone = (value: { command: string } | undefined) => void;

function createHistoryPicker(
	commands: readonly string[],
	ctx: ExtensionCommandContext,
	requestRender: () => void,
	done: PickerDone,
	theme: PickerTheme,
): Container {
	const items: SelectItem[] = commands.map((command) => ({
		label: command,
		value: command,
	}));

	const pickerTheme = createPickerTheme(theme);
	const list = new SelectList(items, 10, pickerTheme);
	const accent = (text: string): string => theme.fg("accent", text);
	const topBorder = new DynamicBorder(accent);
	const bottomBorder = new DynamicBorder(accent);
	const titleText = new Text(theme.fg("accent", theme.bold(PICKER_TITLE)), 1, 0);
	const hintText = new Text(
		theme.fg("dim", "type to filter · ↑/↓ navigate · Enter select · Esc cancel"),
		1,
		0,
	);

	const buildQueryLine = (q: string): string =>
		theme.fg("muted", `▸  ${q}`) + accent("_");

	let query = "";
	const queryText = new Text(buildQueryLine(query), 0, 0);

	const container = new Container();
	container.addChild(topBorder);
	container.addChild(titleText);
	container.addChild(queryText);
	container.addChild(list);
	container.addChild(hintText);
	container.addChild(bottomBorder);

	const refresh = (): void => {
		queryText.setText(buildQueryLine(query));
		list.setFilter(query);
		requestRender();
	};

	list.onSelect = (item): void => {
		try {
			applySelection(ctx, item.value);
		} catch {
			// absorb RPC edge cases from setEditorText
		}
		done({ command: item.value });
	};

	list.onCancel = (): void => {
		applyCancel(ctx);
		done(undefined);
	};

	container.handleInput = (data: string): void => {
		if (matchesKey(data, Key.escape)) {
			applyCancel(ctx);
			done(undefined);
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			if (query.length > 0) {
				query = query.slice(0, -1);
				refresh();
			}
			return;
		}
		if (isPrintable(data)) {
			query += data;
			refresh();
			return;
		}
		// Up, Down, Enter, Ctrl+C and other SelectList-owned keys
		// reach the SelectList via getKeybindings() inside handleInput.
		list.handleInput(data);
	};

	refresh();
	return container;
}

async function runHistoryCommand(ctx: ExtensionCommandContext): Promise<void> {
	try {
		if (ctx.mode !== "tui" || ctx.hasUI !== true) {
			ctx.ui.notify(NON_TUI_MESSAGE, "info");
			return;
		}
		const sessionManager = ctx.sessionManager;
		const entries: readonly SessionEntry[] =
			sessionManager && typeof sessionManager.getEntries === "function"
				? (sessionManager.getEntries() as readonly SessionEntry[])
				: [];
		const raw = collectBashCommands(entries);
		const commands = dedupeNewestFirst(raw);
		if (commands.length === 0) {
			ctx.ui.notify(EMPTY_HISTORY_MESSAGE, "info");
			return;
		}
		await ctx.ui.custom<{ command: string } | undefined>(
			(tui, theme, _keybindings, done) => {
				return createHistoryPicker(
					commands,
					ctx,
					() => tui.requestRender(),
					done,
					theme as PickerTheme,
				);
			},
		);
	} catch {
		try {
			ctx.ui.notify(GENERIC_ERROR_MESSAGE, "error");
		} catch {
			// last-resort: nothing more we can do
		}
	}
}

export default function historySearch(pi: ExtensionAPI): void {
	pi.registerCommand("history", {
		description: HISTORY_COMMAND_DESCRIPTION,
		handler: async (_args, ctx) => {
			await runHistoryCommand(ctx);
		},
	});
	pi.registerCommand("r", {
		description: HISTORY_ALIAS_DESCRIPTION,
		handler: async (_args, ctx) => {
			await runHistoryCommand(ctx);
		},
	});
}

export const __testing = {
	collectBashCommands,
	dedupeNewestFirst,
	scoreMatch,
	filterByQuery,
	readBashCommandFromEntry,
	applySelection,
	applyCancel,
};
