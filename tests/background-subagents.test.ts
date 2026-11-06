import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { __testing, createGentleAiExtension } from "../extensions/gentle-ai.ts";

// ---------------------------------------------------------------------------
// Background subagents policy (issue #256).
//
// The policy loader mirrors loadRuntimeGuardrailsConfig: project file >
// global file > env var > default off, strict schema decode, fail-closed to
// "off" on any malformed input.
//
// Capability answers one question: is `subagent_run` callable? The live pi
// tool registry answers it directly and wins when it carries any signal. With
// no registry handle (prompt rendering outside a session, or a runtime without
// getActiveTools) capability falls back to the installed pi-subagents package.
// That fallback probes the package root's own package.json, NOT an `agents/`
// subdirectory: pi-subagents-j0k3r v1.5.2 ships index.ts, src/, skills/ and
// scripts/ and no agents/ at all, so the old agents-dir probe reported
// "absent" on every real install and left the background policy inert.
// ---------------------------------------------------------------------------

const {
	loadBackgroundSubagentsPolicy,
	resolveBackgroundSubagentsPolicy,
	parseBackgroundSubagentsPolicyFile,
	resolveBackgroundSubagentsCapability,
	readActiveToolNames,
	renderBackgroundSubagentsStatusLine,
	renderOrchestratorPrompt,
	getOrchestratorPrompt,
} = __testing;

const scratchRoots: string[] = [];

function makeScratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	scratchRoots.push(dir);
	return dir;
}

after(() => {
	for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

function writePolicyFile(dir: string, policy: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "background-subagents.json"),
		JSON.stringify({ schema: "gentle-pi.background-subagents/v1", policy }),
	);
}

const EMPTY_ENV = {} as Record<string, string | undefined>;

/**
 * Materialize an installed subagents package under the cwd-relative candidate
 * root. `agentsDir` reproduces the hypothetical legacy layout; omitting it
 * reproduces the real published layout, which ships no agents/ directory.
 */
function installSubagentsPackage(
	cwd: string,
	packageName: string,
	options: { agentsDir?: boolean } = {},
): void {
	const root = join(cwd, ".pi", "npm", "node_modules", packageName);
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: packageName, version: "1.5.2", type: "module" }),
	);
	// The real package ships these; none of them is an agents/ directory.
	for (const shipped of ["src", "skills", "scripts"]) {
		mkdirSync(join(root, shipped), { recursive: true });
	}
	if (options.agentsDir) mkdirSync(join(root, "agents"), { recursive: true });
}

// ---------------------------------------------------------------------------
// Strict decode
// ---------------------------------------------------------------------------

test("strict decode accepts exactly the v1 schema with policy on|off", () => {
	assert.equal(
		parseBackgroundSubagentsPolicyFile(
			'{"schema":"gentle-pi.background-subagents/v1","policy":"on"}',
		),
		"on",
	);
	assert.equal(
		parseBackgroundSubagentsPolicyFile(
			'{"schema":"gentle-pi.background-subagents/v1","policy":"off"}',
		),
		"off",
	);
});

test("strict decode rejects malformed shapes", () => {
	for (const raw of [
		"not json",
		"[]",
		"null",
		'{"policy":"on"}',
		'{"schema":"gentle-pi.background-subagents/v2","policy":"on"}',
		'{"schema":"gentle-pi.background-subagents/v1","policy":"ON"}',
		'{"schema":"gentle-pi.background-subagents/v1","policy":true}',
		'{"schema":"gentle-pi.background-subagents/v1","policy":"on","extra":1}',
	]) {
		assert.equal(
			parseBackgroundSubagentsPolicyFile(raw),
			undefined,
			`must reject: ${raw}`,
		);
	}
});

// ---------------------------------------------------------------------------
// Cascade: project > global > env > default off
// ---------------------------------------------------------------------------

