// A tiny HTTP client for the `gentle-shell serve` tests: JSON or raw calls,
// SSE streams that collect their text, and device pairing.

import assert from "node:assert/strict";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { ServeScope } from "../lib/serve-auth.ts";

export interface Reply { status: number; body: any; headers: IncomingMessage["headers"]; bytes: Buffer }

export function call(base: string, method: string, path: string, options: { token?: string; body?: unknown; raw?: Buffer | string; headers?: Record<string, string> } = {}): Promise<Reply> {
	const { promise, resolve, reject } = Promise.withResolvers<Reply>();
	const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
	const req = httpRequest(`${base}${path}`, {
		method,
		agent: false,
		headers: {
			...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
			...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
			...options.headers,
		},
	}, (res) => {
		const chunks: Buffer[] = [];
		res.on("data", (c: Buffer) => chunks.push(c));
		res.on("end", () => {
			const bytes = Buffer.concat(chunks);
			let body: unknown = bytes.toString("utf8");
			try { body = JSON.parse(body as string); } catch { /* not JSON */ }
			resolve({ status: res.statusCode ?? 0, body, headers: res.headers, bytes });
		});
	});
	req.on("error", reject);
	req.end(payload);
	return promise;
}

/** An open SSE stream; `text` grows as events arrive. */
export interface Stream { status: number; text: string; closed: Promise<void>; waitFor(what: string | RegExp): Promise<void>; close(): void }

export function stream(base: string, path: string, token?: string, headers: Record<string, string> = {}): Promise<Stream> {
	const { promise, resolve, reject } = Promise.withResolvers<Stream>();
	const req = httpRequest(`${base}${path}`, { agent: false, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } }, (res) => {
		const closed = Promise.withResolvers<void>();
		const waiters: Array<{ what: string | RegExp; done: () => void }> = [];
		const has = (what: string | RegExp) => (typeof what === "string" ? s.text.includes(what) : what.test(s.text));
		const s: Stream = {
			status: res.statusCode ?? 0,
			text: "",
			closed: closed.promise,
			waitFor(what) {
				if (has(what)) return Promise.resolve();
				const w = Promise.withResolvers<void>();
				waiters.push({ what, done: w.resolve });
				return w.promise;
			},
			close: () => req.destroy(),
		};
		res.on("data", (c: Buffer) => {
			s.text += c.toString("utf8");
			for (const w of [...waiters]) if (has(w.what)) { waiters.splice(waiters.indexOf(w), 1); w.done(); }
		});
		res.on("close", () => closed.resolve());
		resolve(s);
	});
	req.on("error", (error) => { if (!(error as NodeJS.ErrnoException).code?.startsWith("ECONNRESET")) reject(error); });
	req.end();
	return promise;
}

export async function pairDevice(base: string, admin: string, scopes: ServeScope[], name = "device"): Promise<{ id: string; token: string }> {
	const code = await call(base, "POST", "/api/pairing-codes", { token: admin, body: { scopes } });
	assert.equal(code.status, 201);
	const paired = await call(base, "POST", "/api/pair", { body: { code: code.body.code, name } });
	assert.equal(paired.status, 201, JSON.stringify(paired.body));
	return { id: paired.body.id, token: paired.body.token };
}
