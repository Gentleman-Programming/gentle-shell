import { spawn as nodeSpawn } from "node:child_process";

// gentle-ai#4309 owns anonymous usage telemetry end to end: install and
// heartbeat events, the notice, every kill switch, and the wire contract.
// gentle-pi#677 only nudges the local binary once per process, best-effort,
// and never surfaces the outcome to the user. This module is the pure,
// testable core of that nudge (`shouldTriggerTelemetry`,
// `spawnTelemetryTrigger`) plus the decode helper the foreground
// `/gentle:telemetry` slash command uses to relay `<op> --json` output
// (`decodeTelemetryTriggerDecision`).

export const TELEMETRY_TRIGGER_KILL_TIMEOUT_MS = 3_000;

export const TELEMETRY_TRIGGER_CONTRACT = "gentle-ai.telemetry-trigger/v1";

export const TELEMETRY_TRIGGER_DECISIONS = [
	"enrolled",
	"sent_install",
	"sent_heartbeat",
	"rate_limited",
	"backoff",
	"disabled",
] as const;
export type TelemetryTriggerDecision = (typeof TELEMETRY_TRIGGER_DECISIONS)[number];

export interface TelemetryTriggerDecisionV1 {
	schema: typeof TELEMETRY_TRIGGER_CONTRACT;
	decision: TelemetryTriggerDecision;
	source: string;
}

/**
 * Decodes `gentle-ai telemetry trigger --json` stdout. An older binary
 * without the verb prints `unknown telemetry command` and exits non-zero, so
 * its stdout never parses as JSON here; that -- along with malformed JSON, a
 * mismatched schema, an unrecognized decision, or a missing/non-string
 * source -- means "nothing to do" and returns undefined rather than
 * throwing.
 */
export function decodeTelemetryTriggerDecision(stdout: string): TelemetryTriggerDecisionV1 | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	if (record.schema !== TELEMETRY_TRIGGER_CONTRACT) return undefined;
	if (typeof record.decision !== "string") return undefined;
	if (!(TELEMETRY_TRIGGER_DECISIONS as readonly string[]).includes(record.decision)) return undefined;
	if (typeof record.source !== "string" || record.source.length === 0) return undefined;
	return {
		schema: TELEMETRY_TRIGGER_CONTRACT,
		decision: record.decision as TelemetryTriggerDecision,
		source: record.source,
	};
}

export type TelemetryKillSwitchReason = "do-not-track" | "telemetry-disabled" | "ci";

function telemetryKillSwitchReason(env: Readonly<Record<string, string | undefined>>): TelemetryKillSwitchReason | undefined {
	if (env.DO_NOT_TRACK === "1") return "do-not-track";
	if (env.GENTLE_AI_TELEMETRY === "0") return "telemetry-disabled";
	if (env.CI === "true") return "ci";
	return undefined;
}

/**
 * True unless one of Gentle Pi's own kill switches is set
 * (`DO_NOT_TRACK=1`, `GENTLE_AI_TELEMETRY=0`, or `CI=true`). The binary
 * enforces its own opt-out and rate limiting independently; this predicate
 * only decides whether Gentle Pi spawns the trigger at all.
 */
export function shouldTriggerTelemetry(env: Readonly<Record<string, string | undefined>>): boolean {
	return telemetryKillSwitchReason(env) === undefined;
}

// A minimal structural subset of node:child_process's ChildProcess, mirroring
// the ChildLike/Spawn seam already used by lib/agents-runner.ts: narrow
// enough that tests can stub it without touching a real process.
export interface TelemetryTriggerChildLike {
	unref(): unknown;
	kill(signal?: NodeJS.Signals | number): boolean;
	on(event: "error", listener: (error: Error) => void): unknown;
}

export interface TelemetryTriggerSpawnOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	detached: boolean;
	windowsHide: boolean;
	stdio: "ignore";
}

export type TelemetryTriggerSpawn = (
	command: string,
	args: readonly string[],
	options: TelemetryTriggerSpawnOptions,
) => TelemetryTriggerChildLike;

export interface SpawnTelemetryTriggerOptions {
	executable: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	spawn?: TelemetryTriggerSpawn;
}

export type TelemetryTriggerReason = "spawned" | "spawn-error" | TelemetryKillSwitchReason;

export interface TelemetryTriggerResult {
	spawned: boolean;
	reason: TelemetryTriggerReason;
}

/**
 * Nudges `<executable> telemetry trigger --json`, detached and
 * fire-and-forget. Never throws, never awaits the child's exit, and never
 * blocks session start: a missing binary, an old binary without the verb, or
 * a spawn failure all just report `{ spawned: false, ... }`. A 3 s timer
 * kills a runaway child; the timer is unref'd so it can never keep the host
 * process alive on its own, matching the detached child's own `unref()`.
 */
export function spawnTelemetryTrigger(options: SpawnTelemetryTriggerOptions): TelemetryTriggerResult {
	const killSwitch = telemetryKillSwitchReason(options.env);
	if (killSwitch !== undefined) return { spawned: false, reason: killSwitch };
	const spawnImpl = options.spawn ?? (nodeSpawn as unknown as TelemetryTriggerSpawn);
	try {
		const child = spawnImpl(options.executable, ["telemetry", "trigger", "--json"], {
			cwd: options.cwd,
			env: options.env,
			detached: true,
			windowsHide: true,
			stdio: "ignore",
		});
		child.on("error", () => {
			// Fire-and-forget: a spawn-time or runtime child error never surfaces
			// to the caller and never affects session start.
		});
		const killTimer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				// Best effort only; the child may already have exited.
			}
		}, TELEMETRY_TRIGGER_KILL_TIMEOUT_MS);
		killTimer.unref?.();
		child.unref();
		return { spawned: true, reason: "spawned" };
	} catch {
		return { spawned: false, reason: "spawn-error" };
	}
}
