import { isAbsolute } from "node:path";

// #1690: the gentle-shell launcher injects the gentle-pi package into the
// parent pi with `-e` instead of a settings declaration, so delegated children
// would otherwise start without it. The launcher records the exact extension
// set it injected in this variable; the subagent runner forwards that set to
// every child. Kept free of launcher imports so the runner can load it cheaply.
export const CHILD_PACKAGE_INJECTION_ENV = "GENTLE_SHELL_CHILD_PACKAGE_INJECTION";

const CHILD_PACKAGE_INJECTION_VERSION = 1;

export interface ChildPackageInjection {
	// True for a launcher takeover: the parent ran with --no-extensions, so the
	// child must too, or settings discovery would load a second gentle-pi.
	noExtensions: boolean;
	// Absolute extension paths, in the order the launcher passed them to `-e`.
	extensionPaths: string[];
}

export function encodeChildPackageInjection(value: ChildPackageInjection): string {
	return JSON.stringify({
		version: CHILD_PACKAGE_INJECTION_VERSION,
		noExtensions: value.noExtensions,
		extensionPaths: value.extensionPaths,
	});
}

// Returns undefined for an absent or invalid value and never throws: a bad
// signal must degrade to "no forwarding", not break a child launch. The path
// flavor is injectable so tests can check Windows paths on any platform.
export function parseChildPackageInjection(
	env: Record<string, string | undefined>,
	pathFlavor: { isAbsolute(path: string): boolean } = { isAbsolute },
): ChildPackageInjection | undefined {
	const raw = env[CHILD_PACKAGE_INJECTION_ENV];
	if (raw === undefined || raw.length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	if (record.version !== CHILD_PACKAGE_INJECTION_VERSION) return undefined;
	if (typeof record.noExtensions !== "boolean") return undefined;
	const paths = record.extensionPaths;
	if (!Array.isArray(paths) || paths.length === 0) return undefined;
	const extensionPaths: string[] = [];
	for (const path of paths) {
		if (typeof path !== "string" || path.length === 0 || !pathFlavor.isAbsolute(path)) return undefined;
		extensionPaths.push(path);
	}
	return { noExtensions: record.noExtensions, extensionPaths };
}

// Plain argv elements for a child pi: spawned without a shell, so no quoting.
export function childPackageExtensionArgs(injection: ChildPackageInjection): string[] {
	const args = injection.noExtensions ? ["--no-extensions"] : [];
	for (const path of injection.extensionPaths) args.push("--extension", path);
	return args;
}
