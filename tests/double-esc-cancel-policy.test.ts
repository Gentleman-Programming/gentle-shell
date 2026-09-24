import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
	DOUBLE_ESC_CANCEL_FILE,
	DOUBLE_ESC_CANCEL_SCHEMA,
	DOUBLE_ESC_CANCEL_WINDOW_MS,
	loadDoubleEscCancelPolicy,
	parseDoubleEscCancelPolicyFile,
	resolveDoubleEscCancelPolicy,
	writeDoubleEscCancelPolicy,
} from "../lib/double-esc-cancel-policy.ts";

// ---------------------------------------------------------------------------
// Double-esc-cancel policy (issue #1163).
//
// Global-only resolver: global file > env var > default off. Mirrors the
// resolution shape of lib/background-subagents-policy.ts minus the
// project-file layer, since this preference is deliberately global-only
// (see the feature scope in odd/tasks/double-esc-cancel.md). Strict schema
// decode, fail-closed to "off" on any malformed input.
// ---------------------------------------------------------------------------

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
	writeFileSync(join(dir, DOUBLE_ESC_CANCEL_FILE), JSON.stringify({ schema: DOUBLE_ESC_CANCEL_SCHEMA, policy }));
}

const EMPTY_ENV = {} as Record<string, string | undefined>;

test("the confirmation window is 1000ms, deliberately double Pi's own 500ms idle double-Esc window", () => {
	assert.equal(DOUBLE_ESC_CANCEL_WINDOW_MS, 1000);
});

// --- strict decode ---------------------------------------------------------

test("strict decode accepts exactly the v1 schema with policy on|off", () => {
	assert.equal(parseDoubleEscCancelPolicyFile(`{"schema":"${DOUBLE_ESC_CANCEL_SCHEMA}","policy":"on"}`), "on");
	assert.equal(parseDoubleEscCancelPolicyFile(`{"schema":"${DOUBLE_ESC_CANCEL_SCHEMA}","policy":"off"}`), "off");
});

test("strict decode rejects malformed shapes", () => {
	for (const raw of [
		"not json",
		"[]",
		"null",
		'{"policy":"on"}',
		'{"schema":"gentle-pi.double-esc-cancel/v2","policy":"on"}',
		`{"schema":"${DOUBLE_ESC_CANCEL_SCHEMA}","policy":"ON"}`,
		`{"schema":"${DOUBLE_ESC_CANCEL_SCHEMA}","policy":true}`,
		`{"schema":"${DOUBLE_ESC_CANCEL_SCHEMA}","policy":"on","extra":1}`,
	]) {
		assert.equal(parseDoubleEscCancelPolicyFile(raw), undefined, `must reject: ${raw}`);
	}
});

// --- cascade: global file > env > default off -------------------------------

test("default is off with no file and no env", () => {
	const configHome = join(makeScratch("gp-esc-home-"), "gentle-ai");
	assert.equal(loadDoubleEscCancelPolicy({ gentlePiConfigHome: configHome, env: EMPTY_ENV }), "off");
});

test("the resolver reads GENTLE_PI_CONFIG_HOME from the given env, never from process.env", () => {
	const root = makeScratch("gp-esc-envhome-");
	writePolicyFile(root, "on");
	const result = resolveDoubleEscCancelPolicy({ env: { GENTLE_PI_CONFIG_HOME: root } });
	assert.equal(result.policy, "on");
	assert.equal(result.globalFile, join(root, "double-esc-cancel.json"));
});

test("global file overrides env", () => {
	const configHome = join(makeScratch("gp-esc-home-"), "gentle-ai");
	writePolicyFile(configHome, "on");
	assert.equal(
		loadDoubleEscCancelPolicy({ gentlePiConfigHome: configHome, env: { GENTLE_PI_DOUBLE_ESC_CANCEL: "off" } }),
		"on",
	);
});

test("env var applies only when no policy file exists, and only exact on|off", () => {
	const configHome = join(makeScratch("gp-esc-home-"), "gentle-ai");
	assert.equal(
		loadDoubleEscCancelPolicy({ gentlePiConfigHome: configHome, env: { GENTLE_PI_DOUBLE_ESC_CANCEL: "on" } }),
		"on",
	);
	for (const invalid of ["1", "true", "ON", "yes", ""]) {
		assert.equal(
			loadDoubleEscCancelPolicy({ gentlePiConfigHome: configHome, env: { GENTLE_PI_DOUBLE_ESC_CANCEL: invalid } }),
			"off",
			`env value "${invalid}" must fail closed to off`,
		);
	}
});

