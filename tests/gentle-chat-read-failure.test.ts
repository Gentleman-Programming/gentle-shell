// Gentle Chat must show a failed transcript read as a failure, never as an empty conversation, and
// read again on the next refresh (issue #3537: a session file that cannot be read showed
// "No messages yet" and reported nothing).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The Herdr runtime modules main.js imports, inert: these tests drive the view's reads directly.
const stub = (names: string[], extra = "") => `data:text/javascript,${encodeURIComponent(`
const noop = () => null;
${extra}
export const ${names.map((n) => `${n} = noop`).join(", ")};
`)}`;
const MODULES: Record<string, string> = {
	"gpui-kit": stub(["div", "svg"], "export class View {}"),
	"gpui-base": stub(["v_flex", "h_flex", "TextView", "Textarea", "Popover", "TextareaState", "ScrollHandle"]),
	herdr: stub(["agents", "props", "layout", "hc", "run", "setShared", "shared", "theme", "watchFolder", "nextCommand", "openOverlay",
		"readTextFile", "writeTextFile", "terminals", "panes", "focused", "home", "exec", "fonts", "settings"]),
};
// Herdr's fs/promises also has `exists` (actions.js); the reads use Node's readFile.
const FS = `data:text/javascript,${encodeURIComponent(`export * from "node:fs/promises"; export const exists = async () => false;`)}`;
registerHooks({ resolve(specifier, context, next) {
	if (MODULES[specifier]) return { url: MODULES[specifier], shortCircuit: true };
	if (specifier === "fs/promises" && context.parentURL?.includes("/herdr/mods/")) return { url: FS, shortCircuit: true };
	return next(specifier, context);
} });

const { default: GentleChat } = await import("../herdr/mods/gentle-chat/main.js");
const { createFeed } = await import("../herdr/mods/gentle-chat/feed.js");

const cx = { notify() {} };
const line = (text: string) => `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })}\n`;

// The view of a local session whose session file is `file`; `snap`: it publishes a snapshot, so its
// first read is the file's tail (readTail), else the whole file (readAfter).
function view(file: string, snap: boolean) {
	const v = Object.create(GentleChat.prototype);
	Object.assign(v, { key: "s1", address: null, foreign: false, snap: snap ? { identity: { sessionFile: file } } : null, file,
		feed: createFeed(), pos: 0, start: 0, size: 0, back: 1, loading: false, again: false });
	return v;
}

function folder(t: test.TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "gentle-chat-fail-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const FAILED = ["Cannot read this conversation", "Its session file could not be read. The chat tries again when the session updates."];

for (const snap of [true, false]) {
	test(`an unreadable session file shows the failure, and the next read shows its messages (${snap ? "tail" : "whole"} read)`, async (t) => {
		const file = join(folder(t), "session.jsonl");
		const v = view(file, snap);
		await v.load(cx);
		assert.equal(v.feed.items.length, 0);
		assert.deepEqual(v.emptyText(), FAILED);
		writeFileSync(file, line("hello"));
		await v.load(cx);
		assert.equal(v.feed.items.length, 1);
		assert.deepEqual(v.emptyText(), ["No messages yet", "Type below to start."]);
	});
}

test("a readable session file with no messages still says No messages yet", async (t) => {
	const file = join(folder(t), "session.jsonl");
	writeFileSync(file, "");
	const v = view(file, true);
	await v.load(cx);
	assert.deepEqual(v.emptyText(), ["No messages yet", "Type below to start."]);
});
