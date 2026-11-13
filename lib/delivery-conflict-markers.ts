import { execFile } from "node:child_process";
import { lstat, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { worktreeGitEnvironment } from "./session-worktree-registry.ts";

// cost-speed P9: a mechanical guard, not a review. It refuses a `git commit` (or
// a sequencer `--continue`) whose recorded content ADDS a full set of conflict
// markers, including what a `git add` earlier in the same command would stage.
// Pushes are not checked: the range a push publishes depends on remote refs this
// guard cannot trust offline, and blocking a legitimate push is worse than a gap
// the commit check already covers. It fails open on its own errors: unparsed
// shapes, unknown directories, git failures and the time budget let the command through.

type Denial = { block: true; reason: string };
/** What a `git add` (or `git stage`) earlier in the same command would stage. */
interface Staging { pathspecs: string[]; tracked: boolean; untracked: boolean; force: boolean }
/** The content a commit records: the index, or worktree content (tracked, and untracked when staged by `add`). */
type Source = { kind: "index" } | { kind: "worktree"; pathspecs: string[]; untracked: boolean; force: boolean };
export interface Check { directory: string; sources: Source[]; staged: Staging[] }
/** `redirect`: an unquoted redirection, complete (`2>&1`, `>out`) or needing the next word as its target (`>`). */
interface Token { value: string; operator: boolean; redirect?: "complete" | "target" }

const SHOWN = 5;
const BUDGET_MS = 5_000;
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_UNTRACKED_BYTES = 1024 * 1024;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const COMMIT_VALUE_OPTIONS = new Set(["-m", "-F", "-C", "-c", "-t", "--message", "--file", "--reuse-message", "--reedit-message",
	"--template", "--author", "--date", "--cleanup", "--fixup", "--squash", "--trailer"]);
const SEQUENCERS = new Set(["merge", "rebase", "cherry-pick", "revert", "am"]);
// The second side of a commit that concludes a merge or applies a picked commit: a marker line counts only
// when it is added against HEAD and against this side. `revert` and `am` have no such side and stay one-sided.
const SECOND_SIDES = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REBASE_HEAD"];
const DIFF = ["--no-pager", "-c", "core.quotepath=false", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-relative", "--no-renames"];
const CANDIDATE = "-G^[<>][<>]";

/** Remove backslash-newline continuations outside single quotes (inside them a backslash is literal). */
function joinContinuations(command: string): string {
	let out = "", single = false, double = false;
	for (let at = 0; at < command.length; at++) {
		const char = command[at];
		if (char === "\\" && !single) {
			if (command[at + 1] === "\n") { at++; continue; }
			out += command.slice(at, at + 2); at++; continue;
		}
		if (char === "'" && !double) single = !single;
		else if (char === '"' && !single) double = !double;
		out += char;
	}
	return out;
}

function tokenize(command: string): Token[] {
	const tokens: Token[] = [];
	// `[<>]&`, `&>` and `>|` belong to a redirection (`2>&1`, `>&2`, `&>file`), never to a `&` separator.
	for (const match of joinContinuations(command).matchAll(/(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|[<>]&|&>|>\||[^\s;&|()'"\\])+|&&|\|\||[;&|()\n]/g)) {
		const raw = match[0];
		const operator = /^(?:&&|\|\||[;&|()\n])$/.test(raw);
		// Decided on the raw text: a quoted or escaped `<`/`>` is part of a word, never a redirection.
		const redirect = operator || !/^\d*(?:&>|[<>])/.test(raw) ? undefined : /^\d*(?:&>>?|[<>]{1,2}&?|>\|)$/.test(raw) ? "target" : "complete";
		tokens.push({ operator, redirect, value: operator ? raw : raw.replace(/"((?:\\.|[^"\\])*)"|'([^']*)'|\\(.)/g,
			(_raw, double: string | undefined, single: string | undefined, escaped: string | undefined) => double?.replace(/\\(["\\$`])/g, "$1") ?? single ?? escaped ?? "") });
	}
	return tokens;
}

const literal = (value: string | undefined) => value !== undefined && value !== "" && !/[\n\r$`~*?[\]]/.test(value) && !value.startsWith("-");

/** Commit-like segments with their literal directory and the staging that precedes them; anything unclear is skipped. */
export function conflictMarkerChecks(command: string, cwd: string): Check[] {
	// Heredoc bodies (a commit message, a script) are data, not segments.
	const tokens = tokenize(command.replace(/(<<-?\s*(['"]?)([A-Za-z_]\w*)\2[^\n]*)\n[\s\S]*?\n\s*\3(?=\n|\)|$)/g, "$1"));
	// cd persists through `;`, `&&` and `||`, but not across pipes, jobs or subshells.
	const scoped = !tokens.some(token => token.operator && ["|", "&", "(", ")"].includes(token.value));
	const checks: Check[] = [];
	// Staging seen so far, by directory; `undefined` in the list means an add this guard cannot predict.
	const staging = new Map<string, Array<Staging | undefined>>();
	let directory: string | undefined = cwd;
	let start = 0;
	for (let end = 0; end <= tokens.length; end++) {
		if (end < tokens.length && !tokens[end].operator) continue;
		// Redirections are not arguments: `> out`, `2>&1`, `<<EOF`, `< message.txt`.
		const words = tokens.slice(start, end).filter((token, at, all) => !token.redirect && all[at - 1]?.redirect !== "target").map(token => token.value);
		start = end + 1;
		let head = 0;
		while (/^[A-Za-z_]\w*=/.test(words[head] ?? "")) {
			if (/^GIT_/i.test(words[head])) head = words.length; // ambient git redirect: not ours to guess
			head++;
		}
		// `builtin cd` and `command cd` are cd; with an option the shape is not ours to guess.
		if ((words[head] === "builtin" || words[head] === "command") && words[head + 1] !== undefined) {
			if (words[head + 1].startsWith("-")) { directory = undefined; continue; }
			head++;
		}
		const name = (words[head] ?? "").split("/").at(-1);
		const args = words.slice(head + 1);
		if (name === "cd" || name === "pushd" || name === "popd") {
			directory = scoped && name === "cd" && directory && args.length === 1 && literal(args[0]) ? resolve(directory, args[0]) : undefined;
			continue;
		}
		if (name !== "git" || !directory) continue;
		let target: string | undefined = directory, index = 0;
		while (index < args.length && args[index].startsWith("-")) {
			const option = args[index];
			if (option === "-C") { target = target && literal(args[index + 1]) ? resolve(target, args[index + 1]) : undefined; index += 2; }
			else if (option.startsWith("-C")) { target = target && literal(option.slice(2)) ? resolve(target, option.slice(2)) : undefined; index++; }
			else if (option === "-c") index += 2;
			else if (/^--(?:git-dir|work-tree|namespace)(?:=|$)/.test(option)) { target = undefined; index += option.includes("=") ? 1 : 2; }
			else index++;
		}
		const subcommand = args[index], rest = args.slice(index + 1);
		if (!target) continue;
		if (subcommand === "add" || subcommand === "stage") {
			staging.set(target, [...(staging.get(target) ?? []), addStaging(rest)]);
		} else if (subcommand === "commit") {
			const check = commitCheck(rest, target, staging.get(target) ?? []);
			if (check) checks.push(check);
		} else if (SEQUENCERS.has(subcommand ?? "") && rest.includes("--continue")) {
			const staged = staging.get(target) ?? [];
			checks.push({ directory: target, sources: [{ kind: "index" }], staged: staged.filter(item => item !== undefined) });
		}
	}
	return checks;
}

/** What `git add <args>` would stage; `undefined` for a shape that cannot be predicted (patch, pathspec magic, shell globs). */
function addStaging(args: string[]): Staging | undefined {
	let all = false, update = false, force = false, dryRun = false;
	const pathspecs: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") { pathspecs.push(...args.slice(index + 1)); break; }
		if (/^(?:--patch|--interactive|--edit|--intent-to-add|--pathspec-from-file.*|--renormalize|--refresh)$/.test(arg)) return undefined;
		if (arg === "--all" || arg === "--no-ignore-removal") all = true;
		else if (arg === "--update") update = true;
		else if (arg === "--force") force = true;
		else if (arg === "--dry-run") dryRun = true;
		else if (/^-[^-]/.test(arg)) {
			for (const flag of arg.slice(1)) {
				if ("piNe".includes(flag)) return undefined;
				if (flag === "A") all = true;
				else if (flag === "u") update = true;
				else if (flag === "f") force = true;
				else if (flag === "n") dryRun = true;
			}
		} else if (!arg.startsWith("-")) pathspecs.push(arg);
	}
	if (pathspecs.some(path => !literal(path) || path.startsWith(":"))) return undefined;
	if (dryRun || (!pathspecs.length && !all && !update)) return { pathspecs: [], tracked: false, untracked: false, force: false };
	return { pathspecs, tracked: true, untracked: !update, force };
}

function commitCheck(args: string[], directory: string, staged: Array<Staging | undefined>): Check | undefined {
	let all = false, include = false;
	const paths: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") { paths.push(...args.slice(index + 1)); break; }
		if (arg === "--dry-run" || arg.startsWith("--pathspec-from-file")) return undefined;
		if (arg === "--all") all = true;
		else if (arg === "--include") include = true;
		else if (COMMIT_VALUE_OPTIONS.has(arg)) index++;
		else if (/^-[^-]/.test(arg)) {
			for (let at = 1; at < arg.length; at++) {
				const flag = arg[at];
				if (flag === "a") all = true;
				else if (flag === "i") include = true;
				else if ("mFCct".includes(flag)) { if (at === arg.length - 1) index++; break; }
				else if ("Su".includes(flag)) break;
			}
		}
		else if (!arg.startsWith("-")) paths.push(arg);
	}
	const known = staged.filter(item => item !== undefined);
	// `commit <paths>` records only those paths' worktree content; staging does not change it unless `--include`.
	if (paths.length && !include) return { directory, sources: [{ kind: "worktree", pathspecs: paths, untracked: false, force: false }], staged: [] };
	const sources: Source[] = [];
	if (paths.length) sources.push({ kind: "worktree", pathspecs: paths, untracked: false, force: false });
	// `-a` records the worktree of every tracked file (files in the index included), which replaces the index.
	if (all) sources.push({ kind: "worktree", pathspecs: [], untracked: false, force: false });
	else sources.push({ kind: "index" });
	return { directory, sources, staged: known };
}

type Added = Map<string, Array<{ line: number; text: string }>>;
const isCandidate = (text: string) => /^(<|=|>)\1/.test(text);

/** Added lines that could be markers from a `-U0` diff of ONE file, whose path the caller already knows. */
export function addedMarkerLines(diff: string): Array<{ line: number; text: string }> {
	const lines: Array<{ line: number; text: string }> = [];
	// Headers (`+++ b/...`) come before the first hunk; with `-U0` every later `+` line is added content.
	let line = 0, inHunk = false;
	for (const raw of diff.split("\n")) {
		if (raw.startsWith("@@ ")) { line = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0); inHunk = true; }
		else if (inHunk && raw.startsWith("+")) {
			const text = raw.slice(1).replace(/\r$/, "");
			if (isCandidate(text)) lines.push({ line, text });
			line++;
		}
	}
	return lines;
}

/** `path:line` of each opening marker in files that add an opening and a closing marker of their size. */
export function conflictMarkerFindings(added: Added, sizes: Map<string, number> = new Map()): string[] {
	const findings: string[] = [];
	for (const [path, lines] of added) {
		const size = sizes.get(path) ?? 7;
		const opening = lines.filter(({ text }) => text.startsWith(`${"<".repeat(size)} `));
		if (opening.length && lines.some(({ text }) => text.startsWith(`${">".repeat(size)} `)))
			findings.push(...opening.map(({ line }) => `${path}:${line}`));
	}
	return findings;
}

class Budget {
	readonly deadline = Date.now() + BUDGET_MS;
	readonly signal: AbortSignal | undefined;
	constructor(signal?: AbortSignal) { this.signal = signal; }
	git(directory: string, args: string[]): Promise<string | undefined> {
		const timeout = this.deadline - Date.now();
		if (timeout <= 0 || this.signal?.aborted) return Promise.resolve(undefined);
		return new Promise(done => execFile("git", args, { cwd: directory, encoding: "utf8", timeout, maxBuffer: MAX_BUFFER,
			windowsHide: true, env: worktreeGitEnvironment(), ...(this.signal ? { signal: this.signal } : {}) },
		(error, stdout) => done(error ? undefined : stdout)));
	}
}

const nulList = (out: string) => out.split("\0").filter(Boolean);

// Git's own `conflict-marker-size` attribute is the escape for files that keep markers on purpose.
async function markerSizes(budget: Budget, top: string, paths: string[]): Promise<Map<string, number> | undefined> {
	const out = await budget.git(top, ["check-attr", "-z", "conflict-marker-size", "--", ...paths]);
	if (out === undefined) return undefined;
	const fields = out.split("\0"), sizes = new Map<string, number>();
	for (let at = 0; at + 2 < fields.length; at += 3) {
		const size = Number(fields[at + 2]);
		if (Number.isInteger(size) && size > 0) sizes.set(fields[at], size);
	}
	return sizes;
}

async function untrackedLines(top: string, path: string): Promise<Array<{ line: number; text: string }>> {
	const file = join(top, path);
	const stats = await lstat(file);
	if (!stats.isFile() || stats.size > MAX_UNTRACKED_BYTES) return [];
	const handle = await open(file, "r");
	try {
		const content = await handle.readFile();
		if (content.subarray(0, 8000).includes(0)) return [];
		return content.toString("utf8").split("\n").map((text, at) => ({ line: at + 1, text: text.replace(/\r$/, "") })).filter(({ text }) => isCandidate(text));
	} finally { await handle.close(); }
}

/** Marker candidates the source adds against `base`, by root-relative path; `undefined` when git cannot say. */
async function addedBy(budget: Budget, check: Check, top: string, source: Source, base: string, exists: (path: string) => Promise<boolean>): Promise<Added | undefined> {
	const added: Added = new Map();
	const cached = source.kind === "index" ? ["--cached"] : [];
	const pathspecs = source.kind === "worktree" ? source.pathspecs : [];
	// NUL-separated names cannot be confused by spaces, quotes, tabs or non-ASCII; each file is then diffed by its exact path.
	const names = await budget.git(check.directory, [...DIFF, "--name-only", "-z", CANDIDATE, ...cached, base, "--", ...pathspecs]);
	if (names === undefined) return undefined;
	for (const path of nulList(names).slice(0, MAX_FILES)) {
		const diff = await budget.git(top, ["--literal-pathspecs", ...DIFF, "-U0", ...cached, base, "--", path]);
		if (diff === undefined) return undefined;
		const lines = addedMarkerLines(diff);
		if (lines.length) added.set(path, lines);
	}
	if (source.kind === "worktree" && source.untracked) {
		const others = await budget.git(check.directory, ["ls-files", "-z", "--full-name", "--others", ...(source.force ? [] : ["--exclude-standard"]), "--", ...pathspecs]);
		if (others === undefined) return undefined;
		for (const path of nulList(others).slice(0, MAX_FILES)) {
			if (await exists(path)) continue;
			const lines = await untrackedLines(top, path).catch(() => []);
			if (lines.length) added.set(path, lines);
		}
	}
	return added;
}

/** Root-relative paths a staging covers: its tracked matches and, when it adds untracked files, those too. */
async function covered(budget: Budget, check: Check, staging: Staging): Promise<Set<string> | "all" | undefined> {
	if (!staging.pathspecs.length) return staging.tracked ? "all" : new Set();
	const tracked = await budget.git(check.directory, ["ls-files", "-z", "--full-name", "--", ...staging.pathspecs]);
	return tracked === undefined ? undefined : new Set(nulList(tracked));
}

async function verified(budget: Budget, top: string, ref: string): Promise<string | undefined> {
	return (await budget.git(top, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]))?.trim() || undefined;
}

async function findingsFor(budget: Budget, check: Check): Promise<string[] | undefined> {
	const top = (await budget.git(check.directory, ["rev-parse", "--show-toplevel"]))?.trim();
	if (!top) return undefined;
	const head = await verified(budget, top, "HEAD") ?? EMPTY_TREE;
	let second: string | undefined;
	for (const ref of SECOND_SIDES) if ((second = await verified(budget, top, ref))) break;
	const sources: Source[] = [...check.sources];
	let excluded: Set<string> | "all" = new Set();
	for (const staging of check.staged) {
		if (!staging.tracked) continue;
		sources.push({ kind: "worktree", pathspecs: staging.pathspecs, untracked: staging.untracked, force: staging.force });
		const cover = await covered(budget, check, staging);
		if (cover === undefined) return undefined;
		if (cover === "all" || excluded === "all") excluded = "all";
		else for (const path of cover) excluded.add(path);
	}
	const findings = new Set<string>();
	for (const source of sources) {
		// A staged path that `add` replaces is recorded from the worktree, not from the current index.
		const replaced = source.kind === "index" ? excluded : new Set<string>();
		if (replaced === "all") continue;
		const exists = async (path: string) => second !== undefined && (await budget.git(top, ["cat-file", "-e", `${second}:${path}`])) !== undefined;
		const added = await addedBy(budget, check, top, source, head, async () => false); // untracked: absent from HEAD
		if (!added) return undefined;
		for (const path of replaced) added.delete(path);
		if (!added.size) continue;
		const sizes = await markerSizes(budget, top, [...added.keys()]);
		if (!sizes) return undefined;
		let found = conflictMarkerFindings(added, sizes);
		if (found.length && second !== undefined) {
			// During a merge or pick, content that came whole from the other side is not this commit's addition.
			const other = await addedBy(budget, check, top, source, second, exists);
			if (!other) return undefined;
			const keys = new Set([...other].flatMap(([path, lines]) => lines.map(({ line }) => `${path}:${line}`)));
			found = found.filter(finding => keys.has(finding));
		}
		for (const finding of found) findings.add(finding);
	}
	return [...findings];
}

const printable = (finding: string) => finding.replace(/[\u0000-\u001f\u007f]/g, char => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);

/** Refuse a commit that adds conflict markers; undefined means "let it run" (including every guard error). */
export async function checkDeliveryConflictMarkers(cwd: string, command: string, signal?: AbortSignal): Promise<Denial | undefined> {
	try {
		const budget = new Budget(signal);
		for (const check of conflictMarkerChecks(command, cwd)) {
			const findings = await findingsFor(budget, check);
			if (findings === undefined) return undefined;
			if (!findings.length) continue;
			const shown = findings.slice(0, SHOWN).map(printable).join(", ") + (findings.length > SHOWN ? `, and ${findings.length - SHOWN} more` : "");
			return { block: true, reason: `Conflict markers: this commit would add unresolved conflict markers (<<<<<<< ... >>>>>>>) at ${shown}. This command was not run. Resolve the markers and stage the result, then retry. A file that holds markers on purpose is exempted by a \`conflict-marker-size\` attribute in \`.gitattributes\`.` };
		}
	} catch { /* fail open */ }
	return undefined;
}
