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
	supportsDesktop,
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
  "")
    touch "$state/running"
    # Herdr writes its default keys.json when the window first starts and none exists.
    if [ -f "$state/default-keys.json" ] && [ ! -f "$HOME/.config/herdr-app/keys.json" ]; then
      mkdir -p "$HOME/.config/herdr-app" && cp "$state/default-keys.json" "$HOME/.config/herdr-app/keys.json"
    fi ;;
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

test("pins Herdr app 0.1.16 with the SHA-256 of every official release target", () => {
	assert.equal(HERDR_APP_VERSION, "0.1.16");
	assert.equal(HERDR_APP_RELEASE.version, "0.1.16");
	assert.deepEqual(Object.keys(HERDR_APP_RELEASE.sha256).sort(), ["linux-aarch64", "linux-x86_64", "macos-aarch64", "windows-x86_64"]);
	assert.equal(HERDR_APP_RELEASE.sha256["macos-aarch64"], "99000875ead9333a33f5cb60274ccd9cf9d3e47360f03613a467295105c71c04");
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
	// The staged copies are checked, so a running window never loads an unchecked mod.
	const stage = join(f.home, ".gentle-shell", "desktop", "stage", "mods");
	for (const mod of ["gentle-a", "gentle-b"]) assert.ok(calls.includes(`check ${join(stage, mod)}`), mod);
	assert.ok(!calls.some((call) => call.startsWith(`check ${join(f.herdrHome, "mods")}`)), "never checks the live copies");
	assert.ok(calls.includes(""), "starts the Herdr window");
	assert.ok(calls.includes('do layout.switch {"name":"gentle-shell"}'));
	assert.ok(calls.includes(`do space.new ${JSON.stringify({ folder: f.cwd, argv: ["gentle-shell"] })}`));
	assert.ok(calls.indexOf(`check ${join(stage, "gentle-b")}`) < calls.indexOf('do layout.switch {"name":"gentle-shell"}'));
	assert.deepEqual(userSnapshot(f), before);
	assert.equal(readFileSync(join(f.state, "layout"), "utf8"), "gentle-shell");
});

test("already installed Herdr app: no download, and an up-to-date second run just opens without asking", async (t) => {
	const f = fixture(t);
	installFakeHerdr(join(f.bin, "herdr-app"), "0.1.17", f.state);
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
	assert.ok(f.calls().includes(`check ${join(f.home, ".gentle-shell", "desktop", "stage", "mods", "gentle-a")}`));
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
	installFakeHerdr(join(f.bin, "herdr-app"), HERDR_APP_VERSION, f.state);
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
	assert.match(message, new RegExp(`the Gentle mods and layout were not installed; nothing in ${f.herdrHome} was changed`));
	assert.deepEqual(tree(f.herdrHome), before);
	assert.ok(!f.calls().some((call) => call.startsWith("do ")));
	assert.equal(existsSync(join(f.home, ".gentle-shell", "desktop", "state.json")), false);
});

test("a failing herdr-app check on a fresh Herdr home leaves no empty mods/ or layouts/ folder behind", async (t) => {
	const f = fixture(t);
	installFakeHerdr(join(f.bin, "herdr-app"), HERDR_APP_VERSION, f.state);
	assert.equal(await runDesktop(context(f, { args: ["--yes", "--no-open"], fail: "gentle-a" })), 1);
	assert.match(f.err.join("\n"), /herdr-app check failed for gentle-a/);
	assert.equal(existsSync(f.herdrHome), false);
	assert.equal(existsSync(join(f.home, ".gentle-shell", "desktop", "state.json")), false);
	assert.equal(existsSync(join(f.home, ".gentle-shell", "desktop", "stage")), false);
});

function hasMarker(dir: string, marker: string): boolean {
	if (!existsSync(dir)) return false;
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (lstatSync(path).isDirectory() ? hasMarker(path, marker) : readFileSync(path, "utf8").includes(marker)) return true;
	}
	return false;
}

test("a user's own gentle-* mod and gentle-shell layout are never lost across install, refresh and uninstall", async (t) => {
	const f = fixture(t);
	installFakeHerdr(join(f.bin, "herdr-app"), HERDR_APP_VERSION, f.state);
	const userMod = join(f.herdrHome, "mods", "gentle-a");
	const userLayout = join(f.herdrHome, "layouts", "gentle-shell.json");
	mkdirSync(join(userMod, "lib"), { recursive: true });
	writeFileSync(join(userMod, "main.js"), "// USER-MOD-MARKER\n");
	writeFileSync(join(userMod, "lib", "util.js"), "export const own = 1;\n");
	mkdirSync(join(f.herdrHome, "layouts"), { recursive: true });
	writeFileSync(userLayout, "{\"USER-LAYOUT-MARKER\":1}\n");
	const before = tree(f.herdrHome);
	assert.equal(await runDesktop(context(f, { args: ["--yes", "--no-open"] })), 0, f.err.join("\n"));
	assert.equal(readFileSync(join(userMod, "main.js"), "utf8"), "// gentle-a v2\n");
	writeFileSync(join(f.pkg, "herdr", "mods", "gentle-a", "main.js"), "// gentle-a v3\n");
	assert.equal(await runDesktop(context(f, { args: ["--refresh"] })), 0, f.err.join("\n"));
	// A second refresh rotates our own backup again; the user's originals must survive it.
	writeFileSync(join(f.pkg, "herdr", "mods", "gentle-a", "main.js"), "// gentle-a v4\n");
	writeFileSync(join(f.pkg, "herdr", "layouts", "gentle-shell.json"), "{\"id\":\"root\",\"v\":4}\n");
	assert.equal(await runDesktop(context(f, { args: ["--refresh"] })), 0, f.err.join("\n"));
	for (const marker of ["USER-MOD-MARKER", "USER-LAYOUT-MARKER"]) {
		assert.ok(hasMarker(f.herdrHome, marker) || hasMarker(join(f.home, ".gentle-shell", "desktop"), marker), `${marker} was deleted`);
	}
	f.out.length = 0;
	assert.equal(await runDesktop(context(f, { args: ["--uninstall"] })), 0, f.err.join("\n"));
	// Back at their original paths, byte-identical; our gentle-b is gone.
	assert.deepEqual(tree(f.herdrHome), before);
	assert.ok(f.out.join("\n").includes(`Put back what was there before Gentle Shell Desktop: mods gentle-a, layout gentle-shell in ${f.herdrHome}.`));
	assert.equal(existsSync(join(f.home, ".gentle-shell", "desktop", "state.json")), false);
	assert.equal(hasMarker(join(f.home, ".gentle-shell", "desktop"), "USER-MOD-MARKER"), false, "the original moved back rather than being copied");
});

