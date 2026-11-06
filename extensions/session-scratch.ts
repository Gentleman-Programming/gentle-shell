import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { gentlePiConfigHome } from "../lib/agent-home.ts";
import {
	checkArtifact,
	CLEAN_RECENT_MS,
	createSessionScratch,
	deleteLedger,
	directorySize,
	formatSize,
	gitArtifactTargets,
	isProcessAlive,
	isProtectedPath,
	isSessionScratchName,
	isWithin,
	LEDGER_ARTIFACTS_CAP,
	LEDGER_VERSION,
	ledgerPath,
	listLedgers,
	listLedgersSync,
	liveSubagentScratch,
	processStartToken,
	readLedger,
	realTempRoot,
	removeArtifact,
	removeSessionScratch,
	scratchRefusal,
	SWEEP_GRACE_MS,
	type ArtifactCheck,
	type ArtifactTarget,
	type ScratchArtifact,
	type ScratchLedger,
	type StoredLedger,
	writeLedger,
	writeLedgerSync,
} from "../lib/session-scratch.ts";

// Session scratch and artifact ledger (odd/tasks/session-scratch-ledger.md):
// the primary session gets its own TMPDIR, the runtime records the clones and
// worktrees its bash commands create, removes the scratch at shutdown (and the
// scratch of crashed sessions at the next start), and /gentle:scratch lists or
// cleans the rest. Delegated children (GENTLE_PI_AGENTS_CHILD=1) do none of it:
// their own TMPDIR comes from the runner and nests under the parent's scratch.

export const SCRATCH_COMMAND_USAGE = [
	"Usage: /gentle:scratch [list|clean]",
	"  list   this session's scratch dir with its size, and the clones and worktrees recorded by this and ended sessions",
	"  clean  remove scratch dirs; after one confirmation, remove recorded worktrees and clones with no uncommitted changes and no unpushed commits",
].join("\n");

export interface SessionScratchOptions {
	env?: NodeJS.ProcessEnv;
	configHome?: string;
	now?: () => number;
	isProcessAlive?: (pid: number) => boolean;
	/** When a process started (epoch ms), or undefined when it cannot be read. */
	processStartToken?: (pid: number) => string | undefined;
	graceMs?: number;
	platform?: NodeJS.Platform;
}

interface ActiveSession {
	sessionId: string;
	path: string;
	ledger: ScratchLedger;
}

// Keyed by the environment the session scratch was applied to. A /reload that
// re-runs this factory in the same module instance finds the live session here;
// one that re-evaluates the module (Pi's loader) recovers it from the ledger.
const activeSessions = new WeakMap<NodeJS.ProcessEnv, ActiveSession>();

