import { homedir } from "node:os";
import { join } from "node:path";
import { bundledGentlePiConfigHome, runningBundledPrefix } from "./gentle-shell-bundled.ts";

// Pi Subagents resolves its global directory as `PI_CODING_AGENT_DIR || ~/.pi/agent`,
// so an empty value must fall through here too or the two homes diverge again.
export function resolveGentlePiAgentHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.GENTLE_PI_AGENT_HOME || env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

// The Gentle AI config directory outside `~/.pi/agent`: everything the extension
// commands own lives here. It is defined once because the launch-time profile pin
// resolver reads the same profiles store the `/gentle:profiles` panel writes, and
// two spellings of the override would silently read two different stores.
// A bundled Gentle Shell keeps it inside its prefix (S9, bundledGentlePiConfigHome).
export function gentlePiConfigHome(env: NodeJS.ProcessEnv = process.env): string {
	return bundledGentlePiConfigHome(env) ?? (env.GENTLE_PI_CONFIG_HOME || join(homedir(), ".pi", "gentle-ai"));
}

// The agent home Pi runs with, only in a bundled Gentle Shell (S9): there the
// extensions that otherwise write under ~/.pi/agent keep their files in it.
// Undefined elsewhere, where they keep their existing locations.
export function bundledGentlePiAgentHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return runningBundledPrefix(env) === undefined ? undefined : resolveGentlePiAgentHome(env);
}
