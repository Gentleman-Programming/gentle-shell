import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CANDIDATE_GIT_MAX_BUFFER_BYTES, resolveCandidateGitTimeoutMs, type CandidateGitExecutor } from "./review-candidate-view.ts";

export type CandidateTreeSymlinkScan = "tracks-symlinks" | "no-symlinks" | "unconfirmed";
type DefinitiveScan = Exclude<CandidateTreeSymlinkScan, "unconfirmed">;
const MAX_REF_METADATA_BYTES = 1024 * 1024;

/** Read exactly the inspected size; concurrent size changes make eligibility unknown. */
function readBoundedFile(path: string, size: number): string | undefined {
	const fd = openSync(path, "r");
	try {
		// A concurrent grow/replacement must not turn a small supported read
		// into unbounded allocation or a truncated cache eligibility answer.
		const bytes = Buffer.alloc(size + 1);
		const length = readSync(fd, bytes, 0, bytes.length, 0);
		return length === size && fstatSync(fd).size === size ? bytes.subarray(0, length).toString("utf8") : undefined;
	} finally { closeSync(fd); }
}

/** Fingerprint ref/config metadata without following a symbolic link. */
function identity(path: string): string | undefined {
	const value = lstatSync(path, { bigint: true, throwIfNoEntry: false });
	return value === undefined ? undefined : [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
}

/** Accept only the bounded, sorted files-backend format with no replacement refs. */
function isCanonicalPackedRefs(contents: string): boolean {
	if (!contents.endsWith("\n")) return false;
	const lines = contents.split("\n");
	if (!/^# pack-refs with: (?:peeled )?(?:fully-peeled )?sorted $/.test(lines.shift() ?? "")) return false;
	lines.pop(); // The required final newline is not an empty ref record.
	let previousName = "", peelable = false, oidLength = 0;
	for (const line of lines) {
		if (line.startsWith("^")) {
			if (!peelable || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(line.slice(1)) || line.length !== oidLength + 1) return false;
			peelable = false; continue;
		}
		const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (refs\/[A-Za-z0-9._/-]+)$/.exec(line);
		if (match === null) return false;
		const [, oid, name] = match;
		if (name.includes("..") || name.split("/").some(part => part === "" || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
			|| name.startsWith("refs/replace/") || name <= previousName || (oidLength !== 0 && oid.length !== oidLength)) return false;
		previousName = name; oidLength = oid.length; peelable = name.startsWith("refs/tags/");
	}
	return true;
}

/** Default files backend only; uncertain configuration is never cache authority. */
function replacementFreeView(commonDir: string): string | undefined {
	const config = join(commonDir, "config");
	const beforeConfig = identity(config);
	const configDetails = lstatSync(config);
	if (!configDetails.isFile() || configDetails.isSymbolicLink() || configDetails.size > MAX_REF_METADATA_BYTES) return undefined;
	const configContents = readBoundedFile(config, configDetails.size);
	// Includes and an explicitly selected backend need Git interpretation;
	// retaining an uncached scan avoids implementing its configuration parser.
	if (configContents === undefined || /refstorage|\[\s*include/i.test(configContents)) return undefined;
	const refs = lstatSync(join(commonDir, "refs"));
	if (!refs.isDirectory() || refs.isSymbolicLink() || lstatSync(join(commonDir, "reftable"), { throwIfNoEntry: false }) !== undefined) return undefined;
	const loose = join(commonDir, "refs", "replace");
	const beforeLoose = identity(loose);
	if (beforeLoose !== undefined) {
		const details = lstatSync(loose);
		if (!details.isDirectory() || details.isSymbolicLink()) return undefined;
		const directory = opendirSync(loose);
		try { if (directory.readSync() !== null) return undefined; } finally { directory.closeSync(); }
	}
	const packed = join(commonDir, "packed-refs");
	const beforePacked = identity(packed);
	if (beforePacked !== undefined) {
		const details = lstatSync(packed);
		if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_REF_METADATA_BYTES) return undefined;
		const contents = readBoundedFile(packed, details.size);
		if (contents === undefined || !isCanonicalPackedRefs(contents)) return undefined;
	}
	return beforeLoose === identity(loose) && beforePacked === identity(packed) && beforeConfig === identity(config) ? beforeConfig : undefined;
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

	/** Reuse definitive literal-tree scans only while fresh local metadata proves eligibility. */
	scan(cwd: string, candidateTree: string, verifiedCommonDir?: string): CandidateTreeSymlinkScan {
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
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
				const view = replacementFreeView(common);
				if (view !== undefined) key = `${root}\0${common}\0${view}\0${candidateTree}`;
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
/** Classify a tree for discovery; an unconfirmed scan never authorizes materialization. */
export function scanCandidateTreeForSymlinks(cwd: string, candidateTree: string, verifiedCommonDir?: string): CandidateTreeSymlinkScan {
	return scanner.scan(cwd, candidateTree, verifiedCommonDir);
}
