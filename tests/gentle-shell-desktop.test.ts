import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	desktopUsage,
	HERDR_APP_RELEASE,
	HERDR_APP_VERSION,
	isShippedModFile,
	nodeDesktopIO,
	runDesktop,
	type DesktopContext,
	type HerdrAppRelease,
} from "../lib/gentle-shell-desktop.ts";

// `gentle-shell desktop` against an isolated HOME, a fake package herdr/ folder
// and a fake `herdr-app` (a shell script that logs its calls). Nothing is ever
// downloaded: `download` is injected and writes a local fake release.

const FAKE_HERDR = `#!/bin/sh
state="$FAKE_HERDR_DIR"
printf '%s\\n' "$*" >> "$state/calls.log"
case "$1" in
  --version) printf 'herdr-app %s\\n' "\${FAKE_VERSION:-$(cat "$state/version")}" ;;
  status)
    [ -f "$state/running" ] || { echo "herdr-app: no Herdr window" >&2; exit 2; }
    printf '{"layout":"%s","errors":[]}\\n' "$(cat "$state/layout" 2>/dev/null || echo main)" ;;
  check)
    name=$(basename "$2")
    case " $FAKE_HERDR_FAIL " in *" $name "*) echo "SyntaxError in $name/main.js" >&2; echo "check failed: $2"; exit 1 ;; esac
    [ -f "$2/main.js" ] || { echo "check failed: $2"; exit 1; }
    echo "check passed: $2" ;;
  ls) cat "$state/ls.json" 2>/dev/null || echo '{"spaces":[]}' ;;
  do)
    [ -f "$state/running" ] || exit 2
    if [ "$2" = layout.switch ]; then printf '%s' "$3" | sed -n 's/.*"name":"\\([^"]*\\)".*/\\1/p' > "$state/layout"; fi ;;
  "") touch "$state/running" ;;
esac
`;

interface Fixture {
	root: string;
	home: string;
	bin: string;
	state: string;
	pkg: string;
	cwd: string;
	herdrHome: string;
	calls: () => string[];
	out: string[];
	err: string[];
	questions: string[];
}

function fixture(t: TestContext): Fixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gs-desktop-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const bin = join(root, "bin");
	const state = join(root, "herdr-state");
	const pkg = join(root, "pkg");
	const cwd = join(root, "project");
	for (const dir of [home, bin, state, cwd]) mkdirSync(dir, { recursive: true });
	for (const name of ["gentle-a", "gentle-b"]) {
		const mod = join(pkg, "herdr", "mods", name);
		mkdirSync(join(mod, "icons"), { recursive: true });
		writeFileSync(join(mod, "main.js"), `// ${name} v2\n`);
		writeFileSync(join(mod, "mod.json"), `{"name":"${name}"}\n`);
		writeFileSync(join(mod, "icons", "x.svg"), "<svg/>\n");
		writeFileSync(join(mod, "gpui-kit.d.ts"), "// generated\n");
		writeFileSync(join(mod, "jsconfig.json"), "{}\n");
		writeFileSync(join(mod, ".gitignore"), "gpui-kit.d.ts\n");
		writeFileSync(join(mod, "SPIKE.md"), "notes\n");
		writeFileSync(join(mod, "FIDELITY.md"), "notes\n");
	}
	mkdirSync(join(pkg, "herdr", "layouts"), { recursive: true });
	writeFileSync(join(pkg, "herdr", "layouts", "gentle-shell.json"), "{\"id\":\"root\",\"v\":2}\n");
	writeFileSync(join(pkg, "herdr", "FIDELITY-T6.md"), "notes\n");
	const herdrHome = join(home, ".config", "herdr-app");
	const calls = () => existsSync(join(state, "calls.log")) ? readFileSync(join(state, "calls.log"), "utf8").trim().split("\n") : [];
	return { root, home, bin, state, pkg, cwd, herdrHome, calls, out: [], err: [], questions: [] };
}

function installFakeHerdr(path: string, version: string, state: string) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, FAKE_HERDR, { mode: 0o755 });
	chmodSync(path, 0o755);
	writeFileSync(join(state, "version"), `${version}\n`);
}

