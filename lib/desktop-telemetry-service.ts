// Gentle Desktop telemetry-consent bridge: answers `get_telemetry` and
// `set_telemetry` by running `gentle-ai telemetry ...` and projecting the
// result with `lib/desktop-rpc-telemetry.ts`.
//
// Constraints (Gentleman-Programming/gentle-shell#3586):
// - Reads use `telemetry policy --json` only, never `status` (it creates the
//   state file as a side effect).
// - `set_telemetry` runs `enable`/`disable --json`, discards that output (it
//   carries `install_id` and `endpoint`), then re-reads the policy.
// - The first-run notice and `notice_shown` stay owned by gentle-ai: nothing
//   here marks the notice as shown.
// - Real failures are typed errors; a policy is never fabricated.

import type { DesktopRpcOutcome } from "./desktop-rpc.ts";
import {
	decodeTelemetryPolicy,
	parseGetTelemetryParams,
	parseSetTelemetryParams,
	TELEMETRY_BINARY_MISSING,
	TELEMETRY_COMMAND_FAILED,
	TELEMETRY_OUTPUT_INVALID,
	TELEMETRY_POLICY_UNSUPPORTED,
	TELEMETRY_RPC_TIMEOUT_MS,
	TELEMETRY_TIMEOUT,
} from "./desktop-rpc-telemetry.ts";
import { resolveGentleAiBinary } from "./gentle-ai-binary.ts";
import { createNodeExecFileAdapter, type ExecFileAdapter, type ExecFileResult } from "./native-review-cli.ts";

type Failure = { code: string; message: string };
type Step = { ok: true; stdout: string } | { ok: false; error: Failure };

const MAX_BUFFER_BYTES = 1024 * 1024;
/** What an older gentle-ai prints for a verb it does not have. */
const UNKNOWN_SUBCOMMAND = /unknown telemetry (sub)?command/i;

export interface DesktopTelemetryBridgeOptions {
	/** Test seam; production resolves the pinned gentle-ai binary. */
	resolveBinary?: () => string;
	/** Test seam; production runs the real process. */
	exec?: ExecFileAdapter;
	cwd?: () => string;
}

export class DesktopTelemetryBridge {
	private readonly resolveBinary: () => string;
	private readonly exec: ExecFileAdapter;
	private readonly cwd: () => string;

	constructor(options: DesktopTelemetryBridgeOptions = {}) {
		this.resolveBinary = options.resolveBinary ?? resolveGentleAiBinary;
		this.exec = options.exec ?? createNodeExecFileAdapter();
		this.cwd = options.cwd ?? (() => process.cwd());
	}

	async handle(method: string, params: Record<string, unknown>): Promise<DesktopRpcOutcome | undefined> {
		if (method === "get_telemetry") {
			const invalid = parseGetTelemetryParams(params);
			if (invalid) return { ok: false, error: invalid.error };
			return this.readPolicy();
		}
		if (method === "set_telemetry") {
			// Parse first: a malformed request never runs gentle-ai.
			const request = parseSetTelemetryParams(params);
			if ("error" in request) return { ok: false, error: request.error };
			const written = await this.run([request.enabled ? "enable" : "disable", "--json"]);
			// The output carries install_id and endpoint: only success matters.
			if (written.ok === false) return { ok: false, error: written.error };
			return this.readPolicy();
		}
		return undefined;
	}

	private async readPolicy(): Promise<DesktopRpcOutcome> {
		const read = await this.run(["policy", "--json"]);
		if (read.ok === false) return { ok: false, error: read.error };
		const policy = decodeTelemetryPolicy(read.stdout);
		if (policy === undefined) return { ok: false, error: TELEMETRY_OUTPUT_INVALID };
		return { ok: true, data: policy };
	}

	private async run(args: readonly string[]): Promise<Step> {
		let file: string;
		try {
			file = this.resolveBinary();
		} catch {
			return { ok: false, error: TELEMETRY_BINARY_MISSING };
		}
		let result: ExecFileResult;
		try {
			result = await this.exec({
				file,
				arguments: ["telemetry", ...args],
				cwd: this.cwd(),
				timeoutMs: TELEMETRY_RPC_TIMEOUT_MS,
				maxBufferBytes: MAX_BUFFER_BYTES,
			});
		} catch (error) {
			const code = (error as { code?: unknown } | null)?.code;
			return { ok: false, error: code === "ENOENT" ? TELEMETRY_BINARY_MISSING : TELEMETRY_COMMAND_FAILED };
		}
		if (result.timedOut) return { ok: false, error: TELEMETRY_TIMEOUT };
		if (result.outputLimitExceeded) return { ok: false, error: TELEMETRY_OUTPUT_INVALID };
		if (result.exitCode !== 0) {
			if (args[0] === "policy" && UNKNOWN_SUBCOMMAND.test(`${result.stderr}\n${result.stdout}`)) return { ok: false, error: TELEMETRY_POLICY_UNSUPPORTED };
			return { ok: false, error: TELEMETRY_COMMAND_FAILED };
		}
		return { ok: true, stdout: result.stdout };
	}
}
