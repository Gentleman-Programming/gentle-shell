import assert from "node:assert/strict";
import test from "node:test";
import { isDestructiveCommand, isDestructiveSegment } from "../lib/destructive-card-activity.ts";

// The card-side recognizer for irreversible operations. It is visual only: it
// never decides permission — `lib/destructive-command-guard.ts` owns that — and
// it reads one shell segment at a time, so what it cannot recognize stays
// unnamed and its call keeps the generic card rather than claiming a warning it
// cannot prove.

test("removals that delete files or directories are recognized", () => {
	for (const segment of [
		"rm -rf dist",
		"rm -r build",
		"rm -R node_modules",
		"rm -f logo.png",
		"rm logo.png",
		"rm dist/a.ts dist/b.ts",
		"rm -f -- -weird-name",
		"sudo rm -f /usr/local/bin/tool",
		"command rm -f x",
		"timeout 30 rm -rf node_modules",
		"rm -rf dist 2>/dev/null",
	]) {
		assert.equal(isDestructiveSegment(segment), true, segment);
	}
});

test("git operations that discard work are recognized", () => {
	for (const segment of [
		"git reset --hard",
		"git reset --hard HEAD~1",
		"git clean -f",
		"git clean -fd",
		"git clean -fdx",
		"git clean --force",
		"git checkout -- .",
		"git checkout -f main",
		"git checkout --force main",
		// The working-tree path is what a path checkout discards, and `.` can name
		// nothing else: git has no branch spelled `.`.
		"git checkout .",
		"git checkout ./",
		"git checkout ..",
		"git checkout HEAD .",
		"git restore .",
		"git restore --worktree lib/a.ts",
		"git restore --staged --worktree lib/a.ts",
		"git branch -D feat/x",
		"git branch -d --force feat/x",
		"git push --force",
		"git push -f origin main",
		"git push --force-with-lease origin feat/x",
		"git stash drop",
		"git stash clear",
		"git rm lib/old.ts",
		"find . -name '*.log' -delete",
	]) {
		assert.equal(isDestructiveSegment(segment), true, segment);
	}
});

test("deletion tools other than rm are recognized", () => {
	for (const segment of [
		"shred secret.key",
		"truncate -s 0 app.log",
		"dd if=/dev/zero of=disk.img bs=1M",
	]) {
		assert.equal(isDestructiveSegment(segment), true, segment);
	}
});

test("a genuine help request is never a deletion", () => {
	for (const segment of ["rm --help", "git reset --hard --help", "git clean -fd --help", "find --help"]) {
		assert.equal(isDestructiveSegment(segment), false, segment);
	}
});

test("a dry run and a non-destructive recovery are never a deletion", () => {
	for (const segment of [
		"git clean -n",
		"git clean -nd",
		"git clean --dry-run -f",
		// Git's own `-n` is a dry run on the verbs that delete, so the short flag keeps
		// its meaning wherever git assigns it one.
		"git rm -n lib/old.ts",
		"git push -n origin main",
		"git push --dry-run",
		"git restore --staged lib/a.ts",
		"git reset --soft HEAD~1",
		"git reset HEAD lib/a.ts",
		"git stash pop",
		"git stash apply",
		"git rebase --abort",
		"git rebase main",
		"git commit --amend --no-edit",
		// A branch checkout switches branch and keeps the working tree.
		"git checkout main",
		"git checkout -b feat/x",
		"git checkout --",
		"git checkout -",
		"git checkout origin/feat/x --",
		"git rm --cached lib/a.ts",
		"git branch -d feat/x",
		"find . -name '*.ts'",
		"dd if=/dev/zero of=/dev/null bs=1M",
		"truncate --help",
	]) {
		assert.equal(isDestructiveSegment(segment), false, segment);
	}
});

test("quoted prose and unknown payloads are never read as a deletion", () => {
	for (const segment of [
		`printf 'rm -rf /'`,
		`echo "git reset --hard HEAD~1"`,
		`grep -rn "git clean -fd" docs`,
		`git commit -m "rm -rf /tmp"`,
		"node scripts/release.mjs",
		"echo rm -rf /",
	]) {
		assert.equal(isDestructiveSegment(segment), false, segment);
	}
});

test("an rm without an operand prints usage instead of deleting anything", () => {
	for (const segment of ["rm", "rm -rf", "rm -f --"]) {
		assert.equal(isDestructiveSegment(segment), false, segment);
	}
});

