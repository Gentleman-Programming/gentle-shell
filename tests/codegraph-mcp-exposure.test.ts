import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import {
	acquireConfigLock,
	atomicWriteFile,
	codegraphMcpPaths,
	ensureDirectExposure,
	ensureDirectExposureInAgentHomes,
	fileIdentity,
	lockPathFor,
	releaseConfigLock,
	takeOverStaleConfigLock,
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

test("ensureDirectExposure: a concurrent writer between the read and the publish loses no update", () => {
	// The update re-reads the file before publishing, so a concurrent save wired into that re-read
	// is exactly a writer that modified mcp.json after the update read it and before it publishes.
	{
		// A sibling server saved concurrently survives the publish.
		const concurrent = JSON.stringify(
			{ mcpServers: { codegraph: { command: "codegraph", args: ["serve", "--mcp"] }, context7: { command: "npx" }, serena: { command: "uvx" } } },
			null,
			2,
		);
		const files: Record<string, string> = { "/f": WITH_CODEGRAPH };
		let reads = 0;
		const io: EnsureExposureIo = {
			read: (path) => {
				reads += 1;
				if (reads === 2) files["/f"] = concurrent; // the concurrent save lands mid-update
				return files[path];
			},
			write: (path, text) => {
				files[path] = text;
			},
		};
		assert.equal(ensureDirectExposure("/f", io).outcome, "added");
		const written = JSON.parse(files["/f"]!) as { mcpServers: { codegraph: { exposure: string }; serena: { command: string } } };
		assert.equal(written.mcpServers.serena.command, "uvx", "the concurrent sibling-server change is not discarded");
		assert.equal(written.mcpServers.codegraph.exposure, "direct", "the exposure update still lands on the newer content");
	}
	{
		// A concurrently set exposure value is never reverted to direct.
		const concurrent = JSON.stringify({ mcpServers: { codegraph: { command: "codegraph", exposure: "hidden" } } }, null, 2);
		const files: Record<string, string> = { "/f": WITH_CODEGRAPH };
		let reads = 0;
		let writes = 0;
		const io: EnsureExposureIo = {
			read: (path) => {
				reads += 1;
				if (reads === 2) files["/f"] = concurrent;
				return files[path];
			},
			write: (path, text) => {
				writes += 1;
				files[path] = text;
			},
		};
		assert.equal(ensureDirectExposure("/f", io).outcome, "present", "the restarted update sees the concurrently set field");
		assert.equal(writes, 0, "a newly set exposure value is never overwritten");
		const written = JSON.parse(files["/f"]!) as { mcpServers: { codegraph: { exposure: string } } };
		assert.equal(written.mcpServers.codegraph.exposure, "hidden", "the concurrent writer's value stays");
	}
	{
		// A writer that saves on every re-verify exhausts the bounded retries: nothing is written.
		const files: Record<string, string> = {};
		let version = 0;
		const latest = () => JSON.stringify({ mcpServers: { codegraph: { command: "codegraph" }, concurrentSave: version } });
		files["/f"] = latest();
		let writes = 0;
		const io: EnsureExposureIo = {
			read: (path) => {
				version += 1;
				files["/f"] = latest();
				return files[path];
			},
			write: (path, text) => {
				writes += 1;
				files[path] = text;
			},
		};
		assert.equal(ensureDirectExposure("/f", io).outcome, "conflict", "a file that keeps changing is left unwritten");
		assert.equal(writes, 0, "no publish ever clobbers the concurrent writer");
		const written = JSON.parse(files["/f"]!) as { mcpServers: { codegraph: { command: string }; concurrentSave: number } };
		assert.equal(written.mcpServers.concurrentSave, version, "the concurrent writer's last content stays");
		assert.equal("exposure" in written.mcpServers.codegraph, false, "a failed update invents no exposure field");
	}
});

test("codegraphMcpPaths: exactly the pi and gentle-shell agent mcp.json paths", () => {
	assert.deepEqual(codegraphMcpPaths("/h", {}), [
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
	const results = ensureDirectExposureInAgentHomes("/h", io, {});
	assert.deepEqual(results.map((result) => result.outcome), ["added", "added"]);
	assert.equal(writes.size, 2);
	for (const path of codegraphMcpPaths("/h", {})) {
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
	const results = ensureDirectExposureInAgentHomes("/h", io, {});
	assert.deepEqual(
		results.map((result) => result.outcome),
		["error", "added"],
		"the failed home is reported and the map continues",
	);
	assert.equal(files[piPath], WITH_CODEGRAPH, "the failed home's file is left exactly as it was");
	const written = JSON.parse(files[shellPath]!) as { mcpServers: { codegraph: { exposure: string } } };
	assert.equal(written.mcpServers.codegraph.exposure, "direct", "the second home still receives its update");
});

test("ensureDirectExposureInAgentHomes: a session with home overrides patches its active homes, never the default-home files", () => {
	// The overrides that move the directories a session loads mcp.json from — the same resolution
	// as resolveGentlePiAgentHome (lib/agent-home.ts) and isolatedDir (lib/gentle-shell-launcher.ts).
	const env = { GENTLE_PI_AGENT_HOME: "/custom/pi", GENTLE_SHELL_HOME: "/custom/shell" };
	assert.deepEqual(
		codegraphMcpPaths("/h", env),
		[join("/custom/pi", "mcp.json"), join("/custom/shell", "mcp.json")],
		"the targets follow the session's home overrides",
	);
	assert.deepEqual(
		codegraphMcpPaths("/h", { PI_CODING_AGENT_DIR: "/via/agent-dir" }),
		[join("/via/agent-dir", "mcp.json"), join("/h", ".gentle-shell", "agent", "mcp.json")],
		"PI_CODING_AGENT_DIR moves the pi home when GENTLE_PI_AGENT_HOME is unset",
	);
	assert.deepEqual(
		codegraphMcpPaths("/h", { GENTLE_PI_AGENT_HOME: "", PI_CODING_AGENT_DIR: "/via/agent-dir" }),
		[join("/via/agent-dir", "mcp.json"), join("/h", ".gentle-shell", "agent", "mcp.json")],
		"an empty GENTLE_PI_AGENT_HOME falls through like an unset one",
	);
	assert.deepEqual(
		codegraphMcpPaths("/h", {}),
		[join("/h", ".pi", "agent", "mcp.json"), join("/h", ".gentle-shell", "agent", "mcp.json")],
		"no override: the default homes stay the targets",
	);
	const overridden = [join("/custom/pi", "mcp.json"), join("/custom/shell", "mcp.json")];
	const defaults = [join("/h", ".pi", "agent", "mcp.json"), join("/h", ".gentle-shell", "agent", "mcp.json")];
	const files: Record<string, string> = {};
	for (const path of [...overridden, ...defaults]) files[path] = WITH_CODEGRAPH;
	const { io, writes } = harness(files);
	const results = ensureDirectExposureInAgentHomes("/h", io, env);
	assert.deepEqual(results.map((result) => result.outcome), ["added", "added"]);
	assert.deepEqual([...writes.keys()].sort(), [...overridden].sort(), "only the overridden homes are written");
	for (const path of overridden) {
		const patched = JSON.parse(files[path]!) as { mcpServers: { codegraph: { exposure: string } } };
		assert.equal(patched.mcpServers.codegraph.exposure, "direct", `the session's active file is patched: ${path}`);
	}
	for (const path of defaults) {
		assert.equal(files[path], WITH_CODEGRAPH, `an inactive default-home file is never touched: ${path}`);
	}
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

test("ensureDirectExposure: a config another writer has locked is never read or written", () => {
	const files: Record<string, string> = { "/f": WITH_CODEGRAPH };
	let reads = 0;
	let writes = 0;
	const io: EnsureExposureIo = {
		read: (path) => {
			reads += 1;
			return files[path];
		},
		write: (path, text) => {
			writes += 1;
			files[path] = text;
		},
		acquireLock: () => false,
		releaseLock: () => {
			throw new Error("releaseLock must not run without a successful acquire");
		},
	};
	assert.deepEqual(ensureDirectExposure("/f", io), { path: "/f", outcome: "busy" });
	assert.equal(reads, 0, "the lock is taken before anything is read");
	assert.equal(writes, 0, "a lock the update cannot take publishes nothing");
	assert.equal(files["/f"], WITH_CODEGRAPH, "the file is left exactly as it was");
});

test("ensureDirectExposure: a writer that saves a sibling between the final read and the replacement is serialized, not lost", () => {
	// The competing writer respects the same lock: it tries to save inside the update's
	// verify-to-replacement window (hooked at the write itself), is refused while the update
	// holds the lock, and saves once the holder releases - neither write is lost.
	const files: Record<string, string> = { "/f": WITH_CODEGRAPH };
	const held: string[] = [];
	const deferred: Array<() => void> = [];
	const competitorSave = () => {
		const doc = JSON.parse(files["/f"]!) as { mcpServers: { codegraph: object; serena?: { command: string } } };
		doc.mcpServers.serena = { command: "uvx" };
		files["/f"] = JSON.stringify(doc, null, 2);
	};
	const io: EnsureExposureIo = {
		read: (path) => files[path],
		write: (path, text) => {
			if (!io.acquireLock(path)) deferred.push(competitorSave);
			files[path] = text;
		},
		acquireLock: (path) => {
			if (held.includes(path)) return false;
			held.push(path);
			return true;
		},
		releaseLock: (path) => {
			const at = held.indexOf(path);
			if (at >= 0) held.splice(at, 1);
		},
	};
	assert.equal(ensureDirectExposure("/f", io).outcome, "added");
	assert.equal(deferred.length, 1, "the mid-window save was refused while the lock was held");
	for (const save of deferred) save();
	const written = JSON.parse(files["/f"]!) as { mcpServers: { codegraph: { exposure: string }; serena: { command: string } } };
	assert.equal(written.mcpServers.codegraph.exposure, "direct", "the holder's update landed");
	assert.equal(written.mcpServers.serena.command, "uvx", "the deferred sibling save landed on the updated content: no lost update");
	assert.deepEqual(held, [], "the lock is released once the update is done");
});

test("ensureDirectExposure: a holder whose lock was taken over mid-update publishes nothing", () => {
	const files: Record<string, string> = { "/f": WITH_CODEGRAPH, "/g": WITH_CODEGRAPH };
	let writes = 0;
	const io: EnsureExposureIo = {
		read: (path) => files[path],
		write: (path, text) => {
			writes += 1;
			files[path] = text;
		},
		acquireLock: () => true,
		releaseLock: () => {},
		ownsLock: (path) => path === "/g",
	};
	assert.equal(ensureDirectExposure("/f", io).outcome, "busy", "another writer owns the lock now: exclusive access is unavailable");
	assert.equal(writes, 0, "the displaced holder publishes nothing");
	assert.equal(files["/f"], WITH_CODEGRAPH, "the config is left exactly as it was");
	assert.equal(ensureDirectExposure("/g", io).outcome, "added", "the same io publishes while it still owns its lock");
	assert.equal(writes, 1);
});

test("acquireConfigLock and releaseConfigLock: release removes only the lock this acquisition still owns", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "codegraph-mcp-exposure-lock-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const config = join(dir, "mcp.json");
	writeFileSync(config, WITH_CODEGRAPH, "utf8");
	const lock = lockPathFor(config);
	assert.equal(acquireConfigLock(config), true, "a free lock path is acquired");
	// A stale takeover by another writer between acquire and release: the file at the lock path
	// now carries the new owner's token.
	writeFileSync(lock, "1:displaced\n", "utf8");
	releaseConfigLock(config);
	assert.equal(readFileSync(lock, "utf8"), "1:displaced\n", "the displaced holder's release leaves the new owner's lock");
	assert.equal(acquireConfigLock(config), false, "the replacement lock is fresh, so a new contender stands down");
	rmSync(lock);
	assert.equal(acquireConfigLock(config), true);
	releaseConfigLock(config);
	assert.equal(existsSync(lock), false, "the holder's own lock is removed on release");
});

test("acquireConfigLock: an abandoned lock is recovered by exactly one of two contenders", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "codegraph-mcp-exposure-stale-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const config = join(dir, "mcp.json");
	writeFileSync(config, WITH_CODEGRAPH, "utf8");
	const lock = lockPathFor(config);
	writeFileSync(lock, "123\n", "utf8");
	const abandoned = new Date(Date.now() - 60_000);
	utimesSync(lock, abandoned, abandoned);
	assert.equal(acquireConfigLock(config), true, "the first contender recovers the abandoned lock");
	assert.equal(acquireConfigLock(config), false, "the second contender finds the recovered lock fresh and stands down");
	assert.notEqual(readFileSync(lock, "utf8"), "123\n", "the abandoned owner's file was replaced, not reused");
	releaseConfigLock(config);
	assert.equal(existsSync(lock), false);
	assert.deepEqual(readdirSync(dir), ["mcp.json"], "no takeover claim file is left behind");
});

test("takeOverStaleConfigLock: a contender whose observation predates a replacement never deletes it", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "codegraph-mcp-exposure-preempt-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const config = join(dir, "mcp.json");
	writeFileSync(config, WITH_CODEGRAPH, "utf8");
	const lock = lockPathFor(config);
	writeFileSync(lock, "9:crashed\n", "utf8");
	const abandoned = new Date(Date.now() - 60_000);
	utimesSync(lock, abandoned, abandoned);
	const observed = { mtimeMs: statSync(lock).mtimeMs, content: readFileSync(lock, "utf8") };
	// Between this contender's observation and its takeover, another writer recovers the lock -
	// worst case, its fresh lock carries the very mtime the contender observed.
	rmSync(lock);
	writeFileSync(lock, "7:fresh\n", "utf8");
	utimesSync(lock, new Date(observed.mtimeMs), new Date(observed.mtimeMs));
	assert.equal(takeOverStaleConfigLock(config, observed), false, "the delayed takeover is refused");
	assert.equal(readFileSync(lock, "utf8"), "7:fresh\n", "the winner's lock survives the delayed contender");
	assert.deepEqual(readdirSync(dir).sort(), [".mcp.json.lock", "mcp.json"], "the replacement is restored at the lock path with no leftover claim");
	// The same takeover proceeds when the path still holds the observed stale identity.
	assert.equal(takeOverStaleConfigLock(config, { mtimeMs: statSync(lock).mtimeMs, content: readFileSync(lock, "utf8") }), true);
	assert.equal(existsSync(lock), false, "the genuinely abandoned lock is removed for the next acquisition");
	assert.deepEqual(readdirSync(dir), ["mcp.json"], "no takeover claim file is left behind");
});

test("ensureDirectExposure: symlinked configs lock the one destination they share", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "codegraph-mcp-exposure-shared-"));
	try {
		const shared = join(dir, "shared-mcp.json");
		writeFileSync(shared, WITH_CODEGRAPH, "utf8");
		const homes = [join(dir, "home-a"), join(dir, "home-b")];
		let linked = true;
		for (const home of homes) {
			mkdirSync(home);
			try {
				symlinkSync(shared, join(home, "mcp.json"));
			} catch {
				linked = false;
			}
		}
		if (!linked) {
			t.skip("symlinks are unavailable on this platform");
			return;
		}
		const resolved = realpathSync(shared);
		assert.equal(lockPathFor(realpathSync(join(homes[0]!, "mcp.json"))), lockPathFor(resolved), "both links resolve to one lock identity");
		// While one update holds the destination's lock, an update through the other link
		// cannot take it: both homes serialize on the file they share.
		assert.equal(acquireConfigLock(resolved), true);
		assert.deepEqual(
			ensureDirectExposure(join(homes[1]!, "mcp.json")),
			{ path: join(homes[1]!, "mcp.json"), outcome: "busy" },
			"the shared destination's lock refuses the second link",
		);
		assert.equal(readFileSync(shared, "utf8"), WITH_CODEGRAPH, "the refused update wrote nothing");
		releaseConfigLock(resolved);
		assert.equal(ensureDirectExposure(join(homes[0]!, "mcp.json")).outcome, "added", "the free shared lock admits the update through either link");
		const written = JSON.parse(readFileSync(shared, "utf8")) as { mcpServers: { codegraph: { exposure: string } } };
		assert.equal(written.mcpServers.codegraph.exposure, "direct", "the update landed on the shared file");
		assert.equal(ensureDirectExposure(join(homes[1]!, "mcp.json")).outcome, "present", "the other link reads the same shared entry");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("releaseConfigLock: a release that resumes after a takeover restores the successor and leaves nothing behind", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "codegraph-mcp-exposure-release-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const config = join(dir, "mcp.json");
	writeFileSync(config, WITH_CODEGRAPH, "utf8");
	const lock = lockPathFor(config);
	assert.equal(acquireConfigLock(config), true);
	// The takeover a paused holder resumes to: the path now carries the successor's token,
	// and the release must take the file aside before deciding it is not its own - a plain
	// read-then-unlink would delete the successor's lock in the resumed instant.
	writeFileSync(lock, "4321:successor\n", "utf8");
	releaseConfigLock(config);
	assert.equal(readFileSync(lock, "utf8"), "4321:successor\n", "the successor's lock survives the delayed release");
	assert.deepEqual(readdirSync(dir).sort(), [".mcp.json.lock", "mcp.json"], "no release claim file is left behind");
	assert.deepEqual(readdirSync(dir).sort(), [".mcp.json.lock", "mcp.json"], "no release claim file is left behind");
});

test("releaseConfigLock: a vanished lock file while the token is still held releases without resurrecting anything", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "codegraph-mcp-exposure-vanish-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const config = join(dir, "mcp.json");
	writeFileSync(config, WITH_CODEGRAPH, "utf8");
	const lock = lockPathFor(config);
	assert.equal(acquireConfigLock(config), true);
	// The lock file vanishes while this process still owns its acquisition token: the release
	// takes the missing path aside, its rename fails, and the release returns without
	// resurrecting any lock or claim file.
	rmSync(lock);
	releaseConfigLock(config);
	assert.equal(existsSync(lock), false, "a vanished lock is not resurrected by its release");
	assert.deepEqual(readdirSync(dir), ["mcp.json"], "no lock or release claim file is left behind");
	assert.equal(acquireConfigLock(config), true, "the vanished lock's path is free for the next acquisition");
	releaseConfigLock(config);
	assert.equal(existsSync(lock), false, "the fresh release removes its own lock");
});

test("ensureDirectExposure: an absent agent-directory parent is a missing config, not an error", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "codegraph-mcp-exposure-fresh-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const fresh = join(dir, "no-such-home", "mcp.json");
	assert.deepEqual(ensureDirectExposure(fresh), { path: fresh, outcome: "missing" });
	assert.equal(existsSync(dirname(fresh)), false, "the absent parent directory is not created");
	assert.deepEqual(readdirSync(dir), [], "no config, lock, or temporary file appears anywhere");
});

