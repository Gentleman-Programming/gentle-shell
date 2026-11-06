import { constants } from "node:fs";
import fs from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const AUTO_PERMISSION_EVIDENCE_BYTES = 8192;
export const AUTO_PERMISSION_EVIDENCE_LIMITS = ["path-count", "provider-rounds", "file-count", "duplicate-file",
	"context-bytes", "invalid-byte-budget", "file-stat-bytes", "file-read-bytes"] as const;
export type AutoPermissionEvidenceLimit = typeof AUTO_PERMISSION_EVIDENCE_LIMITS[number];
/** Host-only discriminator; the public error message remains unchanged. */
export class AutoPermissionEvidenceLimitError extends Error {
	readonly evidenceLimit: AutoPermissionEvidenceLimit;
	constructor(evidenceLimit: AutoPermissionEvidenceLimit) {
		super("evidence-limit");
		this.evidenceLimit = evidenceLimit;
	}
}
const forbidden = /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.azure|\.config|\.gnupg|\.kube|\.docker|\.pi|\.worktrees|node_modules(?:\..*)?|\.npmrc|\.netrc|\.pypirc|auth\.json|oauth.*|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx)|.*(?:credentials?|secrets?|passwords?|tokens?).*)$/i;

/** Exact host-selected paths, not a model-selected project crawl. Paths never grant permission. */
export function resolveAutoPermissionEvidencePath(cwd: string, paths: readonly string[], path: string): string {
	if (!isAbsolute(cwd) || typeof path !== "string" || !path || path.length > 1024
		|| /[\p{Cc}\p{Cf}\p{Cs}]/u.test(path) || path.includes("\\") || path.includes(":")
		|| isAbsolute(path) || path.split("/").some(part => !part || part === "." || part === ".." || forbidden.test(part))
		|| !paths.includes(path)) throw Error("evidence-unavailable");
	const target = resolve(cwd, path), local = relative(cwd, target);
	if (!local || local.startsWith(`..${sep}`) || isAbsolute(local)) throw Error("evidence-unavailable");
	return target;
}

/** Read a complete regular UTF-8 file without execution, truncation or symlink traversal.
 * Component and inode checks are repeated before reading to reject path replacement races.
 * This is conservative evidence collection, not an OS sandbox against a hostile local process. */
export async function readAutoPermissionEvidence(options: {
	cwd: string; paths: readonly string[]; path: string; signal?: AbortSignal; maxBytes?: number;
}): Promise<{ path: string; content: string }> {
	const cancelled = () => { if (options.signal?.aborted) throw Error("cancelled"); };
	cancelled();
	const target = resolveAutoPermissionEvidencePath(options.cwd, options.paths, options.path);
	const maxBytes = Math.min(AUTO_PERMISSION_EVIDENCE_BYTES, options.maxBytes ?? AUTO_PERMISSION_EVIDENCE_BYTES);
	if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new AutoPermissionEvidenceLimitError("invalid-byte-budget");
	let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
	try {
		const root = resolve(options.cwd);
		if (await fs.realpath(root) !== root) throw Error("evidence-unavailable");
		const check = async () => {
			let current = root;
			for (const part of options.path.split("/")) {
				current = resolve(current, part);
				const stat = await fs.lstat(current);
				if (stat.isSymbolicLink() || (current !== target && !stat.isDirectory())) throw Error("evidence-unavailable");
			}
			if (await fs.realpath(target) !== target) throw Error("evidence-unavailable");
			const stat = await fs.lstat(target);
			if (!stat.isFile() || stat.nlink !== 1) throw Error("evidence-unavailable");
			return stat;
		};
		const before = await check();
		if (before.size > maxBytes) throw new AutoPermissionEvidenceLimitError("file-stat-bytes");
		cancelled();
		handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const opened = await handle.stat(), after = await check();
		if (opened.dev !== before.dev || opened.ino !== before.ino || opened.dev !== after.dev || opened.ino !== after.ino
			|| !opened.isFile() || opened.nlink !== 1) throw Error("evidence-unavailable");
		cancelled();
		// Fixed-size buffer bounds even a file that grows after stat; never silently truncate.
		const buffer = Buffer.alloc(maxBytes + 1);
		let bytes = 0;
		while (bytes < buffer.length) {
			cancelled();
			const chunk = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
			if (!chunk.bytesRead) break;
			bytes += chunk.bytesRead;
		}
		cancelled();
		if (bytes > maxBytes) throw new AutoPermissionEvidenceLimitError("file-read-bytes");
		const final = await handle.stat();
		if (final.size !== bytes || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) throw Error("evidence-unavailable");
		const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
		if (content.includes("\u0000") || /[\p{Cf}\p{Cs}]/u.test(content)) throw Error("evidence-unavailable");
		return { path: options.path, content };
	} catch (error) {
		if (options.signal?.aborted) throw Error("cancelled");
		if (error instanceof Error && ["evidence-limit", "evidence-unavailable"].includes(error.message)) throw error;
		throw Error("evidence-unavailable"); // Never expose filesystem error details or file contents.
	} finally {
		try { await handle?.close(); } catch { throw Error("evidence-unavailable"); }
	}
}
