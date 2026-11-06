import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { checkProviderContractMirror } from "../scripts/check-provider-contract.mjs";
import {
	PROVIDER_CONTRACT_ACQUISITION,
	PROVIDER_CONTRACT_LOCK_FILE,
	PROVIDER_CONTRACT_LOCK_SCHEMA,
	PROVIDER_CONTRACT_MIRROR_ROOT,
	mirrorProviderContractBundle,
} from "../scripts/mirror-provider-contract.mjs";

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

// Fixture provenance: the real gentle-ai provider contract bundle 1.2.0
// release archive, extracted. gentle-pi#560 / gentle-ai#4056, #4057.
const FIXTURE_1_2_0_ROOT = join(import.meta.dirname, "fixtures", "provider-contract-bundle", "v1.2.0");

// Fixture provenance: the gentle-ai provider contract bundle 1.4.0 archive
// built by goreleaser, extracted. Adds Pi's ODD routing block as routing/pi.md.
const FIXTURE_1_4_0_ROOT = join(import.meta.dirname, "fixtures", "provider-contract-bundle", "v1.4.0");

interface LockRecord {
	schema: string;
	acquisition: string;
	contract_semver: string;
	source: { kind: string; archive_sha256?: string };
	tree_sha256: string;
	entries: Record<string, string>;
	generated: Record<string, string>;
	runtimes: string[];
	pi_registered: boolean;
}

function withTemporaryRoot<T>(run: (packageRoot: string) => T): T {
	const packageRoot = mkdtempSync(join(tmpdir(), "gentle-pi-provider-mirror-"));
	try {
		return run(packageRoot);
	} finally {
		rmSync(packageRoot, { recursive: true, force: true });
	}
}

function mirrorFixtureInto(packageRoot: string): LockRecord {
	mirrorProviderContractBundle(FIXTURE_ROOT, packageRoot);
	const lockPath = join(packageRoot, PROVIDER_CONTRACT_MIRROR_ROOT, PROVIDER_CONTRACT_LOCK_FILE);
	return JSON.parse(readFileSync(lockPath, "utf8")) as LockRecord;
}

function tarHeader(name: string, bytes: Buffer): Buffer {
	const header = Buffer.alloc(512);
	header.write(name, 0, "ascii");
	header.write("0000644\0", 100, "ascii");
	header.write("0000000\0", 108, "ascii");
	header.write("0000000\0", 116, "ascii");
	header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
	header.write("00000000000\0", 136, "ascii");
	header.write("        ", 148, "ascii");
	header.write("0", 156, "ascii");
	header.write("ustar\0", 257, "ascii");
	header.write("00", 263, "ascii");
	let checksum = 0;
	for (const byte of header) checksum += byte;
	header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
	return header;
}

