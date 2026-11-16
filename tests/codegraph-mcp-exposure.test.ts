import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	atomicWriteFile,
	codegraphMcpPaths,
	ensureDirectExposure,
	ensureDirectExposureInAgentHomes,
	type AtomicFileIo,
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

/** In-memory AtomicFileIo over file and mode maps, with optional failure injection at one step. */
function atomicHarness(
	files: Record<string, string>,
	modes: Record<string, number> = {},
	fail: { step: "write" | "rename" } | undefined = undefined,
): AtomicFileIo {
	return {
		resolve: (path) => path,
		modeOf: (path) => modes[path],
		writeExclusive: (path, text, mode) => {
			if (fail?.step === "write") {
				files[path] = text.slice(0, 8); // the temporary file is left partially written
				throw new Error("ENOSPC: no space left on device");
			}
			files[path] = text;
			modes[path] = mode;
		},
		rename: (from, to) => {
			if (fail?.step === "rename") throw new Error("EPERM: operation not permitted");
			files[to] = files[from]!;
			modes[to] = modes[from] ?? 0o644;
			delete files[from];
			delete modes[from];
		},
		remove: (path) => {
			delete files[path];
			delete modes[path];
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
	assert.deepEqual(codegraphMcpPaths("/h"), [
		join("/h", ".pi", "agent", "mcp.json"),
		join("/h", ".gentle-shell", "agent", "mcp.json"),
	]);
});

test("ensureDirectExposureInAgentHomes: patches each agent home independently", () => {
	const files: Record<string, string> = {
		[join("/h", ".pi", "agent", "mcp.json")]: WITH_CODEGRAPH,
		[join("/h", ".gentle-shell", "agent", "mcp.json")]: WITH_CODEGRAPH,
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

test("ensureDirectExposureInAgentHomes: an I/O failure on the first home does not stop the second home's update", () => {
	const piPath = join("/h", ".pi", "agent", "mcp.json");
	const shellPath = join("/h", ".gentle-shell", "agent", "mcp.json");
	const files: Record<string, string> = { [piPath]: WITH_CODEGRAPH, [shellPath]: WITH_CODEGRAPH };
	const io: EnsureExposureIo = {
		read: (path) => (path in files ? files[path] : undefined),
		write: (path, text) => {
			if (path === piPath) throw new Error("EACCES: permission denied, read-only config");
			files[path] = text;
		},
	};
	const results = ensureDirectExposureInAgentHomes("/h", io);
	assert.deepEqual(
		results.map((result) => result.outcome),
		["error", "added"],
		"the failed home is reported and the map continues",
	);
	assert.equal(files[piPath], WITH_CODEGRAPH, "the failed home's file is left exactly as it was");
	const written = JSON.parse(files[shellPath]!) as { mcpServers: { codegraph: { exposure: string } } };
	assert.equal(written.mcpServers.codegraph.exposure, "direct", "the second home still receives its update");
});

test("atomicWriteFile: a replacement that fails part-way leaves the original file intact", () => {
	const dest = "/home/.pi/agent/mcp.json";
	for (const step of ["write", "rename"] as const) {
		const files: Record<string, string> = { [dest]: WITH_CODEGRAPH };
		assert.throws(() => atomicWriteFile(dest, "{}\n", atomicHarness(files, {}, { step })), /ENOSPC|EPERM/, `failure at ${step}`);
		assert.equal(files[dest], WITH_CODEGRAPH, `the original survives a failed ${step}`);
		assert.deepEqual(Object.keys(files), [dest], `no temporary file is left behind after a failed ${step}`);
	}
});

test("atomicWriteFile: the default io lands the whole text, preserves permissions, and leaves no temporary file", () => {
	const dir = mkdtempSync(join(tmpdir(), "codegraph-mcp-exposure-"));
	try {
		const dest = join(dir, "mcp.json");
		writeFileSync(dest, WITH_CODEGRAPH, "utf8");
		chmodSync(dest, 0o600);
		atomicWriteFile(dest, "{}\n");
		assert.equal(readFileSync(dest, "utf8"), "{}\n", "the new text replaces the old");
		if (process.platform !== "win32") assert.equal(statSync(dest).mode & 0o777, 0o600, "the original permission bits are preserved");
		const fresh = join(dir, "fresh.json");
		atomicWriteFile(fresh, "{}\n");
		assert.equal(readFileSync(fresh, "utf8"), "{}\n", "a destination that does not exist yet is created");
		assert.deepEqual(readdirSync(dir).sort(), ["fresh.json", "mcp.json"], "no temporary file survives a successful replacement");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("atomicWriteFile: a symlinked config keeps receiving updates through the file it points at", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "codegraph-mcp-exposure-"));
	try {
		const real = join(dir, "real-mcp.json");
		writeFileSync(real, WITH_CODEGRAPH, "utf8");
		const link = join(dir, "linked-mcp.json");
		try {
			symlinkSync(real, link);
		} catch {
			t.skip("symlinks are unavailable on this platform");
			return;
		}
		atomicWriteFile(link, "{}\n");
		assert.equal(readFileSync(real, "utf8"), "{}\n", "the update lands on the link's target");
		assert.ok(lstatSync(link).isSymbolicLink(), "the link itself is preserved");
		assert.deepEqual(readdirSync(dir).sort(), ["linked-mcp.json", "real-mcp.json"], "no temporary file is left behind");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
