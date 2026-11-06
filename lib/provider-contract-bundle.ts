// gentle-pi provider contract bundle verifier (gentle-pi#311 P1/P2).
//
// Consumes the data-only `gentle-ai-review-provider-contract-<semver>.tar.gz`
// release bundle (or its extracted tree) and verifies it fail-closed before
// any layout, role, schema, or capability inside it is trusted:
//
// - exact inventory: eight base entries (README.md, manifest.json, 3 schemas,
//   3 vectors) plus one `orchestration/<runtime>.md` (>= 1.2.0) and one
//   `routing/<runtime>.md` (>= 1.4.0) per runtime the manifest lists;
// - strict manifest decode: single JSON object, no duplicate keys, no unknown fields;
// - per-file SHA-256 agreement between the manifest and the actual bytes;
// - pinned transport capability and supported contract major (1);
// - exactly the three provider roles `lens`, `refuter`, `targeted-validator`;
// - only known mandatory capabilities;
// - `runtimes` REQUIRED from contract 1.1.0 and it must register `pi`
//   (a 1.0.x manifest without `runtimes` is a valid bundle, but the relay
//   must then treat the `pi` runtime identity as unregistered);
// - confined in-memory archive reading: regular tar entries only, canonical
//   relative paths, no symlinks, no path escapes, safe modes, bounded sizes.
//
// Gentle AI remains the sole review authority. This module never derives
// admission semantics from the bundle; it only proves the bundle is the exact
// artifact the provider published before generated baselines are built from it.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { posix as posixPath, join as joinPath } from "node:path";
import { gunzipSync } from "node:zlib";

export const PROVIDER_CONTRACT_BUNDLE_SCHEMA = "gentle-ai.review-provider-contract-bundle/v1";
export const PROVIDER_TRANSPORT_CAPABILITY = "gentle-ai.provider-transport/v1";
export const PI_RUNTIME_IDENTITY = "pi";
export const SUPPORTED_PROVIDER_CONTRACT_MAJOR = 1;
// `runtimes` became part of the manifest in contract 1.1.0.
export const RUNTIMES_REQUIRED_SINCE_MINOR = 1;
// `orchestration` became part of the manifest in contract 1.2.0.
export const ORCHESTRATION_REQUIRED_SINCE_MINOR = 2;
// `routing` became part of the manifest in contract 1.4.0.
export const ROUTING_REQUIRED_SINCE_MINOR = 4;
// Exactly the provider roles gentle-pi supports, in the manifest's strict order.
export const PROVIDER_CONTRACT_ROLE_IDS = ["lens", "refuter", "targeted-validator"] as const;
// Every mandatory capability a role may declare. An unknown mandatory
// capability means this gentle-pi build cannot satisfy the role: fail closed.
export const KNOWN_MANDATORY_CAPABILITIES: readonly string[] = [PROVIDER_TRANSPORT_CAPABILITY];

const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const BUNDLE_ENTRY_COUNT = 8;
// Generous fixed safety bound on raw archive/tree entries read BEFORE the
// manifest itself is parsed (the exact expected count, base entries plus one
// per `orchestration` and one per `routing` runtime, is known only after
// manifest decode). Real contracts register a handful of runtimes; this bound
// only rules out an absurd smuggled inventory, it is not the exact-count check.
const MAX_RUNTIME_FILE_ENTRIES = 64;
const MAX_RAW_BUNDLE_ENTRIES = BUNDLE_ENTRY_COUNT + 2 * MAX_RUNTIME_FILE_ENTRIES;
// setuid/setgid/sticky, any execute bit, or world-writable content is never
// acceptable for a data-only contract bundle.
const FORBIDDEN_MODE_BITS = 0o7113;

const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RUNTIME_IDENTITY_PATTERN = /^[a-z][a-z0-9-]*$/;

export const PROVIDER_CONTRACT_BUNDLE_INVALID = "invalid-provider-contract-bundle";

export class ProviderContractBundleError extends Error {
	readonly code = PROVIDER_CONTRACT_BUNDLE_INVALID;
	constructor(message: string) {
		super(`${PROVIDER_CONTRACT_BUNDLE_INVALID}: ${message}`);
		this.name = "ProviderContractBundleError";
	}
}

function invalid(message: string): never {
	throw new ProviderContractBundleError(message);
}

export interface VerifiedProviderRole {
	readonly id: string;
	readonly requestSchemaId: string;
	readonly resultSchemaId: string;
	readonly requiredCapabilities: readonly string[];
	readonly schemaPath: string;
	readonly schemaSha256: string;
	readonly vectorPath: string;
	readonly vectorSha256: string;
}

