import assert from "node:assert/strict";
import test from "node:test";
import {
	evaluateSensitiveDiffFloor,
	combineFloorWithGraphExpansion,
	createDeclinedAuditRecord,
	type SensitiveDiffFloorInput,
	type CodeGraphExpansionInput,
} from "../lib/review-sensitive-diff.ts";

test("evaluateSensitiveDiffFloor detects sensitive file paths across all mandatory attack surfaces", () => {
	const sensitivePathCases = [
		// auth / session
		["src/auth/login.ts", "auth"],
		["lib/session-manager.ts", "session"],
		["controllers/oauth-callback.ts", "oauth"],
		["middleware/jwt-verifier.ts", "jwt"],
		["utils/credentials-store.ts", "credentials"],
		["tokens/refresh.ts", "tokens"],
		// payments
		["billing/stripe-webhook.ts", "payments"],
		["services/checkout-pipeline.ts", "payments"],
		["payments/gateway.ts", "payments"],
		// cryptography
		["crypto/key-derivation.ts", "cryptography"],
		["security/kms-client.ts", "cryptography"],
		["lib/cipher-suite.ts", "cryptography"],
		// untrusted data parsers
		["parsers/xml-untrusted-parser.ts", "untrusted_parser"],
		["data/untrusted-deserializer.ts", "untrusted_parser"],
		["sanitize/html-sanitizer.ts", "untrusted_parser"],
		// webhook verification
		["webhooks/signature-verification.ts", "webhook_verification"],
		["api/github-webhook.ts", "webhook_verification"],
	];

	for (const [path, expectedSurface] of sensitivePathCases) {
		const result = evaluateSensitiveDiffFloor({ paths: [path] });
		assert.equal(result.isSensitive, true, `path ${path} should trigger sensitive floor`);
		assert.ok(
			result.matchedSurfaces.length > 0,
			`path ${path} should match at least one surface`,
		);
	}
});

test("evaluateSensitiveDiffFloor returns false for ordinary non-sensitive paths", () => {
	const ordinaryPaths = [
		"src/components/button.tsx",
		"lib/string-utils.ts",
		"docs/readme.md",
		"styles/theme.css",
		"assets/icon.svg",
	];
	const result = evaluateSensitiveDiffFloor({ paths: ordinaryPaths });
	assert.equal(result.isSensitive, false);
	assert.deepEqual(result.matchedSurfaces, []);
});

test("evaluateSensitiveDiffFloor detects sensitive dependency additions/modifications in manifest diffs", () => {
	const sensitiveDeps = [
		"@auth/core",
		"passport",
		"jsonwebtoken",
		"bcrypt",
		"crypto-js",
		"stripe",
		"xml2js",
	];

	for (const dep of sensitiveDeps) {
		const result = evaluateSensitiveDiffFloor({
			paths: ["package.json"],
			dependencies: [dep],
		});
		assert.equal(result.isSensitive, true, `dependency ${dep} should trigger sensitive floor`);
		assert.ok(result.matchedSurfaces.length > 0);
	}

	const ordinaryResult = evaluateSensitiveDiffFloor({
		paths: ["package.json"],
		dependencies: ["lodash", "chalk", "zod"],
	});
	assert.equal(ordinaryResult.isSensitive, false);
});

test("evaluateSensitiveDiffFloor detects sensitive diff patterns / tokens in hunks", () => {
	const sensitivePatterns = [
		"crypto.createHmac('sha256', secret)",
		"jwt.verify(token, privateKey)",
		"stripe.webhooks.constructEvent(payload, sig, endpointSecret)",
		"Authorization: Bearer <secret>",
		"BEGIN RSA PRIVATE KEY",
	];

	for (const hunk of sensitivePatterns) {
		const result = evaluateSensitiveDiffFloor({
			paths: ["lib/client.ts"],
			diffHunks: [hunk],
		});
		assert.equal(result.isSensitive, true, `pattern '${hunk}' should trigger sensitive floor`);
	}
});

test("CodeGraph expansion can ONLY expand scope, never reduce the deterministic floor", () => {
	// Case 1: Floor is sensitive (true), CodeGraph reports no sensitive calls (false) -> result remains TRUE
	const floorSensitive: SensitiveDiffFloorInput = { paths: ["src/auth/service.ts"] };
	const graphNoExpansion: CodeGraphExpansionInput = { reachesSensitiveSurface: false, expandedPaths: [] };
	const combined1 = combineFloorWithGraphExpansion(floorSensitive, graphNoExpansion);
	assert.equal(combined1.isSensitive, true, "graph cannot override a true floor");
	assert.equal(combined1.expandedByGraph, false);

	// Case 2: Floor is non-sensitive (false), CodeGraph detects reachability to sensitive symbols (true) -> expands to TRUE
	const floorNonSensitive: SensitiveDiffFloorInput = { paths: ["src/utils/encoder.ts"] };
	const graphExpands: CodeGraphExpansionInput = {
		reachesSensitiveSurface: true,
		expandedPaths: ["src/auth/token-encoder.ts"],
		detectedSurfaces: ["auth"],
	};
	const combined2 = combineFloorWithGraphExpansion(floorNonSensitive, graphExpands);
	assert.equal(combined2.isSensitive, true, "graph must expand non-sensitive floor when reachability detected");
	assert.equal(combined2.expandedByGraph, true);
	assert.deepEqual(combined2.matchedSurfaces, ["auth"]);

	// Case 3: Both are non-sensitive -> FALSE
	const combined3 = combineFloorWithGraphExpansion(floorNonSensitive, graphNoExpansion);
	assert.equal(combined3.isSensitive, false);
	assert.equal(combined3.expandedByGraph, false);
});

test("createDeclinedAuditRecord creates a structured audit record without minting a vulnerability", () => {
	const floorResult = evaluateSensitiveDiffFloor({
		paths: ["src/auth/session.ts", "lib/token.ts"],
	});

	const auditRecord = createDeclinedAuditRecord({
		floorResult,
		userResponse: "declined",
		reason: "Internal utility update, separate security review already scheduled",
	});

	assert.equal(auditRecord.recordType, "declined_audit");
	assert.equal(auditRecord.bypassBlocked, false); // non-blocking marker
	assert.equal(auditRecord.userResponse, "declined");
	assert.ok(auditRecord.targetSurfaces.length > 0);
	assert.ok(typeof auditRecord.timestamp === "string" && auditRecord.timestamp.length > 0);
	assert.equal(auditRecord.reason, "Internal utility update, separate security review already scheduled");

	// Invariant: no vulnerability findings minted
	assert.equal("findings" in auditRecord, false);
	assert.equal("severity" in auditRecord, false);
	assert.equal("state" in auditRecord, false);
});