test("default is off with no file and no env", () => {
	const cwd = makeScratch("gp-bg-none-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	assert.equal(
		loadBackgroundSubagentsPolicy(cwd, { gentlePiConfigHome: configHome, env: EMPTY_ENV }),
		"off",
	);
});

test("project file overrides global file and env", () => {
	const cwd = makeScratch("gp-bg-proj-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	writePolicyFile(join(cwd, ".pi", "gentle-ai"), "on");
	writePolicyFile(configHome, "off");
	assert.equal(
		loadBackgroundSubagentsPolicy(cwd, {
			gentlePiConfigHome: configHome,
			env: { GENTLE_PI_BACKGROUND_SUBAGENTS: "off" },
		}),
		"on",
	);
});

test("global file overrides env when no project file exists", () => {
	const cwd = makeScratch("gp-bg-glob-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	writePolicyFile(configHome, "on");
	assert.equal(
		loadBackgroundSubagentsPolicy(cwd, {
			gentlePiConfigHome: configHome,
			env: { GENTLE_PI_BACKGROUND_SUBAGENTS: "off" },
		}),
		"on",
	);
});

test("env var applies only when no policy file exists, and only exact on|off", () => {
	const cwd = makeScratch("gp-bg-env-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	assert.equal(
		loadBackgroundSubagentsPolicy(cwd, {
			gentlePiConfigHome: configHome,
			env: { GENTLE_PI_BACKGROUND_SUBAGENTS: "on" },
		}),
		"on",
	);
	for (const invalid of ["1", "true", "ON", "yes", ""]) {
		assert.equal(
			loadBackgroundSubagentsPolicy(cwd, {
				gentlePiConfigHome: configHome,
				env: { GENTLE_PI_BACKGROUND_SUBAGENTS: invalid },
			}),
			"off",
			`env value "${invalid}" must fail closed to off`,
		);
	}
});

test("a malformed higher-priority file fails closed to off instead of falling through", () => {
	const cwd = makeScratch("gp-bg-mal-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	const projectDir = join(cwd, ".pi", "gentle-ai");
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(join(projectDir, "background-subagents.json"), "{malformed");
	writePolicyFile(configHome, "on");
	assert.equal(
		loadBackgroundSubagentsPolicy(cwd, {
			gentlePiConfigHome: configHome,
			env: { GENTLE_PI_BACKGROUND_SUBAGENTS: "on" },
		}),
		"off",
	);
});

// ---------------------------------------------------------------------------
// Capability degrade
// ---------------------------------------------------------------------------

test("capability is absent when no subagents package exists anywhere", () => {
	const cwd = makeScratch("gp-bg-cap-absent-");
	assert.equal(resolveBackgroundSubagentsCapability(cwd), "absent");
});

// Regression: the exact shape of a real install. pi-subagents-j0k3r v1.5.2
// ships no agents/ directory, so the previous agents-dir probe reported
// "absent" while subagent_run was in fact installed and callable.
test("capability is ready when the subagents package is installed without an agents directory", () => {
	const cwd = makeScratch("gp-bg-cap-real-");
	installSubagentsPackage(cwd, "pi-subagents-j0k3r");
	assert.equal(resolveBackgroundSubagentsCapability(cwd), "ready");
});

test("capability is ready for either supported package name", () => {
	for (const packageName of ["pi-subagents-j0k3r", "pi-subagents"]) {
		const cwd = makeScratch("gp-bg-cap-name-");
		installSubagentsPackage(cwd, packageName);
		assert.equal(
			resolveBackgroundSubagentsCapability(cwd),
			"ready",
			`package name ${packageName} must be detected`,
		);
	}
});

test("capability stays ready for a layout that does ship an agents directory", () => {
	const cwd = makeScratch("gp-bg-cap-legacy-");
	installSubagentsPackage(cwd, "pi-subagents", { agentsDir: true });
	assert.equal(resolveBackgroundSubagentsCapability(cwd), "ready");
});

test("a bare directory with no package.json is not an installed package", () => {
	const cwd = makeScratch("gp-bg-cap-bare-");
	mkdirSync(join(cwd, ".pi", "npm", "node_modules", "pi-subagents-j0k3r", "agents"), {
		recursive: true,
	});
	assert.equal(resolveBackgroundSubagentsCapability(cwd), "absent");
});

// ---------------------------------------------------------------------------
// Live tool registry outranks the filesystem fallback
// ---------------------------------------------------------------------------

test("a live tool registry listing subagent_run reports ready with no package on disk", () => {
	const cwd = makeScratch("gp-bg-cap-tools-ready-");
	assert.equal(
		resolveBackgroundSubagentsCapability(cwd, ["read", "bash", "subagent_run"]),
		"ready",
	);
	assert.equal(
		resolveBackgroundSubagentsCapability(cwd, ["pi-subagents-j0k3r.subagent_run"]),
		"ready",
		"a namespaced tool name must still count",
	);
});

test("a live tool registry without subagent_run outranks an installed package", () => {
	const cwd = makeScratch("gp-bg-cap-tools-absent-");
	installSubagentsPackage(cwd, "pi-subagents-j0k3r");
	assert.equal(resolveBackgroundSubagentsCapability(cwd, ["read", "bash"]), "absent");
});

test("an empty tool list carries no signal and falls back to the package probe", () => {
	const cwd = makeScratch("gp-bg-cap-tools-empty-");
	installSubagentsPackage(cwd, "pi-subagents-j0k3r");
	assert.equal(resolveBackgroundSubagentsCapability(cwd, []), "ready");
});

test("readActiveToolNames reads the pi registry and degrades to undefined", () => {
	assert.deepEqual(
		readActiveToolNames({ getActiveTools: () => ["read", "subagent_run"] }),
		["read", "subagent_run"],
	);
	assert.deepEqual(
		readActiveToolNames({ getActiveTools: () => [{ name: "subagent_run" }, 7, ""] }),
		["subagent_run"],
		"non-string entries are normalized and blanks dropped",
	);
	assert.equal(readActiveToolNames({}), undefined, "no handle means no signal");
	assert.equal(
		readActiveToolNames({ getActiveTools: () => "nope" }),
		undefined,
		"a non-array result means no signal",
	);
	assert.equal(
		readActiveToolNames({
			getActiveTools: () => {
				throw new Error("registry unavailable");
			},
		}),
		undefined,
		"a throwing registry means no signal",
	);
});

// ---------------------------------------------------------------------------
// Token rendering
// ---------------------------------------------------------------------------

test("status line renders policy and capability", () => {
	assert.equal(
		renderBackgroundSubagentsStatusLine({ policy: "on", capability: "ready" }),
		"Background subagent policy: on (capability: ready)",
	);
	assert.equal(
		renderBackgroundSubagentsStatusLine({ policy: "off", capability: "absent" }),
		"Background subagent policy: off (capability: absent)",
	);
});

test("renderOrchestratorPrompt substitutes the background policy token", () => {
	const assetsDir = join(process.cwd(), "assets");
	const rendered = renderOrchestratorPrompt(assetsDir, {
		policy: "on",
		capability: "ready",
	});
	assert.match(rendered, /Background subagent policy: on \(capability: ready\)/);
	assert.doesNotMatch(rendered, /\{\{GENTLE_PI_BACKGROUND_POLICY\}\}/);
});

test("renderOrchestratorPrompt defaults to the fail-closed off/absent rendering", () => {
	const assetsDir = join(process.cwd(), "assets");
	const rendered = renderOrchestratorPrompt(assetsDir);
	assert.match(rendered, /Background subagent policy: off \(capability: absent\)/);
});

// The project policy file pins the policy half of the status line so these
// assertions never depend on the developer's ambient global config.
test("the rendered status line flips to ready when the subagents package is installed", () => {
	const cwd = makeScratch("gp-bg-cap-render-");
	writePolicyFile(join(cwd, ".pi", "gentle-ai"), "on");
	assert.match(
		getOrchestratorPrompt(cwd),
		/Background subagent policy: on \(capability: absent\)/,
		"no package installed yet",
	);
	installSubagentsPackage(cwd, "pi-subagents-j0k3r");
	assert.match(
		getOrchestratorPrompt(cwd),
		/Background subagent policy: on \(capability: ready\)/,
	);
});

test("the rendered status line reports ready from a live registry alone", () => {
	const cwd = makeScratch("gp-bg-cap-render-tools-");
	writePolicyFile(join(cwd, ".pi", "gentle-ai"), "on");
	assert.match(
		getOrchestratorPrompt(cwd, ["read", "subagent_run"]),
		/Background subagent policy: on \(capability: ready\)/,
	);
});

test("getOrchestratorPrompt renders exactly one background status line", () => {
	const rendered = getOrchestratorPrompt();
	const matches = rendered.match(/Background subagent policy: (?:on|off) \(capability: (?:ready|absent)\)/g) ?? [];
	assert.equal(matches.length, 1, "the always-on core must carry exactly one status line");
});

// ---------------------------------------------------------------------------
// Source attribution (issue #345)
//
// Four sources can decide the policy and the first hit wins, so a user who
// edits the global file while a project file exists sees no effect. The
// resolver reports WHICH source decided so the command can say so; the plain
// loader delegates to it, which is the only way the two can never disagree.
// ---------------------------------------------------------------------------

test("the resolver attributes the project file, with its path", () => {
	const cwd = makeScratch("gp-bg-src-project-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	writePolicyFile(join(cwd, ".pi", "gentle-ai"), "on");
	writePolicyFile(configHome, "off");
	const resolution = resolveBackgroundSubagentsPolicy(cwd, {
		gentlePiConfigHome: configHome,
		env: { GENTLE_PI_BACKGROUND_SUBAGENTS: "off" },
	});
	assert.equal(resolution.policy, "on");
	assert.equal(resolution.source, "project_file");
	assert.equal(
		resolution.projectFile,
		join(cwd, ".pi", "gentle-ai", "background-subagents.json"),
	);
	assert.equal(resolution.globalFile, join(configHome, "background-subagents.json"));
	assert.equal(resolution.projectFileExists, true);
	assert.equal(resolution.globalFileExists, true, "the shadowed global file is still reported");
	assert.equal(resolution.malformed, false);
	assert.equal(resolution.envValue, "off");
});

test("the resolver attributes the global file when no project file exists", () => {
	const cwd = makeScratch("gp-bg-src-global-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	writePolicyFile(configHome, "on");
	const resolution = resolveBackgroundSubagentsPolicy(cwd, {
		gentlePiConfigHome: configHome,
		env: { GENTLE_PI_BACKGROUND_SUBAGENTS: "off" },
	});
	assert.equal(resolution.policy, "on");
	assert.equal(resolution.source, "global_file");
	assert.equal(resolution.projectFileExists, false);
	assert.equal(resolution.globalFileExists, true);
});

test("the resolver attributes the environment variable when no file exists", () => {
	const cwd = makeScratch("gp-bg-src-env-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	const resolution = resolveBackgroundSubagentsPolicy(cwd, {
		gentlePiConfigHome: configHome,
		env: { GENTLE_PI_BACKGROUND_SUBAGENTS: "on" },
	});
	assert.equal(resolution.policy, "on");
	assert.equal(resolution.source, "environment");
	assert.equal(resolution.envValue, "on");
});

test("the resolver attributes the built-in default when nothing else decides", () => {
	const cwd = makeScratch("gp-bg-src-default-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	const resolution = resolveBackgroundSubagentsPolicy(cwd, {
		gentlePiConfigHome: configHome,
		env: { GENTLE_PI_BACKGROUND_SUBAGENTS: "yes" },
	});
	assert.equal(resolution.policy, "off");
	assert.equal(resolution.source, "default");
	assert.equal(
		resolution.envValue,
		"yes",
		"an unrecognized env value is reported verbatim so the command can call it inert",
	);
});

test("the resolver attributes a malformed file to that file and does not fall through", () => {
	const cwd = makeScratch("gp-bg-src-malformed-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	const projectDir = join(cwd, ".pi", "gentle-ai");
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(join(projectDir, "background-subagents.json"), "{malformed");
	writePolicyFile(configHome, "on");
	const resolution = resolveBackgroundSubagentsPolicy(cwd, {
		gentlePiConfigHome: configHome,
		env: { GENTLE_PI_BACKGROUND_SUBAGENTS: "on" },
	});
	assert.equal(resolution.policy, "off", "a malformed file fails closed");
	assert.equal(
		resolution.source,
		"project_file",
		"the malformed file still decided; it did not fall through to the global file",
	);
	assert.equal(resolution.malformed, true);
});

test("loadBackgroundSubagentsPolicy delegates to the resolver so the two can never disagree", () => {
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	writePolicyFile(configHome, "on");
	const scenarios: Array<{ cwd: string; env: Record<string, string | undefined> }> = [];
	const bare = makeScratch("gp-bg-agree-bare-");
	scenarios.push({ cwd: bare, env: {} });
	scenarios.push({ cwd: bare, env: { GENTLE_PI_BACKGROUND_SUBAGENTS: "on" } });
	const projectOn = makeScratch("gp-bg-agree-project-");
	writePolicyFile(join(projectOn, ".pi", "gentle-ai"), "off");
	scenarios.push({ cwd: projectOn, env: { GENTLE_PI_BACKGROUND_SUBAGENTS: "on" } });
	const malformed = makeScratch("gp-bg-agree-malformed-");
	mkdirSync(join(malformed, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(
		join(malformed, ".pi", "gentle-ai", "background-subagents.json"),
		"{malformed",
	);
	scenarios.push({ cwd: malformed, env: { GENTLE_PI_BACKGROUND_SUBAGENTS: "on" } });
	for (const scenario of scenarios) {
		const options = { gentlePiConfigHome: configHome, env: scenario.env };
		assert.equal(
			loadBackgroundSubagentsPolicy(scenario.cwd, options),
			resolveBackgroundSubagentsPolicy(scenario.cwd, options).policy,
			`loader and resolver must agree for ${scenario.cwd}`,
		);
	}
});

// ---------------------------------------------------------------------------
// /gentle:background-subagents command (issue #345)
//
// The policy had no user-facing surface at all: it could only be set by
// hand-writing JSON or exporting an env var, and the deciding source was
// visible to nobody. The command mirrors /gentle:review-mode — status|enable|
// disable, user-initiated only, Pi automation never toggles it.
// ---------------------------------------------------------------------------

interface CommandFixture {
	description?: string;
	handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

function registeredCommands(activeTools?: readonly string[]): Map<string, CommandFixture> {
	const commands = new Map<string, CommandFixture>();
	createGentleAiExtension({ nativeReviewCli: null })({
		on() {},
		registerTool() {},
		registerCommand(name: string, definition: CommandFixture) {
			commands.set(name, definition);
		},
		...(activeTools === undefined ? {} : { getActiveTools: () => activeTools }),
	} as unknown as ExtensionAPI);
	return commands;
}

function notifyContext(
	cwd: string,
	notices: Array<{ message: string; type?: string }>,
): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		ui: {
			notify: (message: string, type?: string) => {
				notices.push({ message, type });
			},
		},
	} as unknown as ExtensionContext;
}

/**
 * The same minimal context as `notifyContext`, but interactive: `hasUI` is true
 * and `ui.select` answers the command's no-argument menu. `notifyContext` stays
 * `hasUI: false` so every existing sub-action test keeps the non-menu path.
 */
function selectingContext(
	cwd: string,
	notices: Array<{ message: string; type?: string }>,
	select: (title: string, options: string[]) => Promise<string | undefined>,
): ExtensionContext {
	return {
		cwd,
		hasUI: true,
		ui: {
			notify: (message: string, type?: string) => {
				notices.push({ message, type });
			},
			select,
		},
	} as unknown as ExtensionContext;
}

/** Point the command's global config home at a scratch dir, never at ~/.pi. */
function scopedEnv(t: TestContext, values: Record<string, string | undefined>): void {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	t.after(() => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}

async function runBackgroundSubagents(
	t: TestContext,
	argument: string,
	cwd: string,
	configHome: string,
	env: Record<string, string | undefined> = {},
): Promise<{ message: string; type?: string }> {
	scopedEnv(t, {
		GENTLE_PI_CONFIG_HOME: configHome,
		GENTLE_PI_BACKGROUND_SUBAGENTS: undefined,
		...env,
	});
	const command = registeredCommands().get("gentle:background-subagents");
	assert.ok(command, "gentle:background-subagents must be registered");
	const notices: Array<{ message: string; type?: string }> = [];
	await command!.handler(argument, notifyContext(cwd, notices));
	assert.equal(notices.length, 1, "one invocation reports exactly once");
	return notices[0]!;
}

test("gentle:background-subagents is registered and declares user-initiated sub-actions", () => {
	const command = registeredCommands().get("gentle:background-subagents");
	assert.ok(command, "gentle:background-subagents must be registered");
	assert.match(command!.description ?? "", /status\|enable\|disable/);
	assert.match(
		command!.description ?? "",
		/user-initiated only; Pi automation never toggles it/,
	);
});

test("no argument reports the effective policy, the deciding default, and the capability", async (t) => {
	const cwd = makeScratch("gp-bg-cmd-default-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	const notice = await runBackgroundSubagents(t, "", cwd, configHome);
	assert.equal(notice.type, "info");
	assert.equal(
		notice.message,
		[
			"background subagents: off (decided by built-in default; capability: absent)",
			"Resolution order (first hit wins): project file, global file, GENTLE_PI_BACKGROUND_SUBAGENTS, built-in default off.",
		].join("\n"),
	);
});

test("no argument opens a selectable menu and applies the chosen sub-action", async (t) => {
	const cwd = makeScratch("gp-bg-cmd-select-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	const globalFile = join(configHome, "background-subagents.json");
	scopedEnv(t, {
		GENTLE_PI_CONFIG_HOME: configHome,
		GENTLE_PI_BACKGROUND_SUBAGENTS: undefined,
	});
	const command = registeredCommands().get("gentle:background-subagents");
	assert.ok(command, "gentle:background-subagents must be registered");

	// A dismissed menu (undefined selection) reports nothing and writes nothing.
	// It runs first so the untouched config home can prove the no-write: a second
	// scopedEnv save point in one test would restore out of order at teardown.
	const dismissed: Array<{ message: string; type?: string }> = [];
	await command!.handler("", selectingContext(cwd, dismissed, async () => undefined));
	assert.equal(dismissed.length, 0, "a dismissed menu reports nothing");
	assert.equal(existsSync(globalFile), false, "a dismissed menu writes no file");

	// Choosing "enable" writes the global file and reports exactly once, in the
	// same shape the direct `enable` sub-action already reports.
	const notices: Array<{ message: string; type?: string }> = [];
	await command!.handler(
		"",
		selectingContext(cwd, notices, async (title, options) => {
			assert.equal(title, "Background subagents policy");
			assert.deepEqual(options, ["status", "enable", "disable"]);
			return "enable";
		}),
	);
	assert.equal(notices.length, 1, "one invocation reports exactly once");
	assert.equal(notices[0]!.type, "info");
	assert.equal(
		notices[0]!.message,
		[
			`background subagents: on (decided by global file ${globalFile}; capability: absent)`,
			`Wrote on to the global file ${globalFile}.`,
			"Resolution order (first hit wins): project file, global file, GENTLE_PI_BACKGROUND_SUBAGENTS, built-in default off.",
		].join("\n"),
	);
	assert.deepEqual(JSON.parse(readFileSync(globalFile, "utf8")), {
		schema: "gentle-pi.background-subagents/v1",
		policy: "on",
	});
});

test("status names the project file that decided and the global file it shadows", async (t) => {
	const cwd = makeScratch("gp-bg-cmd-project-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	writePolicyFile(join(cwd, ".pi", "gentle-ai"), "on");
	writePolicyFile(configHome, "off");
	installSubagentsPackage(cwd, "pi-subagents-j0k3r");
	const notice = await runBackgroundSubagents(t, "status", cwd, configHome);
	assert.equal(notice.type, "info");
	assert.equal(
		notice.message,
		[
			`background subagents: on (decided by project file ${join(cwd, ".pi", "gentle-ai", "background-subagents.json")}; capability: ready)`,
			`The global file ${join(configHome, "background-subagents.json")} exists but is outranked by that project file.`,
			"Resolution order (first hit wins): project file, global file, GENTLE_PI_BACKGROUND_SUBAGENTS, built-in default off.",
		].join("\n"),
	);
});

test("status names the global file when it is the deciding source", async (t) => {
	const cwd = makeScratch("gp-bg-cmd-global-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	writePolicyFile(configHome, "on");
	const notice = await runBackgroundSubagents(t, "status", cwd, configHome);
	assert.equal(
		notice.message.split("\n")[0],
		`background subagents: on (decided by global file ${join(configHome, "background-subagents.json")}; capability: absent)`,
	);
});

test("status names the environment variable when it is the deciding source", async (t) => {
	const cwd = makeScratch("gp-bg-cmd-env-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	const notice = await runBackgroundSubagents(t, "status", cwd, configHome, {
		GENTLE_PI_BACKGROUND_SUBAGENTS: "on",
	});
	assert.equal(notice.type, "info");
	assert.equal(
		notice.message.split("\n")[0],
		"background subagents: on (decided by GENTLE_PI_BACKGROUND_SUBAGENTS; capability: absent)",
	);
});

test("status calls an unrecognized environment value inert instead of silently ignoring it", async (t) => {
	const cwd = makeScratch("gp-bg-cmd-env-bad-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	const notice = await runBackgroundSubagents(t, "status", cwd, configHome, {
		GENTLE_PI_BACKGROUND_SUBAGENTS: "true",
	});
	assert.equal(
		notice.message.split("\n")[0],
		"background subagents: off (decided by built-in default; capability: absent)",
	);
	assert.ok(
		notice.message.includes(
			'GENTLE_PI_BACKGROUND_SUBAGENTS="true" is not a recognized value ("on" or "off"), so it is ignored.',
		),
		notice.message,
	);
});

test("status reports a malformed deciding file as fail-closed, not as a real off", async (t) => {
	const cwd = makeScratch("gp-bg-cmd-malformed-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	const projectFile = join(cwd, ".pi", "gentle-ai", "background-subagents.json");
	mkdirSync(join(cwd, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(projectFile, "{malformed");
	writePolicyFile(configHome, "on");
	const notice = await runBackgroundSubagents(t, "status", cwd, configHome);
	assert.equal(notice.type, "warning");
	assert.equal(
		notice.message.split("\n")[0],
		`background subagents: off (decided by project file ${projectFile}; capability: absent)`,
	);
	assert.ok(
		notice.message.includes(
			`${projectFile} is present but malformed, so the policy fails closed to off and no lower-priority source is consulted.`,
		),
		notice.message,
	);
});

test("enable writes the global file and reports that it decides", async (t) => {
	const cwd = makeScratch("gp-bg-cmd-enable-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	const globalFile = join(configHome, "background-subagents.json");
	const notice = await runBackgroundSubagents(t, "enable", cwd, configHome);
	assert.deepEqual(JSON.parse(readFileSync(globalFile, "utf8")), {
		schema: "gentle-pi.background-subagents/v1",
		policy: "on",
	});
	assert.equal(notice.type, "info");
	assert.equal(
		notice.message,
		[
			`background subagents: on (decided by global file ${globalFile}; capability: absent)`,
			`Wrote on to the global file ${globalFile}.`,
			"Resolution order (first hit wins): project file, global file, GENTLE_PI_BACKGROUND_SUBAGENTS, built-in default off.",
		].join("\n"),
	);
});

test("disable writes the global file off and reports that it decides", async (t) => {
	const cwd = makeScratch("gp-bg-cmd-disable-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	const globalFile = join(configHome, "background-subagents.json");
	writePolicyFile(configHome, "on");
	const notice = await runBackgroundSubagents(t, "disable", cwd, configHome);
	assert.deepEqual(JSON.parse(readFileSync(globalFile, "utf8")), {
		schema: "gentle-pi.background-subagents/v1",
		policy: "off",
	});
	assert.equal(notice.type, "info");
	assert.equal(
		notice.message.split("\n")[0],
		`background subagents: off (decided by global file ${globalFile}; capability: absent)`,
	);
});

// The defect this command exists to kill: telling a user "enabled" while a
// project file keeps the policy off. The global write still happens — it is
// what the user asked for — but the report must lead with the truth.
test("enable under an outranking project file writes the global file and says it does not take effect", async (t) => {
	const cwd = makeScratch("gp-bg-cmd-outranked-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	const projectFile = join(cwd, ".pi", "gentle-ai", "background-subagents.json");
	const globalFile = join(configHome, "background-subagents.json");
	writePolicyFile(join(cwd, ".pi", "gentle-ai"), "off");
	const notice = await runBackgroundSubagents(t, "enable", cwd, configHome);
	assert.deepEqual(
		JSON.parse(readFileSync(globalFile, "utf8")),
		{ schema: "gentle-pi.background-subagents/v1", policy: "on" },
		"the requested global write still happens",
	);
	assert.equal(notice.type, "warning");
	assert.equal(
		notice.message,
		[
			`background subagents: off (decided by project file ${projectFile}; capability: absent)`,
			`Wrote on to the global file ${globalFile}.`,
			`That global write does not take effect here: the project file ${projectFile} outranks it. Edit or remove that project file to let the global setting decide.`,
			"Resolution order (first hit wins): project file, global file, GENTLE_PI_BACKGROUND_SUBAGENTS, built-in default off.",
		].join("\n"),
	);
});

test("enable with the environment variable set reports where that variable ranks", async (t) => {
	const cwd = makeScratch("gp-bg-cmd-enable-env-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	const globalFile = join(configHome, "background-subagents.json");
	const notice = await runBackgroundSubagents(t, "enable", cwd, configHome, {
		GENTLE_PI_BACKGROUND_SUBAGENTS: "off",
	});
	assert.equal(
		notice.message.split("\n")[0],
		`background subagents: on (decided by global file ${globalFile}; capability: absent)`,
	);
	assert.ok(
		notice.message.includes(
			"GENTLE_PI_BACKGROUND_SUBAGENTS=off is set, but both files outrank it and it outranks the built-in default; it decides only when neither file exists.",
		),
		notice.message,
	);
});

test("an unknown sub-action warns and changes nothing", async (t) => {
	const cwd = makeScratch("gp-bg-cmd-unknown-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	const notice = await runBackgroundSubagents(t, "toggle", cwd, configHome);
	assert.equal(notice.type, "warning");
	assert.equal(
		notice.message,
		'Unknown /gentle:background-subagents sub-action "toggle". Use status, enable, or disable.',
	);
	assert.equal(
		existsSync(join(configHome, "background-subagents.json")),
		false,
		"an unknown sub-action must not write anything",
	);
});
