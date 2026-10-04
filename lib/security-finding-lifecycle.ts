import {
	type SecurityExecutionReceipt,
	validateExecutionReceipt,
} from "./security-execution-receipt.ts";

export type SecurityFindingSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
export type SecurityFindingLifecycleState = "hypothesis" | "refuted" | "advisory" | "verified" | "remediated" | "locked";

export interface IndependentSevereConfirmation {
	readonly confirmedBy: string;
	readonly verifierRole: "verifier" | "independent_analyst" | "orchestrator";
	readonly timestamp: string;
}

export interface RefutationEvidence {
	readonly kind: "refutation";
	readonly reason: string;
	readonly controlsInspected: readonly string[];
	readonly provenanceHash?: string;
}

export interface AdvisoryEvidence {
	readonly kind: "advisory";
	readonly reason: string;
	readonly architecturalRisk: string;
	readonly provenanceHash?: string;
}

export interface VerificationEvidence {
	readonly kind: "verification";
	readonly receipt: SecurityExecutionReceipt;
	readonly independentConfirmation?: IndependentSevereConfirmation;
}

export interface RemediationEvidence {
	readonly kind: "remediation";
	readonly receipt: SecurityExecutionReceipt;
	readonly sourceDiffSha256?: string;
}

export interface LockEvidence {
	readonly kind: "lock";
	readonly mutationReceipt: SecurityExecutionReceipt;
	readonly mutationDescription: string;
}

export type SecurityFindingEvidence =
	| RefutationEvidence
	| AdvisoryEvidence
	| VerificationEvidence
	| RemediationEvidence
	| LockEvidence;

export interface SecurityFindingTransitionEvent {
	readonly fromState: SecurityFindingLifecycleState;
	readonly toState: SecurityFindingLifecycleState;
	readonly timestamp: string;
	readonly evidence: SecurityFindingEvidence;
	readonly actor?: string;
}

export interface SecurityFindingRecord {
	readonly id: string;
	readonly cwe: string;
	readonly severity: SecurityFindingSeverity;
	readonly state: SecurityFindingLifecycleState;
	readonly claim: string;
	readonly targetLocation: string;
	readonly targetedTest: { readonly file: string; readonly testName: string };
	readonly analystIdentity?: string;
	readonly history: readonly SecurityFindingTransitionEvent[];
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface TransitionFindingInput {
	readonly toState: SecurityFindingLifecycleState;
	readonly evidence: SecurityFindingEvidence;
	readonly actor?: string;
	readonly timestamp?: string;
}

export class SecurityFindingTransitionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SecurityFindingTransitionError";
	}
}

export function createSecurityFinding(params: {
	id: string;
	cwe: string;
	severity: SecurityFindingSeverity;
	claim: string;
	targetLocation: string;
	targetedTest: { file: string; testName: string };
	analystIdentity?: string;
	actor?: string;
	timestamp?: string;
}): SecurityFindingRecord {
	const now = params.timestamp ?? new Date().toISOString();
	const initialEvent: SecurityFindingTransitionEvent = {
		fromState: "hypothesis",
		toState: "hypothesis",
		timestamp: now,
		evidence: {
			kind: "advisory",
			reason: "Initial hypothesis creation",
			architecturalRisk: params.claim,
		},
		actor: params.actor ?? params.analystIdentity,
	};

	return {
		id: params.id,
		cwe: params.cwe,
		severity: params.severity,
		state: "hypothesis",
		claim: params.claim,
		targetLocation: params.targetLocation,
		targetedTest: {
			file: params.targetedTest.file,
			testName: params.targetedTest.testName,
		},
		analystIdentity: params.analystIdentity,
		history: [initialEvent],
		createdAt: now,
		updatedAt: now,
	};
}

function checkTargetBinding(
	receipt: SecurityExecutionReceipt,
	targetedTest: { file: string; testName: string },
): void {
	if (
		receipt.targetedTest.file !== targetedTest.file ||
		receipt.targetedTest.testName !== targetedTest.testName
	) {
		throw new SecurityFindingTransitionError(
			`Receipt target mismatch: expected ${targetedTest.file}:${targetedTest.testName}, got ${receipt.targetedTest.file}:${receipt.targetedTest.testName}`,
		);
	}
}

