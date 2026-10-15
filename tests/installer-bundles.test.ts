import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { INSTALLER_ASSETS, buildInstallerBundles, bundleFiles, relativeReferences } from "../scripts/build-installer-bundles.mjs";
import { installerPaths } from "../scripts/verify-package-files.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const posixOnly = { skip: process.platform === "win32" };
// Independent of the builder's scanner on purpose: imports and file URLs next to the module.
const relativeImports = (text: string) => [...text.matchAll(/(?:from\s+|import\s*\(\s*|new URL\(\s*)["'](\.{1,2}\/[^"']+\.[a-z]+)["']/g)].map((match) => match[1]);

test("the scanner follows imports and files a module reads next to itself, but not folders", () => {
	const text = [
		'import { a } from "./a.mjs";',
		'const b = await import("../b.mjs");',
		'const data = readFileSync(new URL("./data.json", import.meta.url));',
		'const assets = new URL("../assets/wizard/", import.meta.url);',
		'import x from "node:fs";',
	].join("\n");
	assert.deepEqual(relativeReferences(text), ["./a.mjs", "../b.mjs", "./data.json"]);
});

test("the bundle holds every wizard file, package.json and everything they import, and nothing from tests", () => {
	const files = bundleFiles(root);
	for (const path of [...installerPaths, "package.json"]) assert.ok(files.includes(path), path);
	for (const file of files.filter((path) => path.endsWith(".mjs"))) {
		for (const specifier of relativeImports(readFileSync(join(root, file), "utf8"))) {
			const target = join(dirname(file), specifier).replaceAll("\\", "/");
			assert.ok(files.includes(target), `${file} imports ${specifier}, missing from the bundle`);
		}
	}
	assert.equal(files.some((path) => path.startsWith("tests/") || path.startsWith("node_modules/")), false);
	assert.deepEqual([...files].sort(), files, "sorted, so the archives are reproducible in content");
});

function build() {
	const out = realpathSync(mkdtempSync(join(tmpdir(), "installer-bundles-")));
	const artifacts = buildInstallerBundles({ root, outDir: out });
	return { out, artifacts, cleanup: () => rmSync(out, { recursive: true, force: true }) };
}
const listing = (command: string, args: string[]) => spawnSync(command, args, { encoding: "utf8" }).stdout;

test("one download per system, with stable names and SHA-256 checksums", posixOnly, () => {
	const b = build();
	try {
		assert.deepEqual(INSTALLER_ASSETS, ["gentle-shell-installer-macos.zip", "gentle-shell-installer-windows.zip", "gentle-shell-installer-linux.tar.gz"]);
		assert.deepEqual(b.artifacts.map((path: string) => path.slice(b.out.length + 1)), [...INSTALLER_ASSETS, "gentle-shell-installers-SHA256SUMS.txt"]);
		const sums = readFileSync(join(b.out, "gentle-shell-installers-SHA256SUMS.txt"), "utf8");
		for (const name of INSTALLER_ASSETS) {
			const digest = createHash("sha256").update(readFileSync(join(b.out, name))).digest("hex");
			assert.ok(sums.includes(`${digest}  ${name}\n`), name);
		}
	} finally { b.cleanup(); }
});

test("macOS and Linux double-click launchers are executable and start the bundled bootstrap", posixOnly, () => {
	const b = build();
	try {
		const mac = listing("zipinfo", [join(b.out, "gentle-shell-installer-macos.zip")]);
		assert.match(mac, /^-rwxr-xr-x .* Gentle Shell Installer\/Install Gentle Shell\.command$/m);
		assert.match(mac, / Gentle Shell Installer\/installer\/bin\/gentle-shell-install\.mjs$/m);
		const linux = listing("tar", ["-tvzf", join(b.out, "gentle-shell-installer-linux.tar.gz")]);
		assert.match(linux, /^-rwxr-xr-x .* gentle-shell-installer\/install-gentle-shell\.sh$/m);
		const launcher = listing("unzip", ["-p", join(b.out, "gentle-shell-installer-macos.zip"), "Gentle Shell Installer/Install Gentle Shell.command"]);
		assert.match(launcher, /^#!\/bin\/sh\n/);
		assert.ok(launcher.includes('sh "./installer/scripts/bootstrap.sh"'));
		assert.match(launcher, /if \[ "\$status" -eq 0 \]; then/, "only a successful run says the window can be closed");
		assert.ok(launcher.includes("The installer stopped. Read the messages above"));
	} finally { b.cleanup(); }
});

test("the Windows launcher is a CRLF batch file that calls the bundled bootstrap and keeps its window open", posixOnly, () => {
	const b = build();
	try {
		const zip = join(b.out, "gentle-shell-installer-windows.zip");
		const launcher = listing("unzip", ["-p", zip, "Gentle Shell Installer/Install Gentle Shell.cmd"]);
		assert.ok(launcher.split("\n").slice(0, -1).every((line: string) => line.endsWith("\r")), "CRLF line endings");
		assert.ok(launcher.includes('call "%~dp0installer\\scripts\\bootstrap.cmd"'));
		assert.ok(launcher.includes("pause"));
		assert.ok(launcher.includes("if errorlevel 1 ("), "a failed bootstrap is reported");
		assert.ok(launcher.includes("The installer stopped. Read the messages above"));
		assert.match(listing("unzip", ["-p", zip, "Gentle Shell Installer/installer/scripts/bootstrap.cmd"]), /\r\n/);
	} finally { b.cleanup(); }
});

test("an extracted bundle runs on its own: real files only, and every wizard module loads", posixOnly, () => {
	const b = build();
	const target = realpathSync(mkdtempSync(join(tmpdir(), "installer-extract-")));
	try {
		assert.equal(spawnSync("tar", ["-xzf", join(b.out, "gentle-shell-installer-linux.tar.gz"), "-C", target]).status, 0);
		const bundle = join(target, "gentle-shell-installer", "installer");
		for (const file of bundleFiles(root)) {
			assert.ok(existsSync(join(bundle, file)), file);
			assert.equal(lstatSync(join(bundle, file)).isSymbolicLink(), false, file);
		}
		// Paths go through the environment: as argv[1] the wizard entry would think it was run and start.
		const load = spawnSync(process.execPath, ["--input-type=module", "-e",
			"for (const m of process.env.BUNDLE_MODULES.split('\\n')) await import(m); console.log('loaded')"],
			{ cwd: tmpdir(), encoding: "utf8", timeout: 30_000,
				env: { ...process.env, BUNDLE_MODULES: [join(bundle, "bin/gentle-shell-install.mjs"), join(bundle, "scripts/installer-downloads.mjs")].join("\n") } });
		assert.equal(load.status, 0, load.stderr);
		assert.equal(load.stdout.trim(), "loaded");
	} finally {
		b.cleanup();
		rmSync(target, { recursive: true, force: true });
	}
});

test("the builder command writes the downloads to the requested folder", posixOnly, () => {
	const out = realpathSync(mkdtempSync(join(tmpdir(), "installer-cli-")));
	try {
		mkdirSync(join(out, "dist"));
		const result = spawnSync(process.execPath, [join(root, "scripts/build-installer-bundles.mjs"), "--out", join(out, "dist")], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		for (const name of INSTALLER_ASSETS) assert.ok(existsSync(join(out, "dist", name)), name);
	} finally { rmSync(out, { recursive: true, force: true }); }
});
