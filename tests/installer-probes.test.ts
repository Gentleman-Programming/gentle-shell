import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gentleAiBinaryPath } from "../runtime/gentle-ai-binary.mjs";
import { collectInventory, planPreflight, requirements } from "../scripts/installer-preflight.mjs";
import { bootstrapRoots, createProbes, hostAdapters, userEnvironment } from "../scripts/installer-probes.mjs";
import { PI_INSTALL_VERSION } from "../scripts/installer-runner.mjs";

const HOME = "/home/u";
const PNPM_HOME = "/home/u/.local/share/pnpm";
const BIN = `${PNPM_HOME}/bin`;
const TOOLS = "/home/u/.gentle-shell-bootstrap-tools.Ab12Cd34";
const TOOLS_NODE = `${TOOLS}/node/bin/node`;
const TOOLS_PNPM = `${TOOLS}/pnpm/bin/pnpm`;
const USER_NODE = "/usr/bin/node";
const USER_NPM_CLI = "/usr/lib/node_modules/npm/bin/npm-cli.js";
const TOOLS_NPM_CLI = `${TOOLS}/node/lib/node_modules/npm/bin/npm-cli.js`;
const SHELL_ROOT = `${PNPM_HOME}/global/v11/def/node_modules/gentle-pi`;
const LIST = "list -g --depth 0 --json";
const npmPackage = JSON.stringify({ name: "npm", version: "11.19.0" });

type Result = { code: number | null; signal?: string | null; timedOut?: boolean; truncated?: boolean; stdout?: string };
type Call = { command: string; args: string[]; env: Record<string, string>; deadlineMs: number; cwd?: string };

// A bootstrap-acquired Node and pnpm in the temporary tools directory, ahead of the user's PATH.
const bootstrapEnv = { HOME, PATH: `${TOOLS}/node/bin:${TOOLS}/pnpm/bin:/usr/bin:/bin` };

function probes({ env = bootstrapEnv as Record<string, string>, files = [] as string[], dirs = [HOME] as string[],
	writable = [HOME] as string[], others = [] as string[], realpaths = {} as Record<string, string>,
	texts = {} as Record<string, string>, results = {} as Record<string, Result | (() => Result)>,
	integrity = { ok: true } as object, platform = "linux" } = {}) {
	const calls: Call[] = [];
	const unexpected: string[] = [];
	const fileSet = new Set(files);
	const dirSet = new Set(dirs);
	const integrityCalls: object[] = [];
	const instance = createProbes({
		platform,
		env,
		run: async (command: string, args: string[], options: { env: Record<string, string>; deadlineMs: number; cwd?: string }) => {
			calls.push({ command, args, env: options.env, deadlineMs: options.deadlineMs, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) });
			const key = [command, ...args].join(" ");
			const entry = results[key];
			if (!entry) {
				unexpected.push(key);
				return { code: 127, signal: null, timedOut: false, stdout: "" };
			}
			return { signal: null, timedOut: false, stdout: "", ...(typeof entry === "function" ? entry() : entry) };
		},
		fs: {
			isFile: async (path: string) => fileSet.has(path),
			isDirectory: async (path: string) => dirSet.has(path),
			exists: async (path: string) => fileSet.has(path) || dirSet.has(path) || others.includes(path),
			realpath: async (path: string) => {
				if (path in realpaths) return realpaths[path];
				if (fileSet.has(path) || dirSet.has(path)) return path;
				throw new Error(`ENOENT ${path}`);
			},
			readText: async (path: string) => {
				if (!(path in texts)) throw new Error(`ENOENT ${path}`);
				return texts[path];
			},
			writable: async (path: string) => writable.includes(path),
		},
		verifyGentleAi: async (request: object) => {
			integrityCalls.push(request);
			return integrity;
		},
	});
	return { probes: instance, calls, unexpected, integrityCalls };
}

const bootstrapNode = {
	files: [TOOLS_NODE, `${TOOLS}/node/bin/npm`, TOOLS_NPM_CLI, TOOLS_PNPM],
	realpaths: { [`${TOOLS}/node/bin/npm`]: TOOLS_NPM_CLI },
	texts: { [`${TOOLS}/node/lib/node_modules/npm/package.json`]: npmPackage },
	results: { [`${TOOLS_NODE} --version`]: { code: 0, stdout: "v24.18.0\n" } } as Record<string, Result>,
};
const userNode = {
	files: [USER_NODE, "/usr/bin/npm", USER_NPM_CLI],
	realpaths: { "/usr/bin/npm": USER_NPM_CLI },
	texts: { "/usr/lib/node_modules/npm/package.json": JSON.stringify({ name: "npm", version: "10.9.2" }) },
	results: { [`${USER_NODE} --version`]: { code: 0, stdout: "v24.18.0\n" },
		"/usr/bin/npm --version": { code: 0, stdout: "10.9.2\n" },
		"/usr/bin/npm config get prefix": { code: 0, stdout: "/usr\n" } } as Record<string, Result>,
};
// npm from a version manager: a mise shim (a symlink to the mise binary) or a Volta-like shim script.
const MISE_SHIMS = "/home/u/.local/share/mise/shims";
const managedNpm = (directory: string, results: Record<string, Result> = {}) => probes({
	env: { HOME, PATH: `${TOOLS}/pnpm/bin:${directory}:/usr/bin` },
	files: [`${directory}/node`, `${directory}/npm`, TOOLS_PNPM],
	realpaths: { [`${directory}/npm`]: "/home/u/.local/bin/mise" },
	results: { [`${directory}/node --version`]: { code: 0, stdout: "v24.18.0\n" },
		[`${directory}/npm --version`]: { code: 0, stdout: "10.9.2\n" },
		[`${directory}/npm config get prefix`]: { code: 0, stdout: "/home/u/.local/share/mise/installs/node/24.18.0\n" }, ...results },
});
// A clean installation plan for that Node; everything else is ready to install.
const npmPlan = async (h: ReturnType<typeof probes>) => {
	const plan = planPreflight({ platform: "linux", arch: "x64", node: await h.probes.node(),
		pnpm: { available: true, version: "11.1.1", usable: true, compatible: true, persistent: true }, pi: { available: false },
		shell: { available: false }, gentleAi: { available: false }, go: { available: false },
		globalBin: { available: true, path: BIN, writable: true, onPath: true }, setup: false });
	assert.deepEqual(plan.blockers, []);
	return plan.actions.map((action: { id: string }) => action.id);
};

test("bootstrap tool roots come from GENTLE_BOOTSTRAP_TOOLS and PATH segments, and are removed from the user PATH", () => {
	assert.deepEqual(bootstrapRoots({ platform: "linux", env: bootstrapEnv }), [TOOLS]);
	assert.deepEqual(userEnvironment({ platform: "linux", env: bootstrapEnv }), { HOME, PATH: "/usr/bin:/bin" });
	const tools = "C:\\Users\\u\\AppData\\Local\\.gentle-shell-bootstrap-tools.1.2.3";
	const env = { GENTLE_BOOTSTRAP_TOOLS: tools, Path: `${tools}\\pnpm;C:\\Users\\U\\APPDATA\\Local\\.GENTLE-SHELL-BOOTSTRAP-TOOLS.9\\node;C:\\Windows` };
	assert.deepEqual(bootstrapRoots({ platform: "win32", env }), [tools, "C:\\Users\\U\\APPDATA\\Local\\.GENTLE-SHELL-BOOTSTRAP-TOOLS.9"]);
	assert.equal(userEnvironment({ platform: "win32", env }).Path, "C:\\Windows");
	assert.deepEqual(bootstrapRoots({ platform: "linux", env: { PATH: "/usr/bin" } }), []);
	assert.equal(userEnvironment({ platform: "linux", env: { PATH: `${TOOLS}/:/usr/bin` } }).PATH, "/usr/bin");
});

