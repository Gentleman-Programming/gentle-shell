import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARD_CONTENT, CARD_CONTENT_SCHEMA, cardContent, parseCardContentFile, resolveCardContent, setCardContent, writeCardContent } from "../lib/card-content-policy.ts";

const home = () => mkdtempSync(join(tmpdir(), "gentle-card-content-"));

test("a missing preference means the default content level", () => {
	const dir = home();
	assert.deepEqual(resolveCardContent({ gentlePiConfigHome: dir }), { content: "default", source: "default", malformed: false, globalFile: join(dir, "card-content.json") });
});

test("the preference round-trips through the atomic writer", () => {
	const dir = home();
	const path = writeCardContent(CARD_CONTENT.MINIMAL, { gentlePiConfigHome: dir });
	assert.equal(path, join(dir, "card-content.json"));
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { schema: CARD_CONTENT_SCHEMA, content: "minimal" });
	assert.deepEqual(resolveCardContent({ gentlePiConfigHome: dir }), { content: "minimal", source: "global_file", malformed: false, globalFile: path });
	writeCardContent(CARD_CONTENT.DEFAULT, { gentlePiConfigHome: dir });
	assert.equal(resolveCardContent({ gentlePiConfigHome: dir }).content, "default");
	assert.deepEqual(readdirSync(dir), ["card-content.json"], "no temporary file survives the rename");
});

test("the writer rejects values outside the content domain", () => {
	const dir = home();
	assert.throws(() => writeCardContent("clean" as never, { gentlePiConfigHome: dir }), TypeError);
	assert.equal(existsSync(join(dir, "card-content.json")), false);
});

test("invalid or unreadable preference files read as default and are never overwritten", () => {
	for (const raw of ["", "{", "[]", "null", `{"schema":"${CARD_CONTENT_SCHEMA}","content":"clean"}`, `{"schema":"other/v1","content":"minimal"}`, `{"schema":"${CARD_CONTENT_SCHEMA}","content":"default","extra":1}`]) {
		assert.equal(parseCardContentFile(raw), undefined, raw);
		const dir = home();
		const path = join(dir, "card-content.json");
		writeFileSync(path, raw);
		assert.deepEqual(resolveCardContent({ gentlePiConfigHome: dir }), { content: "default", source: "global_file", malformed: true, globalFile: path }, raw);
		assert.throws(() => writeCardContent(CARD_CONTENT.MINIMAL, { gentlePiConfigHome: dir }), /Cannot update malformed or unreadable card content preference/, raw);
		assert.equal(readFileSync(path, "utf8"), raw, "the malformed file is preserved");
	}
	const dir = home();
	mkdirSync(join(dir, "card-content.json"));
	assert.equal(resolveCardContent({ gentlePiConfigHome: dir }).malformed, true, "a directory in its place is unreadable, not missing");
	if (process.getuid?.() !== 0) {
		const locked = home();
		writeCardContent(CARD_CONTENT.MINIMAL, { gentlePiConfigHome: locked });
		chmodSync(join(locked, "card-content.json"), 0o000);
		try {
			assert.deepEqual({ ...resolveCardContent({ gentlePiConfigHome: locked }), globalFile: "" }, { content: "default", source: "global_file", malformed: true, globalFile: "" });
		} finally {
			chmodSync(join(locked, "card-content.json"), 0o600);
		}
	}
});

test("the live slot shares one content level per process and an unset slot reads default", (t) => {
	const slot = Symbol.for("gentle-pi.card-content");
	const state = globalThis as typeof globalThis & { [slot]?: unknown };
	const found = state[slot];
	t.after(() => { state[slot] = found; });
	delete state[slot];
	assert.equal(cardContent(), CARD_CONTENT.DEFAULT);
	setCardContent(CARD_CONTENT.DEFAULT);
	assert.equal(cardContent(), CARD_CONTENT.DEFAULT);
	setCardContent(CARD_CONTENT.MINIMAL);
	assert.equal(cardContent(), CARD_CONTENT.MINIMAL);
});
