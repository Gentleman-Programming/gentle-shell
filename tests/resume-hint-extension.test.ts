import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import resumeHint, { resetResumeHintState } from "../extensions/resume-hint.ts";
import { RESUME_HANDOFF_ENV, parseResumeHandoff } from "../lib/gentle-shell-resume-hint.ts";

const ID = "01a0e0a0-6d7b-7314-89c1-537d47bbf4f3";
const CWD = resolve("/home/u/project");

type Handler = (event: { reason: string }, ctx: unknown) => void;

function loadExtension(env: NodeJS.ProcessEnv): Handler[] {
	const shutdown: Handler[] = [];
	const pi = { on: (name: string, handler: Handler) => { if (name === "session_shutdown") shutdown.push(handler); } };
	resumeHint(pi as never, env);
	return shutdown;
}

function fakeContext(dir: string, mode = "tui") {
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(sessionFile, "{}\n");
	return {
		mode,
		sessionManager: {
			getSessionId: () => ID,
			getSessionDir: () => dir,
			getSessionFile: () => sessionFile,
			getCwd: () => CWD,
		},
	};
}

test("extension is inert without the launcher handoff env", () => {
	assert.equal(loadExtension({}).length, 0);
});

test("extension claims the env var so child processes cannot inherit it", () => {
	const env: NodeJS.ProcessEnv = { [RESUME_HANDOFF_ENV]: "/tmp/unused" };
	loadExtension(env);
	resetResumeHintState();
	assert.equal(env[RESUME_HANDOFF_ENV], undefined);
});

test("extension keeps the claimed handoff across /reload", () => {
	const dir = mkdtempSync(join(tmpdir(), "resume-hint-"));
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
	const dir = mkdtempSync(join(tmpdir(), "resume-hint-"));
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
