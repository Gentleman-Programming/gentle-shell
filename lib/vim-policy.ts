import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

export const VIM_POLICY = { ON: "on", OFF: "off" } as const;
export type VimPolicy = (typeof VIM_POLICY)[keyof typeof VIM_POLICY];
export const VIM_SCHEMA = "gentle-pi.vim/v1";
interface VimOptions { gentlePiConfigHome?: string }
export interface VimResolution {
	policy: VimPolicy;
	source: "global_file" | "default";
	malformed: boolean;
	globalFile: string;
}

export function parseVimPolicyFile(raw: string): VimPolicy | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		if (Object.keys(value).length !== 2 || !("schema" in value) || value.schema !== VIM_SCHEMA || !("policy" in value)) return undefined;
		return value.policy === "on" || value.policy === "off" ? value.policy : undefined;
	} catch { return undefined; }
}

export function resolveVimPolicy(options: VimOptions = {}): VimResolution {
	const globalFile = join(options.gentlePiConfigHome ?? gentlePiConfigHome(), "vim.json");
	try {
		const policy = parseVimPolicyFile(readFileSync(globalFile, "utf8"));
		return { policy: policy ?? "off", source: "global_file", malformed: policy === undefined, globalFile };
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return { policy: "off", source: missing ? "default" : "global_file", malformed: !missing, globalFile };
	}
}

export function writeVimPolicy(policy: VimPolicy, options: VimOptions = {}): string {
	const home = options.gentlePiConfigHome ?? gentlePiConfigHome();
	const path = join(home, "vim.json");
	const temporary = `${path}.${randomUUID()}.tmp`;
	mkdirSync(home, { recursive: true });
	try {
		writeFileSync(temporary, `${JSON.stringify({ schema: VIM_SCHEMA, policy })}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ }
	}
	return path;
}
