import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { shellQuote } from "../lib/gentle-shell-launcher.ts";

// Automatic first-run setup through the real launcher, runnable on every
// platform (tests/gentle-shell-bin.test.ts covers more but cannot run on
// Windows). Gentle AI is missing and its self-install is skipped, so every
// attempt fails fast and the launch continues into a fake Pi that logs its
// arguments. These lines are pinned exactly as Gentle Shell 18b862532 printed
// them: maybeAutoProvisionHome now takes its reasons from setupCheck, the
// helper `setup --check` reports, and must keep saying the same thing.

const binPath = fileURLToPath(new URL("../bin/gentle-shell.mjs", import.meta.url));
const gentlePi = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
const roots: string[] = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
function scratch(prefix: string): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	roots.push(root);
	return root;
}

function fakePi(dir: string): { path: string; log: string } {
	const log = join(dir, "pi.log");
	if (process.platform === "win32") {
		const path = join(dir, "fake-pi.cmd");
		writeFileSync(path, `@echo off\r\necho %*>> "${log}"\r\nif "%1"=="--version" (echo 1.6.0)\r\n`);
		return { path, log };
	}
	const path = join(dir, "fake-pi.sh");
	writeFileSync(path, `#!/bin/sh\necho "$*" >> '${log}'\nif [ "$1" = "--version" ]; then echo 1.6.0; fi\n`);
	chmodSync(path, 0o755);
	return { path, log };
}

interface Case {
	name: string;
	argv?: (root: string) => string[];
	pin?: string;
	// The isolated home's provisioning record, when it has one.
	record?: Record<string, string>;
	seed?: (root: string) => void;
	env?: Record<string, string>;
	// The exact leading stderr lines (paths built with the root).
	expect: (root: string, home: string) => string[];
	attempted: boolean;
}

const failedLine = "gentle-shell: automatic setup failed (exit 1); starting anyway and retrying next run. Run `gentle-shell setup` to see the full output.";
const firstRunHint = (home: string) => `gentle-shell: using a separate home at ${home}. Run 'gentle-shell --link' to reuse your pi sign-ins and chats.`;

const cases: Case[] = [
	{
		name: "never provisioned",
		expect: (_root, home) => [firstRunHint(home), `gentle-shell: first run in ${home}: installing the Gentle AI companion packages (one time; set GENTLE_SHELL_NO_AUTO_SETUP=1 to skip)`, failedLine],
		attempted: true,
	},
	{
		name: "gentle-ai pin changed",
		pin: "3.7.0",
		record: { gentleAi: "3.6.0", gentlePi },
		expect: (_root, home) => [`gentle-shell: gentle-ai pin changed (3.6.0 -> 3.7.0): updating ${home}`, failedLine],
		attempted: true,
	},
	{
		name: "gentle-pi changed",
		record: { gentleAi: "3.6.0", gentlePi: "4.0.0" },
		expect: (_root, home) => [`gentle-shell: gentle-pi changed (4.0.0 -> ${gentlePi}): updating ${home}`, failedLine],
		attempted: true,
	},
	{
		name: "both changed",
		pin: "3.7.0",
		record: { gentleAi: "3.6.0", gentlePi: "4.0.0" },
		expect: (_root, home) => [`gentle-shell: gentle-ai pin changed (3.6.0 -> 3.7.0) and gentle-pi changed (4.0.0 -> ${gentlePi}): updating ${home}`, failedLine],
		attempted: true,
	},
	{
		name: "a record without gentlePi",
		record: { gentleAi: "3.6.0" },
		expect: (_root, home) => [`gentle-shell: gentle-pi changed (unknown -> ${gentlePi}): updating ${home}`, failedLine],
		attempted: true,
	},
	{
		name: "provisioned and current",
		record: { gentleAi: "3.6.0", gentlePi },
		expect: (_root, home) => [`gentle-shell: disabled Pi's builtin codemode in ${join(home, "settings.json")} (Gentle Shell ships its own codemode tool)`],
		attempted: false,
	},
	{
		name: "a foreign --home",
		argv: (root) => ["--home", join(root, "foreign"), "-p", "x"],
		seed: (root) => {
			mkdirSync(join(root, "foreign"));
			writeFileSync(join(root, "foreign", "notes.txt"), "mine\n");
		},
		expect: (root) => [`gentle-shell: ${join(root, "foreign")} already has content and was not set up by gentle-shell; run \`gentle-shell --home ${shellQuote(join(root, "foreign"))} setup\` to provision it`],
		attempted: false,
	},
	{
		name: "--link",
		argv: () => ["--link", "-p", "x"],
		expect: () => [],
		attempted: false,
	},
	{
		name: "automatic setup off",
		env: { GENTLE_SHELL_NO_AUTO_SETUP: "1" },
		expect: (_root, home) => [firstRunHint(home), `gentle-shell: disabled Pi's builtin codemode in ${join(home, "settings.json")} (Gentle Shell ships its own codemode tool)`],
		attempted: false,
	},
];

for (const c of cases) {
	test(`automatic setup, ${c.name}: prints its reason, then still launches Pi`, () => {
		const root = scratch("gentle-shell-auto-provision-");
		const tools = scratch("gentle-shell-auto-provision-pi-");
		const home = join(root, ".gentle-shell", "agent");
		if (c.record !== undefined) {
			mkdirSync(home, { recursive: true });
			writeFileSync(join(home, "settings.json"), "{}");
			writeFileSync(join(root, ".gentle-shell", "config.json"), JSON.stringify({ provisioned: { [home]: { ...c.record, at: "2026-01-01T00:00:00.000Z" } } }, null, 2));
		}
		c.seed?.(root);
		const pi = fakePi(tools);
		const env: NodeJS.ProcessEnv = {
			HOME: root, USERPROFILE: root, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec,
			GENTLE_SHELL_SKIP_STARTUP_UPDATE: "1", GENTLE_SHELL_PI: pi.path, ENGRAM_URL: "http://127.0.0.1:9",
			GENTLE_SHELL_GENTLE_AI_PIN: c.pin ?? "3.6.0", GENTLE_SHELL_GENTLE_AI_BIN: join(root, "missing-gentle-ai"), GENTLE_PI_SKIP_GENTLE_AI_INSTALL: "1",
			...c.env,
		};
		const argv = c.argv?.(root) ?? ["-p", "x"];
		const result = spawnSync(process.execPath, [binPath, ...argv], { env, encoding: "utf8", input: "", timeout: 60000 });

		assert.equal(result.status, 0, result.stderr);
		const lines = result.stderr.split("\n").filter((line) => line.length > 0);
		const expected = c.expect(root, home);
		assert.deepEqual(lines.slice(0, expected.length), expected);
		// A failed attempt also prints Gentle AI's missing-binary detail; nothing else follows otherwise.
		if (c.attempted) assert.ok(lines.some((line) => line.startsWith("package-local-binary-missing: ")), result.stderr);
		else assert.equal(lines.length, expected.length, result.stderr);
		assert.equal(result.stderr.includes("automatic setup failed"), c.attempted);
		// Pi is still launched with the prompt after the attempt (or without one).
		assert.ok(existsSync(pi.log));
		assert.match(readFileSync(pi.log, "utf8"), /-p x/);
	});
}