test("ensureDirectExposureInAgentHomes: a fresh home without agent directories reports missing, not error", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "codegraph-mcp-exposure-homes-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const env = { GENTLE_PI_AGENT_HOME: join(dir, "pi"), GENTLE_SHELL_HOME: join(dir, "shell") };
	const results = ensureDirectExposureInAgentHomes("/h", undefined, env);
	assert.deepEqual(
		results.map((result) => result.outcome),
		["missing", "missing"],
		"both homes of a never-provisioned home are missing configs",
	);
	assert.deepEqual(readdirSync(dir), [], "the update creates no directory, lock, or file");
});

test("ensureDirectExposure: a resolution failure other than an absent parent is still an error", () => {
	const denied: NodeJS.ErrnoException = new Error("EACCES: permission denied, realpath '/p/.pi'");
	denied.code = "EACCES";
	const io: EnsureExposureIo = {
		resolve: () => {
			throw denied;
		},
		read: () => undefined,
		write: () => {},
	};
	assert.throws(() => ensureDirectExposure("/p/mcp.json", io), /EACCES/, "a denied parent propagates to the direct caller");
	const results = ensureDirectExposureInAgentHomes("/h", io, { GENTLE_PI_AGENT_HOME: "/p", GENTLE_SHELL_HOME: "/s" });
	assert.deepEqual(
		results.map((result) => result.outcome),
		["error", "error"],
		"the multi-home helper isolates the failure as error",
	);
});

