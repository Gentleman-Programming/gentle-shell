import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CHANNEL_SCHEMA, GENTLE_AI_MODULE, MainChannelError, ownerManager, readChannel, removeGlobalShell, runUpgrade, writeChannel } from "../scripts/main-channel.mjs";
import { requirements } from "../scripts/installer-preflight.mjs";

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
	bin = "/usr/bin", suffix = "", invocation = undefined as ((name: string) => Promise<Invocation>) | undefined, fs = fsPromises as typeof fsPromises,
	migrate = undefined as ((input: { latest: string; owner: () => Promise<unknown> }) => Promise<unknown>) | undefined,
	failGoInstall = false, failShellInstall = false } = {}) {
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
			if (failGoInstall) return { code: 1, stdout: "" };
			mkdirSync(options.env!.GOBIN, { recursive: true });
			for (const name of ["gentle-ai", "gentle-ai.exe"]) writeFileSync(join(options.env!.GOBIN, name), "#!/bin/sh\n", { mode: 0o755 });
			return { code: 0, stdout: "" };
		}
		if (argv[0] === "version" && command === `${bin}/go`) {
			if (argv[1] === "-m") {
				const commit = String(argv[2] ?? "").split("/").at(-2) ?? "";
				return { code: 0, stdout: `${command} (binary)\n\tmod\t${GENTLE_AI_MODULE}\tv4.0.1-0.20261008202137-${commit.slice(0, 12)}\th1:J8EluS7QrfM+m3vmQlF26B/shZRjD6rBfsKtrABL5mc=\n` };
			}
			return { code: 0, stdout: `go version go${requirements.go} ${platform}/amd64\n` };
		}
		if (argv[0] === "list" && command === `${bin}/go`) {
			const commit = String(argv[3] ?? "").slice(`${GENTLE_AI_MODULE}@`.length);
			return { code: 0, stdout: JSON.stringify({ Path: GENTLE_AI_MODULE, Version: `v4.0.1-0.20261008202137-${commit.slice(0, 12)}`, Origin: { VCS: "git", URL: "https://github.com/gentleman-programming/gentle-ai", Hash: commit } }) };
		}
		if (argv[0] === "version") {
			const sha = command.split("/").at(-2) ?? "";
			return { code: 0, stdout: `gentle-ai 4.0.1-0.20261008202137-${sha.slice(0, 12)}\n` };
		}
		if (command === "tar" || command.endsWith("tar.exe")) {
			writeFileSync(join(argv[argv.indexOf("-C") + 1], "package.json"), JSON.stringify({ name: "gentle-pi", version: "4.1.0", scripts: { prepack: "x" } }));
			return { code: 0, stdout: "" };
		}
		if (failShellInstall && argv.includes("-g") && argv.some((arg) => arg.endsWith(".tgz"))) return { code: 1, stdout: "" };
		if (argv.includes("pack")) {
			const version = JSON.parse(readFileSync(join(options.cwd!, "package.json"), "utf8")).version;
			writeFileSync(join(argv[argv.indexOf("--pack-destination") + 1], `gentle-pi-${version}.tgz`), "tgz");
		}
		return { code: 0, stdout: "" };
	};
	const which = async (name: string) => (tools.includes(name) ? `${bin}/${name}${name === "go" ? "" : suffix}` : null);
	const upgrade = (args: string[], currentVersion = "4.0.0") => runUpgrade({ args, ctx, platform, packageRoot, currentVersion,
		adapters: { fetch, run, fs, which,
			acquireGo: async () => { throw new Error("Unexpected Go acquisition in sandboxed upgrade fixture"); },
			...(invocation ? { invocation } : {}), ...(migrate ? { migrate } : {}) }, out: (line: string) => lines.push(line) });
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

