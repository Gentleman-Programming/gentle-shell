import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CHANNEL_SCHEMA,
	GENTLE_AI_MAIN_PACKAGE,
	MainChannelError,
	buildMainGentleAi,
	channelStatePath,
	installOwner,
	mainChannelAdapter,
	mainVersion,
	packMainShell,
	readChannel,
	resolveMainCommit,
	writeChannel,
} from "../scripts/main-channel.mjs";

const SHELL_SHA = "6e7e3a18f794223396527a54c7c36d19c7d236c6";
const AI_SHA = "1f9d5e6423e37f7d2316859045f379ba9b5d8c3a";
const posixOnly = { skip: process.platform === "win32" };

function sandbox() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "main-channel-")));
	const home = join(root, "home");
	mkdirSync(home);
	return { root, home, ctx: { env: {}, home }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
type Call = { command: string; argv: string[]; options: { env?: Record<string, string>; cwd?: string } };

test("channel state defaults to release and round-trips a main record", async () => {
	const s = sandbox();
	try {
		assert.equal(channelStatePath(s.ctx), join(s.home, ".pi", "gentle-ai", "channel.json"));
		assert.equal(channelStatePath({ env: { GENTLE_PI_CONFIG_HOME: join(s.root, "cfg") }, home: s.home }), join(s.root, "cfg", "channel.json"));
		assert.deepEqual(await readChannel(s.ctx, fsPromises), { channel: "release" });
		await writeChannel(s.ctx, { channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA }, fsPromises);
		assert.deepEqual(JSON.parse(readFileSync(channelStatePath(s.ctx), "utf8")),
			{ schema: CHANNEL_SCHEMA, channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA });
		assert.deepEqual(await readChannel(s.ctx, fsPromises), { channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA });
	} finally { s.cleanup(); }
});

test("a malformed channel state fails closed instead of falling back to release", async () => {
	const s = sandbox();
	try {
		mkdirSync(join(s.home, ".pi", "gentle-ai"), { recursive: true });
		for (const bad of ["not json", JSON.stringify({ schema: CHANNEL_SCHEMA, channel: "nightly" }),
			JSON.stringify({ schema: CHANNEL_SCHEMA, channel: "main", shellCommit: "abc", gentleAiCommit: AI_SHA })]) {
			writeFileSync(channelStatePath(s.ctx), bad);
			await assert.rejects(readChannel(s.ctx, fsPromises), (error: MainChannelError) => error.code === "channel-state-invalid");
		}
	} finally { s.cleanup(); }
});

test("the latest main commit comes from GitHub as an exact 40-character SHA", async () => {
	const requests: Array<{ url: string; accept: string | undefined }> = [];
	const fetch = async (url: string, init: { headers: Record<string, string> }) => {
		requests.push({ url, accept: init.headers.Accept });
		return { ok: true, status: 200, text: async () => `${SHELL_SHA}\n` };
	};
	assert.equal(await resolveMainCommit("Gentleman-Programming/gentle-shell", { fetch }), SHELL_SHA);
	assert.deepEqual(requests, [{ url: "https://api.github.com/repos/Gentleman-Programming/gentle-shell/commits/main", accept: "application/vnd.github.sha" }]);
	for (const response of [{ ok: true, status: 200, text: async () => "abc123" }, { ok: false, status: 403, text: async () => SHELL_SHA }]) {
		await assert.rejects(resolveMainCommit("Gentleman-Programming/gentle-shell", { fetch: async () => response }),
			(error: MainChannelError) => error.code === "main-commit-unavailable");
	}
});

test("a main version marks the release version with the commit", () => {
	assert.equal(mainVersion("4.0.0", SHELL_SHA), "4.0.0-main.6e7e3a18f794");
});

test("the Gentle Shell main package is packed from the exact commit without prepack", async () => {
	const s = sandbox();
	try {
		const calls: Call[] = [];
		let downloaded = "";
		let packed: { version: string; scripts: Record<string, string | undefined> } | null = null;
		const fetch = async (url: string) => {
			downloaded = url;
			return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("archive").buffer };
		};
		const run = async (command: string, argv: string[], options: Call["options"]) => {
			calls.push({ command, argv, options });
			if (command === "tar") {
				const target = argv[argv.indexOf("-C") + 1];
				writeFileSync(join(target, "package.json"), JSON.stringify({ name: "gentle-pi", version: "4.0.0",
					scripts: { prepack: "pnpm test", prepare: "x", postinstall: "node scripts/install-gentle-ai.mjs" } }));
			} else {
				packed = JSON.parse(readFileSync(join(options.cwd!, "package.json"), "utf8"));
				const destination = argv[argv.indexOf("--pack-destination") + 1];
				writeFileSync(join(destination, "gentle-pi-4.0.0-main.6e7e3a18f794.tgz"), "tgz");
			}
			return { code: 0, stdout: "" };
		};
		const tgz = await packMainShell({ commit: SHELL_SHA, ctx: s.ctx, fetch, run, pnpm: { command: "/bin/pnpm", prefix: [] }, fs: fsPromises });
		assert.equal(downloaded, `https://codeload.github.com/Gentleman-Programming/gentle-shell/tar.gz/${SHELL_SHA}`);
		assert.equal(tgz, join(s.home, ".pi", "gentle-ai", "main", "packages", "gentle-pi-4.0.0-main.6e7e3a18f794.tgz"));
		assert.ok(existsSync(tgz));
		const pack = calls.find((call) => call.command === "/bin/pnpm");
		assert.ok(pack);
		assert.deepEqual(pack.argv.slice(0, 1), ["pack"]);
		assert.ok(packed);
		assert.equal(packed.version, "4.0.0-main.6e7e3a18f794");
		assert.equal(packed.scripts.prepack, undefined);
		assert.equal(packed.scripts.prepare, undefined);
		assert.equal(packed.scripts.postinstall, "node scripts/install-gentle-ai.mjs");
		assert.equal(existsSync(join(s.home, ".pi", "gentle-ai", "main", ".source")), false, "the extracted source is removed");
	} finally { s.cleanup(); }
});

