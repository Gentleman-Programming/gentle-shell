import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(testDir);
const binPath = join(packageRoot, "bin", "gentle-shell.mjs");

function ownGentlePiVersion(): string {
	return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
}

/**
 * Creates an executable script fixture for testing launcher execution.
 *
 * @param path - Destination file path for the script.
 * @param content - Script file contents.
 * @returns Executable path (cmd wrapper on Windows, script path on POSIX).
 */
function makeExecutableScript(path: string, content: string): string {
	writeFileSync(path, content, { encoding: "utf8", mode: 0o755 });
	if (process.platform === "win32") {
		const cmdPath = `${path}.cmd`;
		writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${path}" %*\r\nexit /b %errorlevel%\r\n`, "utf8");
		return cmdPath;
	}
	chmodSync(path, 0o755);
	return path;
}

function fixture(t: test.TestContext) {
	const root = join(tmpdir(), `gs-issue-2906-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const home = join(root, "home");
	mkdirSync(home, { recursive: true });

	const piScript = makeExecutableScript(
		join(root, "fake-pi.mjs"),
		[
			"#!/usr/bin/env node",
			"const args = process.argv.slice(2);",
			'if (args.includes("--version")) { console.log("1.2.0"); process.exit(0); }',
			"console.log(JSON.stringify({ args }));",
			"process.exit(0);",
		].join("\n"),
	);

	const gentleAiScript = makeExecutableScript(
		join(root, "fake-gentle-ai.mjs"),
		[
			"#!/usr/bin/env node",
			"const args = process.argv.slice(2);",
			"process.stdout.write(JSON.stringify({ args }));",
			"process.exit(0);",
		].join("\n"),
	);

	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		GENTLE_SHELL_PI: piScript,
		GENTLE_SHELL_GENTLE_AI_BIN: gentleAiScript,
		GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0",
	};

	delete env.GENTLE_SHELL_USER_PI_HOME;
	delete env.GENTLE_SHELL_CONFIG;
	return { root, home, env, piScript, gentleAiScript };
}

function run(env: NodeJS.ProcessEnv, args: string[]) {
	return spawnSync(process.execPath, [binPath, ...args], { encoding: "utf8", env });
}

test("manual setup records a --home matching PI_CODING_AGENT_DIR so subsequent runs do not repeat the foreign hint (#2906)", (t) => {
	const f = fixture(t);
	const customHome = join(f.root, "custom-space");
	mkdirSync(customHome, { recursive: true });

	const env = {
		...f.env,
		PI_CODING_AGENT_DIR: customHome,
	};

	// 1. Run setup on the custom home
	const setupResult = run(env, ["--home", customHome, "setup"]);
	assert.equal(setupResult.status, 0, setupResult.stderr);

	// 2. Verify config recorded the provisioned marker
	const configPath = join(f.home, ".gentle-shell", "config.json");
	assert.ok(existsSync(configPath), "config.json should be created");
	const config = JSON.parse(readFileSync(configPath, "utf8"));
	const customHomeKey = realpathSync(customHome);
	const entry = config.provisioned?.[customHomeKey];
	assert.ok(entry, "manual setup must record the provisioned marker for a custom --home equal to PI_CODING_AGENT_DIR");
	assert.equal(entry.gentleAi, "3.6.0");
	assert.equal(entry.gentlePi, ownGentlePiVersion());

	// 3. Subsequent run should not print foreign home hint
	const launchResult = run(env, ["--home", customHome, "--mode", "rpc"]);
	assert.equal(launchResult.status, 0, launchResult.stderr);
	assert.equal(
		launchResult.stderr.includes("is pi's own default agent home"),
		false,
		"subsequent launch must not repeat the foreign home hint",
	);
});

test("manual setup never records pi's own default agent home (~/.pi/agent)", (t) => {
	const f = fixture(t);
	const defaultPiHome = join(f.home, ".pi", "agent");
	mkdirSync(defaultPiHome, { recursive: true });

	const env = {
		...f.env,
		PI_CODING_AGENT_DIR: undefined,
	};

	// 1. Run setup on pi's own default home
	const setupResult = run(env, ["--home", defaultPiHome, "setup"]);
	assert.equal(setupResult.status, 0, setupResult.stderr);

	// 2. Verify config does not record default pi home
	const configPath = join(f.home, ".gentle-shell", "config.json");
	const provisioned = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")).provisioned ?? {} : {};
	assert.deepEqual(provisioned, {}, "pi's own default agent home must never be recorded in config.json");

	// 3. Launching against pi's default home should print the foreign home hint
	const launchResult = run(env, ["--home", defaultPiHome, "--mode", "rpc"]);
	assert.equal(launchResult.status, 0, launchResult.stderr);
	assert.match(launchResult.stderr, /is pi's own default agent home; gentle-shell never auto-provisions it/);
});