// A fake release tarball holding Herdr.app (macOS) or herdr-app/ (Linux) whose
// binary is the fake herdr-app reporting the pinned version.
function fakeRelease(f: Fixture, platform: "darwin" | "linux"): { tarball: string; release: HerdrAppRelease } {
	const build = join(f.root, "release-build");
	const body = FAKE_HERDR.replace('"${FAKE_VERSION:-$(cat "$state/version")}"', `"${HERDR_APP_VERSION}"`);
	if (platform === "darwin") {
		mkdirSync(join(build, "Herdr.app", "Contents", "MacOS"), { recursive: true });
		writeFileSync(join(build, "Herdr.app", "Contents", "MacOS", "Herdr"), body, { mode: 0o755 });
	} else {
		mkdirSync(join(build, "herdr-app"), { recursive: true });
		writeFileSync(join(build, "herdr-app", "herdr-app"), body, { mode: 0o755 });
		writeFileSync(join(build, "herdr-app", "herdr-app.svg"), "<svg/>\n");
	}
	const tarball = join(f.root, "release.tar.gz");
	const packed = spawnSync("tar", ["-czf", tarball, "-C", build, platform === "darwin" ? "Herdr.app" : "herdr-app"]);
	assert.equal(packed.status, 0, String(packed.stderr));
	const sum = createHash("sha256").update(readFileSync(tarball)).digest("hex");
	const target = platform === "darwin" ? "macos-aarch64" : "linux-x86_64";
	return { tarball, release: { version: HERDR_APP_VERSION, sha256: { [target]: sum } } };
}

function context(f: Fixture, overrides: Partial<DesktopContext> & { answer?: string; downloads?: string[]; tarball?: string; fail?: string } = {}): DesktopContext {
	const { answer, downloads, tarball, fail, ...rest } = overrides;
	const base = nodeDesktopIO();
	return {
		args: [],
		env: { HOME: f.home, PATH: `${f.bin}:/usr/bin:/bin`, FAKE_HERDR_DIR: f.state, ...(fail ? { FAKE_HERDR_FAIL: fail } : {}) },
		home: f.home,
		platform: "darwin",
		arch: "arm64",
		cwd: f.cwd,
		interactive: true,
		packageRoot: f.pkg,
		shellVersion: "9.9.9",
		...rest,
		io: {
			...base,
			sleep: () => new Promise((resolve) => setTimeout(resolve, 20)),
			verifyMacSignature: () => undefined,
			download: async (url: string, file: string) => {
				downloads?.push(url);
				if (!tarball) throw new Error(`unexpected download of ${url}`);
				cpSync(tarball, file);
			},
			ask: async (question: string) => {
				f.questions.push(question);
				return answer ?? "";
			},
			out: (line: string) => f.out.push(line),
			err: (line: string) => f.err.push(line),
			...(rest.io ?? {}),
		},
	};
}

function tree(dir: string): Record<string, string> {
	const result: Record<string, string> = {};
	if (!existsSync(dir)) return result;
	const walk = (path: string, rel: string) => {
		for (const name of readdirSync(path).sort()) {
			const full = join(path, name);
			const key = rel ? `${rel}/${name}` : name;
			if (lstatSync(full).isDirectory()) walk(full, key);
			else result[key] = readFileSync(full, "utf8");
		}
	};
	walk(dir, "");
	return result;
}

function seedUserFiles(f: Fixture) {
	mkdirSync(join(f.herdrHome, "mods", "agents"), { recursive: true });
	mkdirSync(join(f.herdrHome, "mods", "gentle-custom"), { recursive: true });
	mkdirSync(join(f.herdrHome, "layouts"), { recursive: true });
	writeFileSync(join(f.herdrHome, "mods", "agents", "main.js"), "// user agents\n");
	writeFileSync(join(f.herdrHome, "mods", "gentle-custom", "main.js"), "// a user mod named gentle-*\n");
	writeFileSync(join(f.herdrHome, "layouts", "main.json"), "{\"user\":true}\n");
	writeFileSync(join(f.herdrHome, "settings.json"), "{\"theme\":\"mine\"}\n");
}

const userKeys = ["mods/agents/main.js", "mods/gentle-custom/main.js", "layouts/main.json", "settings.json"];
const userSnapshot = (f: Fixture) => Object.fromEntries(Object.entries(tree(f.herdrHome)).filter(([key]) => userKeys.includes(key)));

