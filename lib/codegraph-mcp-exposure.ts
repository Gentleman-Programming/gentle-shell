import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Pi defaults an MCP server's tools to codemode-only exposure, so a `codegraph` entry in
 * mcp.json is invisible to the model unless the entry carries `"exposure": "direct"`. This
 * module adds that field to an existing `codegraph` entry — never creating an entry, never
 * overwriting a field that is already there, and never touching sibling servers.
 */

/**
 * The agent mcp.json files that may carry a `codegraph` entry: the Pi agent home and the Gentle
 * Shell isolated home. Each honors the override that also moves the directory the session loads
 * mcp.json from — GENTLE_PI_AGENT_HOME, then PI_CODING_AGENT_DIR, for the Pi home (mirroring
 * resolveGentlePiAgentHome in lib/agent-home.ts) and GENTLE_SHELL_HOME for the isolated home
 * (mirroring isolatedDir in lib/gentle-shell-launcher.ts), an empty value falling through like
 * an unset one — so the targets are the session's active homes, with `home` supplying the
 * default paths only when no override is set.
 */
export function codegraphMcpPaths(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
	const piAgent = env.GENTLE_PI_AGENT_HOME || env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
	const isolated = env.GENTLE_SHELL_HOME || join(home, ".gentle-shell", "agent");
	return [join(piAgent, "mcp.json"), join(isolated, "mcp.json")];
}

export type ExposureOutcome =
	/** The field was absent; the file was rewritten with `"exposure": "direct"` spliced into the
	 * entry, preserving every other byte of the document — a missing trailing newline is the
	 * only addition. */
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
	| "error"
	/** The file changed under the update on every bounded retry, the locked destination was
	 * replaced mid-update, or the destination was replaced while the replacement was being
	 * staged; nothing was written. */
	| "conflict"
	/** No verifiable syntax-preserving insertion of the field exists for this document — a
	 * splice that cannot be placed or verified, or nesting deeper than the scan's limit;
	 * nothing is written, so unrelated values are never reformatted or corrupted. */
	| "unpreservable"
	/** Another writer holds the config lock; the update did not run and nothing was written. */
	| "busy";

export interface EnsureExposureResult {
	path: string;
	outcome: ExposureOutcome;
}

/** The file access the ensure needs; injectable so tests never touch a real home. */
export interface EnsureExposureIo {
	/** The identity a write to `path` actually lands on — symlinks resolved the way the
	 * replacement itself resolves them, so every link to one shared file coordinates on one
	 * lock. Absent means the io cannot resolve and the path as given is the identity. */
	resolve?(path: string): string;
	/** The file's current text, or undefined when it does not exist. */
	read(path: string): string | undefined;
	/** Replaces the file's whole content. `expectedIdentity`, when defined, is the file identity
	 * the verified read captured: a write that stages its text before the replacement must
	 * verify the destination still carries that identity at the replacement itself and refuse
	 * (by throwing) when it does not, so a save landing during the staging is never overwritten. */
	write(path: string, text: string, expectedIdentity?: string): void;
	/** Takes the config's exclusive lock for the whole read-modify-write, false when another
	 * writer holds it; absent means this io cannot coordinate and the update runs unguarded. */
	acquireLock?(path: string): boolean;
	/** Always called exactly once after an acquire that returned true. */
	releaseLock?(path: string): void;
	/** Whether the lock acquired for `path` still belongs to this update's own acquisition;
	 * checked after the splice is prepared and again inside the staged replacement's final
	 * checks, so a holder displaced by a stale takeover at any point before the rename
	 * publishes nothing. Absent means the io cannot verify ownership and the publish is
	 * unguarded by it. */
	ownsLock?(path: string): boolean;
	/** A stable identity of the file currently at `path` — device, inode, mtime, size — or
	 * undefined when it cannot be observed. The publish compares it with the identity the
	 * verified read captured, so an atomic replacement at the same path (an editor's
	 * temp-and-rename save) is refused even though the path still resolves to the same
	 * destination and no symlink moved. Absent means this io cannot observe identities and the
	 * publish is guarded by path identity alone. */
	identityOf?(path: string): string | undefined;
}

