#!/usr/bin/env node
// Field-test acquisition of the drakonc-ai provider contract bundle
// (drakonc-pi#311 P1/P2).
//
// This script NEVER fetches anything from the network and NEVER touches the
// Drakonc AI release pin (scripts/drakonc-ai-installer.mjs INSTALLER_VERSION).
// RC and main-built bundles are field-test input only: you pass an explicit
// LOCAL path to a `drakonc-ai-review-provider-contract-<semver>.tar.gz` archive
// or to an already-extracted bundle tree, the bundle is strictly verified,
// and only then is the verified mirror written under
// `contracts/review-provider-contract-mirror/` together with a lock record
// (contract semver, archive digest when mirroring an archive, tree digest,
// per-entry digests, generated baseline digests, runtime registry).
//
// Usage:
//   node scripts/mirror-provider-contract.mjs --bundle <local archive or tree> [--root <package root>]

import { lstatSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	generateProviderContractBaselines,
	piRuntimeRegistration,
	verifyProviderContractBundleArchive,
	verifyProviderContractBundleTree,
} from "../lib/provider-contract-bundle.ts";

export const PROVIDER_CONTRACT_MIRROR_ROOT = "contracts/review-provider-contract-mirror";
export const PROVIDER_CONTRACT_LOCK_FILE = "provider-contract.lock.json";
export const PROVIDER_CONTRACT_LOCK_SCHEMA = "gentle-pi.review-provider-contract-mirror-lock/v1";
// This script exists for field-test consumption only; the lock says so
// explicitly so nothing downstream mistakes it for a release pin.
export const PROVIDER_CONTRACT_ACQUISITION = "field-test-local";

function sha256Hex(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function parseArguments(argv) {
	const values = { bundle: undefined, root: undefined };
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if ((flag !== "--bundle" && flag !== "--root") || value === undefined) {
			throw new Error("usage: node scripts/mirror-provider-contract.mjs --bundle <local archive or tree> [--root <package root>]");
		}
		if (values[flag.slice(2)] !== undefined) throw new Error(`duplicate ${flag} argument`);
		values[flag.slice(2)] = value;
	}
	if (values.bundle === undefined) {
		throw new Error("usage: node scripts/mirror-provider-contract.mjs --bundle <local archive or tree> [--root <package root>]");
	}
	return values;
}

function verifyLocalBundle(bundlePath) {
	const details = lstatSync(bundlePath);
	if (details.isDirectory()) {
		return { bundle: verifyProviderContractBundleTree(bundlePath), source: { kind: "tree" } };
	}
	const { bundle, archiveSha256 } = verifyProviderContractBundleArchive(bundlePath);
	return { bundle, source: { kind: "archive", archive_sha256: archiveSha256 } };
}

function sortedRecord(map) {
	return Object.fromEntries([...map.entries()].sort(([left], [right]) => (left < right ? -1 : 1)));
}

export function buildLockRecord(bundle, source, generatedSha256) {
	return {
		schema: PROVIDER_CONTRACT_LOCK_SCHEMA,
		acquisition: PROVIDER_CONTRACT_ACQUISITION,
		contract_semver: bundle.contractSemver,
		source,
		tree_sha256: bundle.treeSha256,
		entries: sortedRecord(bundle.entrySha256),
		generated: sortedRecord(generatedSha256),
		runtimes: [...(bundle.runtimes ?? [])],
		pi_registered: piRuntimeRegistration(bundle).registered,
	};
}

export function mirrorProviderContractBundle(bundlePath, packageRoot) {
	const { bundle, source } = verifyLocalBundle(bundlePath);
	const registration = piRuntimeRegistration(bundle);
	if (!registration.registered) {
		throw new Error(
			`refusing to mirror provider contract ${bundle.contractSemver}: ${registration.reason ?? "the pi runtime identity is not registered"}`,
		);
	}

	const mirrorRoot = join(resolve(packageRoot), ...PROVIDER_CONTRACT_MIRROR_ROOT.split("/"));
	const versionRoot = join(mirrorRoot, `v${bundle.contractSemver}`);
	const bundleRoot = join(versionRoot, "bundle");
	const generatedRoot = join(versionRoot, "generated");

	// Single locked version policy: the mirror directory holds exactly one
	// verified bundle plus its lock, so rebuild it from scratch every time.
	rmSync(mirrorRoot, { recursive: true, force: true });

	// Confined materialization: entries come exclusively from the verified
	// in-memory inventory whose paths already passed canonical-path checks, so
	// no archive metadata ever steers a write location or a file mode.
	for (const [name, payload] of bundle.entries) {
		const destination = join(bundleRoot, ...name.split("/"));
		mkdirSync(dirname(destination), { recursive: true });
		writeFileSync(destination, payload, { flag: "wx" });
		chmodSync(destination, 0o644);
	}

	const baselines = generateProviderContractBaselines(bundle);
	const generatedSha256 = new Map();
	for (const [name, payload] of baselines) {
		const destination = join(generatedRoot, name);
		mkdirSync(generatedRoot, { recursive: true });
		writeFileSync(destination, payload, { flag: "wx" });
		chmodSync(destination, 0o644);
		generatedSha256.set(`generated/${name}`, sha256Hex(Buffer.from(payload, "utf8")));
	}

	const lock = buildLockRecord(bundle, source, generatedSha256);
	const lockPath = join(mirrorRoot, PROVIDER_CONTRACT_LOCK_FILE);
	writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx" });
	chmodSync(lockPath, 0o644);

	return { bundle, source, lock, mirrorRoot };
}

async function main() {
	const packageRoot = join(fileURLToPath(new URL("..", import.meta.url)));
	const { bundle: bundlePath, root } = parseArguments(process.argv.slice(2));
	const { bundle, source, mirrorRoot } = mirrorProviderContractBundle(resolve(bundlePath), root ?? packageRoot);
	console.log(
		`Mirrored provider contract ${bundle.contractSemver} (${source.kind}${source.kind === "archive" ? ` ${source.archive_sha256}` : ""}) into ${mirrorRoot}`,
	);
	console.log(`tree ${bundle.treeSha256}; runtimes ${(bundle.runtimes ?? []).join(", ")}; acquisition ${PROVIDER_CONTRACT_ACQUISITION}`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
	await main();
}
