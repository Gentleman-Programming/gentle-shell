import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gentleAiBinaryPath } from "../runtime/gentle-ai-binary.mjs";
import { persistencePins, planPreflight, requirements } from "../scripts/installer-preflight.mjs";
import {
	PI_INSTALL_VERSION,
	PI_PACKAGE as PI_PACKAGE_NAME,
	blockedReasons,
	failedSteps,
	packageNativeGentleAi,
	runStandardInstall as runUnobserved,
	setupErrorDetail,
} from "../scripts/installer-runner.mjs";

// Every scenario below runs through this wrapper, which records the blocked
// reasons and failed steps the runner actually returns.
const observed = { reasons: new Set<string>(), steps: new Set<string>() };
async function runStandardInstall(...args: Parameters<typeof runUnobserved>) {
	const result = await runUnobserved(...args);
	if (result.outcome === "blocked") observed.reasons.add(result.reason);
	if (result.outcome === "failed") observed.steps.add(result.failedStep);
	return result;
}

const HOME = "/home/u";
const PNPM_HOME = "/home/u/.local/share/pnpm";
const BIN = `${PNPM_HOME}/bin`;
const NODE = "/opt/node/bin/node";
const ENTRY = "/tools/pnpm/bin/pnpm.mjs";
const NPM_CLI = "/opt/node/lib/node_modules/npm/bin/npm-cli.js";
const PACKAGE_ROOT = `${PNPM_HOME}/global/v11/node_modules/gentle-pi`;
const SHELL_ENTRY = `${PACKAGE_ROOT}/bin/gentle-shell.mjs`;

const W_NODE_DIR = "C:\\Program Files\\nodejs";
const W_NODE = `${W_NODE_DIR}\\node.exe`;
const W_ENTRY = "C:\\Tools\\pnpm\\bin\\pnpm.mjs";
const W_NPM_CMD = `${W_NODE_DIR}\\npm.cmd`;
const W_NPM_CLI = `${W_NODE_DIR}\\node_modules\\npm\\bin\\npm-cli.js`;
const W_PNPM_HOME = "C:\\Users\\u\\AppData\\Local\\pnpm";
const W_BIN = `${W_PNPM_HOME}\\bin`;
const W_ROOT = `${W_PNPM_HOME}\\global\\v11\\node_modules\\gentle-pi`;

// Runtime persisted through pnpm: node in $PNPM_HOME/bin plus a pnpm-global npm shim.
const PERSISTENT_NODE = `${BIN}/node`;
const PM_NPM_DIR = `${PNPM_HOME}/global/v11/abc/node_modules/npm`;
const PM_NPM_CLI = `${PM_NPM_DIR}/bin/npm-cli.js`;
const STORE = `${PNPM_HOME}/store`;
// `pnpm store path` reports the versioned store directory.
const STORE_PATH = `${STORE}/v11`;
const STORE_PREFIX = `${STORE_PATH}/links/node/24.21.0/hash`;
const PM_PNPM_DIR = `${PNPM_HOME}/global/v11/abc/node_modules/pnpm`;
const PM_PNPM_ENTRY = `${PM_PNPM_DIR}/bin/pnpm.mjs`;
const POSIX_SHIM = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")
if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/../global/v11/abc/node_modules/npm/bin/npm-cli.js" "$@"
else
  exec node  "$basedir/../global/v11/abc/node_modules/npm/bin/npm-cli.js" "$@"
fi
`;
const POSIX_PNPM_SHIM = POSIX_SHIM.replaceAll("npm/bin/npm-cli.js", "pnpm/bin/pnpm.mjs");
const W_PERSISTENT_NODE = `${W_BIN}\\node.exe`;
const W_PM_PNPM_DIR = `${W_PNPM_HOME}\\global\\v11\\abc\\node_modules\\pnpm`;
const W_PM_PNPM_ENTRY = `${W_PM_PNPM_DIR}\\bin\\pnpm.mjs`;
const W_PM_NPM_DIR = `${W_PNPM_HOME}\\global\\v11\\abc\\node_modules\\npm`;
const W_PM_NPM_CLI = `${W_PM_NPM_DIR}\\bin\\npm-cli.js`;
const W_STORE = `${W_PNPM_HOME}\\store`;
const W_STORE_PATH = `${W_STORE}\\v11`;
const W_STORE_PREFIX = `${W_STORE_PATH}\\links\\node\\24.21.0\\hash`;
const WINDOWS_SHIM = `@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\..\\global\\v11\\abc\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n) ELSE (\r\n  node  "%~dp0\\..\\global\\v11\\abc\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n)\r\n`;

type Call = { command: string; args: string[]; env: Record<string, string>; deadlineMs: number; stderrTail?: number };
type Result = { code: number | null; signal?: string | null; timedOut?: boolean; stdout?: string; stderrTail?: string };
type Layout = { platform: string; node: string; entry: string; npmCli: string; shellEntry: string; bin: string;
	root: string; env: Record<string, string>; files: string[]; realpaths: Record<string, string>; texts: Record<string, string>;
	persistentNode: string; pmNpmCli: string; pmPnpmEntry: string; pmHome: string; storePath: string; storePrefix: string;
	creates: Record<string, string[]> };

const npmPackage = JSON.stringify({ name: "npm", version: "11.19.0" });
const pnpmPackage = JSON.stringify({ name: "pnpm", version: "11.1.1" });
const posixLayout: Layout = {
	platform: "linux", node: NODE, entry: ENTRY, npmCli: NPM_CLI, shellEntry: SHELL_ENTRY, bin: BIN, root: PACKAGE_ROOT,
	env: { HOME, PATH: `${BIN}:/opt/node/bin:/usr/bin`, GENTLE_INSTALL_PNPM_NODE: NODE, GENTLE_INSTALL_PNPM_ENTRY: ENTRY },
	files: ["/opt/node/bin/npm", NPM_CLI, `${BIN}/gentle-shell`],
	realpaths: { "/opt/node/bin/npm": NPM_CLI, [PNPM_HOME]: PNPM_HOME, [PACKAGE_ROOT]: PACKAGE_ROOT,
		[`${BIN}/npm`]: `${BIN}/npm`, [PM_NPM_CLI]: PM_NPM_CLI, [STORE]: STORE, [STORE_PATH]: STORE_PATH, [STORE_PREFIX]: STORE_PREFIX,
		[`${BIN}/pnpm`]: `${BIN}/pnpm`, [PM_PNPM_ENTRY]: PM_PNPM_ENTRY },
	texts: { "/opt/node/lib/node_modules/npm/package.json": npmPackage, [`${BIN}/npm`]: POSIX_SHIM,
		[`${PM_NPM_DIR}/package.json`]: npmPackage, [`${BIN}/pnpm`]: POSIX_PNPM_SHIM, [`${PM_PNPM_DIR}/package.json`]: pnpmPackage },
	persistentNode: PERSISTENT_NODE, pmNpmCli: PM_NPM_CLI, pmPnpmEntry: PM_PNPM_ENTRY, pmHome: PNPM_HOME, storePath: STORE_PATH,
	storePrefix: STORE_PREFIX,
	creates: { "runtime set node 24.21.0 -g": [PERSISTENT_NODE], "add-pm": [`${BIN}/npm`, PM_NPM_CLI, `${BIN}/pnpm`, PM_PNPM_ENTRY],
		"add-npm": [`${BIN}/npm`, PM_NPM_CLI], "add-pnpm": [`${BIN}/pnpm`, PM_PNPM_ENTRY] },
};
// The user's Path already holds the global bin, spelled with different case.
const windowsLayout: Layout = {
	platform: "win32", node: W_NODE, entry: W_ENTRY, npmCli: W_NPM_CLI, shellEntry: `${W_ROOT}\\bin\\gentle-shell.mjs`,
	bin: W_BIN, root: W_ROOT,
	env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", USERPROFILE: "C:\\Users\\u",
		Path: `c:\\users\\u\\appdata\\local\\PNPM\\bin\\;${W_NODE_DIR};C:\\Windows`,
		GENTLE_INSTALL_PNPM_NODE: W_NODE, GENTLE_INSTALL_PNPM_ENTRY: W_ENTRY },
	files: [W_NPM_CMD, W_NPM_CLI, `${W_BIN}\\gentle-shell.cmd`],
	realpaths: { [W_PNPM_HOME]: W_PNPM_HOME, [W_ROOT]: W_ROOT, [W_PM_NPM_CLI]: W_PM_NPM_CLI, [W_STORE]: W_STORE,
		[W_STORE_PATH]: W_STORE_PATH, [W_STORE_PREFIX]: W_STORE_PREFIX, [W_PM_PNPM_ENTRY]: W_PM_PNPM_ENTRY },
	texts: { [`${W_NODE_DIR}\\node_modules\\npm\\package.json`]: npmPackage, [`${W_BIN}\\npm.cmd`]: WINDOWS_SHIM,
		[`${W_PM_NPM_DIR}\\package.json`]: npmPackage,
		[`${W_BIN}\\pnpm.cmd`]: WINDOWS_SHIM.replaceAll("npm\\bin\\npm-cli.js", "pnpm\\bin\\pnpm.mjs"),
		[`${W_PM_PNPM_DIR}\\package.json`]: pnpmPackage },
	persistentNode: W_PERSISTENT_NODE, pmNpmCli: W_PM_NPM_CLI, pmPnpmEntry: W_PM_PNPM_ENTRY,
	pmHome: W_PNPM_HOME, storePath: W_STORE_PATH, storePrefix: W_STORE_PREFIX,
	creates: { "runtime set node 24.21.0 -g": [W_PERSISTENT_NODE], "add-pm": [`${W_BIN}\\npm.cmd`, W_PM_NPM_CLI],
		"add-pnpm": [`${W_BIN}\\pnpm.cmd`, W_PM_PNPM_ENTRY] },
};

const absent = { available: false };
const tool = (version: string) => ({ available: true, version, usable: true });
function plan(platform = "linux", change: object = {}) {
	return planPreflight({ platform, arch: "x64", node: tool("24.18.0"), pnpm: { ...tool("11.1.1"), compatible: true },
		pi: absent, shell: absent, gentleAi: absent, go: platform === "win32" ? tool("1.26.0") : absent,
		globalBin: { available: true, path: BIN, writable: true, onPath: true }, setup: false, ...change });
}
function listing(pi = PI_INSTALL_VERSION, shell = requirements.shell, path = PACKAGE_ROOT) {
	return JSON.stringify([{ path: `${PNPM_HOME}/global/v11`, dependencies: {
		"@earendil-works/pi-coding-agent": { version: pi },
		"gentle-pi": { version: shell, path },
	} }]);
}

// The same response key may hold a sequence: the first list -g precedes installation.
const LIST = "list -g --depth 0 --json";
const emptyList = { code: 0, stdout: "[]" };