/** Mode used when the update creates a config file because none existed yet. */
const NEW_CONFIG_MODE = 0o644;

/** How many times the whole read-modify-write restarts when a concurrent writer changes the file mid-update. */
const MAX_UPDATE_ATTEMPTS = 3;

/** How deep the insertion scan and its semantic verification may nest. JSON.parse accepts
 * nesting far deeper than a recursive traversal can walk without exhausting the stack, so a
 * document beyond this limit is reported unpreservable — its file untouched — instead of
 * surfacing a generic error. Real configs sit a handful of levels deep; the limit only ever
 * rejects pathological nesting. */
const MAX_JSON_DEPTH = 128;

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
	/** The destination's identity at publication time, or undefined when it cannot be observed;
	 * a guarded replacement refuses its rename when this no longer matches the identity the
	 * update verified. */
	identityOf?(path: string): string | undefined;
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
	identityOf: fileIdentity,
};

/**
 * Replaces one file's whole content atomically: the destination is resolved the way a direct
 * write resolves it, then the text is written to a temporary regular file in the destination's
 * own directory — the same filesystem, so the final rename cannot copy — and renamed over the
 * destination. A replacement that fails part-way therefore leaves the original file untouched,
 * sibling entries included when it is an mcp.json. A symlinked destination keeps receiving
 * updates through the file it points at, the destination's permission bits are preserved
 * exactly, and the renamed-in file is always a regular file. When `expectedIdentity` is given
 * and the io can observe identities, the rename is additionally refused — by throwing — if
 * the destination's identity changed while the replacement was being staged, so the final
 * rename never discards a save the caller did not read.
 */
export function atomicWriteFile(path: string, text: string, io: AtomicFileIo = fsIo, expectedIdentity?: string): void {
	writeResolvedFile(io.resolve(path), text, io, expectedIdentity);
}

/** The refusal a staged replacement throws when the destination is no longer the file the
 * update verified: publishing would overwrite a concurrent save, so the caller abandons the
 * staged text and restarts from the saved file instead. */
class DestinationReplacedError extends Error {
	constructor() {
		super("the destination was replaced while the replacement was staged");
	}
}

/** The refusal a staged replacement throws when the config lock was displaced while the
 * replacement was being staged: publishing under a lock this update no longer owns would race
 * the new holder's own read-modify-write, so the caller abandons the staged text and reports
 * the config as busy instead. */
class LockDisplacedError extends Error {
	constructor() {
		super("the config lock was displaced while the replacement was staged");
	}
}

/**
 * {@link atomicWriteFile}'s replacement steps for an already-resolved destination: the rename
 * lands on the destination itself without resolving it again, so a symlink substituted for the
 * final component after resolution cannot redirect the write to another file. The temporary
 * file lives in the destination's own directory — the same filesystem, so the final rename
 * cannot copy — the destination's permission bits are preserved exactly, and the renamed-in
 * file is always a regular file. With `expectedIdentity`, the destination is verified one
 * last time after the staging and before the rename, so a file saved while the staging was
 * in progress is refused instead of replaced. A `verify` hook runs as the last check before
 * the rename and aborts the replacement — by throwing, like an identity mismatch — when the
 * caller's own coordination state changed while the replacement was being staged.
 */
function writeResolvedFile(target: string, text: string, io: AtomicFileIo, expectedIdentity?: string, verify?: () => void): void {
	const mode = io.modeOf(target) ?? NEW_CONFIG_MODE;
	const temp = join(dirname(target), `.${basename(target)}.tmp-${randomUUID()}`);
	try {
		io.writeExclusive(temp, text, mode);
		if (expectedIdentity !== undefined && io.identityOf !== undefined && io.identityOf(target) !== expectedIdentity) {
			throw new DestinationReplacedError();
		}
		verify?.();
		io.rename(temp, target);
	} finally {
		try {
			io.remove(temp);
		} catch {
			/* the successful rename already consumed the temporary file */
		}
	}
}

