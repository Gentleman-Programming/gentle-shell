import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DESKTOP_RPC_SCHEMA, DESKTOP_RPC_WIDGET } from "../../lib/desktop-rpc.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

test("installed Pi dispatches Desktop RPC without adding conversation messages", () => {
	const root = mkdtempSync(join(tmpdir(), "desktop-rpc-maintainer-"));
	try {
		for (const name of ["home", "sessions", "tmp"]) mkdirSync(join(root, name));
		const runtime = resolve(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
		const extension = resolve(packageRoot, "extensions/gentle-desktop-rpc.ts");
		const request = { schema: DESKTOP_RPC_SCHEMA, requestId: "real-1", method: "capabilities", params: {} };
		const input = [
			{ id: "prompt-1", type: "prompt", message: `/gentle:desktop ${JSON.stringify(request)}` },
			{ id: "messages-1", type: "get_messages" },
		].map((value) => JSON.stringify(value)).join("\n") + "\n";
		const home = join(root, "home");
		const temporary = join(root, "tmp");
		const child = spawnSync(process.execPath, [
			runtime,
			"--mode", "rpc",
			"--no-extensions", "-e", extension,
			"--session-dir", join(root, "sessions"),
			"--offline", "--no-mcp", "--no-skills", "--no-context-files",
		], {
			cwd: root,
			env: {
				PATH: process.env.PATH,
				HOME: home,
				USERPROFILE: home,
				TMPDIR: temporary,
				TMP: temporary,
				TEMP: temporary,
				PI_OFFLINE: "1",
				PI_NO_LOCAL_LLM: "1",
				NO_COLOR: "1",
				GENTLE_SHELL_INTERACTIVE_HOST: "1",
				GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_TERMINAL_PROMPT: "0",
			},
			input,
			encoding: "utf8",
			timeout: 15000,
		});

		assert.ifError(child.error);
		assert.equal(child.status, 0, child.stderr);
		assert.equal(child.stderr, "");
		const records = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
		const prompt = records.find((record) => record.id === "prompt-1");
		assert.deepEqual(prompt, {
			id: "prompt-1",
			type: "response",
			command: "prompt",
			success: true,
			data: { disposition: "handled" },
		});
		const messages = records.find((record) => record.id === "messages-1");
		assert.deepEqual(messages.data, { messages: [] });

		const widget = records.find((record) => record.type === "extension_ui_request" && record.widgetKey === DESKTOP_RPC_WIDGET);
		assert.equal(widget.method, "setWidget");
		const response = JSON.parse(widget.widgetLines[0]);
		assert.equal(response.schema, DESKTOP_RPC_SCHEMA);
		assert.equal(response.kind, "response");
		assert.equal(response.requestId, "real-1");
		assert.equal(response.ok, true);
		assert.deepEqual(response.data.methods, ["capabilities", "get_snapshot"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
