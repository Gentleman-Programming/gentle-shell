import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARD_STYLE_SCHEMA, parseCardStyleFile, resolveCardStyle, writeCardStyle } from "../lib/card-style-policy.ts";

const home = () => mkdtempSync(join(tmpdir(), "gentle-card-style-"));

test("a missing preference means the float style", () => {
	const dir = home();
	assert.deepEqual(resolveCardStyle({ gentlePiConfigHome: dir }), { style: "float", source: "default", malformed: false, globalFile: join(dir, "card-style.json") });
});

test("the preference round-trips through the atomic writer", () => {
	const dir = home();
	const path = writeCardStyle("float", { gentlePiConfigHome: dir });
	assert.equal(path, join(dir, "card-style.json"));
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { schema: CARD_STYLE_SCHEMA, style: "float" });
	assert.deepEqual(resolveCardStyle({ gentlePiConfigHome: dir }), { style: "float", source: "global_file", malformed: false, globalFile: path });
	writeCardStyle("neon", { gentlePiConfigHome: dir });
	assert.equal(resolveCardStyle({ gentlePiConfigHome: dir }).style, "neon");
	assert.deepEqual(readdirSync(dir), ["card-style.json"], "no temporary file survives the rename");
});

test("the writer rejects values outside the style domain", () => {
	const dir = home();
	assert.throws(() => writeCardStyle("default" as never, { gentlePiConfigHome: dir }), TypeError);
	assert.equal(existsSync(join(dir, "card-style.json")), false);
});

test("a denied preference read preserves the stored bytes and refuses every write", (t) => {
	const dir = home();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const path = writeCardStyle("neon", { gentlePiConfigHome: dir });
	const before = readFileSync(path);
	const originalRead = fs.readFileSync;
	const originalWrite = fs.writeFileSync;
	let writes = 0;
	t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
		if (args[0] === path) throw Object.assign(new Error("fixture access denied"), { code: "EACCES" });
		return originalRead(...args);
	});
	t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
		writes++;
		return originalWrite(...args);
	});
	syncBuiltinESMExports();
	try {
		assert.deepEqual(resolveCardStyle({ gentlePiConfigHome: dir }), { style: "float", source: "global_file", malformed: true, globalFile: path });
		assert.throws(() => writeCardStyle("float", { gentlePiConfigHome: dir }), { message: `Cannot update malformed or unreadable card style preference: ${path}` });
		assert.equal(writes, 0);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
	assert.deepEqual(readFileSync(path), before);
	assert.deepEqual(readdirSync(dir), ["card-style.json"]);
});

test("invalid or unreadable preference files read as float and are never overwritten", () => {
	for (const raw of ["", "{", "[]", "null", `{"schema":"${CARD_STYLE_SCHEMA}","style":"default"}`, `{"schema":"other/v1","style":"float"}`, `{"schema":"${CARD_STYLE_SCHEMA}","style":"float","extra":1}`]) {
		assert.equal(parseCardStyleFile(raw), undefined, raw);
		const dir = home();
		const path = join(dir, "card-style.json");
		writeFileSync(path, raw);
		assert.deepEqual(resolveCardStyle({ gentlePiConfigHome: dir }), { style: "float", source: "global_file", malformed: true, globalFile: path }, raw);
		assert.throws(() => writeCardStyle("float", { gentlePiConfigHome: dir }), /Cannot update malformed or unreadable card style preference/, raw);
		assert.equal(readFileSync(path, "utf8"), raw, "the malformed file is preserved");
	}
	const dir = home();
	mkdirSync(join(dir, "card-style.json"));
	assert.equal(resolveCardStyle({ gentlePiConfigHome: dir }).malformed, true, "a directory in its place is unreadable, not missing");
	// chmod(000) is a POSIX probe, not a portable access-denial fixture.
	// The EACCES test above exercises the refusal contract on every platform.
	if (process.platform !== "win32" && process.getuid?.() !== 0) {
		const locked = home();
		writeCardStyle("float", { gentlePiConfigHome: locked });
		chmodSync(join(locked, "card-style.json"), 0o000);
		try {
			assert.deepEqual({ ...resolveCardStyle({ gentlePiConfigHome: locked }), globalFile: "" }, { style: "float", source: "global_file", malformed: true, globalFile: "" });
		} finally {
			chmodSync(join(locked, "card-style.json"), 0o600);
		}
	}
});