test("uninstall without Gentle Shell Desktop's state removes nothing, so an unknown gentle-shell layout stays", async (t) => {
	const f = fixture(t);
	installFakeHerdr(join(f.bin, "herdr-app"), HERDR_APP_VERSION, f.state);
	mkdirSync(join(f.herdrHome, "layouts"), { recursive: true });
	mkdirSync(join(f.herdrHome, "mods", "gentle-a"), { recursive: true });
	writeFileSync(join(f.herdrHome, "layouts", "gentle-shell.json"), "{\"mine\":1}\n");
	writeFileSync(join(f.herdrHome, "mods", "gentle-a", "main.js"), "// mine\n");
	const before = tree(f.herdrHome);
	assert.equal(await runDesktop(context(f, { args: ["--uninstall"] })), 0, f.err.join("\n"));
	assert.deepEqual(tree(f.herdrHome), before);
	assert.deepEqual(f.out, [`Gentle Shell Desktop mods and layout are not installed in ${f.herdrHome}; nothing to remove.`]);
});

test("only a Gentle Shell that ships the desktop command is asked to refresh after an upgrade", (t) => {
	const f = fixture(t);
	assert.equal(supportsDesktop(realpathSync(new URL("..", import.meta.url))), true);
	assert.equal(supportsDesktop(f.pkg), false);
	assert.equal(supportsDesktop(join(f.root, "missing")), false);
});

test("uninstall removes only our mods and layout, keeps a backup and switches back to the previous layout", async (t) => {
	const f = fixture(t);
	installFakeHerdr(join(f.bin, "herdr-app"), HERDR_APP_VERSION, f.state);
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
	installFakeHerdr(join(f.bin, "herdr-app"), HERDR_APP_VERSION, f.state);
	assert.equal(await runDesktop(context(f, { args: ["--yes", "--no-open"] })), 0, f.err.join("\n"));
	writeFileSync(join(f.state, "running"), "");
	writeFileSync(join(f.state, "layout"), "gentle-shell");
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
		`  Feed: none at ${f.home}/.pi/agent/desktop/sessions; start a session with gentle-shell and the window will see it`,
		"  Layout gentle-shell: not installed",
		"  Mods: none installed (ships gentle-a, gentle-b)",
		"  Window: not running",
	]);
	installFakeHerdr(join(f.bin, "herdr-app"), HERDR_APP_VERSION, f.state);
	writeFileSync(join(f.state, "running"), "");
	assert.equal(await runDesktop(context(f, { args: ["--yes", "--no-open"] })), 0, f.err.join("\n"));
	f.out.length = 0;
	assert.equal(await runDesktop(context(f, { args: ["--status"] })), 0);
	assert.deepEqual(f.out, [
		"Gentle Shell Desktop",
		"  Gentle Shell: 9.9.9",
		`  Herdr app: ${HERDR_APP_VERSION} at ${join(f.bin, "herdr-app")} (needs ${HERDR_APP_VERSION} or newer)`,
		`  Herdr home: ${f.herdrHome}`,
		`  Feed: none at ${f.home}/.pi/agent/desktop/sessions; start a session with gentle-shell and the window will see it`,
		`  Layout gentle-shell: installed at ${join(f.herdrHome, "layouts", "gentle-shell.json")}`,
		`  Mods: gentle-a, gentle-b installed in ${join(f.herdrHome, "mods")}`,
		"  Window: running, layout main",
	]);
});

