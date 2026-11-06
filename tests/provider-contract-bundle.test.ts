import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
	PI_RUNTIME_IDENTITY,
	PROVIDER_CONTRACT_BUNDLE_INVALID,
	PROVIDER_CONTRACT_ROLE_IDS,
	PROVIDER_TRANSPORT_CAPABILITY,
	generateProviderContractBaselines,
	piRuntimeRegistration,
	verifyProviderContractBundleArchive,
	verifyProviderContractBundleEntries,
	verifyProviderContractBundleTree,
} from "../lib/provider-contract-bundle.ts";

// Fixture provenance: generated from gentle-ai main (contract 1.1.0) with
// `go run ./internal/providercontractbundlecmd generate --out <dir>`.
const FIXTURE_ROOT = join(import.meta.dirname, "fixtures", "provider-contract-bundle", "v1.1.0");
const FIXTURE_PATHS = [
	"README.md",
	"manifest.json",
	"schemas/lens.schema.json",
	"schemas/refuter.schema.json",
	"schemas/targeted-validator.schema.json",
	"vectors/lens.json",
	"vectors/refuter.json",
	"vectors/targeted-validator.json",
] as const;

function fixtureEntries(): Map<string, Buffer> {
	return new Map(FIXTURE_PATHS.map((path) => [path, readFileSync(join(FIXTURE_ROOT, path))]));
}

// Fixture provenance: the real gentle-ai provider contract bundle 1.2.0
// release archive (contract semver 1.2.0), extracted. Adds `orchestration`
// to the manifest: gentle-pi#560 / gentle-ai#4056, #4057.
const FIXTURE_1_2_0_ROOT = join(import.meta.dirname, "fixtures", "provider-contract-bundle", "v1.2.0");
const FIXTURE_1_2_0_PATHS = [...FIXTURE_PATHS, "orchestration/pi.md"] as const;

function fixture120Entries(): Map<string, Buffer> {
	return new Map(FIXTURE_1_2_0_PATHS.map((path) => [path, readFileSync(join(FIXTURE_1_2_0_ROOT, path))]));
}

// Fixture provenance: the gentle-ai provider contract bundle 1.4.0 archive
// built by goreleaser (archives `review-provider-contract`) from gentle-ai
// 9e6f24f6, extracted. Adds `routing` to the manifest: Pi's ODD routing steps.
const FIXTURE_1_4_0_ROOT = join(import.meta.dirname, "fixtures", "provider-contract-bundle", "v1.4.0");
const FIXTURE_1_4_0_PATHS = [...FIXTURE_1_2_0_PATHS, "routing/pi.md"] as const;

function fixture140Entries(): Map<string, Buffer> {
	return new Map(FIXTURE_1_4_0_PATHS.map((path) => [path, readFileSync(join(FIXTURE_1_4_0_ROOT, path))]));
}

// A valid 1.3.0-shaped bundle: the 1.4.0 fixture without the routing field and file.
function contractOneThreeEntries(): Map<string, Buffer> {
	const entries = withManifest(fixture140Entries(), (manifest) => {
		manifest.contract_semver = "1.3.0";
		delete manifest.routing;
	});
	entries.delete("routing/pi.md");
	return entries;
}

