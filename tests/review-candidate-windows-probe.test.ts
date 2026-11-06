import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertCandidateOwnerParent, decodeWindowsAclProbe, WindowsOwnerValidationError } from "../lib/review-candidate-view-owner.ts";

const user = "S-1-5-21-1-2-3-1001";
const administrator = "S-1-5-21-1-2-3-500";
const dacl = `D:P(A;OICI;FA;;;${user})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;
const response = () => ({ schema: "gentle-pi.windows-acl-probe/v1", user, localAdministrator: administrator,
	entries: [{ index: 0, owner: user, dacl }, { index: 1, owner: "S-1-5-18", dacl }] });

test("Windows batch probe decodes ordered complete observations without path or SID diagnostics", () => {
	const result = decodeWindowsAclProbe(JSON.stringify(response()), 2);
	assert.equal(result.user, user);
	assert.equal(result.localAdministrator, administrator);
	assert.deepEqual(result.entries, response().entries);
});

test("Windows batch probe rejects partial, reordered, duplicated and unknown observations", () => {
	for (const invalid of [
		null, [], {}, { ...response(), extra: "unknown" }, { ...response(), schema: "other" },
		{ ...response(), user: "administrator" }, { ...response(), localAdministrator: "LA" },
		{ ...response(), entries: response().entries.slice(0, 1) },
		{ ...response(), entries: [...response().entries].reverse() },
		{ ...response(), entries: [response().entries[0], response().entries[0]] },
		{ ...response(), entries: [{ ...response().entries[0], owner: null }, response().entries[1]] },
		{ ...response(), entries: [{ ...response().entries[0], dacl: "" }, response().entries[1]] },
		{ ...response(), entries: [{ ...response().entries[0], path: "unrequested" }, response().entries[1]] },
	]) assert.throws(() => decodeWindowsAclProbe(JSON.stringify(invalid), 2), error => {
		assert.ok(error instanceof Error);
		assert.ok(!error.message.includes(user));
		assert.ok(!error.message.includes(administrator));
		return true;
	});
	for (const payload of ["", "{", JSON.stringify(response()).slice(0, -1)]) assert.throws(() => decodeWindowsAclProbe(payload, 2));
	for (const count of [0, -1, 4, 1.5]) assert.throws(() => decodeWindowsAclProbe(JSON.stringify(response()), count));
});

test("Windows probe failures and foreign owners block without retrying invalid authority", { skip: process.platform !== "win32" }, t => {
	const parent = realpathSync(tmpdir()); const root = mkdtempSync(join(parent, "rdd-probe-response-"));
	mkdirSync(join(root, "gentle-ai", "candidate-views"), { recursive: true });
	const original = childProcess.execFileSync;
	let payload = "{"; let calls = 0;
	t.mock.method(childProcess, "execFileSync", ((file: string, args: string[], options: unknown) => {
		if (file.toLowerCase().endsWith("powershell.exe")) { calls++; return payload; }
		return original(file, args, options as never);
	}) as typeof childProcess.execFileSync);
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll(); syncBuiltinESMExports();
		assert.equal(dirname(root), parent); assert.ok(root.startsWith(join(parent, "rdd-probe-response-"))); assert.equal(realpathSync(root), root);
		rmSync(root, { recursive: true, force: true });
	});
	assert.throws(() => assertCandidateOwnerParent(root, "win32"), /probe response is invalid/);
	assert.equal(calls, 1);
	payload = JSON.stringify({ ...response(), entries: [0, 1, 2].map(index => ({ index, owner: "S-1-5-21-9-8-7-1002", dacl })) });
	assert.throws(() => assertCandidateOwnerParent(root, "win32"), WindowsOwnerValidationError);
	assert.equal(calls, 2, "a valid transport response with untrusted authority is not retried");
});
