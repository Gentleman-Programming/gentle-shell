import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, copyFileSync, existsSync, symlinkSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { artifactFor, compatibleEngine, windowsBootstrapMessage } from "../scripts/installer-downloads.mjs";
import { validateWindowsEntries, proveWindowsWrapper, windowsNodeFloor, readWindowsPnpmArchive, ensureWindowsPnpm, windowsProcessCheck, windowsAclRuleUnsafe, verifyWindowsStorage,
	bootstrapWindows, windowsBootstrapReason, windowsStorageEvidence } from "../scripts/installer-windows.mjs";

const wrapper = (entry: string) => `@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n\nIF EXIST "%dp0%\\node.exe" (\n  SET "_prog=%dp0%\\node.exe"\n) ELSE (\n  SET "_prog=node"\n  SET PATHEXT=%PATHEXT:;.JS;=;%\n)\n\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\${entry}" %*\n`;

test("Windows descriptors select immutable official ZIPs without changing POSIX pins", () => {
	for (const arch of ["x64", "arm64"]) {
		const descriptor = artifactFor("node", "win32", arch);
		assert.equal(descriptor.version, "24.21.0");
		assert.equal(descriptor.url, `https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-${arch}.zip`);
		assert.match(descriptor.integrity, /^sha256-[a-f0-9]{64}$/);
	}
	assert.equal(artifactFor("node", "linux", "x64").integrity, "sha256-6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff");
	assert.throws(() => artifactFor("node", "win32", "ia32"));
	assert.equal(windowsNodeFloor, ">=24.3.0");
	assert.equal(compatibleEngine(windowsNodeFloor, "24.2.0"), false);
});

test("Windows archive namespace rejects traversal, aliases, reserved names, ADS and links", () => {
	assert.doesNotThrow(() => validateWindowsEntries([{ name: "package/", directory: true }, { name: "package/bin/pnpm.mjs" }]));
	for (const name of ["../escape", "/absolute", "C:/drive", "package/a:b", "package/a.", "package/a ", "package/CON.txt", "package/aux", "package/COM1", "package/LPT9.x", "package/a\\b", "package//b", "package/./b", "package/\u0000x"]) {
		assert.throws(() => validateWindowsEntries([{ name }]), /Unsafe/);
	}
	assert.throws(() => validateWindowsEntries([{ name: "package/A" }, { name: "package/a" }]), /Unsafe/);
	assert.throws(() => validateWindowsEntries([{ name: "Package/a" }, { name: "package/b" }]), /Unsafe/);
	assert.throws(() => validateWindowsEntries([{ name: "package/a", link: true }]), /Unsafe/);
	assert.throws(() => validateWindowsEntries([{ name: "package/a" }, { name: "package/a/b" }]), /Unsafe/);
});

test("only the complete known npm cmd shim proves selected Node and exact JS target", () => {
	const entry = "node_modules\\pnpm\\bin\\pnpm.cjs";
	assert.deepEqual(proveWindowsWrapper(wrapper(entry)), { entry, localNode: "node.exe", fallbackNode: "node", flags: [], environment: "inherited" });
	assert.deepEqual(proveWindowsWrapper(wrapper(entry).replaceAll("\n", "\r\n")), proveWindowsWrapper(wrapper(entry)));
	for (const altered of [wrapper(entry) + "echo changed\n", wrapper(entry).replace('"%_prog%"', '"%_prog%" --require evil'), wrapper(entry).replace("SETLOCAL", "SET NODE_OPTIONS=--require evil\nSETLOCAL"), wrapper("elsewhere\\pnpm.cjs"), "@node pnpm.mjs %*"]) {
		assert.throws(() => proveWindowsWrapper(altered), /Unknown pnpm wrapper/);
	}
});

