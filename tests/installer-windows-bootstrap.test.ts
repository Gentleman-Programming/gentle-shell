import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, copyFileSync, existsSync, symlinkSync, realpathSync, lstatSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { acquireGo, artifactFor, compatibleEngine, installedGo, windowsBootstrapMessage } from "../scripts/installer-downloads.mjs";
import { createProbes, hostAdapters } from "../scripts/installer-probes.mjs";
import { planPreflight } from "../scripts/installer-preflight.mjs";
import { lookPath, upgradeInvocation, windowsInvocation } from "../scripts/installer-runner.mjs";
import { validateWindowsEntries, windowsShim, windowsNodeFloor, readWindowsPnpmArchive, ensureWindowsPnpm, windowsProcessCheck, windowsAclRuleUnsafe, verifyWindowsStorage,
	bootstrapWindows, windowsBootstrapReason, windowsStorageEvidence } from "../scripts/installer-windows.mjs";
import * as windowsModule from "../scripts/installer-windows.mjs";
import * as bundled from "../scripts/bundled-install.mjs";
import { windowsPathRegistry } from "../scripts/bundled-wizard.mjs";

// Real Windows shims, verbatim (CRLF) as their generators write them. npm cmd-shim:
// github.com/npm/cmd-shim tap-snapshots/test/basic.js.test.cjs, v4.1.0-v8.0.0 ("env
// shebang"; two spaces before the target) and v9.0.2, and "no shebang" (native).
const cmdShimHead = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n";
const wrapper = (entry: string) => `${cmdShimHead}\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${entry}" %*\r\n`;
const wrapper9 = (entry: string) => `${cmdShimHead}\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\${entry}" %*\r\n`;
const nativeWrapper = (target: string) => `${cmdShimHead}"%dp0%\\${target}"   %*\r\n`;
// pnpm's global bins: @zkochan/cmd-shim 9.0.8 generateCmdShim (registry.npmjs.org), for
// a native target (pnpm setup / self-update installs @pnpm/exe), a JS target, the
// NODE_PATH block pnpm may add, and a JS target with the node.exe pnpm pins.
const pnpmNative = (target: string) => `@SETLOCAL\r\n@"%~dp0\\${target}"   %*\r\n`;
const nodePathBlock = (paths: string) => `@IF NOT DEFINED NODE_PATH (\r\n  @SET "NODE_PATH=${paths}"\r\n) ELSE (\r\n  @SET "NODE_PATH=${paths};%NODE_PATH%"\r\n)\r\n`;
const pnpmScript = (target: string, block = "") => `@SETLOCAL\r\n${block}@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\${target}" %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\${target}" %*\r\n)\r\n`;
const pnpmPinnedNode = (node: string, target: string) => `@SETLOCAL\r\n@"${node}"  "%~dp0\\${target}" %*\r\n`;
// Node.js's own npm.cmd: npm 6.14.18-9.9.4 bin/npm.cmd, and npm 10.9.4-11.19.0 (npm-prefix.js).
const nodeNpmCmd = (prefixJs: boolean) => ":: Created by npm, please don't edit manually.\r\n@ECHO OFF\r\n\r\nSETLOCAL\r\n\r\nSET \"NODE_EXE=%~dp0\\node.exe\"\r\nIF NOT EXIST \"%NODE_EXE%\" (\r\n  SET \"NODE_EXE=node\"\r\n)\r\n\r\n" +
	(prefixJs ? "SET \"NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js\"\r\n" : "") +
	"SET \"NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js\"\r\n" +
	(prefixJs ? "FOR /F \"delims=\" %%F IN ('CALL \"%NODE_EXE%\" \"%NPM_PREFIX_JS%\"') DO (\r\n" : "FOR /F \"delims=\" %%F IN ('CALL \"%NODE_EXE%\" \"%NPM_CLI_JS%\" prefix -g') DO (\r\n") +
	"  SET \"NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js\"\r\n)\r\nIF EXIST \"%NPM_PREFIX_NPM_CLI_JS%\" (\r\n  SET \"NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%\"\r\n)\r\n\r\n\"%NODE_EXE%\" \"%NPM_CLI_JS%\" %*\r\n";
// Shims no structure can resolve: mise's legacy file shim, Volta's package and
// default shims (github.com/jdx/mise src/shims.rs, volta-cli/volta shim.rs, wix/shim.cmd).
const unresolvable = ["@echo off\r\nsetlocal\r\nmise x -- %*\r\n", "@echo off\nvolta run %~n0 %*\n", "@echo off\r\n\"%~dpn0.exe\" %*\r\n"];

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

test("only complete known Windows shims name what they run: npm cmd-shim, pnpm's cmd-shim and Node.js's npm.cmd", () => {
	const entry = "node_modules\\pnpm\\bin\\pnpm.cjs";
	assert.deepEqual(windowsShim(wrapper(entry)), { entry, node: null });
	assert.deepEqual(windowsShim(wrapper(entry).replaceAll("\r\n", "\n")), { entry, node: null });
	assert.deepEqual(windowsShim(wrapper9(entry)), { entry, node: null });
	assert.deepEqual(windowsShim(nativeWrapper("node_modules\\pnpm\\pnpm.exe")), { exe: "node_modules\\pnpm\\pnpm.exe" });
	const global = "..\\global\\v11\\5f1a\\node_modules\\@pnpm\\exe\\pnpm.exe";
	assert.deepEqual(windowsShim(pnpmNative(global)), { exe: global });
	const script = "..\\global\\v11\\5f1a\\node_modules\\pnpm\\bin\\pnpm.mjs";
	assert.deepEqual(windowsShim(pnpmScript(script)), { entry: script, node: null });
	assert.deepEqual(windowsShim(pnpmScript(script, nodePathBlock("C:\\Users\\u\\AppData\\Local\\pnpm\\global\\v11\\node_modules"))), { entry: script, node: null });
	const pinned = "C:\\Users\\u\\AppData\\Local\\pnpm\\nodejs\\24.21.0\\node.exe";
	assert.deepEqual(windowsShim(pnpmPinnedNode(pinned, script)), { entry: script, node: pinned });
	assert.deepEqual(windowsShim(nodeNpmCmd(true)), { npm: "prefix-js" });
	assert.deepEqual(windowsShim(nodeNpmCmd(false)), { npm: "prefix-g" });
	const altered = [
		wrapper(entry) + "echo changed\r\n",
		wrapper(entry).replace('"%_prog%"', '"%_prog%" --require evil'),
		wrapper(entry).replace("SETLOCAL", "SET NODE_OPTIONS=--require evil\r\nSETLOCAL"),
		// The old single-space fixture: no cmd-shim release ever wrote it.
		wrapper(entry).replace('"%_prog%"  "', '"%_prog%" "'),
		wrapper('node_modules\\pnpm\\bin\\pnpm.cjs" & calc & "'),
		wrapper("node_modules\\%PNPM%\\pnpm.cjs"),
		wrapper("C:\\elsewhere\\pnpm.cjs"),
		wrapper(entry).replace("\r\n", "\r"),
		pnpmNative(global).replace("   %*", " --flag %*"),
		pnpmScript(script).replace('node  "%~dp0', 'node  "%~dp0\\other'),
		pnpmScript(script, nodePathBlock("A").replace("A;%NODE_PATH%", "B;%NODE_PATH%")),
		pnpmPinnedNode("node", script),
		nodeNpmCmd(true).replace("%*\r\n", "%* --evil\r\n"),
		"@node pnpm.mjs %*",
		...unresolvable,
	];
	for (const text of altered) assert.equal(windowsShim(text), null, JSON.stringify(text));
	assert.equal(windowsShim(undefined), null);
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
		readFileSync(new URL("../scripts/installer-windows.mjs", import.meta.url), "utf8").split("const aclCheckMany = String.raw`")[1]?.split("`;")[0] ?? "",
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
test("an existing pnpm wrapper of another major or older than the pin is left unchanged and the verified pnpm is acquired", async () => {
	for (const version of ["10.27.0", "11.0.0", "12.0.0"]) {
		const f = fixture();
		try {
			const commands = join(f.root, "commands"); pnpmWrapperDirectory(commands);
			const metadata = JSON.stringify({ ...pinnedPackage, version });
			writeFileSync(join(commands, "node_modules/pnpm/package.json"), metadata);
			const tools = join(f.root, "tools"); mkdirSync(tools);
			const nodes: string[] = [];
			const result = await ensureWindowsPnpm({ tools, env: { Path: commands, PATHEXT: ".EXE;.CMD" }, adapters: { storage: () => {},
				download: async () => pnpmTar(), digest, process: (command: string, args: string[]) => { nodes.push(command); return cliProcess(command, args); } } });
			assert.equal(result.acquired, true, version);
			assert.equal(result.command, process.execPath);
			assert.deepEqual(result.prefix, [join(tools, "pnpm/package/bin/pnpm.mjs")]);
			assert.equal(nodes.includes(join(commands, "node.exe")), false, "the existing wrapper's Node never runs");
			assert.equal(readFileSync(join(commands, "node_modules/pnpm/package.json"), "utf8"), metadata);
		} finally { f.cleanup(); }
	}
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

// npm, pnpm, Volta and mise write an extensionless Git Bash script beside each .cmd
// shim, and CMD runs the .cmd there ("native Windows: CMD runs the .cmd ..." below).
const gitBashScript = "#!/bin/sh\nbasedir=$(dirname \"$(echo \"$0\" | sed -e 's,\\\\,/,g')\")\nexec node \"$basedir/node_modules/pnpm/bin/pnpm.cjs\" \"$@\"\n";
test("npm's real global pnpm layout is reused: pnpm.cmd beside its Git Bash script and pnpm.ps1; a lone extensionless pnpm still blocks", async () => {
	for (const shim of [wrapper, wrapper9]) {
		const f = fixture();
		try {
			const npm = join(f.root, "npm"); const nodejs = join(f.root, "nodejs"); const early = join(f.root, "early");
			pnpmWrapperDirectory(npm, false); mkdirSync(nodejs); mkdirSync(early);
			writeFileSync(join(npm, "pnpm.cmd"), shim("node_modules\\pnpm\\bin\\pnpm.mjs"));
			writeFileSync(join(npm, "pnpm"), gitBashScript); writeFileSync(join(npm, "pnpm.ps1"), "#!/usr/bin/env pwsh\n");
			writeFileSync(join(nodejs, "node.exe"), "not executed fixture"); writeFileSync(join(nodejs, "node"), gitBashScript);
			const env = { Path: [nodejs, npm].join(";"), PATHEXT: ".COM;.EXE;.BAT;.CMD" };
			const result = await ensureWindowsPnpm({ tools: f.root, env, adapters: { storage: () => {}, process: cliProcess } });
			assert.equal(result.acquired, false);
			assert.equal(result.command, join(nodejs, "node.exe"));
			assert.deepEqual(result.prefix, [join(npm, "node_modules/pnpm/bin/pnpm.mjs")]);
			// An extensionless pnpm alone in an earlier directory is never skipped.
			writeFileSync(join(early, "pnpm"), gitBashScript);
			await assert.rejects(ensureWindowsPnpm({ tools: f.root, env: { ...env, Path: [early, nodejs, npm].join(";") }, adapters: { storage: () => {},
				download: () => { throw new Error("must not download"); }, process: () => { throw new Error("must not run"); } } }),
			(error: Error) => error.message === "Unknown extensionless Windows prerequisite" && windowsBootstrapReason(error, "pnpm-discovery") === "extensionless (pnpm-discovery)");
		} finally { f.cleanup(); }
	}
});

// A native pnpm.exe answers for itself: `--version`, then the global help evidence.
const exeProcess = (exe: string, version: string, calls: string[][] = []) => (command: string, args: string[]) => {
	if (command !== exe) return cliProcess(command, args);
	calls.push(args);
	if (version === "fails") throw new Error("Windows prerequisite process failed");
	return args[0] === "--version" ? version : "--global";
};
// @pnpm/exe installed by pnpm or npm ships a package.json beside its pnpm.exe.
const exePackage = (directory: string, version: string, name = "@pnpm/exe") => writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version, bin: { pnpm: "pnpm.exe" } }));
test("a pnpm.exe beside its pnpm package.json is reused when compatible and left alongside the pinned pnpm otherwise", async () => {
	for (const version of ["11.1.1", "11.28.5"]) {
		const f = fixture();
		try {
			const home = join(f.root, "pnpm"); mkdirSync(home);
			const exe = join(home, "pnpm.exe"); writeFileSync(exe, "MZ fixture"); exePackage(home, version);
			const calls: string[][] = []; const checked: string[] = [];
			const result = await ensureWindowsPnpm({ tools: f.root, env: { Path: home, PATHEXT: ".EXE;.CMD" }, adapters: {
				storage: (path: string) => { checked.push(path); }, download: () => { throw new Error("must not download"); }, process: exeProcess(exe, version, calls) } });
			assert.deepEqual(result, { acquired: false, env: { Path: home, PATHEXT: ".EXE;.CMD" }, command: exe, prefix: [] }, version);
			assert.deepEqual(calls, [["--version"], ["help", "add"], ["help", "bin"]]);
			assert.deepEqual(checked, [exe, exe, join(home, "package.json")], "the found command, the exe it runs and its package.json pass the storage check");
		} finally { f.cleanup(); }
	}
	for (const version of ["10.34.6", "11.0.0", "12.10.1"]) {
		const f = fixture();
		try {
			const home = join(f.root, "pnpm"); mkdirSync(home);
			const exe = join(home, "pnpm.exe"); writeFileSync(exe, "MZ fixture"); exePackage(home, version, "pnpm");
			const tools = join(f.root, "tools"); mkdirSync(tools);
			const calls: string[][] = [];
			const result = await ensureWindowsPnpm({ tools, env: { Path: home, PATHEXT: ".EXE;.CMD" }, adapters: { storage: () => {},
				download: async () => pnpmTar(), digest, process: exeProcess(exe, version, calls) } });
			assert.equal(result.acquired, true, version);
			assert.deepEqual(result.prefix, [join(tools, "pnpm/package/bin/pnpm.mjs")]);
			assert.deepEqual(calls, [["--version"]], "an incompatible pnpm.exe is only asked for its version");
			assert.equal(readFileSync(exe, "utf8"), "MZ fixture");
		} finally { f.cleanup(); }
	}
	for (const [version, message] of [["11.0.0-rc.1", "Windows pnpm version rejected"], ["", "Windows pnpm version rejected"], ["fails", "Windows prerequisite process failed"]]) {
		const f = fixture();
		try {
			const exe = join(f.root, "pnpm.exe"); writeFileSync(exe, "MZ fixture"); exePackage(f.root, "11.1.1");
			await assert.rejects(ensureWindowsPnpm({ tools: f.root, env: { Path: f.root, PATHEXT: ".EXE;.CMD" }, adapters: { storage: () => {},
				download: () => { throw new Error("must not download"); }, process: exeProcess(exe, version) } }), (error: Error) => error.message === message, version);
		} finally { f.cleanup(); }
	}
});

// S12: a standalone pnpm.exe (pnpm's installer, a Volta or mise shim) has no
// package.json naming pnpm beside it: nothing proves what it is, so it never runs.
test("a pnpm.exe without a pnpm package.json beside it is never run: the verified pnpm is acquired", async () => {
	for (const metadata of [null, "other"]) {
		const f = fixture();
		try {
			const home = join(f.root, "pnpm"); mkdirSync(home);
			const exe = join(home, "pnpm.exe"); writeFileSync(exe, "MZ fixture");
			if (metadata === "other") exePackage(home, "11.1.1", "volta");
			const tools = join(f.root, "tools"); mkdirSync(tools);
			const calls: string[][] = [];
			const result = await ensureWindowsPnpm({ tools, env: { Path: home, PATHEXT: ".EXE;.CMD" }, adapters: { storage: () => {},
				download: async () => pnpmTar(), digest, process: exeProcess(exe, "11.1.1", calls) } });
			assert.deepEqual([result.acquired, result.command, result.prefix], [true, process.execPath, [join(tools, "pnpm/package/bin/pnpm.mjs")]], String(metadata));
			assert.deepEqual(calls, [], "the user's pnpm.exe never runs, not even for its version");
			assert.equal(readFileSync(exe, "utf8"), "MZ fixture");
		} finally { f.cleanup(); }
	}
});

// S11: CMD runs an extensionless shim target through PATHEXT, in PATHEXT order.
test("an extensionless native shim target is reused only when the first PATHEXT match is an .exe", async () => {
	const target = "node_modules\\@pnpm\\exe\\pnpm";
	for (const [extensions, PATHEXT, outcome] of [[[".exe", ".cmd"], ".COM;.EXE;.BAT;.CMD", "reused"], [[".com", ".exe"], ".COM;.EXE;.BAT;.CMD", "rejected"],
		[[".cmd", ".exe"], ".CMD;.EXE", "rejected"], [[], ".COM;.EXE;.BAT;.CMD", "rejected"]] as const) {
		const f = fixture();
		try {
			const npm = join(f.root, "npm"); const packageDir = join(npm, "node_modules", "@pnpm", "exe"); mkdirSync(packageDir, { recursive: true });
			writeFileSync(join(npm, "pnpm.cmd"), nativeWrapper(target)); writeFileSync(join(packageDir, "pnpm"), "MZ fixture");
			for (const extension of extensions) writeFileSync(join(packageDir, `pnpm${extension}`), "MZ fixture");
			exePackage(packageDir, "11.1.1");
			const ran: string[] = [];
			const run = ensureWindowsPnpm({ tools: f.root, env: { Path: npm, PATHEXT }, adapters: { storage: () => {}, download: () => { throw new Error("must not download"); },
				process: (command: string, args: string[]) => { ran.push(command); return exeProcess(join(packageDir, "pnpm.exe"), "11.1.1")(command, args); } } });
			if (outcome === "reused") assert.equal((await run).command, join(packageDir, "pnpm.exe"));
			else {
				await assert.rejects(run, (error: Error) => error.message === "Unsafe pnpm wrapper target", `${extensions} ${PATHEXT}`);
				assert.deepEqual(ran, []);
			}
		} finally { f.cleanup(); }
	}
});

test("pnpm's own global bins are followed to the pnpm they run: pnpm setup, self-update, @pnpm/exe, pnpm 12 and pnpm add -g pnpm", async () => {
	// `pnpm setup` / `pnpm self-update` (pnpm 11): $PNPM_HOME\bin\pnpm.cmd runs @pnpm/exe's pnpm.exe.
	const global = "..\\global\\v11\\5f1a\\node_modules\\@pnpm\\exe\\pnpm.exe";
	for (const [reported, outcome] of [["11.2.0", "reused"], ["11.3.0", "rejected"]]) {
		const f = fixture();
		try {
			const bin = join(f.root, "pnpm/bin"); const exeDir = join(f.root, "pnpm/global/v11/5f1a/node_modules/@pnpm/exe");
			mkdirSync(bin, { recursive: true }); mkdirSync(exeDir, { recursive: true });
			writeFileSync(join(bin, "pnpm.cmd"), pnpmNative(global)); writeFileSync(join(bin, "pnpm"), gitBashScript); writeFileSync(join(bin, "pnpm.ps1"), "#!/usr/bin/env pwsh\n");
			const exe = join(exeDir, "pnpm.exe"); writeFileSync(exe, "MZ fixture");
			writeFileSync(join(exeDir, "package.json"), JSON.stringify({ name: "@pnpm/exe", version: "11.2.0", bin: { pnpm: "pnpm.exe" } }));
			const checked: string[] = [];
			const run = ensureWindowsPnpm({ tools: f.root, env: { Path: bin, PATHEXT: ".EXE;.CMD" }, adapters: { storage: (path: string) => { checked.push(path); },
				download: () => { throw new Error("must not download"); }, process: exeProcess(exe, reported) } });
			if (outcome === "reused") {
				assert.deepEqual((await run).command, exe);
				assert.deepEqual(checked, [join(bin, "pnpm.cmd"), exe, join(exeDir, "package.json")]);
			} else await assert.rejects(run, /Windows pnpm version rejected/, "the exe must report its package's version");
		} finally { f.cleanup(); }
	}
	// @pnpm/exe 11 or pnpm 12 installed by npm: the shim names the extensionless hard link or the .exe.
	for (const [target, version, acquired] of [["node_modules\\@pnpm\\exe\\pnpm", "11.26.0", false], ["node_modules\\pnpm\\pnpm.exe", "12.10.1", true]] as const) {
		const f = fixture();
		try {
			const npm = join(f.root, "npm"); const packageDir = join(npm, ...target.split("\\").slice(0, -1)); mkdirSync(packageDir, { recursive: true });
			writeFileSync(join(npm, "pnpm.cmd"), nativeWrapper(target)); writeFileSync(join(npm, "pnpm"), gitBashScript);
			writeFileSync(join(packageDir, "pnpm"), "MZ fixture"); writeFileSync(join(packageDir, "pnpm.exe"), "MZ fixture");
			writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: target.includes("@pnpm") ? "@pnpm/exe" : "pnpm", version }));
			const tools = join(f.root, "tools"); mkdirSync(tools);
			const result = await ensureWindowsPnpm({ tools, env: { Path: npm, PATHEXT: ".EXE;.CMD" }, adapters: { storage: () => {},
				download: async () => pnpmTar(), digest, process: exeProcess(join(packageDir, "pnpm.exe"), version) } });
			assert.equal(result.acquired, acquired, target);
			assert.equal(result.command, acquired ? process.execPath : join(packageDir, "pnpm.exe"));
		} finally { f.cleanup(); }
	}
	// `pnpm add -g pnpm`: pnpm's JS shim, here behind the NODE_PATH block, run by the PATH node.
	const f = fixture();
	try {
		const bin = join(f.root, "pnpm/bin"); const packageDir = join(f.root, "pnpm/global/v11/5f1a/node_modules/pnpm"); const nodejs = join(f.root, "nodejs");
		mkdirSync(join(packageDir, "bin"), { recursive: true }); mkdirSync(bin, { recursive: true }); mkdirSync(nodejs);
		writeFileSync(join(bin, "pnpm.cmd"), pnpmScript("..\\global\\v11\\5f1a\\node_modules\\pnpm\\bin\\pnpm.mjs", nodePathBlock(join(f.root, "pnpm/global/v11/node_modules"))));
		writeFileSync(join(packageDir, "package.json"), JSON.stringify(pinnedPackage)); writeFileSync(join(packageDir, "bin/pnpm.mjs"), "fixture");
		writeFileSync(join(nodejs, "node.exe"), "not executed fixture");
		const result = await ensureWindowsPnpm({ tools: f.root, env: { Path: [bin, nodejs].join(";"), PATHEXT: ".EXE;.CMD" }, adapters: { storage: () => {}, process: cliProcess } });
		assert.deepEqual([result.acquired, result.command, result.prefix], [false, join(nodejs, "node.exe"), [join(packageDir, "bin/pnpm.mjs")]]);
	} finally { f.cleanup(); }
});

