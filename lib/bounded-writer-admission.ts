import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve } from "node:path";
import { resolveSessionWorktree, type WorktreeResolver } from "./session-worktree-registry.ts";

const WRITER_NAMES = ["gentle-ai-worker", "worker", "jd-fix-agent"];
export const WRITER_EDIT_SURFACE_REJECTION =
	"Writer tasks must include the exact Markdown heading `## Allowed edit surfaces` with narrow repository-relative paths or narrow globs, one per line. Every non-empty line belongs to the section until the next canonical Markdown heading and must be a valid surface entry. Paths containing whitespace require whole-entry backticks; begin explanatory prose under the next Markdown heading. The parent must derive or map that canonical block from the delegated task and relaunch the writer; do not accept aliases, and do not ask the human to author paths or globs.";
const ALLOWED_EDIT_SURFACES_HEADING = /^## Allowed edit surfaces[ \t]*$/gim;
const MARKDOWN_HEADING_LINE = /^ {0,3}#{1,6} /;
const MARKDOWN_LIST_MARKER = /^(?:[-*+]|\d+[.)]) +/;

function isTaskScopedRepositoryRelativePath(value: string, backticked: boolean): boolean {
	const normalized = value.replace(/\\/g, "/");
	if (!normalized || isAbsolute(value) || /^(?:[A-Za-z]:|\/|~)/.test(normalized) || /\p{Cc}|\p{Zl}|\p{Zp}/u.test(normalized) || (/\p{White_Space}/u.test(normalized) && !backticked)) return false;
	const path = normalized.replace(/^(?:\.\/)+/, "");
	if (!path || path === "." || path.startsWith("/") || path.split("/").some(segment => segment === "..")) return false;
	return !/[?*\[\]{}]/.test(path.split("/")[0]);
}

// This is the same canonical parser used by both the tool hook and executor.
// Prose cannot close the section, and repeated sections must agree exactly.
export function allowedEditSurfaces(...values: unknown[]): string[] | undefined {
	let expected: string[] | undefined;
	for (const value of values) {
		if (typeof value !== "string") continue;
		for (const heading of value.matchAll(ALLOWED_EDIT_SURFACES_HEADING)) {
			const lines = value.slice((heading.index ?? 0) + heading[0].length).split(/\r?\n/);
			const end = lines.findIndex(line => MARKDOWN_HEADING_LINE.test(line));
			const entries = (end === -1 ? lines : lines.slice(0, end)).map(line => line.replace(/ +$/g, "")).filter(Boolean);
			if (!entries.length) return undefined;
			const paths: string[] = [];
			for (const source of entries) {
				const line = source.replace(/^ {0,3}/, "");
				const unlisted = line.replace(MARKDOWN_LIST_MARKER, "");
				const quoted = unlisted.match(/^`([^`]+)`$/);
				const path = quoted?.[1] ?? unlisted;
				if (/^(?:[-*+]|\d+[.)])$/.test(line) || (unlisted.includes("`") && !quoted) || /\p{Cc}|\p{Zl}|\p{Zp}/u.test(source) || !isTaskScopedRepositoryRelativePath(path, !!quoted)) return undefined;
				paths.push(path);
			}
			const unique = [...new Set(paths)].sort();
			if (expected && (expected.length !== unique.length || expected.some((path, index) => path !== unique[index]))) return undefined;
			expected = unique;
		}
	}
	return expected;
}

export function rejectUnscopedBoundedWriterDispatch(input: unknown): { block: true; reason: string } | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const record = input as Record<string, unknown>;
	if (typeof record.agent !== "string" || !WRITER_NAMES.includes(record.agent)) return undefined;
	return allowedEditSurfaces(record.task, record.context) ? undefined : { block: true, reason: WRITER_EDIT_SURFACE_REJECTION };
}

export function isGenericBoundedWriter(name: string): boolean {
	return name === "gentle-ai-worker" || name === "worker";
}

// Source authorization is structural, never inferred from task prose. Deliberately
// exclude documentation, memory, harness metadata and configuration-only scopes.
export function isDevelopmentSurface(path: string): boolean {
	const normalized = path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
	if (normalized.split("/").some(part => /^(?:\.|\.\.|odd|docs?|memory|secrets|credentials|tokens|keychains|\.pi|\.agents|\.atl|\.git|\.config|\.ssh|\.aws|\.gnupg|\.credentials)$/i.test(part))) return false;
	if (/(^|\/)\w[\w.-]*\.config\.[cm]?[jt]s$/i.test(normalized)) return false;
	if (/(^|\/)\.env(?:$|[./_-])|\.(?:pem|key|p12|pfx)$/i.test(normalized)) return false;
	return /\.(?:[cm]?[jt]sx?|go|rs|py|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|vue|svelte|html|css|scss|sass|sql|sh)$/i.test(normalized) || /^(?:src|lib|tests?|app|packages)\/(?:[^\s]+\/)*\*\*?(?:\/\*)?$/.test(normalized);
}

