import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	GENTLE_AI_PENDING_DIGEST,
	GENTLE_AI_RELEASE_ASSETS,
	GENTLE_AI_WINDOWS_SOURCE_MODULE_CHECKSUM,
	downloadGentleAiAsset,
	gentleAiAssetForm,
	installGentleAi,
	resolveGentleAiInstallerPackageRoot,
	resolveGentleAiReleaseAsset,
	trustedSystemExtractor,
} from "../scripts/gentle-ai-installer.mjs";

// v2.9.1 digests pinned from the published release: archive digests verified
// against the minisign-signed checksums.txt and freshly computed hashes; binary
// digests computed from the extracted executables.
const EXPECTED_ASSETS = {
	"darwin/amd64": { name: "gentle-ai_2.9.1_darwin_amd64.tar.gz", sha256: "9e4b10c8e0ff36e51f39fad4da082f37b408234253cbbb7f8a8f710a5ee7b7f7", binarySha256: "96b2739365aa7513997e9ea5435cf38c019810dc3db0fb51c4c8f2fdb910de58" },
	"darwin/arm64": { name: "gentle-ai_2.9.1_darwin_arm64.tar.gz", sha256: "d876c237e4559bea6849e9f9be33c63cea053154149df4a3e1e5983c9a6232ff", binarySha256: "5a675f666f52e4c070ad703da01a5e3ab6b1a4a002e3ac08ca1ef2871d21ac59" },
	"linux/amd64": { name: "gentle-ai_2.9.1_linux_amd64.tar.gz", sha256: "07efddecd29fd1c3f8c8df19a3b6613c1948927d410b8502bf82b39b84d9481b", binarySha256: "8bd0161c51ed07e77801a92d13bdcb82ff483c273d4a182904534057d4054d97" },
	"linux/arm64": { name: "gentle-ai_2.9.1_linux_arm64.tar.gz", sha256: "c3e5a173fa1b19be0abc0c6e5de18709cd1985cff61cc140546191e809324ed2", binarySha256: "a311c9ae6bc8d59931eee7c686be5d51b35d60b5d2b591e17e9b432968926e4e" },
} as const;

test("default installer package root is the package containing scripts, not its parent", () => {
	const installerPath = fileURLToPath(new URL("../scripts/gentle-ai-installer.mjs", import.meta.url));
	const expectedPackageRoot = dirname(dirname(installerPath));

	assert.equal(resolveGentleAiInstallerPackageRoot(), expectedPackageRoot);
	assert.notEqual(resolveGentleAiInstallerPackageRoot(), dirname(expectedPackageRoot));
});