/** Whether the error is a plain absent-path failure, as opposed to permissions or other I/O. */
function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Whether the error says the destination path is already occupied, as opposed to a
 * filesystem refusing the link operation outright. */
function isEexist(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST";
}

/** How old the lock file may be before a holder that crashed without releasing is considered gone. */
const LOCK_MAX_AGE_MS = 10_000;

/** The advisory lock file beside the config it guards, hidden like the update's own temp file.
 * Exported so the suite can stage the lock files its protocol tests examine. */
export function lockPathFor(path: string): string {
	return join(dirname(path), "." + basename(path) + ".lock");
}

/** The locks this process currently holds, by lock path: the owner token each acquisition wrote.
 * Release and the pre-publish ownership check compare the file's current content with it, so a
 * lock taken over by another writer is neither removed nor published on as if it were still ours. */
const heldLocks = new Map<string, string>();

/** One acquisition's owner token: the pid plus a per-acquisition nonce, so a takeover by another
 * writer is always a content change the displaced holder can detect. */
function lockOwnerToken(): string {
	return process.pid + ":" + randomUUID() + "\n";
}

/** A lock file's whole content, or undefined when it cannot be read. */
function readLockContent(lockPath: string): string | undefined {
	try {
		return readFileSync(lockPath, "utf8");
	} catch {
		return undefined;
	}
}

/** The identity a stale-recovery decision was made from: the mtime the holder was declared gone
 * by, and the owner token that file carried at that moment. */
interface LockObservation {
	mtimeMs: number;
	content: string;
}

/** The lock-protocol steps injectable so the suite can drive restore failures and takeover
 * interleavings deterministically; every default is the real filesystem operation. */
export interface ConfigLockHooks {
	/** The hard-link restore a displaced record attempts when the lock path may be free. */
	link?(from: string, to: string): void;
	/** Runs after the release observed the moved file's content, while the lock path is still
	 * empty — exactly the takeover window the take-aside protocol must survive. */
	afterObserved?(observed: string | undefined): void;
}

/**
 * The stale-recovery step of the lock acquisition, exported with the observation injectable so
 * the suite can drive the preempted-contender window deterministically. The takeover renames the
 * lock path aside - atomic, so of two contenders on the same abandoned lock only the one whose
 * rename still finds the path proceeds - and then verifies the moved file is the very identity
 * observed stale, by mtime and owner token: a lock replaced after the observation, another
 * contender's fresh acquisition, is restored at the path, never adopted or deleted, so a delayed
 * contender cannot delete the winner's lock and double-acquire. An observed lock younger than
 * LOCK_MAX_AGE_MS never gets past the staleness check at all.
 */
export function takeOverStaleConfigLock(configPath: string, observed?: LockObservation, hooks?: ConfigLockHooks): boolean {
	const lockPath = lockPathFor(configPath);
	if (observed === undefined) {
		try {
			const stats = statSync(lockPath);
			const content = readLockContent(lockPath);
			if (content === undefined) return false;
			observed = { mtimeMs: stats.mtimeMs, content };
		} catch {
			return false;
		}
	}
	if (Date.now() - observed.mtimeMs < LOCK_MAX_AGE_MS) return false;
	let claim: string | undefined;
	let keepClaim = false;
	try {
		claim = join(dirname(lockPath), "." + basename(lockPath) + ".stale-" + randomUUID());
		renameSync(lockPath, claim);
		let movedIsObserved = false;
		try {
			movedIsObserved = statSync(claim).mtimeMs === observed.mtimeMs && readLockContent(claim) === observed.content;
		} catch {
			/* the moved file is unreadable: not provably the observed one */
		}
		if (!movedIsObserved) {
			// The lock at the path was replaced after the observation. Restore the replacement
			// without overwriting anyone: the hard link recreates the path only while it is
			// free, and if another owner already took it the displaced lock is dropped - its
			// holder detects the loss through the ownership check before publishing.
			try {
				(hooks?.link ?? linkSync)(claim, lockPath);
			} catch (error) {
				// Only an occupied path proves a live owner took the replacement's place; any other
				// refusal says nothing about the path, and deleting the moved record would destroy
				// the only copy. It stays beside the lock, recoverable, while the displaced holder
				// still detects the loss through the ownership check before publishing.
				if (!isEexist(error)) keepClaim = true;
			}
			return false;
		}
	} catch {
		return false;
	} finally {
		if (claim !== undefined && !keepClaim) {
			try {
				unlinkSync(claim);
			} catch {
				/* a consumed, restored, or never-created claim needs no cleanup */
			}
		}
	}
	return true;
}

