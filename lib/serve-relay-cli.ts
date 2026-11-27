// `gentle-shell relay --listen <host>:<port>`: runs the rendezvous servers
// connect out to (lib/serve-relay.ts) in the foreground, with the secret a
// server must present to register. The secret comes from
// GENTLE_SHELL_RELAY_SECRET, --secret-file, or `<home>/relay/secret` (made on
// first run, owner-only). Run it under a service manager to keep it up.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseListen } from "./serve-cli.ts";
import { startRelay, type Relay } from "./serve-relay.ts";

export type RelayArgs =
	| { action: "run"; host: string; port: number; secretFile?: string; json: boolean }
	| { action: "help" };

export const RELAY_HELP = [
	"Usage: gentle-shell [home selectors] relay --listen <host>:<port> [--secret-file <path>] [--json]",
	"",
	"Runs a relay that lets devices outside a Gentle Shell server's network reach it. Servers connect",
	"out to the relay ('gentle-shell serve share --relay gsr://<this host>:<port>'), so they need no",
	"open port; a device asks the relay for a server and the relay joins the two TCP streams. TLS runs",
	"end to end between the device and the server, which the device pins: the relay sees only",
	"ciphertext and logs byte counts, never content.",
	"",
	"A server must present the relay secret to register: GENTLE_SHELL_RELAY_SECRET, else the file",
	"--secret-file names, else <home>/relay/secret (made on first run, owner-only). Give it to each",
	"server's owner, who puts it in <their home>/serve/relay-secret or GENTLE_SHELL_RELAY_SECRET.",
	"",
	"  --listen         Address and port to listen on, for example 0.0.0.0:7700 (required).",
	"  --secret-file    A file whose first line is the secret.",
	"  --json           Print one JSON line when listening, for programs.",
	"",
	"It runs in the foreground until Ctrl+C. Protocol and limits: docs/serve.md#relay.",
].join("\n");

export function parseRelayArgs(args: readonly string[]): RelayArgs | { error: string } {
	let listen: { host: string; port: number } | undefined;
	let secretFile: string | undefined;
	let json = false;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		const value = (flag: string): string | undefined => {
			if (arg === flag) return args[(i += 1)];
			return arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : undefined;
		};
		if (arg === "--help" || arg === "-h") return { action: "help" };
		if (arg === "--json") { json = true; continue; }
		if (arg === "--listen" || arg.startsWith("--listen=")) {
			const parsed = parseListen(value("--listen") ?? "");
			if ("error" in parsed) return parsed;
			listen = parsed;
			continue;
		}
		if (arg === "--secret-file" || arg.startsWith("--secret-file=")) {
			secretFile = value("--secret-file");
			if (!secretFile) return { error: "--secret-file needs a path" };
			continue;
		}
		return { error: `unknown relay argument "${arg}"` };
	}
	if (!listen) return { error: "relay needs --listen <host>:<port>, for example --listen 0.0.0.0:7700" };
	return { action: "run", host: listen.host, port: listen.port, json, ...(secretFile === undefined ? {} : { secretFile }) };
}

export interface RelayCommandContext {
	agentHome: string;
	env: NodeJS.ProcessEnv;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	/** Resolves when the relay should stop (defaults to SIGINT/SIGTERM). */
	untilStopped?: () => Promise<void>;
}

/** The secret and where it came from; the default file is made on first run. */
export function relayServerSecret(ctx: Pick<RelayCommandContext, "agentHome" | "env">, secretFile?: string): { secret: string; source: string } {
	const fromEnv = ctx.env.GENTLE_SHELL_RELAY_SECRET?.trim();
	if (fromEnv) return { secret: fromEnv, source: "GENTLE_SHELL_RELAY_SECRET" };
	const path = secretFile ?? join(ctx.agentHome, "relay", "secret");
	if (secretFile !== undefined || existsSync(path)) {
		const secret = readFileSync(path, "utf8").split(/\r?\n/)[0].trim();
		if (!secret) throw new Error(`${path} holds no secret on its first line`);
		return { secret, source: path };
	}
	mkdirSync(join(ctx.agentHome, "relay"), { recursive: true, mode: 0o700 });
	const secret = randomBytes(24).toString("base64url");
	writeFileSync(path, `${secret}\n`, { mode: 0o600, flag: "wx" });
	try { chmodSync(path, 0o600); } catch { /* Windows: ACLs, not modes */ }
	return { secret, source: path };
}

function untilSignal(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const done = () => {
		process.off("SIGINT", done);
		process.off("SIGTERM", done);
		resolve();
	};
	process.on("SIGINT", done);
	process.on("SIGTERM", done);
	return promise;
}

export async function runRelayCommand(args: RelayArgs, ctx: RelayCommandContext): Promise<number> {
	if (args.action === "help") {
		ctx.stdout(`${RELAY_HELP}\n`);
		return 0;
	}
	let relay: Relay | undefined;
	try {
		const { secret, source } = relayServerSecret(ctx, args.secretFile);
		const log = (line: string) => ctx.stderr(`${new Date().toISOString()} ${line}\n`);
		relay = await startRelay({ host: args.host, port: args.port, secret, log });
		const host = args.host.includes(":") ? `[${args.host}]` : args.host;
		ctx.stdout(args.json
			? `${JSON.stringify({ schema: "gentle-shell.relay/v1", host: args.host, port: relay.port, secretSource: source })}\n`
			: [
				`Gentle Shell relay listening on ${host}:${relay.port}.`,
				`Servers register with: gentle-shell serve share --relay gsr://<this machine's public name>:${relay.port}`,
				`They need the relay secret from ${source}${source === "GENTLE_SHELL_RELAY_SECRET" ? "" : " (copy its first line)"}, in their <home>/serve/relay-secret or GENTLE_SHELL_RELAY_SECRET.`,
				"Press Ctrl+C to stop.",
				"",
			].join("\n"));
		await (ctx.untilStopped ?? untilSignal)();
		log("relay stopping");
		return 0;
	} catch (error) {
		ctx.stderr(`gentle-shell relay: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	} finally {
		await relay?.close();
	}
}
