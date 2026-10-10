// Main channel: Gentle Shell and Gentle AI built from the latest `main` commits.
//
// Neither repository publishes main builds, so both are produced locally from
// an exact commit SHA resolved at install or upgrade time:
//   - Gentle AI: `go install <module>@<sha>` in a sealed Go environment, so the
//     module source is verified by Go's checksum database (sum.golang.org), as
//     the Windows release build already is. The binary must report a version
//     naming that commit, then it is activated through the existing dev-binary
//     override, which never falls back to the pinned binary silently.
//   - Gentle Shell: the exact commit's source tarball, versioned
//     `<version>-main.<sha12>` and packed without `prepack` (which runs the full
//     test suite), then installed globally like any local tarball.
// The recorded channel lets `gentle-shell upgrade` follow release or main.
import { dirname, isAbsolute, join, posix, relative, win32 } from "node:path";
import { gentleAiDevBinaryRegistrationPath, registerGentleAiDevBinary, unregisterGentleAiDevBinary } from "../runtime/gentle-ai-binary.mjs";
import { installedGo } from "./installer-downloads.mjs";
import { pnpmGlobalBin, requirements } from "./installer-preflight.mjs";

export const SHELL_REPOSITORY = "Gentleman-Programming/gentle-shell";
export const GENTLE_AI_REPOSITORY = "Gentleman-Programming/gentle-ai";
export const GENTLE_AI_MAIN_PACKAGE = "github.com/gentleman-programming/gentle-ai/v4/cmd/gentle-ai";
export const CHANNEL_SCHEMA = "gentle-shell.channel/v1";
export const CHANNELS = Object.freeze(["release", "main"]);

const SHA = /^[0-9a-f]{40}$/;
const MINUTE = 60_000;
const deadlines = Object.freeze({ build: 15 * MINUTE, version: 30_000, extract: 2 * MINUTE, pack: 5 * MINUTE });
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;

export class MainChannelError extends Error {
	constructor(code, message) {
		super(`${code}: ${message}`);
		this.name = "MainChannelError";
		this.code = code;
	}
}

/** Same config home as the dev-binary override: GENTLE_PI_CONFIG_HOME or ~/.pi/gentle-ai. */
export function configHome({ env, home }) {
	return env.GENTLE_PI_CONFIG_HOME ?? join(home, ".pi", "gentle-ai");
}
export function channelStatePath(ctx) {
	return join(configHome(ctx), "channel.json");
}

function validState(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value) || value.schema !== CHANNEL_SCHEMA) return null;
	if (value.channel === "release" && Object.keys(value).length === 2) return { channel: "release" };
	if (value.channel === "main" && Object.keys(value).length === 4 && SHA.test(value.shellCommit) && SHA.test(value.gentleAiCommit)) {
		return { channel: "main", shellCommit: value.shellCommit, gentleAiCommit: value.gentleAiCommit };
	}
	return null;
}

