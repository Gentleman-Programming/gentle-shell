import type { NativeIntendedUntrackedSelectionSubmission } from "./native-review-cli.ts";
import type { ReviewStartContext } from "./review-start-context.ts";

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
	readonly baseCommit?: string;
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
	| { readonly kind: "committed-range"; readonly baseRef: string; readonly mutation?: string }
	| (RetainedPreLineageNativeUntrackedSelection & { readonly kind: "pre-start" })
	| (RetainedNativeCaptureRoute & { readonly kind: "capture" })
	| (RetainedNativeUntrackedStopSelector & { readonly kind: "stop" });

const preStartKey = (root: string) => `${root}\u0000`;
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
	/** A reminder may reuse a selector only for the generation explicitly assessed. */
	readReminderRange(root: string, mutation: string): string | undefined {
		const entry = this.entries.get(`committed-range\u0000${root}`);
		return entry?.kind === "committed-range" && entry.mutation === mutation ? entry.baseRef : undefined;
	}
	retainCommittedRange(root: string, baseRef: string, mutation?: string): void {
		this.retain(`committed-range\u0000${root}`, { kind: "committed-range", baseRef, ...(mutation === undefined ? {} : { mutation }) });
	}
	clearReminderRange(root: string): void {
		const entry = this.entries.get(`committed-range\u0000${root}`);
		if (entry?.kind === "committed-range") this.retainCommittedRange(root, entry.baseRef);
	}
	/** Bound retained hints by evicting the oldest key before a new insertion. */
	private retain(key: string, entry: RetainedReviewContinuation): void {
		if (!this.entries.has(key)) while (this.entries.size >= MAX_RETAINED_CONTINUATIONS) this.entries.delete(this.entries.keys().next().value!);
		this.entries.set(key, Object.freeze(entry));
	}
	readPreStart(root: string): RetainedPreLineageNativeUntrackedSelection | undefined {
		const entry = this.entries.get(preStartKey(root));
		return entry?.kind === "pre-start" ? payload(entry) : undefined;
	}
	readStop(root: string): RetainedNativeUntrackedStopSelector | undefined {
		const entry = this.entries.get(preStartKey(root));
		return entry?.kind === "stop" ? payload(entry) : undefined;
	}
	readCapture(binding: string): RetainedNativeCaptureRoute | undefined {
		const entry = this.entries.get(captureKey(binding));
		return entry?.kind === "capture" ? payload(entry) : undefined;
	}
	retainPreStart(root: string, value: RetainedPreLineageNativeUntrackedSelection): void {
		this.retain(preStartKey(root), { ...value, kind: "pre-start" });
	}
	retainStop(root: string, value: RetainedNativeUntrackedStopSelector): void {
		this.retain(preStartKey(root), { ...value, kind: "stop" });
	}
	retainCapture(binding: string, value: RetainedNativeCaptureRoute): void {
		this.retain(captureKey(binding), { ...value, kind: "capture" });
	}
	clearPreStart(root: string): void { this.entries.delete(preStartKey(root)); }
	clearCaptureRoutes(root: string, lineage: string, keepBindings: readonly string[] = []): void {
		const keepKeys = new Set(keepBindings.map(captureKey));
		for (const [key, entry] of this.entries) if (entry.kind === "capture" && entry.workspaceRoot === root && entry.lineageId === lineage && !keepKeys.has(key)) this.entries.delete(key);
	}
}
