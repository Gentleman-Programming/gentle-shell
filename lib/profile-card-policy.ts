import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

// Whether the sidebar profile card is shown, set by `/gentle:profiles card
// on|off`. A standalone global flag, separate from the visual settings. A
// missing, malformed or unreadable file reads as hidden and never throws; the
// writer replaces such a file, since the flag is the file's only content.
// There is no environment override.
export const PROFILE_CARD_SCHEMA = "gentle-pi.profile-card/v1";
/** Emitted on `pi.events` after the flag is written, so a sidebar can refresh live. */
export const PROFILE_CARD_SETTINGS_CHANGED = "gentle-pi:profile-card-settings-changed";
const PROFILE_CARD_FILE = "profile-card.json";
interface ProfileCardOptions { gentlePiConfigHome?: string }
export interface ProfileCardResolution {
	visible: boolean;
	source: "global_file" | "default";
	malformed: boolean;
	globalFile: string;
}

export function parseProfileCardFile(raw: string): boolean | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		if (Object.keys(value).length !== 2 || !("schema" in value) || value.schema !== PROFILE_CARD_SCHEMA || !("visible" in value)) return undefined;
		return typeof value.visible === "boolean" ? value.visible : undefined;
	} catch { return undefined; }
}

export function resolveProfileCard(options: ProfileCardOptions = {}): ProfileCardResolution {
	const globalFile = join(options.gentlePiConfigHome ?? gentlePiConfigHome(), PROFILE_CARD_FILE);
	try {
		const visible = parseProfileCardFile(readFileSync(globalFile, "utf8"));
		return { visible: visible ?? false, source: "global_file", malformed: visible === undefined, globalFile };
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return { visible: false, source: missing ? "default" : "global_file", malformed: !missing, globalFile };
	}
}

export function writeProfileCard(visible: boolean, options: ProfileCardOptions = {}): string {
	if (typeof visible !== "boolean") throw new TypeError("Invalid profile card visibility");
	const home = options.gentlePiConfigHome ?? gentlePiConfigHome();
	const path = join(home, PROFILE_CARD_FILE);
	const temporary = `${path}.${randomUUID()}.tmp`;
	mkdirSync(home, { recursive: true });
	try {
		writeFileSync(temporary, `${JSON.stringify({ schema: PROFILE_CARD_SCHEMA, visible })}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ }
	}
	return path;
}
