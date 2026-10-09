import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readSessionProfileDisk } from "../lib/session-profile-disk-reader.ts";
import { SESSION_PROFILE_CUSTOM_TYPE as customType } from "../lib/session-profile-persistence.ts";

const header = { type: "session", id: "session", version: 3 };
function entry(id = "selected", data: unknown = { kind: "clear" }) {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-10-05T00:00:00Z",
		customType,
		data,
	};
}
function fixture(
	t: TestContext,
	branch: unknown[] = [],
	rows: unknown[] = [header, ...branch],
) {
	const root = mkdtempSync(join(tmpdir(), "profile-reader-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "session.jsonl");
	writeFileSync(
		path,
		rows
			.map((row) => (typeof row === "string" ? row : JSON.stringify(row)))
			.join("\n") + "\n",
	);
	const source = {
		getSessionId: () => "session",
		getSessionFile: (): string | undefined => path,
		getBranch: () => branch,
	};
	return { path, source, read: () => readSessionProfileDisk(source) };
}

test("header only establishes absence", (t) => {
	assert.deepEqual(fixture(t).read(), { status: "absent" });
});

test("ordinary branch without family remains absent despite disk sibling", (t) => {
	const message = {
		type: "message",
		id: "message",
		parentId: null,
		timestamp: "fixture",
	};
	assert.deepEqual(
		fixture(t, [message], [header, message, entry("sibling")]).read(),
		{ status: "absent" },
	);
});

test("omitted data is terminal invalid or unsupported, never older resurrection", (t) => {
	for (const identifier of [customType, "gentle-pi.session-profile/v9"]) {
		const selected = { ...entry(), customType: identifier, data: undefined };
		const result = fixture(t, [entry("older"), selected]).read();
		assert.equal(
			result.status,
			identifier === customType ? "invalid" : "unsupported",
		);
	}
});

for (const [label, data, status] of [
	["clear", { kind: "clear" }, "cleared"],
	[
		"empty",
		{ kind: "bind", origin: "user", name: "chosen", modelProfiles: {} },
		"bound",
	],
	["invalid", { kind: "broken" }, "invalid"],
] as const) {
	test(`corroborated ${label} retains semantic state and original positions`, (t) => {
		const selected = entry("selected", data);
		const message = {
			type: "message",
			id: "message",
			parentId: null,
			timestamp: "fixture",
		};
		const f = fixture(t, [message, selected], [header, "", message, selected]);
		const result = f.read();
		assert.equal(result.status, status);
		assert.equal(result.entryIndex, 1);
		assert.equal(result.lineNumber, 4);
	});
}

test("future newest is terminal; sibling records never win", (t) => {
	const older = entry("older");
	const future = {
		...entry("future"),
		customType: "gentle-pi.session-profile/v2",
	};
	const f = fixture(
		t,
		[older, future],
		[header, older, future, entry("sibling")],
	);
	assert.equal(f.read().status, "unsupported");
});

test("unknown unwritten newest never falls back; trusted failed evidence excludes only its ID", (t) => {
	const older = entry("older");
	const ghost = entry("ghost");
	const f = fixture(t, [older, ghost], [header, older]);
	assert.equal(f.read().status, "indeterminate");
	const options = { knownFailedEntryIds: new Set(["ghost"]) };
	assert.equal(readSessionProfileDisk(f.source, options).status, "cleared");
	writeFileSync(
		f.path,
		[header, older, ghost].map((row) => JSON.stringify(row)).join("\n"),
	);
	assert.equal(readSessionProfileDisk(f.source, options).entryIndex, 0);
	assert.equal(
		readSessionProfileDisk(f.source, {
			knownFailedEntryIds: new Set(["unrelated"]),
		}).entryIndex,
		1,
	);
});

for (const [label, rows] of [
	["wrong session", [{ ...header, id: "other" }, entry()]],
	["wrong header", [{ ...header, type: "message" }, entry()]],
	["duplicate ID", [header, entry(), entry()]],
	["malformed", [header, "{secret"]],
	["truncated", [header, '{"type":']],
	["data mismatch", [header, entry("selected", { kind: "broken" })]],
	["parent mismatch", [header, { ...entry(), parentId: "other" }]],
	["metadata mismatch", [header, { ...entry(), timestamp: "other" }]],
	["custom type mismatch", [header, { ...entry(), customType: "other" }]],
	["extra metadata mismatch", [header, { ...entry(), extra: "changed" }]],
	["nonobject record", [header, "null"]],
	["empty file", []],
	[
		"missing metadata",
		[
			header,
			{ type: "custom", id: "selected", customType, data: { kind: "clear" } },
		],
	],
] as const) {
	test(`${label} is explicitly indeterminate`, (t) => {
		const result = fixture(t, [entry()], [...rows]).read();
		assert.equal(result.status, "indeterminate");
		assert.ok(!JSON.stringify(result).includes("secret"));
	});
}

test("parse failure reports physical line without contents", (t) => {
	const result = fixture(t, [], [header, "", "bad private contents"]).read();
	assert.deepEqual(result, {
		status: "indeterminate",
		reason: "invalid-json",
		lineNumber: 3,
	});
});

test("missing, undefined and unreadable paths are conservative", (t) => {
	const f = fixture(t);
	rmSync(f.path);
	assert.equal(f.read().status, "indeterminate");
	f.source.getSessionFile = () => undefined;
	assert.equal(f.read().status, "indeterminate");
	f.source.getSessionFile = () => f.path;
	assert.equal(
		readSessionProfileDisk(f.source, {
			readFile: () => {
				throw new Error("private");
			},
		}).status,
		"indeterminate",
	);
});

for (const change of ["id", "path", "branch"] as const) {
	test(`source ${change} change during read invalidates authority`, (t) => {
		const f = fixture(t, [entry()]);
		const result = readSessionProfileDisk(f.source, {
			readFile: (path) => {
				const text = readFileSync(path, "utf8");
				if (change === "id") f.source.getSessionId = () => "changed";
				if (change === "path") f.source.getSessionFile = () => "changed";
				if (change === "branch") f.source.getBranch().push(entry("changed"));
				return text;
			},
		});
		assert.equal(result.status, "indeterminate");
	});
}

test("JSON key order and omitted undefined follow serialization; orphan parent is allowed", (t) => {
	const selected = { ...entry(), parentId: "missing-failed", extra: undefined };
	const reversed = Object.fromEntries(Object.entries(selected).reverse());
	assert.equal(
		fixture(t, [selected], [header, reversed]).read().status,
		"cleared",
	);
});

test("unserializable memory and malformed own candidate metadata fail closed", (t) => {
	const circular: any = entry();
	circular.extra = circular;
	assert.equal(
		fixture(t, [circular], [header, entry()]).read().status,
		"indeterminate",
	);
	for (const field of ["id", "parentId", "timestamp"]) {
		const candidate: any = entry();
		delete candidate[field];
		assert.equal(
			fixture(t, [candidate], [header, candidate]).read().status,
			"indeterminate",
		);
	}
});

test("all origins, legacy routes and orchestrator are detached and preserved", (t) => {
	for (const origin of ["user", "local", "repo", "global"]) {
		const selected = entry("selected", {
			kind: "bind",
			origin,
			name: "chosen",
			modelProfiles: {
				worker: "provider/model",
				orchestrator: { effort: "high" },
			},
		});
		const f = fixture(t, [selected]);
		const result = f.read();
		assert.equal(result.status, "bound");
		if (result.status !== "bound") throw new Error("expected binding");
		assert.equal(result.binding.origin, origin);
		assert.deepEqual(result.binding.modelProfiles.orchestrator, {
			thinking: "high",
		});
		result.binding.modelProfiles.worker = { model: "changed" };
		const next = f.read();
		assert.equal(next.status, "bound");
		if (next.status === "bound")
			assert.deepEqual(next.binding.modelProfiles.worker, {
				model: "provider/model",
			});
	}
});
