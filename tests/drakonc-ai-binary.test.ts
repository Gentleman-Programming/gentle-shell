import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import test from "node:test";
import {
	DRAKONC_AI_BINARY_MISSING_CODE,
	DRAKONC_AI_DEV_BINARY_ENV,
	DRAKONC_AI_VERSION,
	binaryDigest,
	drakoncAiDevBinaryRegistrationPath,
	PackageLocalDrakoncAiBinaryMissingError,
	registerDrakoncAiDevBinary,
	resolveDrakoncAiBinary,
	setDrakoncAiDevBinaryEnvironmentForTesting,
	unregisterDrakoncAiDevBinary,
	type DrakoncAiDevBinaryEnvironment,
} from "../lib/drakonc-ai-binary.ts";
import { NativeReviewCliV216, createNativeReviewCli, type ExecFileAdapter } from "../lib/native-review-cli.ts";
import { DRAKONC_AI_WINDOWS_SOURCE_MODULE_CHECKSUM, resolveDrakoncAiReleaseAsset } from "../scripts/drakonc-ai-installer.mjs";
import { requireNativeBinary } from "./support/native-binary-gate.ts";

const VERSION = { stdout: `drakonc-ai ${DRAKONC_AI_VERSION}\n`, stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false } as const;
const RUNTIME_DIRECTORY = `v${DRAKONC_AI_VERSION}`;
const repoRuntimeBinary = join(import.meta.dirname, "..", ".drakonc-ai", RUNTIME_DIRECTORY, process.platform === "win32" ? "drakonc-ai.exe" : "drakonc-ai");
const releaseDigestsPinned = process.platform === "win32" || /^[0-9a-f]{64}$/.test(resolveDrakoncAiReleaseAsset(process.platform, process.arch).sha256);
// These integrity tests need the published official binary; they skip while a
// re-pinned release's archives and digest table are still pending.
const nativeBinaryGate = requireNativeBinary({
	resolvedBinary: existsSync(repoRuntimeBinary) ? repoRuntimeBinary : undefined,
	digestsPinned: releaseDigestsPinned,
	env: process.env,
});
if (nativeBinaryGate.run === false) console.log(`drakonc-ai-binary: ${nativeBinaryGate.reason}`);
const verifiedBinaryTest = nativeBinaryGate.run && process.platform !== "win32" ? test : test.skip;

interface PinnedBinaryIsolation {
	environment: DrakoncAiDevBinaryEnvironment;
	savedEnvironmentValue: string | undefined;
	savedRegistration: string | undefined;
}

let pinnedBinaryIsolation: PinnedBinaryIsolation | undefined;

test.beforeEach((t) => {
	assert.ok("after" in t);
	const home = mkdtempSync(join(tmpdir(), "drakonc-pi-pinned-binary-home-"));
	const environment: DrakoncAiDevBinaryEnvironment = { env: { ...process.env }, home };
	delete environment.env.DRAKONC_PI_CONFIG_HOME;
	const savedEnvironmentValue = environment.env[DRAKONC_AI_DEV_BINARY_ENV];
	const registrationPath = drakoncAiDevBinaryRegistrationPath(environment);
	const savedRegistration = existsSync(registrationPath)
		? readFileSync(registrationPath, "utf8")
		: undefined;

	delete environment.env[DRAKONC_AI_DEV_BINARY_ENV];
	unregisterDrakoncAiDevBinary(environment);
	setDrakoncAiDevBinaryEnvironmentForTesting(environment);
	pinnedBinaryIsolation = { environment, savedEnvironmentValue, savedRegistration };

	t.after(() => {
		if (savedEnvironmentValue === undefined) {
			delete environment.env[DRAKONC_AI_DEV_BINARY_ENV];
		} else {
			environment.env[DRAKONC_AI_DEV_BINARY_ENV] = savedEnvironmentValue;
		}
		if (savedRegistration === undefined) {
			unregisterDrakoncAiDevBinary(environment);
		} else {
			mkdirSync(dirname(registrationPath), { recursive: true });
			writeFileSync(registrationPath, savedRegistration);
		}
		setDrakoncAiDevBinaryEnvironmentForTesting(undefined);
		pinnedBinaryIsolation = undefined;
		rmSync(home, { recursive: true, force: true });
	});
});

