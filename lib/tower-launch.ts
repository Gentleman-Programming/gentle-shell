// Gentle Tower: open a new floor = start a new Gentle Shell session in a new
// terminal window, in a project already in the tower. Fixed command, every
// value single-quoted for the shell; the first message is one argument.

import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** POSIX single-quote: safe for any byte except NUL. */
export function shellQuote(value: string): string {
	if (value.includes("\0")) throw new Error("Gentle Tower: NUL in a shell argument");
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface LaunchSpec { cwd: string; node: string; launcher: string; prompt?: string }

export function buildLaunchScript(spec: LaunchSpec): string {
	// `--` for gentle-shell, then `--` for pi: a message starting with "-" is never an option.
	const args = [spec.node, spec.launcher, ...(spec.prompt ? ["--", "--", spec.prompt] : [])].map(shellQuote).join(" ");
	// The script removes itself first: it runs once and leaves no copy of the message behind.
	return `#!/bin/sh\nrm -f "$0"\ncd ${shellQuote(spec.cwd)} && exec ${args}\n`;
}

export interface LaunchDeps { tmpRoot?: string; platform?: NodeJS.Platform; spawn?: typeof spawn }

/** Opens the script in a new terminal window (macOS Terminal, or the Linux default terminal). Never throws: every failure is a rejection. */
export async function launchInTerminal(spec: LaunchSpec, deps: LaunchDeps = {}): Promise<void> {
	const dir = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "gentle-tower-floor-"));
	chmodSync(dir, 0o700);
	const script = join(dir, "new-floor.command");
	writeFileSync(script, buildLaunchScript(spec), { mode: 0o700, flag: "wx" });
	const mac = (deps.platform ?? process.platform) === "darwin";
	const [cmd, args] = mac ? ["open", ["-a", "Terminal", script]] : ["x-terminal-emulator", ["-e", script]];
	const run = deps.spawn ?? spawn;
	await new Promise<void>((resolve, reject) => {
		const child = run(cmd, args as string[], { stdio: "ignore", detached: !mac });
		child.once("error", reject);
		// `open` hands the script to Terminal and exits: its exit code is the answer.
		// The Linux terminal is the window itself and keeps running, so starting it is enough.
		if (mac) child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Gentle Tower: open exited with ${code}`))));
		else child.once("spawn", () => { child.unref(); resolve(); });
	});
}
