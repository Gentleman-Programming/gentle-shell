import { sanitizeTerminalText } from "./terminal-theme.ts";

// Gentle Agents transcript: a child's session JSONL rendered as markdown a
// human can read in an editor. Thinking is left out; tool output keeps a tail.

export interface TranscriptOptions {
	title: string;
	maxOutputLines: number;
}

interface Part {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

interface Entry {
	type?: string;
	message?: { role?: string; content?: Part[] | string; toolName?: string; isError?: boolean };
}

const DEFAULT_OPTIONS: TranscriptOptions = { title: "Subagent transcript", maxOutputLines: 40 };

function clean(value: unknown): string {
	return typeof value === "string" ? sanitizeTerminalText(value) : "";
}

function parts(content: Part[] | string | undefined): Part[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? content : [];
}

function argsSummary(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	const first = Object.values(args).find((value) => typeof value === "string") as string | undefined;
	return first ? clean(first).replace(/\s+/g, " ").trim() : JSON.stringify(args);
}

function tail(text: string, max: number): string {
	const lines = text.split("\n");
	if (lines.length <= max) return text;
	return [`… ${lines.length - max} earlier lines omitted`, ...lines.slice(-max)].join("\n");
}

function fence(text: string): string {
	const ticks = /`{3,}/.test(text) ? "````" : "```";
	return `${ticks}\n${text}\n${ticks}`;
}

export function sessionToMarkdown(jsonl: string, options: Partial<TranscriptOptions> = {}): string {
	const { title, maxOutputLines } = { ...DEFAULT_OPTIONS, ...options };
	const out: string[] = [`# ${title}`, ""];
	for (const raw of jsonl.split("\n")) {
		if (raw.trim().length === 0) continue;
		let entry: Entry;
		try {
			entry = JSON.parse(raw) as Entry;
		} catch {
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const { role, content, toolName, isError } = entry.message;
		if (role === "user") {
			const text = parts(content).map((part) => clean(part.text)).filter((text) => text.length > 0).join("\n");
			if (text) out.push("## User", "", text, "");
		} else if (role === "assistant") {
			let opened = false;
			for (const part of parts(content)) {
				if (part.type === "text" && clean(part.text).trim().length > 0) {
					if (!opened) {
						out.push("## Assistant", "");
						opened = true;
					}
					out.push(clean(part.text).trim(), "");
				} else if (part.type === "toolCall") {
					out.push(`### ▸ ${clean(part.name) || "tool"} ${argsSummary(part.arguments)}`.trimEnd(), "");
				}
			}
		} else if (role === "toolResult") {
			const text = parts(content).map((part) => clean(part.text)).filter((text) => text.length > 0).join("\n");
			const label = isError ? `${clean(toolName) || "tool"} error` : (clean(toolName) || "tool");
			out.push(`<!-- ${label} -->`, fence(tail(text.length > 0 ? text : "(no output)", maxOutputLines)), "");
		}
	}
	return `${out.join("\n").trimEnd()}\n`;
}
