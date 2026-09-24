import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const MESSAGING_REASON_MIN_CHARACTERS = 8;
export const MESSAGING_REASON_MAX_UTF8_BYTES = 512;

const PREVIEW_CONTROL_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function escapePreviewText(value: string): string {
	return Array.from(value, (character) => {
		if (!PREVIEW_CONTROL_CHARACTER.test(character)) return character;
		if (character === "\r") return "\\r";
		if (character === "\n") return "\\n";
		if (character === "\t") return "\\t";
		return `\\u${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
	}).join("");
}

export function normalizeMessagingReason(value: unknown): string {
	if (typeof value !== "string") throw new Error("Cross-orchestrator communication requires a concrete reason of at least 8 trimmed characters and at most 512 UTF-8 bytes.");
	const reason = value.trim();
	if (Array.from(reason).length < MESSAGING_REASON_MIN_CHARACTERS || Buffer.byteLength(value, "utf8") > MESSAGING_REASON_MAX_UTF8_BYTES) {
		throw new Error("Cross-orchestrator communication requires a concrete reason of at least 8 trimmed characters and at most 512 UTF-8 bytes.");
	}
	return reason;
}

/**
 * Supported decision tokens for cross-orchestrator communication consent.
 */
export const MESSAGING_CONSENT_DECISIONS = {
	ALLOW_ONCE: "Allow once",
	ALLOW_SESSION: "Allow for this session",
	DENY: "Deny",
} as const;

export type MessagingConsentDecision =
	(typeof MESSAGING_CONSENT_DECISIONS)[keyof typeof MESSAGING_CONSENT_DECISIONS];

/**
 * Options for requesting human authorization before outbound cross-session communication.
 */
export interface MessagingConsentOptions {
	/** Outbound message payload. */
	message: string;
	/** Concrete caller-supplied reason explaining why this communication is needed. */
	reason: string;
	/** Optional abort signal for request cancellation. */
	signal?: AbortSignal;
}

/**
 * Ephemeral in-memory grant manager for cross-orchestrator communication.
 * Permissions are scoped strictly to the live session identity and session manager instance.
 */
export class SessionMessagingGrants {
	private readonly grants = new Map<string, Set<string>>();
	private manager?: ExtensionContext["sessionManager"];
	private sessionId?: string;

	/**
	 * Authorizes an outbound cross-orchestrator message to the given recipient.
	 * Prompts the user interactively when no session-level grant exists, and fails closed otherwise.
	 */
	async authorize(
		ctx: Pick<ExtensionContext, "sessionManager" | "hasUI" | "ui">,
		recipient: string,
		options: MessagingConsentOptions
	): Promise<void> {
		const message = options.message;
		if (typeof message !== "string" || Buffer.byteLength(message, "utf8") > 8192) throw new Error("Cross-orchestrator message is invalid.");
		const reason = normalizeMessagingReason(options.reason);
		const signal = options.signal;
		if (signal?.aborted) throw new Error("Cross-orchestrator message authorization aborted.");
		const id = ctx.sessionManager.getSessionId();
		if (!id) throw new Error("Cross-orchestrator communication requires an active session identity.");
		if (this.manager !== ctx.sessionManager || this.sessionId !== id) {
			this.grants.clear();
			this.manager = ctx.sessionManager;
			this.sessionId = id;
		}
		if (!ctx.hasUI || typeof ctx.ui?.select !== "function") {
			throw new Error("Cross-orchestrator communication requires interactive human consent before sending.");
		}
		if (this.grants.get(id)?.has(recipient)) return;

		const previewMessage = escapePreviewText(message);
		const isTruncated = message.length > 200;
		const messageLabel = isTruncated
			? `Message (${message.length} chars, preview): ${escapePreviewText(message.slice(0, 197))}...`
			: `Message: ${previewMessage}`;
		const title = `Authorize cross-orchestrator message to ${escapePreviewText(recipient)}?\nReason: ${escapePreviewText(reason)}\n${messageLabel}`;

		const selected = await ctx.ui.select(
			title,
			[
				MESSAGING_CONSENT_DECISIONS.ALLOW_ONCE,
				MESSAGING_CONSENT_DECISIONS.ALLOW_SESSION,
				MESSAGING_CONSENT_DECISIONS.DENY,
			],
			{ signal }
		);

		if (signal?.aborted) throw new Error("Cross-orchestrator message authorization aborted.");
		if (ctx.sessionManager !== this.manager || ctx.sessionManager.getSessionId() !== id) {
			throw new Error("Session identity changed during authorization.");
		}

		if (selected === MESSAGING_CONSENT_DECISIONS.ALLOW_SESSION) {
			const sessionGrants = this.grants.get(id) ?? new Set<string>();
			sessionGrants.add(recipient);
			this.grants.set(id, sessionGrants);
			return;
		}

		if (selected === MESSAGING_CONSENT_DECISIONS.ALLOW_ONCE) {
			return;
		}

		throw new Error("Cross-orchestrator communication denied by user.");
	}

	/**
	 * Checks whether a live session-level grant exists for the target recipient in the current session.
	 */
	assertCurrent(ctx: Pick<ExtensionContext, "sessionManager">, recipient: string): boolean {
		if (
			ctx.sessionManager !== this.manager ||
			!this.sessionId ||
			ctx.sessionManager.getSessionId() !== this.sessionId
		) {
			return false;
		}
		return this.grants.get(this.sessionId)?.has(recipient) ?? false;
	}
}
