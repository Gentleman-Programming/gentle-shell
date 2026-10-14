import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createCandidateOwner, prepareCandidateOwnerParent } from "../lib/review-candidate-view-owner.ts";

function fixture(t: test.TestContext) {
	fs.mkdirSync(resolve("tmp"), { recursive: true });
	const base = fs.realpathSync(fs.mkdtempSync(join(resolve("tmp"), "owner-identity-")));
	const commonDir = join(base, "common");
	const parent = join(commonDir, "gentle-ai", "candidate-views");
	fs.mkdirSync(parent, { recursive: true });
	const boundary = [commonDir, dirname(parent), parent];
	let user = "S-1-5-21-1-2-3-1001";
	let identityFailure = "";
	let replacedMarker = false;
	const probes = { user: 0, administrator: 0, owner: [] as string[], dacl: [] as string[], enforce: [] as string[] };
	const native = fs.realpathSync.native;
	t.mock.method(fs.realpathSync, "native", (path: string) =>
		path.startsWith("\\\\?\\GLOBALROOT\\SystemRoot\\System32") ? path : native(path));
	t.mock.method(childProcess, "execFileSync", (command: string, args: string[], options: any) => {
		const name = command.split(/[\\/]/).at(-1);
		if (name === "whoami.exe") {
			probes.user++;
			return identityFailure === "user" ? "unavailable" : user;
		}
		if (name === "icacls.exe") {
			probes.dacl.push(args[0]);
			const directory = fs.lstatSync(args[0]).isDirectory();
			const flags = directory ? "OICI" : "ID";
			const dacl = `D:${directory ? "P" : ""}(A;${flags};FA;;;${user})(A;${flags};FA;;;SY)(A;${flags};FA;;;BA)`;
			fs.writeFileSync(join(options.cwd, args[2]), dacl, "utf16le");
			return "";
		}
		if (name === "powershell.exe") {
			const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
			if (script.includes("RawSecurityDescriptor")) {
				probes.administrator++;
				return identityFailure === "administrator" ? "unavailable" : "S-1-5-21-1-2-3-500";
			}
			if (script.includes("SetAccessControl")) {
				probes.enforce.push(options.env.GENTLE_PI_CANDIDATE_ACL_PATH);
				return "";
			}
			const path = options.env.GENTLE_PI_CANDIDATE_OWNER_PATH;
			probes.owner.push(path);
			return replacedMarker && path.endsWith(".owner.json") ? "S-1-5-21-9-8-7-1002" : user;
		}
		throw new Error(`Unexpected subprocess: ${name}`);
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		fs.rmSync(base, { recursive: true, force: true });
	});
	return { commonDir, parent, boundary, probes,
		changeUser: () => { user = "S-1-5-21-4-5-6-1002"; },
		failIdentity: (kind: string) => { identityFailure = kind; },
		replaceMarker: () => { replacedMarker = true; } };
}

test("Windows creation reuses identity only within one operation and preserves every filesystem probe", (t) => {
	const f = fixture(t);
	for (let operation = 1; operation <= 2; operation++) {
		if (operation === 2) f.changeUser();
		const root = join(f.parent, randomUUID());
		const owner = createCandidateOwner(f.commonDir, root, "win32");
		const marker = `${root}.owner.json`;
		assert.equal(owner.root, root);
		assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), owner);
		assert.equal(fs.existsSync(root), false);
		assert.equal(f.probes.user, operation, "one fresh user SID per creation");
		assert.equal(f.probes.administrator, operation, "one fresh administrator SID per creation");
		assert.deepEqual(f.probes.owner.slice((operation - 1) * 4), [...f.boundary, marker]);
		assert.deepEqual(f.probes.dacl.slice((operation - 1) * 4), [...f.boundary, marker]);
		assert.deepEqual(f.probes.enforce, []);
	}
});

test("Windows preparation retains fresh pre-write and post-write owner/DACL checks", (t) => {
	const f = fixture(t);
	assert.equal(prepareCandidateOwnerParent(f.commonDir, "win32"), f.parent);
	assert.equal(f.probes.user, 1);
	assert.equal(f.probes.administrator, 1);
	assert.deepEqual(f.probes.owner, [...f.boundary, ...f.boundary.flatMap(path => [path, path])]);
	assert.deepEqual(f.probes.dacl, f.boundary);
	assert.deepEqual(f.probes.enforce, f.boundary);
});

for (const kind of ["user", "administrator"]) test(`Windows creation fails closed on fresh ${kind} identity failure`, (t) => {
	const f = fixture(t);
	const first = createCandidateOwner(f.commonDir, join(f.parent, randomUUID()), "win32");
	const marker = `${first.root}.owner.json`;
	const before = fs.readFileSync(marker, "utf8");
	const stored = fs.readdirSync(f.parent);
	f.failIdentity(kind);
	const root = join(f.parent, randomUUID());
	assert.throws(() => createCandidateOwner(f.commonDir, root, "win32"), /SID is unavailable/);
	assert.equal(fs.existsSync(root), false);
	assert.equal(fs.existsSync(`${root}.owner.json`), false);
	assert.equal(fs.readFileSync(marker, "utf8"), before);
	assert.deepEqual(fs.readdirSync(f.parent), stored);
	assert.equal(f.probes.owner.length, 4);
	assert.equal(f.probes.dacl.length, 4);
});

test("Windows creation rollback rechecks a replaced marker owner before removal", (t) => {
	const f = fixture(t);
	const write = fs.writeFileSync;
	const root = join(f.parent, randomUUID());
	const marker = `${root}.owner.json`;
	t.mock.method(fs, "writeFileSync", (...args: any[]) => {
		if (typeof args[0] === "number") {
			f.replaceMarker();
			throw new Error("fixture write failure");
		}
		return (write as any)(...args);
	});
	syncBuiltinESMExports();
	assert.throws(() => createCandidateOwner(f.commonDir, root, "win32"), /fixture write failure/);
	assert.equal(f.probes.user, 1);
	assert.equal(f.probes.administrator, 1);
	assert.deepEqual(f.probes.owner, [...f.boundary, marker, marker]);
	assert.deepEqual(f.probes.dacl, [...f.boundary, marker]);
	assert.equal(fs.existsSync(marker), true, "unproven marker survives rollback");
	assert.equal(fs.readFileSync(marker, "utf8"), "");
	assert.equal(fs.existsSync(root), false);
});
