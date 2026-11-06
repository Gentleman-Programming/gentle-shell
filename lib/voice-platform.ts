import { release } from "node:os";
import { VOICE_LINUX_MIN_GLIBC, VOICE_TARGETS, type VoiceTarget } from "./voice-artifacts.ts";

// Which of the researched voice targets (S3) this machine is, and what that does
// and does not promise. The diagnosis is pure over an injected probe; it never
// loads a native module or opens a device, so "available" means only that a
// pinned binary for this architecture exists, not that it was proven to run.

export interface VoicePlatformProbe {
	platform: string;
	arch: string;
	// The glibc runtime version on Linux; undefined there means musl or unknown.
	glibcVersion?: string;
	wsl?: boolean;
}

export interface VoiceCapability {
	available: boolean;
	reason?: string;
}

export interface VoicePlatformDiagnosis {
	// known: one of the five researched targets. unproven: it maps to one, but the
	// environment (WSL) was never researched. unsupported: no pinned runtime fits.
	support: "known" | "unproven" | "unsupported";
	target?: VoiceTarget;
	transcription: VoiceCapability;
	microphone: VoiceCapability;
	limitations: string[];
	// No target has been exercised on real hardware yet; T4 owns that proof.
	hardwareVerified: false;
}

// Reads the running process only when called, never at import.
export function readVoicePlatformProbe(): VoicePlatformProbe {
	const probe: VoicePlatformProbe = { platform: process.platform, arch: process.arch };
	if (process.platform === "linux") {
		const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
		probe.glibcVersion = header?.glibcVersionRuntime;
		probe.wsl = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) || /microsoft/i.test(release());
	}
	return probe;
}

const NOT_VERIFIED = "Native loading and microphone capture have not been verified on hardware for this target.";

// Prerequisites read from the pinned binaries' headers and metadata. None of them
// is probed before loading, so they are stated rather than promised.
const PREREQUISITES: Partial<Record<string, string[]>> = {
	darwin: ["The native binaries target macOS 11 or newer on arm64 and macOS 10.12 or newer on x64; the macOS version is not checked."],
	linux: ["Microphone capture needs the ALSA library libasound.so.2, which is not checked before loading."],
	win32: ["The native binaries need the Microsoft Visual C++ runtime (vcruntime140.dll), which is not checked before loading and is never downloaded by Gentle AI."],
};

// True when a dotted version is at least the minimum, compared numerically.
function atLeast(version: string, minimum: string): boolean {
	const have = version.split(".").map(Number);
	const need = minimum.split(".").map(Number);
	for (let i = 0; i < need.length; i++) {
		const part = have[i] ?? 0;
		if (!Number.isFinite(part)) return false;
		if (part !== need[i]) return part > need[i]!;
	}
	return true;
}

function unsupported(reason: string): VoicePlatformDiagnosis {
	return {
		support: "unsupported",
		transcription: { available: false, reason },
		microphone: { available: false, reason },
		limitations: [reason],
		hardwareVerified: false,
	};
}

export function diagnoseVoicePlatform(probe: VoicePlatformProbe): VoicePlatformDiagnosis {
	const name = `${probe.platform}-${probe.arch}`;
	if (probe.platform === "win32" && probe.arch === "arm64") {
		return unsupported("Windows ARM64 has no native sherpa-onnx package; running the x64 runtime under emulation is unproven.");
	}
	const target = VOICE_TARGETS.find((candidate) => candidate === name);
	if (!target) return unsupported(`Voice dictation has no pinned runtime for ${name}.`);
	if (probe.platform === "linux" && !probe.glibcVersion) {
		return unsupported("Voice dictation needs glibc Linux; musl and other C libraries have no pinned sherpa-onnx build.");
	}
	if (probe.platform === "linux" && !atLeast(probe.glibcVersion!, VOICE_LINUX_MIN_GLIBC)) {
		return unsupported(`Voice dictation needs glibc ${VOICE_LINUX_MIN_GLIBC} or newer; this system has glibc ${probe.glibcVersion}.`);
	}
	const limitations = [NOT_VERIFIED, ...(PREREQUISITES[probe.platform] ?? [])];
	// "available" means a pinned capture binary for this architecture exists.
	const microphone: VoiceCapability = { available: true };
	let support: VoicePlatformDiagnosis["support"] = "known";
	if (probe.wsl) {
		support = "unproven";
		limitations.push("WSL was not researched: native loading and microphone access there are unproven.");
	}
	return { support, target, transcription: { available: true }, microphone, limitations, hardwareVerified: false };
}
