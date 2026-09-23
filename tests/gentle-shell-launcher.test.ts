import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	MIN_PI_VERSION,
	MIN_SETUP_GENTLE_AI_VERSION,
	PI_SUBCOMMANDS,
	buildPiInvocation,
	checkPeerVersionPin,
	checkPiVersion,
	decideTakeOver,
	describeVersion,
	discoverLooseExtensionEntries,
	findGentlePiDeclaration,
	forceJsonFieldIfAbsentInOriginal,
	helpText,
	homeSelectorFlags,
	isSetupCapablePin,
	launcherConfigPath,
	type LooseExtensionFsEntry,
	missingPiMessage,
	needsProvisioning,
	otherPackageInjections,
	parseLauncherArgs,
	parseLauncherConfig,
	parseRawLauncherConfig,
	planSpawn,
	postInstallRemovals,
	provisionedEntry,
	quoteForCmdExe,
	recordProvisioned,
	resolveHome,
	resolvePiRuntime,
	restoreJsonField,
	settingsDeclareGentlePi,
	shellQuote,
	type PackageJsonPeerShape,
	type ParsedLauncherArgs,
	type RawLauncherConfig,
	type ResolvedHome,
} from "../lib/gentle-shell-launcher.ts";

const packageRoot = join(fileURLToPath(import.meta.url), "..", "..");

// --- parseLauncherArgs -------------------------------------------------

test("parseLauncherArgs returns all-false defaults for an empty argv", () => {
	const parsed = parseLauncherArgs([]);
	assert.deepEqual(parsed, {
		link: false,
		isolated: false,
		home: undefined,
		packageRoot: undefined,
		help: false,
		version: false,
		command: undefined,
		commandArgs: [],
		passthrough: [],
		piSubcommand: undefined,
		error: undefined,
	});
});

test("parseLauncherArgs captures a --package-root value from the next argument", () => {
	assert.equal(parseLauncherArgs(["--package-root", "/custom/root"]).packageRoot, "/custom/root");
});

test("parseLauncherArgs captures a --package-root=<path> value", () => {
	assert.equal(parseLauncherArgs(["--package-root=/custom/root"]).packageRoot, "/custom/root");
});

test("parseLauncherArgs reports an error when --package-root has no value", () => {
	const parsed = parseLauncherArgs(["--package-root"]);
	assert.equal(parsed.packageRoot, undefined);
	assert.match(parsed.error ?? "", /--package-root/);
});

test("parseLauncherArgs reports an error when --package-root=<empty> has no value", () => {
	const parsed = parseLauncherArgs(["--package-root="]);
	assert.equal(parsed.packageRoot, undefined);
	assert.match(parsed.error ?? "", /--package-root/);
});

test("parseLauncherArgs sets link on --link", () => {
	assert.equal(parseLauncherArgs(["--link"]).link, true);
});

test("parseLauncherArgs sets isolated on --isolated", () => {
	assert.equal(parseLauncherArgs(["--isolated"]).isolated, true);
});

test("parseLauncherArgs captures a --home value from the next argument", () => {
	assert.equal(parseLauncherArgs(["--home", "/custom/path"]).home, "/custom/path");
});

test("parseLauncherArgs captures a --home=<path> value", () => {
	assert.equal(parseLauncherArgs(["--home=/custom/path"]).home, "/custom/path");
});

test("parseLauncherArgs reports an error when --home has no value", () => {
	const parsed = parseLauncherArgs(["--home"]);
	assert.equal(parsed.home, undefined);
	assert.match(parsed.error ?? "", /--home/);
});

test("parseLauncherArgs reports an error when --home=<empty> has no value", () => {
	const parsed = parseLauncherArgs(["--home="]);
	assert.equal(parsed.home, undefined);
	assert.match(parsed.error ?? "", /--home/);
});

test("parseLauncherArgs reports an error when a bare --home value is empty", () => {
	const parsed = parseLauncherArgs(["--home", ""]);
	assert.equal(parsed.home, undefined);
	assert.match(parsed.error ?? "", /--home/);
});

test("parseLauncherArgs sets help on --help and -h", () => {
	assert.equal(parseLauncherArgs(["--help"]).help, true);
	assert.equal(parseLauncherArgs(["-h"]).help, true);
});

test("parseLauncherArgs sets version on --version", () => {
	assert.equal(parseLauncherArgs(["--version"]).version, true);
});

test("parseLauncherArgs stops launcher parsing at -- and forwards the rest", () => {
	const parsed = parseLauncherArgs(["--isolated", "--", "--link", "--help"]);
	assert.equal(parsed.isolated, true);
	assert.equal(parsed.link, false);
	assert.equal(parsed.help, false);
	assert.deepEqual(parsed.passthrough, ["--link", "--help"]);
});

test("parseLauncherArgs forwards unrecognised arguments as passthrough, in order", () => {
	const parsed = parseLauncherArgs(["--mode", "rpc", "-p", "hi", "--resume"]);
	assert.deepEqual(parsed.passthrough, ["--mode", "rpc", "-p", "hi", "--resume"]);
});

test("parseLauncherArgs mixes launcher flags and passthrough while keeping passthrough order", () => {
	const parsed = parseLauncherArgs(["--isolated", "--mode", "rpc", "-p", "hi"]);
	assert.equal(parsed.isolated, true);
	assert.deepEqual(parsed.passthrough, ["--mode", "rpc", "-p", "hi"]);
});

test("parseLauncherArgs recognises the home subcommand as argv[0] and captures the rest as commandArgs", () => {
	const parsed = parseLauncherArgs(["home", "link"]);
	assert.equal(parsed.command, "home");
	assert.deepEqual(parsed.commandArgs, ["link"]);
	assert.deepEqual(parsed.passthrough, []);
});

test("parseLauncherArgs treats home as a plain passthrough token when it is not argv[0]", () => {
	const parsed = parseLauncherArgs(["--isolated", "home"]);
	assert.equal(parsed.command, undefined);
	assert.deepEqual(parsed.passthrough, ["home"]);
});

// --- setup subcommand ----------------------------------------------------
//
// Unlike `home`, `setup` is not restricted to argv[0]: it accepts the home
// selectors (--link, --isolated, --home <dir>) ahead of it, same as any pi
// subcommand would, since setup provisions whichever home those selectors
// resolve to.

test("parseLauncherArgs recognises setup as argv[0] and captures the rest as commandArgs", () => {
	const parsed = parseLauncherArgs(["setup"]);
	assert.equal(parsed.command, "setup");
	assert.deepEqual(parsed.commandArgs, []);
	assert.deepEqual(parsed.passthrough, []);
});

test("parseLauncherArgs recognises setup after a home selector and keeps the selector", () => {
	const parsed = parseLauncherArgs(["--isolated", "setup"]);
	assert.equal(parsed.command, "setup");
	assert.equal(parsed.isolated, true);
	assert.deepEqual(parsed.commandArgs, []);
});

test("parseLauncherArgs recognises setup after --home <dir> and forwards --dry-run as commandArgs", () => {
	const parsed = parseLauncherArgs(["--home", "/custom/path", "setup", "--dry-run"]);
	assert.equal(parsed.command, "setup");
	assert.equal(parsed.home, "/custom/path");
	assert.deepEqual(parsed.commandArgs, ["--dry-run"]);
});

test("parseLauncherArgs does not set piSubcommand for the setup launcher subcommand", () => {
	const parsed = parseLauncherArgs(["setup"]);
	assert.equal(parsed.command, "setup");
	assert.equal(parsed.piSubcommand, undefined);
});

test("parseLauncherArgs treats setup as a plain passthrough token once a pi subcommand already started", () => {
	const parsed = parseLauncherArgs(["install", "setup"]);
	assert.equal(parsed.command, undefined);
	assert.equal(parsed.piSubcommand, "install");
	assert.deepEqual(parsed.passthrough, ["install", "setup"]);
});

// --- pi subcommand passthrough (install/remove/uninstall/update/list/config/auth) ---

test("parseLauncherArgs recognises install as a pi subcommand and keeps it in passthrough", () => {
	const parsed = parseLauncherArgs(["install", "npm:x"]);
	assert.equal(parsed.piSubcommand, "install");
	assert.deepEqual(parsed.passthrough, ["install", "npm:x"]);
});

test("parseLauncherArgs recognises every pi subcommand", () => {
	for (const subcommand of PI_SUBCOMMANDS) {
		const parsed = parseLauncherArgs([subcommand]);
		assert.equal(parsed.piSubcommand, subcommand);
		assert.deepEqual(parsed.passthrough, [subcommand]);
	}
});

test("parseLauncherArgs keeps piSubcommand when a launcher flag precedes it", () => {
	const parsed = parseLauncherArgs(["--link", "install", "npm:x"]);
	assert.equal(parsed.link, true);
	assert.equal(parsed.piSubcommand, "install");
	assert.deepEqual(parsed.passthrough, ["install", "npm:x"]);
});

test("parseLauncherArgs does not set piSubcommand for the home launcher subcommand", () => {
	const parsed = parseLauncherArgs(["home", "link"]);
	assert.equal(parsed.command, "home");
	assert.equal(parsed.piSubcommand, undefined);
});

test("parseLauncherArgs does not treat an arbitrary prompt word as a pi subcommand", () => {
	const parsed = parseLauncherArgs(["hello"]);
	assert.equal(parsed.piSubcommand, undefined);
	assert.deepEqual(parsed.passthrough, ["hello"]);
});

test("parseLauncherArgs only recognises the first passthrough token as a pi subcommand", () => {
	const parsed = parseLauncherArgs(["hello", "install"]);
	assert.equal(parsed.piSubcommand, undefined);
	assert.deepEqual(parsed.passthrough, ["hello", "install"]);
});

test("parseLauncherArgs recognises a pi subcommand as the first token after --", () => {
	const parsed = parseLauncherArgs(["--", "install", "npm:x"]);
	assert.equal(parsed.piSubcommand, "install");
	assert.deepEqual(parsed.passthrough, ["install", "npm:x"]);
});

