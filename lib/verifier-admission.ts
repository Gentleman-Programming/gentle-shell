import { namesExistingFeatureDocumentTask } from "./bounded-writer-admission.ts";
import { contextBackstopReached, type MeasuredContext } from "./context-backstop.ts";

// odd/tasks/verifier-admission.md: the Verification rule reserves the independent verifier for a change that names a
// Task Size high-risk item, yet a bench run still launched it on a small, not high-risk task. In the primary session a
// verifier launch is admitted only when its task or context declares a named high-risk item, carries a task of an
// existing feature document (the same lines writer admission accepts), or the parent's measured context reaches the
// context backstop. The agent catalog has no generic verifier alias, so only `gentle-ai-verify` is gated.
const VERIFIER_NAMES = ["gentle-ai-verify"];
// A declaration that starts a line (optionally as a list item) or a sentence (after `.`, `!` or `?` and a space) with
// `Risk:` whose first entry is `item N` with N in 1-6, for example `Risk: item 3 (shared parser)`, `- Risk: item 2,
// item 3 (reason)` or `... on top of ebf3f35. Risk: item 1 (migration)`. `Risk: none` and a mention inside a
// sentence ("Do not write Risk: item 3") do not start one.
const HIGH_RISK_ITEM_LINE = /(?:^[ \t]*(?:[-*+][ \t]+)?|[.!?][ \t]+)Risk:[ \t]*item[ \t]+[1-6](?!\d)/m;
export const VERIFIER_RISK_REJECTION =
	"An independent verifier runs only for a change that declares a named high-risk item (`Risk: item N` from the Task Size list in the task). This change declares none: run its focused test and suite inline yourself now; do not retry the launch, and never add a Risk line or create a feature document only to get a verifier admitted.";

export function rejectUnriskedVerifierLaunch(
	input: unknown,
	options: { root: string; contextUsage: MeasuredContext | undefined; env?: Readonly<Record<string, string | undefined>> },
): { block: true; reason: string } | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const record = input as Record<string, unknown>;
	if (typeof record.agent !== "string" || !VERIFIER_NAMES.includes(record.agent)) return undefined;
	const values = [record.task, record.context];
	if (values.some(value => typeof value === "string" && HIGH_RISK_ITEM_LINE.test(value))) return undefined;
	if (namesExistingFeatureDocumentTask(values, options.root)) return undefined;
	if (contextBackstopReached(options.contextUsage, options.env)) return undefined;
	return { block: true, reason: VERIFIER_RISK_REJECTION };
}
