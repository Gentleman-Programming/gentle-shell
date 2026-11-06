// The web installer's bundled path (T1c; S1, S2, S3, S12): a new installation
// of the release channel whose release publishes the distribution assets gets
// Gentle Shell as one self-contained product, through the shared module in
// bundled-install.mjs. The user's Node, npm, pnpm, Go and Pi are not used or
// changed. Everything else keeps the standard runner (installer-runner.mjs).
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import { DISTRIBUTION_ASSETS, activateVersion, applyPathEntry, checkLauncher, claimPrefix, ensureLauncher, ensureRuntime, installVersion, pathEntryPlan,
	prefixLayout, prefixRoot, readDistribution, removePathEntry, runCommand, setupEnvironment, userNpmrc, writeNpmrcAuth, writePathReceipt } from "./bundled-install.mjs";
import { removeGlobalCommand, removeGlobalShell } from "./main-channel.mjs";
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
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** Every `failedStep` and blocked `reason` runBundledInstall can report, in step order. */
export const bundledFailedSteps = Object.freeze(["claim-prefix", "copy-npm-settings", "install-runtime", "install-version", "activate-version", "write-launcher",
	"verify-launcher", "bundled-path", "shell-setup"]);
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

/** The migration gate (S4, pure): the owner ("pnpm" or "npm") of an existing
 * Gentle Shell on the release channel and a supported target, when release
 * `version` publishes readable assets and is not older than that Gentle Shell;
 * otherwise null. An npm link or an unknown owner is never migrated.
 */
export function migrationGate({ channel, inventory, distribution, version }) {
	const shell = inventory?.shell;
	const owner = shell?.available === true && ["pnpm", "npm"].includes(shell.owner) ? shell.owner : null;
	const [found, release] = [STABLE.exec(String(shell?.version))?.slice(1).map(Number), STABLE.exec(String(version))?.slice(1).map(Number)];
	const at = found && release ? found.findIndex((part, index) => part !== release[index]) : -1;
	const newer = at !== -1 && found[at] > release[at];
	return channel === "release" && TARGETS.includes(`${inventory?.platform}-${inventory?.arch}`) && owner && !newer && distribution?.status === "published" &&
		distribution.manifest?.shell === version ? owner : null;
}

/** The fixed bundled actions; the PATH is a step only when the installer applies
 * it. A migration the plan confirms ("plan") ends with removing the old global
 * gentle-pi; one the upgrade confirms ("ask") leaves setup to the launcher's
 * own first run and asks about the removal afterwards.
 */
