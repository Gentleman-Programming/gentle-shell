import { readFileSync } from "node:fs";
import { join } from "node:path";

// gentle-shell#1494 split the lazy delegation detail into per-mechanism
// modules. Contract tests that assert delegation-scoped clauses read the union
// so a moved clause stays pinned instead of silently disappearing.
export const DELEGATION_MODULES = [
	"orchestrator-delegation.md",
	"orchestrator-tracking.md",
	"orchestrator-verification.md",
	"orchestrator-writer.md",
	"orchestrator-prompts.md",
] as const;

const DEFAULT_ASSETS_DIR = join(import.meta.dirname, "..", "..", "assets");

export function readDelegationDetail(assetsDir: string = DEFAULT_ASSETS_DIR): string {
	return DELEGATION_MODULES.map((file) => readFileSync(join(assetsDir, file), "utf8")).join("\n\n");
}