test("parseLauncherArgs errors when --link is combined with --isolated", () => {
	const parsed = parseLauncherArgs(["--link", "--isolated"]);
	assert.match(parsed.error ?? "", /--link/);
	assert.match(parsed.error ?? "", /--isolated/);
});

test("parseLauncherArgs errors when --link is combined with --home", () => {
	const parsed = parseLauncherArgs(["--link", "--home", "/custom"]);
	assert.match(parsed.error ?? "", /--link/);
	assert.match(parsed.error ?? "", /--home/);
});

test("parseLauncherArgs errors when --home is combined with --link regardless of order", () => {
	const parsed = parseLauncherArgs(["--home", "/custom", "--link"]);
	assert.match(parsed.error ?? "", /--link/);
});

test("parseLauncherArgs errors when --isolated is combined with --home", () => {
	const parsed = parseLauncherArgs(["--isolated", "--home", "/custom"]);
	assert.match(parsed.error ?? "", /--isolated/);
	assert.match(parsed.error ?? "", /--home/);
});

test("parseLauncherArgs errors when --home is combined with --isolated regardless of order", () => {
	const parsed = parseLauncherArgs(["--home", "/custom", "--isolated"]);
	assert.match(parsed.error ?? "", /--isolated/);
	assert.match(parsed.error ?? "", /--home/);
});

// --- resolveHome ---------------------------------------------------------

function args(overrides: Partial<ParsedLauncherArgs> = {}): ParsedLauncherArgs {
	return {
		link: false,
		isolated: false,
		home: undefined,
		packageRoot: undefined,
		help: false,
		version: false,
		command: undefined,
		commandArgs: [],
		passthrough: [],
		error: undefined,
		...overrides,
	};
}

test("resolveHome honours --link and reads PI_CODING_AGENT_DIR", () => {
	const resolved = resolveHome({
		args: args({ link: true }),
		env: { PI_CODING_AGENT_DIR: "/pi/agent" },
		homedir: "/home/alan",
		config: undefined,
	});
	assert.deepEqual(resolved, { mode: "link", dir: "/pi/agent", source: "flag" });
});

test("resolveHome falls back to <homedir>/.pi/agent for --link with no override", () => {
	const resolved = resolveHome({ args: args({ link: true }), env: {}, homedir: "/home/alan", config: undefined });
	assert.deepEqual(resolved, { mode: "link", dir: join("/home/alan", ".pi", "agent"), source: "flag" });
});

test("resolveHome honours --isolated and reads GENTLE_SHELL_HOME", () => {
	const resolved = resolveHome({
		args: args({ isolated: true }),
		env: { GENTLE_SHELL_HOME: "/custom/isolated" },
		homedir: "/home/alan",
		config: undefined,
	});
	assert.deepEqual(resolved, { mode: "isolated", dir: "/custom/isolated", source: "flag" });
});

test("resolveHome falls back to <homedir>/.gentle-shell/agent for --isolated with no override", () => {
	const resolved = resolveHome({ args: args({ isolated: true }), env: {}, homedir: "/home/alan", config: undefined });
	assert.deepEqual(resolved, { mode: "isolated", dir: join("/home/alan", ".gentle-shell", "agent"), source: "flag" });
});

test("resolveHome uses the --home value verbatim", () => {
	const resolved = resolveHome({ args: args({ home: "/explicit/path" }), env: {}, homedir: "/home/alan", config: undefined });
	assert.deepEqual(resolved, { mode: "path", dir: "/explicit/path", source: "flag" });
});

test("resolveHome falls back to a persisted link config", () => {
	const resolved = resolveHome({ args: args(), env: {}, homedir: "/home/alan", config: { mode: "link" } });
	assert.deepEqual(resolved, { mode: "link", dir: join("/home/alan", ".pi", "agent"), source: "config" });
});

test("resolveHome falls back to a persisted isolated config", () => {
	const resolved = resolveHome({ args: args(), env: {}, homedir: "/home/alan", config: { mode: "isolated" } });
	assert.deepEqual(resolved, { mode: "isolated", dir: join("/home/alan", ".gentle-shell", "agent"), source: "config" });
});

test("resolveHome falls back to a persisted path config", () => {
	const resolved = resolveHome({ args: args(), env: {}, homedir: "/home/alan", config: { mode: "path", dir: "/persisted/path" } });
	assert.deepEqual(resolved, { mode: "path", dir: "/persisted/path", source: "config" });
});

test("resolveHome defaults to isolated when neither a flag nor a config is present", () => {
	const resolved = resolveHome({ args: args(), env: {}, homedir: "/home/alan", config: undefined });
	assert.deepEqual(resolved, { mode: "isolated", dir: join("/home/alan", ".gentle-shell", "agent"), source: "default" });
});

test("resolveHome lets a flag override a persisted config", () => {
	const resolved = resolveHome({ args: args({ link: true }), env: {}, homedir: "/home/alan", config: { mode: "isolated" } });
	assert.equal(resolved.mode, "link");
	assert.equal(resolved.source, "flag");
});

// --- homeSelectorFlags -----------------------------------------------------

test("homeSelectorFlags reproduces --link for a link home", () => {
	assert.deepEqual(homeSelectorFlags({ mode: "link", dir: "/home/alan/.pi/agent", source: "flag" }), ["--link"]);
});

test("homeSelectorFlags reproduces --home <dir> for a path home", () => {
	assert.deepEqual(homeSelectorFlags({ mode: "path", dir: "/explicit/path", source: "flag" }), ["--home", "/explicit/path"]);
});

test("homeSelectorFlags is empty for the isolated default (no flags needed)", () => {
	assert.deepEqual(homeSelectorFlags({ mode: "isolated", dir: "/home/alan/.gentle-shell/agent", source: "default" }), []);
});

// --- launcherConfigPath / parseLauncherConfig -----------------------------

test("launcherConfigPath points at <homedir>/.gentle-shell/config.json", () => {
	assert.equal(launcherConfigPath("/home/alan"), join("/home/alan", ".gentle-shell", "config.json"));
});

test("parseLauncherConfig accepts a link config", () => {
	assert.deepEqual(parseLauncherConfig('{"home":"link"}'), { mode: "link" });
});

test("parseLauncherConfig accepts an isolated config", () => {
	assert.deepEqual(parseLauncherConfig('{"home":"isolated"}'), { mode: "isolated" });
});

test("parseLauncherConfig accepts a path config", () => {
	assert.deepEqual(parseLauncherConfig('{"home":"/custom/path"}'), { mode: "path", dir: "/custom/path" });
});

test("parseLauncherConfig treats any non-link/isolated string as a path, including a near-miss like 'linked'", () => {
	assert.deepEqual(parseLauncherConfig('{"home":"linked"}'), { mode: "path", dir: "linked" });
});

test("parseLauncherConfig tolerates invalid JSON", () => {
	assert.equal(parseLauncherConfig("not json"), undefined);
});

test("parseLauncherConfig tolerates a missing home field", () => {
	assert.equal(parseLauncherConfig("{}"), undefined);
});

test("parseLauncherConfig tolerates a non-object document", () => {
	assert.equal(parseLauncherConfig("[]"), undefined);
	assert.equal(parseLauncherConfig('"link"'), undefined);
});

test("parseLauncherConfig tolerates a non-string home value", () => {
	assert.equal(parseLauncherConfig('{"home":1}'), undefined);
});

test("parseLauncherConfig tolerates an empty home value", () => {
	assert.equal(parseLauncherConfig('{"home":""}'), undefined);
});

// --- parseRawLauncherConfig / provisionedEntry / needsProvisioning / recordProvisioned (S7) ---
//
// Unlike parseLauncherConfig's discriminated LauncherConfig (home mode only),
// these operate on the full raw config.json object so a write never drops a
// key (like a sibling home's provisioned marker) it does not itself
// understand.

test("parseRawLauncherConfig returns an empty object for a missing file", () => {
	assert.deepEqual(parseRawLauncherConfig(undefined), {});
});

test("parseRawLauncherConfig tolerates invalid JSON and non-object documents", () => {
	assert.deepEqual(parseRawLauncherConfig("not json"), {});
	assert.deepEqual(parseRawLauncherConfig("[]"), {});
	assert.deepEqual(parseRawLauncherConfig('"link"'), {});
});

test("parseRawLauncherConfig preserves every key, not just home", () => {
	assert.deepEqual(parseRawLauncherConfig('{"home":"link","provisioned":{"/a":{"gentleAi":"3.6.0","at":"2026-09-22T00:00:00.000Z"}}}'), {
		home: "link",
		provisioned: { "/a": { gentleAi: "3.6.0", at: "2026-09-22T00:00:00.000Z" } },
	});
});

test("provisionedEntry is undefined for a home with no marker", () => {
	assert.equal(provisionedEntry({}, "/home/alan/.gentle-shell/agent"), undefined);
});

test("provisionedEntry returns the stored record for a matching home", () => {
	const config: RawLauncherConfig = { provisioned: { "/a": { gentleAi: "3.6.0", at: "2026-09-22T00:00:00.000Z" } } };
	assert.deepEqual(provisionedEntry(config, "/a"), { gentleAi: "3.6.0", at: "2026-09-22T00:00:00.000Z" });
});

test("provisionedEntry tolerates a malformed provisioned map (non-object, missing fields)", () => {
	assert.equal(provisionedEntry({ provisioned: "nope" } as unknown as RawLauncherConfig, "/a"), undefined);
	assert.equal(provisionedEntry({ provisioned: { "/a": { gentleAi: "3.6.0" } } } as unknown as RawLauncherConfig, "/a"), undefined);
});

test("needsProvisioning is true for a home with no marker", () => {
	assert.equal(needsProvisioning({}, "/a", "3.6.0", "3.5.1"), true);
});

test("needsProvisioning is true when the marker's pin differs from the current pin", () => {
	const config: RawLauncherConfig = { provisioned: { "/a": { gentleAi: "3.6.0", gentlePi: "3.5.1", at: "2026-09-22T00:00:00.000Z" } } };
	assert.equal(needsProvisioning(config, "/a", "3.6.1", "3.5.1"), true);
});