function fixtureArchiveBytes(): Buffer {
	const blocks: Buffer[] = [];
	for (const path of FIXTURE_PATHS) {
		const bytes = readFileSync(join(FIXTURE_ROOT, path));
		blocks.push(tarHeader(path, bytes), bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

test("mirrors a verified local bundle tree and the offline drift check passes", () => {
	withTemporaryRoot((packageRoot) => {
		const lock = mirrorFixtureInto(packageRoot);
		assert.equal(lock.schema, PROVIDER_CONTRACT_LOCK_SCHEMA);
		assert.equal(lock.acquisition, PROVIDER_CONTRACT_ACQUISITION);
		assert.equal(lock.contract_semver, "1.1.0");
		assert.deepEqual(lock.source, { kind: "tree" });
		assert.equal(lock.pi_registered, true);
		assert.deepEqual(lock.runtimes, ["claude-code", "codex", "opencode", "pi"]);
		assert.equal(Object.keys(lock.entries).length, 8);
		assert.deepEqual(Object.keys(lock.generated).sort(), [
			"generated/provider-capabilities.baseline.json",
			"generated/provider-roles.baseline.json",
		]);
		for (const path of FIXTURE_PATHS) {
			const mirrored = join(packageRoot, PROVIDER_CONTRACT_MIRROR_ROOT, "v1.1.0", "bundle", path);
			assert.ok(existsSync(mirrored), `${path} must be mirrored`);
			assert.deepEqual(readFileSync(mirrored), readFileSync(join(FIXTURE_ROOT, path)), `${path} must be byte-identical`);
		}
		assert.deepEqual(checkProviderContractMirror(packageRoot), []);
	});
});

test("mirrors a verified local 1.2.0 bundle tree, including its orchestration entry, and the offline drift check passes", () => {
	withTemporaryRoot((packageRoot) => {
		mirrorProviderContractBundle(FIXTURE_1_2_0_ROOT, packageRoot);
		const lockPath = join(packageRoot, PROVIDER_CONTRACT_MIRROR_ROOT, PROVIDER_CONTRACT_LOCK_FILE);
		const lock = JSON.parse(readFileSync(lockPath, "utf8")) as LockRecord;
		assert.equal(lock.contract_semver, "1.2.0");
		assert.equal(Object.keys(lock.entries).length, 9);
		assert.ok("orchestration/pi.md" in lock.entries, "the mirrored lock must record orchestration/pi.md");
		const mirrored = join(packageRoot, PROVIDER_CONTRACT_MIRROR_ROOT, "v1.2.0", "bundle", "orchestration", "pi.md");
		assert.ok(existsSync(mirrored), "orchestration/pi.md must be mirrored");
		assert.deepEqual(readFileSync(mirrored), readFileSync(join(FIXTURE_1_2_0_ROOT, "orchestration", "pi.md")));
		assert.deepEqual(checkProviderContractMirror(packageRoot), []);
	});
});

test("mirrors a verified local 1.4.0 bundle tree, including its routing entry, and the offline drift check passes", () => {
	withTemporaryRoot((packageRoot) => {
		mirrorProviderContractBundle(FIXTURE_1_4_0_ROOT, packageRoot);
		const lock = JSON.parse(
			readFileSync(join(packageRoot, PROVIDER_CONTRACT_MIRROR_ROOT, PROVIDER_CONTRACT_LOCK_FILE), "utf8"),
		) as LockRecord;
		assert.equal(lock.contract_semver, "1.4.0");
		assert.equal(Object.keys(lock.entries).length, 10);
		assert.ok("routing/pi.md" in lock.entries, "the mirrored lock must record routing/pi.md");
		const mirrored = join(packageRoot, PROVIDER_CONTRACT_MIRROR_ROOT, "v1.4.0", "bundle", "routing", "pi.md");
		assert.deepEqual(readFileSync(mirrored), readFileSync(join(FIXTURE_1_4_0_ROOT, "routing", "pi.md")));
		assert.deepEqual(checkProviderContractMirror(packageRoot), []);

		writeFileSync(mirrored, `${readFileSync(mirrored, "utf8")}tampered\n`);
		const problems = checkProviderContractMirror(packageRoot);
		assert.equal(problems.length, 1);
		assert.match(problems[0] ?? "", /mirrored bundle failed verification: .*"routing\/pi\.md" does not match its manifest SHA-256/);
	});
});

test("mirrors a verified local archive and records the archive digest in the lock", () => {
	withTemporaryRoot((packageRoot) => {
		const archivePath = join(packageRoot, "gentle-ai-review-provider-contract-1.1.0.tar.gz");
		writeFileSync(archivePath, fixtureArchiveBytes());
		mirrorProviderContractBundle(archivePath, packageRoot);
		const lock = JSON.parse(
			readFileSync(join(packageRoot, PROVIDER_CONTRACT_MIRROR_ROOT, PROVIDER_CONTRACT_LOCK_FILE), "utf8"),
		) as LockRecord;
		assert.equal(lock.source.kind, "archive");
		assert.match(lock.source.archive_sha256 ?? "", /^[0-9a-f]{64}$/);
		assert.deepEqual(checkProviderContractMirror(packageRoot), []);
	});
});

test("refuses to mirror a 1.0.0 bundle because the pi runtime identity is not registered", () => {
	withTemporaryRoot((packageRoot) => {
		const bundleRoot = join(packageRoot, "bundle-1.0.0");
		for (const path of FIXTURE_PATHS) {
			const destination = join(bundleRoot, ...path.split("/"));
			mkdirSync(dirname(destination), { recursive: true });
			writeFileSync(destination, readFileSync(join(FIXTURE_ROOT, path)));
			chmodSync(destination, 0o644);
		}
		const manifest = JSON.parse(readFileSync(join(bundleRoot, "manifest.json"), "utf8")) as Record<string, unknown>;
		manifest.contract_semver = "1.0.0";
		delete manifest.runtimes;
		writeFileSync(join(bundleRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

		assert.throws(
			() => mirrorProviderContractBundle(bundleRoot, packageRoot),
			/refusing to mirror provider contract 1\.0\.0.*not registered/s,
		);
		assert.ok(!existsSync(join(packageRoot, PROVIDER_CONTRACT_MIRROR_ROOT)), "no partial mirror may be written");
	});
});

test("drift check fails when a mirrored schema byte changes", () => {
	withTemporaryRoot((packageRoot) => {
		mirrorFixtureInto(packageRoot);
		const schemaPath = join(packageRoot, PROVIDER_CONTRACT_MIRROR_ROOT, "v1.1.0", "bundle", "schemas", "lens.schema.json");
		writeFileSync(schemaPath, `${readFileSync(schemaPath).toString("utf8")} `);
		const problems = checkProviderContractMirror(packageRoot);
		assert.ok(problems.length > 0);
		assert.match(problems.join("\n"), /failed verification/);
	});
});

test("drift check fails when a generated baseline is edited by hand", () => {
	withTemporaryRoot((packageRoot) => {
		mirrorFixtureInto(packageRoot);
		const baselinePath = join(
			packageRoot,
			PROVIDER_CONTRACT_MIRROR_ROOT,
			"v1.1.0",
			"generated",
			"provider-capabilities.baseline.json",
		);
		const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, unknown>;
		baseline.pi_registered = false;
		writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
		const problems = checkProviderContractMirror(packageRoot);
		assert.match(problems.join("\n"), /provider-capabilities\.baseline\.json/);
		assert.match(problems.join("\n"), /not byte-identical|drifted/);
	});
});

test("drift check fails when the lock record disagrees with the mirror", () => {
	withTemporaryRoot((packageRoot) => {
		const lock = mirrorFixtureInto(packageRoot);
		lock.tree_sha256 = "0".repeat(64);
		writeFileSync(
			join(packageRoot, PROVIDER_CONTRACT_MIRROR_ROOT, PROVIDER_CONTRACT_LOCK_FILE),
			`${JSON.stringify(lock, null, 2)}\n`,
		);
		const problems = checkProviderContractMirror(packageRoot);
		assert.match(problems.join("\n"), /tree digest .* does not match lock tree_sha256/);
	});
});

test("drift check fails on an unexpected file inside the mirror directory", () => {
	withTemporaryRoot((packageRoot) => {
		mirrorFixtureInto(packageRoot);
		writeFileSync(join(packageRoot, PROVIDER_CONTRACT_MIRROR_ROOT, "NOTES.md"), "overlay\n");
		const problems = checkProviderContractMirror(packageRoot);
		assert.match(problems.join("\n"), /unexpected entry "NOTES\.md"/);
	});
});

test("drift check fails when the lock is missing entirely", () => {
	withTemporaryRoot((packageRoot) => {
		const problems = checkProviderContractMirror(packageRoot);
		assert.equal(problems.length, 1);
		assert.match(problems[0] as string, /provider-contract\.lock\.json is missing/);
	});
});

test("the committed repository mirror matches its lock and generated baselines", () => {
	assert.deepEqual(checkProviderContractMirror(join(import.meta.dirname, "..")), []);
});
