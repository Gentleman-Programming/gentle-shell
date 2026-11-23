import { homedir } from "node:os";
import { join } from "node:path";
import { resolveDrakoncPiConfigHome, runningBundledPrefix } from "./drakonc-shell-bundled.ts";

export { DRAKONC_SHELL_CONFIG_HOME_ENV } from "./drakonc-shell-bundled.ts";

// Pi Subagents resolves its global directory as `PI_CODING_AGENT_DIR || ~/.pi/agent`,
// so an empty value must fall through here too or the two homes diverge again.
export function resolveDrakoncPiAgentHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.DRAKONC_PI_AGENT_HOME || env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

// The Drakonc AI config directory outside `~/.pi/agent`: everything the extension
// commands own lives here. It is defined once because the launch-time profile pin
// resolver reads the same profiles store the `/drakonc:profiles` panel writes, and
// two spellings of the override would silently read two different stores.
// A bundled Drakonc Shell keeps it inside its prefix (S9, bundledDrakoncPiConfigHome),
// the standalone launcher's isolated home next to its agent dir (#2201). The rule
// itself lives in resolveDrakoncPiConfigHome, a generated runtime module, so the
// launcher and the Drakonc AI process environment share it too.
export function drakoncPiConfigHome(env: NodeJS.ProcessEnv = process.env): string {
	return resolveDrakoncPiConfigHome(env, homedir());
}

// The agent home Pi runs with, only in a bundled Drakonc Shell (S9): there the
// extensions that otherwise write under ~/.pi/agent keep their files in it.
// Undefined elsewhere, where they keep their existing locations.
export function bundledDrakoncPiAgentHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return runningBundledPrefix(env) === undefined ? undefined : resolveDrakoncPiAgentHome(env);
}
