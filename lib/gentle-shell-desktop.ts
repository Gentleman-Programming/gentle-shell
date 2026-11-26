import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

// `gentle-shell desktop` (Gentle Shell Desktop, odd/tasks/herdr-desktop.md T8):
// the pinned Herdr app, unchanged, plus our gentle-* mods and the gentle-shell
// layout from this package's herdr/ folder, the way Gentle Shell ships Pi.
// Everything it writes in Herdr's home is a gentle-* mod folder,
// layouts/gentle-shell.json or a themes/gentle-shell-*.json (the layout's light
// and dark palettes, S14); its own state and backups live in
// ~/.gentle-shell/desktop. Whatever was at one of those paths before Gentle
// Shell first installed there (state.json says which paths are ours) is kept
// in ~/.gentle-shell/desktop/originals, never rotated, and put back exactly by
// --uninstall. The one shared file it edits is keys.json: it adds only the
// layout:gentle-shell shortcuts of herdr/keys.json (state.json records each
// one), never changes a key the person binds, and --uninstall removes exactly
// those entries.

// The Herdr app the mods were built and checked against (`herdr-app check`,
// live fidelity passes). Newer apps are accepted; older or missing ones get
// exactly this release.
export const HERDR_APP_VERSION = "0.1.16";

export interface HerdrAppRelease {
	version: string;
	// SHA-256 of herdr-app-<target>.tar.gz, by Herdr target (macos-aarch64, linux-x86_64, ...).
	sha256: Record<string, string>;
}

// From Herdr's immutable per-version manifest,
// https://releases.herdr.dev/app/0.1.16/manifest.json (the file the official
// install.sh reads through app/latest.json). Pinned here so a changed or
// replaced download never installs.
export const HERDR_APP_RELEASE: HerdrAppRelease = {
	version: HERDR_APP_VERSION,
	sha256: {
		"linux-aarch64": "efeef4f1759b0e8900f205c2c22b14287a112f874406539b4ea1b3be24b73631",
		"linux-x86_64": "282d2632196b238206cfe66bfb61c0faf299ca1c91843bd076521bbe36571216",
		"macos-aarch64": "99000875ead9333a33f5cb60274ccd9cf9d3e47360f03613a467295105c71c04",
		"windows-x86_64": "abdc5400679cb730223a43b2a5216999a1edad3c2e80368f0ad3c43ea9895fe3",
	},
};

export const HERDR_RELEASES_URL = "https://releases.herdr.dev";
export const DESKTOP_LAYOUT = "gentle-shell";
const OFFICIAL_WINDOWS_INSTALL = 'powershell -c "irm https://releases.herdr.dev/app/install.ps1 | iex"';
const START_ATTEMPTS = 40;
const START_INTERVAL_MS = 500;
// The keys.json section our shortcuts live in: they apply only while the gentle-shell layout shows.
export const DESKTOP_KEYS_SECTION = `layout:${DESKTOP_LAYOUT}`;
// A running Herdr reloads keys.json on its file event and writes keys.error when it rejects it.
const KEYS_CHECK_ATTEMPTS = 4;
const KEYS_CHECK_INTERVAL_MS = 250;
// After starting the window: how long to wait for the keys.json Herdr writes on its first start.
const KEYS_WAIT_ATTEMPTS = 10;

export interface RunResult {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
}

export interface DesktopIO {
	run: (command: string, args: string[], options: { env: Record<string, string | undefined>; cwd?: string }) => RunResult;
	spawnDetached: (command: string, args: string[], options: { env: Record<string, string | undefined>; cwd?: string }) => void;
	download: (url: string, file: string) => Promise<void>;
	sha256: (file: string) => string;
	// undefined when the bundle carries a valid Developer ID signature, else why not.
	verifyMacSignature: (app: string) => string | undefined;
	sleep: (ms: number) => Promise<void>;
	ask: (question: string) => Promise<string>;
	out: (line: string) => void;
	err: (line: string) => void;
}

export interface DesktopContext {
	args: string[];
	env: Record<string, string | undefined>;
	home: string;
	platform: string;
	arch: string;
	cwd: string;
	interactive: boolean;
	packageRoot: string;
	shellVersion: string;
	io: DesktopIO;
	release?: HerdrAppRelease;
}

export function desktopUsage(): string {
	return [
		"Usage: gentle-shell desktop [--yes] [--no-open]",
		"       gentle-shell desktop --status",
		"       gentle-shell desktop --uninstall",
		"",
		`Gentle Shell Desktop is Herdr app (${HERDR_APP_VERSION} or newer, unchanged) with Gentle Shell's`,
		"gentle-* mods and its gentle-shell layout.",
		"",
		"  (no option)   Install what is missing, then open Herdr on the gentle-shell layout with a",
		"                Gentle Shell space in this folder. Shows what it will install and where, and",
		`                asks first. A missing or older Herdr app gets the pinned ${HERDR_APP_VERSION} release`,
		"                from releases.herdr.dev, verified against its pinned SHA-256. Each mod must",
		"                pass 'herdr-app check' before anything is installed. Only gentle-* mods,",
		"                layouts/gentle-shell.json and its light and dark themes (themes/gentle-shell-*.json)",
		"                are written in Herdr's home: anything Gentle Shell",
		"                did not install there is kept in ~/.gentle-shell/desktop/originals until",
		"                --uninstall puts it back; our own previous copy goes to .../desktop/backup.",
		"                The Gentle shortcuts (layout:gentle-shell: Cmd-K palette, Cmd-J chat/terminal,",
		"                Cmd-. stop, Cmd-Alt-1..6 inspector tabs) are added to Herdr's keys.json; a key",
		"                you already bind there stays yours and is reported.",
		"  --yes, -y     Do not ask (needed when not run in an interactive terminal).",
		"  --no-open     Install only; do not start or switch Herdr app.",
		"  --status      Print versions and what is installed.",
		"  --uninstall   Remove our mods, layout, themes and shortcuts (a copy stays in the backup), put back",
		"                what was there before, and switch Herdr back to your previous layout. Herdr",
		"                app itself stays installed.",
		"  --refresh     Reinstall our mods, layout, themes and shortcuts from this Gentle Shell when they are installed;",
		"                'gentle-shell upgrade' runs it. Does nothing if desktop was never installed.",
	].join("\n");
}

type Action = "open" | "status" | "uninstall" | "refresh" | "help";

function parseDesktopArgs(args: string[]): { action: Action; yes: boolean; open: boolean } | { error: string } {
	let yes = false;
	let open = true;
	const actions: Action[] = [];
	for (const arg of args) {
		if (arg === "--yes" || arg === "-y") yes = true;
		else if (arg === "--no-open") open = false;
		else if (arg === "--status") actions.push("status");
		else if (arg === "--uninstall") actions.push("uninstall");
		else if (arg === "--refresh") actions.push("refresh");
		else if (arg === "--help" || arg === "-h") return { action: "help", yes, open };
		else return { error: `unknown option ${arg}` };
	}
	if (actions.length > 1) return { error: "choose one of --status, --uninstall or --refresh" };
	return { action: actions[0] ?? "open", yes, open };
}

// Whether the Gentle Shell package at `packageRoot` has the `desktop` command:
// a version without this module treats `desktop` as a prompt for the model, so
// `gentle-shell upgrade` only asks a package that ships it to refresh.
export function supportsDesktop(packageRoot: string): boolean {
	return existsSync(join(packageRoot, "runtime", "gentle-shell-desktop.mjs")) && existsSync(join(packageRoot, "bin", "gentle-shell.mjs"));
}

// --- paths -------------------------------------------------------------------

export interface DesktopPaths {
	herdrHome: string;
	mods: string;
	layouts: string;
	layoutFile: string;
	themes: string;
	stateDir: string;
	stateFile: string;
	stage: string;
	backup: string;
	backupNext: string;
	originals: string;
	localBin: string;
	keysFile: string;
	rootsFile: string;
	keysError: string;
	keysBackup: string;
	keysOriginal: string;
}

const nonEmpty = (value: string | undefined) => (value !== undefined && value.length > 0 ? value : undefined);

// Herdr's own rule (herdr-app src/mods.rs app_dir): $HERDR_APP_HOME, else
// $XDG_CONFIG_HOME/herdr-app, else ~/.config/herdr-app, on every OS.
export function desktopPaths(env: Record<string, string | undefined>, home: string): DesktopPaths {
	const herdrHome = nonEmpty(env.HERDR_APP_HOME) ?? join(nonEmpty(env.XDG_CONFIG_HOME) ?? join(home, ".config"), "herdr-app");
	const stateDir = join(home, ".gentle-shell", "desktop");
	return {
		herdrHome,
		mods: join(herdrHome, "mods"),
		layouts: join(herdrHome, "layouts"),
		layoutFile: join(herdrHome, "layouts", `${DESKTOP_LAYOUT}.json`),
		themes: join(herdrHome, "themes"),
		stateDir,
		stateFile: join(stateDir, "state.json"),
		stage: join(stateDir, "stage"),
		backup: join(stateDir, "backup"),
		backupNext: join(stateDir, "backup.next"),
		originals: join(stateDir, "originals"),
		localBin: join(home, ".local", "bin"),
		// One keys.json on every OS; only Herdr's built-in defaults differ (keys.macos.json on macOS).
		keysFile: join(herdrHome, "keys.json"),
		rootsFile: join(herdrHome, "gentle-shell-roots.json"),
		keysError: join(herdrHome, "keys.error"),
		keysBackup: join(stateDir, "keys-backup.json"),
		keysOriginal: join(stateDir, "originals", "keys.json"),
	};
}

