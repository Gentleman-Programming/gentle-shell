import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gentlePiConfigHome } from "../lib/agent-home.ts";
import {
	CONFIG_CATEGORIES,
	CONFIG_CATEGORY_FILES,
	ENV_CONFIG_HOME_ENV,
	ENV_OWN_CONFIG_ENV,
	INSTALL_CONFIG_FILES,
	ownConfigCategories,
} from "../lib/gentle-config-scope.ts";

// --- categories ---------------------------------------------------------------

test("every Gentle config file belongs to exactly one category or is install-level", () => {
	assert.deepEqual([...CONFIG_CATEGORIES], ["models", "persona", "appearance", "behavior"]);
	const seen = new Map<string, string>();
	for (const category of CONFIG_CATEGORIES) {
		for (const file of CONFIG_CATEGORY_FILES[category]) {
			assert.ok(!seen.has(file), `${file} is in ${seen.get(file)} and ${category}`);
			seen.set(file, category);
		}
	}
	for (const file of INSTALL_CONFIG_FILES) assert.ok(!seen.has(file), `${file} is install-level`);
	for (const file of ["models.json", "profiles.json"]) assert.equal(seen.get(file), "models", "a profile is a snapshot of the routing");
	assert.equal(seen.get("persona.json"), "persona");
	assert.equal(seen.get("card-style.json"), "appearance");
	assert.equal(seen.get("permission-mode.json"), "behavior");
});

test("ownConfigCategories trusts only an absolute env config home and known categories", () => {
	const home = join("/", "e", "work", "gentle-ai");
	assert.deepEqual([...ownConfigCategories({ [ENV_CONFIG_HOME_ENV]: home, [ENV_OWN_CONFIG_ENV]: "persona,appearance,bogus" })], ["persona", "appearance"]);
	assert.deepEqual([...ownConfigCategories({ [ENV_OWN_CONFIG_ENV]: "persona" })], [], "no env config home, nothing is own");
	assert.deepEqual([...ownConfigCategories({ [ENV_CONFIG_HOME_ENV]: "relative/dir", [ENV_OWN_CONFIG_ENV]: "persona" })], []);
	assert.deepEqual([...ownConfigCategories({ [ENV_CONFIG_HOME_ENV]: home })], [], "no list, nothing is own");
});

// --- resolution -----------------------------------------------------------------

test("an own category resolves to the env config home; shared ones keep the existing chain", () => {
	const envHome = join("/", "e", "work", "gentle-ai");
	const env = { GENTLE_PI_CONFIG_HOME: "/shared/gentle-ai", [ENV_CONFIG_HOME_ENV]: envHome, [ENV_OWN_CONFIG_ENV]: "persona,behavior" };
	assert.equal(gentlePiConfigHome(env, "persona"), envHome);
	assert.equal(gentlePiConfigHome(env, "behavior"), envHome);
	assert.equal(gentlePiConfigHome(env, "models"), "/shared/gentle-ai");
	assert.equal(gentlePiConfigHome(env, "appearance"), "/shared/gentle-ai");
	assert.equal(gentlePiConfigHome(env), "/shared/gentle-ai", "install-level reads never move");
});

test("without env scope variables every category resolves exactly as before", () => {
	for (const category of CONFIG_CATEGORIES) {
		assert.equal(gentlePiConfigHome({ GENTLE_PI_CONFIG_HOME: "/custom" }, category), "/custom");
		assert.equal(gentlePiConfigHome({}, category), join(homedir(), ".pi", "gentle-ai"));
	}
});

// --- drift guard ---------------------------------------------------------------

// Install-level reads that must ignore env scope: the dev binary registration,
// integrity and the update channel belong to the install, never to an env.
// Session scratch ledgers are runtime state, not configuration, so they stay
// in the shared config home whatever categories an env owns.
const INSTALL_LEVEL_CALLS = new Set<string>(["extensions/session-scratch.ts:93"]);

test("every config-home read names its category (drift guard)", () => {
	const root = new URL("..", import.meta.url);
	const offenders: string[] = [];
	// Recursive: config-home reads also live in subfolders such as extensions/history.
	for (const top of ["lib", "extensions"]) {
		for (const entry of readdirSync(new URL(`${top}/`, root), { recursive: true }) as string[]) {
			const rel = entry.split("\\").join("/");
			if (!rel.endsWith(".ts")) continue;
			const slash = rel.lastIndexOf("/");
			const dir = slash < 0 ? top : `${top}/${rel.slice(0, slash)}`;
			const name = slash < 0 ? rel : rel.slice(slash + 1);
			const source = readFileSync(new URL(`${dir}/${name}`, root), "utf8");
			source.split("\n").forEach((line, index) => {
				if (/export function gentlePiConfigHome/.test(line)) return;
				if (/function gentleAiConfigHome\(category/.test(line)) return;
				// A hand-written copy of the chain bypasses the category entirely.
				if (/bundledGentlePiConfigHome\([^)]*\)\s*\?\?\s*[\w.]*GENTLE_PI_CONFIG_HOME/.test(line) && !/^(gentle-ai-binary|agent-home)\.ts$/.test(name)) {
					offenders.push(`${dir}/${name}:${index + 1}: hand-written config chain`);
				}
				for (const match of line.matchAll(/(?<![\w.])(gentlePiConfigHome|gentleAiConfigHome)\(([^()]*)\)/g)) {
					const args = match[2].trim();
					const hasCategory = /"(models|persona|appearance|behavior)"|category/.test(args);
					const key = `${dir}/${name}:${index + 1}`;
					if (!hasCategory && !INSTALL_LEVEL_CALLS.has(key)) offenders.push(`${key}: ${match[0]}`);
				}
			});
		}
	}
	assert.deepEqual(offenders, []);
});

test("a shared category follows the config home rule, an own one the env config home", async () => {
	const { GENTLE_SHELL_CONFIG_HOME_ENV } = await import("../lib/agent-home.ts");
	const envHome = join("/", "e", "work", "gentle-ai");
	const launcherHome = join("/", "s", ".gentle-shell", "gentle-ai");
	const scoped = { [ENV_CONFIG_HOME_ENV]: envHome, [ENV_OWN_CONFIG_ENV]: "appearance", [GENTLE_SHELL_CONFIG_HOME_ENV]: launcherHome };
	assert.equal(gentlePiConfigHome(scoped, "appearance"), envHome);
	assert.equal(gentlePiConfigHome(scoped, "models"), launcherHome);
	assert.equal(gentlePiConfigHome({ ...scoped, GENTLE_PI_CONFIG_HOME: "" }, "models"), launcherHome, "an empty override falls through");
	assert.equal(gentlePiConfigHome({ [ENV_CONFIG_HOME_ENV]: envHome, [ENV_OWN_CONFIG_ENV]: "appearance" }, "models"), join(homedir(), ".pi", "gentle-ai"));
});
