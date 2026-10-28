#!/usr/bin/env node
// Release distribution assets (S3, T1b): gentle-pi at the release version and
// the exact Pi (PI_INSTALL_VERSION), with the pnpm-lock.yaml our pinned pnpm
// resolves for them, published as two release assets that installVersion
// installs with --frozen-lockfile. pnpm records every platform's optional
// packages (ffi-rs, fff-bin, esbuild prebuilds) in the lockfile whatever system
// resolves it, so one lockfile serves Linux, macOS and Windows.
//
//   node scripts/build-distribution.mjs build --shell <version> [--pi <version>] --out <dir>
//   node scripts/build-distribution.mjs verify --assets <dir>
//
// Both commands work in a fresh temporary prefix with our own pinned Node and
// pnpm (and Go on Windows); the user's tools and home are never used.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DISTRIBUTION_ASSETS, activateVersion, claimPrefix, distributionAsset, distributionFiles, ensureLauncher, ensureRuntime, installVersion,
	pnpmEnvironment, readDistribution, runCommand } from "./bundled-install.mjs";
import { PI_INSTALL_VERSION } from "./installer-preflight.mjs";

const RESOLVE_TIMEOUT = 10 * 60 * 1000;
// Right after `npm publish` the registry may not list gentle-pi@<version> yet:
// 10 attempts 30 seconds apart wait about five minutes for it.
const RESOLVE_ATTEMPTS = 10;
const RESOLVE_DELAY = 30 * 1000;
const output = (result) => `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-4000);

/** Resolves the lockfile for gentle-pi `shell` and Pi `pi` with our pnpm
 * (`install --lockfile-only`) in a fresh folder under the prefix, from the
 * unmodified distributionFiles() output and the same environment installVersion
 * uses. Only "no matching version" for this gentle-pi is retried (pnpm prints it
 * on stdout); any other failure stops at once. Returns { manifest, assets }
 * keyed by the release asset names.
 */
export async function buildDistribution({ layout, shell, pi = PI_INSTALL_VERSION, env = {}, adapters = {} }) {
	const manifest = { shell, pi };
	const files = distributionFiles(manifest);
	const sleep = adapters.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	// `shell` is an exact SemVer here, so only its dots need escaping.
	const unpublished = new RegExp(`ERR_PNPM_NO_(?:MATURE_)?MATCHING_VERSION\\] No matching version found for gentle-pi@${shell.replaceAll(".", "\\.")}(?![\\w.+-])`);
	for (let attempt = 1; ; attempt += 1) {
		const folder = mkdtempSync(join(layout.tmp, "lockfile-"));
		try {
			for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text, { flag: "wx", mode: 0o600 });
			const result = await (adapters.run ?? runCommand)(layout.node, [layout.pnpm, "install", "--lockfile-only"],
				{ cwd: folder, env: pnpmEnvironment(layout, { env }), timeout: RESOLVE_TIMEOUT });
			if (result.status === 0) {
				// Only the lockfile is read back: pnpm may rewrite pnpm-workspace.yaml with placeholders.
				const lockfile = readFileSync(join(folder, "pnpm-lock.yaml"), "utf8");
				return { manifest, assets: { [DISTRIBUTION_ASSETS.distribution]: distributionAsset(manifest, lockfile), [DISTRIBUTION_ASSETS.lockfile]: lockfile } };
			}
			if (!unpublished.test(output(result))) throw Object.assign(new Error("pnpm lockfile resolution failed"), { output: output(result) });
			if (attempt === RESOLVE_ATTEMPTS) {
				throw Object.assign(new Error(`gentle-pi@${shell} is not on the registry after ${RESOLVE_ATTEMPTS} attempts; check its npm publication`), { output: output(result) });
			}
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
		await sleep(RESOLVE_DELAY);
	}
}

/** Runs the launcher with `--version`; the .cmd one through cmd.exe. */
function launch(launcher, { env, platform }) {
	const options = { env, encoding: "utf8", timeout: 120000, windowsHide: true };
	if (platform !== "win32") return spawnSync(launcher, ["--version"], options);
	const cmd = join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "cmd.exe");
	return spawnSync(cmd, ["/d", "/s", "/c", `""${launcher}" --version"`], { ...options, windowsVerbatimArguments: true });
}

/** Proves a release asset pair: our runtimes (Go too on Windows, as
 * installVersion requires), a frozen install of the pair, `current` switched to
 * it, the launcher written, and `gentle-shell --version` reporting exactly the
 * pair's gentle-pi and Pi. Returns { id, version }.
 */
export async function verifyDistribution({ layout, distribution, lockfile, platform, arch, env = {}, adapters = {} }) {
	const { manifest } = readDistribution(distribution, lockfile);
	const runtime = await ensureRuntime({ layout, platform, arch, go: platform === "win32", env, adapters });
	const { id } = await installVersion({ layout, manifest, lockfile, platform, env, go: runtime.go, adapters });
	activateVersion(layout, id);
	ensureLauncher(layout);
	// The environment our pnpm ran in (no NODE_OPTIONS, NODE_PATH or npm/pnpm
	// settings from the host), without any Pi or Gentle override that could point
	// the launcher at another Pi or agent home.
	const launchEnv = Object.fromEntries(Object.entries(pnpmEnvironment(layout, { platform, env })).filter(([key]) => !/^(?:gentle_|pi_)/i.test(key)));
	const result = await (adapters.launch ?? launch)(layout.launcher, { env: launchEnv, platform });
	const version = String(result.stdout ?? "").trim();
	const [shellLine, piLine] = version.split(/\r?\n/);
	if (result.status !== 0 || shellLine !== `gentle-shell ${manifest.shell}` || piLine !== `pi ${manifest.pi}`) {
		throw Object.assign(new Error(`The launcher reported ${JSON.stringify(version)}, not gentle-shell ${manifest.shell} with pi ${manifest.pi}`),
			{ output: output(result) });
	}
	return { id, version };
}

/** A fresh prefix in a new temporary folder. On Windows the private-folder claim
 * (owner, ACL, marker) has its own native tests; here the new folder stands in
 * for it, as in those tests.
 */
function temporaryPrefix(root, platform, base) {
	if (platform !== "win32") {
		const home = join(root, "home");
		mkdirSync(home, { mode: 0o700 });
		const env = { ...base, HOME: home };
		return { env, layout: claimPrefix({ platform, env, home }) };
	}
	const [local, roaming, profile] = ["local", "roaming", "profile"].map((name) => join(root, name));
	for (const folder of [local, roaming, profile]) mkdirSync(folder);
	const kept = Object.entries(base).filter(([key]) => !/^(?:localappdata|appdata|userprofile|home)$/i.test(key));
	const env = { ...Object.fromEntries(kept), LOCALAPPDATA: local, APPDATA: roaming, USERPROFILE: profile, HOME: profile };
	const claim = (folder) => { mkdirSync(folder); return "claimed"; };
	return { env, layout: claimPrefix({ platform, env, home: profile, adapters: { storage: () => {}, claim } }) };
}

/** The CLI. Its temporary prefix (`gsd-*`) is always removed, whether the
 * command succeeded or failed; invalid input is refused before it exists.
 */
export async function main(argv, { platform = process.platform, arch = process.arch, env = process.env, temporaryRoot = tmpdir(), adapters = {} } = {}) {
	const { positionals: [command], values } = parseArgs({ args: argv, allowPositionals: true,
		options: { shell: { type: "string" }, pi: { type: "string" }, out: { type: "string" }, assets: { type: "string" } } });
	const build = command === "build" && values.shell && values.out;
	if (!build && !(command === "verify" && values.assets)) {
		throw new Error("Usage: build-distribution.mjs build --shell <version> [--pi <version>] --out <dir> | verify --assets <dir>");
	}
	// A non-exact version is refused before anything is downloaded.
	if (build) distributionFiles({ shell: values.shell, pi: values.pi ?? PI_INSTALL_VERSION });
	const root = realpathSync(mkdtempSync(join(temporaryRoot, "gsd-")));
	try {
		const prefix = temporaryPrefix(root, platform, env);
		if (build) {
			await ensureRuntime({ layout: prefix.layout, platform, arch, env: prefix.env, adapters });
			const { manifest, assets } = await buildDistribution({ layout: prefix.layout, shell: values.shell, pi: values.pi, env: prefix.env, adapters });
			mkdirSync(values.out, { recursive: true });
			for (const [name, text] of Object.entries(assets)) writeFileSync(join(values.out, name), text, { flag: "wx" });
			console.log(`Built ${Object.keys(assets).join(" and ")} for gentle-pi ${manifest.shell} with pi ${manifest.pi} in ${values.out}`);
		} else {
			const read = (name) => readFileSync(join(values.assets, name), "utf8");
			const result = await verifyDistribution({ layout: prefix.layout, distribution: read(DISTRIBUTION_ASSETS.distribution), lockfile: read(DISTRIBUTION_ASSETS.lockfile),
				platform, arch, env: prefix.env, adapters });
			console.log(`Verified ${result.id}:\n${result.version}`);
		}
	} finally {
		// Windows may hold a file a moment after its process exits.
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	main(process.argv.slice(2)).catch((error) => {
		const detail = error.output ?? error.stderr;
		console.error(detail ? `${error.message}\n${detail}` : error.message);
		process.exitCode = 1;
	});
}
