import { spawnSync } from "node:child_process";
import os from "node:os";

export type IsolationMechanism = "linux_bwrap" | "linux_unshare" | "macos_sandbox" | "none";
export type IsolationCapabilityStatus = "supported" | "unsupported" | "disabled" | "failed";
export type IsolationPolicy = "permissive" | "strict";

export interface HostIsolationCapability {
	mechanism: IsolationMechanism;
	status: IsolationCapabilityStatus;
	platform: string;
	enforced: boolean;
	reason: string;
}

export interface IsolatedExecutionPlan {
	command: string;
	args: string[];
	capability: HostIsolationCapability;
	isolated: boolean;
}

type ProbeRunner = (cmd: string, args: string[]) => boolean;

interface ProbeOptions {
	platform?: string;
	runner?: ProbeRunner;
	forceRefresh?: boolean;
}

let cachedCapability: HostIsolationCapability | undefined;

function defaultRunner(cmd: string, args: string[]): boolean {
	const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000 });
	return r.status === 0 && r.error === undefined;
}

function cap(mechanism: IsolationMechanism, status: IsolationCapabilityStatus, platform: string, enforced: boolean, reason: string): HostIsolationCapability {
	return { mechanism, status, platform, enforced, reason };
}

function probeLinux(run: ProbeRunner, platform: string): HostIsolationCapability {
	if (run("bwrap", ["--unshare-net", "--dev", "/dev", "--proc", "/proc", "--ro-bind", "/", "/", "true"])) {
		return cap("linux_bwrap", "supported", platform, true, "bwrap with --unshare-net is available and functional");
	}
	if (run("bwrap", ["--version"])) {
		return cap("linux_bwrap", "disabled", platform, false, "bwrap binary is present but unprivileged user namespaces appear disabled (check /proc/sys/kernel/unprivileged_userns_clone)");
	}
	if (run("unshare", ["--net", "true"])) {
		return cap("linux_unshare", "supported", platform, true, "unshare --net is available and functional");
	}
	return cap("none", "unsupported", platform, false, "Neither bwrap nor unshare --net is available on this Linux host");
}

function probeMacos(run: ProbeRunner, platform: string): HostIsolationCapability {
	if (run("sandbox-exec", ["-p", "(version 1) (allow default) (deny network*)", "true"])) {
		return cap("macos_sandbox", "supported", platform, true, "sandbox-exec with network-deny profile is available and functional");
	}
	return cap("macos_sandbox", "failed", platform, false, "sandbox-exec invocation failed on this macOS host");
}

/**
 * Probes for unprivileged network isolation capability.
 * Supports DI via `platform` and `runner` options. Caches lazily; use
 * `forceRefresh: true` to bypass the cache.
 */
export function probeHostIsolation(options: ProbeOptions = {}): HostIsolationCapability {
	if (!options.forceRefresh && cachedCapability !== undefined) return cachedCapability;

	const platform = options.platform ?? os.platform();
	const run = options.runner ?? defaultRunner;
	let result: HostIsolationCapability;

	if (platform === "linux") result = probeLinux(run, platform);
	else if (platform === "darwin") result = probeMacos(run, platform);
	else if (platform === "win32") result = cap("none", "unsupported", platform, false, "Windows does not provide an unprivileged OS-level network sandbox primitive equivalent to bwrap or sandbox-exec");
	else result = cap("none", "unsupported", platform, false, `No unprivileged network isolation primitive is known for platform: ${platform}`);

	if (!options.forceRefresh) cachedCapability = result;
	return result;
}

/** Clears the lazy probe cache. Exposed for testing only. */
export function clearIsolationCache(): void { cachedCapability = undefined; }

interface BuildPlanOptions {
	policy?: IsolationPolicy;
	capability?: HostIsolationCapability;
	cwd?: string;
}

/**
 * Wraps `command`/`args` with the detected isolation mechanism.
 * With `policy: "permissive"` (default), falls through organically if isolation
 * is unavailable. With `policy: "strict"`, throws fail-closed.
 */
export function buildIsolatedExecutionPlan(
	command: string,
	args: string[],
	options: BuildPlanOptions = {},
): IsolatedExecutionPlan {
	const policy = options.policy ?? "permissive";
	const capability = options.capability ?? probeHostIsolation();
	const cwd = options.cwd ?? process.cwd();

	if (capability.status !== "supported") {
		if (policy === "strict") throw new Error(`Isolation required but unavailable on this platform/host: ${capability.reason}`);
		return { command, args, capability, isolated: false };
	}

	if (capability.mechanism === "linux_bwrap") {
		return {
			command: "bwrap",
			args: ["--unshare-net", "--dev", "/dev", "--proc", "/proc", "--bind", cwd, cwd, "--ro-bind", "/", "/", command, ...args],
			capability, isolated: true,
		};
	}
	if (capability.mechanism === "linux_unshare") {
		return { command: "unshare", args: ["--net", command, ...args], capability, isolated: true };
	}
	if (capability.mechanism === "macos_sandbox") {
		return {
			command: "sandbox-exec",
			args: ["-p", "(version 1) (allow default) (deny network*)", command, ...args],
			capability, isolated: true,
		};
	}

	// Unreachable: all supported mechanisms are handled; treat defensively.
	if (policy === "strict") throw new Error(`Isolation required but unavailable on this platform/host: ${capability.reason}`);
	return { command, args, capability, isolated: false };
}
