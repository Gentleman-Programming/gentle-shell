import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, parse, relative, resolve } from "node:path";
import type { OrchestratorMode } from "./agent-profiles.ts";
import { contextBackstopReached, type MeasuredContext } from "./context-backstop.ts";
import { resolveSessionWorktree, type WorktreeResolver } from "./session-worktree-registry.ts";
import type { MessageToolCall } from "./writer-batch-admission.ts";
import { overlappingSurfaces } from "./writer-surfaces.ts";

const WRITER_NAMES = ["gentle-ai-worker", "worker", "jd-fix-agent"];
// The rule sentence closes every rejection, after the specific problem (cost-speed P9b).
export const WRITER_EDIT_SURFACE_REJECTION =
	"Fix only that section, then relaunch with the rest of the task unchanged, never shortened or re-summarized; derive the surfaces from the task (narrow repository-relative paths or globs, one per line, until the next Markdown heading) and do not ask the human to author paths or globs.";
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

const INVISIBLE = /\p{Cc}|\p{Zl}|\p{Zp}/u;
const MARKER_ONLY = /^(?:[-*+]|\d+[.)])$/;
// An echoed entry is at most this many UTF-8 bytes, ellipsis included (after escaping and masking), cut on a code point.
const SHOWN_ENTRY_BYTES = 80;
const ELLIPSIS = "…";

function surfaceEntry(source: string): { path: string; valid: boolean } {
	const line = source.replace(/^ {0,3}/, "");
	const unlisted = line.replace(MARKDOWN_LIST_MARKER, "");
	const quoted = unlisted.match(/^`([^`]+)`$/);
	const path = quoted?.[1] ?? unlisted;
	return { path, valid: !(MARKER_ONLY.test(line) || (unlisted.includes("`") && !quoted) || INVISIBLE.test(source) || !isTaskScopedRepositoryRelativePath(path, !!quoted)) };
}

