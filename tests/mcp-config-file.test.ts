import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readdir, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMcpJsonFile } from "../lib/mcp-config-file.ts";

async function leftovers(dir: string): Promise<string[]> {
	return (await readdir(dir, { recursive: true })).filter((entry) => entry.endsWith(".tmp"));
}

test("round-trips content and creates parents", async () => {
	const root = await mkdtemp(join(tmpdir(), "mcp-config-"));
	const path = join(root, ".pi", "mcp.json");
	await writeMcpJsonFile(path, `{"mcpServers": {}}`);
	assert.equal(await readFile(path, "utf8"), `{"mcpServers": {}}`);
	assert.deepEqual(await leftovers(root), []);
});

test("failed writes clean up and report", async () => {
	const root = await mkdtemp(join(tmpdir(), "mcp-config-"));
	const locked = join(root, "locked");
	await mkdir(locked);
	await chmod(locked, 0o555);
	const path = join(locked, "mcp.json");
	await assert.rejects(() => writeMcpJsonFile(path, `{}`));
	assert.deepEqual(await leftovers(locked), []);
	await chmod(locked, 0o755);
});