test("a malformed global file fails closed to off instead of falling through to env", () => {
	const configHome = join(makeScratch("gp-esc-home-"), "gentle-ai");
	mkdirSync(configHome, { recursive: true });
	writeFileSync(join(configHome, DOUBLE_ESC_CANCEL_FILE), "{malformed");
	assert.equal(
		loadDoubleEscCancelPolicy({ gentlePiConfigHome: configHome, env: { GENTLE_PI_DOUBLE_ESC_CANCEL: "on" } }),
		"off",
	);
});

// --- resolver attribution ---------------------------------------------------

test("the resolver attributes the global file when it decides", () => {
	const configHome = join(makeScratch("gp-esc-home-"), "gentle-ai");
	writePolicyFile(configHome, "on");
	const resolution = resolveDoubleEscCancelPolicy({ gentlePiConfigHome: configHome, env: EMPTY_ENV });
	assert.deepEqual(resolution, {
		policy: "on",
		source: "global_file",
		malformed: false,
		globalFile: join(configHome, DOUBLE_ESC_CANCEL_FILE),
		globalFileExists: true,
		envValue: undefined,
	});
});

test("the resolver attributes the environment variable when no file exists", () => {
	const configHome = join(makeScratch("gp-esc-home-"), "gentle-ai");
	const resolution = resolveDoubleEscCancelPolicy({
		gentlePiConfigHome: configHome,
		env: { GENTLE_PI_DOUBLE_ESC_CANCEL: "on" },
	});
	assert.equal(resolution.source, "environment");
	assert.equal(resolution.policy, "on");
	assert.equal(resolution.globalFileExists, false);
});

test("the resolver attributes the built-in default when nothing else decides", () => {
	const configHome = join(makeScratch("gp-esc-home-"), "gentle-ai");
	const resolution = resolveDoubleEscCancelPolicy({ gentlePiConfigHome: configHome, env: EMPTY_ENV });
	assert.equal(resolution.source, "default");
	assert.equal(resolution.policy, "off");
	assert.equal(resolution.malformed, false);
});

test("the resolver attributes a malformed global file to that file and does not fall through", () => {
	const configHome = join(makeScratch("gp-esc-home-"), "gentle-ai");
	mkdirSync(configHome, { recursive: true });
	writeFileSync(join(configHome, DOUBLE_ESC_CANCEL_FILE), "{malformed");
	const resolution = resolveDoubleEscCancelPolicy({
		gentlePiConfigHome: configHome,
		env: { GENTLE_PI_DOUBLE_ESC_CANCEL: "on" },
	});
	assert.equal(resolution.source, "global_file");
	assert.equal(resolution.policy, "off");
	assert.equal(resolution.malformed, true);
});

test("loadDoubleEscCancelPolicy delegates to the resolver so the two can never disagree", () => {
	const configHome = join(makeScratch("gp-esc-home-"), "gentle-ai");
	writePolicyFile(configHome, "on");
	assert.equal(
		loadDoubleEscCancelPolicy({ gentlePiConfigHome: configHome, env: EMPTY_ENV }),
		resolveDoubleEscCancelPolicy({ gentlePiConfigHome: configHome, env: EMPTY_ENV }).policy,
	);
});

// --- writer -------------------------------------------------------------------

test("writeDoubleEscCancelPolicy writes the strict v1 shape to the global file, creating the config home", () => {
	const configHome = join(makeScratch("gp-esc-home-"), "gentle-ai", "nested");
	const path = writeDoubleEscCancelPolicy("on", { gentlePiConfigHome: configHome });
	assert.equal(path, join(configHome, DOUBLE_ESC_CANCEL_FILE));
	assert.equal(loadDoubleEscCancelPolicy({ gentlePiConfigHome: configHome, env: EMPTY_ENV }), "on");
});

test("writeDoubleEscCancelPolicy(off) round-trips through the resolver", () => {
	const configHome = join(makeScratch("gp-esc-home-"), "gentle-ai");
	writeDoubleEscCancelPolicy("on", { gentlePiConfigHome: configHome });
	writeDoubleEscCancelPolicy("off", { gentlePiConfigHome: configHome });
	const resolution = resolveDoubleEscCancelPolicy({ gentlePiConfigHome: configHome, env: EMPTY_ENV });
	assert.equal(resolution.policy, "off");
	assert.equal(resolution.source, "global_file");
	assert.equal(resolution.malformed, false);
});
