// The desktop feed's adapters to state that has no event of its own: Git (the
// Changes scan and the header branch), the active profile label and tier, and
// the publisher's process ancestry (how the Herdr mod matches a terminal to a
// session). Each adapter is injectable so the extension stays testable.

import { execFile } from "node:child_process";
import { gentlePiConfigHome } from "./agent-home.ts";
import { profilesFilePath, readProfilesFileResult } from "./agent-profiles.ts";
import { resolveSessionProfile, sessionProfileLabel } from "./session-profile-freeze.ts";
import { resolveSessionWorktree, worktreeGitEnvironment, type WorktreeIdentity, type WorktreeResolver } from "./session-worktree-registry.ts";
import type { GitRunner } from "./shell-changes.ts";

const GIT_TIMEOUT_MS = 5000;
/** A porcelain inventory past this is a failed scan, never a partial one. */
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/** Git for one root with the same sanitized environment Changes uses; never throws. */
export function desktopFeedGitRunner(root: string, env: NodeJS.ProcessEnv = process.env): GitRunner {
	const childEnv = worktreeGitEnvironment(env);
	return (args) => new Promise((resolve) => {
		try {
			execFile("git", ["--no-optional-locks", "-C", root, ...args], { env: childEnv, encoding: "utf8", shell: false, windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }, (error, stdout) => {
				const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
				if (failure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") { resolve({ stdout: "", code: 1, truncated: true }); return; }
				resolve({ stdout: String(stdout ?? ""), code: failure ? typeof failure.code === "number" ? failure.code : 1 : 0, ...(failure?.killed ? { timedOut: true } : {}) });
			});
		} catch {
			resolve({ stdout: "", code: 1 });
		}
	});
}

export type ParentOf = (pid: number) => Promise<number | undefined>;

/** `ps -o ppid=` for one pid; undefined when unknown (Windows, exited, no ps). */
export const psParentOf: ParentOf = (pid) => new Promise((resolve) => {
	if (process.platform === "win32") { resolve(undefined); return; }
	try {
		execFile("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, windowsHide: true }, (error, stdout) => {
			const parent = error ? Number.NaN : Number.parseInt(String(stdout).trim(), 10);
			resolve(Number.isInteger(parent) && parent > 1 ? parent : undefined);
		});
	} catch {
		resolve(undefined);
	}
});

/** Ancestors above `ppid`, nearest first, stopping at init or after `depth` hops. Never rejects. */
export async function processAncestors(ppid: number, depth: number, parentOf: ParentOf = psParentOf): Promise<number[]> {
	const chain: number[] = [];
	let current = ppid;
	for (let hop = 0; hop < depth; hop++) {
		const parent = await parentOf(current).catch(() => undefined);
		if (parent === undefined || parent <= 1 || chain.includes(parent)) break;
		chain.push(parent);
		current = parent;
	}
	return chain;
}

export interface DesktopFeedProfile {
	name: string | undefined;
	tier: "standard" | "fast" | undefined;
}

/**
 * The profile the status bar names, through the same single rule the shell's
 * active-profile reader applies (resolveSessionProfile + sessionProfileLabel),
 * and the orchestrator tier configured for it in the profiles store.
 */
export function createDesktopFeedProfileReader(env: NodeJS.ProcessEnv = process.env, resolveWorktree: WorktreeResolver = resolveSessionWorktree) {
	let identity: WorktreeIdentity | undefined;
	let boundCwd: string | undefined;
	return (cwd: string, sessionId: string | undefined): DesktopFeedProfile => {
		try {
			if (boundCwd !== cwd) {
				boundCwd = cwd;
				try { identity = resolveWorktree(cwd, cwd); } catch { identity = undefined; }
			}
			const configHome = gentlePiConfigHome(env);
			const store = readProfilesFileResult(profilesFilePath(configHome));
			const tiers: Record<string, "standard" | "fast" | undefined> = store.status === "valid"
				? Object.fromEntries(Object.entries(store.file.profiles).map(([name, config]) => [name, config.orchestrator?.tier]))
				: {};
			const selected = resolveSessionProfile({ sessionId, cwd, configHome, resolveWorktree: () => identity, env });
			const name = sessionProfileLabel(selected);
			const configured = selected.kind === "explicit" ? selected.name : selected.profile?.name;
			return { name, tier: configured ? tiers[configured] : undefined };
		} catch {
			return { name: undefined, tier: undefined };
		}
	};
}
