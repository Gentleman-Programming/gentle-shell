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
		launchResult.stderr.includes(`gentle-shell: ${customHome}`),
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
	};
	delete env.PI_CODING_AGENT_DIR;

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

test("manual setup never records an unrelated pre-existing directory that had content", (t) => {
	const f = fixture(t);
	const unrelatedHome = join(f.root, "unrelated-space");
	mkdirSync(unrelatedHome, { recursive: true });
	writeFileSync(join(unrelatedHome, "pre-existing.txt"), "pre-existing content", "utf8");

	// 1. Run setup on the unrelated directory
	const setupResult = run(f.env, ["--home", unrelatedHome, "setup"]);
	assert.equal(setupResult.status, 0, setupResult.stderr);

	// 2. Verify config does NOT record the unrelated directory as provisioned
	const configPath = join(f.home, ".gentle-shell", "config.json");
	const provisioned = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")).provisioned ?? {} : {};
	assert.deepEqual(provisioned, {}, "unrelated pre-existing directory must never be recorded in config.json");

	// 3. Launching against the unrelated directory prints the pre-existing content hint
	const launchResult = run(f.env, ["--home", unrelatedHome, "--mode", "rpc"]);
	assert.equal(launchResult.status, 0, launchResult.stderr);
	assert.match(launchResult.stderr, /already has content and was not set up by gentle-shell/);
});

test("manual setup records an isolated home even if it had content before bootstrap", (t) => {
	const f = fixture(t);
	const isolatedHome = join(f.root, "isolated-space");
	mkdirSync(isolatedHome, { recursive: true });
	writeFileSync(join(isolatedHome, "pre-existing.txt"), "pre-existing content", "utf8");

	const env = { ...f.env, GENTLE_SHELL_HOME: isolatedHome };
	const setupResult = run(env, ["--isolated", "setup"]);
	assert.equal(setupResult.status, 0, setupResult.stderr);

	const configPath = join(f.home, ".gentle-shell", "config.json");
	const config = JSON.parse(readFileSync(configPath, "utf8"));
	const isolatedHomeKey = realpathSync(isolatedHome);
	assert.ok(config.provisioned?.[isolatedHomeKey], "isolated home with content must still be recorded");
});

test("manual setup re-records and updates an already-recorded provisioned home", (t) => {
	const f = fixture(t);
	const targetHome = join(f.root, "re-setup-space");
	mkdirSync(targetHome, { recursive: true });
	writeFileSync(join(targetHome, "content.txt"), "some content", "utf8");

	const configDir = join(f.home, ".gentle-shell");
	mkdirSync(configDir, { recursive: true });
	const configPath = join(configDir, "config.json");
	const targetHomeKey = realpathSync(targetHome);
	writeFileSync(
		configPath,
		JSON.stringify({
			provisioned: {
				[targetHomeKey]: {
					gentleAi: "0.0.1",
					gentlePi: "0.0.1",
					setupAt: "2026-01-01T00:00:00.000Z",
				},
			},
		}),
		"utf8",
	);

	const setupResult = run(f.env, ["--home", targetHome, "setup"]);
	assert.equal(setupResult.status, 0, setupResult.stderr);

	const updatedConfig = JSON.parse(readFileSync(configPath, "utf8"));
	const entry = updatedConfig.provisioned?.[targetHomeKey];
	assert.ok(entry, "existing provisioned entry must be preserved/updated");
	assert.equal(entry.gentlePi, ownGentlePiVersion(), "gentlePi version must be updated to current");
});