function bundledActions(pathKind, migrate) {
	return [
		{ id: "bundled-prefix", kind: "configure", target: "prefix" },
		{ id: "bundled-runtime", kind: "acquire", target: "runtime" },
		{ id: "bundled-version", kind: "install", target: "shell" },
		{ id: "bundled-activate", kind: "configure", target: "current" },
		...(["symlink", "profile", "registry"].includes(pathKind) ? [{ id: "bundled-path", kind: "configure", target: "path" }] : []),
		...(migrate?.removal === "ask" ? [] : [{ id: "bundled-setup", kind: "normal-setup", target: "shell" }]),
		...(migrate?.removal === "plan" ? [{ id: "remove-global-shell", kind: "remove", target: "global-shell" }] : []),
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
export function bundledPlan({ platform, distribution, layout, path, migrate }) {
	const { shell, pi } = distribution.manifest;
	const migration = migrate ? { manager: migrate.manager, command: removeGlobalCommand(migrate.manager), removal: migrate.removal } : null;
	return {
		tools: {}, blockers: [], actions: bundledActions(path.kind, migration), ready: false,
		bundled: { shell, pi, id: `${shell}-${pi}`, lockfile: sha256(distribution.lockfile), root: layout.root, bin: layout.bin,
			node: artifactFor("node", "linux", "x64").version, pnpm: artifactFor("pnpm").version, go: platform === "win32" ? goPinVersion : null, path: pathSummary(path),
			...(migration ? { migrate: migration } : {}) },
	};
}

/** The consented migration, exactly as bundledPlan writes it, or null. */
function validMigration(migrate) {
	if (migrate === undefined) return null;
	const ok = ["pnpm", "npm"].includes(migrate?.manager) && ["plan", "ask"].includes(migrate.removal) && migrate.command === removeGlobalCommand(migrate.manager);
	return ok ? migrate : false;
}

/** The consented plan is exactly bundledPlan's for these assets. */
function validPlan(plan, distribution) {
	const bundled = plan?.bundled;
	if (typeof bundled !== "object" || bundled === null || distribution?.status !== "published") return false;
	const { shell, pi } = distribution.manifest;
	const migrate = validMigration(bundled.migrate);
	return migrate !== false && bundled.shell === shell && bundled.pi === pi && bundled.id === `${shell}-${pi}` && bundled.lockfile === sha256(distribution.lockfile) &&
		JSON.stringify(plan.actions) === JSON.stringify(bundledActions(bundled.path?.kind, migrate));
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
 * A migration (S4) checks the launcher's `--version` (verify-launcher) right
 * before the PATH step; its plan may skip setup ("ask") or end with
 * remove-global-shell ("plan"), which runs only after every step passed. A
 * failed removal keeps the outcome and adds removeGlobal { status, command }.
 * Adapters: platform, arch, env, home, distribution (the fetchDistribution
 * result the plan was made from), registry (Windows), log, removeGlobal(manager)
 * -> true once the old global gentle-pi is removed, and operations (trusted
 * local overrides of the bundled-install functions and run).
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
	const ops = { claimPrefix, userNpmrc, writeNpmrcAuth, ensureRuntime, installVersion, activateVersion, ensureLauncher, pathEntryPlan, applyPathEntry, checkLauncher,
		writePathReceipt, removePathEntry, run: runCommand, ...adapters.operations };
	const consented = request.plan.bundled;
	const planned = (id) => request.plan.actions.some((action) => action.id === id);
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
		// A migration checks the new launcher before the PATH finds it; the old Gentle Shell is removed only after this passed.
		...(consented.migrate ? [["verify-launcher", async () => {
			const check = await ops.checkLauncher(layout, { id: consented.id, shell: consented.shell, pi: consented.pi, platform, env, run: ops.run, launcher: true });
			if (check?.ok === true) return;
			// What the launcher reported against what the plan installed (bounded; its stderr only when it printed nothing).
			const expected = `"gentle-shell ${consented.shell} / pi ${consented.pi}"`;
			const reported = String(check?.reported ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" / ").slice(0, 120);
			const cause = reported ? "" : lastLine({ stderr: check?.stderr });
			detail = setupErrorDetail(`gentle-shell --version reported ${reported ? `"${reported}"` : "nothing"} instead of ${expected}${cause ? `: ${cause}` : ""}`, home, platform);
			throw new Error("The bundled launcher did not report its versions");
		}]] : []),
		// The change consented to, planned again now that the prefix exists: anything else is not applied.
		...(planned("bundled-path") ? [["bundled-path", () => {
			const plan = ops.pathEntryPlan(layout, { platform, env, home });
			if (JSON.stringify(pathSummary(plan)) !== JSON.stringify(consented.path)) throw new Error("The PATH change differs from the plan");
			const receipt = ops.applyPathEntry(plan, { registry });
			if (receipt?.applied !== true) return;
			// self-uninstall reverts exactly this receipt; an entry it could not record is taken back.
			try {
				ops.writePathReceipt(layout, receipt);
			} catch (error) {
				ops.removePathEntry(receipt, { registry });
				throw error;
			}
		}]] : []),
		// The .cmd launcher would need cmd.exe on Windows: there setup runs the Node and entry it runs.
		...(planned("bundled-setup") ? [["shell-setup", async () => {
			const entry = win32.join(layout.versions, consented.id, "node_modules", "gentle-pi", "bin", "gentle-shell.mjs");
			const [command, args] = platform === "win32" ? [layout.node, [entry, "setup"]] : [layout.launcher, ["setup"]];
			const result = await ops.run(command, args, { cwd: layout.root, env: setupEnvironment(layout, { platform, env, id: consented.id }), timeout: SETUP_TIMEOUT });
			if (result?.status === 0) return;
			detail = lastLine(result);
			throw new Error("gentle-shell setup failed");
		}]] : []),
	];
	for (const [step, run] of steps) {
		try {
			await run();
		} catch (error) {
			// A migration's failure always says why: the step's own detail, otherwise its error message.
			if (!detail && consented.migrate) detail = lastLine({ stderr: String(error?.message ?? "") });
			log({ step, status: "failed" });
			return { outcome: "failed", failedStep: step, completed, ...(detail ? { detail } : {}) };
		}
		completed.push(step);
		log({ step, status: "done" });
	}
	let removal = {};
	if (planned("remove-global-shell")) {
		const removed = await Promise.resolve().then(() => adapters.removeGlobal?.(consented.migrate.manager)).catch(() => false);
		if (removed === true) completed.push("remove-global-shell");
		log({ step: "remove-global-shell", status: removed === true ? "done" : "failed" });
		removal = { removeGlobal: { status: removed === true ? "removed" : "failed", command: consented.migrate.command } };
	}
	const path = consented.path;
	if (path.kind === "manual") return { outcome: "terminal-action-required", action: "add-path-line", pathLine: { file: path.file, line: path.line }, completed, ...removal };
	if (path.kind === "profile" || path.kind === "registry") return { outcome: "terminal-action-required", action: "open-new-terminal", completed, ...removal };
	return { outcome: "ready", completed, ...removal };
}

/** The `gentle-shell` a new terminal would run before the bundled launcher, or
 * null when the launcher comes first (or none is found). A new terminal's PATH
 * is this one with the planned change:
 * - a zsh or bash profile line (or the line the user adds) goes first: it is
 *   appended to the startup file read last for terminals (.zshrc after
 *   .zprofile; the macOS bash login file or .bashrc), after pnpm setup's own
 *   PNPM_HOME line there;
 * - a fish line (`profile`, conf.d/gentle-shell.fish) counts as last: fish reads
 *   conf.d before config.fish, so whatever config.fish prepends (pnpm setup's
 *   PNPM_HOME block) comes before it, and the current PATH already shows it;
 * - the Windows user Path entry goes last;
 * - a ~/.local/bin link or an existing entry stays where it already is.
 * fs: { exists(path), realpath(path) }.
 */
export function shadowingCommand({ platform, env, layout, pathKind, profile, fs = { exists: existsSync, realpath: realpathSync } }) {
	const windows = platform === "win32";
	const path = windows ? win32 : posix;
	const value = windows ? Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] : env.PATH;
	const entries = String(value ?? "").split(path.delimiter).filter(Boolean);
	const line = ["profile", "manual"].includes(pathKind);
	const last = pathKind === "registry" || (line && /\.fish$/.test(String(profile ?? "")));
	const ordered = last ? [...entries, layout.bin] : line ? [layout.bin, ...entries] : entries;
	const names = windows ? ["gentle-shell.exe", "gentle-shell.cmd", "gentle-shell.bat"] : ["gentle-shell"];
	const real = (file) => { try { return fs.realpath(file); } catch { return file; } };
	for (const directory of ordered) {
		const found = names.map((name) => path.join(directory, name)).find((file) => fs.exists(file));
		if (!found) continue;
		const same = windows ? real(found).toLowerCase() === real(layout.launcher).toLowerCase() : real(found) === real(layout.launcher);
		return same ? null : found;
	}
	return null;
}