test("pins Herdr app 0.1.15 with the SHA-256 of every official release target", () => {
	assert.equal(HERDR_APP_VERSION, "0.1.15");
	assert.equal(HERDR_APP_RELEASE.version, "0.1.15");
	assert.deepEqual(Object.keys(HERDR_APP_RELEASE.sha256).sort(), ["linux-aarch64", "linux-x86_64", "macos-aarch64", "windows-x86_64"]);
	assert.equal(HERDR_APP_RELEASE.sha256["macos-aarch64"], "3633ea5d868ea410f84dfbb77a26205de331f4df52fdb3fb006b2b3978458459");
	for (const sum of Object.values(HERDR_APP_RELEASE.sha256)) assert.match(sum, /^[0-9a-f]{64}$/);
});

test("ships mod files except Herdr's generated types and our design notes", () => {
	for (const name of ["main.js", "mod.json", "snapshot.js", "x.svg", "README.md"]) assert.equal(isShippedModFile(name), true, name);
	for (const name of ["gpui-kit.d.ts", "jsconfig.json", ".gitignore", "SPIKE.md", "FIDELITY.md", "FIDELITY-T6.md"]) assert.equal(isShippedModFile(name), false, name);
});

test("package.json ships herdr/ without generated types and notes; the desktop feed loads from ./extensions", () => {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	for (const entry of ["herdr/", "!herdr/**/gpui-kit.d.ts", "!herdr/**/jsconfig.json", "!herdr/**/.gitignore", "!herdr/**/FIDELITY*.md", "!herdr/**/SPIKE*.md"]) {
		assert.ok(manifest.files.includes(entry), entry);
	}
	assert.ok(manifest.pi.extensions.includes("./extensions"));
	assert.ok(existsSync(new URL("../herdr/layouts/gentle-shell.json", import.meta.url)));
});

test("fresh install asks, downloads the pinned release, installs mods and layout, checks, starts Herdr and switches", async (t) => {
	const f = fixture(t);
	seedUserFiles(f);
	const before = userSnapshot(f);
	const { tarball, release } = fakeRelease(f, "darwin");
	const downloads: string[] = [];
	const code = await runDesktop(context(f, { answer: "y", downloads, tarball, release }));
	assert.equal(code, 0, f.err.join("\n"));
	assert.deepEqual(f.questions, ["Install Gentle Shell Desktop as shown above? [y/N] "]);
	assert.deepEqual(downloads, [`https://releases.herdr.dev/app/${HERDR_APP_VERSION}/herdr-app-macos-aarch64.tar.gz`]);
	const app = join(f.home, "Applications", "Herdr.app");
	const plan = f.out.join("\n");
	assert.match(plan, new RegExp(`install Herdr app ${HERDR_APP_VERSION} \\(macos-aarch64\\) into ${app}`));
	assert.ok(plan.includes(`from https://releases.herdr.dev/app/${HERDR_APP_VERSION}/herdr-app-macos-aarch64.tar.gz`));
	assert.ok(plan.includes(`verified against SHA-256 ${release.sha256["macos-aarch64"]}`));
	assert.ok(plan.includes(`install mods gentle-a, gentle-b into ${join(f.herdrHome, "mods")}`));
	assert.ok(plan.includes(`install layout gentle-shell into ${join(f.herdrHome, "layouts", "gentle-shell.json")}`));
	assert.ok(existsSync(join(app, "Contents", "MacOS", "Herdr")));
	assert.equal(readlinkSync(join(f.home, ".local", "bin", "herdr-app")), join(app, "Contents", "MacOS", "Herdr"));
	assert.deepEqual(Object.keys(tree(join(f.herdrHome, "mods", "gentle-a"))), ["icons/x.svg", "main.js", "mod.json"]);
	assert.equal(readFileSync(join(f.herdrHome, "layouts", "gentle-shell.json"), "utf8"), "{\"id\":\"root\",\"v\":2}\n");
	const calls = f.calls();
	for (const mod of ["gentle-a", "gentle-b"]) assert.ok(calls.includes(`check ${join(f.herdrHome, "mods", mod)}`), mod);
	assert.ok(calls.includes(""), "starts the Herdr window");
	assert.ok(calls.includes('do layout.switch {"name":"gentle-shell"}'));
	assert.ok(calls.includes(`do space.new ${JSON.stringify({ folder: f.cwd, argv: ["gentle-shell"] })}`));
	assert.ok(calls.indexOf(`check ${join(f.herdrHome, "mods", "gentle-b")}`) < calls.indexOf('do layout.switch {"name":"gentle-shell"}'));
	assert.deepEqual(userSnapshot(f), before);
	assert.equal(readFileSync(join(f.state, "layout"), "utf8"), "gentle-shell");
});

