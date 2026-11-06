import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CANDIDATE_GIT_MAX_BUFFER_BYTES, resolveCandidateGitTimeoutMs, type CandidateGitExecutor } from "./review-candidate-view.ts";

export type CandidateTreeSymlinkScan = "tracks-symlinks" | "no-symlinks" | "unconfirmed";
type DefinitiveScan = Exclude<CandidateTreeSymlinkScan, "unconfirmed">;

function readPackedRefs(path: string, size: number): string | undefined {
	const fd = openSync(path, "r");
	try {
		// A concurrent grow/replacement must not turn a small supported read
		// into unbounded allocation or a truncated cache eligibility answer.
		const bytes = Buffer.alloc(size + 1);
		const length = readSync(fd, bytes, 0, bytes.length, 0);
		return length === size && fstatSync(fd).size === size ? bytes.subarray(0, length).toString("utf8") : undefined;
	} finally { closeSync(fd); }
}

function identity(path: string): string | undefined {
	const value = lstatSync(path, { bigint: true, throwIfNoEntry: false });
	return value === undefined ? undefined : [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
}

/** Only the files ref backend with a freshly verified empty replacement namespace. */
function hasNoReplacements(commonDir: string): boolean {
	const refs = lstatSync(join(commonDir, "refs"));
	if (!refs.isDirectory() || refs.isSymbolicLink() || lstatSync(join(commonDir, "reftable"), { throwIfNoEntry: false }) !== undefined) return false;
	const loose = join(commonDir, "refs", "replace");
	const beforeLoose = identity(loose);
	if (beforeLoose !== undefined) {
		const details = lstatSync(loose);
		if (!details.isDirectory() || details.isSymbolicLink() || readdirSync(loose).length > 0) return false;
	}
	const packed = join(commonDir, "packed-refs");
	const beforePacked = identity(packed);
	if (beforePacked !== undefined) {
		const details = lstatSync(packed);
		if (!details.isFile() || details.isSymbolicLink() || details.size > 1024 * 1024) return false;
		const contents = readPackedRefs(packed, details.size);
		if (contents === undefined) return false;
		for (const line of contents.split(/\r?\n/)) {
			if (line === "" || line.startsWith("#") || /^\^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(line)) continue;
			if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64}) refs\/[^\x00-\x20\x7f]+$/.test(line) || line.includes(" refs/replace/")) return false;
		}
	}
	return beforeLoose === identity(loose) && beforePacked === identity(packed);
}

/** Discovery only: materialization, filesystem identity and authority stay fresh. */
export class CandidateTreeSymlinkScanner {
	private readonly entries = new Map<string, DefinitiveScan>();
	private readonly execute: CandidateGitExecutor;
	private readonly capacity: number;
	constructor(execute: CandidateGitExecutor = (file, args, options) => execFileSync(file, args, options), capacity = 128) {
		if (!Number.isSafeInteger(capacity) || capacity < 1) throw new TypeError("Invalid scan cache capacity");
		this.execute = execute;
		this.capacity = capacity;
	}

	scan(cwd: string, candidateTree: string, verifiedCommonDir?: string): CandidateTreeSymlinkScan {
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
		const options = { cwd, env, encoding: "utf8" as const, windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
			timeout: resolveCandidateGitTimeoutMs(), maxBuffer: CANDIDATE_GIT_MAX_BUFFER_BYTES };
		let key: string | undefined;
		try {
			if (verifiedCommonDir !== undefined && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(candidateTree)) {
				const root = realpathSync(cwd);
				const common = realpathSync(verifiedCommonDir);
				// No extra Git process on a warm scan. Unknown backend, oversized
				// or malformed refs and active replacements always scan uncached.
				if (hasNoReplacements(common)) key = `${root}\0${common}\0${candidateTree}`;
			}
		} catch { /* An unavailable cache eligibility check never borrows old data. */ }
		if (key !== undefined) {
			const cached = this.entries.get(key);
			if (cached !== undefined) {
				this.entries.delete(key); this.entries.set(key, cached);
				return cached;
			}
		}
		try {
			// Cache only literal object contents: a replacement appearing during
			// this scan cannot poison the reusable answer. With active/unknown
			// replacements keep the original Git interpretation instead.
			const listing = this.execute("git", [...(key === undefined ? [] : ["--no-replace-objects"]),
				"ls-tree", "-r", "--full-tree", candidateTree], options).toString();
			const result: DefinitiveScan = listing.split("\n").some(line => line.startsWith("120000 ")) ? "tracks-symlinks" : "no-symlinks";
			if (key !== undefined) {
				this.entries.set(key, result);
				if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
			}
			return result;
		} catch { return "unconfirmed"; }
	}
}

const scanner = new CandidateTreeSymlinkScanner();
export function scanCandidateTreeForSymlinks(cwd: string, candidateTree: string, verifiedCommonDir?: string): CandidateTreeSymlinkScan {
	return scanner.scan(cwd, candidateTree, verifiedCommonDir);
}
