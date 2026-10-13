import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
	envDir,
	envNameForDir,
	envsRoot,
	removeEnvFromConfig,
	renameEnvInConfig,
	setDefaultEnvInConfig,
	summarizeEnv,
	validateEnvName,
} from "../lib/gentle-shell-envs.ts";
import { homeSelectorFlags, parseLauncherArgs, resolveHome } from "../lib/gentle-shell-launcher.ts";

// --- names and paths -----------------------------------------------------

test("validateEnvName accepts lowercase names with dots, dashes and underscores", () => {
	for (const name of ["work", "client-a", "v2.1", "a_b", "0x"]) assert.equal(validateEnvName(name), undefined, name);
});

test("validateEnvName rejects empty, dot paths, separators, uppercase and overlong names", () => {
	for (const name of ["", ".", "..", ".hidden", "-x", "a/b", "a\\b", "Work", "a b", "x".repeat(41)]) {
		assert.match(validateEnvName(name) ?? "", /env name/, name);
	}
});

test("envsRoot honors GENTLE_SHELL_ENVS_DIR, else ~/.gentle-shell/envs", () => {
	assert.equal(envsRoot({}, "/h"), join("/h", ".gentle-shell", "envs"));
	assert.equal(envsRoot({ GENTLE_SHELL_ENVS_DIR: "/custom" }, "/h"), "/custom");
	assert.equal(envsRoot({ GENTLE_SHELL_ENVS_DIR: "" }, "/h"), join("/h", ".gentle-shell", "envs"));
});

test("envNameForDir maps only a direct, validly named child of the root", () => {
	const root = join("/h", "envs");
	assert.equal(envNameForDir(root, envDir(root, "work")), "work");
	assert.equal(envNameForDir(root, join(root, "work", "nested")), undefined);
	assert.equal(envNameForDir(root, join("/elsewhere", "work")), undefined);
	assert.equal(envNameForDir(root, join(root, "Bad Name")), undefined);
});

// --- config mutations ----------------------------------------------------

test("setDefaultEnvInConfig persists the env dir as home and keeps other keys", () => {
	const next = setDefaultEnvInConfig({ home: "link", other: 1 }, "/e/work");
	assert.deepEqual(next, { home: "/e/work", other: 1 });
});

test("renameEnvInConfig moves provisioned markers and the default home for every alias", () => {
	const marker = { gentleAi: "1", gentlePi: "2", at: "t" };
	const config = { home: "/e/old", provisioned: { "/real/e/old": marker, "/e/keep": marker }, other: true };
	const next = renameEnvInConfig(config, ["/e/old", "/real/e/old"], "/e/new");
	assert.deepEqual(next, { home: "/e/new", provisioned: { "/e/keep": marker, "/e/new": marker }, other: true });
	assert.equal(config.home, "/e/old", "never mutates its input");
});

test("renameEnvInConfig keys the moved marker by the new realpath when given", () => {
	const marker = { gentleAi: "1", at: "t" };
	const next = renameEnvInConfig({ home: "/e/old", provisioned: { "/real/old": marker } }, ["/e/old", "/real/old"], "/e/new", "/real/new");
	assert.deepEqual(next, { home: "/e/new", provisioned: { "/real/new": marker } });
});

test("renameEnvInConfig leaves an unrelated default untouched", () => {
	assert.deepEqual(renameEnvInConfig({ home: "isolated" }, ["/e/old"], "/e/new"), { home: "isolated" });
});

test("removeEnvFromConfig drops the env's markers and clears it as default", () => {
	const marker = { gentleAi: "1", at: "t" };
	const next = removeEnvFromConfig({ home: "/e/x", provisioned: { "/e/x": marker, "/e/y": marker } }, ["/e/x"]);
	assert.deepEqual(next, { provisioned: { "/e/y": marker } });
});

// --- info ---------------------------------------------------------------

test("summarizeEnv reports packages, provider ids only, provisioning and sessions", () => {
	const info = summarizeEnv({
		name: "work",
		dir: "/e/work",
		isDefault: true,
		settingsText: JSON.stringify({ packages: ["npm:gentle-engram", { source: "npm:pi-btw" }, 42] }),
		authText: JSON.stringify({ anthropic: { type: "oauth", access: "SECRET" }, openai: { key: "SECRET" } }),
		provisioned: { gentleAi: "4.0.0", gentlePi: "4.0.0", at: "2026-05-01T00:00:00.000Z" },
		sessionCount: 3,
		lastSessionAt: "2026-05-02T00:00:00.000Z",
	});
	assert.deepEqual(info.packages, ["npm:gentle-engram", "npm:pi-btw"]);
	assert.deepEqual(info.providers, ["anthropic", "openai"]);
	assert.equal(info.provisioned, "gentle-ai 4.0.0 · gentle-pi 4.0.0 · 2026-05-01");
	assert.equal(info.sessionCount, 3);
	assert.ok(!JSON.stringify(info).includes("SECRET"), "never leaks credential values");
});

test("summarizeEnv tolerates missing or malformed files", () => {
	const info = summarizeEnv({ name: "x", dir: "/e/x", isDefault: false, settingsText: "{", authText: "[]", sessionCount: 0 });
	assert.deepEqual(info.packages, []);
	assert.deepEqual(info.providers, []);
	assert.equal(info.provisioned, "not provisioned");
	assert.equal(info.lastSessionAt, undefined);
});