test("release mapping selects only the supported official v2.9.1 assets and pinned digests", () => {
	assert.deepEqual(
		Object.fromEntries(Object.entries(GENTLE_AI_RELEASE_ASSETS).map(([key, asset]) => [key, { name: asset.name, sha256: asset.sha256, binarySha256: asset.binarySha256 }])),
		EXPECTED_ASSETS,
	);
	assert.equal(resolveGentleAiReleaseAsset("linux", "x64").name, "gentle-ai_2.9.1_linux_amd64.tar.gz");
	assert.equal(resolveGentleAiReleaseAsset("darwin", "arm64").name, "gentle-ai_2.9.1_darwin_arm64.tar.gz");
	for (const asset of Object.values(GENTLE_AI_RELEASE_ASSETS)) {
		assert.match(asset.url, /^https:\/\/github\.com\/Gentleman-Programming\/gentle-ai\/releases\/download\/v2\.9\.1\//);
	}
});

test("raw release assets are admitted only under a prerelease pin", () => {
	assert.equal(gentleAiAssetForm("gentle-ai_2.4.0_linux_amd64.tar.gz", "2.4.0"), "archive");
	assert.equal(gentleAiAssetForm("gentle-ai_2.5.0-rc.3_linux_amd64", "2.5.0-rc.3"), "raw-binary");
	assert.equal(gentleAiAssetForm("gentle-ai_2.5.0-rc.3_windows_amd64.exe", "2.5.0-rc.3"), "raw-binary");
	// A raw binary under a stable pin means the pin itself is wrong: stable
	// releases publish signed archives only, so this fails closed pre-download.
	assert.throws(() => gentleAiAssetForm("gentle-ai_2.9.1_linux_amd64", "2.9.1"), /only admitted for a prerelease pin/);
	assert.throws(() => gentleAiAssetForm("gentle-ai.dmg", "2.5.0-rc.3"), /unsupported Gentle AI release asset form/);
	// The current stable pin admits every pinned asset row through the same
	// gate the installer uses at download time (default installerVersion
	// argument): signed archives, never raw binaries.
	for (const asset of Object.values(GENTLE_AI_RELEASE_ASSETS)) {
		assert.equal(gentleAiAssetForm(asset.name), "archive");
	}
});

test("release digests are all-or-none and install fails closed while any digest is pending", async () => {
	const digests = Object.values(GENTLE_AI_RELEASE_ASSETS).flatMap((asset) => [asset.sha256, asset.binarySha256]);
	const pinned = digests.filter((digest) => /^[0-9a-f]{64}$/.test(digest));
	const pending = digests.filter((digest) => digest === GENTLE_AI_PENDING_DIGEST);
	assert.equal(pinned.length + pending.length, digests.length, "every digest must be pinned hex or the explicit pending sentinel");
	assert.equal(pinned.length === digests.length || pending.length === digests.length, true, "digest table must not mix pinned and pending entries");
	if (pending.length === digests.length) {
		const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-pending-"));
		await assert.rejects(
			() => installGentleAi({
				packageRoot,
				platform: "linux",
				arch: "x64",
				download: async (_url, destination) => writeFile(destination, "unverifiable archive"),
			}),
			/checksum mismatch/,
		);
		assert.equal(existsSync(join(packageRoot, ".gentle-ai", "v2.9.1", "gentle-ai")), false);
	}
});

interface WindowsGoCall {
	file: string;
	arguments_: string[];
	options: {
		env?: NodeJS.ProcessEnv;
		shell?: boolean;
		timeout?: number;
		maxBuffer?: number;
	};
}

interface WindowsGoFixtureOptions {
	goVersion?: string;
	goVersionError?: Error;
	reportedVersion?: string;
	installError?: Error;
	goArchitecture?: "amd64" | "arm64";
}

function windowsGoFixture(fixtureOptions: WindowsGoFixtureOptions = {}) {
	const calls: WindowsGoCall[] = [];
	let goExecutable = "go";
	const metadata = [
		"gentle-ai.exe: go1.25.10",
		"\tpath\tgithub.com/gentleman-programming/gentle-ai/v2/cmd/gentle-ai",
		`\tmod\tgithub.com/gentleman-programming/gentle-ai/v2\tv2.9.1\t${GENTLE_AI_WINDOWS_SOURCE_MODULE_CHECKSUM}`,
		"\tbuild\t-buildmode=exe", "\tbuild\t-compiler=gc", "\tbuild\tCGO_ENABLED=0", `\tbuild\tGOARCH=${fixtureOptions.goArchitecture ?? "amd64"}`, "\tbuild\tGOOS=windows",
	].join("\n");
	const run = async (file: string, arguments_: string[], options: WindowsGoCall["options"]) => {
		calls.push({ file, arguments_, options });
		if (file === goExecutable && arguments_.length === 1 && arguments_[0] === "version") {
			if (fixtureOptions.goVersionError) throw fixtureOptions.goVersionError;
			return { stdout: fixtureOptions.goVersion ?? "go version go1.25.10 windows/amd64\n", stderr: "" };
		}
		if (file === goExecutable && arguments_[0] === "install") {
			if (fixtureOptions.installError) throw fixtureOptions.installError;
			const gobin = options.env?.GOBIN;
			assert.ok(gobin, "go install must receive an explicit staging GOBIN");
			await mkdir(gobin, { recursive: true });
			await writeFile(join(gobin, "gentle-ai.exe"), "trusted Windows source build");
			return { stdout: "", stderr: "" };
		}
		if (file === goExecutable && arguments_[0] === "version" && arguments_[1] === "-m") return { stdout: metadata, stderr: "" };
		if (arguments_.length === 1 && arguments_[0] === "version") return { stdout: fixtureOptions.reportedVersion ?? "gentle-ai 2.9.1\n", stderr: "" };
		throw new Error(`unexpected command: ${file} ${arguments_.join(" ")}`);
	};
	return { calls, run, setGoExecutable: (path: string) => { goExecutable = path; } };
}

test("win32 x64 and arm64 install the exact Go SumDB source tag without archive lookup", async () => {
	for (const [arch, goArchitecture] of [["x64", "amd64"], ["arm64", "arm64"]] as const) {
		const packageRoot = await mkdtemp(join(tmpdir(), `gentle-pi-installer-windows-${arch}-`));
		const fixture = windowsGoFixture({ goArchitecture });
		const goPath = join(packageRoot, "go.exe");
		await writeFile(goPath, "trusted local Go executable");
		fixture.setGoExecutable(goPath);
		const result = await installGentleAi({ packageRoot, platform: "win32", arch, execFile: fixture.run, resolveGoExecutable: async () => goPath });
		assert.equal(result.installed, true);
		assert.deepEqual(fixture.calls.filter((call) => call.file === goPath).map((call) => call.arguments_.slice(0, 2)), [
			["version"], ["install", "github.com/gentleman-programming/gentle-ai/v2/cmd/gentle-ai@v2.9.1"], ["version", "-m"],
		]);
	}
});

test("Windows source install reports missing or too-old Go without publishing a binary", async () => {
	for (const fixtureOptions of [
		{ goVersion: "go version go1.25.9 windows/amd64\n", expectedCode: "GENTLE_AI_GO_TOOLCHAIN_TOO_OLD" },
		{ goVersionError: Object.assign(new Error("go was not found"), { code: "ENOENT" }), expectedCode: "GENTLE_AI_GO_TOOLCHAIN_UNAVAILABLE" },
	] as const) {
		const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-windows-go-"));
		const fixture = windowsGoFixture(fixtureOptions);
		const goPath = join(packageRoot, "go.exe");
		await writeFile(goPath, "trusted local Go executable");
		fixture.setGoExecutable(goPath);
		await assert.rejects(
			() => installGentleAi({ packageRoot, platform: "win32", arch: "x64", execFile: fixture.run, resolveGoExecutable: async () => goPath }),
			(error: unknown) => error instanceof Error && "code" in error && error.code === fixtureOptions.expectedCode,
		);
		assert.equal(existsSync(join(packageRoot, ".gentle-ai", "v2.9.1", "gentle-ai.exe")), false);
		assert.deepEqual((await readdir(packageRoot)).filter((entry) => entry.includes("install-")), []);
	}
});

test("Windows source install cleans staging after Go failure or wrong built version", async () => {
	for (const fixtureOptions of [
		{ installError: Object.assign(new Error("go install timed out"), { code: "ETIMEDOUT" }), expectedCode: "GENTLE_AI_GO_INSTALL_FAILED" },
		{ reportedVersion: "gentle-ai 2.2.1\n", expectedCode: "GENTLE_AI_VERSION_MISMATCH" },
	] as const) {
		const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-windows-cleanup-"));
		const fixture = windowsGoFixture(fixtureOptions);
		const goPath = join(packageRoot, "go.exe");
		await writeFile(goPath, "trusted local Go executable");
		fixture.setGoExecutable(goPath);
		await assert.rejects(
			() => installGentleAi({ packageRoot, platform: "win32", arch: "x64", execFile: fixture.run, resolveGoExecutable: async () => goPath }),
			(error: unknown) => error instanceof Error && "code" in error && error.code === fixtureOptions.expectedCode,
		);
		const runtimeDirectory = join(packageRoot, ".gentle-ai", "v2.9.1");
		assert.ok(fixture.calls.some((call) => call.arguments_[0] === "install"));
		assert.equal(existsSync(join(runtimeDirectory, "gentle-ai.exe")), false);
		assert.equal(existsSync(runtimeDirectory) && (await readdir(runtimeDirectory)).some((entry) => entry.startsWith(".go-install-") || entry.endsWith(".tmp")), false);
	}
});

test("Windows source installs reuse only a fully verified package-local binary", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-windows-reuse-"));
	const goPath = join(packageRoot, "go.exe");
	await writeFile(goPath, "trusted local Go executable");
	const initial = windowsGoFixture();
	initial.setGoExecutable(goPath);
	await installGentleAi({ packageRoot, platform: "win32", arch: "x64", execFile: initial.run, resolveGoExecutable: async () => goPath });

	const reuse = windowsGoFixture();
	reuse.setGoExecutable(goPath);
	const reused = await installGentleAi({ packageRoot, platform: "win32", arch: "x64", execFile: reuse.run, resolveGoExecutable: async () => goPath });
	assert.equal(reused.installed, false);
	assert.ok(reuse.calls.every((call) => call.file !== "gentle-ai"), "the installer must never fall back to ambient gentle-ai on PATH");

	await writeFile(join(packageRoot, ".gentle-ai", "v2.9.1", "integrity.json"), "{}\n");
	const repaired = windowsGoFixture();
	repaired.setGoExecutable(goPath);
	assert.equal((await installGentleAi({ packageRoot, platform: "win32", arch: "x64", execFile: repaired.run, resolveGoExecutable: async () => goPath })).installed, true);
	assert.ok(repaired.calls.some((call) => call.arguments_[0] === "install"));
});

