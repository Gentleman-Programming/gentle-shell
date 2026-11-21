// The persona Gentle Shell speaks with ("gentleman" or "neutral"), resolved from
// `persona.json`. One owner for the rule so the /gentle:persona command, the
// system prompt and the desktop feed read the same value.
//
// Resolution order: the project's `<cwd>/.pi/gentle-ai/persona.json`, then the
// global one in the Gentle Pi config home, then "gentleman". A file that is
// missing, unreadable or not a JSON object is skipped; a readable object whose
// `mode` is anything but "neutral" means "gentleman".

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

export type PersonaMode = "gentleman" | "neutral";

export function projectPersonaConfigPath(cwd: string): string {
	return join(cwd, ".pi", "gentle-ai", "persona.json");
}

export function personaConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(gentlePiConfigHome(env), "persona.json");
}

export function readPersonaFile(path: string): PersonaMode | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		return (parsed as Record<string, unknown>).mode === "neutral" ? "neutral" : "gentleman";
	} catch {
		return undefined;
	}
}

export function readPersonaMode(cwd: string, env: NodeJS.ProcessEnv = process.env): PersonaMode {
	return readPersonaFile(projectPersonaConfigPath(cwd)) ?? readPersonaFile(personaConfigPath(env)) ?? "gentleman";
}