test("node on the user's real PATH is persistent with genuine npm evidence", async () => {
	const h = probes({ env: { HOME, PATH: `${TOOLS}/pnpm/bin:/usr/bin` }, ...userNode });
	assert.deepEqual(await h.probes.node(), { available: true, version: "24.18.0", usable: true, persistent: true, npm: true });
	assert.deepEqual(h.unexpected, []);
	for (const call of h.calls) assert.ok(call.deadlineMs > 0);
});

test("a working npm from a version manager is usable: no npm is persisted for it", async () => {
	for (const directory of [MISE_SHIMS, "/home/u/.volta/bin"]) {
		const h = managedNpm(directory);
		assert.deepEqual(await h.probes.node(), { available: true, version: "24.18.0", usable: true, persistent: true, npm: true });
		assert.deepEqual(h.unexpected, []);
		// That npm itself runs from `/` in the user's env with $PNPM_HOME/bin first, never npm-cli.js with another Node.
		const runs = h.calls.filter((call) => call.command === `${directory}/npm`);
		assert.deepEqual(runs.map((call) => call.args.join(" ")), ["--version", "config get prefix"]);
		for (const call of runs) {
			assert.equal(call.cwd, "/");
			assert.equal(call.env.PATH, `${BIN}:${directory}:/usr/bin`);
		}
		assert.deepEqual(await npmPlan(managedNpm(directory)), ["install-pi", "install-shell", "setup-shell", "verify-readiness"]);
	}
});

test("an npm that fails, prints no stable version or no absolute prefix is not usable: persist-npm is planned", async () => {
	const failures: Record<string, Result>[] = [
		{ [`${MISE_SHIMS}/npm --version`]: { code: 1, stdout: "" } },
		{ [`${MISE_SHIMS}/npm --version`]: { code: 0, stdout: "11.0.0-pre.1\n" } },
		{ [`${MISE_SHIMS}/npm --version`]: { code: 0, truncated: true, stdout: "10.9.2" } },
		{ [`${MISE_SHIMS}/npm config get prefix`]: { code: 0, stdout: "relative/prefix\n" } },
		{ [`${MISE_SHIMS}/npm config get prefix`]: { code: 0, timedOut: true, stdout: "/opt/node\n" } },
	];
	for (const results of failures) {
		assert.equal((await managedNpm(MISE_SHIMS, results).probes.node()).npm, false, JSON.stringify(results));
		assert.ok((await npmPlan(managedNpm(MISE_SHIMS, results))).includes("persist-npm"));
	}
});

