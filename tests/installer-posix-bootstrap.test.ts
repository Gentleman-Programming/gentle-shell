import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync, rmSync, lstatSync, unlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import { artifactFor, verifiedDownload, compatibleEngine, ensurePnpm, launchWizard, bootstrap, removeOwnedTools, acquireGo, installedGo } from "../scripts/installer-downloads.mjs";

const script = resolve("scripts/bootstrap.sh");
const helper = resolve("scripts/installer-downloads.mjs");
const node = process.execPath;
// Shell and private-tools fixtures need POSIX sh, stock utilities and uids.
const posixHost = process.platform === "win32" ? "POSIX shell bootstrap fixtures need a POSIX host" : false;
const posixTest = (name: string, fn: (t: TestContext) => void | Promise<void>) => test(name, { skip: posixHost }, fn);
// macOS keeps several stock utilities only in /bin.
const systemUtility = (name: string) => ["/usr/bin", "/bin"].map((dir) => join(dir, name)).find((path) => existsSync(path)) ?? `/usr/bin/${name}`;
function fixture() {
	// The bootstrap refuses symlinked HOME ancestors, such as macOS /var -> /private/var.
	const root = mkdtempSync(join(realpathSync(tmpdir()), "bootstrap space ü-"));
	const bin = join(root, "utilities");
	const home = join(root, "home ü");
	const bundle = join(root, "bundle ü");
	for (const dir of [bin, home, join(bundle, "scripts"), join(bundle, "bin")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(join(bundle, "scripts/bootstrap.sh"), readFileSync(script));
	writeFileSync(join(bundle, "scripts/installer-downloads.mjs"), readFileSync(helper));
	writeFileSync(join(bundle, "package.json"), JSON.stringify({ engines: { node: ">=22.19.0" }, packageManager: "pnpm@11.1.1" }));
	for (const name of ["dirname", "pwd", "awk", "mkdir", "mktemp", "chmod", "mv", "rm", "sleep", "wc", "cat", "id", "ls"])
		symlinkSync(systemUtility(name), join(bin, name));
	const executable = (name: string, body: string) => {
		const path = join(bin, name);
		if (existsSync(path) && lstatSync(path).isSymbolicLink()) unlinkSync(path);
		writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	};
	executable("uname", 'case "$1" in -s) printf "%s\\n" "${FAKE_OS:-Linux}";; -m) printf "%s\\n" "${FAKE_ARCH:-x86_64}";; esac');
	executable("getconf", 'printf "%s\\n" "${FAKE_LIBC:-glibc 2.36}"');
	executable("curl", 'while [ "$#" -gt 0 ]; do if [ "$1" = "--output" ]; then shift; out=$1; fi; shift; done\nprintf archive > "$out"\nexit "${DOWNLOAD_STATUS:-0}"');
	executable("sha256sum", 'printf "%s  archive\\n" "${FAKE_HASH:-6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff}"');
	const nodeBody = `#!/bin/sh\nif [ "$1" = --version ]; then\nif [ -n "\${NODE_PROBE_SCRIPT:-}" ]; then exec '${node}' "$NODE_PROBE_SCRIPT"; fi\nprintf '%s\\n' "\${NODE_VERSION:-v24.21.0}"; else exec '${node}' "$@"; fi\n`;
	executable("tar", `if [ "$1" = -tzf ]; then printf '%s\\n' "$3"; elif [ "$1" = -tvzf ]; then printf '%s\\n' '-rwxr-xr-x node'; else\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -C ]; then shift; target=$1; fi; member=$1; shift; done\nmkdir -p "$target/\${member%/node}"\ncat > "$target/$member" <<'NODE'\n${nodeBody}NODE\nchmod 700 "$target/$member"\nfi`);
	const addNode = () => writeFileSync(join(bin, "node"), nodeBody, { mode: 0o755 });
	// "symlink" mimics a package-manager link; "shim" mimics the regular cmd-shim
	// file pnpm 11 writes when it installs itself (target only in a comment).
	const addPnpm = (version = "11.1.1", engine = ">=22.13.0", style: "symlink" | "shim" | "shim-without-target" = "symlink") => {
		const pkg = join(root, "pnpm package");
		mkdirSync(join(pkg, "bin"), { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pnpm", version, engines: { node: engine } }));
		writeFileSync(join(pkg, "bin/pnpm.mjs"), `#!/bin/sh\ncase "$1" in --version) echo '${version}';; help) echo ' --global '; esac\n`, { mode: 0o755 });
		const entry = join(pkg, "bin/pnpm.mjs");
		if (style === "symlink") symlinkSync(entry, join(bin, "pnpm"));
		else writeFileSync(join(bin, "pnpm"), `#!/bin/sh\nexec '${entry}' "$@"\n${style === "shim" ? `# cmd-shim-target=${entry}\n` : ""}`, { mode: 0o755 });
	};
	const wizard = () => writeFileSync(join(bundle, "bin/gentle-shell-install.mjs"), "console.log('wizard-child:' + process.env.PATH);\n");
	// A wizard that tampers with the ownership marker of the tools it runs from.
	const markerRemovingWizard = () => writeFileSync(join(bundle, "bin/gentle-shell-install.mjs"), [
		"import { unlinkSync } from 'node:fs'; import { resolve, join } from 'node:path';",
		"const bin = process.env.PATH.split(':').find((entry) => entry.includes('.gentle-shell-bootstrap-tools.'));",
		"unlinkSync(join(resolve(bin, '../..'), '.bootstrap-owned'));", ""].join("\n"));
	const run = (extra: Record<string, string> = {}) => spawnSync("/bin/sh", [join(bundle, "scripts/bootstrap.sh")], {
		env: { PATH: bin, HOME: home, ...extra }, encoding: "utf8", timeout: 15000,
	});
	return { root, bin, home, bundle, executable, addNode, addPnpm, wizard, markerRemovingWizard, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

for (const [os, arch, target] of [["darwin", "x64", "darwin-x64"], ["darwin", "arm64", "darwin-arm64"], ["linux", "x64", "linux-x64"], ["linux", "arm64", "linux-arm64"]]) {
	test(`fixed Node descriptor for ${target}`, () => {
		const artifact = artifactFor("node", os, arch);
		assert.match(artifact.url, new RegExp(`^https://nodejs.org/dist/v24\\.21\\.0/node-v24\\.21\\.0-${target}\\.tar\\.gz$`));
		assert.match(artifact.integrity, /^sha256-[a-f0-9]{64}$/);
	});
}
test("unknown targets and caller URLs are rejected", () => {
	assert.throws(() => artifactFor("node", "linux", "ia32"), /Unsupported/);
	assert.throws(() => artifactFor("https://untrusted.example"), /Unsupported/);
});
test("engine evidence supports stable lower bounds, not guessed ranges", () => {
	assert.equal(compatibleEngine(">=22.13.0", "24.21.0"), true);
	assert.equal(compatibleEngine(">=25.0.0", "24.21.0"), false);
	assert.equal(compatibleEngine("*", "24.21.0"), false);
	assert.equal(compatibleEngine(">=22.13.0", "24.0.0-rc.1"), false);
});
test("pnpm descriptor preserves the literal upstream Node engine", () => {
	assert.equal(artifactFor("pnpm").engine, ">=22.13");
});
test("simple partial engine minima normalize only for stable version comparison", () => {
	assert.equal(compatibleEngine(">=22.13", "22.13.0"), true);
	assert.equal(compatibleEngine(">=22.13", "24.21.0"), true);
	for (const version of ["22.12.0", "22.12.99", "22.13.0-rc.1", "24.0.0-rc.1", "unknown", "22.13"]) {
		assert.equal(compatibleEngine(">=22.13", version), false, version);
	}
	for (const range of ["*", ">=22", ">=22.13 || >=24", ">=22.13 <25", "^22.13", ">=22.x", ">=22.13-rc.1", ">=022.13", ">=22.013", ">=22.13.00", ">=9007199254740992.13"]) {
		assert.equal(compatibleEngine(range, "24.21.0"), false, range);
	}
});
test("download helper fails closed on integrity, empty body and adapter failure", async () => {
	for (const download of [async () => Buffer.from("truncated"), async () => Buffer.alloc(0), async () => { throw Error("failure"); }]) {
		await assert.rejects(verifiedDownload("pnpm", { download }), /Download|integrity/);
	}
});
/** A local server that, like dl.google.com, gzips the body when the client accepts it. */
async function compressingServer(bytes: Buffer, always = false) {
	const { createServer } = await import("node:http");
	const seen: string[] = [];
	const server = createServer((request, response) => {
		const accepted = String(request.headers["accept-encoding"] ?? "");
		seen.push(accepted);
		if (always || /gzip/.test(accepted)) {
			const body = gzipSync(bytes);
			response.writeHead(200, { "content-encoding": "gzip", "content-length": String(body.length) });
			response.end(body);
		} else {
			response.writeHead(200, { "content-length": String(bytes.length) });
			response.end(bytes);
		}
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
	const { port } = server.address() as { port: number };
	return { url: `http://127.0.0.1:${port}/go.zip`, seen, close: () => new Promise((done) => server.close(done)) };
}
function localArtifact(url: string, bytes: Buffer) {
	return () => ({ url, size: bytes.length, maxBytes: bytes.length, integrity: `sha256-${createHash("sha256").update(bytes).digest("hex")}` });
}

test("the real download asks for the identity encoding, so a server that would gzip the archive sends it whole", async () => {
	const bytes = Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(4096, 7)]);
	const server = await compressingServer(bytes);
	try {
		const result = await verifiedDownload("go", { artifact: localArtifact(server.url, bytes) });
		assert.deepEqual(result, bytes);
		assert.deepEqual(server.seen, ["identity"]);
	} finally { await server.close(); }
});

test("an encoded response is refused with its cause instead of being reported as truncated", async () => {
	const bytes = Buffer.alloc(4096, 9);
	const server = await compressingServer(bytes, true);
	try {
		await assert.rejects(verifiedDownload("go", { artifact: localArtifact(server.url, bytes) }),
			(error: Error) => error.message === "Download failed" && /encoded/.test(String((error.cause as Error)?.message)));
	} finally { await server.close(); }
});

test("a failed download keeps the transport error as its cause", async () => {
	await assert.rejects(verifiedDownload("pnpm", { download: async () => { throw new Error("socket hang up"); } }),
		(error: Error) => error.message === "Download failed" && (error.cause as Error)?.message === "socket hang up");
});

test("download helper validates bytes before returning them", async () => {
	const bytes = Buffer.from("verified fixture");
	let observed = "";
	const result = await verifiedDownload("pnpm", {
		download: async (descriptor: { url: string }) => { observed = descriptor.url; return bytes; },
		digest: () => Buffer.from(artifactFor("pnpm").integrity.slice(7), "base64"),
	});
	assert.equal(result, bytes);
	assert.equal(observed, "https://registry.npmjs.org/pnpm/-/pnpm-11.1.1.tgz");
	assert.notEqual(createHash("sha512").update(bytes).digest("base64"), artifactFor("pnpm").integrity.slice(7));
});

posixTest("compatible existing tools are reused with whitespace and Unicode paths", () => {
	const f = fixture();
	try {
		f.addNode(); f.addPnpm("11.5.0"); f.wizard();
		const result = f.run();
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /wizard-child:/);
		assert.deepEqual(readdirSync(f.home), []);
	} finally { f.cleanup(); }
});
posixTest("missing wizard fails explicitly without acquiring or claiming installation", () => {
	const f = fixture();
	try {
		const result = f.run();
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /wizard entry.*missing/i);
		assert.deepEqual(readdirSync(f.home), []);
	} finally { f.cleanup(); }
});
posixTest("no initial Node acquires verified native binary and refreshes child PATH", () => {
	const f = fixture();
	try {
		f.addPnpm(); f.wizard();
		const result = f.run();
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /wizard-child:.*bootstrap-tools.*node\/bin/);
		assert.deepEqual(readdirSync(f.home), [], "successful wizard exit removes the owned tools");
	} finally { f.cleanup(); }
});
posixTest("successful exit removes only the owned tools directory", () => {
	const f = fixture();
	try {
		f.addPnpm(); f.wizard();
		mkdirSync(join(f.home, ".gentle-shell-bootstrap-tools.unrelated"));
		writeFileSync(join(f.home, ".gentle-shell-bootstrap-tools.unrelated/keep"), "preserve");
		writeFileSync(join(f.home, "unrelated.txt"), "preserve");
		const result = f.run();
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.deepEqual(readdirSync(f.home).sort(), [".gentle-shell-bootstrap-tools.unrelated", "unrelated.txt"]);
		assert.equal(readFileSync(join(f.home, ".gentle-shell-bootstrap-tools.unrelated/keep"), "utf8"), "preserve");
	} finally { f.cleanup(); }
});
posixTest("tools removal failure after success keeps exit 0 and names the path", () => {
	const f = fixture();
	try {
		f.addPnpm(); f.wizard();
		// Only removal of the tools root itself fails; staging/archive removal still works.
		f.executable("rm", `case "$2" in */.gentle-shell-bootstrap-tools.*/*) ;; */.gentle-shell-bootstrap-tools.*) exit 1;; esac\nexec ${systemUtility("rm")} "$@"`);
		const result = f.run();
		assert.equal(result.status, 0, result.stderr);
		const [tools] = readdirSync(f.home);
		assert.match(tools, /^\.gentle-shell-bootstrap-tools\./);
		assert.ok(result.stderr.includes(`temporary tools could not be removed: ${join(f.home, tools)}`), result.stderr);
	} finally { f.cleanup(); }
});
posixTest("tools whose ownership marker vanished are kept after success with a notice", () => {
	const f = fixture();
	try {
		f.addPnpm(); f.markerRemovingWizard();
		const result = f.run();
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stderr, /temporary tools could not be removed: .*\.gentle-shell-bootstrap-tools\./);
		assert.equal(readdirSync(f.home).length, 1);
	} finally { f.cleanup(); }
});
for (const extra of [{ FAKE_HASH: "0".repeat(64) }, { DOWNLOAD_STATUS: "18" }, { NODE_VERSION: "v21.0.0" }, { NODE_VERSION: "unknown" }, { FAKE_LIBC: "musl" }]) {
	posixTest(`acquisition fails closed: ${JSON.stringify(extra)}`, () => {
		const f = fixture();
		try {
			f.addPnpm(); f.wizard();
			const result = f.run(extra);
			assert.notEqual(result.status, 0);
			assert.doesNotMatch(result.stdout, /wizard-child/);
			assert.deepEqual(readdirSync(f.home), []);
		} finally { f.cleanup(); }
	});
}
for (const version of ["v24.1.0-rc.1", "v25.00.1", "banana"]) {
	posixTest(`existing Node ${version} is rejected without replacement`, () => {
		const f = fixture();
		try {
			f.addNode(); f.addPnpm(); f.wizard();
			const result = f.run({ NODE_VERSION: version });
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /Node.*incompatible|Node.*unknown/);
			assert.deepEqual(readdirSync(f.home), []);
		} finally { f.cleanup(); }
	});
}
posixTest("an older stable Node is left unchanged and a verified Node runs the helper and wizard instead", () => {
	const f = fixture();
	try {
		f.addPnpm(); f.wizard();
		const older = `#!/bin/sh\nif [ "$1" = --version ]; then echo v22.18.0; else echo user-node-ran >&2; exit 9; fi\n`;
		writeFileSync(join(f.bin, "node"), older, { mode: 0o755 });
		const result = f.run();
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /wizard-child:[^:\n]*\.gentle-shell-bootstrap-tools\.[^:\n]*\/node\/bin:/);
		assert.doesNotMatch(result.stderr, /user-node-ran/);
		assert.equal(readFileSync(join(f.bin, "node"), "utf8"), older);
		assert.deepEqual(readdirSync(f.home), [], "successful wizard exit removes the owned tools");
	} finally { f.cleanup(); }
});
posixTest("existing pnpm with unknown engine blocks instead of acquisition", () => {
	const f = fixture();
	try {
		f.addNode(); f.addPnpm("12.0.0", "*"); f.wizard();
		const result = f.run();
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /pnpm.*compatibility/i);
		assert.deepEqual(readdirSync(f.home), []);
	} finally { f.cleanup(); }
});
posixTest("existing pnpm behind a self-installed cmd-shim is reused", () => {
	const f = fixture();
	try {
		f.addNode(); f.addPnpm("11.1.1", ">=22.13.0", "shim"); f.wizard();
		const result = f.run();
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /wizard-child:/);
		assert.deepEqual(readdirSync(f.home), []);
	} finally { f.cleanup(); }
});
posixTest("pnpm version evidence ignores the packageManager pin of the bundle it runs from", () => {
	const f = fixture();
	try {
		f.addNode(); f.addPnpm("11.5.0"); f.wizard();
		// pnpm 11 switches to the version a project pins when run inside it.
		writeFileSync(join(f.root, "pnpm package/bin/pnpm.mjs"),
			`#!/bin/sh\ncase "$1" in --version) if [ -f package.json ]; then echo '11.1.1'; else echo '11.5.0'; fi;; help) echo ' --global '; esac\n`, { mode: 0o755 });
		const result = spawnSync("/bin/sh", [join(f.bundle, "scripts/bootstrap.sh")], {
			cwd: f.bundle, env: { PATH: f.bin, HOME: f.home }, encoding: "utf8", timeout: 15000,
		});
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /wizard-child:/);
	} finally { f.cleanup(); }
});
posixTest("a pnpm shim without a cmd-shim target still blocks", () => {
	const f = fixture();
	try {
		f.addNode(); f.addPnpm("11.1.1", ">=22.13.0", "shim-without-target"); f.wizard();
		const result = f.run();
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /pnpm compatibility is unknown: package engine evidence missing/);
		assert.doesNotMatch(result.stdout, /wizard-child/);
		assert.deepEqual(readdirSync(f.home), []);
	} finally { f.cleanup(); }
});
// mise, asdf and pnpm's own installer ship pnpm as a standalone native executable
// that embeds its runtime: there is no pnpm package.json to read engines from.
const nativeHeaders: Record<string, number[]> = {
	"Mach-O 64-bit": [0xcf, 0xfa, 0xed, 0xfe], "Mach-O universal": [0xca, 0xfe, 0xba, 0xbe], ELF: [0x7f, 0x45, 0x4c, 0x46],
};
function standalonePnpm(f: ReturnType<typeof fixture>, header: number[], linked = false, padding = 64) {
	const installs = join(f.root, "mise/installs/pnpm/10.27.0");
	mkdirSync(installs, { recursive: true });
	const binary = join(installs, "pnpm");
	writeFileSync(binary, Buffer.concat([Buffer.from(header), Buffer.alloc(padding)]), { mode: 0o755 });
	if (linked) symlinkSync(binary, join(f.bin, "pnpm"));
	else writeFileSync(join(f.bin, "pnpm"), Buffer.concat([Buffer.from(header), Buffer.alloc(padding)]), { mode: 0o755 });
}
const standaloneProcess = (version: string, calls: string[][] = []) => (_command: string, args: string[]) => {
	calls.push(args);
	return args.at(-1) === "--version" ? version : " --global ";
};
posixTest("a standalone native pnpm (mise, pnpm installer) is reused after version and capability proof", async () => {
	// A real executable is far larger than the 64 KiB a shim may have; only scripts are read as shims.
	for (const [label, header] of Object.entries(nativeHeaders)) {
		for (const [linked, padding] of [[false, 64], [true, 64], [false, 128 * 1024]] as const) {
			const f = fixture();
			try {
				standalonePnpm(f, header, linked, padding);
				const calls: string[][] = [];
				const result = await ensurePnpm({ tools: f.home, env: { PATH: f.bin }, nodeVersion: "24.21.0", adapters: {
					process: standaloneProcess("11.5.0", calls), download: () => { throw new Error("must not download"); },
				} });
				assert.equal(result.acquired, false, `${label} linked=${linked} padding=${padding}`);
				assert.deepEqual(calls, [["--version"], ["help", "add"], ["help", "bin"]], `${label} linked=${linked} padding=${padding}`);
				assert.deepEqual(readdirSync(f.home), [], "no private tooling is created");
			} finally { f.cleanup(); }
		}
	}
});
posixTest("an existing pnpm of another major, older than the pin or engine-incompatible is left unchanged and the verified pnpm is acquired", async () => {
	for (const [version, engine] of [["10.27.0", ">=18.12"], ["11.0.0", ">=22.13"], ["12.0.0", ">=22.13"], ["11.5.0", ">=99.0.0"]]) {
		const f = fixture();
		try {
			f.addPnpm(version, engine);
			const metadata = readFileSync(join(f.root, "pnpm package/package.json"), "utf8");
			const adapters = acquisitionAdapters();
			const result = await ensurePnpm({ tools: f.home, env: { PATH: f.bin }, nodeVersion: "24.21.0", adapters });
			assert.equal(result.acquired, true, version);
			assert.ok(result.env.PATH.startsWith(`${join(f.home, "pnpm/bin")}:`), version);
			assert.equal(readFileSync(join(f.root, "pnpm package/package.json"), "utf8"), metadata);
			assert.ok(lstatSync(join(f.bin, "pnpm")).isSymbolicLink());
			assert.ok(adapters.calls.every((call) => !call.startsWith(join(f.bin, "pnpm"))), version);
		} finally { f.cleanup(); }
	}
	// A standalone native pnpm (mise) of another major: only its version is read.
	const f = fixture();
	try {
		standalonePnpm(f, nativeHeaders.ELF);
		const calls: string[][] = [];
		const adapters = acquisitionAdapters();
		const standalone = { ...adapters, process: (command: string, args: string[]) => command === join(f.bin, "pnpm")
			? standaloneProcess("10.27.0", calls)(command, args) : adapters.process(command, args) };
		const result = await ensurePnpm({ tools: f.home, env: { PATH: f.bin }, nodeVersion: "24.21.0", adapters: standalone });
		assert.equal(result.acquired, true);
		assert.deepEqual(calls, [["--version"]]);
	} finally { f.cleanup(); }
});
posixTest("the bootstrap claims private tools for the verified pnpm when the existing one is incompatible", async () => {
	const f = fixture();
	try {
		f.addPnpm("10.27.0", ">=18.12");
		writeFileSync(join(f.bundle, "bin/gentle-shell-install.mjs"), "import { writeFileSync } from 'node:fs';\n" +
			`writeFileSync(${JSON.stringify(join(f.root, "wizard-path"))}, process.env.PATH);\n`);
		await bootstrap(f.bundle, "", { env: { PATH: f.bin, HOME: f.home }, adapters: acquisitionAdapters() });
		assert.match(readFileSync(join(f.root, "wizard-path"), "utf8"), /^[^:]*\.gentle-shell-bootstrap-tools\.[^:]*\/pnpm\/bin:/);
		assert.deepEqual(readdirSync(f.home), [], "the helper-created tools are removed after the wizard");
	} finally { f.cleanup(); }
});
posixTest("a standalone native pnpm without a semver version or global capability still blocks", async () => {
	const f = fixture();
	try {
		standalonePnpm(f, nativeHeaders["Mach-O 64-bit"]);
		const adapters = (process: (command: string, args: string[]) => string) => ({ process, download: () => { throw new Error("must not download"); } });
		for (const version of ["", "10.27", "not pnpm", "10.27.0-beta.1"]) {
			await assert.rejects(ensurePnpm({ tools: f.home, env: { PATH: f.bin }, nodeVersion: "24.21.0", adapters: adapters(standaloneProcess(version)) }), /pnpm version rejected/, version);
		}
		await assert.rejects(ensurePnpm({ tools: f.home, env: { PATH: f.bin }, nodeVersion: "24.21.0", adapters: adapters((_c, args) => args.at(-1) === "--version" ? "11.5.0" : "no global flag") }),
			/pnpm global-install capability evidence missing/);
	} finally { f.cleanup(); }
});
posixTest("a script pnpm without a package is not treated as standalone", async () => {
	const f = fixture();
	try {
		writeFileSync(join(f.bin, "pnpm"), "#!/bin/sh\necho 10.27.0\n", { mode: 0o755 });
		await assert.rejects(ensurePnpm({ tools: f.home, env: { PATH: f.bin }, nodeVersion: "24.21.0", adapters: { process: () => { throw new Error("must not run"); } } }),
			/package engine evidence missing/);
	} finally { f.cleanup(); }
});
// $PNPM_HOME layouts captured from real macOS installs (get.pnpm.io + `pnpm setup`,
// `pnpm self-update`, `pnpm add -g`), shims trimmed to the lines naming the target.
interface PnpmHomeLayout {
	bin: string; target: string; shim: (home: string) => string; native: boolean;
	pkg?: { dir: string; json: Record<string, unknown> }; store?: string;
}
const setupShim = (target: string) => (home: string) => `#!/bin/sh\nbasedir_abs=$(CDPATH= cd -P -- "$basedir" && pwd -P) || exit $?\nbasedir="$basedir_abs"\n\n` +
	`exec "$basedir_abs/../${target}"   "$@"\nexit $?\n# cmd-shim-target=${home}/${target}\n`;
