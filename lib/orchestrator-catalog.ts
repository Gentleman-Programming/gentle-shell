import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { boundedRead, rootFor, sanitizeDisplayLabel, type Header } from "./orchestrator-presence.ts";

// Private bounded derivative, never an identity/authority registry. Each request
// reads at most one 64 KiB snapshot and returns eight entries of each category.
export const CATALOG_BYTES = 64 * 1024;
export const CATALOG_ENTRIES = 64;
export const CATALOG_PAGES = 8;
type Task = { id: string; label: string; status: string; cwd: string | null };
type Catalog = { tasks: Task[]; registered: (string | null)[]; omittedTasks: number; omittedRegistered: number };
export type CatalogPage = Catalog & { cursor?: string };
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const safePath = (path: string) => isAbsolute(path) && Buffer.byteLength(path) <= 256
	&& !/[\p{Cc}\p{Cf}\u00a0\u2000-\u200a\u202f\u205f\u3000]/u.test(path);
const pathFact = (path: string) => safePath(path) ? path : null;
const exact = (value: any, keys: string[]) => value && typeof value === "object" && !Array.isArray(value)
	&& Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
const text = (s: unknown) => typeof s === "string" && s === sanitizeDisplayLabel(s);
const path = (s: unknown) => s === null || typeof s === "string" && safePath(s);
function valid(c: any): c is Catalog {
	return exact(c, ["tasks", "registered", "omittedTasks", "omittedRegistered"])
		&& count(c.omittedTasks) && count(c.omittedRegistered)
		&& Array.isArray(c.tasks) && c.tasks.length <= CATALOG_ENTRIES
		&& c.tasks.every((t: any) => exact(t, ["id", "label", "status", "cwd"])
			&& text(t.id) && text(t.label) && ["running", "queued", "waiting"].includes(t.status) && path(t.cwd))
		&& Array.isArray(c.registered) && c.registered.length <= CATALOG_ENTRIES && c.registered.every(path);
}
/** Explicit whitelist; eagerly detached, no task spreads or thread access. */
export function projectCatalog(tasks: readonly { id: string; label: string; status: string; cwd: string }[], roots: readonly string[]): Catalog {
	const c: Catalog = { tasks: [], registered: [], omittedTasks: tasks.length, omittedRegistered: roots.length };
	// Reserve envelope space; byte overflow is an exact omission, not truncation.
	for (let i = 0; i < Math.min(CATALOG_ENTRIES, Math.max(tasks.length, roots.length)); i++) {
		if (i < tasks.length) {
			const t = tasks[i];
			c.tasks.push({ id: sanitizeDisplayLabel(t.id), label: sanitizeDisplayLabel(t.label), status: t.status, cwd: pathFact(t.cwd) });
			if (Buffer.byteLength(JSON.stringify(c)) > CATALOG_BYTES - 1024) c.tasks.pop();
			else c.omittedTasks--;
		}
		if (i < roots.length) {
			c.registered.push(pathFact(roots[i]));
			if (Buffer.byteLength(JSON.stringify(c)) > CATALOG_BYTES - 1024) c.registered.pop();
			else c.omittedRegistered--;
		}
	}
	if (!valid(c)) throw new Error("malformed-catalog");
	return c;
}
/** Cursor binds only public catalog fields and producer activation, not private
 * activity churn. Current envelope/header generation must still agree on every
 * read; no cached pages, paths or authority are carried by the cursor. */
export function readCatalog(profile: string, h: Header, activation: string, cursor?: string): { page?: CatalogPage; unavailable?: string } {
	try {
		const bytes = boundedRead(join(rootFor(profile, false, true), `${h.sessionHash}.${h.incarnation}.json`), CATALOG_BYTES);
		const value = JSON.parse(bytes.toString("utf8"));
		if (!exact(value, ["schema", "sessionHash", "incarnation", "generation", "activation", "tokens", "catalog"])
			|| value.schema !== 1 || value.sessionHash !== h.sessionHash || value.incarnation !== h.incarnation
			|| value.generation !== h.generation || value.activation !== activation || !valid(value.catalog)
			|| !Array.isArray(value.tokens) || value.tokens.length !== 7 || !value.tokens.every((s: unknown) => typeof s === "string" && /^[a-f0-9-]{36}$/.test(s))) throw new Error("unavailable");
		const c: Catalog = value.catalog;
		const publicBytes = JSON.stringify({ tasks: c.tasks.map(t => ({ id: t.id, label: t.label, status: t.status, cwd: t.cwd })),
			registered: c.registered, omittedTasks: c.omittedTasks, omittedRegistered: c.omittedRegistered });
		const binding = [h.sessionHash, h.incarnation, activation, hash(publicBytes)];
		let offset = 0;
		const token = (n: number) => Buffer.from(JSON.stringify([...binding, n, value.tokens[n / 8 - 1]])).toString("base64url");
		if (cursor !== undefined) {
			if (typeof cursor !== "string" || cursor.length > 1024) throw new Error("invalid-cursor");
			const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
			offset = decoded?.[4];
			if (!count(offset) || offset < 8 || offset >= CATALOG_ENTRIES || offset % 8 || token(offset) !== cursor) throw new Error("invalid-cursor");
		}
		if (cursor && offset >= Math.max(c.tasks.length, c.registered.length)) throw new Error("invalid-cursor");
		const end = offset + 8;
		return { page: { tasks: c.tasks.slice(offset, end), registered: c.registered.slice(offset, end),
			omittedTasks: c.omittedTasks, omittedRegistered: c.omittedRegistered,
			...(end < Math.max(c.tasks.length, c.registered.length) ? { cursor: token(end) } : {}) } };
	} catch { return { unavailable: "catalog-unknown-or-invalid-cursor" }; }
}
