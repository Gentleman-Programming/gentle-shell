import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import {
	NODE_CPAL,
	PARAKEET_MODEL_MANIFEST,
	SHERPA_ONNX_NODE,
	VOICE_NOTICES,
	VOICE_TARGETS,
	voiceRuntimeManifest,
} from "../lib/voice-artifacts.ts";
import { diagnoseVoicePlatform, readVoicePlatformProbe } from "../lib/voice-platform.ts";

// Optional voice (S1-S3): the platform diagnosis decides what /gentle:voice may offer.
// It must name the five researched targets without ever claiming hardware-verified
// support, and refuse the unproven ones with a reason instead of a broken install.

const glibc = "2.35";

test("the five researched targets resolve to a runtime target that is never reported as hardware verified", () => {
	const probes = [
		{ platform: "darwin", arch: "x64", target: "darwin-x64" },
		{ platform: "darwin", arch: "arm64", target: "darwin-arm64" },
		{ platform: "linux", arch: "x64", glibcVersion: glibc, target: "linux-x64" },
		{ platform: "linux", arch: "arm64", glibcVersion: glibc, target: "linux-arm64" },
		{ platform: "win32", arch: "x64", target: "win32-x64" },
	];
	assert.deepEqual(probes.map((p) => p.target), [...VOICE_TARGETS]);
	for (const { target, ...probe } of probes) {
		const diagnosis = diagnoseVoicePlatform(probe);
		assert.equal(diagnosis.support, "known", target);
		assert.equal(diagnosis.target, target);
		assert.equal(diagnosis.transcription.available, true, target);
		assert.equal(diagnosis.hardwareVerified, false, target);
		assert.ok(diagnosis.limitations.some((line) => /not been verified on hardware/.test(line)), target);
	}
});

test("Windows ARM64, musl Linux and other platforms are unsupported with a stated reason", () => {
	const cases = [
		{ probe: { platform: "win32", arch: "arm64" }, reason: /Windows ARM64/ },
		{ probe: { platform: "linux", arch: "x64" }, reason: /glibc/ },
		{ probe: { platform: "linux", arch: "ia32", glibcVersion: glibc }, reason: /linux-ia32/ },
		{ probe: { platform: "freebsd", arch: "x64" }, reason: /freebsd-x64/ },
	];
	for (const { probe, reason } of cases) {
		const diagnosis = diagnoseVoicePlatform(probe);
		assert.equal(diagnosis.support, "unsupported", probe.platform + probe.arch);
		assert.equal(diagnosis.target, undefined);
		assert.equal(diagnosis.transcription.available, false);
		assert.equal(diagnosis.microphone.available, false);
		assert.match(diagnosis.transcription.reason ?? "", reason);
	}
});

test("WSL keeps its Linux target but is reported as unproven rather than supported", () => {
	const diagnosis = diagnoseVoicePlatform({ platform: "linux", arch: "x64", glibcVersion: glibc, wsl: true });
	assert.equal(diagnosis.support, "unproven");
	assert.equal(diagnosis.target, "linux-x64");
	assert.ok(diagnosis.limitations.some((line) => /WSL/.test(line)));
});

test("every known target ships the pinned node-cpal capture binary for its own architecture", () => {
	for (const target of VOICE_TARGETS) {
		const [platform, arch] = target.split("-");
		const diagnosis = diagnoseVoicePlatform({ platform: platform!, arch: arch!, glibcVersion: glibc });
		assert.equal(diagnosis.microphone.available, true, target);
		const manifest = voiceRuntimeManifest(target);
		const capture = manifest.packages.find((p) => p.name === NODE_CPAL.name);
		assert.equal(capture?.version, "1.0.0", target);
		assert.ok(capture!.requiredFiles.includes(`bin/${target}/index.node`), target);
		// The capture version is part of the runtime identity, so a runtime
		// installed with an older node-cpal is never mistaken for this one.
		assert.match(manifest.id, /node-cpal-1\.0\.0/, target);
	}
});

test("native prerequisites that are not probed are stated as limitations", () => {
	const linux = diagnoseVoicePlatform({ platform: "linux", arch: "x64", glibcVersion: glibc });
	assert.ok(linux.limitations.some((line) => /libasound\.so\.2/.test(line)));
	const windows = diagnoseVoicePlatform({ platform: "win32", arch: "x64" });
	assert.ok(windows.limitations.some((line) => /vcruntime140\.dll/.test(line) && /not checked/.test(line)));
});