// #2356: a Gentle AI step that fails still installs a main Shell that moved, so the
// retry runs the new Shell's code; the channel is recorded only when both succeed.
const GO_INSTALL_FAILED = `main-gentle-ai-build-failed: go install github.com/gentleman-programming/gentle-ai/v4/cmd/gentle-ai@${NEW_AI} failed`;
const PRIOR_REGISTRATION = JSON.stringify({ schema: "gentle-pi.dev-binary/v1", path: "/prior/main/gentle-ai" });
const NEW_SHELL_TGZ = (home: string) => join(home, ".pi", "gentle-ai", "main", "packages", "gentle-pi-4.1.0-main.333333333333.tgz");
async function onPriorMain(w: ReturnType<typeof world>) {
	await writeChannel(w.ctx, { channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA }, fsPromises);
	writeFileSync(join(w.home, ".pi", "gentle-ai", "dev-binary.json"), PRIOR_REGISTRATION);
	return () => ({ channel: readFileSync(join(w.home, ".pi", "gentle-ai", "channel.json"), "utf8"), registration: readFileSync(join(w.home, ".pi", "gentle-ai", "dev-binary.json"), "utf8") });
}

test("a failed Gentle AI build still installs the main Shell that moved, records no channel and names the retry", posixOnly, async () => {
	const w = world({ commits: { ai: NEW_AI, shell: NEW_SHELL }, failGoInstall: true });
	try {
		const files = await onPriorMain(w);
		const before = files();
		await assert.rejects(w.upgrade([], "4.0.0-main.6e7e3a18f794"), (error: MainChannelError) => {
			assert.equal(error.code, "main-gentle-ai-build-failed");
			assert.equal(error.message, `${GO_INSTALL_FAILED}; Gentle Shell was updated to main 333333333333 but Gentle AI was not: run gentle-shell upgrade --channel main to finish`);
			return true;
		});
		assert.deepEqual(w.installs(), [`/usr/bin/pnpm add -g ${NEW_SHELL_TGZ(w.home)} --allow-build=gentle-pi`]);
		assert.deepEqual(w.lines, ["Updated Gentle Shell to the latest main (333333333333); Gentle AI was not updated."]);
		assert.deepEqual(files(), before);
		assert.deepEqual(JSON.parse(before.registration), JSON.parse(PRIOR_REGISTRATION));
	} finally { w.cleanup(); }
});

test("a Go that cannot be obtained for the Gentle AI build still installs the main Shell that moved", posixOnly, async () => {
	const w = world({ commits: { ai: NEW_AI, shell: NEW_SHELL }, tools: ["pnpm", "npm"] });
	try {
		const files = await onPriorMain(w);
		const before = files();
		await assert.rejects(w.upgrade([], "4.0.0-main.6e7e3a18f794"), (error: MainChannelError) => {
			assert.equal(error.code, "main-requires-tools");
			assert.match(error.message, /^main-requires-tools: the main channel builds Gentle AI with Go .*Unexpected Go acquisition in sandboxed upgrade fixture.*; Gentle Shell was updated to main 333333333333 but Gentle AI was not: run gentle-shell upgrade --channel main to finish$/);
			return true;
		});
		assert.deepEqual(w.installs(), [`/usr/bin/pnpm add -g ${NEW_SHELL_TGZ(w.home)} --allow-build=gentle-pi`]);
		assert.deepEqual(w.lines, ["Updated Gentle Shell to the latest main (333333333333); Gentle AI was not updated."]);
		assert.deepEqual(files(), before);
	} finally { w.cleanup(); }
});