/**
 * Acquires the config's advisory lock for this process: a fresh exclusive create when the path
 * is free, the stale-recovery takeover otherwise. The lock file carries this acquisition's
 * owner token, so a holder displaced by a LOCK_MAX_AGE_MS takeover can detect the displacement
 * before it publishes. Exported with its counterpart so the suite can exercise the real
 * protocol on real files; defaultIo is the only production caller.
 */
export function acquireConfigLock(configPath: string): boolean {
	const lockPath = lockPathFor(configPath);
	const token = lockOwnerToken();
	try {
		writeFileSync(lockPath, token, { flag: "wx" });
	} catch {
		/* held: only a stale lock is taken over below */
		if (!takeOverStaleConfigLock(configPath)) return false;
		try {
			writeFileSync(lockPath, token, { flag: "wx" });
		} catch {
			return false;
		}
	}
	heldLocks.set(lockPath, token);
	return true;
}

/**
 * Releases the config's lock through the same take-aside protocol a stale takeover uses: the
 * lock file is renamed aside atomically and deleted only once the moved file is provably this
 * process's own acquisition token. A holder that paused past a takeover therefore never
 * unlinks the successor's lock — the moved file is the successor's, so it is restored at the
 * path, unless a new owner already holds it, in which case the displaced token is dropped and
 * its holder detects the loss through the ownership check before publishing. No read-then-
 * unlink sequence remains anywhere in the release, so no gap opens for a takeover to slip
 * into between the two. Only a refusal proving the path occupied (EEXIST) drops the displaced
 * record; a filesystem that refuses the restore outright leaves the moved record beside the
 * lock, recoverable, because deleting it would destroy the only copy while nothing proves a
 * new owner took the path.
 */
export function releaseConfigLock(configPath: string, hooks?: ConfigLockHooks): void {
	const lockPath = lockPathFor(configPath);
	const token = heldLocks.get(lockPath);
	heldLocks.delete(lockPath);
	if (token === undefined) return;
	let claim: string | undefined;
	let keepClaim = false;
	try {
		claim = join(dirname(lockPath), "." + basename(lockPath) + ".release-" + randomUUID());
		renameSync(lockPath, claim);
	} catch {
		return; // the lock path is already gone: there is nothing to release
	}
	try {
		const observed = readLockContent(claim);
		hooks?.afterObserved?.(observed);
		if (observed === token) {
			try {
				unlinkSync(claim);
			} catch {
				/* already consumed: the release is done */
			}
			return;
		}
		// Preempted: the moved file is the successor's lock, not this acquisition's. Restore it
		// at the path without overwriting anyone — the hard link recreates the path only while
		// it is free — and drop the displaced token when a new owner already holds the path.
		try {
			(hooks?.link ?? linkSync)(claim, lockPath);
		} catch (error) {
			// Only an occupied path proves a new owner holds it; any other refusal cannot, so
			// the successor's only record stays beside the lock, recoverable, and its holder
			// still detects the displacement through the ownership check before publishing.
			if (!isEexist(error)) keepClaim = true;
		}
	} finally {
		if (!keepClaim) {
			try {
				unlinkSync(claim);
			} catch {
				/* consumed by the deletion above, restored by the link, or never created */
			}
		}
	}
}

