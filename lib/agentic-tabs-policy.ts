import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";
import type { AgenticTab } from "./shell-sidebar.ts";

/**
 * Pestañas del centro agéntico, en el orden fijo de la fila numerada
 * (`1:MAIN 2:GIT 3:PROF 4:MEM 5:TREE 0:WT`). MAIN siempre queda disponible.
 */
export const AGENTIC_TABS: readonly AgenticTab[] = ["main", "git", "prof", "mem", "tree", "wt"];
export const AGENTIC_TABS_SCHEMA = "gentle-pi.agentic-tabs/v1";
const FILE = "agentic-tabs.json";

/**
 * Nombres de la fila anterior (`inicio`, `perfil`, `memoria`, `stats`) y los
 * IDs nuevos escritos a mano. Se aceptan al leer y al invocar `/gentle:tab`,
 * y se canonizan al persistir: un archivo viejo sigue siendo válido y no se
 * marca malformado (`stats` se fusionó con `main` en la consola).
 */
/** Nombres de la fila anterior: un archivo que los usa es anterior a la consola. */
const LEGACY_TAB_NAMES: ReadonlySet<string> = new Set(["inicio", "perfil", "memoria", "stats"]);
const TAB_ALIASES: Readonly<Record<string, AgenticTab>> = {
	inicio: "main",
	main: "main",
	git: "git",
	perfil: "prof",
	prof: "prof",
	memoria: "mem",
	mem: "mem",
	stats: "main",
	tree: "tree",
	wt: "wt",
};

/** Canoniza un nombre de pestaña (nuevo o legado); undefined si no existe. */
export function normalizeAgenticTab(value: unknown): AgenticTab | undefined {
	return typeof value === "string" ? TAB_ALIASES[value.trim().toLowerCase()] : undefined;
}

type Options = { gentlePiConfigHome?: string };
export type TabPreference = { tabs: AgenticTab[]; path: string; malformed: boolean };

/** Acepta únicamente el esquema conocido y no pierde valores desconocidos. */
export function parseAgenticTabs(raw: string): AgenticTab[] | undefined {
	try {
		const obj: unknown = JSON.parse(raw);
		if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
		const value = obj as Record<string, unknown>;
		if (Object.keys(value).length !== 2 || value.schema !== AGENTIC_TABS_SCHEMA || !Array.isArray(value.tabs)) return undefined;
		const listed: unknown[] = value.tabs;
		if (listed.some((entry) => typeof entry !== "string")) return undefined;
		// Un nombre repetido no es una preferencia válida; dos nombres distintos
		// que apuntan a la misma pestaña (p. ej. `inicio` + `stats`) sí lo son y
		// colapsan al canonizar.
		const names = listed.map((entry) => (entry as string).trim().toLowerCase());
		if (new Set(names).size !== names.length) return undefined;
		const tabs: AgenticTab[] = [];
		for (const name of names) {
			const tab = normalizeAgenticTab(name);
			if (!tab) return undefined;
			if (!tabs.includes(tab)) tabs.push(tab);
		}
		// MAIN es siempre visible (S14): un archivo sin ella no es una preferencia válida.
		if (!tabs.includes("main")) return undefined;
		// Un archivo legado no puede expresar "ocultar TREE/WT" porque esas
		// pestañas no existían: se suman para que la consola nueva aparezca
		// completa la primera vez. La elección se persiste al usarla.
		if (names.some((name) => LEGACY_TAB_NAMES.has(name))) {
			for (const tab of ["tree", "wt"] as const) if (!tabs.includes(tab)) tabs.push(tab);
		}
		return AGENTIC_TABS.filter((tab) => tabs.includes(tab));
	} catch { return undefined; }
}

export function resolveAgenticTabs(options: Options = {}): TabPreference {
	const path = join(options.gentlePiConfigHome ?? gentlePiConfigHome(), FILE);
	try {
		const tabs = parseAgenticTabs(readFileSync(path, "utf8"));
		return { tabs: tabs ?? [...AGENTIC_TABS], path, malformed: tabs === undefined };
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return { tabs: [...AGENTIC_TABS], path, malformed: !missing };
	}
}

/** Escribe de forma atómica; nunca sobreescribe una preferencia ilegible. */
export function writeAgenticTabs(tabs: readonly AgenticTab[], options: Options = {}): string {
	const raw = JSON.stringify({ schema: AGENTIC_TABS_SCHEMA, tabs });
	const canonical = parseAgenticTabs(raw);
	if (!canonical) throw new TypeError("Lista de pestañas inválida");
	const home = options.gentlePiConfigHome ?? gentlePiConfigHome();
	const current = resolveAgenticTabs({ gentlePiConfigHome: home });
	if (current.malformed) throw new Error(`No se modifica la preferencia inválida o ilegible: ${current.path}`);
	const temporary = `${current.path}.${randomUUID()}.tmp`;
	mkdirSync(home, { recursive: true });
	try {
		writeFileSync(temporary, `${JSON.stringify({ schema: AGENTIC_TABS_SCHEMA, tabs: canonical })}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, current.path);
	} finally {
		try { unlinkSync(temporary); } catch { /* rename consumió el archivo temporal */ }
	}
	return current.path;
}
