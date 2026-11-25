// `gentle-shell serve share`: the connection code a desktop client pastes when
// LAN discovery cannot find this server, the addresses that
// code advertises, the firewall hint, and the login autostart (a systemd user
// unit or a macOS LaunchAgent) that keeps the network server running.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

export const CONNECTION_CODE_PREFIX = "gsc1.";
export const SHARE_DEFAULT_PORT = 8787;
/** Ports tried after the requested one when it is taken. */
export const SHARE_PORT_ATTEMPTS = 10;
const MAX_ADDRESSES = 8;

// One DNS name (no port, no trailing dot) a client may put in the Host header.
export const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

// --- connection code ---------------------------------------------------------------

export interface ConnectionCode {
	/** Server id; a client pairs only at an address whose identity names it. */
	id: string;
	/** Server name (its hostname), for display. */
	n: string;
	p: number;
	/** Addresses to probe, best first. */
	a: string[];
	/** Pairing code: single use, 5 minutes. */
	c: string;
}

/** `gsc1.` + base64url (no padding) of `{"v":1,"id","n","p","a","c"}`. A secret while its pairing code is valid. */
export function encodeConnectionCode(code: ConnectionCode): string {
	const json = JSON.stringify({ v: 1, id: code.id, n: code.n, p: code.p, a: code.a, c: code.c });
	return `${CONNECTION_CODE_PREFIX}${Buffer.from(json, "utf8").toString("base64url")}`;
}

// --- addresses ---------------------------------------------------------------------

// Container, VM and bridge interfaces: reachable from this machine only, so last.
const VIRTUAL_INTERFACE = /^(?:docker|br-|veth|virbr|vmnet|vboxnet|cni|flannel|podman|lxcbr|lxdbr|bridge)/i;

function privateIPv4(address: string): boolean {
	const [a, b] = address.split(".").map(Number);
	return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** This machine's own names a client may use: the hostname and `<hostname>.local` (the names a `0.0.0.0` bind admits). */
export function ownHostNames(name: string): string[] {
	const own = name.toLowerCase();
	if (!HOST_NAME.test(own)) return [];
	return own.endsWith(".local") ? [own] : [own, `${own}.local`];
}

/**
 * The addresses a connection code advertises: this machine's IPv4 addresses
 * other than loopback and link-local (private LAN ranges first, then others such
 * as a tailnet's, then container and VM bridges), then its own names as
 * fallbacks. At most 8; the names always keep their places.
 */
export function shareAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, name: string): string[] {
	const names = ownHostNames(name);
	const ranked: Array<{ address: string; rank: number }> = [];
	for (const [iface, infos] of Object.entries(interfaces)) {
		for (const info of infos ?? []) {
			// Node < 18.4 reported the family as a number.
			if ((info.family as string | number) !== "IPv4" && (info.family as string | number) !== 4) continue;
			const address = info.address;
			if (info.internal || address.startsWith("127.") || address.startsWith("169.254.") || address === "0.0.0.0") continue;
			if (ranked.some((r) => r.address === address)) continue;
			ranked.push({ address, rank: VIRTUAL_INTERFACE.test(iface) ? 2 : privateIPv4(address) ? 0 : 1 });
		}
	}
	const addresses = ranked.sort((x, y) => x.rank - y.rank).map((r) => r.address);
	return [...addresses.slice(0, Math.max(0, MAX_ADDRESSES - names.length)), ...names];
}

// --- firewall ----------------------------------------------------------------------

/** Whether `command` is on PATH (plus the sbin folders a user PATH may lack). */
export function commandExists(command: string, env: NodeJS.ProcessEnv): boolean {
	const dirs = [...(env.PATH ?? "").split(delimiter), "/usr/sbin", "/sbin", "/usr/local/sbin"];
	return dirs.some((dir) => dir !== "" && isAbsolute(dir) && existsSync(join(dir, command)));
}

/** Inclusive listen ports for forwarded pages. */
export interface PortRange {
	from: number;
	to: number;
}

/** The ports `share` gives forwarded pages, so one firewall rule covers them all. */
export const SHARE_FORWARD_PORTS: PortRange = { from: 8800, to: 8899 };

/**
 * The command that opens `port` in the local firewall for TCP (HTTP) and UDP (LAN discovery), plus the
 * forwarded pages' TCP range when the server has one, on Linux with ufw or firewalld; never run for the user.
 */
