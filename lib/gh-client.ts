// Gentle Shell GitHub: which repository this session is in, and the open work on
// it. `gh` is the source of truth, so it is also the credential owner: nothing
// here reads a token, and nothing here writes to GitHub.

export interface GithubRepo {
	host: string;
	owner: string;
	name: string;
}

export interface PullRequestSummary {
	number: number;
	title: string;
	author: string;
	isDraft: boolean;
	headRefName: string;
	updatedAt: string;
	labels: string[];
	commentCount: number;
	reviewDecision: string | null;
}

export interface IssueSummary {
	number: number;
	title: string;
	author: string;
	labels: string[];
	commentCount: number;
	updatedAt: string;
}

export const GITHUB_HOST = "github.com";
// One screenful of open work: the pane is a digest, and `--limit` is what keeps
// a busy repository from turning a keystroke into a thousand-row list.
export const GITHUB_LIST_LIMIT = 30;
export const UNKNOWN_AUTHOR = "ghost";

const PR_FIELDS = [
	"number",
	"title",
	"author",
	"isDraft",
	"headRefName",
	"updatedAt",
	"labels",
	"comments",
	"reviewDecision",
] as const;
const ISSUE_FIELDS = ["number", "title", "author", "labels", "comments", "updatedAt"] as const;

const GIT_SUFFIX = /\.git$/;
const URL_REMOTE = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?(?<host>[^:/\s]+)(?::\d+)?\/(?<path>.*)$/i;
const SCP_REMOTE = /^(?<user>[^@/\s]+)@(?<host>[^:/\s]+):(?<path>.+)$/;

export class GhParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GhParseError";
	}
}

export function repoFullName(repo: GithubRepo): string {
	return `${repo.owner}/${repo.name}`;
}

/** Resolves a `git remote` URL to a repository, or null when it is not one. */
export function parseRepoFromRemote(remote: string): GithubRepo | null {
	const trimmed = remote.trim();
	if (!trimmed) return null;

	const url = URL_REMOTE.exec(trimmed);
	const scp = url ? null : SCP_REMOTE.exec(trimmed);
	const groups = url?.groups ?? scp?.groups;
	if (!groups?.host || !groups.path) return null;

	const segments = groups.path.split("/").filter((segment) => segment.length > 0);
	if (segments.length < 2) return null;
	const name = segments[segments.length - 1].replace(GIT_SUFFIX, "");
	const owner = segments[segments.length - 2];
	if (!owner || !name) return null;

	return { host: groups.host, owner, name };
}

export function prListArgs(repo: GithubRepo): string[] {
	return ["pr", "list", "--repo", repoFullName(repo), "--state", "open", "--limit", String(GITHUB_LIST_LIMIT), "--json", PR_FIELDS.join(",")];
}

export function issueListArgs(repo: GithubRepo): string[] {
	return ["issue", "list", "--repo", repoFullName(repo), "--state", "open", "--limit", String(GITHUB_LIST_LIMIT), "--json", ISSUE_FIELDS.join(",")];
}

export function parsePullRequests(json: string): PullRequestSummary[] {
	return parseArray(json, "pull requests").map((entry) => {
		const record = asRecord(entry, "pull requests");
		return {
			number: numberField(record, "pull requests"),
			title: stringField(record, "title") ?? "",
			author: authorOf(record),
			isDraft: record.isDraft === true,
			headRefName: stringField(record, "headRefName") ?? "",
			updatedAt: stringField(record, "updatedAt") ?? "",
			labels: labelsOf(record),
			commentCount: commentCountOf(record),
			reviewDecision: stringField(record, "reviewDecision"),
		};
	});
}

export function parseIssues(json: string): IssueSummary[] {
	return parseArray(json, "issues").map((entry) => {
		const record = asRecord(entry, "issues");
		return {
			number: numberField(record, "issues"),
			title: stringField(record, "title") ?? "",
			author: authorOf(record),
			labels: labelsOf(record),
			commentCount: commentCountOf(record),
			updatedAt: stringField(record, "updatedAt") ?? "",
		};
	});
}

function parseArray(json: string, what: string): unknown[] {
	const trimmed = json.trim();
	if (!trimmed) throw new GhParseError(`${what}: gh returned no output`);
	let value: unknown;
	try {
		value = JSON.parse(trimmed);
	} catch {
		throw new GhParseError(`${what}: gh returned malformed JSON`);
	}
	if (!Array.isArray(value)) throw new GhParseError(`${what}: gh returned ${typeof value}, not a JSON array`);
	return value;
}

function asRecord(entry: unknown, what: string): Record<string, unknown> {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		throw new GhParseError(`${what}: gh returned an entry that is not an object`);
	}
	return entry as Record<string, unknown>;
}

function numberField(record: Record<string, unknown>, what: string): number {
	const value = record.number;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new GhParseError(`${what}: gh returned an entry without a number`);
	}
	return value;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" ? value : null;
}

// `gh` serializes an absent author as null, and a deleted account really is a
// nameless author; showing "ghost" is better than dropping the row.
function authorOf(record: Record<string, unknown>): string {
	const author = record.author;
	if (typeof author !== "object" || author === null) return UNKNOWN_AUTHOR;
	const login = (author as Record<string, unknown>).login;
	return typeof login === "string" && login.length > 0 ? login : UNKNOWN_AUTHOR;
}

function labelsOf(record: Record<string, unknown>): string[] {
	const labels = record.labels;
	if (!Array.isArray(labels)) return [];
	const names: string[] = [];
	for (const label of labels) {
		if (typeof label !== "object" || label === null) continue;
		const name = (label as Record<string, unknown>).name;
		if (typeof name === "string" && name.length > 0) names.push(name);
	}
	return names;
}

function commentCountOf(record: Record<string, unknown>): number {
	const comments = record.comments;
	return Array.isArray(comments) ? comments.length : 0;
}
