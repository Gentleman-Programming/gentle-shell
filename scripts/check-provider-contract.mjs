#!/usr/bin/env node
// Offline drift check for the mirrored drakonc-ai provider contract bundle
// (drakonc-pi#311 P2).
//
// Fails when the mirror, the lock record, the schemas, the vectors, or the
// generated consumer baselines disagree in any direction. Runs completely
// offline against `contracts/review-provider-contract-mirror/` and never
// touches the network or the Drakonc AI release pin.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	generateProviderContractBaselines,
	piRuntimeRegistration,
	verifyProviderContractBundleTree,
} from "../lib/provider-contract-bundle.ts";
import {
	PROVIDER_CONTRACT_ACQUISITION,
	PROVIDER_CONTRACT_LOCK_FILE,
	PROVIDER_CONTRACT_LOCK_SCHEMA,
	PROVIDER_CONTRACT_MIRROR_ROOT,
} from "./mirror-provider-contract.mjs";

function sha256Hex(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function recordEquals(problems, label, expected, actual) {
	const expectedKeys = Object.keys(expected).sort();
	const actualKeys = Object.keys(actual).sort();
	for (const key of expectedKeys) {
		if (!(key in actual)) problems.push(`${label}: ${key} is recorded in the lock but absent from the mirror`);
		else if (actual[key] !== expected[key]) problems.push(`${label}: ${key} drifted (lock ${expected[key]}, mirror ${actual[key]})`);
	}
	for (const key of actualKeys) {
		if (!(key in expected)) problems.push(`${label}: ${key} exists in the mirror but is not recorded in the lock`);
	}
}

// Returns a list of drift problems; an empty list means the mirror, lock,
// schemas, vectors, and generated baselines all agree.
export function checkProviderContractMirror(packageRoot) {
	const problems = [];
	const mirrorRoot = join(packageRoot, ...PROVIDER_CONTRACT_MIRROR_ROOT.split("/"));
	const lockPath = join(mirrorRoot, PROVIDER_CONTRACT_LOCK_FILE);
	if (!existsSync(lockPath)) {
		return [`${PROVIDER_CONTRACT_MIRROR_ROOT}/${PROVIDER_CONTRACT_LOCK_FILE} is missing; run scripts/mirror-provider-contract.mjs against a verified local bundle`];
	}

	let lock;
	try {
		lock = JSON.parse(readFileSync(lockPath, "utf8"));
	} catch (error) {
		return [`lock record is not valid JSON: ${error instanceof Error ? error.message : String(error)}`];
	}
	if (lock === null || typeof lock !== "object" || Array.isArray(lock)) return ["lock record is not a JSON object"];
	if (lock.schema !== PROVIDER_CONTRACT_LOCK_SCHEMA) problems.push(`lock schema is ${JSON.stringify(lock.schema)}; expected ${JSON.stringify(PROVIDER_CONTRACT_LOCK_SCHEMA)}`);
	if (lock.acquisition !== PROVIDER_CONTRACT_ACQUISITION) problems.push(`lock acquisition is ${JSON.stringify(lock.acquisition)}; expected ${JSON.stringify(PROVIDER_CONTRACT_ACQUISITION)}`);
	if (typeof lock.contract_semver !== "string") return [...problems, "lock contract_semver is not a string"];
	if (lock.pi_registered !== true) problems.push("lock does not record pi as a registered runtime identity");

	// The mirror directory must contain exactly the lock and the locked version.
	const expectedVersionDirectory = `v${lock.contract_semver}`;
	for (const entry of readdirSync(mirrorRoot)) {
		if (entry !== PROVIDER_CONTRACT_LOCK_FILE && entry !== expectedVersionDirectory) {
			problems.push(`mirror has unexpected entry ${JSON.stringify(entry)}; only ${PROVIDER_CONTRACT_LOCK_FILE} and ${expectedVersionDirectory} belong there`);
		}
	}

	const versionRoot = join(mirrorRoot, expectedVersionDirectory);
	let bundle;
	try {
		bundle = verifyProviderContractBundleTree(join(versionRoot, "bundle"));
	} catch (error) {
		return [...problems, `mirrored bundle failed verification: ${error instanceof Error ? error.message : String(error)}`];
	}

	if (bundle.contractSemver !== lock.contract_semver) {
		problems.push(`mirrored bundle declares contract ${bundle.contractSemver}; lock records ${lock.contract_semver}`);
	}
	if (bundle.treeSha256 !== lock.tree_sha256) {
		problems.push(`mirrored bundle tree digest ${bundle.treeSha256} does not match lock tree_sha256 ${lock.tree_sha256}`);
	}
	recordEquals(problems, "bundle entries", lock.entries ?? {}, Object.fromEntries(bundle.entrySha256));
	const lockRuntimes = Array.isArray(lock.runtimes) ? lock.runtimes : [];
	const bundleRuntimes = [...(bundle.runtimes ?? [])];
	if (JSON.stringify(lockRuntimes) !== JSON.stringify(bundleRuntimes)) {
		problems.push(`lock runtimes ${JSON.stringify(lockRuntimes)} do not match mirrored manifest runtimes ${JSON.stringify(bundleRuntimes)}`);
	}
	if (!piRuntimeRegistration(bundle).registered) {
		problems.push("mirrored bundle does not register the pi runtime identity");
	}

	// Regenerate the consumer contract surface from the verified mirror and
	// require byte-identical generated files plus matching lock digests.
	const baselines = generateProviderContractBaselines(bundle);
	const generatedRoot = join(versionRoot, "generated");
	const onDisk = existsSync(generatedRoot) ? readdirSync(generatedRoot).sort() : [];
	const expectedGenerated = [...baselines.keys()].sort();
	for (const name of onDisk) {
		if (!baselines.has(name)) problems.push(`generated/${name} exists on disk but is not a generated provider baseline`);
	}
	const actualGeneratedSha256 = {};
	for (const name of expectedGenerated) {
		const path = join(generatedRoot, name);
		if (!existsSync(path)) {
			problems.push(`generated/${name} is missing from the mirror`);
			continue;
		}
		const actual = readFileSync(path);
		const expected = Buffer.from(baselines.get(name), "utf8");
		if (!actual.equals(expected)) problems.push(`generated/${name} is not byte-identical to the baseline derived from the verified mirror`);
		actualGeneratedSha256[`generated/${name}`] = sha256Hex(actual);
	}
	recordEquals(problems, "generated baselines", lock.generated ?? {}, actualGeneratedSha256);

	return problems;
}

async function main() {
	const packageRoot = join(fileURLToPath(new URL("..", import.meta.url)));
	const problems = checkProviderContractMirror(packageRoot);
	if (problems.length > 0) {
		console.error("drakonc-pi provider contract mirror has drifted:");
		for (const problem of problems) console.error(`- ${problem}`);
		console.error("\nRe-run scripts/mirror-provider-contract.mjs against a verified local bundle, or restore the mirrored bytes.");
		process.exit(1);
	}
	const lock = JSON.parse(readFileSync(join(packageRoot, ...PROVIDER_CONTRACT_MIRROR_ROOT.split("/"), PROVIDER_CONTRACT_LOCK_FILE), "utf8"));
	console.log(`drakonc-pi provider contract mirror check passed (contract ${lock.contract_semver}, ${Object.keys(lock.entries).length} bundle entries, ${Object.keys(lock.generated).length} generated baselines, acquisition ${lock.acquisition}).`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
	await main();
}
