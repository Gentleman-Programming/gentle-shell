// Gentle Tower: every live Gentle Shell session, from the peer presence registry
// Gentle Agents already keeps (<home>/gentle-agents/presence). Read-only and
// bounded. A session without the tower extension becomes a *basic* floor: name,
// project and its live helpers, no tasks or cost, and it takes no actions.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { nameSubagents, TOWER_SNAPSHOT_VERSION, type TowerSnapshot } from "./tower-snapshot.ts";

const MAX_BYTES = 256 * 1024;
const LIVE = new Set(["queued", "running", "waiting"]);
/** A session whose heartbeat is older than this is gone. */
export const PRESENCE_MAX_AGE_MS = 2 * 60_000;

export function defaultPresenceDirs(home: string = homedir()): string[] {
	return [join(home, ".gentle-shell", "agent", "gentle-agents", "presence"), join(home, ".pi", "agent", "gentle-agents", "presence")];
}

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		const st = lstatSync(path);
		if (!st.isFile() || st.size > MAX_BYTES) return undefined;
		const v = JSON.parse(readFileSync(path, "utf8"));
		return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
	} catch { return undefined; }
}

/** Absolute on any platform: `/home/me/app` or `C:\\work\\app` (the registry may come from another OS). */
const absolute = (p: string) => posix.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);
const basename = (p: string) => win32.basename(p) || p;

export type PresenceFloor = TowerSnapshot & { basic: true; sessionHash: string };

export function readPresenceFloors(dirs: readonly string[], now: number, maxAgeMs = PRESENCE_MAX_AGE_MS): PresenceFloor[] {
	const best = new Map<string, PresenceFloor>();
	for (const dir of dirs) {
		let names: string[];
		try { names = readdirSync(dir).filter((n) => n.endsWith(".header.json")); } catch { continue; }
		for (const name of names) {
			const header = readJson(join(dir, name));
			const hash = header?.sessionHash, heartbeat = header?.heartbeat;
			if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash) || typeof heartbeat !== "number") continue;
			if (header?.unavailable || now - heartbeat > maxAgeMs) continue;
			const meta = (readJson(join(dir, name.replace(/\.header\.json$/, ".discovery.json")))?.metadata ?? {}) as { workspace?: unknown; tasks?: unknown };
			const cwd = typeof meta.workspace === "string" && absolute(meta.workspace) ? meta.workspace : undefined;
			if (!cwd) continue;
			const tasks = (Array.isArray(meta.tasks) ? meta.tasks : []) as Array<{ id?: unknown; agent?: unknown; label?: unknown; status?: unknown }>;
			const live = tasks.filter((t) => !!t && typeof t === "object" && typeof t.id === "string" && typeof t.agent === "string" && LIVE.has(String(t.status)))
				.slice(0, 12).map((t) => ({ id: String(t.id), agent: String(t.agent), label: typeof t.label === "string" ? t.label : undefined, status: String(t.status) }));
			const floor: PresenceFloor = {
				version: TOWER_SNAPSHOT_VERSION,
				sessionId: `p-${hash.slice(0, 32)}`,
				sessionHash: hash,
				name: typeof header.label === "string" && header.label.trim() ? header.label.trim().slice(0, 120) : basename(cwd),
				project: { cwd, name: basename(cwd) },
				model: "",
				context: { percent: null, window: 0 },
				cost: { total: 0, input: 0, output: 0 },
				todos: [],
				subagents: nameSubagents(live).map((a) => ({ id: a.id, role: a.role, name: a.name, status: a.status ?? "running", cost: 0, tokens: 0 })),
				basic: true,
				updatedAt: heartbeat,
			};
			const prev = best.get(hash);
			if (!prev || prev.updatedAt < floor.updatedAt) best.set(hash, floor);
		}
	}
	return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}