// --- shipped assets ------------------------------------------------------------

// Herdr regenerates gpui-kit.d.ts and jsconfig.json next to a mod per version
// (the mods' own .gitignore); FIDELITY*/SPIKE* are our design notes.
export function isShippedModFile(name: string): boolean {
	if (name === "gpui-kit.d.ts" || name === "jsconfig.json" || name === ".gitignore") return false;
	return !/^(FIDELITY|SPIKE).*\.md$/.test(name);
}

interface Assets {
	mods: string[];
	modsDir: string;
	layoutFile: string;
	// The layout's theme files (herdr/themes/gentle-shell-*.json, S14): its light and dark
	// palettes, by file name.
	themes: string[];
	themesDir: string;
	// The layout:gentle-shell section of herdr/keys.json, when this package ships one.
	keys?: Record<string, KeyAction>;
}

function shippedAssets(packageRoot: string): Assets | { error: string } {
	const root = join(packageRoot, "herdr");
	const modsDir = join(root, "mods");
	const layoutFile = join(root, "layouts", `${DESKTOP_LAYOUT}.json`);
	let mods: string[] = [];
	try {
		mods = readdirSync(modsDir).filter((name) => name.startsWith("gentle-") && isDirectory(join(modsDir, name))).sort();
	} catch {
		mods = [];
	}
	if (mods.length === 0 || !existsSync(layoutFile)) return { error: `this Gentle Shell (${packageRoot}) has no herdr/ mods and layout to install` };
	const themesDir = join(root, "themes");
	let themes: string[] = [];
	try {
		themes = readdirSync(themesDir).filter((name) => isThemeFile(name) && !isDirectory(join(themesDir, name))).sort();
	} catch {
		themes = [];
	}
	const keysFile = join(root, "keys.json");
	if (!existsSync(keysFile)) return { mods, modsDir, layoutFile, themes, themesDir };
	const keys = readKeysText(readFileSync(keysFile, "utf8"));
	if ("problem" in keys) return { error: `this Gentle Shell's ${keysFile} ${keys.problem}` };
	const section = keys.sections[DESKTOP_KEYS_SECTION] as Record<string, KeyAction> | undefined;
	return { mods, modsDir, layoutFile, themes, themesDir, ...(section ? { keys: { ...section } } : {}) };
}

// Our theme files: themes/gentle-shell-<appearance>.json, named after the layout.
const isThemeFile = (name: string) => new RegExp(`^${DESKTOP_LAYOUT}-[A-Za-z0-9._-]+\\.json$`).test(name);

function isDirectory(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

function shippedFiles(dir: string, rel = ""): string[] {
	const files: string[] = [];
	for (const name of readdirSync(join(dir, rel)).sort()) {
		const relPath = rel ? join(rel, name) : name;
		if (isDirectory(join(dir, relPath))) files.push(...shippedFiles(dir, relPath));
		else if (isShippedModFile(name)) files.push(relPath);
	}
	return files;
}

function sameFile(a: string, b: string): boolean {
	try {
		return readFileSync(a).equals(readFileSync(b));
	} catch {
		return false;
	}
}

function assetsUpToDate(assets: Assets, paths: DesktopPaths): boolean {
	if (!sameFile(assets.layoutFile, paths.layoutFile)) return false;
	if (!assets.themes.every((name) => sameFile(join(assets.themesDir, name), join(paths.themes, name)))) return false;
	return assets.mods.every((mod) => shippedFiles(join(assets.modsDir, mod)).every((file) => sameFile(join(assets.modsDir, mod, file), join(paths.mods, mod, file))));
}

// --- state -------------------------------------------------------------------

// The paths in Herdr's home that are ours: `mods` folders, `themes` files and,
// when `layout`, layouts/gentle-shell.json. Anything else there is the user's.
interface DesktopState {
	mods: string[];
	themes?: string[];
	layout: boolean;
	previousLayout?: string;
	keys?: KeysState;
}

function readState(paths: DesktopPaths): DesktopState | undefined {
	try {
		const parsed = JSON.parse(readFileSync(paths.stateFile, "utf8"));
		const mods = Array.isArray(parsed?.mods) ? parsed.mods.filter((name: unknown) => typeof name === "string" && /^gentle-[A-Za-z0-9._-]+$/.test(name)) : [];
		const previousLayout = typeof parsed?.previousLayout === "string" && parsed.previousLayout !== DESKTOP_LAYOUT ? parsed.previousLayout : undefined;
		const keys = parseKeysState(parsed?.keys);
		const themes = Array.isArray(parsed?.themes) ? parsed.themes.filter((name: unknown) => typeof name === "string" && isThemeFile(name)) : [];
		return { mods, ...(themes.length > 0 ? { themes } : {}), layout: parsed?.layout !== false, ...(previousLayout ? { previousLayout } : {}), ...(keys ? { keys } : {}) };
	} catch {
		return undefined;
	}
}

function writeState(paths: DesktopPaths, state: DesktopState) {
	mkdirSync(paths.stateDir, { recursive: true });
	const temp = `${paths.stateFile}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
	renameSync(temp, paths.stateFile);
}

// --- Herdr app -----------------------------------------------------------------

function findOnPath(name: string, env: Record<string, string | undefined>, platform: string): string | undefined {
	const extensions = platform === "win32" ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
	for (const dir of (env.PATH ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean)) {
		for (const extension of extensions) {
			const candidate = join(dir, `${name}${extension}`);
			try {
				accessSync(candidate, fsConstants.X_OK);
				if (!isDirectory(candidate)) return candidate;
			} catch {
				// keep looking
			}
		}
	}
	return undefined;
}

export function findHerdrApp(env: Record<string, string | undefined>, home: string, platform: string): string | undefined {
	const onPath = findOnPath("herdr-app", env, platform);
	if (onPath) return onPath;
	const local = join(home, ".local", "bin", platform === "win32" ? "herdr-app.exe" : "herdr-app");
	return existsSync(local) ? local : undefined;
}

export function compareVersions(a: string, b: string): number {
	const parts = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const left = parts(a);
	const right = parts(b);
	for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff < 0 ? -1 : 1;
	}
	return 0;
}

interface InstalledApp {
	path: string;
	version?: string;
}

function detectApp(ctx: DesktopContext): InstalledApp | undefined {
	const path = findHerdrApp(ctx.env, ctx.home, ctx.platform);
	if (!path) return undefined;
	const result = ctx.io.run(path, ["--version"], { env: ctx.env });
	const version = /herdr-app\s+v?(\d+\.\d+\.\d+)/.exec(`${result.stdout}`)?.[1];
	return { path, ...(version ? { version } : {}) };
}

function herdrTarget(platform: string, arch: string): string | undefined {
	const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : undefined;
	if (!cpu) return undefined;
	if (platform === "darwin") return cpu === "aarch64" ? "macos-aarch64" : undefined;
	if (platform === "linux") return `linux-${cpu}`;
	if (platform === "win32") return cpu === "x86_64" ? "windows-x86_64" : undefined;
	return undefined;
}

interface AppPlan {
	target: string;
	url: string;
	sha256: string;
	destination: string;
	link: string;
	replaces?: InstalledApp;
}

function planApp(ctx: DesktopContext, installed: InstalledApp | undefined, release: HerdrAppRelease): AppPlan | { error: string } | undefined {
	if (installed?.version && compareVersions(installed.version, release.version) >= 0) return undefined;
	const target = herdrTarget(ctx.platform, ctx.arch);
	const have = installed ? `Herdr app ${installed.version ?? "(unknown version)"} at ${installed.path} is older than ${release.version}` : `Herdr app ${release.version} or newer is not installed`;
	if (ctx.platform === "win32") {
		return { error: `${have}. Install it with Herdr's official installer, then run gentle-shell desktop again:\n  ${OFFICIAL_WINDOWS_INSTALL}` };
	}
	const sha256 = target ? release.sha256[target] : undefined;
	if (!target || !sha256) {
		return { error: `${have}, and Herdr publishes no ${release.version} build for ${ctx.platform}-${ctx.arch}. See https://herdr.dev/download/` };
	}
	const releases = (nonEmpty(ctx.env.HERDR_RELEASES_URL) ?? HERDR_RELEASES_URL).replace(/\/+$/, "");
	const destination = ctx.platform === "darwin"
		? join(ctx.home, "Applications", "Herdr.app")
		: join(nonEmpty(ctx.env.XDG_DATA_HOME) ?? join(ctx.home, ".local", "share"), "herdr-app");
	return {
		target,
		url: `${releases}/app/${release.version}/herdr-app-${target}.tar.gz`,
		sha256,
		destination,
		link: join(ctx.home, ".local", "bin", "herdr-app"),
		...(installed ? { replaces: installed } : {}),
	};
}