export interface VerifiedProviderContractBundle {
	readonly contractSemver: string;
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	readonly transportCapability: string;
	/** Present exactly when the manifest declares the runtime registry (>= 1.1.0). */
	readonly runtimes: readonly string[] | undefined;
	readonly roles: readonly VerifiedProviderRole[];
	/**
	 * Verified runtime-bound review execution contract text, runtime identity
	 * -> UTF-8 `orchestration/<runtime>.md` contents. Empty before contract
	 * 1.2.0, where `orchestration` does not exist in the manifest.
	 */
	readonly orchestration: ReadonlyMap<string, string>;
	/**
	 * Verified ODD implementation-routing block, runtime identity -> UTF-8
	 * `routing/<runtime>.md` contents. Empty before contract 1.4.0, where
	 * `routing` does not exist in the manifest.
	 */
	readonly routing: ReadonlyMap<string, string>;
	/** Canonical path -> exact verified bytes for all entries (base eight plus one per orchestration and routing runtime). */
	readonly entries: ReadonlyMap<string, Buffer>;
	/** Canonical path -> SHA-256 of the exact verified bytes. */
	readonly entrySha256: ReadonlyMap<string, string>;
	/** Deterministic digest over the sorted `<sha256>  <path>` inventory. */
	readonly treeSha256: string;
}

export interface PiRuntimeRegistration {
	readonly registered: boolean;
	readonly reason?: string;
}

function sha256Hex(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

// --- strict JSON (single object, no duplicate keys, no trailing data) -------

class StrictJsonScanner {
	private index = 0;
	private readonly text: string;
	constructor(text: string) {
		this.text = text;
	}

	scanDocument(): unknown {
		this.skipWhitespace();
		if (this.peek() !== "{") invalid("manifest must be a single JSON object");
		const value = this.scanValue();
		this.skipWhitespace();
		if (this.index !== this.text.length) invalid("manifest has trailing data after its JSON object");
		return value;
	}

	private peek(): string {
		if (this.index >= this.text.length) invalid("manifest JSON ends unexpectedly");
		return this.text[this.index] as string;
	}

	private next(): string {
		const character = this.peek();
		this.index += 1;
		return character;
	}

	private skipWhitespace(): void {
		while (this.index < this.text.length && " \t\n\r".includes(this.text[this.index] as string)) this.index += 1;
	}

	private scanValue(): unknown {
		this.skipWhitespace();
		const character = this.peek();
		if (character === "{") return this.scanObject();
		if (character === "[") return this.scanArray();
		if (character === '"') return this.scanString();
		if (character === "-" || (character >= "0" && character <= "9")) return this.scanNumber();
		if (this.text.startsWith("true", this.index)) { this.index += 4; return true; }
		if (this.text.startsWith("false", this.index)) { this.index += 5; return false; }
		if (this.text.startsWith("null", this.index)) { this.index += 4; return null; }
		return invalid(`manifest JSON has an unexpected token at offset ${this.index}`);
	}

	private scanObject(): Record<string, unknown> {
		this.next();
		const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		this.skipWhitespace();
		if (this.peek() === "}") { this.next(); return value; }
		for (;;) {
			this.skipWhitespace();
			if (this.peek() !== '"') invalid("manifest JSON object key is not a string");
			const key = this.scanString();
			if (Object.prototype.hasOwnProperty.call(value, key)) invalid(`manifest JSON has duplicate key ${JSON.stringify(key)}`);
			this.skipWhitespace();
			if (this.next() !== ":") invalid("manifest JSON object is missing a colon");
			value[key] = this.scanValue();
			this.skipWhitespace();
			const separator = this.next();
			if (separator === "}") return value;
			if (separator !== ",") invalid("manifest JSON object is malformed");
		}
	}

	private scanArray(): unknown[] {
		this.next();
		const values: unknown[] = [];
		this.skipWhitespace();
		if (this.peek() === "]") { this.next(); return values; }
		for (;;) {
			values.push(this.scanValue());
			this.skipWhitespace();
			const separator = this.next();
			if (separator === "]") return values;
			if (separator !== ",") invalid("manifest JSON array is malformed");
		}
	}

	private scanString(): string {
		if (this.next() !== '"') invalid("manifest JSON string is malformed");
		let value = "";
		for (;;) {
			const character = this.next();
			if (character === '"') return value;
			if (character === "\\") {
				const escape = this.next();
				if (escape === '"' || escape === "\\" || escape === "/") value += escape;
				else if (escape === "b") value += "\b";
				else if (escape === "f") value += "\f";
				else if (escape === "n") value += "\n";
				else if (escape === "r") value += "\r";
				else if (escape === "t") value += "\t";
				else if (escape === "u") {
					const hex = this.text.slice(this.index, this.index + 4);
					if (!/^[0-9a-fA-F]{4}$/.test(hex)) invalid("manifest JSON has an invalid unicode escape");
					this.index += 4;
					value += String.fromCharCode(Number.parseInt(hex, 16));
				} else invalid("manifest JSON has an invalid escape sequence");
			} else if (character.charCodeAt(0) < 0x20) {
				invalid("manifest JSON string has an unescaped control character");
			} else {
				value += character;
			}
		}
	}

	private scanNumber(): number {
		const start = this.index;
		if (this.peek() === "-") this.index += 1;
		while (this.index < this.text.length && /[0-9.eE+-]/.test(this.text[this.index] as string)) this.index += 1;
		const literal = this.text.slice(start, this.index);
		if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(literal)) invalid("manifest JSON number is malformed");
		return Number(literal);
	}
}

