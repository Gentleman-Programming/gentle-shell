import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import {
	describeSetupCheck,
	describeVersion,
	describeVersionJson,
	helpText,
	needsProvisioning,
	parseLauncherArgs,
	parseSetupCheckArgs,
	recordProvisioned,
	setupCheck,
	type ResolvedHome,
} from "../lib/gentle-shell-launcher.ts";

// Machine-readable launcher output (desktop-rpc-gpui-parity-2 T1, S1):
// `--version --json` and a read-only `setup --check [--json]`. `mcp list --json`
// stays Pi's own command, forwarded unchanged.

const binPath = fileURLToPath(new URL("../bin/gentle-shell.mjs", import.meta.url));
const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
const roots: string[] = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
function scratch(): string {
	// realpath: the launcher looks homes up through their realpath, and tmpdir
	// can be a symbolic link (macOS /var -> /private/var).
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-shell-machine-output-")));
	roots.push(root);
	return root;
}

const isolatedHome: ResolvedHome = { mode: "isolated", dir: "/gentle-shell/agent", source: "default" };

// --- parser ---------------------------------------------------------------------

test("parseLauncherArgs reads --json only together with --version, in either order", () => {
	for (const argv of [["--version", "--json"], ["--json", "--version"], ["--link", "--version", "--json"]]) {
		const parsed = parseLauncherArgs(argv);
		assert.equal(parsed.version, true);
		assert.equal(parsed.json, true);
		assert.deepEqual(parsed.passthrough, []);
		assert.equal(parsed.piSubcommand, undefined);
	}
});

test("parseLauncherArgs keeps --json for Pi everywhere else", () => {
	assert.equal(parseLauncherArgs(["--json"]).json, undefined);
	assert.deepEqual(parseLauncherArgs(["--json"]).passthrough, ["--json"]);
	// After the separator it is Pi's, even with --version.
	const separated = parseLauncherArgs(["--version", "--", "--json"]);
	assert.equal(separated.json, undefined);
	assert.deepEqual(separated.passthrough, ["--json"]);
	// With other Pi arguments it stays Pi's too.
	const prompt = parseLauncherArgs(["--version", "--json", "hello"]);
	assert.equal(prompt.json, undefined);
	assert.deepEqual(prompt.passthrough, ["--json", "hello"]);
});

test("parseLauncherArgs forwards mcp list --json to Pi unchanged", () => {
	const parsed = parseLauncherArgs(["mcp", "list", "--json"]);
	assert.equal(parsed.piSubcommand, "mcp");
	assert.deepEqual(parsed.passthrough, ["mcp", "list", "--json"]);
	assert.equal(parsed.json, undefined);
	assert.equal(parsed.command, undefined);
	const linked = parseLauncherArgs(["--link", "mcp", "list", "--json"]);
	assert.deepEqual(linked.passthrough, ["mcp", "list", "--json"]);
	assert.equal(linked.link, true);
});

test("parseLauncherArgs keeps the previous --version result without --json", () => {
	assert.deepEqual(parseLauncherArgs(["--version"]), {
		link: false, isolated: false, home: undefined, packageRoot: undefined, help: false, version: true,
		command: undefined, commandArgs: [], passthrough: [], piSubcommand: undefined, error: undefined,
	});
});

test("parseSetupCheckArgs reads --check and --json, and leaves every other setup run alone", () => {
	assert.deepEqual(parseSetupCheckArgs([]), { check: false });
	assert.deepEqual(parseSetupCheckArgs(["--dry-run"]), { check: false });
	assert.deepEqual(parseSetupCheckArgs(["--json"]), { check: false });
	assert.deepEqual(parseSetupCheckArgs(["--check"]), { check: true, json: false });
	assert.deepEqual(parseSetupCheckArgs(["--check", "--json"]), { check: true, json: true });
	assert.deepEqual(parseSetupCheckArgs(["--json", "--check"]), { check: true, json: true });
	assert.deepEqual(parseSetupCheckArgs(["--check", "--dry-run"]), { check: true, json: false, unrecognized: "--dry-run" });
	assert.deepEqual(parseSetupCheckArgs(["--check", "extra"]), { check: true, json: false, unrecognized: "extra" });
});

