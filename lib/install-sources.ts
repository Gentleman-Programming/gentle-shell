// Inventario de las fuentes que Drakonc Shell instala automáticamente y de cómo
// están fijadas (D4 de openspec/changes/publicar-paquetes-drakonc).
//
// Cada entrada importa la constante real que usa el instalador, el launcher o el
// companion: si una fuente cambia, cambia aquí a la vez. El módulo no tiene
// dependencias fuera de las constantes ya publicadas por esos módulos, y es puro:
// no lee archivos, no usa la red y no tiene efectos al importarse, para que
// scripts/check-install-sources.mjs (enganchado a `pnpm test`) pueda recorrerlo.
//
// Fuentes deliberadamente FUERA del inventario, con su motivo:
//   - `LEGACY_ENGRAM_COMPANION_SOURCE` (`bin/drakonc-shell.mjs`) y las entradas
//     `npm:gentle-engram@0.4.2`: solo detectan una selección antigua para
//     migrarla, nunca instalan.
//   - `POST_INSTALL_REMOVAL_SOURCES` y `LAUNCHER_EXCLUDED_PI_PACKAGES`
//     (`lib/drakonc-shell-launcher.ts`): excluyen y borran declaraciones, nunca
//     instalan.
//   - `DISTRIBUTION_RELEASES` (`scripts/bundled-wizard.mjs`): base de releases
//     cuyo contenido se verifica con el manifiesto y el lockfile de la
//     distribución, no con una constante de este repositorio.
import { DRAKONC_STREAM_SPEC } from "../extensions/drakonc-music.ts";
import { DRAKONC_AI_MIRROR_RELEASE_BASE_URL, DRAKONC_AI_RELEASE_ASSETS, RELEASE_BASE_URL } from "../scripts/drakonc-ai-installer.mjs";
import { MUSIC_PLAYER_ARCHIVE } from "../scripts/bundled-install.mjs";
import { artifactFor } from "../scripts/installer-downloads.mjs";
import { ENGRAM_COMPANION_SOURCE } from "./drakonc-shell-bundled.ts";

/** Cómo queda fijada una fuente de instalación. */
export type InstallSourcePin = "npm-exact" | "git-sha" | "sha256" | "exception";

export interface InstallSource {
	/** Identificador estable, citado por las pruebas y el registro de excepciones. */
	readonly id: string;
	/** La fuente tal como la usa el instalador: `npm:…`, spec git, URL de descarga. */
	readonly source: string;
	readonly pin: InstallSourcePin;
	/**
	 * Nombre con el que la fuente existe de verdad hoy en su registro (npm o
	 * GitHub). Si empieza por `drakonc-`, tiene que figurar además en la sección
	 * «Publicados» de `docs/brand-exceptions.md`.
	 */
	readonly publishedName?: string;
	/** Checksums fijados de una descarga (`sha256-<hex>`, `sha512-<base64>`). */
	readonly checksums?: readonly string[];
	/**
	 * Nombre propio del que depende la fuente: el instalador se detiene mientras ese
	 * nombre no figure en «Publicados», así que hoy la fuente no llega a ejecutarse y
	 * la comprobación no la exige; el día que el flag del launcher pase a `true`, sí.
	 */
	readonly requiresPublication?: string;
	/** Detalle para una persona; nunca lo interpreta la comprobación. */
	readonly notes?: string;
}

/** Una entrada de la sección «Publicados» de `docs/brand-exceptions.md`. */
export interface PublishedEntry {
	readonly name: string;
	/** Resultado literal de `npm view <pkg> maintainers repository`. */
	readonly owner: string;
	/** Fecha de la verificación, `AAAA-MM-DD`. */
	readonly date: string;
}

/** Un problema encontrado; `id` es la fuente o el nombre afectado. */
export interface InstallSourceProblem {
	readonly id: string;
	readonly message: string;
}

/** Nombre propio que solo puede usarse cuando ya está publicado. */
export const SHELL_PI_PACKAGE_NAME = "drakonc-pi";

/** Nombre heredado del paquete Pi de la Shell, publicado en npm. */
export const LEGACY_SHELL_PI_PACKAGE_NAME = "gentle-pi";