export function safeBootstrapDirectory(path: string): string | undefined {
	try {
		if (!isAbsolute(path)) return undefined;
		const root = realpathSync(path);
		if (!statSync(root).isDirectory() || root === parse(root).root || root === realpathSync(homedir())) return undefined;
		if (/(^|[\\/])(?:\.ssh|\.credentials|\.aws|\.gnupg|\.config|secrets|credentials|tokens|keychains)(?:[\\/]|$)|(?:^|[\\/])\.env(?:$|[./_-])/i.test(root)) return undefined;
		return root;
	} catch { return undefined; }
}

export function sourcePathWithinProject(path: string, cwd: string): string | undefined {
	const root = safeBootstrapDirectory(cwd);
	if (!root) return undefined;
	try {
		const file = realpathSync(resolve(cwd, path.replace(/^@/, "").replace(/^~(?=\/|$)/, homedir())));
		const within = relative(root, file);
		if (isAbsolute(within) || within === ".." || within.startsWith("../") || within.startsWith("..\\") || !isDevelopmentSurface(within)) return undefined;
		return root;
	} catch { return undefined; }
}

// Capture synchronously before startup's first await. Once a clone is observed,
// its absence or replacement is drift, never permission to initialize again.
export function sessionRepositoryAuthority(cwd: string, resolver: WorktreeResolver = resolveSessionWorktree): () => boolean {
	const initial = resolver(cwd, cwd);
	let established = initial && { ...initial };
	return () => {
		const current = resolver(cwd, cwd);
		if (established) return current?.root === established.root && current?.commonDir === established.commonDir;
		if (current) established = { ...current };
		return true;
	};
}

interface SessionOwner { getSessionId(): string; getCwd?(): string }
type Preparation = (root: string, current: () => boolean, signal?: AbortSignal) => Promise<boolean>;
interface Binding { id: string; cwd: string; prepare: Preparation; current(): boolean; pending?: Promise<boolean> }
const preparations = new WeakMap<SessionOwner, Binding>();
const preparationOwners = new WeakSet<SessionOwner>();

// Session-bound callback, not a target authorization cache. Native policy and
// metadata checks remain in the native extension. Unbind only our incarnation.
export function bindSessionRepositoryPreparation(manager: SessionOwner, cwd: string, prepare: Preparation, live: () => boolean): () => void {
	const authorityCurrent = sessionRepositoryAuthority(cwd);
	const binding: Binding = { id: manager.getSessionId(), cwd, prepare, current: () => live() && manager.getSessionId() === binding.id && (manager.getCwd?.() ?? cwd) === cwd && authorityCurrent() };
	preparationOwners.add(manager);
	preparations.set(manager, binding);
	return () => { if (preparations.get(manager) === binding) preparations.delete(manager); };
}

// Pin the exact incarnation before awaiting native mode. An absent binding is
// compatible only for never-bound callers, not a previously revoked owner.
export function captureBoundSessionRepositoryAuthority(manager: SessionOwner, cwd: string): () => boolean {
	const binding = preparations.get(manager);
	const id = manager.getSessionId();
	return () => manager.getSessionId() === id && (manager.getCwd?.() ?? cwd) === cwd &&
		preparations.get(manager) === binding && (binding
			? binding.cwd === cwd && binding.current()
			: !preparationOwners.has(manager));
}

export function boundSessionRepositoryAuthorityCurrent(manager: SessionOwner, cwd: string): boolean {
	return captureBoundSessionRepositoryAuthority(manager, cwd)();
}

export async function prepareBoundSessionRepository(manager: SessionOwner, cwd: string, signal?: AbortSignal): Promise<boolean> {
	const binding = preparations.get(manager);
	const current = () => preparations.get(manager) === binding && !!binding?.current() && !signal?.aborted;
	if (!binding || binding.cwd !== cwd || !current()) return false;
	const root = safeBootstrapDirectory(cwd);
	if (!root) return false;
	if (!binding.pending) {
		binding.pending = binding.prepare(root, current, signal);
		binding.pending.finally(() => { binding.pending = undefined; }).catch(() => {});
	}
	try { return await binding.pending && current() && safeBootstrapDirectory(cwd) === root; }
	catch { return false; }
}