test("CMD entry contains fixed commands, data-only paths, early bundle checks and no policy bypass", () => {
	const source = readFileSync(new URL("../scripts/bootstrap.cmd", import.meta.url), "utf8");
	assert.match(source, /DisableDelayedExpansion/i);
	assert.match(source, /\$env:GENTLE_BOOTSTRAP_BUNDLE/);
	assert.ok(source.indexOf("gentle-shell-install.mjs") < source.indexOf("New-Item"));
	assert.doesNotMatch(source, /ExecutionPolicy|Unblock-File|EncodedCommand|Invoke-Expression|\biex\b|\.ps1\b|SkipCertificateCheck|RunAs/i);
	assert.match(source, /LanguageMode/);
	assert.match(source, /ReparsePoint/);
	assert.match(source, /\[IO\.Directory\]::GetAccessControl\(/);
	assert.match(source, /AllowAutoRedirect\s*=\s*\$false/);
	assert.match(source, /Get-FileHash/);
});

test("authored sources retain readable lines and normalized whitespace", () => {
	for (const path of ["scripts/bootstrap.cmd", "scripts/installer-downloads.mjs", "scripts/installer-windows.mjs", "scripts/installer-windows-artifacts.json", "tests/installer-windows-bootstrap.test.ts", "docs/install-wizard.md"]) {
		const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
		assert.ok(source.endsWith("\n"), path);
		assert.doesNotMatch(source, /[ \t]+\r?$/m, path);
	}
	const batch = readFileSync(new URL("../scripts/bootstrap.cmd", import.meta.url), "utf8");
	for (const command of batch.replaceAll(/\^\r?\n/g, " ").split(/\r?\n/)) assert.ok(command.length < 7000, "fixed CMD command leaves expansion headroom below 8191 characters");
});

// A bounded interpretation of the exact fixed predicates, not Windows ACL
// execution. The legacy predicate's composite Write includes AppendData (4).
function fixedAclRejects(source: string, rights: number, depth: number) {
	if (source.includes("'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'")) return (rights & 0xd0156) !== 0;
	assert.match(source, /\$allowedRights = 0x1200a9; if \(\$depth -ge 2\) \{ \$allowedRights = 0x1200ad \}/);
	assert.match(source, /\[long\]\$rule.FileSystemRights -band \(-bnot \[long\]\$allowedRights\)/);
	assert.match(source, /\$depth\+\+/);
	return (rights & ~(depth >= 2 ? 0x1200ad : 0x1200a9)) !== 0;
}
function productionAclSources() {
	const batch = readFileSync(new URL("../scripts/bootstrap.cmd", import.meta.url), "utf8");
	return [
		batch.slice(batch.indexOf("rem Claim"), batch.indexOf("rem Select")),
		batch.slice(batch.indexOf("rem Production direct"), batch.indexOf("$start = New-Object")),
		readFileSync(new URL("../scripts/installer-windows.mjs", import.meta.url), "utf8").split("const aclCheck = String.raw`")[1].split("`;")[0],
	];
}
test("fixed ACL predicates allow sibling-only CreateDirectories on distant existing ancestors", () => {
	for (const source of productionAclSources()) {
		assert.equal(fixedAclRejects(source, 4, 2), false, "distant sibling creation alone cannot overwrite a protected existing descendant");
		assert.equal(fixedAclRejects(source, 4, 0), true, "actual target remains protected");
		assert.equal(fixedAclRejects(source, 4, 1), true, "immediate parent remains protected");
	}
});
test("fixed ACL predicates retain dangerous-right rejection at every depth", () => {
	for (const source of productionAclSources()) {
		for (const depth of [0, 1, 2, 5]) {
			for (const rights of [2, 16, 256, 64, 65536, 262144, 524288, 0xd0156, 4 | 64]) assert.equal(fixedAclRejects(source, rights, depth), true);
		}
	}
});

test("portable ACL fixture model matches fixed predicates without treating inheritance as effective access", () => {
	for (const depth of [0, 1, 2, 9]) {
		for (const rights of [0, 4, 0x1200a9, 0x1200ad, 2, 16, 256, 64, 65536, 262144, 524288, 0x10000000, 0x40000000, 0xffffffff]) {
			const rule = { rights, depth };
			for (const source of productionAclSources()) assert.equal(windowsAclRuleUnsafe(rule), fixedAclRejects(source, rights, depth));
			assert.equal(windowsAclRuleUnsafe({ ...rule, trusted: true }), false);
			assert.equal(windowsAclRuleUnsafe({ ...rule, allow: false }), false);
			assert.equal(windowsAclRuleUnsafe({ ...rule, inheritOnly: true }), false);
		}
	}
	assert.throws(() => windowsAclRuleUnsafe({ rights: -1, depth: 0 }));
	const batch = readFileSync(new URL("../scripts/bootstrap.cmd", import.meta.url), "utf8");
	assert.match(productionAclSources()[0], /\$depth = 1/);
	assert.match(productionAclSources()[1], /\$depth = 0/);
	assert.match(productionAclSources()[2], /\$depth = 0/);
	assert.match(batch, /AreAccessRulesProtected/);
	assert.match(batch, /\$claimed = \$true/);
});

function tarFixture(files: Record<string, string>, type = "0") {
	const chunks: Buffer[] = [];
	for (const [name, content] of Object.entries(files)) {
		const bytes = Buffer.from(content);
		const header = Buffer.alloc(512);
		header.write(name, 0, 100);
		header.write("0000644\0", 100);
		header.write("0000000\0", 108);
		header.write("0000000\0", 116);
		header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
		header.write("00000000000\0", 136);
		header.fill(32, 148, 156);
		header.write(type, 156);
		header.write("ustar\0", 257);
		header.write("00", 263);
		const checksum = header.reduce((sum, value) => sum + value, 0);
		header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
		chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
	}
	return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
const pinnedPackage = { name: "pnpm", version: "11.1.1", engines: { node: ">=22.13" }, bin: { pnpm: "bin/pnpm.mjs" } };
function pnpmTar(metadata = pinnedPackage) {
	return tarFixture({ "package/package.json": JSON.stringify(metadata), "package/bin/pnpm.mjs": "// fixture only" });
}
const digest = () => Buffer.from(artifactFor("pnpm").integrity.slice(7), "base64");
function fixture() {
	// Canonical root: macOS tmpdir() is /var -> /private/var, and the tools guard rejects aliased paths.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle windows 雪 & ! % (fixture) ")));
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("tar bytes are fully validated and bounded before publication", () => {
	assert.equal(readWindowsPnpmArchive(pnpmTar()).length, 2);
	for (const bytes of [Buffer.from("not gzip"), tarFixture({ "package/../escape": "x" }), tarFixture({ "package/link": "" }, "2"), tarFixture({ "package/CON": "x" }), tarFixture({ "package/a": "a", "package/A": "b" }), tarFixture({ "package/extended": "x" }, "x")]) {
		assert.throws(() => readWindowsPnpmArchive(bytes));
	}
});

test("missing pnpm publishes only verified package data and returns direct invocation", async () => {
	const f = fixture();
	try {
		const calls: string[][] = [];
		const env = { PATH: "fixture", NODE_OPTIONS: "inherited" };
		const result = await ensureWindowsPnpm({ tools: f.root, env, adapters: {
			findCommand: () => null, storage: () => {}, download: async () => pnpmTar(), digest,
			process: (_command: string, args: string[], childEnv: Record<string, string>) => {
				calls.push(args); assert.equal(childEnv, env);
				return args[0] === "--version" ? "v24.21.0" : args.at(-1) === "--version" ? "11.1.1" : "--global";
			},
		} });
		assert.equal(result.command, process.execPath);
		assert.deepEqual(result.prefix, [join(f.root, "pnpm/package/bin/pnpm.mjs")]);
		assert.equal(result.env, env);
		assert.equal(result.acquired, true);
		assert.equal(calls.length, 4);
		assert.equal(existsSync(join(f.root, "pnpm/package/package.json")), true);
		assert.equal(existsSync(join(f.root, "pnpm.cmd")), false);
	} finally { f.cleanup(); }
});

for (const failure of ["integrity", "namespace", "metadata", "probe", "conflict", "claim-race", "storage"]) {
	test(`pnpm fails closed without unrelated cleanup: ${failure}`, async () => {
		const f = fixture();
		try {
			writeFileSync(join(f.root, "unrelated"), "preserve");
			if (failure === "conflict") mkdirSync(join(f.root, "pnpm"));
			let processes = 0;
			await assert.rejects(ensureWindowsPnpm({ tools: f.root, env: {}, adapters: {
				findCommand: () => null,
				storage: () => { if (failure === "storage") throw new Error("ACL rejected"); },
				download: async () => {
					if (failure === "claim-race") { mkdirSync(join(f.root, "pnpm")); writeFileSync(join(f.root, "pnpm/not-owned"), "preserve"); }
					return failure === "namespace" ? tarFixture({ "package/../escape": "x" }) : failure === "metadata" ? pnpmTar({ ...pinnedPackage, engines: { node: ">=22.13.0" } }) : pnpmTar();
				},
				digest: failure === "integrity" ? () => Buffer.alloc(64) : digest,
				process: () => { processes++; throw new Error("failed"); },
			} }));
			assert.equal(readFileSync(join(f.root, "unrelated"), "utf8"), "preserve");
			assert.equal(processes, failure === "probe" ? 1 : 0);
			if (failure === "claim-race") assert.equal(readFileSync(join(f.root, "pnpm/not-owned"), "utf8"), "preserve");
			else assert.deepEqual(readdirSync(f.root).sort(), failure === "conflict" ? ["pnpm", "unrelated"] : ["unrelated"]);
		} finally { f.cleanup(); }
	});
}

test("Windows PATH resolver skips empty entries but still rejects relative, quoted and UNC entries", async () => {
	const adapters = { storage: () => {}, download: async () => pnpmTar(), digest, process: (_command: string, args: string[]) => args[0] === "--version" ? "v24.21.0" : args.at(-1) === "--version" ? "11.1.1" : "--global" };
	// A trailing `;` is the Windows default PATH shape; `;;` also appears after edits.
	for (const Path of ["C:\\x;", "C:\\x;;C:\\y", ";C:\\x"]) {
		const f = fixture();
		try {
			const result = await ensureWindowsPnpm({ tools: f.root, env: { Path, PATHEXT: ".EXE;.CMD" }, adapters });
			assert.equal(result.acquired, true, Path);
		} finally { f.cleanup(); }
	}
	for (const Path of ["C:\\x;relative", "C:\\x;\"C:\\quoted\"", "C:\\x;\\\\server\\share", "C:\\x; "]) {
		const f = fixture();
		try {
			await assert.rejects(ensureWindowsPnpm({ tools: f.root, env: { Path, PATHEXT: ".EXE;.CMD" }, adapters }), /Unknown Windows PATH/, Path);
			assert.deepEqual(readdirSync(f.root), []);
		} finally { f.cleanup(); }
	}
});

// Windows PowerShell 5.1 appends .CPL to PATHEXT, and bootstrap.cmd always starts
// the helper from it. .CPL is a known extension, never an accepted candidate: the
// PATH-then-PATHEXT order is kept and a .cpl found first fails closed.
const powershellPathExt = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL";
const cliProcess = (_command: string, args: string[]) => args[0] === "--version" ? "v24.21.0" : args.at(-1) === "--version" ? "11.1.1" : "--global";
function pnpmWrapperDirectory(directory: string, siblingNode = true) {
	mkdirSync(join(directory, "node_modules/pnpm/bin"), { recursive: true });
	writeFileSync(join(directory, "pnpm.cmd"), wrapper("node_modules\\pnpm\\bin\\pnpm.mjs"));
	writeFileSync(join(directory, "node_modules/pnpm/package.json"), JSON.stringify(pinnedPackage));
	writeFileSync(join(directory, "node_modules/pnpm/bin/pnpm.mjs"), "fixture");
	if (siblingNode) writeFileSync(join(directory, "node.exe"), "not executed fixture");
}
test("Windows PowerShell's PATHEXT with .CPL resolves an existing pnpm wrapper and still acquires a missing one", async () => {
	const f = fixture();
	try {
		const commands = join(f.root, "commands"); pnpmWrapperDirectory(commands);
		const existing = await ensureWindowsPnpm({ tools: f.root, env: { Path: commands, PATHEXT: powershellPathExt }, adapters: { storage: () => {}, process: cliProcess } });
		assert.equal(existing.acquired, false);
		assert.equal(existing.command, join(commands, "node.exe"));
		const tools = join(f.root, "tools"); mkdirSync(tools);
		const acquired = await ensureWindowsPnpm({ tools, env: { Path: join(f.root, "empty"), PATHEXT: powershellPathExt }, adapters: { storage: () => {}, download: async () => pnpmTar(), digest, process: cliProcess } });
		assert.equal(acquired.acquired, true);
	} finally { f.cleanup(); }
});
test("a .cpl pnpm or node found first in PATH order fails closed instead of being skipped", async () => {
	const f = fixture();
	try {
		const early = join(f.root, "early"); const commands = join(f.root, "commands"); const late = join(f.root, "late");
		mkdirSync(early); mkdirSync(late); pnpmWrapperDirectory(commands, false);
		writeFileSync(join(late, "node.exe"), "not executed fixture");
		const env = { Path: [early, commands, late].join(";"), PATHEXT: powershellPathExt };
		const steps: string[] = [];
		// A wrapper-selected Node through PATH is accepted without a shadow...
		const clean = await ensureWindowsPnpm({ tools: f.root, env, adapters: { storage: () => {}, process: cliProcess } });
		assert.equal(clean.command, join(late, "node.exe"));
		// ...but an earlier node.cpl wins PATH order and is never skipped.
		writeFileSync(join(early, "node.cpl"), "control panel item");
		await assert.rejects(ensureWindowsPnpm({ tools: f.root, env, onStep: (step: string) => steps.push(step), adapters: { storage: () => {}, process: () => { throw new Error("must not run"); } } }),
			(error: Error) => error.message === "Unknown wrapper-selected Node" && windowsBootstrapReason(error, "node-discovery") === "wrapper-node (node-discovery)");
		assert.equal(steps.at(-1), "node-discovery");
		// An earlier pnpm.cpl shadows the genuine pnpm.cmd and refuses replacement.
		writeFileSync(join(early, "pnpm.cpl"), "control panel item");
		await assert.rejects(ensureWindowsPnpm({ tools: f.root, env, adapters: { storage: () => {}, download: () => { throw new Error("must not download"); }, process: () => { throw new Error("must not run"); } } }),
			(error: Error) => error.message === "Unknown pnpm wrapper; refusing replacement" && windowsBootstrapReason(error, "wrapper") === "wrapper-unknown (wrapper)");
		// PATHEXT order inside one directory still puts .CMD before .CPL.
		writeFileSync(join(commands, "pnpm.cpl"), "control panel item");
		await assert.rejects(ensureWindowsPnpm({ tools: f.root, env: { ...env, Path: commands }, adapters: { storage: () => {}, process: () => { throw new Error("must not run"); } } }), /Unknown wrapper-selected Node/,
			"pnpm.cmd wins over pnpm.cpl in the same directory; the missing node then stops it");
	} finally { f.cleanup(); }
});
// Python adds .PY and .PYW to PATHEXT (#1978); Ruby, Perl and others add their
// own. Any well-formed extension resolves in its PATHEXT place, and only a .cmd
// npm shim with an .exe Node is ever accepted, so an unlisted one is never run.
const pythonPathExt = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.PY;.PYW";
test("Windows PATHEXT with Python's .PY and .PYW resolves an existing pnpm wrapper", async () => {
	const f = fixture();
	try {
		const commands = join(f.root, "commands"); pnpmWrapperDirectory(commands);
		for (const PATHEXT of [pythonPathExt, `${pythonPathExt};.CPL`]) {
			const existing = await ensureWindowsPnpm({ tools: f.root, env: { Path: commands, PATHEXT }, adapters: { storage: () => {}, process: cliProcess } });
			assert.equal(existing.acquired, false, PATHEXT);
			assert.equal(existing.command, join(commands, "node.exe"), PATHEXT);
		}
	} finally { f.cleanup(); }
});
test("a pnpm.py found first in PATH order fails closed and is never run", async () => {
	const f = fixture();
	try {
		const early = join(f.root, "early"); const commands = join(f.root, "commands");
		mkdirSync(early); pnpmWrapperDirectory(commands);
		writeFileSync(join(early, "pnpm.py"), "print('not pnpm')");
		const env = { Path: [early, commands].join(";"), PATHEXT: pythonPathExt };
		await assert.rejects(ensureWindowsPnpm({ tools: f.root, env, adapters: { storage: () => {}, download: () => { throw new Error("must not download"); }, process: () => { throw new Error("must not run"); } } }),
			(error: Error) => error.message === "Unknown pnpm wrapper; refusing replacement" && windowsBootstrapReason(error, "wrapper") === "wrapper-unknown (wrapper)");
	} finally { f.cleanup(); }
});
test("Windows PATHEXT still rejects duplicate, empty and malformed extensions", async () => {
	for (const PATHEXT of [".EXE;.CMD;.CPL;.cpl", ".EXE;.CMD;.PY;.py", ".EXE;;.CMD", ".EXE;CPL", "", ".", ".EXE;.E XE", ".EXE;.EXE*", ".EXE;..CMD", ".EXE;.CM\\D", ".EXE;.\u212A"]) {
		await assert.rejects(ensureWindowsPnpm({ tools: "C:\\tools", env: { Path: "C:\\fixture", PATHEXT } }), /Unknown Windows PATHEXT semantics/, PATHEXT);
	}
});

for (const sibling of [true, false]) {
	test(`known cmd wrapper honors ${sibling ? "sibling" : "PATH"}-selected Node without cmd.exe`, async () => {
		const f = fixture();
		try {
			const command = join(f.root, "pnpm.cmd");
			writeFileSync(command, wrapper("node_modules\\pnpm\\bin\\pnpm.mjs"));
			const selected = join(f.root, sibling ? "node.exe" : "path-node.exe");
			writeFileSync(selected, "not executed fixture");
			const packageDir = join(f.root, "node_modules/pnpm");
			mkdirSync(join(packageDir, "bin"), { recursive: true });
			writeFileSync(join(packageDir, "package.json"), JSON.stringify(pinnedPackage));
			writeFileSync(join(packageDir, "bin/pnpm.mjs"), "fixture");
			const env = { NODE_OPTIONS: "preserved", PATHEXT: ".EXE;.CMD" };
			const result = await ensureWindowsPnpm({ tools: f.root, env, adapters: {
				findCommand: () => command, findNode: () => selected, storage: () => {},
				download: () => { throw new Error("must not download"); },
				process: (node: string, args: string[], childEnv: Record<string, string>) => { assert.equal(node, selected); assert.equal(childEnv, env); return args[0] === "--version" ? "v24.21.0" : args.at(-1) === "--version" ? "11.1.1" : "--global"; },
			} });
			assert.equal(result.acquired, false);
			assert.equal(result.command, selected);
		} finally { f.cleanup(); }
	});
}

test("production process adapter rejects cmd, nonzero exits and excess output", () => {
	assert.throws(() => windowsProcessCheck("pnpm.cmd", [], process.env));
	assert.throws(() => windowsProcessCheck(process.execPath, ["-e", "process.exit(3)"], process.env));
	assert.throws(() => windowsProcessCheck(process.execPath, ["-e", "process.stdout.write('x'.repeat(2*1024*1024))"], process.env));
	assert.equal(windowsProcessCheck(process.execPath, ["--version"], process.env), process.version);
});

test("production direct-child deadline rejects valid output followed by hang (Linux process evidence only)", { skip: process.platform === "win32" ? "Windows needs independent native outer-guard lane" : false }, async () => {
	const f = fixture();
	try {
		const pidFile = join(f.root, "probe.pid");
		const probe = join(f.root, "probe.mjs");
		writeFileSync(probe, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); console.log('v24.21.0'); setInterval(() => {}, 1000);`);
		const moduleUrl = pathToFileURL(join(process.cwd(), "scripts/installer-windows.mjs")).href;
		const runner = join(f.root, "runner.mjs");
		writeFileSync(runner, `import { windowsProcessCheck } from ${JSON.stringify(moduleUrl)}; try { windowsProcessCheck(process.execPath, [${JSON.stringify(probe)}], process.env); process.exitCode = 2; } catch { console.log('rejected'); }`);
		const child = spawn(process.execPath, [runner], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let guarded = false;
		const killGroup = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } } };
		const timer = setTimeout(() => { guarded = true; killGroup(); }, 18000);
		let output = ""; child.stdout.on("data", (bytes: Buffer) => { output += bytes.toString(); }); child.stderr.resume();
		try {
			const code = await new Promise<number | null>((resolveChild, reject) => { child.once("error", reject); child.once("close", resolveChild); });
			assert.equal(guarded, false); assert.equal(code, 0); assert.match(output, /rejected/);
			const pid = Number(readFileSync(pidFile, "utf8"));
			assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
		} finally { clearTimeout(timer); killGroup(); }
	} finally { f.cleanup(); }
});

const nativeUnavailable = process.platform !== "win32" ? "unavailable: Linux host without Windows PowerShell runner" : false;
test("native Windows entry: spaces, Unicode, CMD metacharacters and early missing bundle stop", { skip: nativeUnavailable }, () => {
	const f = fixture();
	try {
		const scripts = join(f.root, "scripts"); mkdirSync(scripts);
		copyFileSync(new URL("../scripts/bootstrap.cmd", import.meta.url), join(scripts, "bootstrap.cmd"));
		const local = join(f.root, "home"); mkdirSync(local);
		const result = spawnSync(join(process.env.SystemRoot!, "System32/cmd.exe"), ["/d", "/c", "scripts\\bootstrap.cmd"], { cwd: f.root, env: { ...process.env, LOCALAPPDATA: local }, timeout: 5000, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 1024 * 1024 });
		assert.equal(result.error, undefined); assert.equal(result.status, 1);
		assert.match(result.stderr, /No acquisition attempted/);
		assert.deepEqual(readdirSync(local), []);
	} finally { f.cleanup(); }
});

// Native acceptance uses exact CMD command lines, including continuation and
// argument reconstruction. These fixture-only compositions never load PS files.
// Stage publication proof is NOT official artifact-integrity or whole-entry proof.
function cmdStage(marker: string) {
	const source = readFileSync(new URL("../scripts/bootstrap.cmd", import.meta.url), "utf8");
	const markerAt = source.indexOf(marker);
	assert.ok(markerAt >= 0, marker);
	const start = source.indexOf('"%GENTLE_BOOTSTRAP_PS%" -NoLogo', markerAt);
	assert.ok(start >= 0);
	const ends = ["\nif errorlevel 1 goto failed", "\nendlocal & exit /b 0", "\n:finishfailure"]
		.map((terminator) => source.indexOf(terminator, start)).filter((index) => index >= 0);
	assert.ok(ends.length > 0);
	return source.slice(start, Math.min(...ends)).replace(/\r$/, "");
}
const stageMarkers = {
	bundle: "rem Bundle/dependency", claim: "rem Claim", resolve: "rem Select",
	zip: "rem Inspect the entire ZIP", probe: "rem Production direct",
	launch: "rem Launch the existing", success: "rem Success:", cleanup: "rem Never scan/reuse/clean",
} as const;

test("success removes only the exact claimed marked root and never fails the installation", () => {
	const source = readFileSync(new URL("../scripts/bootstrap.cmd", import.meta.url), "utf8").replaceAll("\r\n", "\n");
	const launch = source.indexOf(stageMarkers.launch);
	const success = source.indexOf(stageMarkers.success);
	const exit = source.indexOf("\nendlocal & exit /b 0");
	assert.ok(launch >= 0 && success > source.indexOf("if errorlevel 1 goto failed", launch) && success < exit, "cleanup runs only after the wizard succeeded");
	const stage = cmdStage(stageMarkers.success).replaceAll("\r\n", "\n");
	assert.equal(source.slice(source.indexOf(stage) + stage.length, exit), "", "no errorlevel turns a removal problem into failure");
	assert.match(stage, /GetFullPath\(\$env:LOCALAPPDATA\)/);
	assert.match(stage, /StartsWith\('\.gentle-shell-bootstrap-tools\.',\[StringComparison\]::Ordinal\)/);
	assert.match(stage, /ReparsePoint/);
	assert.match(stage, /'\.bootstrap-owned'/);
	assert.match(stage, /-ne 'gentle-pi prerequisite tooling only'/);
	assert.match(stage, /\[IO\.Directory\]::Delete\(\$tools, \$true\)/);
	assert.doesNotMatch(stage, /Remove-Item/, "Windows PowerShell 5.1 Remove-Item may follow links");
	assert.match(stage, /could not be removed: ' \+ \$env:GENTLE_BOOTSTRAP_TOOLS/);
});

// Fixed, non-sensitive claim diagnostics: a code names the failed check, never a
// path, SID or exception text. An intentional rejection reports its own code; any
// other exception reports `unexpected-<step>` so it cannot pose as a rejection.
const claimRejections = ["policy", "path-mismatch", "home-owner", "ancestor-reparse", "ancestor-owner", "acl-mask",
	"collision", "protected-dacl", "private-owner", "private-ace"];
const claimSteps = ["policy", "path-mismatch", "home-owner", "ancestor-walk", "create", "private-acl", "marker"];
const claimReasons = [...claimRejections, ...claimSteps.map((step) => `unexpected-${step}`)];
const claimMessage = "Bootstrap: private storage ACL/reparse/ownership claim failed or policy denied it.";
test("claim reports one fixed non-sensitive reason code per check beside the unchanged message", () => {
	const stage = cmdStage(stageMarkers.claim);
	const thrown = [...stage.matchAll(/throw '([^']*)'/g)].map((match) => match[1]);
	const steps = [...stage.matchAll(/\$step = '([^']*)'/g)].map((match) => match[1]);
	for (const code of thrown) assert.ok(claimRejections.includes(code), `unlisted claim rejection: ${code}`);
	for (const step of steps) assert.ok(claimSteps.includes(step), `unlisted claim step: ${step}`);
	assert.deepEqual([...new Set(thrown)].sort(), [...claimRejections].sort(), "every rejection is reachable");
	assert.deepEqual([...new Set(steps)].sort(), [...claimSteps].sort(), "every step is reachable");
	assert.ok(stage.indexOf("$step = 'policy'") < stage.indexOf("try {"), "the step exists before any check can fail");
	const allowlist = stage.match(/\$_\.Exception\.Message -cmatch '\^\(([a-z|-]+)\)\$'\) \{ \$reason = \$_\.Exception\.Message \}/);
	assert.ok(allowlist, "only allowlisted rejection codes are copied from an exception");
	assert.deepEqual(allowlist[1].split("|").sort(), [...claimRejections].sort(), "steps that never reject are not allowlisted");
	assert.match(stage, /\$reason = 'unexpected-' \+ \$step;/, "unexpected exceptions never pose as an intentional rejection");
	assert.doesNotMatch(stage, /\$reason = \$step;/);
	assert.ok(stage.includes(`[Console]::Error.WriteLine('${claimMessage} Reason: ' + $reason)`), "user-facing message is unchanged; the code is appended");
	// Check order is part of the contract: the owner/ACL walk precedes the claim.
	const order = ["path-mismatch", "home-owner", "ancestor-walk", "create", "collision", "private-acl", "marker"].map((code) => stage.indexOf(`'${code}'`));
	assert.deepEqual(order, [...order].sort((left, right) => left - right));
});

// The Node probe follows the same contract. Walk rejections also name the path
// component role (target, immediate parent or distant ancestor), never the path.
const probeRoles = ["target", "parent", "ancestor"];
const probeWalkChecks = ["reparse", "owner", "acl-mask"];
const probeRejections = ["policy", "missing-target", "unsafe-target", "unsafe-path", ...probeRoles.flatMap((role) => probeWalkChecks.map((check) => `${role}-${check}`)),
	"no-start", "deadline", "output-limit", "exit-code", "version-format", "engine", "acquired-version"];
const probeSteps = ["policy", "target", "acl-walk", "start", "drain", "version"];
const probeMessage = "Bootstrap: Node version, execution, deadline, output bound or policy check failed; refusing replacement.";
test("Node probe reports one fixed non-sensitive reason code per check beside the unchanged message", () => {
	const stage = cmdStage(stageMarkers.probe);
	const literal = [...stage.matchAll(/throw '([^']*)'/g)].map((match) => match[1]).filter((code) => code !== "Child termination unconfirmed");
	const walk = [...stage.matchAll(/throw \(\$role \+ '-([^']*)'\)/g)].map((match) => match[1]);
	assert.deepEqual([...new Set(walk)].sort(), [...probeWalkChecks].sort(), "walk checks carry the component role");
	assert.match(stage, /\$role = 'ancestor'; if \(\$depth -eq 0\) \{ \$role = 'target' \} elseif \(\$depth -eq 1\) \{ \$role = 'parent' \};/);
	const thrown = [...literal, ...probeRoles.flatMap((role) => walk.map((check) => `${role}-${check}`))];
	for (const code of thrown) assert.ok(probeRejections.includes(code), `unlisted probe rejection: ${code}`);
	assert.deepEqual([...new Set(thrown)].sort(), [...probeRejections].sort(), "every rejection is reachable");
	const steps = [...stage.matchAll(/\$step = '([^']*)'/g)].map((match) => match[1]);
	assert.deepEqual([...new Set(steps)].sort(), [...probeSteps].sort(), "every step is reachable");
	assert.ok(stage.indexOf("$step = 'policy'") < stage.indexOf("try {"), "the step exists before any check can fail");
	const allowlist = stage.match(/\$_\.Exception\.Message -cmatch '(\^[^']+\$)'\) \{ \$reason = \$_\.Exception\.Message \}/);
	assert.ok(allowlist, "only allowlisted rejection codes are copied from an exception");
	const allowed = new RegExp(allowlist[1]);
	for (const code of probeRejections) assert.match(code, allowed);
	for (const other of [...probeSteps.map((step) => `unexpected-${step}`), "Exception calling Start", "C:\\Users\\someone", "owner", "target-", "target-owner ", ""]) assert.doesNotMatch(other, allowed);
	assert.match(stage, /\$reason = 'unexpected-' \+ \$step;/, "unexpected exceptions never pose as an intentional rejection");
	assert.ok(stage.includes(`[Console]::Error.WriteLine('${probeMessage} Reason: ' + $reason)`), "user-facing message is unchanged; the code is appended");
	assert.ok(stage.includes("[Console]::Error.WriteLine('Bootstrap: direct-child termination could not be confirmed.')"), "termination failure keeps its own message");
	const order = ["'policy'", "'target'", "'acl-walk'", "'start'", "'drain'", "'version'"].map((step) => stage.indexOf(`$step = ${step}`));
	assert.deepEqual(order, [...order].sort((left, right) => left - right));
	// The fixture primitive keeps production's step tracking from the child onward.
	assert.ok(processPrimitive().includes("$step = 'start'"));
	assert.ok(processPrimitive().includes("$step = 'policy'"));
});

// Windows PowerShell 5.1 autoloads Microsoft.PowerShell.Security from PSModulePath.
// Started from PowerShell 7, the inherited path finds a Core-only copy and every
// cmdlet of that module fails, so ACL work uses .NET Framework APIs directly.
const securityModuleCmdlets = /\b(?:Get-Acl|Set-Acl|Get-AuthenticodeSignature|Set-AuthenticodeSignature|ConvertTo-SecureString|ConvertFrom-SecureString|Get-ExecutionPolicy|Set-ExecutionPolicy|Get-PfxCertificate|Get-CmsMessage|Protect-CmsMessage|Unprotect-CmsMessage|New-FileCatalog|Test-FileCatalog|Get-Credential)\b/i;
// The Node target record carries a path that may hold non-ASCII text (a user
// profile, the Unicode fixture root). Windows PowerShell 5.1 writes New-Item -Value
// as BOM-less UTF-8 but reads Get-Content as the ANSI code page, so the record is
// written and read only through .NET with explicit UTF-8, never through cmdlets.
test("Node target record round-trips as explicit UTF-8 and an absent or empty record is a coded rejection", () => {
	const batch = readFileSync(new URL("../scripts/bootstrap.cmd", import.meta.url), "utf8");
	assert.doesNotMatch(batch, /New-Item[^;"]*'\.node-target'/, "no cmdlet-encoded record write");
	assert.doesNotMatch(batch, /Get-Content[^;"]*'\.node-target'/, "no ANSI-default record read");
	const write = /\$bytes = \(New-Object Text\.UTF8Encoding\(\$false\)\)\.GetBytes\(\$[a-zA-Z.]+\); \$record = \[IO\.File\]::Open\(\(Join-Path \$[a-zA-Z_:]+ '\.node-target'\),\[IO\.FileMode\]::CreateNew,\[IO\.FileAccess\]::Write,\[IO\.FileShare\]::None\); try \{ \$record\.Write\(\$bytes,0,\$bytes\.Length\) \} finally \{ \$record\.Dispose\(\) \}/;
	for (const marker of [stageMarkers.resolve, stageMarkers.zip]) assert.match(cmdStage(marker), write, marker);
	const read = /\[IO\.File\]::ReadAllText\(\$record,\[Text\.Encoding\]::UTF8\)\.TrimEnd\(\[char\]13,\[char\]10\)/;
	for (const marker of [stageMarkers.probe, stageMarkers.launch]) assert.match(cmdStage(marker), read, marker);
	const probe = cmdStage(stageMarkers.probe);
	assert.match(probe, /\$step = 'target'; [^"]*if \(-not \[IO\.File\]::Exists\(\$record\)\) \{ throw 'missing-target' \};/, "an absent record is an intentional rejection");
	assert.match(probe, /if \(-not \$node\) \{ throw 'missing-target' \};/, "an empty record is an intentional rejection, not a null-method exception");
	assert.ok(probe.indexOf("throw 'missing-target' };") < probe.indexOf("$item = Get-Item -LiteralPath $node"), "the record is proven before the target is inspected");
});

// The Node helper follows the same contract: an intentional rejection reports
// `<code> (<step>)`, anything else `unexpected-<step>`. Never a path, SID or raw text.
const helperFailure = "Windows bootstrap failed; policy, prerequisite or bundle evidence rejected. No installation completed.";
test("Windows helper reports one fixed non-sensitive reason code beside the unchanged message", async () => {
	const coded = (message: string, extra = {}) => Object.assign(new Error(message), extra);
	assert.equal(windowsBootstrapReason(coded("Unknown Windows PATHEXT semantics"), "pnpm-discovery"), "pathext (pnpm-discovery)");
	assert.equal(windowsBootstrapReason(coded("Windows ACL evidence rejected", { check: "parent-owner" }), "tools-storage"), "parent-owner (tools-storage)");
	assert.equal(windowsBootstrapReason(coded("Windows ACL evidence rejected", { check: "C:\\Users\\someone" }), "tools-storage"), "acl-evidence (tools-storage)", "an unlisted check never leaks");
	assert.equal(windowsBootstrapReason(coded("Windows prerequisite process failed"), "cli-proof"), "process-failed (cli-proof)");
	assert.equal(windowsBootstrapReason(coded("Unsafe tar header"), "archive"), "archive (archive)");
	assert.equal(windowsBootstrapReason(coded("ENOENT: no such file, open 'C:\\Users\\someone\\x'"), "launch"), "unexpected-launch");
	assert.equal(windowsBootstrapReason("not an error", "bundle"), "unexpected-bundle");
	assert.throws(() => windowsBootstrapReason(new Error("x"), "C:\\path"), /Unknown Windows bootstrap step/);
	// Each platform reaches its first fixed check and reports it, never raw text:
	// non-Windows stops at the platform guard, Windows at the missing bundle file.
	const firstBundleReason = process.platform === "win32" ? "bundle-missing (bundle)" : "native-unavailable (bundle)";
	await assert.rejects(bootstrapWindows({ bundle: "/missing", tools: "/missing", env: {} }), (error: { reason?: string }) => error.reason === firstBundleReason);
	// The CLI line only prints a reason with the fixed shape.
	assert.equal(windowsBootstrapMessage({ reason: "pathext (pnpm-discovery)" }), `${helperFailure} Reason: pathext (pnpm-discovery)`);
	assert.equal(windowsBootstrapMessage({ reason: "unexpected-launch" }), `${helperFailure} Reason: unexpected-launch`);
	for (const unsafe of [{ reason: "C:\\Users\\someone" }, { reason: "S-1-5-21-1 (bundle)" }, new Error("raw"), null, { reason: "pathext (pnpm-discovery)\nC:\\x" }]) {
		assert.equal(windowsBootstrapMessage(unsafe), `${helperFailure} Reason: unexpected-helper`);
	}
});

test("Windows helper steps name each pnpm discovery, storage and proof phase", async () => {
	const steps: string[] = [];
	const env = { Path: "C:\\fixture", PATHEXT: ".EXE;.CMD" };
	await assert.rejects(ensureWindowsPnpm({ tools: "C:\\tools", env, onStep: (step: string) => steps.push(step), adapters: {
		findCommand: () => "C:\\fixture\\pnpm.cmd", storage: () => { throw Object.assign(new Error("Windows ACL evidence rejected"), { check: "target-owner" }); },
	} }), (error: { check?: string }) => error.check === "target-owner");
	assert.deepEqual(steps, ["pnpm-discovery", "wrapper-storage"]);
	// A malformed PATHEXT (here a duplicate extension) still stops discovery and names the code.
	const unknown: string[] = [];
	await assert.rejects(ensureWindowsPnpm({ tools: "C:\\tools", env: { Path: "C:\\fixture", PATHEXT: ".EXE;.CMD;.cmd" }, onStep: (step: string) => unknown.push(step) }), /Unknown Windows PATHEXT semantics/);
	assert.deepEqual(unknown, ["pnpm-discovery"]);
	const helper = readFileSync(new URL("../scripts/installer-windows.mjs", import.meta.url), "utf8");
	const body = helper.slice(helper.indexOf("export async function ensureWindowsPnpm"), helper.indexOf("export async function bootstrapWindows"));
	const order = ["pnpm-discovery", "wrapper-storage", "wrapper", "node-discovery", "node-storage", "entry-storage", "metadata-storage", "package", "cli-proof", "tools-check", "download", "archive", "publish"].map((step) => body.indexOf(`"${step}"`));
	assert.ok(order.every((index) => index >= 0), "every pnpm step is reported");
	assert.deepEqual(order, [...order].sort((left, right) => left - right));
	const bootstrap = helper.slice(helper.indexOf("export async function bootstrapWindows"));
	const outer = ["bundle", "tools-storage", "launch"].map((step) => bootstrap.indexOf(`step = "${step}"`));
	assert.ok(outer.every((index) => index >= 0));
	assert.deepEqual(outer, [...outer].sort((left, right) => left - right));
});

test("storage ACL evidence reports a fixed role code and still rejects anything but safe", () => {
	windowsStorageEvidence("safe");
	for (const check of ["policy", "target-reparse", "parent-owner", "ancestor-acl-mask"]) {
		assert.throws(() => windowsStorageEvidence(`unsafe:${check}`), (error: Error & { check?: string }) => error.message === "Windows ACL evidence rejected" && error.check === check);
	}
	for (const output of ["", "SAFE", "safe\nextra", "unsafe:C:\\Users\\x", "unsafe:target-owner extra", "unsafe:"]) {
		assert.throws(() => windowsStorageEvidence(output), (error: Error & { check?: string }) => error.message === "Windows ACL evidence rejected" && error.check === undefined, JSON.stringify(output));
	}
	const check = productionAclSources()[2];
	assert.match(check, /\$role = 'ancestor'; if \(\$depth -eq 0\) \{ \$role = 'target' \} elseif \(\$depth -eq 1\) \{ \$role = 'parent' \};/);
	assert.match(check, /throw \(\$role \+ '-reparse'\)/);
	assert.match(check, /throw \(\$role \+ '-owner'\)/);
	assert.match(check, /throw \(\$role \+ '-acl-mask'\)/);
	assert.match(check, /if \(\$_\.Exception\.Message -cmatch '\^\(policy\|\(target\|parent\|ancestor\)-\(reparse\|owner\|acl-mask\)\)\$'\) \{ 'unsafe:' \+ \$_\.Exception\.Message \} else \{ throw \}/, "unexpected exceptions still exit nonzero");
});

test("production and fixture PowerShell never depend on autoloading Microsoft.PowerShell.Security", () => {
	const batch = readFileSync(new URL("../scripts/bootstrap.cmd", import.meta.url), "utf8");
	const sources = { batch, aclCheck: productionAclSources()[2], fixtureAclSetup, fixtureOwnerSetup, guardCommand, processPrimitive: processPrimitive() };
	for (const [name, source] of Object.entries(sources)) assert.doesNotMatch(source, securityModuleCmdlets, name);
	for (const source of [cmdStage(stageMarkers.claim), fixtureAclSetup, fixtureOwnerSetup]) {
		assert.match(source, /\[IO\.Directory\]::GetAccessControl\(/);
		assert.match(source, /\[IO\.Directory\]::SetAccessControl\(/);
	}
	// Walks that may reach a file read it as a file, never through a directory API.
	for (const source of [productionAclSources()[1], productionAclSources()[2]]) {
		assert.match(source, /if \(\$item\.PSIsContainer\) \{ \$acl = \[IO\.Directory\]::GetAccessControl\(\$path\) \} else \{ \$acl = \[IO\.File\]::GetAccessControl\(\$path\) \}/);
	}
});
const psRecordLine = '  "$record = [Diagnostics.Process]::GetCurrentProcess(); [IO.File]::AppendAllText($env:GENTLE_FIXTURE_RECORDS,([string]$record.Id + [char]124 + [string]$record.StartTime.ToUniversalTime().Ticks + [Environment]::NewLine));" ^';
function observeStage(stage: string) {
	const lines = stage.split("\n");
	const index = lines.findIndex((line) => line.includes("LanguageMode"));
	assert.ok(index >= 0);
	lines.splice(index + 1, 0, psRecordLine);
	return lines.join("\n");
}
function cmdComposition(stages: string[]) {
	return ["@echo off", "setlocal DisableDelayedExpansion", 'set "GENTLE_BOOTSTRAP_PS=%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
		...stages.flatMap((stage) => [...observeStage(stage).split("\n"), "if errorlevel 1 exit /b 1"]),
		"echo fixture-sentinel", "exit /b 0", ""].join("\r\n");
}

// Only pre-start setup is fixture-specific: a known Node runs a bounded local JS
// probe instead of --version. The real start/drain/deadline/validation/finally
// lines remain unchanged; recording observes owned handles without altering them.
function processPrimitive() {
	const stage = cmdStage(stageMarkers.probe).split("\n");
	const childAt = stage.findIndex((line) => line.includes("$child = New-Object Diagnostics.Process;"));
	const languageAt = stage.findIndex((line) => line.includes("LanguageMode"));
	assert.ok(childAt > languageAt);
	const prefix = stage.slice(0, languageAt + 1);
	prefix.push('  "$tools = $env:GENTLE_BOOTSTRAP_TOOLS; $start = New-Object Diagnostics.ProcessStartInfo; $start.FileName = $env:GENTLE_FIXTURE_NODE; $start.Arguments = [string][char]34 + $env:GENTLE_FIXTURE_PROBE + [char]34; $start.UseShellExecute = $false; $start.CreateNoWindow = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true;" ^');
	const recordChild = '  "[IO.File]::AppendAllText($env:GENTLE_FIXTURE_RECORDS,([string]$child.Id + [char]124 + [string]$child.StartTime.ToUniversalTime().Ticks + [Environment]::NewLine));" ^';
	return [...prefix, stage[childAt], recordChild, ...stage.slice(childAt + 1)].join("\n");
}

test("native fixture compositions retain exact production fragments and no transport command", () => {
	for (const marker of Object.values(stageMarkers)) {
		const original = cmdStage(marker);
		const composed = cmdComposition([original]);
		for (const line of original.split("\n")) assert.ok(composed.includes(line));
		assert.doesNotMatch(composed, /HttpWebRequest|ExecutionPolicy|Invoke-Expression|\.ps1\b/);
		assert.match(composed, /fixture-sentinel/);
	}
	const original = cmdStage(stageMarkers.probe);
	const primitive = processPrimitive();
	assert.ok(primitive.includes(original.slice(original.indexOf('  "$streams ='))));
	assert.match(primitive, /\$child.Kill\(\)/);
	assert.match(primitive, /WaitForExit\(1000\)/);
	// The owner fixture only claims ownership for the invoking SID and proves it.
	const owner = cmdComposition([fixtureOwnerSetup]);
	assert.match(owner, /\$acl\.SetOwner\(\$me\)/);
	assert.match(owner, /GetOwner\(\[Security\.Principal\.SecurityIdentifier\]\)\.Value -ne \$me\.Value\) \{ throw 'Fixture owner not established' \}/);
	assert.match(owner, /'Not fixture-owned'/);
	assert.doesNotMatch(owner, /HttpWebRequest|ExecutionPolicy|Invoke-Expression|\.ps1\b|AddAccessRule|SetAccessRule/);
});

interface NativeResult {
	status: number | null;
	stdout: string;
	stderr: string;
	guardKilled: boolean;
}
function nativeFixture() {
	const f = fixture();
	writeFileSync(join(f.root, ".fixture-owned"), "gentle Windows acceptance fixture");
	return f;
}
function nativeEnv(root: string, tools = join(root, "tools")) {
	return { ...process.env, LOCALAPPDATA: root, GENTLE_BOOTSTRAP_TOOLS: tools,
		GENTLE_BOOTSTRAP_BUNDLE: root, GENTLE_FIXTURE_ROOT: root,
		GENTLE_FIXTURE_RECORDS: join(root, "process-records"), NODE_OPTIONS: "" };
}

// Independent hard guard: kill only fresh fixture handles with matching creation
// ticks, never a name, ambient group or unverified reused PID. No tree guarantee.
// The explicit `exit 0` keeps a caught lookup of an already-exited PID from
// leaking $? into the exit code; every ownership failure throws first.
const guardCommand = String.raw`
$ErrorActionPreference = 'Stop';
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'Policy constrained' };
if ((Get-Content -LiteralPath (Join-Path $env:GENTLE_FIXTURE_ROOT '.fixture-owned') -Raw) -ne 'gentle Windows acceptance fixture') { throw 'Unknown fixture' };
$reaped = $false;
if (Test-Path -LiteralPath $env:GENTLE_FIXTURE_RECORDS) {
  $records = @(Get-Content -LiteralPath $env:GENTLE_FIXTURE_RECORDS);
  [Array]::Reverse($records);
  foreach ($record in $records) {
    if ($record -notmatch '^([1-9][0-9]*)\|([1-9][0-9]*)$') { throw 'Unknown process record' };
    $ownedPid = [int]$Matches[1]; $ticks = [long]$Matches[2];
    try { $owned = [Diagnostics.Process]::GetProcessById($ownedPid) } catch { if ($_.Exception -is [ArgumentException] -or $_.Exception.InnerException -is [ArgumentException]) { continue }; throw };
    try {
      if (-not $owned.HasExited -and $owned.StartTime.ToUniversalTime().Ticks -eq $ticks) { $owned.Kill(); $reaped = $true; if (-not $owned.WaitForExit(1000)) { throw 'Guard could not reap' } };
    } finally { $owned.Dispose() };
  };
};
if ($reaped) { [Console]::WriteLine('fixture guard reaped residual owned process') };
exit 0;
`;
function cleanNativeProcesses(root: string) {
	const ps = join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
	const result = spawnSync(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", guardCommand], { env: nativeEnv(root), timeout: 5000, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 65536 });
	assert.equal(result.error, undefined, "fixture guard must be bounded and available");
	assert.equal(result.status, 0, `fixture guard must only clean verified owned processes: ${(result.stderr ?? "").slice(0, 4000)}`);
	assert.ok(["", "fixture guard reaped residual owned process"].includes(result.stdout.trim()), "unexpected fixture guard output");
	return result.stdout.trim().length > 0;
}
async function nativeCmd(root: string, stages: string[], env: NodeJS.ProcessEnv = nativeEnv(root), limit = 14000): Promise<NativeResult> {
	writeFileSync(join(root, "fixture.cmd"), cmdComposition(stages));
	const child = spawn(join(process.env.SystemRoot!, "System32/cmd.exe"), ["/d", "/c", "fixture.cmd"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = ""; let stderr = ""; let guardKilled = false;
	let guardError: unknown;
	const result = await new Promise<NativeResult>((resolveChild, reject) => {
		const timer = setTimeout(() => {
			guardKilled = true;
			try { cleanNativeProcesses(root); } catch (error) { guardError = error; }
			child.kill("SIGKILL");
			child.stdout.destroy(); child.stderr.destroy();
			resolveChild({ status: null, stdout, stderr, guardKilled });
		}, limit);
		child.stdout.on("data", (bytes: Buffer) => { stdout += bytes.toString(); if (stdout.length > 1048576) { guardError = new Error("Fixture output limit"); child.kill("SIGKILL"); } });
		child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString(); if (stderr.length > 1048576) { guardError = new Error("Fixture output limit"); child.kill("SIGKILL"); } });
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
		child.once("close", (status) => { clearTimeout(timer); resolveChild({ status, stdout, stderr, guardKilled }); });
	});
	const residualReaped = cleanNativeProcesses(root);
	assert.equal(residualReaped, false, "production must reap its own recorded children; fixture cleanup cannot mask a failure");
	assert.equal(guardError, undefined);
	return result;
}
function assertNative(result: NativeResult, status: number) {
	const evidence = `stderr: ${result.stderr.slice(0, 4000)}`;
	assert.equal(result.guardKilled, false, `production fragment must return before the independent outer guard; ${evidence}`);
	assert.equal(result.status, status, evidence);
	if (status === 0) assert.match(result.stdout, /fixture-sentinel/, evidence);
	else assert.doesNotMatch(result.stdout, /fixture-sentinel/, evidence);
}
// A rejected claim must fail for the intended check, not an earlier unrelated one,
// and never through an unexpected exception such as a module-load failure.
function assertClaimRejected(result: NativeResult, reason?: string) {
	assertNative(result, 1);
	const reported = result.stderr.match(/claim failed or policy denied it\. Reason: ([a-z-]+)/)?.[1];
	assert.ok(reported && claimRejections.includes(reported), `intentional claim rejection expected; stderr: ${result.stderr.slice(0, 4000)}`);
	if (reason) assert.equal(reported, reason, `stderr: ${result.stderr.slice(0, 4000)}`);
}

// Fixture ACL mutations are restricted to NEW owned descendants, never operator
// directories, global ACLs, policies or the existing Node/PowerShell installation.
const fixtureAclSetup = `"%GENTLE_BOOTSTRAP_PS%" -NoLogo -NoProfile -NonInteractive -Command ^
  "& { $ErrorActionPreference = 'Stop';" ^
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'Policy constrained' };" ^
  "$root = [IO.Path]::GetFullPath($env:GENTLE_FIXTURE_ROOT); $target = [IO.Path]::GetFullPath($env:GENTLE_FIXTURE_ACL_TARGET);" ^
  "if (-not $target.StartsWith($root + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Get-Content -LiteralPath (Join-Path $root '.fixture-owned') -Raw) -ne 'gentle Windows acceptance fixture') { throw 'Not fixture-owned' };" ^
  "$item = Get-Item -LiteralPath $target -Force; if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe fixture' };" ^
  "$rights = [int]$env:GENTLE_FIXTURE_RIGHTS; if (@(4,2,16,256,64,65536,262144,524288) -notcontains $rights) { throw 'Unknown fixture right' };" ^
  "$acl = [IO.Directory]::GetAccessControl($target); $sid = New-Object Security.Principal.SecurityIdentifier('S-1-1-0');" ^
  "$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid,$rights,'None','None','Allow'); $acl.SetAccessRule($rule); [IO.Directory]::SetAccessControl($target,$acl);" ^
  "}"`;

// Elevated Windows Server runners create directories owned by BUILTIN\Administrators,
// while the User Profile Service creates a real %LOCALAPPDATA% owned by the user.
// Production's home-owner check stays strict, so a fixture directory used as
// LOCALAPPDATA gets the invoking SID as owner and is read back before any stage.
const fixtureOwnerSetup = `"%GENTLE_BOOTSTRAP_PS%" -NoLogo -NoProfile -NonInteractive -Command ^
  "& { $ErrorActionPreference = 'Stop';" ^
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'Policy constrained' };" ^
  "$root = [IO.Path]::GetFullPath($env:GENTLE_FIXTURE_ROOT); $target = [IO.Path]::GetFullPath($env:GENTLE_FIXTURE_OWNER_TARGET);" ^
  "if (($target -ne $root -and -not $target.StartsWith($root + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) -or (Get-Content -LiteralPath (Join-Path $root '.fixture-owned') -Raw) -ne 'gentle Windows acceptance fixture') { throw 'Not fixture-owned' };" ^
  "$item = Get-Item -LiteralPath $target -Force; if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe fixture' };" ^
  "$me = [Security.Principal.WindowsIdentity]::GetCurrent().User; $acl = [IO.Directory]::GetAccessControl($target); $acl.SetOwner($me); [IO.Directory]::SetAccessControl($target,$acl);" ^
  "if (([IO.Directory]::GetAccessControl($target)).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $me.Value) { throw 'Fixture owner not established' };" ^
  "}"`;
async function ownFixtureDirectory(root: string, target: string) {
	const result = await nativeCmd(root, [fixtureOwnerSetup], { ...nativeEnv(root), GENTLE_FIXTURE_OWNER_TARGET: target });
	assert.equal(result.status, 0, `fixture could not own its LOCALAPPDATA directory; stderr: ${result.stderr.slice(0, 4000)}`);
}
async function ownedNativeFixture() {
	const f = nativeFixture();
	try { await ownFixtureDirectory(f.root, f.root); }
	catch (error) { f.cleanup(); throw error; }
	return f;
}

test("native Windows: storage check resolves case-insensitive environment copies", { skip: nativeUnavailable }, () => {
	const target = join(process.env.SystemRoot!, "fixture-owned", "tools");
	const root = process.env.SystemRoot!;
	const calls: { executable: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
	const adapter = (executable: string, args: string[], env: NodeJS.ProcessEnv) => {
		calls.push({ executable, args, env });
		return "safe";
	};
	const canonical = { SystemRoot: root };
	assert.equal(verifyWindowsStorage(target, canonical, adapter), undefined);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].executable, join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
	assert.equal(calls[0].args.length, 5);
	assert.deepEqual(calls[0].args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
	assert.match(calls[0].args[4], /LanguageMode -ne 'FullLanguage'/);
	assert.deepEqual(calls[0].env, { ...canonical, GENTLE_WINDOWS_CHECK: target });
	assert.deepEqual(canonical, { SystemRoot: root });
	const copied = { SYSTEMROOT: root };
	assert.equal(verifyWindowsStorage(target, copied, adapter), undefined);
	assert.equal(calls.length, 2);
	assert.equal(calls[1].executable, calls[0].executable);
	assert.deepEqual(calls[1].args, calls[0].args);
	assert.deepEqual(calls[1].env, { ...copied, GENTLE_WINDOWS_CHECK: target });
	assert.deepEqual(copied, { SYSTEMROOT: root });
});

test("native Windows: production owned claim/check, ACL depth and collision preservation", { skip: nativeUnavailable }, async () => {
	const f = await ownedNativeFixture();
	try {
		const env = nativeEnv(f.root);
		assertNative(await nativeCmd(f.root, [cmdStage(stageMarkers.claim)], env), 0);
		verifyWindowsStorage(env.GENTLE_BOOTSTRAP_TOOLS, env);
		writeFileSync(join(env.GENTLE_BOOTSTRAP_TOOLS, "unrelated"), "preserve");
		assertClaimRejected(await nativeCmd(f.root, [cmdStage(stageMarkers.claim)], env), "collision");
		assert.equal(readFileSync(join(env.GENTLE_BOOTSTRAP_TOOLS, "unrelated"), "utf8"), "preserve");
		for (const rights of [4, 2, 16, 256, 64, 65536, 262144, 524288]) {
			const ancestor = join(env.GENTLE_BOOTSTRAP_TOOLS, `ancestor-${rights}`);
			const parent = join(ancestor, "parent"); const target = join(parent, "target");
			mkdirSync(target, { recursive: true });
			assertNative(await nativeCmd(f.root, [fixtureAclSetup], { ...env, GENTLE_FIXTURE_ACL_TARGET: ancestor, GENTLE_FIXTURE_RIGHTS: String(rights) }), 0);
			if (rights === 4) verifyWindowsStorage(target, env);
			else assert.throws(() => verifyWindowsStorage(target, env));
			// The same CreateDirectories permission on the target/parent is unsafe.
			if (rights === 4) {
				const ownedTarget = join(env.GENTLE_BOOTSTRAP_TOOLS, "unsafe-target"); mkdirSync(ownedTarget);
				assertNative(await nativeCmd(f.root, [fixtureAclSetup], { ...env, GENTLE_FIXTURE_ACL_TARGET: ownedTarget, GENTLE_FIXTURE_RIGHTS: "4" }), 0);
				assert.throws(() => verifyWindowsStorage(ownedTarget, env));
				assertNative(await nativeCmd(f.root, [fixtureAclSetup], { ...env, GENTLE_FIXTURE_ACL_TARGET: parent, GENTLE_FIXTURE_RIGHTS: "4" }), 0);
				assert.throws(() => verifyWindowsStorage(target, env));
				// Owned like a real LOCALAPPDATA, so only the parent's ACL can reject the claim.
				await ownFixtureDirectory(f.root, parent);
				const claimEnv = { ...env, LOCALAPPDATA: parent, GENTLE_BOOTSTRAP_TOOLS: join(parent, "new-claim") };
				assertClaimRejected(await nativeCmd(f.root, [cmdStage(stageMarkers.claim)], claimEnv), "acl-mask");
				assert.equal(existsSync(claimEnv.GENTLE_BOOTSTRAP_TOOLS), false);
			}
		}
	} finally { f.cleanup(); }
});

test("native Windows: production checks reject an owned fixture junction without touching its target", { skip: nativeUnavailable }, async (t) => {
	const f = await ownedNativeFixture();
	try {
		const env = nativeEnv(f.root);
		assertNative(await nativeCmd(f.root, [cmdStage(stageMarkers.claim)], env), 0);
		const target = join(env.GENTLE_BOOTSTRAP_TOOLS, "junction-target"); mkdirSync(target);
		writeFileSync(join(target, "unrelated"), "preserve");
		const home = join(target, "home"); mkdirSync(home);
		// Owned real directories: only the junction itself can be rejected.
		await ownFixtureDirectory(f.root, target);
		await ownFixtureDirectory(f.root, home);
		const junction = join(env.GENTLE_BOOTSTRAP_TOOLS, "junction");
		try { symlinkSync(target, junction, "junction"); }
		catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (["EPERM", "EACCES", "ENOTSUP"].includes(code ?? "")) { t.skip(`owned junction creation capability unavailable: ${code}`); return; }
			throw error;
		}
		assert.throws(() => verifyWindowsStorage(junction, env));
		// Junction as an ancestor: home-owner reads the owned real directory through
		// the junction, so the walk must stop at the reparse point itself.
		assertClaimRejected(await nativeCmd(f.root, [cmdStage(stageMarkers.claim)], { ...env, LOCALAPPDATA: join(junction, "home"), GENTLE_BOOTSTRAP_TOOLS: join(junction, "home", "new-claim") }), "ancestor-reparse");
		// Junction as LOCALAPPDATA: the ACL read sees either the owned target or the
		// junction object; both rejections name the junction, never another object.
		const direct = await nativeCmd(f.root, [cmdStage(stageMarkers.claim)], { ...env, LOCALAPPDATA: junction, GENTLE_BOOTSTRAP_TOOLS: join(junction, "new-claim") });
		assertClaimRejected(direct);
		assert.ok(["ancestor-reparse", "home-owner"].some((reason) => direct.stderr.includes(`Reason: ${reason}`)), `stderr: ${direct.stderr.slice(0, 4000)}`);
		assert.equal(readFileSync(join(target, "unrelated"), "utf8"), "preserve");
		assert.equal(existsSync(join(target, "new-claim")), false);
		assert.equal(existsSync(join(home, "new-claim")), false);
	} finally { f.cleanup(); }
});

interface ZipFixtureEntry {
	name: string;
	bytes: Buffer;
	attributes?: number;
}
function crc32(bytes: Buffer) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
function localZip(entries: ZipFixtureEntry[]) {
	const locals: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name);
		const checksum = crc32(entry.bytes);
		// Stored UTF-8 ZIP member; no third-party ZIP tool or executable fixture.
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x800, 6);
		local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(entry.bytes.length, 18);
		local.writeUInt32LE(entry.bytes.length, 22);
		local.writeUInt16LE(name.length, 26);
		const header = Buffer.alloc(46);
		header.writeUInt32LE(0x02014b50);
		header.writeUInt16LE(0x314, 4); // Unix creator: high attribute bits carry type.
		header.writeUInt16LE(20, 6);
		header.writeUInt16LE(0x800, 8);
		header.writeUInt32LE(checksum, 16);
		header.writeUInt32LE(entry.bytes.length, 20);
		header.writeUInt32LE(entry.bytes.length, 24);
		header.writeUInt16LE(name.length, 28);
		header.writeUInt32LE((entry.attributes ?? 0x81a40020) >>> 0, 38);
		header.writeUInt32LE(offset, 42);
		locals.push(local, name, entry.bytes);
		central.push(header, name);
		offset += local.length + name.length + entry.bytes.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

test("native Windows: actual PowerShell ZIP namespace validation precedes no-clobber publication", { skip: nativeUnavailable }, async () => {
	const f = await ownedNativeFixture();
	try {
		const stem = "node-v24.21.0-win-x64";
		const nativeNode = readFileSync(process.execPath); // approved available Node, never run from the ZIP
		const invalid: ZipFixtureEntry[][] = [
			[{ name: `${stem}/../escape`, bytes: Buffer.alloc(0) }],
			[{ name: `${stem}/NODE.EXE`, bytes: Buffer.alloc(0) }],
			[{ name: `${stem}/link`, bytes: Buffer.from("target"), attributes: 0xa1ff0000 }],
			[{ name: `${stem}/reparse`, bytes: Buffer.alloc(0), attributes: 0x81a40400 }],
			[{ name: `${stem}/a:ads`, bytes: Buffer.alloc(0) }],
			[{ name: `${stem}/CON.txt`, bytes: Buffer.alloc(0) }],
			[{ name: `${stem}/parent`, bytes: Buffer.alloc(0) }, { name: `${stem}/parent/child`, bytes: Buffer.alloc(0) }],
			[{ name: `${stem}/a.`, bytes: Buffer.alloc(0) }],
			[{ name: `${stem}/a `, bytes: Buffer.alloc(0) }],
		];
		for (let index = 0; index <= invalid.length; index++) {
			const tools = join(f.root, `zip-tools-${index}`); const env = nativeEnv(f.root, tools);
			assertNative(await nativeCmd(f.root, [cmdStage(stageMarkers.claim)], env), 0);
			writeFileSync(join(tools, ".node-stem"), stem);
			writeFileSync(join(tools, "unrelated"), "preserve");
			const nodeBytes = index === 0 ? nativeNode : Buffer.from("invalid ZIP case; never extracted or executed");
			writeFileSync(join(tools, "node.zip"), localZip([{ name: `${stem}/node.exe`, bytes: nodeBytes }, ...(index ? invalid[index - 1] : [])]));
			assertNative(await nativeCmd(f.root, [cmdStage(stageMarkers.zip)], env), index ? 1 : 0);
			if (index) {
				assert.equal(existsSync(join(tools, "node")), false);
				assert.equal(existsSync(join(tools, ".node-target")), false);
			} else assert.deepEqual(readFileSync(join(tools, "node/node.exe")), nativeNode);
			assert.equal(readFileSync(join(tools, "unrelated"), "utf8"), "preserve");
		}
		// A real valid archive cannot replace an already claimed publication directory.
		const tools = join(f.root, "zip-collision"); const env = nativeEnv(f.root, tools);
		assertNative(await nativeCmd(f.root, [cmdStage(stageMarkers.claim)], env), 0);
		writeFileSync(join(tools, ".node-stem"), stem);
		writeFileSync(join(tools, "node.zip"), localZip([{ name: `${stem}/node.exe`, bytes: nativeNode }]));
		mkdirSync(join(tools, "node")); writeFileSync(join(tools, "node/unrelated"), "preserve");
		assertNative(await nativeCmd(f.root, [cmdStage(stageMarkers.zip)], env), 1);
		assert.equal(readFileSync(join(tools, "node/unrelated"), "utf8"), "preserve");
		assert.equal(existsSync(join(f.root, "escape")), false);
	} finally { f.cleanup(); }
});

const probeModes = ["valid", "nonzero", "stdout-limit", "stderr-limit", "quiet-hang", "stderr-hang", "valid-then-hang", "both-pipes-hang"] as const;
for (const mode of probeModes) {
	test(`native Windows: pre-Node production process primitive ${mode}`, { skip: nativeUnavailable }, async () => {
		const f = await ownedNativeFixture();
		try {
			const env = nativeEnv(f.root); mkdirSync(env.GENTLE_BOOTSTRAP_TOOLS);
			const pidFile = join(f.root, "probe.pid"); const probe = join(f.root, "probe.mjs");
			writeFileSync(join(f.root, "package.json"), JSON.stringify({ engines: { node: ">=24.3.0" } }));
			writeFileSync(probe, `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.GENTLE_FIXTURE_PID, String(process.pid));
const mode = process.env.GENTLE_FIXTURE_MODE;
if (mode === 'stdout-limit') process.stdout.write('x'.repeat(2*1024*1024));
else if (mode === 'stderr-limit') process.stderr.write('x'.repeat(2*1024*1024));
else {
  if (['valid','nonzero','valid-then-hang','both-pipes-hang'].includes(mode)) console.log('v24.21.0');
  if (['valid','stderr-hang','both-pipes-hang'].includes(mode)) console.error('fixture diagnostic');
}
if (mode === 'nonzero') process.exitCode = 7;
if (mode.endsWith('hang')) { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
`);
			const result = await nativeCmd(f.root, [processPrimitive()], { ...env, GENTLE_FIXTURE_NODE: process.execPath, GENTLE_FIXTURE_PROBE: probe, GENTLE_FIXTURE_PID: pidFile, GENTLE_FIXTURE_MODE: mode });
			assertNative(result, mode === "valid" ? 0 : 1);
			if (mode !== "valid") {
				const expected = { nonzero: "exit-code", "stdout-limit": "output-limit", "stderr-limit": "output-limit" }[mode as string] ?? "deadline";
				assert.ok(result.stderr.includes(`${probeMessage} Reason: ${expected}`), `stderr: ${result.stderr.slice(0, 4000)}`);
			}
			assert.equal(existsSync(pidFile), true, "the approved fixture Node must actually start");
			const pid = Number(readFileSync(pidFile, "utf8")); assert.ok(Number.isSafeInteger(pid) && pid > 0);
			assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "owned direct fixture Node must be reaped");
		} finally { f.cleanup(); }
	});
}

test("native Windows: complete local sentinel composes production entry and late blocks without network", { skip: nativeUnavailable }, async () => {
	const f = await ownedNativeFixture();
	try {
		assert.equal(compatibleEngine(windowsNodeFloor, process.versions.node), true, "fixture runner needs the supported Node floor");
		// The non-ASCII root makes the .node-target record round-trip a real encoding check.
		assert.match(f.root, /[^\x00-\x7f]/);
		const scripts = join(f.root, "scripts"); const bin = join(f.root, "bin"); const commands = join(f.root, "commands");
		const nodeDir = join(f.root, "fixture-node"); const fixtureNode = join(nodeDir, "node.exe");
		mkdirSync(scripts); mkdirSync(bin); mkdirSync(commands); mkdirSync(nodeDir);
		// Clone ONLY the approved available Node's unchanged bytes, not any adjacent
		// operator npm/Corepack/pnpm shim. No new executable is built or acquired.
		copyFileSync(process.execPath, fixtureNode);
		for (const name of ["installer-downloads.mjs", "installer-windows.mjs", "installer-windows-artifacts.json"]) copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(scripts, name));
		// Fail-only transport guard in this trusted local JS fixture copy. It never
		// supplies bytes/digests, relaxes integrity or creates a production switch.
		const helper = join(scripts, "installer-downloads.mjs");
		writeFileSync(helper, "globalThis.fetch = async () => { throw new Error('Fixture forbids network'); };\n" + readFileSync(helper, "utf8"));
		writeFileSync(join(f.root, "package.json"), JSON.stringify({ engines: { node: ">=24.3.0" }, packageManager: "pnpm@11.1.1" }));
		const packageDir = join(commands, "node_modules/pnpm"); mkdirSync(join(packageDir, "bin"), { recursive: true });
		writeFileSync(join(packageDir, "package.json"), JSON.stringify(pinnedPackage));
		writeFileSync(join(packageDir, "bin/pnpm.mjs"), "console.log(process.argv[2] === '--version' ? '11.1.1' : '--global');\n");
		writeFileSync(join(commands, "pnpm.cmd"), wrapper("node_modules\\pnpm\\bin\\pnpm.mjs"));
		writeFileSync(join(bin, "gentle-shell-install.mjs"), "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.GENTLE_FIXTURE_REPORT, JSON.stringify({ node: process.env.GENTLE_INSTALL_PNPM_NODE, entry: process.env.GENTLE_INSTALL_PNPM_ENTRY, path: process.env.PATH })); console.log('wizard-sentinel');\n");
		const tools = join(f.root, ".gentle-shell-bootstrap-tools.fixture");
		const env = { ...nativeEnv(f.root, tools), PATH: [dirname(fixtureNode), commands, join(process.env.SystemRoot!, "System32")].join(";"), PATHEXT: ".EXE;.CMD", GENTLE_FIXTURE_REPORT: join(f.root, "handoff.json") };
		const stages = [stageMarkers.bundle, stageMarkers.claim, stageMarkers.resolve, stageMarkers.probe, stageMarkers.launch, stageMarkers.success].map(cmdStage);
		const result = await nativeCmd(f.root, stages, env, 45000);
		assertNative(result, 0); assert.match(result.stdout, /wizard-sentinel/);
		const report = JSON.parse(readFileSync(env.GENTLE_FIXTURE_REPORT, "utf8")) as Record<string, string>;
		assert.equal(report.node.toLowerCase(), fixtureNode.toLowerCase());
		assert.deepEqual(readFileSync(fixtureNode), readFileSync(process.execPath));
		assert.equal(report.entry, join(packageDir, "bin/pnpm.mjs"));
		assert.equal(existsSync(env.GENTLE_BOOTSTRAP_TOOLS), false, "exact production success block removes only its claimed fixture tools");
		assert.equal(existsSync(join(commands, "pnpm.cmd")), true);
	} finally { f.cleanup(); }
});

test("native Windows: success cleanup keeps unprovable roots, reports them and preserves siblings", { skip: nativeUnavailable }, async () => {
	const f = await ownedNativeFixture();
	try {
		const sibling = join(f.root, ".gentle-shell-bootstrap-tools.sibling");
		mkdirSync(sibling); writeFileSync(join(sibling, ".bootstrap-owned"), "gentle-pi prerequisite tooling only");
		const stages = [cmdStage(stageMarkers.claim), cmdStage(stageMarkers.success)];
		const owned = nativeEnv(f.root, join(f.root, ".gentle-shell-bootstrap-tools.owned"));
		assertNative(await nativeCmd(f.root, stages, owned), 0);
		assert.equal(existsSync(owned.GENTLE_BOOTSTRAP_TOOLS), false);
		const unmarked = nativeEnv(f.root, join(f.root, ".gentle-shell-bootstrap-tools.unmarked"));
		assertNative(await nativeCmd(f.root, [cmdStage(stageMarkers.claim)], unmarked), 0);
		rmSync(join(unmarked.GENTLE_BOOTSTRAP_TOOLS, ".bootstrap-owned"));
		const missing = await nativeCmd(f.root, [cmdStage(stageMarkers.success)], unmarked);
		assertNative(missing, 1);
		assert.ok(missing.stderr.includes(`could not be removed: ${unmarked.GENTLE_BOOTSTRAP_TOOLS}`), missing.stderr);
		assert.equal(existsSync(unmarked.GENTLE_BOOTSTRAP_TOOLS), true);
		const misnamed = nativeEnv(f.root, join(f.root, "tools"));
		assertNative(await nativeCmd(f.root, stages, misnamed), 1);
		assert.equal(existsSync(join(misnamed.GENTLE_BOOTSTRAP_TOOLS, ".bootstrap-owned")), true);
		assert.equal(existsSync(join(sibling, ".bootstrap-owned")), true);
	} finally { f.cleanup(); }
});
