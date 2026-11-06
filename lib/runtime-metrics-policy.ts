import { gentleAiDevBinaryOverrideConfigured, resolveGentleAiBinary } from "./gentle-ai-binary.ts";
import { createNodeExecFileAdapter, type ExecFileAdapter } from "./native-review-cli.ts";

export interface RuntimeMetricsPolicyDeps { resolve?: () => string; exec?: ExecFileAdapter }

export function runtimeMetricsEnvAllows(env: NodeJS.ProcessEnv): boolean {
	// Unknown nonempty spellings veto too: never weaken a native environment veto.
	const truthy = (value: string | undefined) => !["", "0", "false", "no", "off"].includes(value?.trim().toLowerCase() ?? "");
	return !truthy(env.DO_NOT_TRACK) && !truthy(env.CI) && !truthy(env.GITHUB_ACTIONS)
		&& env.GENTLE_AI_TELEMETRY?.trim() !== "0";
}

function publishedBinary(): string {
	// This feature must not select an unpublished development binary or install one.
	if (gentleAiDevBinaryOverrideConfigured()) throw new Error("Policy binary unavailable");
	return resolveGentleAiBinary();
}

/** Only a validated boolean crosses this boundary; never raw stdout or errors.
 * The shared adapter and outer timer bound asynchronous process waiting, NOT
 * end-to-end time: the supported resolver synchronously reads/hashes the binary
 * on every check. It exposes no supported validation cache. Keep verification
 * intact rather than cache an unchecked path or invent stat-based trust.
 * No retries, status/preview fallback, enrollment, installation or polling.
 */
export async function readRuntimeMetricsPolicy(cwd: string,
	{ resolve = publishedBinary, exec = createNodeExecFileAdapter() }: RuntimeMetricsPolicyDeps = {}): Promise<boolean> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const deadline = new Promise<false>(done => {
			timer = setTimeout(() => { controller.abort(); done(false); }, 1000);
		});
		const probe = async () => {
			const result = await exec({ file: resolve(), arguments: ["telemetry", "policy", "--json"],
				cwd, timeoutMs: 1000, maxBufferBytes: 2048, signal: controller.signal });
			if (result.exitCode !== 0 || result.signal !== null || result.timedOut !== false
				|| result.outputLimitExceeded !== false || result.stderr !== ""
				|| typeof result.stdout !== "string" || Buffer.byteLength(result.stdout) > 2048) return false;
			const value: unknown = JSON.parse(result.stdout);
			if (!value || typeof value !== "object" || Array.isArray(value)) return false;
			const row = value as Record<string, unknown>;
			return Object.keys(row).sort().join(",") === "enabled,operation,reason,schema,source"
				&& row.schema === "gentle-ai.telemetry-policy/v1" && row.operation === "policy"
				&& typeof row.enabled === "boolean" && row.enabled && row.reason === "enabled"
				&& ["DO_NOT_TRACK", "GENTLE_AI_TELEMETRY", "CI", "state", "default"].includes(row.source as string);
		};
		return await Promise.race([probe(), deadline]);
	} catch { return false; }
	finally { clearTimeout(timer); }
}
