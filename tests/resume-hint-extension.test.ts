import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import resumeHint, { resetResumeHintState } from "../extensions/resume-hint.ts";
import { RESUME_HANDOFF_ENV, parseResumeHandoff } from "../lib/gentle-shell-resume-hint.ts";

const ID = "01a0e0a0-6d7b-7314-89c1-537d47bbf4f3";

// A private dir shaped like the launcher's (<tmpdir>/gentle-shell-resume-XXXXXX).
const handoffDir = () => mkdtempSync(join(tmpdir(), "gentle-shell-resume-"));

type Handler = (event: { reason: string }, ctx: unknown) => void;

function loadExtension(env: NodeJS.ProcessEnv): Handler[] {
	const shutdown: Handler[] = [];
	const pi = { on: (name: string, handler: Handler) => { if (name === "session_shutdown") shutdown.push(handler); } };
	resumeHint(pi as never, env);
	return shutdown;
}

// The session cwd defaults to the launch directory (pi never changes it).
function fakeContext(dir: string, mode = "tui", cwd = process.cwd()) {
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(sessionFile, "{}\n");
	return {
		mode,
		sessionManager: {
			getSessionId: () => ID,
			getSessionDir: () => dir,
			getSessionFile: () => sessionFile,
			getCwd: () => cwd,
		},
	};
}

test("extension is inert without the launcher handoff env", () => {
	assert.equal(loadExtension({}).length, 0);
});

test("extension claims the env var so child processes cannot inherit it", () => {
	const env: NodeJS.ProcessEnv = { [RESUME_HANDOFF_ENV]: join(tmpdir(), "gentle-shell-resume-unused", "handoff.json") };
	loadExtension(env);
	resetResumeHintState();
	assert.equal(env[RESUME_HANDOFF_ENV], undefined);
});

test("extension keeps the claimed handoff across /reload", () => {
	const dir = handoffDir();
	try {
		const handoffPath = join(dir, "handoff.json");
		const env: NodeJS.ProcessEnv = { [RESUME_HANDOFF_ENV]: handoffPath };
		loadExtension(env);
		// A reload re-runs the factory with the env var already claimed.
		const [onShutdown] = loadExtension(env);
		assert.ok(onShutdown);
		onShutdown({ reason: "quit" }, fakeContext(dir));
		assert.equal(parseResumeHandoff(readFileSync(handoffPath, "utf8"))?.sessionId, ID);
	} finally {
		resetResumeHintState();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("extension writes the handoff only for an interactive quit", () => {
	const dir = handoffDir();
	try {
		const handoffPath = join(dir, "handoff.json");
		const [onShutdown] = loadExtension({ [RESUME_HANDOFF_ENV]: handoffPath });
		for (const reason of ["reload", "new", "resume", "fork"]) onShutdown({ reason }, fakeContext(dir));
		for (const mode of ["rpc", "print", "json"]) onShutdown({ reason: "quit" }, fakeContext(dir, mode));
		assert.throws(() => readFileSync(handoffPath, "utf8"));
		onShutdown({ reason: "quit" }, fakeContext(dir));
		assert.deepEqual(parseResumeHandoff(readFileSync(handoffPath, "utf8")), { sessionId: ID, sessionDir: dir });
	} finally {
		resetResumeHintState();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("extension ignores a handoff path that is not the launcher's private file", () => {
	const dir = handoffDir();
	try {
		const target = join(dir, "not-a-handoff.json");
		const env: NodeJS.ProcessEnv = { [RESUME_HANDOFF_ENV]: target };
		assert.equal(loadExtension(env).length, 0);
		assert.equal(env[RESUME_HANDOFF_ENV], undefined);
	} finally {
		resetResumeHintState();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("extension never overwrites an existing file or follows a planted symlink", { skip: process.platform === "win32" && "creating symlinks needs privileges on Windows" }, () => {
	const dir = handoffDir();
	try {
		const victim = join(dir, "victim.txt");
		writeFileSync(victim, "keep");
		const handoffPath = join(dir, "handoff.json");
		symlinkSync(victim, handoffPath);
		const [onShutdown] = loadExtension({ [RESUME_HANDOFF_ENV]: handoffPath });
		onShutdown({ reason: "quit" }, fakeContext(dir));
		assert.equal(readFileSync(victim, "utf8"), "keep");
	} finally {
		resetResumeHintState();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("extension hands off the session file for a session from another project", () => {
	const dir = handoffDir();
	try {
		const handoffPath = join(dir, "handoff.json");
		const [onShutdown] = loadExtension({ [RESUME_HANDOFF_ENV]: handoffPath });
		onShutdown({ reason: "quit" }, fakeContext(dir, "tui", resolve("/home/u/other-project")));
		assert.deepEqual(parseResumeHandoff(readFileSync(handoffPath, "utf8")), { sessionId: ID, sessionFile: join(dir, "session.jsonl") });
	} finally {
		resetResumeHintState();
		rmSync(dir, { recursive: true, force: true });
	}
});