interface HardenedGoCall {
	file: string;
	arguments_: string[];
	options: WindowsGoCall["options"] & { cwd?: string };
}

const GO_ARCHITECTURE = {
	AMD64: "amd64",
	ARM64: "arm64",
} as const;

type GoArchitecture = (typeof GO_ARCHITECTURE)[keyof typeof GO_ARCHITECTURE];

interface HardenedGoFixtureOptions {
	architecture?: GoArchitecture;
	blockInstall?: boolean;
	metadataOverride?: string;
}

async function hardenedWindowsGoFixture(packageRoot: string, fixtureOptions: HardenedGoFixtureOptions = {}) {
	const goDirectory = join(packageRoot, "trusted-go");
	const goPath = join(goDirectory, "go.exe");
	await mkdir(goDirectory, { recursive: true });
	await writeFile(goPath, "trusted local Go executable");
	const calls: HardenedGoCall[] = [];
	let resolveCalls = 0;
	let signalInstallStarted: (() => void) | undefined;
	const installStarted = new Promise<void>((resolve) => { signalInstallStarted = resolve; });
	let releaseInstall: (() => void) | undefined;
	const installGate = fixtureOptions.blockInstall
		? new Promise<void>((resolve) => { releaseInstall = resolve; })
		: undefined;
	const metadata = fixtureOptions.metadataOverride ?? [
		"gentle-ai.exe: go1.25.10",
		"\tpath\tgithub.com/gentleman-programming/gentle-ai/v2/cmd/gentle-ai",
		`\tmod\tgithub.com/gentleman-programming/gentle-ai/v2\tv2.9.1\t${GENTLE_AI_WINDOWS_SOURCE_MODULE_CHECKSUM}`,
		"\tbuild\t-buildmode=exe",
		"\tbuild\t-compiler=gc",
		"\tbuild\tCGO_ENABLED=0",
		`\tbuild\tGOARCH=${fixtureOptions.architecture ?? "amd64"}`,
		"\tbuild\tGOOS=windows",
	].join("\n");
	const run = async (file: string, arguments_: string[], options: HardenedGoCall["options"]) => {
		calls.push({ file, arguments_, options });
		if (file === goPath && arguments_.length === 1 && arguments_[0] === "version") return { stdout: "go version go1.25.10 windows/amd64\n", stderr: "" };
		if (file === goPath && arguments_[0] === "install") {
			signalInstallStarted?.();
			await installGate;
			const gobin = options.env?.GOBIN;
			assert.ok(gobin);
			await mkdir(gobin, { recursive: true });
			await writeFile(join(gobin, "gentle-ai.exe"), "trusted Windows source build");
			return { stdout: "", stderr: "" };
		}
		if (file === goPath && arguments_[0] === "version" && arguments_[1] === "-m") return { stdout: metadata, stderr: "" };
		if (arguments_.length === 1 && arguments_[0] === "version") return { stdout: "gentle-ai 2.9.1\n", stderr: "" };
		throw new Error(`unexpected command: ${file} ${arguments_.join(" ")}`);
	};
	return {
		calls,
		goPath,
		resolveGoExecutable: async () => { resolveCalls += 1; return goPath; },
		resolveCalls: () => resolveCalls,
		waitForInstall: () => installStarted,
		releaseInstall: () => releaseInstall?.(),
		run,
	};
}

test("Windows source installation resolves one validated Go executable and seals hostile Go environment", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-hardened-go-"));
	const fixture = await hardenedWindowsGoFixture(packageRoot);
	await installGentleAi({
		packageRoot,
		platform: "win32",
		arch: "x64",
		execFile: fixture.run,
		resolveGoExecutable: fixture.resolveGoExecutable,
		env: {
			GOENV: "C:\\attacker\\goenv",
			GOFLAGS: "-mod=mod",
			GOWORK: "C:\\attacker\\go.work",
			GOPROXY: "http://attacker.invalid",
			GOBIN: "C:\\attacker\\bin",
			GOPATH: "C:\\attacker\\path",
			GOMODCACHE: "C:\\attacker\\mods",
			GOCACHE: "C:\\attacker\\cache",
			GOOS: "linux",
			GOARCH: "386",
			PATH: "C:\\attacker",
			UNRELATED_SECRET: "must-not-reach-go",
		},
	});
	assert.equal(fixture.resolveCalls(), 1);
	const goCalls = fixture.calls.filter((call) => call.file === fixture.goPath);
	assert.deepEqual(goCalls.map((call) => call.arguments_.slice(0, 2)), [
		["version"],
		["install", "github.com/gentleman-programming/gentle-ai/v2/cmd/gentle-ai@v2.9.1"],
		["version", "-m"],
	]);
	for (const call of goCalls) {
		assert.equal(call.options.shell, false);
		assert.equal(call.options.env?.GOENV, "off");
		assert.equal(call.options.env?.GOFLAGS, "");
		assert.equal(call.options.env?.GOWORK, "off");
		assert.equal(call.options.env?.GOTOOLCHAIN, "local");
		assert.equal(call.options.env?.GOSUMDB, "sum.golang.org");
		assert.equal(call.options.env?.GONOSUMDB, "");
		assert.equal(call.options.env?.GOPRIVATE, "");
		assert.equal(call.options.env?.GONOPROXY, "");
		assert.equal(call.options.env?.GOINSECURE, "");
		assert.equal(call.options.env?.GOPROXY, "https://proxy.golang.org");
		assert.equal(call.options.env?.GOOS, "windows");
		assert.equal(call.options.env?.GOARCH, "amd64");
		assert.equal(call.options.env?.UNRELATED_SECRET, undefined);
		assert.doesNotMatch(call.options.env?.PATH ?? "", /attacker/i);
	}
});

