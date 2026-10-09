import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync, rmSync, lstatSync, unlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { artifactFor, verifiedDownload, compatibleEngine, ensurePnpm, launchWizard, bootstrap, removeOwnedTools } from "../scripts/installer-downloads.mjs";

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
		f.addNode(); f.addPnpm("12.0.0"); f.wizard();
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
for (const version of ["v22.18.0", "v24.1.0-rc.1", "v25.00.1", "banana"]) {
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
function standalonePnpm(f: ReturnType<typeof fixture>, header: number[], linked = false) {
	const installs = join(f.root, "mise/installs/pnpm/10.27.0");
	mkdirSync(installs, { recursive: true });
	const binary = join(installs, "pnpm");
	writeFileSync(binary, Buffer.concat([Buffer.from(header), Buffer.alloc(64)]), { mode: 0o755 });
	if (linked) symlinkSync(binary, join(f.bin, "pnpm"));
	else writeFileSync(join(f.bin, "pnpm"), Buffer.concat([Buffer.from(header), Buffer.alloc(64)]), { mode: 0o755 });
}
const standaloneProcess = (version: string, calls: string[][] = []) => (_command: string, args: string[]) => {
	calls.push(args);
	return args.at(-1) === "--version" ? version : " --global ";
};
posixTest("a standalone native pnpm (mise, pnpm installer) is reused after version and capability proof", async () => {
	for (const [label, header] of Object.entries(nativeHeaders)) {
		for (const linked of [false, true]) {
			const f = fixture();
			try {
				standalonePnpm(f, header, linked);
				const calls: string[][] = [];
				const result = await ensurePnpm({ tools: f.home, env: { PATH: f.bin }, nodeVersion: "24.21.0", adapters: {
					process: standaloneProcess("10.27.0", calls), download: () => { throw new Error("must not download"); },
				} });
				assert.equal(result.acquired, false, `${label} linked=${linked}`);
				assert.deepEqual(calls, [["--version"], ["help", "add"], ["help", "bin"]], `${label} linked=${linked}`);
				assert.deepEqual(readdirSync(f.home), [], "no private tooling is created");
			} finally { f.cleanup(); }
		}
	}
});
posixTest("a standalone native pnpm without a semver version or global capability still blocks", async () => {
	const f = fixture();
	try {
		standalonePnpm(f, nativeHeaders["Mach-O 64-bit"]);
		const adapters = (process: (command: string, args: string[]) => string) => ({ process, download: () => { throw new Error("must not download"); } });
		for (const version of ["", "10.27", "not pnpm", "10.27.0-beta.1"]) {
			await assert.rejects(ensurePnpm({ tools: f.home, env: { PATH: f.bin }, nodeVersion: "24.21.0", adapters: adapters(standaloneProcess(version)) }), /pnpm version rejected/, version);
		}
		await assert.rejects(ensurePnpm({ tools: f.home, env: { PATH: f.bin }, nodeVersion: "24.21.0", adapters: adapters((_c, args) => args.at(-1) === "--version" ? "10.27.0" : "no global flag") }),
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
