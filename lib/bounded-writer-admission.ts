import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, parse, relative, resolve } from "node:path";
import { contextBackstopReached, type MeasuredContext } from "./context-backstop.ts";
import { resolveSessionWorktree, type WorktreeResolver } from "./session-worktree-registry.ts";

const WRITER_NAMES = ["gentle-ai-worker", "worker", "jd-fix-agent"];
export const WRITER_EDIT_SURFACE_REJECTION =
	"Writer tasks must include the exact Markdown heading `## Allowed edit surfaces` with narrow repository-relative paths or narrow globs, one per line. Every non-empty line belongs to the section until the next canonical Markdown heading and must be a valid surface entry. Paths containing whitespace require whole-entry backticks; begin explanatory prose under the next Markdown heading. The parent must derive or map that canonical block from the delegated task and relaunch the writer; do not accept aliases, and do not ask the human to author paths or globs.";
// One heading matcher: the parser scans with the global form, and continuation
// inheritance tests presence with the same source (review R3-003).
const ALLOWED_EDIT_SURFACES_HEADING_LINE = /^## Allowed edit surfaces[ \t]*$/im;
const ALLOWED_EDIT_SURFACES_HEADING = new RegExp(ALLOWED_EDIT_SURFACES_HEADING_LINE.source, "gim");
const MARKDOWN_HEADING_LINE = /^ {0,3}#{1,6} /;
const MARKDOWN_LIST_MARKER = /^(?:[-*+]|\d+[.)]) +/;

function isTaskScopedRepositoryRelativePath(value: string, backticked: boolean): boolean {
	const normalized = value.replace(/\\/g, "/");
	if (!normalized || isAbsolute(value) || /^(?:[A-Za-z]:|\/|~)/.test(normalized) || /\p{Cc}|\p{Zl}|\p{Zp}/u.test(normalized) || (/\p{White_Space}/u.test(normalized) && !backticked)) return false;
	const path = normalized.replace(/^(?:\.\/)+/, "");
	if (!path || path === "." || path.startsWith("/") || path.split("/").some(segment => segment === "..")) return false;
	return !/[?*\[\]{}]/.test(path.split("/")[0]);
}

