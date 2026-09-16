import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import test from "node:test";
import {
	GENTLE_AI_BINARY_MISSING_CODE,
	GENTLE_AI_DEV_BINARY_ENV,
	GENTLE_AI_VERSION,
	gentleAiDevBinaryRegistrationPath,
	PackageLocalGentleAiBinaryMissingError,
	registerGentleAiDevBinary,
	resolveGentleAiBinary,
	setGentleAiDevBinaryEnvironmentForTesting,
	unregisterGentleAiDevBinary,
	type GentleAiDevBinaryEnvironment,
} from "../lib/gentle-ai-binary.ts";
import { NativeReviewCliV216, createNativeReviewCli, type ExecFileAdapter } from "../lib/native-review-cli.ts";
import { GENTLE_AI_WINDOWS_SOURCE_MODULE_CHECKSUM, resolveGentleAiReleaseAsset } from "../scripts/gentle-ai-installer.mjs";
import { requireNativeBinary } from "./support/native-binary-gate.ts";

const VERSION = { stdout: `gentle-ai ${GENTLE_AI_VERSION}\n`, stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false } as const;
const RUNTIME_DIRECTORY = `v${GENTLE_AI_VERSION}`;
const repoRuntimeBinary = join(import.meta.dirname, "..", ".gentle-ai", RUNTIME_DIRECTORY, process.platform === "win32" ? "gentle-ai.exe" : "gentle-ai");
const releaseDigestsPinned = process.platform === "win32" || /^[0-9a-f]{64}$/.test(resolveGentleAiReleaseAsset(process.platform, process.arch).sha256);
// These integrity tests need the published official binary; they skip while a
// re-pinned release's archives and digest table are still pending.
const nativeBinaryGate = requireNativeBinary({
	resolvedBinary: existsSync(repoRuntimeBinary) ? repoRuntimeBinary : undefined,
	digestsPinned: releaseDigestsPinned,
	env: process.env,
});
if (!nativeBinaryGate.run) console.log(`gentle-ai-binary: ${nativeBinaryGate.reason}`);
const verifiedBinaryTest = nativeBinaryGate.run && process.platform !== "win32" ? test : test.skip;

interface PinnedBinaryIsolation {
	environment: GentleAiDevBinaryEnvironment;
	savedEnvironmentValue: string | undefined;
	savedRegistration: string | undefined;
}

let pinnedBinaryIsolation: PinnedBinaryIsolation | undefined;

test.beforeEach((t) => {
	const home = mkdtempSync(join(tmpdir(), "gentle-pi-pinned-binary-home-"));
	const environment: GentleAiDevBinaryEnvironment = { env: { ...process.env }, home };
	delete environment.env.GENTLE_PI_CONFIG_HOME;
	const savedEnvironmentValue = environment.env[GENTLE_AI_DEV_BINARY_ENV];
	const registrationPath = gentleAiDevBinaryRegistrationPath(environment);
	const savedRegistration = existsSync(registrationPath)
		? readFileSync(registrationPath, "utf8")
		: undefined;

	delete environment.env[GENTLE_AI_DEV_BINARY_ENV];
	unregisterGentleAiDevBinary(environment);
	setGentleAiDevBinaryEnvironmentForTesting(environment);
	pinnedBinaryIsolation = { environment, savedEnvironmentValue, savedRegistration };

	t.after(() => {
		if (savedEnvironmentValue === undefined) {
			delete environment.env[GENTLE_AI_DEV_BINARY_ENV];
		} else {
			environment.env[GENTLE_AI_DEV_BINARY_ENV] = savedEnvironmentValue;
		}
		if (savedRegistration === undefined) {
			unregisterGentleAiDevBinary(environment);
		} else {
			mkdirSync(dirname(registrationPath), { recursive: true });
			writeFileSync(registrationPath, savedRegistration);
		}
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
		pinnedBinaryIsolation = undefined;
		rmSync(home, { recursive: true, force: true });
	});
});

