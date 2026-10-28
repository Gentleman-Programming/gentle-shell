import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	DEFAULT_HERDR_TASK_SUMMARY_SETTINGS, HERDR_SUMMARY_COLORS, HERDR_TASK_SUMMARY_SCHEMA,
	resolveHerdrTaskSummarySettings, writeHerdrTaskSummarySettings,
	type HerdrTaskSummarySettings,
} from "../lib/herdr-task-summary-policy.ts";

function fixture() {
	const root = resolve("odd/work/herdr-c65-pure/fixtures/task-summary-policy");
	mkdirSync(root, { recursive: true });
	const home = mkdtempSync(join(root, "case-"));
	return { options: { gentlePiConfigHome: home }, home, file: join(home, "herdr-task-summary.json") };
}

test("missing settings preserve legacy defaults and return independent values", () => {
	const { options, file } = fixture();
	assert.deepEqual(resolveHerdrTaskSummarySettings(options), {
		settings: DEFAULT_HERDR_TASK_SUMMARY_SETTINGS, malformed: false, readError: false,
		source: "default", globalFile: file,
	});
	resolveHerdrTaskSummarySettings(options).settings.enabled = false;
	assert.equal(resolveHerdrTaskSummarySettings(options).settings.enabled, true);
});

test("all semantic roles persist atomically at 0600; visibility preserves both colors", () => {
	const { options, file, home } = fixture();
	assert.deepEqual(HERDR_SUMMARY_COLORS, ["accent", "text", "muted", "dim", "success", "warning", "error"]);
	for (const summaryColor of HERDR_SUMMARY_COLORS) {
		for (const continuationColor of HERDR_SUMMARY_COLORS) {
			for (const enabled of [false, true]) {
				const settings = { enabled, summaryColor, continuationColor };
				assert.equal(writeHerdrTaskSummarySettings(settings, options), file);
				assert.deepEqual(resolveHerdrTaskSummarySettings(options), {
					settings, malformed: false, readError: false, source: "global_file", globalFile: file,
				});
				assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { schema: HERDR_TASK_SUMMARY_SCHEMA, ...settings });
				assert.equal(statSync(file).mode & 0o777, 0o600);
				assert.deepEqual(readdirSync(home), ["herdr-task-summary.json"]);
			}
		}
	}
});

test("strict writer rejects wrong types, unknown roles and extra/missing fields without effects", () => {
	const { options, file, home } = fixture();
	const valid = { ...DEFAULT_HERDR_TASK_SUMMARY_SETTINGS };
	writeHerdrTaskSummarySettings(valid, options);
	const original = readFileSync(file, "utf8");
	for (const invalid of [null, [], {}, { ...valid, enabled: "false" }, { ...valid, summaryColor: "#abcdef" },
		{ ...valid, continuationColor: "blue" }, { ...valid, summaryColor: 1 }, { ...valid, extra: true },
		{ enabled: true, summaryColor: "accent" }]) {
		assert.throws(() => writeHerdrTaskSummarySettings(invalid as HerdrTaskSummarySettings, options), TypeError);
		assert.equal(readFileSync(file, "utf8"), original);
		assert.deepEqual(readdirSync(home), ["herdr-task-summary.json"]);
	}
});

test("malformed existing settings never get silently overwritten", () => {
	const { options, file, home } = fixture();
	const valid = DEFAULT_HERDR_TASK_SUMMARY_SETTINGS;
	for (const raw of ["{", "null", "[]", "{}", JSON.stringify({ ...valid, schema: "wrong" }),
		JSON.stringify({ schema: HERDR_TASK_SUMMARY_SCHEMA, ...valid, enabled: 0 }),
		JSON.stringify({ schema: HERDR_TASK_SUMMARY_SCHEMA, ...valid, summaryColor: "red" }),
		JSON.stringify({ schema: HERDR_TASK_SUMMARY_SCHEMA, ...valid, continuationColor: null }),
		JSON.stringify({ schema: HERDR_TASK_SUMMARY_SCHEMA, ...valid, unknown: true })]) {
		writeFileSync(file, raw);
		assert.deepEqual(resolveHerdrTaskSummarySettings(options), {
			settings: valid, malformed: true, readError: false, source: "global_file", globalFile: file,
		});
		assert.throws(() => writeHerdrTaskSummarySettings(valid, options), /Refusing/);
		assert.equal(readFileSync(file, "utf8"), raw);
		assert.deepEqual(readdirSync(home), ["herdr-task-summary.json"]);
	}
});

test("unreadable non-file and bounded oversized stores refuse writes without effects", () => {
	for (const directory of [true, false]) {
		const { options, file, home } = fixture();
		if (directory) mkdirSync(file); else writeFileSync(file, " ".repeat(4097));
		assert.deepEqual(resolveHerdrTaskSummarySettings(options), {
			settings: DEFAULT_HERDR_TASK_SUMMARY_SETTINGS, malformed: false, readError: true,
			source: "global_file", globalFile: file,
		});
		assert.throws(() => writeHerdrTaskSummarySettings(DEFAULT_HERDR_TASK_SUMMARY_SETTINGS, options), /Refusing/);
		assert.equal(statSync(file).isDirectory(), directory);
		if (!directory) assert.equal(readFileSync(file, "utf8"), " ".repeat(4097));
		assert.deepEqual(readdirSync(home), ["herdr-task-summary.json"]);
	}
});

for (const step of ["writeFileSync", "renameSync"] as const) test(`a failed ${step} removes the temporary file and keeps the previous store`, t => {
	const { options, file, home } = fixture();
	writeHerdrTaskSummarySettings({ ...DEFAULT_HERDR_TASK_SUMMARY_SETTINGS, enabled: false }, options);
	const before = readFileSync(file, "utf8");
	const original = fs[step];
	const failure = Object.assign(new Error(`controlled ${step} failure`), { code: "ENOSPC" });
	t.mock.method(fs, step, (...args: unknown[]) => {
		// The temporary file exists when the failure happens, as with a full disk.
		if (step === "writeFileSync") Reflect.apply(original, fs, [args[0], "", { flag: "wx", mode: 0o600 }]);
		throw failure;
	});
	syncBuiltinESMExports();
	try {
		assert.throws(() => writeHerdrTaskSummarySettings(DEFAULT_HERDR_TASK_SUMMARY_SETTINGS, options), failure);
	} finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
	assert.deepEqual(readdirSync(home).filter(name => name.endsWith(".tmp")), []);
	assert.equal(readFileSync(file, "utf8"), before);
	assert.equal(resolveHerdrTaskSummarySettings(options).settings.enabled, false);
});

test("a failed cleanup never masks the original write failure", t => {
	const { options } = fixture();
	const original = fs.writeFileSync;
	const failure = Object.assign(new Error("controlled write failure"), { code: "ENOSPC" });
	t.mock.method(fs, "writeFileSync", (...args: unknown[]) => {
		Reflect.apply(original, fs, [args[0], "", { flag: "wx", mode: 0o600 }]);
		throw failure;
	});
	t.mock.method(fs, "rmSync", () => { throw Object.assign(new Error("controlled cleanup failure"), { code: "EACCES" }); });
	syncBuiltinESMExports();
	try {
		assert.throws(() => writeHerdrTaskSummarySettings(DEFAULT_HERDR_TASK_SUMMARY_SETTINGS, options), failure);
	} finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
