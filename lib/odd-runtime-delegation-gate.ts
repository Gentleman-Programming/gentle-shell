import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { resolveSessionWorktree } from "./session-worktree-registry.ts";

export interface OddDelegationRefusal {
	block: true;
	reason: string;
}

interface SessionState {
	primary: boolean;
	childDepth: number;
	firstSuccessfulPath?: string;
}

function canonicalTarget(path: string): string {
	let candidate = path;
	const missing: string[] = [];
	while (true) {
		try { return resolve(realpathSync(candidate), ...missing); }
		catch {
			const parent = dirname(candidate);
			if (parent === candidate) return path;
			missing.unshift(basename(candidate));
			candidate = parent;
		}
	}
}

function sessionPath(toolName: string, input: unknown, cwd: string): string | undefined {
	if ((toolName !== "edit" && toolName !== "write") || !input || typeof input !== "object") return undefined;
	const path = (input as { path?: unknown }).path;
	if (typeof path !== "string" || path.trim().length === 0) return undefined;
	const root = resolveSessionWorktree(cwd, cwd)?.root;
	if (!root) return undefined;
	const spelling = path.replace(/^@/, "");
	const canonicalCwd = realpathSync(cwd);
	const lexicalTarget = isAbsolute(spelling)
		? resolve(spelling)
		: resolve(canonicalCwd, spelling);
	const target = canonicalTarget(lexicalTarget);
	const repositoryPath = relative(root, target);
	if (repositoryPath === "" || repositoryPath === ".." || repositoryPath.startsWith(`..${sep}`) || isAbsolute(repositoryPath)) return undefined;
	const canonical = repositoryPath.split(sep).join("/");
	return canonical === "odd/tasks" || canonical.startsWith("odd/tasks/") ? undefined : canonical;
}

export class OddRuntimeDelegationGate {
	private readonly sessions = new Map<string, SessionState>();

	start(sessionId: string, primary: boolean): void {
		const state = this.sessions.get(sessionId);
		if (primary) this.sessions.set(sessionId, { primary: true, childDepth: 0 });
		else if (state?.primary) state.childDepth += 1;
		else this.sessions.set(sessionId, { primary: false, childDepth: 1 });
	}

	endChild(sessionId: string): void {
		const state = this.sessions.get(sessionId);
		if (state && state.childDepth > 0) state.childDepth -= 1;
	}

	beforeTool(
		sessionId: string,
		toolName: string,
		input: unknown,
		cwd: string,
		availableTools: readonly string[],
	): OddDelegationRefusal | undefined {
		const state = this.sessions.get(sessionId);
		if (!state?.primary || state.childDepth > 0) return undefined;
		const path = sessionPath(toolName, input, cwd);
		if (!path || !state.firstSuccessfulPath || path === state.firstSuccessfulPath) return undefined;
		return {
			block: true,
			reason: availableTools.includes("subagent_run")
				? `ODD multi-file write refused before mutation: direct edits already changed ${state.firstSuccessfulPath}. Delegate this additional file through subagent_run, preferring gentle-ai-worker and then worker.`
				: "ODD multi-file write refused before mutation: direct edits already changed another file, but subagent_run is not callable. Stop and report that no delegation mechanism is callable.",
		};
	}

	recordSuccess(sessionId: string, toolName: string, input: unknown, cwd: string): void {
		const state = this.sessions.get(sessionId);
		if (!state?.primary || state.childDepth > 0 || state.firstSuccessfulPath) return;
		const path = sessionPath(toolName, input, cwd);
		if (path) state.firstSuccessfulPath = path;
	}
}