async function writeVerifiedBinary(packageRoot: string, platform = process.platform): Promise<string> {
	const asset = resolveDrakoncAiReleaseAsset(platform, process.arch);
	const binaryPath = join(packageRoot, ".drakonc-ai", RUNTIME_DIRECTORY, asset.executable);
	await mkdir(join(packageRoot, ".drakonc-ai", RUNTIME_DIRECTORY), { recursive: true });
	await writeFile(binaryPath, readFileSync(join(import.meta.dirname, "..", ".drakonc-ai", RUNTIME_DIRECTORY, asset.executable)));
	if (platform !== "win32") await chmod(binaryPath, 0o700);
	await writeFile(join(packageRoot, ".drakonc-ai", RUNTIME_DIRECTORY, "integrity.json"), `${JSON.stringify({ version: DRAKONC_AI_VERSION, asset: asset.name, assetSha256: asset.sha256, binarySha256: asset.binarySha256 })}\n`);
	return binaryPath;
}

async function writeWindowsSourceBinary(packageRoot: string): Promise<{ binaryPath: string; manifestPath: string }> {
	const binaryPath = join(packageRoot, ".drakonc-ai", RUNTIME_DIRECTORY, "drakonc-ai.exe");
	const manifestPath = join(packageRoot, ".drakonc-ai", RUNTIME_DIRECTORY, "integrity.json");
	const binary = "verified Windows source build";
	await mkdir(join(packageRoot, ".drakonc-ai", RUNTIME_DIRECTORY), { recursive: true });
	await writeFile(binaryPath, binary);
	await writeFile(manifestPath, `${JSON.stringify({
		version: DRAKONC_AI_VERSION,
		method: "go-sumdb-source-build",
		package: "github.com/drakoncman-programming/drakonc-ai/v5/cmd/drakonc-ai",
		module: "github.com/drakoncman-programming/drakonc-ai/v5",
		tag: RUNTIME_DIRECTORY,
		architecture: process.arch === "x64" ? "x64" : "arm64",
		binarySha256: createHash("sha256").update(binary).digest("hex"),
		moduleChecksum: DRAKONC_AI_WINDOWS_SOURCE_MODULE_CHECKSUM,
		goVersion: "go1.25.10",
		goos: "windows",
		goarch: process.arch === "x64" ? "amd64" : "arm64",
		buildMode: "exe",
		compiler: "gc",
		cgoEnabled: "0",
	})}\n`);
	return { binaryPath, manifestPath };
}

verifiedBinaryTest("runtime resolves an absolute package-local binary path without PATH fallback or ambient dev contamination", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "drakonc-pi-binary-"));
	const executable = process.platform === "win32" ? "drakonc-ai.exe" : "drakonc-ai";
	const binaryPath = await writeVerifiedBinary(packageRoot);
	const devBinary = join(packageRoot, "maintainer-dev-binary");
	await writeFile(devBinary, "maintainer dev binary");
	if (process.platform !== "win32") await chmod(devBinary, 0o700);
	const isolation = pinnedBinaryIsolation;
	assert.ok(isolation, "the pinned-binary fixture must install its isolated environment");

	const ambientValue = process.env[DRAKONC_AI_DEV_BINARY_ENV];
	process.env[DRAKONC_AI_DEV_BINARY_ENV] = devBinary;
	try {
		assert.equal(resolveDrakoncAiBinary(packageRoot, process.platform), binaryPath, "a maintainer's ambient override must not contaminate a pinned-package case");
	} finally {
		if (ambientValue === undefined) delete process.env[DRAKONC_AI_DEV_BINARY_ENV];
		else process.env[DRAKONC_AI_DEV_BINARY_ENV] = ambientValue;
	}

	isolation.environment.env[DRAKONC_AI_DEV_BINARY_ENV] = devBinary;
	assert.equal(resolveDrakoncAiBinary(packageRoot, process.platform), devBinary, "an explicit dev-binary test may opt in through the isolated environment seam");
	delete isolation.environment.env[DRAKONC_AI_DEV_BINARY_ENV];
	registerDrakoncAiDevBinary(devBinary, isolation.environment);
	assert.equal(resolveDrakoncAiBinary(packageRoot, process.platform), devBinary, "an explicit persistent dev registration may opt in through the isolated environment seam");
	assert.equal(unregisterDrakoncAiDevBinary(isolation.environment), true);

	const resolved = resolveDrakoncAiBinary(packageRoot, process.platform);
	assert.equal(resolved, binaryPath, "clearing the explicit registration restores the pinned resolver");
	assert.equal(isAbsolute(resolved), true);
	assert.equal(basename(resolved), executable);
	assert.doesNotMatch(resolved, /(^|[/\\])PATH($|[/\\])/i);
});

