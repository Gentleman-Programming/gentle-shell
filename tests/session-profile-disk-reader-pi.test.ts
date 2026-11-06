// Run only in the parent's isolated snapshot with supported existing Pi deps.
// Public API fixtures, never providers or production flush/rollback workarounds.
import assert from "node:assert/strict";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readSessionProfileDisk } from "../lib/session-profile-disk-reader.ts";
import { SESSION_PROFILE_CUSTOM_TYPE as customType } from "../lib/session-profile-persistence.ts";

const packagePath = join(
	dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
	"..",
	"package.json",
);
const version: string = JSON.parse(readFileSync(packagePath, "utf8")).version;
// Fail closed rather than silently skipping tests against stale feature deps.
assert.match(version, /^\d+\.\d+\.\d+$/);
const [major, minor] = version.split(".").map(Number);
assert.ok(
	major >= 1,
	`Pi >=1.0.0 required, installed ${version}`,
);
const rollsBackFailedAppend = major > 1 || (major === 1 && minor >= 5);
console.info(
	`Public SessionManager fixture API: ${version}; minimum tested baseline 1.0.0`,
);

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "profile-reader-pi-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sessions = join(root, "sessions");
	const manager = SessionManager.create(root, sessions);
	return { manager, sessions };
}
function bind(name: string) {
	return {
		kind: "bind",
		origin: "user",
		name,
		modelProfiles: { worker: { model: `offline/${name}` } },
	};
}
function flushFixture(manager: SessionManager) {
	// An ordinary test-owned conversation message triggers Pi's normal persistence.
	manager.appendMessage({
		role: "user",
		content: "isolated reader fixture",
		timestamp: Date.now(),
	});
}
function expectBound(manager: SessionManager, name: string) {
	const result = readSessionProfileDisk(manager);
	assert.equal(result.status, "bound");
	if (result.status !== "bound")
		throw new Error("Expected corroborated binding");
	assert.equal(result.binding.name, name);
}

test("custom-only public session cannot restore memory; ordinary fixture flush corroborates", (t) => {
	const { manager } = fixture(t);
	manager.appendCustomEntry(customType, bind("initial"));
	const path = manager.getSessionFile();
	assert.ok(path);
	assert.equal(existsSync(path), false);
	assert.equal(readSessionProfileDisk(manager).status, "indeterminate");
	flushFixture(manager);
	expectBound(manager, "initial");
});

test("malformed line Pi skips on open does not block corroboration", (t) => {
	const { manager, sessions } = fixture(t);
	manager.appendCustomEntry(customType, bind("before"));
	flushFixture(manager);
	const path = manager.getSessionFile();
	assert.ok(path);
	appendFileSync(path, '{"type":"custom","id":"torn\n');
	const reopened = SessionManager.open(path, sessions);
	expectBound(reopened, "before");
	reopened.appendCustomEntry(customType, bind("after"));
	flushFixture(reopened);
	expectBound(reopened, "after");
});

test("public selected branch, sibling and extracted session stay separated", (t) => {
	const { manager, sessions } = fixture(t);
	manager.appendCustomEntry(customType, bind("base"));
	flushFixture(manager);
	const base = manager.getLeafId();
	assert.ok(base);
	manager.appendCustomEntry(customType, bind("left"));
	const left = manager.getLeafId();
	assert.ok(left);
	manager.branch(base);
	manager.appendCustomEntry(customType, bind("right"));
	expectBound(manager, "right");
	manager.branch(left);
	expectBound(manager, "left");
	const originalFile = manager.getSessionFile();
	const extracted = manager.createBranchedSession(left);
	assert.ok(extracted);
	assert.notEqual(extracted, originalFile);
	const reopened = SessionManager.open(extracted, sessions);
	expectBound(reopened, "left");
	assert.equal(
		reopened
			.getBranch()
			.some(
				(row) =>
					row.type === "custom" && (row.data as { name?: string })?.name === "right",
			),
		false,
	);
});