const legacyShim = (target: string) => () => `#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")\n\n\n"$basedir/${target}"   "$@"\nexit $?\n`;
const addGlobalShim = (target: string) => () => `#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")\n\nif [ -x "$basedir/node" ]; then\n` +
	`  exec "$basedir/node"  "$basedir/${target}" "$@"\nelse\n  exec node  "$basedir/${target}" "$@"\nfi\n`;
const pnpmHomeLayouts: Record<string, PnpmHomeLayout & { version: string; outcome: "reused" | "acquired" }> = {
	"pnpm 11 setup or self-update (@pnpm/exe in $PNPM_HOME/bin)": {
		bin: "bin", target: "global/v11/933b1afb/node_modules/@pnpm/exe/pnpm", shim: setupShim("global/v11/933b1afb/node_modules/@pnpm/exe/pnpm"),
		native: true, store: "store/v11/links/@pnpm/exe/directory/643afacf/node_modules/@pnpm/exe",
		pkg: { dir: "global/v11/933b1afb/node_modules/@pnpm/exe", json: { name: "@pnpm/exe", version: "11.28.2", bin: { pnpm: "pnpm", pn: "pnpm" } } },
		version: "11.28.2", outcome: "reused",
	},
	"pnpm 10 self-update to 11 (@pnpm/exe in $PNPM_HOME/.tools)": {
		bin: "", target: ".tools/@pnpm+exe/11.28.2/node_modules/@pnpm/exe/pnpm", shim: legacyShim(".tools/@pnpm+exe/11.28.2/node_modules/@pnpm/exe/pnpm"),
		native: true, pkg: { dir: ".tools/@pnpm+exe/11.28.2/node_modules/@pnpm/exe", json: { name: "@pnpm/exe", version: "11.28.2" } },
		version: "11.28.2", outcome: "reused",
	},
	"pnpm 10 setup (bare executable in $PNPM_HOME/.tools)": {
		bin: "", target: ".tools/pnpm-exe/10.34.6/pnpm", shim: legacyShim(".tools/pnpm-exe/10.34.6/pnpm"), native: true,
		version: "10.34.6", outcome: "acquired",
	},
	"pnpm 12 setup (native pnpm package without engines)": {
		bin: "bin", target: "global/v11/82859147/node_modules/pnpm/pnpm", shim: setupShim("global/v11/82859147/node_modules/pnpm/pnpm"),
		native: true, pkg: { dir: "global/v11/82859147/node_modules/pnpm", json: { name: "pnpm", version: "12.10.1", bin: { pnpm: "pnpm", pn: "pnpm" } } },
		version: "12.10.1", outcome: "acquired",
	},
	"pnpm 10 add -g pnpm (JS package in $PNPM_HOME/global/5)": {
		bin: "", target: "global/5/.pnpm/pnpm@10.34.6/node_modules/pnpm/bin/pnpm.cjs", shim: addGlobalShim("global/5/.pnpm/pnpm@10.34.6/node_modules/pnpm/bin/pnpm.cjs"),
		native: false, pkg: { dir: "global/5/.pnpm/pnpm@10.34.6/node_modules/pnpm", json: { name: "pnpm", version: "10.34.6", engines: { node: ">=18.12" } } },
		version: "10.34.6", outcome: "acquired",
	},
};
function pnpmHome(f: ReturnType<typeof fixture>, layout: PnpmHomeLayout) {
	const home = join(f.root, "Library/pnpm");
	const dir = join(home, layout.bin);
	const target = join(home, layout.target);
	mkdirSync(dir, { recursive: true });
	if (layout.store) {
		// pnpm 11 links the global package directory into its store.
		mkdirSync(join(home, layout.store), { recursive: true });
		mkdirSync(dirname(dirname(target)), { recursive: true });
		symlinkSync(join(home, layout.store), dirname(target));
	} else mkdirSync(dirname(target), { recursive: true });
	if (layout.pkg) {
		mkdirSync(join(home, layout.pkg.dir), { recursive: true });
		writeFileSync(join(home, layout.pkg.dir, "package.json"), JSON.stringify(layout.pkg.json));
	}
	writeFileSync(target, layout.native ? Buffer.concat([Buffer.from(nativeHeaders["Mach-O 64-bit"]), Buffer.alloc(64)]) : "#!/usr/bin/env node\n", { mode: 0o755 });
	writeFileSync(join(dir, "pnpm"), layout.shim(home), { mode: 0o755 });
	return { shim: join(dir, "pnpm"), env: { PATH: `${dir}:${f.bin}` } };
}
posixTest("pnpm installed in $PNPM_HOME by pnpm itself is recognized behind its shim", async () => {
	for (const [label, layout] of Object.entries(pnpmHomeLayouts)) {
		const f = fixture();
		try {
			const { shim, env } = pnpmHome(f, layout);
			const calls: string[][] = [];
			const acquisition = acquisitionAdapters();
			const adapters = { ...acquisition, process: (command: string, args: string[]) => command === shim
				? standaloneProcess(layout.version, calls)(command, args) : acquisition.process(command, args) };
			const result = await ensurePnpm({ tools: f.home, env, nodeVersion: "24.21.0", adapters });
			assert.equal(result.acquired, layout.outcome === "acquired", label);
			if (layout.outcome === "reused") assert.deepEqual(calls, [["--version"], ["help", "add"], ["help", "bin"]], label);
			// An incompatible JS pnpm is judged by its package; a native one only by --version.
			else assert.deepEqual(calls, layout.native ? [["--version"]] : [], label);
		} finally { f.cleanup(); }
	}
});
// A shim is read whole up to 64 KiB, so a target named after the first 4 KiB is still found.
const paddedShim = (shim: (home: string) => string, size: number) => (home: string) => {
	const [first, ...rest] = shim(home).split("\n");
	const text = [first, ...rest].join("\n");
	return `${first}\n${"#".repeat(Math.max(0, size - Buffer.byteLength(text) - 1))}\n${rest.join("\n")}`;
};
posixTest("a $PNPM_HOME shim larger than 4 KiB keeps its target; one above 64 KiB fails closed", async () => {
	const setup = pnpmHomeLayouts["pnpm 11 setup or self-update (@pnpm/exe in $PNPM_HOME/bin)"];
	const legacy = pnpmHomeLayouts["pnpm 10 self-update to 11 (@pnpm/exe in $PNPM_HOME/.tools)"];
	for (const [label, layout] of [["cmd-shim-target comment", setup], ["single basedir target", legacy]] as const) {
		for (const size of [4097, 64 * 1024]) {
			const f = fixture();
			try {
				const { shim, env } = pnpmHome(f, { ...layout, shim: paddedShim(layout.shim, size) });
				assert.equal(readFileSync(shim).length, size, label);
				const calls: string[][] = [];
				const adapters = { process: (command: string, args: string[]) => {
					if (command !== shim) throw new Error("must not run");
					return standaloneProcess(layout.version, calls)(command, args);
				}, download: () => { throw new Error("must not download"); } };
				const result = await ensurePnpm({ tools: f.home, env, nodeVersion: "24.21.0", adapters });
				assert.equal(result.acquired, false, `${label} ${size}`);
				assert.deepEqual(calls, [["--version"], ["help", "add"], ["help", "bin"]], `${label} ${size}`);
			} finally { f.cleanup(); }
		}
		const f = fixture();
		try {
			const { env } = pnpmHome(f, { ...layout, shim: paddedShim(layout.shim, 64 * 1024 + 1) });
			const adapters = { process: () => { throw new Error("must not run"); }, download: () => { throw new Error("must not download"); } };
			await assert.rejects(ensurePnpm({ tools: f.home, env, nodeVersion: "24.21.0", adapters }), /pnpm compatibility is unknown: shim larger than 64 KiB/, label);
			assert.deepEqual(readdirSync(f.home), [], label);
		} finally { f.cleanup(); }
	}
});
posixTest("pnpm behind a $PNPM_HOME shim still fails closed without matching evidence", async () => {
	const setup = pnpmHomeLayouts["pnpm 11 setup or self-update (@pnpm/exe in $PNPM_HOME/bin)"];
	const addGlobal = pnpmHomeLayouts["pnpm 10 add -g pnpm (JS package in $PNPM_HOME/global/5)"];
	const missing = legacyShim(".tools/pnpm-exe/10.34.6/pnpm");
	const ambiguous = () => `${legacyShim(".tools/a/pnpm")()}"$basedir/.tools/b/pnpm" "$@"\n`;
	const cases: [string, PnpmHomeLayout, string | undefined, RegExp][] = [
		["native version differs from its package", setup, "11.27.0", /pnpm version rejected/],
		["JS target not named pnpm", { ...addGlobal, pkg: { dir: addGlobal.pkg!.dir, json: { ...addGlobal.pkg!.json, name: "not-pnpm" } } }, undefined, /package engine evidence missing/],
		["target missing", { bin: "", target: "elsewhere/pnpm", shim: missing, native: true }, undefined, /package engine evidence missing/],
		["two targets", { bin: "", target: ".tools/a/pnpm", shim: ambiguous, native: true }, undefined, /package engine evidence missing/],
	];
	for (const [label, layout, version, error] of cases) {
		const f = fixture();
		try {
			const { shim, env } = pnpmHome(f, layout);
			const adapters = { process: (command: string, args: string[]) => {
				if (command !== shim || version === undefined) throw new Error("must not run");
				return standaloneProcess(version)(command, args);
			}, download: () => { throw new Error("must not download"); } };
			await assert.rejects(ensurePnpm({ tools: f.home, env, nodeVersion: "24.21.0", adapters }), error, label);
			assert.deepEqual(readdirSync(f.home), [], label);
		} finally { f.cleanup(); }
	}
});
posixTest("missing required shell utility is named", () => {
	const f = fixture();
	try {
		f.wizard();
		unlinkSync(join(f.bin, "curl"));
		const result = f.run();
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Required utility missing: curl/);
	} finally { f.cleanup(); }
});
posixTest("symlink HOME and conflicting staging are refused without touching targets", () => {
	const f = fixture();
	try {
		f.addPnpm(); f.wizard();
		const link = join(f.root, "linked-home"); symlinkSync(f.home, link);
		assert.match(f.run({ HOME: link }).stderr, /symlink|unsafe/i);
		f.executable("mktemp", `printf '%s\\n' '${f.bin}'`);
		const result = f.run();
		assert.notEqual(result.status, 0);
		assert.ok(existsSync(join(f.bin, "pnpm")));
	} finally { f.cleanup(); }
});
posixTest("pnpm acquisition refuses conflicting and symlink destinations before download", async () => {
	const f = fixture();
	try {
		mkdirSync(join(f.home, "pnpm"));
		let downloads = 0;
		await assert.rejects(ensurePnpm({ tools: f.home, env: { PATH: f.bin }, nodeVersion: "24.21.0", adapters: {
			download: async () => { downloads += 1; return Buffer.alloc(0); },
		} }), /destination/);
		assert.equal(downloads, 0);
	} finally { f.cleanup(); }
});
posixTest("wizard child failure is propagated and missing entry is explicit", async () => {
	await assert.rejects(launchWizard({ bundle: "/missing-bundle", env: {} }), /wizard entry.*missing/i);
	const f = fixture();
	try {
		writeFileSync(join(f.bundle, "bin/gentle-shell-install.mjs"), "process.exit(7);\n");
		await assert.rejects(launchWizard({ bundle: f.bundle, env: {} }), /Wizard child failed/);
		f.addPnpm();
		assert.notEqual(f.run().status, 0);
		assert.deepEqual(readdirSync(f.home), []);
	} finally { f.cleanup(); }
});

