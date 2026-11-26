// A read-only projection of `claude-bridge.json`, the config file of the
// third-party `pi-claude-bridge` Pi package, for users who already have it.
// Gentle Shell does not install, recommend, or write this package or its file.
//
// The file lives in the Pi agent dir and holds the selected plan under
// `provider.plan` (the shape gentle-shell-gpui reads and writes). Only that
// plan crosses, and only when it is a short plain token; every other key, and
// any value that is not such a token, stays here.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ClaudeBridgeRead =
	| { status: "missing" }
	| { status: "invalid" }
	| { status: "valid"; plan: string | null };

const PLAN_TOKEN = /^[A-Za-z0-9._-]{1,32}$/;

export function claudeBridgeConfigPath(agentHome: string): string {
	return join(agentHome, "claude-bridge.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `missing` when the file is absent, `invalid` when it is not a JSON object. */
export function readClaudeBridgeConfig(agentHome: string): ClaudeBridgeRead {
	const path = claudeBridgeConfigPath(agentHome);
	if (!existsSync(path)) return { status: "missing" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return { status: "invalid" };
	}
	if (!isRecord(parsed)) return { status: "invalid" };
	const plan = isRecord(parsed.provider) ? parsed.provider.plan : undefined;
	return { status: "valid", plan: typeof plan === "string" && PLAN_TOKEN.test(plan) ? plan : null };
}