test("runtime validates a Windows Go SumDB source manifest and rejects tampering, symlinks, and PATH injection", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "drakonc-pi-windows-source-runtime-"));
	const { binaryPath, manifestPath } = await writeWindowsSourceBinary(packageRoot);
	assert.equal(resolveDrakoncAiBinary(packageRoot, "win32"), binaryPath);

	const valid = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, string>;
	for (const manifest of [
		{ ...valid, method: "signed-release-asset" },
		{ ...valid, module: "example.invalid/drakonc-ai" },
		{ ...valid, tag: "v2.2.1" },
		{ ...valid, binarySha256: "0".repeat(64) },
		{ ...valid, moduleChecksum: "h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
		{ ...valid, goVersion: "go1.25.9" },
		{ ...valid, goVersion: "go1.25" },
	]) {
		await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
		assert.throws(() => resolveDrakoncAiBinary(packageRoot, "win32"), /package-local-binary-missing/);
	}
	await writeFile(manifestPath, `${JSON.stringify(valid)}\n`);
	await writeFile(binaryPath, "tampered Windows source build");
	assert.throws(() => resolveDrakoncAiBinary(packageRoot, "win32"), /package-local-binary-missing/);
	await writeFile(binaryPath, "verified Windows source build");
	await rm(binaryPath);
	const ambient = join(packageRoot, "ambient-drakonc-ai.exe");
	await writeFile(ambient, "ambient executable");
	await symlink(ambient, binaryPath);
	assert.throws(() => resolveDrakoncAiBinary(packageRoot, "win32"), /package-local-binary-missing/);
	assert.doesNotMatch(drakoncAiBinaryPathForTest(packageRoot), /(^|[/\\])PATH($|[/\\])/i);
});

// Every native call resolved the binary by reading and hashing all of it; on
// Windows each read is also scanned by antivirus. The digest is reused only
// while the file keeps its identity (device, inode, size, mtime and ctime).
test("runtime reuses the binary digest while the file is unchanged and re-hashes after any rewrite", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "drakonc-pi-binary-digest-cache-"));
	const { binaryPath } = await writeWindowsSourceBinary(packageRoot);
	let reads = 0;
	const countingRead = (path: string) => { reads++; return readFileSync(path); };
	assert.equal(resolveDrakoncAiBinary(packageRoot, "win32", countingRead), binaryPath);
	assert.equal(resolveDrakoncAiBinary(packageRoot, "win32", countingRead), binaryPath);
	assert.equal(binaryDigest(binaryPath, countingRead), createHash("sha256").update(readFileSync(binaryPath)).digest("hex"));
	assert.equal(reads, 1, "an unchanged binary is hashed once");
	await writeFile(binaryPath, "tampered Windows source build");
	assert.throws(() => resolveDrakoncAiBinary(packageRoot, "win32", countingRead), /package-local-binary-missing/);
	assert.equal(reads, 2, "a rewritten binary is hashed again, even with the same size");
});

function drakoncAiBinaryPathForTest(packageRoot: string): string {
	return join(packageRoot, ".drakonc-ai", RUNTIME_DIRECTORY, "drakonc-ai.exe");
}