function decodeStrictManifestObject(payload: Buffer): Record<string, unknown> {
	if (payload.length > MAX_MANIFEST_BYTES) invalid("manifest.json exceeds its size limit");
	if (payload.length >= 3 && payload[0] === 0xef && payload[1] === 0xbb && payload[2] === 0xbf) invalid("manifest.json must not carry a byte-order mark");
	const value = new StrictJsonScanner(payload.toString("utf8")).scanDocument();
	return value as Record<string, unknown>;
}

// --- manifest shape ----------------------------------------------------------

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], where: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) invalid(`${where} has unknown field ${JSON.stringify(key)}`);
	}
	for (const key of required) {
		if (!Object.prototype.hasOwnProperty.call(value, key)) invalid(`${where} is missing field ${JSON.stringify(key)}`);
	}
}

function requireString(value: unknown, where: string): string {
	if (typeof value !== "string" || value === "") invalid(`${where} must be a non-empty string`);
	return value;
}

function requireObject(value: unknown, where: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${where} must be a JSON object`);
	return value as Record<string, unknown>;
}

interface ManifestFileReference {
	readonly path: string;
	readonly sha256: string;
}

function parseFileReference(value: unknown, where: string): ManifestFileReference {
	const object = requireObject(value, where);
	requireExactKeys(object, ["path", "sha256"], ["path", "sha256"], where);
	const path = requireString(object.path, `${where}.path`);
	const sha256 = requireString(object.sha256, `${where}.sha256`);
	if (!isCanonicalBundlePath(path)) invalid(`${where}.path ${JSON.stringify(path)} is unsafe`);
	if (!SHA256_PATTERN.test(sha256)) invalid(`${where}.sha256 is not a lowercase hex SHA-256`);
	return { path, sha256 };
}

interface ManifestRole {
	readonly id: string;
	readonly requestSchemaId: string;
	readonly resultSchemaId: string;
	readonly requiredCapabilities: readonly string[];
	readonly schema: ManifestFileReference;
	readonly vector: ManifestFileReference;
}

function parseManifestRole(value: unknown, index: number): ManifestRole {
	const where = `manifest role ${index}`;
	const object = requireObject(value, where);
	requireExactKeys(
		object,
		["id", "request_schema_id", "result_schema_id", "required_capabilities", "schema", "vector"],
		["id", "request_schema_id", "result_schema_id", "required_capabilities", "schema", "vector"],
		where,
	);
	const id = requireString(object.id, `${where}.id`);
	if (!Array.isArray(object.required_capabilities) || object.required_capabilities.length === 0) {
		invalid(`${where}.required_capabilities must be a non-empty array`);
	}
	const requiredCapabilities = object.required_capabilities.map((capability, capabilityIndex) =>
		requireString(capability, `${where}.required_capabilities[${capabilityIndex}]`),
	);
	for (let position = 0; position < requiredCapabilities.length; position += 1) {
		const capability = requiredCapabilities[position] as string;
		if (position > 0 && (requiredCapabilities[position - 1] as string) >= capability) {
			invalid(`${where}.required_capabilities must be strictly sorted and unique`);
		}
		if (!KNOWN_MANDATORY_CAPABILITIES.includes(capability)) {
			invalid(`${where} declares unknown mandatory capability ${JSON.stringify(capability)}`);
		}
	}
	return {
		id,
		requestSchemaId: requireString(object.request_schema_id, `${where}.request_schema_id`),
		resultSchemaId: requireString(object.result_schema_id, `${where}.result_schema_id`),
		requiredCapabilities,
		schema: parseFileReference(object.schema, `${where}.schema`),
		vector: parseFileReference(object.vector, `${where}.vector`),
	};
}

// One entry of a runtime-file inventory: `orchestration` (>= 1.2.0) or
// `routing` (>= 1.4.0). Both share the shape `{ runtime, file }` with the file
// at `<inventory>/<runtime>.md`.
interface ManifestRuntimeFileEntry {
	readonly runtime: string;
	readonly file: ManifestFileReference;
}

type RuntimeFileInventory = "orchestration" | "routing";

function parseRuntimeFileEntry(inventory: RuntimeFileInventory, value: unknown, index: number): ManifestRuntimeFileEntry {
	const where = `manifest.${inventory}[${index}]`;
	const object = requireObject(value, where);
	requireExactKeys(object, ["runtime", "file"], ["runtime", "file"], where);
	const runtime = requireString(object.runtime, `${where}.runtime`);
	if (!RUNTIME_IDENTITY_PATTERN.test(runtime)) invalid(`${where}.runtime ${JSON.stringify(runtime)} is not a runtime identity`);
	const file = parseFileReference(object.file, `${where}.file`);
	const expectedPath = `${inventory}/${runtime}.md`;
	if (file.path !== expectedPath) invalid(`${where}.file.path must be ${JSON.stringify(expectedPath)}`);
	return { runtime, file };
}

// Decodes one runtime-file inventory: absent before the contract minor that
// introduced it, required from it on, strictly sorted, every runtime
// registered in manifest.runtimes, and `pi` always present.
function parseRuntimeFileInventory(
	object: Record<string, unknown>,
	inventory: RuntimeFileInventory,
	requiredSinceMinor: number,
	contractSemver: string,
	minor: number,
	runtimes: readonly string[] | undefined,
): readonly ManifestRuntimeFileEntry[] {
	const required = minor >= requiredSinceMinor;
	if (!Object.prototype.hasOwnProperty.call(object, inventory)) {
		if (required) invalid(`manifest.${inventory} is required from contract 1.${requiredSinceMinor}.0 (got ${contractSemver} without it)`);
		return [];
	}
	if (!required) {
		invalid(`manifest.${inventory} is not part of contract ${contractSemver}; it exists from 1.${requiredSinceMinor}.0`);
	}
	const value = object[inventory];
	if (!Array.isArray(value) || value.length === 0) invalid(`manifest.${inventory} must be a non-empty array`);
	const entries = value.map((entry, index) => parseRuntimeFileEntry(inventory, entry, index));
	for (let position = 0; position < entries.length; position += 1) {
		const entry = entries[position] as ManifestRuntimeFileEntry;
		if (position > 0 && (entries[position - 1] as ManifestRuntimeFileEntry).runtime >= entry.runtime) {
			invalid(`manifest.${inventory} must be strictly sorted by runtime and unique`);
		}
		if (runtimes === undefined || !runtimes.includes(entry.runtime)) {
			invalid(`manifest.${inventory}[${position}].runtime ${JSON.stringify(entry.runtime)} is not registered in manifest.runtimes`);
		}
	}
	if (!entries.some((entry) => entry.runtime === PI_RUNTIME_IDENTITY)) {
		invalid(`manifest.${inventory} does not register the ${JSON.stringify(PI_RUNTIME_IDENTITY)} runtime identity`);
	}
	return entries;
}

interface ParsedManifest {
	readonly contractSemver: string;
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	readonly transportCapability: string;
	readonly runtimes: readonly string[] | undefined;
	readonly readme: ManifestFileReference;
	readonly roles: readonly ManifestRole[];
	readonly orchestration: readonly ManifestRuntimeFileEntry[];
	readonly routing: readonly ManifestRuntimeFileEntry[];
}

function parseManifest(payload: Buffer): ParsedManifest {
	const object = decodeStrictManifestObject(payload);
	requireExactKeys(
		object,
		["schema", "contract_semver", "transport_capability", "runtimes", "readme", "roles", "orchestration", "routing"],
		["schema", "contract_semver", "transport_capability", "readme", "roles"],
		"manifest",
	);
	if (object.schema !== PROVIDER_CONTRACT_BUNDLE_SCHEMA) {
		invalid(`manifest schema must be ${JSON.stringify(PROVIDER_CONTRACT_BUNDLE_SCHEMA)}`);
	}
	const contractSemver = requireString(object.contract_semver, "manifest.contract_semver");
	const semverMatch = SEMVER_PATTERN.exec(contractSemver);
	if (!semverMatch) invalid(`manifest.contract_semver ${JSON.stringify(contractSemver)} is not exact MAJOR.MINOR.PATCH`);
	const major = Number(semverMatch[1]);
	const minor = Number(semverMatch[2]);
	const patch = Number(semverMatch[3]);
	if (major !== SUPPORTED_PROVIDER_CONTRACT_MAJOR) {
		invalid(`unsupported provider contract major ${major}; gentle-pi supports major ${SUPPORTED_PROVIDER_CONTRACT_MAJOR} only`);
	}
	const transportCapability = requireString(object.transport_capability, "manifest.transport_capability");
	if (transportCapability !== PROVIDER_TRANSPORT_CAPABILITY) {
		invalid(`manifest.transport_capability must be pinned to ${JSON.stringify(PROVIDER_TRANSPORT_CAPABILITY)}`);
	}

	const runtimesRequired = minor >= RUNTIMES_REQUIRED_SINCE_MINOR;
	let runtimes: readonly string[] | undefined;
	if (Object.prototype.hasOwnProperty.call(object, "runtimes")) {
		if (!runtimesRequired) {
			invalid(`manifest.runtimes is not part of contract ${contractSemver}; it exists from 1.${RUNTIMES_REQUIRED_SINCE_MINOR}.0`);
		}
		if (!Array.isArray(object.runtimes) || object.runtimes.length === 0) invalid("manifest.runtimes must be a non-empty array");
		const identities = object.runtimes.map((runtime, index) => requireString(runtime, `manifest.runtimes[${index}]`));
		for (let position = 0; position < identities.length; position += 1) {
			const identity = identities[position] as string;
			if (!RUNTIME_IDENTITY_PATTERN.test(identity)) invalid(`manifest.runtimes[${position}] ${JSON.stringify(identity)} is not a runtime identity`);
			if (position > 0 && (identities[position - 1] as string) >= identity) invalid("manifest.runtimes must be strictly sorted and unique");
		}
		runtimes = identities;
	} else if (runtimesRequired) {
		invalid(`manifest.runtimes is required from contract 1.${RUNTIMES_REQUIRED_SINCE_MINOR}.0 (got ${contractSemver} without it)`);
	}
	if (runtimes !== undefined && !runtimes.includes(PI_RUNTIME_IDENTITY)) {
		// A registry that exists but omits `pi` means this runtime identity is
		// not registered for the published contract: the relay must not trust it.
		invalid(`manifest.runtimes does not register the ${JSON.stringify(PI_RUNTIME_IDENTITY)} runtime identity`);
	}

	const orchestration = parseRuntimeFileInventory(object, "orchestration", ORCHESTRATION_REQUIRED_SINCE_MINOR, contractSemver, minor, runtimes);
	const routing = parseRuntimeFileInventory(object, "routing", ROUTING_REQUIRED_SINCE_MINOR, contractSemver, minor, runtimes);

	if (!Array.isArray(object.roles)) invalid("manifest.roles must be an array");
	const roles = object.roles.map((role, index) => parseManifestRole(role, index));
	if (roles.length !== PROVIDER_CONTRACT_ROLE_IDS.length) {
		invalid(`manifest declares ${roles.length} roles; exactly ${PROVIDER_CONTRACT_ROLE_IDS.length} are supported`);
	}
	roles.forEach((role, index) => {
		if (role.id !== PROVIDER_CONTRACT_ROLE_IDS[index]) {
			invalid(`manifest role ${index} is ${JSON.stringify(role.id)}; expected ${JSON.stringify(PROVIDER_CONTRACT_ROLE_IDS[index])}`);
		}
	});

	return {
		contractSemver,
		major,
		minor,
		patch,
		transportCapability,
		runtimes,
		readme: parseFileReference(object.readme, "manifest.readme"),
		roles,
		orchestration,
		routing,
	};
}

// --- entry-level verification -------------------------------------------------

export function isCanonicalBundlePath(name: string): boolean {
	if (name === "" || name.includes("\\") || name.startsWith("/") || posixPath.normalize(name) !== name) return false;
	for (const component of name.split("/")) {
		if (component === "" || component === "." || component === "..") return false;
	}
	return true;
}

function jsonDeepEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((value, index) => jsonDeepEqual(value, right[index]));
	}
	if (typeof left === "object" && left !== null && typeof right === "object" && right !== null && !Array.isArray(left) && !Array.isArray(right)) {
		const leftKeys = Object.keys(left as Record<string, unknown>).sort();
		const rightKeys = Object.keys(right as Record<string, unknown>).sort();
		return (
			leftKeys.length === rightKeys.length &&
			leftKeys.every(
				(key, index) =>
					key === rightKeys[index] &&
					jsonDeepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
			)
		);
	}
	return false;
}

function verifyFileReference(entries: ReadonlyMap<string, Buffer>, reference: ManifestFileReference, expectedPath: string): Buffer {
	if (reference.path !== expectedPath) invalid(`manifest references ${JSON.stringify(reference.path)}; expected ${JSON.stringify(expectedPath)}`);
	const payload = entries.get(reference.path);
	if (payload === undefined) invalid(`bundle is missing ${JSON.stringify(expectedPath)}`);
	if (sha256Hex(payload) !== reference.sha256) invalid(`bundle entry ${JSON.stringify(expectedPath)} does not match its manifest SHA-256`);
	return payload;
}

function verifyRoleArtifacts(entries: ReadonlyMap<string, Buffer>, role: ManifestRole): void {
	const schemaPath = `schemas/${role.id}.schema.json`;
	const vectorPath = `vectors/${role.id}.json`;
	const schemaPayload = verifyFileReference(entries, role.schema, schemaPath);
	const vectorPayload = verifyFileReference(entries, role.vector, vectorPath);

	let schemaDocument: unknown;
	try {
		schemaDocument = JSON.parse(schemaPayload.toString("utf8"));
	} catch {
		invalid(`bundle schema ${JSON.stringify(schemaPath)} is not valid JSON`);
	}
	const schemaObject = requireObject(schemaDocument, `bundle schema ${JSON.stringify(schemaPath)}`);
	if (schemaObject["$id"] !== role.resultSchemaId) {
		invalid(`bundle schema ${JSON.stringify(schemaPath)} $id does not match the manifest result schema id`);
	}
	const examples = schemaObject.examples;
	if (!Array.isArray(examples) || examples.length === 0) invalid(`bundle schema ${JSON.stringify(schemaPath)} has no canonical example`);

	let vectorDocument: unknown;
	try {
		vectorDocument = JSON.parse(vectorPayload.toString("utf8"));
	} catch {
		invalid(`bundle vector ${JSON.stringify(vectorPath)} is not valid JSON`);
	}
	requireObject(vectorDocument, `bundle vector ${JSON.stringify(vectorPath)}`);
	if (!vectorPayload.toString("utf8").endsWith("\n")) invalid(`bundle vector ${JSON.stringify(vectorPath)} must end with a newline`);
	if (!jsonDeepEqual(vectorDocument, examples[0])) {
		invalid(`bundle vector ${JSON.stringify(vectorPath)} does not equal the schema's canonical example`);
	}
}

