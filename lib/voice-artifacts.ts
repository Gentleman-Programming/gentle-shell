// Pinned artifacts for the optional local voice dictation (S1-S3). Nothing here is
// fetched or resolved at runtime: every version, size and digest below was read
// from the public npm registry and Hugging Face metadata for the exact versions,
// and the tarball layouts were inspected for the facts the comments state.
// Installation lives in voice-install.ts; this module is data only.

export type VoiceTarget = "darwin-x64" | "darwin-arm64" | "linux-x64" | "linux-arm64" | "win32-x64";

export const VOICE_TARGETS: readonly VoiceTarget[] = ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64", "win32-x64"];

// A redirect hop is followed only when its URL is HTTPS on this origin and its
// path starts with the prefix. Anything else ends the download.
export interface VoiceRedirectRule {
	origin: string;
	pathPrefix: string;
}

export interface VoiceNpmPackage {
	name: string;
	version: string;
	license: string;
	tarball: string;
	// The packed tarball size in bytes and its registry `dist.integrity`.
	size: number;
	integrity: string;
	// Registry `dist.unpackedSize` and `dist.fileCount`: hard limits for extraction.
	unpackedSize: number;
	fileCount: number;
	// Paths relative to the package root that must be present after extraction.
	requiredFiles: string[];
}

export interface VoiceRuntimeManifest {
	// The installed directory name; also part of the install marker.
	id: string;
	target: VoiceTarget;
	packages: VoiceNpmPackage[];
	redirects: VoiceRedirectRule[];
}

export interface VoiceModelFile {
	name: string;
	size: number;
	sha256: string;
}

export interface VoiceModelManifest {
	id: string;
	revision: string;
	// Files are fetched from `${baseUrl}/${name}`.
	baseUrl: string;
	files: VoiceModelFile[];
	redirects: VoiceRedirectRule[];
}

const SHERPA_VERSION = "1.13.8";