function replacePath(source: string, destination: string, scratch: string) {
	const old = join(scratch, "previous");
	const hadOld = existsSync(destination) || isSymlink(destination);
	if (hadOld) moveSync(destination, old);
	try {
		moveSync(source, destination);
	} catch (error) {
		if (hadOld) moveSync(old, destination);
		throw error;
	}
	rmSync(old, { recursive: true, force: true });
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function linkBinary(target: string, link: string) {
	mkdirSync(join(link, ".."), { recursive: true });
	if (isSymlink(link) || existsSync(link)) rmSync(link, { force: true });
	symlinkSync(target, link);
}

// The official install.sh steps (herdr-app distribution/install.sh) for one
// pinned version: download the release tarball, refuse it unless its SHA-256
// matches the pin, unpack, then place it where the official installer does.
// herdr-core is not installed here: Herdr app offers to set it up when it opens.
async function installApp(ctx: DesktopContext, paths: DesktopPaths, plan: AppPlan): Promise<string> {
	mkdirSync(paths.stateDir, { recursive: true });
	const scratch = join(paths.stateDir, `download-${process.pid}`);
	rmSync(scratch, { recursive: true, force: true });
	mkdirSync(join(scratch, "unpacked"), { recursive: true });
	try {
		const archive = join(scratch, `herdr-app-${plan.target}.tar.gz`);
		ctx.io.out(`Downloading ${plan.url} ...`);
		await ctx.io.download(plan.url, archive);
		const actual = ctx.io.sha256(archive);
		if (actual !== plan.sha256) throw new Error(`the Herdr app download failed its checksum (checksum mismatch: expected ${plan.sha256}, got ${actual}); nothing was installed`);
		const unpack = ctx.io.run("tar", ["-xzf", archive, "-C", join(scratch, "unpacked")], { env: ctx.env });
		if (unpack.status !== 0) throw new Error(`could not unpack ${archive}: ${unpack.stderr || unpack.error?.message || "tar failed"}`);
		if (ctx.platform === "darwin") {
			const app = join(scratch, "unpacked", "Herdr.app");
			if (!existsSync(app)) throw new Error("the Herdr app download has no Herdr.app");
			const signature = ctx.io.verifyMacSignature(app);
			if (signature !== undefined) throw new Error(`the Herdr app download is not validly signed: ${signature}`);
			mkdirSync(join(plan.destination, ".."), { recursive: true });
			replacePath(app, plan.destination, scratch);
			const binary = join(plan.destination, "Contents", "MacOS", "Herdr");
			linkBinary(binary, plan.link);
			ctx.io.run("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", plan.destination], { env: ctx.env });
			return plan.link;
		}
		const unpacked = join(scratch, "unpacked", "herdr-app");
		if (!existsSync(join(unpacked, "herdr-app"))) throw new Error("the Herdr app download has no herdr-app/herdr-app");
		mkdirSync(join(plan.destination, ".."), { recursive: true });
		replacePath(unpacked, plan.destination, scratch);
		linkBinary(join(plan.destination, "herdr-app"), plan.link);
		const data = join(plan.destination, "..");
		try {
			mkdirSync(join(data, "applications"), { recursive: true });
			mkdirSync(join(data, "icons", "hicolor", "scalable", "apps"), { recursive: true });
			if (existsSync(join(plan.destination, "herdr-app.svg"))) cpSync(join(plan.destination, "herdr-app.svg"), join(data, "icons", "hicolor", "scalable", "apps", "herdr-app.svg"));
			writeFileSync(join(data, "applications", "herdr-app.desktop"), [
				"[Desktop Entry]", "Type=Application", "Name=Herdr", "Comment=Terminals and coding agents that keep running",
				`Exec=${plan.link}`, "Icon=herdr-app", "Terminal=false", "Categories=Development;", "StartupWMClass=herdr-app", "",
			].join("\n"));
		} catch {
			// The launcher entry is a convenience; the app and its command are installed.
		}
		return plan.link;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

// --- mods and layout -----------------------------------------------------------

// rename, or copy + remove across file systems ($HERDR_APP_HOME elsewhere).
function moveSync(source: string, destination: string) {
	try {
		renameSync(source, destination);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
		rmSync(source, { recursive: true, force: true });
	}
}

interface Swap {
	target: string;
	movedTo?: string;
}

function rollback(swaps: Swap[]) {
	for (const swap of [...swaps].reverse()) {
		rmSync(swap.target, { recursive: true, force: true });
		if (swap.movedTo) moveSync(swap.movedTo, swap.target);
	}
}

// Removes each folder that is empty, in order (deepest first); others stay.
function removeEmptyDirs(dirs: string[]) {
	for (const dir of dirs) {
		try {
			rmdirSync(dir);
		} catch {
			// not empty, or already gone
		}
	}
}

function promoteBackup(paths: DesktopPaths) {
	const kept = existsSync(paths.backupNext) && readdirSync(paths.backupNext).some((name) => readdirSync(join(paths.backupNext, name)).length > 0);
	if (kept) {
		rmSync(paths.backup, { recursive: true, force: true });
		moveSync(paths.backupNext, paths.backup);
	} else {
		rmSync(paths.backupNext, { recursive: true, force: true });
	}
}

function prepareScratch(paths: DesktopPaths) {
	for (const dir of [paths.stage, paths.backupNext]) rmSync(dir, { recursive: true, force: true });
	for (const kind of ["mods", "layouts", "themes"]) for (const dir of [join(paths.stage, kind), join(paths.backupNext, kind)]) mkdirSync(dir, { recursive: true });
}

function cleanOriginals(paths: DesktopPaths) {
	removeEmptyDirs([join(paths.originals, "mods"), join(paths.originals, "layouts"), join(paths.originals, "themes"), paths.originals]);
}

// Where a path in Herdr's home goes when it is replaced or removed: our own
// copy rotates through backup.next; anything else is an original, kept until
// --uninstall. An original is never overwritten.
function moveAside(target: string, ours: boolean, backupName: string, originalName: string): string {
	if (ours) {
		moveSync(target, backupName);
		return backupName;
	}
	if (existsSync(originalName) || isSymlink(originalName)) {
		throw new Error(`${target} was not installed by Gentle Shell Desktop and ${originalName} already keeps an earlier original; move one of them elsewhere and run gentle-shell desktop again`);
	}
	mkdirSync(join(originalName, ".."), { recursive: true });
	moveSync(target, originalName);
	return originalName;
}

// Stages our mods and layout and runs `herdr-app check` on every staged mod;
// only then swaps each into Herdr's home. A path that was ours moves to the
// backup; anything else moves to the originals. Any failure puts every
// previous copy back and removes folders this install created.
function installAssets(ctx: DesktopContext, paths: DesktopPaths, assets: Assets, app: string, previous: DesktopState | undefined): string | undefined {
	prepareScratch(paths);
	const ownedMods = previous?.mods ?? [];
	const ownedThemes = previous?.themes ?? [];
	const ownedLayout = previous?.layout === true;
	try {
		for (const mod of assets.mods) {
			const staged = join(paths.stage, "mods", mod);
			mkdirSync(staged);
			for (const file of shippedFiles(join(assets.modsDir, mod))) {
				mkdirSync(join(staged, file, ".."), { recursive: true });
				cpSync(join(assets.modsDir, mod, file), join(staged, file));
			}
		}
		cpSync(assets.layoutFile, join(paths.stage, "layouts", `${DESKTOP_LAYOUT}.json`));
		for (const name of assets.themes) cpSync(join(assets.themesDir, name), join(paths.stage, "themes", name));
	} catch (error) {
		rmSync(paths.stage, { recursive: true, force: true });
		rmSync(paths.backupNext, { recursive: true, force: true });
		return `could not stage the Gentle mods in ${paths.stage}: ${(error as Error).message}; nothing in ${paths.herdrHome} was changed`;
	}
	for (const mod of assets.mods) {
		const result = ctx.io.run(app, ["check", join(paths.stage, "mods", mod)], { env: ctx.env });
		if (result.status !== 0) {
			rmSync(paths.stage, { recursive: true, force: true });
			rmSync(paths.backupNext, { recursive: true, force: true });
			const detail = `${result.stderr}${result.stdout}`.trim() || result.error?.message || `exit ${result.status}`;
			return `herdr-app check failed for ${mod}:\n${detail}\nthe Gentle mods and layout were not installed; nothing in ${paths.herdrHome} was changed`;
		}
	}
	const created = [paths.layouts, paths.mods, ...(assets.themes.length > 0 ? [paths.themes] : []), paths.herdrHome].filter((dir) => !existsSync(dir));
	const swaps: Swap[] = [];
	const swapIn = (staged: string, target: string, ours: boolean, kind: "mods" | "layouts" | "themes", name: string) => {
		const swap: Swap = { target };
		if (existsSync(target) || isSymlink(target)) swap.movedTo = moveAside(target, ours, join(paths.backupNext, kind, name), join(paths.originals, kind, name));
		swaps.push(swap);
		if (staged) moveSync(staged, target);
	};
	try {
		mkdirSync(paths.mods, { recursive: true });
		mkdirSync(paths.layouts, { recursive: true });
		for (const mod of assets.mods) swapIn(join(paths.stage, "mods", mod), join(paths.mods, mod), ownedMods.includes(mod), "mods", mod);
		// A gentle-* mod an earlier Gentle Shell installed and this one no longer ships;
		// what was there before it comes back.
		for (const mod of ownedMods) {
			if (assets.mods.includes(mod)) continue;
			const target = join(paths.mods, mod);
			if (existsSync(target)) swapIn("", target, true, "mods", mod);
			const original = join(paths.originals, "mods", mod);
			if (existsSync(original)) {
				moveSync(original, target);
				swaps.push({ target: original, movedTo: target });
			}
		}
		// The layout's themes go in before the layout that names them.
		if (assets.themes.length > 0) mkdirSync(paths.themes, { recursive: true });
		for (const name of assets.themes) swapIn(join(paths.stage, "themes", name), join(paths.themes, name), ownedThemes.includes(name), "themes", name);
		// A theme an earlier Gentle Shell installed and this one no longer ships; what was there before comes back.
		for (const name of ownedThemes) {
			if (assets.themes.includes(name)) continue;
			const target = join(paths.themes, name);
			if (existsSync(target)) swapIn("", target, true, "themes", name);
			const original = join(paths.originals, "themes", name);
			if (existsSync(original)) {
				moveSync(original, target);
				swaps.push({ target: original, movedTo: target });
			}
		}
		swapIn(join(paths.stage, "layouts", `${DESKTOP_LAYOUT}.json`), paths.layoutFile, ownedLayout, "layouts", `${DESKTOP_LAYOUT}.json`);
	} catch (error) {
		rollback(swaps);
		removeEmptyDirs(created);
		cleanOriginals(paths);
		rmSync(paths.stage, { recursive: true, force: true });
		rmSync(paths.backupNext, { recursive: true, force: true });
		return `could not install the Gentle mods into ${paths.herdrHome}: ${(error as Error).message}; restored the previous Gentle mods and layout`;
	}
	rmSync(paths.stage, { recursive: true, force: true });
	promoteBackup(paths);
	return undefined;
}

// --- keys.json ---------------------------------------------------------------------

// keys.json is the whole keymap: Herdr writes its defaults there on first start
// and never layers them under it (herdr-app src/keys.rs), so Gentle Shell only
// ever edits an existing file, as text: every byte outside the entries it adds
// stays as the person wrote it. state.json's `keys` is the tag: the entries in
// `entries` are ours while they still hold the action we wrote; a Gentle key
// the person deleted or rebound is theirs (`dropped`) and is never added again.

export type KeyAction = string | Record<string, unknown>;

interface KeysState {
	entries: Record<string, KeyAction>;
	dropped: string[];
	conflicts: string[];
	// Whether Gentle Shell added the layout:gentle-shell section itself.
	createdSection: boolean;
	// SHA-256 of keys.json as Gentle Shell last wrote it.
	written: string;
	// SHA-256 of keys.json as the FIRST Gentle write left it (never updated): only
	// then is the saved original still the whole truth.
	firstWritten?: string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringList = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

function parseKeysState(value: unknown): KeysState | undefined {
	if (!isPlainObject(value) || !isPlainObject(value.entries) || typeof value.written !== "string") return undefined;
	const entries: Record<string, KeyAction> = {};
	for (const [key, action] of Object.entries(value.entries)) if (typeof action === "string" || isPlainObject(action)) entries[key] = action;
	return { entries, dropped: stringList(value.dropped), conflicts: stringList(value.conflicts), createdSection: value.createdSection === true, written: value.written, ...(typeof value.firstWritten === "string" ? { firstWritten: value.firstWritten } : {}) };
}

const sha256Text = (text: string) => createHash("sha256").update(text).digest("hex");
const sameAction = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Herdr's sections (keys.rs `tab`): anything else makes Herdr reject the whole file.
const knownSection = (name: string) => name === "global" || name === "terminal" || /^(layout|mod):.+$/.test(name);

function readKeysText(text: string): { sections: Record<string, Record<string, unknown>> } | { problem: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { problem: `is not valid JSON (${(error as Error).message})` };
	}
	if (!isPlainObject(parsed)) return { problem: "must be a JSON object of sections (global, terminal, layout:<name>, mod:<name>)" };
	for (const [section, bindings] of Object.entries(parsed)) {
		if (!knownSection(section)) return { problem: `is not a keys file Herdr accepts: section ${JSON.stringify(section)} is not global, terminal, layout:<name> or mod:<name>` };
		if (!isPlainObject(bindings)) return { problem: `is not a keys file Herdr accepts: ${section} must be an object of key bindings` };
		for (const [keys, action] of Object.entries(bindings)) {
			if (typeof action !== "string" && !isPlainObject(action)) return { problem: `is not a keys file Herdr accepts: ${section}.${keys} must be a command string or an object` };
		}
	}
	return { sections: parsed as Record<string, Record<string, unknown>> };
}

// The same keystroke however it is spelled: modifiers in any order and case, cmd = super = win.
export function normalizeKeystroke(keys: string): string {
	const alias: Record<string, string> = { super: "cmd", win: "cmd", command: "cmd", option: "alt", control: "ctrl" };
	return keys.trim().split(/\s+/).map((stroke) => {
		if (stroke === "-") return "-";
		const parts = stroke.endsWith("--") ? [...stroke.slice(0, -2).split("-"), "-"] : stroke.split("-");
		const key = (parts.pop() ?? "").toLowerCase();
		const modifiers = parts.map((part) => alias[part.toLowerCase()] ?? part.toLowerCase());
		return [...new Set(modifiers)].sort().concat(key).join("-");
	}).join(" ");
}

// A minimal scanner for text JSON.parse already accepted: where each member of an
// object starts and ends, so entries are added, replaced or removed in place.
interface JsonMember {
	key: string;
	keyStart: number;
	valueStart: number;
	valueEnd: number;
}

interface JsonObject {
	open: number;
	close: number;
	members: JsonMember[];
}

const isJsonSpace = (char: string | undefined) => char === " " || char === "\t" || char === "\n" || char === "\r";

function skipSpace(text: string, index: number): number {
	let i = index;
	while (isJsonSpace(text[i])) i += 1;
	return i;
}

function skipString(text: string, index: number): number {
	let i = index + 1;
	while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
	return i + 1;
}

function skipValue(text: string, index: number): number {
	const first = text[index];
	if (first === '"') return skipString(text, index);
	if (first === "{" || first === "[") {
		let depth = 0;
		let i = index;
		for (;;) {
			const char = text[i];
			if (char === '"') {
				i = skipString(text, i);
				continue;
			}
			if (char === "{" || char === "[") depth += 1;
			else if (char === "}" || char === "]") {
				depth -= 1;
				if (depth === 0) return i + 1;
			}
			i += 1;
		}
	}
	let i = index;
	while (i < text.length && !isJsonSpace(text[i]) && text[i] !== "," && text[i] !== "}" && text[i] !== "]") i += 1;
	return i;
}

function objectAt(text: string, open: number): JsonObject {
	const members: JsonMember[] = [];
	let i = skipSpace(text, open + 1);
	if (text[i] === "}") return { open, close: i, members };
	for (;;) {
		const keyStart = skipSpace(text, i);
		const keyEnd = skipString(text, keyStart);
		const valueStart = skipSpace(text, skipSpace(text, keyEnd) + 1);
		const valueEnd = skipValue(text, valueStart);
		members.push({ key: JSON.parse(text.slice(keyStart, keyEnd)), keyStart, valueStart, valueEnd });
		i = skipSpace(text, valueEnd);
		if (text[i] !== ",") return { open, close: i, members };
		i += 1;
	}
}

// JSON.parse keeps the last of duplicate keys; so do we.
const lastMember = (object: JsonObject, key: string) => {
	for (let i = object.members.length - 1; i >= 0; i -= 1) if (object.members[i].key === key) return i;
	return -1;
};

// The whitespace from the start of the line to `index`, when only whitespace precedes it there.
function indentAt(text: string, index: number | undefined): string | undefined {
	if (index === undefined) return undefined;
	const lineStart = text.lastIndexOf("\n", index - 1) + 1;
	const before = text.slice(lineStart, index);
	return lineStart > 0 && /^[ \t]*$/.test(before) ? before : undefined;
}

function sectionAt(text: string): { root: JsonObject; index: number; section?: JsonObject } {
	const root = objectAt(text, skipSpace(text, 0));
	const index = lastMember(root, DESKTOP_KEYS_SECTION);
	const member = root.members[index];
	return { root, index, ...(member && text[member.valueStart] === "{" ? { section: objectAt(text, member.valueStart) } : {}) };
}

// Appends `"key": value` after the last member, or fills an empty object.
function insertMember(text: string, object: JsonObject, key: string, value: string, indent: string, closeIndent: string): string {
	const last = object.members.at(-1);
	if (last) return `${text.slice(0, last.valueEnd)},\n${indent}${JSON.stringify(key)}: ${value}${text.slice(last.valueEnd)}`;
	return `${text.slice(0, object.open + 1)}\n${indent}${JSON.stringify(key)}: ${value}\n${closeIndent}${text.slice(object.close)}`;
}

// The inverse of insertMember: the member and the separator before it.
function removeMember(text: string, object: JsonObject, index: number): string {
	const member = object.members[index];
	if (object.members.length === 1) return `${text.slice(0, object.open + 1)}${text.slice(object.close)}`;
	if (index > 0) return `${text.slice(0, object.members[index - 1].valueEnd)}${text.slice(member.valueEnd)}`;
	return `${text.slice(0, member.keyStart)}${text.slice(object.members[1].keyStart)}`;
}

function addKey(text: string, key: string, action: KeyAction): string {
	let at = sectionAt(text);
	const unit = indentAt(text, at.root.members[0]?.keyStart) ?? "  ";
	if (!at.section) {
		text = insertMember(text, at.root, DESKTOP_KEYS_SECTION, "{}", unit, "");
		at = sectionAt(text);
	}
	const section = at.section as JsonObject;
	const sectionIndent = indentAt(text, at.root.members[at.index].keyStart) ?? unit;
	const indent = indentAt(text, section.members[0]?.keyStart) ?? `${sectionIndent}${unit}`;
	return insertMember(text, section, key, JSON.stringify(action), indent, sectionIndent);
}

function replaceKey(text: string, key: string, action: KeyAction): string {
	const { section } = sectionAt(text);
	const member = section?.members[lastMember(section, key)];
	return member ? `${text.slice(0, member.valueStart)}${JSON.stringify(action)}${text.slice(member.valueEnd)}` : text;
}

function removeKey(text: string, key: string): string {
	const { section } = sectionAt(text);
	const index = section ? lastMember(section, key) : -1;
	return section && index >= 0 ? removeMember(text, section, index) : text;
}

// The section Gentle Shell added, once nothing is left in it.
function removeEmptySection(text: string, created: boolean): string {
	const at = sectionAt(text);
	return created && at.section && at.section.members.length === 0 ? removeMember(text, at.root, at.index) : text;
}

interface KeysConflict {
	key: string;
	theirs: string;
	theirAction: unknown;
	action: KeyAction;
}

interface KeysMerge {
	text: string;
	keys: Omit<KeysState, "written">;
	added: string[];
	conflicts: KeysConflict[];
}

// keys.json text with `shipped` (our layout:gentle-shell entries) merged in.
// `previous` says which entries are ours from an earlier merge.
function mergeKeys(original: string, shipped: Record<string, KeyAction>, previous: KeysState | undefined): KeysMerge | { problem: string } {
	const read = readKeysText(original);
	if ("problem" in read) return read;
	let text = original;
	const sectionNow = () => (JSON.parse(text) as Record<string, Record<string, unknown> | undefined>)[DESKTOP_KEYS_SECTION] ?? {};
	const own = (object: Record<string, unknown>, key: string) => (Object.hasOwn(object, key) ? object[key] : undefined);
	const entries: Record<string, KeyAction> = {};
	const dropped = new Set(previous?.dropped ?? []);
	const createdSection = previous ? previous.createdSection : !Object.hasOwn(read.sections, DESKTOP_KEYS_SECTION);
	for (const [key, action] of Object.entries(previous?.entries ?? {})) {
		const value = own(sectionNow(), key);
		if (value === undefined || !sameAction(value, action)) {
			dropped.add(key);
			continue;
		}
		if (!Object.hasOwn(shipped, key)) {
			text = removeKey(text, key);
			continue;
		}
		if (!sameAction(shipped[key], value)) text = replaceKey(text, key, shipped[key]);
		entries[key] = shipped[key];
	}
	const added: string[] = [];
	const conflicts: KeysConflict[] = [];
	for (const [key, action] of Object.entries(shipped)) {
		if (Object.hasOwn(entries, key) || dropped.has(key)) continue;
		const section = sectionNow();
		const theirs = Object.keys(section).find((bound) => normalizeKeystroke(bound) === normalizeKeystroke(key));
		if (theirs !== undefined) {
			if (theirs !== key || !sameAction(section[theirs], action)) conflicts.push({ key, theirs, theirAction: section[theirs], action });
			continue;
		}
		text = addKey(text, key, action);
		entries[key] = action;
		added.push(key);
	}
	text = removeEmptySection(text, createdSection);
	// What we wrote must read back as exactly what we meant.
	const check = readKeysText(text);
	if ("problem" in check || Object.entries(entries).some(([key, action]) => !sameAction(own(sectionNow(), key), action))) {
		return { problem: "could not be merged safely" };
	}
	return { text, keys: { entries, dropped: [...dropped], conflicts: conflicts.map((conflict) => conflict.key), createdSection }, added, conflicts };
}

// keys.json without the entries that are still ours.
function unmergeKeys(original: string, previous: KeysState): string | { problem: string } {
	const read = readKeysText(original);
	if ("problem" in read) return read;
	const section = read.sections[DESKTOP_KEYS_SECTION] ?? {};
	let text = original;
	for (const [key, action] of Object.entries(previous.entries)) {
		if (Object.hasOwn(section, key) && sameAction(section[key], action)) text = removeKey(text, key);
	}
	return removeEmptySection(text, previous.createdSection);
}

function writeAtomic(file: string, text: string) {
	let mode = 0o644;
	try {
		mode = statSync(file).mode & 0o777;
	} catch {
		// a new file
	}
	const temp = `${file}.gentle-${process.pid}.tmp`;
	writeFileSync(temp, text, { mode });
	renameSync(temp, file);
}

const keysRefusal = (subject: string) => `gentle-shell desktop: ${subject}; it was not changed and the Gentle shortcuts were not added. Fix it and run gentle-shell desktop again.`;

// Writes keys.json atomically, the previous file kept in keys-backup.json. A
// running Herdr reloads it at once: if it writes keys.error, the previous file
// goes back. Returns why it did not apply, or undefined.
async function writeKeys(ctx: DesktopContext, paths: DesktopPaths, previousText: string, text: string, running: boolean): Promise<string | undefined> {
	mkdirSync(paths.stateDir, { recursive: true });
	writeAtomic(paths.keysBackup, previousText);
	writeAtomic(paths.keysFile, text);
	if (!running) return undefined;
	for (let attempt = 0; attempt < KEYS_CHECK_ATTEMPTS; attempt += 1) {
		await ctx.io.sleep(KEYS_CHECK_INTERVAL_MS);
		if (existsSync(paths.keysError)) {
			const why = readTextOr(paths.keysError).trim() || "keys.error";
			writeAtomic(paths.keysFile, previousText);
			return why;
		}
	}
	return undefined;
}

function readTextOr(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

const isRunning = (ctx: DesktopContext, app: string | undefined) => app !== undefined && windowStatus(ctx, app) !== undefined;

// Adds or refreshes our shortcuts in keys.json. "missing": Herdr has not written
// keys.json yet (it does on its first start), so nothing was done.
async function syncKeys(ctx: DesktopContext, paths: DesktopPaths, shipped: Record<string, KeyAction>, app: string | undefined): Promise<"missing" | "done" | "failed"> {
	const state = readState(paths);
	if (!state) return "failed";
	if (!existsSync(paths.keysFile)) return "missing";
	const original = readFileSync(paths.keysFile, "utf8");
	const merged = mergeKeys(original, shipped, state.keys);
	if ("problem" in merged) {
		ctx.io.err(keysRefusal(`${paths.keysFile} ${merged.problem}`));
		return "failed";
	}
	const changed = merged.text !== original;
	const running = changed && isRunning(ctx, app);
	if (running && existsSync(paths.keysError)) {
		ctx.io.err(keysRefusal(`Herdr app reports a problem in your ${paths.keysFile} (${readTextOr(paths.keysError).trim()})`));
		return "failed";
	}
	if (changed) {
		if (!state.keys) {
			mkdirSync(join(paths.keysOriginal, ".."), { recursive: true });
			writeAtomic(paths.keysOriginal, original);
		}
		const rejected = await writeKeys(ctx, paths, original, merged.text, running);
		if (rejected !== undefined) {
			if (!state.keys) rmSync(paths.keysOriginal, { force: true });
			cleanOriginals(paths);
			ctx.io.err(`gentle-shell desktop: Herdr app did not accept the Gentle shortcuts (${rejected}); put back the previous ${paths.keysFile}.`);
			return "failed";
		}
	}
	const known = new Set(state.keys?.conflicts ?? []);
	for (const conflict of merged.conflicts) {
		if (known.has(conflict.key)) continue;
		ctx.io.err(`gentle-shell desktop: your ${paths.keysFile} binds ${conflict.theirs} to ${JSON.stringify(conflict.theirAction)} in ${DESKTOP_KEYS_SECTION}; kept yours, so the Gentle shortcut ${conflict.key} (${typeof conflict.action === "string" ? conflict.action : JSON.stringify(conflict.action)}) was not added.`);
	}
	const written = changed ? sha256Text(merged.text) : state.keys?.written ?? sha256Text(original);
	const firstWritten = state.keys ? state.keys.firstWritten : changed ? written : undefined;
	writeState(paths, { ...state, keys: { ...merged.keys, written, ...(firstWritten ? { firstWritten } : {}) } });
	if (merged.added.length > 0) ctx.io.out(`Added the Gentle shortcuts ${merged.added.join(", ")} to ${paths.keysFile} (${DESKTOP_KEYS_SECTION}); the previous file is in ${paths.keysBackup}.`);
	else if (changed) ctx.io.out(`Updated the Gentle shortcuts in ${paths.keysFile} (${DESKTOP_KEYS_SECTION}); the previous file is in ${paths.keysBackup}.`);
	return "done";
}

// Removes the entries that are still ours. Returns false when keys.json could not be changed.
async function removeKeys(ctx: DesktopContext, paths: DesktopPaths, keys: KeysState, app: string | undefined): Promise<boolean> {
	if (!existsSync(paths.keysFile)) {
		rmSync(paths.keysOriginal, { force: true });
		return true;
	}
	const current = readFileSync(paths.keysFile, "utf8");
	// Untouched since our first write: the file from before Gentle Shell, byte for byte.
	const text = sha256Text(current) === keys.firstWritten && existsSync(paths.keysOriginal) ? readFileSync(paths.keysOriginal, "utf8") : unmergeKeys(current, keys);
	if (typeof text !== "string") {
		ctx.io.err(`gentle-shell desktop: ${paths.keysFile} ${text.problem}; it was not changed, so the Gentle shortcuts are still in it. Fix it and run gentle-shell desktop --uninstall again.`);
		return false;
	}
	if (text !== current) {
		const rejected = await writeKeys(ctx, paths, current, text, isRunning(ctx, app));
		if (rejected !== undefined) {
			ctx.io.err(`gentle-shell desktop: Herdr app did not accept ${paths.keysFile} without the Gentle shortcuts (${rejected}); put it back as it was.`);
			return false;
		}
	}
	rmSync(paths.keysOriginal, { force: true });
	ctx.io.out(`Removed the Gentle shortcuts from ${paths.keysFile}; your own keys are unchanged.`);
	return true;
}

// --- the Herdr window ------------------------------------------------------------

function windowStatus(ctx: DesktopContext, app: string): { layout?: string; errors: unknown[] } | undefined {
	const result = ctx.io.run(app, ["status"], { env: ctx.env });
	if (result.status !== 0) return undefined;
	try {
		const parsed = JSON.parse(result.stdout);
		return { ...(typeof parsed?.layout === "string" ? { layout: parsed.layout } : {}), errors: Array.isArray(parsed?.errors) ? parsed.errors : [] };
	} catch {
		return { errors: [] };
	}
}

async function ensureWindow(ctx: DesktopContext, app: string) {
	const running = windowStatus(ctx, app);
	if (running) return running;
	ctx.io.out("Starting Herdr app ...");
	ctx.io.spawnDetached(app, [], { env: ctx.env, cwd: ctx.cwd });
	for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
		await ctx.io.sleep(START_INTERVAL_MS);
		const status = windowStatus(ctx, app);
		if (status) return status;
	}
	return undefined;
}

function sameFolder(a: unknown, b: string): boolean {
	if (typeof a !== "string") return false;
	const real = (path: string) => {
		try {
			return realpathSync(path);
		} catch {
			return path;
		}
	};
	return real(a) === real(b);
}

function hasGentleSpace(listing: unknown, cwd: string): boolean {
	const spaces = (listing as { spaces?: unknown })?.spaces;
	if (!Array.isArray(spaces)) return false;
	return spaces.some((space) => sameFolder(space?.folder, cwd) && Array.isArray(space?.tabs)
		&& space.tabs.some((tab: { terminals?: unknown }) => Array.isArray(tab?.terminals) && tab.terminals.some((terminal: { app?: unknown }) => terminal?.app === "gentle-shell")));
}

function herdrDo(ctx: DesktopContext, app: string, command: string, payload: Record<string, unknown>): RunResult {
	return ctx.io.run(app, ["do", command, JSON.stringify(payload)], { env: ctx.env, cwd: ctx.cwd });
}

const keysDeferred = (paths: DesktopPaths) => `Herdr writes ${paths.keysFile} when its window first opens; the Gentle shortcuts are added the next time gentle-shell desktop opens Herdr.`;

async function openDesktop(ctx: DesktopContext, paths: DesktopPaths, app: string, keys: Record<string, KeyAction> | undefined): Promise<number> {
	const status = await ensureWindow(ctx, app);
	if (!status) {
		ctx.io.err("gentle-shell desktop: Herdr app did not open its window. Open Herdr (it may ask to set up herdr-core), then run gentle-shell desktop again.");
		return 1;
	}
	// Shortcuts waiting for the keys.json Herdr writes on its first start.
	if (keys) {
		for (let attempt = 0; attempt < KEYS_WAIT_ATTEMPTS && !existsSync(paths.keysFile); attempt += 1) await ctx.io.sleep(START_INTERVAL_MS);
		if ((await syncKeys(ctx, paths, keys, app)) === "missing") ctx.io.out(keysDeferred(paths));
	}
	const state = readState(paths);
	if (state && status.layout && status.layout !== DESKTOP_LAYOUT && state.previousLayout !== status.layout) {
		writeState(paths, { ...state, previousLayout: status.layout });
	}
	const switched = herdrDo(ctx, app, "layout.switch", { name: DESKTOP_LAYOUT });
	if (switched.status !== 0) {
		ctx.io.err(`gentle-shell desktop: Herdr app could not switch to the ${DESKTOP_LAYOUT} layout: ${`${switched.stderr}${switched.stdout}`.trim() || `exit ${switched.status}`}`);
		return 1;
	}
	const listed = ctx.io.run(app, ["ls"], { env: ctx.env });
	let listing: unknown;
	try {
		listing = JSON.parse(listed.stdout);
	} catch {
		listing = undefined;
	}
	if (listed.status === 0 && !hasGentleSpace(listing, ctx.cwd)) {
		const created = herdrDo(ctx, app, "space.new", { folder: ctx.cwd, argv: ["gentle-shell"] });
		if (created.status !== 0) ctx.io.err(`gentle-shell desktop: could not open a Gentle Shell space in ${ctx.cwd}: ${`${created.stderr}${created.stdout}`.trim()}`);
	}
	const after = windowStatus(ctx, app);
	if (after && after.errors.length > 0) ctx.io.err(`gentle-shell desktop: Herdr app reports: ${JSON.stringify(after.errors)}`);
	ctx.io.out(`Herdr app is showing the ${DESKTOP_LAYOUT} layout.`);
	return 0;
}

// --- commands ----------------------------------------------------------------------

// The agent homes Gentle Shell Desktop's mods read without being told
// (docs/desktop-feed.md, "where readers look").
// The same directory can arrive with a trailing separator; compare without it.
const trimSlashes = (path: string): string => path.replace(/[\\/]+$/, "") || path;
// snapshot.js keeps at most eight agent homes after the two defaults.
const MOD_ROOTS = 8;
const isAbsolutePath = (path: string): boolean => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
const knownRoots = (home: string): string[] => [join(home, ".gentle-shell", "agent"), join(home, ".pi", "agent")];

// The agent home this install runs its sessions in: an explicit override, else the
// Agent a separate install recorded in installation.json, else Pi's default.
export function desktopAgentDir(ctx: DesktopContext): string {
	const explicit = ctx.env.GENTLE_PI_AGENT_HOME || ctx.env.PI_CODING_AGENT_DIR;
	if (explicit) return explicit;
	try {
		const installRoot = join(ctx.packageRoot, "..", "..", "..", "..");
		const agent = JSON.parse(readFileSync(join(installRoot, "installation.json"), "utf8"))?.Agent;
		if (typeof agent === "string" && agent.length > 0) return agent;
	} catch {}
	return join(ctx.home, ".pi", "agent");
}

// What the mods actually read: one snapshot per publishing session under
// <agent home>/desktop/sessions. No file means no session in the window, whatever else is right.
export function feedStatusLine(agentDir: string, now: number = Date.now()): string {
	const dir = join(agentDir, "desktop", "sessions");
	let files: string[] = [];
	try {
		files = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return `  Feed: none at ${dir}; start a session with gentle-shell and the window will see it`;
	}
	if (files.length === 0) return `  Feed: none at ${dir}; start a session with gentle-shell and the window will see it`;
	let newest = 0;
	for (const name of files) {
		try {
			const at = statSync(join(dir, name)).mtimeMs;
			if (at > newest) newest = at;
		} catch {}
	}
	const age = newest === 0 ? "unknown age" : `${Math.max(0, Math.round((now - newest) / 1000))}s old`;
	return `  Feed: ${files.length} session snapshot${files.length === 1 ? "" : "s"} in ${dir} (newest ${age})`;
}

// A separate install keeps its agent outside the homes the mods read, so the window
// shows "No Gentle Shell session here" until that home is listed. Report it, read-only.
export function rootsStatusLine(paths: DesktopPaths, home: string, agentDir: string): string | undefined {
	if (knownRoots(home).includes(trimSlashes(agentDir))) return undefined;
	// The mods read this exact path: they ignore HERDR_APP_HOME and XDG_CONFIG_HOME. They also
	// trim, drop non-absolute entries and keep at most MOD_ROOTS homes after the two defaults, so
	// this check has to filter in the same order or it warns about a root that is read.
	const file = join(home, ".config", "herdr-app", "gentle-shell-roots.json");
	let listed: string[] = [];
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		const roots = Array.isArray(parsed) ? parsed : parsed?.roots;
		if (Array.isArray(roots)) listed = roots.filter((root: unknown): root is string => typeof root === "string");
	} catch {}
	const expanded = listed
		.map((root) => root.trim())
		.filter((root) => root.length > 0)
		// The reader concatenates instead of joining, so "~/r/." stays distinct from "~/r"; join() would
		// collapse the dot segment and merge two roots the mods keep apart.
		.map((root) => (root === "~" ? home : root.startsWith("~/") ? `${home}${root.slice(1)}` : root));
	const order = [...knownRoots(home).map(trimSlashes), ...expanded.map(trimSlashes)].filter(isAbsolutePath);
	const seen = new Set<string>();
	const read: string[] = [];
	for (const root of order) {
		if (seen.has(root)) continue;
		seen.add(root);
		read.push(root);
	}
	if (read.slice(0, MOD_ROOTS).includes(trimSlashes(agentDir))) return `  Roots: ${agentDir} listed in ${file}`;
	const entry = JSON.stringify([agentDir]);
	if (read.length >= MOD_ROOTS) {
		return `  Roots: ${agentDir} is not read by the mods: the first ${MOD_ROOTS} roots are taken, so adding it does not help; move it into the first ${MOD_ROOTS} in ${file} or remove an earlier one`;
	}
	return `  Roots: ${agentDir} is not read by the mods; add ${entry} to ${file}`;
}

function printStatus(ctx: DesktopContext, paths: DesktopPaths, assets: Assets | { error: string }, release: HerdrAppRelease): number {
	const app = detectApp(ctx);
	const shipped = "mods" in assets ? assets.mods : [];
	const installed = (readState(paths)?.mods ?? []).concat(shipped).filter((mod, index, all) => all.indexOf(mod) === index && existsSync(join(paths.mods, mod))).sort();
	const missing = shipped.filter((mod) => !installed.includes(mod));
	const window = app ? windowStatus(ctx, app.path) : undefined;
	const needs = `needs ${release.version} or newer`;
	ctx.io.out("Gentle Shell Desktop");
	ctx.io.out(`  Gentle Shell: ${ctx.shellVersion}`);
	ctx.io.out(app ? `  Herdr app: ${app.version ?? "unknown version"} at ${app.path} (${needs})` : `  Herdr app: not installed (${needs})`);
	ctx.io.out(`  Herdr home: ${paths.herdrHome}`);
	const rootsLine = rootsStatusLine(paths, ctx.home, desktopAgentDir(ctx));
	if (rootsLine !== undefined) ctx.io.out(rootsLine);
	ctx.io.out(feedStatusLine(desktopAgentDir(ctx)));
	ctx.io.out(existsSync(paths.layoutFile) ? `  Layout ${DESKTOP_LAYOUT}: installed at ${paths.layoutFile}` : `  Layout ${DESKTOP_LAYOUT}: not installed`);
	const themes = "mods" in assets ? assets.themes : [];
	if (themes.length > 0) {
		const present = themes.filter((name) => existsSync(join(paths.themes, name)));
		ctx.io.out(present.length === 0 ? `  Themes: none installed (ships ${themes.join(", ")})` : `  Themes: ${present.join(", ")} installed in ${paths.themes}${present.length < themes.length ? `; missing ${themes.filter((name) => !present.includes(name)).join(", ")}` : ""}`);
	}
	if (installed.length === 0) ctx.io.out(`  Mods: none installed (ships ${shipped.join(", ")})`);
	else ctx.io.out(`  Mods: ${installed.join(", ")} installed in ${paths.mods}${missing.length > 0 ? `; missing ${missing.join(", ")}` : ""}`);
	if ("mods" in assets && assets.keys) {
		const keys = readState(paths)?.keys;
		ctx.io.out(keys ? `  Keys: ${Object.keys(keys.entries).length} Gentle shortcuts in ${paths.keysFile} (${DESKTOP_KEYS_SECTION})` : "  Keys: Gentle shortcuts not added");
	}
	ctx.io.out(window ? `  Window: running, layout ${window.layout ?? "unknown"}` : "  Window: not running");
	return 0;
}

async function uninstall(ctx: DesktopContext, paths: DesktopPaths): Promise<number> {
	const state = readState(paths);
	const ours = (state?.mods ?? []).filter((mod) => existsSync(join(paths.mods, mod)));
	const layoutOurs = state?.layout === true && existsSync(paths.layoutFile);
	const themesOurs = (state?.themes ?? []).filter((name) => existsSync(join(paths.themes, name)));
	if (ours.length === 0 && !layoutOurs && themesOurs.length === 0 && !state?.keys) {
		rmSync(paths.stateFile, { force: true });
		ctx.io.out(`Gentle Shell Desktop mods and layout are not installed in ${paths.herdrHome}; nothing to remove.`);
		return 0;
	}
	const app = detectApp(ctx);
	const keysKept = state?.keys && !(await removeKeys(ctx, paths, state.keys, app?.path)) ? state.keys : undefined;
	const restored: string[] = [];
	if (ours.length > 0 || layoutOurs || themesOurs.length > 0) {
		prepareScratch(paths);
		rmSync(paths.stage, { recursive: true, force: true });
		const putBack = (kind: "mods" | "layouts" | "themes", name: string, target: string) => {
			const original = join(paths.originals, kind, name);
			if (!existsSync(original) && !isSymlink(original)) return;
			moveSync(original, target);
			restored.push(kind === "mods" ? `mods ${name}` : kind === "themes" ? `theme ${name}` : `layout ${DESKTOP_LAYOUT}`);
		};
		for (const mod of ours) {
			moveSync(join(paths.mods, mod), join(paths.backupNext, "mods", mod));
			putBack("mods", mod, join(paths.mods, mod));
		}
		if (layoutOurs) {
			moveSync(paths.layoutFile, join(paths.backupNext, "layouts", `${DESKTOP_LAYOUT}.json`));
			putBack("layouts", `${DESKTOP_LAYOUT}.json`, paths.layoutFile);
		}
		for (const name of themesOurs) {
			moveSync(join(paths.themes, name), join(paths.backupNext, "themes", name));
			putBack("themes", name, join(paths.themes, name));
		}
		promoteBackup(paths);
	}
	cleanOriginals(paths);
	// Shortcuts that could not be removed stay recorded, so a later --uninstall still finds them.
	if (keysKept) writeState(paths, { mods: [], layout: false, keys: keysKept });
	else rmSync(paths.stateFile, { force: true });
	if (ours.length === 0 && !layoutOurs && themesOurs.length === 0) return keysKept ? 1 : 0;
	const window = app ? windowStatus(ctx, app.path) : undefined;
	if (app && window?.layout === DESKTOP_LAYOUT) {
		const back = state?.previousLayout ?? "main";
		const switched = herdrDo(ctx, app.path, "layout.switch", { name: back });
		if (switched.status !== 0) ctx.io.err(`gentle-shell desktop: could not switch Herdr app back to the ${back} layout; choose another layout in Herdr.`);
	}
	ctx.io.out(`Removed Gentle Shell Desktop ${themesOurs.length > 0 ? "mods, layout and themes" : "mods and layout"} from ${paths.herdrHome}; a copy is in ${paths.backup}. Herdr app itself stays installed.`);
	if (restored.length > 0) ctx.io.out(`Put back what was there before Gentle Shell Desktop: ${restored.join(", ")} in ${paths.herdrHome}.`);
	return keysKept ? 1 : 0;
}

// "mods a, b and layout gentle-shell", or with themes "mods a, b, layout gentle-shell and themes x, y".
const assetsText = (assets: Assets) => (assets.themes.length > 0
	? `mods ${assets.mods.join(", ")}, layout ${DESKTOP_LAYOUT} and themes ${assets.themes.join(", ")}`
	: `mods ${assets.mods.join(", ")} and layout ${DESKTOP_LAYOUT}`);

async function refresh(ctx: DesktopContext, paths: DesktopPaths, assets: Assets | { error: string }): Promise<number> {
	const state = readState(paths);
	if (!state) return 0;
	if ("error" in assets) {
		ctx.io.err(`gentle-shell desktop: ${assets.error}`);
		return 1;
	}
	const app = detectApp(ctx);
	if (!app) {
		ctx.io.err("gentle-shell desktop: Herdr app is not installed, so the Gentle mods were not refreshed; run gentle-shell desktop.");
		return 1;
	}
	if (!assetsUpToDate(assets, paths) || !(state.mods ?? []).every((mod) => assets.mods.includes(mod)) || !(state.themes ?? []).every((name) => assets.themes.includes(name))) {
		const failure = installAssets(ctx, paths, assets, app.path, state);
		if (failure !== undefined) {
			ctx.io.err(`gentle-shell desktop: ${failure}`);
			return 1;
		}
		writeState(paths, { ...state, mods: assets.mods, themes: assets.themes, layout: true });
		ctx.io.out(`Gentle Shell Desktop: refreshed ${assetsText(assets)} in ${paths.herdrHome}.`);
	}
	// Only shortcuts the person already accepted with gentle-shell desktop are refreshed.
	if (assets.keys && state.keys) await syncKeys(ctx, paths, assets.keys, app.path);
	return 0;
}

export async function runDesktop(ctx: DesktopContext): Promise<number> {
	const parsed = parseDesktopArgs(ctx.args);
	if ("error" in parsed) {
		ctx.io.err(`gentle-shell desktop: ${parsed.error}`);
		ctx.io.err(desktopUsage());
		return 2;
	}
	if (parsed.action === "help") {
		ctx.io.out(desktopUsage());
		return 0;
	}
	const release = ctx.release ?? HERDR_APP_RELEASE;
	const paths = desktopPaths(ctx.env, ctx.home);
	const assets = shippedAssets(ctx.packageRoot);
	if (parsed.action === "status") return printStatus(ctx, paths, assets, release);
	if (parsed.action === "uninstall") return await uninstall(ctx, paths);
	if (parsed.action === "refresh") return await refresh(ctx, paths, assets);
	if ("error" in assets) {
		ctx.io.err(`gentle-shell desktop: ${assets.error}`);
		return 1;
	}

	const installed = detectApp(ctx);
	const planned = planApp(ctx, installed, release);
	if (planned && "error" in planned) {
		ctx.io.err(`gentle-shell desktop: ${planned.error}`);
		return 1;
	}
	const appPlan = planned as AppPlan | undefined;
	const previous = readState(paths);
	const assetsNeeded = !previous || !assetsUpToDate(assets, paths);
	// Never merged yet: asked for with the rest. A keys.json Herdr has not written yet is
	// merged once the window opens (and with --no-open, the next time it does).
	const keysNeeded = assets.keys !== undefined && !previous?.keys && (parsed.open || existsSync(paths.keysFile));
	if (appPlan || assetsNeeded || keysNeeded) {
		ctx.io.out("Gentle Shell Desktop will:");
		if (appPlan) {
			const where = `${appPlan.destination} and link ${appPlan.link}`;
			ctx.io.out(appPlan.replaces
				? `  - replace Herdr app ${appPlan.replaces.version ?? "(unknown version)"} at ${appPlan.replaces.path} with ${release.version} (${appPlan.target}) into ${where}`
				: `  - install Herdr app ${release.version} (${appPlan.target}) into ${where}`);
			ctx.io.out(`      from ${appPlan.url}`);
			ctx.io.out(`      verified against SHA-256 ${appPlan.sha256} (pinned by Gentle Shell ${ctx.shellVersion})`);
		}
		if (assetsNeeded) {
			ctx.io.out(`  - install mods ${assets.mods.join(", ")} into ${paths.mods}`);
			ctx.io.out(`  - install layout ${DESKTOP_LAYOUT} into ${paths.layoutFile}`);
			if (assets.themes.length > 0) ctx.io.out(`  - install its light and dark themes ${assets.themes.join(", ")} into ${paths.themes}`);
			ctx.io.out(`  - check each mod with herdr-app check before installing anything`);
			ctx.io.out(`  - keep anything Gentle Shell did not install at those paths in ${paths.originals}, put back by --uninstall`);
			ctx.io.out(`  - keep our own previous copy in ${paths.backup}`);
		}
		if (keysNeeded) {
			ctx.io.out(`  - add the Gentle shortcuts (${DESKTOP_KEYS_SECTION}) to ${paths.keysFile}, keeping every key you already use`);
			ctx.io.out(`      a key you already bind there stays yours; --uninstall removes exactly ours`);
		}
		if (assetsNeeded || keysNeeded) {
			ctx.io.out(`  Your other mods, layouts, keys and settings in ${paths.herdrHome} are not touched.`);
		}
		if (!parsed.yes) {
			if (!ctx.interactive) {
				ctx.io.err("gentle-shell desktop: nothing was installed. Run it in an interactive terminal to confirm, or pass --yes.");
				return 1;
			}
			const answer = (await ctx.io.ask("Install Gentle Shell Desktop as shown above? [y/N] ")).trim().toLowerCase();
			if (answer !== "y" && answer !== "yes") {
				ctx.io.err("gentle-shell desktop: nothing was installed.");
				return 1;
			}
		}
	}

	let app = installed?.path;
	if (appPlan) {
		try {
			app = await installApp(ctx, paths, appPlan);
		} catch (error) {
			ctx.io.err(`gentle-shell desktop: ${(error as Error).message}`);
			return 1;
		}
		ctx.io.out(`Installed Herdr app ${release.version} at ${appPlan.destination}.`);
		if (!findOnPath("herdr-core", ctx.env, ctx.platform) && !existsSync(join(paths.localBin, "herdr-core"))) {
			ctx.io.out("Herdr app sets up herdr-core (the terminal runtime) itself when it opens.");
		}
	}
	if (!app) {
		ctx.io.err("gentle-shell desktop: Herdr app is not available.");
		return 1;
	}
	if (assetsNeeded) {
		const failure = installAssets(ctx, paths, assets, app, previous);
		if (failure !== undefined) {
			ctx.io.err(`gentle-shell desktop: ${failure}`);
			return 1;
		}
		writeState(paths, { mods: assets.mods, themes: assets.themes, layout: true, ...(previous?.previousLayout ? { previousLayout: previous.previousLayout } : {}), ...(previous?.keys ? { keys: previous.keys } : {}) });
		ctx.io.out(`Installed ${assetsText(assets)} in ${paths.herdrHome}.`);
	} else {
		ctx.io.out("Gentle Shell Desktop is up to date.");
	}
	const keysPending = assets.keys !== undefined && (await syncKeys(ctx, paths, assets.keys, app)) === "missing";
	if (!parsed.open) {
		if (keysPending) ctx.io.out(keysDeferred(paths));
		return 0;
	}
	return openDesktop(ctx, paths, app, keysPending ? assets.keys : undefined);
}

// --- the real process --------------------------------------------------------------

export function nodeDesktopIO(): Omit<DesktopIO, "ask" | "out" | "err"> {
	const run: DesktopIO["run"] = (command, args, options) => {
		const result = spawnSync(command, args, { env: options.env, cwd: options.cwd, encoding: "utf8", timeout: 10 * 60_000, stdio: ["ignore", "pipe", "pipe"] });
		return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ...(result.error ? { error: result.error } : {}) };
	};
	return {
		run,
		spawnDetached: (command, args, options) => {
			const child = spawn(command, args, { env: options.env, cwd: options.cwd, detached: true, stdio: "ignore" });
			child.on("error", () => {});
			child.unref();
		},
		// curl, as the official installer uses; the pinned SHA-256 is what is trusted.
		download: async (url, file) => {
			const result = run("curl", ["-fsSL", "--retry", "2", "-o", file, url], { env: process.env });
			if (result.status !== 0) throw new Error(`download of ${url} failed: ${result.stderr.trim() || result.error?.message || `curl exit ${result.status}`}`);
		},
		sha256: (file) => createHash("sha256").update(readFileSync(file)).digest("hex"),
		// The official installer's rule for release builds: a Developer ID signature that verifies.
		verifyMacSignature: (app) => {
			const info = run("/usr/bin/codesign", ["-dvv", app], { env: process.env });
			if (!/^Authority=Developer ID Application:/m.test(`${info.stderr}${info.stdout}`)) return `no Developer ID signature (${info.stderr.trim() || info.error?.message || "codesign failed"})`;
			const verify = run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { env: process.env });
			return verify.status === 0 ? undefined : `invalid signature: ${verify.stderr.trim()}`;
		},
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	};
}
