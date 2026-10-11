import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CHANNEL_SCHEMA, MainChannelError, ownerManager, readChannel, runUpgrade, writeChannel } from "../scripts/main-channel.mjs";

const AI_SHA = "1f9d5e6423e37f7d2316859045f379ba9b5d8c3a";
const SHELL_SHA = "6e7e3a18f794223396527a54c7c36d19c7d236c6";
const NEW_AI = "2222222222222222222222222222222222222222";
const NEW_SHELL = "3333333333333333333333333333333333333333";
const posixOnly = { skip: process.platform === "win32" };
type Call = { command: string; argv: string[] };
type Invocation = { command: string; prefix: string[] } | null;

/** A sandboxed home with a pnpm- or npm-owned package root and fake network/processes.
 * `which` finds `<bin>/<name><suffix>`; `invocation`, when given, is the host's adapter. */
function world({ owner = "pnpm", latest = "4.1.0", commits = { ai: AI_SHA, shell: SHELL_SHA }, tools = ["go", "pnpm", "npm"], platform = "darwin",
	bin = "/usr/bin", suffix = "", invocation = undefined as ((name: string) => Promise<Invocation>) | undefined, fs = fsPromises as typeof fsPromises } = {}) {
	// owner "linked": `npm link` of a source checkout, so npm's global entry points outside npm's root.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "upgrade-")));
	const home = join(root, "home");
	const pnpmHome = join(root, "pnpm");
	const npmRoot = join(root, "npm", "lib", "node_modules");
	mkdirSync(npmRoot, { recursive: true });
	const packageRoot = owner === "pnpm" ? join(pnpmHome, "global", "v11", "x", "node_modules", "gentle-pi")
		: owner === "npm" ? join(npmRoot, "gentle-pi") : join(root, "checkout");
	mkdirSync(packageRoot, { recursive: true });
	mkdirSync(home);
	const ctx = { env: { PNPM_HOME: pnpmHome }, home };
	const calls: Call[] = [];
	const lines: string[] = [];
	const fetches: string[] = [];
	const fetch = async (url: string) => {
		fetches.push(url);
		if (url === "https://registry.npmjs.org/gentle-pi/latest") return { ok: latest !== "", status: latest ? 200 : 503, json: async () => ({ version: latest }) };
		if (url.endsWith("/gentle-ai/commits/main")) return { ok: true, status: 200, text: async () => commits.ai };
		if (url.endsWith("/gentle-shell/commits/main")) return { ok: true, status: 200, text: async () => commits.shell };
		if (url.startsWith("https://codeload.github.com/")) return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("src").buffer };
		throw new Error(`unexpected fetch ${url}`);
	};
	const roots: Call[] = [];
	const run = async (command: string, argv: string[], options: { env?: Record<string, string>; cwd?: string }) => {
		if (argv.slice(-2).join(" ") === "root -g") {
			roots.push({ command, argv });
			return command === "/usr/bin/npm" || command.endsWith("node.exe") ? { code: 0, stdout: `${npmRoot}\n` } : { code: 1, stdout: "" };
		}
		calls.push({ command, argv });
		if (argv[0] === "install" && argv[1]?.includes("gentle-ai/v4/cmd/gentle-ai@")) {
			mkdirSync(options.env!.GOBIN, { recursive: true });
			for (const name of ["gentle-ai", "gentle-ai.exe"]) writeFileSync(join(options.env!.GOBIN, name), "#!/bin/sh\n", { mode: 0o755 });
			return { code: 0, stdout: "" };
		}
		if (argv[0] === "version") {
			const sha = command.split("/").at(-2) ?? "";
			return { code: 0, stdout: `gentle-ai 4.0.1-0.20261008202137-${sha.slice(0, 12)}\n` };
		}
		if (command === "tar" || command.endsWith("tar.exe")) {
			writeFileSync(join(argv[argv.indexOf("-C") + 1], "package.json"), JSON.stringify({ name: "gentle-pi", version: "4.1.0", scripts: { prepack: "x" } }));
			return { code: 0, stdout: "" };
		}
		if (argv.includes("pack")) {
			const version = JSON.parse(readFileSync(join(options.cwd!, "package.json"), "utf8")).version;
			writeFileSync(join(argv[argv.indexOf("--pack-destination") + 1], `gentle-pi-${version}.tgz`), "tgz");
		}
		return { code: 0, stdout: "" };
	};
	const which = async (name: string) => (tools.includes(name) ? `${bin}/${name}${name === "go" ? "" : suffix}` : null);
	const upgrade = (args: string[], currentVersion = "4.0.0") => runUpgrade({ args, ctx, platform, packageRoot, currentVersion,
		adapters: { fetch, run, fs, which, ...(invocation ? { invocation } : {}) }, out: (line: string) => lines.push(line) });
	const installs = () => calls.filter((call) => call.argv.some((arg) => ["add", "install"].includes(arg)) && !call.argv.some((arg) => arg.includes("cmd/gentle-ai@")))
		.map((call) => `${call.command} ${call.argv.join(" ")}`);
	const manager = (command?: string) => ownerManager({ ctx, platform, packageRoot, adapters: { fs, run, which, ...(invocation ? { invocation } : {}) },
		...(command === undefined ? {} : { command }) });
	return { root, home, ctx, calls, roots, lines, fetches, upgrade, installs, manager, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a release install that is already the latest release changes nothing", async () => {
	const w = world({ latest: "4.0.0" });
	try {
		assert.equal(await w.upgrade([]), 0);
		assert.deepEqual(w.lines, ["gentle-shell 4.0.0 is already the latest release."]);
		assert.deepEqual(w.calls, []);
		assert.deepEqual(w.fetches, ["https://registry.npmjs.org/gentle-pi/latest"]);
	} finally { w.cleanup(); }
});

