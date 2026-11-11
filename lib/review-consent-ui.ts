import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ReviewConsentComponent, type ReviewConsentContent } from "./review-consent-component.ts";
import type { ReviewConsentEnvelope, ReviewConsentV3 } from "./review-integration-v2.ts";

export const HOST_REVIEW_SESSION_PERMISSION_LABEL = "Review and allow this session";

const HOST_REVIEW_SESSION_PERMISSION_EFFECT =
	"Reviews this change and allows later reviews in this session and repository; revoke anytime.";

const HOST_REVIEW_SESSION_PERMISSION_OWNERSHIP =
	"The first two actions are provider-owned and apply only to this candidate. The third action is owned by the Pi host. It runs the current provider grant for this frozen candidate and lets the host use one fresh validated provider grant for each later candidate while this exact Pi session and canonical Git repository identity, including sibling worktrees, remain active. Reload preserves it; new, resume, fork, quit, process restart, or explicit revocation ends it. It grants no verdict, acknowledgement, maintenance, delivery, or cross-repository authority.";

export type ReviewConsentUiSelection =
	| { kind: "provider"; answer: "granted" | "declined" }
	| { kind: "host-session" };

export interface ReviewConsentUiModel {
	readonly title: string;
	readonly options: readonly [string, string, string];
	readonly content: ReviewConsentContent;
}

export function isPiConsentV3(consent: ReviewConsentEnvelope): consent is ReviewConsentV3 {
	return consent.schema === "gentle-ai.review-integration.consent/v3" && consent.agent === "pi";
}

export function formatReviewConsentUi(consent: ReviewConsentV3): ReviewConsentUiModel {
	const evidence = consent.riskEvidence.map((item) => `- ${item}`).join("\n");
	const title = [
		consent.headline,
		"",
		`Reason: ${consent.reason}`,
		`Value: ${consent.value}`,
		`Risk: ${consent.riskLevel}; ${consent.changedFiles} changed file(s), ${consent.changedLines} changed line(s).`,
		`Target: ${consent.targetIdentity}`,
		`Projection: ${consent.projection}`,
		"Risk evidence:",
		evidence,
		"",
		`Ownership: ${HOST_REVIEW_SESSION_PERMISSION_OWNERSHIP}`,
		"",
		`Off-path note: ${consent.offPath.note}`,
		`Off-path command: ${consent.offPath.command}`,
	].join("\n");
	const options = [
		`1. ${consent.choices[0].label}\nEffect: ${consent.choices[0].effect}`,
		`2. ${consent.choices[1].label}\nEffect: ${consent.choices[1].effect}`,
		`3. ${HOST_REVIEW_SESSION_PERMISSION_LABEL}\nEffect: ${HOST_REVIEW_SESSION_PERMISSION_EFFECT}`,
	] as const;
	return {
		title,
		options,
		content: {
			headline: consent.headline,
			reason: consent.reason,
			value: consent.value,
			risk: `${consent.riskLevel}; ${consent.changedFiles} changed file(s), ${consent.changedLines} changed line(s).`,
			target: consent.targetIdentity,
			projection: consent.projection,
			evidence: consent.riskEvidence,
			ownership: HOST_REVIEW_SESSION_PERMISSION_OWNERSHIP,
			offPathNote: consent.offPath.note,
			offPathCommand: consent.offPath.command,
			actions: [
				{ label: consent.choices[0].label, effect: consent.choices[0].effect },
				{ label: consent.choices[1].label, effect: consent.choices[1].effect },
				{ label: HOST_REVIEW_SESSION_PERMISSION_LABEL, effect: HOST_REVIEW_SESSION_PERMISSION_EFFECT },
			],
		},
	};
}

export async function presentReviewConsentUi(
	context: ExtensionContext,
	consent: ReviewConsentEnvelope,
): Promise<ReviewConsentUiSelection | undefined> {
	if (!isPiConsentV3(consent)) return undefined;
	const model = formatReviewConsentUi(consent);
	try {
		if (context.mode === "tui") {
			return await context.ui.custom<ReviewConsentUiSelection | undefined>((tui, theme, keybindings, done) => {
				const component = new ReviewConsentComponent({
					content: model.content,
					theme,
					keybindings,
					terminalRows: () => tui.terminal.rows,
					onSelect: (index) => done(index === 0 ? { kind: "provider", answer: "granted" }
						: index === 1 ? { kind: "provider", answer: "declined" } : { kind: "host-session" }),
					onCancel: () => done(undefined),
				});
				return {
					getActionOptions: () => component.getActionOptions(),
					render: (width) => component.render(width),
					invalidate: () => component.invalidate(),
					handleInput: (data) => {
						component.handleInput(data);
						tui.requestRender();
					},
				};
			});
		}
		const selected = await context.ui.select(model.title, [...model.options]);
		if (selected === model.options[0]) return { kind: "provider", answer: "granted" };
		if (selected === model.options[1]) return { kind: "provider", answer: "declined" };
		if (selected === model.options[2]) return { kind: "host-session" };
		return undefined;
	} catch {
		return undefined;
	}
}