test("ensureDirectExposure: a locked destination replaced by a symlink is a conflict, never a write through the new link", (t) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "codegraph-mcp-exposure-swap-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const locked = join(dir, "real-mcp.json");
	writeFileSync(locked, WITH_CODEGRAPH, "utf8");
	const other = join(dir, "other-mcp.json");
	// Identical content on purpose: the verify re-read compares text, so only the destination
	// identity check can catch a swap to an equally-worded config.
	writeFileSync(other, WITH_CODEGRAPH, "utf8");
	try {
		symlinkSync(other, join(dir, "redirect-mcp.json"));
	} catch {
		t.skip("symlinks are unavailable on this platform");
		return;
	}
	let reads = 0;
	const io: EnsureExposureIo = {
		resolve: (path) => {
			try {
				return realpathSync(path);
			} catch {
				return join(realpathSync(dirname(path)), basename(path));
			}
		},
		read: (path) => {
			reads += 1;
			if (path === locked && reads === 2) {
				// The locked file is replaced between the update's two reads: same words, other file.
				unlinkSync(locked);
				symlinkSync(other, locked);
			}
			return existsSync(path) ? readFileSync(path, "utf8") : undefined;
		},
		// The publication shape the io carried before the fix: it re-resolves its destination, so
		// a substituted symlink redirects the write. With the fix the update must refuse to
		// publish before this writer ever runs.
		write: (path, text) => atomicWriteFile(path, text),
	};
	assert.equal(ensureDirectExposure(locked, io).outcome, "conflict", "the changed destination is a conflict, not an update");
	assert.equal(readFileSync(other, "utf8"), WITH_CODEGRAPH, "the other config is never written");
	assert.ok(lstatSync(locked).isSymbolicLink(), "the substituted symlink is left exactly as it was");
	assert.ok(!readdirSync(dir).some((name) => name.includes(".tmp-")), "no temporary file is left behind");
});

