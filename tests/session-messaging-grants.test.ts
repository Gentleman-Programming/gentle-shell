import assert from "node:assert/strict";
import test from "node:test";
import {
	SessionMessagingGrants,
	MESSAGING_CONSENT_DECISIONS,
} from "../lib/session-messaging-grants.ts";

function context(
	selectResult?: (title: string, options: string[]) => Promise<string | undefined>,
	hasUI = true
) {
	let id = "session-1";
	let calls = 0;
	const dialogs: { title: string; options: string[] }[] = [];
	const sessionManager = { getSessionId: () => id };
	const ctx = {
		sessionManager,
		hasUI,
		ui: hasUI && selectResult
			? {
					select: async (title: string, options: string[]) => {
						calls++;
						dialogs.push({ title, options });
						return selectResult(title, options);
					},
				}
			: undefined,
	};
	return {
		ctx,
		setId: (next: string) => {
			id = next;
		},
		calls: () => calls,
		dialogs: () => dialogs,
	};
}

test("SessionMessagingGrants - Allow once authorizes only the current message and prompts again on next send", async () => {
	const grants = new SessionMessagingGrants();
	const h = context(async () => MESSAGING_CONSENT_DECISIONS.ALLOW_ONCE);

	await grants.authorize(h.ctx as never, "peer-alpha", {
		message: "hello peer",
		reason: "sync state",
	});
	assert.equal(h.calls(), 1);
	assert.match(h.dialogs()[0].title, /peer-alpha/);
	assert.match(h.dialogs()[0].title, /sync state/);
	assert.match(h.dialogs()[0].title, /hello peer/);
	assert.deepEqual(h.dialogs()[0].options, [
		MESSAGING_CONSENT_DECISIONS.ALLOW_ONCE,
		MESSAGING_CONSENT_DECISIONS.ALLOW_SESSION,
		MESSAGING_CONSENT_DECISIONS.DENY,
	]);

	// Second send to same peer must prompt again because it was only allowed once
	await grants.authorize(h.ctx as never, "peer-alpha", {
		message: "second message",
		reason: "because another update is needed",
	});
	assert.equal(h.calls(), 2);
});

test("SessionMessagingGrants - Allow for this session caches permission and skips prompt on subsequent sends to same recipient", async () => {
	const grants = new SessionMessagingGrants();
	const h = context(async () => MESSAGING_CONSENT_DECISIONS.ALLOW_SESSION);

	await grants.authorize(h.ctx as never, "peer-alpha", {
		message: "first message",
		reason: "because the first update is needed",
	});
	assert.equal(h.calls(), 1);

	// Subsequent sends to peer-alpha in the same session must NOT prompt
	await grants.authorize(h.ctx as never, "peer-alpha", {
		message: "second message",
		reason: "because another update is needed",
	});
	assert.equal(h.calls(), 1, "must not prompt again for the same session-granted recipient");

	// But a different recipient must prompt!
	await grants.authorize(h.ctx as never, "peer-beta", {
		message: "hello beta",
		reason: "because beta needs a separate update",
	});
	assert.equal(h.calls(), 2, "changed recipient must require a new decision");
});

test("SessionMessagingGrants - Deny fails closed and sends nothing", async () => {
	const grants = new SessionMessagingGrants();
	const h = context(async () => MESSAGING_CONSENT_DECISIONS.DENY);

	await assert.rejects(
		grants.authorize(h.ctx as never, "peer-alpha", { message: "hello", reason: "because this is needed" }),
		/denied/i
	);
	assert.equal(h.calls(), 1);
});

test("SessionMessagingGrants - cancelling prompt (Escape / undefined) fails closed", async () => {
	const grants = new SessionMessagingGrants();
	const h = context(async () => undefined);

	await assert.rejects(
		grants.authorize(h.ctx as never, "peer-alpha", { message: "hello", reason: "because this is needed" }),
		/denied|cancelled/i
	);
	assert.equal(h.calls(), 1);
});

test("SessionMessagingGrants - headless or missing UI fails closed without prompting", async () => {
	const grants = new SessionMessagingGrants();
	const headless = context(undefined, false);

	await assert.rejects(
		grants.authorize(headless.ctx as never, "peer-alpha", { message: "hello", reason: "because this is needed" }),
		/interactive.*consent/i
	);
	assert.equal(headless.calls(), 0);
});

test("SessionMessagingGrants - AbortSignal aborts consent and fails closed", async () => {
	const grants = new SessionMessagingGrants();
	const ac = new AbortController();
	ac.abort();

	const h = context(async () => MESSAGING_CONSENT_DECISIONS.ALLOW_ONCE);
	await assert.rejects(
		grants.authorize(h.ctx as never, "peer-alpha", {
			message: "hello",
			reason: "because this is needed",
			signal: ac.signal,
		}),
		/aborted/i
	);
	assert.equal(h.calls(), 0);
});

test("SessionMessagingGrants - session change invalidates previous session grants", async () => {
	const grants = new SessionMessagingGrants();
	const h = context(async () => MESSAGING_CONSENT_DECISIONS.ALLOW_SESSION);

	await grants.authorize(h.ctx as never, "peer-alpha", { message: "first", reason: "because session one needs it" });
	assert.equal(h.calls(), 1);

	// Change session ID
	h.setId("session-2");

	// Now peer-alpha must prompt again because session changed
	await grants.authorize(h.ctx as never, "peer-alpha", { message: "in new session", reason: "because session two needs it" });
	assert.equal(h.calls(), 2, "session change must invalidate previous session grants");
});

