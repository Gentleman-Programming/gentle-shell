// The persona switch (`/gentle:persona`): one global file in the Gentle config
// home and an optional project override at `.pi/gentle-ai/persona.json`. This
// module is the single owner of reading and writing both; `extensions/gentle-ai.ts`
// and the Desktop `persona` config store use it.
//
// Reading stays as tolerant as it always was: a file that parses as an object
// is a usable layer, and any `mode` other than `"neutral"` means `gentleman`.
// Writing keeps the command's semantics (the global file, plus the project file
// when it already exists) and replaces each file atomically.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type PersonaMode = "gentleman" | "neutral";
export const PERSONA_MODES: readonly PersonaMode[] = ["gentleman", "neutral"];
export const DEFAULT_PERSONA_MODE: PersonaMode = "gentleman";

export type PersonaLayerRead = { status: "missing" } | { status: "invalid" } | { status: "valid"; mode: PersonaMode };

export function projectPersonaPath(cwd: string): string {
	return join(cwd, ".pi", "gentle-ai", "persona.json");
}

export function globalPersonaPath(configHome: string): string {
	return join(configHome, "persona.json");
}

export function isPersonaMode(value: unknown): value is PersonaMode {
	return value === "gentleman" || value === "neutral";
}

/** One layer, as the resolver sees it: absent, unusable, or a mode. */
export function readPersonaLayer(path: string): PersonaLayerRead {
	if (!existsSync(path)) return { status: "missing" };
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { status: "invalid" };
		return { status: "valid", mode: (parsed as { mode?: unknown }).mode === "neutral" ? "neutral" : "gentleman" };
	} catch {
		return { status: "invalid" };
	}
}

/** The persona in effect: the project file wins over the global one; `gentleman` by default. */
export function resolvePersonaMode(cwd: string, configHome: string): PersonaMode {
	for (const path of [projectPersonaPath(cwd), globalPersonaPath(configHome)]) {
		const layer = readPersonaLayer(path);
		if (layer.status === "valid") return layer.mode;
	}
	return DEFAULT_PERSONA_MODE;
}

function writeAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, content);
		renameSync(temporary, path);
	} catch (error) {
		try { unlinkSync(temporary); } catch { /* the temporary file may not exist */ }
		throw error;
	}
}

/**
 * Write `mode` to the global file, and to the project file when it already
 * exists, so a project override never silently outranks the change. Returns
 * the files written, global first.
 */
export function writePersonaMode(cwd: string, configHome: string, mode: PersonaMode): string[] {
	const paths = [globalPersonaPath(configHome)];
	const project = projectPersonaPath(cwd);
	if (existsSync(project)) paths.push(project);
	for (const path of paths) writeAtomic(path, `${JSON.stringify({ mode }, null, 2)}\n`);
	return paths;
}