test("after a fail-forward, the retry from the new Shell builds Gentle AI and records both commits", posixOnly, async () => {
	// The first copy of the built binary fails (as a rejected build would); the retry's succeeds.
	let copies = 0;
	const fs = { ...fsPromises, copyFile: async (...args: Parameters<typeof fsPromises.copyFile>) => {
		if (copies++ === 0) throw new MainChannelError("main-gentle-ai-unverified", "first attempt rejected");
		return fsPromises.copyFile(...args);
	} } as typeof fsPromises;
	const w = world({ commits: { ai: NEW_AI, shell: NEW_SHELL }, fs });
	try {
		const files = await onPriorMain(w);
		const before = files();
		await assert.rejects(w.upgrade([], "4.0.0-main.6e7e3a18f794"), (error: MainChannelError) => error.code === "main-gentle-ai-unverified");
		assert.deepEqual(files(), before);
		// The retry is simulated as the new Shell's run: the same runUpgrade with the new
		// version (the installed package itself is not executed). No channel was recorded,
		// so it rebuilds Gentle AI and repacks the Shell before recording both commits.
		w.lines.length = 0;
		assert.equal(await w.upgrade([], "4.1.0-main.333333333333"), 0);
		assert.deepEqual(w.lines, ["Updated to the latest main: Gentle Shell 333333333333, Gentle AI 222222222222."]);
		assert.deepEqual(w.installs(), [`/usr/bin/pnpm add -g ${NEW_SHELL_TGZ(w.home)} --allow-build=gentle-pi`, `/usr/bin/pnpm add -g ${NEW_SHELL_TGZ(w.home)} --allow-build=gentle-pi`]);
		assert.deepEqual(await readChannel(w.ctx, fsPromises), { channel: "main", shellCommit: NEW_SHELL, gentleAiCommit: NEW_AI });
		assert.equal(JSON.parse(readFileSync(join(w.home, ".pi", "gentle-ai", "dev-binary.json"), "utf8")).path,
			join(w.home, ".pi", "gentle-ai", "main", "gentle-ai", NEW_AI, "gentle-ai"));
		// A third run is a no-op: both commits are current.
		w.lines.length = 0;
		assert.equal(await w.upgrade([], "4.1.0-main.333333333333"), 0);
		assert.deepEqual(w.lines, ["gentle-shell is already at the latest main: Gentle Shell 333333333333, Gentle AI 222222222222."]);
	} finally { w.cleanup(); }
});

test("a failed Gentle AI build with the main Shell already current fails as before: nothing installed or recorded", posixOnly, async () => {
	const w = world({ commits: { ai: NEW_AI, shell: SHELL_SHA }, failGoInstall: true });
	try {
		const files = await onPriorMain(w);
		const before = files();
		await assert.rejects(w.upgrade([], "4.0.0-main.6e7e3a18f794"), (error: MainChannelError) => {
			assert.equal(error.code, "main-gentle-ai-build-failed");
			assert.equal(error.message, GO_INSTALL_FAILED);
			return true;
		});
		assert.deepEqual(w.installs(), []);
		assert.deepEqual(w.lines, []);
		assert.deepEqual(files(), before);
	} finally { w.cleanup(); }
});

test("when the Gentle AI build and the Shell install both fail, the Shell failure is reported with the Gentle AI one", posixOnly, async () => {
	const w = world({ commits: { ai: NEW_AI, shell: NEW_SHELL }, failGoInstall: true, failShellInstall: true });
	try {
		const files = await onPriorMain(w);
		const before = files();
		await assert.rejects(w.upgrade([], "4.0.0-main.6e7e3a18f794"), (error: MainChannelError) => {
			assert.equal(error.code, "upgrade-install-failed");
			assert.equal(error.message, `upgrade-install-failed: pnpm could not install ${NEW_SHELL_TGZ(w.home)}; Gentle AI was not updated either (${GO_INSTALL_FAILED})`);
			return true;
		});
		assert.deepEqual(w.installs(), [`/usr/bin/pnpm add -g ${NEW_SHELL_TGZ(w.home)} --allow-build=gentle-pi`]);
		assert.deepEqual(w.lines, []);
		assert.deepEqual(files(), before);
	} finally { w.cleanup(); }
});

