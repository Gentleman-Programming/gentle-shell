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

test("capture-limit notice is delivered once but stays on the model", () => {
	const changes = new SessionChanges("session");
	for(let i=0;i<257;i++) changes.record(evidence(String(i),"/repo",String(i)+".ts"));
	assert.match(changes.takeNotice()!,/limit reached/);
	assert.equal(changes.takeNotice(),undefined);
	assert.match(changes.notice!,/limit reached/);
	assert.match(changes.model.notice!,/limit reached/);
	assert.equal(new SessionChanges("s").takeNotice(),undefined);
	assert.equal(new SessionChanges("s").model.notice,undefined);
});

test("many edits to few files never reach the cap, because the cap counts files (#1043)", () => {
	// The long-session shape the old bound got wrong: every repeat `write`/`edit`
	// of a file already on screen spent a slot, so the panel froze after 256
	// MUTATIONS while tracking three files.
	const changes = new SessionChanges("session");
	const paths = ["a.ts","b.ts","c.ts"];
	for(let i=0;i<600;i++){
		const path = paths[i % paths.length]!;
		changes.record(evidence("edit-"+String(i),"/repo",path,text("v"+String(i)+"\n"),text("v"+String(i+1)+"\n")));
	}
	assert.equal(changes.notice,undefined);
	assert.equal(changes.model.files.length,3);

	// And the budget those 600 edits did not spend is still there: a file the
	// session has not touched yet must still be admitted. A counter that
	// advanced per record rather than per new file would pass every assertion
	// above and turn this one away.
	assert.equal(changes.record(evidence("fresh","/repo","d.ts")),true);
	assert.equal(changes.model.files.length,4);
	assert.equal(changes.notice,undefined);
});

test("a file already tracked keeps updating after the file cap is reached (#1043)", () => {
	// The half the panel's staleness was actually made of: once the bound fired,
	// a later edit to a file already on screen was dropped too, so the entry it
	// would have refreshed sat at its last admitted state.
	const changes = new SessionChanges("session");
	for(let i=0;i<256;i++) changes.record(evidence("seed-"+String(i),"/repo",String(i)+".ts"));
	const before = changes.model.files.find(file => file.path === "0.ts")!.diffRevision;

	assert.equal(changes.record(evidence("late-new","/repo","257.ts")),false);
	assert.equal(changes.record(evidence("late-known","/repo","0.ts",text("new\n"),text("newer\n"))),true);

	assert.equal(changes.model.files.length,256);
	assert.notEqual(changes.model.files.find(file => file.path === "0.ts")!.diffRevision,before);
});

test("the notice names which bound fired (#1043)", () => {
	// "additional changes are not displayed" was assigned for both bounds, which
	// told an operator neither what filled up nor that the session was fine.
	const files = new SessionChanges("session");
	for(let i=0;i<257;i++) files.record(evidence(String(i),"/repo",String(i)+".ts"));
	assert.match(files.notice!,/files are shown/);

	const bytes = new SessionChanges("session");
	const big = "x".repeat(60*1024);
	for(let i=0;i<200;i++) bytes.record(evidence("big-"+String(i),"/repo",String(i)+".ts",text(big+"\n"),text(big+"y\n")));
	assert.match(bytes.notice!,/snapshot budget/);
});

test("a no-op edit to an unseen path does not spend a file slot (#1043)", () => {
	// before === after is dropped before anything is tracked, so it must not be
	// the reason a later real edit is refused.
	const changes = new SessionChanges("session");
	for(let i=0;i<255;i++) changes.record(evidence("seed-"+String(i),"/repo",String(i)+".ts"));
	assert.equal(changes.record(evidence("noop","/repo","noop.ts",text("same\n"),text("same\n"))),false);

	assert.equal(changes.record(evidence("real","/repo","real.ts")),true);
	assert.equal(changes.model.files.length,256);
	assert.equal(changes.notice,undefined);
});
