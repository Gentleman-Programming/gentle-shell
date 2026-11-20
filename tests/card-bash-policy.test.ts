import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARD_BASH, CARD_BASH_SCHEMA, cardBash, parseCardBashFile, resolveCardBash, setCardBash, writeCardBash } from "../lib/card-bash-policy.ts";

const home = () => mkdtempSync(join(tmpdir(), "gentle-card-bash-"));

test("a missing preference means the activity heading", () => {
	const dir = home();
	assert.deepEqual(resolveCardBash({ gentlePiConfigHome: dir }), { bash: "activity", source: "default", malformed: false, globalFile: join(dir, "card-bash.json") }, "activity is the default");
});

test("the preference round-trips through the atomic writer", () => {
	const dir = home();
	const path = writeCardBash(CARD_BASH.ACTIVITY, { gentlePiConfigHome: dir });
	assert.equal(path, join(dir, "card-bash.json"));
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { schema: CARD_BASH_SCHEMA, bash: "activity" });
	assert.deepEqual(resolveCardBash({ gentlePiConfigHome: dir }), { bash: "activity", source: "global_file", malformed: false, globalFile: path });
	writeCardBash(CARD_BASH.OUTPUT, { gentlePiConfigHome: dir });
	assert.equal(resolveCardBash({ gentlePiConfigHome: dir }).bash, "output");
	assert.deepEqual(readdirSync(dir), ["card-bash.json"], "no temporary file survives the rename");
});

test("the writer rejects values outside the bash domain", () => {
	const dir = home();
	assert.throws(() => writeCardBash("phase" as never, { gentlePiConfigHome: dir }), TypeError);
	assert.equal(existsSync(join(dir, "card-bash.json")), false);
});

test("invalid or unreadable preference files read as activity and are never overwritten", () => {
	for (const raw of ["", "{", "[]", "null", `{"schema":"${CARD_BASH_SCHEMA}","bash":"phase"}`, `{"schema":"other/v1","bash":"output"}`, `{"schema":"${CARD_BASH_SCHEMA}","bash":"output","extra":1}`]) {
		assert.equal(parseCardBashFile(raw), undefined, raw);
		const dir = home();
		const path = join(dir, "card-bash.json");
		writeFileSync(path, raw);
		assert.deepEqual(resolveCardBash({ gentlePiConfigHome: dir }), { bash: "activity", source: "global_file", malformed: true, globalFile: path }, raw);
		assert.throws(() => writeCardBash(CARD_BASH.OUTPUT, { gentlePiConfigHome: dir }), /Cannot update malformed or unreadable card bash preference/, raw);
		assert.equal(readFileSync(path, "utf8"), raw, "the malformed file is preserved");
	}
	const dir = home();
	mkdirSync(join(dir, "card-bash.json"));
	assert.equal(resolveCardBash({ gentlePiConfigHome: dir }).malformed, true, "a directory in its place is unreadable, not missing");
	assert.throws(() => writeCardBash(CARD_BASH.OUTPUT, { gentlePiConfigHome: dir }), /Cannot update malformed or unreadable card bash preference/);
	assert.deepEqual(readdirSync(dir), ["card-bash.json"], "the rejected write must not create temporary files");
	assert.deepEqual(readdirSync(join(dir, "card-bash.json")), [], "the unreadable directory is preserved");
});

// chmod cannot deny reads on Windows; retain the portable directory case above.
test("POSIX unreadable preference files read as activity and are never overwritten", {
	skip: process.platform === "win32" || process.getuid?.() === 0 ? "requires POSIX permissions and a non-root user" : false,
}, () => {
	const locked = home();
	writeCardBash(CARD_BASH.OUTPUT, { gentlePiConfigHome: locked });
	chmodSync(join(locked, "card-bash.json"), 0o000);
	try {
		assert.deepEqual({ ...resolveCardBash({ gentlePiConfigHome: locked }), globalFile: "" }, { bash: "activity", source: "global_file", malformed: true, globalFile: "" });
		assert.throws(() => writeCardBash(CARD_BASH.ACTIVITY, { gentlePiConfigHome: locked }), /Cannot update malformed or unreadable card bash preference/);
	} finally {
		chmodSync(join(locked, "card-bash.json"), 0o600);
	}
	assert.equal(resolveCardBash({ gentlePiConfigHome: locked }).bash, CARD_BASH.OUTPUT, "the rejected write preserves the stored preference");
	assert.deepEqual(readdirSync(locked), ["card-bash.json"], "the rejected write leaves no temporary files");
});

test("the live slot shares one bash mode per process and an unset slot reads activity", (t) => {
	const slot = Symbol.for("gentle-pi.card-bash");
	const state = globalThis as typeof globalThis & { [slot]?: unknown };
	const found = state[slot];
	t.after(() => { state[slot] = found; });
	delete state[slot];
	assert.equal(cardBash(), CARD_BASH.ACTIVITY);
	setCardBash(CARD_BASH.OUTPUT);
	assert.equal(cardBash(), CARD_BASH.OUTPUT);
	setCardBash(CARD_BASH.ACTIVITY);
	assert.equal(cardBash(), CARD_BASH.ACTIVITY);
});