/** Whether the config's lock still carries this process's own latest acquisition token. */
function ownsConfigLock(configPath: string): boolean {
	const lockPath = lockPathFor(configPath);
	const token = heldLocks.get(lockPath);
	if (token === undefined) return false;
	return readLockContent(lockPath) === token;
}

/** The file's identity as the publish guard needs it: device, inode, nanosecond mtime, and
 * size pin the exact file a verified read observed. An atomic save always renames a fresh
 * inode over the path, so a changed identity at the publish is a replacement even when the
 * path and its resolution look unchanged. Exported so a custom io guards with the same
 * identity the default io derives. */
export function fileIdentity(path: string): string | undefined {
	try {
		const stat = statSync(path, { bigint: true });
		return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.size}`;
	} catch {
		return undefined;
	}
}

/** The production io over the real filesystem and the config-lock protocol; exported so the
 * suite can wrap its steps and drive the interleavings the lock and staging guards exist for. */
export const defaultIo: EnsureExposureIo = {
	resolve: (path) => fsIo.resolve(path),
	read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
	identityOf: (path) => fileIdentity(path),
	// io.write always receives the destination ensureDirectExposure already resolved — the same
	// path the lock and every read address — so the write must not resolve it again: a symlink
	// substituted for the final component after resolution would redirect the publish. The
	// expected identity travels into the staged replacement, whose rename is refused when the
	// destination changed while the replacement was being written. Lock ownership joins those
	// staged final checks: a holder displaced while the replacement was being staged must fail
	// the rename itself, not only the check that ran before the staging began.
	write: (path, text, expectedIdentity) =>
		writeResolvedFile(path, text, fsIo, expectedIdentity, () => {
			if (!ownsConfigLock(path)) throw new LockDisplacedError();
		}),
	acquireLock: (path) => acquireConfigLock(path),
	releaseLock: (path) => releaseConfigLock(path),
	ownsLock: (path) => ownsConfigLock(path),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Where `"exposure": "direct"` can be inserted into the `mcpServers.codegraph` entry of a
 * verified mcp.json text: just inside the entry object's opening brace. The scan is purely
 * positional — values are never rebuilt — and follows JSON.parse's last-occurrence rule for
 * duplicate keys, so the entry it locates is the entry the update validated. A document
 * nested deeper than {@link MAX_JSON_DEPTH} is not traversed: its caller reports the splice
 * unpreservable rather than risk the recursive walk exhausting the stack.
 */
function codegraphEntryInsertion(text: string): { at: number; emptyEntry: boolean } | undefined {
	type ValueKind = "object" | "other";
	interface Property {
		key: string;
		valueStart: number;
		kind: ValueKind;
	}
	let at = 0;
	const whitespace = () => {
		while (at < text.length && /\s/.test(text[at]!)) at += 1;
	};
	const escapes: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
	const scanString = (): string | undefined => {
		if (text[at] !== "\"") return undefined;
		at += 1;
		let value = "";
		while (at < text.length) {
			const char = text[at]!;
			if (char === "\"") {
				at += 1;
				return value;
			}
			if (char !== "\\") {
				value += char;
				at += 1;
				continue;
			}
			const escape = text[at + 1];
			if (escape === undefined) return undefined;
			if (escape in escapes) {
				value += escapes[escape]!;
				at += 2;
				continue;
			}
			if (escape !== "u") return undefined;
			const hex = text.slice(at + 2, at + 6);
			if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
			value += String.fromCharCode(Number.parseInt(hex, 16));
			at += 6;
		}
		return undefined;
	};
	const numberOrLiteral = /(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/y;
	const scanValue = (depth: number): ValueKind | undefined => {
		if (depth > MAX_JSON_DEPTH) return undefined;
		whitespace();
		const char = text[at];
		if (char === "{") return scanObject(depth) === undefined ? undefined : "object";
		if (char === "[") {
			at += 1;
			whitespace();
			if (text[at] === "]") {
				at += 1;
				return "other";
			}
			for (;;) {
				if (scanValue(depth + 1) === undefined) return undefined;
				whitespace();
				if (text[at] === ",") {
					at += 1;
					continue;
				}
				if (text[at] === "]") {
					at += 1;
					return "other";
				}
				return undefined;
			}
		}
		if (char === "\"") return scanString() === undefined ? undefined : "other";
		numberOrLiteral.lastIndex = at;
		const literal = numberOrLiteral.exec(text);
		if (literal === null || literal[0] === "") return undefined;
		at += literal[0].length;
		return "other";
	};
	const scanObject = (depth: number): Property[] | undefined => {
		at += 1; // the opening brace the caller verified
		const properties: Property[] = [];
		whitespace();
		if (text[at] === "}") {
			at += 1;
			return properties;
		}
		for (;;) {
			whitespace();
			const key = scanString();
			if (key === undefined) return undefined;
			whitespace();
			if (text[at] !== ":") return undefined;
			at += 1;
			whitespace();
			const valueStart = at;
			const kind = scanValue(depth + 1);
			if (kind === undefined) return undefined;
			properties.push({ key, valueStart, kind });
			whitespace();
			if (text[at] === ",") {
				at += 1;
				continue;
			}
			if (text[at] === "}") {
				at += 1;
				return properties;
			}
			return undefined;
		}
	};
	whitespace();
	if (text[at] !== "{") return undefined;
	const root = scanObject(0);
	if (root === undefined) return undefined;
	const servers = root.findLast((property) => property.key === "mcpServers" && property.kind === "object");
	if (servers === undefined) return undefined;
	at = servers.valueStart;
	const serversObject = scanObject(1); // the depth a root property's value occupies
	if (serversObject === undefined) return undefined;
	const entry = serversObject.findLast((property) => property.key === "codegraph" && property.kind === "object");
	if (entry === undefined) return undefined;
	const insertAt = entry.valueStart + 1;
	let after = insertAt;
	while (after < text.length && /\s/.test(text[after]!)) after += 1;
	return { at: insertAt, emptyEntry: text[after] === "}" };
}

/** A parse-order-free rendering for verifying that a textual edit changed exactly the intended
 * field: every object's keys are sorted, so two documents with the same values compare equal
 * regardless of key order. A value nested beyond {@link MAX_JSON_DEPTH} renders as undefined,
 * so the verification fails closed instead of exhausting the stack. */
function canonicalJson(value: unknown, depth = 0): string | undefined {
	if (depth > MAX_JSON_DEPTH) return undefined;
	if (Array.isArray(value)) {
		const items = value.map((item) => canonicalJson(item, depth + 1));
		if (items.includes(undefined)) return undefined;
		return `[${items.join(",")}]`;
	}
	if (isPlainObject(value)) {
		const keys = Object.keys(value).sort();
		const entries = keys.map((key) => {
			const rendered = canonicalJson(value[key], depth + 1);
			return rendered === undefined ? undefined : `${JSON.stringify(key)}:${rendered}`;
		});
		if (entries.includes(undefined)) return undefined;
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * The `"added"` publish's text: `"exposure": "direct"` spliced into the verified text right
 * inside the codegraph entry, leaving every other byte of the document — formatting, key order,
 * and JSON number spellings a parse-and-restringify would corrupt — exactly as the verified
 * read saw it, with a trailing newline added only when the document lacks one. The splice is
 * verified semantically against the parsed document it was computed from: an edit that changed
 * anything but the one field (or one that could not be placed at all) publishes nothing.
 */
function publishExposureText(raw: string, expected: Record<string, unknown>): string | undefined {
	const insertion = codegraphEntryInsertion(raw);
	if (insertion === undefined) return undefined;
	const field = insertion.emptyEntry ? `"exposure": "direct"` : `"exposure": "direct", `;
	const spliced = raw.slice(0, insertion.at) + field + raw.slice(insertion.at);
	let reparsed: unknown;
	try {
		reparsed = JSON.parse(spliced);
	} catch {
		return undefined;
	}
	const rendered = canonicalJson(reparsed);
	const wanted = canonicalJson(expected);
	if (rendered === undefined || wanted === undefined || rendered !== wanted) return undefined;
	return spliced.endsWith("\n") ? spliced : `${spliced}\n`;
}

/**
 * Adds `"exposure": "direct"` to the `codegraph` server entry of one mcp.json, only when the
 * field is absent. Every other key, server, and value in the document is preserved; the file
 * is rewritten only on the `"added"` outcome, as a syntax-preserving splice of the field into
 * the verified text — every other byte of the document survives as read, including JSON number
 * spellings that a parse-and-restringify would corrupt, and a missing trailing newline is the
 * only addition; a document whose field cannot be spliced and verified is reported as
 * `"unpreservable"` and left unwritten. Best effort by contract: a missing or unparseable file is reported and never
 * written, and an entry the caller did not configure is never invented. The publish also
 * refuses to clobber a concurrent writer: the file is re-read and compared with the text the
 * update was computed from immediately before the write, and any change discards that write
 * and restarts the whole read-modify-write from the file's current content — an atomic rename
 * prevents partial writes, not lost updates. The restart is bounded; a file that keeps
 * changing across every attempt is reported as `"conflict"` and left unwritten — and so is a
 * save that lands while the replacement itself is being staged: the staged text is abandoned
 * before the rename and the restart re-applies the field onto the saved file. The whole
 * update also runs under an exclusive lock beside the config when the io provides one, so two
 * coordinated writers serialize instead of racing through that window; a lock the update
 * cannot take is reported as `"busy"`, again with nothing written - and so is a lock the update
 * can no longer prove it owns at the publish: a holder displaced by a takeover publishes nothing.
 * The whole update addresses the destination a write itself resolves to — a symlinked config
 * and every other link to the same shared file contend on one lock and one file identity,
 * while the reported path stays the caller's own. A config whose parent directory does not
 * exist yet is reported as `"missing"` without creating anything — resolution distinguishes
 * only that absent-parent case, and every other resolution failure propagates. The publish
 * re-checks the destination it locked and refuses with `"conflict"` when the file there has
 * been replaced, so the update never writes through a link it did not lock — and refuses the
 * same way when the file there is no longer the exact file the verified read observed (an
 * editor's atomic same-path save), so a later write can never discard it; an identity the io
 * can no longer observe at all is the same refusal, never a match by absence.
 */
export function ensureDirectExposure(path: string, io: EnsureExposureIo = defaultIo): EnsureExposureResult {
	// The lock, the reads, and the publish all address the destination a write itself resolves
	// to: two mcp.json symlinks to one shared file must contend on one lock, or their updates
	// race through exactly the window the lock exists to serialize. The caller's own path is
	// what the result reports.
	let target: string;
	try {
		target = io.resolve?.(path) ?? path;
	} catch (error) {
		// A fresh home has no agent directory yet: the destination's parent is missing, so
		// resolution fails before anything can be read. That is a missing config — nothing is
		// created, no directory and no lock — while every other failure (permissions, other
		// I/O) propagates unchanged to the caller.
		if (isEnoent(error)) return { path, outcome: "missing" };
		throw error;
	}
	// The lock, when the io provides one, spans the complete read-modify-write — every read,
	// the verification, and the replacement — so two coordinated writers serialize instead of
	// racing through the verify-to-rename window; a lock the update cannot take means another
	// writer owns the file right now, and the update publishes nothing.
	if (io.acquireLock !== undefined && !io.acquireLock(target)) return { path, outcome: "busy" };
	try {
		for (let attempt = 1; ; attempt++) {
			const raw = io.read(target);
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
			// The file identity captured with the verified read: the publish compares it again, so
			// an atomic replacement at the same path between the two — same destination, fresh
			// inode — cannot slip past on an unchanged path identity alone.
			const verifiedIdentity = io.identityOf?.(target);
			if (io.read(target) !== raw) {
				if (attempt >= MAX_UPDATE_ATTEMPTS) return { path, outcome: "conflict" };
				continue; // a concurrent writer changed the file: restart from its current content
			}
			entry.exposure = "direct";
			// The publish lands only on the destination the update locked: if the file there was
			// replaced after the lock — by a symlink to another config or any other substitution
			// — re-resolving it no longer names the locked destination, and writing would land
			// outside this update's lock. A changed destination is a conflict.
			if (io.resolve !== undefined && io.resolve(target) !== target) return { path, outcome: "conflict" };
			// And the file there must still be the exact file the verified read observed: an
			// editor's atomic save after that read keeps the destination identical but always
			// replaces the inode, and writing on top of it would discard the editor's changes.
			// Both observations must exist and agree: an identity that is unknown on either side
			// proves nothing about the file the read observed — another process can move the config
			// aside for the reread and delete it before the publication, and a write through that
			// unknown would recreate a config that is gone. An unknown publishes nothing and gets the
			// bounded restart, so a transient stat failure recovers while an unknown that survives
			// the budget is a conflict; an adapter that supplies no identity hook keeps the verified
			// text comparison above as its only guard.
			if (io.identityOf !== undefined) {
				const observedIdentity = io.identityOf(target);
				if (verifiedIdentity === undefined || observedIdentity === undefined) {
					if (attempt >= MAX_UPDATE_ATTEMPTS) return { path, outcome: "conflict" };
					continue;
				}
				// Two defined observations that differ are two different files at one path: no restart
				// makes that a match, so the update refuses it at once.
				if (observedIdentity !== verifiedIdentity) return { path, outcome: "conflict" };
			}
			// The publish is a splice of the verified text, never a re-serialization: JSON.parse maps
			// an integer beyond Number's exact range onto the nearest double, so a stringified rebuild
			// would silently rewrite a sibling value like 9007199254740993 as 9007199254740992. Only
			// the inserted field is new text, and a splice that cannot be placed and verified
			// publishes nothing.
			const published = publishExposureText(raw, doc);
			if (published === undefined) return { path, outcome: "unpreservable" };
			// Lock ownership is verified after the splice is prepared — the preparation is exactly
			// the window in which a paused holder can be displaced by a stale takeover while the
			// identity checks still pass, because the successor has not written the config — and
			// once more inside the staged replacement itself (see defaultIo.write): a lock this
			// update no longer owns means another writer owns the config now, so nothing is
			// published under it.
			if (io.acquireLock !== undefined && io.ownsLock !== undefined && !io.ownsLock(target)) return { path, outcome: "busy" };
			try {
				io.write(target, published, verifiedIdentity);
			} catch (error) {
				if (error instanceof LockDisplacedError) return { path, outcome: "busy" };
				if (error instanceof DestinationReplacedError) {
					if (attempt >= MAX_UPDATE_ATTEMPTS) return { path, outcome: "conflict" };
					continue; // a save landed while the replacement was staged: restart from it
				}
				throw error;
			}
			return { path, outcome: "added" };
		}
	} finally {
		io.releaseLock?.(target);
	}
}

/**
 * Ensures the field in every agent home mcp.json: the Pi agent home first, then the Gentle Shell
 * isolated home, each resolved from the session's own overrides exactly as the runtime loads it
 * (see {@link codegraphMcpPaths}). An I/O failure on one home is isolated: that path is reported
 * as `"error"` and every remaining home is still attempted, so one unwritable config never
 * blocks the other homes. A home that was never provisioned — no agent directory at all — is
 * reported as `"missing"`, not an error.
 */
export function ensureDirectExposureInAgentHomes(home: string = homedir(), io: EnsureExposureIo = defaultIo, env: NodeJS.ProcessEnv = process.env): EnsureExposureResult[] {
	return [...new Set(codegraphMcpPaths(home, env))].map((path) => {
		try {
			return ensureDirectExposure(path, io);
		} catch {
			return { path, outcome: "error" };
		}
	});
}
