import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEFAULT_CHAIN_KEY,
	FALLBACKS_KIND,
	chainFor,
	emptyFallbacksFile,
	fallbacksFilePath,
	followProfileRename,
	parseFallbacksFileText,
	readFallbacksFile,
	renameProfileFallbacks,
	setChain,
	writeFallbacksFile,
} from "../lib/model-fallback-store.ts";

const valid = {
	kind: FALLBACKS_KIND,
	version: 1,
	profiles: {
		work: {
			orchestrator: [{ model: "openai/gpt-5.5", thinking: "high" }, { model: "qwen/qwen3.8" }],
			"*": [{ model: "anthropic/claude-sonnet-5-5" }],
		},
	},
};

test("chains live next to profiles.json in their own file", () => {
	assert.equal(fallbacksFilePath("/cfg"), join("/cfg", "profile-fallbacks.json"));
});

test("an agent's chain is its own, or the profile's * chain, or none", () => {
	const file = parseFallbacksFileText(JSON.stringify(valid));
	assert.equal(file.status, "valid");
	if (file.status !== "valid") return;
	assert.deepEqual(chainFor(file.file, "work", "orchestrator"), [{ model: "openai/gpt-5.5", thinking: "high" }, { model: "qwen/qwen3.8" }]);
	assert.deepEqual(chainFor(file.file, "work", "explore"), [{ model: "anthropic/claude-sonnet-5-5" }], "agents without a chain use *");
	assert.deepEqual(chainFor(file.file, "other", "explore"), [], "a profile without chains has none");
	assert.deepEqual(chainFor(file.file, undefined, "explore"), [], "no active profile, no chain");
	assert.equal(DEFAULT_CHAIN_KEY, "*");
});

test("the reader is strict: unknown keys, unsafe ids, bad effort, duplicates or long chains reject the file", () => {
	const bad = (patch: (value: typeof valid) => unknown) => parseFallbacksFileText(JSON.stringify(patch(structuredClone(valid)))).status;
	assert.equal(parseFallbacksFileText("{").status, "invalid");
	assert.equal(bad((v) => ({ ...v, kind: "other" })), "invalid");
	assert.equal(bad((v) => ({ ...v, version: 2 })), "invalid");
	assert.equal(bad((v) => ({ ...v, extra: 1 })), "invalid");
	assert.equal(bad((v) => { (v.profiles.work as Record<string, unknown>)["bad agent!"] = []; return v; }), "invalid");
	assert.equal(bad((v) => { v.profiles.work.orchestrator[0]!.model = "bad model"; return v; }), "invalid");
	assert.equal(bad((v) => { (v.profiles.work.orchestrator[0] as Record<string, unknown>).thinking = "ultra"; return v; }), "invalid");
	assert.equal(bad((v) => { (v.profiles.work.orchestrator[0] as Record<string, unknown>).extra = true; return v; }), "invalid");
	assert.equal(bad((v) => { v.profiles.work.orchestrator.push({ model: "openai/gpt-5.5" }); return v; }), "invalid", "a model appears once per chain");
	assert.equal(bad((v) => { v.profiles.work["*"] = Array.from({ length: 9 }, (_, i) => ({ model: `m/${i}` })); return v; }), "invalid", "at most 8 fallbacks");
	assert.equal(bad((v) => { (v.profiles as Record<string, unknown>)["bad name!"] = {}; return v; }), "invalid");
});

test("chains are written atomically, read back, and an empty chain removes the entry", () => {
	const home = mkdtempSync(join(tmpdir(), "fallbacks-"));
	try {
		const path = fallbacksFilePath(home);
		assert.equal(readFallbacksFile(path).status, "missing");
		let file = setChain(emptyFallbacksFile(), "work", "orchestrator", [{ model: "openai/gpt-5.5" }]);
		file = setChain(file, "work", "*", [{ model: "qwen/qwen3.8", thinking: "medium" }]);
		writeFallbacksFile(path, file);
		const read = readFallbacksFile(path);
		assert.equal(read.status, "valid");
		if (read.status !== "valid") return;
		assert.deepEqual(read.file, file);
		const cleared = setChain(setChain(read.file, "work", "orchestrator", []), "work", "*", []);
		assert.deepEqual(cleared.profiles, {}, "a profile with no chains disappears");
		assert.throws(() => setChain(file, "work", "orchestrator", [{ model: "a/b" }, { model: "a/b" }]), /once/);
		writeFileSync(path, "{ broken");
		assert.equal(readFallbacksFile(path).status, "invalid");
		assert.equal(readFileSync(path, "utf8"), "{ broken", "reading never rewrites a broken file");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("renaming or deleting a profile carries or drops its chains", () => {
	const parsed = parseFallbacksFileText(JSON.stringify(valid));
	if (parsed.status !== "valid") throw new Error("fixture");
	const renamed = renameProfileFallbacks(parsed.file, "work", "job");
	assert.deepEqual(Object.keys(renamed.profiles), ["job"]);
	assert.deepEqual(renameProfileFallbacks(parsed.file, "work", undefined).profiles, {}, "a deleted profile loses its chains");
	assert.equal(renameProfileFallbacks(parsed.file, "missing", "x"), parsed.file);
});

test("followProfileRename moves or drops a profile's chains on disk and leaves a broken file alone", () => {
	const home = mkdtempSync(join(tmpdir(), "fallbacks-follow-"));
	try {
		const path = fallbacksFilePath(home);
		assert.equal(followProfileRename(home, "work", "job"), false, "no file, nothing to follow");
		writeFallbacksFile(path, setChain(emptyFallbacksFile(), "work", "*", [{ model: "a/b" }]));
		assert.equal(followProfileRename(home, "work", "job"), true);
		const moved = readFallbacksFile(path);
		assert.deepEqual(moved.status === "valid" && Object.keys(moved.file.profiles), ["job"]);
		assert.equal(followProfileRename(home, "job", undefined), true);
		const dropped = readFallbacksFile(path);
		assert.deepEqual(dropped.status === "valid" && dropped.file.profiles, {});
		writeFileSync(path, "{ broken");
		assert.equal(followProfileRename(home, "job", "x"), false);
		assert.equal(readFileSync(path, "utf8"), "{ broken");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