// SQL data loss is proven by the permission guard's own pure recognizer, reused as
// evidence: the card repeats what that reader already proves instead of keeping a
// second SQL vocabulary, and it reads nothing about a permission verdict.
test("SQL a client is asked to run is data loss", () => {
	for (const segment of [
		`psql -c 'DROP TABLE users'`,
		`psql -c "TRUNCATE TABLE logs"`,
		`mysql -e 'DROP DATABASE app'`,
		`sqlite3 app.db 'DROP TABLE t'`,
		`psql -c 'DELETE FROM t'`,
	]) {
		assert.equal(isDestructiveSegment(segment), true, segment);
	}
	// A pipeline hands the client its SQL, so the whole command is what proves it.
	for (const command of [`echo 'DROP TABLE t' | psql`, `printf '%s' 'DROP TABLE t' | psql`]) {
		assert.equal(isDestructiveCommand(command), true, command);
	}
	// The clause decides: a scoped delete and a read are not data loss.
	for (const command of [
		`psql -c 'DELETE FROM t WHERE id = 1'`,
		`psql -c 'SELECT 1'`,
		"psql --help",
		"psql",
		`echo 'DROP TABLE t'`,
		`printf 'DROP TABLE t'`,
	]) {
		assert.equal(isDestructiveCommand(command), false, command);
		assert.equal(isDestructiveSegment(command), false, command);
	}
});

// The guard's recognizer already reads executable payloads — a shell body, an
// eval, and find's exec — so the card reuses that reading rather than parsing a
// second shell.
test("a shell or eval payload is read by the recognizer that already proves it", () => {
	for (const segment of [
		"bash -c 'rm -rf build'",
		"sh -c 'git reset --hard'",
		"zsh -c 'find . -delete'",
		"dash -c 'psql -c \"DROP TABLE t\"'",
		"eval 'git clean -fd'",
		"find . -maxdepth 1 -exec rm -rf {} +",
	]) {
		assert.equal(isDestructiveSegment(segment), true, segment);
	}
	// A payload with nothing to prove, and a substitution that only starts an agent.
	for (const segment of ["bash -c 'echo hi'", "sh -c 'pnpm test'", `eval "$(ssh-agent -s)"`]) {
		assert.equal(isDestructiveSegment(segment), false, segment);
	}
});

test("container and cluster deletions are recognized", () => {
	for (const segment of [
		"docker rm web",
		"docker rm -f web",
		"docker rmi app:1",
		"docker container rm web",
		"docker volume rm data",
		"docker system prune -af",
		"docker builder prune",
		"docker image prune",
		"kubectl delete pod web",
		"kubectl delete -f deploy.yaml",
		"kubectl delete pods --all",
		// `-n` names the namespace kubectl deletes in; it is not a dry run, so the
		// deletion keeps its identity whichever side of the verb the flag sits on.
		"kubectl delete pod web -n prod",
		"kubectl delete -n prod pod web",
		"kubectl delete pod web --namespace prod",
	]) {
		assert.equal(isDestructiveSegment(segment), true, segment);
	}
	for (const segment of [
		"docker ps",
		"docker run -it app",
		"docker rm",
		"docker volume rm",
		"docker system prune --help",
		"kubectl get pods",
		"kubectl apply -f deploy.yaml",
		"kubectl delete --dry-run=client pod web",
		"kubectl delete --dry-run pod web -n prod",
		"kubectl delete --help",
	]) {
		assert.equal(isDestructiveSegment(segment), false, segment);
	}
});

test("a remote ref deletion is recognized", () => {
	for (const segment of [
		"git push --delete origin feat/x",
		"git push origin --delete feat/x",
		"git push -d origin feat/x",
		"git push origin :feat/x",
	]) {
		assert.equal(isDestructiveSegment(segment), true, segment);
	}
	for (const segment of ["git push origin feat/x", "git push --dry-run origin :feat/x", "git push -u origin HEAD"]) {
		assert.equal(isDestructiveSegment(segment), false, segment);
	}
});

// `FOO=1` and a `nice` adjustment change nothing about what the command deletes,
// and `env` may carry the environment itself before the command it wraps.
test("an assignment or a nice wrapper never hides the command it runs", () => {
	for (const segment of [
		"FOO=1 rm -f logo.png",
		"CI=true rm -rf build",
		"nice rm -f logo.png",
		"nice -n 5 rm -f logo.png",
		"nice --adjustment=10 rm -rf build",
		// The environment a wrapper sets is not the command.
		"env FOO=bar rm -rf dist",
		"env FOO=bar CI=true rm -rf build",
		"env -i FOO=1 rm -f logo.png",
		"env -u HOME FOO=1 rm -rf build",
		"sudo env FOO=1 rm -f /usr/local/bin/tool",
		"nice -n 5 env FOO=1 rm -rf build",
	]) {
		assert.equal(isDestructiveSegment(segment), true, segment);
	}
	for (const segment of [
		"nice -n 5 pnpm test",
		"FOO=1 node scripts/release.mjs",
		"env FOO=bar node scripts/release.mjs",
		"env FOO=bar pnpm test",
		"env FOO=bar git status",
	]) {
		assert.equal(isDestructiveSegment(segment), false, segment);
	}
});

test("quoted prose never names a container, cluster or SQL deletion either", () => {
	for (const segment of [
		`echo "docker system prune"`,
		`printf 'kubectl delete pod web'`,
		`git commit -m "docker rm web"`,
		`grep -rn "git push --delete" docs`,
		`echo "DROP TABLE t"`,
	]) {
		assert.equal(isDestructiveSegment(segment), false, segment);
		assert.equal(isDestructiveCommand(segment), false, segment);
	}
});
