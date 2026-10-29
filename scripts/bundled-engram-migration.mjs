// Explicit bundled-store recovery. The provider owns catalog validation and
// migration; Shell owns promotion and its core-bound provenance. Never called
// from ordinary startup or upgrade.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { engramProbeAllowed, engramProvenancePath, parseEngramProvenance } from "../runtime/gentle-shell-bundled.mjs";

export const MIGRATION_USAGE = "Usage: gentle-shell memory migrate --confirm-quiescent\nStop every Engram client before running this command.\n";
export const MIGRATION_PENDING_NOTICE = "Engram memory disabled: an incomplete memory migration needs recovery. Keep every Engram client stopped, retain the original backup, and follow docs/bundled-install.md#recovering-an-interrupted-migration. Do not remove the migration marker or create a new store before recovery.";
export const migrationMarkerPath = (prefix) => join(prefix, "config", "engram-migration.json");
export function migrationPending(prefix) {
	try { lstatSync(migrationMarkerPath(prefix)); return true; }
	catch (error) { return error.code !== "ENOENT"; }
}
function regularText(path, limit) {
	const info = lstatSync(path);
	if (!info.isFile() || info.size > limit) throw new Error("unsafe migration metadata");
	return readFileSync(path, "utf8");
}
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
// Durably record a file or a directory entry change. Windows cannot open a
// directory for fsync; there NTFS metadata journaling covers the renames.
function syncPath(path, directory = false) {
	if (directory && process.platform === "win32") return;
	const fd = openSync(path, "r");
	try { fsyncSync(fd); } finally { closeSync(fd); }
}
function coreHelp(core, env) {
	// Older cores route unknown commands through legacy startup. Inspect their
	// config-free help in an isolated home, never try an unknown data command.
	const scratch = mkdtempSync(join(tmpdir(), "gentle-engram-capability-"));
	try {
		const probe = spawnSync(core, ["--help"], {
			cwd: scratch, env: { ...env, HOME: scratch, USERPROFILE: scratch, ENGRAM_DATA_DIR: join(scratch, "store") },
			encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000, maxBuffer: 65536, windowsHide: true,
		});
		return !probe.error && !probe.signal && probe.status === 0 && probe.stderr === "" ? probe.stdout.split("\n").map((line) => line.trim()) : [];
	} finally { rmSync(scratch, { recursive: true, force: true }); }
}
function supportsMigration(core, env) {
	return coreHelp(core, env).includes("migrate-copy --data-dir <absolute-source> --output-dir <new-absolute-destination> --confirm-quiescent --json");
}

export function migrateBundledEngram({ prefix, core, home, env }) {
	let markerOwned = false;
	let promotionStarted = false;
	let output;
	let backup;
	try {
		if (!core) throw new Error("the verified bundled core is unavailable; run gentle-shell setup first");
		if (!engramProbeAllowed(env)) throw new Error("explicit Engram selections or a disabled startup policy must be resolved before bundled migration");
		if (migrationPending(prefix)) throw new Error(MIGRATION_PENDING_NOTICE);
		const source = join(realpathSync(home), ".engram");
		if (!lstatSync(source).isDirectory() || realpathSync(source) !== source) throw new Error("the source must be a regular default store directory");
		const provenancePath = engramProvenancePath(prefix);
		const original = regularText(provenancePath, 4096);
		const record = parseEngramProvenance(original);
		const identity = regularText(join(source, ".instance-id"), 128).trim();
		if (!record || record.dataDir !== source || record.instanceId !== identity) throw new Error("the store does not match Shell's recorded identity; it cannot be adopted");
		const coreHash = digest(core);
		const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("ENGRAM_") && key !== "GH_TOKEN" && key !== "GITHUB_TOKEN"));
		childEnv.ENGRAM_NO_UPDATE_CHECK = "1";
		if (!supportsMigration(core, childEnv)) throw new Error("the bundled core does not support migrate-copy; wait for a supporting published bundle. The source and provenance are unchanged");
		const suffix = randomUUID();
		output = `${source}.migrating-${suffix}`;
		backup = `${source}.before-${suffix}`;
		const marker = migrationMarkerPath(prefix);
		mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
		// A recorded refusal precedes copying/promotion. A killed launcher must not
		// mistake the rename gap for a fresh install and provision an empty store.
		writeFileSync(marker, `${JSON.stringify({ source, output, backup, originalProvenance: record })}\n`, { flag: "wx", mode: 0o600 });
		markerOwned = true;
		syncPath(marker);
		syncPath(dirname(marker), true);
		const result = spawnSync(core, ["migrate-copy", "--data-dir", source, "--output-dir", output, "--confirm-quiescent", "--json"], {
			env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000, maxBuffer: 16384, windowsHide: true,
		});
		if (result.error || result.signal) throw new Error("the provider failed or timed out; no source promotion was attempted");
		if (result.status !== 0) throw new Error(`the provider rejected migration (exit ${result.status}): ${result.stderr.trim().slice(0, 2048) || "no diagnostic"}`);
		if (result.stderr !== "") throw new Error("unexpected provider diagnostic with success evidence");
		let proof;
		try { proof = JSON.parse(result.stdout); } catch { throw new Error("invalid provider migration evidence"); }
		if (!proof || proof.migration_completed !== true || proof.source_dir !== source || proof.output_dir !== output || proof.instance_id !== identity) {
			throw new Error("provider migration evidence does not match the requested store and copy");
		}
		if (!lstatSync(output).isDirectory() || realpathSync(output) !== output ||
			regularText(join(output, ".instance-id"), 128).trim() !== identity ||
			regularText(join(source, ".instance-id"), 128).trim() !== identity ||
			regularText(provenancePath, 4096) !== original || digest(core) !== coreHash) {
			throw new Error("store, provenance or bundled core changed during migration");
		}
		// The original is retained, not deleted. From this point any failure keeps
		// the marker: recovery must reconcile both paths before another launch.
		promotionStarted = true;
		renameSync(source, backup);
		renameSync(output, source);
		syncPath(dirname(source), true);
		const temporary = `${provenancePath}.${suffix}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ schema: 1, dataDir: source, instanceId: identity, coreSha256: coreHash })}\n`, { flag: "wx", mode: 0o600 });
		syncPath(temporary);
		renameSync(temporary, provenancePath);
		syncPath(dirname(provenancePath), true);
		// Only a durable promotion and provenance may release the fail-closed marker.
		rmSync(marker);
		// The migration is complete; a failed final sync must not report failure.
		try { syncPath(dirname(marker), true); } catch { /* Best effort. */ }
		return { code: 0, stdout: `${JSON.stringify({ status: "migrated", instance_id: identity, backup_dir: backup })}\n`, stderr: "" };
	} catch (error) {
		if (markerOwned && !promotionStarted) {
			try { rmSync(migrationMarkerPath(prefix)); } catch { /* Keep the fail-closed marker. */ }
		}
		const retained = output ? ` Any partial copy at ${output} is retained; do not use it.` : "";
		const recovery = promotionStarted ? ` Promotion may be incomplete; original backup: ${backup}. ${MIGRATION_PENDING_NOTICE}` : "";
		return { code: 1, stdout: "", stderr: `gentle-shell: memory migration failed: ${error.message}.${retained}${recovery}\n` };
	}
}
