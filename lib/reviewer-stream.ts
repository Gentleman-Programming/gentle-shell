import { AsyncLocalStorage } from "node:async_hooks";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";

export interface ReviewerStream {
	result(): Promise<AssistantMessage>;
	[Symbol.asyncIterator]?(): AsyncIterator<AssistantMessageEvent>;
}
export interface ReviewerProgress {
	readonly routingKey: string;
	readonly phase: "waiting-for-output" | "streaming" | "completion-unobserved";
	readonly elapsedMs: number;
}
export type ReviewerProgressObserver = (progress: ReviewerProgress) => void | Promise<void>;
const observers = new AsyncLocalStorage<ReviewerProgressObserver>();
export function withReviewerProgress<T>(observer: ReviewerProgressObserver, run: () => T): T { return observers.run(observer, run); }
export function publishReviewerProgress(progress: ReviewerProgress): void { notify(observers.getStore(), progress); }
function notify(observer: ReviewerProgressObserver | undefined, progress: ReviewerProgress): void {
	try { void Promise.resolve(observer?.(progress)).catch(() => {}); } catch { /* Progress never changes a review outcome. */ }
}

export function reviewerStreamLimits(environment: NodeJS.ProcessEnv): { firstOutputTimeoutMs: number; idleTimeoutMs: number } {
	const bound = (name: string) => {
		const value = environment[name];
		const number = value !== undefined && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
		return Number.isSafeInteger(number) && number <= 2_147_483_647 ? number : 120_000;
	};
	return { firstOutputTimeoutMs: bound("GENTLE_PI_REVIEW_RELAY_FIRST_OUTPUT_TIMEOUT_MS"), idleTimeoutMs: bound("GENTLE_PI_REVIEW_RELAY_IDLE_TIMEOUT_MS") };
}

/** Observe content activity without retaining provider text or changing the completion. */
export async function readReviewerStream(stream: ReviewerStream, options: {
	routingKey: string; firstOutputTimeoutMs?: number; idleTimeoutMs?: number;
	wait<T>(start: () => Promise<T>): Promise<T>;
	timeout(phase: "first-output" | "stream-idle", limitMs: number): void;
	onProgress?: ReviewerProgressObserver;
}): Promise<AssistantMessage> {
	const began = performance.now();
	const iterator = stream[Symbol.asyncIterator]?.();
	let active = false, disposed = false;
	let endsAt = Infinity, limitMs = 120_000;
	let timeoutPhase: "first-output" | "stream-idle" = "first-output";
	let timer: ReturnType<typeof setTimeout> | undefined;
	const report = () => notify(options.onProgress, { routingKey: options.routingKey,
		phase: iterator === undefined ? "completion-unobserved" : active ? "streaming" : "waiting-for-output", elapsedMs: Math.max(0, performance.now() - began) });
	const expired = () => {
		if (performance.now() < endsAt) return false;
		options.timeout(timeoutPhase, limitMs); return true;
	};
	const check = () => {
		if (!expired()) timer = setTimeout(check, Math.max(1, Math.ceil(endsAt - performance.now())));
	};
	const arm = () => {
		clearTimeout(timer);
		timeoutPhase = active ? "stream-idle" : "first-output";
		const limit = (active ? options.idleTimeoutMs : options.firstOutputTimeoutMs) ?? 120_000;
		if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 2_147_483_647) throw new RangeError("Reviewer stream limits must be positive timer-safe integers.");
		limitMs = limit; endsAt = performance.now() + limit;
		timer = setTimeout(check, limit);
	};
	const drain = async () => {
		if (iterator === undefined) return;
		arm();
		while (!disposed) {
			const next = await options.wait(() => Promise.resolve(iterator.next()));
			if (expired()) return;
			if (next.done || disposed) return;
			const event = next.value;
			if ((event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") && event.delta.length > 0) {
				const first = !active; active = true; arm(); if (first) report();
			}
		}
	};
	const heartbeat = setInterval(report, 5_000);
	try {
		const observed = drain();
		report();
		const [message] = await Promise.all([options.wait(() => stream.result()), observed]);
		expired(); // Provider microtasks may resolve before an overdue timer is dispatched.
		return message;
	} catch (error) {
		expired(); // A provider rejection must retain the same deadline precedence.
		throw error;
	} finally {
		disposed = true; clearTimeout(timer); clearInterval(heartbeat);
		try { void Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* Never wait for provider cleanup. */ }
	}
}
