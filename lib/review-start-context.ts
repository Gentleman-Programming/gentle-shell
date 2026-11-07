import type { NativeStartRequest } from "./native-review-cli.ts";

/** Validated intent for a fresh START, never native authority or a candidate identity. */
export type ReviewStartContext = Readonly<Pick<NativeStartRequest,
	"requestContextPath" | "policyPath" | "focus" | "lenses" | "lensesReason"
>>;

/** Snapshot only intent fields; mutable caller arrays cannot change a retained request. */
export function snapshotReviewStartContext(input: ReviewStartContext): ReviewStartContext {
	return Object.freeze({
		...(input.requestContextPath === undefined ? {} : { requestContextPath: input.requestContextPath }),
		...(input.policyPath === undefined ? {} : { policyPath: input.policyPath }),
		...(input.focus === undefined ? {} : { focus: input.focus }),
		...(input.lenses === undefined ? {} : { lenses: Object.freeze([...input.lenses]) }),
		...(input.lensesReason === undefined ? {} : { lensesReason: input.lensesReason }),
	});
}
