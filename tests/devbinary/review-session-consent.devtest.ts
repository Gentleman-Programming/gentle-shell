import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../../extensions/gentle-ai.ts";
import { CandidateViewRegistry } from "../../lib/review-candidate-view.ts";
import { NativeReviewCliV216, type ExecFileAdapter } from "../../lib/native-review-cli.ts";
import { requireDevBinary } from "../support/native-binary-gate.ts";

const binary = process.env.GENTLE_AI_DEV_BINARY;
const gate = requireDevBinary({ devBinaryPath: binary, exists: !!binary && isAbsolute(binary) && existsSync(binary), env: process.env });

// Real native replies and two real candidates; only the human UI is a fixture.
// No lens capture, model completion or remote delivery is invoked.
test("native CLI retains host session consent across two actual candidates", { skip: gate.run === false ? gate.reason : false }, async t => {
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "review-session-native-")));
	const cwd = join(scratch, "repo"), home = join(scratch, "home");
	mkdirSync(cwd); mkdirSync(home);
	const environment = { ...process.env, HOME: home, USERPROFILE: home, GENTLE_AI_HOME: join(home, "native"),
		GENTLE_PI_CONFIG_HOME: join(home, "config"), XDG_CONFIG_HOME: join(home, ".config"), GENTLE_AI_NO_SELF_UPDATE: "1" };
	for (const key of Object.keys(environment)) if (key.startsWith("GIT_")) delete environment[key as keyof typeof environment];
	const git = (...args: string[]) => execFileSync("git", args, { cwd, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-b", "main");
	writeFileSync(join(cwd, "app.ts"), "export const value = 1;\n");
	git("add", "app.ts"); git("-c", "user.name=Consent Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base");
	const version = execFileSync(binary!, ["--version"], { cwd, env: environment, encoding: "utf8" }).trim();
	t.diagnostic(`native version: ${version}; fixture UI grants session consent; no model review executed`);
	const execute = promisify(execFile);
	const calls: string[][] = [];
	const adapter: ExecFileAdapter = async request => {
		calls.push([...request.arguments]);
		assert.ok(!request.arguments.some(arg => /^capture/.test(arg)), "this consent probe must not run model captures");
		try {
			const result = await execute(request.file, [...request.arguments], { cwd: request.cwd, env: environment,
				encoding: "utf8", timeout: request.timeoutMs ?? 30_000, maxBuffer: request.maxBufferBytes, windowsHide: true, signal: request.signal });
			return { stdout: result.stdout, stderr: result.stderr, exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
		} catch (error) {
			const result = error as Error & { stdout?: string; stderr?: string; code?: number; signal?: NodeJS.Signals; killed?: boolean };
			if (typeof result.code !== "number") throw error;
			return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.code,
				signal: result.signal ?? null, timedOut: result.killed === true, outputLimitExceeded: false };
		}
	};
	const native = new NativeReviewCliV216(adapter, binary!);
	await native.reviewMode({ cwd, operation: "enable" });
	const views = new CandidateViewRegistry();
	t.after(() => { views.cleanupAll(); rmSync(scratch, { recursive: true, force: true }); });
	const tools = new Map<string, { execute(...args: unknown[]): Promise<{ details: Record<string, unknown> }> }>();
	createGentleAiExtension({ nativeReviewCli: native, candidateViews: views, processEnv: environment })({
		on() {}, registerCommand() {}, registerTool(tool: { name: string; execute(...args: unknown[]): Promise<{ details: Record<string, unknown> }> }) { tools.set(tool.name, tool); },
		events: { emit() {} },
	} as unknown as ExtensionAPI);
	const notices: string[] = [];
	let prompts = 0;
	const context = { cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "native-consent-session" }, ui: {
		notify(text: string) { notices.push(text); }, setStatus() {}, theme: { fg: (_color: string, text: string) => text },
		async custom(factory: (...args: unknown[]) => unknown) {
			prompts++;
			let answer: unknown;
			const view = factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text },
				undefined, (value: unknown) => { answer = value; }) as { render(width: number): string[]; handleInput(input: string): void };
			view.render(100); view.handleInput("\u001b[B"); view.render(100); view.handleInput("\u001b[B"); view.render(100); view.handleInput("\r");
			return answer;
		},
	} } as unknown as ExtensionContext;
	const controller = tools.get("gentle_review")!;
	for (const value of [2, 3]) {
		writeFileSync(join(cwd, "app.ts"), `export const value = ${value};\n`);
		const inspected = await controller.execute(`inspect-${value}`, { operation: "inspect" }, undefined, undefined, context);
		if (typeof inspected.details.selectionBinding === "string") {
			await controller.execute(`select-${value}`, { operation: "select-intended-untracked", selectionBinding: inspected.details.selectionBinding, intendedUntracked: [] }, undefined, undefined, context);
		}
		const result = await controller.execute(`candidate-${value}`, { operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, undefined, undefined, context);
		assert.equal(result.details.operation, "answer-consent", JSON.stringify(result.details));
		assert.equal(result.details.status, undefined, JSON.stringify(result.details));
	}
	assert.equal(prompts, 1, "the second candidate uses the same live-session host permission");
	assert.ok(notices.some(message => /Reviews are allowed for this Pi session/.test(message)));
	assert.equal(calls.filter(args => args.some(arg => /consent.*granted/.test(arg)) || args.includes("granted")).length, 2);
});
