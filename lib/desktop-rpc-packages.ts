// Gentle Desktop packages slice: the pure contract of `list_packages`,
// `install_package` and `remove_package`, shared by the bridge
// (`lib/desktop-packages-service.ts`) and its tests. An install or a removal is
// a job: the answer is its id, then `package_progress` lines and one
// `package_finished`.

export const DESKTOP_PACKAGES_METHODS = ["list_packages", "install_package", "remove_package"] as const;
export const DESKTOP_PACKAGES_EVENTS = ["package_progress", "package_finished"] as const;

export const DESKTOP_PACKAGES_LIMITS = {
	source: 1024,
	/** One progress line, in characters. */
	line: 2000,
	/** Progress lines one job emits; the rest are counted, not sent. */
	lines: 2000,
	packages: 500,
	error: 300,
	/** A job still running then is stopped (npm or git hanging on the network). */
	timeoutMs: 20 * 60_000,
} as const;

const err = (code: string, message: string) => ({ code, message }) as const;
export const INVALID_LIST_PACKAGES = err("invalid_request", "Invalid list_packages parameters");
export const INVALID_INSTALL_PACKAGE = err("invalid_request", "Invalid install_package parameters");
export const INVALID_REMOVE_PACKAGE = err("invalid_request", "Invalid remove_package parameters");
export const PACKAGES_UNAVAILABLE = err("packages_unavailable", "Packages are not available in this session");
export const PACKAGE_JOB_RUNNING = err("package_job_running", "Another package install or removal is running");

export type PackageScope = "user" | "project";
export type PackageAction = "install" | "remove";

export interface DesktopPackage {
	source: string;
	version?: string;
	scope: PackageScope;
}

export const JOB_ID = /^pkg_[0-9a-f]{16}$/;

/**
 * `{ source, scope? }`. The source is handed to the CLI as one argument, as a
 * user types it after `install`; one that starts with `-` would be read as an
 * option, so it is refused here. The CLI validates the rest.
 */
export function parsePackageRequest(params: Record<string, unknown>): { source: string; scope: PackageScope } | undefined {
	if (!Object.keys(params).every((key) => key === "source" || key === "scope")) return undefined;
	const { source, scope } = params;
	if (typeof source !== "string" || source.length === 0 || source.length > DESKTOP_PACKAGES_LIMITS.source) return undefined;
	// eslint-disable-next-line no-control-regex
	if (source.trim() !== source || source.startsWith("-") || /[\u0000-\u001f\u007f]/.test(source)) return undefined;
	if (scope !== undefined && scope !== "user" && scope !== "project") return undefined;
	return { source, scope: (scope as PackageScope | undefined) ?? "user" };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Output text as progress lines: no color codes, no control characters, no blank lines, each bounded. */
export function progressLines(text: string): string[] {
	const lines: string[] = [];
	for (const raw of text.replace(ANSI, "").split(/\r\n|\r|\n/)) {
		// eslint-disable-next-line no-control-regex
		const line = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trimEnd();
		if (line.trim().length === 0) continue;
		lines.push(line.length > DESKTOP_PACKAGES_LIMITS.line ? `${line.slice(0, DESKTOP_PACKAGES_LIMITS.line - 1)}…` : line);
	}
	return lines;
}
