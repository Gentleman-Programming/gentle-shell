// Shared --pi-root contract. The comparison driver and the measurement worker
// must refuse a bad root with the same curated message, and both must do it
// before reading, hashing or importing anything from the host.
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const SUPPORTED_PI_VERSION = "1.2.0";
export const PI_ROOT_LAYOUT = "dist/ plus node_modules/@earendil-works/{pi-tui,pi-ai,pi-agent-core} and node_modules/jiti";
export const HOST_PACKAGE = "@earendil-works/pi-coding-agent";
export const TUI_PACKAGE = "@earendil-works/pi-tui";
export const HOST_ENTRY = "core/extensions/jiti-loader.js";
export const HOST_DEPENDENCIES = [
	"node_modules/@earendil-works/pi-tui",
	"node_modules/@earendil-works/pi-ai",
	"node_modules/@earendil-works/pi-agent-core",
	"node_modules/jiti",
];

function layoutError(piRoot, detail) {
	return new Error(`--pi-root ${piRoot} is not a Pi install root: ${detail} It must carry ${PI_ROOT_LAYOUT}.`);
}

function hostPackage(piRoot, relative, expectedName) {
	const path = resolve(piRoot, relative);
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw layoutError(piRoot, `${path} is unreadable.`);
	}
	if (manifest === null || typeof manifest !== "object" || typeof manifest.name !== "string" || typeof manifest.version !== "string") {
		throw layoutError(piRoot, `${path} declares no package name and version.`);
	}
	if (manifest.name !== expectedName) {
		throw layoutError(piRoot, `${path} is ${manifest.name}@${manifest.version}, expected ${expectedName}.`);
	}
	return { name: manifest.name, version: manifest.version };
}

function directoryAt(path) {
	try {
		return statSync(path).isDirectory();
	} catch (error) {
		if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
		throw error;
	}
}

function requireHostLayout(piRoot) {
	const dist = resolve(piRoot, "dist");
	if (!directoryAt(dist)) throw layoutError(piRoot, `${dist} is not a directory.`);
	const entry = resolve(dist, HOST_ENTRY);
	if (!existsSync(entry)) throw layoutError(piRoot, `${entry} is missing.`);
	for (const relative of HOST_DEPENDENCIES) {
		const path = resolve(piRoot, relative);
		if (!directoryAt(path)) throw layoutError(piRoot, `${path} is missing or not a directory.`);
	}
}

/** Validates the install root and returns the two audited manifests. */
export function validatePiRoot(piRoot) {
	const host = hostPackage(piRoot, "package.json", HOST_PACKAGE);
	const hostTui = hostPackage(piRoot, "node_modules/@earendil-works/pi-tui/package.json", TUI_PACKAGE);
	if (host.version !== SUPPORTED_PI_VERSION) {
		throw new Error(`--pi-root ${piRoot} is ${host.name}@${host.version}, but the private frame API is audited only on ${SUPPORTED_PI_VERSION}. Point --pi-root at a Pi ${SUPPORTED_PI_VERSION} install (${PI_ROOT_LAYOUT}).`);
	}
	if (hostTui.version !== host.version) {
		throw new Error(`--pi-root ${piRoot} mixes ${host.name}@${host.version} with ${hostTui.name}@${hostTui.version}; a mixed host cannot be measured. Point --pi-root at a Pi ${SUPPORTED_PI_VERSION} install (${PI_ROOT_LAYOUT}).`);
	}
	requireHostLayout(piRoot);
	return { host, hostTui };
}