// S9: Corepack's pnpm.cmd (npm's or pnpm's cmd-shim of Corepack's pnpm.js) and
// mise's file-mode shim are not pnpm: they count as no pnpm at all, never run.
const corepackShims = [wrapper("node_modules\\corepack\\dist\\pnpm.js"), pnpmScript("node_modules\\corepack\\dist\\pnpm.js")];
const miseFileShims = [unresolvable[0], "@echo off\nsetlocal\nmise x -- pnpm %*\n", "@echo off\r\nsetlocal\r\nmise x -- pnpm %*\r\n"];
test("Corepack's pnpm.cmd and mise's file shim count as missing pnpm: never run or replaced, the verified pnpm is acquired", async () => {
	for (const text of [...corepackShims, ...miseFileShims]) {
		const f = fixture();
		try {
			const commands = join(f.root, "commands"); mkdirSync(join(commands, "node_modules", "corepack", "dist"), { recursive: true });
			writeFileSync(join(commands, "pnpm.cmd"), text); writeFileSync(join(commands, "node.exe"), "not executed fixture");
			writeFileSync(join(commands, "node_modules", "corepack", "dist", "pnpm.js"), "corepack fixture");
			const tools = join(f.root, "tools"); mkdirSync(tools);
			const ran: string[] = []; const steps: string[] = [];
			const result = await ensureWindowsPnpm({ tools, env: { Path: commands, PATHEXT: ".EXE;.CMD" }, onStep: (step: string) => steps.push(step), adapters: { storage: () => {},
				download: async () => pnpmTar(), digest, process: (command: string, args: string[]) => { ran.push(command); return cliProcess(command, args); } } });
			assert.deepEqual([result.acquired, result.command, result.prefix], [true, process.execPath, [join(tools, "pnpm/package/bin/pnpm.mjs")]], text);
			assert.equal(ran.includes(join(commands, "node.exe")), false, "nothing from Corepack or mise runs");
			assert.deepEqual(steps.slice(0, 3), ["pnpm-discovery", "wrapper-storage", "wrapper"]);
			assert.equal(readFileSync(join(commands, "pnpm.cmd"), "utf8"), text);
		} finally { f.cleanup(); }
	}
	// Policy is unchanged: a failed walk of Corepack's shim still stops with its role code.
	const f = fixture();
	try {
		writeFileSync(join(f.root, "pnpm.cmd"), corepackShims[0]);
		await assert.rejects(ensureWindowsPnpm({ tools: f.root, env: { Path: f.root, PATHEXT: ".EXE;.CMD" }, adapters: {
			storage: () => { throw Object.assign(new Error("Windows ACL evidence rejected"), { check: "policy" }); }, download: () => { throw new Error("must not download"); } } }),
		(error: { check?: string }) => error.check === "policy");
	} finally { f.cleanup(); }
});