test("runtime rejects an unverified binary, a symlinked manifest, and ambient executable injection", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "drakonc-pi-binary-integrity-"));
	const executable = process.platform === "win32" ? "drakonc-ai.exe" : "drakonc-ai";
	const binaryPath = join(packageRoot, ".drakonc-ai", RUNTIME_DIRECTORY, executable);
	const manifestPath = join(packageRoot, ".drakonc-ai", RUNTIME_DIRECTORY, "integrity.json");
	await mkdir(join(packageRoot, ".drakonc-ai", RUNTIME_DIRECTORY), { recursive: true });
	await writeFile(binaryPath, "native");

	assert.throws(() => resolveDrakoncAiBinary(packageRoot, process.platform), /package-local-binary-missing/);
	const binarySha256 = createHash("sha256").update("native").digest("hex");
	const manifestTarget = join(packageRoot, "manifest-target.json");
	await writeFile(manifestTarget, `${JSON.stringify({ version: DRAKONC_AI_VERSION, asset: `drakonc-ai_${DRAKONC_AI_VERSION}_${process.platform}_${process.arch === "x64" ? "amd64" : process.arch}.tar.gz`, assetSha256: "a".repeat(64), binarySha256 })}\n`);
	await symlink(manifestTarget, manifestPath);
	assert.throws(() => resolveDrakoncAiBinary(packageRoot, process.platform), /package-local-binary-missing/);
	assert.throws(() => new NativeReviewCliV216(async () => VERSION, "drakonc-ai"), /absolute package-local executable/);
});

verifiedBinaryTest("runtime rejects malformed, unknown, wrong, and symlinked integrity paths", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "drakonc-pi-binary-manifest-"));
	const binaryPath = await writeVerifiedBinary(packageRoot);
	const manifestPath = join(packageRoot, ".drakonc-ai", RUNTIME_DIRECTORY, "integrity.json");
	const valid = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, string>;
	for (const manifest of [
		"{",
		{ ...valid, extra: "unknown" },
		{ ...valid, version: "9.9.9" },
		{ ...valid, asset: "wrong-asset" },
		{ ...valid, assetSha256: "0".repeat(64) },
		{ ...valid, binarySha256: "not-a-digest" },
	]) {
		writeFileSync(manifestPath, typeof manifest === "string" ? manifest : JSON.stringify(manifest));
		assert.throws(() => resolveDrakoncAiBinary(packageRoot, process.platform), /package-local-binary-missing/);
	}
	await writeFile(manifestPath, JSON.stringify(valid));
	const binaryTarget = join(packageRoot, "binary-target");
	await writeFile(binaryTarget, "native");
	await rm(binaryPath);
	await symlink(binaryTarget, binaryPath);
	assert.throws(() => resolveDrakoncAiBinary(packageRoot, process.platform), /package-local-binary-missing/);

	const directoryRoot = await mkdtemp(join(tmpdir(), "drakonc-pi-binary-directory-"));
	await symlink(join(packageRoot, ".drakonc-ai"), join(directoryRoot, ".drakonc-ai"));
	assert.throws(() => resolveDrakoncAiBinary(directoryRoot, process.platform), /package-local-binary-missing/);
});

verifiedBinaryTest("runtime rejects a binary-only tamper while its canonical pinned manifest remains unchanged", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "drakonc-pi-binary-pinned-manifest-tamper-"));
	const binaryPath = await writeVerifiedBinary(packageRoot);
	await writeFile(binaryPath, "binary-only tamper");
	if (process.platform !== "win32") await chmod(binaryPath, 0o700);
	assert.throws(() => resolveDrakoncAiBinary(packageRoot, process.platform), /package-local-binary-missing/);
});

verifiedBinaryTest("runtime rejects an arbitrary binary even when a forged manifest matches its digest", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "drakonc-pi-binary-forged-manifest-"));
	const binaryPath = await writeVerifiedBinary(packageRoot);
	const asset = resolveDrakoncAiReleaseAsset(process.platform, process.arch);
	await writeFile(binaryPath, "arbitrary binary");
	if (process.platform !== "win32") await chmod(binaryPath, 0o700);
	await writeFile(join(packageRoot, ".drakonc-ai", RUNTIME_DIRECTORY, "integrity.json"), JSON.stringify({ version: DRAKONC_AI_VERSION, asset: asset.name, assetSha256: asset.sha256, binarySha256: createHash("sha256").update("arbitrary binary").digest("hex") }));
	assert.throws(() => resolveDrakoncAiBinary(packageRoot, process.platform), /package-local-binary-missing/);
});

