// Independent T3 refusal-identity regressions (S1/S3).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const flavor of ["runtime", "typescript"]) {
	test(`refusal identity public probes: ${flavor}`, () => {
		const scratch = mkdtempSync(join(tmpdir(), "identity-regression-"));
		try {
			const run = spawnSync(process.execPath, ["--experimental-strip-types", "--test", "tests/fixtures/refusal-identity.probe.mjs"], {
				cwd: process.cwd(), encoding: "utf8", timeout: 30_000,
				env: { PATH: process.env.PATH, HOME: scratch, USERPROFILE: scratch,
					TMPDIR: scratch, TMP: scratch, TEMP: scratch,
					NODE_COMPILE_CACHE: join(scratch, "cache"), NO_UPDATE_NOTIFIER: "1",
					PROBE_ROOT: process.cwd(), PROBE_FLAVOR: flavor },
			});
			assert.equal(run.status, 0, `${run.error ?? ""}\n${run.stdout}\n${run.stderr}`);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
}