// --- version ----------------------------------------------------------------------

test("describeVersionJson prints one gentle-shell.version/v1 JSON line", () => {
	const text = describeVersionJson({ gentlePiVersion: "3.3.0", piVersion: "1.6.0", home: isolatedHome });
	assert.ok(!text.includes("\n"));
	assert.deepEqual(JSON.parse(text), { schema: "gentle-shell.version/v1", gentleShell: "3.3.0", pi: "1.6.0", home: { mode: "isolated", dir: "/gentle-shell/agent" } });
	const missing = JSON.parse(describeVersionJson({ gentlePiVersion: "3.3.0", piVersion: undefined, home: isolatedHome }));
	assert.equal(missing.pi, null);
});

// --- setup check -------------------------------------------------------------------

test("setupCheck names why a home needs setup and always agrees with needsProvisioning", () => {
	const at = "2026-01-01T00:00:00.000Z";
	const current = recordProvisioned({}, "/a", "3.6.0", "3.5.1", at);
	const cases: Array<[Record<string, unknown>, string[]]> = [
		[{}, ["never-provisioned"]],
		[current, []],
		[recordProvisioned({}, "/a", "3.5.0", "3.5.1", at), ["gentle-ai-changed"]],
		[recordProvisioned({}, "/a", "3.6.0", "3.5.0", at), ["gentle-pi-changed"]],
		[recordProvisioned({}, "/a", "3.5.0", "3.5.0", at), ["gentle-ai-changed", "gentle-pi-changed"]],
		[{ provisioned: { "/a": { gentleAi: "3.6.0", at } } }, ["gentle-pi-changed"]],
		[recordProvisioned({}, "/b", "3.6.0", "3.5.1", at), ["never-provisioned"]],
	];
	for (const [config, reasons] of cases) {
		const result = setupCheck(config, "/a", "3.6.0", "3.5.1");
		assert.deepEqual(result.reasons, reasons);
		assert.equal(result.needsSetup, reasons.length > 0);
		assert.equal(result.needsSetup, needsProvisioning(config, "/a", "3.6.0", "3.5.1"));
	}
	assert.deepEqual(setupCheck(current, "/a", "3.6.0", "3.5.1").previous, { gentleAi: "3.6.0", gentlePi: "3.5.1", at });
	assert.equal(setupCheck({}, "/a", "3.6.0", "3.5.1").previous, undefined);
});

test("describeSetupCheck prints a gentle-shell.setup-check/v1 JSON line without the home directory", () => {
	const text = describeSetupCheck({ needsSetup: true, reasons: ["never-provisioned"] }, { home: isolatedHome, foreign: false, json: true });
	assert.ok(!text.includes("\n"));
	assert.ok(!text.includes("/gentle-shell/agent"));
	assert.deepEqual(JSON.parse(text), { schema: "gentle-shell.setup-check/v1", needsSetup: true, home: { mode: "isolated" }, reasons: ["never-provisioned"], foreign: false });
	const ready = JSON.parse(describeSetupCheck({ needsSetup: false, reasons: [] }, { home: isolatedHome, foreign: false, json: true }));
	assert.deepEqual(ready, { schema: "gentle-shell.setup-check/v1", needsSetup: false, home: { mode: "isolated" }, reasons: [], foreign: false });
});

