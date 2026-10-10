import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { validRecordedScope, type RecordedScope } from "./orchestrator-scope.ts";
import { projectCatalog } from "./orchestrator-catalog.ts";
import { decodePublishedState, type PublishedState } from "./orchestrator-state.ts";
import { decodeTaskAliases, type TaskAliases } from "./orchestrator-alias.ts";

// Same-profile OS-user trust boundary, not an authorization channel. POSIX modes
// restrict newly created storage; Windows deployments must supply their own ACLs.
// Synchronous bounded I/O serializes publication/disposal without promise races.
export const ACTIVITY_LIMIT = 16 * 1024 * 1024;
const HEADER_LIMIT = 16 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STATUSES = ["running", "queued", "waiting", "completed", "failed", "cancelled", "timed_out"];
type ObjectValue = Record<string, any>;
/** Remote records belong in a separate read-only store, never the local TaskStore.
 * Key them by (header.sessionHash, header.incarnation, summary.id), not bare task ID.
 * The header supplies parent identity; callers project only that session's tasks. */
export interface RemoteSummary {
	id: string; agent: string; label: string; status: string; model: string;
	createdAt: number; startedAt: number | null; endedAt: number | null; lastActivityAt: number;
}
export interface ActivityInput {
	task: RemoteSummary;
	thread: { version: number; dropped: number; items: readonly object[] };
}
export interface Activity { tasks: { summary: ActivityInput["task"]; thread: {
	version: number; dropped: number; items: ObjectValue[];
} }[] }
export interface Target { sessionHash: string; incarnation: string }
export interface DiscoveryMetadata {
	aliases?: TaskAliases;
	state?: PublishedState;
	scope?: RecordedScope;
	activation: string;
	workspace: string;
	tasks: { id: string; label: string; status: string; workspace: string }[];
	omitted: number;
}
export function sessionHash(sessionId: string) { return digest(sessionId); }
export function activationHash(peer: { sessionId: string; endpoint: string; createdAt: number }) {
	return digest(JSON.stringify([peer.sessionId, peer.endpoint, peer.createdAt]));
}
export interface Header extends Target {
	schema: 1; label: string; heartbeat: number; generation: number;
	counts: { running: number; queued: number; waiting: number; finished: number };
	digest: string | null; unavailable: "activity-too-large" | null;
}

const object = (v: unknown): v is ObjectValue => !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const keys = (v: ObjectValue, names: string[]) => Object.keys(v).length === names.length && names.every((k) => Object.hasOwn(v, k));
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export function sanitizeDisplayLabel(text: string) {
	const clean = stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
	return Array.from(clean).slice(0, 120).join("").trimEnd();
}
const label = sanitizeDisplayLabel;
const pick = (v: ObjectValue, names: string[]) => Object.fromEntries(names.map((k) => [k, v[k]]));
const summaryTextKeys = ["id", "agent", "label", "status", "model"];
const summaryKeys = [...summaryTextKeys, "createdAt", "startedAt", "endedAt", "lastActivityAt"];
const toolKeys = ["kind", "callId", "name", "output", "running", "isError"];

/** Retains every item and every output character; no prompt fallback or invocation
 * args (which can embed subagent prompts), session metadata, or control handles.
 * This is a field whitelist, not content redaction: retained text can contain secrets. */
export function projectActivity(input: readonly ActivityInput[]): Activity {
	const activity = { tasks: input.map(({ task, thread }) => ({
		summary: pick(task, summaryKeys) as ActivityInput["task"],
		thread: { version: thread.version, dropped: thread.dropped,
			items: thread.items.map((item) => pick(item, (item as ObjectValue).kind === "tool" ? toolKeys : ["kind", "text"])) },
	})) };
	if (!validActivity(activity)) throw new Error("malformed-activity");
	return activity;
}

function validActivity(value: unknown): value is Activity {
	return object(value) && keys(value, ["tasks"]) && Array.isArray(value.tasks) && value.tasks.every((row: unknown) => {
		if (!object(row) || !keys(row, ["summary", "thread"])) return false;
		const { summary: s, thread: t } = row;
		return object(s) && keys(s, summaryKeys) && summaryTextKeys.every((k) => typeof s[k] === "string") && STATUSES.includes(s.status)
			&& integer(s.createdAt) && integer(s.lastActivityAt)
			&& [s.startedAt, s.endedAt].every((time) => time === null || integer(time))
			&& object(t) && keys(t, ["version", "dropped", "items"]) && integer(t.version) && integer(t.dropped)
			&& Array.isArray(t.items) && t.items.every((item: unknown) => object(item) && (item.kind === "tool"
				? keys(item, toolKeys) && ["callId", "name", "output"].every((k) => typeof item[k] === "string")
					&& typeof item.running === "boolean" && typeof item.isError === "boolean"
				: ["text", "thinking", "note"].includes(item.kind) && keys(item, ["kind", "text"]) && typeof item.text === "string"));
	});
}