// An ordinary failure that is not a MainChannelError (EACCES) keeps the retry advice and both errors.
const eacces = (what: string) => Object.assign(new Error(`EACCES: permission denied, ${what}`), { code: "EACCES" });
const COPY_DENIED = eacces("copyfile");
const MANIFEST_DENIED = eacces("open package.json");
const deniedFs = ({ copy = false, manifest = false }) => ({ ...fsPromises,
	copyFile: async (...args: Parameters<typeof fsPromises.copyFile>) => { if (copy) throw COPY_DENIED; return fsPromises.copyFile(...args); },
	readFile: (async (path: string, options?: unknown) => {
		if (manifest && String(path).endsWith(join(".source", "src", "package.json"))) throw MANIFEST_DENIED;
		return fsPromises.readFile(path, options as never);
	}) as typeof fsPromises.readFile }) as typeof fsPromises;

test("an ordinary error in the Gentle AI step still installs the main Shell that moved and names the retry", posixOnly, async () => {
	const w = world({ commits: { ai: NEW_AI, shell: NEW_SHELL }, fs: deniedFs({ copy: true }) });
	try {
		const files = await onPriorMain(w);
		const before = files();
		await assert.rejects(w.upgrade([], "4.0.0-main.6e7e3a18f794"), (error: MainChannelError) => {
			assert.ok(error instanceof MainChannelError);
			assert.equal(error.code, "main-upgrade-incomplete");
			assert.equal(error.message, "main-upgrade-incomplete: EACCES: permission denied, copyfile; Gentle Shell was updated to main 333333333333 but Gentle AI was not: run gentle-shell upgrade --channel main to finish");
			assert.equal(error.cause, COPY_DENIED);
			return true;
		});
		assert.deepEqual(w.installs(), [`/usr/bin/pnpm add -g ${NEW_SHELL_TGZ(w.home)} --allow-build=gentle-pi`]);
		assert.deepEqual(w.lines, ["Updated Gentle Shell to the latest main (333333333333); Gentle AI was not updated."]);
		assert.deepEqual(files(), before);
	} finally { w.cleanup(); }
});

test("ordinary errors in both steps report the Shell error with the Gentle AI one", posixOnly, async () => {
	const w = world({ commits: { ai: NEW_AI, shell: NEW_SHELL }, fs: deniedFs({ copy: true, manifest: true }) });
	try {
		const files = await onPriorMain(w);
		const before = files();
		await assert.rejects(w.upgrade([], "4.0.0-main.6e7e3a18f794"), (error: MainChannelError) => {
			assert.ok(error instanceof MainChannelError);
			assert.equal(error.code, "main-upgrade-incomplete");
			assert.equal(error.message, "main-upgrade-incomplete: EACCES: permission denied, open package.json; Gentle AI was not updated either (EACCES: permission denied, copyfile)");
			assert.equal(error.cause, MANIFEST_DENIED);
			return true;
		});
		assert.deepEqual(w.installs(), []);
		assert.deepEqual(w.lines, []);
		assert.deepEqual(files(), before);
	} finally { w.cleanup(); }
});

test("an ordinary error in the Gentle AI step with the main Shell already current is rethrown unchanged", posixOnly, async () => {
	const w = world({ commits: { ai: NEW_AI, shell: SHELL_SHA }, fs: deniedFs({ copy: true }) });
	try {
		const files = await onPriorMain(w);
		const before = files();
		await assert.rejects(w.upgrade([], "4.0.0-main.6e7e3a18f794"), (error: Error) => error === COPY_DENIED);
		assert.deepEqual(w.installs(), []);
		assert.deepEqual(w.lines, []);
		assert.deepEqual(files(), before);
	} finally { w.cleanup(); }
});

// A rejection that is not an Error, even a falsy one, is still a failed Gentle AI step.
const rejectingCopy = (value: unknown) => ({ ...fsPromises, copyFile: async () => { throw value; } }) as typeof fsPromises;