export function firewallHint(platform: NodeJS.Platform, port: number, has: (command: string) => boolean, forwardPorts?: PortRange): string | undefined {
	if (platform !== "linux") return undefined;
	if (has("ufw")) return `sudo ufw allow ${port}${forwardPorts ? ` && sudo ufw allow ${forwardPorts.from}:${forwardPorts.to}/tcp` : ""}`;
	if (has("firewall-cmd")) return `sudo firewall-cmd --permanent --add-port=${port}/tcp --add-port=${port}/udp${forwardPorts ? ` --add-port=${forwardPorts.from}-${forwardPorts.to}/tcp` : ""} && sudo firewall-cmd --reload`;
	return undefined;
}

// --- autostart ---------------------------------------------------------------------

export const AUTOSTART_UNIT = "gentle-shell-serve.service";
export const AUTOSTART_LABEL = "com.gentle-shell.serve";
/** Environment an autostarted server keeps from the invocation that installed it. */
const AUTOSTART_ENV = ["PATH", "GENTLE_SHELL_NO_AUTO_SETUP", "GENTLE_SHELL_HOME", "GENTLE_SHELL_CONFIG", "GENTLE_PI_CONFIG_HOME", "GENTLE_SHELL_PI", "PI_CODING_AGENT_DIR"];

export interface AutostartCommand {
	command: string;
	args: string[];
	env: Record<string, string>;
	/** macOS: launchd writes the server's output here (systemd uses the journal). */
	logFile: string;
}

/** The same launcher, home flags and kept environment as this invocation, serving the network in the foreground. */
export function autostartCommand(input: { nodePath: string; launcher: string; homeFlags: readonly string[]; port: number; allowHosts: readonly string[]; forwardPorts?: PortRange; env: NodeJS.ProcessEnv; logFile: string }): AutostartCommand {
	const env: Record<string, string> = {};
	for (const key of AUTOSTART_ENV) {
		const value = input.env[key];
		if (value !== undefined && value !== "" && !/[\r\n]/.test(value)) env[key] = value;
	}
	return {
		command: input.nodePath,
		args: [input.launcher, ...input.homeFlags, "serve", "--foreground", "--listen", `0.0.0.0:${input.port}`, ...input.allowHosts.flatMap((name) => ["--allow-host", name]),
			...(input.forwardPorts ? ["--forward-ports", `${input.forwardPorts.from}-${input.forwardPorts.to}`] : [])],
		env,
		logFile: input.logFile,
	};
}