export function bundleTreeSha256(entrySha256: ReadonlyMap<string, string>): string {
	const lines = [...entrySha256.entries()]
		.sort(([leftPath], [rightPath]) => (leftPath < rightPath ? -1 : 1))
		.map(([path, digest]) => `${digest}  ${path}\n`);
	return sha256Hex(Buffer.from(lines.join(""), "utf8"));
}

/** Verifies a complete in-memory bundle inventory. The single trust anchor. */
export function verifyProviderContractBundleEntries(rawEntries: ReadonlyMap<string, Buffer>): VerifiedProviderContractBundle {
	if (rawEntries.size > MAX_RAW_BUNDLE_ENTRIES) {
		invalid(`bundle inventory has ${rawEntries.size} files; at most ${MAX_RAW_BUNDLE_ENTRIES} are ever expected`);
	}
	for (const [name, payload] of rawEntries) {
		if (!isCanonicalBundlePath(name)) invalid(`bundle path ${JSON.stringify(name)} is unsafe`);
		if (payload.length > MAX_FILE_BYTES) invalid(`bundle entry ${JSON.stringify(name)} exceeds its size limit`);
	}
	const manifestPayload = rawEntries.get("manifest.json");
	if (manifestPayload === undefined) invalid("bundle is missing manifest.json");
	const manifest = parseManifest(manifestPayload);

	// The exact expected inventory size is only known once the manifest is
	// decoded: base entries plus exactly one `orchestration/<runtime>.md` per
	// registered orchestration runtime and one `routing/<runtime>.md` per
	// registered routing runtime.
	const expectedEntryCount = BUNDLE_ENTRY_COUNT + manifest.orchestration.length + manifest.routing.length;
	if (rawEntries.size !== expectedEntryCount) {
		invalid(`bundle inventory has ${rawEntries.size} files; exactly ${expectedEntryCount} are expected`);
	}

	verifyFileReference(rawEntries, manifest.readme, "README.md");
	const expected = new Set(["README.md", "manifest.json"]);
	for (const role of manifest.roles) {
		verifyRoleArtifacts(rawEntries, role);
		expected.add(`schemas/${role.id}.schema.json`);
		expected.add(`vectors/${role.id}.json`);
	}
	const verifyRuntimeFiles = (inventory: RuntimeFileInventory, manifestEntries: readonly ManifestRuntimeFileEntry[]): Map<string, string> => {
		const texts = new Map<string, string>();
		for (const entry of manifestEntries) {
			const path = `${inventory}/${entry.runtime}.md`;
			const payload = verifyFileReference(rawEntries, entry.file, path);
			texts.set(entry.runtime, payload.toString("utf8"));
			expected.add(path);
		}
		return texts;
	};
	const orchestration = verifyRuntimeFiles("orchestration", manifest.orchestration);
	const routing = verifyRuntimeFiles("routing", manifest.routing);
	for (const name of rawEntries.keys()) {
		if (!expected.has(name)) invalid(`bundle has unexpected file ${JSON.stringify(name)}`);
	}

	const entries = new Map<string, Buffer>();
	const entrySha256 = new Map<string, string>();
	for (const name of [...rawEntries.keys()].sort()) {
		const payload = rawEntries.get(name) as Buffer;
		entries.set(name, Buffer.from(payload));
		entrySha256.set(name, sha256Hex(payload));
	}

	return {
		contractSemver: manifest.contractSemver,
		major: manifest.major,
		minor: manifest.minor,
		patch: manifest.patch,
		transportCapability: manifest.transportCapability,
		runtimes: manifest.runtimes,
		roles: manifest.roles.map((role) => ({
			id: role.id,
			requestSchemaId: role.requestSchemaId,
			resultSchemaId: role.resultSchemaId,
			requiredCapabilities: [...role.requiredCapabilities],
			schemaPath: role.schema.path,
			schemaSha256: role.schema.sha256,
			vectorPath: role.vector.path,
			vectorSha256: role.vector.sha256,
		})),
		orchestration,
		routing,
		entries,
		entrySha256,
		treeSha256: bundleTreeSha256(entrySha256),
	};
}