test("ensureDirectExposure: an atomic replacement after the verified read is a conflict, never a lost update", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "codegraph-mcp-exposure-atomic-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const config = join(dir, "mcp.json");
	writeFileSync(config, WITH_CODEGRAPH, "utf8");
	// An editor's save with different words: the swap lands after the verify re-read compared
	// text, so only the file identity captured at that read can catch the replacement — the
	// new file still resolves to the very destination the update locked.
	const editorSaved = JSON.stringify(
		{ mcpServers: { codegraph: { command: "codegraph", args: ["serve", "--mcp"], env: { EDITED: "yes" } }, context7: { command: "npx" } } },
		null,
		2,
	);
	let resolves = 0;
	let wrote = false;
	const io: EnsureExposureIo = {
		resolve: (path) => {
			resolves += 1;
			if (resolves === 2) {
				// The editor's atomic save between the verified read and the publish: a fresh file
				// is renamed over the config at the same path.
				const staged = join(dir, ".mcp.json.editor-save");
				writeFileSync(staged, editorSaved, "utf8");
				renameSync(staged, config);
			}
			try {
				return realpathSync(path);
			} catch {
				return join(realpathSync(dirname(path)), basename(path));
			}
		},
		read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
		identityOf: (path) => fileIdentity(path),
		write: (path, text) => {
			wrote = true;
			atomicWriteFile(path, text);
		},
	};
	assert.equal(ensureDirectExposure(config, io).outcome, "conflict", "the same-path replacement is a conflict, not an update");
	assert.equal(wrote, false, "nothing was written over the editor's save");
	assert.equal(readFileSync(config, "utf8"), editorSaved, "the editor's changes survive byte-for-byte");
});