test("needsProvisioning is false when the marker's pin and gentle-pi version both match the current ones", () => {
	const config: RawLauncherConfig = { provisioned: { "/a": { gentleAi: "3.6.0", gentlePi: "3.5.1", at: "2026-09-22T00:00:00.000Z" } } };
	assert.equal(needsProvisioning(config, "/a", "3.6.0", "3.5.1"), false);
});

// A marker written before gentle-pi version tracking existed (S8) has no
// `gentlePi` field at all; that omission must never equal a real running
// version, so it always counts as needing provisioning even though the
// gentle-ai pin itself still matches.
test("needsProvisioning is true when the marker predates gentle-pi version tracking (no gentlePi field)", () => {
	const config: RawLauncherConfig = { provisioned: { "/a": { gentleAi: "3.6.0", at: "2026-09-22T00:00:00.000Z" } } };
	assert.equal(needsProvisioning(config, "/a", "3.6.0", "3.5.1"), true);
});

test("needsProvisioning is true when the marker's gentle-pi version differs from the running one, even though the pin matches", () => {
	const config: RawLauncherConfig = { provisioned: { "/a": { gentleAi: "3.6.0", gentlePi: "3.5.0", at: "2026-09-22T00:00:00.000Z" } } };
	assert.equal(needsProvisioning(config, "/a", "3.6.0", "3.5.1"), true);
});

test("recordProvisioned adds a marker (gentleAi, gentlePi, at) and preserves every other key, including other homes", () => {
	const config: RawLauncherConfig = {
		home: "isolated",
		provisioned: { "/other": { gentleAi: "3.5.0", gentlePi: "3.4.0", at: "2026-01-01T00:00:00.000Z" } },
	};
	const updated = recordProvisioned(config, "/a", "3.6.0", "3.5.1", "2026-09-22T00:00:00.000Z");
	assert.deepEqual(updated, {
		home: "isolated",
		provisioned: {
			"/other": { gentleAi: "3.5.0", gentlePi: "3.4.0", at: "2026-01-01T00:00:00.000Z" },
			"/a": { gentleAi: "3.6.0", gentlePi: "3.5.1", at: "2026-09-22T00:00:00.000Z" },
		},
	});
	// Returns a new object; never mutates the input.
	assert.deepEqual(config, {
		home: "isolated",
		provisioned: { "/other": { gentleAi: "3.5.0", gentlePi: "3.4.0", at: "2026-01-01T00:00:00.000Z" } },
	});
});

test("recordProvisioned overwrites an existing marker for the same home", () => {
	const config: RawLauncherConfig = { provisioned: { "/a": { gentleAi: "3.6.0", gentlePi: "3.5.0", at: "2026-01-01T00:00:00.000Z" } } };
	const updated = recordProvisioned(config, "/a", "3.6.1", "3.5.1", "2026-09-22T00:00:00.000Z");
	assert.deepEqual(updated, { provisioned: { "/a": { gentleAi: "3.6.1", gentlePi: "3.5.1", at: "2026-09-22T00:00:00.000Z" } } });
});

// --- resolvePiRuntime ------------------------------------------------------

test("resolvePiRuntime prefers GENTLE_SHELL_PI over every other source", () => {
	const runtime = resolvePiRuntime({
		env: { GENTLE_SHELL_PI: "/opt/pi/pi" },
		resolveBundledCli: () => "/bundled/cli.js",
		findOnPath: () => "/usr/bin/pi",
		nodeExecPath: "/usr/bin/node",
	});
	assert.deepEqual(runtime, { kind: "env", command: "/opt/pi/pi", args: [] });
});

test("resolvePiRuntime falls back to the bundled CLI run with the current node", () => {
	const runtime = resolvePiRuntime({
		env: {},
		resolveBundledCli: () => "/bundled/cli.js",
		findOnPath: () => "/usr/bin/pi",
		nodeExecPath: "/usr/bin/node",
	});
	assert.deepEqual(runtime, { kind: "bundled", command: "/usr/bin/node", args: ["/bundled/cli.js"] });
});

test("resolvePiRuntime falls back to pi on PATH when nothing else resolves", () => {
	const runtime = resolvePiRuntime({
		env: {},
		resolveBundledCli: () => undefined,
		findOnPath: (name) => (name === "pi" ? "/usr/bin/pi" : undefined),
		nodeExecPath: "/usr/bin/node",
	});
	assert.deepEqual(runtime, { kind: "path", command: "/usr/bin/pi", args: [] });
});

test("resolvePiRuntime returns undefined when no source resolves", () => {
	const runtime = resolvePiRuntime({
		env: {},
		resolveBundledCli: () => undefined,
		findOnPath: () => undefined,
		nodeExecPath: "/usr/bin/node",
	});
	assert.equal(runtime, undefined);
});

test("resolvePiRuntime treats an empty GENTLE_SHELL_PI as unset", () => {
	const runtime = resolvePiRuntime({
		env: { GENTLE_SHELL_PI: "" },
		resolveBundledCli: () => "/bundled/cli.js",
		findOnPath: () => undefined,
		nodeExecPath: "/usr/bin/node",
	});
	assert.deepEqual(runtime, { kind: "bundled", command: "/usr/bin/node", args: ["/bundled/cli.js"] });
});

test("missingPiMessage names the three resolution options", () => {
	const message = missingPiMessage();
	assert.match(message, /GENTLE_SHELL_PI/);
	assert.match(message, /@earendil-works\/pi-coding-agent/);
	assert.match(message, /PATH/);
});

// --- checkPiVersion ---------------------------------------------------------

test("MIN_PI_VERSION matches the pinned peer dependency, so the two cannot drift", () => {
	const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as PackageJsonPeerShape;
	const result = checkPeerVersionPin(packageJson, "@earendil-works/pi-coding-agent", MIN_PI_VERSION);
	if (result.ok) return;
	assert.equal(result.ok, false);
	assert.fail(result.message);
});

// --- checkPeerVersionPin ------------------------------------------------------
// The drift-guard test above must fail with a clear assertion message, not a
// raw TypeError from indexing an undefined peerDependencies block or entry.
// These tests exercise that failure path directly against synthetic input,
// since a real, well-formed package.json cannot exercise it.

test("checkPeerVersionPin reports a missing peerDependencies block clearly", () => {
	const result = checkPeerVersionPin({}, "@earendil-works/pi-coding-agent", MIN_PI_VERSION);
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("expected a failing result");
	assert.match(result.message, /peerDependencies/);
});

test("checkPeerVersionPin reports a missing peer entry clearly", () => {
	const result = checkPeerVersionPin({ peerDependencies: {} }, "@earendil-works/pi-coding-agent", MIN_PI_VERSION);
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("expected a failing result");
	assert.match(result.message, /@earendil-works\/pi-coding-agent/);
});

test("checkPeerVersionPin reports a malformed peer range clearly", () => {
	const result = checkPeerVersionPin(
		{ peerDependencies: { "@earendil-works/pi-coding-agent": "^0.85.1" } },
		"@earendil-works/pi-coding-agent",
		MIN_PI_VERSION,
	);
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("expected a failing result");
	assert.match(result.message, />=x\.y\.z/);
});

test("checkPeerVersionPin reports a mismatched minimum clearly", () => {
	const result = checkPeerVersionPin(
		{ peerDependencies: { "@earendil-works/pi-coding-agent": ">=0.80.0" } },
		"@earendil-works/pi-coding-agent",
		MIN_PI_VERSION,
	);
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("expected a failing result");
	assert.match(result.message, /0\.80\.0/);
	assert.match(result.message, new RegExp(MIN_PI_VERSION.replace(/\./g, "\\.")));
});

test("checkPeerVersionPin passes for a matching pin", () => {
	const result = checkPeerVersionPin({ peerDependencies: { "@earendil-works/pi-coding-agent": ">=0.85.1" } }, "@earendil-works/pi-coding-agent", "0.85.1");
	assert.deepEqual(result, { ok: true, pinned: ">=0.85.1" });
});

test("checkPiVersion accepts a version equal to the minimum", () => {
	assert.deepEqual(checkPiVersion("0.85.1"), { ok: true, version: "0.85.1" });
});

test("checkPiVersion accepts a version above the minimum", () => {
	assert.deepEqual(checkPiVersion("0.86.0"), { ok: true, version: "0.86.0" });
});

test("checkPiVersion accepts a v-prefixed version", () => {
	assert.deepEqual(checkPiVersion("v0.85.1"), { ok: true, version: "0.85.1" });
});

test("checkPiVersion accepts a prerelease suffix at the minimum", () => {
	assert.deepEqual(checkPiVersion("pi version 0.85.1-rc.2"), { ok: true, version: "0.85.1" });
});

test("checkPiVersion rejects a version below the minimum and names both versions", () => {
	const result = checkPiVersion("0.85.0");
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("expected a failing result");
	assert.equal(result.version, "0.85.0");
	assert.match(result.message, /0\.85\.0/);
	assert.match(result.message, /0\.85\.1/);
});

test("checkPiVersion rejects a prerelease below the minimum", () => {
	const result = checkPiVersion("0.85.0-beta.1");
	assert.equal(result.ok, false);
});

test("checkPiVersion reports unparsable output with the raw text and the minimum", () => {
	const result = checkPiVersion("  not a version  ");
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("expected a failing result");
	assert.equal(result.version, undefined);
	assert.match(result.message, /not a version/);
	assert.match(result.message, /0\.85\.1/);
});

test("checkPiVersion accepts a custom minimum", () => {
	assert.equal(checkPiVersion("1.0.0", "1.1.0").ok, false);
	assert.equal(checkPiVersion("1.1.0", "1.1.0").ok, true);
	assert.equal(checkPiVersion("1.2.0", "1.1.0").ok, true);
});

// --- isSetupCapablePin -------------------------------------------------------
// `gentle-shell setup` provisions a home through the package-local pinned
// gentle-ai binary by pointing PI_CODING_AGENT_DIR at that home; only
// gentle-ai >= 3.6.0 honors that variable in its own `install --agent pi`
// provisioning. An older pin would silently provision the caller's real
// ~/.pi/agent instead, so setup must refuse to spawn it.

