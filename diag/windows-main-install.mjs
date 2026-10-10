// Temporary diagnostic: runs the installer's real install-shell-main pieces on native Windows.
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { hostAdapters } from "../scripts/installer-probes.mjs";
import { mainChannelAdapter } from "../scripts/main-channel.mjs";

const { run } = hostAdapters();
const traced = async (command, argv, options = {}) => {
	const result = await run(command, argv, { ...options, env: options.env ?? process.env, stderrTail: 4096 });
	console.log(`$ ${command} ${argv.join(" ")}  (cwd ${options.cwd ?? "-"})`);
	console.log(`  code=${result.code} signal=${result.signal} timedOut=${result.timedOut}`);
	if (result.stdout) console.log(`  stdout: ${String(result.stdout).trim().slice(-1500)}`);
	if (result.stderrTail) console.log(`  stderr: ${String(result.stderrTail).trim().slice(-1500)}`);
	return result;
};
for (const tool of ["tar", "pnpm"]) {
	try { console.log(`where ${tool}:\n${execFileSync("where.exe", [tool], { encoding: "utf8" })}`); } catch { console.log(`where ${tool}: none`); }
}
const home = process.env.USERPROFILE;
const ctx = { env: { ...process.env, GENTLE_PI_CONFIG_HOME: join(process.env.RUNNER_TEMP, "gentle-config") }, home };
const pnpmCli = join(execFileSync("npm.cmd", ["root", "-g"], { encoding: "utf8", shell: true }).trim(), "pnpm", "bin", "pnpm.mjs");
const pnpm = { command: process.execPath, prefix: [pnpmCli] };
// Diagnostic only: the runner's shared IP hits GitHub's anonymous API limit.
const authedFetch = (url, init = {}) => String(url).startsWith("https://api.github.com/")
	? fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${process.env.GH_TOKEN}` } }) : fetch(url, init);
const channel = mainChannelAdapter({ fs, fetch: authedFetch });
const commit = await channel.resolveCommit("Gentleman-Programming/gentle-shell");
console.log(`shell commit ${commit}`);
// A. Git for Windows' MSYS tar with a Windows path, as when its usr\bin comes first on PATH.
{
	const probe = join(process.env.RUNNER_TEMP, "msys-probe");
	await fs.rm(probe, { recursive: true, force: true });
	await fs.mkdir(join(probe, "out"), { recursive: true });
	const archive = join(probe, "a.tgz");
	execFileSync("C:\\Windows\\System32\\tar.exe", ["-czf", archive, "-C", process.env.GITHUB_WORKSPACE, "package.json"]);
	await traced("C:\\Program Files\\Git\\usr\\bin\\tar.exe", ["-xzf", archive, "-C", join(probe, "out")]);
	const msysFirst = { ...process.env, PATH: `C:\\Program Files\\Git\\usr\\bin;${process.env.PATH}` };
	await traced("tar", ["-xzf", archive, "-C", join(probe, "out")], { env: msysFirst });
}
// B. The real flow installs the release stack first, then overlays main.
const release = await traced(pnpm.command, [...pnpm.prefix, "add", "-g", "@earendil-works/pi-coding-agent@1.0.0", "gentle-pi@4.0.0", "--allow-build=gentle-pi"], { deadlineMs: 20 * 60_000 });
console.log(release.code === 0 ? "RELEASE OK" : "RELEASE FAILED");
let tgz;
try {
	tgz = await channel.packShell({ commit, ctx, run: traced, pnpm });
	console.log(`PACK OK ${tgz}`);
} catch (error) {
	console.log(`PACK FAILED ${error.code ?? ""} ${error.message}`);
	process.exit(1);
}
const add = await traced(pnpm.command, [...pnpm.prefix, "add", "-g", tgz, "--allow-build=gentle-pi"], { deadlineMs: 20 * 60_000 });
console.log(add.code === 0 ? "ADD OK" : "ADD FAILED");
const list = await traced(pnpm.command, [...pnpm.prefix, "list", "-g", "--json"], { deadlineMs: 120_000 });
console.log(`LIST ${String(list.stdout).replace(/\s+/g, " ").slice(0, 3000)}`);
process.exit(add.code === 0 ? 0 : 1);