// systemd unit quoting: `%` is a specifier and `$` a variable in ExecStart.
function systemdArg(value: string): string {
	if (value !== "" && !/[\s"'\\%$;]/.test(value)) return value;
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

export function systemdUnit(spec: AutostartCommand): string {
	const env = Object.entries(spec.env).map(([key, value]) => `Environment="${key}=${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`);
	return [
		"# Written by 'gentle-shell serve share --always'; remove with 'gentle-shell serve share --off'.",
		"[Unit]",
		"Description=Gentle Shell server for the local network",
		// Gives up after 5 failed starts in a minute (for example another server already holds this home).
		"StartLimitIntervalSec=60",
		"StartLimitBurst=5",
		"",
		"[Service]",
		"Type=simple",
		...env,
		`ExecStart=${[spec.command, ...spec.args].map(systemdArg).join(" ")}`,
		"Restart=on-failure",
		"RestartSec=5",
		"TimeoutStopSec=30",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}

function xml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function launchAgentPlist(spec: AutostartCommand): string {
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		"<!-- Written by 'gentle-shell serve share --always'; remove with 'gentle-shell serve share --off'. -->",
		'<plist version="1.0">',
		"<dict>",
		"\t<key>Label</key>",
		`\t<string>${AUTOSTART_LABEL}</string>`,
		"\t<key>ProgramArguments</key>",
		"\t<array>",
		...[spec.command, ...spec.args].map((arg) => `\t\t<string>${xml(arg)}</string>`),
		"\t</array>",
		"\t<key>EnvironmentVariables</key>",
		"\t<dict>",
		...Object.entries(spec.env).flatMap(([key, value]) => [`\t\t<key>${xml(key)}</key>`, `\t\t<string>${xml(value)}</string>`]),
		"\t</dict>",
		"\t<key>RunAtLoad</key>",
		"\t<true/>",
		// Restarted after a crash, not after `serve stop`.
		"\t<key>KeepAlive</key>",
		"\t<dict>",
		"\t\t<key>SuccessfulExit</key>",
		"\t\t<false/>",
		"\t</dict>",
		"\t<key>StandardOutPath</key>",
		`\t<string>${xml(spec.logFile)}</string>`,
		"\t<key>StandardErrorPath</key>",
		`\t<string>${xml(spec.logFile)}</string>`,
		"</dict>",
		"</plist>",
		"",
	].join("\n");
}

/** Runs a command to completion; ENOENT is status 127. */
export type CommandRunner = (command: string, args: readonly string[]) => Promise<{ status: number; output: string }>;

export function commandRunner(env: NodeJS.ProcessEnv): CommandRunner {
	return (command, args) => {
		const { promise, resolve } = Promise.withResolvers<{ status: number; output: string }>();
		let output = "";
		const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		child.stdout.on("data", (d) => { output += d; });
		child.stderr.on("data", (d) => { output += d; });
		child.once("error", (error) => resolve({ status: (error as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1, output: `${output}${error.message}` }));
		child.once("close", (code) => resolve({ status: code ?? 1, output }));
		return promise;
	};
}

/** Machine facts and the command runner `serve share` uses; tests replace them. */
export interface ShareSystem {
	platform: NodeJS.Platform;
	hostname: () => string;
	networkInterfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
	userHome: string;
	/** XDG_CONFIG_HOME when set (systemd reads user units there). */
	configHome?: string;
	uid: number;
	user: string;
	run: CommandRunner;
	has: (command: string) => boolean;
}

export function defaultShareSystem(env: NodeJS.ProcessEnv): ShareSystem {
	const userHome = homedir();
	return {
		platform: process.platform,
		hostname,
		networkInterfaces,
		userHome,
		...(env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? { configHome: env.XDG_CONFIG_HOME } : {}),
		uid: process.getuid?.() ?? 0,
		user: env.USER ?? env.LOGNAME ?? "$USER",
		run: commandRunner(env),
		has: (command) => commandExists(command, env),
	};
}

/** Where autostart lives on this platform, or undefined where it is not supported (Windows). */
export function autostartFile(system: Pick<ShareSystem, "platform" | "userHome" | "configHome">): string | undefined {
	if (system.platform === "linux") return join(system.configHome ?? join(system.userHome, ".config"), "systemd", "user", AUTOSTART_UNIT);
	if (system.platform === "darwin") return join(system.userHome, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`);
	return undefined;
}

export function autostartContent(system: Pick<ShareSystem, "platform">, spec: AutostartCommand): string {
	return system.platform === "darwin" ? launchAgentPlist(spec) : systemdUnit(spec);
}

/** Whether the installed autostart is exactly this one. */
export function autostartInstalled(system: Pick<ShareSystem, "platform" | "userHome" | "configHome">, spec: AutostartCommand): boolean {
	const file = autostartFile(system);
	try {
		return file !== undefined && readFileSync(file, "utf8") === autostartContent(system, spec);
	} catch {
		return false;
	}
}

/** Writes the unit or agent and starts it now through the service manager. An error removes what was written. */
export async function installAutostart(system: ShareSystem, spec: AutostartCommand): Promise<{ file: string } | { error: string }> {
	const file = autostartFile(system);
	if (!file) return { error: `autostart is not supported on ${system.platform} yet` };
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, autostartContent(system, spec), { mode: 0o644 });
	const steps: Array<[string, string[]]> = system.platform === "darwin"
		? [["launchctl", ["bootstrap", `gui/${system.uid}`, file]]]
		: [["systemctl", ["--user", "daemon-reload"]], ["systemctl", ["--user", "enable", "--now", AUTOSTART_UNIT]]];
	if (system.platform === "darwin") {
		// launchd opens the log before the server runs: create it owner-only first.
		mkdirSync(dirname(spec.logFile), { recursive: true, mode: 0o700 });
		closeSync(openSync(spec.logFile, "a", 0o600));
		// A previous version of the agent may still be loaded.
		await system.run("launchctl", ["bootout", `gui/${system.uid}/${AUTOSTART_LABEL}`]);
	}
	for (const [command, args] of steps) {
		const result = await system.run(command, args);
		if (result.status !== 0) {
			rmSync(file, { force: true });
			if (system.platform !== "darwin") await system.run("systemctl", ["--user", "daemon-reload"]);
			return { error: `${command} ${args.join(" ")} failed (${result.status})${result.output.trim() ? `: ${result.output.trim()}` : ""}` };
		}
	}
	return { file };
}

/** Stops the autostarted server and removes the unit or agent. */
export async function removeAutostart(system: ShareSystem): Promise<{ file: string; removed: boolean }> {
	const file = autostartFile(system);
	if (!file || !existsSync(file)) return { file: file ?? "", removed: false };
	if (system.platform === "darwin") {
		await system.run("launchctl", ["bootout", `gui/${system.uid}/${AUTOSTART_LABEL}`]);
		rmSync(file, { force: true });
	} else {
		await system.run("systemctl", ["--user", "disable", "--now", AUTOSTART_UNIT]);
		rmSync(file, { force: true });
		await system.run("systemctl", ["--user", "daemon-reload"]);
	}
	return { file, removed: true };
}