test("describeSetupCheck prints one readable line without --json", () => {
	assert.equal(describeSetupCheck({ needsSetup: false, reasons: [] }, { home: isolatedHome, foreign: false, json: false }),
		"gentle-shell: /gentle-shell/agent is set up");
	assert.equal(describeSetupCheck({ needsSetup: true, reasons: ["gentle-ai-changed", "gentle-pi-changed"] }, { home: isolatedHome, foreign: false, json: false }),
		"gentle-shell: /gentle-shell/agent needs setup (gentle-ai changed, gentle-pi changed); run `gentle-shell --isolated setup`");
	const custom: ResolvedHome = { mode: "path", dir: "/my home", source: "flag" };
	assert.equal(describeSetupCheck({ needsSetup: true, reasons: ["never-provisioned"] }, { home: custom, foreign: true, json: false }),
		"gentle-shell: /my home needs setup (never provisioned; not created by Gentle Shell, so it is never set up automatically); run `gentle-shell --home '/my home' setup`");
});

// --- help text ----------------------------------------------------------------------

test("helpText documents --version --json and setup --check [--json]", () => {
	const text = helpText();
	assert.ok(text.includes("       gentle-shell [home selectors] setup --check [--json]"));
	assert.match(text, /--version --json/);
	assert.match(text, /gentle-shell\.version\/v1/);
	assert.match(text, /gentle-shell\.setup-check\/v1/);
	assert.match(text, /mcp list --json/);
});

test("helpText keeps its previous setup and version lines", () => {
	const text = helpText();
	assert.ok(text.includes("       gentle-shell [home selectors] setup [--dry-run]"));
	assert.ok(text.includes("  --version        Show gentle-shell, pi, and home version information."));
	assert.ok(text.includes("       gentle-shell tower [--no-open] [--port <n>] [--json]"));
});

test("describeVersion text stays the same three lines", () => {
	assert.equal(describeVersion({ gentlePiVersion: "3.3.0", piVersion: "1.6.0", home: isolatedHome }), "gentle-shell 3.3.0\npi 1.6.0\nhome isolated /gentle-shell/agent");
});

// --- the real launcher --------------------------------------------------------------

function fakePi(root: string): string {
	if (process.platform === "win32") {
		const path = join(root, "fake-pi.cmd");
		writeFileSync(path, "@echo 1.6.0\r\n");
		return path;
	}
	const path = join(root, "fake-pi.sh");
	writeFileSync(path, "#!/bin/sh\necho 1.6.0\n");
	chmodSync(path, 0o755);
	return path;
}

function launcherEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		HOME: root, USERPROFILE: root, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec,
		GENTLE_SHELL_NO_AUTO_SETUP: "1", GENTLE_SHELL_SKIP_STARTUP_UPDATE: "1", GENTLE_SHELL_PI: fakePi(scratch()), ...extra,
	};
}

function run(root: string, argv: string[], extra: Record<string, string> = {}) {
	return spawnSync(process.execPath, [binPath, ...argv], { env: launcherEnv(root, extra), encoding: "utf8", input: "", timeout: 30000 });
}

// Every file under root with its size and mtime, so a run that writes or
// changes anything shows up as a difference.
function snapshot(root: string): string[] {
	const entries: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			const stat = statSync(path);
			entries.push(`${relative(root, path)} ${stat.isDirectory() ? "dir" : `${stat.size} ${stat.mtimeMs}`}`);
			if (stat.isDirectory()) walk(path);
		}
	};
	walk(root);
	return entries;
}

