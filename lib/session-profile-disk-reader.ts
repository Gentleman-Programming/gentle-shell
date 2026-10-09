// Observable selected-record authority only, not conversation durability.
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
	readSessionProfileEntry,
	SESSION_PROFILE_CUSTOM_TYPE,
	type SessionProfileReadResult,
} from "./session-profile-persistence.ts";

const profileFamily = SESSION_PROFILE_CUSTOM_TYPE.slice(
	0,
	SESSION_PROFILE_CUSTOM_TYPE.lastIndexOf("/") + 1,
);

export interface SessionProfileSource {
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getBranch(): readonly unknown[];
}
export type DiskProfileResult =
	| {
			status: "indeterminate";
			reason: string;
			entryIndex?: never;
			lineNumber?: number;
	  }
	| (SessionProfileReadResult & { entryIndex?: number; lineNumber?: number });

export interface DiskProfileOptions {
	readFile?: (path: string) => string;
	/** Trusted caller evidence ONLY: exclude known failed appends, never arbitrary
	 * invalid/future entries. This reader owns no quarantine or append controller.
	 * Failed IDs remain excluded even if they subsequently appear on disk. */
	knownFailedEntryIds?: ReadonlySet<string>;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function metadata(value: Record<string, unknown>): boolean {
	return (
		["type", "id", "parentId", "timestamp"].every((key) =>
			Object.hasOwn(value, key),
		) &&
		typeString(value.type) &&
		typeString(value.id) &&
		typeString(value.timestamp) &&
		(value.parentId === null || typeString(value.parentId))
	);
}
function typeString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
function snapshot(value: unknown): unknown {
	// Same undefined omission/toJSON behavior as Pi's JSONL serialization. Throws
	// on cycles/BigInt; decoded copies cannot retain mutable memory references.
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		throw new TypeError("Unserializable source snapshot");
	}
}
function unavailable(reason: string, lineNumber?: number): DiskProfileResult {
	return lineNumber === undefined
		? { status: "indeterminate", reason }
		: { status: "indeterminate", reason, lineNumber };
}

/**
 * Stateless synchronous read of the captured public active branch and file.
 * No writes, SDK imports, UI, fallback policy, cache, ancestry repair or fsync.
 * An orphan selected record can be corroborated: complete disk ancestry is NOT
 * required. No external-writer/TOCTOU guarantee is implied by source checks.
 * Missing disk is conservative and does not decide future memory-only activation.
 */
export function readSessionProfileDisk(
	source: SessionProfileSource,
	options: DiskProfileOptions = {},
): DiskProfileResult {
	try {
		const sessionId = source.getSessionId();
		const path = source.getSessionFile();
		const rawBranch = source.getBranch();
		if (!typeString(sessionId) || !typeString(path) || !Array.isArray(rawBranch))
			return unavailable("missing-source");
		// Validate own required candidate metadata before serialization can hide
		// missing/inherited fields. Ordinary branch entries have no profile meaning.
		for (const raw of rawBranch) {
			if (
				record(raw) &&
				raw.type === "custom" &&
				typeof raw.customType === "string" &&
				raw.customType.startsWith(profileFamily) &&
				(!metadata(raw) || !Object.hasOwn(raw, "customType"))
			)
				return unavailable("invalid-candidate-metadata");
		}
		const branch = snapshot(rawBranch) as unknown[];
		const failed = new Set(options.knownFailedEntryIds);
		let entryIndex = -1;
		for (let index = branch.length - 1; index >= 0; index--) {
			const candidate = branch[index];
			if (
				record(candidate) &&
				candidate.type === "custom" &&
				typeof candidate.customType === "string" &&
				candidate.customType.startsWith(profileFamily) &&
				!failed.has(candidate.id as string)
			) {
				entryIndex = index;
				break;
			}
		}
		let text: string;
		try {
			text = (options.readFile ?? ((file) => readFileSync(file, "utf8")))(path);
		} catch {
			return unavailable("unreadable-file");
		}
		if (
			source.getSessionId() !== sessionId ||
			source.getSessionFile() !== path ||
			!isDeepStrictEqual(snapshot(source.getBranch()), branch)
		)
			return unavailable("source-changed");
		const disk = new Map<
			string,
			{ value: Record<string, unknown>; lineNumber: number }
		>();
		let foundHeader = false;
		const lines = text.split("\n");
		for (let index = 0; index < lines.length; index++) {
			if (!lines[index].trim()) continue;
			const lineNumber = index + 1;
			let value: unknown;
			try {
				value = JSON.parse(lines[index]);
			} catch {
				return unavailable("invalid-json", lineNumber);
			}
			if (!record(value)) return unavailable("invalid-record", lineNumber);
			if (!foundHeader) {
				if (value.type !== "session" || value.id !== sessionId)
					return unavailable("session-header-mismatch", lineNumber);
				foundHeader = true;
				continue;
			}
			if (!metadata(value) || value.type === "session")
				return unavailable("invalid-record", lineNumber);
			if (disk.has(value.id as string) || value.id === sessionId)
				return unavailable("duplicate-id", lineNumber);
			disk.set(value.id as string, { value, lineNumber });
		}
		if (!foundHeader) return unavailable("missing-header");
		if (entryIndex < 0) return { status: "absent" };
		const selected = branch[entryIndex] as Record<string, unknown>;
		const saved = disk.get(selected.id as string);
		if (!saved) return unavailable("selected-record-missing");
		if (!isDeepStrictEqual(selected, saved.value))
			return unavailable("selected-record-mismatch", saved.lineNumber);
		const semantic = readSessionProfileEntry({
			type: selected.type as string,
			customType: selected.customType as string,
			data: selected.data,
		});
		return { ...semantic, entryIndex, lineNumber: saved.lineNumber };
	} catch {
		// Never expose exception messages or record contents (including getters).
		return unavailable("unserializable-source");
	}
}
