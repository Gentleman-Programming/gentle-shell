// review-sensitive-diff.ts
// Deterministic sensitive-diff floor detection and consent/audit invariants.

export interface SensitiveDiffFloorInput {
	paths?: string[];
	dependencies?: string[];
	diffHunks?: string[];
}

export interface SensitiveDiffFloorResult {
	isSensitive: boolean;
	matchedSurfaces: string[];
}

export interface CodeGraphExpansionInput {
	reachesSensitiveSurface: boolean;
	expandedPaths?: string[];
	detectedSurfaces?: string[];
}

export interface CombinedSensitiveResult {
	isSensitive: boolean;
	expandedByGraph: boolean;
	matchedSurfaces: string[];
}

export interface DeclinedAuditInput {
	floorResult: SensitiveDiffFloorResult;
	userResponse: "declined";
	reason?: string;
}

export interface DeclinedAuditRecord {
	recordType: "declined_audit";
	bypassBlocked: false;
	userResponse: "declined";
	targetSurfaces: string[];
	timestamp: string;
	reason?: string;
}

// Path pattern rules: each entry is [regex, surfaceLabel]
const PATH_SURFACE_RULES: Array<[RegExp, string]> = [
	[/auth|session|oauth|jwt|credentials|tokens/i, "auth"],
	[/billing|stripe|checkout|payments/i, "payments"],
	[/crypto|kms|cipher|key-derivation/i, "cryptography"],
	[/parsers|untrusted|deserializ|sanitiz|xml/i, "untrusted_parser"],
	[/webhook|signature-verif/i, "webhook_verification"],
];

// Sensitive dependency names (exact or substring match)
const SENSITIVE_DEPS: string[] = [
	"@auth/core",
	"passport",
	"jsonwebtoken",
	"bcrypt",
	"crypto-js",
	"stripe",
	"xml2js",
];

// Sensitive diff-hunk patterns
const SENSITIVE_HUNK_PATTERNS: RegExp[] = [
	/crypto\.createHmac/,
	/jwt\.verify/,
	/stripe\.webhooks\.constructEvent/,
	/Authorization:\s*Bearer/,
	/BEGIN RSA PRIVATE KEY/,
];

function detectPathSurfaces(paths: string[]): string[] {
	const matched = new Set<string>();
	for (const p of paths) {
		for (const [pattern, surface] of PATH_SURFACE_RULES) {
			if (pattern.test(p)) {
				matched.add(surface);
			}
		}
	}
	return [...matched];
}

function detectDepSurfaces(deps: string[]): string[] {
	const matched = new Set<string>();
	for (const dep of deps) {
		if (SENSITIVE_DEPS.includes(dep)) {
			// Map dep to a surface label
			if (dep === "@auth/core" || dep === "passport" || dep === "jsonwebtoken" || dep === "bcrypt") {
				matched.add("auth");
			} else if (dep === "crypto-js") {
				matched.add("cryptography");
			} else if (dep === "stripe") {
				matched.add("payments");
			} else if (dep === "xml2js") {
				matched.add("untrusted_parser");
			}
		}
	}
	return [...matched];
}

function detectHunkSurfaces(hunks: string[]): string[] {
	const matched = new Set<string>();
	for (const hunk of hunks) {
		for (const pattern of SENSITIVE_HUNK_PATTERNS) {
			if (pattern.test(hunk)) {
				matched.add("hunk_pattern");
			}
		}
	}
	return [...matched];
}

export function evaluateSensitiveDiffFloor(
	input: SensitiveDiffFloorInput,
): SensitiveDiffFloorResult {
	const surfaces = new Set<string>();

	if (input.paths && input.paths.length > 0) {
		for (const s of detectPathSurfaces(input.paths)) {
			surfaces.add(s);
		}
	}

	if (input.dependencies && input.dependencies.length > 0) {
		for (const s of detectDepSurfaces(input.dependencies)) {
			surfaces.add(s);
		}
	}

	if (input.diffHunks && input.diffHunks.length > 0) {
		for (const s of detectHunkSurfaces(input.diffHunks)) {
			surfaces.add(s);
		}
	}

	const matchedSurfaces = [...surfaces];
	return {
		isSensitive: matchedSurfaces.length > 0,
		matchedSurfaces,
	};
}

export function combineFloorWithGraphExpansion(
	floor: SensitiveDiffFloorInput,
	expansion: CodeGraphExpansionInput,
): CombinedSensitiveResult {
	const floorResult = evaluateSensitiveDiffFloor(floor);

	// Invariant: CodeGraph may ONLY expand scope, never reduce the deterministic floor.
	if (floorResult.isSensitive) {
		return {
			isSensitive: true,
			expandedByGraph: false,
			matchedSurfaces: floorResult.matchedSurfaces,
		};
	}

	if (expansion.reachesSensitiveSurface) {
		const detectedSurfaces =
			expansion.detectedSurfaces && expansion.detectedSurfaces.length > 0
				? expansion.detectedSurfaces
				: ["unknown_sensitive"];
		return {
			isSensitive: true,
			expandedByGraph: true,
			matchedSurfaces: detectedSurfaces,
		};
	}

	return {
		isSensitive: false,
		expandedByGraph: false,
		matchedSurfaces: [],
	};
}

export function createDeclinedAuditRecord(input: DeclinedAuditInput): DeclinedAuditRecord {
	const record: DeclinedAuditRecord = {
		recordType: "declined_audit",
		bypassBlocked: false,
		userResponse: input.userResponse,
		targetSurfaces: [...input.floorResult.matchedSurfaces],
		timestamp: new Date().toISOString(),
	};

	if (input.reason !== undefined) {
		record.reason = input.reason;
	}

	return record;
}