test("a release install updates to the latest release with the package manager that owns it", async () => {
	for (const [owner, expected] of [["pnpm", "/usr/bin/pnpm add -g gentle-pi@4.1.0 --allow-build=gentle-pi"], ["npm", "/usr/bin/npm install -g gentle-pi@4.1.0"]]) {
		const w = world({ owner });
		try {
			assert.equal(await w.upgrade([]), 0);
			assert.deepEqual(w.installs(), [expected]);
			assert.deepEqual(w.lines, ["Updated gentle-shell 4.0.0 to 4.1.0 (release)."]);
			assert.deepEqual(await readChannel(w.ctx, fsPromises), { channel: "release" });
		} finally { w.cleanup(); }
	}
});

test("a pnpm upgrade adds only gentle-pi, in its own pnpm group: a Pi installed with pnpm is never read or replaced", async () => {
	// A separate add keeps `pi update` (which replaces Pi's own group) from removing gentle-pi.
	const w = world();
	try {
		assert.equal(await w.upgrade([]), 0);
		assert.deepEqual(w.calls.map((call) => `${call.command} ${call.argv.join(" ")}`), ["/usr/bin/pnpm add -g gentle-pi@4.1.0 --allow-build=gentle-pi"]);
	} finally { w.cleanup(); }
});

test("a Gentle Shell that neither pnpm nor npm owns, such as an npm-linked checkout, is never reinstalled", async () => {
	const w = world({ owner: "linked" });
	try {
		await assert.rejects(w.upgrade([]), (error: MainChannelError) => error.code === "upgrade-owner-unknown");
		assert.deepEqual(w.installs(), []);
	} finally { w.cleanup(); }
});

test("self-uninstall resolves the owning package manager with its own refusals", async () => {
	for (const [owner, expected] of [["pnpm", { name: "pnpm", command: "/usr/bin/pnpm", prefix: [] }], ["npm", { name: "npm", command: "/usr/bin/npm", prefix: [] }]] as const) {
		const w = world({ owner });
		try {
			assert.deepEqual(await w.manager("uninstall"), expected);
		} finally { w.cleanup(); }
	}
	const linked = world({ owner: "linked" });
	try {
		await assert.rejects(linked.manager("uninstall"), (error: MainChannelError) =>
			error.code === "uninstall-owner-unknown" && /remove it the way you installed it/.test(error.message));
	} finally { linked.cleanup(); }
	const missing = world({ tools: ["npm"] });
	try {
		await assert.rejects(missing.manager("uninstall"), (error: MainChannelError) => error.code === "uninstall-manager-missing");
	} finally { missing.cleanup(); }
});