verifiedBinaryTest("runtime rejects binary replacement during verification", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "drakonc-pi-binary-replacement-"));
	const binaryPath = await writeVerifiedBinary(packageRoot);
	assert.throws(
		() => resolveDrakoncAiBinary(packageRoot, process.platform, (path) => {
			writeFileSync(path, "replaced");
			return readFileSync(path);
		}),
		/package-local-binary-missing/,
	);
	assert.equal(readFileSync(binaryPath, "utf8"), "replaced");
});

test("runtime fails closed when the package-local binary is missing", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "drakonc-pi-binary-missing-"));
	assert.throws(
		() => resolveDrakoncAiBinary(packageRoot, "linux"),
		(error: unknown) => error instanceof PackageLocalDrakoncAiBinaryMissingError
			&& error.code === DRAKONC_AI_BINARY_MISSING_CODE
			&& error.message.includes("package-local-binary-missing")
			&& error.message.includes("If DRAKONC_PI_SKIP_DRAKONC_AI_INSTALL is set, remove or unset it before")
			&& error.message.includes("installed drakonc-pi package directory")
			&& error.message.includes("DRAKONC_PI_SKIP_DRAKONC_AI_INSTALL")
			&& error.message.includes("remove or unset it before")
			&& error.message.includes("does not prove install lifecycle scripts were disabled"),
	);
});

verifiedBinaryTest("runtime rejects a valid but non-executable POSIX binary", async (t) => {
	if (process.platform === "win32") {
		t.skip("Windows does not use POSIX executable mode bits");
		return;
	}
	const packageRoot = await mkdtemp(join(tmpdir(), "drakonc-pi-binary-non-executable-"));
	const binaryPath = await writeVerifiedBinary(packageRoot);
	await chmod(binaryPath, 0o600);
	assert.throws(() => resolveDrakoncAiBinary(packageRoot, process.platform), /package-local-binary-missing/);
});

test("production native operations report the package-local missing binary code", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "drakonc-pi-native-missing-"));
	const adapter: ExecFileAdapter = async () => {
		throw new Error("the adapter must not be reached when the package binary is missing");
	};
	await assert.rejects(
		() => createNativeReviewCli(adapter, () => resolveDrakoncAiBinary(packageRoot, "linux")).start({ cwd: packageRoot }),
		(error: unknown) => error instanceof Error && "code" in error && error.code === DRAKONC_AI_BINARY_MISSING_CODE,
	);
});

verifiedBinaryTest("production native client never invokes a global drakonc-ai executable", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "drakonc-pi-native-"));
	const binaryPath = await writeVerifiedBinary(packageRoot);
	const calls: string[] = [];
	const adapter: ExecFileAdapter = async (request) => {
		calls.push(request.file);
		return {
			...VERSION,
			stdout: readFileSync(join(import.meta.dirname, "..", "contracts", "review-integration", "v2", "fixtures", "status.fixture.json"), "utf8"),
		};
	};

	await assert.rejects(
		() => createNativeReviewCli(adapter, () => resolveDrakoncAiBinary(packageRoot, process.platform)).targetStatus!({ cwd: packageRoot, lineageId: "review-status-fixture" }),
		/status\/v3 is older than the supported v9 \(drakonc-ai v4\.6\.0\)/,
	);
	assert.deepEqual(calls, [binaryPath]);
	assert.ok(calls.every((file) => file !== "drakonc-ai"));
	assert.throws(() => new NativeReviewCliV216(adapter, "drakonc-ai"), /absolute package-local executable/);
	assert.throws(() => new NativeReviewCliV216(adapter, "./drakonc-ai"), /absolute package-local executable/);
});
