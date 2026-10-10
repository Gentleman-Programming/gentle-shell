import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	checkProjectMapIntegrationTasks,
	parseProjectMapTaskDocument,
	readProjectMapTestCommand,
} from "../lib/project-map-integration-documents.ts";

test("a task document counts its checked and unchecked boxes", () => {
	assert.deepEqual(parseProjectMapTaskDocument("- [x] one\n- [ ] two\n- [x] three\n"), { done: 2, total: 3 });
});

test("a task document ignores lines that are not checkboxes", () => {
	const text = "# PM-8\n\nSome prose mentioning [x] inline.\n\n- [ ] a real task\n- [x] a done task\n";
	assert.deepEqual(parseProjectMapTaskDocument(text), { done: 1, total: 2 }, "the two list items count; the prose does not");
});

test("an uppercase X counts as checked", () => {
	assert.deepEqual(parseProjectMapTaskDocument("- [X] one\n"), { done: 1, total: 1 });
});

test("a task document with CRLF line endings parses the same way", () => {
	assert.deepEqual(parseProjectMapTaskDocument("- [x] one\r\n- [ ] two\r\n"), { done: 1, total: 2 });
});

test("a document with no checkboxes reports zero tasks rather than a missing document", () => {
	assert.deepEqual(parseProjectMapTaskDocument("# Nothing to do here\n"), { done: 0, total: 0 });
});

test("indented checkboxes count, because ODD task lists are nested", () => {
	assert.deepEqual(parseProjectMapTaskDocument("  - [x] nested\n    - [ ] deeper\n"), { done: 1, total: 2 });
});

test("a capability declared done while its document still has open tasks is a mismatch", () => {
	const result = checkProjectMapIntegrationTasks({ declaredState: "done", declaredDocumentCount: 1, document: { path: "odd/tasks/catalog.md", done: 2, total: 5 } });
	assert.equal(result.check, "mismatched");
	assert.match(result.reason!, /2 of 5/);
});

test("a capability declared done with every task done agrees", () => {
	const result = checkProjectMapIntegrationTasks({ declaredState: "done", declaredDocumentCount: 1, document: { path: "odd/tasks/catalog.md", done: 5, total: 5 } });
	assert.equal(result.check, "verified");
});

test("a document whose tasks are all done while the map does not declare it done is a mismatch", () => {
	const result = checkProjectMapIntegrationTasks({ declaredState: "active", declaredDocumentCount: 1, document: { path: "odd/tasks/catalog.md", done: 4, total: 4 } });
	assert.equal(result.check, "mismatched");
	assert.match(result.reason!, /every task done/);
});

test("a capability in flight with some tasks done agrees, because that is what in flight looks like", () => {
	const result = checkProjectMapIntegrationTasks({ declaredState: "active", declaredDocumentCount: 1, document: { path: "odd/tasks/catalog.md", done: 2, total: 5 } });
	assert.equal(result.check, "verified");
});

test("a document with no checkboxes never contradicts a declared state", () => {
	const result = checkProjectMapIntegrationTasks({ declaredState: "done", declaredDocumentCount: 1, document: { path: "odd/tasks/catalog.md", done: 0, total: 0 } });
	assert.equal(result.check, "verified");
});

test("a declared feature document that could not be read is a mismatch, not a silent pass", () => {
	const result = checkProjectMapIntegrationTasks({ declaredState: "active", declaredDocumentCount: 1, document: null });
	assert.equal(result.check, "mismatched");
	assert.match(result.reason!, /could not be read/);
});

test("a capability that declares no feature document leaves the check unverified", () => {
	const result = checkProjectMapIntegrationTasks({ declaredState: "active", declaredDocumentCount: 0, document: null });
	assert.equal(result.check, "unverified");
	assert.match(result.reason!, /declares no feature document/);
});

test("the verification requirement is read from package.json scripts.test", () => {
	assert.equal(readProjectMapTestCommand(JSON.stringify({ scripts: { test: "pnpm test" } })), "pnpm test");
});

test("the repository's own manifest declares the command the map reads", (t) => {
	const repository = mkdtempSync(join(tmpdir(), "project-map-manifest-"));
	t.after(() => rmSync(repository, { recursive: true, force: true }));
	const manifestPath = join(repository, "package.json");
	writeFileSync(manifestPath, JSON.stringify({ scripts: { test: "pnpm test" } }));
	const manifest = readFileSync(manifestPath, "utf8");
	assert.equal(readProjectMapTestCommand(manifest), "pnpm test");
});

test("a manifest without a test command declares none", () => {
	assert.equal(readProjectMapTestCommand(JSON.stringify({ name: "example" })), null);
});

test("an absent or unreadable manifest declares no test command", () => {
	assert.equal(readProjectMapTestCommand(null), null);
	assert.equal(readProjectMapTestCommand(""), null);
});

test("a test command that is present but blank is not a requirement", () => {
	assert.equal(readProjectMapTestCommand(JSON.stringify({ scripts: { test: "" } })), null);
});

test("malformed manifests and non-string or whitespace test scripts declare no command", () => {
	for (const text of ["not JSON", "null", "[]", "42", ...[undefined, null, [], "test", {}, { test: 42 }, { test: null }, { test: "  " }].map((scripts) => JSON.stringify({ scripts }))]) {
		assert.equal(readProjectMapTestCommand(text), null, text);
	}
	assert.equal(readProjectMapTestCommand(JSON.stringify({ scripts: { test: " pnpm test " } })), " pnpm test ");
});
