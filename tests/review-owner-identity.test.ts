import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createCandidateOwner, prepareCandidateOwnerParent, WindowsOwnerValidationError } from "../lib/review-candidate-view-owner.ts";

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
	let whoamiUser: string | undefined;
	let foreignPath: string | undefined;
	const probes = { user: 0, whoami: 0, administrator: 0, owner: [] as string[], dacl: [] as string[], enforce: [] as string[], sddl: [] as string[] };
	const native = fs.realpathSync.native;
	t.mock.method(fs.realpathSync, "native", (path: string) =>
		path.startsWith("\\\\?\\GLOBALROOT\\SystemRoot\\System32") ? path : native(path));
	t.mock.method(childProcess, "execFileSync", (command: string, args: string[], options: any) => {
		const name = command.split(/[\\/]/).at(-1);
		if (name === "whoami.exe") {
			probes.user++;
			probes.whoami++;
			return identityFailure === "user" ? "unavailable" : whoamiUser ?? user;
		}
		if (name === "powershell.exe") {
			const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
			if (script.includes("gentle-pi.windows-acl-probe/v1")) {
				probes.user++;
				if (identityFailure === "user") throw Object.assign(new Error("fixture user unavailable"), { code: "EACCES" });
				probes.administrator++;
				if (identityFailure === "administrator") throw Object.assign(new Error("fixture administrator unavailable"), { code: "EACCES" });
				const requests = JSON.parse(options.input) as { path: string; kind: string }[];
				return JSON.stringify({ schema: "gentle-pi.windows-acl-probe/v1", user, localAdministrator: "S-1-5-21-1-2-3-500", entries: requests.map((request, index) => {
					probes.owner.push(request.path); probes.dacl.push(request.path);
					const directory = request.kind === "directory";
					const flags = directory ? "OICI" : "ID";
					return { index, owner: (replacedMarker && request.path.endsWith(".owner.json")) || request.path === foreignPath ? "S-1-5-21-9-8-7-1002" : user,
						dacl: `D:${directory ? "P" : ""}(A;${flags};FA;;;${user})(A;${flags};FA;;;SY)(A;${flags};FA;;;BA)` };
				}) });
			}
			if (script.includes("SetAccessControl")) {
				probes.enforce.push(options.env.GENTLE_PI_CANDIDATE_ACL_PATH);
				probes.sddl.push(options.env.GENTLE_PI_CANDIDATE_ACL_SDDL);
				return "";
			}
			const path = options.env.GENTLE_PI_CANDIDATE_OWNER_PATH;
			probes.owner.push(path);
			return (replacedMarker && path.endsWith(".owner.json")) || path === foreignPath ? "S-1-5-21-9-8-7-1002" : user;
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
		disagreeWhoami: () => { whoamiUser = "S-1-5-21-7-7-7-1003"; },
		foreignOwner: (path: string) => { foreignPath = path; },
		replaceMarker: () => { replacedMarker = true; } };
}

test("Windows creation refreshes identity at each boundary and preserves every filesystem probe", (t) => {
	const f = fixture(t);
	for (let operation = 1; operation <= 2; operation++) {
		if (operation === 2) f.changeUser();
		const root = join(f.parent, randomUUID());
		const owner = createCandidateOwner(f.commonDir, root, "win32");
		const marker = `${root}.owner.json`;
		assert.equal(owner.root, root);
		assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), owner);
		assert.equal(fs.existsSync(root), false);
		assert.equal(f.probes.user, operation * 2, "fresh user SID at the parent batch and marker boundary");
		assert.equal(f.probes.administrator, operation * 2, "fresh administrator SID at the parent batch and marker boundary");
		assert.deepEqual(f.probes.owner.slice((operation - 1) * 4), [...f.boundary, marker]);
		assert.deepEqual(f.probes.dacl.slice((operation - 1) * 4), [...f.boundary, marker]);
		assert.deepEqual(f.probes.enforce, []);
	}
});

test("Windows preparation retains fresh pre-write and post-write owner/DACL checks", (t) => {
	const f = fixture(t);
	assert.equal(prepareCandidateOwnerParent(f.commonDir, "win32"), f.parent);
	assert.equal(f.probes.user, 4, "one pre-write identity batch plus one fresh read-back per directory");
	assert.equal(f.probes.whoami, 0);
	assert.equal(f.probes.administrator, 4);
	assert.deepEqual(f.probes.owner, [...f.boundary, ...f.boundary.flatMap(path => [path, path])]);
	// The pre-write batch observes the DACLs it is about to replace; only the
	// read-back observations are validated as private.
	assert.deepEqual(f.probes.dacl, [...f.boundary, ...f.boundary]);
	assert.deepEqual(f.probes.enforce, f.boundary);
});

test("Windows preparation takes its identity from the probe that reads owners back", (t) => {
	const f = fixture(t);
	// whoami and the .NET token can only disagree in theory; preparation must
	// not depend on a second identity source it never re-reads.
	f.disagreeWhoami();
	assert.equal(prepareCandidateOwnerParent(f.commonDir, "win32"), f.parent);
	assert.equal(f.probes.whoami, 0);
	assert.deepEqual(f.probes.enforce, f.boundary);
	for (const sddl of f.probes.sddl) assert.match(sddl, /^D:P\(A;OICI;FA;;;S-1-5-21-1-2-3-1001\)/);
});

for (const index of [0, 1, 2]) test(`Windows preparation rejects a foreign owner at boundary ${index} before rewriting any DACL`, (t) => {
	const f = fixture(t);
	f.foreignOwner(f.boundary[index]!);
	assert.throws(() => prepareCandidateOwnerParent(f.commonDir, "win32"), WindowsOwnerValidationError);
	assert.deepEqual(f.probes.enforce, []);
});

for (const kind of ["user", "administrator"]) test(`Windows preparation fails closed on ${kind} identity failure before rewriting any DACL`, (t) => {
	const f = fixture(t);
	f.failIdentity(kind);
	assert.throws(() => prepareCandidateOwnerParent(f.commonDir, "win32"), WindowsOwnerValidationError);
	assert.deepEqual(f.probes.enforce, []);
});

for (const kind of ["user", "administrator"]) test(`Windows creation fails closed on fresh ${kind} identity failure`, (t) => {
	const f = fixture(t);
	const first = createCandidateOwner(f.commonDir, join(f.parent, randomUUID()), "win32");
	const marker = `${first.root}.owner.json`;
	const before = fs.readFileSync(marker, "utf8");
	const stored = fs.readdirSync(f.parent);
	f.failIdentity(kind);
	const root = join(f.parent, randomUUID());
	assert.throws(() => createCandidateOwner(f.commonDir, root, "win32"), WindowsOwnerValidationError);
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
	assert.equal(f.probes.user, 3, "rollback obtains another fresh identity observation");
	assert.equal(f.probes.administrator, 3);
	assert.deepEqual(f.probes.owner, [...f.boundary, marker, marker]);
	assert.deepEqual(f.probes.dacl, [...f.boundary, marker, marker]);
	assert.equal(fs.existsSync(marker), true, "unproven marker survives rollback");
	assert.equal(fs.readFileSync(marker, "utf8"), "");
	assert.equal(fs.existsSync(root), false);
});