test("non-interactive without --yes refuses and writes nothing; declining also installs nothing", async (t) => {
	const f = fixture(t);
	installFakeHerdr(join(f.bin, "herdr-app"), HERDR_APP_VERSION, f.state);
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
	installFakeHerdr(join(f.bin, "herdr-app"), HERDR_APP_VERSION, f.state);
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

// --- S14: the layout's light and dark themes (herdr/themes/gentle-shell-*.json) -----------

test("themes: herdr/themes/gentle-shell-*.json install into themes/, a user's file there is kept and put back, refresh and uninstall follow (S14)", async (t) => {
	const f = fixture(t);
	installFakeHerdr(join(f.bin, "herdr-app"), HERDR_APP_VERSION, f.state);
	const pkgThemes = join(f.pkg, "herdr", "themes");
	mkdirSync(pkgThemes, { recursive: true });
	writeFileSync(join(pkgThemes, "gentle-shell-dark.json"), "{\"dark\":1}\n");
	writeFileSync(join(pkgThemes, "gentle-shell-light.json"), "{\"light\":1}\n");
	writeFileSync(join(pkgThemes, "other.json"), "{\"not\":\"ours\"}\n");
	const themes = join(f.herdrHome, "themes");
	mkdirSync(themes, { recursive: true });
	writeFileSync(join(themes, "gentle-shell-light.json"), "{\"mine\":1}\n");
	writeFileSync(join(themes, "atom-one-dark.json"), "{\"herdr\":1}\n");
	assert.equal(await runDesktop(context(f, { args: ["--yes", "--no-open"] })), 0, f.err.join("\n"));
	const out = f.out.join("\n");
	assert.ok(out.includes(`  - install its light and dark themes gentle-shell-dark.json, gentle-shell-light.json into ${themes}`), out);
	assert.ok(out.includes(`Installed mods gentle-a, gentle-b, layout gentle-shell and themes gentle-shell-dark.json, gentle-shell-light.json in ${f.herdrHome}.`), out);
	assert.deepEqual(readdirSync(themes).sort(), ["atom-one-dark.json", "gentle-shell-dark.json", "gentle-shell-light.json"]);
	assert.equal(readFileSync(join(themes, "gentle-shell-dark.json"), "utf8"), "{\"dark\":1}\n");
	assert.equal(readFileSync(join(themes, "gentle-shell-light.json"), "utf8"), "{\"light\":1}\n");
	assert.equal(readFileSync(join(themes, "atom-one-dark.json"), "utf8"), "{\"herdr\":1}\n");
	const originals = join(f.home, ".gentle-shell", "desktop", "originals", "themes");
	assert.equal(readFileSync(join(originals, "gentle-shell-light.json"), "utf8"), "{\"mine\":1}\n");
	const stateFile = join(f.home, ".gentle-shell", "desktop", "state.json");
	assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")).themes, ["gentle-shell-dark.json", "gentle-shell-light.json"]);
	f.out.length = 0;
	assert.equal(await runDesktop(context(f, { args: ["--status"] })), 0);
	assert.ok(f.out.includes(`  Themes: gentle-shell-dark.json, gentle-shell-light.json installed in ${themes}`), f.out.join("\n"));
	writeFileSync(join(pkgThemes, "gentle-shell-dark.json"), "{\"dark\":2}\n");
	f.out.length = 0;
	assert.equal(await runDesktop(context(f, { args: ["--refresh"], interactive: false })), 0, f.err.join("\n"));
	assert.equal(readFileSync(join(themes, "gentle-shell-dark.json"), "utf8"), "{\"dark\":2}\n");
	assert.deepEqual(f.out, [`Gentle Shell Desktop: refreshed mods gentle-a, gentle-b, layout gentle-shell and themes gentle-shell-dark.json, gentle-shell-light.json in ${f.herdrHome}.`]);
	f.out.length = 0;
	assert.equal(await runDesktop(context(f, { args: ["--uninstall"] })), 0, f.err.join("\n"));
	assert.deepEqual(readdirSync(themes).sort(), ["atom-one-dark.json", "gentle-shell-light.json"]);
	assert.equal(readFileSync(join(themes, "gentle-shell-light.json"), "utf8"), "{\"mine\":1}\n");
	const backup = join(f.home, ".gentle-shell", "desktop", "backup");
	assert.equal(readFileSync(join(backup, "themes", "gentle-shell-dark.json"), "utf8"), "{\"dark\":2}\n");
	assert.ok(f.out.includes(`Removed Gentle Shell Desktop mods, layout and themes from ${f.herdrHome}; a copy is in ${backup}. Herdr app itself stays installed.`), f.out.join("\n"));
	assert.ok(f.out.some((line) => line.startsWith("Put back what was there before Gentle Shell Desktop:") && line.includes("theme gentle-shell-light.json")), f.out.join("\n"));
	assert.equal(existsSync(join(f.home, ".gentle-shell", "desktop", "originals")), false);
	assert.equal(existsSync(stateFile), false);
});

// WCAG 2.x contrast of two #rrggbb colours.
function contrast(a: string, b: string): number {
	const lum = (hex: string) => {
		const n = Number.parseInt(hex.slice(1, 7), 16);
		const [r, g, bl] = [16, 8, 0].map((shift) => {
			const c = ((n >> shift) & 255) / 255;
			return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
	};
	const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
	return (x + 0.05) / (y + 0.05);
}

test("the real layout follows the appearance: gentle-shell-light / gentle-shell-dark themes, the dark one keeps the dark look, light text is WCAG AA (S14)", () => {
	const read = (path: string) => JSON.parse(readFileSync(new URL(`../herdr/${path}`, import.meta.url), "utf8"));
	const layout = read("layouts/gentle-shell.json");
	assert.deepEqual(layout.theme, { light: "gentle-shell-light", dark: "gentle-shell-dark" });
	// Root colors apply in both appearances (Herdr), so the layout must not force any.
	assert.equal(layout.colors, undefined);
	const isHex6 = (v: unknown) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
	const isHex = (v: unknown) => typeof v === "string" && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v);
	const files = readdirSync(new URL("../herdr/themes/", import.meta.url)).sort();
	assert.deepEqual(files, ["gentle-shell-dark.json", "gentle-shell-light.json"]);
	const allowed = new Set(["background", "foreground", "selection", "cursor", "ansi", "colors"]);
	for (const name of files) {
		const theme = read(`themes/${name}`);
		// Herdr's ThemeFile (deny_unknown_fields): every key known, #rrggbb palette, 16 ansi.
		for (const key of Object.keys(theme)) assert.ok(allowed.has(key), `${name}: ${key}`);
		for (const key of ["background", "foreground", "selection"]) assert.ok(isHex6(theme[key]), `${name}: ${key}`);
		if (theme.cursor !== undefined) assert.ok(isHex6(theme.cursor), `${name}: cursor`);
		assert.equal(theme.ansi.length, 16);
		for (const c of theme.ansi) assert.ok(isHex6(c), `${name}: ansi ${c}`);
		for (const [key, c] of Object.entries(theme.colors)) assert.ok(isHex(c), `${name}: colors.${key}`);
	}
	// Dark: Herdr's graphite palette (terminal colours as before) plus the former root colors,
	// so every theme() role resolves exactly as with the old layout.
	const dark = read("themes/gentle-shell-dark.json");
	assert.deepEqual({ background: dark.background, foreground: dark.foreground, selection: dark.selection, cursor: dark.cursor }, { background: "#17191d", foreground: "#d2d4d9", selection: "#394454", cursor: undefined });
	assert.deepEqual(dark.ansi, ["#45484f", "#dc8c95", "#a6bd91", "#d8be87", "#96b2d7", "#b5a2ce", "#8cbdc3", "#d2d4d9", "#818793", "#f0a5ad", "#bad5a2", "#ead2a1", "#b0cbef", "#cbb7e6", "#a4d5db", "#f0f0f2"]);
	assert.deepEqual(dark.colors, {
		background: "#060407", canvas: "#060407", chrome: "#100A0F", surface: "#20161e", raised: "#241822", popover: "#241822",
		selected: "#28121E", hover: "#28121E", border: "#2A1720", input: "#563040", foreground: "#f6eff3", muted: "#a78e9b",
		dim: "#76616b", accent: "#f095c8", accent_foreground: "#1a1218", solid: "#f095c8", solid_foreground: "#1a1218",
		done: "#b4e7c7", blocked: "#e0c27a", working: "#a9c7ee", idle: "#a78e9b", selection: "#f095c84d",
	});
	// Light: the same roles, and every text role at least 4.5:1 on the surfaces text sits on.
	const light = read("themes/gentle-shell-light.json").colors;
	assert.deepEqual(Object.keys(light).sort(), Object.keys(dark.colors).sort());
	for (const text of ["foreground", "muted", "accent", "done", "blocked", "working"]) {
		for (const surface of ["canvas", "chrome", "selected", "background", "popover"]) {
			assert.ok(contrast(light[text], light[surface]) >= 4.5, `${text} on ${surface}: ${contrast(light[text], light[surface]).toFixed(2)}`);
		}
	}
	assert.ok(contrast(light.accent_foreground, light.accent) >= 4.5, "text on the accent button");
	assert.ok(contrast(light.solid_foreground, light.solid) >= 4.5, "text on the solid button");
});

test("Projects group by machine like Herdr's spaces once a machine is not this computer, with each machine's state (S14)", async () => {
	const { machineGroups, STATE_WORD } = await import("../herdr/mods/gentle-spaces/machines.js");
	assert.deepEqual(STATE_WORD, { loading: "loading…", ready: "ready", unavailable: "unavailable" });
	// Only this computer: no headers, the plain list (unchanged look).
	assert.equal(machineGroups([{ id: "w1", machine: null }], [{ name: null, layout: "ready" }]), null);
	assert.equal(machineGroups([], []), null);
	// This computer first, then machines by name; machines with no space are listed too.
	const groups = machineGroups(
		[{ id: "w1", machine: null }, { id: "vps/w2", machine: "vps" }, { id: "w3", machine: null }],
		[{ name: null, layout: "ready" }, { name: "vps", layout: "loading" }, { name: "box", layout: "unavailable" }],
	);
	assert.deepEqual(groups, [
		{ name: null, state: "ready", spaces: [{ id: "w1", machine: null }, { id: "w3", machine: null }] },
		{ name: "box", state: "unavailable", spaces: [] },
		{ name: "vps", state: "loading", spaces: [{ id: "vps/w2", machine: "vps" }] },
	]);
	// A space whose machine Herdr does not list (yet): unavailable, never "ready".
	assert.deepEqual(machineGroups([{ id: "x/w9", machine: "x" }], [])?.map((g) => [g.name, g.state]), [[null, "ready"], ["x", "unavailable"]]);
});

test("a swap conflict rolls back: Herdr home, originals and a created mods/ folder are as before (B1)", async (t) => {
	const f = fixture(t);
	installFakeHerdr(join(f.bin, "herdr-app"), HERDR_APP_VERSION, f.state);
	const originals = join(f.home, ".gentle-shell", "desktop", "originals", "layouts");
	mkdirSync(originals, { recursive: true });
	writeFileSync(join(originals, "gentle-shell.json"), "{\"earlier\":1}\n");
	mkdirSync(join(f.herdrHome, "layouts"), { recursive: true });
	writeFileSync(join(f.herdrHome, "layouts", "gentle-shell.json"), "{\"live\":1}\n");
	const before = tree(f.herdrHome);
	assert.equal(await runDesktop(context(f, { args: ["--yes", "--no-open"] })), 1);
	assert.match(f.err.join("\n"), /already keeps an earlier original/);
	assert.deepEqual(tree(f.herdrHome), before);
	assert.equal(existsSync(join(f.herdrHome, "mods")), false);
	assert.equal(readFileSync(join(originals, "gentle-shell.json"), "utf8"), "{\"earlier\":1}\n");
});

test("a state.json written before `layout` existed treats our layout as ours (migration, B1)", async (t) => {
	const f = fixture(t);
	installFakeHerdr(join(f.bin, "herdr-app"), HERDR_APP_VERSION, f.state);
	assert.equal(await runDesktop(context(f, { args: ["--yes", "--no-open"] })), 0, f.err.join("\n"));
	const stateFile = join(f.home, ".gentle-shell", "desktop", "state.json");
	const { layout: _layout, ...old } = JSON.parse(readFileSync(stateFile, "utf8"));
	writeFileSync(stateFile, JSON.stringify(old));
	writeFileSync(join(f.pkg, "herdr", "layouts", "gentle-shell.json"), "{\"v\":9}\n");
	assert.equal(await runDesktop(context(f, { args: ["--refresh"] })), 0, f.err.join("\n"));
	assert.equal(existsSync(join(f.home, ".gentle-shell", "desktop", "originals")), false);
	assert.equal(await runDesktop(context(f, { args: ["--uninstall"] })), 0, f.err.join("\n"));
	assert.equal(existsSync(join(f.herdrHome, "layouts", "gentle-shell.json")), false);
});

// --- Desktop keys: herdr/keys.json merged into <herdr home>/keys.json ----------------

const SHIPPED_KEYS = `{
  "layout:gentle-shell": {
    "cmd-k": "mod.open:gentle-palette",
    "cmd-j": "gentle-status.toggle",
    "cmd-alt-1": "gentle-inspector.tab-changes"
  },
  "global": { "cmd-q": "app.quit" }
}
`;
const OUR_SECTION = { "cmd-k": "mod.open:gentle-palette", "cmd-j": "gentle-status.toggle", "cmd-alt-1": "gentle-inspector.tab-changes" };

function keysFixture(t: TestContext, options: { running?: boolean } = {}) {
	const f = fixture(t);
	writeFileSync(join(f.pkg, "herdr", "keys.json"), SHIPPED_KEYS);
	installFakeHerdr(join(f.bin, "herdr-app"), HERDR_APP_VERSION, f.state);
	if (options.running) writeFileSync(join(f.state, "running"), "");
	const keysFile = join(f.herdrHome, "keys.json");
	const stateFile = join(f.home, ".gentle-shell", "desktop", "state.json");
	const writeKeys = (text: string) => {
		mkdirSync(f.herdrHome, { recursive: true });
		writeFileSync(keysFile, text);
	};
	const keys = () => readFileSync(keysFile, "utf8");
	const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
	return { f, keysFile, stateFile, writeKeys, keys, state };
}

const USER_KEYS = `{
\t"global": { "ctrl-shift-t": "tab.new" },
\t"terminal": {
\t\t"ctrl-left": "send:\\u001bb"
\t}
}
`;
const USER_KEYS_MERGED = `{
\t"global": { "ctrl-shift-t": "tab.new" },
\t"terminal": {
\t\t"ctrl-left": "send:\\u001bb"
\t},
\t"layout:gentle-shell": {
\t\t"cmd-k": "mod.open:gentle-palette",
\t\t"cmd-j": "gentle-status.toggle",
\t\t"cmd-alt-1": "gentle-inspector.tab-changes"
\t}
}
`;

test("keys: on a fresh Herdr home the Gentle shortcuts are merged into the keys.json Herdr writes on first start", async (t) => {
	const { f, keysFile, keys, state } = keysFixture(t);
	writeFileSync(join(f.state, "default-keys.json"), USER_KEYS);
	assert.equal(await runDesktop(context(f, { args: ["--yes"] })), 0, f.err.join("\n"));
	assert.ok(f.out.join("\n").includes(`add the Gentle shortcuts (layout:gentle-shell) to ${keysFile}, keeping every key you already use`));
	assert.equal(keys(), USER_KEYS_MERGED);
	assert.deepEqual(state().keys.entries, OUR_SECTION);
	assert.equal(state().keys.createdSection, true);
	assert.equal(readFileSync(join(f.home, ".gentle-shell", "desktop", "originals", "keys.json"), "utf8"), USER_KEYS, "the file before Gentle Shell is kept");
	assert.equal(readFileSync(join(f.home, ".gentle-shell", "desktop", "keys-backup.json"), "utf8"), USER_KEYS, "the previous file is backed up");
	assert.ok(f.out.includes(`Added the Gentle shortcuts cmd-k, cmd-j, cmd-alt-1 to ${keysFile} (layout:gentle-shell); the previous file is in ${join(f.home, ".gentle-shell", "desktop", "keys-backup.json")}.`), f.out.join("\n"));
	assert.ok(!keys().includes("app.quit"), "only our layout section is merged");
	f.out.length = 0;
	assert.equal(await runDesktop(context(f, { args: ["--status"] })), 0);
	assert.ok(f.out.includes(`  Keys: 3 Gentle shortcuts in ${keysFile} (layout:gentle-shell)`), f.out.join("\n"));
});

test("keys: --no-open with no keys.json yet writes none (Herdr's defaults come from its first start) and says when they are added", async (t) => {
	const { f, keysFile, state } = keysFixture(t);
	assert.equal(await runDesktop(context(f, { args: ["--yes", "--no-open"] })), 0, f.err.join("\n"));
	assert.equal(existsSync(keysFile), false);
	assert.equal(state().keys, undefined);
	assert.ok(f.out.includes(`Herdr writes ${keysFile} when its window first opens; the Gentle shortcuts are added the next time gentle-shell desktop opens Herdr.`), f.out.join("\n"));
	f.out.length = 0;
	assert.equal(await runDesktop(context(f, { args: ["--status"] })), 0);
	assert.ok(f.out.includes("  Keys: Gentle shortcuts not added"), f.out.join("\n"));
});

test("keys: an existing keys.json keeps every byte of the user's keys; only our section is appended", async (t) => {
	const { f, keys, writeKeys } = keysFixture(t);
	writeKeys(USER_KEYS);
	assert.equal(await runDesktop(context(f, { args: ["--yes", "--no-open"] })), 0, f.err.join("\n"));
	assert.equal(keys(), USER_KEYS_MERGED);
	assert.deepEqual(f.err, []);
});

test("keys: a key the user already binds in layout:gentle-shell keeps theirs and reports the conflict once", async (t) => {
	const { f, keysFile, keys, writeKeys, state } = keysFixture(t);
	const user = `{"layout:gentle-shell":{"cmd-k":"space.new","alt-cmd-1":"tab.new"},"global":{}}\n`;
	writeKeys(user);
	assert.equal(await runDesktop(context(f, { args: ["--yes", "--no-open"] })), 0, f.err.join("\n"));
	assert.deepEqual(JSON.parse(keys()), { "layout:gentle-shell": { "cmd-k": "space.new", "alt-cmd-1": "tab.new", "cmd-j": "gentle-status.toggle" }, global: {} });
	assert.ok(keys().startsWith(`{"layout:gentle-shell":{"cmd-k":"space.new","alt-cmd-1":"tab.new",`), keys());
	assert.deepEqual(f.err, [
		`gentle-shell desktop: your ${keysFile} binds cmd-k to "space.new" in layout:gentle-shell; kept yours, so the Gentle shortcut cmd-k (mod.open:gentle-palette) was not added.`,
		`gentle-shell desktop: your ${keysFile} binds alt-cmd-1 to "tab.new" in layout:gentle-shell; kept yours, so the Gentle shortcut cmd-alt-1 (gentle-inspector.tab-changes) was not added.`,
	]);
	assert.deepEqual(state().keys.entries, { "cmd-j": "gentle-status.toggle" });
	f.err.length = 0;
	assert.equal(await runDesktop(context(f, { args: ["--refresh"] })), 0, f.err.join("\n"));
	assert.deepEqual(f.err, [], "a known conflict is not reported again");
	assert.equal(await runDesktop(context(f, { args: ["--uninstall"] })), 0, f.err.join("\n"));
	assert.equal(keys(), user, "uninstall leaves the user's own cmd-k and alt-cmd-1");
});

test("keys: install, refresh and a second run are idempotent; a changed shipped key is updated and a dropped one removed", async (t) => {
	const { f, keys, writeKeys, state } = keysFixture(t);
	writeKeys(USER_KEYS);
	assert.equal(await runDesktop(context(f, { args: ["--yes", "--no-open"] })), 0, f.err.join("\n"));
	const backup = join(f.home, ".gentle-shell", "desktop", "keys-backup.json");
	f.out.length = 0;
	assert.equal(await runDesktop(context(f, { args: ["--refresh"] })), 0, f.err.join("\n"));
	assert.equal(await runDesktop(context(f, { args: ["--yes", "--no-open"] })), 0, f.err.join("\n"));
	assert.equal(keys(), USER_KEYS_MERGED);
	assert.equal(readFileSync(backup, "utf8"), USER_KEYS, "no write, so no new backup");
	assert.ok(!f.out.some((line) => line.includes("shortcuts")), f.out.join("\n"));
	writeFileSync(join(f.pkg, "herdr", "keys.json"), JSON.stringify({ "layout:gentle-shell": { "cmd-k": "mod.open:gentle-palette", "cmd-j": "gentle-chat.toggle" } }));
	f.out.length = 0;
	assert.equal(await runDesktop(context(f, { args: ["--refresh"] })), 0, f.err.join("\n"));
	assert.equal(keys(), USER_KEYS_MERGED.replace('"gentle-status.toggle"', '"gentle-chat.toggle"').replace(',\n\t\t"cmd-alt-1": "gentle-inspector.tab-changes"', ""));
	assert.equal(readFileSync(backup, "utf8"), USER_KEYS_MERGED);
	assert.deepEqual(state().keys.entries, { "cmd-k": "mod.open:gentle-palette", "cmd-j": "gentle-chat.toggle" });
});

test("keys: a Gentle shortcut the user deleted or rebound is theirs and never comes back", async (t) => {
	const { f, keys, writeKeys, state } = keysFixture(t);
	writeKeys(USER_KEYS);
	assert.equal(await runDesktop(context(f, { args: ["--yes", "--no-open"] })), 0, f.err.join("\n"));
	const edited = keys().replace(',\n\t\t"cmd-j": "gentle-status.toggle"', "").replace('"gentle-inspector.tab-changes"', '"space.next"');
	writeKeys(edited);
	assert.equal(await runDesktop(context(f, { args: ["--refresh"] })), 0, f.err.join("\n"));
	assert.equal(keys(), edited);
	assert.deepEqual(state().keys.entries, { "cmd-k": "mod.open:gentle-palette" });
	assert.equal(await runDesktop(context(f, { args: ["--uninstall"] })), 0, f.err.join("\n"));
	assert.equal(keys(), `{
\t"global": { "ctrl-shift-t": "tab.new" },
\t"terminal": {
\t\t"ctrl-left": "send:\\u001bb"
\t},
\t"layout:gentle-shell": {
\t\t"cmd-alt-1": "space.next"
\t}
}
`);
});

test("keys: --uninstall removes exactly our entries; the rest stays byte-identical, including later user edits", async (t) => {
	const { f, keysFile, keys, writeKeys, state } = keysFixture(t);
	writeKeys(USER_KEYS);
	assert.equal(await runDesktop(context(f, { args: ["--yes", "--no-open"] })), 0, f.err.join("\n"));
	assert.equal(state().keys.firstWritten, state().keys.written, "untouched since the first write: byte-for-byte restore");
	f.out.length = 0;
	assert.equal(await runDesktop(context(f, { args: ["--uninstall"] })), 0, f.err.join("\n"));
	assert.equal(keys(), USER_KEYS);
	assert.ok(f.out.includes(`Removed the Gentle shortcuts from ${keysFile}; your own keys are unchanged.`), f.out.join("\n"));
	assert.equal(existsSync(join(f.home, ".gentle-shell", "desktop", "originals")), false);
	assert.equal(existsSync(join(f.home, ".gentle-shell", "desktop", "state.json")), false);
	// Edited after install: our entries go, the user's edit stays.
	assert.equal(await runDesktop(context(f, { args: ["--yes", "--no-open"] })), 0, f.err.join("\n"));
	writeKeys(keys().replace('"tab.new"', '"tab.new", "ctrl-shift-w": "tab.close"'));
	assert.equal(await runDesktop(context(f, { args: ["--uninstall"] })), 0, f.err.join("\n"));
	assert.equal(keys(), USER_KEYS.replace('"tab.new"', '"tab.new", "ctrl-shift-w": "tab.close"'));
});

test("keys: a user edit followed by a refresh that rewrites keys.json survives --uninstall (R1/R3)", async (t) => {
	const { f, keys, writeKeys } = keysFixture(t);
	writeKeys(USER_KEYS);
	assert.equal(await runDesktop(context(f, { args: ["--yes", "--no-open"] })), 0, f.err.join("\n"));
	writeKeys(keys().replace('"tab.new"', '"tab.new", "ctrl-shift-w": "tab.close"'));
	writeFileSync(join(f.pkg, "herdr", "keys.json"), JSON.stringify({ "layout:gentle-shell": { "cmd-k": "mod.open:gentle-palette" } }));
	assert.equal(await runDesktop(context(f, { args: ["--refresh"] })), 0, f.err.join("\n"));
	assert.ok(!keys().includes("gentle-status.toggle"), "the refresh rewrote keys.json");
	assert.equal(await runDesktop(context(f, { args: ["--uninstall"] })), 0, f.err.join("\n"));
	assert.equal(keys(), USER_KEYS.replace('"tab.new"', '"tab.new", "ctrl-shift-w": "tab.close"'));
});

test("keys: an invalid user keys.json is never written; mods still install and the message says why", async (t) => {
	const { f, keysFile, keys, writeKeys, state } = keysFixture(t);
	for (const [bad, why] of [["{ \"global\": { \"ctrl-shift-t\": \"tab.new\", } }\n", /is not valid JSON/], ["[1, 2]\n", /must be a JSON object of sections/], ["{\"global\": {\"ctrl-a\": 3}}\n", /global\.ctrl-a must be a command string or an object/]] as const) {
		writeKeys(bad);
		f.err.length = 0;
		assert.equal(await runDesktop(context(f, { args: ["--yes", "--no-open"] })), 0, f.err.join("\n"));
		assert.equal(keys(), bad);
		assert.equal(f.err.length, 1, f.err.join("\n"));
		assert.match(f.err[0], new RegExp(`^gentle-shell desktop: ${keysFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `));
		assert.match(f.err[0], why);
		assert.match(f.err[0], /it was not changed and the Gentle shortcuts were not added/);
		assert.ok(existsSync(join(f.herdrHome, "mods", "gentle-a", "main.js")));
		assert.equal(state().keys, undefined);
	}
});

test("keys: when the running Herdr rejects the merged file (keys.error), the previous keys.json is restored", async (t) => {
	const { f, keysFile, keys, writeKeys, state } = keysFixture(t, { running: true });
	writeKeys(USER_KEYS);
	const keysError = join(f.herdrHome, "keys.error");
	const io = { ...context(f).io, sleep: async () => {
		if (existsSync(keysFile) && readFileSync(keysFile, "utf8").includes("gentle-status.toggle")) writeFileSync(keysError, "keys.json was not applied: layout:gentle-shell.cmd-j: bad\n");
		else rmSync(keysError, { force: true });
	} };
	assert.equal(await runDesktop(context(f, { args: ["--yes", "--no-open"], io })), 0, f.err.join("\n"));
	assert.equal(keys(), USER_KEYS);
	assert.deepEqual(f.err, [`gentle-shell desktop: Herdr app did not accept the Gentle shortcuts (keys.json was not applied: layout:gentle-shell.cmd-j: bad); put back the previous ${keysFile}.`]);
	assert.equal(state().keys, undefined);
});

test("keys: a running Herdr that already reports keys.error gets no write", async (t) => {
	const { f, keysFile, keys, writeKeys, state } = keysFixture(t, { running: true });
	writeKeys(USER_KEYS);
	writeFileSync(join(f.herdrHome, "keys.error"), "keys.json was not applied: global.x: unknown action\n");
	assert.equal(await runDesktop(context(f, { args: ["--yes", "--no-open"] })), 0, f.err.join("\n"));
	assert.equal(keys(), USER_KEYS);
	assert.deepEqual(f.err, [`gentle-shell desktop: Herdr app reports a problem in your ${keysFile} (keys.json was not applied: global.x: unknown action); it was not changed and the Gentle shortcuts were not added. Fix it and run gentle-shell desktop again.`]);
	assert.equal(state().keys, undefined);
});

test("keys: a package without herdr/keys.json never touches keys.json (PRESERVE)", async (t) => {
	const f = fixture(t);
	installFakeHerdr(join(f.bin, "herdr-app"), HERDR_APP_VERSION, f.state);
	mkdirSync(f.herdrHome, { recursive: true });
	writeFileSync(join(f.herdrHome, "keys.json"), USER_KEYS);
	assert.equal(await runDesktop(context(f, { args: ["--yes", "--no-open"] })), 0, f.err.join("\n"));
	assert.equal(await runDesktop(context(f, { args: ["--uninstall"] })), 0, f.err.join("\n"));
	assert.equal(readFileSync(join(f.herdrHome, "keys.json"), "utf8"), USER_KEYS);
});

// --- T12 (S11): the chat's minimal view -------------------------------------------------

const REPO = join(import.meta.dirname, "..");

test("keys: the shipped layout section adds ⌘O for the chat's expand-all and keeps the other Gentle shortcuts", () => {
	const shipped = JSON.parse(readFileSync(join(REPO, "herdr", "keys.json"), "utf8"));
	assert.deepEqual(shipped, {
		"layout:gentle-shell": {
			"cmd-k": "mod.open:gentle-palette",
			"cmd-j": "gentle-status.toggle",
			"cmd-.": "gentle-status.stop",
			"cmd-o": "gentle-chat.expand",
			"cmd-alt-1": "gentle-inspector.tab-changes",
			"cmd-alt-2": "gentle-inspector.tab-todo",
			"cmd-alt-3": "gentle-inspector.tab-agents",
			"cmd-alt-4": "gentle-inspector.tab-jobs",
			"cmd-alt-5": "gentle-inspector.tab-review",
			"cmd-alt-6": "gentle-inspector.tab-session",
		},
	});
});

test("chat feed: compaction, branch summaries and skill invocations become their own foldable items, as the TUI draws them", async () => {
	const { createFeed, ingest } = await import(join(REPO, "herdr", "mods", "gentle-chat", "feed.js"));
	const feed = createFeed();
	const lines = [
		{ type: "compaction", id: "c1", summary: "## Goal\nShip T12", tokensBefore: 123456, firstKeptEntryId: "x" },
		{ type: "branch_summary", id: "b1", summary: "Tried a fork\nthen came back", fromId: "a" },
		{ type: "branch_summary", id: "b2", summary: "   " },
		{ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: '<skill name="odd" location="/s/odd/SKILL.md">\n# ODD\nrules\n</skill>\n\nplan this' }], timestamp: Date.parse("2026-11-15T10:00:00Z") } },
		{ type: "message", id: "u2", message: { role: "user", content: '<skill name="odd" location="/s/odd/SKILL.md">\nonly the skill\n</skill>' } },
		{ type: "custom_message", id: "n1", customType: "gentle-agents", display: true, content: "Subagent finished\n\nDetails" },
	];
	ingest(feed, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	const items = feed.items.map(({ time: _t, ...rest }: Record<string, unknown>) => rest);
	assert.deepEqual(items, [
		{ kind: "compaction", id: "c1", summary: "## Goal\nShip T12", tokens: 123456 },
		{ kind: "branch", id: "b1", summary: "Tried a fork\nthen came back" },
		{ kind: "skill", id: "u1-skill", name: "odd", text: "# ODD\nrules" },
		{ kind: "user", id: "u1", text: "plan this" },
		{ kind: "skill", id: "u2-skill", name: "odd", text: "only the skill" },
		{ kind: "note", id: "n1", text: "Subagent finished\n\nDetails", type: "gentle-agents" },
	]);
});

test("chat feed: an ordinary user message stays one user item (PRESERVE)", async () => {
	const { createFeed, ingest } = await import(join(REPO, "herdr", "mods", "gentle-chat", "feed.js"));
	const feed = createFeed();
	ingest(feed, JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: "<skill> is a word here" } }) + "\n");
	assert.deepEqual(feed.items.map((i: { kind: string; text: string }) => [i.kind, i.text]), [["user", "<skill> is a word here"]]);
});

