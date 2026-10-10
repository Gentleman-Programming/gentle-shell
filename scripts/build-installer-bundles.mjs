#!/usr/bin/env node
// Double-click installers: one unsigned download per system that opens the
// browser installation wizard with no git, clone or typed command.
//
// Each archive holds a launcher next to an `installer/` folder with the
// wizard's own files (they import only `node:` modules, so no dependencies).
// The launcher runs the bundled bootstrap, which fetches Node.js and pnpm when
// they are missing and opens the wizard in the browser. Real files only: the
// bootstrap refuses symlinked bundle files.
//
//   node scripts/build-installer-bundles.mjs --out <folder>
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installerPaths } from "./verify-package-files.mjs";

/** Stable names, so `releases/latest/download/<name>` always points at the newest release. */
const MACOS_ASSET = "gentle-shell-installer-macos.zip";
const WINDOWS_ASSET = "gentle-shell-installer-windows.zip";
const LINUX_ASSET = "gentle-shell-installer-linux.tar.gz";
export const INSTALLER_ASSETS = Object.freeze([MACOS_ASSET, WINDOWS_ASSET, LINUX_ASSET]);
export const INSTALLER_CHECKSUMS = "gentle-shell-installers-SHA256SUMS.txt";

// Static and dynamic imports, and files a module reads next to itself through
// `new URL("./file.ext", import.meta.url)`. Folder URLs (a trailing slash) are not
// followed: their files are listed in installerPaths.
const RELATIVE_REFERENCE = /(?:from\s+|import\s*\(\s*|new URL\(\s*)["'](\.{1,2}\/[^"']*[^/"'])["']/g;

/** Relative module and file references in a module's source. */
export function relativeReferences(text) {
	return [...text.matchAll(RELATIVE_REFERENCE)].map((match) => match[1]);
}

/** Wizard files, package.json and everything their modules import, sorted. */
export function bundleFiles(root) {
	const files = new Set(["package.json", ...installerPaths]);
	const pending = [...files].filter((path) => path.endsWith(".mjs"));
	while (pending.length > 0) {
		const file = pending.pop();
		for (const specifier of relativeReferences(readFileSync(join(root, file), "utf8"))) {
			const target = posix.normalize(posix.join(posix.dirname(file), specifier));
			if (files.has(target)) continue;
			if (!existsSync(join(root, target))) throw new Error(`${file} imports ${specifier}, which does not exist`);
			files.add(target);
			if (target.endsWith(".mjs")) pending.push(target);
		}
	}
	return [...files].sort();
}

const unixLauncher = (title) => [
	"#!/bin/sh",
	`# ${title}: double-click to install or update Gentle Shell.`,
	"# It runs the bundled bootstrap, which opens the installation wizard in your browser.",
	'cd "$(dirname "$0")" || exit 1',
	'sh "./installer/scripts/bootstrap.sh"',
	"status=$?",
	'if [ "$status" -eq 0 ]; then',
	'	printf "\\n%s\\n" "You can close this window."',
	"else",
	'	printf "\\n%s\\n" "The installer stopped. Read the messages above, then close this window."',
	"fi",
	'exit "$status"',
	"",
].join("\n");

const windowsLauncher = [
	"@echo off",
	"rem Double-click to install or update Gentle Shell.",
	"rem It runs the bundled bootstrap, which opens the installation wizard in your browser.",
	'call "%~dp0installer\\scripts\\bootstrap.cmd"',
	"echo.",
	"if errorlevel 1 (",
	"  echo The installer stopped. Read the messages above, then close this window.",
	") else (",
	"  echo You can close this window.",
	")",
	"pause",
	"",
].join("\r\n");

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`);
}

function stage(root, folder, files, launcher) {
	mkdirSync(folder, { recursive: true });
	for (const file of files) {
		const target = join(folder, "installer", file);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(join(root, file), target);
		if (file.endsWith(".sh")) chmodSync(target, 0o755);
	}
	const path = join(folder, launcher.name);
	writeFileSync(path, launcher.content);
	chmodSync(path, 0o755);
}

/** Builds the three downloads and their checksums into `outDir`; returns their paths. */
export function buildInstallerBundles({ root, outDir }) {
	const files = bundleFiles(root);
	const work = mkdtempSync(join(tmpdir(), "gentle-shell-installers-"));
	try {
		mkdirSync(outDir, { recursive: true });
		const zipped = (asset, folder, launcher) => {
			stage(root, join(work, asset, folder), files, launcher);
			rmSync(join(outDir, asset), { force: true });
			run("zip", ["-q", "-r", join(outDir, asset), folder], join(work, asset));
		};
		zipped(MACOS_ASSET, "Gentle Shell Installer", { name: "Install Gentle Shell.command", content: unixLauncher("macOS") });
		zipped(WINDOWS_ASSET, "Gentle Shell Installer", { name: "Install Gentle Shell.cmd", content: windowsLauncher });
		const linux = join(work, LINUX_ASSET);
		stage(root, join(linux, "gentle-shell-installer"), files, { name: "install-gentle-shell.sh", content: unixLauncher("Linux") });
		run("tar", ["-czf", join(outDir, LINUX_ASSET), "gentle-shell-installer"], linux);
		const sums = INSTALLER_ASSETS.map((asset) => `${createHash("sha256").update(readFileSync(join(outDir, asset))).digest("hex")}  ${asset}\n`);
		writeFileSync(join(outDir, INSTALLER_CHECKSUMS), sums.join(""));
		return [...INSTALLER_ASSETS, INSTALLER_CHECKSUMS].map((asset) => join(outDir, asset));
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const at = process.argv.indexOf("--out");
	const out = at === -1 ? undefined : process.argv[at + 1];
	if (!out || process.argv.length !== 4) {
		console.error("usage: node scripts/build-installer-bundles.mjs --out <folder>");
		process.exit(2);
	}
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	for (const path of buildInstallerBundles({ root, outDir: resolve(out) })) console.log(path);
}