function validTarget(value: Target) {
	return object(value) && typeof value.sessionHash === "string" && HASH.test(value.sessionHash)
		&& typeof value.incarnation === "string" && UUID.test(value.incarnation);
}
function validDiscovery(d: unknown): d is DiscoveryMetadata {
	return object(d) && keys(d, ["activation", "workspace", "tasks", "omitted", ...["scope", "state", "aliases"].filter(k => Object.hasOwn(d, k))])
		&& typeof d.activation === "string" && HASH.test(d.activation)
		&& typeof d.workspace === "string" && d.workspace === label(d.workspace) && integer(d.omitted)
		&& Array.isArray(d.tasks) && d.tasks.length <= 8 && d.tasks.every((t: unknown) => object(t)
			&& keys(t, ["id", "label", "status", "workspace"])
			&& ["id", "label", "workspace"].every(k => typeof t[k] === "string" && t[k] === label(t[k]))
			&& STATUSES.includes(t.status));
}
function validHeader(h: unknown): h is Header {
	if (!object(h) || !keys(h, ["schema", "sessionHash", "incarnation", "label", "heartbeat", "generation", "counts", "digest", "unavailable"])) return false;
	return validTarget(h as Header) && h.schema === 1 && typeof h.label === "string" && h.label === label(h.label)
		&& integer(h.heartbeat) && integer(h.generation) && h.generation > 0
		&& object(h.counts) && keys(h.counts, ["running", "queued", "waiting", "finished"]) && Object.values(h.counts).every(integer)
		&& ((h.unavailable === null && typeof h.digest === "string" && HASH.test(h.digest))
			|| (h.unavailable === "activity-too-large" && h.digest === null));
}
function filename(target: Target, kind: "header" | "activity" | "discovery") {
	if (!validTarget(target)) throw new Error("malformed");
	return `${target.sessionHash}.${target.incarnation}.${kind}.json`;
}