export function tryNormalizeInRepoAbsolutePath(candidate: string, targetRoot: string): string | undefined {
	const normalizedCandidate = candidate.replace(/\\/g, "/");
	const isWindowsDrive = /^[A-Za-z]:\//.test(normalizedCandidate);
	const isPosixAbsolute = normalizedCandidate.startsWith("/");
	if (!isWindowsDrive && !isPosixAbsolute) {
		return undefined;
	}

	const roots = [targetRoot];
	try {
		const realRoot = realpathSync(targetRoot);
		if (realRoot !== targetRoot) roots.push(realRoot);
	} catch {
		// Target root might not exist on disk in synthetic unit tests
	}

	for (const root of roots) {
		const normRoot = root.replace(/\\/g, "/");
		const rootDriveMatch = normRoot.match(/^([A-Za-z]:)(\/.*)?$/);
		const candDriveMatch = normalizedCandidate.match(/^([A-Za-z]:)(\/.*)?$/);

		let candPrefix = "";
		let candPath = normalizedCandidate;
		if (candDriveMatch) {
			candPrefix = candDriveMatch[1]!.toLowerCase();
			candPath = candDriveMatch[2] ?? "/";
		} else if (isPosixAbsolute) {
			candPrefix = "";
			candPath = normalizedCandidate;
		} else {
			continue;
		}

		let rootPrefix = "";
		let rootPath = normRoot;
		if (rootDriveMatch) {
			rootPrefix = rootDriveMatch[1]!.toLowerCase();
			rootPath = rootDriveMatch[2] ?? "/";
		} else if (normRoot.startsWith("/")) {
			rootPrefix = "";
			rootPath = normRoot;
		} else {
			const resolvedRoot = resolve(normRoot).replace(/\\/g, "/");
			const resDrive = resolvedRoot.match(/^([A-Za-z]:)(\/.*)?$/);
			if (resDrive) {
				rootPrefix = resDrive[1]!.toLowerCase();
				rootPath = resDrive[2] ?? "/";
			} else {
				rootPrefix = "";
				rootPath = resolvedRoot;
			}
		}

		if (candPrefix !== rootPrefix) continue;

		const candSegments = candPath.split("/").filter((s) => s.length > 0 && s !== ".");
		const collapsedCand: string[] = [];
		for (const seg of candSegments) {
			if (seg === "..") {
				collapsedCand.pop();
			} else {
				collapsedCand.push(seg);
			}
		}
		const collapsedCandPath = "/" + collapsedCand.join("/");

		const rootSegments = rootPath.split("/").filter((s) => s.length > 0 && s !== ".");
		if (rootSegments.length === 0) continue;

		const collapsedRoot: string[] = [];
		for (const seg of rootSegments) {
			if (seg === "..") {
				collapsedRoot.pop();
			} else {
				collapsedRoot.push(seg);
			}
		}
		if (collapsedRoot.length === 0) continue;
		const collapsedRootPath = "/" + collapsedRoot.join("/");

		const prefixWithSlash = collapsedRootPath === "/" ? "/" : collapsedRootPath + "/";
		const isMatch = rootDriveMatch
			? collapsedCandPath.toLowerCase().startsWith(prefixWithSlash.toLowerCase())
			: collapsedCandPath.startsWith(prefixWithSlash);

		if (isMatch) {
			const rel = collapsedCandPath.slice(prefixWithSlash.length);
			if (rel.length > 0 && rel !== "." && !rel.startsWith("/")) {
				// Verify symlinks do not escape target root when the root exists on disk.
				// If the candidate or a segment of it does not exist yet, resolve its
				// nearest existing ancestor within the root and verify it does not escape.
				const existingRealRoots: string[] = [];
				for (const r of roots) {
					try {
						existingRealRoots.push(realpathSync(r));
					} catch {
						// Synthetic root in unit tests does not exist on disk
					}
				}

				if (existingRealRoots.length > 0) {
					// Use resolve(root, rel) rather than candidate directly to avoid
					// POSIX resolving Windows-style drive paths (e.g. C:\...) relative to process.cwd()
					let checkPath: string | undefined = resolve(root, rel);
					let realTarget: string | undefined;
					while (checkPath) {
						try {
							realTarget = realpathSync(checkPath);
							break;
						} catch {
							const parent = resolve(checkPath, "..");
							if (parent === checkPath) {
								break;
							}
							checkPath = parent;
						}
					}

					if (realTarget) {
						const escapes = !existingRealRoots.some((r) => {
							const relToRoot = relative(r, realTarget!);
							if (relToRoot === "" || (!relToRoot.startsWith("..") && !isAbsolute(relToRoot))) {
								return true;
							}
							if (rootDriveMatch) {
								const relLower = relative(r.toLowerCase(), realTarget!.toLowerCase());
								return relLower === "" || (!relLower.startsWith("..") && !isAbsolute(relLower));
							}
							return false;
						});
						if (escapes) return undefined;
					}
				}
				return rel;
			}
		}
	}

	return undefined;
}

export function resolveTargetRepositoryRoot(input: Record<string, unknown>, fallbackRoot?: string): string {
	if (typeof input.repository_root === "string" && input.repository_root.trim().length > 0) {
		return input.repository_root.trim();
	}
	if (typeof input.workspace_root === "string" && input.workspace_root.trim().length > 0) {
		return input.workspace_root.trim();
	}
	return fallbackRoot ?? process.cwd();
}

