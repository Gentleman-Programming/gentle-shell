// A delegated subagent runs as a `pi --mode rpc` child that the runner marks with
// GENTLE_PI_AGENTS_CHILD=1 (lib/agents-runner.ts). It reports hasUI=true but has
// no terminal, so UI-only entrypoints use this to register nothing (gentle-shell#3386).
export function isChildSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.GENTLE_PI_AGENTS_CHILD === "1";
}
