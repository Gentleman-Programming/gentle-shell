import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatImportPiReport, importPi, nodeImportPiFs } from "../lib/gentle-shell-import-pi.ts";

// `gentle-shell home import-pi` core: real temp directories, never the real
// ~/.pi or ~/.gentle-shell. Credential contents never appear in assertions.

const AUTH = JSON.stringify({ anthropic: { type: "oauth", refresh: "dummy-refresh", access: "dummy-access" } });
const MCP = JSON.stringify({ mcpServers: { demo: { command: "demo" } } }, null, 2);

function fixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "gentle-shell-import-pi-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const source = join(root, "pi-agent");
	const target = join(root, "gentle-agent");
	mkdirSync(source, { recursive: true });
	mkdirSync(target, { recursive: true });
	return { root, source, target };
}

function seedSource(source: string) {
	writeFileSync(join(source, "auth.json"), AUTH, { mode: 0o644 });
	chmodSync(join(source, "auth.json"), 0o644);
	writeFileSync(join(source, "mcp.json"), MCP);
	chmodSync(join(source, "mcp.json"), 0o640);
	writeFileSync(join(source, "settings.json"), `${JSON.stringify({
		defaultProvider: "anthropic",
		defaultModel: "claude-opus-5-5",
		defaultThinkingLevel: "high",
		packages: ["npm:foreign"],
		extensions: ["./x.ts"],
		theme: "dark",
		npmCommand: ["npm"],
	}, null, 2)}\n`);
	writeFileSync(join(source, "mcp-cache.json"), "{}");
	writeFileSync(join(source, "mcp-npx-cache.json"), "{}");
	writeFileSync(join(source, "AGENTS.md"), "# agents\n");
	mkdirSync(join(source, "sessions"));
}

function snapshot(dir: string) {
	return Object.fromEntries(readdirSync(dir).sort().map((name) => {
		const stat = statSync(join(dir, name));
		const hash = stat.isFile() ? createHash("sha256").update(readFileSync(join(dir, name))).digest("hex") : "dir";
		return [name, { hash, mode: stat.mode, mtimeMs: stat.mtimeMs }];
	}));
}

function statusOf(result: ReturnType<typeof importPi>, item: string) {
	return result.items.find((entry) => entry.item === item)?.status;
}

const modeOf = (path: string) => statSync(path).mode & 0o777;

test("copies auth.json (0600) and mcp.json (source mode) only when absent in the target", (t) => {
	const f = fixture(t);
	seedSource(f.source);
	const result = importPi({ source: f.source, target: f.target, dryRun: false });
	assert.equal(result.failed, false);
	assert.equal(statusOf(result, "auth.json"), "copied");
	assert.equal(statusOf(result, "mcp.json"), "copied");
	assert.ok(readFileSync(join(f.target, "auth.json"), "utf8") === AUTH, "auth.json bytes copied verbatim");
	assert.ok(readFileSync(join(f.target, "mcp.json"), "utf8") === MCP);
	if (process.platform !== "win32") {
		assert.equal(modeOf(join(f.target, "auth.json")), 0o600);
		assert.equal(modeOf(join(f.target, "mcp.json")), 0o640);
	}
});

test("never overwrites a target file that already exists and is idempotent", (t) => {
	const f = fixture(t);
	seedSource(f.source);
	writeFileSync(join(f.target, "auth.json"), "{\"mine\":true}");
	const first = importPi({ source: f.source, target: f.target, dryRun: false });
	assert.equal(statusOf(first, "auth.json"), "present");
	assert.ok(readFileSync(join(f.target, "auth.json"), "utf8") === "{\"mine\":true}", "existing target auth.json kept");
	const before = snapshot(f.target);
	const second = importPi({ source: f.source, target: f.target, dryRun: false });
	assert.equal(second.failed, false);
	assert.ok(second.items.every((entry) => entry.status !== "copied"), "a second run copies nothing");
	assert.deepEqual(snapshot(f.target), before);
});

test("never modifies the source: content, mode and mtime stay the same", (t) => {
	const f = fixture(t);
	seedSource(f.source);
	const before = snapshot(f.source);
	importPi({ source: f.source, target: f.target, dryRun: false });
	assert.deepEqual(snapshot(f.source), before);
});

