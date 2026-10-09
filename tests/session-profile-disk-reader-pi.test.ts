// Run only in the parent's isolated snapshot with supported existing Pi deps.
// Public API fixtures, never providers or production flush/rollback workarounds.
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
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
assert.ok(
	Number(version.split(".")[0]) >= 1,
	`Pi >=1.0.0 required, installed ${version}`,
);
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
	test(`real EISDIR ghost quarantined; new ${recovery} corroborates missing parent even after reopen`, (t) => {
		const { manager, sessions } = fixture(t);
		manager.appendCustomEntry(customType, bind("good"));
		flushFixture(manager);
		const file = manager.getSessionFile();
		assert.ok(file);
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
		const failedId = manager.getLeafId();
		assert.ok(failedId);
		assert.equal(readSessionProfileDisk(manager).status, "indeterminate");
		renameSync(file, `${file}.fault-directory`);
		renameSync(saved, file);
		assert.equal(readSessionProfileDisk(manager).status, "indeterminate");
		const knownFailedEntryIds = new Set([failedId]);
		const old = readSessionProfileDisk(manager, { knownFailedEntryIds });
		assert.equal(old.status, "bound");
		if (old.status === "bound") assert.equal(old.binding.name, "good");
		manager.appendCustomEntry(
			customType,
			recovery === "bind" ? bind("recovered") : { kind: "clear" },
		);
		const latest = manager.getBranch().at(-1);
		assert.ok(latest);
		assert.equal(latest.parentId, failedId);
		const disk = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(
			disk.some((row) => row.id === failedId),
			false,
		);
		assert.deepEqual(
			disk.find((row) => row.id === latest.id),
			JSON.parse(JSON.stringify(latest)),
		);
		assert.equal(
			readSessionProfileDisk(manager, { knownFailedEntryIds }).status,
			recovery === "bind" ? "bound" : "cleared",
		);
		const reopened = SessionManager.open(file, sessions);
		assert.equal(reopened.getBranch().length, 1);
		assert.equal(reopened.getBranch()[0].id, latest.id);
		assert.equal(
			readSessionProfileDisk(reopened).status,
			recovery === "bind" ? "bound" : "cleared",
		);
		if (recovery === "bind") expectBound(reopened, "recovered");
	});
}