test("MIN_SETUP_GENTLE_AI_VERSION is 3.6.0", () => {
	assert.equal(MIN_SETUP_GENTLE_AI_VERSION, "3.6.0");
});

test("isSetupCapablePin accepts a version equal to the minimum", () => {
	assert.equal(isSetupCapablePin("3.6.0"), true);
});

test("isSetupCapablePin accepts a version above the minimum", () => {
	assert.equal(isSetupCapablePin("3.6.1"), true);
	assert.equal(isSetupCapablePin("4.0.0"), true);
});

test("isSetupCapablePin rejects a version below the minimum", () => {
	assert.equal(isSetupCapablePin("3.5.1"), false);
	assert.equal(isSetupCapablePin("3.5.9"), false);
});

test("isSetupCapablePin accepts a v-prefixed version", () => {
	assert.equal(isSetupCapablePin("v3.6.0"), true);
});

test("isSetupCapablePin rejects unparsable input", () => {
	assert.equal(isSetupCapablePin("not a version"), false);
});

test("isSetupCapablePin accepts a custom minimum", () => {
	assert.equal(isSetupCapablePin("2.0.0", "2.1.0"), false);
	assert.equal(isSetupCapablePin("2.1.0", "2.1.0"), true);
});

// --- settingsDeclareGentlePi ------------------------------------------------

test("settingsDeclareGentlePi is false when settings text is undefined", () => {
	assert.equal(settingsDeclareGentlePi(undefined), false);
});

test("settingsDeclareGentlePi is false for invalid JSON", () => {
	assert.equal(settingsDeclareGentlePi("not json"), false);
});

test("settingsDeclareGentlePi is false when packages is absent", () => {
	assert.equal(settingsDeclareGentlePi("{}"), false);
});

test("settingsDeclareGentlePi detects a bare npm:gentle-pi string entry", () => {
	assert.equal(settingsDeclareGentlePi('{"packages":["npm:gentle-pi"]}'), true);
});

test("settingsDeclareGentlePi detects a versioned npm:gentle-pi string entry", () => {
	assert.equal(settingsDeclareGentlePi('{"packages":["npm:gentle-pi@3.3.0"]}'), true);
});

test("settingsDeclareGentlePi detects a bare npm:gentle-pi object source entry", () => {
	assert.equal(settingsDeclareGentlePi('{"packages":[{"source":"npm:gentle-pi"}]}'), true);
});

test("settingsDeclareGentlePi detects a versioned npm:gentle-pi object source entry", () => {
	assert.equal(settingsDeclareGentlePi('{"packages":[{"source":"npm:gentle-pi@3.3.0"}]}'), true);
});

test("settingsDeclareGentlePi is false when packages lists unrelated entries", () => {
	assert.equal(settingsDeclareGentlePi('{"packages":["npm:some-other-package"]}'), false);
});

test("settingsDeclareGentlePi is false for a path package entry, even one that resolves to gentle-pi on disk", () => {
	// The compat wrapper never reads the filesystem: it only recognises npm
	// declarations, matching its pre-existing behaviour before path detection
	// was added via findGentlePiDeclaration.
	assert.equal(settingsDeclareGentlePi('{"packages":["../../work/gentle-pi"]}'), false);
});

// --- postInstallRemovals -----------------------------------------------
//
// gentle-ai's managed Pi stack (gentle-ai #4820, gentle-shell #1277) still
// installs npm:@juicesharp/rpiv-ask-user-question, which conflicts with
// gentle-pi's own first-party ask_user_question tool: Pi refuses two
// providers for the same tool name. It also always declares npm:gentle-pi
// itself, which must never stay in the home's settings.json: this launcher
// always loads its own gentle-pi, so leaving that declaration in place would
// let the home drift onto whatever gentle-pi npm installed instead. This
// pure helper tells `gentle-shell setup` which declared packages it must
// remove after provisioning a home, for either reason.

test("postInstallRemovals is empty when settings text is undefined", () => {
	assert.deepEqual(postInstallRemovals(undefined), []);
});

test("postInstallRemovals is empty for invalid JSON", () => {
	assert.deepEqual(postInstallRemovals("not json"), []);
});

test("postInstallRemovals is empty when packages is absent", () => {
	assert.deepEqual(postInstallRemovals("{}"), []);
});

test("postInstallRemovals detects a bare npm:@juicesharp/rpiv-ask-user-question string entry", () => {
	assert.deepEqual(postInstallRemovals('{"packages":["npm:@juicesharp/rpiv-ask-user-question"]}'), ["npm:@juicesharp/rpiv-ask-user-question"]);
});

test("postInstallRemovals detects a versioned entry and returns the canonical unversioned source", () => {
	assert.deepEqual(postInstallRemovals('{"packages":["npm:@juicesharp/rpiv-ask-user-question@1.2.3"]}'), [
		"npm:@juicesharp/rpiv-ask-user-question",
	]);
});

test("postInstallRemovals detects a versioned object source entry", () => {
	assert.deepEqual(postInstallRemovals('{"packages":[{"source":"npm:@juicesharp/rpiv-ask-user-question@1.2.3"}]}'), [
		"npm:@juicesharp/rpiv-ask-user-question",
	]);
});

test("postInstallRemovals detects npm:gentle-pi at any version, alongside an unrelated package", () => {
	assert.deepEqual(postInstallRemovals('{"packages":["npm:gentle-pi@3.5.1","npm:some-other-package"]}'), ["npm:gentle-pi"]);
});

test("postInstallRemovals dedupes a duplicated declaration and preserves declaration order", () => {
	const settingsText =
		'{"packages":["npm:gentle-pi@1.0.0","npm:@juicesharp/rpiv-ask-user-question@1.0.0","npm:@juicesharp/rpiv-ask-user-question@2.0.0"]}';
	assert.deepEqual(postInstallRemovals(settingsText), ["npm:gentle-pi", "npm:@juicesharp/rpiv-ask-user-question"]);
});

test("postInstallRemovals ignores a path entry that happens to share the package name", () => {
	assert.deepEqual(postInstallRemovals('{"packages":["./local-ask-user-question"]}'), []);
	assert.deepEqual(postInstallRemovals('{"packages":["./local-gentle-pi"]}'), []);
});

// --- findGentlePiDeclaration -------------------------------------------------

function readPackageNameStub(names: Record<string, string | undefined>) {
	return (dir: string) => names[dir];
}

test("findGentlePiDeclaration is undefined when settings text is undefined", () => {
	assert.equal(findGentlePiDeclaration(undefined, { agentDir: "/agent", readPackageName: () => undefined }), undefined);
});

test("findGentlePiDeclaration is undefined for invalid JSON", () => {
	assert.equal(findGentlePiDeclaration("not json", { agentDir: "/agent", readPackageName: () => undefined }), undefined);
});

test("findGentlePiDeclaration is undefined when packages is absent", () => {
	assert.equal(findGentlePiDeclaration("{}", { agentDir: "/agent", readPackageName: () => undefined }), undefined);
});

test("findGentlePiDeclaration detects a bare npm:gentle-pi string entry", () => {
	const result = findGentlePiDeclaration('{"packages":["npm:gentle-pi"]}', { agentDir: "/agent", readPackageName: () => undefined });
	assert.deepEqual(result, { kind: "npm" });
});

test("findGentlePiDeclaration detects a versioned npm:gentle-pi string entry", () => {
	const result = findGentlePiDeclaration('{"packages":["npm:gentle-pi@3.3.0"]}', { agentDir: "/agent", readPackageName: () => undefined });
	assert.deepEqual(result, { kind: "npm" });
});

test("findGentlePiDeclaration detects a bare npm:gentle-pi object source entry", () => {
	const result = findGentlePiDeclaration('{"packages":[{"source":"npm:gentle-pi"}]}', { agentDir: "/agent", readPackageName: () => undefined });
	assert.deepEqual(result, { kind: "npm" });
});

test("findGentlePiDeclaration recognises a relative path entry whose package.json name is gentle-pi", () => {
	const resolvedDir = join("/agent", "..", "..", "work", "gentle-pi");
	const result = findGentlePiDeclaration('{"packages":["../../work/gentle-pi"]}', {
		agentDir: "/agent",
		readPackageName: readPackageNameStub({ [resolvedDir]: "gentle-pi" }),
	});
	assert.deepEqual(result, { kind: "path", dir: resolvedDir });
});

test("findGentlePiDeclaration recognises an absolute path entry whose package.json name is gentle-pi", () => {
	const result = findGentlePiDeclaration('{"packages":["/checkouts/gentle-pi"]}', {
		agentDir: "/agent",
		readPackageName: readPackageNameStub({ "/checkouts/gentle-pi": "gentle-pi" }),
	});
	assert.deepEqual(result, { kind: "path", dir: "/checkouts/gentle-pi" });
});

test("findGentlePiDeclaration recognises a path object source entry whose package.json name is gentle-pi", () => {
	const result = findGentlePiDeclaration('{"packages":[{"source":"../gentle-pi","extensions":[]}]}', {
		agentDir: "/agent",
		readPackageName: readPackageNameStub({ [join("/agent", "..", "gentle-pi")]: "gentle-pi" }),
	});
	assert.deepEqual(result, { kind: "path", dir: join("/agent", "..", "gentle-pi") });
});

test("findGentlePiDeclaration is undefined for a path entry whose package.json name is not gentle-pi", () => {
	const resolvedDir = join("/agent", "..", "..", "work", "engram", "plugin", "pi");
	const result = findGentlePiDeclaration('{"packages":["../../work/engram/plugin/pi"]}', {
		agentDir: "/agent",
		readPackageName: readPackageNameStub({ [resolvedDir]: "engram" }),
	});
	assert.equal(result, undefined);
});

test("findGentlePiDeclaration is undefined for a path entry with no readable package.json", () => {
	const result = findGentlePiDeclaration('{"packages":["../gentle-pi"]}', { agentDir: "/agent", readPackageName: () => undefined });
	assert.equal(result, undefined);
});