test("never copies caches, AGENTS.md, sessions or any other file", (t) => {
	const f = fixture(t);
	seedSource(f.source);
	importPi({ source: f.source, target: f.target, dryRun: false });
	assert.deepEqual(readdirSync(f.target).sort(), ["auth.json", "mcp.json", "settings.json"]);
});

test("missing source files are reported as not found, not errors", (t) => {
	const f = fixture(t);
	const result = importPi({ source: f.source, target: f.target, dryRun: false });
	assert.equal(result.failed, false);
	assert.equal(statusOf(result, "auth.json"), "not found");
	assert.equal(statusOf(result, "mcp.json"), "not found");
	assert.equal(statusOf(result, "settings.json"), "not found");
	assert.deepEqual(readdirSync(f.target), []);
});

test("skips a symlinked or non-regular source file", { skip: process.platform === "win32" }, (t) => {
	const f = fixture(t);
	writeFileSync(join(f.root, "elsewhere.json"), AUTH);
	symlinkSync(join(f.root, "elsewhere.json"), join(f.source, "auth.json"));
	mkdirSync(join(f.source, "mcp.json"));
	const result = importPi({ source: f.source, target: f.target, dryRun: false });
	assert.equal(statusOf(result, "auth.json"), "skipped");
	assert.equal(statusOf(result, "mcp.json"), "skipped");
	assert.equal(existsSync(join(f.target, "auth.json")), false);
	assert.equal(existsSync(join(f.target, "mcp.json")), false);
});

test("settings: copies only the default provider/model/thinking keys absent in the target, preserving every target key and order", (t) => {
	const f = fixture(t);
	seedSource(f.source);
	writeFileSync(join(f.target, "settings.json"), `${JSON.stringify({ tuiMode: "fullscreen", theme: "Gentleman-Cute", defaultModel: "kept-model", packages: ["npm:own"] }, null, 2)}\n`);
	const result = importPi({ source: f.source, target: f.target, dryRun: false });
	assert.equal(result.failed, false);
	assert.equal(statusOf(result, "settings.json defaultProvider"), "copied");
	assert.equal(statusOf(result, "settings.json defaultModel"), "present");
	assert.equal(statusOf(result, "settings.json defaultThinkingLevel"), "copied");
	const text = readFileSync(join(f.target, "settings.json"), "utf8");
	assert.equal(text, `${JSON.stringify({
		tuiMode: "fullscreen", theme: "Gentleman-Cute", defaultModel: "kept-model", packages: ["npm:own"],
		defaultProvider: "anthropic", defaultThinkingLevel: "high",
	}, null, 2)}\n`);
});

test("settings: the target keeps its own indentation and trailing-newline style", (t) => {
	const f = fixture(t);
	seedSource(f.source);
	writeFileSync(join(f.target, "settings.json"), `{\n\t"tuiMode": "fullscreen",\n\t"zeta": 1\n}`);
	importPi({ source: f.source, target: f.target, dryRun: false });
	assert.equal(readFileSync(join(f.target, "settings.json"), "utf8"), JSON.stringify({
		tuiMode: "fullscreen", zeta: 1, defaultProvider: "anthropic", defaultModel: "claude-opus-5-5", defaultThinkingLevel: "high",
	}, null, "\t"));
});

test("settings: an unreadable settings.json is reported per item while the other items still run", (t) => {
	if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("needs POSIX permissions as a non-root user");
	const f = fixture(t);
	seedSource(f.source);
	const settings = join(f.target, "settings.json");
	writeFileSync(settings, "{}\n");
	chmodSync(settings, 0o000);
	try {
		const result = importPi({ source: f.source, target: f.target, dryRun: false });
		assert.equal(statusOf(result, "auth.json"), "copied");
		assert.equal(statusOf(result, "settings.json"), "failed");
		assert.equal(result.failed, true);
		assert.match(formatImportPiReport(result, { source: f.source, target: f.target, dryRun: false }).join("\n"), /settings\.json: failed/);
	} finally {
		chmodSync(settings, 0o600);
	}
});

test("a destination that cannot be classified is one failed item while the other items still run", (t) => {
	const f = fixture(t);
	seedSource(f.source);
	const blocked = join(f.target, "auth.json");
	const fs = { ...nodeImportPiFs, kind: (path: string) => {
		if (path === blocked) throw Object.assign(new Error(`ENOTDIR: not a directory, lstat '${path}'`), { code: "ENOTDIR" });
		return nodeImportPiFs.kind(path);
	} };
	for (const dryRun of [true, false]) {
		const result = importPi({ source: f.source, target: f.target, dryRun, fs });
		assert.equal(statusOf(result, "auth.json"), "failed", `dryRun=${dryRun}`);
		assert.equal(statusOf(result, "mcp.json"), dryRun ? "would copy" : "copied");
		assert.equal(result.failed, true);
	}
});