for (const [os, arch, platform, architecture] of [["Darwin", "arm64", "darwin", "arm64"], ["Darwin", "x86_64", "darwin", "x64"], ["Linux", "aarch64", "linux", "arm64"]]) {
	posixTest(`shell artifact selection ${os}/${arch} (simulated, not native proof)`, () => {
		const f = fixture();
		try {
			f.addPnpm(); f.wizard();
			const hash = artifactFor("node", platform, architecture).integrity.slice(7);
			assert.equal(f.run({ FAKE_OS: os, FAKE_ARCH: arch, FAKE_HASH: hash }).status, 0);
		} finally { f.cleanup(); }
	});
}
for (const extra of [{ FAKE_ARCH: "riscv64" }, { FAKE_OS: "FreeBSD" }, { FAKE_LIBC: "glibc 2.27" }]) {
	posixTest(`unsupported acquisition blocks before download: ${JSON.stringify(extra)}`, () => {
		const f = fixture();
		try {
			f.wizard();
			assert.notEqual(f.run(extra).status, 0);
			assert.deepEqual(readdirSync(f.home), []);
		} finally { f.cleanup(); }
	});
}
for (const [utility, body, message] of [
	["curl", 'while [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; out=$1; fi; shift; done; : > "$out"', /download/i],
	["sha256sum", "exit 2", /SHA256 process failed/],
	["tar", "exit 2", /archive is invalid/],
	["tar", "echo 'lrwxrwxrwx malicious-link'", /not a regular file/],
] as [string, string, RegExp][]) {
	posixTest(`native acquisition process rejection: ${utility}/${message}`, () => {
		const f = fixture();
		try {
			f.addPnpm(); f.wizard(); f.executable(utility, body);
			const result = f.run();
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, message);
			assert.deepEqual(readdirSync(f.home), []);
		} finally { f.cleanup(); }
	});
}

