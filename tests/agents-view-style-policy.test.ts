import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS_VIEW_STYLE_SCHEMA, parseAgentsViewStyleFile, resolveAgentsViewStyle, writeAgentsViewStyle } from "../lib/agents-view-style-policy.ts";

function home(t: { after(callback: () => void): void }): string {
	const dir = mkdtempSync(join(tmpdir(), "gentle-agents-view-style-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
const file = (dir: string) => join(dir, "agents-view-style.json");

test("a missing preference means the log view", (t) => {
	const dir = home(t);
	assert.deepEqual(resolveAgentsViewStyle({ gentlePiConfigHome: dir }), { style: "log", source: "default", malformed: false, globalFile: file(dir) });
});

test("the preference round-trips through the atomic writer", (t) => {
	const dir = home(t);
	assert.equal(writeAgentsViewStyle("cards", { gentlePiConfigHome: dir }), file(dir));
	assert.deepEqual(JSON.parse(readFileSync(file(dir), "utf8")), { schema: AGENTS_VIEW_STYLE_SCHEMA, style: "cards" });
	assert.deepEqual(resolveAgentsViewStyle({ gentlePiConfigHome: dir }), { style: "cards", source: "global_file", malformed: false, globalFile: file(dir) });
	writeAgentsViewStyle("log", { gentlePiConfigHome: dir });
	assert.equal(resolveAgentsViewStyle({ gentlePiConfigHome: dir }).style, "log");
	assert.deepEqual(readdirSync(dir), ["agents-view-style.json"], "no temporary file survives the rename");
});

test("the writer rejects values outside the style domain", (t) => {
	const dir = home(t);
	for (const value of ["chat", "registry", "log ", "", "LOG"]) {
		assert.throws(() => writeAgentsViewStyle(value as never, { gentlePiConfigHome: dir }), TypeError, value);
		assert.equal(existsSync(file(dir)), false, `${value} never creates the preference`);
	}
});

test("invalid or unreadable preference files read as log and are never overwritten", (t) => {
	for (const raw of ["", "{", "[]", "null", "42", `{"schema":"${AGENTS_VIEW_STYLE_SCHEMA}","style":"registro"}`, `{"schema":"other/v1","style":"cards"}`, `{"schema":"${AGENTS_VIEW_STYLE_SCHEMA}"}`, `{"schema":"${AGENTS_VIEW_STYLE_SCHEMA}","style":"cards","extra":1}`]) {
		assert.equal(parseAgentsViewStyleFile(raw), undefined, raw);
		const dir = home(t);
		writeFileSync(file(dir), raw);
		assert.deepEqual(resolveAgentsViewStyle({ gentlePiConfigHome: dir }), { style: "log", source: "global_file", malformed: true, globalFile: file(dir) }, raw);
		assert.throws(() => writeAgentsViewStyle("log", { gentlePiConfigHome: dir }), { message: `Cannot update malformed or unreadable agents view style preference: ${file(dir)}` }, raw);
		assert.equal(readFileSync(file(dir), "utf8"), raw, "the malformed file is preserved");
		assert.deepEqual(readdirSync(dir), ["agents-view-style.json"], "a refused write leaves no temporary file");
	}
});

test("a directory in the preference's place is unreadable, not missing", (t) => {
	const dir = home(t);
	mkdirSync(file(dir));
	assert.deepEqual({ ...resolveAgentsViewStyle({ gentlePiConfigHome: dir }), globalFile: "" }, { style: "log", source: "global_file", malformed: true, globalFile: "" });
	assert.throws(() => writeAgentsViewStyle("cards", { gentlePiConfigHome: dir }), /Cannot update malformed or unreadable agents view style preference/);
	assert.deepEqual(readdirSync(file(dir)), [], "the unreadable directory is preserved");
});

test("both current styles parse back exactly", () => {
	for (const style of ["log", "cards"]) {
		assert.equal(parseAgentsViewStyleFile(JSON.stringify({ schema: AGENTS_VIEW_STYLE_SCHEMA, style })), style);
	}
});

// The names were `registry` and `chat` before this vocabulary existed, and a
// preference saved then must keep selecting the view it selected: it reads as
// the current name, the writer stores that name, and nothing is lost.
test("a preference saved under the old names resolves to the view it selected", (t) => {
	for (const [legacy, current] of [["registry", "log"], ["chat", "cards"]] as const) {
		const dir = home(t);
		writeFileSync(file(dir), JSON.stringify({ schema: AGENTS_VIEW_STYLE_SCHEMA, style: legacy }));
		assert.equal(parseAgentsViewStyleFile(readFileSync(file(dir), "utf8")), current, legacy);
		assert.deepEqual(resolveAgentsViewStyle({ gentlePiConfigHome: dir }), { style: current, source: "global_file", malformed: false, globalFile: file(dir) }, `${legacy} is not a malformed file`);
		assert.equal(writeAgentsViewStyle(current, { gentlePiConfigHome: dir }), file(dir), "the old name is still writable over");
		assert.deepEqual(JSON.parse(readFileSync(file(dir), "utf8")), { schema: AGENTS_VIEW_STYLE_SCHEMA, style: current });
	}
});