for (const recovery of ["bind", "clear"] as const) {
	test(`real EISDIR preserves corroboration; new ${recovery} survives a missing parent`, (t) => {
		const { manager, sessions } = fixture(t);
		manager.appendCustomEntry(customType, bind("good"));
		flushFixture(manager);
		const file = manager.getSessionFile();
		assert.ok(file);
		const original = readFileSync(file, "utf8");
		const before = structuredClone(manager.getBranch());
		const retained = manager.getLeafId();
		assert.ok(retained);
		const saved = `${file}.saved`;
		renameSync(file, saved);
		mkdirSync(file);
		assert.throws(
			() => manager.appendCustomEntry(customType, bind("failed")),
			(error: unknown) => {
				assert.equal((error as NodeJS.ErrnoException).code, "EISDIR");
				return true;
			},
		);
		const after = manager.getBranch();
		let failedLeaf = retained;
		const knownFailedEntryIds = new Set<string>();
		if (rollsBackFailedAppend) {
			assert.deepEqual(after, before, "SDK rolls back the failed entry and leaf");
			assert.equal(manager.getLeafId(), retained);
		} else {
			assert.equal(after.length, before.length + 1);
			assert.deepEqual(after.slice(0, before.length), before);
			const ghost = after.at(-1);
			assert.ok(ghost);
			assert.equal(ghost.type, "custom");
			assert.equal(ghost.customType, customType);
			assert.deepEqual(ghost.data, bind("failed"));
			assert.equal(ghost.parentId, retained);
			assert.ok(ghost.id);
			assert.notEqual(ghost.id, retained);
			assert.equal(manager.getLeafId(), ghost.id);
			failedLeaf = ghost.id;
			knownFailedEntryIds.add(ghost.id);
		}
		assert.equal(readFileSync(saved, "utf8"), original);
		assert.equal(readSessionProfileDisk(manager).status, "indeterminate");
		renameSync(file, `${file}.fault-directory`);
		renameSync(saved, file);
		if (rollsBackFailedAppend) {
			expectBound(manager, "good");
		} else {
			assert.deepEqual(readSessionProfileDisk(manager), { status: "indeterminate", reason: "selected-record-missing" });
			const old = readSessionProfileDisk(manager, { knownFailedEntryIds });
			assert.equal(old.status, "bound");
			if (old.status === "bound") assert.equal(old.binding.name, "good");
		}
		manager.appendCustomEntry(
			customType,
			recovery === "bind" ? bind("recovered") : { kind: "clear" },
		);
		const latest = manager.getBranch().at(-1);
		assert.ok(latest);
		assert.equal(latest.parentId, failedLeaf);
		const disk = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(disk.some((row) => row.id === retained), true);
		if (!rollsBackFailedAppend) assert.equal(disk.some((row) => row.id === failedLeaf), false);
		assert.deepEqual(
			disk.find((row) => row.id === latest.id),
			JSON.parse(JSON.stringify(latest)),
		);
		assert.equal(
			readSessionProfileDisk(manager, { knownFailedEntryIds }).status,
			recovery === "bind" ? "bound" : "cleared",
		);
		const reopened = SessionManager.open(file, sessions);
		if (rollsBackFailedAppend) {
			assert.deepEqual(reopened.getBranch(), manager.getBranch());
			// With rollback, use a separately damaged test-owned file for a disk gap.
			const orphanFile = `${file}.orphan.jsonl`;
			writeFileSync(orphanFile,
				disk.filter((row) => row.id !== retained)
					.map((row) => JSON.stringify(row)).join("\n") + "\n",
			);
			const orphan = SessionManager.open(orphanFile, sessions);
			assert.deepEqual(orphan.getBranch(), [JSON.parse(JSON.stringify(latest))]);
			assert.equal(readSessionProfileDisk(orphan).status, recovery === "bind" ? "bound" : "cleared");
			if (recovery === "bind") expectBound(orphan, "recovered");
		} else {
			// The real failed parent is absent on disk; Pi reopens the recovered suffix.
			assert.deepEqual(reopened.getBranch(), [JSON.parse(JSON.stringify(latest))]);
		}
		assert.equal(
			readSessionProfileDisk(reopened).status,
			recovery === "bind" ? "bound" : "cleared",
		);
		if (recovery === "bind") expectBound(reopened, "recovered");
	});
}