/**
 * Versión con la que `scripts/installer-runner.mjs` pide el paquete Pi de la Shell
 * al registro (`SHELL_PACKAGE@requirements.shell`, que sale de `package.json`).
 * `tests/install-sources.test.ts` comprueba que sigue coincidiendo con
 * `package.json`.
 */
export const SHELL_PACKAGE_REGISTRY_VERSION = "5.0.0";

// Plataformas que el instalador adquiere; se recorren para recoger el checksum
// de cada archivo publicado, no para instalarlos todos en una máquina.
const DOWNLOAD_TARGETS: readonly (readonly [string, string])[] = [
	["darwin", "arm64"],
	["darwin", "x64"],
	["linux", "x64"],
	["linux", "arm64"],
	["win32", "x64"],
	["win32", "arm64"],
];

interface DownloadInventory {
	readonly source: string;
	readonly checksums: readonly string[];
}

/** URLs y checksums fijados de un artefacto de `scripts/installer-downloads.mjs`. */
function downloadInventory(name: string): DownloadInventory {
	const descriptors = DOWNLOAD_TARGETS.map(([platform, arch]) => artifactFor(name, platform, arch));
	return Object.freeze({
		source: descriptors[0].url,
		checksums: Object.freeze([...new Set(descriptors.map((descriptor) => descriptor.integrity))].sort()),
	});
}

const engramDownload = downloadInventory("engram");
const nodeDownload = downloadInventory("node");
const uvDownload = downloadInventory("uv");
const goDownload = downloadInventory("go");
const pnpmDownload = downloadInventory("pnpm");

// Los assets del binario companion se fijan con el sha256 del archivo y el del
// ejecutable extraído; ambos cambian solo con una versión nueva (INSTALLER_VERSION).
interface CompanionBinaryAsset {
	readonly sha256: string;
	readonly binarySha256: string;
}

const companionBinaryAssets: readonly CompanionBinaryAsset[] = Object.values(
	DRAKONC_AI_RELEASE_ASSETS as Record<string, CompanionBinaryAsset>,
);
const drakoncAiChecksums: readonly string[] = Object.freeze(
	[...new Set(companionBinaryAssets.flatMap((asset) => [`sha256-${asset.sha256}`, `sha256-${asset.binarySha256}`]))].sort(),
);