test("chat feed: hideThinkingBlock follows pi's settings merge (project over agent dir, false when unset or unreadable)", async () => {
	const { hideThinkingFrom } = await import(join(REPO, "herdr", "mods", "gentle-chat", "feed.js"));
	assert.equal(hideThinkingFrom('{"hideThinkingBlock":true}', null), true);
	assert.equal(hideThinkingFrom('{"hideThinkingBlock":true}', '{"hideThinkingBlock":false}'), false);
	assert.equal(hideThinkingFrom('{"hideThinkingBlock":false}', '{"theme":"x"}'), false);
	assert.equal(hideThinkingFrom(null, null), false);
	assert.equal(hideThinkingFrom("{not json", '{"hideThinkingBlock":"yes"}'), false);
});

test("--status reports an agent home the mods cannot read", async (t) => {
	const f = fixture(t);
	const agent = join(f.home, "elsewhere", "agent");
	const base = context(f, { args: ["--status"] });
	assert.equal(await runDesktop({ ...base, env: { ...base.env, PI_CODING_AGENT_DIR: agent } }), 0);
	const line = f.out.find((entry) => entry.startsWith("  Roots: "));
	assert.ok(line !== undefined, f.out.join("\n"));
	assert.match(line ?? "", /is not read by the mods/);
	assert.match(line ?? "", /add \["/);
});

test("--status accepts an agent home listed in the roots file", async (t) => {
	const f = fixture(t);
	const agent = join(f.home, "elsewhere", "agent");
	mkdirSync(f.herdrHome, { recursive: true });
	writeFileSync(join(f.herdrHome, "gentle-shell-roots.json"), `${JSON.stringify({ roots: [agent] }, null, 2)}\n`);
	const base = context(f, { args: ["--status"] });
	assert.equal(await runDesktop({ ...base, env: { ...base.env, PI_CODING_AGENT_DIR: agent } }), 0);
	const line = f.out.find((entry) => entry.startsWith("  Roots: "));
	assert.ok(line !== undefined, f.out.join("\n"));
	assert.match(line ?? "", /listed in .*gentle-shell-roots\.json/);
	assert.doesNotMatch(line ?? "", /is not listed/);
});

test("--status reports a feed it can read", async (t) => {
	const f = fixture(t);
	const agent = join(f.home, "agent");
	const dir = join(agent, "desktop", "sessions");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "session-a.json"), "{}\n");
	const base = context(f, { args: ["--status"] });
	assert.equal(await runDesktop({ ...base, env: { ...base.env, PI_CODING_AGENT_DIR: agent } }), 0);
	const line = f.out.find((entry) => entry.startsWith("  Feed: "));
	assert.ok(line !== undefined, f.out.join("\n"));
	assert.match(line ?? "", /1 session snapshot in .*desktop\/sessions \(newest \d+s old\)/);
});

