// Gentle Tower hub: one private JSON file per live session, written atomically.
// Directory 0700, files 0600, write to a temp file then rename (repo convention).

import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isTowerSnapshot, TOWER_SNAPSHOT_MAX_BYTES, type TowerSnapshot } from "./tower-snapshot.ts";

export { TOWER_SNAPSHOT_MAX_BYTES };

/** `GENTLE_TOWER_HOME` overrides the hub for tests and isolated runs. */
export function towerHubDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	return env.GENTLE_TOWER_HOME || join(home, ".gentle-shell", "tower", "sessions");
}

function safeId(sessionId: string): string {
	if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionId) || sessionId.startsWith(".")) throw new Error(`Gentle Tower: unsafe session id ${JSON.stringify(sessionId)}`);
	return sessionId;
}

function privateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const st = lstatSync(dir);
	if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`Gentle Tower: hub is not a directory: ${dir}`);
	if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

export function writeTowerSnapshot(dir: string, snapshot: TowerSnapshot): void {
	const id = safeId(snapshot.sessionId);
	const body = JSON.stringify(snapshot);
	if (Buffer.byteLength(body) > TOWER_SNAPSHOT_MAX_BYTES) throw new Error(`Gentle Tower: snapshot too large (${Buffer.byteLength(body)} bytes)`);
	privateDir(dir);
	const target = join(dir, `${id}.json`);
	const temp = join(dir, `.${id}.${process.pid}.${Date.now()}.tmp`);
	try {
		writeFileSync(temp, body, { mode: 0o600, flag: "wx" });
		renameSync(temp, target);
	} finally {
		rmSync(temp, { force: true });
	}
}

export function removeTowerSnapshot(dir: string, sessionId: string): void {
	rmSync(join(dir, `${safeId(sessionId)}.json`), { force: true });
}

function alive(pid: number | undefined): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return true;
	try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Snapshots whose publishing process is still running (one killed without shutdown left a frozen file). */
export function readLiveTowerSnapshots(dir: string): TowerSnapshot[] {
	return readTowerSnapshots(dir).filter((s) => alive(s.pid));
}

/** Every valid snapshot in the hub; unreadable, oversized or foreign files are skipped. */
export function readTowerSnapshots(dir: string): TowerSnapshot[] {
	let names: string[];
	try { names = readdirSync(dir); } catch { return []; }
	const out: TowerSnapshot[] = [];
	for (const name of names.sort()) {
		if (!name.endsWith(".json") || name.startsWith(".")) continue;
		try {
			const path = join(dir, name);
			const st = lstatSync(path);
			if (!st.isFile() || st.size > TOWER_SNAPSHOT_MAX_BYTES) continue;
			const value = JSON.parse(readFileSync(path, "utf8"));
			if (isTowerSnapshot(value) && `${value.sessionId}.json` === name) out.push(value);
		} catch { /* skip */ }
	}
	return out;
}