// --- launcher integration ----------------------------------------------

test("parseLauncherArgs captures --env <name> and --env=<name>", () => {
	assert.equal(parseLauncherArgs(["--env", "work"]).env, "work");
	assert.equal(parseLauncherArgs(["--env=work", "-p", "hi"]).env, "work");
	assert.deepEqual(parseLauncherArgs(["--env=work", "-p", "hi"]).passthrough, ["-p", "hi"]);
});

test("parseLauncherArgs rejects a missing or invalid --env and combinations with other selectors", () => {
	assert.match(parseLauncherArgs(["--env"]).error ?? "", /--env requires/);
	assert.match(parseLauncherArgs(["--env", "Bad"]).error ?? "", /env name/);
	assert.match(parseLauncherArgs(["--env", "a", "--link"]).error ?? "", /--env cannot be combined with --link/);
	assert.match(parseLauncherArgs(["--env", "a", "--isolated"]).error ?? "", /--env cannot be combined with --isolated/);
	assert.match(parseLauncherArgs(["--env", "a", "--home", "/x"]).error ?? "", /--env cannot be combined with --home/);
});

test("parseLauncherArgs treats argv[0] envs as the envs command", () => {
	const parsed = parseLauncherArgs(["envs", "list"]);
	assert.equal(parsed.command, "envs");
	assert.deepEqual(parsed.commandArgs, ["list"]);
	assert.equal(parseLauncherArgs(["-p", "envs"]).command, undefined);
});

test("resolveHome resolves --env to its managed dir and reproduces it as --env", () => {
	const home = resolveHome({ args: parseLauncherArgs(["--env", "work"]), env: {}, homedir: "/h", config: undefined });
	assert.deepEqual(home, { mode: "path", dir: join("/h", ".gentle-shell", "envs", "work"), source: "flag", env: "work" });
	assert.deepEqual(homeSelectorFlags(home), ["--env", "work"]);
});

test("resolveHome names a persisted default that lives in the envs root", () => {
	const dir = join("/h", ".gentle-shell", "envs", "work");
	const home = resolveHome({ args: parseLauncherArgs([]), env: {}, homedir: "/h", config: { mode: "path", dir } });
	assert.equal(home.env, "work");
	assert.equal(home.source, "config");
	const plain = resolveHome({ args: parseLauncherArgs([]), env: {}, homedir: "/h", config: { mode: "path", dir: "/other" } });
	assert.equal(plain.env, undefined);
	assert.deepEqual(homeSelectorFlags(plain), ["--home", "/other"]);
});

test("buildPiInvocation names the env for the session and never leaks an inherited one", async () => {
	const { buildPiInvocation, ENV_NAME_ENV } = await import("../lib/gentle-shell-launcher.ts");
	const base = {
		runtime: { kind: "path" as const, command: "pi", args: [] },
		packageRoot: "/pkg",
		declaration: undefined,
		takeOver: false,
		otherPackagePaths: [],
		passthrough: [],
		homedir: "/h",
		cwd: "/w",
	};
	const named = buildPiInvocation({ ...base, home: { mode: "path", dir: "/h/.gentle-shell/envs/work", source: "flag", env: "work" }, baseEnv: {} });
	assert.equal(ENV_NAME_ENV, "GENTLE_SHELL_ENV");
	assert.equal(named.env.GENTLE_SHELL_ENV, "work");
	const plain = buildPiInvocation({ ...base, home: { mode: "isolated", dir: "/h/.gentle-shell/agent", source: "default" }, baseEnv: { GENTLE_SHELL_ENV: "outer" } });
	assert.ok(!("GENTLE_SHELL_ENV" in plain.env), "an outer session's env name never reaches a different home");
});

test("activeEnvName accepts only a valid env name from the environment", async () => {
	const { activeEnvName } = await import("../lib/gentle-shell-envs.ts");
	assert.equal(activeEnvName({ GENTLE_SHELL_ENV: "work" }), "work");
	assert.equal(activeEnvName({}), undefined);
	assert.equal(activeEnvName({ GENTLE_SHELL_ENV: "" }), undefined);
	assert.equal(activeEnvName({ GENTLE_SHELL_ENV: "\x1b[31mevil" }), undefined);
});

test("resolveHome names an explicit --home that is an env in the envs root", () => {
	const dir = join("/h", ".gentle-shell", "envs", "work");
	const home = resolveHome({ args: parseLauncherArgs(["--home", dir]), env: {}, homedir: "/h", config: undefined });
	assert.equal(home.env, "work");
	assert.deepEqual(homeSelectorFlags(home), ["--env", "work"]);
	const other = resolveHome({ args: parseLauncherArgs(["--home", "/elsewhere/work"]), env: {}, homedir: "/h", config: undefined });
	assert.equal(other.env, undefined);
});

test("summarizeEnv reports whether the home was ever set up", () => {
	assert.equal(summarizeEnv({ name: "x", dir: "/e/x", isDefault: false, sessionCount: 0 }).setUp, false);
	assert.equal(summarizeEnv({ name: "x", dir: "/e/x", isDefault: false, sessionCount: 0, provisioned: { gentleAi: "1", at: "2026-01-01" } }).setUp, true);
});
