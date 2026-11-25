import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function isWithinPath(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

// Match Pi's file tool spelling (dist/core/tools/path-utils.js). The SDK does
// not export these path helpers. POSIX backslashes and whitespace are literal.
function normalizeToolPath(raw: string): string {
	let path = raw.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/^@/, "");
	if (process.platform === "win32" && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\")) {
		const drive = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
		if (drive) path = `${drive[1].toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
	}
	if (path === "~") return homedir();
	if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) return join(homedir(), path.slice(2));
	return path.startsWith("file://") ? fileURLToPath(path) : path;
}

// A nonexistent leaf may be created by write. Resolve its existing ancestors,
// but never treat a dangling symlink as a missing lexical component (#1659).
function canonicalizePath(absolute: string): string {
	let probe = absolute;
	const missing: string[] = [];
	let links = 0;
	while (true) {
		try {
			const real = realpathSync.native(probe);
			return missing.length === 0 ? real : resolve(real, ...missing.reverse());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const stat = lstatSync(probe, { throwIfNoEntry: false });
		if (stat?.isSymbolicLink()) {
			if (++links > 40) throw new Error("Too many symbolic links");
			const target = readlinkSync(probe);
			const { root } = parse(target);
			const base = resolve(realpathSync.native(dirname(probe)), root);
			// Keep parent segments for native realpath: a preceding component
			// may itself be a symlink. Append the missing tail only after that.
			probe = base + (base.endsWith(sep) ? "" : sep) + target.slice(root.length);
			continue;
		}
		const parent = dirname(probe);
		const component = basename(probe);
		// A parent segment is meaningful only if its prefix actually resolves.
		if (stat || parent === probe || component === "..") throw new Error("Unresolved path");
		missing.push(component);
		probe = parent;
	}
}

export function canonicalizeTarget(raw: string, cwd: string, toolName: string): string {
	let path = resolve(cwd, normalizeToolPath(raw));
	if (toolName === "read" && !existsSync(path)) {
		// Pi's read tool tries these macOS filename spellings in this order.
		const nfd = path.normalize("NFD");
		path = [path.replace(/ (AM|PM)\./gi, "\u202f$1."), nfd, path.replace(/'/g, "\u2019"), nfd.replace(/'/g, "\u2019")].find(existsSync) ?? path;
	}
	return canonicalizePath(path);
}

export function isTempTarget(target: string, env: NodeJS.ProcessEnv): boolean {
	return [env.TMPDIR || tmpdir(), "/tmp", "/var/tmp"].some(path => {
		if (!isAbsolute(path)) return false;
		try {
			const root = realpathSync.native(path);
			return dirname(root) !== root && statSync(root).isDirectory() && isWithinPath(root, target);
		} catch { return false; }
	});
}

// Both producers publish only host-indexed, exact files. Snapshot their real
// destinations: a later retargeted symlink must not inherit the exemption.
// Pi loads extension entries independently with Jiti's module cache disabled.
const indexedSkillsKey = Symbol.for("gentle-pi.path-consent.indexed-skills");
type SkillIndex = WeakMap<object, { sessionId: string; cwd: string; pi?: Set<string>; registry?: Set<string> }>;
const indexedSkills = ((globalThis as typeof globalThis & { [indexedSkillsKey]?: SkillIndex })[indexedSkillsKey] ??= new WeakMap());

export function clearPathConsentSkills(ctx: ExtensionContext): void {
	indexedSkills.delete(ctx.sessionManager);
}

export function setPathConsentSkills(ctx: ExtensionContext, source: "pi" | "registry", paths: readonly string[]): void {
	const manager = ctx.sessionManager;
	const sessionId = manager?.getSessionId?.();
	if (!sessionId) return;
	let index = indexedSkills.get(manager);
	if (!index || index.sessionId !== sessionId || index.cwd !== ctx.cwd) {
		index = { sessionId, cwd: ctx.cwd };
		indexedSkills.set(manager, index);
	}
	const exact = new Set<string>();
	for (const path of paths) {
		if (!isAbsolute(path)) continue;
		try {
			const real = realpathSync.native(path);
			if (statSync(real).isFile()) exact.add(real);
		} catch { /* A missing or inaccessible skill supplies no exemption. */ }
	}
	index[source] = exact;
}

export function isIndexedSkillTarget(ctx: ExtensionContext, target: string): boolean {
	const index = indexedSkills.get(ctx.sessionManager);
	return index !== undefined && index.sessionId === ctx.sessionManager.getSessionId() && index.cwd === ctx.cwd
		&& (index.pi?.has(target) === true || index.registry?.has(target) === true);
}
