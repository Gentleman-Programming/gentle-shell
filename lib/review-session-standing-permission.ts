import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

export const REVIEW_SESSION_PERMISSION_REGISTRY_SCHEMA = "gentle-pi.review-session-standing-permission/v1";
export const REVIEW_SESSION_PERMISSION_REGISTRY_SYMBOL = Symbol.for(REVIEW_SESSION_PERMISSION_REGISTRY_SCHEMA);

const execFileAsync = promisify(execFile);

export interface GitCommandOptions {
	encoding: "utf8";
	timeout: number;
	maxBuffer: number;
	windowsHide?: boolean;
}

export type GitAsyncRunner = (command: string, args: readonly string[], options: GitCommandOptions) => Promise<{ stdout: string }>;
export type GitSyncRunner = (command: string, args: readonly string[], options: GitCommandOptions) => string;

export interface ReviewSessionManager {
	getSessionId(): unknown;
}

export interface ReviewSessionContext {
	cwd: string;
	mode?: string;
	hasUI: boolean;
	ui?: { getAllThemes?: () => readonly unknown[] };
	sessionManager: ReviewSessionManager;
}

export interface ReviewSessionIdentity {
	readonly sessionManager: ReviewSessionManager;
	readonly sessionId: string;
	readonly worktreeRoot: string;
	// A SHA-256 digest of the canonical Git common directory. It is stable for
	// sibling worktrees of one clone without serializing a filesystem path.
	readonly repositoryIdentity: string;
}

interface ReviewSessionPermissionRegistry {
	readonly schema: typeof REVIEW_SESSION_PERMISSION_REGISTRY_SCHEMA;
	readonly permissions: WeakMap<object, Map<string, Set<string>>>;
	readonly revocationEpochs: WeakMap<object, Map<string, number>>;
}

type GlobalRegistry = Record<symbol, unknown>;

function registry(): ReviewSessionPermissionRegistry | undefined {
	const globalRegistry = globalThis as GlobalRegistry;
	const current = globalRegistry[REVIEW_SESSION_PERMISSION_REGISTRY_SYMBOL];
	if (current === undefined) {
		const created: ReviewSessionPermissionRegistry = {
			schema: REVIEW_SESSION_PERMISSION_REGISTRY_SCHEMA,
			permissions: new WeakMap(),
			revocationEpochs: new WeakMap(),
		};
		globalRegistry[REVIEW_SESSION_PERMISSION_REGISTRY_SYMBOL] = created;
		return created;
	}
	if (
		typeof current !== "object" ||
		current === null ||
		(current as { schema?: unknown }).schema !== REVIEW_SESSION_PERMISSION_REGISTRY_SCHEMA ||
		!((current as { permissions?: unknown }).permissions instanceof WeakMap) ||
		!((current as { revocationEpochs?: unknown }).revocationEpochs instanceof WeakMap)
	) return undefined;
	return current as ReviewSessionPermissionRegistry;
}

function exactSessionId(sessionManager: ReviewSessionManager): string | undefined {
	try {
		const value = sessionManager.getSessionId();
		return typeof value === "string" && value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

function canonicalRepositoryIdentity(commonDir: string): string {
	return `sha256:${createHash("sha256").update(commonDir).digest("hex")}`;
}

function validAbsoluteGitPath(value: string): boolean {
	return isAbsolute(value) && value.length > 0 && !value.includes("\n") && !value.includes("\r");
}

export async function resolveCanonicalGitWorktreeRoot(
	cwd: string,
	run: GitAsyncRunner = execFileAsync as unknown as GitAsyncRunner,
): Promise<string | undefined> {
	try {
		const result = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			timeout: 5_000,
			maxBuffer: 64 * 1024,
			windowsHide: true,
		});
		const output = result.stdout.trim();
		if (!validAbsoluteGitPath(output)) return undefined;
		return await realpath(output);
	} catch {
		return undefined;
	}
}

/** Resolves a non-secret, clone-stable identity from Git's canonical common dir. */
export async function resolveCanonicalGitRepositoryIdentity(
	cwd: string,
	run: GitAsyncRunner = execFileAsync as unknown as GitAsyncRunner,
): Promise<string | undefined> {
	try {
		const result = await run("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
			encoding: "utf8",
			timeout: 5_000,
			maxBuffer: 64 * 1024,
			windowsHide: true,
		});
		const output = result.stdout.trim();
		if (output.length === 0 || output.includes("\n") || output.includes("\r")) return undefined;
		return canonicalRepositoryIdentity(await realpath(resolve(cwd, output)));
	} catch {
		return undefined;
	}
}

