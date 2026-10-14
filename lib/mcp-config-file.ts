import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

// Atomic mcp.json writes: create parents defensively, write a unique temp
// file in the target directory, then rename it over the target, so readers
// never observe a partial config. Cleans the temp file up on failure.
export async function writeMcpJsonFile(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = join(dirname(path), `.mcp-${randomUUID()}.tmp`);
	try {
		await writeFile(tmp, content, "utf8");
		await rename(tmp, path);
	} catch (error) {
		try {
			await unlink(tmp);
		} catch {
			// Already gone; report the original failure below.
		}
		throw error;
	}
}