test("--status reads the agent home a separate install recorded", async (t) => {
	const f = fixture(t);
	// packageRoot mirrors <root>/prefix/lib/node_modules/gentle-pi, and installation.json sits at <root>.
	const root = join(f.home, "install");
	const packageRoot = join(root, "prefix", "lib", "node_modules", "gentle-pi");
	mkdirSync(packageRoot, { recursive: true });
	const agent = join(root, "agent");
	writeFileSync(join(root, "installation.json"), `${JSON.stringify({ Agent: agent })}\n`);
	const base = context(f, { args: ["--status"], packageRoot });
	assert.equal(await runDesktop({ ...base, env: { ...base.env, PI_CODING_AGENT_DIR: "" } }), 0);
	const line = f.out.find((entry) => entry.startsWith("  Roots: "));
	assert.ok(line !== undefined, f.out.join("\n"));
	assert.match(line ?? "", new RegExp(`Roots: ${agent} is not read by the mods`));
});

test("--status treats a trailing separator as the same agent home", async (t) => {
	const f = fixture(t);
	const agent = join(f.home, ".pi", "agent");
	const base = context(f, { args: ["--status"] });
	assert.equal(await runDesktop({ ...base, env: { ...base.env, PI_CODING_AGENT_DIR: `${agent}/` } }), 0);
	assert.equal(f.out.some((entry) => entry.startsWith("  Roots: ")), false, f.out.join("\n"));
});

