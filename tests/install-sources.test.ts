import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	describeProblems,
	INSTALL_SOURCES,
	type InstallSource,
	inventoryProblems,
	npmSourceVersion,
	parsePublishedSection,
	type PublishedEntry,
	publishedFlagProblems,
	readPublishedFlag,
	SHELL_PACKAGE_REGISTRY_VERSION,
	sourcePackageNames,
} from "../lib/install-sources.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path: string): string => readFileSync(join(packageRoot, path), "utf8");

function source(overrides: Partial<InstallSource> & Pick<InstallSource, "source" | "pin">): InstallSource {
	return { id: "prueba", ...overrides } as InstallSource;
}

// --- inventario real ---------------------------------------------------------

test("el inventario actual pasa la comprobación sin ningún nombre publicado", () => {
	assert.deepEqual(inventoryProblems(), []);
});

test("el inventario cubre las fuentes que se instalan automáticamente", () => {
	const ids = INSTALL_SOURCES.map((entry) => entry.id);
	for (const id of [
		"engram-companion-pi",
		"shell-pi-companion-install",
		"shell-pi-registry",
		"engram-binary",
		"node-runtime",
		"pnpm-cli",
		"uv-tool",
		"go-toolchain",
		"music-player-git",
		"music-player-archive",
		"companion-binary-release",
		"companion-binary-mirror",
	]) {
		assert.ok(ids.includes(id), `falta la fuente ${id}`);
	}
	assert.equal(new Set(ids).size, ids.length);
});

test("mientras drakonc-pi no esté publicado, ninguna fuente lo instala", () => {
	const docs = parsePublishedSection(read("docs/brand-exceptions.md"));
	assert.equal(docs.problems.length, 0);
	assert.deepEqual(docs.entries, []);
	for (const entry of INSTALL_SOURCES) {
		if (entry.requiresPublication !== undefined) continue;
		assert.ok(!entry.source.includes("drakonc-pi"), `la fuente ${entry.id} instala drakonc-pi sin publicar`);
	}
});

// La única fuente que nombra `drakonc-pi` es la del instalador estándar, y está
// condicionada a la publicación: hoy el instalador se detiene antes de pedirla.
test("la fuente condicionada a publicación es la del instalador y exige la entrada cuando el flag está activo", () => {
	const conditional = INSTALL_SOURCES.filter((entry) => entry.requiresPublication !== undefined);
	assert.deepEqual(conditional.map((entry) => entry.id), ["shell-pi-registry"]);
	const [shell] = conditional;
	assert.equal(shell.requiresPublication, "drakonc-pi");
	assert.equal(shell.pin, "npm-exact");
	assert.deepEqual(inventoryProblems([shell], []), [], "hoy no se exige: el instalador se detiene");
	const problems = inventoryProblems([shell], [], { drakoncPiPublished: true });
	assert.equal(problems.length, 1);
	assert.match(problems[0].message, /drakonc-pi.*no figura en la sección «Publicados»/);
	assert.deepEqual(inventoryProblems([shell], [publishedDrakoncPi], { drakoncPiPublished: true }), []);
});

test("la fuente del instalador fija la misma versión que package.json", () => {
	const manifest = JSON.parse(read("package.json")) as { name: string; version: string };
	const shell = INSTALL_SOURCES.find((entry) => entry.id === "shell-pi-registry");
	assert.ok(shell);
	assert.equal(manifest.name, "drakonc-pi");
	assert.equal(npmSourceVersion(shell.source), manifest.version);
	assert.equal(SHELL_PACKAGE_REGISTRY_VERSION, manifest.version);
});

test("npmSourceVersion devuelve la versión exacta y undefined cuando la fuente flota", () => {
	assert.equal(npmSourceVersion("npm:gentle-engram@0.8.0"), "0.8.0");
	assert.equal(npmSourceVersion("npm:@scope/pkg@1.2.3"), "1.2.3");
	assert.equal(npmSourceVersion("npm:gentle-pi"), undefined);
});

test("sourcePackageNames reconoce las tres formas de fuente", () => {
	assert.deepEqual(sourcePackageNames("npm:gentle-engram@0.8.0"), ["gentle-engram"]);
	assert.deepEqual(sourcePackageNames("gentle-stream[samples] @ git+https://github.com/Owner/gentle-stream@381290451544ad2ca3348a68a81b3056bdac73b7"), [
		"gentle-stream",
	]);
	assert.deepEqual(sourcePackageNames("https://github.com/Gentleman-Programming/engram/releases/download/v3.7.2/engram_3.7.2_linux_amd64.tar.gz"), [
		"engram",
	]);
	assert.deepEqual(sourcePackageNames("https://github.com/Gentleman-Programming/gentle-stream/archive/381290451544ad2ca3348a68a81b3056bdac73b7.tar.gz"), [
		"gentle-stream",
	]);
});

