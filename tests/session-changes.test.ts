import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionChanges, readChangeSnapshot, SESSION_CHANGE_ENTRY, MAX_CHANGE_BYTES } from "../lib/session-changes.ts";

const text = (text: string) => ({ kind: "text" as const, text });
const absent = { kind: "absent" as const };
const evidence = (id = "a", root = "/repo", path = "file.ts", before = text("old\n"), after = text("new\n")) => ({ id, root, path, before, after });

test("session changes starts empty without reading the worktree or its untracked contents", async () => {
	const changes = new SessionChanges("session");
	assert.deepEqual(await changes.refresh(), { files: [], added: 0, deleted: 0 });
	assert.deepEqual(changes.worktrees, []);
});

test("only attributed changes appear, against the pre-tool content rather than HEAD", () => {
	const changes = new SessionChanges("session");
	changes.record(evidence("a", "/repo", "file.ts", text("preexisting human edit\nold\n"), text("preexisting human edit\nnew\n")));
	assert.equal(changes.model.files.length, 1);
	assert.equal(changes.model.added, 1);
	assert.equal(changes.model.deleted, 1);
	assert.match(changes.loadDiff("/repo", changes.model.files[0]), /\+new/);
	assert.doesNotMatch(changes.loadDiff("/repo", changes.model.files[0]), /\+preexisting/);
});

test("diff counts include content lines that resemble patch headers", () => {
	const changes = new SessionChanges("session");
	changes.record(evidence("headers", "/repo", "patch.txt", text("-- old content\n"), text("++ new content\n")));
	assert.equal(changes.model.added, 1);
	assert.equal(changes.model.deleted, 1);
});

test("contiguous own edits combine and own reverts remove the file and worktree", () => {
	const changes = new SessionChanges("session");
	changes.record(evidence());
	changes.record(evidence("b", "/repo", "file.ts", text("new\n"), text("final\n")));
	assert.equal(changes.model.added, 1);
	assert.match(changes.loadDiff("/repo", changes.model.files[0]), /\+final/);
	changes.record(evidence("c", "/repo", "file.ts", text("final\n"), text("old\n")));
	assert.deepEqual(changes.worktrees, []);
});

test("external edits between agent operations are not folded into an attributed diff", () => {
	const changes = new SessionChanges("session");
	changes.record(evidence());
	changes.record(evidence("b", "/repo", "file.ts", text("external\n"), text("agent again\n")));
	const file = changes.model.files[0];
	assert.match(file.countsUnavailable!, /external|continuity/i);
	assert.doesNotMatch(changes.loadDiff("/repo", file), /\+external|\-external/);
});

test("new files and child worktrees are admitted only by positive mutation evidence", () => {
	const changes = new SessionChanges("session");
	changes.record({ ...evidence("child:1", "/linked", "new.ts"), before: absent });
	assert.deepEqual(changes.worktrees.map(tree => tree.root), ["/linked"]);
	assert.equal(changes.model.files[0].status, "added");
});

test("reload restores only the exact session and deduplicates operation identities", () => {
	const row = { type: "custom", customType: SESSION_CHANGE_ENTRY, data: { sessionId: "session", evidence: evidence() } };
	const changes = new SessionChanges("session", [row, row, { ...row, data: { sessionId: "other", evidence: evidence("b", "/other") } }]);
	assert.equal(changes.model.files.length, 1);
	changes.record(evidence());
	assert.equal(changes.model.added, 1);
});

test("oversized, binary, nonregular and missing snapshots are bounded and explicit", async () => {
	const dir = await mkdtemp(join(tmpdir(), "session-changes-"));
	try {
		await writeFile(join(dir, "large"), Buffer.alloc(MAX_CHANGE_BYTES + 1, 65));
		await writeFile(join(dir, "binary"), Buffer.from([65, 0, 66]));
		assert.equal((await readChangeSnapshot(join(dir, "large"))).kind, "unavailable");
		assert.equal((await readChangeSnapshot(join(dir, "binary"))).kind, "unavailable");
		assert.equal((await readChangeSnapshot(dir)).kind, "unavailable");
		assert.deepEqual(await readChangeSnapshot(join(dir, "missing")), absent);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("bounded captures mark partial counts, including the narrow widget", async () => {
	const { renderChangesWidget } = await import("../lib/shell-changes.ts");
	const changes = new SessionChanges("session");
	changes.record({ ...evidence("large", "/repo", "a-very-long-path-that-does-not-fit-in-the-widget.bin"), before: {kind:"unavailable",reason:"Binary file"}, after:{kind:"unavailable",reason:"Binary file"} });
	assert.match(renderChangesWidget(changes.model,{fg:(_color,text)=>text},75).join("\n"),/partial counts/);
});

test("same-count edits change preview revisions and malformed evidence is rejected", () => {
	const changes = new SessionChanges("session");
	changes.record(evidence());
	const first = changes.model.files[0].diffRevision;
	changes.record(evidence("b","/repo","file.ts",text("new\n"),text("other\n")));
	assert.notEqual(changes.model.files[0].diffRevision,first);
	assert.equal(changes.record({...evidence("bad"),path:"../escape"}),false);
	assert.equal(changes.record({...evidence("bad"),path:".git/config"}),false);
});

test("capture capacity is explicit instead of growing without limit", () => {
	const changes = new SessionChanges("session");
	for(let i=0;i<257;i++) changes.record(evidence(String(i),"/repo",String(i)+".ts"));
	assert.equal(changes.model.files.length,256);
	assert.match(changes.notice!,/limit reached/);
});