test("a falsy rejection in the Gentle AI step still records no channel and names the retry", posixOnly, async () => {
	for (const value of [undefined, null, 0, false]) {
		const w = world({ commits: { ai: NEW_AI, shell: NEW_SHELL }, fs: rejectingCopy(value) });
		try {
			const files = await onPriorMain(w);
			const before = files();
			await assert.rejects(w.upgrade([], "4.0.0-main.6e7e3a18f794"), (error: MainChannelError) => {
				assert.ok(error instanceof MainChannelError);
				assert.equal(error.code, "main-upgrade-incomplete");
				assert.equal(error.message, `main-upgrade-incomplete: ${String(value)}; Gentle Shell was updated to main 333333333333 but Gentle AI was not: run gentle-shell upgrade --channel main to finish`);
				return true;
			});
			assert.deepEqual(w.installs(), [`/usr/bin/pnpm add -g ${NEW_SHELL_TGZ(w.home)} --allow-build=gentle-pi`]);
			assert.deepEqual(w.lines, ["Updated Gentle Shell to the latest main (333333333333); Gentle AI was not updated."]);
			assert.deepEqual(files(), before);
		} finally { w.cleanup(); }
	}
});

test("a rejection that is not an Error but has a message keeps that message", posixOnly, async () => {
	for (const failShellInstall of [false, true]) {
		const w = world({ commits: { ai: NEW_AI, shell: NEW_SHELL }, fs: rejectingCopy({ message: "EACCES: copy denied", code: "EACCES" }), failShellInstall });
		try {
			const files = await onPriorMain(w);
			const before = files();
			await assert.rejects(w.upgrade([], "4.0.0-main.6e7e3a18f794"), (error: MainChannelError) => {
				assert.equal(error.message, failShellInstall
					? `upgrade-install-failed: pnpm could not install ${NEW_SHELL_TGZ(w.home)}; Gentle AI was not updated either (EACCES: copy denied)`
					: "main-upgrade-incomplete: EACCES: copy denied; Gentle Shell was updated to main 333333333333 but Gentle AI was not: run gentle-shell upgrade --channel main to finish");
				return true;
			});
			assert.deepEqual(files(), before);
		} finally { w.cleanup(); }
	}
});