test("Windows source manifest binds verified Go metadata and architecture", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-provenance-"));
	const fixture = await hardenedWindowsGoFixture(packageRoot, { architecture: "arm64" });
	const result = await installGentleAi({ packageRoot, platform: "win32", arch: "arm64", execFile: fixture.run, resolveGoExecutable: fixture.resolveGoExecutable });
	const manifest = JSON.parse(await readFile(join(packageRoot, ".gentle-ai", "v2.9.1", "integrity.json"), "utf8")) as Record<string, string>;
	assert.equal(result.installed, true);
	assert.deepEqual(manifest, {
		version: "2.9.1",
		method: "go-sumdb-source-build",
		package: "github.com/gentleman-programming/gentle-ai/v2/cmd/gentle-ai",
		module: "github.com/gentleman-programming/gentle-ai/v2",
		tag: "v2.9.1",
		architecture: "arm64",
		binarySha256: createHash("sha256").update("trusted Windows source build").digest("hex"),
		moduleChecksum: GENTLE_AI_WINDOWS_SOURCE_MODULE_CHECKSUM,
		goVersion: "go1.25.10",
		goos: "windows",
		goarch: "arm64",
		buildMode: "exe",
		compiler: "gc",
		cgoEnabled: "0",
	});
});

test("Windows source installation rejects Go metadata for a different architecture", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-provenance-architecture-"));
	const fixture = await hardenedWindowsGoFixture(packageRoot, { architecture: "arm64" });
	await assert.rejects(
		() => installGentleAi({ packageRoot, platform: "win32", arch: "x64", execFile: fixture.run, resolveGoExecutable: fixture.resolveGoExecutable }),
		(error: unknown) => error instanceof Error && "code" in error && error.code === "GENTLE_AI_GO_INSTALL_FAILED",
	);
	assert.equal(existsSync(join(packageRoot, ".gentle-ai", "v2.9.1", "gentle-ai.exe")), false);
});

test("Windows source installation treats a fresh ownerless lock as active", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-ownerless-lock-"));
	const lockPath = join(packageRoot, ".gentle-ai", ".v2.9.1.install.lock");
	await mkdir(lockPath, { recursive: true });
	const fixture = await hardenedWindowsGoFixture(packageRoot);
	await assertManualLockRecoveryRequired(packageRoot, fixture);
});

test("Windows source installation preserves a lock whose owner nonce changed before release", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-owner-lock-"));
	const lockOwnerPath = join(packageRoot, ".gentle-ai", ".v2.9.1.install.lock", "owner.json");
	const fixture = await hardenedWindowsGoFixture(packageRoot);
	let replacedOwner = false;
	const run = async (...arguments_: Parameters<typeof fixture.run>) => {
		const result = await fixture.run(...arguments_);
		if (!replacedOwner && arguments_[0] !== fixture.goPath && arguments_[1].length === 1 && arguments_[1][0] === "version") {
			replacedOwner = true;
			await writeFile(lockOwnerPath, `${JSON.stringify({ createdAt: Date.now(), nonce: "1".repeat(64) })}\n`);
		}
		return result;
	};
	await installGentleAi({ packageRoot, platform: "win32", arch: "x64", execFile: run, resolveGoExecutable: fixture.resolveGoExecutable });
	assert.equal(replacedOwner, true);
	assert.equal((await readFile(lockOwnerPath, "utf8")).includes("1".repeat(64)), true);
});

async function assertManualLockRecoveryRequired(packageRoot: string, fixture: Awaited<ReturnType<typeof hardenedWindowsGoFixture>>, options: Record<string, unknown> = {}) {
	const lockPath = join(packageRoot, ".gentle-ai", ".v2.9.1.install.lock");
	await assert.rejects(
		() => installGentleAi({ packageRoot, platform: "win32", arch: "x64", execFile: fixture.run, resolveGoExecutable: fixture.resolveGoExecutable, ...options }),
		(error: unknown) => error instanceof Error && error.message.includes(lockPath) && /confirm no installer is active.*remove.*manually/i.test(error.message),
	);
	assert.equal(fixture.calls.some((call) => call.arguments_[0] === "install"), false);
	assert.equal(existsSync(lockPath), true);
}

function tombstonePath(packageRoot: string, nonce: string): string {
	return join(packageRoot, ".gentle-ai", `.v2.9.1.install.tombstone-${nonce}`);
}

async function tombstones(packageRoot: string): Promise<string[]> {
	const runtimeRoot = join(packageRoot, ".gentle-ai");
	return existsSync(runtimeRoot)
		? (await readdir(runtimeRoot)).filter((entry) => entry.startsWith(".v2.9.1.install.tombstone-"))
		: [];
}

function backupBundlePath(packageRoot: string, nonce: string): string {
	return join(packageRoot, ".gentle-ai", `.v2.9.1.backup-${nonce}`);
}

async function copyWindowsBundle(source: string, destination: string): Promise<void> {
	await mkdir(destination, { recursive: true });
	await copyFile(join(source, "gentle-ai.exe"), join(destination, "gentle-ai.exe"));
	await copyFile(join(source, "integrity.json"), join(destination, "integrity.json"));
}

test("Windows source installation fails closed for an ownerless lock even after the stale threshold", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-ownerless-stale-lock-"));
	const lockPath = join(packageRoot, ".gentle-ai", ".v2.9.1.install.lock");
	await mkdir(lockPath, { recursive: true });
	const fixture = await hardenedWindowsGoFixture(packageRoot);
	await assertManualLockRecoveryRequired(packageRoot, fixture, { now: () => Date.now() + 10 * 60_000 });
});

