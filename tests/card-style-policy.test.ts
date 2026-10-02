import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
	if (process.getuid?.() !== 0) {
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
