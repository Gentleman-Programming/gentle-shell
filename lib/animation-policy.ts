import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

export const ANIMATION_POLICY = { QUALITY: "quality", PERFORMANCE: "performance", POTATO: "potato" } as const;
export type AnimationPolicy = (typeof ANIMATION_POLICY)[keyof typeof ANIMATION_POLICY];
const SOURCE = { GLOBAL: "global_file", DEFAULT: "default" } as const;
export const ANIMATION_SCHEMA = "gentle-pi.animations/v1";

interface AnimationOptions { gentlePiConfigHome?: string }
export interface AnimationResolution {
	policy: AnimationPolicy;
	source: (typeof SOURCE)[keyof typeof SOURCE];
	malformed: boolean;
	globalFile: string;
}

export function parseAnimationPolicyFile(raw: string): AnimationPolicy | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		if (!("schema" in value) || value.schema !== ANIMATION_SCHEMA || !("policy" in value) || Object.keys(value).length !== 2) return undefined;
		return value.policy === "quality" || value.policy === "performance" || value.policy === "potato" ? value.policy : undefined;
	} catch { return undefined; }
}

export function resolveAnimationPolicy(options: AnimationOptions = {}): AnimationResolution {
	const globalFile = join(options.gentlePiConfigHome ?? gentlePiConfigHome(), "animations.json");
	try {
		const policy = parseAnimationPolicyFile(readFileSync(globalFile, "utf8"));
		return { policy: policy ?? "quality", source: SOURCE.GLOBAL, malformed: policy === undefined, globalFile };
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return { policy: "quality", source: missing ? SOURCE.DEFAULT : SOURCE.GLOBAL, malformed: !missing, globalFile };
	}
}

/** Same-directory rename prevents readers from seeing a partially written policy. */
export function writeAnimationPolicy(policy: AnimationPolicy, options: AnimationOptions = {}): string {
	const home = options.gentlePiConfigHome ?? gentlePiConfigHome();
	const path = join(home, "animations.json");
	const temporary = `${path}.${randomUUID()}.tmp`;
	mkdirSync(home, { recursive: true });
	try {
		writeFileSync(temporary, `${JSON.stringify({ schema: ANIMATION_SCHEMA, policy })}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename already consumed the temporary file. */ }
	}
	return path;
}