test("upgrade keeps its owner refusals unchanged", async () => {
	const linked = world({ owner: "linked" });
	try {
		await assert.rejects(linked.manager(), (error: MainChannelError) =>
			error.code === "upgrade-owner-unknown" && /update it the way you installed it/.test(error.message));
	} finally { linked.cleanup(); }
	const missing = world({ tools: ["npm"] });
	try {
		await assert.rejects(missing.manager(), (error: MainChannelError) =>
			error.code === "upgrade-manager-missing" && /which owns this Gentle Shell installation, is not on PATH/.test(error.message));
		await assert.rejects(missing.upgrade([]), (error: MainChannelError) => error.code === "upgrade-manager-missing");
		assert.deepEqual(missing.installs(), []);
	} finally { missing.cleanup(); }
});

test("an unreachable registry fails without installing anything", async () => {
	const w = world({ latest: "" });
	try {
		await assert.rejects(w.upgrade([]), (error: MainChannelError) => error.code === "latest-release-unavailable");
		assert.deepEqual(w.calls, []);
	} finally { w.cleanup(); }
});

test("a main install already at both latest main commits changes nothing", async () => {
	const w = world();
	try {
		await writeChannel(w.ctx, { channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA }, fsPromises);
		assert.equal(await w.upgrade([], "4.0.0-main.6e7e3a18f794"), 0);
		assert.deepEqual(w.lines, ["gentle-shell is already at the latest main: Gentle Shell 6e7e3a18f794, Gentle AI 1f9d5e6423e3."]);
		assert.deepEqual(w.calls, []);
	} finally { w.cleanup(); }
});

test("a main install rebuilds only what moved on main and records the new commits", posixOnly, async () => {
	const w = world({ commits: { ai: NEW_AI, shell: NEW_SHELL } });
	try {
		await writeChannel(w.ctx, { channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA }, fsPromises);
		assert.equal(await w.upgrade([], "4.0.0-main.6e7e3a18f794"), 0);
		assert.ok(w.calls.some((call) => call.argv.join(" ") === `install github.com/gentleman-programming/gentle-ai/v4/cmd/gentle-ai@${NEW_AI}`));
		const tgz = join(w.home, ".pi", "gentle-ai", "main", "packages", "gentle-pi-4.1.0-main.333333333333.tgz");
		assert.deepEqual(w.installs(), [`/usr/bin/pnpm add -g ${tgz} --allow-build=gentle-pi`]);
		assert.deepEqual(await readChannel(w.ctx, fsPromises), { channel: "main", shellCommit: NEW_SHELL, gentleAiCommit: NEW_AI });
		assert.deepEqual(w.lines, ["Updated to the latest main: Gentle Shell 333333333333, Gentle AI 222222222222."]);
	} finally { w.cleanup(); }
});

test("a main install whose Gentle AI did not move rebuilds only Gentle Shell", posixOnly, async () => {
	const w = world({ commits: { ai: AI_SHA, shell: NEW_SHELL } });
	try {
		await writeChannel(w.ctx, { channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA }, fsPromises);
		assert.equal(await w.upgrade([], "4.0.0-main.6e7e3a18f794"), 0);
		assert.equal(w.calls.some((call) => call.argv[1]?.includes("cmd/gentle-ai@")), false);
		assert.equal(w.installs().length, 1);
	} finally { w.cleanup(); }
});

test("--channel main switches a release install to both latest main commits", posixOnly, async () => {
	const w = world();
	try {
		assert.equal(await w.upgrade(["--channel", "main"]), 0);
		assert.ok(w.calls.some((call) => call.argv[1] === `github.com/gentleman-programming/gentle-ai/v4/cmd/gentle-ai@${AI_SHA}`));
		assert.equal(w.installs().length, 1);
		assert.deepEqual(await readChannel(w.ctx, fsPromises), { channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA });
		assert.deepEqual(JSON.parse(readFileSync(join(w.home, ".pi", "gentle-ai", "dev-binary.json"), "utf8")).path,
			join(w.home, ".pi", "gentle-ai", "main", "gentle-ai", AI_SHA, "gentle-ai"));
	} finally { w.cleanup(); }
});

