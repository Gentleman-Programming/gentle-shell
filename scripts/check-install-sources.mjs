#!/usr/bin/env node
// Comprobación del inventario de fuentes de instalación (tarea 3.1 de
// openspec/changes/publicar-paquetes-drakonc, decisión D4).
//
// Recorre `lib/install-sources.ts` y falla cuando:
//   1. una fuente que se instala automáticamente no está fijada (versión exacta
//      de npm, commit SHA de 40 caracteres o checksum), salvo una excepción con
//      motivo documentado;
//   2. una fuente usa un nombre `drakonc-*` que no figura en la sección
//      «Publicados» de `docs/brand-exceptions.md` con propietario verificado y
//      fecha;
//   3. el flag `DRAKONC_PI_PACKAGE_PUBLISHED` de `lib/drakonc-shell-launcher.ts`
//      y esa sección no dicen lo mismo.
//
// Sin dependencias: solo Node y el propio repositorio. Node ≥ 22.19 (el mínimo
// de `engines`) importa TypeScript sin flag, así que el inventario se importa
// tal cual en lugar de duplicar sus valores aquí.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	INSTALL_SOURCES,
	describeProblems,
	inventoryProblems,
	parsePublishedSection,
	publishedFlagProblems,
	readPublishedFlag,
} from "../lib/install-sources.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const DOCS = join(packageRoot, "docs", "brand-exceptions.md");
const LAUNCHER = join(packageRoot, "lib", "drakonc-shell-launcher.ts");

function read(path) {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		return { error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

const docs = read(DOCS);
const launcher = read(LAUNCHER);
const failures = [];
if (typeof docs !== "string") failures.push({ id: "docs", message: docs.error });
if (typeof launcher !== "string") failures.push({ id: "launcher", message: launcher.error });

const parsed = typeof docs === "string" ? parsePublishedSection(docs) : { entries: [], problems: [] };
for (const problem of parsed.problems) failures.push({ id: "Publicados", message: problem });

// Una fuente condicionada a la publicación (`requiresPublication`) solo se exige en
// «Publicados» cuando el flag del launcher ya dice que ese nombre está publicado.
const drakoncPiPublished = typeof launcher === "string" ? readPublishedFlag(launcher) === true : false;
failures.push(...inventoryProblems(INSTALL_SOURCES, parsed.entries, { drakoncPiPublished }));

if (typeof launcher === "string") {
	for (const problem of publishedFlagProblems(launcher, parsed.entries)) failures.push({ id: "D6", message: problem });
}

if (failures.length > 0) {
	console.error(`check-install-sources: ${failures.length} problema(s)`);
	for (const line of describeProblems(failures)) console.error(`  - ${line}`);
	process.exitCode = 1;
} else {
	const exceptions = INSTALL_SOURCES.filter((source) => source.pin === "exception").length;
	const conditional = INSTALL_SOURCES.filter((source) => source.requiresPublication !== undefined && !drakoncPiPublished).length;
	const published = parsed.entries.length === 0 ? "ninguno" : parsed.entries.map((entry) => entry.name).join(", ");
	console.log(
		`check-install-sources: ${INSTALL_SOURCES.length} fuentes fijadas (${exceptions} excepción(es) documentada(s), ${conditional} condicionada(s) a publicación); nombres drakonc-* publicados: ${published}`,
	);
}