/** Lista canónica de lo que se instala automáticamente. */
export const INSTALL_SOURCES: readonly InstallSource[] = Object.freeze([
	{
		id: "engram-companion-pi",
		source: ENGRAM_COMPANION_SOURCE,
		pin: "npm-exact",
		publishedName: "gentle-engram",
		notes: "Companion de memoria que instala `drakonc-shell setup` (lib/drakonc-shell-bundled.ts).",
	},
	{
		id: "shell-pi-companion-install",
		source: `npm:${LEGACY_SHELL_PI_PACKAGE_NAME}`,
		pin: "exception",
		publishedName: LEGACY_SHELL_PI_PACKAGE_NAME,
		notes:
			"El binario companion ejecuta `pi install npm:gentle-pi` sin versión y no acepta una: es la declaración " +
			"del paquete Pi de la Shell que después `setup` vuelve a excluir y borrar (bin/drakonc-shell.mjs). " +
			"`drakonc-pi` no existe en npm todavía, así que la fuente no puede usar el nombre propio.",
	},
	{
		id: "shell-pi-registry",
		source: `npm:${SHELL_PI_PACKAGE_NAME}@${SHELL_PACKAGE_REGISTRY_VERSION}`,
		pin: "npm-exact",
		publishedName: SHELL_PI_PACKAGE_NAME,
		requiresPublication: SHELL_PI_PACKAGE_NAME,
		notes:
			"`scripts/installer-runner.mjs` (SHELL_PACKAGE) instala el paquete Pi de la Shell desde el registro. " +
			"Mientras `drakonc-pi` no exista en npm, el instalador se detiene antes de cualquier add -g: no instala " +
			"un nombre inexistente ni el `gentle-pi` original.",
	},
	{
		id: "engram-binary",
		source: engramDownload.source,
		pin: "sha256",
		publishedName: "engram",
		checksums: engramDownload.checksums,
		notes: "Núcleo de memoria descargado por el instalador del bundle.",
	},
	{
		id: "node-runtime",
		source: nodeDownload.source,
		pin: "sha256",
		publishedName: "node",
		checksums: nodeDownload.checksums,
		notes: "Node privado de la instalación empaquetada.",
	},
	{
		id: "pnpm-cli",
		source: pnpmDownload.source,
		pin: "sha256",
		publishedName: "pnpm",
		checksums: pnpmDownload.checksums,
		notes: "pnpm privado de la instalación empaquetada.",
	},
	{
		id: "uv-tool",
		source: uvDownload.source,
		pin: "sha256",
		publishedName: "uv",
		checksums: uvDownload.checksums,
		notes: "uv de /drakonc:music; nunca forma parte de la instalación por defecto.",
	},
	{
		id: "go-toolchain",
		source: goDownload.source,
		pin: "sha256",
		publishedName: "go",
		checksums: goDownload.checksums,
		notes: "Go privado que compila el binario companion cuando hace falta.",
	},
	{
		id: "music-player-git",
		source: DRAKONC_STREAM_SPEC,
		pin: "git-sha",
		publishedName: "gentle-stream",
		notes: "Reproductor de /drakonc:music instalado con uv (extensions/drakonc-music.ts).",
	},
	{
		id: "music-player-archive",
		source: MUSIC_PLAYER_ARCHIVE,
		pin: "git-sha",
		publishedName: "gentle-stream",
		notes: "Mismo commit que la spec anterior, como archivo de GitHub (scripts/bundled-install.mjs).",
	},
	{
		id: "companion-binary-release",
		source: RELEASE_BASE_URL,
		pin: "sha256",
		publishedName: "gentle-ai",
		checksums: drakoncAiChecksums,
		notes: "Releases firmados del binario companion (scripts/drakonc-ai-installer.mjs).",
	},
	{
		id: "companion-binary-mirror",
		source: DRAKONC_AI_MIRROR_RELEASE_BASE_URL,
		pin: "sha256",
		publishedName: "gentle-ai",
		checksums: drakoncAiChecksums,
		notes: "Espejo de los mismos archivos, con los mismos digests fijados.",
	},
]);

const EXACT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const FULL_GIT_SHA = /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/;
// sha256 en hexadecimal de 64 caracteres, o sha384/sha512 en base64 (pnpm publica
// el suyo así). Un digest corto nunca cuenta como checksum.
const CHECKSUM = /^(?:sha256-[0-9a-f]{64}|sha(?:384|512)-[A-Za-z0-9+/]{64,}={0,2})$/;
const MIN_EXCEPTION_REASON = 20;

/** `npm:<name>[@<versión>]`, tolerando un `@scope/name`. */
export function npmPackageNameFromSource(source: string): string | undefined {
	if (!source.startsWith("npm:")) return undefined;
	const spec = source.slice("npm:".length);
	if (spec.startsWith("@")) {
		const versionAt = spec.indexOf("@", 1);
		return versionAt === -1 ? spec : spec.slice(0, versionAt);
	}
	const versionAt = spec.indexOf("@");
	return versionAt === -1 ? spec : spec.slice(0, versionAt);
}

/** La versión exacta de una fuente npm, o undefined si flota. */
export function npmSourceVersion(source: string): string | undefined {
	const name = npmPackageNameFromSource(source);
	if (name === undefined) return undefined;
	const spec = source.slice("npm:".length);
	if (!spec.startsWith(`${name}@`)) return undefined;
	const version = spec.slice(name.length + 1);
	return version.length > 0 ? version : undefined;
}

/**
 * Nombres de paquete o repositorio que una fuente nombra. Un spec de uv
 * (`name[extras] @ git+https://…`), un `npm:…` y una URL de descarga se reducen
 * al nombre que el registro o el repositorio usan.
 */