function directory(path: string, privateMode = false, owned = privateMode) {
	const stat = fs.lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (owned && process.platform !== "win32"
		&& ((stat.mode & (privateMode ? 0o077 : 0o022)) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("unsafe-directory");
}
export function rootFor(profile: string, create = false, catalog = false) {
	const absolute = resolve(profile);
	// Reject symlink ancestors too. The caller supplies an existing profile root.
	for (let path = absolute;; path = dirname(path)) {
		directory(path);
		if (dirname(path) === path) break;
	}
	const shared = join(absolute, "gentle-agents");
	const root = join(shared, catalog ? "catalog" : "presence");
	// History may already own a 0755 shared root. Never change its permissions.
	for (const path of [shared, root]) {
		if (create) {
			try { fs.mkdirSync(path, { mode: 0o700 }); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		}
		directory(path, path === root, true);
	}
	return root;
}
function regular(stat: fs.Stats) {
	if (!stat.isFile() || stat.nlink !== 1 || (process.platform !== "win32" && stat.uid !== process.getuid?.())) throw new Error("unsafe-file");
}
export function boundedRead(path: string, limit: number) {
	const before = fs.lstatSync(path);
	regular(before);
	if (before.size > limit) throw new Error("oversized");
	const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
	try {
		const stat = fs.fstatSync(fd);
		regular(stat);
		if (stat.ino !== before.ino || stat.dev !== before.dev) throw new Error("unsafe-file");
		if (stat.size > limit) throw new Error("oversized");
		const bytes = Buffer.alloc(stat.size + 1);
		let used = 0;
		while (used < bytes.length) {
			const count = fs.readSync(fd, bytes, used, bytes.length - used, null);
			if (!count) break;
			used += count;
		}
		if (used !== stat.size) throw new Error("changed-file");
		return bytes.subarray(0, used);
	} finally { fs.closeSync(fd); }
}
function reason(error: unknown) {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" ? "missing" : code ? "io-error" : error instanceof SyntaxError ? "malformed" : (error as Error).message;
}
function atomicWrite(root: string, name: string, bytes: string) {
	directory(root, true);
	const destination = join(root, name);
	try { regular(fs.lstatSync(destination)); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	const temp = join(root, `.${name}.${randomUUID()}.tmp`);
	const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
	try {
		try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
		fs.renameSync(temp, destination);
	} finally {
		try { fs.unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
}

export interface PresencePage {
	entries: (Header & { recent: boolean })[];
	scanned: number; rejected: number; overflow: boolean; unavailable?: string;
}
function emptyPage(): PresencePage {
	return { entries: [], scanned: 0, rejected: 0, overflow: false };
}

/** A bounded, process-local continuation: each next() examines at most 128 entries.
 * Exhaustion closes automatically; callers abandoning traversal must close in finally.
 * Overflow means the page budget was exhausted; the next page may be empty.
 * A stable directory is traversed once in OS order. Concurrent mutations can cause
 * misses/duplicates: deduplicate activation keys and open a fresh cursor on refresh.
 * This is not a snapshot or a liveness guarantee. No stale files are deleted. */
export class PresenceCursor {
	private dir?: fs.Dir;
	private readonly profile: string;
	private readonly identity: fs.Stats;
	constructor(profile: string) {
		this.profile = resolve(profile);
		const root = rootFor(this.profile);
		this.identity = fs.lstatSync(root);
		this.dir = fs.opendirSync(root);
	}
	next(now = Date.now()): PresencePage {
		const result = emptyPage();
		if (!this.dir) return { ...result, unavailable: "closed" };
		try {
			const stat = fs.lstatSync(rootFor(this.profile));
			if (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) throw new Error("changed-directory");
			while (result.scanned < 128) {
				const entry = this.dir.readSync();
				if (!entry) { this.close(); return result; }
				result.scanned++;
				if (!entry.name.endsWith(".header.json") || entry.name.startsWith(".")) continue;
				try {
					const h = JSON.parse(boundedRead(join(this.dir.path, entry.name), HEADER_LIMIT).toString("utf8"));
					if (!validHeader(h) || filename(h, "header") !== entry.name) throw new Error("malformed");
					result.entries.push({ ...h, recent: now >= h.heartbeat && now - h.heartbeat <= 15_000 });
				} catch { result.rejected++; }
			}
			result.overflow = true;
		} catch (error) { result.unavailable = reason(error); this.close(); }
		return result;
	}
	close() {
		const dir = this.dir;
		this.dir = undefined;
		dir?.closeSync();
	}
}

/** First-page convenience only. Use PresenceCursor when overflow is visible. */
export function listPresence(profile: string, now = Date.now()): PresencePage {
	try {
		const cursor = new PresenceCursor(profile);
		try { return cursor.next(now); } finally { cursor.close(); }
	} catch (error) { return { ...emptyPage(), unavailable: reason(error) }; }
}

/** The selection pins both activation and generation; never fall back to another session. */
export function readActivity(profile: string, selection: Header): { activity?: Activity; unavailable?: string } {
	try {
		// Directory list adds only this reader-owned display hint.
		const { recent: _recent, ...h } = selection as Header & { recent?: boolean };
		if (!validHeader(h)) throw new Error("malformed");
		if (h.unavailable) return { unavailable: h.unavailable };
		const bytes = boundedRead(join(rootFor(profile), filename(h, "activity")), ACTIVITY_LIMIT);
		const value = JSON.parse(bytes.toString("utf8"));
		if (object(value) && integer(value.generation) && value.generation !== h.generation) throw new Error("generation-mismatch");
		if (digest(bytes) !== h.digest) throw new Error("digest-mismatch");
		if (!object(value) || !keys(value, ["schema", "sessionHash", "incarnation", "generation", "activity"])
			|| value.schema !== 1 || value.generation !== h.generation || value.sessionHash !== h.sessionHash
			|| value.incarnation !== h.incarnation || !validActivity(value.activity)) throw new Error("malformed");
		return { activity: value.activity };
	} catch (error) { return { unavailable: reason(error) }; }
}

/** Optional derived sidecar; failures never invalidate the schema-1 header. */
export function readDiscovery(profile: string, h: Header): DiscoveryMetadata | undefined {
	try {
		const value = JSON.parse(boundedRead(join(rootFor(profile), filename(h, "discovery")), HEADER_LIMIT).toString("utf8"));
		if (!object(value) || !keys(value, ["schema", "sessionHash", "incarnation", "generation", "metadata"])
			|| value.schema !== 1 || value.sessionHash !== h.sessionHash || value.incarnation !== h.incarnation
			|| value.generation !== h.generation || !validDiscovery(value.metadata)) return undefined;
		const { scope, state, aliases: rawAliases, ...legacy } = value.metadata;
		const decoded = decodePublishedState(state);
		const aliases = decodeTaskAliases(rawAliases);
		return { ...legacy, ...(aliases ? { aliases } : {}), ...(validRecordedScope(scope) ? { scope } : {}), ...(decoded ? { state: decoded } : {}) };
	} catch { return undefined; }
}

export class PresencePublisher {
	readonly target: Readonly<Target>;
	private readonly profile: string;
	private readonly displayLabel: string;
	private readonly labelSource?: () => string;
	private header!: Header;
	private discovery?: DiscoveryMetadata;
	private catalog?: ReturnType<typeof projectCatalog>;
	private catalogTokens: string[] = [];
	private published = "";
	private pending = "";
	private timer?: ReturnType<typeof setTimeout>;
	private heartbeat?: ReturnType<typeof setInterval>;
	private disposed = false;
	private owned = new Map<string, { dev: number; ino: number }>();
	/** Timer I/O failures stop publication; consumers still apply the recent TTL. */
	error?: string;

	private constructor(options: { profile: string; sessionId: string; label: string; labelSource?: () => string }) {
		this.profile = options.profile;
		this.displayLabel = label(options.label);
		this.labelSource = options.labelSource;
		this.target = Object.freeze({ sessionHash: digest(options.sessionId), incarnation: randomUUID() });
	}
	static start(options: { profile: string; sessionId: string; label: string; labelSource?: () => string; activity: readonly ActivityInput[] }) {
		const publisher = new PresencePublisher(options);
		try {
			rootFor(options.profile, true);
			publisher.pending = JSON.stringify(projectActivity(options.activity));
			publisher.flush();
			publisher.heartbeat = setInterval(() => publisher.guarded(() => publisher.publishHeader()), 5000);
			publisher.heartbeat.unref();
			return publisher;
		} catch (error) { publisher.dispose(); throw error; }
	}
	/** Refresh through the existing publication path, without changing activity generation.
	 * The source must be a cheap canonical-name getter; throw when its session is stale. */
	refreshLabel() {
		this.guarded(() => this.publishHeader());
	}
	/** Metadata-only projection; never reads task prompts, results, or threads.
	 * Binding to the listener activation prevents reused session IDs from joining. */
	updateDiscovery(peer: { sessionId: string; endpoint: string; createdAt: number }, input: {
		workspace: string; tasks: readonly { id: string; label: string; status: string; cwd: string }[]; scope?: RecordedScope; registered?: readonly string[]; state?: PublishedState;
	}) {
		if (this.disposed) throw new Error("disposed");
		if (sessionHash(peer.sessionId) !== this.target.sessionHash) throw new Error("malformed-discovery");
		// A shortened path could denote a different workspace; do not advertise it.
		const workspace = (path: string) => Array.from(path).length <= 120 && label(path) === path ? path : "";
		const discovery: DiscoveryMetadata = { activation: activationHash(peer), workspace: workspace(input.workspace),
			tasks: input.tasks.slice(0, 8).map(t => ({ id: label(t.id), label: label(t.label), status: t.status, workspace: workspace(t.cwd) })),
			omitted: Math.max(0, input.tasks.length - 8) };
		const state = decodePublishedState(input.state);
		if (state?.sessionId === peer.sessionId) {
			discovery.state = state;
			if (state.aliases) discovery.aliases = structuredClone(state.aliases);
		}
		if (input.scope && validRecordedScope(input.scope)) {
			discovery.scope = structuredClone(input.scope);
			// Leave explicit gaps instead of publishing a sidecar readers cannot fit.
			if (Buffer.byteLength(JSON.stringify(discovery)) > HEADER_LIMIT - 1024) {
				const scope = discovery.scope;
				discovery.scope = { ...scope, tasks: [], registered: [],
					omittedTasks: scope.tasks.length + scope.omittedTasks,
					omittedRegistered: scope.registered.length + scope.omittedRegistered, complete: false };
			}
		}
		if (Buffer.byteLength(JSON.stringify(discovery)) > HEADER_LIMIT - 1024) delete discovery.state;
		if (!validDiscovery(discovery)) throw new Error("malformed-discovery");
		const catalog = projectCatalog(input.tasks, input.registered ?? []);
		if (JSON.stringify(discovery) === JSON.stringify(this.discovery) && JSON.stringify(catalog) === JSON.stringify(this.catalog)) return;
		// Only catalog or routing-activation changes rotate page tokens; private
		// activity generations and unrelated legacy metadata do not invalidate them.
		if (JSON.stringify(catalog) !== JSON.stringify(this.catalog) || discovery.activation !== this.discovery?.activation)
			this.catalogTokens = Array.from({ length: 7 }, () => randomUUID());
		this.catalog = catalog;
		this.discovery = discovery;
		this.writeDiscovery();
	}
	/** Eagerly projects/serializes each supplied snapshot to detach caller-owned data.
	 * Only disk publication is coalesced; callers should avoid unrelated invalidations. */
	update(input: readonly ActivityInput[]) {
		if (this.disposed) throw new Error("disposed");
		const next = JSON.stringify(projectActivity(input));
		if (next === this.pending) return;
		this.pending = next;
		if (!this.timer && next !== this.published) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.guarded(() => this.flush());
			}, 400);
			this.timer.unref();
		}
	}
	private guarded(action: () => void) {
		if (this.disposed) return;
		try { action(); } catch (error) { this.error = reason(error); this.dispose(); }
	}
	private write(kind: "header" | "activity" | "discovery" | "catalog", bytes: string) {
		const root = rootFor(this.profile, kind === "catalog", kind === "catalog");
		const name = kind === "catalog" ? `${this.target.sessionHash}.${this.target.incarnation}.json` : filename(this.target, kind);
		atomicWrite(root, name, bytes);
		const { dev, ino } = fs.lstatSync(join(root, name));
		this.owned.set(join(root, name), { dev, ino });
	}
	private writeDiscovery() {
		if (!this.discovery) return;
		try {
			if (this.catalog) this.write("catalog", JSON.stringify({ schema: 1, ...this.target,
				generation: this.header.generation, activation: this.discovery.activation, tokens: this.catalogTokens, catalog: this.catalog }));
		} catch { /* Optional catalog failure must not suppress other metadata. */ }
		try {
			this.write("discovery", JSON.stringify({ schema: 1, ...this.target, generation: this.header.generation, metadata: this.discovery }));
		} catch { /* Metadata failure must not withdraw an existing activity peer. */ }
	}
	private publishHeader() {
		const header = { ...this.header, label: label(this.labelSource?.() ?? this.displayLabel), heartbeat: Date.now() };
		if (!validHeader(header)) throw new Error("malformed-header");
		this.write("header", JSON.stringify(header));
		this.header = header;
		this.writeDiscovery();
	}
	private flush() {
		if (this.pending === this.published) return;
		const activity: Activity = JSON.parse(this.pending);
		const generation = (this.header?.generation ?? 0) + 1;
		const bytes = JSON.stringify({ schema: 1, ...this.target, generation, activity });
		const oversized = Buffer.byteLength(bytes) > ACTIVITY_LIMIT;
		const counts = { running: 0, queued: 0, waiting: 0, finished: 0 };
		for (const { summary } of activity.tasks) {
			const status = summary.status;
			if (status === "running" || status === "queued" || status === "waiting") counts[status]++;
			else counts.finished++;
		}
		if (!oversized) this.write("activity", bytes);
		this.header = { schema: 1, ...this.target, label: this.displayLabel, heartbeat: Date.now(), generation,
			counts, digest: oversized ? null : digest(bytes), unavailable: oversized ? "activity-too-large" : null };
		this.publishHeader();
		this.published = this.pending;
	}
	/** Idempotent, non-recursive cleanup, limited to files this activation published.
	 * Replaced or linked files are deliberately left for their owner to handle. */
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		clearTimeout(this.timer);
		clearInterval(this.heartbeat);
		this.pending = this.published = "";
		for (const [path, identity] of this.owned) {
			try {
				rootFor(this.profile, false, dirname(path) === join(resolve(this.profile), "gentle-agents", "catalog"));
				const stat = fs.lstatSync(path);
				regular(stat);
				if (stat.dev === identity.dev && stat.ino === identity.ino) fs.unlinkSync(path);
			} catch { /* Never follow or remove a replacement when storage becomes unsafe. */ }
		}
		this.owned.clear();
	}
}