test("Windows source installation fails closed for a stale owner lock", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-stale-lock-"));
	const lockPath = join(packageRoot, ".gentle-ai", ".v2.9.1.install.lock");
	await mkdir(lockPath, { recursive: true });
	await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({ createdAt: 0, nonce: "0".repeat(64) })}\n`);
	const fixture = await hardenedWindowsGoFixture(packageRoot);
	await assertManualLockRecoveryRequired(packageRoot, fixture);
});

test("Windows source release moves a replacement lock to a preserved tombstone", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-release-tombstone-"));
	const fixture = await hardenedWindowsGoFixture(packageRoot);
	const replacementNonce = "2".repeat(64);
	await assert.rejects(
		() => installGentleAi({
			packageRoot,
			platform: "win32",
			arch: "x64",
			execFile: fixture.run,
			resolveGoExecutable: fixture.resolveGoExecutable,
			beforeInstallLockReleaseRename: async (lockPath: string) => writeFile(join(lockPath, "owner.json"), `${JSON.stringify({ createdAt: Date.now(), nonce: replacementNonce })}\n`),
		}),
		/package-private installation lock or tombstone exists/,
	);
	const preserved = await tombstones(packageRoot);
	assert.equal(preserved.length, 1);
	const preservedPath = join(packageRoot, ".gentle-ai", preserved[0]);
	assert.equal((await readFile(join(preservedPath, "owner.json"), "utf8")).includes(replacementNonce), true);
	const retry = await hardenedWindowsGoFixture(packageRoot);
	await assert.rejects(
		() => installGentleAi({ packageRoot, platform: "win32", arch: "x64", execFile: retry.run, resolveGoExecutable: retry.resolveGoExecutable }),
		(error: unknown) => error instanceof Error && error.message.includes(preservedPath),
	);
});

test("Windows source acquisition fails closed when a tombstone appears after its first scan", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-acquire-tombstone-"));
	const fixture = await hardenedWindowsGoFixture(packageRoot);
	const foreignTombstone = tombstonePath(packageRoot, "3".repeat(64));
	await assert.rejects(
		() => installGentleAi({
			packageRoot,
			platform: "win32",
			arch: "x64",
			execFile: fixture.run,
			resolveGoExecutable: fixture.resolveGoExecutable,
			afterInstallLockFirstTombstoneScan: async () => {
				await mkdir(foreignTombstone, { recursive: true });
				await writeFile(join(foreignTombstone, "owner.json"), `${JSON.stringify({ createdAt: Date.now(), nonce: "3".repeat(64) })}\n`);
			},
		}),
		(error: unknown) => error instanceof Error && error.message.includes(foreignTombstone),
	);
	assert.equal(existsSync(foreignTombstone), true);
	assert.equal(existsSync(join(packageRoot, ".gentle-ai", ".v2.9.1.install.lock")), false);
	assert.equal(fixture.calls.some((call) => call.arguments_[0] === "install"), false);
});

test("Windows source release deletes its matching tombstone and allows reuse", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-owned-lock-release-"));
	const fixture = await hardenedWindowsGoFixture(packageRoot);
	await installGentleAi({ packageRoot, platform: "win32", arch: "x64", execFile: fixture.run, resolveGoExecutable: fixture.resolveGoExecutable });
	assert.equal(existsSync(join(packageRoot, ".gentle-ai", ".v2.9.1.install.lock")), false);
	assert.deepEqual(await tombstones(packageRoot), []);
	const reuse = await hardenedWindowsGoFixture(packageRoot);
	assert.equal((await installGentleAi({ packageRoot, platform: "win32", arch: "x64", execFile: reuse.run, resolveGoExecutable: reuse.resolveGoExecutable })).installed, false);
});

test("Windows source recovers a valid backup after a crash between publication renames before any build", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-backup-crash-"));
	const initial = await hardenedWindowsGoFixture(packageRoot);
	await installGentleAi({ packageRoot, platform: "win32", arch: "x64", execFile: initial.run, resolveGoExecutable: initial.resolveGoExecutable });
	const live = join(packageRoot, ".gentle-ai", "v2.9.1");
	const backup = backupBundlePath(packageRoot, "crash");
	await rename(live, backup);
	const recovery = await hardenedWindowsGoFixture(packageRoot);
	let buildAttempted = false;
	const run = async (...arguments_: Parameters<typeof recovery.run>) => {
		if (arguments_[1][0] === "install") { buildAttempted = true; throw new Error("recovery must precede a new build"); }
		return recovery.run(...arguments_);
	};
	assert.equal((await installGentleAi({ packageRoot, platform: "win32", arch: "x64", execFile: run, resolveGoExecutable: recovery.resolveGoExecutable })).installed, false);
	assert.equal(existsSync(live), true);
	assert.equal(existsSync(backup), false);
	assert.equal(buildAttempted, false);
});

test("Windows source fails closed for multiple or invalid backup candidates", async () => {
	for (const setup of ["multiple", "invalid"] as const) {
		const packageRoot = await mkdtemp(join(tmpdir(), `gentle-pi-installer-backup-${setup}-`));
		const first = backupBundlePath(packageRoot, "first");
		await mkdir(first, { recursive: true });
		if (setup === "multiple") await mkdir(backupBundlePath(packageRoot, "second"), { recursive: true });
		else await writeFile(join(first, "not-a-bundle"), "invalid");
		const fixture = await hardenedWindowsGoFixture(packageRoot);
		await assert.rejects(
			() => installGentleAi({ packageRoot, platform: "win32", arch: "x64", execFile: fixture.run, resolveGoExecutable: fixture.resolveGoExecutable }),
			/bundle recovery.*manual/i,
		);
		assert.equal(existsSync(first), true);
		assert.equal(fixture.calls.some((call) => call.arguments_[0] === "install"), false);
	}
});

test("Windows source cleans one validated backup only when the live bundle is valid", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-backup-valid-live-"));
	const initial = await hardenedWindowsGoFixture(packageRoot);
	await installGentleAi({ packageRoot, platform: "win32", arch: "x64", execFile: initial.run, resolveGoExecutable: initial.resolveGoExecutable });
	const live = join(packageRoot, ".gentle-ai", "v2.9.1");
	const backup = backupBundlePath(packageRoot, "valid");
	await copyWindowsBundle(live, backup);
	const reuse = await hardenedWindowsGoFixture(packageRoot);
	assert.equal((await installGentleAi({ packageRoot, platform: "win32", arch: "x64", execFile: reuse.run, resolveGoExecutable: reuse.resolveGoExecutable })).installed, false);
	assert.equal(existsSync(live), true);
	assert.equal(existsSync(backup), false);
});

test("Windows source preserves a valid backup when the live bundle is invalid", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-backup-invalid-live-"));
	const initial = await hardenedWindowsGoFixture(packageRoot);
	await installGentleAi({ packageRoot, platform: "win32", arch: "x64", execFile: initial.run, resolveGoExecutable: initial.resolveGoExecutable });
	const live = join(packageRoot, ".gentle-ai", "v2.9.1");
	const backup = backupBundlePath(packageRoot, "valid");
	await copyWindowsBundle(live, backup);
	await writeFile(join(live, "integrity.json"), "{}\n");
	const fixture = await hardenedWindowsGoFixture(packageRoot);
	await assert.rejects(
		() => installGentleAi({ packageRoot, platform: "win32", arch: "x64", execFile: fixture.run, resolveGoExecutable: fixture.resolveGoExecutable }),
		/bundle recovery.*manual/i,
	);
	assert.equal(existsSync(backup), true);
	assert.equal(fixture.calls.some((call) => call.arguments_[0] === "install"), false);
});

test("Windows concurrent installs fail closed until normal release, then reuse the published bundle", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-concurrent-"));
	const fixture = await hardenedWindowsGoFixture(packageRoot, { blockInstall: true });
	const first = installGentleAi({ packageRoot, platform: "win32", arch: "x64", execFile: fixture.run, resolveGoExecutable: fixture.resolveGoExecutable });
	await fixture.waitForInstall();
	const lockPath = join(packageRoot, ".gentle-ai", ".v2.9.1.install.lock");
	await assert.rejects(
		() => installGentleAi({ packageRoot, platform: "win32", arch: "x64", execFile: fixture.run, resolveGoExecutable: fixture.resolveGoExecutable }),
		(error: unknown) => error instanceof Error && error.message.includes(lockPath),
	);
	assert.equal(fixture.calls.filter((call) => call.file === fixture.goPath && call.arguments_[0] === "install").length, 1);
	fixture.releaseInstall();
	assert.equal((await first).installed, true);
	assert.equal((await installGentleAi({ packageRoot, platform: "win32", arch: "x64", execFile: fixture.run, resolveGoExecutable: fixture.resolveGoExecutable })).installed, false);
	assert.equal(fixture.calls.filter((call) => call.file === fixture.goPath && call.arguments_[0] === "install").length, 1);
});

test("Windows source publication rolls back a prior bundle when final directory swap fails", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-rollback-"));
	const versionDirectory = join(packageRoot, ".gentle-ai", "v2.9.1");
	await mkdir(versionDirectory, { recursive: true });
	await writeFile(join(versionDirectory, "old.txt"), "previous bundle");
	const fixture = await hardenedWindowsGoFixture(packageRoot);
	await assert.rejects(
		() => installGentleAi({
			packageRoot,
			platform: "win32",
			arch: "x64",
			execFile: fixture.run,
			resolveGoExecutable: fixture.resolveGoExecutable,
			rename: async (from: string, to: string) => {
				if (to === versionDirectory && from.includes(".staging-")) throw new Error("simulated final swap failure");
				await rename(from, to);
			},
		}),
		/simulated final swap failure/,
	);
	assert.equal(await readFile(join(versionDirectory, "old.txt"), "utf8"), "previous bundle");
});

test("Darwin/Linux signed bundles retain their four-field manifest and reusable compatibility", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-signed-compatibility-"));
	const payload = Buffer.from("signed archive fixture");
	const asset = { name: "gentle-ai_2.4.0_linux_amd64.tar.gz", sha256: createHash("sha256").update(payload).digest("hex"), url: "https://example.invalid/gentle-ai.tar.gz", executable: "gentle-ai" };
	const options = {
		packageRoot,
		platform: "linux",
		arch: "x64",
		releaseAssets: { "linux/amd64": asset },
		download: async (_url: string, destination: string) => writeFile(destination, payload),
		extractArchive: async (_archive: string, destination: string) => {
			await mkdir(destination, { recursive: true });
			await writeFile(join(destination, "gentle-ai"), "signed binary");
		},
	};
	await installGentleAi(options);
	const manifestPath = join(packageRoot, ".gentle-ai", "v2.9.1", "integrity.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, string>;
	assert.deepEqual(Object.keys(manifest), ["version", "asset", "assetSha256", "binarySha256"]);
	assert.equal((await installGentleAi({ ...options, download: async () => { throw new Error("signed bundle must be reused"); } })).installed, false);
});

test("a pinned asset falls back to its gentle-pi mirror only on download failure, and a stable pin declares no mirror", async () => {
	// The mirror fallback is a property of the pinned row, not of the asset
	// form: a prerelease row carries a mirrorUrl, a stable row never does.
	// Drive the fallback through an archive-form asset so the same test holds
	// under the current stable pin, whose form gate refuses raw binaries.
	const payload = Buffer.from("signed archive fixture");
	const binary = "mirrored binary";
	const baseAsset = { name: "gentle-ai_2.9.1_linux_amd64.tar.gz", sha256: createHash("sha256").update(payload).digest("hex"), binarySha256: createHash("sha256").update(binary).digest("hex"), url: "https://example.invalid/upstream", mirrorUrl: "https://example.invalid/mirror", executable: "gentle-ai" };
	const extractArchive = async (_archive: string, destination: string) => {
		await mkdir(destination, { recursive: true });
		await writeFile(join(destination, "gentle-ai"), binary);
	};

	const attempted: string[] = [];
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-mirror-"));
	const result = await installGentleAi({
		packageRoot, platform: "linux", arch: "x64",
		releaseAssets: { "linux/amd64": baseAsset },
		extractArchive,
		download: async (url: string, destination: string) => {
			attempted.push(url);
			if (url === baseAsset.url) throw new Error("upstream asset deleted");
			await writeFile(destination, payload);
		},
	});
	assert.equal(result.installed, true);
	assert.deepEqual(attempted, [baseAsset.url, baseAsset.mirrorUrl]);

	// Integrity beats availability: wrong bytes from the upstream source fail
	// immediately and the mirror is never consulted.
	const mismatched: string[] = [];
	await assert.rejects(installGentleAi({
		packageRoot: await mkdtemp(join(tmpdir(), "gentle-pi-installer-mirror-mismatch-")), platform: "linux", arch: "x64",
		releaseAssets: { "linux/amd64": baseAsset },
		extractArchive,
		download: async (url: string, destination: string) => { mismatched.push(url); await writeFile(destination, "tampered bytes"); },
	}), /checksum mismatch/);
	assert.deepEqual(mismatched, [baseAsset.url]);

	// Both sources unavailable: the failure names the documented recovery.
	await assert.rejects(installGentleAi({
		packageRoot: await mkdtemp(join(tmpdir(), "gentle-pi-installer-mirror-unavailable-")), platform: "linux", arch: "x64",
		releaseAssets: { "linux/amd64": baseAsset },
		extractArchive,
		download: async () => { throw new Error("gone"); },
	}), (error: unknown) => error instanceof Error && /GENTLE_PI_SKIP_GENTLE_AI_INSTALL=1/.test(error.message) && (error as { code?: string }).code === "GENTLE_AI_ASSET_UNAVAILABLE");

	// A stable pin downloads only from the signed gentle-ai release: no pinned
	// row carries a mirror, so an upstream failure surfaces as the primary error.
	for (const pinned of Object.values(GENTLE_AI_RELEASE_ASSETS)) {
		assert.equal((pinned as { mirrorUrl?: string }).mirrorUrl, undefined);
	}
});

test("Windows archive lookup remains unsupported and names Go SumDB source installation", () => {
	for (const arch of ["x64", "arm64"]) {
		assert.throws(() => resolveGentleAiReleaseAsset("win32", arch), /Go SumDB source installation/);
	}
});

test("unsupported platform pairs fail clearly before download", () => {
	for (const [platform, arch] of [["freebsd", "x64"], ["linux", "ia32"], ["darwin", "ppc64"]]) {
		assert.throws(() => resolveGentleAiReleaseAsset(platform, arch), /unsupported Gentle AI platform\/architecture/);
	}
});

test("extractors use only absolute trusted system paths, never lifecycle PATH or SystemRoot", () => {
	const extractor = trustedSystemExtractor("archive.tar.gz", "linux", (path) => path === "/usr/bin/tar");
	assert.equal(extractor.command, "/usr/bin/tar");
	assert.ok(extractor.command.startsWith("/"));
	assert.throws(() => trustedSystemExtractor("archive.zip", "linux", () => false), /trusted system unzip/);
	const originalSystemRoot = process.env.SystemRoot;
	try {
		for (const hostileSystemRoot of ["relative", "\\\\attacker\\share", "C:\\attacker", ""]) {
			process.env.SystemRoot = hostileSystemRoot;
			const windows = trustedSystemExtractor("archive.zip", "win32", (path) => path === "C:\\Windows\\System32\\tar.exe");
			assert.equal(windows.command, "C:\\Windows\\System32\\tar.exe");
		}
	} finally {
		if (originalSystemRoot === undefined) delete process.env.SystemRoot;
		else process.env.SystemRoot = originalSystemRoot;
	}
});

function pendingRequest() {
	const pending = new EventEmitter() as EventEmitter & { destroy(error?: Error): void; setTimeout(): void };
	pending.destroy = (error) => queueMicrotask(() => pending.emit("error", error));
	pending.setTimeout = () => undefined;
	return pending;
}
test("download bounds stalled headers and bodies with transient retry exhaustion", async () => {
	for (const [stage, request] of [
		["headers", () => pendingRequest()],
		["body", (_url: URL, _options: unknown, callback: (response: PassThrough & { statusCode?: number; headers: Record<string, string> }) => void) => {
			const response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
			queueMicrotask(() => callback(response));
			return pendingRequest();
		}],
	] as const) {
		let attempts = 0;
		await assert.rejects(() => downloadGentleAiAsset("https://example.invalid/archive", join(tmpdir(), `gentle-pi-stalled-${stage}-${process.pid}`), 1024, 0, { request: (...args: never[]) => { attempts += 1; return request(...args); }, headerTimeoutMs: 1, bodyTimeoutMs: 1, maxAttempts: 2, retryDelayMs: 0 }), new RegExp(`download ${stage} timed out`));
		assert.equal(attempts, 2);
	}
});

test("download retries only transient HTTP statuses and exhausts within the attempt bound", async () => {
	for (const [status, expectedAttempts] of [[429, 2], [500, 2], [502, 2], [503, 2], [504, 2], [400, 1], [404, 1]] as const) {
		let attempts = 0;
		const request = (_url: URL, _options: unknown, callback: (response: PassThrough & { statusCode?: number; headers: Record<string, string> }) => void) => { attempts += 1; const response = Object.assign(new PassThrough(), { statusCode: status, headers: {} }); queueMicrotask(() => { callback(response); response.end(); }); return pendingRequest(); };
		await assert.rejects(() => downloadGentleAiAsset("https://example.invalid/archive", join(tmpdir(), `gentle-pi-http-${status}-${process.pid}`), 1024, 0, { request, maxAttempts: 2, retryDelayMs: 0 }), new RegExp(`HTTP ${status}`));
		assert.equal(attempts, expectedAttempts, `HTTP ${status}`);
	}
});

test("checksum mismatch cleans temporary state without promoting a binary", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-mismatch-"));
	await assert.rejects(
		() => installGentleAi({
			packageRoot,
			platform: "linux",
			arch: "x64",
			download: async (_url, destination) => writeFile(destination, "corrupt archive"),
		}),
		/checksum mismatch/,
	);
	assert.equal(existsSync(join(packageRoot, ".gentle-ai", "v2.9.1", "gentle-ai")), false);
	assert.deepEqual((await readdir(packageRoot)).filter((entry) => entry.startsWith(".gentle-ai-install-")), []);
});

test("installer promotes only the expected regular executable with executable POSIX mode", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-promote-"));
	const payload = Buffer.from("trusted archive fixture");
	const sha256 = createHash("sha256").update(payload).digest("hex");
	const asset = { name: "gentle-ai_2.1.3_linux_amd64.tar.gz", sha256, url: "https://example.invalid/gentle-ai.tar.gz", executable: "gentle-ai" };
	await installGentleAi({
		packageRoot,
		platform: "linux",
		arch: "x64",
		releaseAssets: { "linux/amd64": asset },
		download: async (_url, destination) => writeFile(destination, payload),
		extractArchive: async (_archive, destination) => {
			await mkdir(destination, { recursive: true });
			const extracted = join(destination, "gentle-ai");
			await writeFile(extracted, "native executable");
			await chmod(extracted, 0o700);
		},
	});
	const binary = join(packageRoot, ".gentle-ai", "v2.9.1", "gentle-ai");
	assert.equal(existsSync(binary), true);
	assert.equal(await readFile(binary, "utf8"), "native executable");
	assert.ok(((await stat(binary)).mode & 0o111) !== 0);
	assert.equal((await installGentleAi({ packageRoot, platform: "linux", arch: "x64", releaseAssets: { "linux/amd64": asset } })).installed, false);
});

test("installer rejects an extracted binary that differs from its pinned digest", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-binary-mismatch-"));
	const payload = Buffer.from("trusted archive fixture");
	const asset = {
		name: "gentle-ai_2.1.9_linux_amd64.tar.gz",
		sha256: createHash("sha256").update(payload).digest("hex"),
		binarySha256: "0".repeat(64),
		url: "https://example.invalid/gentle-ai.tar.gz",
		executable: "gentle-ai",
	};
	await assert.rejects(
		() => installGentleAi({
			packageRoot,
			platform: "linux",
			arch: "x64",
			releaseAssets: { "linux/amd64": asset },
			download: async (_url, destination) => writeFile(destination, payload),
			extractArchive: async (_archive, destination) => {
				await mkdir(destination, { recursive: true });
				await writeFile(join(destination, "gentle-ai"), "native executable");
			},
		}),
		/binary checksum mismatch/,
	);
	assert.equal(existsSync(join(packageRoot, ".gentle-ai", "v2.9.1", "gentle-ai")), false);
});

test("installer repairs a valid non-executable POSIX binary instead of reusing it", async (t) => {
	if (process.platform === "win32") {
		t.skip("Windows does not use POSIX executable mode bits");
		return;
	}
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-repair-mode-"));
	const payload = Buffer.from("trusted archive fixture");
	const asset = { name: "gentle-ai_2.1.3_linux_amd64.tar.gz", sha256: createHash("sha256").update(payload).digest("hex"), url: "https://example.invalid/gentle-ai.tar.gz", executable: "gentle-ai" };
	const options = {
		packageRoot,
		platform: "linux",
		arch: "x64",
		releaseAssets: { "linux/amd64": asset },
		download: async (_url: string, destination: string) => writeFile(destination, payload),
		extractArchive: async (_archive: string, destination: string) => {
			await mkdir(destination, { recursive: true });
			await writeFile(join(destination, "gentle-ai"), "native executable");
		},
	};
	await installGentleAi(options);
	const binary = join(packageRoot, ".gentle-ai", "v2.9.1", "gentle-ai");
	await chmod(binary, 0o600);
	const repaired = await installGentleAi(options);
	assert.equal(repaired.installed, true);
	assert.notEqual((await stat(binary)).mode & 0o111, 0);
});

test("installer rejects a symlinked package-local runtime parent directory", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-symlink-"));
	const redirected = await mkdtemp(join(tmpdir(), "gentle-pi-installer-redirected-"));
	await symlink(redirected, join(packageRoot, ".gentle-ai"));
	await assert.rejects(
		() => installGentleAi({ packageRoot, platform: "linux", arch: "x64" }),
		/package-local runtime directory/,
	);
});

test("installer rejects archives with multiple expected executable entries", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-cardinality-"));
	const payload = Buffer.from("trusted archive fixture");
	const asset = { name: "gentle-ai_2.1.3_linux_amd64.tar.gz", sha256: createHash("sha256").update(payload).digest("hex"), url: "https://example.invalid/gentle-ai.tar.gz", executable: "gentle-ai" };
	await assert.rejects(
		() => installGentleAi({
			packageRoot,
			platform: "linux",
			arch: "x64",
			releaseAssets: { "linux/amd64": asset },
			download: async (_url, destination) => writeFile(destination, payload),
			extractArchive: async (_archive, destination) => {
				await mkdir(join(destination, "first"), { recursive: true });
				await mkdir(join(destination, "second"), { recursive: true });
				await writeFile(join(destination, "first", "gentle-ai"), "one");
				await writeFile(join(destination, "second", "gentle-ai"), "two");
			},
		}),
		/exactly one regular gentle-ai/,
	);
	assert.equal(existsSync(join(packageRoot, ".gentle-ai", "v2.9.1", "gentle-ai")), false);
});

test("installer rejects an archive without the expected regular executable", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-nonregular-"));
	const payload = Buffer.from("trusted archive fixture");
	const asset = { name: "gentle-ai_2.1.3_linux_amd64.tar.gz", sha256: createHash("sha256").update(payload).digest("hex"), url: "https://example.invalid/gentle-ai.tar.gz", executable: "gentle-ai" };
	await assert.rejects(
		() => installGentleAi({
			packageRoot,
			platform: "linux",
			arch: "x64",
			releaseAssets: { "linux/amd64": asset },
			download: async (_url, destination) => writeFile(destination, payload),
			extractArchive: async (_archive, destination) => mkdir(join(destination, "gentle-ai"), { recursive: true }),
		}),
		/non-regular gentle-ai/,
	);
	assert.equal(existsSync(join(packageRoot, ".gentle-ai", "v2.9.1", "gentle-ai")), false);
});

// #400: a clean Windows source build measured 232 s on a cold module cache,
// so `go install` cannot share the 120 s bound that fits the `go version`
// probes. The probes keep their bound; the build gets its own.
test("Windows source build bounds go install separately from the Go toolchain probes", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-installer-windows-timeout-"));
	const fixture = windowsGoFixture();
	const goPath = join(packageRoot, "go.exe");
	await writeFile(goPath, "trusted local Go executable");
	fixture.setGoExecutable(goPath);
	await installGentleAi({ packageRoot, platform: "win32", arch: "x64", execFile: fixture.run, resolveGoExecutable: async () => goPath });
	const goCalls = fixture.calls.filter((call) => call.file === goPath);
	const install = goCalls.find((call) => call.arguments_[0] === "install");
	assert.ok(install, "go install must run");
	assert.ok(typeof install.options.timeout === "number" && install.options.timeout >= 600_000, `go install must get at least a ten-minute bound, received ${install.options.timeout}`);
	const probes = goCalls.filter((call) => call.arguments_[0] === "version");
	assert.ok(probes.length >= 2, "go version probes must run");
	for (const probe of probes) assert.equal(probe.options.timeout, 120_000, `go ${probe.arguments_.join(" ")} keeps the probe bound`);
});