export function sourcePackageNames(source: string): string[] {
	const trimmed = source.trim();
	const npmName = npmPackageNameFromSource(trimmed);
	if (npmName !== undefined) return [npmName];
	const requirement = trimmed.includes(" @ ") ? trimmed.slice(0, trimmed.indexOf(" @ ")) : trimmed;
	if (!requirement.includes("://")) {
		// Spec de requisito (pip/uv): `nombre[extras]`.
		const name = requirement.replace(/\[[^\]]*\]$/, "").trim();
		return name.length > 0 ? [name] : [];
	}
	const withoutQuery = requirement.split(/[?#]/)[0];
	const segments = withoutQuery.split("/").filter((segment) => segment.length > 0);
	const releasesAt = segments.indexOf("releases");
	if (releasesAt > 0) return [segments[releasesAt - 1]];
	const archiveAt = segments.indexOf("archive");
	if (archiveAt > 0) return [segments[archiveAt - 1]];
	const last = segments[segments.length - 1];
	if (last === undefined) return [];
	return [last.replace(/\.(?:tar\.gz|tgz|zip)$/, "")];
}

/** Nombres `drakonc-*` que la fuente usaría. */
export function drakoncNamesOf(entry: InstallSource): string[] {
	const names = [...sourcePackageNames(entry.source)];
	if (entry.publishedName !== undefined) names.push(entry.publishedName);
	return [...new Set(names.filter((name) => name.startsWith("drakonc-") || name.startsWith("drakonc/")))];
}

function pinProblems(entry: InstallSource): string[] {
	switch (entry.pin) {
		case "npm-exact": {
			const name = npmPackageNameFromSource(entry.source);
			if (name === undefined) return [`«${entry.source}» no es una fuente npm, pero declara pin npm-exact`];
			const version = npmSourceVersion(entry.source);
			if (version === undefined) return [`«${entry.source}» no fija una versión exacta`];
			if (!EXACT_SEMVER.test(version)) return [`«${entry.source}» no fija una versión exacta (${version} no es semver exacta)`];
			return [];
		}
		case "git-sha":
			if (!FULL_GIT_SHA.test(entry.source)) {
				return [`«${entry.source}» no fija un commit SHA de 40 caracteres`];
			}
			return [];
		case "sha256": {
			const checksums = entry.checksums ?? [];
			if (checksums.length === 0) return [`«${entry.source}» no fija ningún checksum`];
			const invalid = checksums.filter((checksum) => !CHECKSUM.test(checksum));
			if (invalid.length > 0) return [`«${entry.source}» tiene checksums mal formados: ${invalid.join(", ")}`];
			return [];
		}
		case "exception":
			if ((entry.notes ?? "").trim().length < MIN_EXCEPTION_REASON) {
				return [`«${entry.source}» es una excepción sin motivo documentado`];
			}
			return [];
	}
}

export interface InventoryProblemOptions {
	/** Valor del flag del launcher; por defecto, el estado real (`false`). */
	readonly drakoncPiPublished?: boolean;
}

function publishedProblems(
	entry: InstallSource,
	published: readonly PublishedEntry[],
	options: InventoryProblemOptions,
): string[] {
	return drakoncNamesOf(entry)
		.map((name) => {
			if (published.some((candidate) => candidate.name === name)) return "";
			// Una fuente condicionada a un nombre sin publicar no llega a ejecutarse: el
			// instalador se detiene antes. En cuanto el flag diga que ese nombre está
			// publicado, la entrada en «Publicados» vuelve a ser obligatoria.
			if (entry.requiresPublication === name && options.drakoncPiPublished !== true) return "";
			return `la fuente «${entry.id}» usa «${name}», que no figura en la sección «Publicados» de docs/brand-exceptions.md`;
		})
		.filter((message) => message.length > 0);
}

/** Comprueba el inventario: fijación de cada fuente y nombres propios publicados. */
export function inventoryProblems(
	entries: readonly InstallSource[] = INSTALL_SOURCES,
	published: readonly PublishedEntry[] = [],
	options: InventoryProblemOptions = {},
): InstallSourceProblem[] {
	const problems: InstallSourceProblem[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (seen.has(entry.id)) problems.push({ id: entry.id, message: `identificador repetido: «${entry.id}»` });
		seen.add(entry.id);
		for (const message of pinProblems(entry)) problems.push({ id: entry.id, message });
		for (const message of publishedProblems(entry, published, options)) problems.push({ id: entry.id, message });
	}
	return problems;
}

const SECTION_HEADING = /^##\s+(.+?)\s*$/;
const PUBLISHED_HEADING = /^##\s+Publicados\s*$/;
const ENTRY_START = /^-\s+\*\*`([^`]+)`\*\*/;

/**
 * Lee la sección «Publicados» de `docs/brand-exceptions.md`. Los bloques de
 * código y los comentarios HTML son instrucciones, no entradas; cada entrada
 * real necesita `Propietario:` y `Fecha: AAAA-MM-DD`.
 */
export function parsePublishedSection(markdown: string): { entries: PublishedEntry[]; problems: string[] } {
	const lines = markdown.split(/\r?\n/);
	const start = lines.findIndex((line) => PUBLISHED_HEADING.test(line));
	if (start === -1) return { entries: [], problems: ["falta la sección «## Publicados» en docs/brand-exceptions.md"] };

	const entries: PublishedEntry[] = [];
	const problems: string[] = [];
	let current: { name: string; owner?: string; date?: string } | undefined;
	let inFence = false;
	let inComment = false;

	const close = (): void => {
		if (current === undefined) return;
		if (current.owner === undefined) problems.push(`«${current.name}» no registra «Propietario:»`);
		if (current.date === undefined) problems.push(`«${current.name}» no registra «Fecha: AAAA-MM-DD»`);
		if (current.owner !== undefined && current.date !== undefined) {
			entries.push({ name: current.name, owner: current.owner, date: current.date });
		}
		current = undefined;
	};

	for (const line of lines.slice(start + 1)) {
		if (SECTION_HEADING.test(line) && !line.startsWith("###")) {
			close();
			break;
		}
		if (/^```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		if (line.includes("<!--")) inComment = true;
		if (inComment) {
			if (line.includes("-->")) inComment = false;
			continue;
		}
		const entryStart = ENTRY_START.exec(line);
		if (entryStart !== null) {
			close();
			current = { name: entryStart[1] };
			continue;
		}
		if (current === undefined) continue;
		const owner = /^\s*-?\s*Propietario:\s*(\S.*)$/.exec(line);
		if (owner !== null) current.owner = owner[1].trim();
		const date = /^\s*-?\s*Fecha:\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(line);
		if (date !== null) current.date = date[1];
	}
	close();
	return { entries, problems };
}