test("findGentlePiDeclaration ignores git and URL entries when looking for a path declaration", () => {
	const result = findGentlePiDeclaration('{"packages":["git:github.com/foo/gentle-pi","https://github.com/foo/gentle-pi"]}', {
		agentDir: "/agent",
		readPackageName: () => "gentle-pi",
	});
	assert.equal(result, undefined);
});

test("findGentlePiDeclaration is undefined when packages lists unrelated entries", () => {
	const result = findGentlePiDeclaration('{"packages":["npm:some-other-package"]}', { agentDir: "/agent", readPackageName: () => undefined });
	assert.equal(result, undefined);
});

test("findGentlePiDeclaration returns the first matching declaration, path or npm, in list order", () => {
	const result = findGentlePiDeclaration('{"packages":["../gentle-pi","npm:gentle-pi"]}', {
		agentDir: "/agent",
		readPackageName: readPackageNameStub({ [join("/agent", "..", "gentle-pi")]: "gentle-pi" }),
	});
	assert.deepEqual(result, { kind: "path", dir: join("/agent", "..", "gentle-pi") });
});

// --- decideTakeOver -----------------------------------------------------------

test("decideTakeOver is false when there is no declaration and --package-root was not requested", () => {
	assert.equal(
		decideTakeOver({ declaration: undefined, realPackageRoot: "/pkg", packageRootExplicit: false }),
		false,
	);
});

test("decideTakeOver is false for an npm declaration matching the launcher's own install", () => {
	assert.equal(
		decideTakeOver({ declaration: { kind: "npm" }, realPackageRoot: "/pkg", packageRootExplicit: false }),
		false,
	);
});

test("decideTakeOver is true when a path declaration's real directory differs from the real package root", () => {
	assert.equal(
		decideTakeOver({
			declaration: { kind: "path", dir: "/other/checkout" },
			realPackageRoot: "/pkg",
			realDeclaredDir: "/other/checkout",
			packageRootExplicit: false,
		}),
		true,
	);
});

test("decideTakeOver is false when a path declaration's real directory equals the real package root", () => {
	assert.equal(
		decideTakeOver({
			declaration: { kind: "path", dir: "/pkg-symlink" },
			realPackageRoot: "/pkg",
			realDeclaredDir: "/pkg",
			packageRootExplicit: false,
		}),
		false,
	);
});

test("decideTakeOver is true when --package-root is explicitly requested, even for a matching npm declaration", () => {
	assert.equal(
		decideTakeOver({ declaration: { kind: "npm" }, realPackageRoot: "/pkg", packageRootExplicit: true }),
		true,
	);
});

test("decideTakeOver is true when --package-root is explicitly requested and there is no declaration", () => {
	assert.equal(
		decideTakeOver({ declaration: undefined, realPackageRoot: "/pkg", packageRootExplicit: true }),
		true,
	);
});

// --- otherPackageInjections ---------------------------------------------------

test("otherPackageInjections resolves an npm entry to <agentDir>/npm/node_modules/<name>", () => {
	const result = otherPackageInjections({
		settingsText: '{"packages":["npm:some-other","npm:gentle-pi"]}',
		agentDir: "/agent",
		skip: { kind: "npm" },
	});
	assert.deepEqual(result.paths, [join("/agent", "npm", "node_modules", "some-other")]);
	assert.deepEqual(result.warnings, []);
});

test("otherPackageInjections extracts a scoped and versioned npm package name", () => {
	const result = otherPackageInjections({
		settingsText: '{"packages":["npm:@scope/pkg@1.2.3","npm:gentle-pi"]}',
		agentDir: "/agent",
		skip: { kind: "npm" },
	});
	assert.deepEqual(result.paths, [join("/agent", "npm", "node_modules", "@scope/pkg")]);
});

test("otherPackageInjections resolves a path entry relative to agentDir", () => {
	const result = otherPackageInjections({
		settingsText: '{"packages":["../../work/pi-qwen-ambassador","npm:gentle-pi"]}',
		agentDir: "/agent",
		skip: { kind: "npm" },
	});
	assert.deepEqual(result.paths, [join("/agent", "..", "..", "work", "pi-qwen-ambassador")]);
});

test("otherPackageInjections skips a git entry and warns", () => {
	const result = otherPackageInjections({
		settingsText: '{"packages":["git:github.com/foo/bar","npm:gentle-pi"]}',
		agentDir: "/agent",
		skip: { kind: "npm" },
	});
	assert.deepEqual(result.paths, []);
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0], /git:github\.com\/foo\/bar/);
});

test("otherPackageInjections warns for an object entry with extensions or autoload filters but still includes it", () => {
	const result = otherPackageInjections({
		settingsText: '{"packages":[{"source":"npm:filtered","extensions":["a.ts"]},"npm:gentle-pi"]}',
		agentDir: "/agent",
		skip: { kind: "npm" },
	});
	assert.deepEqual(result.paths, [join("/agent", "npm", "node_modules", "filtered")]);
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0], /filtered/);
});

test("otherPackageInjections skips the entry matching a path declaration being taken over", () => {
	const declaredDir = join("/agent", "..", "..", "work", "gentle-pi");
	const result = otherPackageInjections({
		settingsText: '{"packages":["npm:some-other","../../work/gentle-pi"]}',
		agentDir: "/agent",
		skip: { kind: "path", dir: declaredDir },
	});
	assert.deepEqual(result.paths, [join("/agent", "npm", "node_modules", "some-other")]);
});

test("otherPackageInjections tolerates undefined or malformed settings text", () => {
	assert.deepEqual(otherPackageInjections({ settingsText: undefined, agentDir: "/agent", skip: { kind: "npm" } }), { paths: [], warnings: [] });
	assert.deepEqual(otherPackageInjections({ settingsText: "not json", agentDir: "/agent", skip: { kind: "npm" } }), { paths: [], warnings: [] });
});

test("otherPackageInjections skips every gentle-pi entry, not only the one matching the declaration kind", () => {
	const declaredDir = join("/agent", "..", "..", "work", "gentle-pi");
	const result = otherPackageInjections({
		// The declaration being taken over is the path entry, but settings
		// also carries a second, unrelated npm:gentle-pi entry: both must be
		// excluded, not just the one matching skip.kind, or the npm entry
		// would get re-injected as an "other package" and double-load gentle-pi.
		settingsText: '{"packages":["npm:some-other","../../work/gentle-pi","npm:gentle-pi"]}',
		agentDir: "/agent",
		skip: { kind: "path", dir: declaredDir },
	});
	assert.deepEqual(result.paths, [join("/agent", "npm", "node_modules", "some-other")]);
	assert.deepEqual(result.warnings, []);
});

test("otherPackageInjections skips a duplicate npm:gentle-pi entry when the declaration being taken over is itself npm", () => {
	const result = otherPackageInjections({
		settingsText: '{"packages":["npm:some-other","npm:gentle-pi","npm:gentle-pi@1.2.3"]}',
		agentDir: "/agent",
		skip: { kind: "npm" },
	});
	assert.deepEqual(result.paths, [join("/agent", "npm", "node_modules", "some-other")]);
});

// R3-001/R4-takeover-injects-unverified-package-dirs: a declared-but-missing
// package directory must never be handed to pi as -e (it fails at pi startup
// with "Cannot find module"); it is filtered the same way loose extension
// candidates are, via an injectable isDirectory predicate so this function
// stays pure and unit-testable without a real filesystem.

test("otherPackageInjections omits a declared package directory that isDirectory reports missing, and warns", () => {
	const result = otherPackageInjections({
		settingsText: '{"packages":["npm:missing-pkg","npm:gentle-pi"]}',
		agentDir: "/agent",
		skip: { kind: "npm" },
		isDirectory: () => false,
	});
	assert.deepEqual(result.paths, []);
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0], /skipping declared package/);
	assert.match(result.warnings[0], /"npm:missing-pkg"/);
	assert.match(result.warnings[0], /is not a directory/);
});

test("otherPackageInjections keeps a declared package directory that isDirectory reports present", () => {
	const result = otherPackageInjections({
		settingsText: '{"packages":["npm:installed-pkg","npm:gentle-pi"]}',
		agentDir: "/agent",
		skip: { kind: "npm" },
		isDirectory: (dir) => dir === join("/agent", "npm", "node_modules", "installed-pkg"),
	});
	assert.deepEqual(result.paths, [join("/agent", "npm", "node_modules", "installed-pkg")]);
	assert.deepEqual(result.warnings, []);
});

test("otherPackageInjections excludes a settings path entry that resolves via realpath to the same physical directory as a realpath'd skip (R4-forced-root-symlink-double-injection)", () => {
	const linkOtherDir = join("/agent", "link-other");
	const result = otherPackageInjections({
		settingsText: '{"packages":["link-other","npm:some-other"]}',
		agentDir: "/agent",
		// skip.dir mirrors bin/gentle-shell.mjs's --package-root case, where
		// it is already the realpath of the effective package root.
		skip: { kind: "path", dir: "/real/other" },
		realpath: (dir) => (dir === linkOtherDir ? "/real/other" : dir),
	});
	assert.deepEqual(result.paths, [join("/agent", "npm", "node_modules", "some-other")]);
	assert.deepEqual(result.warnings, []);
});

test("otherPackageInjections keeps comparing raw strings when no realpath resolver is provided (default stays pure)", () => {
	const result = otherPackageInjections({
		settingsText: '{"packages":["link-other","npm:some-other"]}',
		agentDir: "/agent",
		skip: { kind: "path", dir: "/real/other" },
	});
	assert.deepEqual(result.paths, [join("/agent", "link-other"), join("/agent", "npm", "node_modules", "some-other")]);
});

test("otherPackageInjections defaults to including every declared package when isDirectory is not provided (existing callers keep pure string resolution)", () => {
	const result = otherPackageInjections({
		settingsText: '{"packages":["npm:some-other","npm:gentle-pi"]}',
		agentDir: "/agent",
		skip: { kind: "npm" },
	});
	assert.deepEqual(result.paths, [join("/agent", "npm", "node_modules", "some-other")]);
	assert.deepEqual(result.warnings, []);
});

// --- buildPiInvocation -------------------------------------------------------

