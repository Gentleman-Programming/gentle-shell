import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

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
	| "no-server"
	/** The update itself failed (an unreadable or unwritable file); that path is left as it was. */
	| "error";

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

/** Mode used when the update creates a config file because none existed yet. */
const NEW_CONFIG_MODE = 0o644;

/**
 * The single-file replacement steps behind {@link defaultIo}'s write. The whole update is
 * orchestrated by {@link atomicWriteFile}; these primitives stay injectable so failure paths
 * are testable without a real filesystem.
 */
export interface AtomicFileIo {
	/** The path a write to `path` actually lands on: symlinks resolved the way a direct write resolves them. */
	resolve(path: string): string;
	/** The destination's permission bits, or undefined when it does not exist. */
	modeOf(path: string): number | undefined;
	/** Creates the temporary file exclusively (never through a symlink) with exactly `mode`, writing the whole text. */
	writeExclusive(path: string, text: string, mode: number): void;
	/** Moves the completed temporary file over the destination. */
	rename(from: string, to: string): void;
	/** Removes a leftover temporary file; only ever called best-effort after success or failure. */
	remove(path: string): void;
}

const fsIo: AtomicFileIo = {
	resolve: (path) => {
		try {
			return realpathSync(path);
		} catch {
			// A destination that does not exist yet (or a dangling link): anchor on its directory.
			return join(realpathSync(dirname(path)), basename(path));
		}
	},
	modeOf: (path) => {
		try {
			return statSync(path).mode & 0o777;
		} catch {
			return undefined;
		}
	},
	writeExclusive: (path, text, mode) => {
		writeFileSync(path, text, { flag: "wx", mode });
		chmodSync(path, mode); // creation is umask-masked; the preserved mode must be exact
	},
	rename: renameSync,
	remove: unlinkSync,
};

/**
 * Replaces one file's whole content atomically: the text is written to a temporary regular file
 * in the destination's own directory — the same filesystem, so the final rename cannot copy —
 * and renamed over the destination. A replacement that fails part-way therefore leaves the
 * original file untouched, sibling entries included when it is an mcp.json. A symlinked
 * destination keeps receiving updates through the file it points at, the destination's
 * permission bits are preserved exactly, and the renamed-in file is always a regular file.
 */
export function atomicWriteFile(path: string, text: string, io: AtomicFileIo = fsIo): void {
	const target = io.resolve(path);
	const mode = io.modeOf(target) ?? NEW_CONFIG_MODE;
	const temp = join(dirname(target), `.${basename(target)}.tmp-${randomUUID()}`);
	try {
		io.writeExclusive(temp, text, mode);
		io.rename(temp, target);
	} finally {
		try {
			io.remove(temp);
		} catch {
			/* the successful rename already consumed the temporary file */
		}
	}
}

const defaultIo: EnsureExposureIo = {
	read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
	write: (path, text) => atomicWriteFile(path, text),
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

/**
 * Ensures the field in every agent home mcp.json: the pi home first, then the Gentle Shell home.
 * An I/O failure on one home is isolated: that path is reported as `"error"` and every
 * remaining home is still attempted, so one unwritable config never blocks the other homes.
 */
export function ensureDirectExposureInAgentHomes(home: string = homedir(), io: EnsureExposureIo = defaultIo): EnsureExposureResult[] {
	return [...new Set(codegraphMcpPaths(home))].map((path) => {
		try {
			return ensureDirectExposure(path, io);
		} catch {
			return { path, outcome: "error" };
		}
	});
}
