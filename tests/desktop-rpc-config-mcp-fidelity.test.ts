import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadMcpConfig } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/config.js";
import { createDefaultTransport } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/runtime.js";
import { readMcpConfig } from "../lib/mcp-config.ts";

// The `mcp` store must list exactly the servers Pi would load. Pi does not
// export its loader, so `lib/mcp-config.ts` ports it; this test runs Pi's real
// `loadMcpConfig` from its dist file on the same fixtures, trusted and
// untrusted, so a Pi update that changes the rules fails here.

type Fixture = { global?: unknown; project?: unknown };

const FIXTURES: Record<string, Fixture> = {
	basic: { global: { mcpServers: { fs: { command: "npx", args: ["a"] }, docs: { url: "https://x.example/mcp", enabled: false } } } },
	authOnPlainHttp: {
		global: { mcpServers: { a: { url: "http://example.com/mcp", auth: { provider: "anthropic" } }, b: { url: "http://localhost/mcp", auth: { provider: "anthropic" } }, c: { url: "https://example.com/mcp", auth: { provider: "anthropic" } }, d: { url: "https://example.com/mcp", auth: { provider: "" } } } },
	},
	oauthSubfields: {
		global: {
			mcpServers: {
				o1: { url: "https://x.example/mcp", oauth: { clientId: 5 } },
				o2: { url: "https://x.example/mcp", oauth: { callbackPort: 70000 } },
				o3: { url: "https://x.example/mcp", oauth: { authServerMetadataUrl: "http://evil.example/" } },
				o4: { url: "https://x.example/mcp", oauth: { authServerMetadataUrl: "http://localhost:9000/meta" } },
				o5: { url: "https://x.example/mcp", oauth: { callbackUrl: "http://localhost:3000/callback", callbackPort: 3001 } },
				o6: { url: "https://x.example/mcp", oauth: { callbackUrl: "http://example.com/callback" } },
				o7: { url: "https://x.example/mcp", oauth: { clientRegistration: "cimd" } },
				o8: { url: "https://x.example/mcp", oauth: { clientRegistration: "cimd", callbackUrl: "http://localhost:3000/other" } },
				o9: { url: "https://x.example/mcp", oauth: { clientRegistration: "cimd", clientId: "id" } },
				o10: { url: "https://x.example/mcp", oauth: { clientRegistration: "bogus" } },
				o11: { url: "https://x.example/mcp", oauth: { clientName: "  " } },
				o12: { url: "https://x.example/mcp", oauth: { scope: 1 } },
				o13: { url: "https://x.example/mcp", oauth: { clientSecret: "s", clientId: "id", callbackPort: 4000 } },
				o14: { url: "https://x.example/mcp", oauth: "yes" },
			},
		},
	},
	overrides: {
		global: { mcpServers: { internal: { url: "https://internal.example/mcp" }, other: { command: "x" }, keep: { command: "k" } } },
		project: { mcpServers: { internal: { enabled: false }, other: { enabled: false, description: "extra key" }, orphan: { enabled: true }, keep: { exposure: "direct", toolExposure: { t: "hidden" } } } },
	},
	disabled: { global: { mcpServers: { a: { command: "a", enabled: false }, b: { url: "https://b.example/mcp", enabled: true } } }, project: { mcpServers: { c: { command: "c", enabled: false } } } },
	malformedEntries: {
		global: {
			mcpServers: {
				bad1: { command: "x", enabled: "no" },
				"bad.name": { command: "x" },
				ftp: { url: "ftp://x/mcp" },
				t0: { command: "x", timeout: 0 },
				hdr: { url: "https://x.example/mcp", headers: { a: 1 } },
				typemix: { type: "stdio", url: "https://x.example/mcp" },
				args: { command: "x", args: [1] },
				env: { command: "x", env: { A: 1 } },
				exposure: { command: "x", exposure: "loud" },
				alias: { command: "x", exposure: "codemode-deferred" },
				arr: [],
				ok: { command: "x" },
			},
		},
	},
	commandAndUrl: { global: { mcpServers: { both: { command: "x", url: "https://both.example/mcp" }, typedStdio: { type: "stdio", command: "x", url: "https://typed.example/mcp" }, typedHttp: { type: "http", command: "x", url: "https://h.example/mcp" } } } },
	sse: { global: { mcpServers: { s: { type: "sse", url: "https://x.example/sse" }, h: { type: "streamable-http", url: "https://x.example/mcp" } } } },
	nameClash: { global: { mcpServers: { "my-tool": { command: "a" }, my_tool: { command: "b" } } }, project: { mcpServers: { "my-tool": { command: "c" }, other_one: { command: "d" }, "other-one": { command: "e" } } } },
	projectAuth: { global: { mcpServers: {} }, project: { mcpServers: { p: { url: "https://p.example/mcp", auth: { provider: "anthropic" } } } } },
	brokenProject: { global: { mcpServers: { a: { command: "a" } } }, project: "{ not json" },
	notAnObject: { global: { mcpServers: [] }, project: { mcpServers: { b: { command: "b" } } } },
};

function piTransport(transport: object): "stdio" | "http" {
	const kind = transport.constructor.name;
	if (kind === "StreamableHttpTransport") return "http";
	if (kind === "StdioTransport") return "stdio";
	throw new Error(`unexpected Pi transport ${kind}`);
}

function write(path: string, value: unknown): void {
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

for (const [label, fixture] of Object.entries(FIXTURES)) {
	for (const projectTrusted of [true, false]) {
		test(`mcp matches Pi's loadMcpConfig: ${label} (${projectTrusted ? "trusted" : "untrusted"})`, (t) => {
			const root = mkdtempSync(join(tmpdir(), "desktop-config-mcp-fidelity-"));
			t.after(() => rmSync(root, { recursive: true, force: true }));
			const agentDir = join(root, "agent");
			const cwd = join(root, "workspace");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			if (fixture.global !== undefined) write(join(agentDir, "mcp.json"), fixture.global);
			if (fixture.project !== undefined) write(join(cwd, ".pi", "mcp.json"), fixture.project);

			// The transport is the one Pi's own factory builds for the entry (constructing
			// a transport neither spawns nor connects), not a rule restated here.
			const pi = loadMcpConfig({ agentDir, cwd, projectTrusted }).servers.map((s) => ({
				name: s.name,
				transport: piTransport(createDefaultTransport(s, cwd, undefined)),
				enabled: s.config.enabled !== false,
			}));
			assert.deepEqual(readMcpConfig({ agentHome: agentDir, cwd, projectTrusted }).servers, pi);
		});
	}
}