const linkHome: ResolvedHome = { mode: "link", dir: "/pi/agent", source: "flag" };
const isolatedHomeResolved: ResolvedHome = { mode: "isolated", dir: "/gentle-shell/agent", source: "default" };

test("buildPiInvocation injects the launcher env into baseEnv", () => {
	const built = buildPiInvocation({
		runtime: { kind: "path", command: "/usr/bin/pi", args: [] },
		home: linkHome,
		packageRoot: "/pkg",
		declaration: { kind: "npm" },
		takeOver: false,
		otherPackagePaths: [],
		passthrough: [],
		baseEnv: { PATH: "/usr/bin" },
	});
	assert.deepEqual(built.env, { PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/pi/agent", GENTLE_PI_AGENT_HOME: "/pi/agent" });
});

test("buildPiInvocation skips injection when there is a declaration and no takeover (npm matches the launcher's own install)", () => {
	const built = buildPiInvocation({
		runtime: { kind: "path", command: "/usr/bin/pi", args: [] },
		home: linkHome,
		packageRoot: "/pkg",
		declaration: { kind: "npm" },
		takeOver: false,
		otherPackagePaths: [],
		passthrough: ["--mode", "rpc"],
		baseEnv: {},
	});
	assert.deepEqual(built.command, "/usr/bin/pi");
	assert.deepEqual(built.args, ["--mode", "rpc"]);
});

test("buildPiInvocation adds the gentle-pi injection flags when there is no declaration", () => {
	const built = buildPiInvocation({
		runtime: { kind: "path", command: "/usr/bin/pi", args: [] },
		home: isolatedHomeResolved,
		packageRoot: "/pkg",
		declaration: undefined,
		takeOver: false,
		otherPackagePaths: [],
		passthrough: ["--mode", "rpc"],
		baseEnv: {},
	});
	assert.deepEqual(built.args, [
		"-e",
		"/pkg",
		"--theme",
		join("/pkg", "themes"),
		"--skill",
		join("/pkg", "skills"),
		"--prompt-template",
		join("/pkg", "prompts"),
		"--mode",
		"rpc",
	]);
});

test("buildPiInvocation emits only runtime args and passthrough when a pi subcommand is set, skipping injection", () => {
	const built = buildPiInvocation({
		runtime: { kind: "path", command: "/usr/bin/pi", args: [] },
		home: isolatedHomeResolved,
		packageRoot: "/pkg",
		declaration: undefined,
		takeOver: false,
		otherPackagePaths: [],
		passthrough: ["install", "npm:x"],
		piSubcommand: "install",
		baseEnv: {},
	});
	assert.deepEqual(built.args, ["install", "npm:x"]);
	assert.equal(built.command, "/usr/bin/pi");
});

test("buildPiInvocation still injects the launcher env for a pi subcommand", () => {
	const built = buildPiInvocation({
		runtime: { kind: "path", command: "/usr/bin/pi", args: [] },
		home: isolatedHomeResolved,
		packageRoot: "/pkg",
		declaration: undefined,
		takeOver: false,
		otherPackagePaths: [],
		passthrough: ["list"],
		piSubcommand: "list",
		baseEnv: { PATH: "/usr/bin" },
	});
	assert.deepEqual(built.env, {
		PATH: "/usr/bin",
		PI_CODING_AGENT_DIR: "/gentle-shell/agent",
		GENTLE_PI_AGENT_HOME: "/gentle-shell/agent",
	});
});

test("buildPiInvocation in link mode with a pi subcommand is exactly pi <subcommand> against the user's own agent dir, even when a conflicting declaration would otherwise force a take-over", () => {
	const built = buildPiInvocation({
		runtime: { kind: "path", command: "/usr/bin/pi", args: [] },
		home: linkHome,
		packageRoot: "/pkg",
		declaration: { kind: "path", dir: "/other/checkout" },
		takeOver: true,
		otherPackagePaths: [join("/agent", "npm", "node_modules", "some-other")],
		passthrough: ["auth", "status"],
		piSubcommand: "auth",
		baseEnv: {},
	});
	assert.equal(built.command, "/usr/bin/pi");
	assert.deepEqual(built.args, ["auth", "status"]);
	assert.deepEqual(built.env, { PI_CODING_AGENT_DIR: "/pi/agent", GENTLE_PI_AGENT_HOME: "/pi/agent" });
});

test("buildPiInvocation keeps the runtime's own args ahead of the injection and passthrough", () => {
	const built = buildPiInvocation({
		runtime: { kind: "bundled", command: "/usr/bin/node", args: ["/bundled/cli.js"] },
		home: isolatedHomeResolved,
		packageRoot: "/pkg",
		declaration: undefined,
		takeOver: false,
		otherPackagePaths: [],
		passthrough: [],
		baseEnv: {},
	});
	assert.equal(built.args[0], "/bundled/cli.js");
	assert.equal(built.command, "/usr/bin/node");
});

test("buildPiInvocation takes over a conflicting path declaration: --no-extensions, other package dirs, then the launcher's own -e and env", () => {
	const built = buildPiInvocation({
		runtime: { kind: "path", command: "/usr/bin/pi", args: [] },
		home: linkHome,
		packageRoot: "/pkg",
		declaration: { kind: "path", dir: "/other/checkout" },
		takeOver: true,
		otherPackagePaths: [join("/agent", "npm", "node_modules", "some-other")],
		passthrough: ["--mode", "rpc"],
		baseEnv: {},
	});
	assert.deepEqual(built.args, [
		"--no-extensions",
		"-e",
		join("/agent", "npm", "node_modules", "some-other"),
		"-e",
		"/pkg",
		"--theme",
		join("/pkg", "themes"),
		"--skill",
		join("/pkg", "skills"),
		"--prompt-template",
		join("/pkg", "prompts"),
		"--mode",
		"rpc",
	]);
});

test("buildPiInvocation takes over with --package-root even for a matching npm declaration, and with no other packages", () => {
	const built = buildPiInvocation({
		runtime: { kind: "path", command: "/usr/bin/pi", args: [] },
		home: linkHome,
		packageRoot: "/forced/root",
		declaration: { kind: "npm" },
		takeOver: true,
		otherPackagePaths: [],
		passthrough: [],
		baseEnv: {},
	});
	assert.deepEqual(built.args, [
		"--no-extensions",
		"-e",
		"/forced/root",
		"--theme",
		join("/forced/root", "themes"),
		"--skill",
		join("/forced/root", "skills"),
		"--prompt-template",
		join("/forced/root", "prompts"),
	]);
});

test("buildPiInvocation takes over with --package-root even when there is no declaration at all (takeOver wins over the plain no-declaration branch)", () => {
	const built = buildPiInvocation({
		runtime: { kind: "path", command: "/usr/bin/pi", args: [] },
		home: linkHome,
		packageRoot: "/forced/root",
		declaration: undefined,
		takeOver: true,
		otherPackagePaths: [join("/agent", "npm", "node_modules", "some-other")],
		passthrough: [],
		baseEnv: {},
	});
	assert.deepEqual(built.args, [
		"--no-extensions",
		"-e",
		join("/agent", "npm", "node_modules", "some-other"),
		"-e",
		"/forced/root",
		"--theme",
		join("/forced/root", "themes"),
		"--skill",
		join("/forced/root", "skills"),
		"--prompt-template",
		join("/forced/root", "prompts"),
	]);
});

test("buildPiInvocation injects loose extension entries during a takeover, after other package dirs and before the launcher's own root", () => {
	const built = buildPiInvocation({
		runtime: { kind: "path", command: "/usr/bin/pi", args: [] },
		home: linkHome,
		packageRoot: "/pkg",
		declaration: { kind: "path", dir: "/other/checkout" },
		takeOver: true,
		otherPackagePaths: [join("/agent", "npm", "node_modules", "some-other")],
		looseExtensionEntries: [join("/agent", "extensions", "a.ts"), join("/project", ".pi", "extensions", "b.js")],
		passthrough: ["--mode", "rpc"],
		baseEnv: {},
	});
	assert.deepEqual(built.args, [
		"--no-extensions",
		"-e",
		join("/agent", "npm", "node_modules", "some-other"),
		"-e",
		join("/agent", "extensions", "a.ts"),
		"-e",
		join("/project", ".pi", "extensions", "b.js"),
		"-e",
		"/pkg",
		"--theme",
		join("/pkg", "themes"),
		"--skill",
		join("/pkg", "skills"),
		"--prompt-template",
		join("/pkg", "prompts"),
		"--mode",
		"rpc",
	]);
});

test("buildPiInvocation omits loose extension entry flags when the list is empty or not provided", () => {
	const withoutField = buildPiInvocation({
		runtime: { kind: "path", command: "/usr/bin/pi", args: [] },
		home: linkHome,
		packageRoot: "/pkg",
		declaration: { kind: "path", dir: "/other/checkout" },
		takeOver: true,
		otherPackagePaths: [],
		passthrough: [],
		baseEnv: {},
	});
	assert.deepEqual(withoutField.args, ["--no-extensions", "-e", "/pkg", "--theme", join("/pkg", "themes"), "--skill", join("/pkg", "skills"), "--prompt-template", join("/pkg", "prompts")]);

	const withEmptyField = buildPiInvocation({
		runtime: { kind: "path", command: "/usr/bin/pi", args: [] },
		home: linkHome,
		packageRoot: "/pkg",
		declaration: { kind: "path", dir: "/other/checkout" },
		takeOver: true,
		otherPackagePaths: [],
		looseExtensionEntries: [],
		passthrough: [],
		baseEnv: {},
	});
	assert.deepEqual(withEmptyField.args, withoutField.args);
});

// R3-001: a settings package path can coincide with a discovered loose
// extension file (or a loose extension can repeat across candidate dirs);
// buildPiInvocation must inject each resolved path at most once, keeping
// first-occurrence order, rather than loading it twice and letting pi report
// a duplicate-registration tool conflict.
test("buildPiInvocation dedupes loose extension entries against other-package paths and against each other", () => {
	const built = buildPiInvocation({
		runtime: { kind: "path", command: "/usr/bin/pi", args: [] },
		home: linkHome,
		packageRoot: "/pkg",
		declaration: { kind: "path", dir: "/other/checkout" },
		takeOver: true,
		otherPackagePaths: [join("/agent", "npm", "node_modules", "some-other"), "/shared/dup.ts"],
		looseExtensionEntries: ["/shared/dup.ts", "/agent/extensions/a.ts", "/agent/extensions/a.ts"],
		passthrough: [],
		baseEnv: {},
	});
	assert.deepEqual(built.args, [
		"--no-extensions",
		"-e",
		join("/agent", "npm", "node_modules", "some-other"),
		"-e",
		"/shared/dup.ts",
		"-e",
		"/agent/extensions/a.ts",
		"-e",
		"/pkg",
		"--theme",
		join("/pkg", "themes"),
		"--skill",
		join("/pkg", "skills"),
		"--prompt-template",
		join("/pkg", "prompts"),
	]);
});

// R3-003: the launcher's own package root must also be checked against the
// dedupe set, not just appended unconditionally after the two loops — this
// is reachable when --package-root names a directory that settings also
// declare as a non-gentle-pi path entry.
test("buildPiInvocation dedupes the launcher's own package root against an other-package path that resolves to the same directory", () => {
	const built = buildPiInvocation({
		runtime: { kind: "path", command: "/usr/bin/pi", args: [] },
		home: linkHome,
		packageRoot: "/pkg",
		declaration: { kind: "path", dir: "/other/checkout" },
		takeOver: true,
		otherPackagePaths: [join("/agent", "npm", "node_modules", "some-other"), "/pkg"],
		passthrough: [],
		baseEnv: {},
	});
	const eFlags = built.args.filter((arg, index) => built.args[index - 1] === "-e");
	assert.deepEqual(eFlags, [join("/agent", "npm", "node_modules", "some-other"), "/pkg"]);
	assert.deepEqual(built.args, [
		"--no-extensions",
		"-e",
		join("/agent", "npm", "node_modules", "some-other"),
		"-e",
		"/pkg",
		"--theme",
		join("/pkg", "themes"),
		"--skill",
		join("/pkg", "skills"),
		"--prompt-template",
		join("/pkg", "prompts"),
	]);
});

// --- discoverLooseExtensionEntries -------------------------------------------
//
// Pure mirror of pi's own discoverExtensionsInDir (packages/coding-agent/src/
// core/extensions/loader.ts): direct *.ts/*.js/*.mjs files, plus <subdir>/
// index.ts or index.js for a child directory that has one. Hidden entries and
// *.d.ts files are deliberately excluded even though pi's own scan does not
// special-case them, because neither was ever a runnable extension and both
// would otherwise surface a confusing "Cannot find module" error once handed
// to pi's loader as an explicit, no-directory-discovery `-e <file>`.

function fakeFs(entries: LooseExtensionFsEntry[], indexFiles: string[] = []) {
	return {
		readdir: (_dir: string) => entries,
		exists: (path: string) => indexFiles.includes(path),
	};
}

test("discoverLooseExtensionEntries keeps direct .ts/.js/.mjs files and skips other suffixes", () => {
	const entries = [
		{ name: "a.ts", isFile: true, isDirectory: false },
		{ name: "b.js", isFile: true, isDirectory: false },
		{ name: "c.mjs", isFile: true, isDirectory: false },
		{ name: "readme.md", isFile: true, isDirectory: false },
		{ name: "gentle-agent-state.ts.bak-pre-fullscreen-fix", isFile: true, isDirectory: false },
	];
	const found = discoverLooseExtensionEntries("/extensions", fakeFs(entries));
	assert.deepEqual(found, [join("/extensions", "a.ts"), join("/extensions", "b.js"), join("/extensions", "c.mjs")]);
});

test("discoverLooseExtensionEntries skips hidden dotfiles and .d.ts declaration files", () => {
	const entries = [
		{ name: ".hidden.ts", isFile: true, isDirectory: false },
		{ name: "types.d.ts", isFile: true, isDirectory: false },
		{ name: "real.ts", isFile: true, isDirectory: false },
	];
	const found = discoverLooseExtensionEntries("/extensions", fakeFs(entries));
	assert.deepEqual(found, [join("/extensions", "real.ts")]);
});

test("discoverLooseExtensionEntries is case-sensitive on the file extension", () => {
	const entries = [{ name: "Upper.TS", isFile: true, isDirectory: false }];
	const found = discoverLooseExtensionEntries("/extensions", fakeFs(entries));
	assert.deepEqual(found, []);
});

test("discoverLooseExtensionEntries includes <subdir>/index.ts, falls back to index.js, and skips a subdir with neither", () => {
	const entries = [
		{ name: "with-ts", isFile: false, isDirectory: true },
		{ name: "with-js", isFile: false, isDirectory: true },
		{ name: "empty", isFile: false, isDirectory: true },
	];
	const indexFiles = [join("/extensions", "with-ts", "index.ts"), join("/extensions", "with-js", "index.js")];
	const found = discoverLooseExtensionEntries("/extensions", fakeFs(entries, indexFiles));
	// Sorted by name: "empty" (no index.ts/index.js -> excluded), then "with-js", then "with-ts".
	assert.deepEqual(found, [join("/extensions", "with-js", "index.js"), join("/extensions", "with-ts", "index.ts")]);
});

test("discoverLooseExtensionEntries prefers index.ts over index.js when a subdir has both", () => {
	const entries = [{ name: "both", isFile: false, isDirectory: true }];
	const indexFiles = [join("/extensions", "both", "index.ts"), join("/extensions", "both", "index.js")];
	const found = discoverLooseExtensionEntries("/extensions", fakeFs(entries, indexFiles));
	assert.deepEqual(found, [join("/extensions", "both", "index.ts")]);
});

test("discoverLooseExtensionEntries skips a hidden subdirectory even with its own index.ts", () => {
	const entries = [{ name: ".hidden-dir", isFile: false, isDirectory: true }];
	const indexFiles = [join("/extensions", ".hidden-dir", "index.ts")];
	const found = discoverLooseExtensionEntries("/extensions", fakeFs(entries, indexFiles));
	assert.deepEqual(found, []);
});

test("discoverLooseExtensionEntries sorts results by name regardless of readdir order", () => {
	const entries = [
		{ name: "b.ts", isFile: true, isDirectory: false },
		{ name: "a.ts", isFile: true, isDirectory: false },
		{ name: "sub", isFile: false, isDirectory: true },
	];
	const indexFiles = [join("/extensions", "sub", "index.ts")];
	const found = discoverLooseExtensionEntries("/extensions", fakeFs(entries, indexFiles));
	assert.deepEqual(found, [join("/extensions", "a.ts"), join("/extensions", "b.ts"), join("/extensions", "sub", "index.ts")]);
});

test("discoverLooseExtensionEntries returns an empty list when readdir throws (missing or unreadable directory)", () => {
	const fs = {
		readdir: (_dir: string): LooseExtensionFsEntry[] => {
			throw new Error("ENOENT");
		},
		exists: (_path: string) => false,
	};
	assert.deepEqual(discoverLooseExtensionEntries("/missing", fs), []);
});

// --- planSpawn / quoteForCmdExe ----------------------------------------------
//
// R3-001: on win32, `findOnPath` in bin/gentle-shell.mjs can resolve a PATHEXT
// candidate such as a .CMD or .BAT shim (exactly how an npm-installed `pi`
// lands on PATH). Node refuses to spawn a batch file directly without
// `shell: true` (EINVAL), so both the version probe and the real launch must
// route a batch shim through cmd.exe.

test("planSpawn runs a win32 .CMD shim through the shell as a single quoted command line", () => {
	const plan = planSpawn({
		command: "C:\\Users\\x\\AppData\\Roaming\\npm\\pi.CMD",
		args: [],
		platform: "win32",
	});
	assert.equal(plan.shell, true);
	assert.equal(plan.args.length, 0);
	// No spaces in the path, so quoting is optional; only the exact text must be present.
	assert.equal(plan.command, "C:\\Users\\x\\AppData\\Roaming\\npm\\pi.CMD");
});

test("planSpawn quotes a win32 .bat shim and its args that contain spaces", () => {
	const plan = planSpawn({
		command: "C:\\Program Files\\pi\\pi.bat",
		args: ["--mode", "rpc", "hello world"],
		platform: "win32",
	});
	assert.equal(plan.shell, true);
	assert.deepEqual(plan.args, []);
	assert.equal(plan.command, '"C:\\Program Files\\pi\\pi.bat" --mode rpc "hello world"');
});

test("planSpawn leaves a win32 .exe or extension-less command unchanged", () => {
	const exe = planSpawn({ command: "C:\\pi\\pi.exe", args: ["--version"], platform: "win32" });
	assert.deepEqual(exe, { command: "C:\\pi\\pi.exe", args: ["--version"], shell: false });

	const bare = planSpawn({ command: "pi", args: ["--version"], platform: "win32" });
	assert.deepEqual(bare, { command: "pi", args: ["--version"], shell: false });
});

test("planSpawn never enables the shell on posix, even for a .cmd-named command", () => {
	for (const platform of ["darwin", "linux"] as const) {
		const plan = planSpawn({ command: "/usr/local/bin/pi.cmd", args: ["--version"], platform });
		assert.deepEqual(plan, { command: "/usr/local/bin/pi.cmd", args: ["--version"], shell: false });
	}
});

test("quoteForCmdExe leaves a plain token untouched", () => {
	assert.equal(quoteForCmdExe("pi"), "pi");
});

test("quoteForCmdExe quotes a token with a space and escapes an inner double quote", () => {
	assert.equal(quoteForCmdExe('say "hi" now'), '"say \\"hi\\" now"');
});

test("quoteForCmdExe quotes an empty token", () => {
	assert.equal(quoteForCmdExe(""), '""');
});

// --- restoreJsonField ---------------------------------------------------------
//
// Pure JSON merge used by bin/gentle-shell.mjs's setup flow to restore a
// single field of `~/.gentle-ai/state.json` (managed_asset_digest) after the
// pinned gentle-ai spawn rewrites it, the same way the whole-file
// snapshot/restore already protects `~/.pi/gentle-ai/persona.json` — but
// scoped to one field, since state.json also carries fields the pinned
// gentle-ai is supposed to update (gentle-shell #<managed-asset-digest>).

test("restoreJsonField restores a changed field and keeps every other field untouched", () => {
	const original = `${JSON.stringify({ managed_asset_digest: "abc123", installed_agents: ["pi"] }, null, 2)}\n`;
	const current = `${JSON.stringify({ managed_asset_digest: "def456", installed_agents: ["pi", "claude"] }, null, 2)}\n`;
	const result = restoreJsonField(original, current, "managed_asset_digest");
	assert.equal(result, `${JSON.stringify({ managed_asset_digest: "abc123", installed_agents: ["pi", "claude"] }, null, 2)}\n`);
});

test("restoreJsonField deletes the field when it was absent before", () => {
	const original = `${JSON.stringify({ installed_agents: ["pi"] }, null, 2)}\n`;
	const current = `${JSON.stringify({ managed_asset_digest: "def456", installed_agents: ["pi"] }, null, 2)}\n`;
	const result = restoreJsonField(original, current, "managed_asset_digest");
	assert.equal(result, `${JSON.stringify({ installed_agents: ["pi"] }, null, 2)}\n`);
});

test("restoreJsonField returns undefined when the field is unchanged", () => {
	const original = `${JSON.stringify({ managed_asset_digest: "abc123", installed_agents: ["pi"] }, null, 2)}\n`;
	const current = `${JSON.stringify({ managed_asset_digest: "abc123", installed_agents: ["pi", "claude"] }, null, 2)}\n`;
	assert.equal(restoreJsonField(original, current, "managed_asset_digest"), undefined);
});

test("restoreJsonField returns undefined when the field stays absent on both sides", () => {
	const original = `${JSON.stringify({ installed_agents: ["pi"] }, null, 2)}\n`;
	const current = `${JSON.stringify({ installed_agents: ["pi", "claude"] }, null, 2)}\n`;
	assert.equal(restoreJsonField(original, current, "managed_asset_digest"), undefined);
});

test("restoreJsonField returns undefined for invalid original JSON", () => {
	const result = restoreJsonField("not json", '{"managed_asset_digest":"def456"}', "managed_asset_digest");
	assert.equal(result, undefined);
});

test("restoreJsonField returns undefined for invalid current JSON", () => {
	const result = restoreJsonField('{"managed_asset_digest":"abc123"}', "not json", "managed_asset_digest");
	assert.equal(result, undefined);
});

test("restoreJsonField preserves 2-space indentation and a trailing newline detected from the original text", () => {
	const original = '{\n  "managed_asset_digest": "abc123"\n}\n';
	const current = '{"managed_asset_digest":"def456","installed_agents":["pi"]}';
	const result = restoreJsonField(original, current, "managed_asset_digest");
	assert.equal(result, `${JSON.stringify({ managed_asset_digest: "abc123", installed_agents: ["pi"] }, null, 2)}\n`);
});

test("restoreJsonField matches compact formatting (no indent, no trailing newline) when the original had none", () => {
	const original = '{"managed_asset_digest":"abc123"}';
	const current = '{"managed_asset_digest":"def456","installed_agents":["pi"]}';
	const result = restoreJsonField(original, current, "managed_asset_digest");
	assert.equal(result, '{"managed_asset_digest":"abc123","installed_agents":["pi"]}');
});

// --- forceJsonFieldIfAbsentInOriginal ------------------------------------------
//
// Pure JSON merge used by bin/gentle-shell.mjs's setup flow to make sure a
// home gentle-shell provisions ends up with the default Gentle Shell theme
// unless the home (or the user) already had an opinion about it — even when
// gentle-ai's own managed install wrote a *different* default theme into
// settings.json. Unlike restoreJsonField above (which restores a field back
// to whatever it was originally), this only ever forces one specific value,
// and only when the original text had no opinion on the field at all.

test("forceJsonFieldIfAbsentInOriginal forces the field when the original had none and the current text disagrees", () => {
	const original = `${JSON.stringify({ tuiMode: "fullscreen" }, null, 2)}\n`;
	const current = `${JSON.stringify({ tuiMode: "fullscreen", theme: "kanagawa" }, null, 2)}\n`;
	const result = forceJsonFieldIfAbsentInOriginal(original, current, "theme", "Gentleman-Cute");
	assert.equal(result, `${JSON.stringify({ tuiMode: "fullscreen", theme: "Gentleman-Cute" }, null, 2)}\n`);
});

test("forceJsonFieldIfAbsentInOriginal forces the field when the original had none and the current text also has none", () => {
	const original = `${JSON.stringify({ tuiMode: "fullscreen" }, null, 2)}\n`;
	const current = `${JSON.stringify({ tuiMode: "fullscreen" }, null, 2)}\n`;
	const result = forceJsonFieldIfAbsentInOriginal(original, current, "theme", "Gentleman-Cute");
	assert.equal(result, `${JSON.stringify({ tuiMode: "fullscreen", theme: "Gentleman-Cute" }, null, 2)}\n`);
});

test("forceJsonFieldIfAbsentInOriginal returns undefined when the original already declared the field", () => {
	const original = `${JSON.stringify({ tuiMode: "fullscreen", theme: "rose" }, null, 2)}\n`;
	const current = `${JSON.stringify({ tuiMode: "fullscreen", theme: "rose" }, null, 2)}\n`;
	assert.equal(forceJsonFieldIfAbsentInOriginal(original, current, "theme", "Gentleman-Cute"), undefined);
});

test("forceJsonFieldIfAbsentInOriginal returns undefined when the original declared the field, even if the current text changed it", () => {
	const original = `${JSON.stringify({ tuiMode: "fullscreen", theme: "rose" }, null, 2)}\n`;
	const current = `${JSON.stringify({ tuiMode: "fullscreen", theme: "kanagawa" }, null, 2)}\n`;
	assert.equal(forceJsonFieldIfAbsentInOriginal(original, current, "theme", "Gentleman-Cute"), undefined);
});

test("forceJsonFieldIfAbsentInOriginal returns undefined when the current value already matches the forced value", () => {
	const original = `${JSON.stringify({ tuiMode: "fullscreen" }, null, 2)}\n`;
	const current = `${JSON.stringify({ tuiMode: "fullscreen", theme: "Gentleman-Cute" }, null, 2)}\n`;
	assert.equal(forceJsonFieldIfAbsentInOriginal(original, current, "theme", "Gentleman-Cute"), undefined);
});

test("forceJsonFieldIfAbsentInOriginal returns undefined for invalid original JSON", () => {
	assert.equal(forceJsonFieldIfAbsentInOriginal("not json", '{"theme":"kanagawa"}', "theme", "Gentleman-Cute"), undefined);
});

test("forceJsonFieldIfAbsentInOriginal returns undefined for invalid current JSON", () => {
	assert.equal(forceJsonFieldIfAbsentInOriginal("{}", "not json", "theme", "Gentleman-Cute"), undefined);
});

test("forceJsonFieldIfAbsentInOriginal matches the current text's own indentation and trailing-newline convention, not the original's", () => {
	const original = '{\n  "tuiMode": "fullscreen"\n}\n';
	const current = '{"tuiMode":"fullscreen"}';
	const result = forceJsonFieldIfAbsentInOriginal(original, current, "theme", "Gentleman-Cute");
	assert.equal(result, '{"tuiMode":"fullscreen","theme":"Gentleman-Cute"}');
});

// --- shellQuote ---------------------------------------------------------------
//
// Used by bin/gentle-shell.mjs to build the copy-pasteable
// `gentle-shell <home selector> remove <source>` remediation command it
// prints after a failed conflicting-package removal: an unquoted --home
// <dir> containing a space would silently split into two shell words if
// copy-pasted (gentle-shell #1277 follow-up).

test("shellQuote leaves a plain token unchanged", () => {
	assert.equal(shellQuote("/Users/alan/.gentle-shell/agent"), "/Users/alan/.gentle-shell/agent");
});

test("shellQuote single-quotes a token containing a space", () => {
	assert.equal(shellQuote("/Users/alan/custom home"), "'/Users/alan/custom home'");
});

test("shellQuote escapes an embedded single quote as '\\''", () => {
	assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

// --- describeVersion / helpText ----------------------------------------------

test("describeVersion formats the three-line report with a found pi version", () => {
	const text = describeVersion({ gentlePiVersion: "3.3.0", piVersion: "0.85.1", home: linkHome });
	assert.equal(text, "gentle-shell 3.3.0\npi 0.85.1\nhome link /pi/agent");
});

test("describeVersion reports pi as not found when no pi version is available", () => {
	const text = describeVersion({ gentlePiVersion: "3.3.0", piVersion: undefined, home: isolatedHomeResolved });
	assert.equal(text, "gentle-shell 3.3.0\npi not found\nhome isolated /gentle-shell/agent");
});

test("helpText documents the launcher flags, the home subcommand, the env vars, and passthrough forwarding", () => {
	const text = helpText();
	assert.match(text, /--link/);
	assert.match(text, /--isolated/);
	assert.match(text, /--home/);
	assert.match(text, /--package-root/);
	assert.match(text, /\bhome\b/);
	assert.match(text, /GENTLE_SHELL_PI/);
	assert.match(text, /GENTLE_SHELL_HOME/);
	assert.match(text, /PI_CODING_AGENT_DIR/);
	assert.match(text, /forward/i);
});

test("helpText documents the setup subcommand", () => {
	const text = helpText();
	assert.match(text, /\bsetup\b/);
	assert.match(text, /--dry-run/);
});

test("helpText documents pi's own package-management subcommands", () => {
	const text = helpText();
	assert.match(text, /\binstall\b/);
	assert.match(text, /\bremove\b/);
	assert.match(text, /\blist\b/);
	assert.match(text, /\bupdate\b/);
	assert.match(text, /\bconfig\b/);
	assert.match(text, /\bauth\b/);
});