// Why an entry `surfaceEntry` rejected is invalid, and its fix. Rule (verifier blocker 3): the fix, applied
// literally to the entry, yields the path the author meant or an input that is still rejected, never a
// different accepted surface. So wrapping is suggested only for an entry that reads as one path with spaces,
// text beside a path is moved out rather than wrapped, and the path-shape reasons come before the whitespace ones.
function surfaceEntryProblem(source: string): string {
	const line = source.replace(/^ {0,3}/, "");
	const unlisted = line.replace(MARKDOWN_LIST_MARKER, "");
	const quoted = unlisted.match(/^`([^`]+)`$/);
	const path = quoted?.[1] ?? unlisted;
	if (MARKER_ONLY.test(line)) return "is a list marker with no path; put the path after it or delete the line";
	if (INVISIBLE.test(source)) return "contains a control or line-separator character; retype it without that character";
	if (unlisted.includes("`") && !quoted) return /`[^`]+`/.test(unlisted)
		? "has text outside its backticked path; move that text below another Markdown heading"
		: "has stray backticks; remove them";
	// The raw line, not the unlisted one: a real indented heading keeps its leftover indent, while `- # foo`
	// is list text, and moving it to the line start would make a heading that ends the section (PR #3114 review).
	if (/^ +#{1,6} /.test(line)) return "is a heading indented 4+ spaces, so it does not end the section; start it at the line start";
	if (unlisted !== line && /^#{1,6}\s/.test(unlisted)) return "is text under a list marker, not a path; move it below another Markdown heading, as a line of its own outside the list";
	const spaced = !quoted && /\p{White_Space}/u.test(unlisted);
	const normalized = path.replace(/\\/g, "/");
	const relativePath = normalized.replace(/^(?:\.\/)+/, "");
	const firstSegment = relativePath.split("/")[0];
	if (spaced ? /^(?:\/|~\/|[A-Za-z]:\/)/.test(normalized) : isAbsolute(path) || /^(?:[A-Za-z]:|\/|~)/.test(normalized) || relativePath.startsWith("/")) return "is absolute or home-relative; use a repository-relative path";
	if (!relativePath || relativePath === ".") return "names the whole repository; list only the paths or narrow globs the task edits";
	if (relativePath.split("/").includes("..")) return "has a `..` segment; use a path inside the repository";
	if (/[?*\[\]{}]/.test(firstSegment) && !/\p{White_Space}/u.test(firstSegment)) return "starts with a glob, so it spans the whole repository; start with a directory, for example `src/**/*.ts`";
	if (spaced) {
		if (!isTaskScopedRepositoryRelativePath(unlisted, true)) return "is not a path; move it below another Markdown heading";
		const words = unlisted.split(/\p{White_Space}+/u);
		const first = words[0], rest = unlisted.slice(first.length);
		const pathLike = (word: string) => isTaskScopedRepositoryRelativePath(word, false) && (word.includes("/") || /\.[\w-]{1,10}$/.test(word));
		const parts = commaParts(unlisted);
		if (parts.length > 1 && parts.every(part => isTaskScopedRepositoryRelativePath(part, false))) return "lists several paths; put one path per line";
		if (pathLike(first.replace(/:$/, "")) && (first.endsWith(":") || /^\p{White_Space}+(?:#|\/\/|\(|—|–|-|:)/u.test(rest))) return "has text after the path; move that text below another Markdown heading";
		if (words.length === 2 && first.endsWith(":") && pathLike(words[1])) return "has a label before the path; keep only the path";
		if (!first.endsWith(":") && !/[.:;,!?]$/.test(unlisted) && /\.[\w-]{1,10}$|\/$|\*$/.test(words.at(-1)!)) return "has spaces outside backticks; if it is one path, wrap the whole entry in backticks, otherwise move it below another Markdown heading";
		return "looks like prose; move it below another Markdown heading";
	}
	return "is not a narrow repository-relative path or glob; use one";
}

const WHITE_SPACE = /\p{White_Space}/u;

// `text.split(/\p{White_Space}*,\p{White_Space}*/u).filter(Boolean)` in linear time: that regex backtracks
// quadratically over a long whitespace run with no comma (PR #3114 review).
function commaParts(text: string): string[] {
	const raw = text.split(",");
	return raw.map((part, index) => {
		let start = 0, end = part.length;
		if (index > 0) while (start < end && WHITE_SPACE.test(part[start])) start++;
		if (index < raw.length - 1) while (end > start && WHITE_SPACE.test(part[end - 1])) end--;
		return part.slice(start, end);
	}).filter(Boolean);
}

const SECRET_WORDS = ["key", "token", "secret", "password", "passwd", "pwd", "credential", "credentials", "auth"];
const isWordCode = (code: number) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
const isLabelCode = (code: number) => isWordCode(code) || code === 46 || code === 45; // [\w.-]
const isTokenCode = (code: number) => isWordCode(code) || code === 43 || code === 61 || code === 45; // [\w+=-]
const isLineTerminator = (code: number) => code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
const isRegExpSpace = (char: string) => /\s/.test(char);

// Masking in one forward scan with no backtracking (PR #3114 review), equal to the earlier
// `.replace(/([\w.-]*(?:key|token|secret|passw(?:or)?d|pwd|credentials?|auth)\s*[:=]\s*).*/i, "$1***")`
// then `.replace(/[\w+=-]{24,}/g, run => /\d/.test(run) ? "***" : run)`. The keyword must end its [\w.-] run
// (neither `\s`, `:` nor `=` is in it), so the first run ending in one and followed by `\s*[:=]` is the match,
// starting at that run's first character. Whole runs are masked, so no masked token is ever cut.
function maskSecrets(text: string): string {
	let masked = text;
	for (let index = 0; index < text.length;) {
		if (!isLabelCode(text.charCodeAt(index))) { index++; continue; }
		const start = index;
		while (index < text.length && isLabelCode(text.charCodeAt(index))) index++;
		const tail = text.slice(Math.max(start, index - 11), index).toLowerCase();
		if (!SECRET_WORDS.some(word => tail.endsWith(word))) continue;
		let value = index;
		while (value < text.length && isRegExpSpace(text[value])) value++;
		if (text[value] !== ":" && text[value] !== "=") continue;
		value++;
		while (value < text.length && isRegExpSpace(text[value])) value++;
		let end = value;
		while (end < text.length && !isLineTerminator(text.charCodeAt(end))) end++;
		masked = `${text.slice(0, value)}***${text.slice(end)}`;
		break;
	}
	const pieces: string[] = [];
	for (let index = 0; index < masked.length;) {
		const start = index;
		while (index < masked.length && isTokenCode(masked.charCodeAt(index))) index++;
		if (index === start) { pieces.push(masked[index++]); continue; }
		const run = masked.slice(start, index);
		pieces.push(run.length >= 24 && /\d/.test(run) ? "***" : run);
	}
	return pieces.join("");
}

// Quote an offending line without echoing a secret or an unbounded line: secret-looking assignment values
// and long digit-bearing tokens are masked, invisible characters escaped, then cut at SHOWN_ENTRY_BYTES.
// Only ASCII spaces are stripped from the ends, so a tab at either end is shown escaped (PR #3114 review).
// Every step is linear in the line length.
function shownEntry(line: string): string {
	let start = 0, end = line.length;
	while (start < end && line[start] === " ") start++;
	while (end > start && line[end - 1] === " ") end--;
	const text = maskSecrets(line.slice(start, end))
		.replace(/\p{Cc}|\p{Zl}|\p{Zp}/gu, char => `\\u${char.codePointAt(0)!.toString(16).padStart(4, "0")}`);
	if (Buffer.byteLength(text) <= SHOWN_ENTRY_BYTES) return text;
	let shown = "", bytes = Buffer.byteLength(ELLIPSIS);
	for (const char of text) {
		bytes += Buffer.byteLength(char);
		if (bytes > SHOWN_ENTRY_BYTES) break;
		shown += char;
	}
	return `${shown}${ELLIPSIS}`;
}

// This is the same canonical parser used by both the tool hook and executor.
// Prose cannot close the section, and repeated sections must agree exactly.
// A rejection carries the concrete problem so the caller repairs only the
// section instead of re-summarizing the whole task (gentle-shell#1713).
function parseAllowedEditSurfaces(values: readonly unknown[]): { paths: string[] } | { problem: string } {
	let expected: string[] | undefined;
	let section = 0;
	for (const value of values) {
		if (typeof value !== "string") continue;
		for (const heading of value.matchAll(ALLOWED_EDIT_SURFACES_HEADING)) {
			section++;
			const lines = value.slice((heading.index ?? 0) + heading[0].length).split(/\r?\n/);
			const end = lines.findIndex(line => MARKDOWN_HEADING_LINE.test(line));
			const entries = (end === -1 ? lines : lines.slice(0, end)).map(line => line.replace(/ +$/g, "")).filter(Boolean);
			if (!entries.length) return { problem: "The `## Allowed edit surfaces` section has no entries; add one path per line before the next heading." };
			const parsed = entries.map(surfaceEntry);
			const invalid = parsed.findIndex(entry => !entry.valid);
			if (invalid !== -1) {
				const more = parsed.slice(invalid + 1).filter(entry => !entry.valid).length;
				const position = `non-empty line ${invalid + 1}${section > 1 ? ` of section ${section}` : ""}`;
				return { problem: `Allowed edit surfaces entry "${shownEntry(entries[invalid])}" (${position}) ${surfaceEntryProblem(entries[invalid])}.${more ? ` ${more} more invalid line${more === 1 ? " follows" : "s follow"}.` : ""}` };
			}
			const unique = [...new Set(parsed.map(entry => entry.path))].sort();
			if (expected) {
				const previous = expected;
				const differing = [...previous.filter(path => !unique.includes(path)), ...unique.filter(path => !previous.includes(path))].sort()[0];
				if (differing !== undefined) return { problem: `Repeated \`## Allowed edit surfaces\` sections disagree on "${shownEntry(differing)}"; keep one section or list the same entries in each.` };
			}
			expected = unique;
		}
	}
	if (expected) return { paths: expected };
	// A near-miss heading (wrong level, trailing colon, missing word) is the usual cause: name it.
	for (const value of values) {
		if (typeof value !== "string") continue;
		const alias = value.split(/\r?\n/).find(line => /^ {0,3}#{1,6}[ \t]/.test(line) && /\b(?:edit[ \t]+surfaces?|allowed[ \t]+(?:edit|files|paths))\b/i.test(line));
		if (alias) return { problem: `No \`## Allowed edit surfaces\` heading was found; "${shownEntry(alias)}" is close: rename it to exactly \`## Allowed edit surfaces\`.` };
	}
	return { problem: "No `## Allowed edit surfaces` heading was found; add it with one path per line." };
}

export function allowedEditSurfaces(...values: unknown[]): string[] | undefined {
	const parsed = parseAllowedEditSurfaces(values);
	return "paths" in parsed ? parsed.paths : undefined;
}

export function rejectUnscopedBoundedWriterDispatch(input: unknown): { block: true; reason: string } | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const record = input as Record<string, unknown>;
	if (typeof record.agent !== "string" || !WRITER_NAMES.includes(record.agent)) return undefined;
	const parsed = parseAllowedEditSurfaces([record.task, record.context]);
	if ("paths" in parsed) return undefined;
	return { block: true, reason: `${parsed.problem} ${WRITER_EDIT_SURFACE_REJECTION}` };
}

// Pain-point iteration S16: prompt rules alone did not stop small-task delegation (a two-feature request still
// started two writers for ~35-line units). A generic writer launch is admitted only for a task of an existing ODD
// feature document, when the parent's measured context reaches the context backstop (the same threshold as the
// runtime notice, lib/context-backstop.ts), or as one of 2+ disjoint writers alone in one message (P6, below). Judgment Day fix agents and continuations keep their own protocols.
// A line that starts with `Spec:` (optionally as a list item), names an odd/tasks document, and names a task
// `T<n>` later on the same line: covers the canon (`, T2, S3-S4`), the delegation card (`(read until "## Log").
// Do T2; S3.`), and comma-free forms (`.md T1 S1;`). A mention inside prose does not start the line.
const FEATURE_DOCUMENT_TASK = /^[ \t]*(?:[-*+][ \t]+)?Spec:[ \t]*`?(odd\/tasks\/[^\s,`()]+\.md)`?[^\n]*?\bT\d+\b/gm;
export const WRITER_FEATURE_DOCUMENT_REJECTION =
	"Writers run only for a task of an existing ODD feature document (`Spec: odd/tasks/<feature>.md, T<n>` in the task), when your measured context reaches the context backstop, or as two or more writers with disjoint `## Allowed edit surfaces` launched together in one message with no other tool call. This unit has none: write this unit inline yourself now; do not retry the launch, and never create a feature document only to launch writers.";

// cost-speed P6 (R1, L41): the parallel reason is two or more independent units launched together in one turn,
// in background mode or not. Pi runs one message's calls in parallel unless one is sequential, so the batch must
// hold only generic writer launches: any other call beside them (a sequential `todo`, an explorer, a verifier)
// voids it. Admission cannot measure unit size; "each heavier than a subagent start" stays a prompt rule.
function parallelWriterBatch(calls: readonly MessageToolCall[] | undefined): boolean {
	if (!calls || calls.length < 2) return false;
	const claims: string[][] = [];
	for (const call of calls) {
		const input = call.arguments;
		if (call.name !== "subagent_run" || !input || typeof input !== "object" || Array.isArray(input)) return false;
		const record = input as Record<string, unknown>;
		if (typeof record.agent !== "string" || !isGenericBoundedWriter(record.agent)) return false;
		const surfaces = allowedEditSurfaces(record.task, record.context);
		if (!surfaces) return false;
		if (claims.some(other => overlappingSurfaces(surfaces, other).length > 0)) return false;
		claims.push(surfaces);
	}
	return true;
}

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
	options: {
		root: string;
		contextUsage: MeasuredContext | undefined;
		env?: Readonly<Record<string, string | undefined>>;
		/**
		 * The parent's workflow mode. In full delegation mode the orchestrator never implements, so every authorized
		 * change, small ones included, belongs to a writer: rejecting it here would leave the task with no legal route.
		 * Omitted means organic, the admission above.
		 */
		orchestratorMode?: OrchestratorMode;
		/** Every tool call of the assistant message that issued this launch, itself included (`sameMessageToolCalls`). */
		sameMessageCalls?: readonly MessageToolCall[];
	},
): { block: true; reason: string } | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const record = input as Record<string, unknown>;
	if (typeof record.agent !== "string" || !isGenericBoundedWriter(record.agent)) return undefined;
	if (options.orchestratorMode === "full-delegation") return undefined;
	if (namesExistingFeatureDocumentTask([record.task, record.context], options.root)) return undefined;
	if (contextBackstopReached(options.contextUsage, options.env)) return undefined;
	if (parallelWriterBatch(options.sameMessageCalls)) return undefined;
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
