import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { agentBody } from "../lib/agent-assets.ts";

const SCRIPT = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts", "update-agent-body-history.mjs");
const HISTORY = join("assets", "migrations", "agent-body-history.json");

const bodyHash = (content: string) => createHash("sha256").update(agentBody(content)).digest("hex");
const agent = (body: string) => `---\nname: a\ndescription: test agent\n---\n${body}\n`;

// A scratch git repository with its own copy of the script, so the script's
// root is the fixture and this repository's history is never read.
function withFixtureRepo(run: (root: string) => void) {
	const root = mkdtempSync(join(tmpdir(), "agent-body-history-"));
	try {
		mkdirSync(join(root, "scripts"));
		mkdirSync(join(root, "assets", "agents"), { recursive: true });
		mkdirSync(join(root, "assets", "migrations"), { recursive: true });
		copyFileSync(SCRIPT, join(root, "scripts", "update-agent-body-history.mjs"));
		git(root, "init", "-q");
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function git(root: string, ...args: string[]) {
	return execFileSync(
		"git",
		["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
		{ cwd: root, encoding: "utf8" },
	);
}

function commitAgent(root: string, file: string, content: string) {
	writeFileSync(join(root, "assets", "agents", file), content);
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", `update ${file}`);
}

function writeHistory(root: string, bodies: Record<string, string[]>) {
	writeFileSync(join(root, HISTORY), `${JSON.stringify({ schemaVersion: 1, bodies }, null, 2)}\n`);
}

function runScript(root: string) {
	const result = spawnSync(process.execPath, [join(root, "scripts", "update-agent-body-history.mjs")], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	return result.stdout;
}

const readHistory = (root: string) =>
	JSON.parse(readFileSync(join(root, HISTORY), "utf8")) as { schemaVersion: number; bodies: Record<string, string[]> };

test("a recorded body that git history no longer contains survives regeneration", () => {
	withFixtureRepo((root) => {
		// A body that shipped only on a branch later squash-merged: recorded,
		// but no commit reachable from HEAD carries it.
		const squashedAway = bodyHash(agent("Body from an unmerged branch commit."));
		const removedAgent = bodyHash(agent("Agent no longer packaged."));
		commitAgent(root, "a.md", agent("Shipped body."));
		const shipped = bodyHash(agent("Shipped body."));
		writeHistory(root, { "agents/a.md": [shipped, squashedAway].sort(), "agents/gone.md": [removedAgent] });

		const stdout = runScript(root);

		assert.deepEqual(readHistory(root), {
			schemaVersion: 1,
			bodies: { "agents/a.md": [shipped, squashedAway].sort(), "agents/gone.md": [removedAgent] },
		});
		assert.equal(
			stdout,
			"agent body history: 3 hashes for 2 agents (kept 3, added 0, kept although not in git history 2)\n",
		);
	});
});

test("a new agent body is added to the recorded ones", () => {
	withFixtureRepo((root) => {
		commitAgent(root, "a.md", agent("First body."));
		const first = bodyHash(agent("First body."));
		writeHistory(root, { "agents/a.md": [first] });
		// The new body is only in the working tree, as when a writer edits an
		// agent and regenerates before committing.
		writeFileSync(join(root, "assets", "agents", "a.md"), agent("Second body."));
		const second = bodyHash(agent("Second body."));

		const stdout = runScript(root);

		assert.deepEqual(readHistory(root).bodies, { "agents/a.md": [first, second].sort() });
		assert.equal(stdout, "agent body history: 2 hashes for 1 agents (kept 1, added 1, kept although not in git history 0)\n");
	});
});

test("regeneration is sorted and byte-identical when nothing changed", () => {
	withFixtureRepo((root) => {
		commitAgent(root, "b.md", agent("B one."));
		commitAgent(root, "a.md", agent("A one."));
		commitAgent(root, "b.md", agent("B two."));
		// No history file yet: the first run creates it.
		runScript(root);
		const first = readFileSync(join(root, HISTORY), "utf8");
		const parsed = readHistory(root);
		assert.deepEqual(Object.keys(parsed.bodies), ["agents/a.md", "agents/b.md"]);
		assert.deepEqual(parsed.bodies["agents/b.md"], [bodyHash(agent("B one.")), bodyHash(agent("B two."))].sort());
		assert.equal(first, `${JSON.stringify(parsed, null, 2)}\n`);

		const stdout = runScript(root);
		assert.equal(readFileSync(join(root, HISTORY), "utf8"), first);
		assert.equal(stdout, "agent body history: 3 hashes for 2 agents (kept 3, added 0, kept although not in git history 0)\n");
	});
});

test("an unreadable history file fails loudly and is left untouched", () => {
	withFixtureRepo((root) => {
		commitAgent(root, "a.md", agent("Body."));
		writeFileSync(join(root, HISTORY), "{ not json");

		const result = spawnSync(process.execPath, [join(root, "scripts", "update-agent-body-history.mjs")], {
			cwd: root,
			encoding: "utf8",
		});

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /agent-body-history\.json/);
		assert.equal(readFileSync(join(root, HISTORY), "utf8"), "{ not json");
	});
});
