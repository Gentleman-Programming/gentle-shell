import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { applyToolOverlay, loadToolOverlays } from "../lib/agent-tool-overlay.ts";
import { discoverAgents } from "../lib/agents-config.ts";

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "gentle-tool-overlay-"));
}

test("loadToolOverlays merges sources with higher precedence winning per tool", (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const configHome = join(root, "config");
	const cwd = join(root, "project");
	writeJson(join(configHome, "agent-overlays.d", "10-extension.json"), { worker: { add: ["ext"] } });
	writeJson(join(configHome, "tools.json"), { worker: { add: ["a", "global-add"], remove: ["b"] } });
	writeJson(join(cwd, ".pi", "gentle-ai", "tools.json"), { worker: { remove: ["a"], add: ["b", "project-add"] } });

	const result = loadToolOverlays(configHome, cwd);
	assert.deepEqual(result.notices, []);
	const worker = result.entries.worker;
	assert.ok(worker, "worker must have a merged overlay entry");
	assert.deepEqual([...worker.add].sort(), ["b", "ext", "global-add", "project-add"]);
	assert.deepEqual([...worker.remove], ["a"]);
	// global add + project remove => removed; global remove + project add => re-added.
	assert.equal(worker.add.includes("a"), false);
	assert.equal(worker.remove.includes("a"), true);
	assert.equal(worker.add.includes("b"), true);
	assert.equal(worker.remove.includes("b"), false);
});

test("loadToolOverlays ignores invalid JSON and invalid entries with notices while valid files still load", (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const configHome = join(root, "config");
	const cwd = join(root, "project");
	writeJson(join(configHome, "agent-overlays.d", "valid.json"), { worker: { add: ["ext"] } });
	writeFileSync(join(configHome, "agent-overlays.d", "broken.json"), "{ not json");
	writeFileSync(join(configHome, "agent-overlays.d", "array.json"), "[1, 2, 3]");
	writeJson(join(configHome, "tools.json"), { worker: { add: ["global"] }, bad: "not-an-object", other: { add: "not-an-array" } });

	const result = loadToolOverlays(configHome, cwd);
	assert.deepEqual([...result.entries.worker.add].sort(), ["ext", "global"]);
	assert.ok(result.notices.includes(`ignored invalid tool overlay ${join(configHome, "agent-overlays.d", "broken.json")}`));
	assert.ok(result.notices.includes(`ignored invalid tool overlay ${join(configHome, "agent-overlays.d", "array.json")}`));
	assert.ok(result.notices.includes(`ignored invalid entry for "bad" in ${join(configHome, "tools.json")}`));
	assert.ok(result.notices.includes(`ignored invalid entry for "other" in ${join(configHome, "tools.json")}`));
});

test("applyToolOverlay appends, dedups, removes package tools, and ignores absent removals", () => {
	const tools = ["read", "grep", "bash"];
	const overlaid = applyToolOverlay(tools, { add: ["bash", "web_search"], remove: ["grep", "absent"] });
	assert.deepEqual(overlaid, ["read", "bash", "web_search"]);
	assert.deepEqual(tools, ["read", "grep", "bash"], "the input array must not be mutated");
});

test("applyToolOverlay with an undefined overlay returns the same array reference", () => {
	const tools = ["read", "grep"];
	assert.equal(applyToolOverlay(tools, undefined), tools);
});

test("discoverAgents applies the overlay and reports overlay keys naming no agent", (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "cwd");
	const agentHome = join(root, "agent");
	const configHome = join(root, "config");
	mkdirSync(join(agentHome, "agents"), { recursive: true });
	writeFileSync(join(agentHome, "agents", "worker.md"), "---\nname: worker\ntools:\n  - read\n  - grep\n---\nbody");
	writeJson(join(configHome, "tools.json"), {
		worker: { add: ["bash_background"], remove: ["grep"] },
		ghost: { add: ["read"] },
	});

	const { agents, errors, notices } = discoverAgents({ cwd, home: join(root, "home"), agentHome, configHome });
	assert.deepEqual(errors, []);
	const worker = agents.find((agent) => agent.name === "worker");
	assert.ok(worker, "worker must be discovered");
	assert.deepEqual(worker.tools, ["read", "bash_background"]);
	assert.ok(notices.includes('overlay names unknown agent "ghost"'));
});