export function createSessionScratchExtension(options: SessionScratchOptions = {}): (pi: ExtensionAPI) => void {
	const env = options.env ?? process.env;
	const now = options.now ?? Date.now;
	const alive = options.isProcessAlive ?? isProcessAlive;
	const startToken = options.processStartToken ?? processStartToken;
	// A live pid is the ledger's process only if it has the start token the ledger
	// recorded: the OS may have reused it. A token that is missing or cannot be
	// read keeps the ledger live.
	const isLive = (ledger: ScratchLedger) => {
		if (!alive(ledger.pid)) return false;
		if (ledger.processStartToken === undefined) return true;
		let current: string | undefined;
		try { current = startToken(ledger.pid); } catch { current = undefined; }
		return current === undefined || current === ledger.processStartToken;
	};
	// This process's own token, or undefined (omitted from the ledger JSON) when it cannot be read.
	const safeStartToken = () => { try { return startToken(process.pid); } catch { return undefined; } };
	// Real paths of this process's live and quarantined subagent TMPDIRs (lib/agents-runner.ts).
	const subagentDirs = () => liveSubagentScratch().flatMap((dir) => realTempRoot(dir) ?? []);
	const graceMs = options.graceMs ?? SWEEP_GRACE_MS;
	const tempVariables = (options.platform ?? process.platform) === "win32" ? ["TMPDIR", "TMP", "TEMP"] : ["TMPDIR"];
	const configHome = () => options.configHome ?? gentlePiConfigHome(env);

	const persist = async (path: string, ledger: ScratchLedger) => {
		try {
			if (ledger.scratchDir === null && ledger.artifacts.length === 0) deleteLedger(path);
			else await writeLedger(path, ledger);
		} catch { /* Best effort: an unwritable config home keeps the session running. */ }
	};
	// The shutdown path stays synchronous: its callers (tests/agents-runner.ts, and any
	// handler consumer that does not await) read its post-conditions right after it runs.
	const persistSync = (path: string, ledger: ScratchLedger) => {
		try {
			if (ledger.scratchDir === null && ledger.artifacts.length === 0) deleteLedger(path);
			else writeLedgerSync(path, ledger);
		} catch { /* Best effort: an unwritable config home keeps the session running. */ }
	};
	// Paths the runtime never records or removes, whatever a ledger says.
	const protectedDirs = (ledger: ScratchLedger) => [configHome(), ledger.cwd, process.cwd()];

	// The temp root the asking session trusts inside the home: its own, as recorded.
	const ownRoot = () => activeSessions.get(env)?.ledger.tempRoot ?? realTempRoot(env.TMPDIR?.trim() || tmpdir());

	// S9: a scratch name no longer carries its session id, so a scratch dir that a
	// live session's ledger records stays out of reach of every other ledger. This
	// session is live whatever the process check says. Returns, per ledger path,
	// what removal through that ledger must keep: its artifacts and others' live scratch.
	const heldBy = (ledgers: readonly StoredLedger[]) => {
		const own = activeSessions.get(env);
		const live = ledgers.filter(({ ledger }) => ledger.scratchDir !== null && isLive(ledger)).map(({ path, ledger }) => ({ path, dir: ledger.scratchDir! }));
		if (own?.ledger.scratchDir) live.push({ path: own.path, dir: own.ledger.scratchDir });
		return (path: string, ledger: ScratchLedger) => [
			...ledger.artifacts.map((artifact) => artifact.path),
			...live.filter((entry) => entry.path !== path).map((entry) => entry.dir),
		];
	};

	const endSession = (session: ActiveSession) => {
		const { ledger } = session;
		// A running or quarantined subagent's TMPDIR stays; the scratch then stays in the ledger for a later sweep.
		const removal = removeSessionScratch(ledger, heldBy(listLedgersSync(configHome()))(session.path, ledger), { ownRoot: ledger.tempRoot ?? undefined, liveSubagentDirs: subagentDirs() });
		if (removal === "removed" || removal === "absent") ledger.scratchDir = null;
		for (const [key, value] of Object.entries(ledger.inherited)) {
			if (value === null) delete env[key];
			else env[key] = value;
		}
		persistSync(session.path, ledger);
		activeSessions.delete(env);
		pending.clear();
	};

	// S5(b): scratch of ended sessions past the grace period; their artifacts stay for the command.
	// The startup sweep stays synchronous: session_start's callers (tests/agents-runner.ts) read
	// its post-conditions right after it runs, without awaiting the handler.
	const sweep = (ownPath: string) => {
		const ledgers = listLedgersSync(configHome());
		const held = heldBy(ledgers);
		for (const { path, ledger, mtimeMs } of ledgers) {
			if (path === ownPath || isLive(ledger) || now() - mtimeMs < graceMs) continue;
			const artifacts = ledger.artifacts.filter((artifact) => { try { lstatSync(artifact.path); return true; } catch { return false; } });
			const removal = ledger.scratchDir === null ? "absent" : removeSessionScratch(ledger, held(path, { ...ledger, artifacts }), { ownRoot: ownRoot(), liveSubagentDirs: subagentDirs() });
			persistSync(path, { ...ledger, scratchDir: removal === "removed" || removal === "absent" ? null : ledger.scratchDir, artifacts });
		}
	};

	// The live scratch of this process: its ledger names this pid and a scratch it
	// created that TMPDIR still points into, as after a reload that lost module state.
	const isLiveScratch = (ledger: ScratchLedger | undefined): boolean => {
		if (!ledger?.scratchDir || ledger.pid !== process.pid || scratchRefusal(ledger, ledger.tempRoot ?? undefined) !== undefined) return false;
		const current = env.TMPDIR?.trim();
		return !!current && [resolve(current), realTempRoot(current)].some((dir) => dir !== undefined && isWithin(dir, ledger.scratchDir!));
	};

	// The startup path stays synchronous, like the shutdown path: its callers
	// (tests/agents-runner.ts) read its post-conditions without awaiting the handler.
	const startSession = (ctx: ExtensionContext, reason: string) => {
		const sessionId = ctx.sessionManager.getSessionId?.();
		if (!sessionId) return;
		const current = activeSessions.get(env);
		if (current?.sessionId === sessionId && reason === "reload") return;
		if (current) endSession(current);
		const path = ledgerPath(configHome(), sessionId);
		const previous = readLedger(path);
		if (previous && isLiveScratch(previous)) {
			activeSessions.set(env, { sessionId, path, ledger: previous });
			persistSync(path, previous);
			sweep(path);
			return;
		}
		// A reload that could not recover the scratch finds TMPDIR pointing at it:
		// the inherited values are the ones this process's ledger recorded, else
		// TMPDIR as it is unless it is a session scratch, whose parent it was made in.
		const reloaded = reason === "reload" && previous?.pid === process.pid ? previous.inherited : undefined;
		const inheritedValue = (key: string) => {
			if (reloaded && key in reloaded) return reloaded[key];
			const value = env[key];
			if (reason === "reload" && value?.trim() && isSessionScratchName(value.trim())) return dirname(value.trim());
			return value ?? null;
		};
		const inherited = Object.fromEntries(tempVariables.map((key) => [key, inheritedValue(key)]));
		// Restored first, so tmpdir() never answers with the old scratch.
		for (const [key, value] of Object.entries(inherited)) {
			if (value === null) delete env[key];
			else env[key] = value;
		}
		const inheritedTmp = inherited.TMPDIR?.trim();
		const created = createSessionScratch(inheritedTmp ? inheritedTmp : tmpdir());
		// TMPDIR keeps the inherited spelling (S9: socket path length); the ledger keeps real paths.
		if (created) for (const key of tempVariables) env[key] = created.path;
		const scratchDir = created?.realPath;
		// A resumed session keeps the artifacts an earlier run of it recorded.
		const ledger: ScratchLedger = {
			version: LEDGER_VERSION,
			sessionId,
			pid: process.pid,
			processStartedAt: new Date(now() - process.uptime() * 1000).toISOString(),
			processStartToken: safeStartToken(),
			cwd: ctx.cwd,
			tempRoot: scratchDir ? dirname(scratchDir) : null,
			inherited,
			scratchDir: scratchDir ?? null,
			artifacts: previous?.artifacts ?? [],
		};
		// A scratch of this process is never removed at startup: it may still be in use.
		if (previous?.scratchDir && previous.scratchDir !== scratchDir && previous.pid !== process.pid && !isLive(previous)) {
			const held = heldBy(listLedgersSync(configHome()))(path, ledger);
			removeSessionScratch(previous, scratchDir ? [...held, scratchDir] : held, { ownRoot: ownRoot(), liveSubagentDirs: subagentDirs() });
		}
		activeSessions.set(env, { sessionId, path, ledger });
		persistSync(path, ledger);
		sweep(path);
	};

	// S4: destinations a foreground bash command is about to create, by tool call
	// id. A destination that already exists belongs to someone else.
	const pending = new Map<string, ArtifactTarget[]>();

	const note = (toolCallId: string, command: string, ctx: ExtensionContext) => {
		if (!activeSessions.get(env)) return;
		const absent = gitArtifactTargets(command, ctx.cwd).filter((target) => {
			try { lstatSync(target.path); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
		});
		if (absent.length > 0) pending.set(toolCallId, absent);
	};

	// S4: the noted destinations that a successful command created. The ledger keeps
	// only the most recent artifacts, evicting the oldest first, so a long session's
	// ledger file stays bounded.
	const capture = async (targets: readonly ArtifactTarget[], command: string) => {
		const session = activeSessions.get(env);
		if (!session) return;
		const { ledger } = session;
		let changed = false;
		for (const target of targets) {
			let path: string;
			try {
				if (!lstatSync(target.path).isDirectory()) continue;
				path = realpathSync(target.path);
			} catch { continue; }
			if (isProtectedPath(path, protectedDirs(ledger)) || ledger.artifacts.some((artifact) => artifact.path === path)) continue;
			ledger.artifacts.push({ kind: target.kind, path, command, recordedAt: new Date(now()).toISOString() });
			changed = true;
		}
		if (!changed) return;
		if (ledger.artifacts.length > LEDGER_ARTIFACTS_CAP) ledger.artifacts = ledger.artifacts.slice(-LEDGER_ARTIFACTS_CAP);
		await persist(session.path, ledger);
	};

	const endedLedgers = async (ownPath: string | undefined) =>
		(await listLedgers(configHome())).filter(({ path, ledger }) => path !== ownPath && !isLive(ledger));

	const describe = (artifact: ScratchArtifact) => `${artifact.kind} ${artifact.path}`;

	const list = async (): Promise<string> => {
		const session = activeSessions.get(env);
		const lines: string[] = [];
		const own = session?.ledger;
		lines.push(own?.scratchDir
			? `Session scratch: ${own.scratchDir} (${formatSize(directorySize(own.scratchDir))})`
			: `Session scratch: none (TMPDIR ${env.TMPDIR ?? tmpdir()})`);
		const ended = await endedLedgers(session?.path);
		for (const { ledger } of ended) if (ledger.scratchDir) lines.push(`Ended-session scratch: ${ledger.scratchDir} (session ${ledger.sessionId})`);
		const artifacts = [
			...(own?.artifacts ?? []).map((artifact) => `  ${describe(artifact)} (this session)`),
			...ended.flatMap(({ ledger }) => ledger.artifacts.map((artifact) => `  ${describe(artifact)} (session ${ledger.sessionId}, ended)`)),
		];
		lines.push(artifacts.length > 0 ? "Recorded clones and worktrees:" : "Recorded clones and worktrees: none", ...artifacts);
		return lines.join("\n");
	};

	const clean = async (ctx: ExtensionContext): Promise<string> => {
		// Entries of the live scratch changed since this moment may belong to a running command.
		const recentSince = now() - CLEAN_RECENT_MS;
		const session = activeSessions.get(env);
		const groups = [
			...(session ? [{ path: session.path, ledger: session.ledger, own: true }] : []),
			...(await endedLedgers(session?.path)).map(({ path, ledger }) => ({ path, ledger, own: false })),
		];
		const lines: string[] = [];
		const entries = groups.flatMap((group) => group.ledger.artifacts.map((artifact) => ({ group, artifact })));
		const drop = (entry: (typeof entries)[number]) => {
			entry.group.ledger.artifacts = entry.group.ledger.artifacts.filter((artifact) => artifact !== entry.artifact);
		};
		if (entries.length > 0 && !ctx.hasUI) {
			lines.push("Recorded clones and worktrees kept (no UI to confirm their removal):", ...entries.map(({ artifact }) => `  ${describe(artifact)}`));
		} else if (entries.length > 0) {
			const checked = await Promise.all(entries.map(async (entry) => ({ ...entry, check: await checkArtifact(entry.artifact, protectedDirs(entry.group.ledger)) })));
			const removable: Array<(typeof entries)[number] & { check: Extract<ArtifactCheck, { state: "removable" }> }> = [];
			for (const entry of checked) {
				if (entry.check.state === "missing") { drop(entry); lines.push(`Already gone: ${describe(entry.artifact)}`); }
				else if (entry.check.state === "kept") lines.push(`Kept ${describe(entry.artifact)}: ${entry.check.reason}`);
				else removable.push(entry as (typeof removable)[number]);
			}
			if (removable.length > 0) {
				const confirmed = await ctx.ui.confirm(
					`Remove ${removable.length} recorded clone${removable.length === 1 ? "" : "s"}/worktree${removable.length === 1 ? "" : "s"}?`,
					`No uncommitted changes and no unpushed commits; ignored files inside these paths are deleted too:\n${removable.map(({ artifact }) => `  ${describe(artifact)}`).join("\n")}`,
				);
				for (const entry of removable) {
					if (!confirmed) { lines.push(`Kept ${describe(entry.artifact)}: not confirmed`); continue; }
					// The clone may have changed while the confirmation was open: check it again.
					const recheck = await checkArtifact(entry.artifact, protectedDirs(entry.group.ledger));
					if (recheck.state === "missing") { drop(entry); lines.push(`Already gone: ${describe(entry.artifact)}`); continue; }
					if (recheck.state === "kept") { lines.push(`Kept ${describe(entry.artifact)}: ${recheck.reason}`); continue; }
					if (recheck.identity?.dev !== entry.check.identity?.dev || recheck.identity?.ino !== entry.check.identity?.ino) { lines.push(`Kept ${describe(entry.artifact)}: replaced after the check`); continue; }
					const failure = await removeArtifact(entry.artifact, recheck);
					if (failure) lines.push(`Kept ${describe(entry.artifact)}: ${failure}`);
					else { drop(entry); lines.push(`Removed ${describe(entry.artifact)}`); }
				}
			}
		}
		// Scratch goes without asking; the live session keeps its TMPDIR and empties it.
		const held = heldBy(await listLedgers(configHome()));
		for (const group of groups) {
			const { ledger } = group;
			if (!ledger.scratchDir) continue;
			const dir = ledger.scratchDir;
			const removal = removeSessionScratch(ledger, held(group.path, ledger), { contentsOnly: group.own, ownRoot: ownRoot(), liveSubagentDirs: subagentDirs(), keepChangedSince: group.own ? recentSince : undefined });
			if (!group.own && (removal === "removed" || removal === "absent")) ledger.scratchDir = null;
			if (removal === "refused") lines.push(`Kept scratch ${dir}: not a directory this runtime created`);
			else if (removal === "kept") lines.push(`${group.own ? "Emptied" : "Kept"} scratch ${dir}${group.own ? " except subagent scratch, live sessions' scratch, recorded artifacts, and entries changed in the last minute" : ": holds a recorded artifact, a live session's scratch, or a live subagent's scratch"}`);
			else lines.push(`${group.own ? "Emptied" : "Removed"} scratch ${dir}`);
		}
		for (const group of groups) await persist(group.path, group.ledger);
		return lines.length > 0 ? lines.join("\n") : "Nothing to clean.";
	};

	return (pi: ExtensionAPI) => {
		if (env.GENTLE_PI_AGENTS_CHILD === "1") return;
		pi.on("session_start", (event, ctx) => {
			try { startSession(ctx, (event as { reason?: string }).reason ?? "startup"); } catch { /* The session keeps the inherited TMPDIR. */ }
		});
		pi.on("session_shutdown", (event) => {
			// A reload continues the same session and keeps its scratch.
			if ((event as { reason?: string }).reason === "reload") return;
			const session = activeSessions.get(env);
			try { if (session) endSession(session); } catch { /* best effort */ }
		});
		pi.on("tool_call", (event, ctx) => {
			// Only foreground bash: a background job's result arrives before its clone exists.
			const command = (event.input as { command?: unknown } | undefined)?.command;
			if (event.toolName !== "bash" || typeof command !== "string") return undefined;
			try { note(event.toolCallId, command, ctx); } catch { /* Capture never blocks a tool call. */ }
			return undefined;
		});
		pi.on("tool_result", async (event) => {
			const targets = pending.get(event.toolCallId);
			if (!targets) return undefined;
			pending.delete(event.toolCallId);
			const command = (event.input as { command?: unknown } | undefined)?.command;
			if (event.toolName !== "bash" || event.isError !== false || typeof command !== "string") return undefined;
			try { await capture(targets, command); } catch { /* Capture never changes a tool result. */ }
			return undefined;
		});
		pi.registerCommand("gentle:scratch", {
			description: "List or clean this session's scratch dir and the recorded clones and worktrees (list|clean).",
			getArgumentCompletions: (prefix) => ["list", "clean"].filter((action) => action.startsWith(prefix.trim())).map((action) => ({ value: action, label: action })),
			handler: async (args, ctx) => {
				const action = args.trim() || "list";
				if (action === "list") ctx.ui.notify(await list(), "info");
				else if (action === "clean") ctx.ui.notify(await clean(ctx), "info");
				else ctx.ui.notify(SCRATCH_COMMAND_USAGE, "warning");
			},
		});
	};
}

export default function sessionScratch(pi: ExtensionAPI): void {
	createSessionScratchExtension()(pi);
}
