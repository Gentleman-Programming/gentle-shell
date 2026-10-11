#!/usr/bin/env node
import { spawn as spawnChild } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectInventory, planPreflight, pnpmGlobalBin, requirements } from "../scripts/installer-preflight.mjs";
import { createProbes, hostAdapters, userEnvironment } from "../scripts/installer-probes.mjs";
import { acquireGo } from "../scripts/installer-downloads.mjs";
import { childEnvironment, goFirstEnvironment, lookPath, packageNativeGentleAi, pnpmInvocation, runStandardInstall, upgradeInvocation } from "../scripts/installer-runner.mjs";
import { createInstallerServer } from "../scripts/installer-server.mjs";
import { configHome, mainChannelAdapter, runUpgrade } from "../scripts/main-channel.mjs";
import { ensureWindowsPnpmHome, windowsWizardEnvironment } from "../scripts/installer-windows.mjs";
import { pathEntryPlan, prefixLayout, prefixRoot } from "../scripts/bundled-install.mjs";
import { DISTRIBUTION_RELEASES, bundledGate, bundledPlan, fetchDistribution, runBundledInstall, windowsPathRegistry } from "../scripts/bundled-wizard.mjs";

// Browser installation wizard entry, started by the bootstrap with no argv.
// Thin wiring only: real probes and adapters, the standard or bundled runner
// and the loopback host. Exit 0 keeps the bootstrap's tools; nonzero removes them.

/** Fixed per-platform browser opener for a local file, spawned with shell:false; null when none. */
export function openerFor(platform, file, env) {
	if (platform === "darwin") return { command: "/usr/bin/open", args: [file] };
	if (platform === "linux") return { command: "xdg-open", args: [file] };
	if (platform === "win32") {
		// Absolute path: Windows would otherwise search the current directory first.
		const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
		if (typeof systemRoot !== "string" || !win32.isAbsolute(systemRoot)) return null;
		return { command: win32.join(systemRoot, "System32", "rundll32.exe"), args: ["url.dll,FileProtocolHandler", file] };
	}
	return null;
}

