import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNativeReviewCli, createNodeExecFileAdapter, NativeReviewConsentRequiredError } from "../lib/native-review-cli.ts";

// gentle-ai#6203: against the real provider (gentle-ai main) an agent-escalated
// medium candidate's START reports risk high. Stops at the consent question: no
// reviewer capture, and consent is never answered.
const binary = process.env.GENTLE_AI_REAL_BINARY ?? join(process.env.HOME ?? "", "go", "bin", "gentle-ai");

test("real provider: START carries the escalation so the consent reads high; without it medium", { skip: !existsSync(binary) }, async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gp-escalate-")));
	const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
	try {
		const repo = join(root, "repo");
		mkdirSync(join(root, "home")); mkdirSync(join(root, "tmp")); mkdirSync(repo);
		process.env.HOME = join(root, "home"); process.env.TMPDIR = join(root, "tmp");
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
		git("init", "-q"); git("config", "user.email", "t@example.invalid"); git("config", "user.name", "t");
		writeFileSync(join(repo, "a.txt"), "a\n"); git("add", "."); git("commit", "-qm", "init");
		writeFileSync(join(repo, "a.txt"), Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n");
		const risk = async (escalate?: { item: 2; reason: string }): Promise<unknown> => {
			const cli = createNativeReviewCli(createNodeExecFileAdapter(), () => binary);
			try { await cli.start({ cwd: repo, ...(escalate === undefined ? {} : { escalate }) }); }
			catch (error) {
				if (!(error instanceof NativeReviewConsentRequiredError)) throw error;
				return JSON.stringify(error.consent.raw);
			}
			throw new Error("expected the provider to ask for consent");
		};
		const escalated = String(await risk({ item: 2, reason: "changes the auth boundary" }));
		assert.match(escalated, /"risk_(?:tier|level)":\s*"high"/);
		const plain = String(await risk());
		assert.doesNotMatch(plain, /"risk_(?:tier|level)":\s*"high"/);
	} finally {
		for (const key of ["HOME", "TMPDIR"] as const) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
		rmSync(root, { recursive: true, force: true });
	}
});
