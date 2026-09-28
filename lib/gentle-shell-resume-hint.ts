// Pure logic behind the gentle-shell resume hint. On interactive quit pi
// prints "To resume this session: pi --session <id>" (interactive-mode
// formatResumeCommand). Under gentle-shell that command cannot find the
// session: pi resolves sessions from PI_CODING_AGENT_DIR, which the launcher
// points at the gentle-shell home, but the hint names the bare `pi` binary
// and never mentions that directory, so running it looks in ~/.pi/agent.
//
// The clean fix belongs in pi (earendil-works/pi#8048, #9750). Until then,
// gentle-shell appends its own line below pi's, leaving pi's output as is:
// extensions/resume-hint.ts writes a ResumeHandoff on session_shutdown, and
// bin/gentle-shell.mjs prints the planResumeHint line after pi exits.
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { shellQuote } from "./gentle-shell-launcher.ts";

export const RESUME_HANDOFF_ENV = "GENTLE_SHELL_RESUME_HANDOFF";

const HINT_LABEL = "To resume in gentle-shell:";

// pi's assertValidSessionId charset. The handoff ends up on the terminal, so
// anything outside it (or any C0/C1 control in a session dir) is refused
// rather than escaped.
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

// The launcher creates <tmpdir>/<RESUME_HANDOFF_DIR_PREFIX>XXXXXX/<RESUME_HANDOFF_FILE>.
export const RESUME_HANDOFF_DIR_PREFIX = "gentle-shell-resume-";
export const RESUME_HANDOFF_FILE = "handoff.json";

// The extension only writes to a path shaped like the launcher's private
// handoff, so an inherited or foreign env value cannot aim it at another file.
export function isResumeHandoffPath(path: string): boolean {
	return (
		isAbsolute(path) &&
		basename(path) === RESUME_HANDOFF_FILE &&
		basename(dirname(path)).startsWith(RESUME_HANDOFF_DIR_PREFIX) &&
		!CONTROL_CHARS.test(path)
	);
}

export interface ResumeHandoff {
	sessionId: string;
	// Present only when pi would add --session-dir, i.e. the session does not
	// live in pi's default per-cwd directory under the agent dir.
	sessionDir?: string;
	// Present only when the session belongs to another project than the one
	// gentle-shell was launched from (e.g. after /resume). A bare id would
	// then make pi offer a fork into the launch directory, while an absolute
	// session file path reopens the original session.
	sessionFile?: string;
}

// Mirror of pi's getDefaultSessionDirPath (core/session-manager), which pi
// does not export. Kept byte-for-byte so usesDefaultSessionDir agrees.
export function piDefaultSessionDir(cwd: string, agentDir: string): string {
	const resolvedCwd = resolvePath(cwd);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(resolvePath(agentDir), "sessions", safePath);
}

export interface SessionSnapshot {
	sessionId: string;
	sessionDir: string;
	sessionFile: string | undefined;
	cwd: string;
	// The directory gentle-shell was launched from; pi never changes it.
	launchCwd: string;
	agentDir: string;
	fileExists: (path: string) => boolean;
}

// Mirrors the guards in pi's formatResumeCommand: no hint for an
// unpersisted session or one whose file was never written.
export function resumeHandoffFromSession(snapshot: SessionSnapshot): ResumeHandoff | undefined {
	const { sessionId, sessionDir, sessionFile, cwd, launchCwd, agentDir, fileExists } = snapshot;
	if (!sessionFile || !fileExists(sessionFile)) return undefined;
	if (resolvePath(cwd) !== resolvePath(launchCwd)) return { sessionId, sessionFile: resolvePath(sessionFile) };
	if (sessionDir === piDefaultSessionDir(cwd, agentDir)) return { sessionId };
	return { sessionId, sessionDir };
}

export function serializeResumeHandoff(handoff: ResumeHandoff): string {
	return JSON.stringify(handoff);
}

// Tolerant on purpose: a missing, stale, or foreign handoff file just means
// "print nothing".
export function parseResumeHandoff(text: string): ResumeHandoff | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const { sessionId, sessionDir, sessionFile } = parsed as Record<string, unknown>;
	if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) return undefined;
	if (sessionFile !== undefined) {
		if (sessionDir !== undefined || typeof sessionFile !== "string") return undefined;
		if (!isAbsolute(sessionFile) || !sessionFile.endsWith(".jsonl") || CONTROL_CHARS.test(sessionFile)) return undefined;
		return { sessionId, sessionFile };
	}
	if (sessionDir === undefined) return { sessionId };
	if (typeof sessionDir !== "string" || sessionDir.length === 0 || CONTROL_CHARS.test(sessionDir)) return undefined;
	return { sessionId, sessionDir };
}

export function gentleShellResumeCommand(handoff: ResumeHandoff, homeFlags: string[]): string {
	const args = ["gentle-shell", ...homeFlags.map(shellQuote)];
	// pi treats a --session value containing a path separator as a file path
	// and opens it directly, whatever the launch directory.
	if (handoff.sessionFile !== undefined) {
		args.push("--session", shellQuote(handoff.sessionFile));
		return args.join(" ");
	}
	if (handoff.sessionDir !== undefined) args.push("--session-dir", shellQuote(handoff.sessionDir));
	args.push("--session", handoff.sessionId);
	return args.join(" ");
}

export interface ResumeHintInput {
	handoff: ResumeHandoff | undefined;
	homeFlags: string[];
	stdoutIsTTY: boolean;
	// True once the launcher got SIGHUP: the terminal is gone.
	terminalHungUp: boolean;
}

// Returns the line to print after pi exits, or undefined to print nothing.
// Like pi, it only prints to a TTY, and never after the terminal hung up.
export function planResumeHint(input: ResumeHintInput): string | undefined {
	const { handoff, homeFlags, stdoutIsTTY, terminalHungUp } = input;
	if (!handoff || !stdoutIsTTY || terminalHungUp) return undefined;
	return `\u001b[2m${HINT_LABEL}\u001b[22m ${gentleShellResumeCommand(handoff, homeFlags)}\n`;
}