async function writeVerifiedBinary(packageRoot: string, platform = process.platform): Promise<string> {
	const asset = resolveGentleAiReleaseAsset(platform, process.arch);
	const binaryPath = join(packageRoot, ".gentle-ai", RUNTIME_DIRECTORY, asset.executable);
	await mkdir(join(packageRoot, ".gentle-ai", RUNTIME_DIRECTORY), { recursive: true });
	await writeFile(binaryPath, readFileSync(join(import.meta.dirname, "..", ".gentle-ai", RUNTIME_DIRECTORY, asset.executable)));
	if (platform !== "win32") await chmod(binaryPath, 0o700);
	await writeFile(join(packageRoot, ".gentle-ai", RUNTIME_DIRECTORY, "integrity.json"), `${JSON.stringify({ version: GENTLE_AI_VERSION, asset: asset.name, assetSha256: asset.sha256, binarySha256: asset.binarySha256 })}\n`);
	return binaryPath;
}

async function writeWindowsSourceBinary(packageRoot: string): Promise<{ binaryPath: string; manifestPath: string }> {
	const binaryPath = join(packageRoot, ".gentle-ai", RUNTIME_DIRECTORY, "gentle-ai.exe");
	const manifestPath = join(packageRoot, ".gentle-ai", RUNTIME_DIRECTORY, "integrity.json");
	const binary = "verified Windows source build";
	await mkdir(join(packageRoot, ".gentle-ai", RUNTIME_DIRECTORY), { recursive: true });
	await writeFile(binaryPath, binary);
	await writeFile(manifestPath, `${JSON.stringify({
		version: GENTLE_AI_VERSION,
		method: "go-sumdb-source-build",
		package: "github.com/gentleman-programming/gentle-ai/v3/cmd/gentle-ai",
		module: "github.com/gentleman-programming/gentle-ai/v3",
		tag: "v3.0.1",
		architecture: process.arch === "x64" ? "x64" : "arm64",
		binarySha256: createHash("sha256").update(binary).digest("hex"),
		moduleChecksum: GENTLE_AI_WINDOWS_SOURCE_MODULE_CHECKSUM,
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
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-binary-"));
	const executable = process.platform === "win32" ? "gentle-ai.exe" : "gentle-ai";
	const binaryPath = await writeVerifiedBinary(packageRoot);
	const devBinary = join(packageRoot, "maintainer-dev-binary");
	await writeFile(devBinary, "maintainer dev binary");
	if (process.platform !== "win32") await chmod(devBinary, 0o700);
	const isolation = pinnedBinaryIsolation;
	assert.ok(isolation, "the pinned-binary fixture must install its isolated environment");

	const ambientValue = process.env[GENTLE_AI_DEV_BINARY_ENV];
	process.env[GENTLE_AI_DEV_BINARY_ENV] = devBinary;
	try {
		assert.equal(resolveGentleAiBinary(packageRoot, process.platform), binaryPath, "a maintainer's ambient override must not contaminate a pinned-package case");
	} finally {
		if (ambientValue === undefined) delete process.env[GENTLE_AI_DEV_BINARY_ENV];
		else process.env[GENTLE_AI_DEV_BINARY_ENV] = ambientValue;
	}

	isolation.environment.env[GENTLE_AI_DEV_BINARY_ENV] = devBinary;
	assert.equal(resolveGentleAiBinary(packageRoot, process.platform), devBinary, "an explicit dev-binary test may opt in through the isolated environment seam");
	delete isolation.environment.env[GENTLE_AI_DEV_BINARY_ENV];
	registerGentleAiDevBinary(devBinary, isolation.environment);
	assert.equal(resolveGentleAiBinary(packageRoot, process.platform), devBinary, "an explicit persistent dev registration may opt in through the isolated environment seam");
	assert.equal(unregisterGentleAiDevBinary(isolation.environment), true);

	const resolved = resolveGentleAiBinary(packageRoot, process.platform);
	assert.equal(resolved, binaryPath, "clearing the explicit registration restores the pinned resolver");
	assert.equal(isAbsolute(resolved), true);
	assert.equal(basename(resolved), executable);
	assert.doesNotMatch(resolved, /(^|[/\\])PATH($|[/\\])/i);
});

test("runtime validates a Windows Go SumDB source manifest and rejects tampering, symlinks, and PATH injection", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-windows-source-runtime-"));
	const { binaryPath, manifestPath } = await writeWindowsSourceBinary(packageRoot);
	assert.equal(resolveGentleAiBinary(packageRoot, "win32"), binaryPath);

	const valid = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, string>;
	for (const manifest of [
		{ ...valid, method: "signed-release-asset" },
		{ ...valid, module: "example.invalid/gentle-ai" },
		{ ...valid, tag: "v2.2.1" },
		{ ...valid, binarySha256: "0".repeat(64) },
		{ ...valid, moduleChecksum: "h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
		{ ...valid, goVersion: "go1.25.9" },
		{ ...valid, goVersion: "go1.25" },
	]) {
		await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
		assert.throws(() => resolveGentleAiBinary(packageRoot, "win32"), /package-local-binary-missing/);
	}
	await writeFile(manifestPath, `${JSON.stringify(valid)}\n`);
	await writeFile(binaryPath, "tampered Windows source build");
	assert.throws(() => resolveGentleAiBinary(packageRoot, "win32"), /package-local-binary-missing/);
	await writeFile(binaryPath, "verified Windows source build");
	await rm(binaryPath);
	const ambient = join(packageRoot, "ambient-gentle-ai.exe");
	await writeFile(ambient, "ambient executable");
	await symlink(ambient, binaryPath);
	assert.throws(() => resolveGentleAiBinary(packageRoot, "win32"), /package-local-binary-missing/);
	assert.doesNotMatch(gentleAiBinaryPathForTest(packageRoot), /(^|[/\\])PATH($|[/\\])/i);
});

function gentleAiBinaryPathForTest(packageRoot: string): string {
	return join(packageRoot, ".gentle-ai", RUNTIME_DIRECTORY, "gentle-ai.exe");
}

test("runtime rejects an unverified binary, a symlinked manifest, and ambient executable injection", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-binary-integrity-"));
	const executable = process.platform === "win32" ? "gentle-ai.exe" : "gentle-ai";
	const binaryPath = join(packageRoot, ".gentle-ai", RUNTIME_DIRECTORY, executable);
	const manifestPath = join(packageRoot, ".gentle-ai", RUNTIME_DIRECTORY, "integrity.json");
	await mkdir(join(packageRoot, ".gentle-ai", RUNTIME_DIRECTORY), { recursive: true });
	await writeFile(binaryPath, "native");

	assert.throws(() => resolveGentleAiBinary(packageRoot, process.platform), /package-local-binary-missing/);
	const binarySha256 = createHash("sha256").update("native").digest("hex");
	const manifestTarget = join(packageRoot, "manifest-target.json");
	await writeFile(manifestTarget, `${JSON.stringify({ version: GENTLE_AI_VERSION, asset: `gentle-ai_${GENTLE_AI_VERSION}_${process.platform}_${process.arch === "x64" ? "amd64" : process.arch}.tar.gz`, assetSha256: "a".repeat(64), binarySha256 })}\n`);
	await symlink(manifestTarget, manifestPath);
	assert.throws(() => resolveGentleAiBinary(packageRoot, process.platform), /package-local-binary-missing/);
	assert.throws(() => new NativeReviewCliV216(async () => VERSION, "gentle-ai"), /absolute package-local executable/);
});

verifiedBinaryTest("runtime rejects malformed, unknown, wrong, and symlinked integrity paths", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-binary-manifest-"));
	const binaryPath = await writeVerifiedBinary(packageRoot);
	const manifestPath = join(packageRoot, ".gentle-ai", RUNTIME_DIRECTORY, "integrity.json");
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
		assert.throws(() => resolveGentleAiBinary(packageRoot, process.platform), /package-local-binary-missing/);
	}
	await writeFile(manifestPath, JSON.stringify(valid));
	const binaryTarget = join(packageRoot, "binary-target");
	await writeFile(binaryTarget, "native");
	await rm(binaryPath);
	await symlink(binaryTarget, binaryPath);
	assert.throws(() => resolveGentleAiBinary(packageRoot, process.platform), /package-local-binary-missing/);

	const directoryRoot = await mkdtemp(join(tmpdir(), "gentle-pi-binary-directory-"));
	await symlink(join(packageRoot, ".gentle-ai"), join(directoryRoot, ".gentle-ai"));
	assert.throws(() => resolveGentleAiBinary(directoryRoot, process.platform), /package-local-binary-missing/);
});

verifiedBinaryTest("runtime rejects a binary-only tamper while its canonical pinned manifest remains unchanged", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-binary-pinned-manifest-tamper-"));
	const binaryPath = await writeVerifiedBinary(packageRoot);
	await writeFile(binaryPath, "binary-only tamper");
	if (process.platform !== "win32") await chmod(binaryPath, 0o700);
	assert.throws(() => resolveGentleAiBinary(packageRoot, process.platform), /package-local-binary-missing/);
});

verifiedBinaryTest("runtime rejects an arbitrary binary even when a forged manifest matches its digest", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-binary-forged-manifest-"));
	const binaryPath = await writeVerifiedBinary(packageRoot);
	const asset = resolveGentleAiReleaseAsset(process.platform, process.arch);
	await writeFile(binaryPath, "arbitrary binary");
	if (process.platform !== "win32") await chmod(binaryPath, 0o700);
	await writeFile(join(packageRoot, ".gentle-ai", RUNTIME_DIRECTORY, "integrity.json"), JSON.stringify({ version: GENTLE_AI_VERSION, asset: asset.name, assetSha256: asset.sha256, binarySha256: createHash("sha256").update("arbitrary binary").digest("hex") }));
	assert.throws(() => resolveGentleAiBinary(packageRoot, process.platform), /package-local-binary-missing/);
});

verifiedBinaryTest("runtime rejects binary replacement during verification", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-binary-replacement-"));
	const binaryPath = await writeVerifiedBinary(packageRoot);
	assert.throws(
		() => resolveGentleAiBinary(packageRoot, process.platform, (path) => {
			writeFileSync(path, "replaced");
			return readFileSync(path);
		}),
		/package-local-binary-missing/,
	);
	assert.equal(readFileSync(binaryPath, "utf8"), "replaced");
});

test("runtime fails closed when the package-local binary is missing", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-binary-missing-"));
	assert.throws(
		() => resolveGentleAiBinary(packageRoot, "linux"),
		(error: unknown) => error instanceof PackageLocalGentleAiBinaryMissingError
			&& error.code === GENTLE_AI_BINARY_MISSING_CODE
			&& error.message.includes("package-local-binary-missing")
			&& error.message.includes("If GENTLE_PI_SKIP_GENTLE_AI_INSTALL is set, remove or unset it before")
			&& error.message.includes("installed gentle-pi package directory")
			&& error.message.includes("GENTLE_PI_SKIP_GENTLE_AI_INSTALL")
			&& error.message.includes("remove or unset it before")
			&& error.message.includes("does not prove install lifecycle scripts were disabled"),
	);
});

verifiedBinaryTest("runtime rejects a valid but non-executable POSIX binary", async (t) => {
	if (process.platform === "win32") {
		t.skip("Windows does not use POSIX executable mode bits");
		return;
	}
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-binary-non-executable-"));
	const binaryPath = await writeVerifiedBinary(packageRoot);
	await chmod(binaryPath, 0o600);
	assert.throws(() => resolveGentleAiBinary(packageRoot, process.platform), /package-local-binary-missing/);
});

test("production native operations report the package-local missing binary code", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-native-missing-"));
	const adapter: ExecFileAdapter = async () => {
		throw new Error("the adapter must not be reached when the package binary is missing");
	};
	await assert.rejects(
		() => createNativeReviewCli(adapter, () => resolveGentleAiBinary(packageRoot, "linux")).start({ cwd: packageRoot }),
		(error: unknown) => error instanceof Error && "code" in error && error.code === GENTLE_AI_BINARY_MISSING_CODE,
	);
});

verifiedBinaryTest("production native client never invokes a global gentle-ai executable", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-native-"));
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
		() => createNativeReviewCli(adapter, () => resolveGentleAiBinary(packageRoot, process.platform)).targetStatus!({ cwd: packageRoot, lineageId: "review-status-fixture" }),
		/schema incompatible/,
	);
	assert.deepEqual(calls, [binaryPath]);
	assert.ok(calls.every((file) => file !== "gentle-ai"));
	assert.throws(() => new NativeReviewCliV216(adapter, "gentle-ai"), /absolute package-local executable/);
	assert.throws(() => new NativeReviewCliV216(adapter, "./gentle-ai"), /absolute package-local executable/);
});
