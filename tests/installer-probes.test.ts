import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
type Call = { command: string; args: string[]; env: Record<string, string>; deadlineMs: number };

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
		run: async (command: string, args: string[], options: { env: Record<string, string>; deadlineMs: number }) => {
			calls.push({ command, args, env: options.env, deadlineMs: options.deadlineMs });
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
		[`${USER_NODE} ${USER_NPM_CLI} --version`]: { code: 0, stdout: "10.9.2\n" } } as Record<string, Result>,
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

test("a node only inside the bootstrap tools directory is bootstrap-only and its npm does not count", async () => {
	const h = probes(bootstrapNode);
	assert.deepEqual(await h.probes.node(), { available: true, version: "24.18.0", usable: true, persistent: false, npm: false });
	assert.deepEqual(h.unexpected, []);
	assert.equal(h.calls.some((call) => call.args[0] === TOOLS_NPM_CLI), false);
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
	assert.deepEqual(await h.probes.shell(), { available: true, version: requirements.shell, usable: true, global: true });
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

test("Pi or Shell on the user's PATH but not pnpm-global is unknown, never absent", async () => {
	const h = probes({ files: [TOOLS_PNPM, "/usr/local/bin/pi", "/usr/local/bin/gentle-shell"],
		env: { HOME, PATH: `${TOOLS}/pnpm/bin:/usr/local/bin` }, results: pnpmVersion });
	assert.deepEqual(await h.probes.pi(), { available: null });
	assert.deepEqual(await h.probes.shell(), { available: null });
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
