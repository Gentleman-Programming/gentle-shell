import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Without GENTLE_PI_CONFIG_HOME an extension reads ~/.pi/gentle-ai, so a
// developer's saved preferences (keymaps.json among them) would leak into
// tests. isolatedConfigEnv gives each call a fresh empty config home unless
// the test owns one; removeIsolatedConfigHomes deletes them after the file.
const homes: string[] = [];

export function isolatedConfigEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	if (env.GENTLE_PI_CONFIG_HOME !== undefined) return env;
	const home = mkdtempSync(join(tmpdir(), "gentle-config-"));
	homes.push(home);
	return { ...env, GENTLE_PI_CONFIG_HOME: home };
}

/** A fresh config home whose keymaps.json holds `bindings`. */
export function keymapsConfigHome(bindings: Record<string, string | null>): string {
	const home = mkdtempSync(join(tmpdir(), "gentle-keymaps-"));
	homes.push(home);
	writeFileSync(join(home, "keymaps.json"), JSON.stringify({ schema: 1, bindings }));
	return home;
}

export function removeIsolatedConfigHomes(): void {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
}