test("settings: a missing target settings.json gets only the allowlisted keys", (t) => {
	const f = fixture(t);
	seedSource(f.source);
	importPi({ source: f.source, target: f.target, dryRun: false });
	assert.deepEqual(JSON.parse(readFileSync(join(f.target, "settings.json"), "utf8")), {
		defaultProvider: "anthropic", defaultModel: "claude-opus-5-5", defaultThinkingLevel: "high",
	});
});

test("settings: nothing to add leaves the target settings.json untouched", (t) => {
	const f = fixture(t);
	writeFileSync(join(f.source, "settings.json"), JSON.stringify({ packages: ["npm:x"] }));
	writeFileSync(join(f.target, "settings.json"), "{\"tuiMode\":\"fullscreen\"}");
	const before = snapshot(f.target);
	importPi({ source: f.source, target: f.target, dryRun: false });
	assert.deepEqual(snapshot(f.target), before);
});

test("settings: malformed source or target JSON is reported and nothing is written", (t) => {
	const f = fixture(t);
	writeFileSync(join(f.source, "settings.json"), "{ not json");
	const badSource = importPi({ source: f.source, target: f.target, dryRun: false });
	assert.equal(statusOf(badSource, "settings.json"), "skipped");
	assert.equal(badSource.failed, false);
	assert.equal(existsSync(join(f.target, "settings.json")), false);

	writeFileSync(join(f.source, "settings.json"), JSON.stringify({ defaultProvider: "anthropic" }));
	writeFileSync(join(f.target, "settings.json"), "[1, 2]");
	const badTarget = importPi({ source: f.source, target: f.target, dryRun: false });
	assert.equal(statusOf(badTarget, "settings.json"), "skipped");
	assert.equal(readFileSync(join(f.target, "settings.json"), "utf8"), "[1, 2]");
});

test("dry run reports the same plan and writes nothing, not even the target directory", (t) => {
	const f = fixture(t);
	seedSource(f.source);
	const target = join(f.root, "not-created", "agent");
	const result = importPi({ source: f.source, target, dryRun: true });
	assert.equal(result.failed, false);
	assert.equal(statusOf(result, "auth.json"), "would copy");
	assert.equal(statusOf(result, "settings.json defaultProvider"), "would copy");
	assert.equal(existsSync(join(f.root, "not-created")), false);
});

test("a write failure is reported per item and keeps what was already copied", { skip: process.platform === "win32" }, (t) => {
	const f = fixture(t);
	seedSource(f.source);
	// A read-only target makes every write fail; nothing is half-written.
	writeFileSync(join(f.target, "settings.json"), "{}");
	chmodSync(f.target, 0o500);
	let result;
	try {
		result = importPi({ source: f.source, target: f.target, dryRun: false });
	} finally {
		chmodSync(f.target, 0o700); // before the fixture's own cleanup
	}
	assert.equal(result.failed, true);
	assert.equal(statusOf(result, "auth.json"), "failed");
	assert.equal(statusOf(result, "settings.json defaultProvider"), "failed");
});

test("the report has one line per item and a summary, and never prints credential contents", (t) => {
	const f = fixture(t);
	seedSource(f.source);
	const result = importPi({ source: f.source, target: f.target, dryRun: false });
	const lines = formatImportPiReport(result, { source: f.source, target: f.target, dryRun: false });
	const text = lines.join("\n");
	assert.match(text, /auth\.json: copied \(0600\)/);
	assert.match(text, /mcp\.json: copied/);
	assert.match(text, /settings\.json defaultModel: copied/);
	assert.match(text, /Imported 5 item\(s\)/);
	assert.doesNotMatch(text, /dummy-refresh|dummy-access/);

	const again = formatImportPiReport(importPi({ source: f.source, target: f.target, dryRun: true }), { source: f.source, target: f.target, dryRun: true });
	assert.match(again.join("\n"), /auth\.json: already present, kept/);
	assert.match(again.join("\n"), /Dry run/);
	assert.match(again.join("\n"), /Nothing to import/);
});
