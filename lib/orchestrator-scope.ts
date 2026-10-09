import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { resolveSessionWorktree, type WorktreeResolver } from "./session-worktree-registry.ts";

export interface RepositoryFact {
	root: string | null;
	cloneHash: string | null;
	resolvedAt: number;
	source: "recorded-workspace/git";
}
export interface RecordedScope {
	host: RepositoryFact;
	tasks: { id: string; repository: RepositoryFact }[];
	registered: RepositoryFact[];
	omittedTasks: number;
	omittedRegistered: number;
	complete: boolean;
}
// Recorded cwd/root is literal, not a user spelling. The shared resolver maps
// these Unicode separators to ASCII space; reject them before resolving and on
// output/readback rather than aliasing a distinct directory or truncating a root.
const safeRoot = (root: string) => isAbsolute(root) && Buffer.byteLength(root) <= 256
	&& !/[\p{Cc}\p{Cf}\u00a0\u2000-\u200a\u202f\u205f\u3000]/u.test(root);
const object = (v: any) => v && typeof v === "object" && !Array.isArray(v);
const keys = (v: object, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
export function validRecordedScope(value: any): value is RecordedScope {
	const fact = (v: any) => object(v) && keys(v, ["cloneHash", "resolvedAt", "root", "source"])
		&& v.source === "recorded-workspace/git" && count(v.resolvedAt)
		&& ((v.root === null && v.cloneHash === null) || (typeof v.root === "string" && safeRoot(v.root)
			&& typeof v.cloneHash === "string" && /^[a-f0-9]{64}$/.test(v.cloneHash)));
	return object(value) && keys(value, ["complete", "host", "omittedRegistered", "omittedTasks", "registered", "tasks"])
		&& fact(value.host) && Array.isArray(value.tasks) && value.tasks.length <= 8
		&& value.tasks.every((t: any) => object(t) && keys(t, ["id", "repository"])
			&& typeof t.id === "string" && Buffer.byteLength(t.id) <= 512 && fact(t.repository))
		&& Array.isArray(value.registered) && value.registered.length <= 8 && value.registered.every(fact)
		&& count(value.omittedTasks) && count(value.omittedRegistered)
		&& value.complete === (value.omittedTasks === 0 && value.omittedRegistered === 0);
}

/** One bounded derivative snapshot, not a registry or authority. The caller supplies
 * only admitted, unfinished, non-restored owned children and durable registry roots.
 * Membership/cwd changes invalidate even unknown facts; session replacement clears.
 * No resolution runs on a stable heartbeat/token update. */
export class OrchestratorScopeCache {
	private key = "";
	private snapshot?: RecordedScope;
	private resolver: WorktreeResolver;
	private now: () => number;
	constructor(resolver = resolveSessionWorktree, now = Date.now) {
		this.resolver = resolver;
		this.now = now;
	}
	clear() {
		this.key = "";
		this.snapshot = undefined;
	}
	project(cwd: string, tasks: readonly { id: string; cwd: string }[], roots: readonly string[]): RecordedScope {
		const registered = [...new Set(roots)];
		const key = createHash("sha256").update(JSON.stringify([cwd, tasks.map(t => [t.id, t.cwd]), registered])).digest("hex");
		if (key === this.key && this.snapshot) return this.snapshot;
		const resolvedAt = this.now();
		const facts = new Map<string, RepositoryFact>();
		const fact = (path: string) => {
			if (facts.has(path)) return facts.get(path)!;
			const unknown: RepositoryFact = { root: null, cloneHash: null, resolvedAt, source: "recorded-workspace/git" };
			let identity;
			try { identity = safeRoot(path) ? this.resolver(path, path) : undefined; } catch { /* Unavailable is unknown. */ }
			const result = identity && safeRoot(identity.root) ? { ...unknown, root: identity.root,
				cloneHash: createHash("sha256").update(identity.commonDir).digest("hex") } : unknown;
			facts.set(path, result);
			return result;
		};
		this.snapshot = { host: fact(cwd), tasks: tasks.slice(0, 8).map(t => ({ id: t.id, repository: fact(t.cwd) })),
			registered: registered.slice(0, 8).map(fact), omittedTasks: Math.max(0, tasks.length - 8),
			omittedRegistered: Math.max(0, registered.length - 8), complete: tasks.length <= 8 && registered.length <= 8 };
		this.key = key;
		return this.snapshot;
	}
}