test("a pnpm.cmd that no structure resolves (Volta, an unknown mise shim, Node.js's npm.cmd) is never run or replaced", async () => {
	const unknownMise = "@echo off\r\nsetlocal\r\nmise x -- npm %*\r\n";
	for (const text of [...unresolvable.slice(1), unknownMise, wrapper("node_modules\\corepack\\dist\\other.js"), nodeNpmCmd(true)]) {
		const f = fixture();
		try {
			writeFileSync(join(f.root, "pnpm.cmd"), text);
			await assert.rejects(ensureWindowsPnpm({ tools: f.root, env: { Path: f.root, PATHEXT: ".EXE;.CMD" }, adapters: { storage: () => {},
				download: () => { throw new Error("must not download"); }, process: () => { throw new Error("must not run"); } } }),
			(error: Error) => error.message === "Unknown pnpm wrapper; refusing execution or replacement" && windowsBootstrapReason(error, "wrapper") === "wrapper-unproven (wrapper)", text);
			assert.equal(readFileSync(join(f.root, "pnpm.cmd"), "utf8"), text);
		} finally { f.cleanup(); }
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
test("native Windows entry: spaces, Unicode, CMD metacharacters and early missing bundle stop", { skip: nativeUnavailable }, async () => {
	const f = nativeFixture();
	try {
		const scripts = join(f.root, "scripts"); mkdirSync(scripts);
		// Observe the copied production entry's first PowerShell handle so the
		// existing ownership-checked guard can reap it if the fixture times out.
		writeFileSync(join(scripts, "bootstrap.cmd"), observeStage(readFileSync(new URL("../scripts/bootstrap.cmd", import.meta.url), "utf8")));
		const local = join(f.root, "home"); mkdirSync(local);
		const env = { ...nativeEnv(f.root), LOCALAPPDATA: local };
		// The same outer bound as every other production fragment (nativeCmd): a cold
		// cmd.exe plus Windows PowerShell 5.1 start can exceed 5 s while the CI step runs
		// the installer suites in parallel. The bundle stage itself has no deadline.
		console.error("WINDOWS_ENTRY_PROBE_START timeoutMs=14000");
		const started = performance.now();
		const result = await nativeCmdFile(f.root, "scripts\\bootstrap.cmd", env, 14000);
		console.error("WINDOWS_ENTRY_PROBE_RESULT", JSON.stringify({ elapsedMs: performance.now() - started, status: result.status, guardKilled: result.guardKilled, expectedDiagnostic: /No acquisition attempted/.test(result.stderr) }));
		// Spawn errors reject the helper; a guard intervention or unexpected exit
		// must still fail acceptance rather than being hidden by fixture cleanup.
		assertNative(result, 1);
		assert.match(result.stderr, /No acquisition attempted/);
		assert.match(readFileSync(join(f.root, "process-records"), "utf8").trim(), /^[1-9][0-9]*\|[1-9][0-9]*$/, "the copied entry must expose its first PowerShell handle to fixture cleanup");
		assert.deepEqual(readdirSync(local), []);
	} finally {
		try { cleanNativeProcesses(f.root); } finally { f.cleanup(); }
	}
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
	const ends = ["\nif errorlevel 1 goto failed", "\nif errorlevel 3 goto failed", "\nendlocal & exit /b 0", "\n:finishfailure"]
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
	assert.ok(stage.includes("$parent -ne [IO.Path]::GetFullPath($env:LOCALAPPDATA) -and $parent -ne [IO.Path]::GetFullPath($env:USERPROFILE)"), "a direct child of either claim base");
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

// S1: a profile whose %LOCALAPPDATA% another principal may write (acl-mask) or
// whose owner is untrusted (home-owner) gets exactly one more candidate, a new
// folder directly under %USERPROFILE%, held to the same checks. Exit 2 tells CMD.
test("claim tries %LOCALAPPDATA% first and one %USERPROFILE% fallback only after acl-mask or home-owner", () => {
	const source = readFileSync(new URL("../scripts/bootstrap.cmd", import.meta.url), "utf8").replaceAll("\r\n", "\n");
	assert.ok(source.includes('set "GENTLE_BOOTSTRAP_TOOLS=%LOCALAPPDATA%\\.gentle-shell-bootstrap-tools.%RANDOM%.%RANDOM%.%RANDOM%"\nset "GENTLE_BOOTSTRAP_FALLBACK_TOOLS=%USERPROFILE%\\.gentle-shell-bootstrap-tools.%RANDOM%.%RANDOM%.%RANDOM%"\n'));
	const stage = cmdStage(stageMarkers.claim).replaceAll("\r\n", "\n");
	assert.ok(stage.includes("$candidates = @(,@($env:GENTLE_BOOTSTRAP_TOOLS,$env:LOCALAPPDATA)); if ($env:GENTLE_BOOTSTRAP_FALLBACK_TOOLS) { $candidates += ,@($env:GENTLE_BOOTSTRAP_FALLBACK_TOOLS,$env:USERPROFILE) };"), "LOCALAPPDATA first, then exactly one USERPROFILE candidate");
	assert.ok(stage.includes("if ($index -eq 0 -and $candidates.Count -gt 1 -and $code -cmatch '^(acl-mask|home-owner)$') { continue }; throw"), "only acl-mask or home-owner on the first candidate reaches the fallback");
	// Every candidate gets the exact-parent rule, the base owner and the whole walk before anything is created.
	const steps = ["for ($index = 0; $index -lt $candidates.Count; $index++)", "$step = 'path-mismatch'", "throw 'path-mismatch'", "$step = 'home-owner'", "$step = 'ancestor-walk'",
		"throw 'ancestor-reparse'", "throw 'ancestor-owner'", "throw 'acl-mask'", "{ continue }; throw", "$step = 'create'"].map((text) => stage.indexOf(text));
	assert.ok(steps.every((index) => index >= 0), JSON.stringify(steps));
	assert.deepEqual(steps, [...steps].sort((left, right) => left - right));
	assert.ok(stage.includes("$path -ne [IO.Path]::GetFullPath($base)"), "the chosen base is the claim's exact parent");
	assert.ok(stage.includes("if ($index -gt 0) { exit 2 };"));
	// CMD switches to the fallback only on exit 2, before it records ownership.
	const end = source.indexOf(stage) + stage.length;
	assert.ok(source.slice(end).startsWith('\nif errorlevel 3 goto failed\nif errorlevel 2 goto fallbackclaimed\nif errorlevel 1 goto failed\ngoto claimed\n:fallbackclaimed\nset "GENTLE_BOOTSTRAP_TOOLS=%GENTLE_BOOTSTRAP_FALLBACK_TOOLS%"\n:claimed\nset "GENTLE_BOOTSTRAP_FALLBACK_TOOLS="\nset "GENTLE_BOOTSTRAP_OWNED=1"\n'));
});

test("the claim base may be owned by the user, SYSTEM or Administrators and the private folder is set to the user", () => {
	const stage = cmdStage(stageMarkers.claim);
	assert.ok(stage.includes("$owners = @($me.Value,'S-1-5-18','S-1-5-32-544');"), "TrustedInstaller or any other SID cannot own the base");
	assert.ok(stage.includes("$step = 'home-owner'; $owner = ([IO.Directory]::GetAccessControl($path)).GetOwner([Security.Principal.SecurityIdentifier]); if ($owners -notcontains $owner.Value) {"));
	assert.ok(stage.includes("$trusted = @($me.Value,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');"), "ancestor owners are unchanged");
	// An Administrators member's new folders default to BUILTIN\Administrators: the owner
	// is set explicitly, written with the protected DACL, then read back.
	const owner = stage.indexOf("$acl = New-Object Security.AccessControl.DirectorySecurity; $acl.SetOwner($me); $acl.SetAccessRuleProtection($true,$false);");
	const persist = stage.indexOf("[IO.Directory]::SetAccessControl($tools,$acl);");
	const readback = stage.indexOf("throw 'private-owner'");
	assert.ok(owner >= 0 && owner < persist && persist < readback);
	assert.equal(stage.split("SetAccessControl(").length, 2, "owner and DACL are written together, once");
});

test("a rejected claim keeps its first line, then names each candidate folder and, for acl-mask, the principal and rights", () => {
	const stage = cmdStage(stageMarkers.claim);
	assert.ok(stage.includes(`[Console]::Error.WriteLine('${claimMessage} Reason: ' + $reason); foreach ($line in $tried) { [Console]::Error.WriteLine('Bootstrap: storage candidate ' + $line) }; exit 1`));
	assert.ok(stage.includes("$tried += ($base + ': ' + $code + $detail);"));
	assert.ok(stage.includes("$detail = ' at ' + $path + ': ' + $rule.IdentityReference.Value + (& $account $rule.IdentityReference) + ' allowed 0x' + ([int]$rule.FileSystemRights).ToString('X8'); throw 'acl-mask'"));
	assert.ok(stage.includes("$detail = ' owned by ' + $owner.Value + (& $account $owner); throw 'home-owner'"));
	assert.ok(stage.includes("$account = { param($sid) try { ' (' + $sid.Translate([Security.Principal.NTAccount]).Value + ')' } catch { '' } };"), "the account name is added only when it resolves");
	// The candidate catch copies only walk codes; anything else stays unexpected-<step>.
	assert.ok(stage.includes("$code = 'unexpected-' + $step; if ($_.Exception.Message -cmatch '^(path-mismatch|home-owner|ancestor-reparse|ancestor-owner|acl-mask)$') { $code = $_.Exception.Message };"));
	// A failure after the walk names the chosen folder, which is removed by its own path.
	assert.ok(stage.includes("if ($step -cmatch '^(create|private-acl|marker)$') { $tried += ($tools + ': ' + $reason) };"));
	assert.ok(stage.includes("if ($claimed) { Remove-Item -LiteralPath $tools -Recurse -Force -ErrorAction SilentlyContinue };"));
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

// An older stable Node, or one whose storage fails the reparse/owner/ACL walk
// before it ever runs, is left as it is: its record goes and the verified pinned
// Node is acquired exactly as when Node is absent (POSIX parity, S2). Never the
// acquired Node: it must be v24.21.0 and pass every check. Unknown versions refuse.
test("an older or untrusted user Node re-enters the pinned acquisition once; the acquired Node and unknown versions still refuse", () => {
	const source = readFileSync(new URL("../scripts/bootstrap.cmd", import.meta.url), "utf8").replaceAll("\r\n", "\n");
	const probe = cmdStage(stageMarkers.probe).replaceAll("\r\n", "\n");
	assert.match(probe, /"& \{ \$child = \$null; \$started = \$false; \$acquired = \$true; \$step = 'policy'; try \{/, "refusal is the default before any check");
	assert.match(probe, /throw 'missing-target' \}; \$acquired = Test-Path -LiteralPath \(Join-Path \$tools '\.node-stem'\);/);
	assert.match(probe, /if \(\$acquired -and \$version -ne 'v24\.21\.0'\) \{ throw 'acquired-version' \};/);
	assert.match(probe, /\[Version\]\$metadata\.engines\.node\.Substring\(2\)\) \{ if \(\$acquired\) \{ throw 'engine' \}; \[IO\.File\]::Delete\(\(Join-Path \$tools '\.node-target'\)\) \};/);
	const untrusted = probe.match(/if \(-not \$acquired -and \$reason -cmatch '\^\(([a-z|()-]+)\)\$'\) \{ \[IO\.File\]::Delete\(\(Join-Path \$env:GENTLE_BOOTSTRAP_TOOLS '\.node-target'\)\) \}\" \^\n {2}\"else \{ \[Console\]::Error\.WriteLine\(/);
	assert.ok(untrusted, "only fixed storage codes leave the user's Node; everything else still refuses");
	const leaves = new RegExp(`^(?:${untrusted[1]})$`);
	for (const code of ["unsafe-target", "unsafe-path", ...probeRoles.flatMap((role) => probeWalkChecks.map((check) => `${role}-${check}`))]) assert.match(code, leaves);
	for (const code of ["policy", "missing-target", "no-start", "deadline", "output-limit", "exit-code", "version-format", "engine", "acquired-version", "unexpected-start"]) assert.doesNotMatch(code, leaves, code);
	assert.ok(probe.indexOf("$step = 'acl-walk'") < probe.indexOf("$child.Start()"), "the storage walk finishes before the Node could start");
	// Flow: a removed record jumps back to the verified download, ZIP and probe stages.
	const end = source.indexOf(probe) + probe.length;
	assert.ok(source.slice(end).startsWith('\nif errorlevel 1 goto failed\nif not exist "%GENTLE_BOOTSTRAP_TOOLS%\\.node-target" goto acquirenode\n\nrem Launch'));
	const label = source.indexOf("\n:acquirenode\n");
	assert.ok(source.indexOf(stageMarkers.resolve) < label && source.includes("\n:acquirenode\nrem Fixed official ZIP transport"), "the label opens the download stage");
	assert.equal(source.split(":acquirenode").length, 2, "one label");
	for (const marker of [stageMarkers.zip, "rem Fixed official ZIP transport"]) {
		assert.match(cmdStage(marker), /if \(Test-Path -LiteralPath \(Join-Path \$tools '\.node-target'\)\) \{ exit 0 \};/, "a kept record skips acquisition");
	}
	// The second pass has .node-stem, so the acquired Node can only pass or refuse: no loop.
	assert.match(cmdStage("rem Fixed official ZIP transport"), /\$null = New-Item -ItemType File -Path \(Join-Path \$tools '\.node-stem'\) -Value \$stem;/);
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
	// A policy denial still stops at the wrapper (an untrusted wrapper is covered below).
	await assert.rejects(ensureWindowsPnpm({ tools: "C:\\tools", env, onStep: (step: string) => steps.push(step), adapters: {
		findCommand: () => "C:\\fixture\\pnpm.cmd", storage: () => { throw Object.assign(new Error("Windows ACL evidence rejected"), { check: "policy" }); },
	} }), (error: { check?: string }) => error.check === "policy");
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

// S1: the user's own pnpm under a %LOCALAPPDATA% another principal may write is
// never run. Like an untrusted user Node in bootstrap.cmd, a storage rejection of
// its wrapper, Node, entry or metadata leaves it as it is and the verified pnpm is
// acquired into the private tools folder. Policy and other failures still stop.
test("an existing pnpm whose storage fails the walk is never run and the verified pnpm is acquired", async () => {
	const components = { "wrapper-storage": "pnpm.cmd", "node-storage": "node.exe", "entry-storage": "node_modules/pnpm/bin/pnpm.mjs", "metadata-storage": "node_modules/pnpm/package.json" };
	for (const [step, component] of Object.entries(components)) {
		for (const check of ["target-acl-mask", "parent-acl-mask", "ancestor-owner", "target-reparse"]) {
			const f = fixture();
			try {
				const commands = join(f.root, "commands"); pnpmWrapperDirectory(commands);
				const tools = join(f.root, "tools"); mkdirSync(tools);
				const steps: string[] = []; const ran: string[] = [];
				const result = await ensureWindowsPnpm({ tools, env: { Path: commands, PATHEXT: ".EXE;.CMD" }, onStep: (next: string) => steps.push(next), adapters: {
					storage: (path: string) => { if (path === join(commands, component)) throw Object.assign(new Error("Windows ACL evidence rejected"), { check }); },
					download: async () => pnpmTar(), digest, process: (command: string, args: string[]) => { ran.push(...[command, ...args].filter((value) => value.startsWith(commands))); return cliProcess(command, args); } } });
				assert.equal(result.acquired, true, `${step} ${check}`);
				assert.deepEqual(result.prefix, [join(tools, "pnpm/package/bin/pnpm.mjs")]);
				assert.equal(steps[steps.indexOf(step) + 1], "tools-check", `${step} ${check}: ${steps}`);
				assert.deepEqual(ran, [], "nothing from the untrusted pnpm runs");
			} finally { f.cleanup(); }
		}
	}
	for (const error of [Object.assign(new Error("Windows ACL evidence rejected"), { check: "policy" }), new Error("Windows ACL evidence rejected"), new Error("Windows prerequisite process failed")]) {
		const f = fixture();
		try {
			const commands = join(f.root, "commands"); pnpmWrapperDirectory(commands);
			const tools = join(f.root, "tools"); mkdirSync(tools);
			let downloads = 0;
			await assert.rejects(ensureWindowsPnpm({ tools, env: { Path: commands, PATHEXT: ".EXE;.CMD" }, adapters: {
				storage: (path: string) => { if (path.startsWith(commands)) throw error; },
				download: async () => { downloads++; return pnpmTar(); }, digest, process: cliProcess } }), (rejected: unknown) => rejected === error);
			assert.equal(downloads, 0, error.message);
			assert.deepEqual(readdirSync(tools), []);
		} finally { f.cleanup(); }
	}
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
	assert.ok(check.includes("if ($_.Exception.Message -cmatch '^(policy|(target|parent|ancestor)-(reparse|owner|acl-mask))$') { 'unsafe:' + $_.Exception.Message + " +
		"$(if ($detail) { '|' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($detail)) } else { '' }) } else { throw }"), "unexpected exceptions still exit nonzero");
});

// S6: a walk rejection names the component, the principal and the rights that
// failed, as base64 UTF-8 after the fixed code, for the PNPM_HOME guidance.
const encoded = (text: string) => Buffer.from(text, "utf8").toString("base64");
test("storage ACL evidence carries the failing folder, principal and rights; malformed detail drops the code", () => {
	const detail = "C:\\Users\\mé\\AppData\\Local|S-1-5-21-1-2-3-1002|PC\\other|0x001301BF";
	assert.throws(() => windowsStorageEvidence(`unsafe:target-acl-mask|${encoded(detail)}`), (error: Error & { check?: string; detail?: object }) =>
		error.check === "target-acl-mask" && JSON.stringify(error.detail) === JSON.stringify({ at: "C:\\Users\\mé\\AppData\\Local", sid: "S-1-5-21-1-2-3-1002", account: "PC\\other", rights: "0x001301BF" }));
	assert.throws(() => windowsStorageEvidence(`unsafe:parent-owner|${encoded("C:\\Users\\m|S-1-5-21-9||")}`), (error: Error & { check?: string; detail?: object }) =>
		error.check === "parent-owner" && JSON.stringify(error.detail) === JSON.stringify({ at: "C:\\Users\\m", sid: "S-1-5-21-9" }));
	assert.throws(() => windowsStorageEvidence(`unsafe:target-reparse|${encoded("C:\\link|||")}`), (error: Error & { detail?: object }) => JSON.stringify(error.detail) === JSON.stringify({ at: "C:\\link" }));
	for (const bad of ["relative|S-1-5-18||", "C:\\x|not-a-sid||", "C:\\x|S-1-5-18||0x1", "C:\\x|S-1-5-18||\n", "C:\\x|S-1-5-18|||extra", "C:\\x|S-1-5-18"]) {
		assert.throws(() => windowsStorageEvidence(`unsafe:target-acl-mask|${encoded(bad)}`), (error: Error & { check?: string }) => error.check === undefined, bad);
	}
	for (const output of [`unsafe:policy|${encoded("C:\\x|||")}`, "unsafe:target-acl-mask|not base64!", `unsafe:target-acl-mask|${encoded("C:\\x|||")}x`]) {
		assert.throws(() => windowsStorageEvidence(output), (error: Error & { check?: string }) => error.check === undefined, output);
	}
	const check = productionAclSources()[2];
	assert.ok(check.includes("$detail = $path + '|' + $rule.IdentityReference.Value + '|' + (& $account $rule.IdentityReference) + '|0x' + ([int]$rule.FileSystemRights).ToString('X8'); throw ($role + '-acl-mask')"));
	assert.ok(check.includes("$detail = $path + '|' + $owner.Value + '|' + (& $account $owner) + '|'; throw ($role + '-owner')"));
	assert.ok(check.includes("$detail = $path + '|||'; throw ($role + '-reparse')"));
});

// S6 notice: every reused tool path in one Windows PowerShell launch.
const manyCheck = () => readFileSync(new URL("../scripts/installer-windows.mjs", import.meta.url), "utf8").split("const aclCheckMany = String.raw`")[1].split("`;")[0];
const walkLoop = (source: string) => source.slice(source.indexOf("$depth = 0;"), source.indexOf("'safe'")).replace(/\s+/g, " ");
test("verifyWindowsStorageMany walks every path in one Windows PowerShell launch and reads one result line per path", () => {
	const paths = ["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\m\\AppData\\Roaming\\npm\\pi.cmd", "D:\\go\\bin\\go.exe"];
	const weak = "C:\\Users\\m\\AppData\\Roaming|S-1-5-21-1-2-3-1002|PC\\other|0x001301BF";
	const calls: { command: string; args: string[]; env: Record<string, string> }[] = [];
	const adapter = (output: string) => (command: string, args: string[], env: Record<string, string>) => { calls.push({ command, args, env }); return output; };
	const env = { SystemRoot: "C:\\Windows" };
	const many = (output: string, list = paths) => windowsModule.verifyWindowsStorageMany(list, env, { processAdapter: adapter(output), platform: "win32" });
	// A1: a path whose walk failed for another reason (READ_CONTROL denied, for example) could not be checked.
	assert.deepEqual(many(`safe\r\nunsafe:parent-acl-mask|${encoded(weak)}\r\nunknown`),
		[null, { check: "parent-acl-mask", at: "C:\\Users\\m\\AppData\\Roaming", sid: "S-1-5-21-1-2-3-1002", account: "PC\\other", rights: "0x001301BF" },
			{ check: "unchecked", at: "D:\\go\\bin\\go.exe" }]);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].command, join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
	assert.deepEqual(calls[0].args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
	assert.equal(calls[0].args[4], manyCheck());
	assert.deepEqual(calls[0].env, { ...env, GENTLE_WINDOWS_CHECKS: paths.join("|") }, "paths travel only as environment data, joined by a character no Windows path holds");
	// A reparse point and an owner are findings too; nothing to walk launches nothing.
	assert.deepEqual(many(`unsafe:target-reparse|${encoded("C:\\link|||")}\nunsafe:ancestor-owner|${encoded("C:\\Users|S-1-5-21-9||")}\nsafe`),
		[{ check: "target-reparse", at: "C:\\link" }, { check: "ancestor-owner", at: "C:\\Users", sid: "S-1-5-21-9" }, null]);
	const launches = calls.length;
	assert.deepEqual(many("safe", []), []);
	assert.equal(calls.length, launches);
	// Policy, a count that does not match, or any other line rejects the whole result.
	for (const output of ["unsafe:policy", "safe\nsafe", "safe\nsafe\nsafe\nsafe", "safe\nSAFE\nsafe", "safe\nunsafe:policy\nsafe", `safe\nunsafe:parent-acl-mask|${encoded("relative|||")}\nsafe`,
		"safe\nunsafe:C:\\Users\\x\nsafe", ""]) {
		assert.throws(() => many(output), (error: Error) => error.message === "Windows ACL evidence rejected", JSON.stringify(output));
	}
	// Only local drive paths, never one holding the delimiter, and only on Windows.
	const before = calls.length;
	for (const bad of ["\\\\server\\share\\node.exe", "\\\\?\\C:\\node.exe", "\\node.exe", "relative\\node.exe", "C:\\a|b\\node.exe", "C:\\a\nb"]) {
		assert.throws(() => many("safe", [bad]), /Unsafe Windows storage path/, bad);
	}
	assert.equal(calls.length, before, "a rejected path launches nothing");
	assert.throws(() => windowsModule.verifyWindowsStorageMany(paths, env, { processAdapter: adapter("safe") }), process.platform === "win32" ? /Windows ACL evidence rejected/ : /Native Windows storage verification unavailable/);
});
test("the one-launch walk applies the single-path walk, per path, with its own fixed result lines", () => {
	const many = manyCheck();
	const single = productionAclSources()[2];
	assert.equal(walkLoop(many), walkLoop(single), "the same walk, statement for statement");
	assert.ok(walkLoop(many).length > 500);
	assert.match(many, /if \(\$ExecutionContext\.SessionState\.LanguageMode -ne 'FullLanguage'\) \{ 'unsafe:policy'; exit 0 \};/);
	assert.match(many, /foreach \(\$start in \$env:GENTLE_WINDOWS_CHECKS\.Split\('\|'\)\) \{/);
	assert.match(many, /\$detail = '';\s+try \{\s+\$path = \[IO\.Path\]::GetFullPath\(\$start\);/);
	assert.ok(many.includes("} else { 'unknown' } }"), "an unexpected error on one path is that path's `unknown` line, never a stop");
	assert.doesNotMatch(many, /Invoke-Expression|\biex\b|ScriptBlock\]::Create|EncodedCommand/);
});

// S6 decision fixtures: an in-memory folder tree and an injected walk verdict per
// path, the same way the helper tests inject storage. `weak` maps a walked path
// to the check its walk fails; every other walk passes.
const W_LOCAL = "C:\\Users\\m\\AppData\\Local";
const W_DEFAULT = `${W_LOCAL}\\pnpm`;
const W_PRIVATE = "C:\\Users\\m\\.pnpm";
const homeEnv = { LOCALAPPDATA: W_LOCAL, USERPROFILE: "C:\\Users\\m", SystemRoot: "C:\\Windows" };
function homeDecision({ env = homeEnv as Record<string, string>, dirs = [] as string[], files = {} as Record<string, string>, weak = {} as Record<string, string>,
	throws = null as Error | null } = {}) {
	const walked: string[] = [];
	const existing = new Set(["C:\\", "C:\\Users", "C:\\Users\\m", "C:\\Users\\m\\AppData", W_LOCAL, ...dirs]);
	const fs = {
		kind: (path: string) => (existing.has(path) ? "directory" : path in files ? "file" : "missing"),
		entries: (path: string) => [...existing, ...Object.keys(files)].filter((entry) => entry !== path && entry.startsWith(`${path}\\`) && !entry.slice(path.length + 1).includes("\\")),
		readText: (path: string) => files[path],
	};
	const storage = (path: string) => {
		walked.push(path);
		if (throws) throw throws;
		if (path in weak) throw Object.assign(new Error("Windows ACL evidence rejected"), { check: weak[path], detail: { at: path, sid: "S-1-5-21-1-2-3-1002", account: "PC\\other", rights: "0x001301BF" } });
	};
	return { decide: () => windowsModule.windowsPnpmHome({ env, storage, fs }), wizard: () => windowsModule.windowsWizardEnvironment({ env, storage, fs }), walked };
}
const finding = (path: string, check = "target-acl-mask") => ({ check, at: path, sid: "S-1-5-21-1-2-3-1002", account: "PC\\other", rights: "0x001301BF" });

test("a default PNPM_HOME that passes the walk is used as before, absent or present with its bin", () => {
	const absent = homeDecision();
	assert.deepEqual(absent.decide(), { available: true, path: W_DEFAULT, source: "default" });
	assert.deepEqual(absent.walked, [W_LOCAL], "an absent folder walks its nearest existing ancestor");
	const present = homeDecision({ dirs: [W_DEFAULT, `${W_DEFAULT}\\bin`] });
	assert.deepEqual(present.decide(), { available: true, path: W_DEFAULT, source: "default" });
	assert.deepEqual(present.walked, [W_DEFAULT, `${W_DEFAULT}\\bin`]);
	// The wizard environment is the caller's own object, unchanged.
	const wizard = present.wizard();
	assert.deepEqual(wizard.pnpmHome, { available: true, path: W_DEFAULT, source: "default" });
	assert.deepEqual(wizard.env, homeEnv);
});

test("a weak default holding nothing switches to %USERPROFILE%\\.pnpm, which must pass the walk itself", () => {
	for (const dirs of [[], [W_DEFAULT]]) {
		const weakAt = dirs.length ? W_DEFAULT : W_LOCAL;
		const h = homeDecision({ dirs, weak: { [weakAt]: "target-acl-mask" } });
		assert.deepEqual(h.decide(), { available: true, path: W_PRIVATE, source: "private", rejected: { path: W_DEFAULT, ...finding(weakAt) } });
		assert.deepEqual(h.walked, [weakAt, "C:\\Users\\m"]);
	}
	// The private folder already created by this flow (marked) or empty is accepted.
	const marker = `${W_PRIVATE}\\.gentle-shell-pnpm-home`;
	for (const [dirs, files] of [[[W_PRIVATE], {}], [[W_PRIVATE, `${W_PRIVATE}\\bin`], { [marker]: "gentle-pi private pnpm home" }]] as const) {
		const h = homeDecision({ dirs: [...dirs], files: { ...files }, weak: { [W_LOCAL]: "target-acl-mask" } });
		assert.equal(h.decide().source, "private");
	}
	// The wizard environment points PNPM_HOME there; childEnvironment adds pnpm's own folders.
	const wizard = homeDecision({ weak: { [W_LOCAL]: "target-acl-mask" } }).wizard();
	assert.deepEqual(wizard.env, { ...homeEnv, PNPM_HOME: W_PRIVATE });
});

test("a weak default that already holds files, a weak or foreign private folder, or a weak user PNPM_HOME blocks", () => {
	const installed = homeDecision({ dirs: [W_DEFAULT, `${W_DEFAULT}\\store`], weak: { [W_DEFAULT]: "target-acl-mask" } });
	assert.deepEqual(installed.decide(), { available: true, path: W_DEFAULT, source: "default", untrusted: finding(W_DEFAULT), installed: true });
	assert.deepEqual(installed.walked, [W_DEFAULT], "the private folder is never considered");
	const file = homeDecision({ files: { [W_DEFAULT]: "" }, weak: { [W_DEFAULT]: "target-owner" } });
	assert.equal(file.decide().installed, true, "anything but an empty real directory counts as installed");
	const foreign = homeDecision({ dirs: [W_PRIVATE], files: { [`${W_PRIVATE}\\notes.txt`]: "x" }, weak: { [W_LOCAL]: "target-acl-mask" } });
	assert.deepEqual(foreign.decide(), { available: true, path: W_DEFAULT, source: "default", untrusted: finding(W_LOCAL), private: { path: W_PRIVATE, foreign: true } });
	const forged = homeDecision({ dirs: [W_PRIVATE], files: { [`${W_PRIVATE}\\.gentle-shell-pnpm-home`]: "other text" }, weak: { [W_LOCAL]: "target-acl-mask" } });
	assert.equal(forged.decide().private?.foreign, true);
	const weakPrivate = homeDecision({ weak: { [W_LOCAL]: "target-acl-mask", "C:\\Users\\m": "target-owner" } });
	assert.deepEqual(weakPrivate.decide(), { available: true, path: W_DEFAULT, source: "default", untrusted: finding(W_LOCAL),
		private: { path: W_PRIVATE, untrusted: finding("C:\\Users\\m", "target-owner") } });
	const user = homeDecision({ env: { ...homeEnv, Pnpm_Home: "C:\\pnpm\\" }, weak: { "C:\\": "target-acl-mask" } });
	assert.deepEqual(user.decide(), { available: true, path: "C:\\pnpm", source: "user", untrusted: finding("C:\\") });
	assert.deepEqual(user.walked, ["C:\\"], "a set PNPM_HOME is walked; absent here, so its nearest existing ancestor is");
	assert.throws(() => homeDecision({ env: { ...homeEnv, PNPM_HOME: "D:\\pnpm" } }).decide(), /Unknown Windows PNPM_HOME/, "a drive with no existing folder");
	// Blockers never change the wizard environment.
	assert.deepEqual(installed.wizard().env, homeEnv);
	// An unknowable home is null, as for pnpmGlobalBin; a policy denial or failed walk is a failed check.
	assert.equal(homeDecision({ env: { ...homeEnv, PNPM_HOME: "relative" } }).decide(), null);
	assert.equal(homeDecision({ env: { USERPROFILE: "C:\\Users\\m" } }).decide(), null);
	const policy = homeDecision({ throws: Object.assign(new Error("Windows ACL evidence rejected"), { check: "policy" }) });
	assert.throws(() => policy.decide());
	assert.deepEqual(policy.wizard(), { env: homeEnv, pnpmHome: { available: null, failed: true } });
});

// The private PNPM_HOME is claimed after consent with the bootstrap claim's exact
// private-ACL primitives; only a marked or empty folder is ever kept or adopted.
test("the private PNPM_HOME claim reuses the bootstrap's protected DACL and readback, and adopts nothing foreign", () => {
	const source = readFileSync(new URL("../scripts/installer-windows.mjs", import.meta.url), "utf8");
	const claim = source.split("const pnpmHomeClaim = String.raw`")[1].split("`;")[0];
	const bootstrap = cmdStage(stageMarkers.claim).replaceAll("$tools", "$target");
	for (const statement of [
		"$acl = New-Object Security.AccessControl.DirectorySecurity; $acl.SetOwner($me); $acl.SetAccessRuleProtection($true,$false);",
		"foreach ($sid in @($me.Value,'S-1-5-18','S-1-5-32-544')) {",
		"$identity = New-Object Security.Principal.SecurityIdentifier($sid);",
		"$rule = New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule);",
		"}; [IO.Directory]::SetAccessControl($target,$acl);",
		"$verified = [IO.Directory]::GetAccessControl($target); if (-not $verified.AreAccessRulesProtected) { throw 'protected-dacl' };",
		"if ($verified.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $me.Value) { throw 'private-owner' };",
		"foreach ($rule in $verified.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { if ($rule.AccessControlType -ne 'Allow' -or @($me.Value,'S-1-5-18','S-1-5-32-544') -notcontains $rule.IdentityReference.Value) { throw 'private-ace' } };",
	]) {
		assert.ok(bootstrap.includes(statement), `bootstrap: ${statement}`);
		assert.ok(claim.includes(statement), `claim: ${statement}`);
	}
	assert.ok(claim.includes("if (@(Get-ChildItem -LiteralPath $target -Force).Count -ne 0) {"), "only an empty folder is adopted");
	assert.ok(claim.includes("(Get-Content -LiteralPath $marker -Raw) -ne 'gentle-pi private pnpm home') { throw 'foreign' };"), "a non-empty one must carry the exact marker");
	assert.ok(claim.includes("if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'foreign' };"));
	assert.ok(claim.indexOf("throw 'private-ace'") < claim.indexOf("$null = New-Item -ItemType File -Path $marker"), "marked only after the readback");
	assert.ok(claim.includes("if ($created) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue };"), "only a folder this run created is removed");
	assert.equal(windowsModule.privatePnpmHome.text, "gentle-pi private pnpm home");
	// The Node side accepts only the fixed results, then walks the folder again.
	if (process.platform !== "win32") assert.throws(() => windowsModule.ensureWindowsPnpmHome(W_PRIVATE, homeEnv, { processAdapter: () => "claimed" }), /Native Windows/);
});

// R2: the claim also creates the children's TEMP/TMP folder inside the claimed
// home, after the DACL readback, so it inherits that protected DACL; the Node side
// walks both before any command runs.
test("prepare-pnpm-home creates the private tmp folder inside the claimed home and walks it", () => {
	const source = readFileSync(new URL("../scripts/installer-windows.mjs", import.meta.url), "utf8");
	const claim = source.split("const pnpmHomeClaim = String.raw`")[1].split("`;")[0];
	const tmp = claim.indexOf("$temp = Join-Path $target 'tmp';");
	assert.ok(tmp > claim.indexOf("throw 'private-ace'"), "after the readback");
	assert.ok(claim.includes("if (Test-Path -LiteralPath $temp) { $folder = Get-Item -LiteralPath $temp -Force; if (-not $folder.PSIsContainer -or ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'foreign' } } else { $null = New-Item -ItemType Directory -Path $temp };"));
	assert.ok(tmp < claim.indexOf("  $result\n"), "also for a kept home");
	for (const output of ["claimed", "kept"]) {
		const walked: string[] = []; const scripts: string[] = [];
		const result = windowsModule.ensureWindowsPnpmHome(W_PRIVATE, homeEnv, { platform: "win32",
			processAdapter: (_command: string, args: string[], env: Record<string, string>) => { scripts.push(args[4]); assert.equal(env.GENTLE_WINDOWS_PNPM_HOME, W_PRIVATE); return output; },
			storage: (path: string) => { walked.push(path); } });
		assert.equal(result, output);
		assert.deepEqual(walked, [W_PRIVATE, `${W_PRIVATE}\\tmp`]);
		assert.equal(scripts[0], claim);
	}
	assert.equal(windowsModule.privatePnpmHome.temp, "tmp");
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
		// The stage's own code is kept: a claim reports its fallback with exit 2.
		...stages.flatMap((stage) => [...observeStage(stage).split("\n"), "if errorlevel 1 exit /b %errorlevel%"]),
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
	prefix.push('  "$tools = $env:GENTLE_BOOTSTRAP_TOOLS; $acquired = Test-Path -LiteralPath (Join-Path $tools \'.node-stem\'); $start = New-Object Diagnostics.ProcessStartInfo; $start.FileName = $env:GENTLE_FIXTURE_NODE; $start.Arguments = [string][char]34 + $env:GENTLE_FIXTURE_PROBE + [char]34; $start.UseShellExecute = $false; $start.CreateNoWindow = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true;" ^');
	const recordChild = '  "[IO.File]::AppendAllText($env:GENTLE_FIXTURE_RECORDS,([string]$child.Id + [char]124 + [string]$child.StartTime.ToUniversalTime().Ticks + [Environment]::NewLine));" ^';
	return [...prefix, stage[childAt], recordChild, ...stage.slice(childAt + 1)].join("\n");
}

test("native entry observation preserves the complete production batch", () => {
	const source = readFileSync(new URL("../scripts/bootstrap.cmd", import.meta.url), "utf8");
	const observed = observeStage(source).split("\n");
	assert.equal(observed.filter((line) => line === psRecordLine).length, 1);
	assert.equal(observed.filter((line) => line !== psRecordLine).join("\n"), source);
});

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
	// The Administrators variant only changes the owner it sets, and never on the fixture root.
	const administrators = cmdComposition([fixtureAdministratorsOwnerSetup]);
	assert.match(administrators, /\$me = New-Object Security\.Principal\.SecurityIdentifier\('S-1-5-32-544'\); \$acl = \[IO\.Directory\]::GetAccessControl\(\$target\); \$acl\.SetOwner\(\$me\)/);
	assert.match(administrators, /if \(\(-not \$target\.StartsWith\(\$root/);
	assert.doesNotMatch(administrators, /GetCurrent\(\)|AddAccessRule|SetAccessRule/);
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
	return nativeCmdFile(root, "fixture.cmd", env, limit);
}
async function nativeCmdFile(root: string, file: string, env: NodeJS.ProcessEnv, limit = 5000): Promise<NativeResult> {
	const started = performance.now();
	const trace = (phase: string, detail: Record<string, unknown> = {}) => {
		if (file === "scripts\\bootstrap.cmd") console.error("WINDOWS_ENTRY_PHASE", JSON.stringify({ phase, elapsedMs: performance.now() - started, limit, ...detail }));
	};
	trace("spawn-request");
	const child = spawn(join(process.env.SystemRoot!, "System32/cmd.exe"), ["/d", "/c", file], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = ""; let stderr = ""; let guardKilled = false;
	child.once("spawn", () => trace("cmd-spawned"));
	child.once("exit", (status, signal) => trace("cmd-exit", { status, signal }));
	let guardError: unknown;
	const result = await new Promise<NativeResult>((resolveChild, reject) => {
		const timer = setTimeout(() => {
			guardKilled = true;
			trace("guard-fired", { recordExists: existsSync(join(root, "process-records")), diagnosticSeen: /No acquisition attempted/.test(stderr) });
			try { cleanNativeProcesses(root); } catch (error) { guardError = error; }
			child.kill("SIGKILL");
			child.stdout.destroy(); child.stderr.destroy();
			resolveChild({ status: null, stdout, stderr, guardKilled });
		}, limit);
		child.stdout.on("data", (bytes: Buffer) => { stdout += bytes.toString(); if (stdout.length > 1048576) { guardError = new Error("Fixture output limit"); child.kill("SIGKILL"); } });
		child.stderr.on("data", (bytes: Buffer) => {
			const before = stderr;
			stderr += bytes.toString();
			if (!before.length) trace("first-stderr", { bytes: bytes.length });
			if (!/No acquisition attempted/.test(before) && /No acquisition attempted/.test(stderr)) trace("missing-bundle-diagnostic");
			if (stderr.length > 1048576) { guardError = new Error("Fixture output limit"); child.kill("SIGKILL"); } });
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
		child.once("close", (status) => { trace("cmd-close", { status, guardKilled }); clearTimeout(timer); resolveChild({ status, stdout, stderr, guardKilled }); });
	});
	const residualReaped = cleanNativeProcesses(root);
	assert.equal(residualReaped, false, "production must reap its own recorded children; fixture cleanup cannot mask a failure");
	assert.equal(guardError, undefined);
	return result;
}
test("native Windows: entry fixture deadline is bounded and leaves no recorded descendant", { skip: nativeUnavailable }, async () => {
	const f = nativeFixture();
	try {
		// A finite sleep preserves CMD → PowerShell ancestry without relying on
		// runner load or leaving a permanently hanging child after a worker crash.
		const sleepingStage = `"%GENTLE_BOOTSTRAP_PS%" -NoLogo -NoProfile -NonInteractive -Command ^
  "& { if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'Policy constrained' };" ^
  "[Threading.Thread]::Sleep(20000); }"`;
		writeFileSync(join(f.root, "fixture.cmd"), cmdComposition([sleepingStage]));
		const started = performance.now();
		const result = await nativeCmdFile(f.root, "fixture.cmd", nativeEnv(f.root), 5000);
		const elapsedMs = performance.now() - started;
		const records = readFileSync(join(f.root, "process-records"), "utf8").trim().split(/\r?\n/);
		assert.equal(records.length, 1, "the controlled PowerShell descendant must have been observed");
		assert.match(records[0], /^[1-9][0-9]*\|[1-9][0-9]*$/);
		const residualReaped = cleanNativeProcesses(f.root);
		console.error("WINDOWS_ENTRY_DEADLINE_RESULT", JSON.stringify({ elapsedMs, status: result.status, guardKilled: result.guardKilled, residualReaped }));
		assert.equal(result.guardKilled, true, "the forced fixture deadline must be reported");
		assert.equal(result.status, null, "a deadline cannot report successful completion");
		// Five-second deadline plus two bounded guard invocations and margin.
		assert.ok(elapsedMs < 16000, `entry fixture exceeded its outer bound: ${elapsedMs}ms`);
		assert.equal(residualReaped, false, "entry runner must reap recorded descendants; later cleanup must not mask a leak");
	} finally {
		try { cleanNativeProcesses(f.root); } finally { f.cleanup(); }
	}
});

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
  "$rights = [int]$env:GENTLE_FIXTURE_RIGHTS; if (@(4,2,16,256,64,65536,262144,524288,1245631) -notcontains $rights) { throw 'Unknown fixture right' };" ^
  "$acl = [IO.Directory]::GetAccessControl($target); $sid = New-Object Security.Principal.SecurityIdentifier('S-1-1-0');" ^
  "$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid,$rights,'None','None','Allow'); $acl.SetAccessRule($rule); [IO.Directory]::SetAccessControl($target,$acl);" ^
  "}"`;

// Elevated Windows Server runners create directories owned by BUILTIN\Administrators,
// while the User Profile Service creates a real %LOCALAPPDATA% owned by the user.
// Production's home-owner check accepts the user, SYSTEM or Administrators; a fixture
// directory used as LOCALAPPDATA still gets the invoking SID as owner, read back
// before any stage, so only the check under test can reject a claim.
const fixtureOwnerSetup = `"%GENTLE_BOOTSTRAP_PS%" -NoLogo -NoProfile -NonInteractive -Command ^
  "& { $ErrorActionPreference = 'Stop';" ^
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'Policy constrained' };" ^
  "$root = [IO.Path]::GetFullPath($env:GENTLE_FIXTURE_ROOT); $target = [IO.Path]::GetFullPath($env:GENTLE_FIXTURE_OWNER_TARGET);" ^
  "if (($target -ne $root -and -not $target.StartsWith($root + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) -or (Get-Content -LiteralPath (Join-Path $root '.fixture-owned') -Raw) -ne 'gentle Windows acceptance fixture') { throw 'Not fixture-owned' };" ^
  "$item = Get-Item -LiteralPath $target -Force; if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe fixture' };" ^
  "$me = [Security.Principal.WindowsIdentity]::GetCurrent().User; $acl = [IO.Directory]::GetAccessControl($target); $acl.SetOwner($me); [IO.Directory]::SetAccessControl($target,$acl);" ^
  "if (([IO.Directory]::GetAccessControl($target)).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $me.Value) { throw 'Fixture owner not established' };" ^
  "}"`;
// An elevated Administrators member may hand a new fixture directory to BUILTIN\Administrators,
// the owner the tester's new folders had; read back before any stage runs.
const fixtureAdministratorsOwnerSetup = fixtureOwnerSetup
	.replace("$me = [Security.Principal.WindowsIdentity]::GetCurrent().User;", "$me = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544');")
	.replace("($target -ne $root -and -not $target.StartsWith(", "(-not $target.StartsWith(");
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

// S1, the tester's layout: another principal may modify %LOCALAPPDATA% (0x1301bf)
// and new folders belong to Administrators. Fixture folders stand in for both
// bases; every ancestor above them is the runner's real path, walked as usual.
const modifyRights = 0x1301bf;
function candidateEnv(root: string, local: string, profile: string) {
	return { ...nativeEnv(root, join(local, ".gentle-shell-bootstrap-tools.primary")), LOCALAPPDATA: local, USERPROFILE: profile,
		GENTLE_BOOTSTRAP_FALLBACK_TOOLS: join(profile, ".gentle-shell-bootstrap-tools.fallback") };
}
async function grantEveryone(root: string, target: string, rights: number) {
	assertNative(await nativeCmd(root, [fixtureAclSetup], { ...nativeEnv(root), GENTLE_FIXTURE_ACL_TARGET: target, GENTLE_FIXTURE_RIGHTS: String(rights) }), 0);
}
async function ownByAdministrators(root: string, target: string) {
	const result = await nativeCmd(root, [fixtureAdministratorsOwnerSetup], { ...nativeEnv(root), GENTLE_FIXTURE_OWNER_TARGET: target });
	assert.equal(result.status, 0, `fixture could not hand its directory to Administrators; stderr: ${result.stderr.slice(0, 4000)}`);
}
function candidateLine(stderr: string, base: string) {
	return stderr.split(/\r?\n/).find((line) => line.startsWith(`Bootstrap: storage candidate ${base}: `)) ?? "";
}

test("native Windows: a %LOCALAPPDATA% another principal may modify falls back to an Administrators-owned %USERPROFILE%", { skip: nativeUnavailable }, async () => {
	const f = await ownedNativeFixture();
	try {
		const local = join(f.root, "local"); const profile = join(f.root, "profile"); mkdirSync(local); mkdirSync(profile);
		await grantEveryone(f.root, local, modifyRights);
		await ownByAdministrators(f.root, profile);
		const env = candidateEnv(f.root, local, profile);
		const result = await nativeCmd(f.root, [cmdStage(stageMarkers.claim)], env);
		assertNative(result, 2);
		assert.equal(result.stderr.trim(), "");
		assert.equal(existsSync(env.GENTLE_BOOTSTRAP_TOOLS), false, "nothing is created under the writable base");
		// Exit 2 follows the claim's own private-owner readback: the user owns the new folder.
		assert.equal(readFileSync(join(env.GENTLE_BOOTSTRAP_FALLBACK_TOOLS, ".bootstrap-owned"), "utf8"), "gentle-pi prerequisite tooling only");
		// The Node side accepts the same location and still rejects the writable base.
		verifyWindowsStorage(env.GENTLE_BOOTSTRAP_FALLBACK_TOOLS, env);
		assert.throws(() => verifyWindowsStorage(local, env), (error: { check?: string }) => error.check === "target-acl-mask");
		// Without a fallback candidate the same base fails acl-mask as before.
		const alone: NodeJS.ProcessEnv = { ...env }; delete alone.GENTLE_BOOTSTRAP_FALLBACK_TOOLS;
		assertClaimRejected(await nativeCmd(f.root, [cmdStage(stageMarkers.claim)], alone), "acl-mask");
		assert.equal(existsSync(env.GENTLE_BOOTSTRAP_TOOLS), false);
		// A base owned by Administrators (home-owner) is now a valid first candidate too.
		const owned = { ...candidateEnv(f.root, profile, local), GENTLE_BOOTSTRAP_TOOLS: join(profile, ".gentle-shell-bootstrap-tools.direct") };
		assertNative(await nativeCmd(f.root, [cmdStage(stageMarkers.claim)], owned), 0);
		verifyWindowsStorage(owned.GENTLE_BOOTSTRAP_TOOLS, owned);
	} finally { f.cleanup(); }
});

test("native Windows: when both candidates fail, the claim names each folder, principal and rights", { skip: nativeUnavailable }, async () => {
	const f = await ownedNativeFixture();
	try {
		const local = join(f.root, "local"); const weak = join(f.root, "weak"); const profile = join(weak, "profile");
		mkdirSync(local); mkdirSync(profile, { recursive: true });
		await grantEveryone(f.root, local, modifyRights);
		// A distant ancestor of the fallback that another principal may write still rejects it.
		await grantEveryone(f.root, weak, 2);
		const env = candidateEnv(f.root, local, profile);
		const result = await nativeCmd(f.root, [cmdStage(stageMarkers.claim)], env);
		assertClaimRejected(result, "acl-mask");
		assert.match(candidateLine(result.stderr, local), /: acl-mask at .+: S-1-1-0( \([^)]+\))? allowed 0x001301BF$/, result.stderr);
		assert.match(candidateLine(result.stderr, profile), /: acl-mask at .+\\weak: S-1-1-0( \([^)]+\))? allowed 0x00100002$/, result.stderr);
		assert.equal(existsSync(env.GENTLE_BOOTSTRAP_TOOLS), false);
		assert.equal(existsSync(env.GENTLE_BOOTSTRAP_FALLBACK_TOOLS), false);
		const inside = join(profile, "tools"); mkdirSync(inside);
		assert.throws(() => verifyWindowsStorage(inside, env), (error: { check?: string }) => error.check === "ancestor-acl-mask");
	} finally { f.cleanup(); }
});

test("native Windows: a user pnpm in a folder another principal may write is never run and the verified pnpm is acquired", { skip: nativeUnavailable }, async () => {
	const f = await ownedNativeFixture();
	try {
		const env = nativeEnv(f.root);
		assertNative(await nativeCmd(f.root, [cmdStage(stageMarkers.claim)], env), 0);
		const commands = join(f.root, "commands"); pnpmWrapperDirectory(commands);
		await grantEveryone(f.root, commands, modifyRights);
		const ran: string[] = [];
		const result = await ensureWindowsPnpm({ tools: env.GENTLE_BOOTSTRAP_TOOLS, env: nativePath([commands], env), adapters: {
			download: async () => pnpmTar(), digest, process: (command: string, args: string[]) => { ran.push(command); return cliProcess(command, args); } } });
		assert.equal(result.acquired, true);
		assert.deepEqual(result.prefix, [join(env.GENTLE_BOOTSTRAP_TOOLS, "pnpm", "package", "bin", "pnpm.mjs")]);
		assert.equal(ran.some((command) => command.startsWith(commands)), false, "the untrusted wrapper's Node never runs");
	} finally { f.cleanup(); }
});

// S6 on a real Windows host: fixture folders stand in for %LOCALAPPDATA% and
// %USERPROFILE%; every ancestor above them is the runner's real path. The
// runner's own PNPM_HOME, if any, is dropped so pnpm's default applies.
function withoutPnpmHome(env: NodeJS.ProcessEnv, changes: Record<string, string>) {
	return { ...Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== "PNPM_HOME")), ...changes } as Record<string, string>;
}
test("native Windows: a weak default PNPM_HOME holding nothing makes the plan use a claimed private %USERPROFILE%\\.pnpm", { skip: nativeUnavailable }, async () => {
	const f = await ownedNativeFixture();
	try {
		const local = join(f.root, "local"); const profile = join(f.root, "profile"); mkdirSync(local); mkdirSync(profile);
		await grantEveryone(f.root, local, modifyRights);
		const env = withoutPnpmHome(process.env, { LOCALAPPDATA: local, USERPROFILE: profile });
		const own = join(profile, ".pnpm");
		const decided = windowsModule.windowsWizardEnvironment({ env });
		assert.equal(decided.pnpmHome.source, "private", JSON.stringify(decided.pnpmHome));
		assert.equal(decided.pnpmHome.path, own);
		assert.deepEqual([decided.pnpmHome.rejected.path, decided.pnpmHome.rejected.check, decided.pnpmHome.rejected.sid, decided.pnpmHome.rejected.rights],
			[join(local, "pnpm"), "target-acl-mask", "S-1-1-0", "0x001301BF"]);
		assert.equal(decided.env.PNPM_HOME, own);
		const plan = planPreflight({ platform: "win32", arch: "x64", node: { available: false }, pnpm: { available: false }, pi: { available: false }, shell: { available: false },
			gentleAi: { available: false }, go: { available: true, version: "1.26.0", usable: true }, globalBin: { available: true, path: join(own, "bin"), writable: true, onPath: false },
			setup: false, pnpmHome: decided.pnpmHome });
		assert.deepEqual([plan.blockers, plan.tools.pnpmHome.status, plan.tools.pnpmHome.path], [[], "private", own]);
		assert.equal(existsSync(own), false, "nothing is created before consent");
		// After consent: claimed with the protected DACL and owned by the user (the walk passes), then kept.
		assert.equal(windowsModule.ensureWindowsPnpmHome(own, env), "claimed");
		// Its tmp folder (the children's TEMP/TMP) exists and, inheriting the DACL, passed the same walk.
		assert.equal(existsSync(join(own, "tmp")), true);
		verifyWindowsStorage(own, env);
		assert.equal(readFileSync(join(own, ".gentle-shell-pnpm-home"), "utf8"), "gentle-pi private pnpm home");
		mkdirSync(join(own, "bin"));
		assert.equal(windowsModule.ensureWindowsPnpmHome(own, env), "kept");
		assert.equal(windowsModule.windowsPnpmHome({ env }).source, "private", "the folder this flow created is accepted again");
		// A foreign non-empty folder is never adopted.
		const other = join(f.root, "other-profile"); mkdirSync(join(other, ".pnpm"), { recursive: true }); writeFileSync(join(other, ".pnpm", "notes.txt"), "keep");
		const foreign = windowsModule.windowsPnpmHome({ env: { ...env, USERPROFILE: other } });
		assert.equal(foreign.private?.foreign, true, JSON.stringify(foreign));
		assert.throws(() => windowsModule.ensureWindowsPnpmHome(join(other, ".pnpm"), env), (error: { check?: string }) => error.check === "foreign");
		assert.equal(readFileSync(join(other, ".pnpm", "notes.txt"), "utf8"), "keep");
	} finally { f.cleanup(); }
});

test("native Windows: a weak default PNPM_HOME that already holds files blocks and names the folder, principal and rights", { skip: nativeUnavailable }, async () => {
	const f = await ownedNativeFixture();
	try {
		const local = join(f.root, "local"); const profile = join(f.root, "profile");
		mkdirSync(join(local, "pnpm", "store"), { recursive: true }); mkdirSync(profile);
		await grantEveryone(f.root, join(local, "pnpm"), modifyRights);
		const env = withoutPnpmHome(process.env, { LOCALAPPDATA: local, USERPROFILE: profile });
		const decided = windowsModule.windowsWizardEnvironment({ env });
		assert.equal(decided.pnpmHome.installed, true, JSON.stringify(decided.pnpmHome));
		// The walk reports the component as Windows PowerShell's GetFullPath resolves it
		// (long form); the fixture's tmpdir may be an 8.3 short path such as RUNNER~1.
		assert.equal(decided.pnpmHome.path, join(local, "pnpm"), "the configured folder is kept as the user's environment spells it");
		assert.deepEqual([realpathSync.native(decided.pnpmHome.untrusted.at), decided.pnpmHome.untrusted.sid, decided.pnpmHome.untrusted.rights],
			[realpathSync.native(join(local, "pnpm")), "S-1-1-0", "0x001301BF"]);
		assert.equal(decided.env, env, "the environment is unchanged");
		const plan = planPreflight({ platform: "win32", arch: "x64", node: { available: false }, pnpm: { available: false }, pi: { available: false }, shell: { available: false },
			gentleAi: { available: false }, go: { available: false }, globalBin: { available: false }, setup: false, pnpmHome: decided.pnpmHome });
		assert.ok(plan.blockers.some((blocker: { code: string }) => blocker.code === "untrusted-pnpm-home"));
		assert.equal(existsSync(join(profile, ".pnpm")), false);
		assert.deepEqual(readdirSync(join(local, "pnpm")), ["store"], "nothing is moved or deleted");
		// A PNPM_HOME the user set is held to the same walk.
		const user = windowsModule.windowsPnpmHome({ env: { ...env, PNPM_HOME: join(local, "pnpm") } });
		assert.deepEqual([user.source, user.untrusted?.check], ["user", "target-acl-mask"]);
	} finally { f.cleanup(); }
});

test("native Windows: the wizard probe never runs a pnpm in a folder another principal may write", { skip: nativeUnavailable }, async () => {
	const f = await ownedNativeFixture();
	try {
		const tools = join(f.root, ".gentle-shell-bootstrap-tools.probe"); mkdirSync(tools);
		const entry = join(tools, "pnpm.mjs"); writeFileSync(entry, "console.log('11.1.1');\n");
		const weakBin = join(f.root, "weak-bin"); mkdirSync(weakBin);
		const exe = join(weakBin, "pnpm.exe"); copyFileSync(process.execPath, exe);
		const home = join(f.root, "home"); mkdirSync(home);
		const env = withoutPnpmHome(nativePath([weakBin, join(process.env.SystemRoot!, "System32")]),
			{ PNPM_HOME: home, GENTLE_BOOTSTRAP_TOOLS: tools, GENTLE_INSTALL_PNPM_NODE: process.execPath, GENTLE_INSTALL_PNPM_ENTRY: entry });
		const adapters = hostAdapters();
		const probe = async () => {
			const ran: string[] = [];
			const run = (command: string, args: string[], options: Parameters<typeof adapters.run>[2]) => { ran.push(command); return adapters.run(command, args, options); };
			const result = await createProbes({ platform: "win32", env, run, fs: adapters.fs }).pnpm();
			return { result, ran };
		};
		// Control: in a private folder the user's pnpm.exe is run for its version.
		const trusted = await probe();
		assert.ok(trusted.ran.some((command) => command.toLowerCase() === exe.toLowerCase()), JSON.stringify(trusted));
		await grantEveryone(f.root, weakBin, modifyRights);
		const weak = await probe();
		assert.equal(weak.ran.some((command) => command.toLowerCase() === exe.toLowerCase()), false, JSON.stringify(weak));
		assert.deepEqual(weak.result, { available: true, version: "11.1.1", usable: true, compatible: true, persistent: false });
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

// Native evidence for the Windows command shapes: what CMD itself runs is compared
// with what the installer runs with shell:false. cmd.exe appears only in these
// fixtures, with fixed arguments; production never starts it.
function nativePath(entries: string[], env: NodeJS.ProcessEnv = process.env) {
	const kept = Object.entries(env).filter(([key]) => !["path", "pathext"].includes(key.toLowerCase()));
	return { ...Object.fromEntries(kept), Path: entries.join(";"), PATHEXT: ".COM;.EXE;.BAT;.CMD" } as NodeJS.ProcessEnv;
}
function viaCmd(shim: string, env: NodeJS.ProcessEnv, cwd = parse(shim).root) {
	const cmd = join(process.env.SystemRoot!, "System32", "cmd.exe");
	return spawnSync(cmd, ["/d", "/s", "/c", `""${shim}" --version"`], { cwd, env, encoding: "utf8", timeout: 60000, killSignal: "SIGKILL", windowsHide: true, windowsVerbatimArguments: true });
}
test("native Windows: CMD runs the .cmd beside an extensionless Git Bash script, as npm, pnpm, Volta and mise lay them out", { skip: nativeUnavailable }, () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-cmd-search-")));
	try {
		const bin = join(root, "bin"); const away = join(root, "away"); mkdirSync(bin); mkdirSync(away);
		writeFileSync(join(bin, "pnpm"), gitBashScript); writeFileSync(join(bin, "pnpm.ps1"), "Write-Output ps1\n");
		writeFileSync(join(bin, "pnpm.cmd"), "@echo cmd-shim-ran\r\n");
		const env = nativePath([bin, join(process.env.SystemRoot!, "System32")]);
		const cmd = join(process.env.SystemRoot!, "System32", "cmd.exe");
		// From PATH, and from the directory itself (CMD searches the current directory first).
		for (const cwd of [away, bin]) {
			const result = spawnSync(cmd, ["/d", "/c", "pnpm"], { cwd, env, encoding: "utf8", timeout: 10000, killSignal: "SIGKILL", windowsHide: true });
			assert.equal(result.error, undefined, cwd);
			assert.equal(result.status, 0, `${cwd}: ${result.stderr}`);
			assert.equal(result.stdout.trim(), "cmd-shim-ran", cwd);
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("native Windows: Node.js's npm.cmd and an npm cmd-shim pnpm.cmd run without cmd.exe exactly what CMD runs", { skip: nativeUnavailable }, async () => {
	const adapters = hostAdapters();
	// The npm.cmd beside the Node.js running these tests (actions/setup-node's toolcache).
	const npm = await lookPath("npm", process.env, "win32", adapters.fs);
	assert.ok(npm && /\.cmd$/i.test(npm), String(npm));
	assert.ok(windowsShim(readFileSync(npm, "utf8"))?.npm, "Node.js's own npm.cmd matches a known template");
	const npmRun = await windowsInvocation(npm, process.env, adapters);
	assert.ok(npmRun && /\\node\.exe$/i.test(npmRun.command) && /\\npm-cli\.js$/i.test(npmRun.prefix[0]), JSON.stringify(npmRun));
	const direct = await adapters.run(npmRun.command, [...npmRun.prefix, "--version"], { env: process.env, cwd: parse(npmRun.command).root, deadlineMs: 60000 });
	const shell = viaCmd(npm, process.env);
	assert.equal(direct.code, 0); assert.equal(shell.status, 0, shell.stderr);
	assert.match(direct.stdout.trim(), /^\d+\.\d+\.\d+$/);
	assert.equal(direct.stdout.trim(), shell.stdout.trim(), "the redirect-aware invocation runs the npm CMD runs");
	// npm's global pnpm: the cmd-shim beside its Git Bash script, Node from PATH.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-shim-run-")));
	try {
		const bin = join(root, "npm"); const packageDir = join(bin, "node_modules/pnpm");
		mkdirSync(join(packageDir, "bin"), { recursive: true });
		writeFileSync(join(bin, "pnpm.cmd"), wrapper("node_modules\\pnpm\\bin\\pnpm.mjs")); writeFileSync(join(bin, "pnpm"), gitBashScript);
		writeFileSync(join(packageDir, "package.json"), JSON.stringify(pinnedPackage));
		writeFileSync(join(packageDir, "bin/pnpm.mjs"), "const [first] = process.argv.slice(2); console.log(first === '--version' ? '11.1.1' : '--global');\n");
		const env = nativePath([bin, dirname(process.execPath), join(process.env.SystemRoot!, "System32")]);
		const shim = join(bin, "pnpm.cmd");
		const pnpmRun = await windowsInvocation(shim, env, adapters);
		assert.deepEqual(pnpmRun, { command: join(dirname(process.execPath), "node.exe"), prefix: [join(packageDir, "bin", "pnpm.mjs")] });
		const ran = await adapters.run(pnpmRun!.command, [...pnpmRun!.prefix, "--version"], { env, deadlineMs: 60000 });
		const cmdRan = viaCmd(shim, env);
		assert.equal(cmdRan.status, 0, cmdRan.stderr);
		assert.deepEqual([ran.code, ran.stdout.trim()], [0, cmdRan.stdout.trim()]);
		// The bootstrap's discovery reaches the same pnpm through its real process adapter.
		const tools = join(root, "tools"); mkdirSync(tools);
		const reused = await ensureWindowsPnpm({ tools, env, adapters: { storage: () => {} } });
		assert.deepEqual([reused.acquired, reused.command.toLowerCase(), reused.prefix], [false, join(dirname(process.execPath), "node.exe").toLowerCase(), [join(packageDir, "bin", "pnpm.mjs")]]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

// S8: `gentle-shell upgrade` (and the wizard's update) on a real Windows host.
test("native Windows: the upgrade's invocation runs the real npm without cmd.exe, exactly as CMD runs it", { skip: nativeUnavailable }, async () => {
	const adapters = hostAdapters();
	const invoke = upgradeInvocation({ platform: "win32", env: process.env, ...adapters });
	const npm = await invoke!("npm");
	assert.ok(npm && /\.exe$/i.test(npm.command), JSON.stringify(npm));
	const direct = await adapters.run(npm.command, [...npm.prefix, "--version"], { env: process.env, cwd: parse(npm.command).root, deadlineMs: 60000 });
	const shell = viaCmd((await lookPath("npm", process.env, "win32", adapters.fs))!, process.env);
	assert.deepEqual([direct.code, shell.status], [0, 0], shell.stderr);
	assert.equal(direct.stdout.trim(), shell.stdout.trim());
	// A pnpm.cmd from Corepack, or none at all, is never run: no invocation.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-upgrade-run-")));
	try {
		mkdirSync(join(root, "node_modules", "corepack", "dist"), { recursive: true });
		writeFileSync(join(root, "pnpm.cmd"), corepackShims[0]); writeFileSync(join(root, "node_modules", "corepack", "dist", "pnpm.js"), "process.exit(9)\n");
		const env = nativePath([root, dirname(process.execPath), join(process.env.SystemRoot!, "System32")]);
		assert.equal(await upgradeInvocation({ platform: "win32", env, ...adapters })!("pnpm"), null);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

// S6 notice on a real Windows host: one Windows PowerShell launch, real ACLs.
test("native Windows: one Windows PowerShell launch walks every reused tool path and names each folder another account can change", { skip: nativeUnavailable }, async () => {
	const f = await ownedNativeFixture();
	try {
		const safe = join(f.root, "safe"); const weak = join(f.root, "weak"); mkdirSync(safe); mkdirSync(weak);
		writeFileSync(join(safe, "node.exe"), "not executed fixture"); writeFileSync(join(weak, "go.exe"), "not executed fixture");
		await grantEveryone(f.root, weak, modifyRights);
		const launches: string[] = [];
		const processAdapter = (command: string, args: string[], env: NodeJS.ProcessEnv) => { launches.push(command); return windowsProcessCheck(command, args, env); };
		const results = windowsModule.verifyWindowsStorageMany([join(safe, "node.exe"), join(weak, "go.exe"), join(f.root, "missing", "pi.cmd")], process.env, { processAdapter });
		assert.equal(launches.length, 1);
		assert.equal(results[0], null);
		assert.deepEqual([results[1]?.check, realpathSync.native(results[1]!.at!), results[1]?.sid, results[1]?.rights], ["parent-acl-mask", realpathSync.native(weak), "S-1-1-0", "0x001301BF"]);
		assert.deepEqual(results[2], { check: "unchecked", at: join(f.root, "missing", "pi.cmd") }, "a path whose walk cannot finish could not be checked");
		// The single-path walk agrees on both.
		verifyWindowsStorage(join(safe, "node.exe"), process.env);
		assert.throws(() => verifyWindowsStorage(join(weak, "go.exe"), process.env), (error: { check?: string }) => error.check === "parent-acl-mask");
		// The wizard's probe reaches the same finding for the Go on the user's PATH.
		const adapters = hostAdapters();
		const env = withoutPnpmHome(nativePath([safe, weak, join(process.env.SystemRoot!, "System32")]), {});
		const folders = await createProbes({ platform: "win32", env, run: adapters.run, fs: adapters.fs }).folders();
		assert.deepEqual(Object.keys(folders ?? {}), ["go"], JSON.stringify(folders));
		assert.equal(folders.go.check, "parent-acl-mask");
	} finally { f.cleanup(); }
});

// S6 notice, B2: a tool reached through a junction (pnpm's global node_modules link)
// is walked where it really is; the junction itself is never a finding.
test("native Windows: the reused-folder walk follows a junction to the real folder and reports only a weak real folder", { skip: nativeUnavailable }, async (t) => {
	const f = await ownedNativeFixture();
	try {
		const real = join(f.root, "store", "go"); mkdirSync(real, { recursive: true });
		writeFileSync(join(real, "go.exe"), "not executed fixture");
		const link = join(f.root, "linked-go");
		try { symlinkSync(real, link, "junction"); }
		catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (["EPERM", "EACCES", "ENOTSUP"].includes(code ?? "")) { t.skip(`owned junction creation capability unavailable: ${code}`); return; }
			throw error;
		}
		// Control: the unresolved path stops at the junction, as the single-path walk does.
		assert.throws(() => verifyWindowsStorage(join(link, "go.exe"), process.env), (error: { check?: string }) => error.check === "parent-reparse");
		const adapters = hostAdapters();
		const env = withoutPnpmHome(nativePath([link, join(process.env.SystemRoot!, "System32")]), {});
		const probe = () => createProbes({ platform: "win32", env, run: adapters.run, fs: adapters.fs }).folders();
		assert.equal(await probe(), null, "the junction is not a finding");
		await grantEveryone(f.root, join(f.root, "store"), modifyRights);
		const weak = await probe();
		assert.equal(weak?.go?.check, "ancestor-acl-mask", JSON.stringify(weak));
		assert.equal(realpathSync.native(weak.go.at!), realpathSync.native(join(f.root, "store")));
	} finally { f.cleanup(); }
});

test("native Windows: the production probe leaves an older stable user Node for the pinned one and still refuses unknown or acquired versions", { skip: nativeUnavailable }, async () => {
	for (const [version, stem, status, kept, reason] of [
		["v20.0.0", false, 0, false, ""], ["v24.21.0", false, 0, true, ""],
		["v20.0.0-rc.1", false, 1, true, "version-format"], ["v20.0.0", true, 1, true, "acquired-version"],
	] as const) {
		const f = await ownedNativeFixture();
		try {
			const env = nativeEnv(f.root); mkdirSync(env.GENTLE_BOOTSTRAP_TOOLS);
			const record = join(env.GENTLE_BOOTSTRAP_TOOLS, ".node-target"); writeFileSync(record, process.execPath);
			if (stem) writeFileSync(join(env.GENTLE_BOOTSTRAP_TOOLS, ".node-stem"), "node-v24.21.0-win-x64");
			writeFileSync(join(f.root, "package.json"), JSON.stringify({ engines: { node: ">=24.3.0" } }));
			const probe = join(f.root, "probe.mjs"); writeFileSync(probe, `console.log(${JSON.stringify(version)});\n`);
			const result = await nativeCmd(f.root, [processPrimitive()], { ...env, GENTLE_FIXTURE_NODE: process.execPath, GENTLE_FIXTURE_PROBE: probe });
			assertNative(result, status);
			assert.equal(existsSync(record), kept, `${version} stem=${stem}`);
			if (reason) assert.ok(result.stderr.includes(`${probeMessage} Reason: ${reason}`), result.stderr.slice(0, 4000));
		} finally { f.cleanup(); }
	}
});

test("native Windows: the production probe never runs a user Node behind a junction and leaves it for the pinned one", { skip: nativeUnavailable }, async (t) => {
	const f = await ownedNativeFixture();
	try {
		const env = nativeEnv(f.root); mkdirSync(env.GENTLE_BOOTSTRAP_TOOLS);
		writeFileSync(join(f.root, "package.json"), JSON.stringify({ engines: { node: ">=24.3.0" } }));
		const real = join(f.root, "real-node"); mkdirSync(real); copyFileSync(process.execPath, join(real, "node.exe"));
		const linked = join(f.root, "linked-node");
		try { symlinkSync(real, linked, "junction"); }
		catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (["EPERM", "EACCES", "ENOTSUP"].includes(code ?? "")) { t.skip(`owned junction creation capability unavailable: ${code}`); return; }
			throw error;
		}
		const record = join(env.GENTLE_BOOTSTRAP_TOOLS, ".node-target");
		const stage = cmdStage(stageMarkers.probe);
		// The same current Node in a real directory is trusted, run and kept.
		writeFileSync(record, join(real, "node.exe"));
		assertNative(await nativeCmd(f.root, [stage], env), 0);
		assert.equal(readFileSync(record, "utf8"), join(real, "node.exe"));
		// Behind the junction it is rejected before it runs: the record goes, nothing fails.
		rmSync(record); writeFileSync(record, join(linked, "node.exe"));
		const untrusted = await nativeCmd(f.root, [stage], env);
		assertNative(untrusted, 0);
		assert.equal(existsSync(record), false, "a current version would have kept the record had it run");
		// The acquired Node is held to every check: behind a junction it refuses.
		writeFileSync(record, join(linked, "node.exe")); writeFileSync(join(env.GENTLE_BOOTSTRAP_TOOLS, ".node-stem"), "node-v24.21.0-win-x64");
		const acquired = await nativeCmd(f.root, [stage], env);
		assertNative(acquired, 1);
		assert.ok(acquired.stderr.includes(`${probeMessage} Reason: parent-reparse`), acquired.stderr.slice(0, 4000));
		assert.equal(existsSync(record), true);
	} finally { f.cleanup(); }
});

// Run 38061123855: with Git for Windows' usr\bin first on PATH, a bare `tar` is MSYS tar,
// which reads `D:\...` as a remote host ("Cannot connect to D: resolve failed").
test("native Windows: the main channel extracts its source with System32's tar.exe even with Git's usr\\bin first on PATH", { skip: nativeUnavailable }, async () => {
	const gitUsrBin = "C:\\Program Files\\Git\\usr\\bin";
	assert.ok(existsSync(join(gitUsrBin, "tar.exe")), "the runner image ships Git for Windows' MSYS tar");
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-main-tar-")));
	try {
		const commit = "6e7e3a18f794223396527a54c7c36d19c7d236c6";
		const stage = join(root, "stage"); mkdirSync(join(stage, `gentle-shell-${commit}`), { recursive: true });
		writeFileSync(join(stage, `gentle-shell-${commit}`, "package.json"), JSON.stringify({ name: "gentle-pi", version: "4.0.0" }));
		const archive = join(root, "source.tgz");
		const created = spawnSync(join(process.env.SystemRoot!, "System32", "tar.exe"), ["-czf", archive, "-C", stage, `gentle-shell-${commit}`], { encoding: "utf8", windowsHide: true });
		assert.equal(created.status, 0, created.stderr);
		const env = nativePath([gitUsrBin, dirname(process.execPath), join(process.env.SystemRoot!, "System32"), process.env.SystemRoot!]);
		const host = hostAdapters();
		assert.equal((await lookPath("tar", env, "win32", host.fs))?.toLowerCase(), join(gitUsrBin, "tar.exe").toLowerCase(), "a bare tar resolves to MSYS tar");
		const extracted: string[] = [];
		const run = async (command: string, argv: string[], options: { cwd?: string; deadlineMs: number }) => {
			if (argv[0] !== "pack") {
				extracted.push(command);
				return host.run(command, argv, { env, cwd: options.cwd, deadlineMs: options.deadlineMs, stderrTail: 4096 });
			}
			// pnpm pack is not under test: the extracted, rewritten manifest is enough.
			const manifest = JSON.parse(readFileSync(join(options.cwd!, "package.json"), "utf8"));
			writeFileSync(join(argv[argv.indexOf("--pack-destination") + 1], `gentle-pi-${manifest.version}.tgz`), "tgz");
			return { code: 0, stdout: "" };
		};
		const bytes = readFileSync(archive);
		const fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
		const { packMainShell } = await import("../scripts/main-channel.mjs");
		const tgz = await packMainShell({ commit, ctx: { env: { GENTLE_PI_CONFIG_HOME: join(root, "config") }, home: root }, fetch, run,
			pnpm: { command: "pnpm", prefix: [] }, fs: await import("node:fs/promises"), platform: "win32" });
		assert.equal(tgz, join(root, "config", "main", "packages", "gentle-pi-4.0.0-main.6e7e3a18f794.tgz"));
		assert.deepEqual(extracted, [join(process.env.SystemRoot!, "System32", "tar.exe")]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

// Run 38063142924: from a 179-character package root (a pnpm 11 store path) Go's asm.exe failed
// with "The directory name is invalid." while building inside the package. The real source
// build (network: proxy.golang.org and sum.golang.org) from a root deeper than 200 characters.
test("native Windows: the pinned Go downloads from go.dev, verifies and runs", { skip: nativeUnavailable }, async () => {
	// The real transport: dl.google.com gzips archives unless identity is requested.
	const root = mkdtempSync(join(tmpdir(), "gentle pinned go "));
	try {
		const result = await acquireGo({ root, platform: "win32", arch: process.arch });
		assert.equal(result.acquired, true);
		assert.equal(installedGo(root, "win32", process.arch), result.goPath);
		const version = spawnSync(result.goPath, ["version"], { encoding: "utf8", env: { ...process.env, GOTOOLCHAIN: "local" } });
		assert.equal(version.status, 0, version.stderr);
		assert.match(version.stdout.trim(), new RegExp(`^go version go${result.version} windows/`));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("native Windows: the Gentle AI source build succeeds from a package root deeper than 200 characters", { skip: nativeUnavailable }, async (t) => {
	const installer = await import("../scripts/gentle-ai-installer.mjs");
	const where = spawnSync(join(process.env.SystemRoot!, "System32", "where.exe"), ["go.exe"], { encoding: "utf8", windowsHide: true });
	const go = where.status === 0 ? where.stdout.split(/\r?\n/)[0].trim() : "";
	const version = go ? /go version (go\d+\.\d+\.\d+) /.exec(spawnSync(go, ["version"], { encoding: "utf8", windowsHide: true }).stdout ?? "")?.[1] : undefined;
	if (!version || !installer.isGentleAiWindowsGoVersionSupported(version)) {
		t.skip(`Go ${installer.GENTLE_AI_WINDOWS_MINIMUM_GO_VERSION} or newer is not on PATH (found ${version ?? "none"})`);
		return;
	}
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-deep-root-")));
	try {
		let packageRoot = root;
		while (packageRoot.length <= 200) packageRoot = join(packageRoot, "nested-package-store-segment");
		mkdirSync(packageRoot, { recursive: true });
		const temporaryDirectory = join(root, "t"); mkdirSync(temporaryDirectory);
		const result = await installer.installGentleAi({ packageRoot, platform: "win32", arch: process.arch, temporaryDirectory });
		assert.equal(result.installed, true);
		assert.equal(result.binaryPath, join(packageRoot, ".gentle-ai", `v${installer.INSTALLER_VERSION}`, "gentle-ai.exe"));
		assert.ok(existsSync(result.binaryPath));
		assert.deepEqual(readdirSync(temporaryDirectory), [], "the short build directory is removed");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

// Bundled install (S2, S3, S6) on a real Windows host. The pinned Node and pnpm
// are downloaded once per run (verifiedDownload still checks every byte against
// the pins); local fixture packages stand in for the registry.
const bundledDownloads = new Map<string, Promise<Buffer>>();
function bundledDownload(descriptor: { url: string }) {
	if (!bundledDownloads.has(descriptor.url)) {
		bundledDownloads.set(descriptor.url, fetch(descriptor.url, { redirect: "error", signal: AbortSignal.timeout(180000) }).then(async (response) => {
			if (!response.ok) throw new Error(`Download failed: ${response.status}`);
			return Buffer.from(await response.arrayBuffer());
		}));
	}
	return bundledDownloads.get(descriptor.url)!;
}
const bundledManifest = { shell: "4.1.0", pi: "1.0.2" };
/** A bundled prefix in a plain fixture folder standing in for %LOCALAPPDATA%: the
 * claim itself is native-tested separately, so here it only creates the folder. */
function bundledPrefix(root: string) {
	const local = join(root, "local"); const roaming = join(root, "roaming"); const profile = join(root, "profile");
	for (const folder of [local, roaming, profile]) mkdirSync(folder);
	const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:pnpm_home|localappdata|appdata|userprofile|home)$/i.test(key))),
		LOCALAPPDATA: local, APPDATA: roaming, USERPROFILE: profile, HOME: profile } as Record<string, string>;
	const layout = bundled.claimPrefix({ platform: "win32", env, home: profile, adapters: { storage: () => {}, claim: (folder: string) => { mkdirSync(folder); return "claimed"; } } });
	// installVersion requires the pinned Go on Windows; the fixture packages never run it.
	const go = join(layout.goRoot, "1.25.14", "go", "bin", "go.exe");
	mkdirSync(dirname(go), { recursive: true });
	writeFileSync(go, "");
	return { local, profile, env, layout, go };
}
function bundledLinks(folder: string): string[] {
	return readdirSync(folder).flatMap((name) => {
		const path = join(folder, name);
		const info = lstatSync(path);
		return info.isSymbolicLink() ? [path] : info.isDirectory() ? bundledLinks(path) : [];
	});
}
const insideFolder = (folder: string, path: string) => path.toLowerCase().startsWith(`${folder.toLowerCase()}\\`);

test("native Windows: a bundled version installs in place with the real pinned pnpm, every link resolves inside versions\\<id>, and the launcher runs it", { skip: nativeUnavailable }, async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle bundled ")));
	try {
		const { env, layout, go } = bundledPrefix(root);
		await bundled.ensureRuntime({ layout, platform: "win32", arch: process.arch, env, adapters: { download: bundledDownload } });
		const packages = join(layout.root, "packages"); mkdirSync(packages);
		writeFileSync(join(packages, "gentle-pi.tgz"), tarFixture({
			"package/package.json": JSON.stringify({ name: "gentle-pi", version: bundledManifest.shell, type: "module", scripts: { postinstall: "node postinstall.mjs" } }),
			"package/postinstall.mjs": "import { writeFileSync } from \"node:fs\";\nwriteFileSync(\"postinstall.txt\", process.execPath);\n",
			"package/bin/gentle-shell.mjs": "console.log(JSON.stringify({ execPath: process.execPath, args: process.argv.slice(2) }));\nprocess.exitCode = Number(process.argv[2]);\n",
		}));
		writeFileSync(join(packages, "pi.tgz"), tarFixture({ "package/package.json": JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: bundledManifest.pi }) }));
		// Both project folders sit two levels under the prefix, so the lockfile's relative file: paths match.
		const files = { "package.json": JSON.stringify({ name: "gentle-shell-distribution", version: bundledManifest.shell, private: true,
			dependencies: { "gentle-pi": "file:../../packages/gentle-pi.tgz", "@earendil-works/pi-coding-agent": "file:../../packages/pi.tgz" } }),
			"pnpm-workspace.yaml": bundled.distributionFiles(bundledManifest)["pnpm-workspace.yaml"] };
		const resolve = join(layout.root, "lockfile", "4.1.0-1.0.2"); mkdirSync(resolve, { recursive: true });
		for (const [name, text] of Object.entries(files)) writeFileSync(join(resolve, name), text);
		const childEnv = bundled.pnpmEnvironment(layout, { platform: "win32", env, go });
		const lock = spawnSync(layout.node, [layout.pnpm, "install", "--lockfile-only"], { cwd: resolve, env: childEnv, encoding: "utf8", timeout: 300000, windowsHide: true });
		assert.equal(lock.status, 0, lock.stderr + lock.stdout);
		const result = await bundled.installVersion({ layout, manifest: bundledManifest, lockfile: readFileSync(join(resolve, "pnpm-lock.yaml"), "utf8"), env, go,
			adapters: { distribution: () => files } });
		assert.deepEqual(result, { id: "4.1.0-1.0.2", path: join(layout.versions, "4.1.0-1.0.2"), installed: true });
		const version = realpathSync.native(result.path);
		const links = bundledLinks(join(result.path, "node_modules"));
		assert.ok(links.length > 0, "pnpm linked the packages");
		for (const link of links) assert.ok(insideFolder(version, realpathSync.native(link)), `${link} resolves inside the version folder`);
		// The build script ran with our Node, first on PATH (long names compared: the temp folder may be 8.3).
		const ourNode = realpathSync.native(layout.node).toLowerCase();
		assert.equal(realpathSync.native(readFileSync(join(result.path, "node_modules", "gentle-pi", "postinstall.txt"), "utf8")).toLowerCase(), ourNode);
		bundled.activateVersion(layout, result.id);
		bundled.ensureLauncher(layout);
		const cmd = join(process.env.SystemRoot!, "System32", "cmd.exe");
		const run = spawnSync(cmd, ["/d", "/s", "/c", `""${layout.launcher}" 0 "a b""`], { env, encoding: "utf8", timeout: 60000, windowsHide: true, windowsVerbatimArguments: true });
		assert.equal(run.status, 0, run.stderr);
		const output = JSON.parse(run.stdout);
		assert.deepEqual([realpathSync.native(output.execPath).toLowerCase(), output.args], [ourNode, ["0", "a b"]]);
		// Pi installs its packages with `npm`: setup's PATH finds the npm.cmd from the same Node archive, which runs our node.exe
		// (its global prefix is inside the bundled prefix, so npm.cmd never switches to a user's global npm).
		const setupEnv = bundled.setupEnvironment(layout, { platform: "win32", env, id: result.id });
		const npm = spawnSync(cmd, ["/d", "/s", "/c", "\"npm --version\""], { cwd: layout.root, env: setupEnv, encoding: "utf8", timeout: 60000, windowsHide: true,
			windowsVerbatimArguments: true });
		assert.equal(npm.status, 0, npm.stderr);
		assert.equal(npm.stdout.trim(), JSON.parse(readFileSync(join(layout.nodeDir, "node_modules", "npm", "package.json"), "utf8")).version);
		assert.equal(existsSync(join(layout.nodeDir, "npm.cmd")), true);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

// The bundled install's single Windows PATH change: the HKCU user Path, edited in
// place on this runner and restored byte for byte afterwards.
test("native Windows: the bundled user Path entry is added once with the value kind kept, every other entry kept, and removed again", { skip: nativeUnavailable }, () => {
	const powershell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const userPath = (script: string, data: Record<string, string> = {}) => {
		const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, ...data }, encoding: "utf8",
			timeout: 60000, windowsHide: true });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	const read = () => userPath("$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); if ($k.GetValueNames() -contains 'Path') { " +
		"[string]$k.GetValueKind('Path') + '|' + [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { 'absent|' }");
	const before = read();
	const [kind, value] = [before.slice(0, before.indexOf("|")), before.slice(before.indexOf("|") + 1)];
	const parts = value.split(";").filter(Boolean);
	const entry = join(realpathSync(tmpdir()), "gentle bundled path", "bin");
	const registry = windowsPathRegistry(process.env as Record<string, string>);
	try {
		registry.add(entry);
		const added = read();
		assert.equal(added, `${kind === "absent" ? "ExpandString" : kind}|${[...parts, entry].join(";")}`);
		// Never twice, whatever its case or trailing backslash.
		registry.add(`${entry.toUpperCase()}\\`);
		assert.equal(read(), added);
		registry.remove(entry);
		assert.equal(read(), `${kind === "absent" ? "ExpandString" : kind}|${parts.join(";")}`);
	} finally {
		userPath("$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); if ($env:GENTLE_TEST_KIND -eq 'absent') { $k.DeleteValue('Path', $false) } " +
			"else { $k.SetValue('Path', $env:GENTLE_TEST_VALUE, [Microsoft.Win32.RegistryValueKind]$env:GENTLE_TEST_KIND) }; $k.Close()", { GENTLE_TEST_KIND: kind, GENTLE_TEST_VALUE: value });
	}
	assert.equal(read(), before);
});

test("native Windows: the bundled .cmd launcher runs from a path holding spaces and & % ^ ( ! , passes the exit code, and names a missing version", { skip: nativeUnavailable }, async () => {
	const f = nativeFixture();
	try {
		const profile = join(f.root, "profile"); mkdirSync(profile);
		const layout = bundled.prefixLayout({ platform: "win32", env: {}, home: profile, root: join(f.root, "a^b,c (d) !e %f%", "gentle-shell") });
		for (const folder of [layout.versions, layout.bin, dirname(layout.node)]) mkdirSync(folder, { recursive: true });
		copyFileSync(process.execPath, layout.node);
		const go = join(layout.goRoot, "1.25.14", "go", "bin", "go.exe");
		mkdirSync(dirname(go), { recursive: true }); writeFileSync(go, "");
		const run = (_command: string, _args: string[], { cwd }: { cwd: string }) => {
			const shell = join(cwd, "node_modules", "gentle-pi"); const pi = join(cwd, "node_modules", "@earendil-works", "pi-coding-agent");
			mkdirSync(join(shell, "bin"), { recursive: true }); mkdirSync(pi, { recursive: true });
			writeFileSync(join(shell, "package.json"), JSON.stringify({ name: "gentle-pi", version: bundledManifest.shell }));
			writeFileSync(join(shell, "bin", "gentle-shell.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));\nprocess.exitCode = Number(process.argv[2]);\n");
			writeFileSync(join(pi, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: bundledManifest.pi }));
			return { status: 0, stdout: "", stderr: "" };
		};
		const { id } = await bundled.installVersion({ layout, manifest: bundledManifest, lockfile: "x", env: {}, go, adapters: { run } });
		bundled.ensureLauncher(layout);
		// Run by name through PATH, as a terminal does.
		const env = nativePath([layout.bin, join(process.env.SystemRoot!, "System32")]);
		const cmd = join(process.env.SystemRoot!, "System32", "cmd.exe");
		const launch = () => spawnSync(cmd, ["/d", "/c", "gentle-shell 7 \"x & y\" 100%"], { env, encoding: "utf8", timeout: 60000, windowsHide: true, windowsVerbatimArguments: true });
		const missing = "gentle-shell: no active Gentle Shell version; run the Gentle Shell installer again.";
		const none = launch();
		assert.deepEqual([none.status, none.stderr.trim(), none.stdout], [1, missing, ""]);
		bundled.activateVersion(layout, id);
		const ran = launch();
		assert.deepEqual([ran.status, JSON.parse(ran.stdout)], [7, ["7", "x & y", "100%"]], ran.stderr);
		writeFileSync(layout.current, "9.9.9-9.9.9\n");
		const gone = launch();
		assert.deepEqual([gone.status, gone.stderr.trim()], [1, missing]);
	} finally { f.cleanup(); }
});

test("native Windows: the bundled prefix claim creates, adopts an empty folder, keeps a marked one, and never adopts a foreign folder or a reparse point", { skip: nativeUnavailable }, async (t) => {
	const f = await ownedNativeFixture();
	try {
		const local = join(f.root, "local"); const profile = join(f.root, "profile"); mkdirSync(local); mkdirSync(profile);
		const env = withoutPnpmHome(process.env, { LOCALAPPDATA: local, USERPROFILE: profile });
		const layout = bundled.claimPrefix({ platform: "win32", env, home: profile });
		assert.equal(layout.root, join(local, "gentle-shell"));
		verifyWindowsStorage(layout.root, env);
		assert.equal(readFileSync(join(layout.root, ".gentle-shell-bundle"), "utf8"), "gentle-shell bundled install");
		for (const folder of [layout.runtime, layout.store, layout.versions, layout.bin, layout.tmp]) assert.equal(existsSync(folder), true, folder);
		assert.equal(bundled.claimPrefix({ platform: "win32", env, home: profile }).root, layout.root, "a marked prefix is kept");
		const claim = (folder: string) => windowsModule.ensureWindowsPrivateFolder(folder, env, { marker: ".gentle-shell-bundle", text: "gentle-shell bundled install" });
		assert.equal(claim(layout.root), "kept");
		const empty = join(f.root, "empty"); mkdirSync(empty);
		assert.equal(claim(empty), "claimed");
		const foreign = join(f.root, "foreign"); mkdirSync(foreign); writeFileSync(join(foreign, "notes.txt"), "keep");
		assert.throws(() => claim(foreign), (error: { check?: string }) => error.check === "foreign");
		assert.deepEqual(readdirSync(foreign), ["notes.txt"]);
		const target = join(f.root, "junction-target"); mkdirSync(target);
		const junction = join(f.root, "junction");
		try { symlinkSync(target, junction, "junction"); }
		catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (["EPERM", "EACCES", "ENOTSUP"].includes(code ?? "")) { t.skip(`owned junction creation capability unavailable: ${code}`); return; }
			throw error;
		}
		assert.throws(() => claim(junction), (error: { check?: string }) => error.check === "foreign");
		assert.deepEqual(readdirSync(target), [], "nothing is written through the junction");
	} finally { f.cleanup(); }
});

test("native Windows: the bundled pnpm keeps its store, cache and state in the prefix and writes nothing under %LOCALAPPDATA%\\pnpm or the profile", { skip: nativeUnavailable }, async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle bundled ")));
	try {
		const { local, profile, env, layout } = bundledPrefix(root);
		await bundled.ensureRuntime({ layout, platform: "win32", arch: process.arch, env, adapters: { download: bundledDownload } });
		const childEnv = bundled.pnpmEnvironment(layout, { platform: "win32", env });
		const pnpm = (...args: string[]) => {
			const result = spawnSync(layout.node, [layout.pnpm, ...args], { cwd: layout.versions, env: childEnv, encoding: "utf8", timeout: 120000, windowsHide: true });
			assert.equal(result.status, 0, result.stderr);
			return result.stdout.trim();
		};
		assert.equal(pnpm("--version"), "11.1.1");
		for (const [key, folder] of [["store-dir", layout.store], ["cache-dir", layout.cache], ["state-dir", layout.state]]) assert.equal(pnpm("config", "get", key), folder, key);
		assert.ok(insideFolder(layout.store, pnpm("store", "path")), "the resolved store is inside the prefix");
		assert.deepEqual(readdirSync(local).filter((name) => /pnpm/i.test(name)), []);
		assert.deepEqual(readdirSync(profile).filter((name) => /pnpm|npmrc/i.test(name)), []);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