/** The recorded channel; no record means release. A malformed record fails closed. */
export async function readChannel(ctx, fs) {
	let text;
	try {
		text = await fs.readFile(channelStatePath(ctx), "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return { channel: "release" };
		throw new MainChannelError("channel-state-invalid", `${channelStatePath(ctx)} could not be read`);
	}
	let parsed = null;
	try { parsed = validState(JSON.parse(text)); } catch { parsed = null; }
	if (!parsed) throw new MainChannelError("channel-state-invalid", `${channelStatePath(ctx)} is not a valid ${CHANNEL_SCHEMA} record; fix or remove it`);
	return parsed;
}

export async function writeChannel(ctx, state, fs) {
	const record = { schema: CHANNEL_SCHEMA, ...state };
	if (!validState(record)) throw new MainChannelError("channel-state-invalid", "refusing to record an invalid channel state");
	const path = channelStatePath(ctx);
	await fs.mkdir(dirname(path), { recursive: true });
	await fs.writeFile(`${path}.tmp`, `${JSON.stringify(record)}\n`);
	await fs.rename(`${path}.tmp`, path);
}

/** Latest commit of `main` as an exact SHA (GitHub's raw-SHA media type). */
export async function resolveMainCommit(repository, { fetch }) {
	let response;
	try {
		response = await fetch(`https://api.github.com/repos/${repository}/commits/main`, {
			headers: { Accept: "application/vnd.github.sha", "User-Agent": "gentle-shell" },
		});
	} catch {
		throw new MainChannelError("main-commit-unavailable", `the latest main commit of ${repository} could not be fetched`);
	}
	const sha = response?.ok ? String(await response.text()).trim() : "";
	if (!SHA.test(sha)) {
		throw new MainChannelError("main-commit-unavailable", `GitHub did not return the latest main commit of ${repository} (HTTP ${response?.status ?? "error"})`);
	}
	return sha;
}

export function mainVersion(baseVersion, commit) {
	return `${baseVersion}-main.${commit.slice(0, 12)}`;
}

function succeeded(result) {
	return result?.code === 0 && result.timedOut !== true && result.signal == null;
}

function sealedGoEnvironment(goPath, buildDirectory, platform) {
	const temporary = join(buildDirectory, "tmp");
	const base = {
		// -modcacherw: Go makes its module cache read-only, which would stop its removal.
		GOENV: "off", GOFLAGS: "-modcacherw", GOWORK: "off", GOTOOLCHAIN: "local", GOSUMDB: "sum.golang.org",
		GONOSUMDB: "", GOPRIVATE: "", GONOPROXY: "", GOINSECURE: "", GOPROXY: "https://proxy.golang.org", CGO_ENABLED: "0",
		GOBIN: join(buildDirectory, "gobin"), GOPATH: join(buildDirectory, "gopath"),
		GOMODCACHE: join(buildDirectory, "gomodcache"), GOCACHE: join(buildDirectory, "gocache"),
	};
	if (platform === "win32") {
		const root = process.env.SystemRoot ?? "C:\\Windows";
		return { ...base, SystemRoot: root, TEMP: temporary, TMP: temporary, PATH: [dirname(goPath), join(root, "System32"), root].join(";") };
	}
	return { ...base, HOME: buildDirectory, TMPDIR: temporary, PATH: [dirname(goPath), "/usr/bin", "/bin"].join(":") };
}

/** Builds Gentle AI from `commit`, verifies the binary names it and registers it as the override. */
export async function buildMainGentleAi({ commit, ctx, platform, goPath, run, fs }) {
	if (!SHA.test(commit)) throw new MainChannelError("main-gentle-ai-unverified", "the Gentle AI commit is not an exact SHA");
	const executable = platform === "win32" ? "gentle-ai.exe" : "gentle-ai";
	const directory = join(configHome(ctx), "main", "gentle-ai", commit);
	const buildDirectory = join(configHome(ctx), "main", ".build");
	await fs.rm(buildDirectory, { recursive: true, force: true });
	const env = sealedGoEnvironment(goPath, buildDirectory, platform);
	for (const path of [env.GOBIN, env.GOPATH, env.GOMODCACHE, env.GOCACHE, join(buildDirectory, "tmp")]) await fs.mkdir(path, { recursive: true });
	try {
		const install = await run(goPath, ["install", `${GENTLE_AI_MAIN_PACKAGE}@${commit}`], { env, cwd: buildDirectory, deadlineMs: deadlines.build });
		if (!succeeded(install)) throw new MainChannelError("main-gentle-ai-build-failed", `go install ${GENTLE_AI_MAIN_PACKAGE}@${commit} failed`);
		await fs.mkdir(directory, { recursive: true });
		const binaryPath = join(directory, executable);
		await fs.copyFile(join(env.GOBIN, executable), binaryPath);
		if (platform !== "win32") await fs.chmod(binaryPath, 0o755);
		// Go stamps the module pseudo-version, whose suffix is the commit's first 12 characters.
		const probe = await run(binaryPath, ["version"], { env: { PATH: env.PATH }, deadlineMs: deadlines.version });
		const match = succeeded(probe) && /^gentle-ai (\S+)$/m.exec(String(probe.stdout ?? ""));
		if (!match || !match[1].endsWith(`-${commit.slice(0, 12)}`)) {
			await fs.rm(directory, { recursive: true, force: true });
			throw new MainChannelError("main-gentle-ai-unverified", `the built Gentle AI does not report commit ${commit.slice(0, 12)}`);
		}
		registerGentleAiDevBinary(binaryPath, ctx, platform);
		return { binaryPath, version: match[1] };
	} finally {
		await fs.rm(buildDirectory, { recursive: true, force: true });
	}
}

/** Packs Gentle Shell from `commit` as `<version>-main.<sha12>` without running `prepack`. */
export async function packMainShell({ commit, ctx, fetch, run, pnpm, fs }) {
	if (!SHA.test(commit)) throw new MainChannelError("main-shell-pack-failed", "the Gentle Shell commit is not an exact SHA");
	const packages = join(configHome(ctx), "main", "packages");
	const work = join(configHome(ctx), "main", ".source");
	await fs.rm(work, { recursive: true, force: true });
	await fs.mkdir(join(work, "src"), { recursive: true });
	await fs.mkdir(packages, { recursive: true });
	try {
		let response;
		try {
			response = await fetch(`https://codeload.github.com/${SHELL_REPOSITORY}/tar.gz/${commit}`, { headers: { "User-Agent": "gentle-shell" } });
		} catch {
			response = null;
		}
		const bytes = response?.ok ? Buffer.from(await response.arrayBuffer()) : null;
		if (!bytes || bytes.length === 0 || bytes.length > MAX_SOURCE_BYTES) {
			throw new MainChannelError("main-shell-download-failed", `the Gentle Shell source for ${commit.slice(0, 12)} could not be downloaded`);
		}
		const archive = join(work, "source.tgz");
		await fs.writeFile(archive, bytes);
		const source = join(work, "src");
		if (!succeeded(await run("tar", ["-xzf", archive, "-C", source, "--strip-components=1"], { deadlineMs: deadlines.extract }))) {
			throw new MainChannelError("main-shell-pack-failed", "the Gentle Shell source archive could not be extracted");
		}
		const manifestPath = join(source, "package.json");
		const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
		if (manifest?.name !== "gentle-pi" || typeof manifest.version !== "string") {
			throw new MainChannelError("main-shell-pack-failed", "the downloaded source is not the gentle-pi package");
		}
		manifest.version = mainVersion(manifest.version, commit);
		// prepack runs the full test suite; postinstall (the native binary) stays.
		if (manifest.scripts) {
			delete manifest.scripts.prepack;
			delete manifest.scripts.prepare;
		}
		await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
		const pack = await run(pnpm.command, [...pnpm.prefix, "pack", "--pack-destination", packages], { cwd: source, deadlineMs: deadlines.pack });
		const tgz = join(packages, `gentle-pi-${manifest.version}.tgz`);
		if (!succeeded(pack) || !(await fs.stat(tgz).then((info) => info.isFile(), () => false))) {
			throw new MainChannelError("main-shell-pack-failed", "the Gentle Shell main package could not be packed");
		}
		return tgz;
	} finally {
		await fs.rm(work, { recursive: true, force: true });
	}
}

/** The installer runner's main-channel adapter over real network and files. */
export function mainChannelAdapter({ fetch = globalThis.fetch, fs }) {
	return {
		resolveCommit: (repository) => resolveMainCommit(repository, { fetch }),
		buildGentleAi: ({ commit, goPath, platform, ctx, run }) => buildMainGentleAi({ commit, ctx, platform, goPath, run, fs }),
		packShell: ({ commit, ctx, run, pnpm }) => packMainShell({ commit, ctx, fetch, run, pnpm, fs }),
		writeChannel: (ctx, state) => writeChannel(ctx, state, fs),
	};
}

// ---------------------------------------------------------------------------
// `gentle-shell upgrade [--channel release|main]`
// ---------------------------------------------------------------------------

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const UPGRADE_USAGE = "usage: gentle-shell upgrade [--channel release|main]";
const INSTALL_DEADLINE = 20 * MINUTE;

function parseUpgradeArgs(args) {
	if (args.length === 0) return null;
	let value;
	if (args.length === 1 && args[0].startsWith("--channel=")) value = args[0].slice("--channel=".length);
	else if (args.length === 2 && args[0] === "--channel") value = args[1];
	if (!CHANNELS.includes(value)) throw new MainChannelError("upgrade-usage", UPGRADE_USAGE);
	return value;
}

function older(left, right) {
	const [a, b] = [STABLE.exec(left), STABLE.exec(right)];
	if (!a || !b) return true;
	for (let index = 1; index <= 3; index += 1) {
		if (Number(a[index]) !== Number(b[index])) return Number(a[index]) < Number(b[index]);
	}
	return false;
}

function inside(parent, child) {
	const path = relative(parent, child);
	return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

async function latestRelease(fetch) {
	let version = null;
	try {
		const response = await fetch("https://registry.npmjs.org/gentle-pi/latest", { headers: { Accept: "application/json" } });
		if (response?.ok) version = (await response.json())?.version;
	} catch {
		version = null;
	}
	if (typeof version !== "string" || !STABLE.test(version)) {
		throw new MainChannelError("latest-release-unavailable", "the latest gentle-pi release could not be read from the npm registry");
	}
	return version;
}

/**
 * Which package manager owns an installed package (gentle-pi unless `name` says
 * otherwise), from real (symlink-free) paths: pnpm when it lives under PNPM_HOME,
 * npm only when it is `<npm root -g>/<name>` itself, otherwise null — for example
 * an `npm link` of a source checkout, which must never be reinstalled over.
 * Paths follow `platform` (this host by default): case-insensitive on Windows.
 */
export function installOwner({ packageRoot, pnpmHome, npmRoot, name = "gentle-pi", platform = process.platform }) {
	const path = platform === "win32" ? win32 : posix;
	const comparable = (value) => (platform === "win32" ? value.toLowerCase() : value);
	if (typeof packageRoot !== "string") return null;
	if (typeof pnpmHome === "string") {
		const rest = path.relative(pnpmHome, packageRoot);
		if (rest !== "" && !rest.startsWith("..") && !path.isAbsolute(rest)) return "pnpm";
	}
	if (typeof npmRoot === "string" && comparable(path.relative(npmRoot, packageRoot)) === comparable(path.normalize(name))) return "npm";
	return null;
}

async function npmGlobalRoot(npm, run, fs) {
	if (!npm) return null;
	const result = await run(npm, ["root", "-g"], { deadlineMs: deadlines.version });
	const reported = succeeded(result) ? String(result.stdout ?? "").trim().split(/\r?\n/).at(-1) : "";
	return isAbsolute(reported) ? fs.realpath(reported).catch(() => null) : null;
}

/** The package manager that owns this installation, or a typed refusal. */
async function ownerManager({ ctx, platform, packageRoot, fs, which, run }) {
	const bin = pnpmGlobalBin({ platform, env: { HOME: ctx.home, ...ctx.env } });
	const npm = await which("npm");
	const [pnpmHome, root, npmRoot] = await Promise.all([
		bin ? fs.realpath(bin.pnpmHome).catch(() => null) : null,
		fs.realpath(packageRoot).catch(() => null),
		npmGlobalRoot(npm, run, fs),
	]);
	const name = installOwner({ packageRoot: root, pnpmHome, npmRoot, platform });
	if (!name) {
		throw new MainChannelError("upgrade-owner-unknown", `neither pnpm nor npm owns ${root ?? packageRoot} (a linked source checkout, for example); update it the way you installed it`);
	}
	const command = name === "npm" ? npm : await which("pnpm");
	if (!command) throw new MainChannelError("upgrade-manager-missing", `${name}, which owns this Gentle Shell installation, is not on PATH`);
	return { name, command };
}

async function installGlobal(manager, spec, run) {
	const argv = manager.name === "pnpm" ? ["add", "-g", spec, "--allow-build=gentle-pi"] : ["install", "-g", spec];
	if (!succeeded(await run(manager.command, argv, { deadlineMs: INSTALL_DEADLINE }))) {
		throw new MainChannelError("upgrade-install-failed", `${manager.name} could not install ${spec}`);
	}
}

/** Removes the dev-binary override only when it points at a main build this module made. */
async function removeMainOverride(ctx, fs) {
	try {
		const registration = JSON.parse(await fs.readFile(gentleAiDevBinaryRegistrationPath(ctx), "utf8"));
		if (typeof registration?.path === "string" && inside(join(configHome(ctx), "main", "gentle-ai"), registration.path)) {
			unregisterGentleAiDevBinary(ctx);
		}
	} catch {
		// No registration, or one that is not ours: leave it alone.
	}
}

/** The Go a main build runs: the user's, unless it is missing or reports a version
 * older than requirements.go; then the pinned Go the installer published under
 * the config home (`tools/go`). A Go whose version is unknown is tried as before.
 * Nothing is downloaded here and the user's Go is never changed.
 */
async function mainGo({ userGo, pinnedGo, run }) {
	if (!userGo) return pinnedGo;
	const result = await run(userGo, ["version"], { deadlineMs: deadlines.version });
	const match = succeeded(result) && /^go version go(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))? \S+$/.exec(String(result.stdout ?? "").trim());
	if (!match) return userGo;
	const found = `${match[1]}.${match[2]}.${match[3] ?? "0"}`;
	if (!older(found, requirements.go)) return userGo;
	if (pinnedGo) return pinnedGo;
	throw new MainChannelError("main-requires-tools", `the main channel builds Gentle AI with Go ${requirements.go} or newer, but Go ${found} is on PATH; update it, or run the Gentle Shell installer, which provides its own pinned Go`);
}

/**
 * Updates Gentle Shell along its recorded channel (or the one `--channel` selects):
 * release goes to the latest npm release, main to the latest `main` commits of
 * Gentle Shell and Gentle AI, rebuilding only what moved. Returns the exit code;
 * failures throw MainChannelError (`upgrade-usage` is a usage error).
 */
export async function runUpgrade({ args, ctx, platform, arch = process.arch, packageRoot, currentVersion, adapters, out }) {
	const { fetch, run, fs, which } = adapters;
	const requested = parseUpgradeArgs(args);
	const state = await readChannel(ctx, fs);
	const channel = requested ?? state.channel;
	if (channel === "release") {
		const latest = await latestRelease(fetch);
		if (state.channel === "release" && !older(currentVersion, latest)) {
			out(`gentle-shell ${currentVersion} is already the latest release.`);
			return 0;
		}
		await installGlobal(await ownerManager({ ctx, platform, packageRoot, fs, which, run }), `gentle-pi@${latest}`, run);
		await removeMainOverride(ctx, fs);
		await writeChannel(ctx, { channel: "release" }, fs);
		out(`Updated gentle-shell ${currentVersion} to ${latest} (release).`);
		return 0;
	}
	const [userGo, pnpmPath] = [await which("go"), await which("pnpm")];
	const pinnedGo = installedGo(join(configHome(ctx), "tools", "go"), platform, arch);
	if ((!userGo && !pinnedGo) || !pnpmPath) {
		throw new MainChannelError("main-requires-tools", "the main channel builds Gentle AI with Go and packs Gentle Shell with pnpm; put both on PATH (the Gentle Shell installer can provide its own pinned Go)");
	}
	const gentleAiCommit = await resolveMainCommit(GENTLE_AI_REPOSITORY, { fetch });
	const shellCommit = await resolveMainCommit(SHELL_REPOSITORY, { fetch });
	const onMain = state.channel === "main";
	const aiCurrent = onMain && state.gentleAiCommit === gentleAiCommit;
	const shellCurrent = onMain && state.shellCommit === shellCommit && currentVersion.endsWith(`-main.${shellCommit.slice(0, 12)}`);
	const summary = `Gentle Shell ${shellCommit.slice(0, 12)}, Gentle AI ${gentleAiCommit.slice(0, 12)}`;
	if (aiCurrent && shellCurrent) {
		out(`gentle-shell is already at the latest main: ${summary}.`);
		return 0;
	}
	if (!aiCurrent) await buildMainGentleAi({ commit: gentleAiCommit, ctx, platform, goPath: await mainGo({ userGo, pinnedGo, run }), run, fs });
	if (!shellCurrent) {
		const manager = await ownerManager({ ctx, platform, packageRoot, fs, which, run });
		const tgz = await packMainShell({ commit: shellCommit, ctx, fetch, run, pnpm: { command: pnpmPath, prefix: [] }, fs });
		await installGlobal(manager, tgz, run);
	}
	await writeChannel(ctx, { channel: "main", shellCommit, gentleAiCommit }, fs);
	out(`Updated to the latest main: ${summary}.`);
	return 0;
}