/** The parent AgentRunner binds a child task to this same digest at spawn time. */
export function resolveCanonicalGitRepositoryIdentitySync(
	cwd: string,
	run: GitSyncRunner = execFileSync as unknown as GitSyncRunner,
): string | undefined {
	try {
		const output = run("git", ["-C", cwd, "rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true }).trim();
		if (output.length === 0 || output.includes("\n") || output.includes("\r")) return undefined;
		return canonicalRepositoryIdentity(realpathSync(resolve(cwd, output)));
	} catch {
		return undefined;
	}
}

function hasInteractiveTui(context: ReviewSessionContext): boolean {
	if (context.mode !== undefined) return context.mode === "tui";
	try {
		// Pi 0.85 exposes ctx.mode in the documented SDK surface, while its
		// compatibility runner omits that property. In the latter, the real TUI
		// has themes and RPC's deliberately unsupported TUI surface returns none.
		return (context.ui?.getAllThemes?.().length ?? 0) > 0;
	} catch {
		return false;
	}
}

export async function captureReviewSessionIdentity(
	context: ReviewSessionContext,
	processEnv: NodeJS.ProcessEnv = process.env,
	resolveRoot: (cwd: string) => Promise<string | undefined> = resolveCanonicalGitWorktreeRoot,
	resolveRepositoryIdentity: (cwd: string) => Promise<string | undefined> = resolveCanonicalGitRepositoryIdentity,
): Promise<ReviewSessionIdentity | undefined> {
	if (processEnv.GENTLE_PI_AGENTS_CHILD === "1" || context.hasUI !== true || !hasInteractiveTui(context)) return undefined;
	const sessionManager = context.sessionManager;
	if (typeof sessionManager !== "object" || sessionManager === null) return undefined;
	const sessionId = exactSessionId(sessionManager);
	if (sessionId === undefined) return undefined;
	const [worktreeRoot, repositoryIdentity] = await Promise.all([resolveRoot(context.cwd), resolveRepositoryIdentity(context.cwd)]);
	if (worktreeRoot === undefined || repositoryIdentity === undefined) return undefined;
	return { sessionManager, sessionId, worktreeRoot, repositoryIdentity };
}

export function sameReviewSessionIdentity(left: ReviewSessionIdentity, right: ReviewSessionIdentity): boolean {
	return left.sessionManager === right.sessionManager && left.sessionId === right.sessionId && left.repositoryIdentity === right.repositoryIdentity;
}

function epochFor(state: ReviewSessionPermissionRegistry, sessionManager: object, sessionId: string): number {
	return state.revocationEpochs.get(sessionManager)?.get(sessionId) ?? 0;
}

function advanceEpoch(state: ReviewSessionPermissionRegistry, sessionManager: object, sessionId: string): void {
	let sessions = state.revocationEpochs.get(sessionManager);
	if (sessions === undefined) {
		sessions = new Map();
		state.revocationEpochs.set(sessionManager, sessions);
	}
	sessions.set(sessionId, epochFor(state, sessionManager, sessionId) + 1);
}

export function reviewSessionPermissionEpoch(identity: ReviewSessionIdentity): number | undefined {
	const state = registry();
	return state === undefined ? undefined : epochFor(state, identity.sessionManager, identity.sessionId);
}

export function grantReviewSessionPermission(identity: ReviewSessionIdentity, expectedEpoch?: number): boolean {
	const state = registry();
	if (state === undefined || (expectedEpoch !== undefined && epochFor(state, identity.sessionManager, identity.sessionId) !== expectedEpoch)) return false;
	let sessions = state.permissions.get(identity.sessionManager);
	if (sessions === undefined) {
		sessions = new Map();
		state.permissions.set(identity.sessionManager, sessions);
	}
	let roots = sessions.get(identity.sessionId);
	if (roots === undefined) {
		roots = new Set();
		sessions.set(identity.sessionId, roots);
	}
	roots.add(identity.repositoryIdentity);
	return true;
}

// A grant belongs to one live session and one Git clone. It follows sibling
// worktrees through their common directory, never an unrelated repository.
export function hasReviewSessionPermission(identity: ReviewSessionIdentity): boolean {
	return registry()?.permissions.get(identity.sessionManager)?.get(identity.sessionId)?.has(identity.repositoryIdentity) === true;
}

export function revokeReviewSessionPermission(identity: ReviewSessionIdentity): boolean {
	const state = registry();
	if (state === undefined) return false;
	advanceEpoch(state, identity.sessionManager, identity.sessionId);
	const sessions = state.permissions.get(identity.sessionManager);
	const roots = sessions?.get(identity.sessionId);
	if (sessions === undefined || roots === undefined) return false;
	const removed = roots.delete(identity.repositoryIdentity);
	if (roots.size === 0) sessions.delete(identity.sessionId);
	if (sessions.size === 0) state.permissions.delete(identity.sessionManager);
	return removed;
}

export function revokeReviewSessionPermissionsForSession(sessionManager: object, sessionId: string): boolean {
	if (sessionId.length === 0) return false;
	const state = registry();
	if (state === undefined) return false;
	advanceEpoch(state, sessionManager, sessionId);
	const sessions = state.permissions.get(sessionManager);
	if (sessions === undefined) return false;
	const removed = sessions.delete(sessionId);
	if (sessions.size === 0) state.permissions.delete(sessionManager);
	return removed;
}
