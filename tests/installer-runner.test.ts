import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gentleAiBinaryPath } from "../runtime/gentle-ai-binary.mjs";
import { MainChannelError } from "../scripts/main-channel.mjs";
import { goAcquisition, persistencePins, planPreflight, requirements } from "../scripts/installer-preflight.mjs";
import {
	PI_INSTALL_VERSION,
	PI_PACKAGE as PI_PACKAGE_NAME,
	blockedReasons,
	childEnvironment,
	failedSteps,
	genuineNpm,
	lookPath,
	packageNativeGentleAi,
	pnpmInvocation,
	runStandardInstall as runUnobserved,
	setupErrorDetail,
	upgradeInvocation,
	windowsInvocation,
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
// Node.js's own npm.cmd (npm 10-11 bin/npm.cmd, verbatim from registry.npmjs.org npm@11.19.0).
const NODE_NPM_CMD = ":: Created by npm, please don't edit manually.\r\n@ECHO OFF\r\n\r\nSETLOCAL\r\n\r\nSET \"NODE_EXE=%~dp0\\node.exe\"\r\nIF NOT EXIST \"%NODE_EXE%\" (\r\n  SET \"NODE_EXE=node\"\r\n)\r\n\r\nSET \"NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js\"\r\nSET \"NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js\"\r\nFOR /F \"delims=\" %%F IN ('CALL \"%NODE_EXE%\" \"%NPM_PREFIX_JS%\"') DO (\r\n  SET \"NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js\"\r\n)\r\nIF EXIST \"%NPM_PREFIX_NPM_CLI_JS%\" (\r\n  SET \"NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%\"\r\n)\r\n\r\n\"%NODE_EXE%\" \"%NPM_CLI_JS%\" %*\r\n";
const WINDOWS_SHIM = `@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\..\\global\\v11\\abc\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n) ELSE (\r\n  node  "%~dp0\\..\\global\\v11\\abc\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n)\r\n`;

type Call = { command: string; args: string[]; env: Record<string, string>; deadlineMs: number; stderrTail?: number; cwd?: string };
type Result = { code: number | null; signal?: string | null; timedOut?: boolean; stdout?: string; stderrTail?: string };
type Layout = { platform: string; node: string; entry: string; npmCli: string; shellEntry: string; bin: string;
	root: string; env: Record<string, string>; files: string[]; realpaths: Record<string, string>; texts: Record<string, string>;
	persistentNode: string; pmNpmCli: string; pmPnpmEntry: string; pmHome: string; storePath: string; storePrefix: string;
	creates: Record<string, string[]> };

const npmPackage = JSON.stringify({ name: "npm", version: "11.19.0" });
const pnpmPackage = JSON.stringify({ name: "pnpm", version: "11.1.1" });
// pnpm 11 links gentle-pi's optional peer Pi beside gentle-pi in gentle-pi's own
// global group, at the latest version unless one is already there; the launcher
// resolves that Pi (a nested node_modules first) from gentle-pi.
const piPackage = (version = PI_INSTALL_VERSION) => JSON.stringify({ name: "@earendil-works/pi-coding-agent", version });
const besidePi = (root: string, sep = "/") => `${root.slice(0, root.lastIndexOf(sep))}${sep}@earendil-works${sep}pi-coding-agent${sep}package.json`;
const nestedPi = (root: string) => `${root}/node_modules/@earendil-works/pi-coding-agent/package.json`;
const posixLayout: Layout = {
	platform: "linux", node: NODE, entry: ENTRY, npmCli: NPM_CLI, shellEntry: SHELL_ENTRY, bin: BIN, root: PACKAGE_ROOT,
	env: { HOME, PATH: `${BIN}:/opt/node/bin:/usr/bin`, GENTLE_INSTALL_PNPM_NODE: NODE, GENTLE_INSTALL_PNPM_ENTRY: ENTRY },
	files: ["/opt/node/bin/npm", NPM_CLI, `${BIN}/gentle-shell`],
	realpaths: { "/opt/node/bin/npm": NPM_CLI, [PNPM_HOME]: PNPM_HOME, [PACKAGE_ROOT]: PACKAGE_ROOT,
		[`${BIN}/npm`]: `${BIN}/npm`, [PM_NPM_CLI]: PM_NPM_CLI, [STORE]: STORE, [STORE_PATH]: STORE_PATH, [STORE_PREFIX]: STORE_PREFIX,
		[`${BIN}/pnpm`]: `${BIN}/pnpm`, [PM_PNPM_ENTRY]: PM_PNPM_ENTRY },
	texts: { "/opt/node/lib/node_modules/npm/package.json": npmPackage, [`${BIN}/npm`]: POSIX_SHIM,
		[`${PM_NPM_DIR}/package.json`]: npmPackage, [`${BIN}/pnpm`]: POSIX_PNPM_SHIM, [`${PM_PNPM_DIR}/package.json`]: pnpmPackage,
		[besidePi(PACKAGE_ROOT)]: piPackage() },
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
	files: [W_NODE, W_NPM_CMD, W_NPM_CLI, `${W_BIN}\\gentle-shell.cmd`],
	realpaths: { [W_PNPM_HOME]: W_PNPM_HOME, [W_ROOT]: W_ROOT, [W_PM_NPM_CLI]: W_PM_NPM_CLI, [W_STORE]: W_STORE,
		[W_STORE_PATH]: W_STORE_PATH, [W_STORE_PREFIX]: W_STORE_PREFIX, [W_PM_PNPM_ENTRY]: W_PM_PNPM_ENTRY },
	texts: { [`${W_NODE_DIR}\\node_modules\\npm\\package.json`]: npmPackage, [W_NPM_CMD]: NODE_NPM_CMD, [`${W_BIN}\\npm.cmd`]: WINDOWS_SHIM,
		[`${W_PM_NPM_DIR}\\package.json`]: npmPackage,
		[`${W_BIN}\\pnpm.cmd`]: WINDOWS_SHIM.replaceAll("npm\\bin\\npm-cli.js", "pnpm\\bin\\pnpm.mjs"),
		[`${W_PM_PNPM_DIR}\\package.json`]: pnpmPackage, [besidePi(W_ROOT, "\\")]: piPackage() },
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
		"config get prefix": { code: 0, stdout: "/opt/node\n" },
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
		run: async (command: string, args: string[], options: { env: Record<string, string>; deadlineMs: number; stderrTail?: number; cwd?: string }) => {
			calls.push({ command, args, env: options.env, deadlineMs: options.deadlineMs,
				...(options.stderrTail === undefined ? {} : { stderrTail: options.stderrTail }),
				...(options.cwd === undefined ? {} : { cwd: options.cwd }) });
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

// The installer's pinned Go: published under its own config directory, never on the user's PATH.
const PINNED_GO = `${HOME}/.pi/gentle-ai/tools/go/${goAcquisition.version}/go/bin/go`;
const W_PINNED_GO = `C:\\Users\\u\\.pi\\gentle-ai\\tools\\go\\${goAcquisition.version}\\go\\bin\\go.exe`;
const goVersion = (platform = "linux") => ({ code: 0, stdout: `go version go${goAcquisition.version} ${platform === "win32" ? "windows" : platform}/amd64\n` });
/** A harness whose acquireGo publishes the pinned Go (or fails), counting calls. */
function withGo<T extends { adapters: object }>(h: T, goPath: string | Error = PINNED_GO) {
	const acquisitions: number[] = [];
	const adapters = { ...h.adapters, acquireGo: async () => {
		acquisitions.push(1);
		if (goPath instanceof Error) throw goPath;
		return { goPath, version: goAcquisition.version, acquired: true };
	} };
	return { ...h, adapters, acquisitions };
}

test("Windows with a missing or older Go acquires the pinned Go after consent and builds with it first on PATH", async () => {
	for (const go of [absent, tool("1.25.9")]) {
		const fixed = plan("win32", { go });
		assert.deepEqual(fixed.blockers, []);
		const h = withGo(harness({ layout: windowsLayout, results: { version: goVersion("win32") } }), W_PINNED_GO);
		const declined = await runStandardInstall({ plan: fixed, consent: false }, h.adapters);
		assert.equal(declined.reason, "consent-required");
		assert.deepEqual(h.acquisitions, [], "nothing is downloaded before consent");
		const result = await runStandardInstall({ plan: fixed, consent: true }, h.adapters);
		assert.equal(result.outcome, "ready");
		assert.deepEqual(result.completed, ["check-npm", "check-global-bin", "check-existing-stack", "acquire-go", "verify-go",
			"install-global", "verify-global-list", "verify-shell-bin", "verify-gentle-ai", "shell-setup"]);
		assert.deepEqual(h.acquisitions, [1]);
		const verify = h.calls.find((call) => call.command === W_PINNED_GO);
		assert.deepEqual(verify?.args, ["version"]);
		assert.equal(verify?.env.GOTOOLCHAIN, "local");
		// gentle-pi's postinstall finds go.exe on PATH: the pinned Go comes first, only for that child.
		const install = h.calls.find((call) => call.args[1] === "add");
		assert.equal(install?.env.Path.split(";")[0], "C:\\Users\\u\\.pi\\gentle-ai\\tools\\go\\1.25.14\\go\\bin");
		assert.equal(install?.env.Path.split(";")[1], W_BIN);
		for (const call of h.calls.filter((call) => call !== install && call !== verify)) assert.equal(call.env.Path.includes("tools\\go"), false);
		assert.equal(h.adapters.env.Path.includes("tools\\go"), false, "the user's environment is unchanged");
	}
});

test("a failed or unverified Go acquisition stops before anything is installed", async () => {
	const failed = withGo(harness({ layout: windowsLayout }), new Error("Go verified acquisition failed"));
	const result = await runStandardInstall({ plan: plan("win32", { go: absent }), consent: true }, failed.adapters);
	assert.deepEqual([result.outcome, result.failedStep], ["failed", "acquire-go"]);
	assert.deepEqual(result.completed, ["check-npm", "check-global-bin", "check-existing-stack"]);
	assert.equal(failed.calls.some((call) => call.args[1] === "add"), false);
	// Without an acquisition adapter the step fails the same way.
	const missing = harness({ layout: windowsLayout });
	assert.equal((await runStandardInstall({ plan: plan("win32", { go: absent }), consent: true }, missing.adapters)).failedStep, "acquire-go");
	for (const [goPath, version] of [[W_PINNED_GO, { code: 0, stdout: "go version go1.25.13 windows/amd64\n" }], [W_PINNED_GO, { code: 1 }],
		["go.exe", goVersion("win32")]] as const) {
		const h = withGo(harness({ layout: windowsLayout, results: { version } }), goPath);
		const outcome = await runStandardInstall({ plan: plan("win32", { go: absent }), consent: true }, h.adapters);
		assert.deepEqual([outcome.outcome, outcome.failedStep], ["failed", "verify-go"], goPath);
		assert.equal(h.calls.some((call) => call.args[1] === "add"), false);
	}
});

test("an acquisition the plan does not need, or a build without one, is never run", async () => {
	// A release install on macOS or Linux needs no Go: a forged acquisition is rejected.
	const forged = plan("linux");
	forged.tools.go = { status: "needs-acquire", required: requirements.go, version: goAcquisition.version };
	forged.actions.unshift({ id: "acquire-go", kind: "acquire", target: "go", version: goAcquisition.version }, { id: "verify-go", kind: "verify", target: "go" });
	// Half an acquisition, or one whose tools record does not ask for it.
	const half = plan("win32", { go: absent });
	half.actions = half.actions.filter((action: { id: string }) => action.id !== "verify-go");
	const unrecorded = plan("win32", { go: absent });
	unrecorded.tools.go = { status: "reusable", required: requirements.go };
	for (const fixed of [forged, half, unrecorded]) {
		const h = withGo(harness({ layout: fixed === forged ? posixLayout : windowsLayout }));
		const result = await runStandardInstall({ plan: fixed, consent: true }, h.adapters);
		assert.deepEqual([result.outcome, result.reason], ["blocked", "unsupported-plan"]);
		assert.deepEqual([h.calls, h.acquisitions], [[], []]);
	}
	// Windows still refuses to build when Go is neither reusable nor acquired.
	const stripped = plan("win32", { go: absent });
	stripped.actions = stripped.actions.filter((action: { target: string }) => action.target !== "go");
	const h = withGo(harness({ layout: windowsLayout }));
	assert.equal((await runStandardInstall({ plan: stripped, consent: true }, h.adapters)).reason, "go-required");
	assert.deepEqual(h.acquisitions, []);
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
		{ files: [`${W_NODE_DIR}\\npm.bat`] },
		{ files: [`${W_NODE_DIR}\\npm.com`] },
		{ files: [`${W_NODE_DIR}\\npm.ps1`, `${W_NODE_DIR}\\npm.exe`], env: { PathExt: ".PS1;.CMD" } },
	];
	for (const { files, env } of shadows) {
		const h = harness({ layout: windowsLayout, files, env });
		const result = await runStandardInstall({ plan: plan("win32"), consent: true }, h.adapters);
		assert.equal(result.outcome, "blocked");
		assert.equal(result.reason, "npm-shadowed");
		assert.equal(h.pnpmCalls().some((call) => call.startsWith("add")), false);
	}
	// An npm.exe found first (a Volta or mise shim) runs as it is, with shell:false.
	for (const { files, env, npm } of [
		{ files: [`${W_NODE_DIR}\\npm.exe`], npm: `${W_NODE_DIR}\\npm.exe` },
		{ files: ["C:\\Early\\npm.exe"], env: { Path: `${W_BIN};C:\\Early;${W_NODE_DIR}` }, npm: "C:\\Early\\npm.exe" },
	]) {
		const h = harness({ layout: windowsLayout, files, env });
		assert.equal((await runStandardInstall({ plan: plan("win32"), consent: true }, h.adapters)).outcome, "ready");
		assert.deepEqual(h.calls.filter((call) => call.command === npm).map((call) => [call.args.join(" "), call.cwd]),
			[["--version", "C:\\"], ["config get prefix", "C:\\"]]);
	}
	// An npm.cmd that is no known shim (here unreadable) is never run.
	const fake = harness({ layout: windowsLayout, files: ["C:\\Early\\npm.cmd"], env: { Path: `C:\\Early;${W_NODE_DIR}` } });
	assert.equal((await runStandardInstall({ plan: plan("win32"), consent: true }, fake.adapters)).reason, "npm-unavailable");
	// PATHEXT order wins inside one directory: .CMD before .EXE resolves Node.js's own npm.cmd.
	const ordered = harness({ layout: windowsLayout, files: [`${W_NODE_DIR}\\npm.exe`], env: { PATHEXT: "cmd;.EXE" } });
	assert.equal((await runStandardInstall({ plan: plan("win32"), consent: true }, ordered.adapters)).outcome, "ready");
	assert.equal(ordered.calls.some((call) => call.command.endsWith("npm.exe")), false);
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

// Windows command shapes, verbatim from their generators (see installer-windows-bootstrap.test.ts).
const CMD_SHIM_HEAD = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n";
const cmdShim = (target: string) => `${CMD_SHIM_HEAD}\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;
const W_APPDATA_NPM = "C:\\Users\\u\\AppData\\Roaming\\npm";
const W_REDIRECTED_CLI = `${W_APPDATA_NPM}\\node_modules\\npm\\bin\\npm-cli.js`;
const W_PREFIX_JS = `${W_NODE_DIR}\\node_modules\\npm\\bin\\npm-prefix.js`;
function windowsShapes({ files = [] as string[], texts = {} as Record<string, string>, results = {} as Record<string, Result> } = {}) {
	const calls: { command: string; args: string[]; cwd?: string }[] = [];
	const fileSet = new Set(files);
	const adapters = {
		fs: { isFile: async (path: string) => fileSet.has(path), readText: async (path: string) => {
			if (!(path in texts)) throw new Error(`ENOENT ${path}`);
			return texts[path];
		} },
		run: async (command: string, args: string[], options: { cwd?: string }) => {
			calls.push({ command, args, cwd: options.cwd });
			return { signal: null, timedOut: false, stdout: "", ...(results[[command, ...args].join(" ")] ?? { code: 1 }) };
		},
	};
	return { adapters, calls };
}
test("windowsInvocation runs what a Windows npm or pnpm shim runs, never through cmd.exe", async () => {
	const env = { Path: `${W_APPDATA_NPM};C:\\PathNode;${W_NODE_DIR}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
	// Node.js's own npm.cmd: its sibling node.exe, and the npm under npm's global prefix when it is there.
	for (const [redirected, entry] of [[true, W_REDIRECTED_CLI], [false, W_NPM_CLI]] as const) {
		const h = windowsShapes({ files: [W_NODE, W_NPM_CLI, W_PREFIX_JS, ...(redirected ? [W_REDIRECTED_CLI] : [])], texts: { [W_NPM_CMD]: NODE_NPM_CMD },
			results: { [`${W_NODE} ${W_PREFIX_JS}`]: { code: 0, stdout: `${W_APPDATA_NPM}\r\n` } } });
		assert.deepEqual(await windowsInvocation(W_NPM_CMD, env, h.adapters), { command: W_NODE, prefix: [entry] });
		assert.deepEqual(h.calls, [{ command: W_NODE, args: [W_PREFIX_JS], cwd: "C:\\" }], "the fixed prefix query, from the drive root");
	}
	// npm 6-9's npm.cmd asks npm-cli.js itself; a failed query keeps the bundled npm.
	const older = windowsShapes({ files: [W_NODE, W_NPM_CLI, W_REDIRECTED_CLI], texts: { [W_NPM_CMD]: NODE_NPM_CMD.replace(/SET "NPM_PREFIX_JS=[^\r]*\r\n/, "")
		.replace('"%NPM_PREFIX_JS%"', '"%NPM_CLI_JS%" prefix -g') } });
	assert.deepEqual(await windowsInvocation(W_NPM_CMD, env, older.adapters), { command: W_NODE, prefix: [W_NPM_CLI] });
	assert.deepEqual(older.calls.map((call) => call.args), [[W_NPM_CLI, "prefix", "-g"]]);
	// npm's cmd-shim in its global prefix: no sibling node.exe, so the first node.exe on PATH.
	const shim = `${W_APPDATA_NPM}\\npm.cmd`;
	const appdata = windowsShapes({ files: ["C:\\PathNode\\node.exe", W_REDIRECTED_CLI], texts: { [shim]: cmdShim("node_modules\\npm\\bin\\npm-cli.js") } });
	assert.deepEqual(await windowsInvocation(shim, env, appdata.adapters), { command: "C:\\PathNode\\node.exe", prefix: [W_REDIRECTED_CLI] });
	// ...never a node.cmd found first, a missing entry, an unknown shim, a .bat or an unreadable file.
	const nodeCmd = windowsShapes({ files: ["C:\\PathNode\\node.cmd", "C:\\PathNode\\node.exe", W_REDIRECTED_CLI], texts: { [shim]: cmdShim("node_modules\\npm\\bin\\npm-cli.js") } });
	assert.equal(await windowsInvocation(shim, { ...env, PATHEXT: ".CMD;.EXE" }, nodeCmd.adapters), null);
	assert.equal(await windowsInvocation(shim, env, windowsShapes({ files: ["C:\\PathNode\\node.exe"], texts: { [shim]: cmdShim("node_modules\\npm\\bin\\npm-cli.js") } }).adapters), null);
	const mise = windowsShapes({ files: ["C:\\PathNode\\node.exe"], texts: { [shim]: "@echo off\r\nsetlocal\r\nmise x -- %*\r\n" } });
	assert.equal(await windowsInvocation(shim, env, mise.adapters), null);
	assert.equal(await windowsInvocation(`${W_APPDATA_NPM}\\npm.bat`, env, mise.adapters), null);
	assert.equal(await windowsInvocation(`${W_APPDATA_NPM}\\missing.cmd`, env, mise.adapters), null);
	assert.deepEqual(mise.calls, []);
	// An npm.exe (Volta, mise) runs as it is.
	const volta = "C:\\Program Files\\Volta\\npm.exe";
	assert.deepEqual(await windowsInvocation(volta, env, windowsShapes({ files: [volta] }).adapters), { command: volta, prefix: [] });
	assert.equal(await windowsInvocation(volta, env, windowsShapes().adapters), null);
	// pnpm's own shim with the node.exe pnpm pins, and with a native target.
	const pinnedNode = "C:\\Users\\u\\AppData\\Local\\pnpm\\nodejs\\24.21.0\\node.exe";
	const pnpmShim = `${W_BIN}\\pnpm.cmd`;
	const pinned = windowsShapes({ files: [pinnedNode, W_PM_PNPM_ENTRY], texts: { [pnpmShim]: `@SETLOCAL\r\n@"${pinnedNode}"  "%~dp0\\..\\global\\v11\\abc\\node_modules\\pnpm\\bin\\pnpm.mjs" %*\r\n` } });
	assert.deepEqual(await windowsInvocation(pnpmShim, env, pinned.adapters), { command: pinnedNode, prefix: [W_PM_PNPM_ENTRY] });
	const exe = `${W_PNPM_HOME}\\global\\v11\\abc\\node_modules\\@pnpm\\exe\\pnpm.exe`;
	const native = windowsShapes({ files: [exe], texts: { [pnpmShim]: "@SETLOCAL\r\n@\"%~dp0\\..\\global\\v11\\abc\\node_modules\\@pnpm\\exe\\pnpm\"   %*\r\n" } });
	assert.deepEqual(await windowsInvocation(pnpmShim, env, native.adapters), { command: exe, prefix: [] }, "@pnpm/exe's extensionless hard link runs as its .exe twin");
});

// S10: only local drive paths. A UNC, `\\?\` or drive-less rooted path is never
// searched, read or run (even a lookup can reach a remote share).
const nonLocal = ["\\\\server\\share\\bin", "\\\\?\\C:\\bin", "\\\\.\\C:\\bin", "\\bin"];
function recordedShapes(options: Parameters<typeof windowsShapes>[0] = {}) {
	const shapes = windowsShapes(options);
	const touched: string[] = [];
	const { isFile, readText } = shapes.adapters.fs;
	shapes.adapters.fs = { isFile: async (path: string) => { touched.push(path); return isFile(path); }, readText: async (path: string) => { touched.push(path); return readText(path); } };
	return { ...shapes, touched };
}
test("Windows lookPath and windowsInvocation accept only local drive paths for the command, the PATH node and the npm prefix", async () => {
	const env = { Path: [...nonLocal, "C:\\Local"].join(";"), PATHEXT: ".COM;.EXE;.BAT;.CMD" };
	const everywhere = recordedShapes({ files: [...nonLocal, "C:\\Local"].map((directory) => `${directory}\\node.exe`) });
	assert.equal(await lookPath("node", env, "win32", everywhere.adapters.fs), "C:\\Local\\node.exe");
	assert.deepEqual(everywhere.touched.filter((path) => !/^[A-Za-z]:\\/.test(path)), [], "no non-local directory is searched");
	for (const directory of nonLocal) {
		const shapes = recordedShapes({ files: [`${directory}\\npm.exe`, `${directory}\\npm.cmd`, W_NODE, W_NPM_CLI], texts: { [`${directory}\\npm.cmd`]: NODE_NPM_CMD } });
		for (const file of [`${directory}\\npm.exe`, `${directory}\\npm.cmd`]) assert.equal(await windowsInvocation(file, env, shapes.adapters), null, file);
		assert.deepEqual([shapes.touched, shapes.calls], [[], []], directory);
	}
	// The PATH node of a shim without a sibling node.exe: only a local one runs.
	const shim = `${W_APPDATA_NPM}\\npm.cmd`;
	const remoteNode = recordedShapes({ files: ["\\\\server\\share\\bin\\node.exe", W_REDIRECTED_CLI], texts: { [shim]: cmdShim("node_modules\\npm\\bin\\npm-cli.js") } });
	assert.equal(await windowsInvocation(shim, { ...env, Path: "\\\\server\\share\\bin" }, remoteNode.adapters), null);
	// npm's global prefix: anything but a local drive path keeps the bundled npm.
	for (const prefix of ["\\\\server\\share\\npm", "\\\\?\\C:\\Users\\u\\AppData\\Roaming\\npm", "\\npm"]) {
		const h = recordedShapes({ files: [W_NODE, W_NPM_CLI, W_PREFIX_JS, `${prefix}\\node_modules\\npm\\bin\\npm-cli.js`], texts: { [W_NPM_CMD]: NODE_NPM_CMD },
			results: { [`${W_NODE} ${W_PREFIX_JS}`]: { code: 0, stdout: `${prefix}\r\n` } } });
		assert.deepEqual(await windowsInvocation(W_NPM_CMD, env, h.adapters), { command: W_NODE, prefix: [W_NPM_CLI] }, prefix);
		assert.equal(h.touched.some((path) => path.startsWith(prefix)), false, prefix);
	}
});

// S11: CMD runs an extensionless shim target through PATHEXT, in PATHEXT order.
test("an extensionless native shim target runs only when the first PATHEXT match is an .exe", async () => {
	const pnpmShim = `${W_BIN}\\pnpm.cmd`;
	const target = `${W_PNPM_HOME}\\global\\v11\\abc\\node_modules\\@pnpm\\exe\\pnpm`;
	const texts = { [pnpmShim]: "@SETLOCAL\r\n@\"%~dp0\\..\\global\\v11\\abc\\node_modules\\@pnpm\\exe\\pnpm\"   %*\r\n" };
	const invoke = (files: string[], PATHEXT = ".COM;.EXE;.BAT;.CMD") => windowsInvocation(pnpmShim, { Path: W_BIN, PATHEXT }, windowsShapes({ files, texts }).adapters);
	assert.deepEqual(await invoke([target, `${target}.exe`, `${target}.cmd`]), { command: `${target}.exe`, prefix: [] });
	assert.deepEqual(await invoke([`${target}.exe`], "exe;.CMD"), { command: `${target}.exe`, prefix: [] }, "PATHEXT entries are lowercased and dot-prefixed");
	for (const [files, PATHEXT] of [[[`${target}.com`, `${target}.exe`]], [[`${target}.cmd`, `${target}.exe`], ".CMD;.EXE"], [[`${target}.bat`]], [[target]]] as [string[], string?][]) {
		assert.equal(await invoke(files, PATHEXT), null, `${files.join(",")} ${PATHEXT ?? ""}`);
	}
});

// S8: how `gentle-shell upgrade` (and the wizard's update) runs npm and pnpm on Windows.
test("upgradeInvocation resolves npm and pnpm on Windows without cmd.exe, and is absent on POSIX", async () => {
	for (const platform of ["linux", "darwin"]) assert.equal(upgradeInvocation({ platform, env: {}, ...windowsShapes().adapters }), undefined);
	const env = { Path: `${W_BIN};${W_NODE_DIR}`, PATHEXT: ".COM;.EXE;.BAT;.CMD", GENTLE_INSTALL_PNPM_NODE: "C:\\Tools\\node.exe", GENTLE_INSTALL_PNPM_ENTRY: W_ENTRY };
	const exe = `${W_PNPM_HOME}\\global\\v11\\abc\\node_modules\\@pnpm\\exe\\pnpm.exe`;
	const h = windowsShapes({ files: [W_NODE, W_NPM_CMD, W_NPM_CLI, `${W_BIN}\\pnpm.cmd`, exe, `${W_BIN}\\other.cmd`],
		texts: { [W_NPM_CMD]: NODE_NPM_CMD, [`${W_BIN}\\pnpm.cmd`]: "@SETLOCAL\r\n@\"%~dp0\\..\\global\\v11\\abc\\node_modules\\@pnpm\\exe\\pnpm.exe\"   %*\r\n",
			[`${W_BIN}\\other.cmd`]: "@echo off\r\nvolta run %~n0 %*\r\n" } });
	const cli = upgradeInvocation({ platform: "win32", env, ...h.adapters });
	assert.deepEqual(await cli!("npm"), { command: W_NODE, prefix: [W_NPM_CLI] });
	assert.deepEqual(await cli!("pnpm"), { command: exe, prefix: [] }, "the CLI runs the user's own pnpm, as its shim runs it");
	assert.equal(await cli!("other"), null, "a shim no structure resolves never runs");
	assert.equal(await cli!("missing"), null);
	// The wizard hands pnpm over from the bootstrap: its verified pnpm runs the update.
	const wizard = upgradeInvocation({ platform: "win32", env, ...h.adapters, handoff: true });
	assert.deepEqual(await wizard!("pnpm"), { command: "C:\\Tools\\node.exe", prefix: [W_ENTRY] });
	assert.deepEqual(await wizard!("npm"), { command: W_NODE, prefix: [W_NPM_CLI] });
	assert.equal(h.calls.some((call) => /\.(cmd|bat)$/i.test(call.command)), false);
});

// S9: Corepack's pnpm.cmd runs Corepack, never pnpm's own entry: it is not pnpm.
test("windowsInvocation runs a pnpm shim only when it names pnpm's own bin entry", async () => {
	const env = { Path: W_NODE_DIR, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
	const pnpmCmd = `${W_NODE_DIR}\\pnpm.cmd`;
	for (const entry of ["node_modules\\corepack\\dist\\pnpm.js", "node_modules\\pnpm\\dist\\pnpm.cjs", "node_modules\\other\\bin\\pnpm.cjs"]) {
		const h = windowsShapes({ files: [W_NODE, `${W_NODE_DIR}\\${entry}`], texts: { [pnpmCmd]: cmdShim(entry) } });
		assert.equal(await windowsInvocation(pnpmCmd, env, h.adapters), null, entry);
		assert.deepEqual(h.calls, []);
	}
	for (const file of ["pnpm.cjs", "pnpm.mjs"]) {
		const entry = `${W_NODE_DIR}\\node_modules\\pnpm\\bin\\${file}`;
		const h = windowsShapes({ files: [W_NODE, entry], texts: { [pnpmCmd]: cmdShim(`node_modules\\pnpm\\bin\\${file}`) } });
		assert.deepEqual(await windowsInvocation(pnpmCmd, env, h.adapters), { command: W_NODE, prefix: [entry] }, file);
	}
	// Any other command keeps its JS entry, whatever it is called (here Corepack's own shim).
	const corepackCmd = `${W_NODE_DIR}\\corepack.cmd`;
	const corepackEntry = `${W_NODE_DIR}\\node_modules\\corepack\\dist\\corepack.js`;
	const corepack = windowsShapes({ files: [W_NODE, corepackEntry], texts: { [corepackCmd]: cmdShim("node_modules\\corepack\\dist\\corepack.js") } });
	assert.deepEqual(await windowsInvocation(corepackCmd, env, corepack.adapters), { command: W_NODE, prefix: [corepackEntry] });
});

test("a Windows npm is usable only by behavior: a stable --version and one absolute prefix", async () => {
	const child = { Path: W_NODE_DIR, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
	const npm = (version: Result, prefix: Result) => windowsShapes({ files: [W_NODE, W_NPM_CMD, W_NPM_CLI], texts: { [W_NPM_CMD]: NODE_NPM_CMD },
		results: { [`${W_NODE} ${W_NPM_CLI} --version`]: version, [`${W_NODE} ${W_NPM_CLI} config get prefix`]: prefix } });
	const working = npm({ code: 0, stdout: "11.19.0\r\n" }, { code: 0, stdout: "C:\\Users\\u\\AppData\\Roaming\\npm\r\n" });
	assert.deepEqual(await genuineNpm(child, "win32", "C:\\bootstrap\\node.exe", working.adapters), { command: W_NODE, prefix: [W_NPM_CLI] });
	assert.deepEqual(working.calls.map((call) => [call.command, call.args.slice(1).join(" "), call.cwd]), [[W_NODE, "--version", "C:\\"], [W_NODE, "config get prefix", "C:\\"]],
		"run with the Node npm.cmd selects, never the installer's");
	for (const [version, prefix] of [[{ code: 1 }, { code: 0, stdout: "C:\\x" }], [{ code: 0, stdout: "11.19.0-pre" }, { code: 0, stdout: "C:\\x" }],
		[{ code: 0, stdout: "11.19.0" }, { code: 0, stdout: "relative\\prefix" }], [{ code: 0, stdout: "11.19.0" }, { code: 0, stdout: "C:\\a\r\nC:\\b" }],
		[{ code: 0, stdout: "11.19.0" }, { code: null, timedOut: true, stdout: "C:\\x" }]] as Result[][]) {
		assert.equal(await genuineNpm(child, "win32", "C:\\bootstrap\\node.exe", npm(version, prefix).adapters), false, JSON.stringify([version, prefix]));
	}
});

test("Windows hands a native pnpm.exe off as the command itself; nothing else is accepted in its place", async () => {
	const exe = `${W_PNPM_HOME}\\pnpm.exe`;
	const fs = { isFile: async () => false };
	assert.deepEqual(await pnpmInvocation({ GENTLE_INSTALL_PNPM_COMMAND: exe }, "win32", fs), { command: exe, prefix: [] });
	for (const command of ["pnpm.exe", `${W_PNPM_HOME}\\pnpm.cmd`, `${W_PNPM_HOME}\\pnpm`, ""]) {
		assert.equal(await pnpmInvocation({ GENTLE_INSTALL_PNPM_COMMAND: command }, "win32", fs), null, command);
	}
	// Node plus entry still wins, and POSIX never reads the Windows-only key.
	assert.deepEqual(await pnpmInvocation({ GENTLE_INSTALL_PNPM_COMMAND: exe, GENTLE_INSTALL_PNPM_NODE: W_NODE, GENTLE_INSTALL_PNPM_ENTRY: W_ENTRY }, "win32", fs),
		{ command: W_NODE, prefix: [W_ENTRY] });
	assert.equal(await pnpmInvocation({ GENTLE_INSTALL_PNPM_COMMAND: "/opt/pnpm", PATH: "/usr/bin" }, "linux", fs), null);
	const h = harness({ layout: windowsLayout, env: { GENTLE_INSTALL_PNPM_NODE: "", GENTLE_INSTALL_PNPM_ENTRY: "", GENTLE_INSTALL_PNPM_COMMAND: exe } });
	const result = await runStandardInstall({ plan: plan("win32"), consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.deepEqual(h.calls.filter((call) => call.command === exe).map((call) => call.args.join(" ")), ["bin -g", LIST, INSTALL, LIST]);
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

// Version-manager npm commands: a mise shim (a symlink to the mise binary) and a Volta-like shim script.
const MISE_NPM = "/home/u/.local/share/mise/shims/npm";
const VOLTA_NPM = "/home/u/.volta/bin/npm";
const userNpm = (npm: string) => ({ env: { PATH: `${BIN}:${npm.slice(0, npm.lastIndexOf("/"))}:/usr/bin` }, files: [npm],
	realpaths: npm === MISE_NPM ? { [MISE_NPM]: "/home/u/.local/bin/mise" } : {},
	texts: npm === VOLTA_NPM ? { [VOLTA_NPM]: "#!/bin/sh\nexec volta-shim npm \"$@\"\n" } : {},
	results: { "--version": { code: 0, stdout: "10.9.2\n" }, "config get prefix": { code: 0, stdout: "/home/u/.local/share/mise/installs/node/22.18.0\n" } } });

test("missing or non-working npm blocks before installation", async () => {
	const variants: object[] = [
		{ env: { PATH: `${BIN}:/usr/bin` } },
		{ results: { "--version": { code: 1, stdout: "" } } },
		{ results: { "--version": { code: 0, timedOut: true, stdout: "11.19.0\n" } } },
		{ results: { "--version": { code: 0, stdout: "11.19.0-pre.1\n" } } },
		{ results: { "--version": { code: 0, stdout: "npm 11\n" } } },
		{ results: { "config get prefix": { code: 1, stdout: "" } } },
		{ results: { "config get prefix": { code: 0, stdout: "relative/prefix\n" } } },
		{ results: { "config get prefix": { code: 0, stdout: "\n" } } },
		{ results: { "config get prefix": { code: 0, stdout: "/opt/node\n/elsewhere\n" } } },
	];
	for (const variant of variants) {
		const h = harness(variant);
		const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
		assert.equal(result.outcome, "blocked", JSON.stringify(variant));
		assert.equal(result.reason, "npm-unavailable");
		assert.equal(h.pnpmCalls().some((call) => call.startsWith("add")), false);
	}
});

test("POSIX accepts the first npm on PATH that works, whatever installed it, by running that npm itself", async () => {
	for (const npm of ["/opt/node/bin/npm", MISE_NPM, VOLTA_NPM]) {
		const h = harness(npm === "/opt/node/bin/npm" ? {} : userNpm(npm));
		const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
		assert.equal(result.outcome, "ready", npm);
		assert.equal(result.completed[0], "check-npm");
		const runs = h.calls.filter((call) => call.command === npm);
		assert.deepEqual(runs.map((call) => call.args), [["--version"], ["config", "get", "prefix"]]);
		for (const call of runs) {
			// The user's env with $PNPM_HOME/bin first, from `/` so no project-local tool config applies.
			assert.equal(call.cwd, "/");
			assert.equal(call.env.PATH.split(":")[0], BIN);
			assert.equal(call.env.HOME, HOME);
			assert.ok(call.deadlineMs > 0);
		}
		// npm's own CLI is never run with the installer's Node: a shim has none to find.
		assert.equal(h.calls.some((call) => call.command === NODE && /npm-cli\.js$/.test(call.args[0] ?? "")), false);
		assert.deepEqual(h.pnpmCalls(), ["bin -g", LIST, INSTALL, LIST]);
	}
});

test("an npm in $PNPM_HOME/bin still needs the persistence pin even when it works", async () => {
	const script = harness({ files: [`${BIN}/npm`], texts: { [`${BIN}/npm`]: "#!/bin/sh\nexec /opt/fake/npm \"$@\"\n" } });
	const blocked = await runStandardInstall({ plan: plan(), consent: true }, script.adapters);
	assert.equal(blocked.outcome, "blocked");
	assert.equal(blocked.reason, "npm-unavailable");
	assert.equal(script.calls.some((call) => call.command === `${BIN}/npm`), false);
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
	// The setup child gets its stderr tail captured, as pnpm's global add does (detail below).
	assert.deepEqual(h.calls.filter((call) => call.stderrTail !== undefined).map((call) => [call.args.at(-1), call.stderrTail]),
		[["--allow-build=gentle-pi", 4096], ["setup", 4096]]);
	for (const setup of [{ code: 2 }, { code: 2, stderrTail: " \n\t\n" }]) {
		const silent = await runStandardInstall({ plan: plan(), consent: true }, harness({ results: { "gentle-shell setup": setup } }).adapters);
		assert.equal(silent.failedStep, "shell-setup");
		assert.equal("detail" in silent, false);
	}
	const succeeded = await runStandardInstall({ plan: plan(), consent: true }, harness({ results: { "gentle-shell setup": { code: 0, stderrTail: "Error: ignored" } } }).adapters);
	assert.equal(succeeded.outcome, "ready");
	assert.equal("detail" in succeeded, false);
	// A step without a detail rule never carries one.
	const early = await runStandardInstall({ plan: plan(), consent: true }, harness({ results: { "bin -g": { code: 0, stdout: "/elsewhere\n" }, add: { code: 1, stderrTail: "Error: x" } } }).adapters);
	assert.equal(early.reason, "global-bin-mismatch");
	assert.equal("detail" in early, false);
});

test("a gentle-shell setup detail is unchanged next to the pnpm install's own detail rule", async () => {
	const stderrTail = `Error: GitHub API returned HTTP 403 (${HOME}/.gentle-shell/agent)\n`;
	const h = harness({ results: { add: { code: 0, stdout: "Error: an earlier warning\n", stderrTail: "Error: ignored\n" }, "gentle-shell setup": { code: 1, stderrTail } } });
	const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
	assert.deepEqual([result.outcome, result.failedStep, result.detail], ["failed", "shell-setup", "Error: GitHub API returned HTTP 403 (~/.gentle-shell/agent)"]);
});

// Observed shape: pnpm reports a failed postinstall on stdout, its own summary last.
const PNPM_ADD_POSTINSTALL = `Progress: resolved 120, reused 119, downloaded 1, added 2\n.../gentle-pi postinstall: gentle-pi could not install its package-local Gentle AI v4.0.0 binary: Gentle AI Go SumDB source installation failed.\n.../gentle-pi postinstall:   caused by Error: Command failed: ${HOME}/go/bin/go install (code 1)\n.../gentle-pi postinstall:   root cause Error: go: open ${HOME}/x: The directory name is invalid.\n ELIFECYCLE  Command failed with exit code 1.\n`;

test("a failed pnpm install of Pi and Gentle Shell reports pnpm's last error line, from stderr else stdout", async () => {
	const h = harness({ results: { add: { code: 1, stdout: PNPM_ADD_POSTINSTALL, stderrTail: "" } } });
	const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
	assert.equal(result.failedStep, "install-global");
	assert.equal(result.detail, ".../gentle-pi postinstall:   root cause Error: go: open ~/x: The directory name is invalid.");
	assert.deepEqual(h.calls.filter((call) => call.stderrTail !== undefined).map((call) => [call.args.slice(1).join(" "), call.stderrTail]), [[INSTALL, 4096]]);
	const stderr = await runStandardInstall({ plan: plan(), consent: true }, harness({ results: { add: { code: 1, stdout: PNPM_ADD_POSTINSTALL,
		stderrTail: `[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/gentle-pi: Not Found\n` } } }).adapters);
	assert.equal(stderr.detail, "[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/gentle-pi: Not Found");
	const silent = await runStandardInstall({ plan: plan(), consent: true }, harness({ results: { add: { code: 1 } } }).adapters);
	assert.deepEqual([silent.failedStep, "detail" in silent], ["install-global", false]);
});

// Observed with pnpm 11.1.1 and no SHELL: the error goes to stdout after the global CLI install output.
const PNPM_SETUP_NO_SHELL = `Installing pnpm CLI globally from /usr/bin\nProgress: resolved 1, reused 1, downloaded 0, added 1, done\n[WARN] Failed to create bin at ${HOME}/.local/share/pnpm/bin/pnpm.\n\nDone in 393ms using pnpm v11.1.1\n[ERR_PNPM_UNKNOWN_SHELL] Could not infer shell type.\n\nSet the SHELL environment variable to your active shell.\nSupported shell languages are bash, zsh, fish, ksh, dash, sh, and nushell.\n`;

test("a failed pnpm setup reports its error line from stderr, else from stdout", async () => {
	const noPath = { PATH: "/opt/node/bin:/usr/bin" };
	const h = harness({ env: noPath, results: { "pnpm setup": { code: 1, stdout: PNPM_SETUP_NO_SHELL, stderrTail: "" } } });
	const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
	assert.equal(result.failedStep, "persist-path");
	assert.equal(result.detail, "[ERR_PNPM_UNKNOWN_SHELL] Could not infer shell type.");
	// Both fixed setup commands request the same bounded stderr tail, as pnpm's global add does.
	assert.deepEqual(h.calls.filter((call) => call.stderrTail !== undefined).map((call) => [call.args.at(-1), call.stderrTail]),
		[["--allow-build=gentle-pi", 4096], ["setup", 4096], ["setup", 4096]]);
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
// The bootstrap's pnpm is bootstrap-only too, so it is persisted with npm.
const bootstrapNode = { ...tool("24.18.0"), persistent: false, npm: false };
const bootstrapPnpm = { ...tool("11.1.1"), compatible: true, persistent: false };
function persistPlan(platform = "linux", node: object = bootstrapNode) {
	return plan(platform, { node, pnpm: bootstrapPnpm });
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

test("after persist-node, check-npm and configure-npm-prefix use the pinned npm even next to a working user npm", async () => {
	// $PNPM_HOME/bin is first in the child env, so the persisted shim resolves before any user npm.
	const h = harness({ ...userNpm(MISE_NPM), results: { ...persistedList, ...userNpm(MISE_NPM).results } });
	const result = await runStandardInstall({ plan: persistPlan(), consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.equal(result.npmPrefix, "configured");
	assert.deepEqual(result.completed.slice(0, PERSISTED_STEPS.length), PERSISTED_STEPS);
	assert.equal(h.calls.some((call) => call.command === MISE_NPM), false);
	assert.deepEqual(h.calls.filter((call) => call.args.includes("config")).map((call) => [call.command, call.args[0]]),
		Array(3).fill([PERSISTENT_NODE, PM_NPM_CLI]));
});

test("an older Node and incompatible pnpm left alongside: the pinned copies run every step and are persisted", async () => {
	const fixed = plan("linux", { node: { ...bootstrapNode, version: "24.21.0", found: "22.18.0" },
		pnpm: { ...tool("11.1.1"), compatible: true, persistent: false, found: "10.27.0" } });
	assert.equal(fixed.tools.node.found, "22.18.0");
	const h = harness({ results: persistedList });
	const result = await runStandardInstall({ plan: fixed, consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.deepEqual(h.pnpmCalls(), ["bin -g", LIST, RUNTIME_SET, PM_ADD, "store path", INSTALL, LIST]);
	// pnpm always runs through the installer's own copy, never a pnpm found on PATH.
	for (const call of h.calls.filter((c) => c.args[0] === ENTRY)) assert.equal(call.command, NODE);
	assert.equal(h.calls.some((call) => /\/pnpm$/.test(call.command)), false);
	assert.equal(h.calls.at(-1)?.command, NODE);
});

test("the full persistence group runs exactly when Node is bootstrap-only", async () => {
	// pnpm is added with npm only when it is bootstrap-only too.
	for (const [pnpm, add] of [[{ ...tool("11.1.1"), compatible: true, persistent: true }, NPM_ADD], [bootstrapPnpm, PM_ADD]] as const) {
		const h = harness({ results: persistedList });
		const result = await runStandardInstall({ plan: plan("linux", { node: { ...tool("24.18.0"), persistent: false, npm: true }, pnpm }),
			consent: true }, h.adapters);
		assert.equal(result.outcome, "ready");
		assert.deepEqual(h.pnpmCalls().slice(2, 4), [RUNTIME_SET, add]);
	}
	const h = harness();
	const result = await runStandardInstall({ plan: plan("linux", { node: { ...tool("24.18.0"), persistent: true, npm: true } }), consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.equal(result.npmPrefix, undefined);
	assert.deepEqual(h.pnpmCalls(), ["bin -g", LIST, INSTALL, LIST]);
	assert.equal(h.calls.some((call) => call.args[0] === PM_NPM_CLI || call.command === PERSISTENT_NODE), false);
});

test("bootstrap-only Node next to a persistent newer pnpm 11 adds only npm: that pnpm is never downgraded", async () => {
	const newer = { ...tool("11.5.0"), compatible: true, persistent: true, inGlobalBin: true };
	const fixed = plan("linux", { node: { ...tool("24.18.0"), persistent: false, npm: true }, pnpm: newer });
	assert.deepEqual(fixed.actions.slice(0, 3).map((action: { id: string }) => action.id), ["persist-node", "persist-npm", "configure-npm-prefix"]);
	const h = harness({ results: persistedList });
	const result = await runStandardInstall({ plan: fixed, consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.equal(result.npmPrefix, "configured");
	assert.deepEqual(h.pnpmCalls(), ["bin -g", LIST, RUNTIME_SET, NPM_ADD, "store path", INSTALL, LIST]);
	assert.deepEqual(result.completed, ["check-global-bin", "check-existing-stack", "persist-node", "persist-npm", "verify-persistent-runtime",
		"check-npm", "configure-npm-prefix", ...AFTER_STACK]);
	assert.equal(h.pnpmCalls().some((call) => call.includes("pnpm@")), false);
	// A failed npm add stops before the stack install, after the runtime.
	const failing = harness({ results: { ...persistedList, "add-npm": { code: 1 } } });
	const failed = await runStandardInstall({ plan: fixed, consent: true }, failing.adapters);
	assert.equal(failed.failedStep, "persist-npm");
	assert.deepEqual(failed.completed, ["check-global-bin", "check-existing-stack", "persist-node"]);
	assert.deepEqual(failing.pnpmCalls(), ["bin -g", LIST, RUNTIME_SET, NPM_ADD]);
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
		// No runtime and no prefix change: check-npm only reads the user's npm.
		assert.equal(h.calls.some((call) => call.command === PERSISTENT_NODE || call.args.includes("set")), false);
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
	for (const extra of [[npmAction, pnpmAction], [both, prefix], [node, pnpmAction, prefix], [node, npmAction], [node, both], [npmAction, prefix]]) {
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
	// A clean Windows install still provides Go before gentle-pi's postinstall.
	assert.ok(plan("win32", { go: absent }).actions.some((action: { id: string }) => action.id === "acquire-go"));
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
			packShell: async (request: { commit: string; ctx: object; platform: string }) => {
				calls.push(["packShell", { commit: request.commit, ctx: request.ctx, platform: request.platform }]);
				return MAIN_TGZ;
			},
			writeChannel: async (ctx: object, state: object) => {
				calls.push(["writeChannel", { ctx, state }]);
			},
		},
	};
}
const MAIN_ADD = `add -g ${MAIN_TGZ} --allow-build=gentle-pi`;
function mainHarness(mainListing = listing(PI_INSTALL_VERSION, MAIN_VERSION, MAIN_ROOT), extra: { texts?: Record<string, string>; results?: object } = {}) {
	const h = harness({ files: ["/usr/bin/go"], realpaths: { [MAIN_ROOT]: MAIN_ROOT },
		results: { [LIST]: [emptyList, { code: 0, stdout: listing() }, { code: 0, stdout: mainListing }],
			[`${MAIN_ROOT}/bin/gentle-shell.mjs setup`]: { code: 0 } }, ...extra,
		texts: { [besidePi(MAIN_ROOT)]: piPackage(), ...extra.texts } });
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
		["packShell", { commit: SHELL_SHA, ctx, platform: "linux" }],
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

test("a main plan with a missing or older Go builds Gentle AI with the pinned Go and never runs the user's Go", async () => {
	for (const go of [absent, tool("1.24.0")]) {
		const fixed = mainPlan({ go });
		assert.deepEqual(fixed.blockers, []);
		const h = withGo(mainHarness(undefined, { results: { [LIST]: [emptyList, { code: 0, stdout: listing() },
			{ code: 0, stdout: listing(PI_INSTALL_VERSION, MAIN_VERSION, MAIN_ROOT) }], [`${MAIN_ROOT}/bin/gentle-shell.mjs setup`]: { code: 0 },
			version: goVersion() } }));
		const result = await runStandardInstall({ plan: fixed, consent: true }, h.adapters);
		assert.equal(result.outcome, "ready");
		assert.deepEqual(result.completed, ["check-npm", "check-global-bin", "check-existing-stack", "acquire-go", "verify-go", "install-global",
			"verify-global-list", "verify-shell-bin", "verify-gentle-ai", "build-gentle-ai-main", "install-shell-main", "record-channel", "shell-setup"]);
		const build = h.main.calls.find(([name]) => name === "buildGentleAi")?.[1] as { goPath: string };
		assert.equal(build.goPath, PINNED_GO);
		assert.equal(h.calls.some((call) => call.command === "/usr/bin/go"), false, "the user's Go is never run");
	}
});

test("a failed pinned Go download stops before the runtime is persisted, so nothing was installed", async () => {
	const fixed = mainPlan({ node: bootstrapNode, go: absent });
	assert.deepEqual(fixed.blockers, []);
	const h = withGo(mainHarness(), new Error("Go verified acquisition failed; nothing was published", { cause: new Error("size") }));
	const result = await runStandardInstall({ plan: fixed, consent: true }, h.adapters);
	assert.equal(result.outcome, "failed");
	assert.equal(result.failedStep, "acquire-go");
	assert.deepEqual(result.completed, ["check-global-bin", "check-existing-stack"]);
	assert.equal(h.pnpmCalls().includes(RUNTIME_SET), false, "Node is not persisted");
	assert.equal("detail" in result, false, "a download failure carries no detail");
});

test("a Go destination left by an earlier run fails acquire-go with the folder to remove, the home shortened to ~", async () => {
	const folder = `${HOME}/.pi/gentle-ai/tools/go/${goAcquisition.version}`;
	const h = withGo(mainHarness(), new Error("Go verified acquisition failed; nothing was published",
		{ cause: new Error(`Conflicting Go destination: ${folder}`) }));
	const result = await runStandardInstall({ plan: mainPlan({ go: absent }), consent: true }, h.adapters);
	assert.equal(result.outcome, "failed");
	assert.equal(result.failedStep, "acquire-go");
	assert.equal(result.detail, `Conflicting Go destination: ~/.pi/gentle-ai/tools/go/${goAcquisition.version}`);
});

test("a failed main step reports the main channel's error and its cause, the home as ~, never another error's text", async () => {
	const build = mainHarness();
	build.adapters.mainChannel.buildGentleAi = async () => {
		throw new MainChannelError("main-gentle-ai-build-failed", "go install github.com/gentleman-programming/gentle-ai/v4/cmd/gentle-ai@x failed",
			new Error(`go: downloading golang.org/x/sys\ngolang.org/x/sys/cpu: fork/exec ${HOME}/.pi/asm: The directory name is invalid.`));
	};
	const built = await runStandardInstall({ plan: mainPlan(), consent: true }, build.adapters);
	assert.deepEqual([built.failedStep, built.detail], ["build-gentle-ai-main", "golang.org/x/sys/cpu: fork/exec ~/.pi/asm: The directory name is invalid."]);
	const limited = mainHarness();
	limited.adapters.mainChannel.resolveCommit = async (repository: string) => {
		if (repository.endsWith("/gentle-ai")) return AI_SHA;
		throw new MainChannelError("main-commit-unavailable", `GitHub did not return the latest main commit of ${repository} (HTTP 403)`);
	};
	const resolved = await runStandardInstall({ plan: mainPlan(), consent: true }, limited.adapters);
	assert.deepEqual([resolved.failedStep, resolved.detail],
		["install-shell-main", "main-commit-unavailable: GitHub did not return the latest main commit of Gentleman-Programming/gentle-shell (HTTP 403)"]);
	// The main package's own pnpm add reports pnpm's line, as install-global does.
	const add = mainHarness(undefined, { results: { [LIST]: [emptyList, { code: 0, stdout: listing() }], add: [{ code: 0 }, { code: 1, stdout: PNPM_ADD_POSTINSTALL }] } });
	const added = await runStandardInstall({ plan: mainPlan(), consent: true }, add.adapters);
	assert.deepEqual([added.failedStep, added.detail], ["install-shell-main", ".../gentle-pi postinstall:   root cause Error: go: open ~/x: The directory name is invalid."]);
	assert.equal(add.calls.filter((call) => call.stderrTail === 4096 && call.args.includes(MAIN_TGZ)).length, 1);
	// Any other error keeps its text out of the result.
	const plain = mainHarness();
	plain.adapters.mainChannel.buildGentleAi = async () => { throw new Error(`EACCES ${HOME}/.pi`); };
	const hidden = await runStandardInstall({ plan: mainPlan(), consent: true }, plain.adapters);
	assert.deepEqual([hidden.failedStep, "detail" in hidden], ["build-gentle-ai-main", false]);
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
	// A pnpm Pi newer than PI_INSTALL_VERSION is kept too: gentle-pi gets its own pnpm group, nothing is replaced.
	for (const version of ["1.2.0", PI_INSTALL_VERSION]) {
		const h = harness({ results: { [LIST]: [piOnlyList(version), { code: 0, stdout: listing(version) }], [SHELL_ONLY_ADD]: { code: 0 } } });
		const result = await runStandardInstall({ plan: existingPlan({ pi: tool(version) }), consent: true }, h.adapters);
		assert.equal(result.outcome, "ready", version);
		assert.deepEqual(h.pnpmCalls(), ["bin -g", LIST, SHELL_ONLY_ADD, LIST]);
		assert.deepEqual(result.completed, ["check-npm", "check-global-bin", "check-existing-shell", "install-global",
			"verify-global-list", "verify-shell-bin", "verify-gentle-ai", "shell-setup"]);
		assert.equal(h.calls.some((call) => call.args.includes(`${PI_PACKAGE_NAME}@${PI_INSTALL_VERSION}`)), false);
	}
});

test("adding only Gentle Shell still refuses a gentle-pi that pnpm already lists", async () => {
	const h = harness({ results: { [LIST]: { code: 0, stdout: listing("1.2.0") } } });
	const result = await runStandardInstall({ plan: existingPlan({}), consent: true }, h.adapters);
	assert.deepEqual([result.outcome, result.reason], ["blocked", "existing-stack"]);
	assert.equal(h.calls.some((call) => call.args[1] === "add"), false);
});

// --- The Pi that Gentle Shell runs: pnpm 11 installs every `add -g` argument as its own
// group, so gentle-pi may get a newer Pi beside it than PI_INSTALL_VERSION (at least the minimum).
test("Pi and gentle-pi are added as separate pnpm groups, so a later `pi update` keeps gentle-pi", async () => {
	const separate = ["add", "-g", `${PI_PACKAGE_NAME}@${PI_INSTALL_VERSION}`, `gentle-pi@${requirements.shell}`, "--allow-build=gentle-pi"];
	const h = harness();
	const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.deepEqual(h.calls.filter((call) => call.args[1] === "add").map((call) => call.args.slice(1)), [separate]);
	assert.equal(h.calls.some((call) => call.args.some((arg) => arg.includes(","))), false);
	const w = harness({ layout: windowsLayout });
	assert.equal((await runStandardInstall({ plan: plan("win32"), consent: true }, w.adapters)).outcome, "ready");
	assert.deepEqual(w.calls.filter((call) => call.args[1] === "add").map((call) => call.args.slice(1)), [separate]);
});

test("verify-global-list accepts the Pi the launcher runs beside gentle-pi at the minimum or newer, and reports one other than the pin", async () => {
	// pnpm's latest peer beside gentle-pi (or nested in it): Gentle Shell runs it, and the outcome says which.
	for (const texts of [{ [besidePi(PACKAGE_ROOT)]: piPackage("1.1.0") }, { [nestedPi(PACKAGE_ROOT)]: piPackage("1.1.0") },
		{ [besidePi(PACKAGE_ROOT)]: piPackage(requirements.pi) }]) {
		const h = harness({ texts });
		const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
		assert.equal(result.outcome, "ready", JSON.stringify(texts));
		assert.equal(result.piVersion, Object.values(texts)[0].includes("1.1.0") ? "1.1.0" : requirements.pi);
	}
	// The pin itself adds nothing to the outcome.
	assert.equal("piVersion" in (await runStandardInstall({ plan: plan(), consent: true }, harness().adapters)), false);
	const wrong = [
		{ [besidePi(PACKAGE_ROOT)]: piPackage("0.99.0") },
		// A Pi nested in gentle-pi resolves first, even below the minimum.
		{ [nestedPi(PACKAGE_ROOT)]: piPackage("0.99.0"), [besidePi(PACKAGE_ROOT)]: piPackage("1.1.0") },
		{ [besidePi(PACKAGE_ROOT)]: piPackage("1.2.0-beta.1") },
		{ [besidePi(PACKAGE_ROOT)]: JSON.stringify({ name: "not-pi", version: PI_INSTALL_VERSION }) },
		{ [besidePi(PACKAGE_ROOT)]: "not json" },
	];
	for (const texts of wrong) {
		const h = harness({ texts });
		const result = await runStandardInstall({ plan: plan(), consent: true }, h.adapters);
		assert.deepEqual([result.outcome, result.failedStep], ["failed", "verify-global-list"], JSON.stringify(texts));
		assert.equal(h.calls.some((call) => call.args[0] === SHELL_ENTRY), false);
	}
	// No Pi beside gentle-pi at all: the launcher would run any `pi` on PATH.
	const bare = `${PNPM_HOME}/global/v11/xyz/node_modules/gentle-pi`;
	const missing = harness({ realpaths: { [bare]: bare },
		results: { [LIST]: [emptyList, { code: 0, stdout: listing(PI_INSTALL_VERSION, requirements.shell, bare) }] } });
	const failed = await runStandardInstall({ plan: plan(), consent: true }, missing.adapters);
	assert.deepEqual([failed.outcome, failed.failedStep], ["failed", "verify-global-list"]);
});

test("the main Shell is added alone and its adjacent Pi is verified like the release one", async () => {
	const h = mainHarness(undefined, { texts: { [besidePi(MAIN_ROOT)]: piPackage("1.1.0") } });
	const result = await runStandardInstall({ plan: mainPlan(), consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.equal(result.piVersion, "1.1.0");
	assert.deepEqual(h.calls.filter((call) => call.args[1] === "add").map((call) => call.args.slice(1)),
		[INSTALL.split(" "), MAIN_ADD.split(" ")]);
	const below = mainHarness(undefined, { texts: { [besidePi(MAIN_ROOT)]: piPackage("0.99.0") } });
	const failed = await runStandardInstall({ plan: mainPlan(), consent: true }, below.adapters);
	assert.deepEqual([failed.outcome, failed.failedStep], ["failed", "install-shell-main"]);
});

test("a pnpm-owned Gentle Shell update is verified with a Pi at the minimum or newer beside it; an npm-owned one is not", async () => {
	const OLD_ROOT = `${PNPM_HOME}/global/v11/old/node_modules/gentle-pi`;
	const fixed = existingPlan({ shell: { available: true, version: "3.9.0", usable: true, global: true, owner: "pnpm" },
		gentleAi: { available: null }, setup: { available: null } });
	const located = [{ root: OLD_ROOT, version: "3.9.0", owner: "pnpm" }, { root: PACKAGE_ROOT, version: requirements.shell, owner: "pnpm" }];
	const h = updateHarness({ located, texts: { [besidePi(PACKAGE_ROOT)]: piPackage("1.1.0") } });
	const result = await runStandardInstall({ plan: fixed, consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.equal(result.piVersion, "1.1.0");
	assert.deepEqual(result.completed.slice(3, 5), ["update-shell", "verify-updated-shell"]);
	for (const texts of [{ [besidePi(PACKAGE_ROOT)]: piPackage("0.99.0") }, { [nestedPi(PACKAGE_ROOT)]: piPackage("0.99.0") }]) {
		const wrong = updateHarness({ located, texts });
		const failed = await runStandardInstall({ plan: fixed, consent: true }, wrong.adapters);
		assert.deepEqual([failed.outcome, failed.failedStep], ["failed", "verify-updated-shell"]);
	}
	// npm keeps resolving its own peer; nothing beside an npm Shell is read.
	const npm = updateHarness();
	const npmResult = await runStandardInstall({ plan: existingPlan({ shell: { available: true, version: "3.9.0", usable: true, global: true, owner: "npm" },
		gentleAi: { available: null }, setup: { available: null } }), consent: true }, npm.adapters);
	assert.equal(npmResult.outcome, "ready");
});

test("a setup recovery accepts a newer Pi beside gentle-pi but not one below the minimum", async () => {
	const newer = harness({ results: installedList, texts: { [besidePi(PACKAGE_ROOT)]: piPackage("1.1.0") } });
	assert.equal((await runStandardInstall({ plan: recoveryPlan(), consent: true }, newer.adapters)).outcome, "ready");
	const h = harness({ results: installedList, texts: { [besidePi(PACKAGE_ROOT)]: piPackage("0.99.0") } });
	const result = await runStandardInstall({ plan: recoveryPlan(), consent: true }, h.adapters);
	assert.deepEqual([result.outcome, result.reason], ["blocked", "existing-stack-unverified"]);
	assert.equal(h.calls.some((call) => call.args[0] === SHELL_ENTRY), false);
});

function updateHarness({ located = [{ root: NPM_SHELL_ROOT, version: "3.9.0", owner: "npm" }, { root: NPM_SHELL_ROOT, version: requirements.shell, owner: "npm" }] as Array<object | null>,
	upgrade = async () => true as boolean, results = {} as Record<string, Result>, texts = {} as Record<string, string> } = {}) {
	const h = harness({ results: { [`${NPM_SHELL_ROOT}/bin/gentle-shell.mjs setup`]: { code: 0 }, ...results }, texts });
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

test("updating to main without a usable Go acquires the pinned Go first and hands it to the upgrade", async () => {
	const mainVersion = `${requirements.shell}-main.6e7e3a18f794`;
	const fixed = existingPlan({ shell: { available: true, version: requirements.shell, usable: true, global: true, owner: "npm" },
		gentleAi: { available: null }, setup: { available: null }, go: absent }, "main");
	assert.deepEqual(fixed.actions.map((action: { id: string }) => action.id), ["acquire-go", "verify-go", "update-shell-main", "setup-shell", "verify-readiness"]);
	const h = withGo(updateHarness({ located: [{ root: NPM_SHELL_ROOT, version: requirements.shell, owner: "npm" }, { root: NPM_SHELL_ROOT, version: mainVersion, owner: "npm" }],
		results: { version: goVersion() } }));
	const result = await runStandardInstall({ plan: fixed, consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.deepEqual(result.completed.slice(3, 6), ["acquire-go", "verify-go", "update-shell"]);
	assert.deepEqual(h.upgrades, [{ channel: "main", packageRoot: NPM_SHELL_ROOT, currentVersion: requirements.shell, goPath: PINNED_GO }]);
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

test("a failed Gentle Shell update reports the upgrade's main-channel error, the home as ~", async () => {
	const plan = existingPlan({ shell: { available: true, version: "3.9.0", usable: true, global: true, owner: "npm" },
		gentleAi: { available: null }, setup: { available: null } });
	const h = updateHarness({ upgrade: async () => {
		throw new MainChannelError("main-shell-pack-failed", "the Gentle Shell source archive could not be extracted",
			new Error(`tar (child): Cannot connect to D: resolve failed\ntar: Error is not recoverable: exiting now (${HOME}/.pi)`));
	} });
	const result = await runStandardInstall({ plan, consent: true }, h.adapters);
	assert.deepEqual([result.failedStep, result.detail], ["update-shell", "tar: Error is not recoverable: exiting now (~/.pi)"]);
});

// --- An older Pi: updated with the package manager that owns it, before any Gentle Shell step ------
const PI_ROOT = `${PNPM_HOME}/global/v11/abc/node_modules/${PI_PACKAGE_NAME}`;
const NEW_PI_ROOT = `${PNPM_HOME}/global/v11/def/node_modules/${PI_PACKAGE_NAME}`;
const NPM_ROOT = "/usr/local/lib/node_modules";
const NPM_PI_ROOT = `${NPM_ROOT}/${PI_PACKAGE_NAME}`;
const USER_NPM = "/opt/node/bin/npm";
const PI_UPDATE = `add -g ${PI_PACKAGE_NAME}@${PI_INSTALL_VERSION}`;
const NPM_PI_UPDATE = `install -g ${PI_PACKAGE_NAME}@${PI_INSTALL_VERSION}`;
const olderPi = (owner: string, version = "0.87.1") => ({ available: true, version, usable: true, owner });
const piBefore = { root: PI_ROOT, version: "0.87.1", owner: "pnpm" };
const piAfter = { root: NEW_PI_ROOT, version: PI_INSTALL_VERSION, owner: "pnpm" };
const npmPiBefore = { root: NPM_PI_ROOT, version: "0.87.1", owner: "npm" };
const npmPiAfter = { root: NPM_PI_ROOT, version: PI_INSTALL_VERSION, owner: "npm" };
const piOnlyList = (version: string) => ({ code: 0, stdout: JSON.stringify([{ path: `${PNPM_HOME}/global/v11`, dependencies: {
	[PI_PACKAGE_NAME]: { version } } }]) });

/** Adds a locatePi adapter answering each call with the next entry (the last one repeats). */
function locatingPi<T extends { adapters: object }>(h: T, located: Array<object | null>) {
	let locates = 0;
	return { ...h, adapters: { ...h.adapters, locatePi: async () => located[Math.min(locates++, located.length - 1)] } };
}
const npmResults = { "root -g": { code: 0, stdout: `${NPM_ROOT}\n` }, [NPM_PI_UPDATE]: { code: 0 } };

test("an older pnpm Pi is updated with pnpm and verified before only Gentle Shell is added", async () => {
	const h = locatingPi(harness({ results: { [LIST]: [piOnlyList("0.87.1"), { code: 0, stdout: listing(PI_INSTALL_VERSION) }] } }),
		[piBefore, piAfter]);
	const result = await runStandardInstall({ plan: existingPlan({ pi: olderPi("pnpm") }), consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.deepEqual(result.completed, ["check-npm", "check-global-bin", "check-existing-shell", "check-installed-pi", "update-pi",
		"verify-updated-pi", "install-global", "verify-global-list", "verify-shell-bin", "verify-gentle-ai", "shell-setup"]);
	assert.deepEqual(h.pnpmCalls(), ["bin -g", LIST, PI_UPDATE, SHELL_ONLY_ADD, LIST]);
});

test("an older npm Pi is updated with npm in its own global root, never with pnpm", async () => {
	const h = locatingPi(harness({ results: { ...npmResults, [LIST]: [emptyList, { code: 0, stdout: listing(PI_INSTALL_VERSION) }] },
		realpaths: { [NPM_ROOT]: NPM_ROOT } }), [npmPiBefore, npmPiAfter]);
	const result = await runStandardInstall({ plan: existingPlan({ pi: olderPi("npm") }), consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.deepEqual(result.completed.slice(3, 6), ["check-installed-pi", "update-pi", "verify-updated-pi"]);
	const npmCalls = h.calls.filter((call) => call.command === USER_NPM);
	// check-npm first reads that same npm in the child env; the update then runs it in the user's env.
	assert.deepEqual(npmCalls.map((call) => call.args.join(" ")), ["--version", "config get prefix", "root -g", NPM_PI_UPDATE]);
	for (const call of npmCalls.slice(2)) assert.deepEqual(call.env, h.adapters.env);
	assert.deepEqual(h.pnpmCalls(), ["bin -g", LIST, SHELL_ONLY_ADD, LIST]);
});

test("Windows: an older npm Pi is updated through what Node.js's npm.cmd runs, never through cmd.exe", async () => {
	const npmRoot = `${W_APPDATA_NPM}\\node_modules`;
	const npmPi = `${npmRoot}\\@earendil-works\\pi-coding-agent`;
	const shell = { available: true, version: requirements.shell, usable: true, global: true, owner: "npm" };
	const fixed = planPreflight({ platform: "win32", arch: "x64", node: tool("24.18.0"), pnpm: { ...tool("11.1.1"), compatible: true },
		pi: olderPi("npm"), shell, gentleAi: absent, go: absent, globalBin: { available: true, path: W_BIN, writable: true, onPath: true }, setup: false });
	assert.deepEqual(fixed.actions.map((action: { id: string }) => action.id), ["update-pi", "verify-readiness"]);
	// npm reports its root in another case: the same directory on Windows.
	for (const reported of [npmRoot, npmRoot.toLowerCase()]) {
		const h = locatingPi(harness({ layout: windowsLayout, results: { "root -g": { code: 0, stdout: `${reported}\r\n` }, [NPM_PI_UPDATE]: { code: 0 } },
			realpaths: { [reported]: reported } }), [{ root: npmPi, version: "0.87.1", owner: "npm" }, { root: npmPi, version: PI_INSTALL_VERSION, owner: "npm" }]);
		const result = await runStandardInstall({ plan: fixed, consent: true }, h.adapters);
		assert.equal(result.outcome, "ready", reported);
		assert.deepEqual(h.calls.filter((call) => call.command === W_NODE && call.args[0] === W_NPM_CLI).map((call) => call.args.slice(1).join(" ")),
			["--version", "config get prefix", "root -g", NPM_PI_UPDATE]);
		assert.equal(h.calls.some((call) => /(?:^|\\)cmd(?:\.exe)?$|\.cmd$/i.test(call.command)), false);
	}
	// An npm root that does not hold the Pi blocks before any change.
	const foreign = locatingPi(harness({ layout: windowsLayout, results: { "root -g": { code: 0, stdout: "C:\\Other\\node_modules\r\n" } },
		realpaths: { "C:\\Other\\node_modules": "C:\\Other\\node_modules" } }), [{ root: npmPi, version: "0.87.1", owner: "npm" }]);
	const blocked = await runStandardInstall({ plan: fixed, consent: true }, foreign.adapters);
	assert.deepEqual([blocked.outcome, blocked.reason], ["blocked", "existing-stack-unverified"]);
	assert.equal(foreign.calls.some((call) => call.args.includes("install")), false);
});

test("a failed or unverified Pi update stops before any Gentle Shell change", async () => {
	const plan = existingPlan({ pi: olderPi("pnpm") });
	const failed = locatingPi(harness({ results: { [LIST]: piOnlyList("0.87.1"), add: { code: 1 } } }), [piBefore, piAfter]);
	const result = await runStandardInstall({ plan, consent: true }, failed.adapters);
	assert.deepEqual([result.outcome, result.failedStep], ["failed", "update-pi"]);
	assert.deepEqual(failed.pnpmCalls(), ["bin -g", LIST, PI_UPDATE]);
	// Still old, another owner, listed twice (null) or a pre-release afterwards: never a single reusable Pi.
	for (const after of [piBefore, { ...piAfter, owner: "npm" }, null, { ...piAfter, version: `${PI_INSTALL_VERSION}-rc.1` }]) {
		const h = locatingPi(harness({ results: { [LIST]: piOnlyList("0.87.1") } }), [piBefore, after]);
		const outcome = await runStandardInstall({ plan, consent: true }, h.adapters);
		assert.deepEqual([outcome.outcome, outcome.failedStep], ["failed", "verify-updated-pi"], JSON.stringify(after));
		assert.deepEqual(h.pnpmCalls(), ["bin -g", LIST, PI_UPDATE]);
	}
	// npm must leave the update in the same global root.
	const moved = locatingPi(harness({ results: { ...npmResults, [LIST]: emptyList }, realpaths: { [NPM_ROOT]: NPM_ROOT } }),
		[npmPiBefore, { ...npmPiAfter, root: "/elsewhere/node_modules/@earendil-works/pi-coding-agent" }]);
	const outcome = await runStandardInstall({ plan: existingPlan({ pi: olderPi("npm") }), consent: true }, moved.adapters);
	assert.deepEqual([outcome.outcome, outcome.failedStep], ["failed", "verify-updated-pi"]);
});

test("a Pi update is refused before any change when the installed Pi is not the one in the plan", async () => {
	const plan = existingPlan({ pi: olderPi("pnpm") });
	// Gone, unattributed, another version, another owner, or already current: never reinstalled, never downgraded.
	for (const before of [null, { ...piBefore, owner: null }, { ...piBefore, version: "0.90.0" }, { ...piBefore, owner: "npm" },
		{ ...piBefore, version: "1.2.0" }, { ...piBefore, version: PI_INSTALL_VERSION }, { ...piBefore, root: "relative/pi" }]) {
		const h = locatingPi(harness({ results: { [LIST]: piOnlyList("0.87.1") } }), [before]);
		const result = await runStandardInstall({ plan, consent: true }, h.adapters);
		assert.deepEqual([result.outcome, result.reason], ["blocked", "existing-stack-unverified"], JSON.stringify(before));
		assert.equal(h.calls.some((call) => ["add", "install"].includes(call.args[1]) || call.args[0] === "install"), false);
	}
	// The plan's own record of an already current Pi is never accepted as an update.
	const current = existingPlan({ pi: olderPi("pnpm") });
	current.tools.pi = { ...current.tools.pi, version: PI_INSTALL_VERSION };
	const h = locatingPi(harness({ results: { [LIST]: piOnlyList(PI_INSTALL_VERSION) } }), [{ ...piBefore, version: PI_INSTALL_VERSION }]);
	const result = await runStandardInstall({ plan: current, consent: true }, h.adapters);
	assert.deepEqual([result.outcome, result.reason], ["blocked", "existing-stack-unverified"]);
	// An npm whose global root does not hold the installed Pi would install somewhere else.
	const foreign = locatingPi(harness({ results: { ...npmResults, "root -g": { code: 0, stdout: "/opt/other/lib/node_modules\n" },
		[LIST]: emptyList }, realpaths: { "/opt/other/lib/node_modules": "/opt/other/lib/node_modules" } }), [npmPiBefore]);
	const npm = await runStandardInstall({ plan: existingPlan({ pi: olderPi("npm") }), consent: true }, foreign.adapters);
	assert.deepEqual([npm.outcome, npm.reason], ["blocked", "existing-stack-unverified"]);
	assert.equal(foreign.calls.some((call) => call.args[0] === "install"), false);
});

test("a Pi update is only accepted for a Pi that preflight found older and owned", async () => {
	const forged = existingPlan({ pi: olderPi("pnpm") });
	forged.tools.pi = { status: "reusable", required: requirements.pi };
	const both = existingPlan({ pi: olderPi("pnpm") });
	both.actions.unshift({ id: "install-pi", kind: "install-global", target: "pi", version: requirements.pi });
	for (const plan of [forged, both]) {
		const h = locatingPi(harness(), [piBefore]);
		const result = await runStandardInstall({ plan, consent: true }, h.adapters);
		assert.deepEqual([result.outcome, result.reason], ["blocked", "unsupported-plan"]);
		assert.deepEqual(h.calls, []);
	}
});

test("an older Pi is updated before an existing Gentle Shell is updated; its failure leaves the Shell untouched", async () => {
	const plan = existingPlan({ pi: olderPi("pnpm"), shell: { available: true, version: "3.9.0", usable: true, global: true, owner: "npm" },
		gentleAi: { available: null }, setup: { available: null } });
	const h = locatingPi(updateHarness(), [piBefore, piAfter]);
	const result = await runStandardInstall({ plan, consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.deepEqual(result.completed, ["check-npm", "check-global-bin", "check-installed-shell", "check-installed-pi", "update-pi",
		"verify-updated-pi", "update-shell", "verify-updated-shell", "verify-gentle-ai", "shell-setup"]);
	assert.deepEqual(h.pnpmCalls(), ["bin -g", PI_UPDATE]);
	const failed = locatingPi(updateHarness({ results: { add: { code: 1 } } }), [piBefore, piAfter]);
	const outcome = await runStandardInstall({ plan, consent: true }, failed.adapters);
	assert.deepEqual([outcome.outcome, outcome.failedStep], ["failed", "update-pi"]);
	assert.deepEqual(failed.upgrades, []);
});

test("with a current Gentle Shell, only the older Pi is updated: no setup, PATH change or Go", async () => {
	const shell = { available: true, version: requirements.shell, usable: true, global: true, owner: "npm" };
	const plan = existingPlan({ pi: olderPi("npm"), shell, gentleAi: { available: null }, setup: { available: null } });
	assert.deepEqual(plan.actions.map((action: { id: string }) => action.id), ["update-pi", "verify-readiness"]);
	const h = locatingPi(harness({ env: { PATH: "/opt/node/bin:/usr/bin" }, results: npmResults, realpaths: { [NPM_ROOT]: NPM_ROOT } }),
		[npmPiBefore, npmPiAfter]);
	const result = await runStandardInstall({ plan, consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.deepEqual(result.completed, ["check-npm", "check-global-bin", "check-installed-pi", "update-pi", "verify-updated-pi"]);
	assert.deepEqual(h.pnpmCalls(), ["bin -g"]);
	assert.equal(h.integrityCalls.length, 0);
	// Windows: a pnpm-owned Pi is updated through the pnpm handoff without Go.
	const windows = planPreflight({ platform: "win32", arch: "x64", node: tool("24.18.0"), pnpm: { ...tool("11.1.1"), compatible: true },
		pi: olderPi("pnpm"), shell, gentleAi: { available: null }, go: absent,
		globalBin: { available: true, path: W_BIN, writable: true, onPath: true }, setup: { available: null } });
	const w = locatingPi(harness({ layout: windowsLayout }), [{ ...piBefore, root: `${W_PNPM_HOME}\\global\\v11\\abc` }, { ...piAfter, root: `${W_PNPM_HOME}\\global\\v11\\def` }]);
	const wResult = await runStandardInstall({ plan: windows, consent: true }, w.adapters);
	assert.equal(wResult.outcome, "ready");
	assert.deepEqual(w.pnpmCalls(), ["bin -g", PI_UPDATE]);
});

// --- An older Pi that neither pnpm nor npm owns: the installer's Pi is installed alongside ----------
const externalPi = { available: true, version: "0.87.1", usable: true, external: true };
const EXTERNAL_PI = "/home/u/.local/share/mise/installs/pi/bin/pi";
// check-npm's read-only `npm --version` and `npm config get prefix` are not about Pi.
const touchesExternalPi = (calls: Call[]) => calls.some((call) => call.command === EXTERNAL_PI ||
	(call.command === USER_NPM && !["--version", "config get prefix"].includes(call.args.join(" "))) ||
	call.args.some((arg) => arg.includes("mise")));

test("an older Pi that neither pnpm nor npm owns gets the installer's Pi alongside, exactly as when Pi is absent", async () => {
	const plan = existingPlan({ pi: externalPi });
	assert.deepEqual(plan.actions.map((action: { id: string }) => action.id), ["install-pi", "install-shell", "setup-shell", "verify-readiness"]);
	const h = harness();
	const result = await runStandardInstall({ plan, consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.deepEqual(result.completed, ["check-npm", "check-global-bin", "check-existing-stack", "install-global", "verify-global-list",
		"verify-shell-bin", "verify-gentle-ai", "shell-setup"]);
	assert.deepEqual(h.pnpmCalls(), ["bin -g", LIST, INSTALL, LIST]);
	assert.equal(touchesExternalPi(h.calls), false);
});

test("with a current Gentle Shell, only the installer's Pi is added next to the older one, then found in pnpm's list", async () => {
	const shell = { available: true, version: requirements.shell, usable: true, global: true, owner: "npm" };
	const plan = existingPlan({ pi: externalPi, shell, gentleAi: { available: null }, setup: { available: null } });
	assert.deepEqual(plan.actions.map((action: { id: string }) => action.id), ["install-pi", "verify-readiness"]);
	const h = locatingPi(harness({ env: { PATH: "/opt/node/bin:/usr/bin" }, results: { [LIST]: emptyList } }), [piAfter]);
	const result = await runStandardInstall({ plan, consent: true }, h.adapters);
	assert.equal(result.outcome, "ready");
	assert.deepEqual(result.completed, ["check-npm", "check-global-bin", "check-existing-pi", "install-pi", "verify-installed-pi"]);
	assert.deepEqual(h.pnpmCalls(), ["bin -g", LIST, PI_UPDATE]);
	assert.equal(touchesExternalPi(h.calls), false);
	// pnpm already lists a Pi: never reinstalled.
	const listed = locatingPi(harness({ results: { [LIST]: piOnlyList(PI_INSTALL_VERSION) } }), [piAfter]);
	const existing = await runStandardInstall({ plan, consent: true }, listed.adapters);
	assert.deepEqual([existing.outcome, existing.reason], ["blocked", "existing-stack"]);
	assert.deepEqual(listed.pnpmCalls(), ["bin -g", LIST]);
	// Afterwards the next probe must find one pnpm-global Pi at the target version.
	for (const after of [null, { ...piAfter, owner: "npm" }, { ...piAfter, version: "0.99.1" }]) {
		const unverified = locatingPi(harness({ results: { [LIST]: emptyList } }), [after]);
		const outcome = await runStandardInstall({ plan, consent: true }, unverified.adapters);
		assert.deepEqual([outcome.outcome, outcome.failedStep], ["failed", "verify-installed-pi"], JSON.stringify(after));
	}
	const failed = locatingPi(harness({ results: { [LIST]: emptyList, add: { code: 1 } } }), [piAfter]);
	const outcome = await runStandardInstall({ plan, consent: true }, failed.adapters);
	assert.deepEqual([outcome.outcome, outcome.failedStep], ["failed", "install-pi"]);
});

// S6: a private Windows PNPM_HOME is claimed first, after consent and before any
// command, then every pnpm child gets it and pnpm's own folders inside it.
const W_LOCAL_DEFAULT = "C:\\Users\\u\\AppData\\Local\\pnpm-weak";
function privatePlan(change: object = {}, path = W_PNPM_HOME) {
	return plan("win32", { pnpmHome: { available: true, path, source: "private", rejected: { path: W_LOCAL_DEFAULT, check: "target-acl-mask" } }, ...change });
}
function preparing(h: ReturnType<typeof harness>, prepare: (home: string) => unknown = () => "claimed", windows = true) {
	const prepared: Array<{ home: string; calls: number }> = [];
	return { ...h, prepared, adapters: { ...h.adapters, env: { ...h.adapters.env, ...(windows ? { PNPM_HOME: W_PNPM_HOME } : {}) },
		preparePnpmHome: async (home: string) => { prepared.push({ home, calls: h.calls.length }); return prepare(home); } } };
}
const xdgKeys = ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"];
test("a private Windows PNPM_HOME is claimed before any command and holds pnpm's config, cache and state", async () => {
	const h = preparing(harness({ layout: windowsLayout, env: { Path: `${W_NODE_DIR};C:\\Windows` } }));
	const result = await runStandardInstall({ plan: privatePlan(), consent: true }, h.adapters);
	assert.equal(result.outcome, "terminal-action-required");
	assert.deepEqual(h.prepared, [{ home: W_PNPM_HOME, calls: 0 }]);
	assert.equal(result.completed[0], "prepare-pnpm-home");
	assert.equal(h.pnpmCalls().at(-1), "setup", "pnpm setup persists the private PNPM_HOME and its bin");
	for (const call of h.calls) {
		assert.equal(call.env.PNPM_HOME, W_PNPM_HOME);
		assert.deepEqual(xdgKeys.map((key) => call.env[key]), [".config", ".cache", ".state"].map((folder) => `${W_PNPM_HOME}\\${folder}`));
	}
	// Folders the user set are kept.
	const own = preparing(harness({ layout: windowsLayout, env: { XDG_CACHE_HOME: "D:\\cache" } }));
	await runStandardInstall({ plan: privatePlan(), consent: true }, own.adapters);
	assert.ok(own.calls.every((call) => call.env.XDG_CACHE_HOME === "D:\\cache"));
	// Without a private PNPM_HOME nothing is claimed and no XDG folder is set, on Windows or POSIX.
	for (const [layout, fixed] of [[windowsLayout, plan("win32")], [posixLayout, plan()]] as const) {
		const plain = preparing(harness({ layout }), undefined, layout === windowsLayout);
		assert.equal((await runStandardInstall({ plan: fixed, consent: true }, plain.adapters)).outcome, "ready");
		assert.deepEqual(plain.prepared, []);
		assert.ok(plain.calls.length > 0 && plain.calls.every((call) => xdgKeys.every((key) => !(key in call.env))));
	}
	// The private record is Windows-only: a POSIX plan carrying one claims nothing.
	const posix = preparing(harness(), undefined, false);
	await runStandardInstall({ plan: { ...plan(), tools: { ...plan().tools, pnpmHome: privatePlan().tools.pnpmHome } }, consent: true }, posix.adapters);
	assert.deepEqual(posix.prepared, []);
});

test("a private PNPM_HOME that changed, or could not be claimed, stops before any command", async () => {
	const moved = preparing(harness({ layout: windowsLayout }));
	const changed = await runStandardInstall({ plan: privatePlan({}, "C:\\Users\\u\\.pnpm"), consent: true }, moved.adapters);
	assert.deepEqual([changed.outcome, changed.reason], ["blocked", "pnpm-home-changed"]);
	assert.deepEqual([moved.prepared, moved.calls], [[], []]);
	for (const prepare of [() => { throw new Error("Windows PNPM_HOME claim rejected"); }, () => Promise.reject(new Error("x"))]) {
		const h = preparing(harness({ layout: windowsLayout }), prepare);
		const failed = await runStandardInstall({ plan: privatePlan(), consent: true }, h.adapters);
		assert.deepEqual([failed.outcome, failed.failedStep, failed.completed], ["failed", "prepare-pnpm-home", []]);
		assert.deepEqual(h.calls, []);
	}
	const h = harness({ layout: windowsLayout, env: { PNPM_HOME: W_PNPM_HOME } });
	const missing = await runStandardInstall({ plan: privatePlan(), consent: true }, h.adapters);
	assert.deepEqual([missing.outcome, missing.failedStep], ["failed", "prepare-pnpm-home"]);
	assert.deepEqual(h.calls, []);
});

test("an update with a private PNPM_HOME still persists it with pnpm setup", async () => {
	const root = "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\gentle-pi";
	const fixed = plan("win32", { pi: tool("1.2.0"), shell: { available: true, version: "3.9.0", usable: true, global: true, owner: "npm" },
		gentleAi: { available: null }, setup: { available: null } });
	const h = preparing(harness({ layout: windowsLayout, env: { Path: `${W_NODE_DIR};C:\\Windows` }, results: { [`${root}\\bin\\gentle-shell.mjs setup`]: { code: 0 } } }));
	let locates = 0;
	const located = [{ root, version: "3.9.0", owner: "npm" }, { root, version: requirements.shell, owner: "npm" }];
	const adapters = { ...h.adapters, locateShell: async () => located[Math.min(locates++, 1)], upgradeShell: async () => true };
	const withHome = { ...fixed, tools: { ...fixed.tools, pnpmHome: privatePlan().tools.pnpmHome } };
	const result = await runStandardInstall({ plan: withHome, consent: true }, adapters);
	assert.equal(result.outcome, "terminal-action-required");
	assert.equal(h.pnpmCalls().at(-1), "setup");
	const plain = await runStandardInstall({ plan: fixed, consent: true }, { ...adapters, preparePnpmHome: undefined });
	assert.equal(plain.outcome, "ready", "an update keeps the PATH its installation already uses");
});

test("exported blocked reasons and failed steps match what the scenarios observed", () => {
	assert.ok(Object.isFrozen(blockedReasons) && Object.isFrozen(failedSteps));
	assert.equal(new Set(blockedReasons).size, blockedReasons.length);
	assert.equal(new Set(failedSteps).size, failedSteps.length);
	for (const reason of observed.reasons) assert.ok(blockedReasons.includes(reason), reason);
	for (const step of observed.steps) assert.ok(failedSteps.includes(step), step);
	// Every reason is reached; only the single pnpm add failure has no scenario above.
	assert.deepEqual(blockedReasons.filter((reason) => !observed.reasons.has(reason)), []);
	assert.deepEqual(failedSteps.filter((step) => !observed.steps.has(step)), ["persist-pnpm"]);
});

// R2: in private mode the installer's children also get TEMP and TMP inside the
// claimed private home, so a postinstall's os.tmpdir() (the Gentle AI source
// build) never uses a %LOCALAPPDATA%\Temp another account may write.
test("childEnvironment puts TEMP and TMP under a private Windows PNPM_HOME only", () => {
	const globalBin = { pnpmHome: W_PNPM_HOME, path: W_BIN, onPath: false };
	const base = { Path: "C:\\Windows", Temp: "C:\\Users\\u\\AppData\\Local\\Temp", TMP: "C:\\Users\\u\\AppData\\Local\\Temp" };
	const isolated = childEnvironment(base, "win32", globalBin, { privateHome: true });
	const temps = (env: Record<string, string>) => Object.entries(env).filter(([key]) => /^(TEMP|TMP)$/i.test(key));
	assert.deepEqual(temps(isolated), [["TEMP", `${W_PNPM_HOME}\\tmp`], ["TMP", `${W_PNPM_HOME}\\tmp`]], "one key each, any spelling replaced");
	assert.deepEqual(temps(childEnvironment(base, "win32", globalBin)), [["Temp", base.Temp], ["TMP", base.TMP]], "unchanged outside private mode");
	const posix = { PATH: "/usr/bin", TMPDIR: "/tmp/x" };
	assert.deepEqual(childEnvironment(posix, "linux", { pnpmHome: PNPM_HOME, path: BIN, onPath: false }, { privateHome: true }),
		{ ...posix, PNPM_HOME, PATH: `${BIN}:/usr/bin` }, "POSIX unchanged");
	assert.equal(base.Temp, "C:\\Users\\u\\AppData\\Local\\Temp", "the caller's env is not modified");
});
