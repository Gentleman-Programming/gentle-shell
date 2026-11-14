import assert from "node:assert/strict";
import test from "node:test";
import { artifactFor, engramPinVersion, uvPinVersion } from "../scripts/installer-downloads.mjs";

// The Engram core the bundled install ships (S9), from its checksums.txt and
// the published asset digests; every archive was downloaded and re-hashed.
const engramPins = {
	"darwin-arm64": ["darwin_arm64.tar.gz", "f96e08db8f47ca49ebc034eba30e468db81eb56df98f9bf21a73366b510695e4", 8001813],
	"darwin-x64": ["darwin_amd64.tar.gz", "d35623443a5d85e8f78338cda5d0bb73b2f7ec6217a57e4abb71904a3e0d6287", 8488340],
	"linux-x64": ["linux_amd64.tar.gz", "8db9d5db1c1574b8b830aac4ffbe86c024014aed6b9a3f0406ac3361a152cdf0", 8365851],
	"linux-arm64": ["linux_arm64.tar.gz", "cdbbcb68d3e842d3e52e27edccef55e6fe98ce3cdbc90cd79894323b029efb50", 7712574],
	"win32-x64": ["windows_amd64.zip", "515a716ce966202058d4b9f310626fde72583cfc64ccefbf0dcc81456260089c", 8582764],
	"win32-arm64": ["windows_arm64.zip", "01e4f5dab2f941cf810d1373e7c6998c014499bee9c2d5783e34da94c70ac7f2", 7780232],
} as const;

test("fixed Engram descriptors are the published 3.7.2 core archives and checksums, and nothing else", () => {
	assert.equal(engramPinVersion, "3.7.2");
	for (const [target, [suffix, sha256, size]] of Object.entries(engramPins)) {
		const [platform, arch] = target.split("-");
		const artifact = artifactFor("engram", platform, arch);
		assert.equal(artifact.name, "engram");
		assert.equal(artifact.version, "3.7.2");
		assert.equal(artifact.url, `https://github.com/Gentleman-Programming/engram/releases/download/v3.7.2/engram_3.7.2_${suffix}`);
		assert.equal(artifact.integrity, `sha256-${sha256}`);
		assert.deepEqual([artifact.size, artifact.maxBytes], [size, size]);
		assert.deepEqual(artifact.redirectHosts, ["objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
		assert.ok(Object.isFrozen(artifact));
	}
	for (const [platform, arch] of [["linux", "ia32"], ["freebsd", "x64"], ["win32", "ia32"], ["darwin", "ppc64"]]) {
		assert.throws(() => artifactFor("engram", platform, arch), /Unsupported/);
	}
});

// The uv the /gentle:music offer installs inside a bundled prefix (S5): the
// astral-sh/uv release archives, each re-hashed after download before pinning.
const uvPins = {
	"darwin-arm64": ["uv-aarch64-apple-darwin.tar.gz", "60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472", 14235670],
	"darwin-x64": ["uv-x86_64-apple-darwin.tar.gz", "63ba17fdda55ad1a230d4b37fc6017ffa10c23688c83818bd3bfdf914c652a02", 17004934],
	"linux-x64": ["uv-x86_64-unknown-linux-gnu.tar.gz", "f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645", 16799024],
	"linux-arm64": ["uv-aarch64-unknown-linux-gnu.tar.gz", "229e194255c7958d86d56e8790d969a6f74736592133f0dfd0076f754c642c1d", 15794886],
	"win32-x64": ["uv-x86_64-pc-windows-msvc.zip", "a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f", 15239500],
	"win32-arm64": ["uv-aarch64-pc-windows-msvc.zip", "c2426c0c8e28b53d8c440e47a18d96ad4db51e159866c0e81435b196d7f0081c", 15439263],
} as const;

test("fixed uv descriptors are the astral-sh/uv release archives and checksums, and nothing else", () => {
	assert.equal(uvPinVersion, "0.13.6");
	for (const [target, [asset, sha256, size]] of Object.entries(uvPins)) {
		const [platform, arch] = target.split("-");
		const artifact = artifactFor("uv", platform, arch);
		assert.equal(artifact.name, "uv");
		assert.equal(artifact.version, "0.13.6");
		assert.equal(artifact.url, `https://github.com/astral-sh/uv/releases/download/0.13.6/${asset}`);
		assert.equal(artifact.integrity, `sha256-${sha256}`);
		assert.deepEqual([artifact.size, artifact.maxBytes], [size, size]);
		assert.deepEqual(artifact.redirectHosts, ["objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
		assert.ok(Object.isFrozen(artifact));
	}
	for (const [platform, arch] of [["linux", "ia32"], ["freebsd", "x64"], ["win32", "ia32"], ["darwin", "ppc64"]]) {
		assert.throws(() => artifactFor("uv", platform, arch), /Unsupported/);
	}
});
