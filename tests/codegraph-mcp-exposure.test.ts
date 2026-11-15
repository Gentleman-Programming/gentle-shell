import assert from "node:assert/strict";
import test from "node:test";
import {
	codegraphMcpPaths,
	ensureDirectExposure,
	ensureDirectExposureInAgentHomes,
	type EnsureExposureIo,
} from "../lib/codegraph-mcp-exposure.ts";

/** In-memory io: the config files a test starts with, and every write it saw. */
function harness(files: Record<string, string>): { io: EnsureExposureIo; files: Record<string, string>; writes: Map<string, string> } {
	const writes = new Map<string, string>();
	return {
		files,
		writes,
		io: {
			read: (path) => (path in files ? files[path] : undefined),
			write: (path, text) => {
				writes.set(path, text);
				files[path] = text;
			},
		},
	};
}

const WITH_CODEGRAPH = JSON.stringify(
	{ mcpServers: { codegraph: { command: "codegraph", args: ["serve", "--mcp"] }, context7: { command: "npx" } } },
	null,
	2,
);

test("ensureDirectExposure: adds exposure direct to an existing codegraph entry when the field is absent", () => {
	const { io, writes } = harness({ "/home/.pi/agent/mcp.json": WITH_CODEGRAPH });
	const result = ensureDirectExposure("/home/.pi/agent/mcp.json", io);
	assert.equal(result.outcome, "added");
	const path = "/home/.pi/agent/mcp.json";
	const text = writes.get(path);
	assert.ok(text !== undefined, "the config file is rewritten once");
	const written = JSON.parse(text!) as {
		mcpServers: { codegraph: { command: string; args: string[]; exposure: string }; context7: { command: string } };
	};
	assert.equal(written.mcpServers.codegraph.exposure, "direct");
	assert.equal(written.mcpServers.codegraph.command, "codegraph");
	assert.deepEqual(written.mcpServers.codegraph.args, ["serve", "--mcp"], "the entry's own keys survive");
	assert.deepEqual(written.mcpServers.context7, { command: "npx" }, "sibling servers are untouched");
	assert.ok(text!.endsWith("}\n"), "the file is written with a trailing newline");
});

test("ensureDirectExposure: an entry that already has exposure is never touched, whatever its value", () => {
	for (const exposure of ["direct", "codemode", "deferred", "hidden"]) {
		const file = JSON.stringify({ mcpServers: { codegraph: { command: "codegraph", exposure } } }, null, 2);
		const { io, writes } = harness({ "/f": file });
		assert.equal(ensureDirectExposure("/f", io).outcome, "present", `exposure ${exposure}`);
		assert.equal(writes.size, 0, `no write for exposure ${exposure}`);
	}
});

test("ensureDirectExposure: a missing file and unparseable or non-object documents are left alone", () => {
	const missing = harness({});
	assert.equal(ensureDirectExposure("/none", missing.io).outcome, "missing");
	assert.equal(missing.writes.size, 0);
	for (const bad of ["not json", '"a string"', "[1, 2]", "null"]) {
		const { io, writes } = harness({ "/f": bad });
		assert.equal(ensureDirectExposure("/f", io).outcome, "unparseable", bad);
		assert.equal(writes.size, 0, `no write for ${bad}`);
	}
});

test("ensureDirectExposure: without a codegraph entry nothing is created", () => {
	const files = [
		"{}",
		JSON.stringify({ mcpServers: {} }),
		JSON.stringify({ mcpServers: { context7: { command: "npx" } } }),
		JSON.stringify({ mcpServers: { codegraph: "not an object" } }),
		JSON.stringify({ other: 1 }),
	];
	for (const file of files) {
		const { io, writes } = harness({ "/f": file });
		assert.equal(ensureDirectExposure("/f", io).outcome, "no-server", file);
		assert.equal(writes.size, 0, `no write for ${file}`);
	}
});

test("codegraphMcpPaths: exactly the pi and gentle-shell agent mcp.json paths", () => {
	assert.deepEqual(codegraphMcpPaths("/h"), ["/h/.pi/agent/mcp.json", "/h/.gentle-shell/agent/mcp.json"]);
});

test("ensureDirectExposureInAgentHomes: patches each agent home independently", () => {
	const files: Record<string, string> = {
		"/h/.pi/agent/mcp.json": WITH_CODEGRAPH,
		"/h/.gentle-shell/agent/mcp.json": WITH_CODEGRAPH,
	};
	const { io, writes } = harness(files);
	const results = ensureDirectExposureInAgentHomes("/h", io);
	assert.deepEqual(results.map((result) => result.outcome), ["added", "added"]);
	assert.equal(writes.size, 2);
	for (const path of codegraphMcpPaths("/h")) {
		const written = JSON.parse(files[path]!) as { mcpServers: { codegraph: { exposure: string } } };
		assert.equal(written.mcpServers.codegraph.exposure, "direct", path);
	}
});
