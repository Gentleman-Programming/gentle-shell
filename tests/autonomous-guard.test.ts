import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

const { classifyGuardedCommand, evaluateGuardedCommand, guardedCommandPreview, guardedCommandTitle, isReversibleYoloCommand, yoloConfiguredRestriction } = __testing;

// gentle-shell#2172: YOLO waives every reversible push and non-interactive
// rebase segment; anything that deletes, rewrites or publishes keeps asking.
test("YOLO waives reversible push and rebase segments after full evaluation (#2172)", () => {
	const config = { autonomousMode: false, guardedCommands: {} };
	for (const command of [
		"git push", "git push -u origin feature/test", "git push --set-upstream origin main", "git push origin HEAD",
		"git push -q origin main", "git push --quiet --tags", "git push --no-verify origin main", "git push --follow-tags -v origin main",
		"git push origin HEAD:refs/heads/feature/x", "git push origin main:main",
		"git -C /other push origin main", "env X=1 git push origin main",
		"git add -A && git commit -m 'fix: x && y' && git push -u origin feature/test",
		"git push origin main && gh pr create --fill", "cd sub && git push", "git push origin main; git status",
		"git rebase main", "git rebase origin/main", "git rebase --onto main feature~3 feature", "git rebase --continue", "git rebase --abort", "git rebase --autostash main",
		"git fetch origin && git rebase origin/main && git push",
		"git\tpush\torigin\tmain", "git -C dir rebase main", "command git push origin main", "env -i git push origin main", "GIT_AUTHOR_NAME=x git push origin main",
	]) {
		assert.equal(isReversibleYoloCommand(command, evaluateGuardedCommand(command, config)), true, command);
	}
	for (const command of [
		"git push --delete origin main", "git push -d origin main", "git push origin :main", "git push origin +main", "git push --mirror origin",
		"git push --prune origin", "git push --all origin", "git push -f origin main", "git push --force-with-lease origin main",
		"git push --receive-pack=evil origin main", "git push --exec=evil origin main", "git push --repo=/other origin main", "git push -o ci.skip origin main",
		"sudo git push origin main", "git push origin main && npm publish", "git push origin main && pi remove foo", "git push origin main && git branch -D old",
		`sh -c 'git push origin main'`, `git push origin main && sh -c "psql -c 'DROP TABLE users'"`,
		"git push origin main && find data -delete", "git push origin main && rm -r data", "git push origin main && git stash drop", "git push origin main && git reset --hard",
		"git rebase -i HEAD~3", "git rebase --interactive main", "git rebase -x 'make test' main", "git rebase --exec 'make test' main",
		"git commit -m x", "git status",
		// Global git options that run or redirect code are not inspected by the segment grammar, so they never qualify.
		"git -c core.sshCommand=evil push origin main", "git --exec-path=/evil push origin main", "git --git-dir=/x push origin main", "git -C dir rebase -i main",
		"git push origin $(echo main)", "git push origin `echo main`", "GIT_SSH=\"evil\" git push origin main",
		"sh -c 'git push; echo done'", "bash -c 'git push && echo done'", "sh -c 'git rebase main; echo done'", "eval 'git push origin main'", "sudo -u x git push origin main",
	]) assert.equal(isReversibleYoloCommand(command, evaluateGuardedCommand(command, config)), false, command);
});