const npmTarball = (name: string, version: string) => `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;

// sherpa-onnx-node holds only JavaScript. Its addon-static-import.js loads
// `../sherpa-onnx-<platform>-<arch>/sherpa-onnx.node` (Windows spelled `win`), so the
// platform package must be installed as a sibling directory under node_modules.
export const SHERPA_ONNX_NODE: VoiceNpmPackage = {
	name: "sherpa-onnx-node",
	version: SHERPA_VERSION,
	license: "Apache-2.0",
	tarball: npmTarball("sherpa-onnx-node", SHERPA_VERSION),
	size: 11954,
	integrity: "sha512-MsDMBdhLFTZ1GwvcGSSQhnS7g/EA8OMH6IYysCVUOM7j8Icty9KRc0E6YT1A5fWBsZwRfKOeh88QC95aRvS8ag==",
	unpackedSize: 61221,
	fileCount: 19,
	requiredFiles: ["package.json", "sherpa-onnx.js", "addon.js", "addon-static-import.js", "non-streaming-asr.js"],
};

function sherpaPlatform(target: VoiceTarget, size: number, integrity: string, unpackedSize: number, fileCount: number): VoiceNpmPackage {
	const name = `sherpa-onnx-${target.replace(/^win32-/, "win-")}`;
	return {
		name,
		version: SHERPA_VERSION,
		license: "Apache-2.0",
		tarball: npmTarball(name, SHERPA_VERSION),
		size,
		integrity,
		unpackedSize,
		fileCount,
		requiredFiles: ["package.json", "sherpa-onnx.node"],
	};
}

// Each platform package bundles sherpa-onnx.node, the sherpa-onnx C/C++ API
// libraries and onnxruntime, all built for the named architecture.
export const SHERPA_ONNX_PLATFORM_PACKAGES: Readonly<Record<VoiceTarget, VoiceNpmPackage>> = {
	"darwin-x64": sherpaPlatform("darwin-x64", 11191481, "sha512-7BLRpjM6w4f9W46/nmkmq8lEKUayhebvcpslCVQ+6QN2uReYlZEMDZlSpXMjme+hUFrPfRz8P3UNq8ep/4d19g==", 37678686, 7),
	"darwin-arm64": sherpaPlatform("darwin-arm64", 10047754, "sha512-FPNgJMgnWVl/KhRTIhG3KL3A4Om63Rn4YKXc9/uHY7SzLcvqLJLc/h7UBWJwduXvv7K18t5NpxHR6XgXn4sjWw==", 34089738, 7),
	"linux-x64": sherpaPlatform("linux-x64", 11089653, "sha512-6plnhjagsSeTntCgnlag86hWbs/uZE9Crms1LgOb68/1nKsIQjMd+WG519m+aPwT6TrsBOiEMzrx41t8sL5L5g==", 33381117, 7),
	"linux-arm64": sherpaPlatform("linux-arm64", 13910679, "sha512-Tlg7a70b/Wge3OF8IgTHF9jhSVCsLyKQKhwc4BsJ5A+dL/SrFtGBjzuHp4XeLhiiOT7afCxX5PdSn/D4c8Lnuw==", 40306856, 7),
	"win32-x64": sherpaPlatform("win32-x64", 8894875, "sha512-oZF1c9VPOKtMwn83Bboc5XSWL+76BRoyB3eUuVnCknBKxwSULZU2Foia9VHWzU+n4I12rPsP6z6H9Rp1hD9o8g==", 23453246, 8),
};

// node-cpal has no dependencies or install scripts and needs Node >= 22. Its
// tarball ships every prebuilt binary; the default backend loads
// bin/<platform>-<arch>/index.node through facade.js. The five binary headers were
// inspected (not loaded) and each is built for its own architecture. Published
// from saeta-eth/node-cpal tag v1.0.0, commit 20e2ac8d1922de7c4af50431e2ddc21a421cf764.
// 0.1.1 is not used: its darwin-x64 and linux-arm64 binaries were built for the
// other architecture.
const NODE_CPAL_VERSION = "1.0.0";

export const NODE_CPAL: VoiceNpmPackage = {
	name: "node-cpal",
	version: NODE_CPAL_VERSION,
	license: "ISC",
	tarball: npmTarball("node-cpal", NODE_CPAL_VERSION),
	size: 7723259,
	integrity: "sha512-d71jIzKDjw1HepqaJQMPd+/k3ZLqYZWhLAv6a8aafIGnYoA1QWlShA5iB5CgijIJtQxq9PdQAk99JQKspqlnTA==",
	unpackedSize: 20363834,
	fileCount: 40,
	requiredFiles: ["package.json", "index.js", "facade.js", "cpal-values.js"],
};

// The oldest glibc the pinned Linux native binaries accept.
export const VOICE_LINUX_MIN_GLIBC = "2.34";

export function voiceRuntimeManifest(target: VoiceTarget): VoiceRuntimeManifest {
	const packages = [
		SHERPA_ONNX_NODE,
		SHERPA_ONNX_PLATFORM_PACKAGES[target],
		{ ...NODE_CPAL, requiredFiles: [...NODE_CPAL.requiredFiles, `bin/${target}/index.node`] },
	];
	// The id names both native versions, so a runtime installed with other pins
	// lives in another directory and is never reported as this one.
	// npm serves these tarballs directly; no redirect is expected or followed.
	return { id: `sherpa-onnx-${SHERPA_VERSION}-node-cpal-${NODE_CPAL_VERSION}-${target}`, target, packages, redirects: [] };
}

const PARAKEET_REPO = "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
const PARAKEET_REVISION = "2bda32ec70b097a55adaa07d9a7173915b43cc78";

// The int8 sherpa-onnx export of NVIDIA Parakeet TDT 0.6B v3 at a fixed commit.
// Observed redirects: tokens.txt answers 307 with a same-origin resolve-cache path,
// the LFS/Xet files answer 302 to us.aws.cdn.hf.co/xet-bridge-us/. Other CDN
// regions were not observed, so they are refused rather than guessed.
export const PARAKEET_MODEL_MANIFEST: VoiceModelManifest = {
	id: `parakeet-tdt-0.6b-v3-int8-${PARAKEET_REVISION.slice(0, 12)}`,
	revision: PARAKEET_REVISION,
	baseUrl: `https://huggingface.co/${PARAKEET_REPO}/resolve/${PARAKEET_REVISION}`,
	files: [
		{ name: "encoder.int8.onnx", size: 652184281, sha256: "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247" },
		{ name: "decoder.int8.onnx", size: 11845275, sha256: "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e" },
		{ name: "joiner.int8.onnx", size: 6355277, sha256: "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3" },
		{ name: "tokens.txt", size: 93939, sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d" },
	],
	redirects: [
		{ origin: "https://huggingface.co", pathPrefix: `/api/resolve-cache/models/${PARAKEET_REPO}/${PARAKEET_REVISION}/` },
		{ origin: "https://us.aws.cdn.hf.co", pathPrefix: "/xet-bridge-us/" },
	],
};

export interface VoiceNotice {
	component: string;
	license: string;
	source: string;
	attribution?: string;
	// What is known to be missing from the distributed artifact, stated plainly.
	unresolved?: string;
}

export const VOICE_NOTICES: readonly VoiceNotice[] = [
	{
		component: "parakeet-tdt-0.6b-v3",
		license: "CC-BY-4.0",
		source: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3",
		attribution: "Parakeet TDT 0.6B v3 by NVIDIA, licensed under CC-BY-4.0; int8 sherpa-onnx export by csukuangfj.",
		unresolved: `The ${PARAKEET_REPO} export has no license file or model card license of its own; the license is taken from the upstream NVIDIA model.`,
	},
	{
		component: "sherpa-onnx-node",
		license: "Apache-2.0",
		source: "https://github.com/k2-fsa/sherpa-onnx",
		unresolved: "The sherpa-onnx npm tarballs ship no LICENSE or NOTICE file, and the platform packages bundle onnxruntime (MIT) without its license text.",
	},
	{
		component: "node-cpal",
		license: "ISC",
		source: "https://github.com/saeta-eth/node-cpal",
		unresolved: "The node-cpal@1.0.0 tarball ships no LICENSE or NOTICE file, and its prebuilt binaries link Rust crates whose notices are not included.",
	},
];
