import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

async function proveLazyDiscovery(): Promise<void> {
	const {
		createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
		ModelRuntime, SessionManager, SettingsManager,
	} = await import("@earendil-works/pi-coding-agent");
	const cwd = process.cwd();
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	const shim = join(cwd, "extensions.ts");
	const source = (name: string) => JSON.stringify(new URL(`../extensions/${name}.ts`, import.meta.url).href);
	writeFileSync(shim, `
import { createGentleAiExtension } from ${source("gentle-ai")};
import gentleAgents from ${source("gentle-agents")};
import sddInit from ${source("sdd-init")};
export default function (pi) {
  createGentleAiExtension({ nativeReviewCli: null, candidateViews: null, processEnv: {} })(pi);
  gentleAgents(pi);
  sddInit(pi);
}
`);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "empty-auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
	});
	const runtime = await createAgentSessionRuntime(async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd, agentDir, modelRuntime,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
			resourceLoaderOptions: {
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				additionalExtensionPaths: [shim],
			},
		});
		assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
		assert.deepEqual(services.diagnostics, []);
		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: ["subagent_list_agents"] })),
			services, diagnostics: services.diagnostics,
		};
	}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
	try {
		await runtime.session.bindExtensions({ mode: "print" });
		const session = runtime.session;
		const list = session.agent.state.tools.find(tool => tool.name === "subagent_list_agents");
		assert.ok(list, "actual SDK must expose the wrapped discovery tool");
		const names = async () => {
			const result = await list.execute("asset-discovery", {});
			return result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
		};
		const before = await names();
		assert.match(before, /- gentle-ai-explore \(global\)/);
		assert.match(before, /- review-risk \(global\)/);
		assert.doesNotMatch(before, /- sdd-/, "fresh startup must not install SDD definitions");
		assert.equal(existsSync(join(agentDir, "chains", "sdd-full.chain.md")), false);
		assert.equal(existsSync(join(agentDir, "gentle-ai", "support")), false);
		await session.prompt("/gentle:install-sdd");
		assert.strictEqual(runtime.session, session);
		const after = await names();
		for (const name of ["gentle-ai-explore", "review-risk", "sdd-init", "sdd-apply"]) {
			assert.ok(after.includes(`- ${name} (global)`), `same-session discovery must include ${name}`);
		}
		for (const file of ["sdd-status-contract.md", "strict-tdd.md", "strict-tdd-verify.md"]) {
			assert.ok(existsSync(join(agentDir, "gentle-ai", "support", file)), `missing support: ${file}`);
		}
		assert.ok(existsSync(join(agentDir, "chains", "sdd-full.chain.md")));
		assert.equal(session.messages.length, 0, "slash activation must not start a model turn");
		console.log("SDK discovery: delegation/review only -> /gentle:install-sdd -> same-session sdd-init/sdd-apply and support");
	} finally {
		await runtime.dispose();
	}
}

if (process.env.GENTLE_PI_ASSET_PROOF_CHILD === "1") {
	await proveLazyDiscovery();
} else {
	test("actual SDK discovers SDD only after explicit activation in the same session", () => {
		const root = mkdtempSync(join(tmpdir(), "gentle-pi-assets-sdk-"));
		try {
			const home = join(root, "home");
			const cwd = join(root, "project");
			const agentDir = join(home, ".pi", "agent");
			for (const path of [cwd, agentDir]) mkdirSync(path, { recursive: true });
			const result = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url)], {
				cwd, encoding: "utf8", timeout: 30_000,
				env: {
					PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: root,
					PI_CODING_AGENT_DIR: agentDir, GENTLE_PI_AGENT_HOME: agentDir,
					GENTLE_PI_CONFIG_HOME: join(home, "config"), XDG_CONFIG_HOME: join(home, ".config"),
					PI_OFFLINE: "1", GENTLE_PI_ASSET_PROOF_CHILD: "1",
				},
			});
			assert.ifError(result.error);
			assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
			assert.match(result.stdout, /SDK discovery: delegation\/review only/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
