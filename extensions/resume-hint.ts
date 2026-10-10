import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, writeFileSync } from "node:fs";
import {
	isResumeHandoffPath,
	RESUME_HANDOFF_ENV,
	resumeHandoffFromSession,
	serializeResumeHandoff,
} from "../lib/gentle-shell-resume-hint.ts";

// Hands the quitting session to bin/gentle-shell.mjs, which prints a
// gentle-shell resume command below pi's "pi --session <id>" exit hint (see
// lib/gentle-shell-resume-hint.ts). Inert unless the launcher set the env var.

// Process-wide, not per extension instance: /reload re-runs this factory after
// the env var was already claimed, and must keep using the same handoff path
// instead of going inert.
const STATE_KEY = Symbol.for("gentle-pi.resume-hint");
type StateHolder = { [STATE_KEY]?: string };

function claimHandoffPath(env: NodeJS.ProcessEnv): string | undefined {
	const holder = globalThis as StateHolder;
	const path = env[RESUME_HANDOFF_ENV];
	// Claim the handoff for this process only: subagents and tool shells
	// inherit process.env, and their own shutdowns must not overwrite it.
	delete env[RESUME_HANDOFF_ENV];
	if (holder[STATE_KEY] === undefined && path && isResumeHandoffPath(path)) holder[STATE_KEY] = path;
	return holder[STATE_KEY];
}

/** Test-only: forget the claimed handoff path. */
export function resetResumeHintState(): void {
	delete (globalThis as StateHolder)[STATE_KEY];
}

export default function resumeHint(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	const handoffPath = claimHandoffPath(env);
	if (!handoffPath) return;

	pi.on("session_shutdown", (event, ctx) => {
		if (event.reason !== "quit" || ctx.mode !== "tui") return;
		const sessionManager = ctx.sessionManager;
		const handoff = resumeHandoffFromSession({
			sessionId: sessionManager.getSessionId(),
			sessionDir: sessionManager.getSessionDir(),
			sessionFile: sessionManager.getSessionFile(),
			cwd: sessionManager.getCwd(),
			launchCwd: process.cwd(),
			agentDir: getAgentDir(),
			fileExists: existsSync,
		});
		if (!handoff) return;
		try {
			// "wx": create only. The launcher's private dir starts empty, so an
			// existing file (or a planted symlink) means it is not ours to write.
			writeFileSync(handoffPath, serializeResumeHandoff(handoff), { encoding: "utf8", flag: "wx" });
		} catch {
			// Best effort: without a handoff the launcher prints nothing extra.
		}
	});
}