test("gentle-shell --version --json prints the version JSON line and exits 0", () => {
	const root = scratch();
	const result = run(root, ["--isolated", "--version", "--json"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	assert.ok(result.stdout.endsWith("}\n"));
	assert.equal(result.stdout.split("\n").length, 2);
	assert.deepEqual(JSON.parse(result.stdout), {
		schema: "gentle-shell.version/v1", gentleShell: packageVersion, pi: "1.6.0", home: { mode: "isolated", dir: join(root, ".gentle-shell", "agent") },
	});
});

test("gentle-shell --version without --json keeps the three text lines", () => {
	const root = scratch();
	const result = run(root, ["--isolated", "--version"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, `gentle-shell ${packageVersion}\npi 1.6.0\nhome isolated ${join(root, ".gentle-shell", "agent")}\n`);
});

test("gentle-shell setup --check --json on a new home reports never-provisioned, exits 1 and writes nothing", () => {
	const root = scratch();
	const before = snapshot(root);
	const result = run(root, ["setup", "--check", "--json"]);
	assert.equal(result.status, 1, result.stderr);
	assert.equal(result.stderr, "");
	assert.deepEqual(JSON.parse(result.stdout), { schema: "gentle-shell.setup-check/v1", needsSetup: true, home: { mode: "isolated" }, reasons: ["never-provisioned"], foreign: false });
	assert.deepEqual(snapshot(root), before);
});

test("gentle-shell setup --check on a provisioned home exits 0, in text and JSON, and writes nothing", () => {
	const root = scratch();
	const home = join(root, "custom-home");
	mkdirSync(home);
	writeFileSync(join(home, "settings.json"), "{}\n");
	const configPath = join(root, "launcher-config.json");
	writeFileSync(configPath, `${JSON.stringify(recordProvisioned({}, home, "3.6.0", packageVersion, "2026-01-01T00:00:00.000Z"), null, 2)}\n`);
	const extra = { GENTLE_SHELL_CONFIG: configPath, GENTLE_SHELL_GENTLE_AI_PIN: "3.6.0" };
	const before = snapshot(root);
	const json = run(root, ["--home", home, "setup", "--check", "--json"], extra);
	assert.equal(json.status, 0, json.stderr);
	assert.equal(json.stderr, "");
	assert.deepEqual(JSON.parse(json.stdout), { schema: "gentle-shell.setup-check/v1", needsSetup: false, home: { mode: "path" }, reasons: [], foreign: false });
	const text = run(root, ["--home", home, "setup", "--check"], extra);
	assert.equal(text.status, 0, text.stderr);
	assert.equal(text.stdout, `gentle-shell: ${home} is set up\n`);
	const changed = run(root, ["--home", home, "setup", "--check", "--json"], { ...extra, GENTLE_SHELL_GENTLE_AI_PIN: "3.7.0" });
	assert.equal(changed.status, 1, changed.stderr);
	assert.deepEqual(JSON.parse(changed.stdout).reasons, ["gentle-ai-changed"]);
	assert.deepEqual(snapshot(root), before);
});

test("gentle-shell setup --check reports a foreign --home with content as foreign", () => {
	const root = scratch();
	const home = join(root, "someone-elses");
	mkdirSync(home);
	writeFileSync(join(home, "notes.txt"), "mine\n");
	const before = snapshot(root);
	const result = run(root, ["--home", home, "setup", "--check", "--json"]);
	assert.equal(result.status, 1, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), { schema: "gentle-shell.setup-check/v1", needsSetup: true, home: { mode: "path" }, reasons: ["never-provisioned"], foreign: true });
	assert.deepEqual(snapshot(root), before);
});

test("gentle-shell setup --check rejects other arguments with exit 2", () => {
	const root = scratch();
	const result = run(root, ["setup", "--check", "--dry-run"]);
	assert.equal(result.status, 2);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "Unrecognized argument for 'gentle-shell setup': --dry-run\nRun 'gentle-shell --help' for usage.\n");
});

test("gentle-shell setup --json without --check is still rejected as before", () => {
	const root = scratch();
	const result = run(root, ["setup", "--json"], { GENTLE_SHELL_GENTLE_AI_BIN: join(root, "missing-gentle-ai") });
	assert.equal(result.status, 2);
	// Reached after the home bootstrap, as before, so its first-run hint may come first.
	assert.match(result.stderr, /^Unrecognized argument for 'gentle-shell setup': --json$/m);
	assert.equal(result.stdout, "");
});

test("gentle-shell setup --check treats a malformed config.json as no record", () => {
	const root = scratch();
	mkdirSync(join(root, ".gentle-shell"));
	writeFileSync(join(root, ".gentle-shell", "config.json"), "{ not json");
	const before = snapshot(root);
	const result = run(root, ["setup", "--check", "--json"]);
	assert.equal(result.status, 1, result.stderr);
	assert.equal(result.stderr, "");
	assert.deepEqual(JSON.parse(result.stdout), { schema: "gentle-shell.setup-check/v1", needsSetup: true, home: { mode: "isolated" }, reasons: ["never-provisioned"], foreign: false });
	assert.deepEqual(snapshot(root), before);
});

test("gentle-shell setup --check reports an unreadable config with exit 3, as JSON and as text, without paths", () => {
	const root = scratch();
	// A directory where config.json should be: reading it fails (EISDIR).
	mkdirSync(join(root, ".gentle-shell", "config.json"), { recursive: true });
	const before = snapshot(root);
	const json = run(root, ["setup", "--check", "--json"]);
	assert.equal(json.status, 3, json.stderr);
	assert.equal(json.stderr, "");
	assert.equal(json.stdout.split("\n").length, 2);
	assert.deepEqual(JSON.parse(json.stdout), { schema: "gentle-shell.setup-check/v1", error: "could not read the launcher config or home (EISDIR)" });
	const text = run(root, ["setup", "--check"]);
	assert.equal(text.status, 3);
	assert.equal(text.stdout, "");
	assert.equal(text.stderr, "gentle-shell setup --check: could not read the launcher config or home (EISDIR)\n");
	assert.ok(!json.stdout.includes(root) && !text.stderr.includes(root));
	assert.deepEqual(snapshot(root), before);
});

test("gentle-shell setup --check reports a home that cannot be listed with exit 3, not as needing setup", () => {
	const root = scratch();
	// A file where the home directory should be: listing it fails (ENOTDIR).
	const home = join(root, "not-a-dir");
	writeFileSync(home, "x");
	const before = snapshot(root);
	const json = run(root, ["--home", home, "setup", "--check", "--json"]);
	assert.equal(json.status, 3, json.stdout + json.stderr);
	assert.deepEqual(JSON.parse(json.stdout), { schema: "gentle-shell.setup-check/v1", error: "could not read the launcher config or home (ENOTDIR)" });
	assert.ok(!json.stdout.includes(root));
	assert.deepEqual(snapshot(root), before);
});

test("gentle-shell setup --check reports a --link home as foreign: automatic setup never touches it", () => {
	const root = scratch();
	mkdirSync(join(root, ".pi", "agent"), { recursive: true });
	writeFileSync(join(root, ".pi", "agent", "settings.json"), "{}\n");
	const before = snapshot(root);
	const result = run(root, ["--link", "setup", "--check", "--json"]);
	assert.equal(result.status, 1, result.stderr);
	assert.equal(result.stderr, "");
	assert.deepEqual(JSON.parse(result.stdout), { schema: "gentle-shell.setup-check/v1", needsSetup: true, home: { mode: "link" }, reasons: ["never-provisioned"], foreign: true });
	const text = run(root, ["--link", "setup", "--check"]);
	assert.equal(text.status, 1);
	assert.equal(text.stdout, `gentle-shell: ${join(root, ".pi", "agent")} needs setup (never provisioned; not created by Gentle Shell, so it is never set up automatically); run \`gentle-shell --link setup\`\n`);
	assert.deepEqual(snapshot(root), before);
});

test("gentle-shell setup --check reports Pi's default agent home given as --home as foreign, even when empty", () => {
	const root = scratch();
	const piHome = join(root, ".pi", "agent");
	mkdirSync(piHome, { recursive: true });
	const before = snapshot(root);
	const result = run(root, ["--home", piHome, "setup", "--check", "--json"]);
	assert.equal(result.status, 1, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), { schema: "gentle-shell.setup-check/v1", needsSetup: true, home: { mode: "path" }, reasons: ["never-provisioned"], foreign: true });
	assert.deepEqual(snapshot(root), before);
});
