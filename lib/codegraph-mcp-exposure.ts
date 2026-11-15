import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Pi defaults an MCP server's tools to codemode-only exposure, so a `codegraph` entry in
 * mcp.json is invisible to the model unless the entry carries `"exposure": "direct"`. This
 * module adds that field to an existing `codegraph` entry — never creating an entry, never
 * overwriting a field that is already there, and never touching sibling servers.
 */

/** The agent mcp.json files that may carry a `codegraph` entry: the pi home and the Gentle Shell home. */
export function codegraphMcpPaths(home: string = homedir()): string[] {
	return [join(home, ".pi", "agent", "mcp.json"), join(home, ".gentle-shell", "agent", "mcp.json")];
}

export type ExposureOutcome =
	/** The field was absent; the file was rewritten with `"exposure": "direct"` on the entry. */
	| "added"
	/** The entry already has an `exposure` field; the file was not written. */
	| "present"
	/** No mcp.json exists at the path; nothing to patch. */
	| "missing"
	/** The file exists but is not a JSON object; left exactly as it is. */
	| "unparseable"
	/** No `mcpServers.codegraph` object entry exists; nothing is created. */
	| "no-server";

export interface EnsureExposureResult {
	path: string;
	outcome: ExposureOutcome;
}

/** The file access the ensure needs; injectable so tests never touch a real home. */
export interface EnsureExposureIo {
	/** The file's current text, or undefined when it does not exist. */
	read(path: string): string | undefined;
	write(path: string, text: string): void;
}

const defaultIo: EnsureExposureIo = {
	read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
	write: (path, text) => writeFileSync(path, text, "utf8"),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Adds `"exposure": "direct"` to the `codegraph` server entry of one mcp.json, only when the
 * field is absent. Every other key, server, and value in the document is preserved; the file
 * is rewritten only on the `"added"` outcome, as two-space-indented JSON with a trailing
 * newline. Best effort by contract: a missing or unparseable file is reported and never
 * written, and an entry the caller did not configure is never invented.
 */
export function ensureDirectExposure(path: string, io: EnsureExposureIo = defaultIo): EnsureExposureResult {
	const raw = io.read(path);
	if (raw === undefined) return { path, outcome: "missing" };
	let doc: unknown;
	try {
		doc = JSON.parse(raw);
	} catch {
		return { path, outcome: "unparseable" };
	}
	if (!isPlainObject(doc)) return { path, outcome: "unparseable" };
	const servers = doc.mcpServers;
	const entry = isPlainObject(servers) ? servers.codegraph : undefined;
	if (!isPlainObject(entry)) return { path, outcome: "no-server" };
	if ("exposure" in entry) return { path, outcome: "present" };
	entry.exposure = "direct";
	io.write(path, `${JSON.stringify(doc, null, 2)}\n`);
	return { path, outcome: "added" };
}

/** Ensures the field in every agent home mcp.json: the pi home first, then the Gentle Shell home. */
export function ensureDirectExposureInAgentHomes(home: string = homedir(), io: EnsureExposureIo = defaultIo): EnsureExposureResult[] {
	return [...new Set(codegraphMcpPaths(home))].map((path) => ensureDirectExposure(path, io));
}
