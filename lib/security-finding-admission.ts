import {
	type SecurityFindingRecord,
	type SecurityFindingLifecycleState,
	type IndependentSevereConfirmation,
	createSecurityFinding,
	transitionSecurityFinding,
} from "./security-finding-lifecycle.ts";
import { type SecurityExecutionReceipt, type ValidatedExecutionReceipt, validateExecutionReceipt } from "./security-execution-receipt.ts";

export type SecurityFindingState = SecurityFindingLifecycleState;

export interface AdmissionContext {
	readonly targetedTest: { readonly file: string; readonly testName: string };
}
export interface RejectedEntry { readonly raw: unknown; readonly reason: string }
export interface AdmissionResult {
	readonly admitted: readonly SecurityFindingRecord[];
	readonly rejected: readonly RejectedEntry[];
	readonly parseError?: string;
}
export interface IndependentConfirmationInput {
	readonly confirmedBy: string;
	readonly verifierRole: "verifier" | "independent_analyst" | "orchestrator";
	readonly timestamp: string;
}
export interface PromotionOptions {
	readonly receipt?: SecurityExecutionReceipt;
	readonly independentConfirmation?: IndependentConfirmationInput;
	readonly mutationReceipt?: SecurityExecutionReceipt;
	readonly mutationDescription?: string;
	readonly targetedTest?: { readonly file: string; readonly testName: string };
}

const VALID_SEVERITIES = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]);

function extractJson(raw: string): string {
	return raw.match(/```json\s*([\s\S]*?)```/)?.[1]?.trim() ?? raw.trim();
}

function validateFinding(e: Record<string, unknown>): string | null {
	for (const f of ["id", "title", "severity", "description", "analystIdentity"] as const) {
		if (!e[f] || typeof e[f] !== "string") return `Missing required field: ${f}`;
	}
	return VALID_SEVERITIES.has(e["severity"] as string) ? null : `Invalid severity: ${e["severity"]}`;
}

export function admitSecurityFindingsFromOutput(raw: string, ctx: AdmissionContext): AdmissionResult {
	let parsed: unknown;
	try { parsed = JSON.parse(extractJson(raw)); } catch { return { admitted: [], rejected: [], parseError: "Could not parse JSON from output" }; }
	if (typeof parsed !== "object" || parsed === null) return { admitted: [], rejected: [{ raw: parsed, reason: "Top-level value is not an object" }] };
	const findings = (parsed as Record<string, unknown>)["findings"];
	if (!Array.isArray(findings)) return { admitted: [], rejected: [] };

	const admitted: SecurityFindingRecord[] = [], rejected: RejectedEntry[] = [];
	for (const entry of findings) {
		if (typeof entry !== "object" || entry === null) { rejected.push({ raw: entry, reason: "Finding entry is not an object" }); continue; }
		const rec = entry as Record<string, unknown>;
		const err = validateFinding(rec);
		if (err) { rejected.push({ raw: entry, reason: err }); continue; }
		admitted.push(createSecurityFinding({
			id: rec["id"] as string,
			cwe: (rec["cwe"] as string) ?? "CWE-unknown",
			severity: rec["severity"] as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO",
			claim: rec["description"] as string,
			targetLocation: (rec["category"] as string) ?? "unknown",
			targetedTest: ctx.targetedTest,
			analystIdentity: rec["analystIdentity"] as string | undefined,
		}));
	}
	return { admitted, rejected };
}

function requireRed(receipt: SecurityExecutionReceipt | undefined, label: string): ValidatedExecutionReceipt {
	if (!receipt) throw new Error(`${label}: receipt is required`);
	const val = validateExecutionReceipt(receipt);
	if (val.validationState !== "valid_red") throw new Error(`${label} requires valid red execution receipt, got ${val.validationState}: ${val.failureReason ?? "unknown"}`);
	return val;
}

export function promoteSecurityFindingWithReceipt(
	record: SecurityFindingRecord,
	targetState: SecurityFindingLifecycleState,
	options: PromotionOptions,
): SecurityFindingRecord {
	const tt = options.targetedTest ?? record.targetedTest;

	if (targetState === "verified") {
		requireRed(options.receipt, "Promotion to verified");
		const rt = options.receipt!.targetedTest;
		if (rt.file !== tt.file || rt.testName !== tt.testName) throw new Error(`Receipt target mismatch: expected ${tt.testName}, got ${rt.testName}`);
		const conf = options.independentConfirmation;
		if (record.severity === "CRITICAL" || record.severity === "HIGH") {
			if (!conf?.confirmedBy) throw new Error(`Independent confirmation required for ${record.severity} finding`);
			if (record.analystIdentity && conf.confirmedBy === record.analystIdentity) throw new Error(`Analyst '${record.analystIdentity}' cannot independently confirm own finding`);
		}
		return transitionSecurityFinding(record, { toState: "verified", evidence: { kind: "verification", receipt: options.receipt!, ...(conf && { independentConfirmation: conf as IndependentSevereConfirmation }) } });
	}

	if (targetState === "remediated") {
		if (!options.receipt) throw new Error("Promotion to remediated: receipt is required");
		const val = validateExecutionReceipt(options.receipt);
		if (val.validationState !== "valid_green") throw new Error(`Promotion to remediated requires valid green execution receipt, got ${val.validationState}: ${val.failureReason ?? "unknown"}`);
		return transitionSecurityFinding(record, { toState: "remediated", evidence: { kind: "remediation", receipt: options.receipt } });
	}

	if (targetState === "locked") {
		requireRed(options.mutationReceipt, "Promotion to locked");
		return transitionSecurityFinding(record, { toState: "locked", evidence: { kind: "lock", mutationReceipt: options.mutationReceipt!, mutationDescription: options.mutationDescription ?? "" } });
	}

	return transitionSecurityFinding(record, { toState: targetState, evidence: { kind: "advisory", reason: "Direct promotion", architecturalRisk: "unknown" } });
}