/**
 * Reports whether the verified bundle registers the `pi` runtime identity.
 *
 * A 1.0.x bundle predates the runtime registry: it is a valid bundle, but the
 * relay must treat `pi` as unregistered and must not trust the layout for
 * host-relay work. From 1.1.0 the registry is mandatory and `pi` membership is
 * already enforced during verification, so a verified >=1.1.0 bundle is
 * always registered.
 */
export function piRuntimeRegistration(bundle: VerifiedProviderContractBundle): PiRuntimeRegistration {
	if (bundle.runtimes === undefined) {
		return {
			registered: false,
			reason: `contract ${bundle.contractSemver} predates the runtime identity registry; the ${JSON.stringify(PI_RUNTIME_IDENTITY)} runtime identity is not registered and the relay must not trust this bundle`,
		};
	}
	return { registered: bundle.runtimes.includes(PI_RUNTIME_IDENTITY) };
}

// --- extracted tree reading ---------------------------------------------------

function assertSafeDirectory(path: string): void {
	const details = lstatSync(path);
	if (details.isSymbolicLink() || !details.isDirectory()) invalid(`bundle directory ${JSON.stringify(path)} is not a real directory`);
}

/** Reads and verifies an already-extracted local bundle tree. */
export function verifyProviderContractBundleTree(directory: string): VerifiedProviderContractBundle {
	assertSafeDirectory(directory);
	const entries = new Map<string, Buffer>();
	const walk = (current: string, relative: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const absolute = joinPath(current, entry.name);
			const relativeName = relative === "" ? entry.name : `${relative}/${entry.name}`;
			const details = lstatSync(absolute);
			if (details.isSymbolicLink()) invalid(`bundle tree entry ${JSON.stringify(relativeName)} is a symlink`);
			if (details.isDirectory()) {
				walk(absolute, relativeName);
				continue;
			}
			if (!details.isFile()) invalid(`bundle tree entry ${JSON.stringify(relativeName)} is not a regular file`);
			if (process.platform !== "win32" && (details.mode & FORBIDDEN_MODE_BITS) !== 0) {
				invalid(`bundle tree entry ${JSON.stringify(relativeName)} has an unsafe file mode`);
			}
			if (!isCanonicalBundlePath(relativeName)) invalid(`bundle tree path ${JSON.stringify(relativeName)} is unsafe`);
			if (details.size > MAX_FILE_BYTES) invalid(`bundle tree entry ${JSON.stringify(relativeName)} exceeds its size limit`);
			if (entries.size >= MAX_RAW_BUNDLE_ENTRIES) invalid(`bundle tree has more than ${MAX_RAW_BUNDLE_ENTRIES} files`);
			entries.set(relativeName, readFileSync(absolute));
		}
	};
	walk(directory, "");
	return verifyProviderContractBundleEntries(entries);
}

