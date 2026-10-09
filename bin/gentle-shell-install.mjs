#!/usr/bin/env node
import { spawn as spawnChild } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectInventory, planPreflight } from "../scripts/installer-preflight.mjs";
import { createProbes, hostAdapters, userEnvironment } from "../scripts/installer-probes.mjs";
import { lookPath, packageNativeGentleAi, pnpmInvocation, runStandardInstall } from "../scripts/installer-runner.mjs";
import { createInstallerServer } from "../scripts/installer-server.mjs";
import { mainChannelAdapter, runUpgrade } from "../scripts/main-channel.mjs";

// Browser installation wizard entry, started by the bootstrap with no argv.
// Thin wiring only: real probes and adapters, the standard runner and the
// loopback host. Exit 0 keeps the bootstrap's tools; nonzero removes them.

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
 * POSIX bootstrap pnpm (passed only through PATH) stays reachable as the last
 * PATH entry; Windows passes pnpm through the GENTLE_INSTALL_PNPM_* handoff.
 */
export async function runnerEnvironment({ platform, env, fs }) {
	const user = userEnvironment({ platform, env });
	if (platform === "win32" || (await pnpmInvocation(user, platform, fs)) !== null) return user;
	const wizard = await pnpmInvocation(env, platform, fs);
	if (wizard === null || wizard.prefix.length > 0) return user;
	const rest = String(user.PATH ?? "").split(posix.delimiter).filter((entry) => entry.length > 0);
	return { ...user, PATH: [...rest, posix.dirname(wizard.command)].join(posix.delimiter) };
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
		collectPlan: async (channel) => {
			// Fresh probes every time: createProbes caches its global package listing.
			const inventory = await collectInventory({ platform, arch, probes: createProbes({ platform, env, run, fs }) });
			return { inventory, plan: planPreflight(inventory, { channel }) };
		},
		runInstall: async (request, log) => {
			const runnerEnv = await runnerEnvironment({ platform, env, fs });
			return runStandardInstall(request, {
			platform,
			nodePath: process.execPath,
			env: runnerEnv,
			run,
			fs,
			// An existing Gentle Shell: fresh probes find it, `gentle-shell upgrade`'s logic updates it.
			locateShell: () => createProbes({ platform, env, run, fs }).locateShell(),
			upgradeShell: async ({ channel, packageRoot, currentVersion }) => (await runUpgrade({
				args: ["--channel", channel],
				ctx: { env: runnerEnv, home: runnerEnv.HOME ?? env.HOME ?? env.USERPROFILE },
				platform,
				packageRoot,
				currentVersion,
				adapters: {
					fetch: globalThis.fetch,
					fs: fsPromises,
					which: (name) => lookPath(name, runnerEnv, platform, fs),
					run: (command, argv, options = {}) => run(command, argv, { env: options.env ?? runnerEnv, cwd: options.cwd, deadlineMs: options.deadlineMs ?? 20 * 60_000 }),
				},
				out: () => {},
			})) === 0,
			verifyGentleAi: packageNativeGentleAi,
			// Only a main plan uses it: network access and writes under ~/.pi/gentle-ai.
			mainChannel: mainChannelAdapter({ fs: fsPromises }),
			log,
		});
		},
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