test("--channel release switches a main install back and removes only the main override", async () => {
	const w = world();
	try {
		await writeChannel(w.ctx, { channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA }, fsPromises);
		const registration = join(w.home, ".pi", "gentle-ai", "dev-binary.json");
		writeFileSync(registration, JSON.stringify({ schema: "gentle-pi.dev-binary/v1", path: join(w.home, ".pi", "gentle-ai", "main", "gentle-ai", AI_SHA, "gentle-ai") }));
		assert.equal(await w.upgrade(["--channel=release"], "4.0.0-main.6e7e3a18f794"), 0);
		assert.deepEqual(w.installs(), ["/usr/bin/pnpm add -g gentle-pi@4.1.0 --allow-build=gentle-pi"]);
		assert.equal(existsSync(registration), false);
		assert.deepEqual(JSON.parse(readFileSync(join(w.home, ".pi", "gentle-ai", "channel.json"), "utf8")), { schema: CHANNEL_SCHEMA, channel: "release" });
	} finally { w.cleanup(); }
});

test("switching to release keeps a dev binary the user registered themselves", async () => {
	const w = world();
	try {
		await writeChannel(w.ctx, { channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA }, fsPromises);
		const registration = join(w.home, ".pi", "gentle-ai", "dev-binary.json");
		writeFileSync(registration, JSON.stringify({ schema: "gentle-pi.dev-binary/v1", path: "/Users/me/src/gentle-ai/gentle-ai" }));
		assert.equal(await w.upgrade(["--channel", "release"], "4.0.0-main.6e7e3a18f794"), 0);
		assert.equal(existsSync(registration), true);
	} finally { w.cleanup(); }
});

test("main needs Go and pnpm on PATH", async () => {
	for (const tools of [["pnpm", "npm"], ["go", "npm"]]) {
		const w = world({ tools });
		try {
			await assert.rejects(w.upgrade(["--channel", "main"]), (error: MainChannelError) => error.code === "main-requires-tools");
			assert.deepEqual(w.calls, []);
		} finally { w.cleanup(); }
	}
});

// S8: on Windows npm and pnpm are `.cmd` shims, which cannot run with shell:false.
// The host's invocation adapter says how each one runs (node.exe plus its JS entry).
const NODE_EXE = "C:\\nodejs\\node.exe";
const NPM_CLI = "C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
const PNPM_ENTRY = "C:\\tools\\pnpm\\package\\bin\\pnpm.mjs";
const windowsInvocations = async (name: string): Promise<Invocation> => (name === "npm" ? { command: NODE_EXE, prefix: [NPM_CLI] }
	: name === "pnpm" ? { command: NODE_EXE, prefix: [PNPM_ENTRY] } : null);
// This host's sandbox paths, read as Windows paths (backslashes), still resolve.
const windowsFs = { ...fsPromises, realpath: (path: string) => fsPromises.realpath(path.replaceAll("\\", "/")) } as typeof fsPromises;
const windowsWorld = (options: Parameters<typeof world>[0] = {}) => world({ platform: "win32", bin: "C:/nodejs", suffix: ".cmd", invocation: windowsInvocations, fs: windowsFs, ...options });

test("Windows: a release update runs npm or pnpm through the host's invocation, never a .cmd", async () => {
	for (const [owner, expected] of [["pnpm", `${NODE_EXE} ${PNPM_ENTRY} add -g gentle-pi@4.1.0 --allow-build=gentle-pi`], ["npm", `${NODE_EXE} ${NPM_CLI} install -g gentle-pi@4.1.0`]]) {
		const w = windowsWorld({ owner });
		try {
			assert.equal(await w.upgrade([]), 0);
			assert.deepEqual(w.installs(), [expected]);
			assert.deepEqual(w.roots.map((call) => `${call.command} ${call.argv.join(" ")}`), [`${NODE_EXE} ${NPM_CLI} root -g`]);
			assert.equal([...w.calls, ...w.roots].some((call) => /\.(cmd|bat)$/i.test(call.command)), false);
		} finally { w.cleanup(); }
	}
});