// --- archive reading (bounded, in memory, never extracted to disk) ------------

const TAR_BLOCK_SIZE = 512;

function parseOctalField(field: Buffer, where: string): number {
	const text = field.toString("ascii").replace(/[\0 ]+$/g, "").replace(/^[\0 ]+/g, "");
	if (text === "") return 0;
	if (!/^[0-7]+$/.test(text)) invalid(`tar ${where} field is not octal`);
	return Number.parseInt(text, 8);
}

function verifyTarHeaderChecksum(header: Buffer): void {
	const recorded = parseOctalField(header.subarray(148, 156), "checksum");
	let computed = 0;
	for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
		computed += index >= 148 && index < 156 ? 0x20 : (header[index] as number);
	}
	if (computed !== recorded) invalid("tar header checksum does not match");
}

function readTarEntries(expanded: Buffer): Map<string, Buffer> {
	const entries = new Map<string, Buffer>();
	let offset = 0;
	let totalBytes = 0;
	for (;;) {
		if (expanded.length - offset < TAR_BLOCK_SIZE) invalid("tar stream ends before a complete header");
		const header = expanded.subarray(offset, offset + TAR_BLOCK_SIZE);
		offset += TAR_BLOCK_SIZE;
		if (header.every((byte) => byte === 0)) {
			if (expanded.length - offset < TAR_BLOCK_SIZE) invalid("tar stream has an incomplete terminator");
			const second = expanded.subarray(offset, offset + TAR_BLOCK_SIZE);
			if (!second.every((byte) => byte === 0)) invalid("tar stream has an incomplete terminator");
			offset += TAR_BLOCK_SIZE;
			for (; offset < expanded.length; offset += 1) {
				if (expanded[offset] !== 0) invalid("tar stream has data after its terminator");
			}
			return entries;
		}
		verifyTarHeaderChecksum(header);
		const typeflag = header[156] as number;
		// Only plain regular files: no symlinks, links, directories, devices,
		// and no PAX/GNU metadata entries that could smuggle a second identity.
		if (typeflag !== 0x30 && typeflag !== 0) invalid(`tar entry type ${JSON.stringify(String.fromCharCode(typeflag))} is forbidden`);
		const prefix = header.subarray(345, 500).toString("ascii").replace(/\0+$/g, "");
		if (prefix !== "") invalid("tar entry uses the ustar prefix field; canonical bundle paths never need it");
		const name = header.subarray(0, 100).toString("ascii").replace(/\0+$/g, "");
		if (!isCanonicalBundlePath(name)) invalid(`tar entry path ${JSON.stringify(name)} is unsafe`);
		if (entries.has(name)) invalid(`tar entry path ${JSON.stringify(name)} is duplicated`);
		const mode = parseOctalField(header.subarray(100, 108), "mode");
		if ((mode & FORBIDDEN_MODE_BITS) !== 0) invalid(`tar entry ${JSON.stringify(name)} has an unsafe file mode`);
		const size = parseOctalField(header.subarray(124, 136), "size");
		if (size > MAX_FILE_BYTES) invalid(`tar entry ${JSON.stringify(name)} exceeds its size limit`);
		totalBytes += size;
		if (totalBytes > MAX_BUNDLE_BYTES) invalid("tar entries exceed the bundle size limit");
		if (entries.size >= MAX_RAW_BUNDLE_ENTRIES) invalid(`tar has more than ${MAX_RAW_BUNDLE_ENTRIES} entries`);
		const padding = (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
		if (expanded.length - offset < size + padding) invalid("tar stream ends before a complete entry");
		entries.set(name, Buffer.from(expanded.subarray(offset, offset + size)));
		offset += size + padding;
	}
}

export interface VerifiedProviderContractArchive {
	readonly bundle: VerifiedProviderContractBundle;
	readonly archiveSha256: string;
}

/** Verifies a local `gentle-ai-review-provider-contract-<semver>.tar.gz` archive in memory. */
export function verifyProviderContractBundleArchive(archivePath: string): VerifiedProviderContractArchive {
	const details = lstatSync(archivePath);
	if (details.isSymbolicLink() || !details.isFile()) invalid("archive is not a regular file");
	if (details.size > MAX_ARCHIVE_BYTES) invalid("archive exceeds its size limit");
	const compressed = readFileSync(archivePath);
	let expanded: Buffer;
	try {
		expanded = gunzipSync(compressed, { maxOutputLength: MAX_BUNDLE_BYTES + 1 });
	} catch {
		invalid("archive is not a readable gzip stream within the bundle size limit");
	}
	if (expanded.length > MAX_BUNDLE_BYTES) invalid("expanded tar exceeds the bundle size limit");
	const entries = readTarEntries(expanded);
	return {
		bundle: verifyProviderContractBundleEntries(entries),
		archiveSha256: sha256Hex(compressed),
	};
}

// --- generated consumer contract surface (P2) ---------------------------------

export const PROVIDER_ROLES_BASELINE_SCHEMA = "gentle-pi.provider-contract-roles-baseline/v1";
export const PROVIDER_CAPABILITIES_BASELINE_SCHEMA = "gentle-pi.provider-contract-capabilities-baseline/v1";
export const PROVIDER_ROLES_BASELINE_FILE = "provider-roles.baseline.json";
export const PROVIDER_CAPABILITIES_BASELINE_FILE = "provider-capabilities.baseline.json";

function runtimeFileBaseline(
	bundle: VerifiedProviderContractBundle,
	inventory: RuntimeFileInventory,
	texts: ReadonlyMap<string, string>,
): { runtime: string; path: string; sha256: string | undefined }[] {
	return [...texts.keys()].sort().map((runtime) => ({
		runtime,
		path: `${inventory}/${runtime}.md`,
		sha256: bundle.entrySha256.get(`${inventory}/${runtime}.md`),
	}));
}

/**
 * Deterministically derives the provider-owned consumer contract surface from
 * a verified bundle. Pi overlays never live in these files; they are pure
 * projections of the provider bundle and are regenerated, never hand-edited.
 */
export function generateProviderContractBaselines(bundle: VerifiedProviderContractBundle): ReadonlyMap<string, string> {
	const roles = {
		schema: PROVIDER_ROLES_BASELINE_SCHEMA,
		contract_semver: bundle.contractSemver,
		roles: bundle.roles.map((role) => ({
			id: role.id,
			request_schema_id: role.requestSchemaId,
			result_schema_id: role.resultSchemaId,
			required_capabilities: [...role.requiredCapabilities],
			schema_path: role.schemaPath,
			schema_sha256: role.schemaSha256,
			vector_path: role.vectorPath,
			vector_sha256: role.vectorSha256,
		})),
	};
	const mandatory = [...new Set(bundle.roles.flatMap((role) => [...role.requiredCapabilities]))].sort();
	const capabilities = {
		schema: PROVIDER_CAPABILITIES_BASELINE_SCHEMA,
		contract_semver: bundle.contractSemver,
		transport_capability: bundle.transportCapability,
		mandatory_capabilities: mandatory,
		runtimes: bundle.runtimes === undefined ? null : [...bundle.runtimes],
		pi_registered: piRuntimeRegistration(bundle).registered,
		orchestration: runtimeFileBaseline(bundle, "orchestration", bundle.orchestration),
		routing: runtimeFileBaseline(bundle, "routing", bundle.routing),
	};
	return new Map([
		[PROVIDER_ROLES_BASELINE_FILE, `${JSON.stringify(roles, null, 2)}\n`],
		[PROVIDER_CAPABILITIES_BASELINE_FILE, `${JSON.stringify(capabilities, null, 2)}\n`],
	]);
}