test("already installed Herdr app: no download, and an up-to-date second run just opens without asking", async (t) => {
	const f = fixture(t);
	installFakeHerdr(join(f.bin, "herdr-app"), "0.1.16", f.state);
	writeFileSync(join(f.state, "running"), "");
	writeFileSync(join(f.state, "ls.json"), JSON.stringify({ spaces: [{ folder: f.cwd, tabs: [{ terminals: [{ app: "gentle-shell" }] }] }] }));
	assert.equal(await runDesktop(context(f, { args: ["--yes"] })), 0, f.err.join("\n"));
	assert.deepEqual(f.questions, []);
	assert.ok(!f.out.join("\n").includes("install Herdr app"));
	assert.ok(existsSync(join(f.herdrHome, "mods", "gentle-b", "main.js")));
	assert.ok(!f.calls().some((call) => call.startsWith("do space.new")), "a Gentle Shell space already runs in this folder");
	f.out.length = 0;
	assert.equal(await runDesktop(context(f, { interactive: false })), 0, f.err.join("\n"));
	assert.deepEqual(f.questions, []);
	assert.ok(f.out.join("\n").includes("Gentle Shell Desktop is up to date"));
	assert.equal(f.calls().filter((call) => call === 'do layout.switch {"name":"gentle-shell"}').length, 2);
});