test("a null rejection in the Gentle AI step is kept when the Shell install fails too", posixOnly, async () => {
	const w = world({ commits: { ai: NEW_AI, shell: NEW_SHELL }, fs: rejectingCopy(null), failShellInstall: true });
	try {
		const files = await onPriorMain(w);
		const before = files();
		await assert.rejects(w.upgrade([], "4.0.0-main.6e7e3a18f794"), (error: MainChannelError) => {
			assert.equal(error.code, "upgrade-install-failed");
			assert.equal(error.message, `upgrade-install-failed: pnpm could not install ${NEW_SHELL_TGZ(w.home)}; Gentle AI was not updated either (null)`);
			return true;
		});
		assert.deepEqual(w.lines, []);
		assert.deepEqual(files(), before);
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

// A missing Go is not a blocker: the build downloads the pinned Go (main-channel.test.ts).
test("main needs pnpm on PATH", async () => {
	const w = world({ tools: ["go", "npm"] });
	try {
		await assert.rejects(w.upgrade(["--channel", "main"]), (error: MainChannelError) => error.code === "main-requires-tools");
		assert.deepEqual(w.calls, []);
	} finally { w.cleanup(); }
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

// T3 (S4): the release branch first offers the migration to the bundled install.
test("a release upgrade that migrates installs nothing globally, records the release channel and removes only the main override", async () => {
	const seen: { latest: string; owner: unknown }[] = [];
	const w = world({ migrate: async ({ latest, owner }) => { seen.push({ latest, owner: await owner() }); return { code: 0, installed: true }; } });
	try {
		await writeChannel(w.ctx, { channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA }, fsPromises);
		const registration = join(w.home, ".pi", "gentle-ai", "dev-binary.json");
		writeFileSync(registration, JSON.stringify({ schema: "gentle-pi.dev-binary/v1", path: join(w.home, ".pi", "gentle-ai", "main", "gentle-ai", AI_SHA, "gentle-ai") }));
		assert.equal(await w.upgrade(["--channel", "release"], "4.0.0-main.6e7e3a18f794"), 0);
		assert.deepEqual(seen, [{ latest: "4.1.0", owner: { name: "pnpm", command: "/usr/bin/pnpm", prefix: [] } }]);
		assert.deepEqual(w.installs(), []);
		assert.equal(existsSync(registration), false);
		assert.deepEqual(await readChannel(w.ctx, fsPromises), { channel: "release" });
	} finally { w.cleanup(); }
	// A migration whose removal failed keeps the bundled install: its exit code, and the release channel recorded.
	const kept = world({ migrate: async () => ({ code: 1, installed: true }) });
	try {
		assert.equal(await kept.upgrade([]), 1);
		assert.deepEqual(kept.installs(), []);
		assert.equal(existsSync(join(kept.home, ".pi", "gentle-ai", "channel.json")), true);
	} finally { kept.cleanup(); }
	// B3: a migration that failed (it printed why and returns null) leaves this run to the global update.
	const failed = world({ migrate: async () => null });
	try {
		assert.equal(await failed.upgrade([]), 0);
		assert.deepEqual(failed.installs(), ["/usr/bin/pnpm add -g gentle-pi@4.1.0 --allow-build=gentle-pi"]);
	} finally { failed.cleanup(); }
});

test("a release upgrade the migration declines keeps the current path, and main never asks", async () => {
	let asked = 0;
	const w = world({ migrate: async () => { asked += 1; return null; } });
	try {
		assert.equal(await w.upgrade([]), 0);
		assert.deepEqual(w.installs(), ["/usr/bin/pnpm add -g gentle-pi@4.1.0 --allow-build=gentle-pi"]);
		assert.deepEqual(w.lines, ["Updated gentle-shell 4.0.0 to 4.1.0 (release)."]);
		assert.equal(asked, 1);
	} finally { w.cleanup(); }
	// The migration's owner check keeps the current refusals for an npm link.
	const linked = world({ owner: "linked", migrate: async ({ owner }) => owner().then(() => ({ code: 0, installed: true }), () => null) });
	try {
		await assert.rejects(linked.upgrade([]), (error: MainChannelError) => error.code === "upgrade-owner-unknown");
	} finally { linked.cleanup(); }
	const main = world({ migrate: async () => { asked += 1; return { code: 0, installed: true }; } });
	try {
		await writeChannel(main.ctx, { channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA }, fsPromises);
		assert.equal(await main.upgrade([], "4.0.0-main.6e7e3a18f794"), 0);
		assert.equal(asked, 1);
	} finally { main.cleanup(); }
});

test("removeGlobalShell removes gentle-pi with the manager that owns it, through its verified invocation", async () => {
	const calls: string[] = [];
	const run = async (command: string, argv: string[]) => { calls.push(`${command} ${argv.join(" ")}`); return { code: calls.length === 3 ? 1 : 0, stdout: "" }; };
	assert.equal(await removeGlobalShell({ name: "pnpm", command: "/usr/bin/pnpm", prefix: [] }, run), true);
	assert.equal(await removeGlobalShell({ name: "npm", command: "C:\\nodejs\\node.exe", prefix: ["C:\\nodejs\\npm-cli.js"] }, run), true);
	assert.equal(await removeGlobalShell({ name: "npm", command: "/usr/bin/npm", prefix: [] }, run), false);
	assert.deepEqual(calls, ["/usr/bin/pnpm remove -g gentle-pi", "C:\\nodejs\\node.exe C:\\nodejs\\npm-cli.js uninstall -g gentle-pi", "/usr/bin/npm uninstall -g gentle-pi"]);
});
