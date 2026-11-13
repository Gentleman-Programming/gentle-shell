import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

// The declared contribution order: `plugins.json` in the gentle-pi config home
// names owners, never ids, and every read point applies it at use time. One
// reader lives here, so the palette, the sidebar rail, the customize rows and
// `/gentle:plugins` can never disagree about what the file says.
//
// Leaf-ish on purpose: no Pi API, no plugin contract, no gentle-pi internals
// beyond the home resolver, so any read point may import it.

/** The only `plugins.json` shape this reader accepts. Anything else is ignored, never guessed. */
export const PLUGINS_SCHEMA = "gentle-pi.plugins/v1";
const PLUGINS_FILE = "plugins.json";

/**
 * Why no owner order came out of `plugins.json`: `none` means the file was
 * read and accepted. Every other value names the check that failed, so
 * `/gentle:plugins` can tell a maintainer which one instead of printing a
 * generic "malformed".
 */
export type PluginOrderReason = "none" | "missing" | "unreadable" | "not-json" | "wrong-schema" | "wrong-shape";

export interface PluginOrderOptions {
	/** Defaults to the gentle-pi config home; only a test or a caller with an env passes it. */
	gentlePiConfigHome?: string;
}

export interface PluginOrderResolution {
	/** Owners to place first, in this order. Empty means "no explicit order". */
	order: string[];
	/** `default` is a missing file: insertion order, exactly the base behavior. */
	source: "global_file" | "default";
	/** A file exists but is unreadable, not JSON or wrongly schemated. */
	malformed: boolean;
	/** Which check left `order` empty; `none` only when the file was accepted. */
	reason: PluginOrderReason;
	globalFile: string;
}

/** One parse attempt: the owner order when the text is accepted, and why not otherwise. */
export interface PluginOrderParse {
	/** The accepted owner order, `undefined` when the text is not a valid file. */
	order: string[] | undefined;
	reason: PluginOrderReason;
}

/**
 * The explicit owner order and the check that decided it. Two keys exactly,
 * this schema, and no coercion, so a hand edit is accepted or reported, never
 * half-read.
 */
export function parsePluginOrderText(raw: string): PluginOrderParse {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { order: undefined, reason: "not-json" };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { order: undefined, reason: "wrong-shape" };
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== 2 || !("schema" in record) || !("order" in record)) {
		return { order: undefined, reason: "wrong-shape" };
	}
	if (record.schema !== PLUGINS_SCHEMA) return { order: undefined, reason: "wrong-schema" };
	const order = record.order;
	if (!Array.isArray(order) || !order.every((owner) => typeof owner === "string" && owner.length > 0)) {
		return { order: undefined, reason: "wrong-shape" };
	}
	return { order: [...order], reason: "none" };
}

/**
 * The explicit owner order, `undefined` when the text is not a valid file.
 * Mirrors `parseCardStyleFile`: two keys exactly, this schema, and no coercion.
 */
export function parsePluginOrderFile(raw: string): string[] | undefined {
	return parsePluginOrderText(raw).order;
}

/**
 * A missing `plugins.json` means no explicit order. A malformed, wrongly
 * schemated or unreadable one also means no explicit order — the same
 * "malformed reads as default" contract as `lib/card-style-policy.ts` — so a
 * hand edit can break arbitration but never a read point, and this reader
 * never throws and never rewrites the file. `reason` says which check made the
 * reader fall back, so the audit can report it without changing any read.
 *
 * Callers read it at use time (one read per build or prepare), never once at
 * load time, so an edit takes effect without a reload.
 */
export function readPluginOrder(options: PluginOrderOptions = {}): PluginOrderResolution {
	const globalFile = join(options.gentlePiConfigHome ?? gentlePiConfigHome(), PLUGINS_FILE);
	let raw: string;
	try {
		raw = readFileSync(globalFile, "utf8");
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return {
			order: [],
			source: missing ? "default" : "global_file",
			malformed: !missing,
			reason: missing ? "missing" : "unreadable",
			globalFile,
		};
	}
	const parsed = parsePluginOrderText(raw);
	return {
		order: parsed.order ?? [],
		source: "global_file",
		malformed: parsed.order === undefined,
		reason: parsed.reason,
		globalFile,
	};
}