function harness({ env = {}, results = {}, files = [] as string[], integrity = { ok: true } as object, layout = posixLayout,
	realpaths: extraRealpaths = {} as Record<string, string>, texts: extraTexts = {} as Record<string, string>,
	creates = layout.creates } = {}) {
	const calls: Call[] = [];
	const logs: object[] = [];
	const fileSet = new Set([...layout.files, ...files]);
	const realpaths = { ...layout.realpaths, ...extraRealpaths };
	const texts = { ...layout.texts, ...extraTexts };
	const defaults: Record<string, Result | Result[]> = {
		"--version": { code: 0, stdout: "11.19.0\n" },
		"bin -g": { code: 0, stdout: `${layout.bin}\n` },
		add: { code: 0 },
		[LIST]: [emptyList, { code: 0, stdout: listing(PI_INSTALL_VERSION, requirements.shell, layout.root) }],
		"gentle-shell setup": { code: 0 },
		"pnpm setup": { code: 0 },
		"runtime set node 24.21.0 -g": { code: 0 },
		"add-pm": { code: 0 },
		"add-npm": { code: 0 },
		"add-pnpm": { code: 0 },
		"store path": { code: 0, stdout: `${layout.storePath}\n` },
		"pm-pnpm --version": { code: 0, stdout: "11.1.1\n" },
		"persistent-node --version": { code: 0, stdout: "v24.21.0\n" },
		"pm-npm --version": { code: 0, stdout: "11.19.0\n" },
		"pm-npm config get prefix": [{ code: 0, stdout: `${layout.storePrefix}\n` }, { code: 0, stdout: `${layout.pmHome}\n` }],
		[`pm-npm config set prefix ${layout.pmHome} --location=user`]: { code: 0 },
	};
	const responses = { ...defaults, ...results } as Record<string, Result | Result[]>;
	const seen: Record<string, number> = {};
	function key(command: string, args: string[]) {
		if (command === layout.node && args[0] === layout.npmCli) return args.slice(1).join(" ");
		if (args[0] === layout.pmNpmCli) return `pm-npm ${args.slice(1).join(" ")}`;
		if (args[0] === layout.pmPnpmEntry) return `pm-pnpm ${args.slice(1).join(" ")}`;
		if (command === layout.persistentNode) return `persistent-node ${args.join(" ")}`;
		if (command === layout.node && args[0] === layout.shellEntry) return `gentle-shell ${args.slice(1).join(" ")}`;
		const rest = command === layout.node && args[0] === layout.entry ? args.slice(1) : args;
		if (rest[0] === "add") return ({ [PM_ADD]: "add-pm", [NPM_ADD]: "add-npm", [PNPM_ADD]: "add-pnpm" } as Record<string, string>)[rest.join(" ")] ?? "add";
		if (rest.join(" ") === "setup") return "pnpm setup";
		return rest.join(" ");
	}
	const integrityCalls: object[] = [];
	const adapters = {
		platform: layout.platform,
		nodePath: layout.node,
		env: { ...layout.env, ...env } as Record<string, string>,
		run: async (command: string, args: string[], options: { env: Record<string, string>; deadlineMs: number; stderrTail?: number }) => {
			calls.push({ command, args, env: options.env, deadlineMs: options.deadlineMs,
				...(options.stderrTail === undefined ? {} : { stderrTail: options.stderrTail }) });
			const k = key(command, args);
			const entry = responses[k];
			assert.ok(entry, `unexpected command ${command} ${args.join(" ")}`);
			const index = seen[k] ?? 0;
			seen[k] = index + 1;
			const response = Array.isArray(entry) ? entry[Math.min(index, entry.length - 1)] : entry;
			if (response.code === 0) for (const file of creates[k] ?? []) fileSet.add(file);
			return { signal: null, timedOut: false, stdout: "", stderr: "", ...response };
		},
		fs: {
			isFile: async (path: string) => fileSet.has(path),
			realpath: async (path: string) => {
				if (!(path in realpaths)) throw new Error(`ENOENT ${path}`);
				return realpaths[path];
			},
			readText: async (path: string) => {
				if (!(path in texts)) throw new Error(`ENOENT ${path}`);
				return texts[path];
			},
		},
		verifyGentleAi: async (request: object) => {
			integrityCalls.push(request);
			return integrity;
		},
		log: (entry: object) => logs.push(entry),
	};
	const pnpmCalls = () => calls.filter((call) => call.args[0] === layout.entry).map((call) => call.args.slice(1).join(" "));
	return { adapters, calls, logs, pnpmCalls, integrityCalls };
}

const INSTALL = `add -g @earendil-works/pi-coding-agent@${PI_INSTALL_VERSION} gentle-pi@${requirements.shell} --allow-build=gentle-pi`;
const PM_ADD = "add -g npm@11.19.0 pnpm@11.1.1";
const NPM_ADD = "add -g npm@11.19.0";
const PNPM_ADD = "add -g pnpm@11.1.1";
const RUNTIME_SET = "runtime set node 24.21.0 -g";

test("declined or missing consent runs no commands", async () => {
	for (const consent of [false, undefined, "yes", 1]) {
		const h = harness();
		const result = await runStandardInstall({ plan: plan(), consent }, h.adapters);
		assert.equal(result.outcome, "blocked");
		assert.equal(result.reason, "consent-required");
		assert.deepEqual(h.calls, []);
	}
});

test("caller-supplied commands, URLs, roots or env are rejected before any command", async () => {
	const base = plan();
	const injected = [
		{ plan: base, consent: true, commands: [["rm", "-rf", "/"]] },
		{ plan: base, consent: true, env: { PATH: "/evil" } },
		{ plan: { ...base, commands: ["curl https://example.invalid"] }, consent: true },
		{ plan: { ...base, actions: [...base.actions, { id: "run", kind: "exec", target: "sh", command: "sh" }] }, consent: true },
		{ plan: { ...base, actions: base.actions.map((a: object) => ({ ...a, url: "https://example.invalid" })) }, consent: true },
		{ plan: { ...base, actions: base.actions.map((a: { id: string }) => a.id === "install-shell" ? { ...a, version: "9.9.9" } : a) }, consent: true },
		{ plan: { ...base, root: "/elsewhere" }, consent: true },
		null,
	];
	for (const request of injected) {
		const h = harness();
		const result = await runStandardInstall(request, h.adapters);
		assert.equal(result.outcome, "blocked");
		assert.equal(result.reason, "invalid-request");
		assert.deepEqual(h.calls, []);
	}
});

test("preflight blockers and unsupported T4 plans are blocked before any command", async () => {
	const cases = [
		plan("linux", { node: tool("20.0.0") }),
		plan("linux", { node: absent }),
		// (Pi present with Shell missing is the shell-only installation, covered below.)
		plan("linux", { pi: tool("1.2.0"), shell: { ...tool("4.0.0"), global: true } }),
	];
	for (const fixed of cases) {
		const h = harness();
		const result = await runStandardInstall({ plan: fixed, consent: true }, h.adapters);
		assert.equal(result.outcome, "blocked");
		assert.match(result.reason, /^(preflight-blocked|unsupported-plan)$/);
		assert.deepEqual(h.calls, []);
	}
});

test("Windows without suitable Go is blocked before install", async () => {
	// Missing Go yields an acquire-go intent; too-old Go is already a preflight blocker.
	for (const [go, reason] of [[absent, "go-required"], [tool("1.25.9"), "preflight-blocked"]] as const) {
		const h = harness({ layout: windowsLayout });
		const result = await runStandardInstall({ plan: plan("win32", { go }), consent: true }, h.adapters);
		assert.equal(result.outcome, "blocked");
		assert.equal(result.reason, reason);
		assert.deepEqual(h.calls, []);
	}
});

