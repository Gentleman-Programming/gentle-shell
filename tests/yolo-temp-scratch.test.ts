import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultTempScratchFs, isTempScratchTarget, type TempScratchFs } from "../lib/yolo-temp-scratch.ts";

const ownDir = { uid: 1000, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
const mock = (overrides: Partial<TempScratchFs> = {}): TempScratchFs => ({
	uid: 1000, tmpdir: "/tmp", home: "/home/user",
	lstat: () => ownDir,
	...overrides,
});

test("temp roots are /tmp, /var/tmp and the resolved tmpdir, never the root itself", () => {
	assert.equal(isTempScratchTarget("/tmp/tmp.abcdef", mock()), true);
	assert.equal(isTempScratchTarget("/var/tmp/tmp.abcdef", mock()), true);
	assert.equal(isTempScratchTarget("/run/user/1000/tmp.abcdef", mock({ tmpdir: "/run/user/1000" })), true);
	for (const target of ["/tmp", "/var/tmp", "/run/user/1000/tmp.abcdef", "/", "/tmp.abcdef"]) {
		assert.equal(isTempScratchTarget(target, mock()), false, target);
	}
});

test("a tmpdir that is /, home, an ancestor or a descendant of home is not a temp root", () => {
	for (const tmpdir of ["/", "/home/user", "/home", "/home/user/work/repo"]) {
		const fs = mock({ tmpdir });
		for (const target of ["/tmp.abcdef", "/home/user/tmp.abcdef", "/home/tmp.abcdef", "/home/user/work/repo/tmp.abcdef"]) {
			assert.equal(isTempScratchTarget(target, fs), false, `${tmpdir}: ${target}`);
		}
	}
	const ownFile = { uid: 1000, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
	assert.equal(isTempScratchTarget("/home/gentleman/work/repo/README.md", mock({ home: "/home/gentleman", tmpdir: "/home/gentleman/work/repo", lstat: () => ownFile })), false);
	assert.equal(isTempScratchTarget("/home/gentleman-tmp/x.log", mock({ home: "/home/gentleman", tmpdir: "/home/gentleman-tmp", lstat: () => ownFile })), true, "sibling prefix is not a descendant");
});

test("only mktemp-named own directories qualify; files need ownership, symlinks and missing paths always qualify", () => {
	const dir = (uid: number) => ({ uid, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false });
	assert.equal(isTempScratchTarget("/tmp/tmp.ab12CD", mock({ lstat: () => dir(1000) })), true);
	assert.equal(isTempScratchTarget("/tmp/tmp.ab12C", mock({ lstat: () => dir(1000) })), false, "short suffix");
	assert.equal(isTempScratchTarget("/tmp/cache", mock({ lstat: () => dir(1000) })), false, "non-mktemp name");
	assert.equal(isTempScratchTarget("/tmp/tmp.ab12CD", mock({ lstat: () => dir(0) })), false, "other uid");
	const other = { uid: 0, isDirectory: () => false, isFile: () => false, isSymbolicLink: () => false };
	assert.equal(isTempScratchTarget("/tmp/fifo", mock({ lstat: () => other })), false, "special file");
	assert.equal(isTempScratchTarget("/tmp/x.log", mock({ lstat: () => ({ ...other, uid: 1000, isFile: () => true }) })), true);
	assert.equal(isTempScratchTarget("/tmp/x.log", mock({ lstat: () => ({ ...other, isFile: () => true }) })), false);
	assert.equal(isTempScratchTarget("/tmp/link", mock({ lstat: () => ({ ...other, isSymbolicLink: () => true }) })), true);
	const missing = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
	assert.equal(isTempScratchTarget("/tmp/whatever", mock({ lstat: missing })), true);
	const denied = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
	assert.equal(isTempScratchTarget("/tmp/whatever", mock({ lstat: denied })), false);
});

test("the production probe recognizes a real mktemp directory, own file and symlink", () => {
	const fs = defaultTempScratchFs();
	if (fs.uid === undefined) return;
	const root = realpathSync(tmpdir());
	const scratch = mkdtempSync(join(root, "tmp."));
	const file = join(root, `gentle-scratch-${process.pid}.log`);
	const link = join(root, `gentle-scratch-${process.pid}.link`);
	const named = mkdtempSync(join(root, "gentle-scratch-"));
	try {
		writeFileSync(file, "log");
		symlinkSync(named, link);
		assert.equal(isTempScratchTarget(scratch, fs), true, scratch);
		assert.equal(isTempScratchTarget(file, fs), true, file);
		assert.equal(isTempScratchTarget(link, fs), true, link);
		assert.equal(isTempScratchTarget(named, fs), false, named);
	} finally {
		for (const path of [scratch, file, link, named]) rmSync(path, { recursive: true, force: true });
	}
});