test("an older Herdr app in ~/.local/bin is replaced by the pinned release (Linux)", async (t) => {
	const f = fixture(t);
	const local = join(f.home, ".local", "bin", "herdr-app");
	installFakeHerdr(local, "0.1.10", f.state);
	const { tarball, release } = fakeRelease(f, "linux");
	const downloads: string[] = [];
	const code = await runDesktop(context(f, { platform: "linux", arch: "x64", args: ["--yes", "--no-open"], downloads, tarball, release }));
	assert.equal(code, 0, f.err.join("\n"));
	assert.deepEqual(downloads, [`https://releases.herdr.dev/app/${HERDR_APP_VERSION}/herdr-app-linux-x86_64.tar.gz`]);
	const data = join(f.home, ".local", "share", "herdr-app");
	assert.ok(f.out.join("\n").includes(`replace Herdr app 0.1.10 at ${local} with ${HERDR_APP_VERSION} (linux-x86_64) into ${data}`));
	assert.equal(readlinkSync(local), join(data, "herdr-app"));
	const version = spawnSync(local, ["--version"], { env: { FAKE_HERDR_DIR: f.state, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
	assert.equal(version.stdout.trim(), `herdr-app ${HERDR_APP_VERSION}`);
	assert.ok(f.calls().includes(`check ${join(f.herdrHome, "mods", "gentle-a")}`));
	assert.ok(!f.calls().includes(""), "--no-open never starts the window");
});

test("a download that does not match the pinned SHA-256 installs nothing", async (t) => {
	const f = fixture(t);
	const { tarball } = fakeRelease(f, "darwin");
	const code = await runDesktop(context(f, { args: ["--yes"], tarball }));
	assert.equal(code, 1);
	assert.match(f.err.join("\n"), /checksum mismatch/);
	assert.equal(existsSync(join(f.home, "Applications", "Herdr.app")), false);
	assert.equal(existsSync(join(f.herdrHome, "mods", "gentle-a")), false);
	assert.equal(existsSync(join(f.home, ".gentle-shell", "desktop", "state.json")), false);
});

test("a failing herdr-app check restores the previous gentle-* copies and never switches", async (t) => {
	const f = fixture(t);
	installFakeHerdr(join(f.bin, "herdr-app"), "0.1.15", f.state);
	writeFileSync(join(f.state, "running"), "");
	seedUserFiles(f);
	mkdirSync(join(f.herdrHome, "mods", "gentle-a"), { recursive: true });
	writeFileSync(join(f.herdrHome, "mods", "gentle-a", "main.js"), "// gentle-a v1\n");
	writeFileSync(join(f.herdrHome, "layouts", "gentle-shell.json"), "{\"v\":1}\n");
	const before = tree(f.herdrHome);
	const code = await runDesktop(context(f, { args: ["--yes"], fail: "gentle-b" }));
	assert.equal(code, 1);
	const message = f.err.join("\n");
	assert.match(message, /herdr-app check failed for gentle-b/);
	assert.match(message, /SyntaxError in gentle-b\/main\.js/);
	assert.match(message, /restored the previous Gentle mods and layout/);
	assert.deepEqual(tree(f.herdrHome), before);
	assert.ok(!f.calls().some((call) => call.startsWith("do ")));
	assert.equal(existsSync(join(f.home, ".gentle-shell", "desktop", "state.json")), false);
});

test("uninstall removes only our mods and layout, keeps a backup and switches back to the previous layout", async (t) => {
	const f = fixture(t);
	installFakeHerdr(join(f.bin, "herdr-app"), "0.1.15", f.state);
	writeFileSync(join(f.state, "running"), "");
	writeFileSync(join(f.state, "layout"), "win98");
	seedUserFiles(f);
	const before = userSnapshot(f);
	assert.equal(await runDesktop(context(f, { args: ["--yes"] })), 0, f.err.join("\n"));
	assert.equal(readFileSync(join(f.state, "layout"), "utf8"), "gentle-shell");
	f.out.length = 0;
	assert.equal(await runDesktop(context(f, { args: ["--uninstall"] })), 0, f.err.join("\n"));
	assert.ok(f.calls().includes('do layout.switch {"name":"win98"}'));
	assert.equal(existsSync(join(f.herdrHome, "mods", "gentle-a")), false);
	assert.equal(existsSync(join(f.herdrHome, "mods", "gentle-b")), false);
	assert.equal(existsSync(join(f.herdrHome, "layouts", "gentle-shell.json")), false);
	assert.deepEqual(userSnapshot(f), before);
	const backup = join(f.home, ".gentle-shell", "desktop", "backup");
	assert.ok(existsSync(join(backup, "mods", "gentle-a", "main.js")));
	assert.ok(existsSync(join(backup, "layouts", "gentle-shell.json")));
	assert.equal(existsSync(join(f.home, ".gentle-shell", "desktop", "state.json")), false);
	assert.ok(f.out.join("\n").includes(`Removed Gentle Shell Desktop mods and layout from ${f.herdrHome}; a copy is in ${backup}. Herdr app itself stays installed.`));
});

test("uninstall falls back to the main layout when none was recorded", async (t) => {
	const f = fixture(t);
	installFakeHerdr(join(f.bin, "herdr-app"), "0.1.15", f.state);
	writeFileSync(join(f.state, "running"), "");
	writeFileSync(join(f.state, "layout"), "gentle-shell");
	mkdirSync(join(f.herdrHome, "layouts"), { recursive: true });
	writeFileSync(join(f.herdrHome, "layouts", "gentle-shell.json"), "{}\n");
	assert.equal(await runDesktop(context(f, { args: ["--uninstall"] })), 0, f.err.join("\n"));
	assert.ok(f.calls().includes('do layout.switch {"name":"main"}'));
	assert.equal(existsSync(join(f.herdrHome, "layouts", "gentle-shell.json")), false);
});

test("--status prints versions and what is installed", async (t) => {
	const f = fixture(t);
	assert.equal(await runDesktop(context(f, { args: ["--status"] })), 0);
	assert.deepEqual(f.out, [
		"Gentle Shell Desktop",
		"  Gentle Shell: 9.9.9",
		`  Herdr app: not installed (needs ${HERDR_APP_VERSION} or newer)`,
		`  Herdr home: ${f.herdrHome}`,
		"  Layout gentle-shell: not installed",
		"  Mods: none installed (ships gentle-a, gentle-b)",
		"  Window: not running",
	]);
	installFakeHerdr(join(f.bin, "herdr-app"), "0.1.15", f.state);
	writeFileSync(join(f.state, "running"), "");
	assert.equal(await runDesktop(context(f, { args: ["--yes", "--no-open"] })), 0, f.err.join("\n"));
	f.out.length = 0;
	assert.equal(await runDesktop(context(f, { args: ["--status"] })), 0);
	assert.deepEqual(f.out, [
		"Gentle Shell Desktop",
		"  Gentle Shell: 9.9.9",
		`  Herdr app: 0.1.15 at ${join(f.bin, "herdr-app")} (needs ${HERDR_APP_VERSION} or newer)`,
		`  Herdr home: ${f.herdrHome}`,
		`  Layout gentle-shell: installed at ${join(f.herdrHome, "layouts", "gentle-shell.json")}`,
		`  Mods: gentle-a, gentle-b installed in ${join(f.herdrHome, "mods")}`,
		"  Window: running, layout main",
	]);
});

test("non-interactive without --yes refuses and writes nothing; declining also installs nothing", async (t) => {
	const f = fixture(t);
	installFakeHerdr(join(f.bin, "herdr-app"), "0.1.15", f.state);
	assert.equal(await runDesktop(context(f, { interactive: false })), 1);
	assert.deepEqual(f.questions, []);
	assert.deepEqual(f.err, ["gentle-shell desktop: nothing was installed. Run it in an interactive terminal to confirm, or pass --yes."]);
	assert.equal(existsSync(f.herdrHome), false);
	assert.equal(existsSync(join(f.home, ".gentle-shell")), false);
	f.err.length = 0;
	assert.equal(await runDesktop(context(f, { answer: "n" })), 1);
	assert.equal(f.questions.length, 1);
	assert.deepEqual(f.err, ["gentle-shell desktop: nothing was installed."]);
	assert.equal(existsSync(f.herdrHome), false);
});

test("--refresh updates installed mods without asking or opening, and does nothing when desktop was never installed", async (t) => {
	const f = fixture(t);
	installFakeHerdr(join(f.bin, "herdr-app"), "0.1.15", f.state);
	assert.equal(await runDesktop(context(f, { args: ["--refresh"], interactive: false })), 0);
	assert.equal(existsSync(f.herdrHome), false);
	assert.deepEqual(f.calls(), []);
	assert.equal(await runDesktop(context(f, { args: ["--yes", "--no-open"] })), 0, f.err.join("\n"));
	writeFileSync(join(f.pkg, "herdr", "mods", "gentle-a", "main.js"), "// gentle-a v3\n");
	f.out.length = 0;
	assert.equal(await runDesktop(context(f, { args: ["--refresh"], interactive: false })), 0, f.err.join("\n"));
	assert.deepEqual(f.questions, []);
	assert.equal(readFileSync(join(f.herdrHome, "mods", "gentle-a", "main.js"), "utf8"), "// gentle-a v3\n");
	assert.deepEqual(f.out, [`Gentle Shell Desktop: refreshed mods gentle-a, gentle-b and layout gentle-shell in ${f.herdrHome}.`]);
	assert.ok(!f.calls().includes(""));
});

test("usage errors exit 2 and --help prints the desktop usage", async (t) => {
	const f = fixture(t);
	assert.equal(await runDesktop(context(f, { args: ["--bogus"] })), 2);
	assert.deepEqual(f.err, ["gentle-shell desktop: unknown option --bogus", desktopUsage()]);
	f.err.length = 0;
	assert.equal(await runDesktop(context(f, { args: ["--status", "--uninstall"] })), 2);
	assert.deepEqual(f.err, ["gentle-shell desktop: choose one of --status, --uninstall or --refresh", desktopUsage()]);
	assert.equal(await runDesktop(context(f, { args: ["--help"] })), 0);
	assert.deepEqual(f.out, [desktopUsage()]);
	assert.match(desktopUsage(), /^Usage: gentle-shell desktop \[--yes\] \[--no-open\]\n {7}gentle-shell desktop --status\n {7}gentle-shell desktop --uninstall\n/);
});

test("the real package herdr/ folder ships gentle-* mods and the gentle-shell layout", async (t) => {
	const f = fixture(t);
	const packageRoot = realpathSync(new URL("..", import.meta.url));
	assert.equal(await runDesktop(context(f, { args: ["--status"], packageRoot })), 0);
	const mods = f.out.find((line) => line.startsWith("  Mods:"));
	assert.match(mods ?? "", /^ {2}Mods: none installed \(ships gentle-[a-z-]+(, gentle-[a-z-]+)*\)$/);
	assert.ok(mods?.includes("gentle-chat"));
});