test("Windows uses the case-insensitive Path key for the child env and bin -g comparison", async () => {
	const h = harness({ layout: windowsLayout, results: { "bin -g": { code: 0, stdout: "c:\\users\\u\\appdata\\local\\PNPM\\BIN\\\r\n" } } });
	const result = await runStandardInstall({ plan: plan("win32"), consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.ok(h.calls.length > 0);
	for (const call of h.calls) {
		assert.equal(call.env.PATH, undefined);
		assert.equal(call.env.PNPM_HOME, W_PNPM_HOME);
		assert.equal(call.env.Path.split(";")[0], W_BIN);
	}
	assert.deepEqual(h.calls.at(-1)?.args, [`${W_ROOT}\\bin\\gentle-shell.mjs`, "setup"]);
	const missing = harness({ layout: windowsLayout, env: { Path: `${W_NODE_DIR};C:\\Windows` } });
	const persisted = await runStandardInstall({ plan: plan("win32"), consent: true }, missing.adapters);
	assert.equal(persisted.outcome, "terminal-action-required");
	assert.equal(missing.pnpmCalls().at(-1), "setup");
});

test("Windows npm resolves like Go exec.LookPath: PATH order, then PATHEXT order", async () => {
	const shadows = [
		{ files: [`${W_NODE_DIR}\\npm.exe`] },
		{ files: [`${W_NODE_DIR}\\npm.bat`] },
		{ files: [`${W_NODE_DIR}\\npm.com`] },
		{ files: ["C:\\Early\\npm.exe"], env: { Path: `C:\\Early;${W_NODE_DIR}` } },
		{ files: [`${W_NODE_DIR}\\npm.ps1`, `${W_NODE_DIR}\\npm.exe`], env: { PathExt: ".PS1;.CMD" } },
	];
	for (const { files, env } of shadows) {
		const h = harness({ layout: windowsLayout, files, env });
		const result = await runStandardInstall({ plan: plan("win32"), consent: true }, h.adapters);
		assert.equal(result.outcome, "blocked");
		assert.equal(result.reason, "npm-shadowed");
		assert.equal(h.pnpmCalls().some((call) => call.startsWith("add")), false);
	}
	const fake = harness({ layout: windowsLayout, files: ["C:\\Early\\npm.cmd"], env: { Path: `C:\\Early;${W_NODE_DIR}` } });
	assert.equal((await runStandardInstall({ plan: plan("win32"), consent: true }, fake.adapters)).reason, "npm-unavailable");
	// PATHEXT order wins inside one directory: .CMD before .EXE resolves the genuine npm.cmd.
	const ordered = harness({ layout: windowsLayout, files: [`${W_NODE_DIR}\\npm.exe`], env: { PATHEXT: "cmd;.EXE" } });
	assert.equal((await runStandardInstall({ plan: plan("win32"), consent: true }, ordered.adapters)).outcome, "ready");
	const noCmd = harness({ layout: windowsLayout, env: { PATHEXT: ".EXE;.COM" } });
	assert.equal((await runStandardInstall({ plan: plan("win32"), consent: true }, noCmd.adapters)).reason, "npm-unavailable");
	// Windows PowerShell 5.1 appends .CPL, and the wizard inherits that environment.
	// .CPL is resolved in its PATHEXT place like any other extension, never skipped.
	const powershell = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL";
	const cpl = harness({ layout: windowsLayout, env: { PATHEXT: powershell } });
	assert.equal((await runStandardInstall({ plan: plan("win32"), consent: true }, cpl.adapters)).outcome, "ready");
	const cplShadow = harness({ layout: windowsLayout, files: ["C:\\Early\\npm.cpl"], env: { PATHEXT: powershell, Path: `C:\\Early;${W_NODE_DIR}` } });
	const shadowed = await runStandardInstall({ plan: plan("win32"), consent: true }, cplShadow.adapters);
	assert.equal(shadowed.reason, "npm-shadowed");
	assert.equal(cplShadow.pnpmCalls().some((call) => call.startsWith("add")), false);
});

test("Windows without the direct pnpm handoff is blocked rather than spawning a .cmd shim", async () => {
	const h = harness({ env: { GENTLE_INSTALL_PNPM_NODE: "", GENTLE_INSTALL_PNPM_ENTRY: "" } });
	h.adapters.platform = "win32";
	h.adapters.env = { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", Path: "C:\\Windows" };
	const result = await runStandardInstall({ plan: plan("win32"), consent: true }, h.adapters);
	assert.equal(result.outcome, "blocked");
	assert.equal(result.reason, "pnpm-unavailable");
	assert.deepEqual(h.calls, []);
});

test("missing or impersonated npm blocks before installation", async () => {
	const variants = [
		(h: ReturnType<typeof harness>) => { h.adapters.env.PATH = `${BIN}:/usr/bin`; },
		(h: ReturnType<typeof harness>) => { h.adapters.fs.realpath = async () => "/opt/fake/npm-wrapper.sh"; },
		(h: ReturnType<typeof harness>) => { h.adapters.fs.readText = async () => JSON.stringify({ name: "not-npm", version: "1.0.0" }); },
	];
	for (const vary of variants) {
		const h = harness();
		vary(h);
		const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
		assert.equal(result.outcome, "blocked");
		assert.equal(result.reason, "npm-unavailable");
		assert.equal(h.pnpmCalls().some((call) => call.startsWith("add")), false);
	}
	const lying = harness({ results: { "--version": { code: 0, stdout: "10.0.0\n" } } });
	assert.equal((await runStandardInstall({ plan: plan(), consent: true }, lying.adapters)).reason, "npm-unavailable");
	assert.equal(lying.pnpmCalls().some((call) => call.startsWith("add")), false);
});

test("verified clean install runs one exact add -g with a package-scoped build approval", async () => {
	const h = harness();
	const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.deepEqual(h.pnpmCalls(), ["bin -g", LIST, INSTALL, LIST]);
	const adds = h.calls.filter((call) => call.args[1] === "add");
	assert.equal(adds.length, 1);
	assert.equal(adds[0].args.some((arg) => /dangerously|allow-build=\*|--allow-build$|approve-builds/.test(arg)), false);
	assert.equal(adds[0].command, NODE);
	assert.deepEqual(h.calls.at(-1)?.args, [SHELL_ENTRY, "setup"]);
	assert.deepEqual(result.completed, ["check-npm", "check-global-bin", "check-existing-stack", "install-global",
		"verify-global-list", "verify-shell-bin", "verify-gentle-ai", "shell-setup"]);
	assert.deepEqual(h.integrityCalls, [{ packageRoot: PACKAGE_ROOT, platform: "linux", env: h.adapters.env, home: HOME }]);
	assert.equal(JSON.stringify(h.logs).includes("11.19.0"), false);
});

test("every child env has PNPM_HOME and $PNPM_HOME/bin first on PATH", async () => {
	const h = harness({ env: { PATH: "/opt/node/bin:/usr/bin" } });
	await runStandardInstall({ plan: plan("linux", { globalBin: { available: true, path: BIN, writable: true, onPath: false } }), consent: true }, h.adapters);
	assert.ok(h.calls.length > 0);
	for (const call of h.calls) {
		assert.equal(call.env.PNPM_HOME, PNPM_HOME);
		assert.equal(call.env.PATH.split(":")[0], BIN);
		assert.ok(call.deadlineMs > 0);
	}
	assert.equal(h.adapters.env.PNPM_HOME, undefined);
});

test("bin -g mismatch or failure is blocked before installation", async () => {
	for (const result of [{ code: 0, stdout: `${PNPM_HOME}\n` }, { code: 1, stdout: "" }, { code: 0, stdout: "/elsewhere/bin\n" }]) {
		const h = harness({ results: { "bin -g": result } });
		const outcome = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
		assert.equal(outcome.outcome, "blocked");
		assert.equal(outcome.reason, "global-bin-mismatch");
		assert.equal(h.pnpmCalls().some((call) => call.startsWith("add")), false);
	}
});

test("install nonzero, signal or deadline fails and reports completed steps", async () => {
	for (const add of [{ code: 1 }, { code: null, signal: "SIGKILL" }, { code: 0, timedOut: true }]) {
		const h = harness({ results: { add } });
		const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
		assert.equal(result.outcome, "failed");
		assert.equal(result.failedStep, "install-global");
		assert.deepEqual(result.completed, ["check-npm", "check-global-bin", "check-existing-stack"]);
		assert.equal(h.pnpmCalls().length, 3);
	}
});

test("an existing global Pi or gentle-pi blocks before installation regardless of the plan", async () => {
	const existing = [
		listing(),
		JSON.stringify([{ dependencies: { "@earendil-works/pi-coding-agent": { version: "1.2.0" } } }]),
		JSON.stringify([{ dependencies: {} }, { dependencies: { "gentle-pi": { version: "3.0.0" } } }]),
		JSON.stringify([{ optionalDependencies: { "gentle-pi": { version: "4.0.0" } } }]),
	];
	for (const stdout of existing) {
		const h = harness({ results: { [LIST]: { code: 0, stdout } } });
		const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
		assert.equal(result.outcome, "blocked");
		assert.equal(result.reason, "existing-stack");
		assert.equal(h.pnpmCalls().some((call) => call.startsWith("add")), false);
	}
	const unrelated = harness({ results: { [LIST]: [{ code: 0, stdout: JSON.stringify([{ dependencies: { typescript: { version: "5.0.0" } } }]) },
		{ code: 0, stdout: listing() }] } });
	assert.equal((await runStandardInstall({ plan: plan(), consent: true }, unrelated.adapters)).outcome, "ready");
});

test("a failed or unparseable pre-install global list blocks before mutation", async () => {
	for (const list of [{ code: 1, stdout: "[]" }, { code: 0, timedOut: true, stdout: "[]" }, { code: 0, stdout: "not json" },
		{ code: 0, stdout: "" }, { code: 0, stdout: "{}" }, { code: 0, stdout: JSON.stringify([{ dependencies: [] }]) }]) {
		const h = harness({ results: { [LIST]: list } });
		const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
		assert.equal(result.outcome, "blocked");
		assert.equal(result.reason, "global-list-unavailable");
		assert.deepEqual(h.pnpmCalls(), ["bin -g", LIST]);
	}
});

test("global list missing a package, wrong version or unconfined path fails", async () => {
	const listings = [
		JSON.stringify([{ dependencies: { "gentle-pi": { version: requirements.shell, path: PACKAGE_ROOT } } }]),
		listing("0.99.1"),
		listing(PI_INSTALL_VERSION, "3.0.0"),
		listing(PI_INSTALL_VERSION, requirements.shell, "/elsewhere/gentle-pi"),
		"not json",
	];
	for (const stdout of listings) {
		const h = harness({ results: { [LIST]: [emptyList, { code: 0, stdout }] } });
		const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
		assert.equal(result.outcome, "failed");
		assert.equal(result.failedStep, "verify-global-list");
		assert.equal(h.calls.some((call) => call.args[0] === SHELL_ENTRY), false);
	}
});

test("missing gentle-shell bin in $PNPM_HOME/bin fails", async () => {
	const h = harness();
	h.adapters.fs.isFile = async (path: string) => path !== `${BIN}/gentle-shell` && [NPM_CLI, "/opt/node/bin/npm"].includes(path);
	const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
	assert.equal(result.outcome, "failed");
	assert.equal(result.failedStep, "verify-shell-bin");
});

test("integrity failure or development override fails before setup", async () => {
	for (const integrity of [{ ok: false, reason: "package-local-binary-missing" }, { ok: false, reason: "development-override" }, {}]) {
		const h = harness({ integrity });
		const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
		assert.equal(result.outcome, "failed");
		assert.equal(result.failedStep, "verify-gentle-ai");
		assert.equal(h.calls.some((call) => call.args[0] === SHELL_ENTRY), false);
	}
});

test("gentle-shell setup nonzero, signal or deadline fails", async () => {
	for (const setup of [{ code: 2 }, { code: null, signal: "SIGTERM" }, { code: 0, timedOut: true }]) {
		const h = harness({ results: { "gentle-shell setup": setup } });
		const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
		assert.equal(result.outcome, "failed");
		assert.equal(result.failedStep, "shell-setup");
		assert.ok(result.completed.includes("verify-gentle-ai"));
	}
});

test("a failed gentle-shell setup reports its last error line as a sanitized detail", async () => {
	const stderrTail = `fetching engram\n\u001b[31mError: execute install pipeline: download engram binary: fetch latest engram version: GitHub API returned HTTP 403\u001b[0m (${HOME}/.gentle-shell/agent)\ninstalled via go install\n`;
	const h = harness({ results: { "gentle-shell setup": { code: 1, stderrTail } } });
	const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
	assert.equal(result.outcome, "failed");
	assert.equal(result.failedStep, "shell-setup");
	assert.equal(result.detail, "Error: execute install pipeline: download engram binary: fetch latest engram version: GitHub API returned HTTP 403 (~/.gentle-shell/agent)");
	// Only the setup child gets its stderr tail captured; every other command keeps stderr discarded.
	assert.deepEqual(h.calls.filter((call) => call.stderrTail !== undefined).map((call) => [call.args, call.stderrTail]), [[[SHELL_ENTRY, "setup"], 4096]]);
	for (const setup of [{ code: 2 }, { code: 2, stderrTail: " \n\t\n" }]) {
		const silent = await runStandardInstall({ plan: plan(), consent: true }, harness({ results: { "gentle-shell setup": setup } }).adapters);
		assert.equal(silent.failedStep, "shell-setup");
		assert.equal("detail" in silent, false);
	}
	const succeeded = await runStandardInstall({ plan: plan(), consent: true }, harness({ results: { "gentle-shell setup": { code: 0, stderrTail: "Error: ignored" } } }).adapters);
	assert.equal(succeeded.outcome, "ready");
	assert.equal("detail" in succeeded, false);
	// Only shell-setup carries a detail, never an earlier failed step.
	const early = await runStandardInstall({ plan: plan(), consent: true }, harness({ results: { add: { code: 1, stderrTail: "Error: x" } } }).adapters);
	assert.equal(early.failedStep, "install-global");
	assert.equal("detail" in early, false);
});

// Observed with pnpm 11.1.1 and no SHELL: the error goes to stdout after the global CLI install output.
const PNPM_SETUP_NO_SHELL = `Installing pnpm CLI globally from /usr/bin\nProgress: resolved 1, reused 1, downloaded 0, added 1, done\n[WARN] Failed to create bin at ${HOME}/.local/share/pnpm/bin/pnpm.\n\nDone in 393ms using pnpm v11.1.1\n[ERR_PNPM_UNKNOWN_SHELL] Could not infer shell type.\n\nSet the SHELL environment variable to your active shell.\nSupported shell languages are bash, zsh, fish, ksh, dash, sh, and nushell.\n`;

test("a failed pnpm setup reports its error line from stderr, else from stdout", async () => {
	const noPath = { PATH: "/opt/node/bin:/usr/bin" };
	const h = harness({ env: noPath, results: { "pnpm setup": { code: 1, stdout: PNPM_SETUP_NO_SHELL, stderrTail: "" } } });
	const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
	assert.equal(result.failedStep, "persist-path");
	assert.equal(result.detail, "[ERR_PNPM_UNKNOWN_SHELL] Could not infer shell type.");
	// Both fixed setup commands, and only they, request the same bounded stderr tail.
	assert.deepEqual(h.calls.filter((call) => call.stderrTail !== undefined).map((call) => [call.args.at(-1), call.stderrTail]), [["setup", 4096], ["setup", 4096]]);
	const stderr = await runStandardInstall({ plan: plan(), consent: true }, harness({ env: noPath,
		results: { "pnpm setup": { code: 1, stdout: PNPM_SETUP_NO_SHELL, stderrTail: "Error: EACCES: permission denied, open '/home/u/.bashrc'\n" } } }).adapters);
	assert.equal(stderr.detail, "Error: EACCES: permission denied, open '~/.bashrc'");
	const silent = await runStandardInstall({ plan: plan(), consent: true }, harness({ env: noPath, results: { "pnpm setup": { code: 1 } } }).adapters);
	assert.equal(silent.failedStep, "persist-path");
	assert.equal("detail" in silent, false);
	const passed = await runStandardInstall({ plan: plan(), consent: true }, harness({ env: noPath, results: { "pnpm setup": { code: 0, stdout: PNPM_SETUP_NO_SHELL } } }).adapters);
	assert.equal(passed.outcome, "terminal-action-required");
	assert.equal("detail" in passed, false);
});

test("setup error detail picks the last Error line, else the last line, bounded and without control characters", () => {
	assert.equal(setupErrorDetail(PNPM_SETUP_NO_SHELL, HOME, "linux"), "[ERR_PNPM_UNKNOWN_SHELL] Could not infer shell type.", "pnpm error codes count as error lines");
	assert.equal(setupErrorDetail("Error: first\nmore\nError: second\ntrailer\n", HOME, "linux"), "Error: second");
	assert.equal(setupErrorDetail("one\r\ntwo\r\n\r\n", HOME, "linux"), "two");
	assert.equal(setupErrorDetail(`bad\u0000\u0007 \u009b31mtext\u001b]0;title\u0007 at ${HOME}/x and ${HOME}`, HOME, "linux"), "bad text at ~/x and ~");
	assert.equal(setupErrorDetail("x".repeat(500), HOME, "linux")?.length, 300);
	assert.equal(setupErrorDetail("C:\\USERS\\U\\.gentle-shell failed", "C:\\Users\\u", "win32"), "~\\.gentle-shell failed");
	assert.equal(setupErrorDetail("/home/user/x", "/home/u", "linux"), "/home/user/x", "only the exact HOME path is replaced");
	for (const empty of ["", "\n \n", "\u001b[0m", undefined, null, 42]) assert.equal(setupErrorDetail(empty, HOME, "linux"), null);
	assert.equal(setupErrorDetail("Error: plain", undefined, "linux"), "Error: plain");
});

test("$PNPM_HOME/bin absent from the user PATH runs pnpm setup and requires a new terminal", async () => {
	const h = harness({ env: { PATH: `${PNPM_HOME}:/opt/node/bin:/usr/bin` } });
	const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
	assert.equal(result.outcome, "terminal-action-required");
	assert.equal(result.action, "open-new-terminal");
	assert.equal(h.pnpmCalls().at(-1), "setup");
	assert.equal(result.completed.at(-1), "persist-path");
	const failing = harness({ env: { PATH: "/opt/node/bin:/usr/bin" }, results: { "pnpm setup": { code: 1 } } });
	const failed = await runStandardInstall({ plan: plan(), consent: true }, failing.adapters);
	assert.equal(failed.outcome, "failed");
	assert.equal(failed.failedStep, "persist-path");
});

test("pnpm setup gets the network setup deadline, not the short probe deadline", async () => {
	// pnpm setup installs @pnpm/exe from the registry, so it shares the shell-setup budget.
	const h = harness({ env: { PATH: "/opt/node/bin:/usr/bin" } });
	await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
	const setupCalls = h.calls.filter((call) => call.args.at(-1) === "setup");
	assert.equal(setupCalls.length, 2);
	assert.equal(setupCalls[0].args.at(-2), SHELL_ENTRY);
	assert.equal(setupCalls[1], h.calls.at(-1));
	assert.equal(h.pnpmCalls().at(-1), "setup");
	assert.deepEqual(setupCalls.map((call) => call.deadlineMs), [20 * 60 * 1000, 20 * 60 * 1000]);
});

test("already on PATH and fully verified is ready without pnpm setup", async () => {
	const h = harness();
	const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.equal(h.pnpmCalls().includes("setup"), false);
});

test("an unexpected adapter exception fails closed without leaking its message", async () => {
	const h = harness();
	h.adapters.run = async () => { throw new Error("private /home/u/secret"); };
	const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
	assert.equal(result.outcome, "blocked");
	assert.equal(JSON.stringify(result).includes("secret"), false);
	assert.equal(JSON.stringify(h.logs).includes("secret"), false);
});

test("package-native integrity rejects development overrides and unverified package roots", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gentle-runner-integrity-"));
	try {
		const dev = join(dir, "dev-gentle-ai");
		writeFileSync(dev, "#!/bin/sh\n");
		chmodSync(dev, 0o755);
		const overridden = await packageNativeGentleAi({ packageRoot: dir, platform: "linux", home: dir,
			env: { GENTLE_PI_GENTLE_AI_DEV_BINARY: dev } });
		assert.deepEqual(overridden, { ok: false, reason: "development-override" });
		const missing = await packageNativeGentleAi({ packageRoot: dir, platform: "linux", home: dir, env: {} });
		assert.deepEqual(missing, { ok: false, reason: "package-native-unverified" });
		const seen: unknown[][] = [];
		const verified = await packageNativeGentleAi({ packageRoot: dir, platform: "linux", home: dir, env: {} },
			(...args: unknown[]) => { seen.push(args); return gentleAiBinaryPath(dir, "linux"); });
		assert.deepEqual(verified, { ok: true });
		assert.equal(seen.length, 1);
		assert.deepEqual(seen[0].slice(0, 2), [dir, "linux"]);
		assert.deepEqual(seen[0][3], { env: {}, home: dir });
		const elsewhere = await packageNativeGentleAi({ packageRoot: dir, platform: "linux", home: dir, env: {} }, () => dev);
		assert.deepEqual(elsewhere, { ok: false, reason: "package-native-unverified" });
		let called = false;
		await packageNativeGentleAi({ packageRoot: dir, platform: "linux", home: dir, env: { GENTLE_PI_GENTLE_AI_DEV_BINARY: dev } },
			() => { called = true; return gentleAiBinaryPath(dir, "linux"); });
		assert.equal(called, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// Plans whose inventory says Node is bootstrap-only (or npm is not genuine) include fixed persistence steps.
const bootstrapNode = { ...tool("24.18.0"), persistent: false, npm: false };
function persistPlan(platform = "linux", node: object = bootstrapNode) {
	return plan(platform, { node });
}
// pnpm 11 keeps each global add in its own project: npm+pnpm and the stack are listed separately.
function persistedListing(root = PACKAGE_ROOT, home = PNPM_HOME) {
	return JSON.stringify([
		{ path: `${home}/global/v11/abc`, dependencies: { npm: { version: "11.19.0" }, pnpm: { version: "11.1.1" } } },
		{ path: `${home}/global/v11/def`, dependencies: { "@earendil-works/pi-coding-agent": { version: PI_INSTALL_VERSION },
			"gentle-pi": { version: requirements.shell, path: root } } },
	]);
}
const persistedList = { [LIST]: [emptyList, { code: 0, stdout: persistedListing() }] };
const PERSISTED_STEPS = ["check-global-bin", "check-existing-stack", "persist-node", "persist-package-managers",
	"verify-persistent-runtime", "check-npm", "configure-npm-prefix"];

test("persistence pins are fixed: Node 24.21.0 with its bundled npm 11.19.0 and the pnpm acquisition pin", () => {
	assert.deepEqual(persistencePins, { node: "24.21.0", npm: "11.19.0", pnpm: requirements.pnpm });
});

test("bootstrap-only Node persists node, npm and pnpm under PNPM_HOME before the stack install", async () => {
	const h = harness({ results: persistedList });
	const result = await runStandardInstall({ plan: persistPlan(), consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.equal(result.npmPrefix, "configured");
	assert.deepEqual(h.pnpmCalls(), ["bin -g", LIST, RUNTIME_SET, PM_ADD, "store path", INSTALL, LIST]);
	assert.deepEqual(result.completed, [...PERSISTED_STEPS, "install-global", "verify-global-list", "verify-shell-bin",
		"verify-gentle-ai", "shell-setup"]);
	for (const call of h.calls.filter((c) => c.args[1] === "add" || c.args[1] === "runtime")) {
		assert.equal(call.command, NODE);
		assert.equal(call.args.some((arg) => /dangerously|allow-build=\*|--allow-build$|approve-builds/.test(arg)), false);
		assert.equal(call.env.PNPM_HOME, PNPM_HOME);
		assert.equal(call.env.PATH.split(":")[0], BIN);
	}
	assert.equal(h.pnpmCalls().filter((call) => call === PM_ADD)[0].includes("allow-build"), false);
	// After persistence, node and npm resolve from $PNPM_HOME/bin in the child env.
	assert.deepEqual(h.calls.filter((call) => call.args[0] === PM_NPM_CLI).map((call) => [call.command, ...call.args]), [
		[NODE, PM_NPM_CLI, "--version"],
		[PERSISTENT_NODE, PM_NPM_CLI, "config", "get", "prefix"],
		[PERSISTENT_NODE, PM_NPM_CLI, "config", "set", "prefix", PNPM_HOME, "--location=user"],
		[PERSISTENT_NODE, PM_NPM_CLI, "config", "get", "prefix"],
	]);
	assert.deepEqual(h.calls.find((call) => call.command === PERSISTENT_NODE)?.args, ["--version"]);
});

test("the full persistence group runs exactly when Node is bootstrap-only", async () => {
	for (const pnpm of [{ ...tool("11.1.1"), compatible: true, persistent: true }, { ...tool("11.1.1"), compatible: true, persistent: false }]) {
		const h = harness({ results: persistedList });
		const result = await runStandardInstall({ plan: plan("linux", { node: { ...tool("24.18.0"), persistent: false, npm: true }, pnpm }),
			consent: true }, h.adapters);
		assert.equal(result.outcome, "ready");
		assert.deepEqual(h.pnpmCalls().slice(2, 4), [RUNTIME_SET, PM_ADD]);
	}
	const h = harness();
	const result = await runStandardInstall({ plan: plan("linux", { node: { ...tool("24.18.0"), persistent: true, npm: true } }), consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.equal(result.npmPrefix, undefined);
	assert.deepEqual(h.pnpmCalls(), ["bin -g", LIST, INSTALL, LIST]);
	assert.equal(h.calls.some((call) => call.args[0] === PM_NPM_CLI || call.command === PERSISTENT_NODE), false);
});

test("a failed persistence step stops before the stack install and reports completed steps", async () => {
	const cases: [string, object, string[]][] = [
		["persist-node", { [RUNTIME_SET]: { code: 1 } }, [RUNTIME_SET]],
		["persist-node", { [RUNTIME_SET]: { code: 0, timedOut: true } }, [RUNTIME_SET]],
		["persist-package-managers", { "add-pm": { code: 1 } }, [RUNTIME_SET, PM_ADD]],
		["verify-persistent-runtime", { "persistent-node --version": { code: 0, stdout: "v24.18.0\n" } }, [RUNTIME_SET, PM_ADD]],
	];
	for (const [failedStep, results, mutations] of cases) {
		const h = harness({ results: { ...persistedList, ...results } });
		const result = await runStandardInstall({ plan: persistPlan(), consent: true }, h.adapters);
		assert.equal(result.outcome, "failed");
		assert.equal(result.failedStep, failedStep);
		assert.deepEqual(result.completed, PERSISTED_STEPS.slice(0, PERSISTED_STEPS.indexOf(failedStep)));
		assert.deepEqual(h.pnpmCalls(), ["bin -g", LIST, ...mutations]);
	}
	// pnpm reports success but node or npm is not in $PNPM_HOME/bin.
	for (const creates of [{ "add-pm": [`${BIN}/npm`, PM_NPM_CLI] }, { [RUNTIME_SET]: [PERSISTENT_NODE] }]) {
		const h = harness({ results: persistedList, creates });
		const result = await runStandardInstall({ plan: persistPlan(), consent: true }, h.adapters);
		assert.equal(result.failedStep, "verify-persistent-runtime");
		assert.equal(h.pnpmCalls().includes(INSTALL), false);
	}
});

test("pnpm-global npm shim: wrong version, foreign target or ambiguous shim is rejected", async () => {
	// Each variant is otherwise a working npm, so only the rule under test rejects it.
	const foreign = "/elsewhere/node_modules/npm/bin/npm-cli.js";
	const variants = [
		{ texts: { [`${PM_NPM_DIR}/package.json`]: JSON.stringify({ name: "npm", version: "11.18.0" }) },
			results: { "pm-npm --version": { code: 0, stdout: "11.18.0\n" } } },
		{ texts: { [`${PM_NPM_DIR}/package.json`]: JSON.stringify({ name: "not-npm", version: "11.19.0" }) } },
		{ realpaths: { [PM_NPM_CLI]: foreign }, files: [foreign],
			texts: { "/elsewhere/node_modules/npm/package.json": npmPackage },
			results: { [`${foreign} --version`]: { code: 0, stdout: "11.19.0\n" } } },
		{ texts: { [`${BIN}/npm`]: POSIX_SHIM.replace("abc/node_modules/npm/bin/npm-cli.js\" \"$@\"\nelse", "xyz/node_modules/npm/bin/npm-cli.js\" \"$@\"\nelse") } },
		{ texts: { [`${BIN}/npm`]: "#!/bin/sh\nexec /opt/fake/npm \"$@\"\n" } },
		{ results: { "pm-npm --version": { code: 0, stdout: "10.0.0\n" } } },
	];
	for (const variant of variants) {
		const h = harness({ ...variant, results: { ...persistedList, ...(variant as { results?: object }).results } });
		const result = await runStandardInstall({ plan: persistPlan(), consent: true }, h.adapters);
		assert.equal(result.outcome, "failed");
		assert.equal(result.failedStep, "check-npm");
		assert.equal(h.pnpmCalls().includes(INSTALL), false);
	}
});

test("an existing pnpm-global npm shim first on PATH satisfies check-npm without persistence", async () => {
	const files = [`${BIN}/npm`, PM_NPM_CLI];
	const h = harness({ files });
	const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.deepEqual(h.pnpmCalls(), ["bin -g", LIST, INSTALL, LIST]);
	assert.deepEqual(h.calls[0].args, [PM_NPM_CLI, "--version"]);
	const wrong = harness({ files, texts: { [`${PM_NPM_DIR}/package.json`]: JSON.stringify({ name: "npm", version: "11.20.0" }) },
		results: { "pm-npm --version": { code: 0, stdout: "11.20.0\n" } } });
	const blocked = await runStandardInstall({ plan: plan(), consent: true }, wrong.adapters);
	assert.equal(blocked.outcome, "blocked");
	assert.equal(blocked.reason, "npm-unavailable");
});

test("npm prefix is set only when inside the pnpm store and not explicit; never overwritten", async () => {
	const set = `pm-npm config set prefix ${PNPM_HOME} --location=user`;
	const cases: [object, object][] = [
		[{ "pm-npm config get prefix": { code: 0, stdout: "/home/u/.npm-global\n" } }, {}],
		[{}, { NPM_CONFIG_PREFIX: STORE_PREFIX }],
		[{}, { npm_config_prefix: STORE_PREFIX }],
		[{}, { Npm_Config_Prefix: STORE_PREFIX }],
		[{}, { PREFIX: STORE_PREFIX }],
	];
	for (const [results, env] of cases) {
		const h = harness({ env, results: { ...persistedList, ...results } });
		const result = await runStandardInstall({ plan: persistPlan(), consent: true }, h.adapters);
		assert.equal(result.outcome, "ready");
		assert.equal(result.npmPrefix, "unchanged");
		assert.equal(h.calls.some((call) => call.args[0] === PM_NPM_CLI && call.args.includes("set")), false);
		assert.ok(result.completed.includes("configure-npm-prefix"));
		// An explicit prefix never needs the store; an effective one is compared with `pnpm store path`.
		assert.equal(h.pnpmCalls().includes("store path"), Object.keys(env).length === 0);
	}
	const failures = [
		{ [set]: { code: 1 } },
		{ "pm-npm config get prefix": [{ code: 0, stdout: `${STORE_PREFIX}\n` }, { code: 0, stdout: `${STORE_PREFIX}\n` }] },
		{ "pm-npm config get prefix": { code: 1, stdout: "" } },
		{ "pm-npm config get prefix": { code: 0, stdout: "relative/prefix\n" } },
		// The store must be resolved by pnpm itself; an unknown store is a failure, never "unchanged".
		{ "store path": { code: 1, stdout: "" } },
		{ "store path": { code: 0, timedOut: true, stdout: `${STORE_PATH}\n` } },
		{ "store path": { code: 0, stdout: "store/v11\n" } },
		{ "store path": { code: 0, stdout: "/missing/store/v11\n" } },
	];
	for (const results of failures) {
		const h = harness({ results: { ...persistedList, ...results } });
		const result = await runStandardInstall({ plan: persistPlan(), consent: true }, h.adapters);
		assert.equal(result.outcome, "failed");
		assert.equal(result.failedStep, "configure-npm-prefix");
		assert.deepEqual(result.completed, PERSISTED_STEPS.slice(0, -1));
		assert.equal(h.pnpmCalls().includes(INSTALL), false);
	}
});

test("Windows persistence resolves node.exe and the npm.cmd shim from $PNPM_HOME\\bin", async () => {
	const h = harness({ layout: windowsLayout, results: { [LIST]: [emptyList, { code: 0, stdout: persistedListing(W_ROOT, W_PNPM_HOME) }] } });
	const result = await runStandardInstall({ plan: persistPlan("win32"), consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.equal(result.npmPrefix, "configured");
	assert.deepEqual(h.calls.filter((call) => call.args[0] === W_PM_NPM_CLI).map((call) => [call.command, ...call.args]), [
		[W_NODE, W_PM_NPM_CLI, "--version"],
		[W_PERSISTENT_NODE, W_PM_NPM_CLI, "config", "get", "prefix"],
		[W_PERSISTENT_NODE, W_PM_NPM_CLI, "config", "set", "prefix", W_PNPM_HOME, "--location=user"],
		[W_PERSISTENT_NODE, W_PM_NPM_CLI, "config", "get", "prefix"],
	]);
	// An npm.exe beside the shim resolves first in PATHEXT order and is not accepted.
	const shadowed = harness({ layout: windowsLayout, creates: { ...windowsLayout.creates, "add-pm": [`${W_BIN}\\npm.exe`, `${W_BIN}\\npm.cmd`, W_PM_NPM_CLI] },
		results: { [LIST]: [emptyList, { code: 0, stdout: persistedListing(W_ROOT, W_PNPM_HOME) }] } });
	const failed = await runStandardInstall({ plan: persistPlan("win32"), consent: true }, shadowed.adapters);
	assert.equal(failed.outcome, "failed");
	assert.equal(failed.failedStep, "check-npm");
});

test("partial or altered persistence actions are rejected before any command", async () => {
	const base = persistPlan();
	const partial = { ...base, actions: base.actions.filter((action: { id: string }) => action.id !== "configure-npm-prefix") };
	const h = harness();
	assert.equal((await runStandardInstall({ plan: partial, consent: true }, h.adapters)).reason, "unsupported-plan");
	const altered = { ...base, actions: base.actions.map((action: { id: string }) => action.id === "persist-node" ? { ...action, version: "25.0.0" } : action) };
	assert.equal((await runStandardInstall({ plan: altered, consent: true }, h.adapters)).reason, "invalid-request");
	assert.deepEqual(h.calls, []);
});

test("gentle-shell setup receives no GENTLE_BOOTSTRAP_* or GENTLE_INSTALL_* keys", async () => {
	const h = harness({ env: { GENTLE_BOOTSTRAP_TOOLS: "/home/u/.gentle-shell-bootstrap-tools.x", gentle_install_lower: "kept", KEEP: "1" } });
	assert.equal((await runStandardInstall({ plan: plan(), consent: true }, h.adapters)).outcome, "ready");
	const setup = h.calls.find((call) => call.args[0] === SHELL_ENTRY);
	assert.ok(setup);
	assert.deepEqual(Object.keys(setup.env).filter((key) => /^gentle_/i.test(key)), ["gentle_install_lower"]);
	assert.equal(setup.env.KEEP, "1");
	assert.equal(setup.env.PNPM_HOME, PNPM_HOME);
	// pnpm still receives the bootstrap handoff; only setup is stripped.
	assert.equal(h.calls.find((call) => call.args[1] === "add")?.env.GENTLE_INSTALL_PNPM_ENTRY, ENTRY);
	const w = harness({ layout: windowsLayout, env: { gentle_bootstrap_tools: "C:\\x", Gentle_Install_Other: "y" } });
	assert.equal((await runStandardInstall({ plan: plan("win32"), consent: true }, w.adapters)).outcome, "ready");
	const wSetup = w.calls.find((call) => call.args[0] === `${W_ROOT}\\bin\\gentle-shell.mjs`);
	assert.deepEqual(Object.keys(wSetup?.env ?? {}).filter((key) => /^gentle_/i.test(key)), []);
});

test("npm prefix compares with the store pnpm reports, not an assumed $PNPM_HOME/store", async () => {
	const custom = "/srv/pnpm-store/v11";
	const prefix = `${custom}/links/node/24.21.0/hash`;
	const h = harness({ realpaths: { [custom]: custom, [prefix]: prefix }, results: { ...persistedList,
		"store path": { code: 0, stdout: `${custom}\n` },
		"pm-npm config get prefix": [{ code: 0, stdout: `${prefix}\n` }, { code: 0, stdout: `${PNPM_HOME}\n` }] } });
	const result = await runStandardInstall({ plan: persistPlan(), consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.equal(result.npmPrefix, "configured");
	const storeCall = h.calls.find((call) => call.args[1] === "store");
	assert.deepEqual(storeCall?.args, [ENTRY, "store", "path"]);
	assert.equal(storeCall?.env.PNPM_HOME, PNPM_HOME);
	assert.ok((storeCall?.deadlineMs ?? 0) > 0);
	// The default $PNPM_HOME/store is no longer assumed when pnpm reports another store.
	const elsewhere = harness({ realpaths: { [custom]: custom }, results: { ...persistedList, "store path": { code: 0, stdout: `${custom}\n` } } });
	const unchanged = await runStandardInstall({ plan: persistPlan(), consent: true }, elsewhere.adapters);
	assert.equal(unchanged.npmPrefix, "unchanged");
});

test("a symlinked $PNPM_HOME/bin/npm must resolve inside PNPM_HOME to npm@11.19.0", async () => {
	const outside = "/usr/lib/node_modules/npm/bin/npm-cli.js";
	const foreign = harness({ files: [`${BIN}/npm`, outside], realpaths: { [`${BIN}/npm`]: outside },
		texts: { "/usr/lib/node_modules/npm/package.json": npmPackage },
		results: { [`${outside} --version`]: { code: 0, stdout: "11.19.0\n" } } });
	const blocked = await runStandardInstall({ plan: plan(), consent: true }, foreign.adapters);
	assert.equal(blocked.outcome, "blocked");
	assert.equal(blocked.reason, "npm-unavailable");
	assert.equal(foreign.pnpmCalls().some((call) => call.startsWith("add")), false);
	const old = harness({ files: [`${BIN}/npm`, PM_NPM_CLI], realpaths: { [`${BIN}/npm`]: PM_NPM_CLI },
		texts: { [`${PM_NPM_DIR}/package.json`]: JSON.stringify({ name: "npm", version: "11.18.0" }) },
		results: { "pm-npm --version": { code: 0, stdout: "11.18.0\n" } } });
	assert.equal((await runStandardInstall({ plan: plan(), consent: true }, old.adapters)).reason, "npm-unavailable");
	const linked = harness({ files: [`${BIN}/npm`, PM_NPM_CLI], realpaths: { [`${BIN}/npm`]: PM_NPM_CLI } });
	assert.equal((await runStandardInstall({ plan: plan(), consent: true }, linked.adapters)).outcome, "ready");
	assert.deepEqual(linked.calls[0].args, [PM_NPM_CLI, "--version"]);
});

// Node already persistent: only the missing package managers, in one add -g, never runtime set.
const persistentNode = (npm: boolean) => ({ ...tool("24.18.0"), persistent: true, npm });
const pnpmTool = (persistent: boolean) => ({ ...tool("11.1.1"), compatible: true, persistent });
const AFTER_STACK = ["install-global", "verify-global-list", "verify-shell-bin", "verify-gentle-ai", "shell-setup"];

test("persistent Node adds only the missing npm and/or pnpm with exact fixed argv", async () => {
	const cases: [boolean, boolean, string, string[]][] = [
		[false, true, NPM_ADD, ["check-global-bin", "check-existing-stack", "persist-npm", "check-npm"]],
		[true, false, PNPM_ADD, ["check-npm", "check-global-bin", "check-existing-stack", "persist-pnpm", "verify-persistent-pnpm"]],
		[false, false, PM_ADD, ["check-global-bin", "check-existing-stack", "persist-package-managers", "check-npm", "verify-persistent-pnpm"]],
	];
	for (const [npm, pnpmPersistent, add, steps] of cases) {
		const fixed = plan("linux", { node: persistentNode(npm), pnpm: pnpmTool(pnpmPersistent) });
		const h = harness({ results: persistedList });
		const result = await runStandardInstall({ plan: fixed, consent: true }, h.adapters);
		assert.equal(result.outcome, "ready", add);
		assert.deepEqual(h.pnpmCalls(), ["bin -g", LIST, add, INSTALL, LIST]);
		assert.deepEqual(result.completed, [...steps, ...AFTER_STACK]);
		assert.equal(result.npmPrefix, undefined);
		assert.equal(h.calls.some((call) => call.command === PERSISTENT_NODE || call.args.includes("config")), false);
		const persisted = h.calls.find((call) => call.args[1] === "add" && call.args.join(" ") !== `${ENTRY} ${INSTALL}`);
		assert.equal(persisted?.env.PATH.split(":")[0], BIN);
		if (!pnpmPersistent) assert.ok(h.calls.some((call) => call.command === NODE && call.args.join(" ") === `${PM_PNPM_ENTRY} --version`));
	}
	const none = harness();
	const reused = await runStandardInstall({ plan: plan("linux", { node: persistentNode(true), pnpm: pnpmTool(true) }), consent: true }, none.adapters);
	assert.deepEqual(none.pnpmCalls(), ["bin -g", LIST, INSTALL, LIST]);
	assert.equal(reused.outcome, "ready");
});

test("an added pnpm must resolve from $PNPM_HOME/bin at 11.1.1", async () => {
	const fixed = plan("linux", { node: persistentNode(true), pnpm: pnpmTool(false) });
	const variants = [
		{ creates: { "add-pnpm": [] } },
		{ texts: { [`${PM_PNPM_DIR}/package.json`]: JSON.stringify({ name: "pnpm", version: "11.2.0" }) },
			results: { "pm-pnpm --version": { code: 0, stdout: "11.2.0\n" } } },
		{ results: { "pm-pnpm --version": { code: 0, stdout: "10.0.0\n" } } },
		{ realpaths: { [PM_PNPM_ENTRY]: "/elsewhere/node_modules/pnpm/bin/pnpm.mjs" } },
		{ texts: { [`${BIN}/pnpm`]: "#!/bin/sh\nexec /opt/fake/pnpm \"$@\"\n" } },
	];
	for (const variant of variants) {
		const h = harness({ ...variant, results: { ...persistedList, ...(variant as { results?: object }).results } });
		const result = await runStandardInstall({ plan: fixed, consent: true }, h.adapters);
		assert.equal(result.outcome, "failed");
		assert.equal(result.failedStep, "verify-persistent-pnpm");
		assert.equal(h.pnpmCalls().includes(INSTALL), false);
	}
	const npmFixed = plan("linux", { node: persistentNode(false), pnpm: pnpmTool(true) });
	const wrongNpm = harness({ results: { ...persistedList, "pm-npm --version": { code: 0, stdout: "11.18.0\n" } },
		texts: { [`${PM_NPM_DIR}/package.json`]: JSON.stringify({ name: "npm", version: "11.18.0" }) } });
	const failed = await runStandardInstall({ plan: npmFixed, consent: true }, wrongNpm.adapters);
	assert.equal(failed.failedStep, "check-npm");
	assert.equal(wrongNpm.pnpmCalls().includes(RUNTIME_SET), false);
});

test("Windows persistent Node adds only pnpm and verifies the pnpm.cmd shim target", async () => {
	const fixed = plan("win32", { node: persistentNode(true), pnpm: pnpmTool(false) });
	const h = harness({ layout: windowsLayout, results: { [LIST]: [emptyList, { code: 0, stdout: persistedListing(W_ROOT, W_PNPM_HOME) }] } });
	const result = await runStandardInstall({ plan: fixed, consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.ok(result.completed.includes("verify-persistent-pnpm"));
	assert.ok(h.calls.some((call) => call.command === W_NODE && call.args.join(" ") === `${W_PM_PNPM_ENTRY} --version`));
});

test("persistence variants are accepted only as fixed sets", async () => {
	const npmAction = { id: "persist-npm", kind: "install-global", target: "npm", version: "11.19.0" };
	const pnpmAction = { id: "persist-pnpm", kind: "install-global", target: "pnpm", version: "11.1.1" };
	const both = { id: "persist-package-managers", kind: "install-global", target: "package-managers" };
	const prefix = { id: "configure-npm-prefix", kind: "configure", target: "npm-prefix" };
	const node = { id: "persist-node", kind: "persist-runtime", target: "node", version: "24.21.0" };
	const base = plan();
	for (const extra of [[npmAction, pnpmAction], [both, prefix], [node, npmAction, prefix], [node, both], [npmAction, prefix]]) {
		const h = harness();
		const result = await runStandardInstall({ plan: { ...base, actions: [...extra, ...base.actions] }, consent: true }, h.adapters);
		assert.equal(result.outcome, "blocked");
		assert.equal(result.reason, "unsupported-plan");
		assert.deepEqual(h.calls, []);
	}
	const altered = { ...base, actions: [{ ...npmAction, version: "11.20.0" }, ...base.actions] };
	assert.equal((await runStandardInstall({ plan: altered, consent: true }, harness().adapters)).reason, "invalid-request");
});

test("gates without PNPM_HOME or an absolute host Node block before any command", async () => {
	const h = harness();
	const noHome = await runStandardInstall({ plan: plan(), consent: true }, { ...h.adapters, env: { PATH: "/usr/bin" } });
	assert.equal(noHome.reason, "pnpm-home-unknown");
	const relativeNode = await runStandardInstall({ plan: plan(), consent: true }, { ...h.adapters, nodePath: "node" });
	assert.equal(relativeNode.reason, "node-unavailable");
	assert.deepEqual(h.calls, []);
});

// Setup recovery: the pinned stack this pnpm installed is present and only its setup did not finish.
function recoveryPlan(platform = "linux", change: object = {}) {
	return plan(platform, { pi: tool(PI_INSTALL_VERSION), shell: { ...tool(requirements.shell), global: true },
		gentleAi: { ...tool(requirements.gentleAi), compatible: true }, setup: { available: true, recoverable: true }, ...change });
}
const installedList = { [LIST]: { code: 0, stdout: listing() } };
const RECOVERY_STEPS = ["check-npm", "check-global-bin", "check-recoverable-stack", "verify-global-list", "verify-shell-bin",
	"verify-gentle-ai", "shell-setup"];
const actionIds = (fixed: { actions: { id: string }[] }) => fixed.actions.map((action) => action.id);

test("setup recovery re-verifies the installed stack and reruns setup without add -g", async () => {
	const fixed = recoveryPlan();
	assert.deepEqual(actionIds(fixed), ["setup-shell", "verify-readiness"]);
	const h = harness({ results: installedList });
	const result = await runStandardInstall({ plan: fixed, consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.deepEqual(result.completed, RECOVERY_STEPS);
	assert.deepEqual(h.pnpmCalls(), ["bin -g", LIST, LIST]);
	assert.equal(h.calls.some((call) => call.args.includes("add")), false);
	assert.deepEqual(h.calls.at(-1)?.args, [SHELL_ENTRY, "setup"]);
	assert.deepEqual(h.integrityCalls, [{ packageRoot: PACKAGE_ROOT, platform: "linux", env: h.adapters.env, home: HOME }]);
	// npm and pnpm persisted by the earlier run live in their own project.
	const persisted = harness({ results: { [LIST]: { code: 0, stdout: persistedListing() } } });
	assert.equal((await runStandardInstall({ plan: fixed, consent: true }, persisted.adapters)).outcome, "ready");
});

test("setup recovery off PATH persists PATH, needs a new terminal, and reports failed steps", async () => {
	const env = { PATH: "/opt/node/bin:/usr/bin" };
	const fixed = recoveryPlan("linux", { globalBin: { available: true, path: BIN, writable: true, onPath: false } });
	assert.deepEqual(actionIds(fixed), ["setup-global-bin", "setup-shell", "verify-readiness"]);
	const h = harness({ env, results: installedList });
	const result = await runStandardInstall({ plan: fixed, consent: true }, h.adapters);
	assert.equal(result.outcome, "terminal-action-required");
	assert.deepEqual(result.completed, [...RECOVERY_STEPS, "persist-path"]);
	assert.deepEqual(h.pnpmCalls(), ["bin -g", LIST, LIST, "setup"]);
	const failures: [object, string][] = [
		[{ "gentle-shell setup": { code: 1, stderrTail: "Error: API rate limit exceeded\n" } }, "shell-setup"],
		[{ "pnpm setup": { code: 1 } }, "persist-path"],
	];
	for (const [results, step] of failures) {
		const failing = harness({ env, results: { ...installedList, ...results } });
		const failed = await runStandardInstall({ plan: fixed, consent: true }, failing.adapters);
		assert.equal(failed.outcome, "failed");
		assert.equal(failed.failedStep, step);
		assert.equal(failing.calls.some((call) => call.args.includes("add")), false);
	}
	const unverified = harness({ results: installedList, integrity: { ok: false } });
	const failed = await runStandardInstall({ plan: recoveryPlan(), consent: true }, unverified.adapters);
	assert.equal(failed.failedStep, "verify-gentle-ai");
	assert.equal(unverified.calls.some((call) => call.args[0] === SHELL_ENTRY), false);
});

test("setup recovery blocks when the installed stack changed between plan and run", async () => {
	const stack = JSON.parse(listing());
	const changed = [
		"[]",
		listing("1.2.0"),
		listing(PI_INSTALL_VERSION, "3.0.0"),
		listing(PI_INSTALL_VERSION, requirements.shell, "/elsewhere/gentle-pi"),
		JSON.stringify([...stack, { dependencies: { "gentle-pi": { version: requirements.shell, path: PACKAGE_ROOT } } }]),
		JSON.stringify([...stack, { optionalDependencies: { "@earendil-works/pi-coding-agent": { version: PI_INSTALL_VERSION } } }]),
		"{}",
		"not json",
	];
	for (const stdout of changed) {
		const h = harness({ results: { [LIST]: { code: 0, stdout } }, realpaths: { "/elsewhere/gentle-pi": "/elsewhere/gentle-pi" } });
		const result = await runStandardInstall({ plan: recoveryPlan(), consent: true }, h.adapters);
		assert.equal(result.outcome, "blocked", stdout);
		assert.equal(result.reason, "existing-stack-unverified", stdout);
		assert.deepEqual(result.completed, ["check-npm", "check-global-bin"]);
		assert.deepEqual(h.pnpmCalls(), ["bin -g", LIST]);
		assert.equal(h.calls.some((call) => call.args[0] === SHELL_ENTRY), false);
	}
	// A root that now resolves outside PNPM_HOME through a symlink is not this pnpm's install.
	const moved = harness({ results: installedList, realpaths: { [PACKAGE_ROOT]: "/elsewhere/gentle-pi" } });
	assert.equal((await runStandardInstall({ plan: recoveryPlan(), consent: true }, moved.adapters)).reason, "existing-stack-unverified");
	const failing = harness({ results: { [LIST]: { code: 1, stdout: listing() } } });
	assert.equal((await runStandardInstall({ plan: recoveryPlan(), consent: true }, failing.adapters)).reason, "global-list-unavailable");
});

test("the setup recovery variant is accepted only as a fixed set", async () => {
	const clean = plan();
	const descriptor = (id: string) => clean.actions.find((action: { id: string }) => action.id === id);
	const persistNpm = { id: "persist-npm", kind: "install-global", target: "npm", version: "11.19.0" };
	const provision = { id: "provision-native", kind: "existing-installer", target: "gentleAi", version: requirements.gentleAi };
	const base = recoveryPlan();
	const offPath = recoveryPlan("linux", { globalBin: { available: true, path: BIN, writable: true, onPath: false } });
	const variants = [
		[descriptor("install-pi"), ...base.actions],
		[descriptor("install-shell"), ...base.actions],
		[persistNpm, ...base.actions],
		[provision, ...base.actions],
		base.actions.filter((action: { id: string }) => action.id !== "setup-shell"),
		offPath.actions.filter((action: { id: string }) => action.id !== "setup-shell"),
		base.actions.filter((action: { id: string }) => action.id !== "verify-readiness"),
	];
	for (const actions of variants) {
		const h = harness({ results: installedList });
		const result = await runStandardInstall({ plan: { ...base, actions }, consent: true }, h.adapters);
		assert.equal(result.outcome, "blocked");
		assert.equal(result.reason, "unsupported-plan");
		assert.deepEqual(h.calls, []);
	}
});

test("Windows setup recovery needs no Go: it never runs add -g, and the native binary is verified", async () => {
	const fixed = recoveryPlan("win32", { go: absent });
	assert.equal(fixed.tools.go.status, "not-required");
	const h = harness({ layout: windowsLayout, results: { [LIST]: { code: 0, stdout: listing(PI_INSTALL_VERSION, requirements.shell, W_ROOT) } } });
	const result = await runStandardInstall({ plan: fixed, consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.deepEqual(result.completed, RECOVERY_STEPS);
	assert.equal(h.pnpmCalls().some((call) => call.startsWith("add")), false);
	assert.deepEqual(h.calls.at(-1)?.args, [`${W_ROOT}\\bin\\gentle-shell.mjs`, "setup"]);
	// A clean Windows install still requires Go before gentle-pi's postinstall.
	assert.equal((await runStandardInstall({ plan: plan("win32", { go: absent }), consent: true }, harness({ layout: windowsLayout }).adapters)).reason,
		"go-required");
});

// Declared last: node:test runs a file's top-level tests in order.
const AI_SHA = "1f9d5e6423e37f7d2316859045f379ba9b5d8c3a";
const SHELL_SHA = "6e7e3a18f794223396527a54c7c36d19c7d236c6";
const MAIN_VERSION = `${requirements.shell}-main.6e7e3a18f794`;
const MAIN_ROOT = `${PNPM_HOME}/global/v11/def/node_modules/gentle-pi`;
const MAIN_TGZ = `${HOME}/.pi/gentle-ai/main/packages/gentle-pi-${MAIN_VERSION}.tgz`;
function mainPlan(change: object = {}) {
	return planPreflight({ platform: "linux", arch: "x64", node: tool("24.18.0"), pnpm: { ...tool("11.1.1"), compatible: true },
		pi: absent, shell: absent, gentleAi: absent, go: tool("1.26.0"),
		globalBin: { available: true, path: BIN, writable: true, onPath: true }, setup: false, ...change }, { channel: "main" });
}
function mainChannel() {
	const calls: Array<[string, object]> = [];
	return {
		calls,
		adapter: {
			resolveCommit: async (repository: string) => {
				calls.push(["resolveCommit", { repository }]);
				return repository.endsWith("/gentle-ai") ? AI_SHA : SHELL_SHA;
			},
			buildGentleAi: async (request: { commit: string; goPath: string; platform: string; ctx: object }) => {
				calls.push(["buildGentleAi", { commit: request.commit, goPath: request.goPath, platform: request.platform, ctx: request.ctx }]);
				return { binaryPath: "/main/gentle-ai", version: "4.0.1-0.20261008202137-1f9d5e6423e3" };
			},
			packShell: async (request: { commit: string; ctx: object }) => {
				calls.push(["packShell", { commit: request.commit, ctx: request.ctx }]);
				return MAIN_TGZ;
			},
			writeChannel: async (ctx: object, state: object) => {
				calls.push(["writeChannel", { ctx, state }]);
			},
		},
	};
}
const MAIN_ADD = `add -g ${MAIN_TGZ} --allow-build=gentle-pi`;
function mainHarness(mainListing = listing(PI_INSTALL_VERSION, MAIN_VERSION, MAIN_ROOT), extra: object = {}) {
	const h = harness({ files: ["/usr/bin/go"], realpaths: { [MAIN_ROOT]: MAIN_ROOT },
		results: { [LIST]: [emptyList, { code: 0, stdout: listing() }, { code: 0, stdout: mainListing }],
			[`${MAIN_ROOT}/bin/gentle-shell.mjs setup`]: { code: 0 } }, ...extra });
	const main = mainChannel();
	return { ...h, main, adapters: { ...h.adapters, mainChannel: main.adapter } };
}

test("the main plan builds Gentle AI and installs the main Shell after the verified release install, then sets up the main Shell", async () => {
	const h = mainHarness();
	const result = await runStandardInstall({ plan: mainPlan(), consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.deepEqual(result.completed, ["check-npm", "check-global-bin", "check-existing-stack", "install-global",
		"verify-global-list", "verify-shell-bin", "verify-gentle-ai", "build-gentle-ai-main", "install-shell-main", "record-channel", "shell-setup"]);
	assert.deepEqual(h.pnpmCalls(), ["bin -g", LIST, INSTALL, LIST, MAIN_ADD, LIST]);
	const ctx = { env: h.adapters.env, home: HOME };
	assert.deepEqual(h.main.calls, [
		["resolveCommit", { repository: "Gentleman-Programming/gentle-ai" }],
		["buildGentleAi", { commit: AI_SHA, goPath: "/usr/bin/go", platform: "linux", ctx }],
		["resolveCommit", { repository: "Gentleman-Programming/gentle-shell" }],
		["packShell", { commit: SHELL_SHA, ctx }],
		["writeChannel", { ctx, state: { channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA } }],
	]);
	assert.deepEqual(h.calls.at(-1)?.args, [`${MAIN_ROOT}/bin/gentle-shell.mjs`, "setup"]);
	// The release package's own integrity check ran before the override was registered.
	assert.deepEqual(h.integrityCalls, [{ packageRoot: PACKAGE_ROOT, platform: "linux", env: h.adapters.env, home: HOME }]);
});

test("a main Shell that pnpm does not list at the main version of that commit fails before recording the channel", async () => {
	for (const mainListing of [listing(), listing(PI_INSTALL_VERSION, `${requirements.shell}-main.aaaaaaaaaaaa`, MAIN_ROOT)]) {
		const h = mainHarness(mainListing);
		const result = await runStandardInstall({ plan: mainPlan(), consent: true }, h.adapters);
		assert.equal(result.outcome, "failed");
		assert.equal(result.failedStep, "install-shell-main");
		assert.equal(h.main.calls.some(([name]) => name === "writeChannel"), false);
		assert.equal(h.calls.some((call) => call.args[1] === "setup"), false);
	}
});

test("the main build fails without Go on PATH and runs nothing after it", async () => {
	const h = harness({ results: { [LIST]: [emptyList, { code: 0, stdout: listing() }] } });
	const main = mainChannel();
	const result = await runStandardInstall({ plan: mainPlan(), consent: true }, { ...h.adapters, mainChannel: main.adapter });
	assert.equal(result.outcome, "failed");
	assert.equal(result.failedStep, "build-gentle-ai-main");
	assert.deepEqual(main.calls.map(([name]) => name), []);
});

test("a channel that cannot be recorded fails the record step after the main Shell is installed", async () => {
	const h = mainHarness();
	h.adapters.mainChannel.writeChannel = async () => { throw new Error("EACCES /home/u/.pi"); };
	const result = await runStandardInstall({ plan: mainPlan(), consent: true }, h.adapters);
	assert.equal(result.outcome, "failed");
	assert.equal(result.failedStep, "record-channel");
	assert.equal(JSON.stringify(result).includes("EACCES"), false);
});

test("a release plan never uses the main channel", async () => {
	const h = harness();
	const main = mainChannel();
	const result = await runStandardInstall({ plan: plan(), consent: true }, { ...h.adapters, mainChannel: main.adapter });
	assert.equal(result.outcome, "ready");
	assert.deepEqual(main.calls, []);
});

test("a partial set of main steps is an unsupported plan", async () => {
	const partial = mainPlan();
	partial.actions = partial.actions.filter((action: { id: string }) => action.id !== "record-channel");
	const h = mainHarness();
	const result = await runStandardInstall({ plan: partial, consent: true }, h.adapters);
	assert.deepEqual([result.outcome, result.reason], ["blocked", "unsupported-plan"]);
	assert.deepEqual(h.calls, []);
});

// --- Existing installations: install only Gentle Shell, or update it ----------------------------
function existingPlan(change: object, channel = "release") {
	return planPreflight({ platform: "linux", arch: "x64", node: tool("24.18.0"), pnpm: { ...tool("11.1.1"), compatible: true },
		pi: tool("1.2.0"), shell: absent, gentleAi: absent, go: tool("1.26.0"),
		globalBin: { available: true, path: BIN, writable: true, onPath: true }, setup: false, ...change }, { channel });
}
const SHELL_ONLY_ADD = `add -g gentle-pi@${requirements.shell} --allow-build=gentle-pi`;
const NPM_SHELL_ROOT = "/usr/local/lib/node_modules/gentle-pi";

test("with a compatible Pi already installed, only Gentle Shell is added and Pi is left as it is", async () => {
	const h = harness({ results: { [LIST]: [{ code: 0, stdout: JSON.stringify([{ path: `${PNPM_HOME}/global/v11`, dependencies: {
		"@earendil-works/pi-coding-agent": { version: "1.2.0" } } }]) }, { code: 0, stdout: listing("1.2.0") }], [SHELL_ONLY_ADD]: { code: 0 } } });
	const result = await runStandardInstall({ plan: existingPlan({}), consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.deepEqual(h.pnpmCalls(), ["bin -g", LIST, SHELL_ONLY_ADD, LIST]);
	assert.deepEqual(result.completed, ["check-npm", "check-global-bin", "check-existing-shell", "install-global",
		"verify-global-list", "verify-shell-bin", "verify-gentle-ai", "shell-setup"]);
	assert.equal(h.calls.some((call) => call.args.includes(`${PI_PACKAGE_NAME}@${PI_INSTALL_VERSION}`)), false);
});

test("adding only Gentle Shell still refuses a gentle-pi that pnpm already lists", async () => {
	const h = harness({ results: { [LIST]: { code: 0, stdout: listing("1.2.0") } } });
	const result = await runStandardInstall({ plan: existingPlan({}), consent: true }, h.adapters);
	assert.deepEqual([result.outcome, result.reason], ["blocked", "existing-stack"]);
	assert.equal(h.calls.some((call) => call.args[1] === "add"), false);
});

function updateHarness({ located = [{ root: NPM_SHELL_ROOT, version: "3.9.0", owner: "npm" }, { root: NPM_SHELL_ROOT, version: requirements.shell, owner: "npm" }] as Array<object | null>,
	upgrade = async () => true as boolean, results = {} as Record<string, Result> } = {}) {
	const h = harness({ results: { [`${NPM_SHELL_ROOT}/bin/gentle-shell.mjs setup`]: { code: 0 }, ...results } });
	const upgrades: object[] = [];
	let locates = 0;
	const adapters = { ...h.adapters,
		locateShell: async () => located[Math.min(locates++, located.length - 1)],
		upgradeShell: async (request: object) => {
			upgrades.push(request);
			return upgrade();
		} };
	return { ...h, adapters, upgrades };
}

test("an older Gentle Shell is updated to the latest release with its owner's logic, verified, then set up", async () => {
	const h = updateHarness();
	const result = await runStandardInstall({ plan: existingPlan({ shell: { available: true, version: "3.9.0", usable: true, global: true, owner: "npm" },
		gentleAi: { available: null }, setup: { available: null } }), consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.deepEqual(result.completed, ["check-npm", "check-global-bin", "check-installed-shell", "update-shell", "verify-updated-shell",
		"verify-gentle-ai", "shell-setup"]);
	assert.deepEqual(h.upgrades, [{ channel: "release", packageRoot: NPM_SHELL_ROOT, currentVersion: "3.9.0" }]);
	assert.deepEqual(h.integrityCalls, [{ packageRoot: NPM_SHELL_ROOT, platform: "linux", env: h.adapters.env, home: HOME }]);
	assert.deepEqual(h.calls.at(-1)?.args, [`${NPM_SHELL_ROOT}/bin/gentle-shell.mjs`, "setup"]);
	assert.equal(h.calls.some((call) => call.args[1] === "add"), false);
});

test("updating to main requires a main version afterwards and skips the pinned binary check", async () => {
	const mainVersion = `${requirements.shell}-main.6e7e3a18f794`;
	const plan = existingPlan({ shell: { available: true, version: requirements.shell, usable: true, global: true, owner: "npm" },
		gentleAi: { available: null }, setup: { available: null } }, "main");
	const h = updateHarness({ located: [{ root: NPM_SHELL_ROOT, version: requirements.shell, owner: "npm" }, { root: NPM_SHELL_ROOT, version: mainVersion, owner: "npm" }] });
	const result = await runStandardInstall({ plan, consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.deepEqual(h.upgrades, [{ channel: "main", packageRoot: NPM_SHELL_ROOT, currentVersion: requirements.shell }]);
	assert.equal(result.completed.includes("verify-gentle-ai"), false);
	const stale = updateHarness({ located: [{ root: NPM_SHELL_ROOT, version: requirements.shell, owner: "npm" }] });
	const failed = await runStandardInstall({ plan, consent: true }, stale.adapters);
	assert.deepEqual([failed.outcome, failed.failedStep], ["failed", "verify-updated-shell"]);
});

test("a missing Pi is installed before the existing Gentle Shell is updated", async () => {
	const h = updateHarness();
	const plan = existingPlan({ pi: absent, shell: { available: true, version: "3.9.0", usable: true, global: true, owner: "npm" },
		gentleAi: { available: null }, setup: { available: null } });
	const result = await runStandardInstall({ plan, consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.deepEqual(result.completed.slice(3, 5), ["install-pi", "update-shell"]);
	assert.ok(h.pnpmCalls().includes(`add -g ${PI_PACKAGE_NAME}@${PI_INSTALL_VERSION}`));
});

test("a failed Pi installation stops before the existing Gentle Shell is touched", async () => {
	const h = updateHarness({ results: { add: { code: 1 } } });
	const plan = existingPlan({ pi: absent, shell: { available: true, version: "3.9.0", usable: true, global: true, owner: "npm" },
		gentleAi: { available: null }, setup: { available: null } });
	const result = await runStandardInstall({ plan, consent: true }, h.adapters);
	assert.deepEqual([result.outcome, result.failedStep], ["failed", "install-pi"]);
	assert.deepEqual(h.upgrades, []);
});

test("an update stops before changing anything when the installed Gentle Shell or its owner cannot be confirmed", async () => {
	const plan = existingPlan({ shell: { available: true, version: "3.9.0", usable: true, global: true, owner: "npm" },
		gentleAi: { available: null }, setup: { available: null } });
	for (const located of [[null], [{ root: "/home/u/work/gentle-pi", version: "3.9.0", owner: null }]]) {
		const h = updateHarness({ located });
		const result = await runStandardInstall({ plan, consent: true }, h.adapters);
		assert.deepEqual([result.outcome, result.reason], ["blocked", "existing-stack-unverified"]);
		assert.deepEqual(h.upgrades, []);
	}
	const h = updateHarness({ upgrade: async () => { throw new Error("npm ERR! EACCES /usr/local"); } });
	const result = await runStandardInstall({ plan, consent: true }, h.adapters);
	assert.deepEqual([result.outcome, result.failedStep], ["failed", "update-shell"]);
	assert.equal(JSON.stringify(result).includes("EACCES"), false);
});

test("exported blocked reasons and failed steps match what the scenarios observed", () => {
	assert.ok(Object.isFrozen(blockedReasons) && Object.isFrozen(failedSteps));
	assert.equal(new Set(blockedReasons).size, blockedReasons.length);
	assert.equal(new Set(failedSteps).size, failedSteps.length);
	for (const reason of observed.reasons) assert.ok(blockedReasons.includes(reason), reason);
	for (const step of observed.steps) assert.ok(failedSteps.includes(step), step);
	// Every reason is reached; only the single-manager add failures have no scenario above.
	assert.deepEqual(blockedReasons.filter((reason) => !observed.reasons.has(reason)), []);
	assert.deepEqual(failedSteps.filter((step) => !observed.steps.has(step)), ["persist-npm", "persist-pnpm"]);
});

