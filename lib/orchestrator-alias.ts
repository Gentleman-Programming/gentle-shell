import { stripVTControlCharacters } from "node:util";

export interface TaskAliases { initialAlias: string | null; currentAlias: string | null }
/** Explicit public topic only; never infer from names or private conversation. */
export function normalizeTaskSubject(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || /\p{Cs}/u.test(value)) throw new Error("invalid-task-subject");
	const clean = stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
	return Array.from(clean).slice(0, 120).join("").trimEnd() || undefined;
}
export function decodeTaskAliases(value: unknown): TaskAliases | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const valid = (v: unknown): v is string => typeof v === "string" && !!v && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(v)
		&& Array.from(v).length <= 120 && normalizeTaskSubject(v) === v;
	if (Object.keys(input).length !== 2 || !Object.hasOwn(input, "initialAlias") || !Object.hasOwn(input, "currentAlias")
		|| !(input.initialAlias === null || valid(input.initialAlias))
		|| !(valid(input.currentAlias) || (input.currentAlias === null && input.initialAlias === null))) return undefined;
	return { initialAlias: input.initialAlias as string | null, currentAlias: input.currentAlias as string | null };
}