/**
 * El flag del launcher (`DRAKONC_PI_PACKAGE_PUBLISHED`) y la sección «Publicados»
 * tienen que decir lo mismo: mientras `drakonc-pi` no esté publicado, ninguna
 * fuente puede instalarlo ni proponerlo.
 */
/**
 * El flag `DRAKONC_PI_PACKAGE_PUBLISHED` de `lib/drakonc-shell-launcher.ts`, o
 * undefined cuando no está declarado. Lo leen la comprobación y el inventario.
 */
export function readPublishedFlag(launcherSource: string): boolean | undefined {
	const match = /export const DRAKONC_PI_PACKAGE_PUBLISHED = (true|false);/.exec(launcherSource);
	return match === null ? undefined : match[1] === "true";
}

export function publishedFlagProblems(launcherSource: string, published: readonly PublishedEntry[]): string[] {
	const flag = readPublishedFlag(launcherSource);
	if (flag === undefined) return ["lib/drakonc-shell-launcher.ts no declara DRAKONC_PI_PACKAGE_PUBLISHED"];
	const registered = published.some((entry) => entry.name === SHELL_PI_PACKAGE_NAME);
	if (flag === registered) return [];
	return flag
		? [`DRAKONC_PI_PACKAGE_PUBLISHED es true, pero «${SHELL_PI_PACKAGE_NAME}» no figura en «Publicados»`]
		: [`«${SHELL_PI_PACKAGE_NAME}» figura en «Publicados» pero DRAKONC_PI_PACKAGE_PUBLISHED sigue en false`];
}

/** Una línea por problema, con el identificador delante. */
export function describeProblems(problems: readonly InstallSourceProblem[]): string[] {
	return problems.map((problem) => `${problem.id}: ${problem.message}`);
}
