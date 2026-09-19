import fs from "node:fs";

interface SharedHistoryEntry {
	text: string;
}

function isSharedHistoryEntry(value: unknown): value is SharedHistoryEntry {
	if (!value || typeof value !== "object") return false;
	return typeof (value as { text?: unknown }).text === "string";
}

function toSharedHistoryValue(value: unknown): string | null {
	if (typeof value === "string") return value.length > 0 ? value : null;
	if (isSharedHistoryEntry(value))
		return value.text.length > 0 ? value.text : null;
	return null;
}

function isNonEmptyString(value: string | null): value is string {
	return typeof value === "string" && value.length > 0;
}

export function loadSharedHistory(historyFile: string): string[] {
	if (!fs.existsSync(historyFile)) return [];

	try {
		const raw = fs.readFileSync(historyFile, "utf8");
		const parsed: unknown = JSON.parse(raw);

		if (!Array.isArray(parsed)) return [];

		return parsed.map(toSharedHistoryValue).filter(isNonEmptyString);
	} catch {
		return [];
	}
}