function sha256Hex(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function withManifest(entries: Map<string, Buffer>, mutate: (manifest: Record<string, unknown>) => void): Map<string, Buffer> {
	const manifest = JSON.parse((entries.get("manifest.json") as Buffer).toString("utf8")) as Record<string, unknown>;
	mutate(manifest);
	entries.set("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
	return entries;
}

// A valid 1.0.0-shaped bundle: the manifest predates the runtime registry.
function contractOneZeroEntries(): Map<string, Buffer> {
	return withManifest(fixtureEntries(), (manifest) => {
		manifest.contract_semver = "1.0.0";
		delete manifest.runtimes;
	});
}

function assertRejects(entries: Map<string, Buffer>, messagePart: string): void {
	assert.throws(
		() => verifyProviderContractBundleEntries(entries),
		(error: unknown) =>
			error instanceof Error &&
			error.message.startsWith(`${PROVIDER_CONTRACT_BUNDLE_INVALID}:`) &&
			error.message.includes(messagePart),
		`expected rejection mentioning ${JSON.stringify(messagePart)}`,
	);
}

// --- minimal deterministic tar.gz writer for archive-leg tests ---------------

interface TarEntry {
	readonly name: string;
	readonly bytes: Buffer;
	readonly mode?: number;
	readonly typeflag?: string;
}

function tarHeader(entry: TarEntry): Buffer {
	const header = Buffer.alloc(512);
	header.write(entry.name, 0, "ascii");
	header.write(`${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100, "ascii");
	header.write("0000000\0", 108, "ascii");
	header.write("0000000\0", 116, "ascii");
	header.write(`${entry.bytes.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
	header.write("00000000000\0", 136, "ascii");
	header.write("        ", 148, "ascii");
	header.write(entry.typeflag ?? "0", 156, "ascii");
	header.write("ustar\0", 257, "ascii");
	header.write("00", 263, "ascii");
	let checksum = 0;
	for (const byte of header) checksum += byte;
	header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
	return header;
}

function buildTarGz(entries: readonly TarEntry[], trailingBytes = Buffer.alloc(0)): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		blocks.push(tarHeader(entry));
		const padding = (512 - (entry.bytes.length % 512)) % 512;
		blocks.push(entry.bytes, Buffer.alloc(padding));
	}
	blocks.push(Buffer.alloc(1024), trailingBytes);
	return gzipSync(Buffer.concat(blocks));
}

function fixtureArchive(): Buffer {
	return buildTarGz([...fixtureEntries()].map(([name, bytes]) => ({ name, bytes })));
}

function withTemporaryDirectory<T>(run: (directory: string) => T): T {
	const directory = mkdtempSync(join(tmpdir(), "gentle-pi-provider-bundle-"));
	try {
		return run(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function materialize(entries: Map<string, Buffer>, directory: string): void {
	for (const [name, bytes] of entries) {
		const destination = join(directory, ...name.split("/"));
		mkdirSync(dirname(destination), { recursive: true });
		writeFileSync(destination, bytes);
		chmodSync(destination, 0o644);
	}
}

// --- positive legs ------------------------------------------------------------

test("verifies the generated 1.1.0 fixture tree and reports the exact contract surface", () => {
	const bundle = verifyProviderContractBundleTree(FIXTURE_ROOT);
	assert.equal(bundle.contractSemver, "1.1.0");
	assert.deepEqual([bundle.major, bundle.minor, bundle.patch], [1, 1, 0]);
	assert.equal(bundle.transportCapability, PROVIDER_TRANSPORT_CAPABILITY);
	assert.deepEqual(bundle.runtimes, ["claude-code", "codex", "opencode", PI_RUNTIME_IDENTITY]);
	assert.deepEqual(bundle.roles.map((role) => role.id), [...PROVIDER_CONTRACT_ROLE_IDS]);
	assert.equal(bundle.entries.size, 8);
	for (const role of bundle.roles) {
		assert.equal(bundle.entrySha256.get(role.schemaPath), role.schemaSha256);
		assert.equal(bundle.entrySha256.get(role.vectorPath), role.vectorSha256);
		assert.deepEqual(role.requiredCapabilities, [PROVIDER_TRANSPORT_CAPABILITY]);
	}
	assert.match(bundle.treeSha256, /^[0-9a-f]{64}$/);
	assert.deepEqual(piRuntimeRegistration(bundle), { registered: true });
});

test("verifies the same bundle as an in-memory-read archive and reports the archive digest", () => {
	withTemporaryDirectory((directory) => {
		const archiveBytes = fixtureArchive();
		const archivePath = join(directory, "gentle-ai-review-provider-contract-1.1.0.tar.gz");
		writeFileSync(archivePath, archiveBytes);
		const { bundle, archiveSha256 } = verifyProviderContractBundleArchive(archivePath);
		assert.equal(archiveSha256, sha256Hex(archiveBytes));
		const tree = verifyProviderContractBundleTree(FIXTURE_ROOT);
		assert.equal(bundle.treeSha256, tree.treeSha256);
		assert.deepEqual([...bundle.entrySha256.entries()], [...tree.entrySha256.entries()]);
	});
});

test("a 1.0.0 manifest without runtimes is a VALID bundle, but pi is reported unregistered for relay trust", () => {
	const bundle = verifyProviderContractBundleEntries(contractOneZeroEntries());
	assert.equal(bundle.contractSemver, "1.0.0");
	assert.equal(bundle.runtimes, undefined);
	const registration = piRuntimeRegistration(bundle);
	assert.equal(registration.registered, false);
	assert.match(registration.reason ?? "", /predates the runtime identity registry/);
	assert.match(registration.reason ?? "", /must not trust/);
});

test("generated baselines project roles, capabilities, and runtime registration deterministically", () => {
	const bundle = verifyProviderContractBundleTree(FIXTURE_ROOT);
	const baselines = generateProviderContractBaselines(bundle);
	assert.deepEqual([...baselines.keys()].sort(), ["provider-capabilities.baseline.json", "provider-roles.baseline.json"]);
	const roles = JSON.parse(baselines.get("provider-roles.baseline.json") as string) as { roles: { id: string; result_schema_id: string; schema_sha256: string }[] };
	assert.deepEqual(roles.roles.map((role) => role.id), [...PROVIDER_CONTRACT_ROLE_IDS]);
	const capabilities = JSON.parse(baselines.get("provider-capabilities.baseline.json") as string) as Record<string, unknown>;
	assert.equal(capabilities.transport_capability, PROVIDER_TRANSPORT_CAPABILITY);
	assert.deepEqual(capabilities.mandatory_capabilities, [PROVIDER_TRANSPORT_CAPABILITY]);
	assert.equal(capabilities.pi_registered, true);
	assert.deepEqual(capabilities.orchestration, []);
	// Byte determinism: regenerating from the same bundle is identical.
	const again = generateProviderContractBaselines(verifyProviderContractBundleTree(FIXTURE_ROOT));
	assert.deepEqual([...again.entries()], [...baselines.entries()]);
});

test("generated 1.2.0 baselines record the mirrored orchestration entry", () => {
	const bundle = verifyProviderContractBundleTree(FIXTURE_1_2_0_ROOT);
	const baselines = generateProviderContractBaselines(bundle);
	const capabilities = JSON.parse(baselines.get("provider-capabilities.baseline.json") as string) as { orchestration: { runtime: string; path: string; sha256: string }[] };
	assert.deepEqual(capabilities.orchestration, [
		{
			runtime: PI_RUNTIME_IDENTITY,
			path: "orchestration/pi.md",
			sha256: bundle.entrySha256.get("orchestration/pi.md"),
		},
	]);
});

// --- inventory and hash rejections ---------------------------------------------

test("rejects a ninth file in the inventory", () => {
	const entries = fixtureEntries();
	entries.set("extra.txt", Buffer.from("surprise\n"));
	assertRejects(entries, "9 files");
});

test("rejects a missing bundle entry", () => {
	const entries = fixtureEntries();
	entries.delete("vectors/lens.json");
	assertRejects(entries, "7 files");
});

test("rejects a bundle whose schema bytes do not match the manifest SHA-256", () => {
	const entries = fixtureEntries();
	const tampered = Buffer.from(entries.get("schemas/lens.schema.json") as Buffer);
	tampered[tampered.length - 2] = 0x20;
	entries.set("schemas/lens.schema.json", tampered);
	assertRejects(entries, "does not match its manifest SHA-256");
});

test("rejects a vector that no longer equals the schema's canonical example even when its hash is updated", () => {
	const entries = fixtureEntries();
	const vector = JSON.parse((entries.get("vectors/refuter.json") as Buffer).toString("utf8")) as Record<string, unknown>;
	vector.subject_hash = "0".repeat(64);
	const tampered = Buffer.from(`${JSON.stringify(vector)}\n`, "utf8");
	entries.set("vectors/refuter.json", tampered);
	withManifest(entries, (manifest) => {
		const roles = manifest.roles as { id: string; vector: { sha256: string } }[];
		(roles.find((role) => role.id === "refuter") as { vector: { sha256: string } }).vector.sha256 = sha256Hex(tampered);
	});
	assertRejects(entries, "does not equal the schema's canonical example");
});

// --- strict manifest decode ------------------------------------------------------

test("rejects unknown manifest fields", () => {
	assertRejects(
		withManifest(fixtureEntries(), (manifest) => {
			manifest.surprise = true;
		}),
		'unknown field "surprise"',
	);
});

test("rejects duplicate manifest JSON keys", () => {
	const entries = fixtureEntries();
	const text = (entries.get("manifest.json") as Buffer).toString("utf8");
	const duplicated = text.replace('"contract_semver"', '"schema": "gentle-ai.review-provider-contract-bundle/v1",\n  "contract_semver"');
	entries.set("manifest.json", Buffer.from(duplicated, "utf8"));
	assertRejects(entries, "duplicate key");
});

test("rejects an unpinned transport capability", () => {
	assertRejects(
		withManifest(fixtureEntries(), (manifest) => {
			manifest.transport_capability = "gentle-ai.provider-transport/v2";
		}),
		"transport_capability must be pinned",
	);
});

test("rejects an unsupported contract major", () => {
	assertRejects(
		withManifest(fixtureEntries(), (manifest) => {
			manifest.contract_semver = "2.0.0";
		}),
		"unsupported provider contract major 2",
	);
});

// --- runtimes registry rules -----------------------------------------------------

test("rejects a 1.1.0 manifest without the required runtimes registry", () => {
	assertRejects(
		withManifest(fixtureEntries(), (manifest) => {
			delete manifest.runtimes;
		}),
		"manifest.runtimes is required from contract 1.1.0",
	);
});

test("rejects a 1.1.0 manifest whose runtimes registry does not register pi", () => {
	assertRejects(
		withManifest(fixtureEntries(), (manifest) => {
			manifest.runtimes = ["claude-code", "codex", "opencode"];
		}),
		'does not register the "pi" runtime identity',
	);
});

test("rejects a 1.0.0 manifest that carries a runtimes registry it cannot have", () => {
	assertRejects(
		withManifest(fixtureEntries(), (manifest) => {
			manifest.contract_semver = "1.0.0";
		}),
		"manifest.runtimes is not part of contract 1.0.0",
	);
});

// --- roles and capabilities --------------------------------------------------------

test("rejects an unknown role id", () => {
	assertRejects(
		withManifest(fixtureEntries(), (manifest) => {
			(manifest.roles as { id: string }[])[1].id = "judge";
		}),
		'manifest role 1 is "judge"',
	);
});

test("rejects an unknown mandatory capability", () => {
	assertRejects(
		withManifest(fixtureEntries(), (manifest) => {
			(manifest.roles as { required_capabilities: string[] }[])[0].required_capabilities = [
				PROVIDER_TRANSPORT_CAPABILITY,
				"gentle-ai.telepathy/v1",
			];
		}),
		'unknown mandatory capability "gentle-ai.telepathy/v1"',
	);
});

test("rejects a schema whose $id does not match the manifest result schema id", () => {
	assertRejects(
		withManifest(fixtureEntries(), (manifest) => {
			(manifest.roles as { result_schema_id: string }[])[0].result_schema_id = "https://gentle-ai.dev/schema/review/other/v1";
		}),
		"$id does not match",
	);
});

// --- orchestration (contract 1.2.0) -------------------------------------------------

test("verifies the 1.2.0 fixture tree and exposes the mirrored pi orchestration text", () => {
	const bundle = verifyProviderContractBundleTree(FIXTURE_1_2_0_ROOT);
	assert.equal(bundle.contractSemver, "1.2.0");
	assert.deepEqual([bundle.major, bundle.minor, bundle.patch], [1, 2, 0]);
	assert.equal(bundle.entries.size, 9);
	assert.deepEqual([...bundle.orchestration.keys()], [PI_RUNTIME_IDENTITY]);
	const piText = bundle.orchestration.get(PI_RUNTIME_IDENTITY);
	assert.equal(piText, readFileSync(join(FIXTURE_1_2_0_ROOT, "orchestration/pi.md"), "utf8"));
	assert.equal(bundle.entrySha256.get("orchestration/pi.md"), sha256Hex(readFileSync(join(FIXTURE_1_2_0_ROOT, "orchestration/pi.md"))));
});

test("rejects a 1.2.0 manifest without the required orchestration array", () => {
	assertRejects(
		withManifest(fixture120Entries(), (manifest) => {
			delete manifest.orchestration;
		}),
		"manifest.orchestration is required from contract 1.2.0",
	);
});

test("rejects a 1.2.0 orchestration entry whose runtime is not registered in manifest.runtimes", () => {
	assertRejects(
		withManifest(fixture120Entries(), (manifest) => {
			const orchestration = manifest.orchestration as { runtime: string; file: { path: string } }[];
			orchestration[0]!.runtime = "aider";
			orchestration[0]!.file.path = "orchestration/aider.md";
		}),
		'manifest.orchestration[0].runtime "aider" is not registered in manifest.runtimes',
	);
});

test("rejects a 1.2.0 orchestration entry whose file bytes do not match its manifest SHA-256", () => {
	const entries = fixture120Entries();
	const tampered = Buffer.from(entries.get("orchestration/pi.md") as Buffer);
	tampered[tampered.length - 2] = 0x20;
	entries.set("orchestration/pi.md", tampered);
	assertRejects(entries, "does not match its manifest SHA-256");
});

test("rejects an orchestration array on a 1.1.0 manifest", () => {
	assertRejects(
		withManifest(fixtureEntries(), (manifest) => {
			manifest.orchestration = [
				{ runtime: PI_RUNTIME_IDENTITY, file: { path: "orchestration/pi.md", sha256: "0".repeat(64) } },
			];
		}),
		"manifest.orchestration is not part of contract 1.1.0",
	);
});

// --- routing (contract 1.4.0) ----------------------------------------------------------

test("verifies the 1.4.0 fixture tree and exposes the mirrored pi routing text", () => {
	const bundle = verifyProviderContractBundleTree(FIXTURE_1_4_0_ROOT);
	assert.equal(bundle.contractSemver, "1.4.0");
	assert.equal(bundle.entries.size, 10);
	assert.deepEqual([...bundle.orchestration.keys()], [PI_RUNTIME_IDENTITY]);
	assert.deepEqual([...bundle.routing.keys()], [PI_RUNTIME_IDENTITY]);
	assert.equal(bundle.routing.get(PI_RUNTIME_IDENTITY), readFileSync(join(FIXTURE_1_4_0_ROOT, "routing/pi.md"), "utf8"));
	assert.equal(bundle.entrySha256.get("routing/pi.md"), sha256Hex(readFileSync(join(FIXTURE_1_4_0_ROOT, "routing/pi.md"))));
});

test("verifies the 1.4.0 release archive in memory", () => {
	withTemporaryDirectory((directory) => {
		const archivePath = join(directory, "gentle-ai-review-provider-contract-1.4.0.tar.gz");
		writeFileSync(archivePath, buildTarGz([...fixture140Entries()].map(([name, bytes]) => ({ name, bytes }))));
		const { bundle } = verifyProviderContractBundleArchive(archivePath);
		assert.equal(bundle.contractSemver, "1.4.0");
		assert.deepEqual([...bundle.routing.keys()], [PI_RUNTIME_IDENTITY]);
	});
});

test("a 1.3.0 bundle without routing still verifies with an empty routing inventory", () => {
	const bundle = verifyProviderContractBundleEntries(contractOneThreeEntries());
	assert.equal(bundle.contractSemver, "1.3.0");
	assert.equal(bundle.entries.size, 9);
	assert.equal(bundle.routing.size, 0);
	assert.deepEqual([...bundle.orchestration.keys()], [PI_RUNTIME_IDENTITY]);
});

test("rejects a 1.4.0 manifest without the required routing array", () => {
	const entries = withManifest(fixture140Entries(), (manifest) => {
		delete manifest.routing;
	});
	assertRejects(entries, "manifest.routing is required from contract 1.4.0");
});

test("rejects a routing array on a 1.3.0 manifest", () => {
	const entries = withManifest(fixture140Entries(), (manifest) => {
		manifest.contract_semver = "1.3.0";
	});
	assertRejects(entries, "manifest.routing is not part of contract 1.3.0");
});

test("rejects a 1.4.0 routing entry whose runtime is not registered in manifest.runtimes", () => {
	assertRejects(
		withManifest(fixture140Entries(), (manifest) => {
			const routing = manifest.routing as { runtime: string; file: { path: string } }[];
			routing[0]!.runtime = "aider";
			routing[0]!.file.path = "routing/aider.md";
		}),
		'manifest.routing[0].runtime "aider" is not registered in manifest.runtimes',
	);
});

test("rejects a 1.4.0 routing entry that points outside routing/<runtime>.md", () => {
	assertRejects(
		withManifest(fixture140Entries(), (manifest) => {
			(manifest.routing as { file: { path: string } }[])[0]!.file.path = "orchestration/pi.md";
		}),
		'manifest.routing[0].file.path must be "routing/pi.md"',
	);
});

test("rejects a 1.4.0 routing entry whose file bytes do not match its manifest SHA-256", () => {
	const entries = fixture140Entries();
	const tampered = Buffer.from(entries.get("routing/pi.md") as Buffer);
	tampered[tampered.length - 2] = 0x20;
	entries.set("routing/pi.md", tampered);
	assertRejects(entries, "does not match its manifest SHA-256");
});

test("rejects a 1.4.0 bundle missing its routing file", () => {
	const entries = fixture140Entries();
	entries.delete("routing/pi.md");
	assertRejects(entries, "bundle inventory has 9 files; exactly 10 are expected");
});

test("the raw-entry bound leaves room for one routing file per runtime before the exact count decides", () => {
	const entries = fixture140Entries();
	for (let index = 0; index < 70; index += 1) entries.set(`extra/${index}.md`, Buffer.from("x\n"));
	assertRejects(entries, "bundle inventory has 80 files; exactly 10 are expected");
});

test("generated 1.4.0 baselines record the mirrored routing entry", () => {
	const bundle = verifyProviderContractBundleTree(FIXTURE_1_4_0_ROOT);
	const capabilities = JSON.parse(
		generateProviderContractBaselines(bundle).get("provider-capabilities.baseline.json") as string,
	) as { routing: { runtime: string; path: string; sha256: string }[] };
	assert.deepEqual(capabilities.routing, [
		{ runtime: PI_RUNTIME_IDENTITY, path: "routing/pi.md", sha256: bundle.entrySha256.get("routing/pi.md") },
	]);
	const older = JSON.parse(
		generateProviderContractBaselines(verifyProviderContractBundleTree(FIXTURE_1_2_0_ROOT)).get("provider-capabilities.baseline.json") as string,
	) as { routing: unknown[] };
	assert.deepEqual(older.routing, []);
});

// --- archive safety ------------------------------------------------------------------

test("rejects a tar entry that escapes the bundle root", () => {
	withTemporaryDirectory((directory) => {
		const entries = [...fixtureEntries()].map(([name, bytes]) => ({ name, bytes }));
		entries.push({ name: "../evil.txt", bytes: Buffer.from("escape\n") });
		const archivePath = join(directory, "escape.tar.gz");
		writeFileSync(archivePath, buildTarGz(entries));
		assert.throws(() => verifyProviderContractBundleArchive(archivePath), /is unsafe/);
	});
});

test("rejects a non-regular tar entry (symlink typeflag)", () => {
	withTemporaryDirectory((directory) => {
		const entries = [...fixtureEntries()].map(([name, bytes]) => ({ name, bytes } as { name: string; bytes: Buffer; typeflag?: string }));
		(entries[0] as { typeflag?: string }).typeflag = "2";
		const archivePath = join(directory, "symlink.tar.gz");
		writeFileSync(archivePath, buildTarGz(entries));
		assert.throws(() => verifyProviderContractBundleArchive(archivePath), /type "2" is forbidden/);
	});
});

test("rejects an executable or setuid tar entry mode", () => {
	withTemporaryDirectory((directory) => {
		const entries = [...fixtureEntries()].map(([name, bytes]) => ({ name, bytes } as { name: string; bytes: Buffer; mode?: number }));
		(entries[2] as { mode?: number }).mode = 0o4755;
		const archivePath = join(directory, "setuid.tar.gz");
		writeFileSync(archivePath, buildTarGz(entries));
		assert.throws(() => verifyProviderContractBundleArchive(archivePath), /unsafe file mode/);
	});
});

test("rejects trailing data after the tar terminator", () => {
	withTemporaryDirectory((directory) => {
		const archivePath = join(directory, "trailing.tar.gz");
		writeFileSync(archivePath, buildTarGz([...fixtureEntries()].map(([name, bytes]) => ({ name, bytes })), Buffer.from("smuggled")));
		assert.throws(() => verifyProviderContractBundleArchive(archivePath), /data after its terminator/);
	});
});

test("rejects a duplicated tar entry path", () => {
	withTemporaryDirectory((directory) => {
		const entries = [...fixtureEntries()].map(([name, bytes]) => ({ name, bytes }));
		entries.push({ name: "README.md", bytes: Buffer.from("second\n") });
		const archivePath = join(directory, "duplicate.tar.gz");
		writeFileSync(archivePath, buildTarGz(entries));
		assert.throws(() => verifyProviderContractBundleArchive(archivePath), /duplicated|more than 8/);
	});
});

// --- extracted tree safety --------------------------------------------------------------

test("rejects a bundle tree containing a symlink", { skip: process.platform === "win32" }, () => {
	withTemporaryDirectory((directory) => {
		materialize(fixtureEntries(), directory);
		rmSync(join(directory, "README.md"));
		symlinkSync(join(directory, "manifest.json"), join(directory, "README.md"));
		assert.throws(() => verifyProviderContractBundleTree(directory), /is a symlink/);
	});
});

test("rejects a bundle tree entry with an executable mode", { skip: process.platform === "win32" }, () => {
	withTemporaryDirectory((directory) => {
		materialize(fixtureEntries(), directory);
		chmodSync(join(directory, "schemas/lens.schema.json"), 0o755);
		assert.throws(() => verifyProviderContractBundleTree(directory), /unsafe file mode/);
	});
});
