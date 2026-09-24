import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";
import { ensureSddPreflight } from "../lib/sdd-preflight.ts";

type Hook = (event: unknown, ctx: ExtensionContext) => Promise<{ systemPrompt: string }>;

for (const store of ["openspec", "engram", "hybrid"] as const) {
	for (const selected of [true, false]) {
		test(`classical startup preserves native archive and admits optional verify (store=${store}, selected=${selected})`, async (t) => {
			const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-classical-")));
			t.after(() => rmSync(root, { recursive: true, force: true }));
			const status = {
				schemaName: "gentle-ai.sdd-status", schemaVersion: 2, changeName: "alpha", artifactStore: store,
				planningHome: { mode: "repo-local", path: store === "openspec" ? join(root, "openspec") : "engram:sdd" }, changeRoot: store === "openspec" ? join(root, "openspec/changes/alpha") : null,
				actionContext: { mode: "repo-local", workspaceRoot: root, allowedEditRoots: [root] },
				dependencies: { proposal: "all_done", specs: "all_done", design: "all_done", tasks: "all_done", apply: "all_done", verify: "ready", archive: "ready" },
				phaseInstructions: { apply: [], verify: ["Optional functional verification."], archive: ["Compose applicable specs and archive." ] },
				blockedReasons: [] as string[], nextRecommended: "archive",
			};
			let phase = "verify";
			let reply: unknown = status;
			const hooks = new Map<string, Hook>();
			const pi = {
				on(name: string, hook: Hook) { hooks.set(name, hook); }, events: { emit() {} }, registerCommand() {}, registerTool() {},
				getFlag: () => selected ? JSON.stringify({ changeName: "alpha", workspaceRoot: root, phase }) : undefined,
				getActiveTools: () => [],
			} as unknown as ExtensionAPI;
			const ctx = { cwd: root, hasUI: false, sessionManager: { getSessionId: () => root } } as unknown as ExtensionContext;
			await ensureSddPreflight(ctx, { pi, installAssets: () => ({ agents: 0, chains: 0, support: 0, skipped: 0 }) });
			createGentleAiExtension({ nativeReviewCli: { sddStatus: async () => reply } as unknown as NativeReviewCli, processEnv: {} })(pi);
			const start = () => hooks.get("before_agent_start")!({ agentName: `sdd-${phase}`, systemPrompt: `SDD ${phase} executor` }, ctx);
			for (const next of ["verify", "archive"]) {
				phase = next;
				await t.test(`explicit ${next}`, async () => {
					const result = await start();
					assert.doesNotMatch(result.systemPrompt, /SDD selection blocked:/);
					assert.ok(result.systemPrompt.includes(JSON.stringify(status, null, 2)), "never rewrite the native recommended action");
				});
			}
			phase = "verify";
			reply = { ...status, nextRecommended: "apply", dependencies: { ...status.dependencies, apply: "ready" } };
			await t.test("partial verification", async () => {
				assert.doesNotMatch((await start()).systemPrompt, /SDD selection blocked:/, "explicit partial verification preserves native apply selection");
			});
			reply = { ...status, dependencies: { ...status.dependencies, verify: "blocked" } };
			assert.match((await start()).systemPrompt, /SDD selection blocked:/);
			phase = "archive";
			for (const blocked of [
				{ ...status, nextRecommended: "apply", dependencies: { ...status.dependencies, apply: "ready", archive: "blocked" } },
				{ ...status, blockedReasons: ["edit authority missing"] },
				{ ...status, dependencies: { ...status.dependencies, archive: "blocked" } },
				{ ...status, nextRecommended: "verify" },
			]) {
				reply = blocked;
				assert.match((await start()).systemPrompt, /SDD selection blocked:/);
			}
			phase = "sync";
			reply = status;
			await t.test("stale sync is mechanically blocked", async () => {
				assert.match((await start()).systemPrompt, /SDD selection blocked:/, "stale sync executors must not bypass native authority");
				const callTool = hooks.get("tool_call")! as unknown as (event: unknown, ctx: ExtensionContext) => Promise<{ block?: boolean }>;
				for (const toolName of ["write", "edit", "bash"]) {
					assert.equal((await callTool({ toolName, input: { path: "unsafe.ts", command: "echo unsafe" } }, ctx))?.block, true);
				}
			});
		});
	}
}