export function transitionSecurityFinding(
	record: SecurityFindingRecord,
	input: TransitionFindingInput,
): SecurityFindingRecord {
	const fromState = record.state;
	const toState = input.toState;
	const ev = input.evidence;
	const now = input.timestamp ?? new Date().toISOString();

	if (fromState === "refuted" || fromState === "advisory" || fromState === "locked") {
		throw new SecurityFindingTransitionError(
			`Cannot transition from terminal state '${fromState}' to '${toState}'`,
		);
	}

	if (fromState === "hypothesis") {
		if (toState === "refuted") {
			if (ev.kind !== "refutation" || !ev.reason || !Array.isArray(ev.controlsInspected)) {
				throw new SecurityFindingTransitionError("Invalid refutation evidence");
			}
		} else if (toState === "advisory") {
			if (ev.kind !== "advisory" || !ev.reason || !ev.architecturalRisk) {
				throw new SecurityFindingTransitionError("Invalid advisory evidence");
			}
		} else if (toState === "verified") {
			if (ev.kind !== "verification") {
				throw new SecurityFindingTransitionError("Verification evidence required");
			}
			const val = validateExecutionReceipt(ev.receipt);
			if (val.validationState !== "valid_red") {
				throw new SecurityFindingTransitionError(
					`Verification requires valid RED execution receipt, got ${val.validationState}: ${val.failureReason ?? "unknown"}`,
				);
			}
			checkTargetBinding(ev.receipt, record.targetedTest);

			if (record.severity === "CRITICAL" || record.severity === "HIGH") {
				const conf = ev.independentConfirmation;
				if (!conf || !conf.confirmedBy) {
					throw new SecurityFindingTransitionError(
						`Independent confirmation required for ${record.severity} finding`,
					);
				}
				if (record.analystIdentity && conf.confirmedBy === record.analystIdentity) {
					throw new SecurityFindingTransitionError(
						`Analyst '${record.analystIdentity}' cannot independently confirm own finding`,
					);
				}
			}
		} else {
			throw new SecurityFindingTransitionError(
				`Illegal transition from 'hypothesis' to '${toState}'`,
			);
		}
	} else if (fromState === "verified") {
		if (toState === "remediated") {
			if (ev.kind !== "remediation") {
				throw new SecurityFindingTransitionError("Remediation evidence required");
			}
			const val = validateExecutionReceipt(ev.receipt);
			if (val.validationState !== "valid_green") {
				throw new SecurityFindingTransitionError(
					`Remediation requires valid GREEN execution receipt, got ${val.validationState}: ${val.failureReason ?? "unknown"}`,
				);
			}
			checkTargetBinding(ev.receipt, record.targetedTest);
		} else {
			throw new SecurityFindingTransitionError(
				`Illegal transition from 'verified' to '${toState}'`,
			);
		}
	} else if (fromState === "remediated") {
		if (toState === "locked") {
			if (ev.kind !== "lock") {
				throw new SecurityFindingTransitionError("Lock evidence required");
			}
			const val = validateExecutionReceipt(ev.mutationReceipt);
			if (val.validationState !== "valid_red") {
				throw new SecurityFindingTransitionError(
					`Locking requires valid isolated mutation RED execution receipt, got ${val.validationState}`,
				);
			}
			checkTargetBinding(ev.mutationReceipt, record.targetedTest);
		} else {
			throw new SecurityFindingTransitionError(
				`Illegal transition from 'remediated' to '${toState}'`,
			);
		}
	}

	const event: SecurityFindingTransitionEvent = {
		fromState,
		toState,
		timestamp: now,
		evidence: ev,
		actor: input.actor,
	};

	return {
		...record,
		state: toState,
		history: [...record.history, event],
		updatedAt: now,
	};
}
