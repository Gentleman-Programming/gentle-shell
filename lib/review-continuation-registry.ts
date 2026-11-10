import type { NativeIntendedUntrackedSelectionSubmission } from "./native-review-cli.ts";
import type { ReviewStartContext } from "./review-start-context.ts";

export interface RetainedNativeUntrackedSelection {
	readonly untrackedScope: "exclude" | "select";
	readonly expectedUntrackedInventory: string;
	readonly intendedUntracked: readonly string[];
	readonly submission?: NativeIntendedUntrackedSelectionSubmission;
}
export interface RetainedPreLineageNativeUntrackedSelection {
	readonly untrackedScope?: "exclude" | "select";
	readonly expectedUntrackedInventory?: string;
	readonly intendedUntracked?: readonly string[];
	readonly submission?: NativeIntendedUntrackedSelectionSubmission;
	readonly targetIdentity: string;
	readonly candidateTree: string;
	readonly baseRef?: string;
	readonly committedOnly?: true;
}
export interface RetainedNativeCaptureRoute {
	readonly workspaceRoot: string;
	readonly lineageId: string;
	readonly targetIdentity: string;
	readonly baseRef?: string;
	readonly committedOnly?: true;
}
export interface RetainedNativeUntrackedStopSelector {
	readonly selectionBinding: string;
	readonly targetIdentity: string;
	readonly baseRef?: string;
	readonly committedOnly?: true;
	readonly startContext?: ReviewStartContext;
}

export type RetainedReviewContinuation =
	| { readonly kind: "committed-range"; readonly baseRef: string }
	| (RetainedNativeUntrackedSelection & { readonly kind: "selection" })
	| (RetainedPreLineageNativeUntrackedSelection & { readonly kind: "pre-start" })
	| (RetainedNativeCaptureRoute & { readonly kind: "capture" })
	| (RetainedNativeUntrackedStopSelector & { readonly kind: "stop" });

const lifecycleKey = (root: string, lineage: string) => `${root}\u0000${lineage}`;
const captureKey = (binding: string) => `capture\u0000${binding}`;
const MAX_RETAINED_CONTINUATIONS = 64;
/** Strip the private discriminator from a retained routing payload. */
function payload<T extends RetainedReviewContinuation>(entry: T): Omit<T, "kind"> {
	const { kind: _kind, ...value } = entry;
	return value;
}

/** Process-local routing hints only. Native STATUS remains the authority. */
export class ReviewContinuationRegistry {
	private readonly entries: Map<string, RetainedReviewContinuation>;
	// Optional backing map keeps the existing __testing seam on this same store,
	// without copying state or maintaining a second representation.
	constructor(entries = new Map<string, RetainedReviewContinuation>()) { this.entries = entries; }
	/** Reuse a registry or wrap the legacy backing map without copying state. */
	static from(value: ReviewContinuationRegistry | Map<string, RetainedReviewContinuation>): ReviewContinuationRegistry {
		return value instanceof ReviewContinuationRegistry ? value : new ReviewContinuationRegistry(value);
	}
	get size(): number { return this.entries.size; }
	readCommittedRange(root: string): string | undefined {
		const entry = this.entries.get(`committed-range\u0000${root}`);
		return entry?.kind === "committed-range" ? entry.baseRef : undefined;
	}
	retainCommittedRange(root: string, baseRef: string): void {
		this.retain(`committed-range\u0000${root}`, { kind: "committed-range", baseRef });
	}
	/** Bound retained hints by evicting the oldest key before a new insertion. */
	private retain(key: string, entry: RetainedReviewContinuation): void {
		if (!this.entries.has(key)) while (this.entries.size >= MAX_RETAINED_CONTINUATIONS) this.entries.delete(this.entries.keys().next().value!);
		this.entries.set(key, Object.freeze(entry));
	}
	readSelection(root: string, lineage: string): RetainedNativeUntrackedSelection | undefined {
		const entry = this.entries.get(lifecycleKey(root, lineage));
		return entry?.kind === "selection" ? payload(entry) : undefined;
	}
	readPreStart(root: string): RetainedPreLineageNativeUntrackedSelection | undefined {
		const entry = this.entries.get(lifecycleKey(root, ""));
		return entry?.kind === "pre-start" ? payload(entry) : undefined;
	}
	readStop(root: string): RetainedNativeUntrackedStopSelector | undefined {
		const entry = this.entries.get(lifecycleKey(root, ""));
		return entry?.kind === "stop" ? payload(entry) : undefined;
	}
	readCapture(binding: string): RetainedNativeCaptureRoute | undefined {
		const entry = this.entries.get(captureKey(binding));
		return entry?.kind === "capture" ? payload(entry) : undefined;
	}
	retainSelection(root: string, lineage: string, value: RetainedNativeUntrackedSelection): void {
		this.retain(lifecycleKey(root, lineage), { ...value, kind: "selection" });
	}
	retainPreStart(root: string, value: RetainedPreLineageNativeUntrackedSelection): void {
		this.retain(lifecycleKey(root, ""), { ...value, kind: "pre-start" });
	}
	retainStop(root: string, value: RetainedNativeUntrackedStopSelector): void {
		this.retain(lifecycleKey(root, ""), { ...value, kind: "stop" });
	}
	retainCapture(binding: string, value: RetainedNativeCaptureRoute): void {
		this.retain(captureKey(binding), { ...value, kind: "capture" });
	}
	clearSelection(root: string, lineage: string): void { this.entries.delete(lifecycleKey(root, lineage)); }
	clearCaptureRoutes(root: string, lineage: string, keepBindings: readonly string[] = []): void {
		const keepKeys = new Set(keepBindings.map(captureKey));
		for (const [key, entry] of this.entries) if (entry.kind === "capture" && entry.workspaceRoot === root && entry.lineageId === lineage && !keepKeys.has(key)) this.entries.delete(key);
	}
}