test("SessionMessagingGrants - sessionManager replacement revokes grants", async () => {
	const grants = new SessionMessagingGrants();
	const h = context(async () => MESSAGING_CONSENT_DECISIONS.ALLOW_SESSION);

	await grants.authorize(h.ctx as never, "peer-alpha", { message: "first", reason: "because session one needs it" });
	assert.equal(h.calls(), 1);

	// Replace sessionManager object
	const replacedCtx = {
		...h.ctx,
		sessionManager: { getSessionId: () => "session-1" },
	};

	await grants.authorize(replacedCtx as never, "peer-alpha", { message: "with new manager", reason: "because manager changed" });
	assert.equal(h.calls(), 2, "sessionManager replacement must invalidate previous grants");
});

test("SessionMessagingGrants - session ID change during prompt selection rejects and records no grant", async () => {
	const grants = new SessionMessagingGrants();
	const h = context(async () => {
		h.setId("session-mutated");
		return MESSAGING_CONSENT_DECISIONS.ALLOW_SESSION;
	});

	await assert.rejects(
		grants.authorize(h.ctx as never, "peer-alpha", { message: "concurrent", reason: "because concurrent work is needed" }),
		/identity changed/i
	);
	assert.equal(h.calls(), 1);

	// Subsequent authorization in the mutated session must prompt again
	await grants.authorize(h.ctx as never, "peer-alpha", { message: "fresh", reason: "because fresh consent is needed" });
	assert.equal(h.calls(), 2, "must prompt again because no grant was recorded for mutated session");
});

test("SessionMessagingGrants - truncates long messages with char count notice and shows the supplied reason", async () => {
	const grants = new SessionMessagingGrants();
	const h = context(async () => MESSAGING_CONSENT_DECISIONS.ALLOW_ONCE);
	const longMessage = "x".repeat(300);

	await grants.authorize(h.ctx as never, "peer-long", { message: longMessage, reason: "because the long message needs review" });
	assert.equal(h.calls(), 1);
	assert.match(h.dialogs()[0].title, /Reason: because the long message needs review/);
	assert.match(h.dialogs()[0].title, /Message \(300 chars, preview\): x{197}\.\.\./);
});

test("SessionMessagingGrants - validates a concrete bounded reason before prompting", async () => {
	const grants = new SessionMessagingGrants();
	const h = context(async () => MESSAGING_CONSENT_DECISIONS.ALLOW_ONCE);

	for (const reason of [undefined, "   short  ", "é".repeat(257)]) {
		await assert.rejects(
			grants.authorize(h.ctx as never, "peer-alpha", { message: "hello", reason } as never),
			/reason/i,
		);
	}
	await grants.authorize(h.ctx as never, "peer-min", { message: "hello", reason: "  12345678  " });
	await grants.authorize(h.ctx as never, "peer-max", { message: "hello", reason: "é".repeat(256) });
	assert.equal(h.calls(), 2, "8 trimmed characters and exactly 512 UTF-8 bytes are valid");
});

test("SessionMessagingGrants - cached grant still requires an available interactive selector", async () => {
	const grants = new SessionMessagingGrants();
	const h = context(async () => MESSAGING_CONSENT_DECISIONS.ALLOW_SESSION);
	const options = { message: "first", reason: "because a session grant is needed" };
	await grants.authorize(h.ctx as never, "peer-alpha", options);
	assert.equal(h.calls(), 1);

	(h.ctx as { hasUI: boolean }).hasUI = false;
	await assert.rejects(grants.authorize(h.ctx as never, "peer-alpha", options), /interactive.*consent/i);
	(h.ctx as { hasUI: boolean }).hasUI = true;
	(h.ctx as { ui?: unknown }).ui = undefined;
	await assert.rejects(grants.authorize(h.ctx as never, "peer-alpha", options), /interactive.*consent/i);
	assert.equal(h.calls(), 1, "cached grants cannot bypass an unavailable selector");
});

test("SessionMessagingGrants - snapshots message and reason while consent selection is pending", async () => {
	let release!: (decision: string) => void;
	const selection = new Promise<string>((resolve) => { release = resolve; });
	const h = context(async () => selection);
	const grants = new SessionMessagingGrants();
	const options = { message: "original\r\nMessage: forged", reason: "because original request" };
	const pending = grants.authorize(h.ctx as never, "peer-alpha", options);
	options.message = "mutated message";
	options.reason = "mutated reason";
	release(MESSAGING_CONSENT_DECISIONS.ALLOW_ONCE);
	await pending;
	assert.match(h.dialogs()[0].title, /Reason: because original request/);
	assert.match(h.dialogs()[0].title, /Message: original\\r\\nMessage: forged/);
	assert.doesNotMatch(h.dialogs()[0].title, /mutated/);
});

test("SessionMessagingGrants - escapes preview controls and Unicode line separators", async () => {
	const grants = new SessionMessagingGrants();
	const h = context(async () => MESSAGING_CONSENT_DECISIONS.ALLOW_ONCE);
	await grants.authorize(h.ctx as never, "peer\nReason: forged", {
		message: "line1\r\nReason: forged\ttab\u2028next\u2029end\u001b[31m",
		reason: "because\r\nMessage: forged\tline\u2028sep",
	});
	assert.equal(h.dialogs()[0].title, "Authorize cross-orchestrator message to peer\\nReason: forged?\nReason: because\\r\\nMessage: forged\\tline\\u2028sep\nMessage: line1\\r\\nReason: forged\\ttab\\u2028next\\u2029end\\u001B[31m");
});
