import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildPiInvocation } from "../../lib/gentle-shell-launcher.ts";

const piRoot = process.env.GENTLE_MCP_STATUS_PI_ROOT;
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

test("Shell child invocation receives native sanitized MCP snapshots and events", {
	skip: !piRoot && "Set GENTLE_MCP_STATUS_PI_ROOT to a built Pi coding-agent package with the status API",
}, () => {
	if (!piRoot) throw new Error("Pi status runtime was not selected");
	const root = mkdtempSync(join(tmpdir(), "shell-mcp-status-"));
	try {
		const home = join(root, "agent");
		const userHome = join(root, "home");
		const temporary = join(root, "tmp");
		for (const path of [home, userHome, temporary]) mkdirSync(path);
		writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: {
			"dev-docs": { command: "never-start", enabled: false, env: { FIXTURE: "fixture-not-public" } },
		} }));
		const extension = join(root, "probe.mjs");
		writeFileSync(extension, `
export default function (pi) {
	const initial = pi.getMcpStatus();
	const events = [];
	const subscription = pi.onMcpStatusChanged((all) => events.push(all));
	pi.registerProvider("mcp-status-fixture", {
		api: "openai-completions", apiKey: "fixture", baseUrl: "http://unused.invalid",
		models: [{
			id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1024, maxTokens: 16,
		}],
		streamSimple() { throw new Error("A status probe must not call a model"); },
	});
	pi.registerCommand("mcp-status-probe", {
		description: "Report native status for an isolated integration probe",
		async handler() {
			subscription.dispose();
			subscription.dispose();
			process.stdout.write(JSON.stringify({ initial, snapshot: pi.getMcpStatus(), events }) + "\\n");
		},
	});
	pi.on("session_shutdown", () => subscription.dispose());
}
`);
		const invocation = buildPiInvocation({
			runtime: { kind: "path", command: process.execPath, args: [resolve(piRoot, "dist/cli.js")] },
			home: { mode: "path", dir: home, source: "flag" },
			packageRoot,
			// Exercise the normal declared-package route, without loading unrelated harness extensions.
			declaration: { kind: "npm" }, takeOver: false, otherPackagePaths: [],
			passthrough: [
				"--no-extensions", "-e", "builtin:mcp", "-e", extension,
				"--no-session", "--provider", "mcp-status-fixture", "--model", "fixture",
				"--print", "/mcp-status-probe",
			],
			baseEnv: {
				PATH: process.env.PATH, HOME: userHome, USERPROFILE: userHome,
				TMPDIR: temporary, TMP: temporary, TEMP: temporary,
				PI_OFFLINE: "1", PI_NO_LOCAL_LLM: "1", NO_COLOR: "1",
				GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
			},
			homedir: userHome, cwd: root,
		});
		const child = spawnSync(invocation.command, invocation.args, {
			cwd: root, env: invocation.env, encoding: "utf8", timeout: 15000,
		});
		assert.ifError(child.error);
		assert.equal(child.status, 0, child.stderr);
		// Pi reserves print-mode stdout for model output and redirects extension writes to stderr.
		assert.equal(child.stdout, "");
		const report = JSON.parse(child.stderr) as { snapshot: Array<{ since: number }> };
		assert.equal(child.stderr, JSON.stringify(report) + "\n");
		const since = report.snapshot[0]?.since;
		assert.equal(typeof since, "number");
		const snapshot = [{ name: "dev_docs", state: "disabled", since }];
		assert.deepEqual(report, { initial: [], snapshot, events: [snapshot] });
		assert.ok(!child.stderr.includes("fixture-not-public"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
