// The web installer's bundled path (T1c; S1, S2, S3, S12): a new installation
// of the release channel whose release publishes the distribution assets gets
// Gentle Shell as one self-contained product, through the shared module in
// bundled-install.mjs. The user's Node, npm, pnpm, Go and Pi are not used or
// changed. Everything else keeps the standard runner (installer-runner.mjs).
import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { DISTRIBUTION_ASSETS, activateVersion, applyPathEntry, claimPrefix, ensureLauncher, ensureRuntime, installVersion, pathEntryPlan, readDistribution,
	runCommand, setupEnvironment, userNpmrc, writeNpmrcAuth } from "./bundled-install.mjs";
import { artifactFor, download as httpDownload, goPinVersion } from "./installer-downloads.mjs";
import { setupErrorDetail } from "./installer-runner.mjs";
import { windowsProcessCheck } from "./installer-windows.mjs";

/** Where each release's distribution assets live: <base>/v<version>/<asset>. */
export const DISTRIBUTION_RELEASES = "https://github.com/Gentleman-Programming/gentle-shell/releases/download";
// GitHub answers a release asset with a redirect to its asset host.
const ASSET_HOSTS = Object.freeze(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
const ASSET_LIMITS = Object.freeze({ distribution: 64 * 1024, lockfile: 8 * 1024 * 1024 });
const TARGETS = Object.freeze(["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"]);
const SETUP_TIMEOUT = 20 * 60 * 1000;
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** Every `failedStep` and blocked `reason` runBundledInstall can report, in step order. */
export const bundledFailedSteps = Object.freeze(["claim-prefix", "copy-npm-settings", "install-runtime", "install-version", "activate-version", "write-launcher",
	"bundled-path", "shell-setup"]);
export const bundledBlockedReasons = Object.freeze(["invalid-request", "consent-required"]);

/** The asset pair of release v<version>: { status: "published", manifest,
 * lockfile } once readDistribution accepts it (exact versions, the recorded
 * lockfile sha256); "missing" when GitHub answers 404 for either asset (a
 * release from before the assets existed); "rejected" when they do not read;
 * "unavailable" on any other failure. Each asset is size-bounded and fetched
 * with the identity encoding.
 */
export async function fetchDistribution({ version, base = DISTRIBUTION_RELEASES, download = httpDownload }) {
	const texts = [];
	for (const kind of ["distribution", "lockfile"]) {
		try {
			const bytes = await download({ url: `${base}/v${version}/${DISTRIBUTION_ASSETS[kind]}`, maxBytes: ASSET_LIMITS[kind], redirectHosts: ASSET_HOSTS });
			if (!Buffer.isBuffer(bytes) || bytes.length > ASSET_LIMITS[kind]) return { status: "unavailable" };
			texts.push(bytes.toString("utf8"));
		} catch (error) {
			return { status: error?.status === 404 ? "missing" : "unavailable" };
		}
	}
	try {
		return { status: "published", ...readDistribution(texts[0], texts[1]) };
	} catch {
		return { status: "rejected" };
	}
}

/** The gate (pure): the bundled install only for a new installation (preflight
 * found no Gentle Shell) of the release channel on a supported target, when this
 * package's own release (`version`) publishes readable distribution assets.
 * Anything else keeps the standard path unchanged.
 */
export function bundledGate({ channel, inventory, distribution, version }) {
	return channel === "release" && TARGETS.includes(`${inventory?.platform}-${inventory?.arch}`) && inventory?.shell?.available === false &&
		distribution?.status === "published" && distribution.manifest?.shell === version;
}

/** The fixed bundled actions; the PATH is a step only when the installer applies it. */
function bundledActions(pathKind) {
	return [
		{ id: "bundled-prefix", kind: "configure", target: "prefix" },
		{ id: "bundled-runtime", kind: "acquire", target: "runtime" },
		{ id: "bundled-version", kind: "install", target: "shell" },
		{ id: "bundled-activate", kind: "configure", target: "current" },
		...(["symlink", "profile", "registry"].includes(pathKind) ? [{ id: "bundled-path", kind: "configure", target: "path" }] : []),
		{ id: "bundled-setup", kind: "normal-setup", target: "shell" },
	];
}
/** What the plan copy and the outcome show of a pathEntryPlan. */
function pathSummary(plan) {
	if (plan.kind === "registry") return { kind: "registry", entry: plan.entry };
	if (plan.kind === "symlink") return { kind: "symlink", file: plan.path };
	if (plan.kind === "profile" || plan.kind === "manual") return { kind: plan.kind, file: plan.path, line: plan.line };
	return { kind: "none" };
}
/** The bundled plan the user consents to, in the standard plan's shape (no
 * tools or blockers), plus `bundled`: the exact versions, the lockfile's sha256,
 * the prefix, the pinned runtimes and the single PATH change (pathEntryPlan).
 */
export function bundledPlan({ platform, distribution, layout, path }) {
	const { shell, pi } = distribution.manifest;
	return {
		tools: {}, blockers: [], actions: bundledActions(path.kind), ready: false,
		bundled: { shell, pi, id: `${shell}-${pi}`, lockfile: sha256(distribution.lockfile), root: layout.root, bin: layout.bin,
			node: artifactFor("node", "linux", "x64").version, pnpm: artifactFor("pnpm").version, go: platform === "win32" ? goPinVersion : null, path: pathSummary(path) },
	};
}

/** The consented plan is exactly bundledPlan's for these assets. */
function validPlan(plan, distribution) {
	const bundled = plan?.bundled;
	if (typeof bundled !== "object" || bundled === null || distribution?.status !== "published") return false;
	const { shell, pi } = distribution.manifest;
	return bundled.shell === shell && bundled.pi === pi && bundled.id === `${shell}-${pi}` && bundled.lockfile === sha256(distribution.lockfile) &&
		JSON.stringify(plan.actions) === JSON.stringify(bundledActions(bundled.path?.kind));
}

/**
 * runBundledInstall({ plan, consent }, adapters) -> outcome, in the standard
 * runner's shapes: blocked (nothing changed), failed (stopped after
 * `completed`, with `detail` for install-version and shell-setup: pnpm's or
 * setup's last error line, the home as ~), ready, or terminal-action-required
 * with `action` "open-new-terminal" (a profile line or the user Path was added)
 * or "add-path-line" with `pathLine` { file, line } (a profile the installer may
 * not edit). Steps, logged with log({ step, status }) like the runner's:
 * claim-prefix, copy-npm-settings (the user's npmrc, filtered, S12),
 * install-runtime (our Node with its npm, pnpm, and Go on Windows),
 * install-version (frozen, from the release lockfile), activate-version,
 * write-launcher, bundled-path (only symlink, profile or registry), shell-setup.
 * Adapters: platform, arch, env, home, distribution (the fetchDistribution
 * result the plan was made from), registry (Windows), log, and operations
 * (trusted local overrides of the bundled-install functions and run).
 */
export async function runBundledInstall(request, adapters) {
	const { platform, arch, env, home, distribution, registry, log = () => {} } = adapters;
	const completed = [];
	const blocked = (reason) => {
		log({ step: "gate", status: "blocked", reason });
		return { outcome: "blocked", reason, completed };
	};
	if (request?.consent !== true) return blocked(validPlan(request?.plan, distribution) ? "consent-required" : "invalid-request");
	if (!validPlan(request.plan, distribution)) return blocked("invalid-request");
	const ops = { claimPrefix, userNpmrc, writeNpmrcAuth, ensureRuntime, installVersion, activateVersion, ensureLauncher, pathEntryPlan, applyPathEntry,
		run: runCommand, ...adapters.operations };
	const consented = request.plan.bundled;
	let layout = null;
	let runtime = null;
	let detail = null;
	const lastLine = (result) => setupErrorDetail(result?.stderr, home, platform) ?? setupErrorDetail(result?.stdout, home, platform);
	const steps = [
		["claim-prefix", () => { layout = ops.claimPrefix({ platform, env, home, root: consented.root }); }],
		["copy-npm-settings", () => ops.writeNpmrcAuth(layout, ops.userNpmrc({ platform, env, home }))],
		["install-runtime", async () => { runtime = await ops.ensureRuntime({ layout, platform, arch, go: platform === "win32", env }); }],
		["install-version", async () => {
			try {
				await ops.installVersion({ layout, manifest: distribution.manifest, lockfile: distribution.lockfile, platform, env, go: runtime.go });
			} catch (error) {
				detail = lastLine({ stderr: error?.stderr });
				throw error;
			}
		}],
		["activate-version", () => ops.activateVersion(layout, consented.id)],
		["write-launcher", () => ops.ensureLauncher(layout)],
		// The change consented to, planned again now that the prefix exists: anything else is not applied.
		...(request.plan.actions.some((action) => action.id === "bundled-path") ? [["bundled-path", () => {
			const plan = ops.pathEntryPlan(layout, { platform, env, home });
			if (JSON.stringify(pathSummary(plan)) !== JSON.stringify(consented.path)) throw new Error("The PATH change differs from the plan");
			ops.applyPathEntry(plan, { registry });
		}]] : []),
		// The .cmd launcher would need cmd.exe on Windows: there setup runs the Node and entry it runs.
		["shell-setup", async () => {
			const entry = win32.join(layout.versions, consented.id, "node_modules", "gentle-pi", "bin", "gentle-shell.mjs");
			const [command, args] = platform === "win32" ? [layout.node, [entry, "setup"]] : [layout.launcher, ["setup"]];
			const result = await ops.run(command, args, { cwd: layout.root, env: setupEnvironment(layout, { platform, env, id: consented.id }), timeout: SETUP_TIMEOUT });
			if (result?.status === 0) return;
			detail = lastLine(result);
			throw new Error("gentle-shell setup failed");
		}],
	];
	for (const [step, run] of steps) {
		try {
			await run();
		} catch {
			log({ step, status: "failed" });
			return { outcome: "failed", failedStep: step, completed, ...(detail ? { detail } : {}) };
		}
		completed.push(step);
		log({ step, status: "done" });
	}
	const path = consented.path;
	if (path.kind === "manual") return { outcome: "terminal-action-required", action: "add-path-line", pathLine: { file: path.file, line: path.line }, completed };
	if (path.kind === "profile" || path.kind === "registry") return { outcome: "terminal-action-required", action: "open-new-terminal", completed };
	return { outcome: "ready", completed };
}

// The HKCU user Path, read without expanding %VARIABLES%, keeps its value kind;
// a WM_SETTINGCHANGE broadcast (through a user variable set and removed) lets
// new terminals see it. The entry and the mode are data, never script text.
const pathScript = `$ErrorActionPreference = 'Stop'
$entry = $env:GENTLE_BUNDLED_PATH_ENTRY
$add = $env:GENTLE_BUNDLED_PATH_MODE -eq 'add'
$same = { param($part) $part.TrimEnd('\\') -ieq $entry.TrimEnd('\\') }
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $exists = $key.GetValueNames() -contains 'Path'
  $kind = if ($exists) { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
  if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String -and $kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) { throw 'unsupported Path kind' }
  $current = if ($exists) { [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { '' }
  $parts = @($current.Split(';') | Where-Object { $_ -ne '' })
  $ours = @($parts | Where-Object { & $same $_ })
  if ($add -and $ours.Count -gt 0) { $result = 'present' }
  elseif (-not $add -and $ours.Count -eq 0) { $result = 'absent' }
  else {
    $next = if ($add) { @($parts) + $entry } else { @($parts | Where-Object { -not (& $same $_) }) }
    $key.SetValue('Path', ($next -join ';'), $kind)
    $result = if ($add) { 'added' } else { 'removed' }
  }
} finally { $key.Close() }
if ($result -eq 'added' -or $result -eq 'removed') {
  [Environment]::SetEnvironmentVariable('GENTLE_SHELL_PATH_REFRESH', '1', 'User')
  [Environment]::SetEnvironmentVariable('GENTLE_SHELL_PATH_REFRESH', $null, 'User')
}
$result`;
/** The registry adapter applyPathEntry and removePathEntry use on Windows:
 * add(entry) appends the absolute `entry` to the HKCU user Path once, remove(entry)
 * removes every spelling of it; nothing else in the Path changes.
 */
export function windowsPathRegistry(env, processAdapter = windowsProcessCheck) {
	const systemRoot = env.SystemRoot ?? Object.entries(env).find(([key]) => key.toLowerCase() === "systemroot")?.[1];
	const edit = (mode, entry, expected) => {
		if (!win32.isAbsolute(entry ?? "") || entry.startsWith("\\\\") || /[;"\r\n]/.test(entry) || !win32.isAbsolute(systemRoot ?? "")) {
			throw new Error("Unsafe entry for the user Path");
		}
		const output = processAdapter(win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
			["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", pathScript], { ...env, GENTLE_BUNDLED_PATH_ENTRY: entry, GENTLE_BUNDLED_PATH_MODE: mode });
		if (!expected.includes(output)) throw new Error("The user Path could not be changed");
	};
	return { add: (entry) => edit("add", entry, ["added", "present"]), remove: (entry) => edit("remove", entry, ["removed", "absent"]) };
}
