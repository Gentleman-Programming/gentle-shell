import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONTEXT_HIGH_PERCENT, ContextHighLatch } from "../lib/context-threshold.ts";
import { MainNotificationRun, NOTIFICATION_ATTENTION_EVENT, NOTIFICATION_SOURCE_EVENT, isNotificationSourceEvent } from "../lib/notification-events.ts";
import { claimNotificationOwner, type NotificationServiceDependencies } from "../lib/notification-service.ts";
import { resolveVisualSettings } from "../lib/visual-customization-policy.ts";

/**
 * Extension-only additions to the notification service dependencies. The visual
 * preference store (`visual-customization.json`) owns `contextWarning`; it is
 * never part of the notification schema, and the two warnings toggle independently.
 */
export interface NotificationExtensionDependencies extends NotificationServiceDependencies {
	/** Reads the visual context-warning preference; defaults to the visual policy store. */
	visualNotice?: () => boolean;
}

/** Default directory loader is the sole audio owner; customize will retrieve its shared facade. */
export function createNotificationExtension(pi: ExtensionAPI, deps: NotificationExtensionDependencies = {}): () => void {
	const nativeOff: (() => void)[] = []; const busOff: (() => void)[] = [];
	const stopBus = () => { for (const off of busOff.splice(0)) off(); };
	const owner = claimNotificationOwner(() => {
		stopBus(); main.reset(); runId = undefined;
		for (const off of nativeOff.splice(0)) off();
	}, deps);
	const main = new MainNotificationRun(owner.now);
	const contextHigh = new ContextHighLatch();
	const visualNotice = deps.visualNotice ?? (() => resolveVisualSettings().settings.visibility.contextWarning);
	let runId: string | undefined; let sessionId: string | undefined; let attachedAt = 0;
	let contextRunId: string | undefined; let contextSequence = 0;
	const valid = (ctx: ExtensionContext) => owner.allowed(ctx) && ctx.sessionManager.getSessionId() === sessionId;
	/** One sound and one optional visual notice per high episode; the latch owns rearming. */
	const evaluateContextHigh = (ctx: ExtensionContext): void => {
		if (!valid(ctx) || !sessionId || !contextRunId) return;
		const reading = ctx.getContextUsage?.()?.percent ?? null;
		if (!contextHigh.observe(reading)) return;
		owner.enqueue({ sessionId, runId: contextRunId, sequence: ++contextSequence,
			event: "context.high", occurredAt: owner.now() });
		if (!visualNotice()) return;
		const percent = reading ?? CONTEXT_HIGH_PERCENT;
		try { ctx.ui.notify(`Context usage is at ${Math.round(percent)}% (\u2265 ${CONTEXT_HIGH_PERCENT}%); consider compacting before the next turn.`, "warning"); }
		catch { /* A local visual diagnostic cannot fail a run. */ }
	};
	const remember = (off: unknown) => { if (typeof off === "function") nativeOff.push(off as () => void); };
	remember(pi.on("session_start", (event, ctx) => {
		if (!owner.current()) return;
		stopBus(); main.reset(); runId = undefined;
		const nextSession = ctx.sessionManager.getSessionId();
		if (nextSession !== sessionId) { contextHigh.rearm(); contextSequence = 0; }
		sessionId = nextSession; contextRunId = `${nextSession}:context`;
		if (!owner.attach(ctx)) return;
		attachedAt = owner.now();
		busOff.push(pi.events.on(NOTIFICATION_SOURCE_EVENT, data => {
			if (!valid(ctx) || !isNotificationSourceEvent(data) || data.source !== "subagent"
				|| data.sessionId !== sessionId || data.parentSessionId !== sessionId
				|| data.occurredAt < attachedAt || data.occurredAt > owner.now()) return;
			if (!owner.acceptSource(data.producerId, data.runId, data.sequence)) return;
			owner.enqueue(data);
		}));
		busOff.push(pi.events.on(NOTIFICATION_ATTENTION_EVENT, payload => {
			if (!valid(ctx) || !runId) return;
			const token = runId;
			const occurrence = main.blocked(sessionId!, token, payload);
			if (occurrence) owner.enqueue(occurrence);
		}));
		if (event.reason === "startup" && owner.startup()) owner.enqueue({ sessionId: sessionId!, runId: "process-startup",
			sequence: 1, event: "session.started", occurredAt: owner.now() });
	}));
	remember(pi.on("agent_start", (_event, ctx) => {
		if (!valid(ctx)) return;
		const occurrence = main.begin(sessionId!); runId = occurrence.runId; owner.enqueue(occurrence);
		evaluateContextHigh(ctx);
	}));
	// Native events carry no run identity. Capture the local token synchronously: no awaits
	// here, no late callback ever searches for a replacement token. before_settle is latest/final evidence.
	remember(pi.on("agent_before_settle", (event, ctx) => {
		const token = runId;
		if (valid(ctx) && token) main.beforeSettle(sessionId!, token, event.outcome);
	}));
	remember(pi.on("turn_end", (event, ctx) => {
		if (!valid(ctx)) return;
		const token = runId;
		if (token) main.turnEnd(sessionId!, token, event.outcome);
		evaluateContextHigh(ctx);
	}));
	remember(pi.on("agent_settled", (_event, ctx) => {
		const token = runId;
		if (!valid(ctx) || !token) return;
		const occurrence = main.settled(sessionId!, token); runId = undefined;
		if (occurrence) owner.enqueue(occurrence);
	}));
	// Model changes move the window: re-evaluate without resetting the episode.
	remember(pi.on("model_select", (_event, ctx) => evaluateContextHigh(ctx)));
	// Only a completed compaction reduced the context; canceled/failed attempts keep the latch.
	remember(pi.on("session_compact", (_event, ctx) => { if (valid(ctx)) contextHigh.rearm(); }));
	remember(pi.on("session_shutdown", () => {
		if (!owner.current()) return;
		stopBus(); main.reset(); runId = undefined; owner.shutdown();
		sessionId = undefined;
		// No quit sound: mandatory immediate cancellation must not wait for lazy detection.
		// Native lifecycle hooks remain dormant for the next session; lease retirement removes them.
	}));
	return owner.retire;
}
export default function gentleNotifications(pi: ExtensionAPI): void { createNotificationExtension(pi); }