test("a mise-like npm shim runs for real: a symlink to a non-npm executable that behaves like npm", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX shims");
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-probe-npm-")));
	try {
		const shims = join(root, "shims");
		mkdirSync(shims);
		// Like mise, one executable dispatches on the name it was run as, and reads the global config only from `/`.
		const mise = join(root, "mise");
		writeFileSync(mise, `#!/bin/sh\n[ "$(basename "$0")" = npm ] || exit 9\n[ "$(pwd)" = / ] || exit 8\n` +
			`case "$*" in\n  --version) echo 10.9.2 ;;\n  "config get prefix") echo /opt/mise/node ;;\n  *) exit 7 ;;\nesac\n`);
		chmodSync(mise, 0o755);
		symlinkSync(mise, join(shims, "npm"));
		symlinkSync(process.execPath, join(shims, "node"));
		const { run, fs } = hostAdapters();
		const env = { HOME: root, PNPM_HOME: join(root, "pnpm"), PATH: `${shims}:/usr/bin:/bin` };
		const node = await createProbes({ platform: process.platform, env, run, fs }).node();
		assert.equal(node.npm, true);
		assert.equal(node.persistent, true);
		// The same shim answering a relative prefix is not usable.
		writeFileSync(mise, readFileSync(mise, "utf8").replace("echo /opt/mise/node", "echo opt/mise/node"));
		assert.equal((await createProbes({ platform: process.platform, env, run, fs }).node()).npm, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a node only inside the bootstrap tools directory is bootstrap-only and its npm does not count", async () => {
	const h = probes(bootstrapNode);
	assert.deepEqual(await h.probes.node(), { available: true, version: "24.18.0", usable: true, persistent: false, npm: false });
	assert.deepEqual(h.unexpected, []);
	assert.equal(h.calls.some((call) => call.args[0] === TOOLS_NPM_CLI), false);
});

test("an older Node on the user's PATH is left as it is: the bootstrap's Node is reported with the older version found", async () => {
	const older = { ...userNode.results, [`${USER_NODE} --version`]: { code: 0, stdout: "v22.18.0\n" } };
	const h = probes({ files: [...userNode.files, ...bootstrapNode.files], realpaths: { ...userNode.realpaths, ...bootstrapNode.realpaths },
		texts: { ...userNode.texts, ...bootstrapNode.texts }, results: { ...older, [`${TOOLS_NODE} --version`]: { code: 0, stdout: "v24.21.0\n" },
			[`${TOOLS_NODE} ${USER_NPM_CLI} --version`]: { code: 0, stdout: "10.9.2\n" } } });
	const node = await h.probes.node();
	assert.equal(node.version, "24.21.0");
	assert.equal(node.persistent, false);
	assert.equal(node.found, "22.18.0");
	// A current user Node is reused as before, and an older one without a bootstrap copy is reported as it is.
	const current = probes({ files: [...userNode.files, ...bootstrapNode.files], realpaths: userNode.realpaths, texts: userNode.texts,
		results: { ...userNode.results, [`${TOOLS_NODE} --version`]: { code: 0, stdout: "v24.21.0\n" } } });
	assert.deepEqual(await current.probes.node(), { available: true, version: "24.18.0", usable: true, persistent: true, npm: true });
	const alone = probes({ ...userNode, env: { HOME, PATH: "/usr/bin" }, results: older });
	assert.deepEqual(await alone.probes.node(), { available: true, version: "22.18.0", usable: true, persistent: true, npm: true });
	// A bootstrap copy that is itself not newer is no replacement.
	const stale = probes({ files: [...userNode.files, ...bootstrapNode.files], realpaths: userNode.realpaths, texts: userNode.texts,
		results: { ...older, [`${TOOLS_NODE} --version`]: { code: 0, stdout: "v22.0.0\n" } } });
	assert.equal((await stale.probes.node()).found, undefined);
});

test("node absent, unparseable, failing, timed out or truncated", async () => {
	assert.deepEqual(await probes({ env: { HOME, PATH: "/usr/bin" } }).probes.node(), { available: false });
	for (const result of [{ code: 0, stdout: "v24\n" }, { code: 0, stdout: "v24.18.0-nightly\n" }, { code: 1, stdout: "v24.18.0" },
		{ code: 0, timedOut: true, stdout: "v24.18.0" }, { code: null, signal: "SIGKILL" }, { code: 0, truncated: true, stdout: "v24.18.0" }]) {
		const h = probes({ ...userNode, env: { HOME, PATH: "/usr/bin" }, results: { [`${USER_NODE} --version`]: result } });
		assert.deepEqual(await h.probes.node(), { available: null });
	}
	// An adapter exception becomes the unknown shape and never leaks its message.
	const instance = createProbes({ platform: "linux", env: { HOME, PATH: "/usr/bin" }, run: async () => { throw new Error("private /home/u/secret"); },
		fs: { isFile: async () => true, isDirectory: async () => false, exists: async () => true, realpath: async (p: string) => p,
			readText: async () => "", writable: async () => false } });
	for (const name of ["node", "pnpm", "pi", "shell", "gentleAi", "go", "setup"] as const) {
		assert.deepEqual(await instance[name](), { available: null }, name);
	}
});

test("pnpm from the bootstrap is bootstrap-only; one on the user's PATH is persistent", async () => {
	const results = { [`${TOOLS_PNPM} --version`]: { code: 0, stdout: "11.1.1\n" } };
	const h = probes({ files: [TOOLS_PNPM], results });
	assert.deepEqual(await h.probes.pnpm(), { available: true, version: "11.1.1", usable: true, compatible: true, persistent: false });
	assert.equal(h.calls[0].env.PNPM_HOME, PNPM_HOME);
	assert.equal(h.calls[0].env.PATH.split(":")[0], BIN);
	const persistent = probes({ env: { HOME, PATH: "/usr/bin" }, files: ["/usr/bin/pnpm"],
		results: { "/usr/bin/pnpm --version": { code: 0, stdout: "11.4.0\n" } } });
	assert.deepEqual(await persistent.probes.pnpm(), { available: true, version: "11.4.0", usable: true, compatible: true, persistent: true });
});

test("pnpm outside the verified major, unparseable, timed out or absent", async () => {
	for (const [stdout, compatible] of [["10.30.0", false], ["12.0.0", false], ["11.0.9", false], ["11.1.1", true]] as const) {
		const h = probes({ files: [TOOLS_PNPM], results: { [`${TOOLS_PNPM} --version`]: { code: 0, stdout } } });
		assert.equal((await h.probes.pnpm()).compatible, compatible);
	}
	for (const result of [{ code: 0, stdout: "pnpm 11" }, { code: 0, timedOut: true, stdout: "11.1.1" }, { code: 2 }]) {
		const h = probes({ files: [TOOLS_PNPM], results: { [`${TOOLS_PNPM} --version`]: result } });
		assert.deepEqual(await h.probes.pnpm(), { available: null });
	}
	assert.deepEqual(await probes({ env: { HOME, PATH: "/usr/bin" } }).probes.pnpm(), { available: false });
});

test("the bootstrap's pnpm next to an incompatible pnpm on the user's PATH is bootstrap-only and reports the version found", async () => {
	const results = { [`${TOOLS_PNPM} --version`]: { code: 0, stdout: "11.1.1\n" } };
	for (const [own, found] of [["10.27.0", "10.27.0"], ["12.0.0", "12.0.0"], ["11.1.1", undefined], ["not a version", undefined]] as const) {
		const h = probes({ files: [TOOLS_PNPM, "/usr/bin/pnpm"], results: { ...results, "/usr/bin/pnpm --version": { code: 0, stdout: `${own}\n` } } });
		assert.deepEqual(await h.probes.pnpm(), { available: true, version: "11.1.1", usable: true, compatible: true, persistent: false,
			...(found ? { found } : {}) }, own);
		// The user's pnpm runs only for its version, with the user's own environment.
		const own_ = h.calls.find((call) => call.command === "/usr/bin/pnpm");
		assert.deepEqual(own_?.args, ["--version"]);
		assert.equal(own_?.env.PATH, "/usr/bin:/bin");
	}
	// The Windows handoff from the bootstrap tools is bootstrap-only even with a pnpm.cmd on the user's Path.
	const local = "C:\\Users\\u\\AppData\\Local";
	const tools = `${local}\\.gentle-shell-bootstrap-tools.1`;
	const node = `${tools}\\node\\node.exe`;
	const entry = `${tools}\\pnpm\\package\\bin\\pnpm.mjs`;
	const env = { LOCALAPPDATA: local, USERPROFILE: "C:\\Users\\u", Path: "C:\\Tools", GENTLE_BOOTSTRAP_TOOLS: tools,
		GENTLE_INSTALL_PNPM_NODE: node, GENTLE_INSTALL_PNPM_ENTRY: entry };
	const windows = probes({ platform: "win32", env, files: ["C:\\Tools\\pnpm.cmd"], results: { [`${node} ${entry} --version`]: { code: 0, stdout: "11.1.1\r\n" } } });
	assert.deepEqual(await windows.probes.pnpm(), { available: true, version: "11.1.1", usable: true, compatible: true, persistent: false });
});

test("a user's pnpm in $PNPM_HOME/bin is reported as it is next to the bootstrap's pnpm, never as replaced", async () => {
	// Persisting pnpm writes $PNPM_HOME/bin/pnpm: the user's own pnpm there is never replaced or downgraded.
	const env = { HOME, PATH: `${TOOLS}/node/bin:${TOOLS}/pnpm/bin:${BIN}:/usr/bin:/bin` };
	const results = { [`${TOOLS_PNPM} --version`]: { code: 0, stdout: "11.1.1\n" } };
	for (const own of ["11.0.5", "12.0.0", "10.27.0"]) {
		const h = probes({ env, files: [TOOLS_PNPM, `${BIN}/pnpm`], results: { ...results, [`${BIN}/pnpm --version`]: { code: 0, stdout: `${own}\n` } } });
		assert.deepEqual(await h.probes.pnpm(), { available: true, version: own, usable: true, compatible: false, persistent: true, inGlobalBin: true }, own);
	}
	// Without a version it is unknown, still never replaced.
	const unread = probes({ env, files: [TOOLS_PNPM, `${BIN}/pnpm`], results: { ...results, [`${BIN}/pnpm --version`]: { code: 2 } } });
	assert.deepEqual(await unread.probes.pnpm(), { available: null, inGlobalBin: true });
	// A compatible one there needs nothing persisted over it.
	const current = probes({ env, files: [TOOLS_PNPM, `${BIN}/pnpm`], results: { ...results, [`${BIN}/pnpm --version`]: { code: 0, stdout: "11.5.0\n" } } });
	assert.deepEqual(await current.probes.pnpm(), { available: true, version: "11.5.0", usable: true, compatible: true, persistent: true, inGlobalBin: true });
	// Through the planner: a blocker before consent, and nothing persisted over it.
	for (const own of ["11.0.5", "12.0.0"]) {
		const h = probes({ env, files: [TOOLS_PNPM, `${BIN}/pnpm`], results: { ...results, [`${BIN}/pnpm --version`]: { code: 0, stdout: `${own}\n` } } });
		const inventory = await collectInventory({ platform: "linux", arch: "x64", probes: { pnpm: h.probes.pnpm,
			node: async () => ({ available: true, version: "24.18.0", usable: true, persistent: true, npm: true }),
			pi: async () => ({ available: false }), shell: async () => ({ available: false }), gentleAi: async () => ({ available: false }),
			go: async () => ({ available: false }), globalBin: async () => ({ available: true, path: BIN, writable: true, onPath: true }),
			setup: async () => false } });
		const plan = planPreflight(inventory);
		assert.deepEqual(plan.blockers, [{ code: "incompatible-tool", tool: "pnpm" }], own);
		assert.deepEqual(plan.actions, []);
	}
	// The same user pnpm outside $PNPM_HOME/bin keeps the pinned copy alongside.
	const outside = probes({ files: [TOOLS_PNPM, "/usr/bin/pnpm"], results: { ...results, "/usr/bin/pnpm --version": { code: 0, stdout: "11.0.5\n" } } });
	assert.deepEqual(await outside.probes.pnpm(), { available: true, version: "11.1.1", usable: true, compatible: true, persistent: false, found: "11.0.5" });
	// Windows cannot run the user's pnpm.cmd for its version: one in $PNPM_HOME\bin is unknown.
	const local = "C:\\Users\\u\\AppData\\Local";
	const tools = `${local}\\.gentle-shell-bootstrap-tools.1`;
	const node = `${tools}\\node\\node.exe`;
	const entry = `${tools}\\pnpm\\package\\bin\\pnpm.mjs`;
	const windowsEnv = { LOCALAPPDATA: local, USERPROFILE: "C:\\Users\\u", Path: `${local}\\pnpm\\bin`, GENTLE_BOOTSTRAP_TOOLS: tools,
		GENTLE_INSTALL_PNPM_NODE: node, GENTLE_INSTALL_PNPM_ENTRY: entry };
	const windows = probes({ platform: "win32", env: windowsEnv, files: [`${local}\\pnpm\\bin\\pnpm.cmd`],
		results: { [`${node} ${entry} --version`]: { code: 0, stdout: "11.1.1\r\n" } } });
	assert.deepEqual(await windows.probes.pnpm(), { available: null, inGlobalBin: true });
});

test("Windows pnpm uses the direct bootstrap handoff; a .cmd shim alone is unknown", async () => {
	const local = "C:\\Users\\u\\AppData\\Local";
	const node = `${local}\\.gentle-shell-bootstrap-tools.1\\node\\node.exe`;
	const entry = `${local}\\.gentle-shell-bootstrap-tools.1\\pnpm\\package\\bin\\pnpm.mjs`;
	const env = { LOCALAPPDATA: local, USERPROFILE: "C:\\Users\\u", Path: "C:\\Windows", GENTLE_INSTALL_PNPM_NODE: node, GENTLE_INSTALL_PNPM_ENTRY: entry };
	const h = probes({ platform: "win32", env, results: { [`${node} ${entry} --version`]: { code: 0, stdout: "11.1.1\r\n" } } });
	assert.deepEqual(await h.probes.pnpm(), { available: true, version: "11.1.1", usable: true, compatible: true, persistent: false });
	assert.equal(h.calls[0].env.Path.split(";")[0], `${local}\\pnpm\\bin`);
	const shim = probes({ platform: "win32", env: { LOCALAPPDATA: local, Path: "C:\\Tools" }, files: ["C:\\Tools\\pnpm.cmd"] });
	assert.deepEqual(await shim.probes.pnpm(), { available: null });
	assert.deepEqual(shim.calls, []);
});

// Windows layouts, verbatim shim text (see installer-windows-bootstrap.test.ts for sources).
const W_LOCAL = "C:\\Users\\u\\AppData\\Local";
const W_TOOLS = `${W_LOCAL}\\.gentle-shell-bootstrap-tools.1`;
const W_TOOLS_NODE = `${W_TOOLS}\\node\\node.exe`;
const W_TOOLS_ENTRY = `${W_TOOLS}\\pnpm\\package\\bin\\pnpm.mjs`;
const W_APPDATA_NPM = "C:\\Users\\u\\AppData\\Roaming\\npm";
const W_NPM_ROOT = `${W_APPDATA_NPM}\\node_modules`;
const W_NODE_DIR = "C:\\Program Files\\nodejs";
const W_NODE = `${W_NODE_DIR}\\node.exe`;
const W_NPM_CLI = `${W_NODE_DIR}\\node_modules\\npm\\bin\\npm-cli.js`;
const cmdShimHead = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n";
const cmdShim = (target: string) => `${cmdShimHead}\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;
const nodeNpmCmd = ":: Created by npm, please don't edit manually.\r\n@ECHO OFF\r\n\r\nSETLOCAL\r\n\r\nSET \"NODE_EXE=%~dp0\\node.exe\"\r\nIF NOT EXIST \"%NODE_EXE%\" (\r\n  SET \"NODE_EXE=node\"\r\n)\r\n\r\nSET \"NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js\"\r\nSET \"NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js\"\r\nFOR /F \"delims=\" %%F IN ('CALL \"%NODE_EXE%\" \"%NPM_PREFIX_JS%\"') DO (\r\n  SET \"NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js\"\r\n)\r\nIF EXIST \"%NPM_PREFIX_NPM_CLI_JS%\" (\r\n  SET \"NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%\"\r\n)\r\n\r\n\"%NODE_EXE%\" \"%NPM_CLI_JS%\" %*\r\n";
const W_PI = `${W_NPM_ROOT}\\@earendil-works\\pi-coding-agent`;
const W_PI_ENTRY = `${W_PI}\\dist\\bundle\\cli.js`;
// The wizard on Windows: the bootstrap's Node and pnpm handed off, Node.js on the user's Path.
const windowsPi = (version: string, { shim = cmdShim("node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js"), root = W_NPM_ROOT } = {}) => probes({
	platform: "win32",
	env: { LOCALAPPDATA: W_LOCAL, USERPROFILE: "C:\\Users\\u", Path: `${W_TOOLS}\\node;${W_APPDATA_NPM};${W_NODE_DIR}`, PATHEXT: ".COM;.EXE;.BAT;.CMD",
		GENTLE_BOOTSTRAP_TOOLS: W_TOOLS, GENTLE_INSTALL_PNPM_NODE: W_TOOLS_NODE, GENTLE_INSTALL_PNPM_ENTRY: W_TOOLS_ENTRY },
	files: [`${W_APPDATA_NPM}\\pi.cmd`, `${W_APPDATA_NPM}\\pi`, W_PI_ENTRY, W_NODE, `${W_NODE_DIR}\\npm.cmd`, W_NPM_CLI],
	dirs: [W_NPM_ROOT, root],
	texts: { [`${W_APPDATA_NPM}\\pi.cmd`]: shim, [`${W_NODE_DIR}\\npm.cmd`]: nodeNpmCmd,
		[`${W_PI}\\package.json`]: JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }) },
	results: { [`${W_TOOLS_NODE} ${W_TOOLS_ENTRY} ${LIST}`]: { code: 0, stdout: "[]" },
		[`${W_NODE} ${W_PI_ENTRY} --version`]: { code: 0, stdout: `${version}\r\n` },
		[`${W_NODE} ${W_NPM_CLI} root -g`]: { code: 0, stdout: `${root}\r\n` } },
});
test("Windows: an older Pi installed by npm is run through its shim and attributed to npm, as on POSIX", async () => {
	const npm = windowsPi("0.87.1");
	assert.deepEqual(await npm.probes.pi(), { available: true, version: "0.87.1", usable: true, external: true, owner: "npm" });
	assert.deepEqual(await npm.probes.locatePi(), { root: W_PI, version: "0.87.1", owner: "npm" });
	assert.deepEqual(npm.unexpected, []);
	assert.equal(npm.calls.some((call) => /\.cmd$/i.test(call.command)), false, "no shim is ever spawned");
	// npm's global root elsewhere: the Pi is reused or replaced alongside, never attributed.
	const elsewhere = windowsPi("0.87.1", { root: "C:\\Other\\node_modules" });
	assert.deepEqual(await elsewhere.probes.pi(), { available: true, version: "0.87.1", usable: true, external: true });
	// A pi.cmd no structure resolves is never run: unknown, outside pnpm.
	const mise = windowsPi("0.87.1", { shim: "@echo off\r\nsetlocal\r\nmise x -- %*\r\n" });
	assert.deepEqual(await mise.probes.pi(), { available: null, outsidePnpm: true });
	assert.equal(mise.calls.some((call) => call.args.includes("--version")), false);
});

test("Windows: a user's pnpm in $PNPM_HOME\\bin is run through its shim for the version it reports, never replaced", async () => {
	const bin = `${W_LOCAL}\\pnpm\\bin`;
	const exe = `${W_LOCAL}\\pnpm\\global\\v11\\5f1a\\node_modules\\@pnpm\\exe\\pnpm.exe`;
	const h = probes({ platform: "win32", env: { LOCALAPPDATA: W_LOCAL, USERPROFILE: "C:\\Users\\u", Path: bin, GENTLE_BOOTSTRAP_TOOLS: W_TOOLS,
		GENTLE_INSTALL_PNPM_NODE: W_TOOLS_NODE, GENTLE_INSTALL_PNPM_ENTRY: W_TOOLS_ENTRY },
	files: [`${bin}\\pnpm.cmd`, `${bin}\\pnpm`, exe],
	texts: { [`${bin}\\pnpm.cmd`]: "@SETLOCAL\r\n@\"%~dp0\\..\\global\\v11\\5f1a\\node_modules\\@pnpm\\exe\\pnpm.exe\"   %*\r\n" },
	results: { [`${W_TOOLS_NODE} ${W_TOOLS_ENTRY} --version`]: { code: 0, stdout: "11.1.1\r\n" }, [`${exe} --version`]: { code: 0, stdout: "11.0.5\r\n" } } });
	assert.deepEqual(await h.probes.pnpm(), { available: true, version: "11.0.5", usable: true, compatible: false, persistent: true, inGlobalBin: true });
	assert.deepEqual(h.calls.find((call) => call.command === exe)?.cwd, "C:\\");
});

test("Windows npm counts by behavior whatever installed it: Node.js, nvm-windows, fnm or a Volta npm.exe", async () => {
	const layouts = {
		node: { dir: W_NODE_DIR, npm: "npm.cmd" },
		nvm: { dir: "C:\\nvm4w\\nodejs", npm: "npm.cmd" },
		fnm: { dir: `${W_LOCAL}\\fnm_multishells\\1234_1700000000000`, npm: "npm.cmd" },
		volta: { dir: "C:\\Program Files\\Volta", npm: "npm.exe" },
	};
	for (const [name, { dir, npm }] of Object.entries(layouts)) {
		const node = `${dir}\\node.exe`; const cli = `${dir}\\node_modules\\npm\\bin\\npm-cli.js`;
		const command = npm === "npm.exe" ? `${dir}\\npm.exe` : node;
		const prefix = npm === "npm.exe" ? [] : [cli];
		const h = probes({ platform: "win32", env: { LOCALAPPDATA: W_LOCAL, USERPROFILE: "C:\\Users\\u", Path: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD",
			GENTLE_INSTALL_PNPM_NODE: W_TOOLS_NODE, GENTLE_INSTALL_PNPM_ENTRY: W_TOOLS_ENTRY },
		files: [node, `${dir}\\${npm}`, cli], texts: { [`${dir}\\npm.cmd`]: nodeNpmCmd },
		results: { [`${node} --version`]: { code: 0, stdout: "v24.18.0\r\n" }, [[command, ...prefix, "--version"].join(" ")]: { code: 0, stdout: "11.6.2\r\n" },
			[[command, ...prefix, "config", "get", "prefix"].join(" ")]: { code: 0, stdout: `${W_APPDATA_NPM}\r\n` } } });
		assert.deepEqual(await h.probes.node(), { available: true, version: "24.18.0", usable: true, persistent: true, npm: true }, name);
	}
	// mise's file shim cannot be run without cmd.exe: no usable npm, so the plan persists one.
	const mise = `${W_LOCAL}\\mise\\shims`;
	const h = probes({ platform: "win32", env: { LOCALAPPDATA: W_LOCAL, Path: `${mise};${W_NODE_DIR}`, PATHEXT: ".COM;.EXE;.BAT;.CMD",
		GENTLE_INSTALL_PNPM_NODE: W_TOOLS_NODE, GENTLE_INSTALL_PNPM_ENTRY: W_TOOLS_ENTRY },
	files: [`${mise}\\npm.cmd`, W_NODE], texts: { [`${mise}\\npm.cmd`]: "@echo off\r\nsetlocal\r\nmise x -- %*\r\n" },
	results: { [`${W_NODE} --version`]: { code: 0, stdout: "v24.18.0\r\n" } } });
	assert.deepEqual(await h.probes.node(), { available: true, version: "24.18.0", usable: true, persistent: true, npm: false });
});

function listing(dependencies: object) {
	return JSON.stringify([{ path: `${PNPM_HOME}/global/v11/def`, dependencies }]);
}
const pnpmVersion = { [`${TOOLS_PNPM} ${LIST}`]: { code: 0, stdout: "[]" } };

test("clean global list: Pi, Shell and Gentle AI absent and setup needed, from one list call", async () => {
	const h = probes({ files: [TOOLS_PNPM], results: pnpmVersion });
	assert.deepEqual(await h.probes.pi(), { available: false });
	assert.deepEqual(await h.probes.shell(), { available: false });
	assert.deepEqual(await h.probes.gentleAi(), { available: false });
	assert.equal(await h.probes.setup(), false);
	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0].env.PATH.split(":")[0], BIN);
});

test("pnpm-global Pi and Shell report versions; verified package-native Gentle AI is compatible", async () => {
	const stdout = listing({ "@earendil-works/pi-coding-agent": { version: "1.0.0", path: `${PNPM_HOME}/global/v11/def/node_modules/pi` },
		"gentle-pi": { version: requirements.shell, path: SHELL_ROOT } });
	const files = [TOOLS_PNPM, `${BIN}/gentle-shell`, gentleAiBinaryPath(SHELL_ROOT, "linux")];
	const h = probes({ files, dirs: [HOME, PNPM_HOME, SHELL_ROOT], results: { [`${TOOLS_PNPM} ${LIST}`]: { code: 0, stdout } } });
	assert.deepEqual(await h.probes.pi(), { available: true, version: "1.0.0", usable: true });
	assert.deepEqual(await h.probes.shell(), { available: true, version: requirements.shell, usable: true, global: true, owner: "pnpm" });
	assert.deepEqual(await h.probes.gentleAi(), { available: true, version: requirements.gentleAi, usable: true, compatible: true });
	assert.deepEqual(h.integrityCalls, [{ packageRoot: SHELL_ROOT, platform: "linux", env: bootstrapEnv, home: HOME }]);
	// The pinned stack in one pnpm project under PNPM_HOME: only its setup may be rerun.
	assert.deepEqual(await h.probes.setup(), { available: true, recoverable: true });
	const missingBin = probes({ files: [TOOLS_PNPM], results: { [`${TOOLS_PNPM} ${LIST}`]: { code: 0, stdout } } });
	assert.equal((await missingBin.probes.shell()).usable, false);
});

test("setup is recoverable only for the pinned Pi and Shell owned by one pnpm project under PNPM_HOME", async () => {
	const PI = "@earendil-works/pi-coding-agent";
	const pi = { version: PI_INSTALL_VERSION, path: `${PNPM_HOME}/global/v11/def/node_modules/pi` };
	const shell = { version: requirements.shell, path: SHELL_ROOT };
	const setup = (stdout: string, extra: { realpaths?: Record<string, string> } = {}) => probes({ files: [TOOLS_PNPM],
		dirs: [HOME, PNPM_HOME, SHELL_ROOT, "/elsewhere/gentle-pi"], results: { [`${TOOLS_PNPM} ${LIST}`]: { code: 0, stdout } }, ...extra })
		.probes.setup();
	const recoverable = { available: true, recoverable: true };
	assert.deepEqual(await setup(listing({ [PI]: pi, "gentle-pi": shell })), recoverable);
	// The npm and pnpm persisted by an earlier run live in their own project and do not matter.
	const persisted = { dependencies: { npm: { version: "11.19.0" }, pnpm: { version: "11.1.1" } } };
	assert.deepEqual(await setup(JSON.stringify([persisted, { dependencies: { [PI]: pi, "gentle-pi": shell } }])), recoverable);
	const foreign = [
		listing({ [PI]: { ...pi, version: "1.2.0" }, "gentle-pi": shell }),
		listing({ [PI]: pi, "gentle-pi": { ...shell, version: "3.0.0" } }),
		listing({ "gentle-pi": shell }),
		JSON.stringify([{ dependencies: { [PI]: pi, "gentle-pi": shell } }, { dependencies: { [PI]: pi } }]),
		JSON.stringify([{ dependencies: { "gentle-pi": shell } }, { dependencies: { [PI]: pi } }]),
		JSON.stringify([{ dependencies: { [PI]: pi, "gentle-pi": shell } }, { devDependencies: { "gentle-pi": shell } }]),
		listing({ [PI]: pi, "gentle-pi": { ...shell, path: "/elsewhere/gentle-pi" } }),
		listing({ [PI]: pi, "gentle-pi": { version: requirements.shell } }),
	];
	for (const stdout of foreign) assert.deepEqual(await setup(stdout), { available: null }, stdout);
	// A root that resolves outside PNPM_HOME through a symlink is not this pnpm's install.
	assert.deepEqual(await setup(listing({ [PI]: pi, "gentle-pi": shell }), { realpaths: { [SHELL_ROOT]: "/elsewhere/gentle-pi" } }),
		{ available: null });
});

test("Gentle AI is absent without its binary, unknown when unverified, unconfined or another Shell version", async () => {
	const shell = (version: string, path = SHELL_ROOT) => ({ [`${TOOLS_PNPM} ${LIST}`]: { code: 0, stdout: listing({ "gentle-pi": { version, path } }) } });
	const binary = gentleAiBinaryPath(SHELL_ROOT, "linux");
	const dirs = [HOME, PNPM_HOME, SHELL_ROOT];
	assert.deepEqual(await probes({ files: [TOOLS_PNPM], dirs, results: shell(requirements.shell) }).probes.gentleAi(), { available: false });
	const unverified = probes({ files: [TOOLS_PNPM, binary], dirs, results: shell(requirements.shell), integrity: { ok: false } });
	assert.deepEqual(await unverified.probes.gentleAi(), { available: null });
	assert.deepEqual(await probes({ files: [TOOLS_PNPM, binary], dirs, results: shell("3.0.0") }).probes.gentleAi(), { available: null });
	const outside = probes({ files: [TOOLS_PNPM, "/elsewhere/gentle-pi"], dirs: [...dirs, "/elsewhere/gentle-pi"],
		results: shell(requirements.shell, "/elsewhere/gentle-pi") });
	assert.deepEqual(await outside.probes.gentleAi(), { available: null });
});

test("a failed, unparseable or ambiguous global list makes Pi, Shell, Gentle AI and setup unknown", async () => {
	const duplicated = JSON.stringify([{ dependencies: { "gentle-pi": { version: "4.0.0" } } }, { dependencies: { "gentle-pi": { version: "4.0.0" } } }]);
	for (const result of [{ code: 1, stdout: "[]" }, { code: 0, stdout: "" }, { code: 0, stdout: "{}" }, { code: 0, stdout: "not json" },
		{ code: 0, timedOut: true, stdout: "[]" }, { code: 0, truncated: true, stdout: "[]" }]) {
		const h = probes({ files: [TOOLS_PNPM], results: { [`${TOOLS_PNPM} ${LIST}`]: result } });
		for (const name of ["pi", "shell", "gentleAi", "setup"] as const) assert.deepEqual(await h.probes[name](), { available: null }, name);
	}
	const h = probes({ files: [TOOLS_PNPM], results: { [`${TOOLS_PNPM} ${LIST}`]: { code: 0, stdout: duplicated } } });
	assert.deepEqual(await h.probes.shell(), { available: null });
});

test("a pnpm-global Shell from the main channel is present with its main version; other prereleases stay unknown", async () => {
	const main = `${requirements.shell}-main.6e7e3a18f794`;
	const cases: Array<[string, object]> = [[main, { available: true, version: main, usable: true, global: true, owner: "pnpm" }],
		[`${requirements.shell}-rc.1`, { available: null }], [`${requirements.shell}-main.6E7E3A18F794`, { available: null }]];
	for (const [version, expected] of cases) {
		const stdout = listing({ "gentle-pi": { version, path: SHELL_ROOT } });
		const h = probes({ files: [TOOLS_PNPM, `${BIN}/gentle-shell`], results: { [`${TOOLS_PNPM} ${LIST}`]: { code: 0, stdout } } });
		assert.deepEqual(await h.probes.shell(), expected, version);
	}
});

const NPM_ROOT = "/usr/local/lib/node_modules";
const NPM_SHELL = `${NPM_ROOT}/gentle-pi`;
const outside = (shellVersion: string, { linked = false, piOutput = "1.0.4\n" } = {}) => probes({
	env: { HOME, PATH: `${TOOLS}/pnpm/bin:/usr/local/bin:/usr/bin` },
	files: [TOOLS_PNPM, "/usr/local/bin/pi", "/usr/local/bin/gentle-shell", "/usr/local/bin/npm"],
	dirs: [HOME, NPM_ROOT, "/home/u/work/gentle-pi"],
	realpaths: { "/usr/local/bin/gentle-shell": `${linked ? "/home/u/work/gentle-pi" : NPM_SHELL}/bin/gentle-shell.mjs` },
	texts: { [`${linked ? "/home/u/work/gentle-pi" : NPM_SHELL}/package.json`]: JSON.stringify({ name: "gentle-pi", version: shellVersion }) },
	results: { ...pnpmVersion, "/usr/local/bin/npm root -g": { code: 0, stdout: `${NPM_ROOT}\n` },
		"/usr/local/bin/pi --version": { code: 0, stdout: piOutput } },
});

test("a Pi on PATH that pnpm does not manage is reused with the version it reports", async () => {
	assert.deepEqual(await outside("3.9.0").probes.pi(), { available: true, version: "1.0.4", usable: true, external: true });
	for (const piOutput of ["", "pi dev build\n"]) {
		assert.deepEqual(await outside("3.9.0", { piOutput }).probes.pi(), { available: null, outsidePnpm: true }, piOutput);
	}
});

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_ROOT = `${PNPM_HOME}/global/v11/abc/node_modules/${PI_PACKAGE}`;
const NPM_PI = `${NPM_ROOT}/${PI_PACKAGE}`;
// A Pi on PATH outside pnpm: npm's own global root, or another installation such as mise.
const outsidePi = (version: string, root = NPM_PI) => probes({
	env: { HOME, PATH: `${TOOLS}/pnpm/bin:/usr/local/bin:/usr/bin` },
	files: [TOOLS_PNPM, "/usr/local/bin/pi", "/usr/local/bin/npm"],
	dirs: [HOME, NPM_ROOT],
	realpaths: { "/usr/local/bin/pi": `${root}/dist/cli.js` },
	texts: { [`${root}/package.json`]: JSON.stringify({ name: PI_PACKAGE, version }) },
	results: { ...pnpmVersion, "/usr/local/bin/npm root -g": { code: 0, stdout: `${NPM_ROOT}\n` },
		"/usr/local/bin/pi --version": { code: 0, stdout: `${version}\n` } },
});

test("an older pnpm-global Pi reports pnpm as its owner, and locatePi finds its real root", async () => {
	const older = probes({ files: [TOOLS_PNPM], dirs: [HOME, PI_ROOT], results: { [`${TOOLS_PNPM} ${LIST}`]: { code: 0,
		stdout: listing({ [PI_PACKAGE]: { version: "0.87.1", path: PI_ROOT } }) } } });
	assert.deepEqual(await older.probes.pi(), { available: true, version: "0.87.1", usable: true, owner: "pnpm" });
	assert.deepEqual(await older.probes.locatePi(), { root: PI_ROOT, version: "0.87.1", owner: "pnpm" });
	// A current Pi keeps its shape: nothing about it is updated.
	const current = probes({ files: [TOOLS_PNPM], dirs: [HOME, PI_ROOT], results: { [`${TOOLS_PNPM} ${LIST}`]: { code: 0,
		stdout: listing({ [PI_PACKAGE]: { version: PI_INSTALL_VERSION, path: PI_ROOT } }) } } });
	assert.deepEqual(await current.probes.pi(), { available: true, version: PI_INSTALL_VERSION, usable: true });
	assert.deepEqual(await current.probes.locatePi(), { root: PI_ROOT, version: PI_INSTALL_VERSION, owner: "pnpm" });
	// Listed twice (two global projects): ambiguous, so nothing is located.
	const twice = probes({ files: [TOOLS_PNPM], dirs: [HOME, PI_ROOT], results: { [`${TOOLS_PNPM} ${LIST}`]: { code: 0,
		stdout: JSON.stringify([{ dependencies: { [PI_PACKAGE]: { version: "0.87.1", path: PI_ROOT } } },
			{ dependencies: { [PI_PACKAGE]: { version: PI_INSTALL_VERSION, path: PI_ROOT } } }]) } } });
	assert.deepEqual(await twice.probes.pi(), { available: null });
	assert.equal(await twice.probes.locatePi(), null);
});

test("an older Pi in npm's global root reports npm as its owner; one elsewhere has no owner", async () => {
	const npm = outsidePi("0.87.1");
	assert.deepEqual(await npm.probes.pi(), { available: true, version: "0.87.1", usable: true, external: true, owner: "npm" });
	assert.deepEqual(await npm.probes.locatePi(), { root: NPM_PI, version: "0.87.1", owner: "npm" });
	const mise = outsidePi("0.87.1", "/home/u/.local/share/mise/installs/pi/lib/node_modules/@earendil-works/pi-coding-agent");
	assert.deepEqual(await mise.probes.pi(), { available: true, version: "0.87.1", usable: true, external: true });
	assert.equal((await mise.probes.locatePi())?.owner, null);
	// A current npm Pi is reused as before, without asking npm where its global root is.
	const current = outsidePi(PI_INSTALL_VERSION);
	assert.deepEqual(await current.probes.pi(), { available: true, version: PI_INSTALL_VERSION, usable: true, external: true });
	assert.equal(current.calls.some((call) => call.args.join(" ") === "root -g"), false);
	// No Pi at all: nothing is located.
	assert.equal(await probes({ files: [TOOLS_PNPM], results: pnpmVersion }).probes.locatePi(), null);
});

test("after the installer's Pi is added next to another one, the next probe reuses the pnpm-global Pi and never runs the other", async () => {
	const h = probes({ env: { HOME, PATH: `${TOOLS}/pnpm/bin:/home/u/.local/share/mise/shims:/usr/bin` },
		files: [TOOLS_PNPM, "/home/u/.local/share/mise/shims/pi"], dirs: [HOME, PI_ROOT],
		results: { [`${TOOLS_PNPM} ${LIST}`]: { code: 0, stdout: listing({ [PI_PACKAGE]: { version: PI_INSTALL_VERSION, path: PI_ROOT } }) } } });
	assert.deepEqual(await h.probes.pi(), { available: true, version: PI_INSTALL_VERSION, usable: true });
	assert.equal(h.calls.some((call) => call.command.includes("mise")), false);
	assert.equal(planPreflight({ platform: "linux", arch: "x64", pi: await h.probes.pi() }).tools.pi.status, "reusable");
});

test("a Gentle Shell installed by npm reports its version and npm as its owner", async () => {
	for (const version of ["3.9.0", `${requirements.shell}-main.6e7e3a18f794`]) {
		assert.deepEqual(await outside(version).probes.shell(), { available: true, version, usable: true, global: true, owner: "npm" }, version);
	}
});

test("a Gentle Shell that npm links from a source checkout stays unknown and is never claimed by npm", async () => {
	assert.deepEqual(await outside("3.9.0", { linked: true }).probes.shell(), { available: null, outsidePnpm: true });
});

test("locateShell finds the installed Gentle Shell with its real root, version and owner", async () => {
	const stdout = listing({ "gentle-pi": { version: "3.9.0", path: SHELL_ROOT } });
	const pnpm = probes({ files: [TOOLS_PNPM], dirs: [HOME, SHELL_ROOT], results: { [`${TOOLS_PNPM} ${LIST}`]: { code: 0, stdout } } });
	assert.deepEqual(await pnpm.probes.locateShell(), { root: SHELL_ROOT, version: "3.9.0", owner: "pnpm" });
	assert.deepEqual(await outside("3.9.0").probes.locateShell(), { root: NPM_SHELL, version: "3.9.0", owner: "npm" });
	assert.deepEqual(await outside("3.9.0", { linked: true }).probes.locateShell(), { root: "/home/u/work/gentle-pi", version: "3.9.0", owner: null });
	assert.equal(await probes({ files: [TOOLS_PNPM], results: pnpmVersion }).probes.locateShell(), null);
});

test("Pi or Shell on the user's PATH but not pnpm-global is unknown, never absent, and says so", async () => {
	const h = probes({ files: [TOOLS_PNPM, "/usr/local/bin/pi", "/usr/local/bin/gentle-shell"],
		env: { HOME, PATH: `${TOOLS}/pnpm/bin:/usr/local/bin` }, results: pnpmVersion });
	assert.deepEqual(await h.probes.pi(), { available: null, outsidePnpm: true });
	assert.deepEqual(await h.probes.shell(), { available: null, outsidePnpm: true });
	assert.deepEqual(await h.probes.setup(), { available: null });
});

test("go version parsing, absence, devel builds and timeouts", async () => {
	const env = { HOME, PATH: "/usr/local/go/bin:/usr/bin" };
	for (const [stdout, version] of [["go version go1.26.0 linux/amd64\n", "1.26.0"], ["go version go1.22 linux/arm64", "1.22.0"]]) {
		const h = probes({ env, files: ["/usr/local/go/bin/go"], results: { "/usr/local/go/bin/go version": { code: 0, stdout } } });
		assert.deepEqual(await h.probes.go(), { available: true, version, usable: true });
	}
	for (const result of [{ code: 0, stdout: "go version devel go1.27-abc linux/amd64" }, { code: 0, stdout: "go version go1.26rc1 linux/amd64" },
		{ code: 0, timedOut: true, stdout: "go version go1.26.0 linux/amd64" }]) {
		const h = probes({ env, files: ["/usr/local/go/bin/go"], results: { "/usr/local/go/bin/go version": result } });
		assert.deepEqual(await h.probes.go(), { available: null });
	}
	assert.deepEqual(await probes({ env }).probes.go(), { available: false });
});

test("Windows PowerShell's PATHEXT with .CPL keeps resolving, and a .cpl found first is never run", async () => {
	// The wizard inherits the helper's environment, which Windows PowerShell 5.1
	// extends with .CPL. lookPath keeps PATH-then-PATHEXT order; spawnable refuses it.
	const env = { USERPROFILE: "C:\\Users\\u", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", Path: "C:\\Early;C:\\Go\\bin",
		PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL" };
	const go = "C:\\Go\\bin\\go.exe";
	const found = probes({ platform: "win32", env, files: [go], results: { [`${go} version`]: { code: 0, stdout: "go version go1.26.0 windows/amd64\r\n" } } });
	assert.deepEqual(await found.probes.go(), { available: true, version: "1.26.0", usable: true });
	for (const name of ["go", "node"] as const) {
		const shadowed = probes({ platform: "win32", env, files: [go, `C:\\Early\\${name}.cpl`, "C:\\Go\\bin\\node.exe"] });
		assert.deepEqual(await shadowed.probes[name](), { available: null }, name);
		assert.deepEqual(shadowed.calls, [], `${name}.cpl is never executed`);
	}
});

test("globalBin writability comes from the nearest existing ancestor of $PNPM_HOME/bin, without writing", async () => {
	const share = "/home/u/.local/share";
	assert.deepEqual(await probes({ dirs: [HOME, share], writable: [share] }).probes.globalBin(),
		{ available: true, path: BIN, writable: true, onPath: false });
	assert.equal((await probes({ dirs: [HOME, share], writable: [HOME] }).probes.globalBin()).writable, false);
	assert.equal((await probes({ dirs: [HOME, PNPM_HOME, BIN], writable: [BIN] }).probes.globalBin()).writable, true);
	assert.equal((await probes({ dirs: [HOME], others: [`${HOME}/.local`], writable: [HOME, `${HOME}/.local`] }).probes.globalBin()).writable, false);
	const onPath = await probes({ env: { HOME, PATH: `${BIN}:/usr/bin` }, dirs: [HOME, PNPM_HOME, BIN], writable: [BIN] }).probes.globalBin();
	assert.deepEqual(onPath, { available: true, path: BIN, writable: true, onPath: true });
	assert.deepEqual(await probes({ env: { PATH: "/usr/bin" } }).probes.globalBin(), { available: null });
	assert.deepEqual(await probes({ dirs: [], writable: [] }).probes.globalBin(), { available: null });
});

test("real probes feed collectInventory; a bootstrap-only clean Linux host plans runtime persistence", async () => {
	const h = probes({ files: [...bootstrapNode.files], realpaths: bootstrapNode.realpaths, texts: bootstrapNode.texts,
		dirs: [HOME, "/home/u/.local/share"], writable: ["/home/u/.local/share"],
		results: { ...bootstrapNode.results, [`${TOOLS_PNPM} --version`]: { code: 0, stdout: "11.1.1\n" }, ...pnpmVersion } });
	const inventory = await collectInventory({ platform: "linux", arch: "x64", probes: h.probes });
	assert.deepEqual(h.unexpected, []);
	const plan = planPreflight(inventory);
	assert.deepEqual(plan.blockers, []);
	assert.deepEqual(plan.actions.map((action: { id: string }) => action.id), ["setup-global-bin", "persist-node", "persist-package-managers",
		"configure-npm-prefix", "install-pi", "install-shell", "setup-shell", "verify-readiness"]);
	// Only fixed read-only argv ever runs: versions and the global listing.
	for (const call of h.calls) assert.match(call.args.join(" "), /^(--version|list -g --depth 0 --json)$/);
});

test("host adapters: argv without a shell, exit codes, deadlines and bounded output", async () => {
	const { run } = hostAdapters({ maxOutputBytes: 64 });
	const env = { PATH: process.env.PATH ?? "" };
	const ok = await run(process.execPath, ["-e", "process.stdout.write('ok $HOME')"], { env, deadlineMs: 10_000 });
	assert.deepEqual(ok, { code: 0, signal: null, timedOut: false, truncated: false, stdout: "ok $HOME" });
	assert.equal((await run(process.execPath, ["-e", "process.exit(3)"], { env, deadlineMs: 10_000 })).code, 3);
	const started = Date.now();
	const slow = await run(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { env, deadlineMs: 200 });
	assert.equal(slow.timedOut, true);
	assert.equal(slow.signal, "SIGKILL");
	assert.ok(Date.now() - started < 10_000);
	const big = await run(process.execPath, ["-e", "process.stdout.write('x'.repeat(5000))"], { env, deadlineMs: 10_000 });
	assert.equal(big.truncated, true);
	assert.equal(big.stdout.length, 64);
	const missing = await run(join(tmpdir(), "gentle-probe-missing-command"), [], { env, deadlineMs: 10_000 });
	assert.equal(missing.code, null);
	assert.equal(missing.timedOut, false);
});

test("host run runs in the requested working directory, and in the current one without it", async () => {
	const { run } = hostAdapters();
	const env = { PATH: process.env.PATH ?? "" };
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "gentle-probe-cwd-")));
	try {
		const inside = await run(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { env, cwd: directory, deadlineMs: 10_000 });
		assert.equal(inside.stdout, directory);
		const ambient = await run(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { env, deadlineMs: 10_000 });
		assert.equal(ambient.stdout, process.cwd());
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("host run discards stderr unless a bounded stderr tail is requested", async () => {
	const { run } = hostAdapters();
	const env = { PATH: process.env.PATH ?? "" };
	const noisy = "process.stderr.write('head-'.repeat(2000) + 'Error: tail line'); process.stdout.write('out'); process.exit(1)";
	const discarded = await run(process.execPath, ["-e", noisy], { env, deadlineMs: 10_000 });
	assert.deepEqual(discarded, { code: 1, signal: null, timedOut: false, truncated: false, stdout: "out" });
	const tailed = await run(process.execPath, ["-e", noisy], { env, deadlineMs: 10_000, stderrTail: 32 });
	assert.equal(tailed.code, 1);
	assert.equal(tailed.stdout, "out");
	assert.equal(tailed.stderrTail, `${"head-".repeat(2000)}Error: tail line`.slice(-32));
	const quiet = await run(process.execPath, ["-e", "process.exit(0)"], { env, deadlineMs: 10_000, stderrTail: 32 });
	assert.equal(quiet.stderrTail, "");
	// Larger requests are clamped to the 4-KiB ceiling; invalid ones keep stderr discarded.
	const clamped = await run(process.execPath, ["-e", noisy], { env, deadlineMs: 10_000, stderrTail: 1_000_000 });
	assert.equal(Buffer.byteLength(clamped.stderrTail), 4096);
	for (const stderrTail of [0, -1, 1.5, "32", null]) {
		assert.equal("stderrTail" in await run(process.execPath, ["-e", noisy], { env, deadlineMs: 10_000, stderrTail }), false, String(stderrTail));
	}
	const slow = await run(process.execPath, ["-e", "process.stderr.write('before kill'); setTimeout(() => {}, 30000)"], { env, deadlineMs: 500, stderrTail: 64 });
	assert.equal(slow.timedOut, true);
	assert.equal(slow.signal, "SIGKILL");
	assert.equal(slow.stderrTail, "before kill");
});

test("host fs adapter is read-only and bounded", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gentle-probes-fs-"));
	try {
		const { fs } = hostAdapters({ maxTextBytes: 16 });
		const file = join(dir, "small.txt");
		writeFileSync(file, "hello");
		writeFileSync(join(dir, "large.txt"), "x".repeat(64));
		mkdirSync(join(dir, "locked"));
		chmodSync(join(dir, "locked"), 0o500);
		symlinkSync(join(dir, "missing-target"), join(dir, "dangling"));
		assert.equal(await fs.isFile(file), true);
		assert.equal(await fs.isDirectory(dir), true);
		assert.equal(await fs.isFile(join(dir, "nope")), false);
		assert.equal(await fs.exists(join(dir, "dangling")), true);
		assert.equal(await fs.isDirectory(join(dir, "dangling")), false);
		assert.equal(await fs.exists(join(dir, "nope")), false);
		assert.equal(await fs.readText(file), "hello");
		await assert.rejects(fs.readText(join(dir, "large.txt")));
		assert.equal(await fs.writable(dir), true);
		// chmod 0o500 does not make a Windows directory read-only; root bypasses mode bits.
		if (process.platform !== "win32" && process.getuid?.() !== 0) assert.equal(await fs.writable(join(dir, "locked")), false);
		// The adapter uses the native realpath: Windows runners may expose %TEMP% as an
		// 8.3 short path (RUNNER~1) that only the native call expands to its long form.
		assert.equal(await fs.realpath(join(dir, ".", "small.txt")), realpathSync.native(file));
	} finally {
		chmodSync(join(dir, "locked"), 0o700);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("host run settles at the deadline even when the child's stdout never closes", async () => {
	const { EventEmitter } = await import("node:events");
	const killed: string[] = [];
	let destroyed = false;
	const stdout = Object.assign(new EventEmitter(), { destroy: () => { destroyed = true; } });
	// A child whose direct process ignores the kill and whose stdout stays open (as with a grandchild holding it).
	const child = Object.assign(new EventEmitter(), { stdout, stdin: null, stderr: null, kill: (signal: string) => { killed.push(signal); return true; } });
	const spawned: unknown[][] = [];
	const { run } = hostAdapters({ spawn: (...args: unknown[]) => { spawned.push(args); setTimeout(() => stdout.emit("data", Buffer.from("partial")), 5); return child; } });
	const started = Date.now();
	const result = await Promise.race([
		run("/fake/tool", ["--version"], { env: {}, deadlineMs: 50 }),
		new Promise((resolve) => setTimeout(() => resolve("still pending"), 2000)),
	]);
	assert.deepEqual(result, { code: null, signal: "SIGKILL", timedOut: true, truncated: false, stdout: "partial" });
	assert.ok(Date.now() - started < 1500);
	assert.deepEqual(killed, ["SIGKILL"]);
	assert.equal(destroyed, true);
	assert.deepEqual(spawned[0].slice(0, 2), ["/fake/tool", ["--version"]]);
	assert.equal((spawned[0][2] as { shell: boolean }).shell, false);
	// A late close after the deadline does not change the settled result.
	child.emit("close", 0, null);
});
