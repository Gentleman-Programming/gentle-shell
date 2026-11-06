import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	RESUME_HANDOFF_ENV,
	gentleShellResumeCommand,
	isResumeHandoffPath,
	parseResumeHandoff,
	piDefaultSessionDir,
	planResumeHint,
	resumeHandoffFromSession,
	serializeResumeHandoff,
} from "../lib/gentle-shell-resume-hint.ts";

const ID = "01a0e0a0-6d7b-7314-89c1-537d47bbf4f3";
const AGENT_DIR = resolve("/home/u/.gentle-shell/agent");
const CWD = resolve("/home/u/project");
const DEFAULT_DIR = join(AGENT_DIR, "sessions", `--${CWD.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);

test("handoff env name is stable", () => {
	assert.equal(RESUME_HANDOFF_ENV, "GENTLE_SHELL_RESUME_HANDOFF");
});

test("piDefaultSessionDir mirrors pi's encoded per-cwd session dir", () => {
	assert.equal(piDefaultSessionDir(CWD, AGENT_DIR), DEFAULT_DIR);
	if (process.platform !== "win32") assert.equal(piDefaultSessionDir("/home/u/project", "/a"), "/a/sessions/--home-u-project--");
});

test("piDefaultSessionDir matches pi's own SessionManager", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "resume-hint-agent-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const byDefault = SessionManager.create(CWD);
		assert.equal(byDefault.usesDefaultSessionDir(), true);
		assert.equal(byDefault.getSessionDir(), piDefaultSessionDir(CWD, getAgentDir()));
		const custom = SessionManager.create(CWD, join(agentDir, "elsewhere"));
		assert.equal(custom.usesDefaultSessionDir(), false);
		assert.notEqual(custom.getSessionDir(), piDefaultSessionDir(CWD, getAgentDir()));
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("resumeHandoffFromSession omits the session dir when it is pi's default", () => {
	const handoff = resumeHandoffFromSession({
		sessionId: ID,
		sessionDir: DEFAULT_DIR,
		sessionFile: join(DEFAULT_DIR, "x.jsonl"),
		cwd: CWD,
		launchCwd: CWD,
		agentDir: AGENT_DIR,
		fileExists: () => true,
	});
	assert.deepEqual(handoff, { sessionId: ID });
});

test("resumeHandoffFromSession keeps a custom session dir", () => {
	const handoff = resumeHandoffFromSession({
		sessionId: ID,
		sessionDir: "/tmp/my sessions",
		sessionFile: "/tmp/my sessions/x.jsonl",
		cwd: CWD,
		launchCwd: CWD,
		agentDir: AGENT_DIR,
		fileExists: () => true,
	});
	assert.deepEqual(handoff, { sessionId: ID, sessionDir: "/tmp/my sessions" });
});

test("resumeHandoffFromSession carries the session file for a session from another project", () => {
	const other = resolve("/home/u/other");
	const handoff = resumeHandoffFromSession({
		sessionId: ID,
		sessionDir: DEFAULT_DIR,
		sessionFile: join(DEFAULT_DIR, "x.jsonl"),
		cwd: CWD,
		launchCwd: other,
		agentDir: AGENT_DIR,
		fileExists: () => true,
	});
	assert.deepEqual(handoff, { sessionId: ID, sessionFile: join(DEFAULT_DIR, "x.jsonl") });
	assert.equal(gentleShellResumeCommand(handoff!, ["--link"], "linux"), `gentle-shell --link --session ${join(DEFAULT_DIR, "x.jsonl")}`);
});

test("resumeHandoffFromSession returns undefined when pi would not print a hint", () => {
	const base = { sessionId: ID, sessionDir: DEFAULT_DIR, cwd: CWD, launchCwd: CWD, agentDir: AGENT_DIR };
	assert.equal(resumeHandoffFromSession({ ...base, sessionFile: undefined, fileExists: () => true }), undefined);
	assert.equal(resumeHandoffFromSession({ ...base, sessionFile: join(DEFAULT_DIR, "x.jsonl"), fileExists: () => false }), undefined);
});

test("handoff round-trips and rejects malformed input", () => {
	const handoff = { sessionId: ID, sessionDir: "/tmp/s" };
	assert.deepEqual(parseResumeHandoff(serializeResumeHandoff(handoff)), handoff);
	assert.deepEqual(parseResumeHandoff(serializeResumeHandoff({ sessionId: ID })), { sessionId: ID });
	for (const text of ["", "not json", "null", "[]", '{"sessionId":""}', '{"sessionId":1}', '{"sessionId":"a","sessionDir":3}', '{"sessionId":"a","sessionDir":""}']) {
		assert.equal(parseResumeHandoff(text), undefined, text);
	}
});

test("handoff accepts only an absolute, control-free session file on its own", () => {
	const file = resolve("/tmp/s/x.jsonl");
	assert.deepEqual(parseResumeHandoff(JSON.stringify({ sessionId: ID, sessionFile: file })), { sessionId: ID, sessionFile: file });
	for (const value of [
		{ sessionId: ID, sessionFile: "relative/x.jsonl" },
		{ sessionId: ID, sessionFile: resolve("/tmp/s/x.txt") },
		{ sessionId: ID, sessionFile: resolve("/tmp/s/\u001b[2J.jsonl") },
		{ sessionId: ID, sessionFile: 3 },
		{ sessionId: ID, sessionFile: file, sessionDir: "/tmp/s" },
	]) {
		assert.equal(parseResumeHandoff(JSON.stringify(value)), undefined, JSON.stringify(value));
	}
});

test("isResumeHandoffPath accepts only the launcher's private handoff shape", () => {
	const tmp = tmpdir();
	assert.equal(isResumeHandoffPath(join(tmp, "gentle-shell-resume-Ab12Cd", "handoff.json")), true);
	assert.equal(isResumeHandoffPath(join(tmp, "gentle-shell-resume-Ab12Cd", "other.json")), false);
	assert.equal(isResumeHandoffPath(join(tmp, "elsewhere", "handoff.json")), false);
	assert.equal(isResumeHandoffPath(join(resolve("/home/u"), ".bashrc")), false);
	assert.equal(isResumeHandoffPath("gentle-shell-resume-Ab12Cd/handoff.json"), false);
});

test("handoff rejects values that could inject terminal control sequences", () => {
	const reject = (value: object) => assert.equal(parseResumeHandoff(JSON.stringify(value)), undefined, JSON.stringify(value));
	// Session ids follow pi's assertValidSessionId charset.
	reject({ sessionId: "abc\u001b[2J" });
	reject({ sessionId: "abc def" });
	reject({ sessionId: "-abc" });
	reject({ sessionId: "abc$(id)" });
	reject({ sessionId: ID, sessionDir: "/tmp/\u001b]0;pwned\u0007" });
	reject({ sessionId: ID, sessionDir: "/tmp/a\u009bb" });
	assert.deepEqual(parseResumeHandoff(JSON.stringify({ sessionId: "a.b_c-1" })), { sessionId: "a.b_c-1" });
});

test("gentleShellResumeCommand keeps home selectors and a custom session dir", () => {
	assert.equal(gentleShellResumeCommand({ sessionId: ID }, [], "linux"), `gentle-shell --session ${ID}`);
	assert.equal(gentleShellResumeCommand({ sessionId: ID }, ["--link"], "linux"), `gentle-shell --link --session ${ID}`);
	assert.equal(
		gentleShellResumeCommand({ sessionId: ID, sessionDir: "/tmp/my sessions" }, ["--home", "/x y"], "linux"),
		`gentle-shell --home '/x y' --session-dir '/tmp/my sessions' --session ${ID}`,
	);
});

test("the gentle-shell command matches pi's real exit hint with the binary swapped", async () => {
	// formatResumeCommand is not in pi's exports map; load the module file.
	const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
	const modulePath = join(piDist, "modes", "interactive", "interactive-mode.js");
	const { formatResumeCommand } = await import(pathToFileURL(modulePath).href);
	// The appended line is only needed while pi prints this hint.
	assert.ok(readFileSync(modulePath, "utf8").includes('chalk.dim("To resume this session:")'), "pi's hint label changed");

	const agentDir = mkdtempSync(join(tmpdir(), "resume-hint-agent-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const previousTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	try {
		for (const sessionDir of [undefined, join(agentDir, "my sessions")]) {
			const manager = SessionManager.create(CWD, sessionDir);
			manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() } as never);
			manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.now() } as never);
			const handoff = resumeHandoffFromSession({
				sessionId: manager.getSessionId(),
				sessionDir: manager.getSessionDir(),
				sessionFile: manager.getSessionFile(),
				cwd: manager.getCwd(),
				launchCwd: manager.getCwd(),
				agentDir: getAgentDir(),
				fileExists: existsSync,
			});
			assert.ok(handoff);
			const piCommand: string = formatResumeCommand(manager);
			assert.ok(piCommand.startsWith("pi "), piCommand);
			// pi quotes the POSIX way on every platform; compare with the same quoting.
			assert.equal(gentleShellResumeCommand(handoff, [], "linux"), `gentle-shell ${piCommand.slice("pi ".length)}`);
		}
	} finally {
		if (previousTTY) Object.defineProperty(process.stdout, "isTTY", previousTTY);
		else delete (process.stdout as { isTTY?: boolean }).isTTY;
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("on win32 the command uses double quotes that cmd.exe and PowerShell honor", () => {
	assert.equal(gentleShellResumeCommand({ sessionId: ID }, ["--link"], "win32"), `gentle-shell --link --session ${ID}`);
	assert.equal(
		gentleShellResumeCommand({ sessionId: ID, sessionDir: "C:\\Users\\Name With Space\\sessions" }, ["--home", "C:\\Users\\Name With Space\\home"], "win32"),
		`gentle-shell --home "C:\\Users\\Name With Space\\home" --session-dir "C:\\Users\\Name With Space\\sessions" --session ${ID}`,
	);
	// Plain paths need no quotes at all.
	assert.equal(
		gentleShellResumeCommand({ sessionId: ID, sessionFile: "C:\\s\\x.jsonl" }, [], "win32"),
		"gentle-shell --session C:\\s\\x.jsonl",
	);
	// Spaces alone are safe inside double quotes.
	assert.equal(
		gentleShellResumeCommand({ sessionId: ID, sessionFile: "C:\\My Sessions\\x.jsonl" }, [], "win32"),
		'gentle-shell --session "C:\\My Sessions\\x.jsonl"',
	);
});

test("on win32 no command is produced when a value cannot be quoted safely", () => {
	// PowerShell passes a space-free argument to the .cmd shim unquoted, so
	// cmd.exe operators are refused even though double quotes would cover them.
	for (const home of ["C:\\%USERPROFILE%\\h", "C:\\a!b\\h", "C:\\$env\\h", "C:\\a`b\\h", 'C:\\a"b\\h', "C:\\a b\\", "C:\\R&D\\h", "C:\\a|b\\h", "C:\\a<b\\h", "C:\\a>b\\h", "C:\\a^b\\h", "C:\\a(b)\\h"]) {
		assert.equal(gentleShellResumeCommand({ sessionId: ID }, ["--home", home], "win32"), undefined, home);
	}
	assert.equal(
		planResumeHint({ handoff: { sessionId: ID }, homeFlags: ["--home", "C:\\%TEMP%\\h"], stdoutIsTTY: true, terminalHungUp: false, platform: "win32", color: true }),
		undefined,
	);
	// The same characters are harmless inside POSIX single quotes elsewhere.
	assert.equal(gentleShellResumeCommand({ sessionId: ID }, ["--home", "/tmp/$h"], "linux"), `gentle-shell --home '/tmp/$h' --session ${ID}`);
});

