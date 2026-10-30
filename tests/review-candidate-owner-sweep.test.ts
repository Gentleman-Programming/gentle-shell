import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assertCandidateOwnerParent,
	removeCandidateOwner,
	setWindowsAclAuthorityForTesting,
	sweepCandidateOwners,
	type CandidateViewOwner,
} from "../lib/review-candidate-view-owner.ts";
import { CandidateViewRegistry } from "../lib/review-candidate-view.ts";

function fixture(t: test.TestContext, count: number) {
	const commonDir = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-owner-sweep-")));
	t.after(() => rmSync(commonDir, { recursive: true, force: true }));
	const parent = join(commonDir, "gentle-ai", "candidate-views");
	mkdirSync(parent, { recursive: true });
	const owners: CandidateViewOwner[] = [];
	for (let i = 0; i < count; i++) {
		const uuid = randomUUID();
		const root = join(parent, uuid);
		const owner: CandidateViewOwner = { version: 1, uuid, token: randomUUID(), pid: process.pid, host: null, root, commonDir };
		writeFileSync(`${root}.owner.json`, JSON.stringify(owner));
		owners.push(owner);
	}
	const snapshot = () => readdirSync(parent).sort().map(name => [name, readFileSync(join(parent, name), "utf8")]);
	return { commonDir, parent, owners, snapshot };
}

test("Windows automatic owner sweeps avoid ACL probes and preserve every marker", t => {
	let aclProbes = 0;
	let gitCalls = 0;
	let writableCalls = 0;
	setWindowsAclAuthorityForTesting(() => { aclProbes++; });
	t.after(() => setWindowsAclAuthorityForTesting());
	for (const count of [0, 1, 7, 30]) {
		const { commonDir, snapshot } = fixture(t, count);
		const before = snapshot();
		for (let pass = 0; pass < 2; pass++) {
			sweepCandidateOwners(commonDir, () => { gitCalls++; return ""; }, () => { writableCalls++; }, "win32");
			assert.deepEqual(snapshot(), before);
		}
	}
	assert.equal(gitCalls, 0);
	assert.equal(writableCalls, 0);
	assert.equal(aclProbes, 0);
});

test("registry startup sweeping on Windows preserves markers without ACL work", t => {
	const { commonDir, snapshot } = fixture(t, 3);
	const before = snapshot();
	let aclProbes = 0;
	const recorded: string[][] = [];
	setWindowsAclAuthorityForTesting(() => { aclProbes++; });
	t.after(() => setWindowsAclAuthorityForTesting());
	const registry = new CandidateViewRegistry((_file, args) => {
		recorded.push([...args]);
		assert.deepEqual(args, ["rev-parse", "--git-common-dir"]);
		return commonDir;
	}, "win32");
	registry.sweepOrphans(commonDir);
	assert.deepEqual(recorded, [["rev-parse", "--git-common-dir"]]);
	assert.deepEqual(snapshot(), before);
	assert.equal(aclProbes, 0);
});

test("explicit Windows owner validation and cleanup still reject untrusted ACLs", t => {
	const { commonDir, owners, snapshot } = fixture(t, 1);
	const before = snapshot();
	const denied = new Error("fixture ACL denied");
	let aclProbes = 0;
	let destructiveCalls = 0;
	setWindowsAclAuthorityForTesting(() => { aclProbes++; throw denied; });
	t.after(() => setWindowsAclAuthorityForTesting());
	assert.throws(() => assertCandidateOwnerParent(commonDir, "win32"), error => error === denied);
	assert.throws(() => removeCandidateOwner(owners[0]!, () => { destructiveCalls++; return ""; }, () => { destructiveCalls++; }, false, "win32"), error => error === denied);
	assert.equal(aclProbes, 2);
	assert.equal(destructiveCalls, 0);
	assert.deepEqual(snapshot(), before);
});

test("unavailable POSIX owner stores remain a best-effort no-op", t => {
	const { commonDir, snapshot } = fixture(t, 1);
	const before = snapshot();
	const missing = join(commonDir, "missing");
	let callbacks = 0;
	sweepCandidateOwners(missing, () => { callbacks++; return ""; }, () => { callbacks++; }, "linux");
	assert.equal(callbacks, 0);
	assert.deepEqual(snapshot(), before);
});
