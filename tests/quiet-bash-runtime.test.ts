import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

async function proveNativeBash() {
	const { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
		ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const cwd = process.cwd();
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	const shellPath = process.env.GENTLE_TEST_SHELL!;
	// Hide Windows default discovery only inside this isolated child. The explicit
	// shell remains usable; on POSIX the prefix also detects a recreated executor.
	for (const key of Object.keys(process.env)) if (key.toLowerCase() === "path") process.env[key] = "";
	process.env.ProgramFiles = join(cwd, "absent-git");
	process.env["ProgramFiles(x86)"] = join(cwd, "absent-git-x86");
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "empty-auth.json"),
		modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false });
	for (const quiet of [false, true]) {
		const runtime = await createAgentSessionRuntime(async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime,
				settingsManager: SettingsManager.inMemory({ shellPath, shellCommandPrefix: "printf configured-prefix;",
					retry: { enabled: false }, compaction: { enabled: false } }),
				resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true,
					noThemes: true, noContextFiles: true,
					additionalExtensionPaths: quiet ? [fileURLToPath(new URL("../extensions/quiet-tools.ts", import.meta.url))] : [] },
			});
			assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
			return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: ["bash"] })),
				services, diagnostics: services.diagnostics };
		}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
		try {
			await runtime.session.bindExtensions({ mode: "print" });
			const bash = runtime.session.agent.state.tools.find(tool => tool.name === "bash");
			assert.ok(bash);
			const result = await bash.execute("configured-shell", { command: "printf native-ok" }, new AbortController().signal);
			assert.equal(result.content.filter(part => part.type === "text").map(part => part.text).join("\n"),
				"configured-prefixnative-ok", `quiet=${quiet}: native effective shell settings must survive`);
			assert.equal(runtime.session.messages.length, 0);
			console.log(`native Bash configured settings: quiet=${quiet} passed`);
		} finally { await runtime.dispose(); }
	}
}

if (process.env.GENTLE_TEST_BASH_CHILD === "1") {
	await proveNativeBash();
} else {
	test("quiet tools preserve actual SDK configured Bash execution (#107)", (t) => {
		const candidates = process.platform === "win32"
			? [join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"), "C:\\Program Files\\Git\\usr\\bin\\bash.exe"]
			: ["/bin/bash", "/usr/bin/bash"];
		const shell = candidates.find(existsSync);
		if (!shell) { t.skip("requires an installed Bash; no binary installation is performed"); return; }
		const root = mkdtempSync(join(tmpdir(), "gentle-quiet-bash-sdk-"));
		const cwd = join(root, "project");
		const home = join(root, "home");
		const agentDir = join(home, "agent");
		for (const path of [cwd, agentDir]) mkdirSync(path, { recursive: true });
		const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"),
			PI_CODING_AGENT_DIR: agentDir, GENTLE_PI_AGENT_HOME: agentDir, GENTLE_PI_CONFIG_HOME: join(home, "gentle-config"),
			PI_OFFLINE: "1", GENTLE_PI_QUIET_TOOLS: "1", GENTLE_TEST_BASH_CHILD: "1", GENTLE_TEST_SHELL: shell };
		try {
			const result = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url)],
				{ cwd, env, encoding: "utf8", timeout: 30_000 });
			assert.ifError(result.error);
			assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\nfixture: ${root}`);
			assert.match(result.stdout, /quiet=false passed/);
			assert.match(result.stdout, /quiet=true passed/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