test("a cross-project session file reopens the original session in pi", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "resume-hint-agent-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const manager = SessionManager.create(CWD);
		manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() } as never);
		manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.now() } as never);
		const handoff = resumeHandoffFromSession({
			sessionId: manager.getSessionId(),
			sessionDir: manager.getSessionDir(),
			sessionFile: manager.getSessionFile(),
			cwd: manager.getCwd(),
			launchCwd: resolve("/home/u/other"),
			agentDir: getAgentDir(),
			fileExists: existsSync,
		});
		assert.ok(handoff?.sessionFile);
		// pi's --session takes any value with a path separator as a file path.
		assert.ok(/[/\\]/.test(handoff.sessionFile));
		const reopened = SessionManager.open(handoff.sessionFile);
		assert.equal(reopened.getSessionId(), manager.getSessionId());
		assert.equal(reopened.getCwd(), manager.getCwd());
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("planResumeHint prints the gentle-shell line with pi's dim label style", () => {
	const hint = planResumeHint({ handoff: { sessionId: ID }, homeFlags: ["--link"], stdoutIsTTY: true, terminalHungUp: false, platform: "linux", color: true });
	assert.equal(hint, `\u001b[2mTo resume in gentle-shell:\u001b[22m gentle-shell --link --session ${ID}\n`);
});

test("planResumeHint drops the ANSI style when stdout has no colors", () => {
	const hint = planResumeHint({ handoff: { sessionId: ID }, homeFlags: [], stdoutIsTTY: true, terminalHungUp: false, platform: "linux", color: false });
	assert.equal(hint, `To resume in gentle-shell: gentle-shell --session ${ID}\n`);
});

test("planResumeHint prints nothing without a handoff, a TTY, or after a hang-up", () => {
	const base = { handoff: { sessionId: ID } as { sessionId: string } | undefined, homeFlags: [], stdoutIsTTY: true, terminalHungUp: false, platform: "linux" as NodeJS.Platform, color: true };
	assert.equal(planResumeHint({ ...base, handoff: undefined }), undefined);
	assert.equal(planResumeHint({ ...base, stdoutIsTTY: false }), undefined);
	assert.equal(planResumeHint({ ...base, terminalHungUp: true }), undefined);
});
