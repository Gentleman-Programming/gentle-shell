import assert from "node:assert/strict";
import test from "node:test";
import {
	GITHUB_LIST_LIMIT,
	GhParseError,
	issueListArgs,
	parseIssues,
	parsePullRequests,
	parseRepoFromRemote,
	prListArgs,
	repoFullName,
} from "../lib/gh-client.ts";

// The GitHub pane reads open pull requests and issues through the `gh` CLI, so
// everything that decides what the pane shows is parsing, and parsing is where
// a remote form or a null field can quietly show the wrong repository.

test("parseRepoFromRemote resolves every remote form to the same repository", () => {
	const forms = [
		"git@github.com:Gentleman-Programming/gentle-shell.git",
		"git@github.com:Gentleman-Programming/gentle-shell",
		"ssh://git@github.com/Gentleman-Programming/gentle-shell.git",
		"https://github.com/Gentleman-Programming/gentle-shell.git",
		"https://github.com/Gentleman-Programming/gentle-shell",
		"https://github.com/Gentleman-Programming/gentle-shell/",
		"git+https://github.com/Gentleman-Programming/gentle-shell.git",
	];
	for (const form of forms) {
		assert.deepEqual(
			parseRepoFromRemote(form),
			{ host: "github.com", owner: "Gentleman-Programming", name: "gentle-shell" },
			`remote form not resolved: ${form}`,
		);
	}
});

test("parseRepoFromRemote keeps the host so a non-GitHub remote is not silently gh-read", () => {
	assert.deepEqual(parseRepoFromRemote("git@gitlab.com:acme/widget.git"), {
		host: "gitlab.com",
		owner: "acme",
		name: "widget",
	});
});

test("parseRepoFromRemote rejects what is not a repository remote", () => {
	for (const remote of ["", "   ", "not a url", "https://github.com/", "git@github.com:owner-only.git", "/Users/someone/local/path"]) {
		assert.equal(parseRepoFromRemote(remote), null, `should not resolve: ${JSON.stringify(remote)}`);
	}
});

test("repoFullName is the owner/name gh understands", () => {
	assert.equal(
		repoFullName({ host: "github.com", owner: "Gentleman-Programming", name: "gentle-shell" }),
		"Gentleman-Programming/gentle-shell",
	);
});

test("parsePullRequests maps the gh payload onto the pane model", () => {
	const json = JSON.stringify([
		{
			number: 2841,
			title: "docs: state that donations go through GitHub Sponsors",
			author: { login: "doblas" },
			isDraft: false,
			headRefName: "docs/donations",
			updatedAt: "2026-11-10T09:00:00Z",
			labels: [{ name: "documentation" }, { name: "good first issue" }],
			comments: [{ id: 1 }, { id: 2 }],
			reviewDecision: "APPROVED",
		},
	]);
	assert.deepEqual(parsePullRequests(json), [
		{
			number: 2841,
			title: "docs: state that donations go through GitHub Sponsors",
			author: "doblas",
			isDraft: false,
			headRefName: "docs/donations",
			updatedAt: "2026-11-10T09:00:00Z",
			labels: ["documentation", "good first issue"],
			commentCount: 2,
			reviewDecision: "APPROVED",
		},
	]);
});

test("parsePullRequests survives the null fields gh really returns", () => {
	const json = JSON.stringify([
		{ number: 7, title: "no author", author: null, labels: null, comments: null, reviewDecision: null },
	]);
	const [pull] = parsePullRequests(json);
	assert.equal(pull.author, "ghost");
	assert.deepEqual(pull.labels, []);
	assert.equal(pull.commentCount, 0);
	assert.equal(pull.isDraft, false);
	assert.equal(pull.reviewDecision, null);
});

test("parseIssues maps the gh payload and skips a label without a name", () => {
	const json = JSON.stringify([
		{
			number: 2801,
			title: "[Bug]: accepting an invitation answers the previous company",
			author: { login: "someone" },
			labels: [{ name: "bug" }, { nope: true }],
			comments: [{ id: 1 }],
			updatedAt: "2026-11-09T12:00:00Z",
		},
	]);
	assert.deepEqual(parseIssues(json), [
		{
			number: 2801,
			title: "[Bug]: accepting an invitation answers the previous company",
			author: "someone",
			labels: ["bug"],
			commentCount: 1,
			updatedAt: "2026-11-09T12:00:00Z",
		},
	]);
});

test("an empty list is empty, not an error", () => {
	assert.deepEqual(parsePullRequests("[]"), []);
	assert.deepEqual(parseIssues("[]"), []);
});

test("malformed gh output is a GhParseError, never a silent empty list", () => {
	for (const bad of ["", "null", "{}", "not json", "[{\"number\":", "[null]"]) {
		assert.throws(() => parsePullRequests(bad), GhParseError, `pull parse should reject: ${JSON.stringify(bad)}`);
		assert.throws(() => parseIssues(bad), GhParseError, `issue parse should reject: ${JSON.stringify(bad)}`);
	}
});

test("the list arguments ask gh for exactly what the pane renders", () => {
	const repo = { host: "github.com", owner: "Gentleman-Programming", name: "gentle-shell" };
	const prs = prListArgs(repo);
	assert.deepEqual(prs.slice(0, 2), ["pr", "list"]);
	assert.equal(prs[prs.indexOf("--repo") + 1], "Gentleman-Programming/gentle-shell");
	assert.equal(prs[prs.indexOf("--state") + 1], "open");
	assert.equal(prs[prs.indexOf("--limit") + 1], String(GITHUB_LIST_LIMIT));
	const prFields = prs[prs.indexOf("--json") + 1].split(",");
	for (const field of ["number", "title", "author", "isDraft", "headRefName", "updatedAt", "labels", "comments", "reviewDecision"]) {
		assert.ok(prFields.includes(field), `missing pull request field: ${field}`);
	}

	const issues = issueListArgs(repo);
	assert.deepEqual(issues.slice(0, 2), ["issue", "list"]);
	assert.equal(issues[issues.indexOf("--repo") + 1], "Gentleman-Programming/gentle-shell");
	assert.equal(issues[issues.indexOf("--state") + 1], "open");
	const issueFields = issues[issues.indexOf("--json") + 1].split(",");
	for (const field of ["number", "title", "author", "labels", "comments", "updatedAt"]) {
		assert.ok(issueFields.includes(field), `missing issue field: ${field}`);
	}
});