test("Gentle AI main is built from the exact commit through Go's checksum database and registered as the override", posixOnly, async () => {
	const s = sandbox();
	try {
		const goPath = join(s.root, "go", "bin", "go");
		const calls: Call[] = [];
		const run = async (command: string, argv: string[], options: Call["options"]) => {
			calls.push({ command, argv, options });
			if (argv[0] === "install") {
				mkdirSync(options.env!.GOBIN, { recursive: true });
				const binary = join(options.env!.GOBIN, "gentle-ai");
				writeFileSync(binary, "#!/bin/sh\n");
				chmodSync(binary, 0o755);
				return { code: 0, stdout: "" };
			}
			return { code: 0, stdout: "gentle-ai 4.0.1-0.20261008202137-1f9d5e6423e3\n" };
		};
		const built = await buildMainGentleAi({ commit: AI_SHA, ctx: s.ctx, platform: "darwin", goPath, run, fs: fsPromises });
		const install = calls[0];
		assert.equal(install.command, goPath);
		assert.deepEqual(install.argv, ["install", `${GENTLE_AI_MAIN_PACKAGE}@${AI_SHA}`]);
		for (const [key, value] of Object.entries({ GOPROXY: "https://proxy.golang.org", GOSUMDB: "sum.golang.org", GOTOOLCHAIN: "local",
			GOFLAGS: "-modcacherw", GONOSUMDB: "", GOPRIVATE: "", GOINSECURE: "", GOENV: "off", GOWORK: "off" })) assert.equal(install.options.env![key], value, key);
		assert.equal(built.binaryPath, join(s.home, ".pi", "gentle-ai", "main", "gentle-ai", AI_SHA, "gentle-ai"));
		assert.equal(built.version, "4.0.1-0.20261008202137-1f9d5e6423e3");
		assert.deepEqual(JSON.parse(readFileSync(join(s.home, ".pi", "gentle-ai", "dev-binary.json"), "utf8")),
			{ schema: "gentle-pi.dev-binary/v1", path: built.binaryPath });
	} finally { s.cleanup(); }
});

test("a Gentle AI build whose version names another commit is rejected and never registered", posixOnly, async () => {
	const s = sandbox();
	try {
		const run = async (_command: string, argv: string[], options: Call["options"]) => {
			if (argv[0] === "install") {
				mkdirSync(options.env!.GOBIN, { recursive: true });
				writeFileSync(join(options.env!.GOBIN, "gentle-ai"), "#!/bin/sh\n", { mode: 0o755 });
			}
			return { code: 0, stdout: "gentle-ai 4.0.1-0.20261008202137-aaaaaaaaaaaa\n" };
		};
		await assert.rejects(buildMainGentleAi({ commit: AI_SHA, ctx: s.ctx, platform: "darwin", goPath: "/go/bin/go", run, fs: fsPromises }),
			(error: MainChannelError) => error.code === "main-gentle-ai-unverified");
		assert.equal(existsSync(join(s.home, ".pi", "gentle-ai", "dev-binary.json")), false);
	} finally { s.cleanup(); }
});

test("the runner adapter resolves commits and records the channel through the given network and files", async () => {
	const s = sandbox();
	try {
		const urls: string[] = [];
		const adapter = mainChannelAdapter({ fs: fsPromises, fetch: async (url: string) => {
			urls.push(url);
			return { ok: true, status: 200, text: async () => AI_SHA };
		} });
		assert.equal(await adapter.resolveCommit("Gentleman-Programming/gentle-ai"), AI_SHA);
		assert.deepEqual(urls, ["https://api.github.com/repos/Gentleman-Programming/gentle-ai/commits/main"]);
		await adapter.writeChannel(s.ctx, { channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA });
		assert.deepEqual(await readChannel(s.ctx, fsPromises), { channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA });
	} finally { s.cleanup(); }
});

test("the owner of an installation is pnpm under PNPM_HOME, npm only inside npm's global root, otherwise unknown", () => {
	const roots = { pnpmHome: "/u/Library/pnpm", npmRoot: "/u/.local/lib/node_modules" };
	assert.equal(installOwner({ ...roots, packageRoot: "/u/Library/pnpm/global/v11/x/node_modules/gentle-pi" }), "pnpm");
	assert.equal(installOwner({ ...roots, packageRoot: "/u/.local/lib/node_modules/gentle-pi" }), "npm");
	for (const packageRoot of ["/u/work/gentle-pi", "/u/.local/lib/node_modules", "/u/.local/lib/node_modules/other/gentle-pi"]) {
		assert.equal(installOwner({ ...roots, packageRoot }), null, packageRoot);
	}
	assert.equal(installOwner({ pnpmHome: null, npmRoot: null, packageRoot: "/u/.local/lib/node_modules/gentle-pi" }), null);
});