// YOLO also waives recursive removal of the session's own temp scratch: one
// literal path component under a temp root whose admission-time lstat is
// missing, a symlink, an own file or an own mktemp directory. Every other
// effect in the command keeps its ordinary guard.
test("YOLO waives recursive removal of own temp scratch only", () => {
	const config = { autonomousMode: false, guardedCommands: {} };
	const entry = (type: "dir" | "file" | "link", uid = 1000) => ({
		uid, isDirectory: () => type === "dir", isFile: () => type === "file", isSymbolicLink: () => type === "link",
	});
	const entries = new Map([
		["/tmp/tmp.8phya1BpFr", entry("dir")], ["/tmp/tmp.LKd1kBX8Rw", entry("dir")], ["/tmp/tmp.C94OVzf01o", entry("dir")],
		["/tmp/ctx-backstop-pnpm-test.log", entry("file")], ["/tmp/tmp.abcdef1234", entry("dir")], ["/tmp/latest", entry("link", 0)],
		["/var/tmp/tmp.zzzzzz", entry("dir")], ["/tmp/cache", entry("dir")], ["/tmp/tmp.other1234", entry("dir", 0)],
		["/tmp/shared.log", entry("file", 0)],
	]);
	const fs = {
		uid: 1000, tmpdir: "/tmp", home: "/home/user",
		lstat(path: string) {
			if (path === "/tmp/tmp.denied99") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			const found = entries.get(path);
			if (found === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
			return found;
		},
	};
	const waived = (command: string) => isReversibleYoloCommand(command, evaluateGuardedCommand(command, config), fs);
	for (const command of [
		"rm -rf /tmp/tmp.8phya1BpFr /tmp/tmp.LKd1kBX8Rw /tmp/tmp.C94OVzf01o /tmp/ctx-backstop-pnpm-test.log; cd /home/gentleman/work/gentle-pi-worktrees/harness-r1 && git log --oneline -1",
		"rm -rf /tmp/tmp.abcdef1234", "rm -rf /tmp/ctx-backstop-pnpm-test.log", "rm -rf /tmp/latest", "rm -rf /tmp/tmp.gone1234",
		"rm -r -f -- /var/tmp/tmp.zzzzzz", "rm -rf /tmp/tmp.abcdef1234 && git push -u origin feature/x",
		"rm -rf /tmp/tmp.abcdef1234 && rm -rf /tmp/tmp.gone1234\nrm -rf /tmp/latest || git log --oneline -1",
	]) assert.equal(waived(command), true, command);
	for (const command of [
		"rm -rf /tmp", "rm -rf /tmp/", "rm -rf /tmp/*", "rm -rf /tmp/tmp.x/", "rm -rf /tmp/tmp.x/../..", "rm -rf /tmp/./tmp.x",
		"rm -rf /tmp/a/b", `rm -rf "$TMPDIR/x"`, "rm -rf $TMPDIR/x", "rm -rf /tmp/tmp.{a,b}", "rm -rf /tmp/tmp.abc?", "rm -rf tmp.abcdef1234",
		"sudo rm -rf /tmp/tmp.abcdef1234", "xargs rm -rf /tmp/tmp.abcdef1234", "rm -rf --no-preserve-root /tmp/tmp.abcdef1234",
		"rm -rf /tmp/tmp.abcdef1234 ~/foo", "rm -rf /tmp/tmp.abcdef1234 && rm -rf data", "rm -rf /tmp/tmp.abcdef1234 data",
		"rm -rf /tmp/tmp.abcdef1234 && find /tmp/x -delete", "rm -rf /tmp/tmp.abcdef1234 && psql -c 'DROP TABLE users'",
		"rm -rf /tmp/tmp.abcdef1234 && git push --delete origin main", "rm -rf /tmp/tmp.abcdef1234 && npm publish",
		"rm -rf /tmp/tmp.abcdef1234 && git stash drop", "rm -rf /tmp/cache", "rm -rf /tmp/tmp.other1234", "rm -rf /tmp/shared.log",
		"rm -rf /tmp/tmp.denied99", "rm -rf /home/user/tmp.abcdef1234", "sh -c 'rm -rf /tmp/tmp.abcdef1234'",
		"find /tmp -maxdepth 1 -name 'tmp.*' -exec rm -rf {} +", "rm -rf /tmp/tmp.gone1234>important.txt", "rm -rf /tmp/tmp.gone1234 2>/dev/null",
		// Ordering: an earlier segment can move data into a target the lstat saw as scratch.
		"mv /home/u/data /tmp/tmp.missingZZ619976 && rm -rf /tmp/tmp.missingZZ619976", "mv /home/u/data /tmp/tmp.abcdef1234 && rm -rf /tmp/tmp.abcdef1234",
		"cp -r x /tmp/tmp.abcdef1234; rm -rf /tmp/tmp.abcdef1234", "echo hi; rm -rf /tmp/tmp.abcdef1234", "ln -s /home/u/data /tmp/tmp.gone1234 && rm -rf /tmp/tmp.gone1234",
		"(mv /home/u/data /tmp/tmp.abcdef1234) && rm -rf /tmp/tmp.abcdef1234", "(rm -rf /tmp/tmp.abcdef1234)",
		"rm -rf /tmp/tmp.abcdef1234 & mv /home/u/data /tmp/tmp.abcdef1234", "rm -rf /tmp/tmp.abcdef1234 | cat",
		"rm -rf /tmp/tmp.gone1234; mv /home/u/data /tmp/tmp.abcdef1234; rm -rf /tmp/tmp.abcdef1234",
	]) assert.equal(waived(command), false, command);
	// A tmpdir under home would make top-level repository files look like scratch.
	const underHome = { ...fs, home: "/home/gentleman", tmpdir: "/home/gentleman/work/repo", lstat: () => entry("file") };
	assert.equal(isReversibleYoloCommand("rm -rf /home/gentleman/work/repo/README.md", evaluateGuardedCommand("rm -rf /home/gentleman/work/repo/README.md", config), underHome), false);
	// A missing uid (no POSIX ownership) never proves own scratch.
	assert.equal(isReversibleYoloCommand("rm -rf /tmp/tmp.abcdef1234", evaluateGuardedCommand("rm -rf /tmp/tmp.abcdef1234", config), { ...fs, uid: undefined }), false);
});

// An eligible push or rebase stays waived with fd or /dev/null redirections
// and a pipe into a read-only filter; any other redirection or consumer asks.
test("YOLO waives push and rebase segments with harmless redirections and read-only filters", () => {
	const config = { autonomousMode: false, guardedCommands: {} };
	const entry = { uid: 1000, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
	const fs = { uid: 1000, tmpdir: "/tmp", home: "/home/user", lstat: () => entry };
	const waived = (command: string) => isReversibleYoloCommand(command, evaluateGuardedCommand(command, config), fs);
	for (const command of [
		"git push origin main 2>&1", "git push -u origin feat/x 2>&1 | tail -5", "git push origin main >/dev/null", "git push origin main 2>/dev/null",
		"git push origin main &>/dev/null", "git push origin main > /dev/null 2>&1", "git push origin main 2>&1 | grep -v hint | head -20",
		"git push origin main | cat", "git push origin main 2>&1 | wc -l && gh pr create --fill", "git push 2>&1 | grep 'remote: '",
		"git rebase origin/main 2>&1 | tail -3", "git fetch && git rebase origin/main >/dev/null && git push 2>&1 | tail -5",
		"rm -rf /tmp/tmp.abcdef1234; git push origin main 2>&1 | tail -5",
	]) assert.equal(waived(command), true, command);
	for (const command of [
		"git push origin main > out.txt", "git push origin main 2>err.log", "git push origin main >> /dev/null.txt", "git push origin main &>log",
		"git push origin main | sh", "git push origin main | tee out", "git push origin main 2>&1 | tail -5 | sh", "git push origin main | tail -5 > out",
		"git push origin main | catx", "git push origin main 2>&1 &", "git push origin main | tail -5 &", "git push origin main | grep \"$(id)\"",
		"git push --force origin main 2>&1", "git push --delete origin main 2>&1 | tail -5", "git push origin :main 2>&1", "git push --mirror origin 2>&1",
		"git rebase -i main 2>&1 | tail", "git push origin main 2>&1 | xargs echo",
	]) assert.equal(waived(command), false, command);
});

// gentle-shell#2174: a guarded word inside an argument of a known data command
// (search, print, view, non-executing edit) is text, not an operation. Every
// opaque form keeps today's lexical match.
test("guarded words inside data-command arguments are not guarded operations (#2174)", () => {
	const config = { autonomousMode: false, guardedCommands: {} };
	for (const command of [
		"grep -n 'git push origin main' probe.mts",
		"grep -o '\"command\":\"[^\"]*git push[^\"]*\"' session.jsonl | sort | uniq -c | sort -rn | head -8",
		"rg 'npm publish' docs",
		"echo 'remember to git push later'",
		"cat > probe.mts <<'EOF'\nconst x = \"git push --force origin main\";\nEOF",
		"grep -rn 'git reset --hard' docs",
		"env LC_ALL=C grep 'pi remove' notes.md",
		"grep -l \"git push\" a.jsonl",
		// A data-only command substitution or a plain assignment keeps the exemption.
		"f=$(ls); grep -l \"git push\" $f",
		"cd x; f=$(ls -t */*.jsonl | head -40); grep -l \"git push\" $f 2>/dev/null | head -5",
		"grep -l 'git push' $(ls *.jsonl)", "f=1; grep 'git push' x", "grep \"git push $(pwd)\" x", "f=$(ls); grep -rn 'git reset --hard' docs",
	]) assert.equal(classifyGuardedCommand(command, config), "not-guarded", command);
	for (const [command, expected] of [
		["git push origin main", "confirm"],
		["grep x file && git push origin main", "confirm"],
		["sh -c 'git push origin main'", "confirm"],
		["bash <<'EOF'\ngit push origin main\nEOF", "confirm"],
		["python3 -c \"import os; os.system('git push')\"", "confirm"],
		["echo $(git push origin main)", "confirm"],
		["x=$(ls); git push origin main", "confirm"],
		["x=$(git push origin main); grep 'git push' $x", "confirm"],
		["f=$(ls); $f push origin main; grep 'git push' x", "confirm"],
		["grep 'git push' $(cat x | sh)", "confirm"],
		["grep 'git push' $(echo $(git push))", "confirm"],
		["grep 'git push' $((1+2))", "confirm"],
		["cat <<EOF\ndon't $(git push origin main)\nEOF", "confirm"],
		["PATH=/x; git push origin main", "confirm"],
		["x=$(ls); git reset --hard", "block"],
		["grep 'git push origin main' f | sh", "confirm"],
		["time git push origin main", "confirm"],
		["sed 's/x/git push/e' file", "confirm"],
		["grep \"git push origin main file", "confirm"],
		["ssh host git push origin main", "confirm"],
		["cat <<'EOF' | bash\ngit push -f origin main\nEOF", "block"],
		["git reset --hard", "block"],
		["echo ok; git push --force origin main", "block"],
		// Verifier counterexamples: every executor or unproven heredoc keeps the lexical guard.
		["cat <<EOF; git push origin main\nhello\nEOF", "confirm"],
		["cat <<EOF; chmod -R 777 /tmp/guard-target\nhello\nEOF", "block"],
		["echo '<<true'\ngit push --force origin main\ntrue", "block"],
		["printf '%s\\n' 'git push --force origin main' | xargs env", "block"],
		["printf '%s\\n' 'git push origin main' | sudo -s", "confirm"],
		["printf '%s\\n' 'git push origin main' | env -S 'sh -s'", "confirm"],
		["printf '%s\\n' 'git push origin main' | exec -a cat sh", "confirm"],
		["printf '%s\\n' 'git push origin main' | builtin source /dev/stdin", "confirm"],
		["printf '%s\\n' 'git push origin main' | $'sh'", "confirm"],
		["printf x | sed 's|.*|git push --force origin main|e'", "block"],
		["printf x | sed '1e git push origin main'", "confirm"],
		["echo 'git push origin main' | at now", "confirm"],
		["echo 'git push origin main' > x.sh && ./x.sh", "confirm"],
		["sed -i '' 's/a/git push/' file", "confirm"],
	] as const) assert.equal(classifyGuardedCommand(command, config), expected, command);
});

test("YOLO preserves explicit push restrictions in either config layer independently of persistent autonomy", () => {
	const root = makeTmpDir();
	const cwd = join(root, "repo");
	const home = join(root, "home");
	try {
		const pushOnly = (): unknown => yoloConfiguredRestriction(cwd, ["gitPush"], { gentlePiConfigHome: home });
		assert.equal(pushOnly(), undefined);
		writeConfig(home, "runtime-guardrails.json", { autonomousMode: false, guardedCommands: { gitPush: "confirm" } });
		writeConfig(cwd, ".pi/gentle-ai/runtime-guardrails.json", { autonomousMode: true, guardedCommands: { gitPush: "allow" } });
		assert.equal(pushOnly(), "confirm");
		writeConfig(home, "runtime-guardrails.json", { autonomousMode: true, guardedCommands: { gitPush: "allow" } });
		assert.equal(pushOnly(), undefined);
		writeConfig(cwd, ".pi/gentle-ai/runtime-guardrails.json", { guardedCommands: { gitPush: "block" } });
		assert.equal(pushOnly(), "block");
		writeConfig(cwd, ".pi/gentle-ai/runtime-guardrails.json", { guardedCommands: { gitPush: "confirm" } });
		assert.equal(pushOnly(), "confirm");
		writeConfig(cwd, ".pi/gentle-ai/runtime-guardrails.json", null);
		assert.equal(pushOnly(), "confirm");
		// gentle-shell#2172: a rebase rule restricts only commands that rebase.
		writeConfig(cwd, ".pi/gentle-ai/runtime-guardrails.json", { guardedCommands: { gitRebase: "block" } });
		assert.equal(pushOnly(), undefined, "a rebase rule does not restrict a push-only command");
		assert.equal(yoloConfiguredRestriction(cwd, ["gitPush", "gitRebase"], { gentlePiConfigHome: home }), "block");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("recognized data loss requires fresh confirmation across autonomous and mixed commands", () => {
	for (const command of [
		`psql -c 'DROP TABLE users'`,
		`mysql -e 'TRUNCATE TABLE users'`,
		`sqlite3 app.db 'DELETE FROM users'`,
		`git push origin main && rm -rf ./data`,
		`sh -c "psql -c 'DROP DATABASE app'"`,
	]) {
		assert.equal(classifyGuardedCommand(command, { autonomousMode: true, guardedCommands: { gitPush: "allow" } }), "confirm", command);
	}
	assert.equal(classifyGuardedCommand(`psql -c 'DROP TABLE users' && npm publish`, {
		autonomousMode: true, guardedCommands: { npmPublish: "block" },
	}), "block", "configured blocks still take precedence");
});

test("quoted separator arguments cannot waive hard denial or invent destruction", () => {
	const config = { autonomousMode: true, guardedCommands: { gitPush: "allow" as const } };
	for (const command of [`git push ';' -f main`, `git push '|' --force main`, `rm -r ';' /`]) {
		assert.equal(classifyGuardedCommand(command, config), "block", command);
	}
	for (const command of [
		String.raw`sh -c "psql -c \"DROP TABLE users\""`,
		`psql -c 'DELETE FROM "where"'`,
		String.raw`find cache -exec echo {} \; -exec rm -r {} \;`,
		`sudo -n rm -r ./data`, `command -p psql -c 'DROP TABLE users'`,
	]) {
		assert.equal(classifyGuardedCommand(command, config), "confirm", command);
	}
	for (const command of [`echo ';' rm -r cache`, `printf '%s ' ';' rm -r ./data`]) {
		assert.equal(classifyGuardedCommand(command, config), "not-guarded", command);
	}
});

// gentle-pi#2285: compound bodies, backticks and eval reach the data-loss
// boundary, while the YOLO scratch waiver still covers leading direct `rm` only.
test("removal after reserved words, in backticks and in eval needs fresh confirmation and is never scratch-waived", () => {
	const config = { autonomousMode: true, guardedCommands: { gitPush: "allow" as const } };
	for (const command of [`if true; then rm -rf data; fi`, `for d in a b; do rm -rf "$d"; done`, "echo `rm -rf data`", `eval 'rm -rf data'`]) {
		const evaluation = evaluateGuardedCommand(command, config);
		assert.equal(evaluation.action, "confirm", command);
		assert.equal(evaluation.dataLoss, true, command);
	}
	for (const command of [`if true; then rm -rf ~; fi`, "echo `rm -rf /`", `eval 'rm -rf "$HOME"'`]) {
		assert.equal(classifyGuardedCommand(command, config), "block", command);
	}
	for (const command of [`if [ -f x ]; then echo ok; fi`, `for f in *; do cat "$f"; done`, "echo `date`", `eval "$(ssh-agent -s)"`, `grep "then rm -rf" x`]) {
		assert.equal(classifyGuardedCommand(command, config), "not-guarded", command);
	}
	const entry = { uid: 1000, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
	const fs = { uid: 1000, tmpdir: "/tmp", home: "/home/user", lstat: () => entry };
	const normal = { autonomousMode: false, guardedCommands: {} };
	assert.equal(isReversibleYoloCommand("rm -rf /tmp/tmp.abcdef1234", evaluateGuardedCommand("rm -rf /tmp/tmp.abcdef1234", normal), fs), true);
	for (const command of [
		`if true; then rm -rf /tmp/tmp.abcdef1234; fi`, `for d in a; do rm -rf /tmp/tmp.abcdef1234; done`, `{ rm -rf /tmp/tmp.abcdef1234; }`,
		`! rm -rf /tmp/tmp.abcdef1234`, "echo `rm -rf /tmp/tmp.abcdef1234`", `eval 'rm -rf /tmp/tmp.abcdef1234'`, `eval rm -rf /tmp/tmp.abcdef1234`,
		"rm -rf /tmp/tmp.abcdef1234 && echo `rm -rf data`", `rm -rf /tmp/tmp.abcdef1234; eval 'rm -rf data'`,
	]) {
		const evaluation = evaluateGuardedCommand(command, normal);
		assert.equal(evaluation.action, "confirm", command);
		assert.equal(isReversibleYoloCommand(command, evaluation, fs), false, command);
	}
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "gentle-pi-autonomous-"));
}

function writeConfig(dir: string, relPath: string, content: unknown): void {
	const full = join(dir, relPath);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, JSON.stringify(content, null, 2));
}

// ---------------------------------------------------------------------------
// classifyGuardedCommand — base contract
// ---------------------------------------------------------------------------

test("classifyGuardedCommand: git push plain → confirm by default (no autonomous mode)", () => {
	const result = classifyGuardedCommand("git push origin main", {
		autonomousMode: false,
		guardedCommands: {},
	});
	assert.equal(result, "confirm");
});

test("classifyGuardedCommand: git rebase → confirm by default (no autonomous mode)", () => {
	const result = classifyGuardedCommand("git rebase main", {
		autonomousMode: false,
		guardedCommands: {},
	});
	assert.equal(result, "confirm");
});

test("classifyGuardedCommand: npm publish → confirm by default (no autonomous mode)", () => {
	const result = classifyGuardedCommand("npm publish", {
		autonomousMode: false,
		guardedCommands: {},
	});
	assert.equal(result, "confirm");
});

test("classifyGuardedCommand: unknown command → not-guarded", () => {
	const result = classifyGuardedCommand("echo hello", {
		autonomousMode: false,
		guardedCommands: {},
	});
	assert.equal(result, "not-guarded");
});

// ---------------------------------------------------------------------------
// Hard-deny always blocks regardless of autonomous mode or config
// ---------------------------------------------------------------------------

test("classifyGuardedCommand: git push --force always blocked even with gitPush=allow", () => {
	const result = classifyGuardedCommand("git push --force origin main", {
		autonomousMode: true,
		guardedCommands: { gitPush: "allow" },
	});
	assert.equal(result, "block");
});

test("classifyGuardedCommand: git push --force-with-lease always blocked", () => {
	const result = classifyGuardedCommand("git push --force-with-lease origin main", {
		autonomousMode: true,
		guardedCommands: { gitPush: "allow" },
	});
	assert.equal(result, "block");
});

test("classifyGuardedCommand: git push -f always blocked even in autonomous mode", () => {
	const result = classifyGuardedCommand("git push -f origin main", {
		autonomousMode: true,
		guardedCommands: { gitPush: "allow" },
	});
	assert.equal(result, "block");
});

test("classifyGuardedCommand: git reset --hard always blocked", () => {
	const result = classifyGuardedCommand("git reset --hard HEAD~1", {
		autonomousMode: true,
		guardedCommands: {},
	});
	assert.equal(result, "block");
});

test("classifyGuardedCommand: rm -rf / always blocked", () => {
	const result = classifyGuardedCommand("rm -rf /", {
		autonomousMode: true,
		guardedCommands: {},
	});
	assert.equal(result, "block");
});

test("classifyGuardedCommand: rm -rf ~ always blocked", () => {
	const result = classifyGuardedCommand("rm -rf ~", {
		autonomousMode: true,
		guardedCommands: {},
	});
	assert.equal(result, "block");
});

test("classifyGuardedCommand: chmod -R 777 always blocked", () => {
	const result = classifyGuardedCommand("chmod -R 777 /etc", {
		autonomousMode: true,
		guardedCommands: {},
	});
	assert.equal(result, "block");
});

// ---------------------------------------------------------------------------
// Autonomous mode + allow action
// ---------------------------------------------------------------------------

test("classifyGuardedCommand: git push plain allowed when autonomousMode=true and gitPush=allow", () => {
	const result = classifyGuardedCommand("git push origin feature/test", {
		autonomousMode: true,
		guardedCommands: { gitPush: "allow" },
	});
	assert.equal(result, "allow");
});

test("classifyGuardedCommand: configured push allow is remote-agnostic and unchanged", () => {
	const config = { autonomousMode: true, guardedCommands: { gitPush: "allow" as const } };
	for (const command of [
		"git push origin feature/test",
		"git push upstream feature/test",
		"git push fork feature/test",
		"git push",
		"git push feature/test && git status",
		"echo done || git push origin feature/test",
	]) {
		assert.equal(classifyGuardedCommand(command, config), "allow", command);
	}
	assert.equal(
		classifyGuardedCommand("git push origin feature/test", { autonomousMode: true, guardedCommands: { gitPush: "block" } }),
		"block",
	);
	for (const command of [
		"git push -f origin feature/test",
		"git push --force origin main",
		"git push --force-with-lease origin feature/test",
	]) {
		assert.equal(classifyGuardedCommand(command, config), "block", command);
	}
});

// ---------------------------------------------------------------------------
// Guarded command preview — presentation-only centering
// ---------------------------------------------------------------------------

test("guardedCommandPreview: long late matched action stays visible in preview", () => {
	const prefix = "noise ".repeat(80);
	const command = `${prefix}git push origin feature/test`;
	// Contract: the caller owns the trigger index. confirmCommand hands over
	// evaluation.triggerIndex, so the preview always centers on the matched
	// action supplied by the evaluator.
	const triggerIndex = command.indexOf("git push");
	const preview = guardedCommandPreview(command, triggerIndex);
	assert.match(preview, /git push origin feature\/test/);
	assert.ok(preview.startsWith("…"), "preview elides leading context near a late match");
});

test("guardedCommandPreview: late non-push action visible, elided, and width-bounded", () => {
	const prefix = "noise ".repeat(80);
	const command = `${prefix}npm publish --tag beta`;
	const triggerIndex = command.indexOf("npm publish");
	const preview = guardedCommandPreview(command, triggerIndex);
	assert.match(preview, /npm publish --tag beta/);
	assert.ok(preview.startsWith("…"), "preview elides leading context near a late match");
	// Bounded visible width: 1 leading ellipsis + up to 179 content chars (budget 180).
	assert.ok(preview.length <= 180, `preview exceeds bounded width: ${preview.length}`);
});

// ---------------------------------------------------------------------------
// Guarded command title — presentation-only, action-specific
// ---------------------------------------------------------------------------

test("guardedCommandTitle: exact action-specific titles per guarded key", () => {
	assert.equal(guardedCommandTitle("gitPush"), "Allow guarded git push?");
	assert.equal(guardedCommandTitle("gitRebase"), "Allow guarded git rebase?");
	assert.equal(
		guardedCommandTitle("gitBranchDeleteForce"),
		"Allow guarded forced git branch deletion?",
	);
	assert.equal(guardedCommandTitle("npmPublish"), "Allow guarded npm publish?");
	assert.equal(guardedCommandTitle("piRemove"), "Allow guarded pi remove?");
});

test("guardedCommandTitle: unkeyed guarded command falls back to generic title", () => {
	assert.equal(guardedCommandTitle(undefined), "Allow guarded command?");
});

test("evaluateGuardedCommand: collects guarded matches in command order and applies full-command precedence", () => {
	const command = "npm publish && git push origin main && git rebase main";
	const evaluation = evaluateGuardedCommand(command, {
		autonomousMode: true,
		guardedCommands: { gitPush: "allow", gitRebase: "confirm", npmPublish: "block" },
	});
	assert.deepEqual(evaluation.matches.map((match) => [match.key, match.action]), [
		["npmPublish", "block"],
		["gitPush", "allow"],
		["gitRebase", "confirm"],
	]);
	assert.deepEqual(evaluation.matches.map((match) => command.slice(match.triggerIndex).split(/\s/, 1)[0]), ["publish", "push", "rebase"]);
	assert.equal(evaluation.action, "block");

	assert.equal(evaluateGuardedCommand("git rebase main && git push --force origin main", {
		autonomousMode: true,
		guardedCommands: { gitRebase: "allow", gitPush: "allow" },
	}).action, "block", "a later hard deny overrides an earlier allowed action");
});

test("evaluateGuardedCommand: git -C stores the push token offset for bounded previews", () => {
	const command = `git -C /${"very-long-path/".repeat(30)} push origin main`;
	const evaluation = evaluateGuardedCommand(command, { autonomousMode: false, guardedCommands: {} });
	assert.equal(command.slice(evaluation.triggerIndex, evaluation.triggerIndex + 4), "push");
	assert.match(guardedCommandPreview(command, evaluation.triggerIndex), /push origin main/);
});

test("evaluateGuardedCommand: git -C path containing push still offsets the push action", () => {
	const command = `git -C /${"push-path/".repeat(30)} push origin main`;
	const evaluation = evaluateGuardedCommand(command, { autonomousMode: false, guardedCommands: {} });
	assert.equal(evaluation.triggerIndex, command.lastIndexOf("push"));
	assert.match(guardedCommandPreview(command, evaluation.triggerIndex), /push origin main/);
});

test("evaluateGuardedCommand: repeated forced branch deletions remain separate matches", () => {
	const command = "git branch --delete --force old && git branch --delete --force older";
	const evaluation = evaluateGuardedCommand(command, { autonomousMode: false, guardedCommands: {} });
	assert.deepEqual(evaluation.matches.map((match) => match.key), ["gitBranchDeleteForce", "gitBranchDeleteForce"]);
	assert.equal(
		guardedCommandTitle(evaluation.key, evaluation.matches),
		"Allow guarded actions: forced git branch deletion; forced git branch deletion?",
	);
});

test("classifyGuardedCommand: git push plain still confirm when autonomousMode=false even with gitPush=allow in config", () => {
	const result = classifyGuardedCommand("git push origin feature/test", {
		autonomousMode: false,
		guardedCommands: { gitPush: "allow" },
	});
	assert.equal(result, "confirm");
});

// ---------------------------------------------------------------------------
// Autonomous mode + confirm action (stays gated)
// ---------------------------------------------------------------------------

test("classifyGuardedCommand: git rebase stays confirm when autonomousMode=true and gitRebase=confirm", () => {
	const result = classifyGuardedCommand("git rebase main", {
		autonomousMode: true,
		guardedCommands: { gitRebase: "confirm" },
	});
	assert.equal(result, "confirm");
});

test("classifyGuardedCommand: git branch -D stays confirm in autonomous mode (gitBranchDeleteForce=confirm)", () => {
	const result = classifyGuardedCommand("git branch -D old-feature", {
		autonomousMode: true,
		guardedCommands: { gitBranchDeleteForce: "confirm" },
	});
	assert.equal(result, "confirm");
});

test("classifyGuardedCommand: git branch -df stays confirm in autonomous mode", () => {
	const result = classifyGuardedCommand("git branch -df old-feature", {
		autonomousMode: true,
		guardedCommands: { gitBranchDeleteForce: "confirm" },
	});
	assert.equal(result, "confirm");
});

test("classifyGuardedCommand: git branch --delete --force stays confirm in autonomous mode", () => {
	const result = classifyGuardedCommand("git branch --delete --force old-feature", {
		autonomousMode: true,
		guardedCommands: { gitBranchDeleteForce: "confirm" },
	});
	assert.equal(result, "confirm");
});

// ---------------------------------------------------------------------------
// Autonomous mode + block action
// ---------------------------------------------------------------------------

test("classifyGuardedCommand: npm publish blocked when autonomousMode=true and npmPublish=block", () => {
	const result = classifyGuardedCommand("npm publish", {
		autonomousMode: true,
		guardedCommands: { npmPublish: "block" },
	});
	assert.equal(result, "block");
});

// ---------------------------------------------------------------------------
// loadRuntimeGuardrailsConfig — file loading
// ---------------------------------------------------------------------------

test("loadRuntimeGuardrailsConfig: returns off config when no file exists", () => {
	const dir = makeTmpDir();
	try {
		const config = __testing.loadRuntimeGuardrailsConfig(dir, {
			gentlePiConfigHome: join(dir, "global-config"),
		});
		assert.equal(config.autonomousMode, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadRuntimeGuardrailsConfig: env var GENTLE_PI_AUTONOMOUS_MODE=1 activates mode", () => {
	const original = process.env.GENTLE_PI_AUTONOMOUS_MODE;
	process.env.GENTLE_PI_AUTONOMOUS_MODE = "1";
	const dir = makeTmpDir();
	try {
		const config = __testing.loadRuntimeGuardrailsConfig(dir, {
			gentlePiConfigHome: join(dir, "global-config"),
		});
		assert.equal(config.autonomousMode, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		if (original === undefined) delete process.env.GENTLE_PI_AUTONOMOUS_MODE;
		else process.env.GENTLE_PI_AUTONOMOUS_MODE = original;
	}
});

test("loadRuntimeGuardrailsConfig: global config file activates autonomous mode", () => {
	const dir = makeTmpDir();
	try {
		const globalConfigDir = join(dir, "global-config");
		writeConfig(globalConfigDir, "runtime-guardrails.json", {
			autonomousMode: true,
			guardedCommands: { gitPush: "allow" },
		});
		const config = __testing.loadRuntimeGuardrailsConfig(join(dir, "project"), {
			gentlePiConfigHome: globalConfigDir,
		});
		assert.equal(config.autonomousMode, true);
		assert.equal(config.guardedCommands.gitPush, "allow");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadRuntimeGuardrailsConfig: project config overrides global config", () => {
	const dir = makeTmpDir();
	try {
		const globalConfigDir = join(dir, "global-config");
		const projectDir = join(dir, "project");

		writeConfig(globalConfigDir, "runtime-guardrails.json", {
			autonomousMode: true,
			guardedCommands: { gitPush: "allow", npmPublish: "confirm" },
		});
		writeConfig(projectDir, join(".pi", "gentle-ai", "runtime-guardrails.json"), {
			autonomousMode: true,
			guardedCommands: { gitPush: "confirm", npmPublish: "block" },
		});

		const config = __testing.loadRuntimeGuardrailsConfig(projectDir, {
			gentlePiConfigHome: globalConfigDir,
		});
		assert.equal(config.autonomousMode, true);
		assert.equal(config.guardedCommands.gitPush, "confirm");
		assert.equal(config.guardedCommands.npmPublish, "block");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadRuntimeGuardrailsConfig: invalid JSON in config fails safe (autonomousMode=false)", () => {
	const dir = makeTmpDir();
	try {
		const globalConfigDir = join(dir, "global-config");
		const configPath = join(globalConfigDir, "runtime-guardrails.json");
		mkdirSync(globalConfigDir, { recursive: true });
		writeFileSync(configPath, "{ not valid json }");

		const config = __testing.loadRuntimeGuardrailsConfig(join(dir, "project"), {
			gentlePiConfigHome: globalConfigDir,
		});
		assert.equal(config.autonomousMode, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadRuntimeGuardrailsConfig: non-object JSON fails safe", () => {
	const dir = makeTmpDir();
	try {
		const globalConfigDir = join(dir, "global-config");
		writeConfig(globalConfigDir, "runtime-guardrails.json", [1, 2, 3]);

		const config = __testing.loadRuntimeGuardrailsConfig(join(dir, "project"), {
			gentlePiConfigHome: globalConfigDir,
		});
		assert.equal(config.autonomousMode, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadRuntimeGuardrailsConfig: invalid project config fails safe (autonomousMode=false)", () => {
	const dir = makeTmpDir();
	try {
		const globalConfigDir = join(dir, "global-config");
		const projectDir = join(dir, "project");

		writeConfig(globalConfigDir, "runtime-guardrails.json", {
			autonomousMode: true,
			guardedCommands: { gitPush: "allow" },
		});
		const projectConfigPath = join(
			projectDir,
			".pi",
			"gentle-ai",
			"runtime-guardrails.json",
		);
		mkdirSync(dirname(projectConfigPath), { recursive: true });
		writeFileSync(projectConfigPath, "{ bad json }");

		const config = __testing.loadRuntimeGuardrailsConfig(projectDir, {
			gentlePiConfigHome: globalConfigDir,
		});
		assert.equal(config.autonomousMode, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// When autonomous mode is OFF nothing changes vs current behavior
// ---------------------------------------------------------------------------

test("classifyGuardedCommand: pi remove confirm when autonomousMode=false", () => {
	const result = classifyGuardedCommand("pi remove my-package", {
		autonomousMode: false,
		guardedCommands: { piRemove: "allow" },
	});
	assert.equal(result, "confirm");
});

test("classifyGuardedCommand: pi remove allowed when autonomousMode=true and piRemove=allow", () => {
	const result = classifyGuardedCommand("pi remove my-package", {
		autonomousMode: true,
		guardedCommands: { piRemove: "allow" },
	});
	assert.equal(result, "allow");
});

// ---------------------------------------------------------------------------
// Fix 1: git global flags bypass — git -C <dir> push / git --work-tree push
// ---------------------------------------------------------------------------

test("classifyGuardedCommand: git -C /repo push --force → block even with gitPush=allow", () => {
	const result = classifyGuardedCommand("git -C /repo push --force origin main", {
		autonomousMode: true,
		guardedCommands: { gitPush: "allow" },
	});
	assert.equal(result, "block");
});

test("classifyGuardedCommand: git --work-tree=/tmp push --force → block", () => {
	const result = classifyGuardedCommand("git --work-tree=/tmp push --force origin main", {
		autonomousMode: true,
		guardedCommands: { gitPush: "allow" },
	});
	assert.equal(result, "block");
});

test("classifyGuardedCommand: git -C /repo push -f → block", () => {
	const result = classifyGuardedCommand("git -C /repo push -f origin main", {
		autonomousMode: true,
		guardedCommands: { gitPush: "allow" },
	});
	assert.equal(result, "block");
});

test("classifyGuardedCommand: git -C /repo push origin feat → classified as gitPush (allow when configured)", () => {
	const result = classifyGuardedCommand("git -C /repo push origin feat", {
		autonomousMode: true,
		guardedCommands: { gitPush: "allow" },
	});
	assert.equal(result, "allow");
});

test("classifyGuardedCommand: git -C /repo push origin feat → confirm when autonomousMode=false", () => {
	const result = classifyGuardedCommand("git -C /repo push origin feat", {
		autonomousMode: false,
		guardedCommands: {},
	});
	assert.equal(result, "confirm");
});

// ---------------------------------------------------------------------------
// Fix 2: rm -rf $HOME was not blocked (dead regex branch)
// ---------------------------------------------------------------------------

test("classifyGuardedCommand: rm -rf $HOME → block", () => {
	const result = classifyGuardedCommand("rm -rf $HOME", {
		autonomousMode: true,
		guardedCommands: {},
	});
	assert.equal(result, "block");
});

test("classifyGuardedCommand: rm -rf $HOME/foo → block", () => {
	const result = classifyGuardedCommand("rm -rf $HOME/foo", {
		autonomousMode: true,
		guardedCommands: {},
	});
	assert.equal(result, "block");
});

// ---------------------------------------------------------------------------
// Fix 5a: gitBranchDeleteForce allow path is tested
// ---------------------------------------------------------------------------

test("classifyGuardedCommand: gitBranchDeleteForce=allow in autonomous mode → allow", () => {
	const result = classifyGuardedCommand("git branch -D old-feature", {
		autonomousMode: true,
		guardedCommands: { gitBranchDeleteForce: "allow" },
	});
	assert.equal(result, "allow");
});

// ---------------------------------------------------------------------------
// Fix 5b: AUTONOMOUS_DEFAULT_ACTIONS fallback — empty guardedCommands in autonomous mode
// ---------------------------------------------------------------------------

test("classifyGuardedCommand: autonomousMode=true, empty guardedCommands, gitPush defaults to allow", () => {
	const result = classifyGuardedCommand("git push origin main", {
		autonomousMode: true,
		guardedCommands: {},
	});
	assert.equal(result, "allow");
});

// ---------------------------------------------------------------------------
// Fix 5c: env var negatives — only "1" activates autonomous mode
// ---------------------------------------------------------------------------

test("loadRuntimeGuardrailsConfig: GENTLE_PI_AUTONOMOUS_MODE=0 does NOT activate autonomous mode", () => {
	const original = process.env.GENTLE_PI_AUTONOMOUS_MODE;
	process.env.GENTLE_PI_AUTONOMOUS_MODE = "0";
	const dir = makeTmpDir();
	try {
		const config = __testing.loadRuntimeGuardrailsConfig(dir, {
			gentlePiConfigHome: join(dir, "global-config"),
		});
		assert.equal(config.autonomousMode, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		if (original === undefined) delete process.env.GENTLE_PI_AUTONOMOUS_MODE;
		else process.env.GENTLE_PI_AUTONOMOUS_MODE = original;
	}
});

test("loadRuntimeGuardrailsConfig: GENTLE_PI_AUTONOMOUS_MODE=true does NOT activate autonomous mode", () => {
	const original = process.env.GENTLE_PI_AUTONOMOUS_MODE;
	process.env.GENTLE_PI_AUTONOMOUS_MODE = "true";
	const dir = makeTmpDir();
	try {
		const config = __testing.loadRuntimeGuardrailsConfig(dir, {
			gentlePiConfigHome: join(dir, "global-config"),
		});
		assert.equal(config.autonomousMode, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		if (original === undefined) delete process.env.GENTLE_PI_AUTONOMOUS_MODE;
		else process.env.GENTLE_PI_AUTONOMOUS_MODE = original;
	}
});

test("loadRuntimeGuardrailsConfig: GENTLE_PI_AUTONOMOUS_MODE='' does NOT activate autonomous mode", () => {
	const original = process.env.GENTLE_PI_AUTONOMOUS_MODE;
	process.env.GENTLE_PI_AUTONOMOUS_MODE = "";
	const dir = makeTmpDir();
	try {
		const config = __testing.loadRuntimeGuardrailsConfig(dir, {
			gentlePiConfigHome: join(dir, "global-config"),
		});
		assert.equal(config.autonomousMode, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		if (original === undefined) delete process.env.GENTLE_PI_AUTONOMOUS_MODE;
		else process.env.GENTLE_PI_AUTONOMOUS_MODE = original;
	}
});

// ---------------------------------------------------------------------------
// Fix 5d: JSON config autonomousMode strict === true check
// ---------------------------------------------------------------------------

test("loadRuntimeGuardrailsConfig: autonomousMode:1 (number) in JSON does NOT activate autonomous mode", () => {
	const dir = makeTmpDir();
	try {
		const globalConfigDir = join(dir, "global-config");
		writeConfig(globalConfigDir, "runtime-guardrails.json", {
			autonomousMode: 1,
			guardedCommands: {},
		});
		const config = __testing.loadRuntimeGuardrailsConfig(join(dir, "project"), {
			gentlePiConfigHome: globalConfigDir,
		});
		assert.equal(config.autonomousMode, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('loadRuntimeGuardrailsConfig: autonomousMode:"true" (string) in JSON does NOT activate autonomous mode', () => {
	const dir = makeTmpDir();
	try {
		const globalConfigDir = join(dir, "global-config");
		writeConfig(globalConfigDir, "runtime-guardrails.json", {
			autonomousMode: "true",
			guardedCommands: {},
		});
		const config = __testing.loadRuntimeGuardrailsConfig(join(dir, "project"), {
			gentlePiConfigHome: globalConfigDir,
		});
		assert.equal(config.autonomousMode, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadRuntimeGuardrailsConfig: autonomousMode:{} (object) in JSON does NOT activate autonomous mode", () => {
	const dir = makeTmpDir();
	try {
		const globalConfigDir = join(dir, "global-config");
		writeConfig(globalConfigDir, "runtime-guardrails.json", {
			autonomousMode: {},
			guardedCommands: {},
		});
		const config = __testing.loadRuntimeGuardrailsConfig(join(dir, "project"), {
			gentlePiConfigHome: globalConfigDir,
		});
		assert.equal(config.autonomousMode, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