interface AcquisitionOptions {
	names?: string;
	types?: string;
	version?: string;
	help?: string;
	failProcess?: boolean;
}
function acquisitionAdapters(options: AcquisitionOptions = {}) {
	const calls: string[] = [];
	return {
		calls,
		download: async () => Buffer.from("verified fixture"),
		digest: () => Buffer.from(artifactFor("pnpm").integrity.slice(7), "base64"),
		process: (command: string, args: string[]) => {
			calls.push(`${command}:${args[0]}`);
			if (options.failProcess) throw Error("injected process failure");
			if (args[0] === "-tzf") return options.names ?? "package/\npackage/package.json\npackage/bin/pnpm.mjs";
			if (args[0] === "-tvzf") return options.types ?? "drwx------ package/\n-rw------- package/package.json\n-rwx------ package/bin/pnpm.mjs";
			if (args[0] === "-xzf") {
				const pkg = join(args[3], "package");
				mkdirSync(join(pkg, "bin"), { recursive: true, mode: 0o700 });
				// Literal parent-verified upstream metadata, intentionally not descriptor-derived.
				writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pnpm", version: "11.1.1", engines: { node: ">=22.13" } }));
				writeFileSync(join(pkg, "bin/pnpm.mjs"), "console.log(process.argv.includes('--version') ? '11.1.1' : '--global');\n");
				return "";
			}
			if (args.includes("--version")) return options.version ?? "11.1.1";
			return options.help ?? "--global";
		},
	};
}
posixTest("verified pnpm with literal upstream >=22.13 engine publishes its owned wrapper", async () => {
	const f = fixture();
	try {
		const adapters = acquisitionAdapters();
		const result = await ensurePnpm({ tools: f.home, env: { PATH: f.bin }, nodeVersion: "24.21.0", adapters });
		assert.equal(result.acquired, true);
		assert.ok(result.env.PATH.startsWith(join(f.home, "pnpm/bin")));
		assert.deepEqual(readdirSync(f.home), ["pnpm"]);
		const wrapper = join(f.home, "pnpm/bin/pnpm");
		assert.equal(spawnSync(wrapper, ["--version"], { encoding: "utf8" }).stdout.trim(), "11.1.1");
		assert.ok(adapters.calls.every((call) => call.startsWith(join(f.bin, "tar")) || call.startsWith(node)));
	} finally { f.cleanup(); }
});
for (const options of [{ names: "package/../escape" }, { names: "/absolute/path" }, { types: "lrwxrwxrwx package/link" }, { types: "hrw------- package/hardlink" }, { version: "11.1.0" }, { help: "--global-bin-dir" }, { failProcess: true }]) {
	posixTest(`pnpm extraction/validation fails without publication: ${JSON.stringify(options)}`, async () => {
		const f = fixture();
		try {
			await assert.rejects(ensurePnpm({ tools: f.home, env: { PATH: f.bin }, nodeVersion: "24.21.0", adapters: acquisitionAdapters(options) }), /acquisition failed/);
			assert.deepEqual(readdirSync(f.home), []);
		} finally { f.cleanup(); }
	});
}
function silentWizard(bundle: string, body = "") {
	writeFileSync(join(bundle, "bin/gentle-shell-install.mjs"), body);
}
posixTest("helper-created pnpm tools are removed after a successful wizard exit", async (t) => {
	const f = fixture();
	try {
		silentWizard(f.bundle);
		writeFileSync(join(f.home, "unrelated.txt"), "preserve");
		const notices = t.mock.method(console, "error", () => {});
		await bootstrap(f.bundle, "", { env: { PATH: f.bin, HOME: f.home }, adapters: acquisitionAdapters() });
		assert.equal(notices.mock.callCount(), 0);
		assert.deepEqual(readdirSync(f.home), ["unrelated.txt"]);
	} finally { f.cleanup(); }
});
posixTest("helper-created tools are removed after wizard failure and kept with a notice when unprovable", async (t) => {
	const f = fixture();
	try {
		silentWizard(f.bundle, "process.exit(3);\n");
		await assert.rejects(bootstrap(f.bundle, "", { env: { PATH: f.bin, HOME: f.home }, adapters: acquisitionAdapters() }), /Wizard child failed/);
		assert.deepEqual(readdirSync(f.home), []);
		f.markerRemovingWizard();
		const notices = t.mock.method(console, "error", () => {});
		await bootstrap(f.bundle, "", { env: { PATH: f.bin, HOME: f.home }, adapters: acquisitionAdapters() });
		const [tools] = readdirSync(f.home);
		assert.match(tools, /^\.gentle-shell-bootstrap-tools\./);
		assert.equal(notices.mock.callCount(), 1);
		assert.ok(String(notices.mock.calls[0].arguments[0]).includes(`temporary tools could not be removed: ${join(f.home, tools)}`));
	} finally { f.cleanup(); }
});
posixTest("owned tools removal refuses anything but the exact marked private directory", () => {
	const f = fixture();
	try {
		const marked = (name: string, marker = "gentle-pi prerequisite tooling only\n") => {
			const path = join(f.home, name);
			mkdirSync(path, { mode: 0o700 });
			writeFileSync(join(path, "keep"), "preserve");
			if (marker) writeFileSync(join(path, ".bootstrap-owned"), marker);
			return path;
		};
		const target = marked("target");
		const link = join(f.home, ".gentle-shell-bootstrap-tools.link");
		symlinkSync(target, link);
		const outside = join(f.root, ".gentle-shell-bootstrap-tools.outside");
		mkdirSync(outside); writeFileSync(join(outside, ".bootstrap-owned"), "gentle-pi prerequisite tooling only\n");
		const nested = join(marked(".gentle-shell-bootstrap-tools.parent"), ".gentle-shell-bootstrap-tools.child");
		mkdirSync(nested); writeFileSync(join(nested, ".bootstrap-owned"), "gentle-pi prerequisite tooling only\n");
		const markerLink = marked(".gentle-shell-bootstrap-tools.markerlink", "");
		symlinkSync(join(target, ".bootstrap-owned"), join(markerLink, ".bootstrap-owned"));
		const refused = [link, outside, nested, marked("other-name"), marked(".gentle-shell-bootstrap-tools.nomarker", ""),
			marked(".gentle-shell-bootstrap-tools.wrongmarker", "something else\n"), markerLink, `${f.home}/./.gentle-shell-bootstrap-tools.parent`, "", undefined];
		for (const path of refused) assert.equal(removeOwnedTools(path, f.home), false, String(path));
		assert.equal(readFileSync(join(target, "keep"), "utf8"), "preserve");
		assert.ok(existsSync(outside) && existsSync(nested));
		const owned = marked(".gentle-shell-bootstrap-tools.owned");
		assert.equal(removeOwnedTools(owned, f.home), true);
		assert.equal(existsSync(owned), false);
		assert.equal(removeOwnedTools(owned, f.home), false, "already removed");
	} finally { f.cleanup(); }
});
posixTest("pnpm symlink conflict does not touch its target", async () => {
	const f = fixture();
	try {
		symlinkSync(f.bin, join(f.home, "pnpm"));
		await assert.rejects(ensurePnpm({ tools: f.home, env: { PATH: f.bin }, nodeVersion: "24.21.0", adapters: acquisitionAdapters() }), /destination/);
		assert.ok(existsSync(join(f.bin, "curl")));
	} finally { f.cleanup(); }
});
posixTest("native Node destination symlink is refused without following its target", () => {
	const f = fixture();
	try {
		f.addPnpm(); f.wizard();
		const tar = readFileSync(join(f.bin, "tar"), "utf8");
		f.executable("tar", tar.replace('mkdir -p "$target/', `${systemUtility("ln")} -s '${f.bin}' "$target/../node"\nmkdir -p "$target/`));
		const result = f.run();
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Conflicting Node destination/);
		assert.ok(existsSync(join(f.bin, "pnpm")));
		assert.deepEqual(readdirSync(f.home), []);
	} finally { f.cleanup(); }
});
posixTest("existing Node failed probe is not repaired", () => {
	const f = fixture();
	try {
		f.addNode(); f.wizard(); f.executable("node", "exit 4");
		assert.match(f.run().stderr, /Existing Node version probe failed/);
		assert.deepEqual(readdirSync(f.home), []);
	} finally { f.cleanup(); }
});
posixTest("pnpm without required global capabilities is not replaced", () => {
	const f = fixture();
	try {
		f.addNode(); f.addPnpm(); f.wizard();
		writeFileSync(join(f.bin, "pnpm"), "#!/bin/sh\n[ \"$1\" != --version ] || echo 11.1.1\n", { mode: 0o755 });
		assert.match(f.run().stderr, /capability evidence missing/);
		assert.deepEqual(readdirSync(f.home), []);
	} finally { f.cleanup(); }
});
posixTest("missing tar blocks pnpm before any download", async () => {
	const f = fixture();
	try {
		unlinkSync(join(f.bin, "tar"));
		let downloaded = false;
		await assert.rejects(ensurePnpm({ tools: f.home, env: { PATH: f.bin }, nodeVersion: "24.21.0", adapters: {
			download: async () => { downloaded = true; return Buffer.alloc(0); },
		} }), /Required utility missing: tar/);
		assert.equal(downloaded, false);
	} finally { f.cleanup(); }
});
test("oversized verified-download input is rejected before digest", async () => {
	let hashed = false;
	await assert.rejects(verifiedDownload("pnpm", {
		download: async () => Buffer.alloc(artifactFor("pnpm").maxBytes + 1),
		digest: () => { hashed = true; return Buffer.alloc(0); },
	}), /size rejected/);
	assert.equal(hashed, false);
});
interface GuardedResult {
	status: number | null;
	signal: string | null;
	stdout: string;
	stderr: string;
	guardKilled: boolean;
	elapsed: number;
}

