import { isAbsolute, relative } from "node:path";
import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";

// Harness roadmap T5 (R1): a delivered test must pass in any clone. Blind review
// found tests that read a fixed commit from git history (a differential check
// leaked into the suite) and orchestrators that pointed TMPDIR into the
// repository. The prompt rule did not hold, so the runtime blocks the write.
// Deliberately narrow: git used inside a throwaway repository (`git init`,
// `git stash`, `HEAD:`) stays allowed; only a literal commit id is history the
// test cannot own. Content written through bash is not seen here.

const TEST_PATH_PATTERNS = [
	/(^|[\\/])(tests?|__tests__|spec)[\\/]/,
	/\.(test|spec)\.[cm]?[jt]sx?$/,
	/_test\.go$/,
	/(^|[\\/])test_[^\\/]*\.py$/,
];

const HISTORY_COMMAND = /\bgit\b[^\n]{0,40}?\b(show|checkout|diff|cat-file|archive)\b([^\n]{0,80})/g;
const COMMIT_ID = /\b[0-9a-f]{7,40}\b/g;
// `=` but not `==`/`===`: a comparison with the working directory is not an assignment.
const TMPDIR_ASSIGNMENT = /\bTMPDIR["']?\]?\s*(?::|=(?!=))\s*([^\n;,}]*)/g;
const WORKING_DIRECTORY = /\$PWD|\$\{PWD\}|\$\(pwd\)|process\.cwd\(\)|__dirname|import\.meta\.dirname|os\.getcwd\(\)/;
// A relative path resolves against the working directory too: `.tmp`, `./x`, `../x` or `tmp/x`, quoted or not.
// Absolute, `~`, `$` or `%` based values and a bare word (`scratch`, `os.tmpdir()`, a fixture value) stay allowed.
const RELATIVE_PATH = /^\s*["'`]?(?:\.{1,2}[\/\\\w-]|[\w.-]+[\/\\])/;

export function isTestFilePath(path: string): boolean {
	return TEST_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/** A literal commit id mixes digits and letters; all-letter or all-digit words are not treated as one. */
function isCommitId(token: string): boolean {
	return /[0-9]/.test(token) && /[a-f]/.test(token);
}

/** Why this test content cannot be delivered, or undefined when it can. */
export function deliveredTestViolation(content: string): string | undefined {
	for (const match of content.matchAll(HISTORY_COMMAND)) {
		const commit = [...match[2].matchAll(COMMIT_ID)].map((m) => m[0]).find(isCommitId);
		if (commit) return `reads git history at a fixed commit (\`git ${match[1]} ${commit}\`), which fails in another clone`;
	}
	for (const match of content.matchAll(TMPDIR_ASSIGNMENT)) {
		if (WORKING_DIRECTORY.test(match[1]) || RELATIVE_PATH.test(match[1])) return `points TMPDIR inside the working directory (\`TMPDIR${match[0].slice(6).trim()}\`), so test scratch enters the diff`;
	}
	return undefined;
}

function writtenText(toolName: string, input: Record<string, unknown>): string | undefined {
	if (toolName === "write") return typeof input.content === "string" ? input.content : undefined;
	const parts: string[] = [];
	if (typeof input.newText === "string") parts.push(input.newText);
	if (Array.isArray(input.edits)) {
		for (const edit of input.edits) {
			if (edit && typeof edit === "object" && typeof (edit as { newText?: unknown }).newText === "string") parts.push((edit as { newText: string }).newText);
		}
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

/** An absolute path inside the session cwd is judged by its repository-relative part. */
function judgedPath(path: string, cwd: string | undefined): string {
	if (!cwd || !isAbsolute(path)) return path;
	const inside = relative(cwd, path);
	return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : path;
}

/** tool_call guard for write and edit, shared by the parent session and every child. */
export function evaluateDeliveredTestTool(toolName: string, input: unknown, cwd?: string): ToolCallEventResult | undefined {
	if ((toolName !== "write" && toolName !== "edit") || !input || typeof input !== "object") return undefined;
	const record = input as Record<string, unknown>;
	if (typeof record.path !== "string" || !isTestFilePath(judgedPath(record.path, cwd))) return undefined;
	const text = writtenText(toolName, record);
	const violation = text === undefined ? undefined : deliveredTestViolation(text);
	if (!violation) return undefined;
	return {
		block: true,
		reason: `Gentle AI blocked this test write: ${record.path} ${violation}. Delivered tests must pass in any clone: build the previous behavior from a fixture instead of git history, and create scratch with mktemp outside the repository. Run differential checks against a scratch copy of the base and do not commit them as tests.`,
	};
}