test("Windows: a main update packs and installs with the host's pnpm invocation", posixOnly, async () => {
	const w = windowsWorld();
	try {
		assert.equal(await w.upgrade(["--channel", "main"]), 0);
		const pack = w.calls.find((call) => call.argv.includes("pack"));
		assert.deepEqual([pack?.command, pack?.argv.slice(0, 2)], [NODE_EXE, [PNPM_ENTRY, "pack"]]);
		assert.deepEqual(w.installs().map((line) => line.split(" ").slice(0, 4).join(" ")), [`${NODE_EXE} ${PNPM_ENTRY} add -g`]);
		assert.equal(w.calls.some((call) => /\.(cmd|bat)$/i.test(call.command)), false);
	} finally { w.cleanup(); }
});

test("Windows: a package manager that resolves only to a .cmd, or not at all, is missing and nothing runs", async () => {
	for (const invocation of [undefined, async () => null]) {
		for (const owner of ["pnpm", "npm"]) {
			const w = windowsWorld({ owner, invocation });
			try {
				await assert.rejects(w.upgrade([]), (error: MainChannelError) => error.code === (owner === "npm" ? "upgrade-owner-unknown" : "upgrade-manager-missing"));
				assert.deepEqual([w.calls, w.roots], [[], []]);
			} finally { w.cleanup(); }
		}
		const main = windowsWorld({ invocation });
		try {
			await assert.rejects(main.upgrade(["--channel", "main"]), (error: MainChannelError) => error.code === "main-requires-tools");
			assert.deepEqual(main.calls, []);
		} finally { main.cleanup(); }
	}
});

test("Windows: self-uninstall resolves npm and pnpm through the host's invocation, never a .cmd", async () => {
	for (const [owner, expected] of [["pnpm", { name: "pnpm", command: NODE_EXE, prefix: [PNPM_ENTRY] }], ["npm", { name: "npm", command: NODE_EXE, prefix: [NPM_CLI] }]] as const) {
		const w = windowsWorld({ owner });
		try {
			assert.deepEqual(await w.manager("uninstall"), expected);
			assert.deepEqual(w.roots.map((call) => `${call.command} ${call.argv.join(" ")}`), [`${NODE_EXE} ${NPM_CLI} root -g`]);
		} finally { w.cleanup(); }
	}
	for (const invocation of [undefined, async () => null]) {
		for (const owner of ["pnpm", "npm"]) {
			const w = windowsWorld({ owner, invocation });
			try {
				await assert.rejects(w.manager("uninstall"), (error: MainChannelError) => error.code === (owner === "npm" ? "uninstall-owner-unknown" : "uninstall-manager-missing"));
				assert.deepEqual([w.calls, w.roots], [[], []]);
			} finally { w.cleanup(); }
		}
	}
});

test("POSIX: without an invocation adapter the package managers `which` finds run as they are, with no prefix", posixOnly, async () => {
	for (const [owner, args] of [["npm", []], ["pnpm", []], ["pnpm", ["--channel", "main"]]] as const) {
		const w = world({ owner, platform: "linux" });
		try {
			assert.equal(await w.upgrade([...args]), 0);
			assert.deepEqual(w.roots.map((call) => `${call.command} ${call.argv.join(" ")}`), ["/usr/bin/npm root -g"]);
			assert.ok(w.installs().every((line) => line.startsWith(`/usr/bin/${owner} ${owner === "npm" ? "install" : "add"} -g `)), w.installs().join("\n"));
			if (args.length > 0) assert.equal(w.calls.find((call) => call.argv[0] === "pack")?.command, "/usr/bin/pnpm");
		} finally { w.cleanup(); }
	}
});

test("unknown upgrade arguments are a usage error", async () => {
	for (const args of [["--channel"], ["--channel", "nightly"], ["--force"], ["main"]]) {
		const w = world();
		try {
			await assert.rejects(w.upgrade(args), (error: MainChannelError) => error.code === "upgrade-usage");
			assert.deepEqual(w.calls, []);
			assert.deepEqual(w.fetches, []);
		} finally { w.cleanup(); }
	}
});