const yes = (answer) => /^\s*y(?:es)?\s*$/i.test(String(answer ?? ""));

/**
 * `gentle-shell upgrade` from a global pnpm or npm install (S4): when release
 * `latest` publishes the assets (migrationGate), explains the move, installs the
 * bundled prefix with runBundledInstall (a plan with removal "ask": no setup,
 * the launcher's own first run does it), then asks one question: remove the old
 * global gentle-pi with its own manager (default No; without a terminal it
 * never removes and prints the command). Returns null when the migration does
 * not apply, or when it failed before the question (it prints the step and its
 * detail, and the old package is untouched): the caller keeps its own path for
 * this run. Otherwise { code, installed: true }. The owner is probed only once
 * the release, the assets and the versions allow a migration.
 * adapters: owner() -> ownerManager's { name, command, prefix } or a throw;
 * distribution(version) -> fetchDistribution's result; run (the manager's
 * runner); registry (Windows); operations and fs as runBundledInstall and
 * shadowingCommand take them.
 */
export async function migrateGlobalShell({ latest, currentVersion, platform, arch, env, home, interactive, ask, out, adapters }) {
	const untouched = "Your global gentle-pi was left untouched; it is updated the usual way instead.";
	const distribution = await adapters.distribution(latest);
	const shell = { available: true, version: currentVersion };
	// Every other condition first: the owner probe runs the user's `npm root -g`.
	if (!migrationGate({ channel: "release", inventory: { platform, arch, shell: { ...shell, owner: "npm" } }, distribution, version: latest })) return null;
	const manager = await Promise.resolve().then(() => adapters.owner()).catch(() => null);
	if (!migrationGate({ channel: "release", inventory: { platform, arch, shell: { ...shell, owner: manager?.name ?? null } }, distribution, version: latest })) {
		out("Gentle Shell now installs as one self-contained product, but this Gentle Shell is not a global pnpm or npm package (an `npm link`, for example), so it is not moved.");
		return null;
	}
	const ops = { prefixRoot, pathEntryPlan, ...adapters.operations };
	let layout;
	let plan;
	try {
		layout = prefixLayout({ platform, env, home, root: ops.prefixRoot({ platform, env }) });
		plan = bundledPlan({ platform, distribution, layout, path: ops.pathEntryPlan(layout, { platform, env, home }), migrate: { manager: manager.name, removal: "ask" } });
	} catch (error) {
		out(`The self-contained install could not be planned: ${setupErrorDetail(String(error?.message ?? ""), home, platform) ?? "unknown error"}. ${untouched}`);
		return null;
	}
	const { shell: shellVersion, pi, migrate } = plan.bundled;
	for (const line of [`Gentle Shell ${shellVersion} installs as one self-contained product in ${layout.root}, with its own Node.js, npm and pnpm and exactly Pi ${pi}.`,
		"Your own Node.js, npm, pnpm and Pi are not used or changed, and your Gentle Shell home (~/.gentle-shell/agent) stays where it is.",
		`Your global gentle-pi (installed with ${manager.name}) is kept until you choose to remove it.`]) out(line);
	const outcome = await runBundledInstall({ plan, consent: true }, { platform, arch, env, home, distribution, registry: adapters.registry,
		operations: adapters.operations });
	if (outcome.outcome !== "ready" && outcome.outcome !== "terminal-action-required") {
		const step = outcome.failedStep ?? outcome.reason ?? "unknown";
		out(`The self-contained install stopped at ${step}${outcome.detail ? `: ${outcome.detail}` : ""}. ${untouched}`);
		return null;
	}
	out(`Installed Gentle Shell ${shellVersion} with Pi ${pi} in ${layout.root}.`);
	if (outcome.action === "add-path-line") out(`Add this line to ${outcome.pathLine.file}, then open a new terminal: ${outcome.pathLine.line}`);
	else if (outcome.action === "open-new-terminal") out("Open a new terminal so it finds the new `gentle-shell`.");
	const question = `Remove the old global gentle-pi with ${manager.name} (${migrate.command})? [y/N] `;
	let code = 0;
	if (interactive && yes(await ask(question))) {
		if (await removeGlobalShell(manager, adapters.run)) {
			out(`Removed the old global gentle-pi with ${manager.name}.`);
			return { code, installed: true };
		}
		out(`The old global gentle-pi could not be removed; Gentle Shell ${shellVersion} stays installed in ${layout.root}. Remove it yourself with: ${migrate.command}`);
		code = 1;
	} else {
		out(`The old global gentle-pi was kept. To remove it, run: ${migrate.command}`);
	}
	const shadow = shadowingCommand({ platform, env, layout, pathKind: plan.bundled.path.kind, profile: plan.bundled.path.file, ...(adapters.fs ? { fs: adapters.fs } : {}) });
	if (shadow) {
		out(`New terminals still run ${shadow} (the old gentle-pi), because its folder comes first on PATH. ` +
			`Remove the old package with ${migrate.command}, or put ${layout.bin} before that folder on PATH.`);
	}
	return { code, installed: true };
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
 * add(entry) appends the absolute `entry` to the HKCU user Path once and returns
 * "added", or "present" when the Path already held it; remove(entry) removes
 * every spelling of it; nothing else in the Path changes.
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
		return output;
	};
	return { add: (entry) => edit("add", entry, ["added", "present"]), remove: (entry) => edit("remove", entry, ["removed", "absent"]) };
}