// --- pinchado ----------------------------------------------------------------

test("una fuente npm sin versión falla", () => {
	const unpinned = inventoryProblems([source({ source: "npm:gentle-pi", pin: "npm-exact" })]);
	assert.equal(unpinned.length, 1);
	assert.match(unpinned[0].message, /no fija una versión exacta/);
});

test("una fuente npm sin versión exacta falla", () => {
	const ranged = source({ source: "npm:gentle-engram@^0.8.0", pin: "npm-exact" });
	const problems = inventoryProblems([ranged]);
	assert.equal(problems.length, 1);
	assert.match(problems[0].message, /no fija una versión exacta/);

	const bare = source({ source: "npm:gentle-engram", pin: "npm-exact" });
	assert.match(inventoryProblems([bare])[0].message, /no fija una versión exacta/);

	const notNpm = source({ source: "git:https://github.com/Owner/repo", pin: "npm-exact" });
	assert.match(inventoryProblems([notNpm])[0].message, /no es una fuente npm/);
});

test("una fuente git con SHA corto falla y con SHA de 40 caracteres pasa", () => {
	const short = source({ source: "gentle-stream @ git+https://github.com/Owner/gentle-stream@381290451544", pin: "git-sha" });
	assert.match(inventoryProblems([short])[0].message, /SHA de 40 caracteres/);

	const full = source({ source: "gentle-stream @ git+https://github.com/Owner/gentle-stream@381290451544ad2ca3348a68a81b3056bdac73b7", pin: "git-sha" });
	assert.deepEqual(inventoryProblems([full]), []);
});

test("una descarga sin checksum o con un checksum mal formado falla", () => {
	assert.match(inventoryProblems([source({ source: "https://example.test/a.tar.gz", pin: "sha256" })])[0].message, /no fija ningún checksum/);
	const malformed = source({ source: "https://example.test/a.tar.gz", pin: "sha256", checksums: ["sha256-corto"] });
	assert.match(inventoryProblems([malformed])[0].message, /checksums mal formados/);
	const ok = source({ source: "https://example.test/a.tar.gz", pin: "sha256", checksums: [`sha256-${"a".repeat(64)}`] });
	assert.deepEqual(inventoryProblems([ok]), []);
});

test("una excepción sin motivo documentado falla", () => {
	const bare = source({ source: "npm:gentle-pi", pin: "exception" });
	assert.match(inventoryProblems([bare])[0].message, /excepción sin motivo/);
	const documented = source({ source: "npm:gentle-pi", pin: "exception", notes: "El companion lo instala sin versión y no acepta una." });
	assert.deepEqual(inventoryProblems([documented]), []);
});

test("un identificador repetido falla", () => {
	const repeated = source({ id: "repetida", source: "npm:gentle-engram@0.8.0", pin: "npm-exact" });
	const problems = inventoryProblems([repeated, repeated]);
	assert.match(problems[0].message, /identificador repetido/);
});

// --- nombres propios solo si están publicados --------------------------------

const publishedDrakoncPi: PublishedEntry = { name: "drakonc-pi", owner: "npm view drakonc-pi maintainers → alan_buscaglia", date: "2026-12-01" };

test("una fuente con nombre drakonc-* sin publicar falla", () => {
	const unpublished = source({ source: "npm:drakonc-engram@0.1.0", pin: "npm-exact" });
	const problems = inventoryProblems([unpublished]);
	assert.equal(problems.length, 1);
	assert.match(problems[0].message, /no figura en la sección «Publicados»/);
});

test("una fuente con nombre drakonc-* publicado pasa", () => {
	const published = source({ source: "npm:drakonc-pi@0.1.0", pin: "npm-exact", publishedName: "drakonc-pi" });
	assert.deepEqual(inventoryProblems([published], [publishedDrakoncPi]), []);
});

test("publishedName también se comprueba: un alias drakonc-* sin publicar falla", () => {
	const aliased = source({ source: "npm:gentle-engram@0.8.0", pin: "npm-exact", publishedName: "drakonc-engram" });
	assert.match(inventoryProblems([aliased])[0].message, /no figura en la sección «Publicados»/);
	assert.deepEqual(inventoryProblems([aliased], [{ name: "drakonc-engram", owner: "npm view", date: "2026-12-01" }]), []);
});

// --- docs/brand-exceptions.md: sección «Publicados» --------------------------

test("la sección «Publicados» real existe y hoy está vacía sin problemas", () => {
	const parsed = parsePublishedSection(read("docs/brand-exceptions.md"));
	assert.deepEqual(parsed.problems, []);
	assert.deepEqual(parsed.entries, []);
});