// This is the same canonical parser used by both the tool hook and executor.
// Prose cannot close the section, and repeated sections must agree exactly.
// A rejection carries the concrete problem so the caller repairs only the
// section instead of re-summarizing the whole task (gentle-shell#1713).
function parseAllowedEditSurfaces(values: readonly unknown[], targetRoot?: string): { paths: string[] } | { problem: string } {
	let expected: string[] | undefined;
	for (const value of values) {
		if (typeof value !== "string") continue;
		for (const heading of value.matchAll(ALLOWED_EDIT_SURFACES_HEADING)) {
			const lines = value.slice((heading.index ?? 0) + heading[0].length).split(/\r?\n/);
			const end = lines.findIndex(line => MARKDOWN_HEADING_LINE.test(line));
			const entries = (end === -1 ? lines : lines.slice(0, end)).map(line => line.replace(/ +$/g, "")).filter(Boolean);
			if (!entries.length) return { problem: "The section has no entries." };
			const paths: string[] = [];
			for (const source of entries) {
				const line = source.replace(/^ {0,3}/, "");
				const unlisted = line.replace(MARKDOWN_LIST_MARKER, "");
				const quoted = unlisted.match(/^`([^`]+)`$/);
				const path = quoted?.[1] ?? unlisted;
				if (/^(?:[-*+]|\d+[.)])$/.test(line) || (unlisted.includes("`") && !quoted) || /\p{Cc}|\p{Zl}|\p{Zp}/u.test(source) || !isTaskScopedRepositoryRelativePath(path, !!quoted)) {
					// Prose and a bad path need different repairs: moving a real surface
					// out of the section would silently narrow the writer's scope.
					// An unquoted entry with whitespace that would be valid when quoted is
					// ambiguous: name both repairs instead of guessing prose.
					const prose = /^(?:[-*+]|\d+[.)])$/.test(line) || (!quoted && /\p{White_Space}/u.test(unlisted));
					const quotable = prose && !quoted && !unlisted.includes("`") && !/\p{Cc}|\p{Zl}|\p{Zp}/u.test(source) && isTaskScopedRepositoryRelativePath(unlisted, true);
					const shown = (prose ? source.trim() : path).replace(/\p{Cc}|\p{Zl}|\p{Zp}/gu, " ");
					const bounded = shown.length > 120 ? `${shown.slice(0, 120)}...` : shown;
					if (quotable) {
						return { problem: `Line "${bounded}" is not a valid surface entry; if it is a path, wrap the whole entry in backticks, otherwise move it under a following Markdown heading.` };
					}
					if (prose) {
						return { problem: `Line "${bounded}" is not a valid surface entry; move prose under a following Markdown heading.` };
					}
					const suggestedRelative = targetRoot ? tryNormalizeInRepoAbsolutePath(path, targetRoot) : undefined;
					if (suggestedRelative && isTaskScopedRepositoryRelativePath(suggestedRelative, !!quoted)) {
						return { problem: `Entry "${bounded}" is not a narrow repository-relative path (use "${suggestedRelative}" instead); remove absolute paths, \`..\` segments, root globs, and stray backticks.` };
					}
					return { problem: `Entry "${bounded}" is not a narrow repository-relative path; remove absolute paths, \`..\` segments, root globs, and stray backticks.` };
				}
				paths.push(path);
			}
			const unique = [...new Set(paths)].sort();
			if (expected && (expected.length !== unique.length || expected.some((path, index) => path !== unique[index]))) return { problem: "Repeated sections list different surfaces." };
			expected = unique;
		}
	}
	return expected ? { paths: expected } : { problem: "No `## Allowed edit surfaces` heading was found." };
}

export function allowedEditSurfaces(...values: unknown[]): string[] | undefined {
	const parsed = parseAllowedEditSurfaces(values);
	return "paths" in parsed ? parsed.paths : undefined;
}

export function rejectUnscopedBoundedWriterDispatch(input: unknown, defaultRoot?: string): { block: true; reason: string } | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const record = input as Record<string, unknown>;
	if (typeof record.agent !== "string" || !WRITER_NAMES.includes(record.agent)) return undefined;
	const targetRoot = resolveTargetRepositoryRoot(record, defaultRoot);
	const parsed = parseAllowedEditSurfaces([record.task, record.context], targetRoot);
	if ("paths" in parsed) return undefined;
	return { block: true, reason: `${WRITER_EDIT_SURFACE_REJECTION} ${parsed.problem} Resend the same task text unchanged except for that section; never shorten or re-summarize it.` };
}