test("Linux with a glibc older than 2.34 is unsupported with the version it needs", () => {
	for (const glibcVersion of ["2.31", "2.33", "1.99"]) {
		const diagnosis = diagnoseVoicePlatform({ platform: "linux", arch: "x64", glibcVersion });
		assert.equal(diagnosis.support, "unsupported", glibcVersion);
		assert.equal(diagnosis.microphone.available, false);
		assert.match(diagnosis.transcription.reason ?? "", new RegExp(`glibc 2\\.34.*${glibcVersion.replace(".", "\\.")}`));
	}
	for (const glibcVersion of ["2.34", "2.39", "3.0"]) {
		assert.equal(diagnoseVoicePlatform({ platform: "linux", arch: "arm64", glibcVersion }).support, "known", glibcVersion);
	}
});

test("the pinned manifest uses exact versions, sibling platform packages and the fixed model revision", () => {
	for (const target of VOICE_TARGETS) {
		const manifest = voiceRuntimeManifest(target);
		const names = manifest.packages.map((p) => p.name);
		const platformName = `sherpa-onnx-${target.replace(/^win32-/, "win-")}`;
		assert.deepEqual(names.slice(0, 2), [SHERPA_ONNX_NODE.name, platformName], target);
		for (const pkg of manifest.packages) {
			assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
			assert.match(pkg.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
			assert.equal(pkg.tarball, `https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`);
			assert.ok(pkg.size > 0 && pkg.unpackedSize > 0 && pkg.fileCount > 0);
		}
		assert.equal(manifest.packages[1]!.version, "1.13.8");
	}
	assert.equal(SHERPA_ONNX_NODE.version, "1.13.8");
	assert.equal(NODE_CPAL.version, "1.0.0");
	assert.equal(NODE_CPAL.integrity, "sha512-d71jIzKDjw1HepqaJQMPd+/k3ZLqYZWhLAv6a8aafIGnYoA1QWlShA5iB5CgijIJtQxq9PdQAk99JQKspqlnTA==");
	assert.deepEqual([NODE_CPAL.size, NODE_CPAL.unpackedSize, NODE_CPAL.fileCount], [7723259, 20363834, 40]);
	assert.equal(PARAKEET_MODEL_MANIFEST.revision, "2bda32ec70b097a55adaa07d9a7173915b43cc78");
	assert.deepEqual(
		PARAKEET_MODEL_MANIFEST.files.map((f) => [f.name, f.size, f.sha256]),
		[
			["encoder.int8.onnx", 652184281, "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247"],
			["decoder.int8.onnx", 11845275, "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e"],
			["joiner.int8.onnx", 6355277, "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3"],
			["tokens.txt", 93939, "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d"],
		],
	);
});

test("the notices attribute the model, runtime and capture licenses and flag what is unresolved", () => {
	const byComponent = new Map(VOICE_NOTICES.map((n) => [n.component, n]));
	assert.equal(byComponent.get("parakeet-tdt-0.6b-v3")?.license, "CC-BY-4.0");
	assert.match(byComponent.get("parakeet-tdt-0.6b-v3")?.attribution ?? "", /NVIDIA/);
	assert.equal(byComponent.get("sherpa-onnx-node")?.license, "Apache-2.0");
	assert.equal(byComponent.get("node-cpal")?.license, "ISC");
	assert.ok(VOICE_NOTICES.some((n) => n.unresolved !== undefined));
});

test("readVoicePlatformProbe reports the running platform only when called", () => {
	const probe = readVoicePlatformProbe();
	assert.equal(probe.platform, process.platform);
	assert.equal(probe.arch, process.arch);
});

test("importing the voice modules performs no filesystem or network IO", async (t) => {
	// The module loader reads the sources through fs itself, so only calls made
	// from a repository lib/ frame count as import-time IO.
	const libFrame = new URL("../lib/", import.meta.url).href;
	const calls: string[] = [];
	const restore: Array<() => void> = [];
	const trap = (target: Record<string, unknown>, label: string) => {
		for (const key of Object.keys(target)) {
			const original = target[key];
			if (typeof original !== "function" || /^[A-Z]/.test(key)) continue;
			target[key] = (...args: unknown[]) => {
				if (new Error().stack?.includes(libFrame)) calls.push(`${label}.${key}`);
				return (original as (...a: unknown[]) => unknown)(...args);
			};
			restore.push(() => { target[key] = original; });
		}
	};
	trap(fs as unknown as Record<string, unknown>, "fs");
	trap(fsPromises as unknown as Record<string, unknown>, "fs/promises");
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => { calls.push("fetch"); throw new Error("no network"); }) as typeof fetch;
	syncBuiltinESMExports();
	t.after(() => {
		for (const undo of restore) undo();
		globalThis.fetch = originalFetch;
		syncBuiltinESMExports();
	});
	const fresh = `?import-io-${process.pid}-${Date.now()}`;
	await import(`../lib/voice-artifacts.ts${fresh}`);
	await import(`../lib/voice-platform.ts${fresh}`);
	await import(`../lib/voice-install.ts${fresh}`);
	assert.deepEqual(calls, []);
});