test("ensureDirectExposure: two unknown file identities are a conflict, never a write through an unproven file", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "codegraph-mcp-exposure-unproven-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const config = join(dir, "mcp.json");
	writeFileSync(config, WITH_CODEGRAPH, "utf8");
	// The adapter supplies the identity hook, so the publish must prove it lands on the file the
	// verified read observed: an identity that is unknown on both sides proves nothing — another
	// process can move the config aside for the reread and delete it before the publication — and
	// an unknown observation is a mismatch like any other, never a match by absence.
	let wrote: string | undefined;
	const io: EnsureExposureIo = {
		read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
		identityOf: () => undefined,
		write: (path, text) => {
			wrote = path;
			atomicWriteFile(path, text);
		},
	};
	assert.equal(ensureDirectExposure(config, io).outcome, "conflict", "an unprovable identity is a conflict, not an update");
	assert.equal(wrote, undefined, "nothing was written through the unknown identity");
	assert.equal(readFileSync(config, "utf8"), WITH_CODEGRAPH, "the config is left exactly as it was");
	assert.deepEqual(readdirSync(dir), ["mcp.json"], "the retries leave no temp file or lock behind");
});

test("ensureDirectExposure: an unknown observation recovers when the retry observes one proven identity", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "codegraph-mcp-exposure-recover-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const config = join(dir, "mcp.json");
	writeFileSync(config, WITH_CODEGRAPH, "utf8");
	// The first attempt's verified read observes no identity — a stat that failed transiently — so
	// that attempt stops short of the publish. The bounded restart must not report that unknown as
	// a conflict: the next attempt observes the same defined identity at its verified read and at
	// its publish, and the entry lands on exactly one write.
	const proven = fileIdentity(config);
	assert.notEqual(proven, undefined, "the fixture file itself has an identity the retry can prove");
	let observations = 0;
	let writes = 0;
	const io: EnsureExposureIo = {
		read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
		identityOf: () => {
			observations += 1;
			return observations === 1 ? undefined : proven;
		},
		write: (path, text) => {
			writes += 1;
			atomicWriteFile(path, text);
		},
	};
	assert.equal(ensureDirectExposure(config, io).outcome, "added", "the retry that proves one identity publishes the entry");
	assert.equal(writes, 1, "exactly one write lands");
	assert.equal(observations, 4, "the unknown observation and the retry that proves it both ran: one observation pair per attempt, none after the publish");
	const published = JSON.parse(readFileSync(config, "utf8")) as { mcpServers: { codegraph: { exposure?: string } } };
	assert.equal(published.mcpServers.codegraph.exposure, "direct", "the published entry carries the direct exposure");
	assert.deepEqual(readdirSync(dir), ["mcp.json"], "the publish leaves no temp file or lock behind");
});