// Pain-point iteration S16: prompt rules alone did not stop small-task delegation (a two-feature request still
// started two writers for ~35-line units). A generic writer launch is admitted only for a task of an existing ODD
// feature document, or when the parent's measured context reaches the context backstop (the same threshold as the
// runtime notice, lib/context-backstop.ts). Judgment Day fix agents and continuations keep their own protocols.
// A line that starts with `Spec:` (optionally as a list item), names an odd/tasks document, and names a task
// `T<n>` later on the same line: covers the canon (`, T2, S3-S4`), the delegation card (`(read until "## Log").
// Do T2; S3.`), and comma-free forms (`.md T1 S1;`). A mention inside prose does not start the line.
const FEATURE_DOCUMENT_TASK = /^[ \t]*(?:[-*+][ \t]+)?Spec:[ \t]*`?(odd\/tasks\/[^\s,`()]+\.md)`?[^\n]*?\bT\d+\b/gm;
export const WRITER_FEATURE_DOCUMENT_REJECTION =
	"Writers run only for a task of an existing ODD feature document (`Spec: odd/tasks/<feature>.md, T<n>` in the task) or when your measured context reaches the context backstop. This unit has neither: write this unit inline yourself now; do not retry the launch, and never create a feature document only to launch writers.";

function featureDocumentExists(root: string, relativePath: string): boolean {
	// Resolve symlinks on both sides so a document linked from outside the root, or an odd/tasks directory linked
	// elsewhere, never admits a writer; the document must be a regular file under <root>/odd/tasks.
	try {
		const realRoot = realpathSync(resolve(root));
		const tasksDir = realpathSync(resolve(realRoot, "odd", "tasks"));
		const target = realpathSync(resolve(realRoot, relativePath));
		const inTasks = relative(tasksDir, target);
		if (relative(realRoot, tasksDir).startsWith("..") || !inTasks || inTasks.startsWith("..") || isAbsolute(inTasks)) return false;
		return statSync(target).isFile();
	} catch {
		return false;
	}
}

// True when a string value has a `Spec:` task line naming an existing feature document under `root`. Shared by
// writer and verifier admission so both accept exactly the same task lines.
export function namesExistingFeatureDocumentTask(values: readonly unknown[], root: string): boolean {
	for (const value of values) {
		if (typeof value !== "string") continue;
		for (const match of value.matchAll(FEATURE_DOCUMENT_TASK)) {
			if (featureDocumentExists(root, match[1])) return true;
		}
	}
	return false;
}

export function rejectUndocumentedWriterLaunch(
	input: unknown,
	options: { root: string; contextUsage: MeasuredContext | undefined; env?: Readonly<Record<string, string | undefined>> },
): { block: true; reason: string } | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const record = input as Record<string, unknown>;
	if (typeof record.agent !== "string" || !isGenericBoundedWriter(record.agent)) return undefined;
	if (namesExistingFeatureDocumentTask([record.task, record.context], options.root)) return undefined;
	if (contextBackstopReached(options.contextUsage, options.env)) return undefined;
	return { block: true, reason: WRITER_FEATURE_DOCUMENT_REJECTION };
}

// A continuation resumes the same delegated task, so a writer follow-up that
// carries no section of its own inherits the surfaces its original launch was
// admitted with. A follow-up that carries the heading is validated as written,
// never merged, and nothing is inherited when the original had no valid section.
// Judgment Day fix batches keep their own exact dispatch protocol.
export function inheritAllowedEditSurfaces(agent: string, followUp: string, context: unknown, originalPrompt: string): string {
	const hasHeading = (value: unknown) => typeof value === "string" && ALLOWED_EDIT_SURFACES_HEADING_LINE.test(value);
	if (!isGenericBoundedWriter(agent) || hasHeading(followUp) || hasHeading(context)) return followUp;
	const inherited = allowedEditSurfaces(originalPrompt);
	if (!inherited) return followUp;
	// Every inherited entry is backticked: some entries are admitted only when
	// quoted, and quoting never changes a valid path (review R3-002).
	return `${followUp}\n\n## Allowed edit surfaces\n${inherited.map(path => `\`${path}\``).join("\n")}\n`;
}

// Every agent admitted through the `## Allowed edit surfaces` guard, including
// Judgment Day fix agents; only these claim surfaces at runtime admission.
export function isBoundedWriter(name: string): boolean {
	return WRITER_NAMES.includes(name);
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

// Broad folders a user opens by accident. A repository there (or in HOME, or
// above it) makes every Git call scan the user's whole tree.
const BROAD_HOME_FOLDER = /^(?:documents|desktop|downloads|onedrive(?: - .+)?)$/i;
const BROAD_ONEDRIVE_FOLDER = /^(?:documents|desktop)$/i;

export interface BootstrapDirectoryOptions {
	/** Defaults to the canonical home directory. */
	readonly home?: string;
	/** Defaults to `process.platform`; Windows paths compare case-insensitively. */
	readonly platform?: NodeJS.Platform;
}

/** True when `path` is HOME, an ancestor of it, or a broad folder directly under it. */
export function isHomeOrBroadUserDirectory(path: string, options: BootstrapDirectoryOptions = {}): boolean {
	const platform = options.platform ?? process.platform;
	const fold = (value: string) => platform === "win32" ? value.toLowerCase() : value;
	let home: string;
	try { home = options.home ?? realpathSync.native(homedir()); } catch { return true; }
	const target = fold(path), canonicalHome = fold(home);
	const towardHome = relative(target, canonicalHome);
	if (towardHome === "" || (!isAbsolute(towardHome) && towardHome !== ".." && !towardHome.startsWith("..\\") && !towardHome.startsWith("../"))) return true;
	const parent = dirname(target);
	if (parent === canonicalHome) return BROAD_HOME_FOLDER.test(basename(path));
	return dirname(parent) === canonicalHome && /^onedrive(?: - .+)?$/i.test(basename(parent)) && BROAD_ONEDRIVE_FOLDER.test(basename(path));
}

export function safeBootstrapDirectory(path: string, options: BootstrapDirectoryOptions = {}): string | undefined {
	try {
		if (!isAbsolute(path)) return undefined;
		const root = realpathSync(path);
		if (!statSync(root).isDirectory() || root === parse(root).root || isHomeOrBroadUserDirectory(realpathSync.native(root), options)) return undefined;
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
