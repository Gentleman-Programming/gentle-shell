import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { incomingMessageCard, outgoingMessageCall, outgoingMessageResult } from "../lib/orchestrator-message-card.ts";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

const theme = { fg: (_role: string, value: string) => value, bg: (_role: string, value: string) => `\x1b[48;2;20;20;20m${value}\x1b[49m` };
const data = {
	message: "Ready for integration\nTests passed ✅\n第三行\nFinal line",
	senderLabel: "API team", recipientLabel: "Integration",
	senderSessionId: "sender-private-id", recipientSessionId: "recipient-private-id",
	messageId: "message-private-id", reason: "Integration needs the test result", state: "accepted",
};

function outgoing(expanded = false) {
	const args = { message: "mutable argument", reason: "mutable reason" };
	const context = { state: {}, args, expanded, isPartial: false };
	const call = outgoingMessageCall(args, theme, context, "expand");
	const result = outgoingMessageResult({ content: [], details: { gentleAgents: data } }, expanded, false, theme, context);
	return { render: (width: number) => [...call.render(width), ...result.render(width)], invalidate: () => { call.invalidate(); result.invalidate(); } };
}

test("both directions share compact cards, labels, and expanded-only technical details", () => {
	const incoming = incomingMessageCard({ ...data, correlationId: data.messageId }, "model envelope", false, theme, "expand");
	for (const card of [incoming, outgoing()]) {
		const text = stripAnsi(card.render(100).join("\n"));
		assert.match(text, /API team → Integration/);
		assert.match(text, /Ready for integration/);
		assert.doesNotMatch(text, /private-id|Integration needs|model envelope|mutable argument|Final line/);
	}
	for (const card of [incomingMessageCard(data, "model envelope", true, theme, "collapse"), outgoing(true)]) {
		const text = stripAnsi(card.render(100).join("\n"));
		for (const line of data.message.split("\n")) assert.ok(text.includes(line));
		assert.match(text, /Sender session: sender-private-id/);
		assert.match(text, /Recipient session: recipient-private-id/);
		assert.match(text, /Message ID: message-private-id/);
	}
	assert.match(stripAnsi(outgoing(true).render(100).join("\n")), /not a delivery or read receipt/);
});

test("legacy incoming envelopes are removed only when their exact stored binding matches", () => {
	const old = { senderSessionId: "old-sender", correlationId: "old-message" };
	const prefix = "Session message from old-sender (correlation old-message): ";
	const render = (content: string) => incomingMessageCard(old, content, false, theme, "").render(150).join("\n");
	assert.doesNotMatch(render(`${prefix}Hello`), /Session message from|old-sender|old-message/);
	assert.match(render(`${prefix}Hello`), /Hello/);
	assert.match(render("Session message from someone else: user text"), /someone else: user text/);
});

test("message text, aliases, and expanded metadata cannot inject terminal escapes", () => {
	const unsafe = "\x1b]52;c;clipboard\x07\x1b[31mVisible\x1b[0m\r\u0000\x9b2J";
	const detail = { ...data, message: unsafe, senderLabel: unsafe, recipientLabel: unsafe, senderSessionId: unsafe, messageId: unsafe, reason: unsafe };
	const context = { state: {}, args: {}, isPartial: false };
	for (const card of [incomingMessageCard(detail, "", true, theme, ""), outgoingMessageResult({ content: [], details: { gentleAgents: detail } }, true, false, theme, context)]) {
		const text = stripAnsi(card.render(100).join("\n"));
		assert.match(text, /Visible/);
		assert.doesNotMatch(text, /clipboard|\x1b|\x9b|\r|\u0000/);
	}
});

test("cards respect widths and resize in neon and float styles, including wide text", () => {
	const previous = cardStyle();
	try {
		for (const style of Object.values(CARD_STYLE)) {
			setCardStyle(style);
			for (const expanded of [false, true]) {
				for (const card of [incomingMessageCard(data, "", expanded, theme, "expand"), outgoing(expanded)]) {
					for (const width of [0, 1, 2, 4, 8, 12, 24, 80, 120, 24]) {
						card.invalidate();
						const rows = card.render(width);
						if (width === 0) assert.deepEqual(rows, []);
						for (const row of rows) assert.ok(visibleWidth(row) <= width, `${style} width ${width}: ${row}`);
					}
				}
			}
		}
	} finally { setCardStyle(previous); }
});

test("pending, cancelled, failed, and recipient-selection results do not claim acceptance", () => {
	const args = { message: "Preparing update" };
	const context = { state: {}, args, isPartial: true, expanded: false };
	const call = outgoingMessageCall(args, theme, context, "expand");
	assert.match(stripAnsi(call.render(100).join("\n")), /Sending message/);
	assert.match(stripAnsi(call.render(100).join("\n")), /Preparing update/);
	for (const error of ["cancelled", "denied", "not accepted"]) {
		const result = outgoingMessageResult({ content: [{ type: "text", text: `Error: ${error}` }], details: { error } }, false, false, theme, context);
		const text = stripAnsi([...call.render(100), ...result.render(100)].join("\n"));
		assert.match(text, /Message not sent/);
		assert.ok(text.includes(`Error: ${error}`));
		assert.doesNotMatch(text, /Message queued|Preparing update/);
	}
	const selection = outgoingMessageResult({ content: [{ type: "text", text: "Choose recipient" }], details: { gentleAgents: { candidates: [] } } }, false, false, theme, context);
	const text = stripAnsi([...call.render(100), ...selection.render(100)].join("\n"));
	assert.match(text, /Choose recipient/);
	assert.doesNotMatch(text, /Message queued|Message not sent/);
	const thrownContext = { ...context, isError: true };
	const thrownCall = outgoingMessageCall(args, theme, thrownContext, "");
	const thrown = outgoingMessageResult({ content: [{ type: "text", text: "transport exception" }] }, false, false, theme, thrownContext);
	const thrownText = stripAnsi([...thrownCall.render(100), ...thrown.render(100)].join("\n"));
	assert.match(thrownText, /Message not sent/);
	assert.match(thrownText, /transport exception/);
});