test("--status stops at the eight roots the mods read", async (t) => {
	const f = fixture(t);
	const agent = join(f.home, "agent");
	const custom = Array.from({ length: 7 }, (_, i) => join(f.home, `root-${i}`));
	mkdirSync(f.herdrHome, { recursive: true });
	writeFileSync(join(f.herdrHome, "gentle-shell-roots.json"), `${JSON.stringify({ roots: [...custom, agent] }, null, 2)}\n`);
	const base = context(f, { args: ["--status"] });
	assert.equal(await runDesktop({ ...base, env: { ...base.env, PI_CODING_AGENT_DIR: agent } }), 0);
	const line = f.out.find((entry) => entry.startsWith("  Roots: "));
	assert.ok(line !== undefined, f.out.join("\n"));
	// Two defaults plus six customs fill the eight slots: adding the ninth does not help.
	assert.match(line ?? "", /the first 8 roots are taken/);
	assert.match(line ?? "", /move it into the first 8|remove an earlier one/);
});

test("--status ignores non-absolute entries when counting the limit", async (t) => {
	const f = fixture(t);
	const agent = join(f.home, "agent");
	mkdirSync(f.herdrHome, { recursive: true });
	writeFileSync(join(f.herdrHome, "gentle-shell-roots.json"), `${JSON.stringify({ roots: ["relative/one", "  ", agent] })}\n`);
	const base = context(f, { args: ["--status"] });
	assert.equal(await runDesktop({ ...base, env: { ...base.env, PI_CODING_AGENT_DIR: agent } }), 0);
	const line = f.out.find((entry) => entry.startsWith("  Roots: "));
	assert.ok(line !== undefined, f.out.join("\n"));
	assert.match(line ?? "", /listed in .*gentle-shell-roots\.json/);
});

test("--status escapes the suggested entry as JSON", async (t) => {
	const f = fixture(t);
	const agent = "C:\\\\Users\\\\Ada\\\\agent";
	const base = context(f, { args: ["--status"] });
	assert.equal(await runDesktop({ ...base, env: { ...base.env, PI_CODING_AGENT_DIR: agent } }), 0);
	const line = f.out.find((entry) => entry.startsWith("  Roots: "));
	assert.ok(line !== undefined, f.out.join("\n"));
	assert.ok((line ?? "").includes('["C:\\\\\\\\Users\\\\\\\\Ada\\\\\\\\agent"]'), line ?? "");
});
