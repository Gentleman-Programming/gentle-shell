import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// gentle-shell#2926: pnpm 11 runs an implicit `pnpm install` before
// `pnpm run`/`pnpm exec` unless verifyDepsBeforeRun is off. In a worktree whose
// node_modules links to another checkout that install tries to purge the shared
// node_modules and aborts without a TTY. These pins keep the setting, keep it
// out of published packages, and keep every workflow installing explicitly.

const root = join(import.meta.dirname, "..");
const read = (relative: string): string => readFileSync(join(root, relative), "utf8");

test("#2926: pnpm-workspace.yaml disables the implicit install before run", () => {
	const workspace = read("pnpm-workspace.yaml");
	const values = [...workspace.matchAll(/^verifyDepsBeforeRun:\s*(\S+)\s*$/gm)].map((match) => match[1]);
	assert.deepEqual(values, ["false"], "verifyDepsBeforeRun must be set once to false; install and prompt break non-TTY shells");
	assert.match(workspace, /^nodeLinker: hoisted$/m);
});

test("#2926: the repository pnpm-workspace.yaml is not published", () => {
	const files = (JSON.parse(read("package.json")) as { files?: string[] }).files ?? [];
	assert.ok(files.length > 0, "package.json must keep an explicit files allowlist");
	assert.ok(!files.some((entry) => entry.replace(/^\.\//, "").startsWith("pnpm-workspace")), "pnpm-workspace.yaml must stay out of the package");
});

function workflowJobs(text: string): Array<{ name: string; body: string }> {
	const jobsAt = text.search(/^jobs:\s*$/m);
	if (jobsAt < 0) return [];
	const jobs: Array<{ name: string; body: string }> = [];
	let current: { name: string; lines: string[] } | undefined;
	for (const line of text.slice(jobsAt).split("\n").slice(1)) {
		const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
		if (header) {
			if (current) jobs.push({ name: current.name, body: current.lines.join("\n") });
			current = { name: header[1], lines: [] };
		} else if (/^\S/.test(line)) break;
		else current?.lines.push(line);
	}
	if (current) jobs.push({ name: current.name, body: current.lines.join("\n") });
	return jobs;
}

test("#2926: every workflow job installs dependencies before pnpm test, run or exec", () => {
	const dir = ".github/workflows";
	let checked = 0;
	for (const file of readdirSync(join(root, dir)).filter((name) => /\.ya?ml$/.test(name))) {
		for (const job of workflowJobs(read(join(dir, file)))) {
			const usesPnpm = job.body.search(/\bpnpm (test|run|exec)\b/);
			if (usesPnpm < 0) continue;
			checked++;
			const install = job.body.search(/\bpnpm install --frozen-lockfile\b/);
			assert.ok(install >= 0 && install < usesPnpm, `${file} job ${job.name} runs pnpm test/run/exec before pnpm install --frozen-lockfile`);
		}
	}
	assert.ok(checked > 0, "expected at least one workflow job that runs pnpm test/run/exec");
});
