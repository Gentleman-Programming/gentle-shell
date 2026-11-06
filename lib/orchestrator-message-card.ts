import { sanitizeTerminalText } from "./terminal-theme.ts";
import { readableDataRows } from "./orchestrator-tool-card.ts";
import {
	CARD_TONE, cardAwaitingResult, cardBodyRows, cardBottom, cardRunningLine, cardTop,
	floatRows, markCardResult, renderCard, type CardRowContext, type CardTheme,
} from "./shell-card.ts";

export interface OrchestratorMessageDetails {
	message?: string;
	reason?: string;
	senderLabel?: string;
	recipientLabel?: string;
	senderSessionId?: string;
	recipientSessionId?: string;
	messageId?: string;
	correlationId?: string;
	state?: string;
}

interface MessageRowContext extends CardRowContext {
	expanded?: boolean;
	isError?: boolean;
	args?: Record<string, unknown>;
	state?: { orchestratorMessage?: OrchestratorMessageDetails; messageError?: boolean };
}

const clean = (value: unknown): string => typeof value === "string" ? sanitizeTerminalText(value) : "";
const route = (data: OrchestratorMessageDetails, incoming = false): string =>
	`🤖 ${clean(data.senderLabel) || (incoming ? "Orchestrator" : "You")} → 🤖 ${clean(data.recipientLabel) || (incoming ? "You" : "Orchestrator")}`;

function technicalRows(data: OrchestratorMessageDetails): string[] {
	return [
		data.senderSessionId && `Sender session: ${clean(data.senderSessionId)}`,
		data.recipientSessionId && `Recipient session: ${clean(data.recipientSessionId)}`,
		(data.messageId || data.correlationId) && `Message ID: ${clean(data.messageId || data.correlationId)}`,
		data.reason && `Reason: ${clean(data.reason)}`,
	].filter((row): row is string => typeof row === "string" && row.length > 0);
}

export function incomingMessageCard(data: OrchestratorMessageDetails, content: string, expanded: boolean, theme: CardTheme, hint: string) {
	// Older stored entries only have the model-facing envelope. Remove only
	// its exact prefix; new entries carry the original message separately.
	const prefix = `Session message from ${data.senderSessionId} (correlation ${data.correlationId}): `;
	const body = clean(data.message ?? (content.startsWith(prefix) ? content.slice(prefix.length) : content)).split("\n");
	return {
		render(width: number) {
			return renderCard({ title: "Message received", subtitle: route(data, true), body: expanded ? [...body, "", ...technicalRows(data)] : body, tone: CARD_TONE.INFO, glyph: "↙" }, theme, width, { expanded, previewRows: 3, hint });
		},
		invalidate() {},
	};
}

export function outgoingMessageCall(args: { message?: unknown }, theme: CardTheme, context: MessageRowContext, hint: string) {
	return {
		render(width: number) {
			if (width <= 0) return [];
			const data = context.state?.orchestratorMessage ?? {};
			const pending = cardAwaitingResult(context);
			const tone = context.state?.messageError ? CARD_TONE.ERROR : CARD_TONE.INFO;
			const title = pending ? "Sending message" : context.state?.messageError ? "Message not sent" : data.state === "accepted" ? "Message queued" : "Orchestrator message";
			return floatRows(tone, theme, width, (inner) => ({
				// Fixed status titles stay on one row; long routes are clipped, not wrapped.
				head: [cardTop({ title, subtitle: route(data), body: [], tone, glyph: "↗" }, theme, inner, hint)],
				...(pending ? {
					body: [...cardBodyRows(clean(args.message).split("\n"), tone, theme, inner, { expanded: !!context.expanded, previewRows: 3 }), cardRunningLine(tone, theme, inner)],
					bottom: cardBottom(tone, theme, inner),
				} : {}),
			}));
		},
		invalidate() {},
	};
}

export function outgoingMessageResult(result: { content: Array<{ type: string; text?: string }>; details?: unknown }, expanded: boolean, partial: boolean, theme: CardTheme, context: MessageRowContext) {
	const details = result.details as { gentleAgents?: OrchestratorMessageDetails; error?: unknown } | undefined;
	const data = details?.gentleAgents ?? {};
	const failed = !!details?.error || !!context.isError;
	const accepted = data.state === "accepted" && !failed;
	if (!partial) markCardResult(context.state);
	if (context.state) {
		context.state.orchestratorMessage = data;
		context.state.messageError = failed;
	}
	const tone = failed ? CARD_TONE.ERROR : CARD_TONE.INFO;
	const text = result.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
	const body = accepted ? clean(data.message ?? context.args?.message).split("\n") : clean(text).split("\n");
	if (expanded && accepted) {
		body.push("", "Queued; not a delivery or read receipt.", ...technicalRows(data));
		const requested = clean(context.args?.recipient_session_id);
		if (requested && requested !== data.recipientSessionId) body.push(`Requested recipient: ${requested}`);
	} else if (expanded) {
		body.push(...readableDataRows({ request: context.args, details: details?.gentleAgents }));
	}
	return {
		render(width: number) {
			if (width <= 0) return [];
			return floatRows(tone, theme, width, (inner) => ({
				afterHeading: true,
				body: cardBodyRows(body, tone, theme, inner, { expanded, previewRows: 3 }),
				bottom: cardBottom(tone, theme, inner),
			}));
		},
		invalidate() {},
	};
}
