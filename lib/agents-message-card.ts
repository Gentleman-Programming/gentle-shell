import { sanitizeTerminalText } from "./terminal-theme.ts";
import { CARD_TONE, cardBodyRows, cardBottom, cardTop, floatRows, type CardParts, type CardTheme, type CardTone } from "./shell-card.ts";

/**
 * The chat's own messaging identity. One definition feeds the chat's
 * `subagent_send_message` card and the Agents thread's received-message rows, so
 * the two cannot drift into a copy of each other.
 *
 * The glyph carries its own trailing space: the card chrome adds one more
 * between glyph and title, and a single space left the envelope against the word.
 */
export const AGENT_MESSAGE = {
	title: "Messaging agent",
	glyph: "✉ ",
	tone: CARD_TONE.INFO,
} as const;

/**
 * Marker `lib/agents-runner.ts` retains when it delivers a message to a running
 * child. The protocol has no user-item kind, so a note that starts with exactly
 * this text is the retained form of a received message — and nothing else is:
 * every other note keeps its own label.
 */
export const STEERED_NOTE_PREFIX = "steered: ";

// The agent identity palette: agent cards wear the iris chrome — heading, glyph,
// frame and running pill — whatever the active accent is, so working with agents
// reads as its own mode. The palette is emitted as truecolor ANSI exactly like pi
// renders theme hex values; every other role stays theme-native, so body text,
// hints and the success/error states keep the user's theme.
const IRIS_FG = "\x1b[38;2;185;167;242m";
const IRIS_DEEP_FG = "\x1b[38;2;143;122;217m";
const IRIS_TINT_BG = "\x1b[48;2;26;21;38m";
const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";

/**
 * The theme an agent card is drawn with. Info cards (live agent work, and the
 * messaging card) also sit on the iris float tint; success, warning and error
 * cards keep the theme's own background.
 */
export function agentTheme(theme: CardTheme, tone: CardTone): CardTheme {
	const tint = tone === CARD_TONE.INFO;
	return {
		fg: (color, text) => color === "accent" ? `${IRIS_FG}${text}${FG_RESET}`
			: color === "border" ? `${IRIS_DEEP_FG}${text}${FG_RESET}`
			: theme.fg(color, text),
		...(theme.bg ? { bg: (color, text) => tint && color === "toolSuccessBg" ? `${IRIS_TINT_BG}${text}${BG_RESET}` : theme.bg!(color, text) } : {}),
	};
}

/**
 * The message body a retained note carries, or `undefined` when the note is not
 * the store's form of a message delivered to the child. Exactly the runner's
 * marker, so a question, a retry, a missing-tool notice or an error stays a note.
 */
export function steeredMessage(text: string): string | undefined {
	return text.startsWith(STEERED_NOTE_PREFIX) ? text.slice(STEERED_NOTE_PREFIX.length) : undefined;
}

/** What one agent card is drawn from. */
export interface AgentCardContent {
	title: string;
	glyph: string;
	tone: CardTone;
	subtitle?: string;
	/** Rows below the heading, drawn exactly as handed: a card never repaints text. */
	body: readonly string[];
	/** Whole body, or the collapsed preview budget. */
	expanded: boolean;
	/** Preview budget a collapsed body keeps; three rows when left out. */
	previewRows?: number;
	/** Right-aligned key hint in the top rule. */
	hint?: string;
}

/**
 * The parts one agent card is drawn from, in the active card style: the heading,
 * the wrapped body rows and the closing rule.
 *
 * This is the drawing boundary of the Messaging agent design, and every other
 * chat agent card draws through it too. The chat composes these parts into pi's
 * own call and result components — the call keeps its `running…` row, the result
 * continues the heading — and the Agents thread draws a received message by
 * wrapping the same parts in one `floatRows` card. Neither side re-implements a
 * heading, a body or a frame, so a change here reaches the chat and the thread
 * together.
 */
export function agentCardParts(content: AgentCardContent, theme: CardTheme, width: number): CardParts {
	return {
		head: [cardTop({ title: content.title, subtitle: content.subtitle, body: [], tone: content.tone, glyph: content.glyph }, theme, width, content.hint)],
		body: cardBodyRows(content.body, content.tone, theme, width, { expanded: content.expanded, previewRows: content.previewRows }),
		bottom: cardBottom(content.tone, theme, width),
	};
}

/**
 * One received message drawn as the chat's Messaging agent card: the same
 * heading, glyph, iris chrome and card drawing its own messaging card uses. The
 * message is drawn whole because a thread row has no expand affordance of its
 * own, so withholding a preview here would hide text the reader cannot reopen.
 */
export function agentMessageCard(message: string, theme: CardTheme, width: number): string[] {
	const painted = agentTheme(theme, AGENT_MESSAGE.tone);
	const body = sanitizeTerminalText(message).split("\n");
	return floatRows(AGENT_MESSAGE.tone, painted, width, (inner) =>
		agentCardParts({ ...AGENT_MESSAGE, body, expanded: true }, painted, inner));
}