test("una sección «Publicados» ausente es un problema", () => {
	const parsed = parsePublishedSection("# Excepciones\n\n## Otra sección\n");
	assert.deepEqual(parsed.entries, []);
	assert.match(parsed.problems[0], /falta la sección/);
});

test("la plantilla en bloque de código no cuenta como entrada publicada", () => {
	const parsed = parsePublishedSection(
		["## Publicados", "", "```md", "- **`drakonc-ejemplo`**", "  - Propietario: nada", "  - Fecha: 2026-01-01", "```", ""].join("\n"),
	);
	assert.deepEqual(parsed.entries, []);
	assert.deepEqual(parsed.problems, []);
});

test("una entrada publicada con propietario y fecha se lee", () => {
	const parsed = parsePublishedSection(
		["## Publicados", "", "- **`drakonc-pi`** — paquete npm.", "  - Propietario: `npm view drakonc-pi` → alan_buscaglia", "  - Fecha: 2026-12-01", "", "## Otra"].join("\n"),
	);
	assert.deepEqual(parsed.problems, []);
	assert.deepEqual(parsed.entries, [{ name: "drakonc-pi", owner: "`npm view drakonc-pi` → alan_buscaglia", date: "2026-12-01" }]);
});

test("una entrada publicada sin propietario o sin fecha es un problema", () => {
	const withoutOwner = parsePublishedSection(["## Publicados", "- **`drakonc-pi`**", "  - Fecha: 2026-12-01"].join("\n"));
	assert.match(withoutOwner.problems[0], /no registra «Propietario:»/);
	assert.deepEqual(withoutOwner.entries, []);

	const withoutDate = parsePublishedSection(["## Publicados", "- **`drakonc-pi`**", "  - Propietario: npm view drakonc-pi"].join("\n"));
	assert.match(withoutDate.problems[0], /no registra «Fecha: AAAA-MM-DD»/);

	const badDate = parsePublishedSection(["## Publicados", "- **`drakonc-pi`**", "  - Propietario: npm view", "  - Fecha: 2026-12"].join("\n"));
	assert.match(badDate.problems[0], /no registra «Fecha: AAAA-MM-DD»/);
});

test("una entrada publicada que falta en la sección se detecta como fuente sin publicar", () => {
	const parsed = parsePublishedSection(["## Publicados", "- **`drakonc-pi`**", "  - Propietario: npm view drakonc-pi", "  - Fecha: 2026-12-01"].join("\n"));
	assert.deepEqual(parsed.problems, []);
	const problems = inventoryProblems([source({ source: "npm:drakonc-engram@0.1.0", pin: "npm-exact" })], parsed.entries);
	assert.match(problems[0].message, /drakonc-engram/);
});

// --- flag del launcher y sección «Publicados» --------------------------------

test("el flag DRAKONC_PI_PACKAGE_PUBLISHED coincide con la sección «Publicados» real", () => {
	const parsed = parsePublishedSection(read("docs/brand-exceptions.md"));
	assert.deepEqual(publishedFlagProblems(read("lib/drakonc-shell-launcher.ts"), parsed.entries), []);
});

test("un flag que no coincide con la sección es un problema, en los dos sentidos", () => {
	const launcherTrue = "export const DRAKONC_PI_PACKAGE_PUBLISHED = true;";
	assert.match(publishedFlagProblems(launcherTrue, [])[0], /no figura en «Publicados»/);
	const launcherFalse = "export const DRAKONC_PI_PACKAGE_PUBLISHED = false;";
	assert.match(publishedFlagProblems(launcherFalse, [publishedDrakoncPi])[0], /sigue en false/);
	assert.deepEqual(publishedFlagProblems(launcherTrue, [publishedDrakoncPi]), []);
});

test("un launcher sin el flag es un problema", () => {
	assert.match(publishedFlagProblems("// nada", [])[0], /no declara DRAKONC_PI_PACKAGE_PUBLISHED/);
});

test("readPublishedFlag lee el flag y devuelve undefined cuando falta", () => {
	assert.equal(readPublishedFlag("export const DRAKONC_PI_PACKAGE_PUBLISHED = false;"), false);
	assert.equal(readPublishedFlag("export const DRAKONC_PI_PACKAGE_PUBLISHED = true;"), true);
	assert.equal(readPublishedFlag("// nada"), undefined);
	assert.equal(readPublishedFlag(read("lib/drakonc-shell-launcher.ts")), false);
});

test("describeProblems nombra el identificador de cada problema", () => {
	assert.deepEqual(describeProblems([{ id: "x", message: "roto" }]), ["x: roto"]);
});
