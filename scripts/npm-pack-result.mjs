// npm <=11 emits an array; npm 12 emits a map keyed by package name.
// Both consumers pack exactly one package. Never reinterpret npm error objects.
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isNonemptyString = (value) => typeof value === "string" && value.trim().length > 0;

export function normalizeNpmPackResult(value) {
	let entries;
	if (Array.isArray(value)) {
		entries = value;
	} else if (isRecord(value)) {
		const pairs = Object.entries(value);
		if (!pairs.every(([name, entry]) => isRecord(entry) && entry.name === name)) {
			throw new Error("npm pack returned a malformed named package map");
		}
		entries = pairs.map(([, entry]) => entry);
	} else {
		throw new Error("npm pack returned neither a package array nor a named package map");
	}
	if (entries.length !== 1) throw new Error("npm pack did not return exactly one package");
	const entry = entries[0];
	if (!isRecord(entry) || !isNonemptyString(entry.name) || !isNonemptyString(entry.filename)
		|| !Array.isArray(entry.files) || entry.files.length === 0
		|| !entry.files.every((file) => isRecord(file) && isNonemptyString(file.path))) {
		throw new Error("npm pack returned malformed package metadata");
	}
	return [entry];
}

export function parseNpmPackResult(output) {
	return normalizeNpmPackResult(JSON.parse(output));
}