function escapeHtml(value) {
	return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

/** Static page that refreshes to the session URL; no script. */
export function redirectPage(url) {
	const href = escapeHtml(url);
	return [
		"<!doctype html>",
		'<meta charset="utf-8">',
		'<meta name="referrer" content="no-referrer">',
		`<meta http-equiv="refresh" content="0;url=${href}">`,
		"<title>Gentle Shell installation wizard</title>",
		`<p><a href="${href}">Continue to the Gentle Shell installation wizard</a></p>`,
		"",
	].join("\n");
}

/**
 * Writes the redirect page into a fresh private directory (0700, file 0600)
 * under tempDir, so the one-time code never appears in the opener's argv.
 * remove() is idempotent and best effort: it deletes the file, then the directory.
 */
export async function writeRedirect(url, { tempDir = tmpdir(), files = fsPromises } = {}) {
	const dir = await files.mkdtemp(join(tempDir, "gentle-shell-install-"));
	const file = join(dir, "open.html");
	let removed = false;
	const remove = async () => {
		if (removed) return;
		removed = true;
		await files.unlink(file).catch(() => {});
		await files.rmdir(dir).catch(() => {});
	};
	try {
		await files.chmod(dir, 0o700);
		await files.writeFile(file, redirectPage(url), { mode: 0o600, flag: "wx" });
	} catch (error) {
		await remove();
		throw error;
	}
	return { dir, file, remove };
}

/**
 * Opens url through a private redirect file with the fixed opener (shell:false,
 * detached). Returns { file, remove } while the file exists, or null when nothing
 * was opened; a failed opener removes the file. The printed URL stays the fallback.
 */
export async function openBrowser(url, { platform = process.platform, env = process.env, tempDir = tmpdir(), files = fsPromises,
	spawn = spawnChild } = {}) {
	// Resolve the opener first so no file is written when there is none.
	if (openerFor(platform, "", env) === null) return null;
	let redirect;
	try {
		redirect = await writeRedirect(url, { tempDir, files });
	} catch {
		return null;
	}
	const opener = openerFor(platform, redirect.file, env);
	try {
		const child = spawn(opener.command, opener.args, { shell: false, detached: true, stdio: "ignore", windowsHide: true });
		child.once("error", () => {
			void redirect.remove();
		});
		child.unref();
	} catch {
		await redirect.remove();
		return null;
	}
	return { file: redirect.file, remove: redirect.remove };
}

/** 0 only for a completed installation; blocked, failed or none is 1. */
export function exitCodeFor(outcome) {
	return ["ready", "terminal-action-required"].includes(outcome?.outcome) ? 0 : 1;
}

/** The runner's environment: the user's real PATH, so a temporary bootstrap npm
 * or node never counts as persistent and globalBin.onPath stays truthful. A
 * POSIX bootstrap pnpm (passed only through PATH) comes first: the bootstrap
 * acquired it because the user's pnpm is absent or incompatible, so the user's
 * is never run. Windows passes pnpm through the GENTLE_INSTALL_PNPM_* handoff.
 */
export async function runnerEnvironment({ platform, env, fs }) {
	const user = userEnvironment({ platform, env });
	if (platform === "win32") return user;
	const wizard = await pnpmInvocation(env, platform, fs);
	if (wizard === null || wizard.prefix.length > 0 || (await pnpmInvocation(user, platform, fs))?.command === wizard.command) return user;
	const rest = String(user.PATH ?? "").split(posix.delimiter).filter((entry) => entry.length > 0);
	return { ...user, PATH: [posix.dirname(wizard.command), ...rest].join(posix.delimiter) };
}

/** An update's children: with a private Windows PNPM_HOME, the runner children's
 * environment (pnpm's folders, TEMP and TMP inside it); a pinned Go first on PATH.
 */
export function upgradeEnvironment({ platform, env, pnpmHome, goPath }) {
	const globalBin = platform === "win32" && pnpmHome?.source === "private" ? pnpmGlobalBin({ platform, env }) : null;
	const base = globalBin ? childEnvironment(env, platform, globalBin, { privateHome: true }) : env;
	return goPath ? goFirstEnvironment(base, platform, goPath) : base;
}

/** The wizard host's collectPlan and runInstall. Every plan starts from a fresh
 * preflight. A new release installation whose release publishes the
 * distribution assets gets the bundled plan (bundledGate) and the bundled
 * runner; everything else gets planPreflight and the standard runner, unchanged.
 * `distributionBase`, `download` and `inventory` are trusted local overrides
 * for tests and local checks.
 */
export function wizardHandlers({ platform, arch, env, run, fs, distributionBase = DISTRIBUTION_RELEASES, download, inventory: inventoryFor }) {
	// Windows: the PNPM_HOME decision (S6) is made before any probe, on every
	// preflight. The server re-collects right before an installation, so the
	// installation uses the decision its consented plan was checked against.
	let wizard = { env, pnpmHome: null };
	// The distribution assets the latest bundled plan was made from; the bundled
	// runner checks them against the consented plan's lockfile sha256.
	let distribution = null;
	const decide = () => (wizard = platform === "win32" ? windowsWizardEnvironment({ env }) : { env, pnpmHome: null });
	// The user's own PATH and home (no bootstrap tools) for the bundled install's PATH entry and setup.
	const user = userEnvironment({ platform, env });
	const home = platform === "win32" ? env.USERPROFILE : env.HOME;
	return {
		collectPlan: async (channel) => {
			const { env: wizardEnv, pnpmHome } = decide();
			// Fresh probes every time: createProbes caches its global package listing.
			const inventory = inventoryFor ? await inventoryFor(channel)
				: await collectInventory({ platform, arch, probes: createProbes({ platform, env: wizardEnv, run, fs, pnpmHome }), pnpmHome });
			// Only a new release installation asks whether its release publishes the assets.
			const assets = channel === "release" && inventory.shell?.available === false
				? await fetchDistribution({ version: requirements.shell, base: distributionBase, ...(download ? { download } : {}) }) : null;
			if (bundledGate({ channel, inventory, distribution: assets, version: requirements.shell })) {
				distribution = assets;
				// The folder the claim will take (Windows may fall back to the profile), from read-only checks.
				const layout = prefixLayout({ platform, env: user, home, root: prefixRoot({ platform, env: user }) });
				return { inventory, plan: bundledPlan({ platform, distribution: assets, layout, path: pathEntryPlan(layout, { platform, env: user, home }) }) };
			}
			return { inventory, plan: planPreflight(inventory, { channel }) };
		},
		runInstall: async (request, log) => {
			if (request?.plan?.bundled !== undefined) {
				return runBundledInstall(request, { platform, arch, env: user, home, distribution, log,
					...(platform === "win32" ? { registry: windowsPathRegistry(env) } : {}) });
			}
			const { env: wizardEnv, pnpmHome } = wizard;
			const runnerEnv = await runnerEnvironment({ platform, env: wizardEnv, fs });
			const ctx = { env: runnerEnv, home: runnerEnv.HOME ?? env.HOME ?? env.USERPROFILE };
			return runStandardInstall(request, {
			platform,
			nodePath: process.execPath,
			env: runnerEnv,
			run,
			fs,
			// An existing Gentle Shell: fresh probes find it, `gentle-shell upgrade`'s logic updates it.
			locateShell: () => createProbes({ platform, env: wizardEnv, run, fs, pnpmHome }).locateShell(),
			// An older Pi: fresh probes find it before its update and confirm it afterwards.
			locatePi: () => createProbes({ platform, env: wizardEnv, run, fs, pnpmHome }).locatePi(),
			// Only a plan with a private Windows PNPM_HOME: claimed, then walked again.
			preparePnpmHome: (home) => ensureWindowsPnpmHome(home, runnerEnv),
			// Only a plan that needs Go and found it missing or older: verified go.dev
			// bytes under <config home>/tools/go, used by path or child PATH only.
			acquireGo: () => acquireGo({ root: join(configHome(ctx), "tools", "go"), platform, arch }),
			// A pinned Go goes first on the PATH of the upgrade's children only. On
			// Windows npm and pnpm (the bootstrap's handoff) run without cmd.exe.
			upgradeShell: async ({ channel, packageRoot, currentVersion, goPath }) => {
				const upgradeEnv = upgradeEnvironment({ platform, env: runnerEnv, pnpmHome, goPath });
				const invocation = upgradeInvocation({ platform, env: upgradeEnv, run, fs, handoff: true });
				return (await runUpgrade({
					args: ["--channel", channel],
					ctx,
					platform,
					arch,
					packageRoot,
					currentVersion,
					adapters: {
						fetch: globalThis.fetch,
						fs: fsPromises,
						which: (name) => lookPath(name, upgradeEnv, platform, fs),
						...(invocation ? { invocation } : {}),
						// stderrTail: a failed main build or extraction keeps its bounded stderr as the error's cause.
						run: (command, argv, options = {}) => run(command, argv, { env: options.env ?? upgradeEnv, cwd: options.cwd, deadlineMs: options.deadlineMs ?? 20 * 60_000,
							...(options.stderrTail === undefined ? {} : { stderrTail: options.stderrTail }) }),
					},
					out: () => {},
				})) === 0;
			},
			verifyGentleAi: packageNativeGentleAi,
			// Only a main plan uses it: network access and writes under ~/.pi/gentle-ai.
			mainChannel: mainChannelAdapter({ fs: fsPromises }),
			log,
		});
		},
	};
}

async function main() {
	const { platform, arch, env } = process;
	const { run, fs } = hostAdapters();
	// The redirect file is removed once the code is redeemed, or when the host closes.
	let redeemed = false;
	let redirect = null;
	const host = createInstallerServer({
		onRedeemed: () => {
			redeemed = true;
			void redirect?.remove();
		},
		assetsDir: fileURLToPath(new URL("../assets/install-wizard/", import.meta.url)),
		...wizardHandlers({ platform, arch, env, run, fs }),
	});
	let started;
	try {
		started = await host.listen();
	} catch {
		console.error("The installation wizard could not start its local server. Nothing was installed.");
		process.exitCode = 1;
		return;
	}
	console.log("Gentle Shell installation wizard");
	console.log(`Open this link in your browser (it works once and expires in 2 minutes):\n  ${started.url}`);
	console.log("Press Ctrl+C to stop the wizard.");

	let signalled = false;
	const stop = () => {
		signalled = true;
		host.close("signal");
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	const opening = openBrowser(started.url).then((opened) => {
		redirect = opened;
		// The printed URL may have been redeemed while the file was being written.
		if (redeemed) void opened?.remove();
		return opened;
	});
	const { reason, outcome } = await host.closed;
	process.off("SIGINT", stop);
	process.off("SIGTERM", stop);
	await (await opening)?.remove();
	const code = exitCodeFor(outcome);
	if (outcome?.guidance) console.log(outcome.guidance);
	else if (reason === "idle") console.log("The wizard closed after 30 minutes without activity. Nothing was installed.");
	else console.log("The wizard closed without installing anything.");
	if (signalled) process.exit(code);
	process.exitCode = code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch(() => {
		console.error("The installation wizard stopped unexpectedly.");
		process.exitCode = 1;
	});
}
