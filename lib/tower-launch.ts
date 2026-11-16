// Gentle Tower: open a new floor = start a new Gentle Shell session in a new
// terminal window, in a project already in the tower. Fixed command, every
// value quoted for the shell that reads it (sh on macOS/Linux, cmd on
// Windows); the first message is one argument and never reaches a command line.

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

/** cmd reads at most 8191 characters per line. */
const CMD_LINE_MAX = 8191;

function cmdSafe(value: string, what: string, quotes: boolean): string {
	// A line break ends the command; other control characters have no safe spelling in a batch file.
	if (/[\0-\x08\n-\x1f\x7f]/.test(value)) throw new Error(`Gentle Tower: the ${what} has a line break or control character, which cmd cannot pass safely`);
	if (!quotes && value.includes('"')) throw new Error(`Gentle Tower: the ${what} has a double quote, which cmd cannot pass safely`);
	return value;
}

/**
 * One argument for a batch-file line, read first by cmd and then by the C runtime of the program.
 * Inside double quotes cmd keeps `& | < > ^ ( )` literal; `%` is the one character a batch file
 * still expands there, so it is written `%%`. A quote is written `""`: cmd stays inside the quotes and
 * the C runtime reads one literal `"`; backslashes before a quote or at the end are doubled for it.
 */
function cmdArg(value: string): string {
	const escaped = value.replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, "$1$1");
	return `"${escaped.replace(/%/g, "%%")}"`;
}

/**
 * The Windows launcher (a `.cmd` file, CRLF). Delayed expansion is turned off so `!` stays literal,
 * the code page is UTF-8 so the message keeps its accents, and the script deletes itself at the end:
 * a running batch file cannot remove itself before its last line.
 */
export function buildWindowsLaunchScript(spec: LaunchSpec): string {
	const cwd = cmdSafe(spec.cwd, "project folder", false);
	const node = cmdSafe(spec.node, "Node path", false);
	const launcher = cmdSafe(spec.launcher, "launcher path", false);
	const prompt = spec.prompt === undefined ? undefined : cmdSafe(spec.prompt, "first message", true);
	// `--` for gentle-shell, then `--` for pi: a message starting with "-" is never an option.
	const args = [node, launcher, ...(prompt ? ["--", "--", prompt] : [])].map(cmdArg).join(" ");
	const run = `cd /d "${cwd.replace(/%/g, "%%")}" && ${args}`;
	if (run.length > CMD_LINE_MAX) throw new Error(`Gentle Tower: the command is longer than cmd's ${CMD_LINE_MAX}-character line limit`);
	return ["@echo off", "setlocal DisableDelayedExpansion", "chcp 65001 >nul", run, `(goto) 2>nul & del "%~f0"`, ""].join("\r\n");
}

export interface LaunchDeps { tmpRoot?: string; platform?: NodeJS.Platform; spawn?: typeof spawn }

/**
 * Opens the script in a new terminal window: macOS Terminal, the Linux default terminal
 * (x-terminal-emulator), or on Windows Windows Terminal, else a cmd window. Never throws: every failure is a rejection.
 */
export async function launchInTerminal(spec: LaunchSpec, deps: LaunchDeps = {}): Promise<void> {
	const platform = deps.platform ?? process.platform;
	const run = deps.spawn ?? spawn;
	if (platform === "win32") {
		const body = buildWindowsLaunchScript(spec);
		const dir = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "gentle-tower-floor-"));
		writeFileSync(join(dir, "new-floor.cmd"), body, { mode: 0o700, flag: "wx" });
		// Every starter runs in the script's folder and names it by a fixed relative name, so no
		// user text and no path ever reaches a command line that cmd parses.
		const starter = (cmd: string, args: string[], verbatim: boolean) => new Promise<void>((resolve, reject) => {
			const child = run(cmd, args, { stdio: "ignore", cwd: dir, windowsVerbatimArguments: verbatim });
			child.once("error", reject);
			// wt.exe and `cmd /c start` hand the window off and exit: their exit code is the answer.
			child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Gentle Tower: ${cmd} exited with ${code}`))));
		});
		// Windows Terminal splits its own arguments on `;`, so a folder with one goes straight to cmd.
		if (!dir.includes(";")) {
			try {
				return await starter("wt.exe", ["-d", dir, "cmd", "/d", "/c", ".\\new-floor.cmd"], false);
			} catch (error) {
				// Only a missing Windows Terminal falls back; one that started and failed is not retried in a second window.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		// Verbatim: the empty window title `""` must reach `start` as written.
		return starter("cmd.exe", ["/d", "/c", "start", '""', "cmd", "/d", "/k", ".\\new-floor.cmd"], true);
	}
	const dir = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "gentle-tower-floor-"));
	chmodSync(dir, 0o700);
	const script = join(dir, "new-floor.command");
	writeFileSync(script, buildLaunchScript(spec), { mode: 0o700, flag: "wx" });
	const mac = platform === "darwin";
	const [cmd, args] = mac ? ["open", ["-a", "Terminal", script]] : ["x-terminal-emulator", ["-e", script]];
	await new Promise<void>((resolve, reject) => {
		const child = run(cmd, args as string[], { stdio: "ignore", detached: !mac });
		child.once("error", reject);
		// `open` hands the script to Terminal and exits: its exit code is the answer.
		// The Linux terminal is the window itself and keeps running, so starting it is enough.
		if (mac) child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Gentle Tower: open exited with ${code}`))));
		else child.once("spawn", () => { child.unref(); resolve(); });
	});
}