// Independent asynchronous guard: even a blocked spawnSync inside the fixture
// cannot block this test process. Only this fresh detached fixture group is killed.
async function guardedFixture(command: string, args: string[], env: Record<string, string>, limit: number): Promise<GuardedResult> {
	const start = Date.now();
	const child = spawn(command, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	const group = child.pid;
	let stdout = "";
	let stderr = "";
	let guardKilled = false;
	const killOwnedGroup = () => {
		if (group === undefined) return;
		try { process.kill(-group, "SIGKILL"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
	};
	const timer = setTimeout(() => { guardKilled = true; killOwnedGroup(); }, limit);
	child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
	child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
	try {
		return await new Promise<GuardedResult>((resolveChild, reject) => {
			child.once("error", reject);
			child.once("close", (status, signal) => resolveChild({ status, signal, stdout, stderr, guardKilled, elapsed: Date.now() - start }));
		});
	} finally {
		clearTimeout(timer);
		// Also clean residual fixture descendants if the group leader exits early.
		killOwnedGroup();
	}
}
function termIgnoringProbe(root: string, output: string) {
	const probe = join(root, "term-ignoring-probe.mjs");
	const pid = join(root, "owned-probe.pid");
	writeFileSync(probe, `import { writeFileSync } from 'node:fs';\nprocess.on('SIGTERM', () => {});\nwriteFileSync(process.env.PROBE_PID, String(process.pid));\nconsole.log(${JSON.stringify(output)});\nsetInterval(() => {}, 1000);\n`);
	return { probe, pid };
}
function assertProbeReaped(path: string) {
	const pid = Number(readFileSync(path, "utf8"));
	assert.ok(Number.isSafeInteger(pid) && pid > 0);
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "owned probe must be reaped before the parent returns");
}

posixTest("production shell deadline rejects TERM-ignored acquired Node and cleans owned tooling", async () => {
	const f = fixture();
	try {
		f.addPnpm(); f.wizard();
		writeFileSync(join(f.home, "unrelated.txt"), "preserve");
		const { probe, pid } = termIgnoringProbe(f.root, "v24.21.0");
		const result = await guardedFixture("/bin/sh", [join(f.bundle, "scripts/bootstrap.sh")], {
			PATH: f.bin, HOME: f.home, NODE_PROBE_SCRIPT: probe, PROBE_PID: pid,
		}, 13000);
		assert.equal(result.guardKilled, false, `shell required outer SIGKILL after ${result.elapsed}ms`);
		assert.equal(result.status, 1);
		assert.equal(result.signal, null);
		assert.match(result.stderr, /Acquired Node cannot execute/);
		assert.doesNotMatch(result.stdout, /wizard-child/);
		assertProbeReaped(pid);
		assert.deepEqual(readdirSync(f.home), ["unrelated.txt"]);
		assert.equal(readFileSync(join(f.home, "unrelated.txt"), "utf8"), "preserve");
	} finally { f.cleanup(); }
});

function productionPnpmRunner(root: string, home: string, bin: string) {
	const runner = join(root, "production-pnpm-runner.mjs");
	// Inject only verified-byte transport/digest, not the production process adapter.
	writeFileSync(runner, `import { artifactFor, ensurePnpm } from ${JSON.stringify(pathToFileURL(helper).href)};\ntry {\nawait ensurePnpm({ tools: ${JSON.stringify(home)}, env: { PATH: ${JSON.stringify(bin)}, PROBE_PID: process.env.PROBE_PID }, nodeVersion: '24.21.0', adapters: {\ndownload: async () => Buffer.from('verified fixture'),\ndigest: () => Buffer.from(artifactFor('pnpm').integrity.slice(7), 'base64'),\n} });\nconsole.log('unexpected acquisition success');\n} catch { console.error('acquisition rejected'); process.exitCode = 1; }\n`);
	return runner;
}
posixTest("production Node process deadline rejects TERM-ignored tar and cleans owned staging", async () => {
	const f = fixture();
	try {
		writeFileSync(join(f.home, "unrelated.txt"), "preserve");
		const { probe, pid } = termIgnoringProbe(f.root, "package/");
		f.executable("tar", `exec '${node}' '${probe}'`);
		const result = await guardedFixture(node, [productionPnpmRunner(f.root, f.home, f.bin)], { PROBE_PID: pid }, 18000);
		assert.equal(result.guardKilled, false, `Node process check required outer SIGKILL after ${result.elapsed}ms`);
		assert.equal(result.status, 1);
		assert.equal(result.signal, null);
		assert.match(result.stderr, /acquisition rejected/);
		assert.doesNotMatch(result.stdout, /unexpected acquisition success/);
		assertProbeReaped(pid);
		assert.deepEqual(readdirSync(f.home), ["unrelated.txt"]);
		assert.equal(readFileSync(join(f.home, "unrelated.txt"), "utf8"), "preserve");
	} finally { f.cleanup(); }
});
posixTest("production Node process adapter propagates ordinary nonzero tar exit with cleanup", async () => {
	const f = fixture();
	try {
		writeFileSync(join(f.home, "unrelated.txt"), "preserve");
		f.executable("tar", "exit 7");
		const result = await guardedFixture(node, [productionPnpmRunner(f.root, f.home, f.bin)], {}, 3000);
		assert.equal(result.guardKilled, false);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /acquisition rejected/);
		assert.deepEqual(readdirSync(f.home), ["unrelated.txt"]);
	} finally { f.cleanup(); }
});

posixTest("failed pnpm download never reaches archive/process adapters", async () => {
	const f = fixture();
	try {
		let processes = 0;
		await assert.rejects(ensurePnpm({ tools: f.home, env: { PATH: f.bin }, nodeVersion: "24.21.0", adapters: {
			download: async () => Buffer.from("truncated"),
			process: () => { processes += 1; return ""; },
		} }), /acquisition failed/);
		assert.equal(processes, 0);
		assert.deepEqual(readdirSync(f.home), []);
	} finally { f.cleanup(); }
});

// --- Pinned Go toolchain: official go.dev archives, verified, extracted in process ---------------
const goPins = {
	"darwin-arm64": ["go1.25.14.darwin-arm64.tar.gz", "5b26c0b6f308240fca2614fb02f622cfcc8c0cc3b69c78bba4845489a4590259", 58123934],
	"darwin-x64": ["go1.25.14.darwin-amd64.tar.gz", "b09087a67d5792a8b0fcbf74212d62560c94ac8a8fd750ff920d8cb5f1e20118", 60622678],
	"linux-x64": ["go1.25.14.linux-amd64.tar.gz", "a21ae5633a269bcd7e90cf767e48225633795e99d831742cbf3397064fee7712", 59909419],
	"linux-arm64": ["go1.25.14.linux-arm64.tar.gz", "9bf234ea70ffec9347fdf6b22ce4add51717d3386a38a441e8c8743fceb5eaee", 57360344],
	"win32-x64": ["go1.25.14.windows-amd64.zip", "119044a92b3987c341cd6aebb256676dd4780d292f7b4e72a3e9976677841697", 67591780],
	"win32-arm64": ["go1.25.14.windows-arm64.zip", "96fb31ae26b288b5311bd31d8252d4a62c8a661e4dbb64d504cc646e4d10a57f", 64735369],
} as const;
for (const [target, [file, sha256, size]] of Object.entries(goPins)) {
	test(`fixed Go descriptor for ${target} is the go.dev archive and checksum`, () => {
		const [platform, arch] = target.split("-");
		const artifact = artifactFor("go", platform, arch);
		assert.equal(artifact.version, "1.25.14");
		assert.equal(artifact.url, `https://dl.google.com/go/${file}`);
		assert.equal(artifact.integrity, `sha256-${sha256}`);
		assert.equal(artifact.size, size);
	});
}
test("Go has no descriptor for other targets", () => {
	for (const [platform, arch] of [["linux", "ia32"], ["freebsd", "x64"], ["win32", "ia32"]]) {
		assert.throws(() => artifactFor("go", platform, arch), /Unsupported/);
	}
});

function tarHeader(name: string, size: number, { type = "0", mode = 0o644, link = "", prefix = "" } = {}) {
	const header = Buffer.alloc(512);
	header.write(name, 0, 100, "utf8");
	header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
	header.write("0000000\0", 108);
	header.write("0000000\0", 116);
	header.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
	header.write("00000000000\0", 136);
	header.write("        ", 148);
	header.write(type, 156);
	header.write(link, 157);
	header.write("ustar\0", 257);
	header.write("00", 263);
	header.write(prefix, 345);
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return header;
}
type GoEntry = { name: string; body?: string; type?: string; mode?: number; link?: string; prefix?: string };
function tarEntry({ name, body = "", ...options }: GoEntry) {
	const data = Buffer.from(body);
	return Buffer.concat([tarHeader(name, data.length, options), data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
function paxPath(path: string) {
	const record = (length: number) => `${length} path=${path}\n`;
	let length = Buffer.byteLength(record(0));
	while (Buffer.byteLength(record(length)) !== length) length = Buffer.byteLength(record(length));
	return tarEntry({ name: "go/PaxHeaders.0/x", type: "x", body: record(length) });
}
const goTarGz = (...entries: Buffer[]) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
function goZip(files: Array<{ name: string; body: string; mode?: number }>) {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const { name, body, mode = 0o100644 } of files) {
		const data = deflateRawSync(Buffer.from(body));
		const nameBytes = Buffer.from(name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x800, 6);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(crc32(Buffer.from(body)), 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(Buffer.byteLength(body), 22);
		local.writeUInt16LE(nameBytes.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE((3 << 8) | 20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x800, 8);
		central.writeUInt16LE(8, 10);
		central.writeUInt32LE(crc32(Buffer.from(body)), 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(Buffer.byteLength(body), 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE((mode << 16) >>> 0, 38);
		central.writeUInt32LE(offset, 42);
		locals.push(local, nameBytes, data);
		centrals.push(central, nameBytes);
		offset += local.length + nameBytes.length + data.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}
const goVersionFile = "go1.25.14\ntime 2026-10-01T00:00:00Z\n";
const goTree = (extra: Buffer[] = []) => goTarGz(
	tarEntry({ name: "go/", type: "5", mode: 0o755 }),
	tarEntry({ name: "go/VERSION", body: goVersionFile }),
	tarEntry({ name: "go/bin/go", body: "#!/bin/sh\necho 'go version go1.25.14 darwin/arm64'\n", mode: 0o755 }),
	tarEntry({ name: "long-name-with-a-ustar-prefix.go", prefix: "go/src/internal/trace/testdata/generators", body: "package x\n" }),
	paxPath("go/test/fixedbugs/issue27836.dir/\u00defoo.go"),
	tarEntry({ name: "go/test/fixedbugs/issue27836.dir/foo.go", body: "package foo\n" }),
	...extra);
/** Trusted test adapters standing in for the pinned download: the fixture's own size and hash. */
function goAdapters(bytes: Buffer, counter = { downloads: 0 }) {
	return {
		artifact: (name: string, platform: string, arch: string) => ({ ...artifactFor(name, platform, arch), size: bytes.length, maxBytes: bytes.length,
			integrity: `sha256-${createHash("sha256").update(bytes).digest("hex")}` }),
		download: async () => { counter.downloads += 1; return bytes; },
	};
}
function goRoot() {
	const base = mkdtempSync(join(realpathSync(tmpdir()), "pinned-go-"));
	return { base, root: join(base, "config", "tools", "go"), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("the pinned Go is verified, extracted in process and published once into the installer's own directory", async () => {
	const r = goRoot();
	try {
		const counter = { downloads: 0 };
		const result = await acquireGo({ root: r.root, platform: "darwin", arch: "arm64", adapters: goAdapters(goTree(), counter) });
		const published = join(r.root, "1.25.14");
		assert.deepEqual(result, { goPath: join(published, "go", "bin", "go"), version: "1.25.14", acquired: true });
		assert.equal(readFileSync(join(published, "go", "VERSION"), "utf8"), goVersionFile);
		assert.equal(readFileSync(join(published, "go/src/internal/trace/testdata/generators/long-name-with-a-ustar-prefix.go"), "utf8"), "package x\n");
		assert.equal(readFileSync(join(published, "go/test/fixedbugs/issue27836.dir/\u00defoo.go"), "utf8"), "package foo\n");
		assert.equal(existsSync(join(published, "go/test/fixedbugs/issue27836.dir/foo.go")), false);
		if (process.platform !== "win32") {
			assert.equal(lstatSync(result.goPath).mode & 0o777, 0o755);
			assert.equal(lstatSync(join(published, "go", "VERSION")).mode & 0o777, 0o644);
			assert.equal(lstatSync(published).mode & 0o077, 0);
		}
		assert.deepEqual(readdirSync(r.root), ["1.25.14"], "no staging directory is left behind");
		assert.equal(installedGo(r.root, "darwin", "arm64"), result.goPath);
		// A later run reuses the published copy: no download, nothing replaced.
		const again = await acquireGo({ root: r.root, platform: "darwin", arch: "arm64", adapters: goAdapters(goTree(), counter) });
		assert.deepEqual(again, { ...result, acquired: false });
		assert.equal(counter.downloads, 1);
		// The marker names the exact pinned archive, so another target's copy is not reused.
		assert.equal(installedGo(r.root, "linux", "x64"), null);
	} finally { r.cleanup(); }
});

test("the Windows Go zip is extracted in process into go\\bin\\go.exe", async () => {
	const r = goRoot();
	try {
		const bytes = goZip([{ name: "go/VERSION", body: goVersionFile }, { name: "go/bin/go.exe", body: "MZ", mode: 0o100755 },
			{ name: "go/src/cmd/go/main.go", body: "package main\n" }]);
		const result = await acquireGo({ root: r.root, platform: "win32", arch: "x64", adapters: goAdapters(bytes) });
		assert.equal(result.goPath, join(r.root, "1.25.14", "go", "bin", "go.exe"));
		assert.equal(readFileSync(result.goPath, "utf8"), "MZ");
		assert.equal(readFileSync(join(r.root, "1.25.14", "go/src/cmd/go/main.go"), "utf8"), "package main\n");
	} finally { r.cleanup(); }
});

test("a Go download with the wrong size or checksum fails closed before anything is extracted", async () => {
	const r = goRoot();
	try {
		const bytes = goTree();
		const wrongHash = { ...goAdapters(bytes), digest: () => Buffer.alloc(32) };
		const wrongSize = { ...goAdapters(bytes), download: async () => Buffer.concat([bytes, Buffer.from("x")]) };
		const truncated = { ...goAdapters(bytes), download: async () => bytes.subarray(1) };
		for (const [adapters, cause] of [[wrongHash, /integrity/], [wrongSize, /size/], [truncated, /size/]] as const) {
			await assert.rejects(acquireGo({ root: r.root, platform: "darwin", arch: "arm64", adapters }),
				(error: Error) => /Go verified acquisition failed/.test(error.message) && cause.test(String((error.cause as Error)?.message)));
			assert.deepEqual(existsSync(r.root) ? readdirSync(r.root) : [], []);
		}
		// The production descriptor is the exact pinned size: anything else is rejected.
		await assert.rejects(acquireGo({ root: r.root, platform: "darwin", arch: "arm64", adapters: { download: async () => bytes } }),
			/Go verified acquisition failed/);
	} finally { r.cleanup(); }
});

test("an unsafe Go archive fails closed and publishes nothing", async () => {
	const unsafe: Array<[string, Buffer]> = [
		["traversal", goTree([tarEntry({ name: "go/../escape", body: "x" })])],
		["absolute", goTree([tarEntry({ name: "/go/escape", body: "x" })])],
		["outside go/", goTree([tarEntry({ name: "other/file", body: "x" })])],
		["backslash", goTree([tarEntry({ name: "go\\..\\escape", body: "x" })])],
		["symlink", goTree([tarEntry({ name: "go/link", type: "2", link: "/etc/passwd" })])],
		["hard link", goTree([tarEntry({ name: "go/hard", type: "1", link: "go/VERSION" })])],
		["duplicate", goTree([tarEntry({ name: "go/VERSION", body: "go1.25.14\n" })])],
		["unknown pax key", goTree([tarEntry({ name: "go/PaxHeaders.0/y", type: "x", body: "19 linkpath=/etc/x\n" }), tarEntry({ name: "go/y", body: "y" })])],
		["missing go binary", goTarGz(tarEntry({ name: "go/VERSION", body: goVersionFile }))],
		["other version", goTarGz(tarEntry({ name: "go/VERSION", body: "go1.25.13\n" }), tarEntry({ name: "go/bin/go", body: "x", mode: 0o755 }))],
		["not a tar", gzipSync(Buffer.from("not a tar archive"))],
		["zip symlink", goZip([{ name: "go/VERSION", body: goVersionFile }, { name: "go/bin/go.exe", body: "MZ" }, { name: "go/link", body: "/etc", mode: 0o120777 }])],
		["zip traversal", goZip([{ name: "go/VERSION", body: goVersionFile }, { name: "go/bin/go.exe", body: "MZ" }, { name: "go/../../escape", body: "x" }])],
	];
	for (const [label, bytes] of unsafe) {
		const r = goRoot();
		try {
			const platform = label.startsWith("zip") ? "win32" : "darwin";
			await assert.rejects(acquireGo({ root: r.root, platform, arch: "arm64", adapters: goAdapters(bytes) }), /Go verified acquisition failed/, label);
			assert.deepEqual(readdirSync(r.root), [], label);
			assert.equal(existsSync(join(r.base, "escape")), false, label);
		} finally { r.cleanup(); }
	}
});

test("an existing Go destination the installer did not publish is never replaced", async () => {
	const r = goRoot();
	try {
		mkdirSync(join(r.root, "1.25.14", "go", "bin"), { recursive: true });
		writeFileSync(join(r.root, "1.25.14", "go", "bin", "go"), "user's own");
		const counter = { downloads: 0 };
		// The cause names the folder in the way, so the wizard can say which one to remove.
		await assert.rejects(acquireGo({ root: r.root, platform: "darwin", arch: "arm64", adapters: goAdapters(goTree(), counter) }),
			(error: Error) => /Go verified acquisition failed/.test(error.message) &&
				(error.cause as Error)?.message === `Conflicting Go destination: ${join(r.root, "1.25.14")}`);
		assert.equal(counter.downloads, 0, "nothing is downloaded next to a conflicting folder");
		assert.equal(readFileSync(join(r.root, "1.25.14", "go", "bin", "go"), "utf8"), "user's own");
		assert.deepEqual(readdirSync(r.root), ["1.25.14"]);
		assert.equal(installedGo(r.root, "darwin", "arm64"), null);
	} finally { r.cleanup(); }
});

test("the pinned Go destination appears only complete and marked, so an interrupted run never leaves it half published", async () => {
	const r = goRoot();
	const destination = join(r.root, "1.25.14");
	const marker = join(destination, ".gentle-shell-go");
	const violations: string[] = [];
	const originals = { mkdirSync: fs.mkdirSync, renameSync: fs.renameSync, writeFileSync: fs.writeFileSync };
	// Every filesystem mutation is a point where the process could die: after each
	// one, the destination is either absent or already carries its marker.
	for (const name of Object.keys(originals) as Array<keyof typeof originals>) {
		(fs as Record<string, unknown>)[name] = (...args: unknown[]) => {
			const result = (originals[name] as (...a: unknown[]) => unknown)(...args);
			if (existsSync(destination) && !existsSync(marker)) violations.push(`${name} ${String(args[0])}`);
			return result;
		};
	}
	syncBuiltinESMExports();
	try {
		// A staging directory left by an earlier interrupted run does not get in the way.
		mkdirSync(join(r.root, ".stage-interrupted", "go"), { recursive: true, mode: 0o700 });
		const result = await acquireGo({ root: r.root, platform: "darwin", arch: "arm64", adapters: goAdapters(goTree()) });
		assert.equal(result.acquired, true);
		assert.deepEqual(violations, []);
		assert.equal(readFileSync(marker, "utf8"), `${artifactFor("go", "darwin", "arm64").url}\n`);
		if (process.platform !== "win32") assert.equal(lstatSync(destination).mode & 0o077, 0);
		assert.equal(installedGo(r.root, "darwin", "arm64"), result.goPath);
	} finally {
		Object.assign(fs, originals);
		syncBuiltinESMExports();
		r.cleanup();
	}
});

// CI runs the "native Windows" lane on windows-latest and requires every one of
// those tests to pass with 0 skips: its count is the real number of native tests,
// the literal ones plus one per pre-Node process primitive mode.
test("the CI native Windows gate requires exactly the native tests the Windows bootstrap suite defines", () => {
	const source = readFileSync(new URL("./installer-windows-bootstrap.test.ts", import.meta.url), "utf8");
	const literal = source.match(/^test\("native Windows[^"]*"/gm)?.length ?? 0;
	const modes = /^const probeModes = \[([^\]]*)\] as const;$/m.exec(source)?.[1].split(",").filter((mode) => mode.trim().length > 0).length ?? 0;
	assert.ok(/^for \(const mode of probeModes\) \{\n\ttest\(`native Windows: /m.test(source.slice(source.indexOf("const probeModes"))));
	const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
	const gate = /\[int\]\$passes\.Groups\[1\]\.Value -ne (\d+) -or/.exec(ci);
	assert.ok(gate, "the gate compares the passed count exactly");
	assert.ok(/\[int\]\$skips\.Groups\[1\]\.Value -ne 0/.test(ci), "0 skips stays required");
	assert.equal(literal + modes, 37);
	assert.equal(Number(gate[1]), literal + modes);
});
