import assert from "node:assert/strict";
import test from "node:test";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

// The review-family tool declarations are injected into every session's
// system prompt (description + snippet + guidelines + parameter schemas).
// They were historically unbudgeted while orchestrator declarations had a
// hard byte budget (tests/orchestrator-prompt-budget.test.ts), so their
// operational prose grew until it duplicated the runtime RDD contract.
// This test pins a hard budget and the security invariants that must
// survive any future trim. Operational detail lives in the mirrored
// review contract (contracts/review-provider-contract-mirror) and in
// docs/delegated-verification.md; the always-on surface keeps only
// invariants and routing.

interface RegisteredDeclaration {
	name: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: readonly string[];
	parameters?: unknown;
}

const REVIEW_FAMILY_TOOLS = [
	"gentle_review",
	"gentle_review_capture",
	"gentle_review_capture_group",
	"gentle_review_scope",
	"gentle_odd_phase",
] as const;

// The whole-declaration JSON (schemas, property names, the operation enum,
// and test-contracted fragments such as the S5 escalate shape) is
// irreducible or contract-pinned surface; the budget pins the prose trim:
// the historical unbudgeted surface was ~21.3 KB and the trimmed surface
// lands ~16.6 KB. Regrowth past 16.8 KB fails here. Prose-only bytes are
// reported in the diagnostic for visibility.
// The original trim measured 16,638 B; rebasing onto main added the requestContextPath
// guideline and the abandon parameter prose (+~0.5 KB of new upstream capability text),
// so the cap tracks that state rather than the earlier main.
// Shared guidance (REVIEW_BLOCKER_GUIDANCE) is declared once on gentle_review:
// Pi dedupes identical guidelines, so per-tool copies only inflate this count.
const REVIEW_FAMILY_PROSE_BUDGET_BYTES = 17300;

function registerReviewFamily(): Map<string, RegisteredDeclaration> {
	const tools = new Map<string, RegisteredDeclaration>();
	createGentleAiExtension({ nativeReviewCli: null })({
		on() {},
		registerCommand() {},
		registerTool(definition: RegisteredDeclaration) {
			tools.set(definition.name, definition);
		},
	} as never);
	for (const name of REVIEW_FAMILY_TOOLS) {
		assert.ok(tools.get(name), `missing registered review tool ${name}`);
	}
	return tools;
}

function surfaceBytes(tools: Map<string, RegisteredDeclaration>): number {
	const selected = REVIEW_FAMILY_TOOLS.map((name) => tools.get(name)!);
	return Buffer.byteLength(JSON.stringify(selected), "utf8");
}

function reviewSurface(tool: RegisteredDeclaration | undefined): string {
	assert.ok(tool, "review tool must be registered");
	return [
		tool.description ?? "",
		tool.promptSnippet ?? "",
		...(tool.promptGuidelines ?? []),
		JSON.stringify(tool.parameters),
	].join("\n");
}

test("review-family tool declarations fit the always-on prose budget", t => {
	const tools = registerReviewFamily();
	const bytes = surfaceBytes(tools);
	const proseBytes = REVIEW_FAMILY_TOOLS.reduce((sum, name) => {
		const tool = tools.get(name)!;
		return sum + Buffer.byteLength([tool.description ?? "", tool.promptSnippet ?? "", ...(tool.promptGuidelines ?? [])].join("\n"), "utf8");
	}, 0);
	t.diagnostic(`review-family declarations: ${bytes} B (budget ${REVIEW_FAMILY_PROSE_BUDGET_BYTES} B); prose-only ${proseBytes} B`);
	assert.ok(
		bytes <= REVIEW_FAMILY_PROSE_BUDGET_BYTES,
		`review-family declarations ${bytes} B exceed the always-on budget ${REVIEW_FAMILY_PROSE_BUDGET_BYTES} B`,
	);
});

test("trimmed review surface keeps the security and authority invariants", () => {
	const tools = registerReviewFamily();
	const controller = reviewSurface(tools.get("gentle_review"));
	const capture = reviewSurface(tools.get("gentle_review_capture"));
	const family = [controller, capture, reviewSurface(tools.get("gentle_review_capture_group")),
		reviewSurface(tools.get("gentle_review_scope")), reviewSurface(tools.get("gentle_odd_phase"))].join("\n");

	// Delivery boundary.
	assert.match(family, /Review outcomes never authorize delivery/);
	// Provider-issued opaque values are authoritative; never invent tokens.
	assert.match(controller, /native-input-required.*never.*invent/is);
	// Ambiguous output handling is declared, not improvised.
	assert.match(
		controller,
		/ambiguous START output.*target-scoped native status.*declared action.*ambiguous gentle_review_capture.*never replays/is,
	);
	// RESET/RECOVER stay destructive and authorization-gated.
	assert.match(controller, /RESET or RECOVER only after explicit user authorization/is);
	assert.match(controller, /destructive/is);
	// Host consent is host-owned; permission is never created from prose or arguments.
	assert.match(controller, /never create host permission from tool arguments|host-owned/is);
	// Correction-budget units stay named (diff lines vs logical budget).
	assert.match(controller, /diff lines/);
	assert.match(controller, /logical correction/);
	for (const [label, text] of [["capture schema", capture.split("\n").at(-1)!], ["capture guidance", (tools.get("gentle_review_capture")!.promptGuidelines ?? []).join("\n")]] as const) {
		assert.match(text, /diff lines/, label);
		assert.match(text, /logical correction budget/, label);
	}
	assert.ok(controller.includes("The plan adds an independent verifier only when escalate names a Task Size high-risk item; it can never lower a tier."));
	// Native review never removes a tier-required verifier (S1) and stays an outside view.
	assert.match(controller, /native review is an additional outside view/);
	assert.match(controller, /verify-always-rdd-high/);
});
