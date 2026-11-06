import assert from "node:assert/strict";
import test from "node:test";
import { recognizeDestructiveCommands } from "../lib/destructive-command-guard.ts";

const destructive = [
	`psql -c 'DROP TABLE users'`,
	`mysql --execute='TRUNCATE TABLE users'`,
	`sqlite3 app.db 'DELETE FROM users;'`,
	`psql -c 'DELETE FROM users WHERE 1=1'`,
	`echo 'DROP DATABASE app' | psql`,
	`printf '%s' 'TRUNCATE users' | mysql`,
	`env MODE=test sudo -u postgres /usr/bin/psql -c 'DROP SCHEMA public CASCADE'`,
	`sh -c "echo ready; psql -c 'DROP TABLE users'"`,
	`echo ready && rm -fr -- ./data`,
	`find ./data -type f -delete`,
	`find ./data -type f -exec rm -rf {} +`,
	`find ./data -print0 | xargs -0 rm -rf`,
	`psql <<'SQL'\nDROP TABLE users;\nSQL`,
	`sqlite3 app.db 'SELECT 1; /* maintenance */ DROP TABLE users'`,
	`timeout 30 bash -lc 'rm -r ./data'`,
	`echo ready || (rm -r ./data)`,
	`rm -r /var/app/data`,
	`git -C /repo reset --hard HEAD`,
	`git clean -fd`,
	`git push --force-with-lease origin main`,
	`git branch -D old`,
	`git restore .`,
	String.raw`sh -c "psql -c \"DROP TABLE users\""`,
	String.raw`bash -lc "rm -r \"./data\""`,
	`psql -c 'DELETE FROM "where"'`,
	`mysql -e 'DELETE FROM \`where\`'`,
	`sqlite3 app.db 'DELETE FROM [where]'`,
	`psql -c 'DROP TABLE "where"'`,
	String.raw`find cache -exec echo {} \; -exec rm -r {} \;`,
	String.raw`find cache -execdir echo {} \; -execdir rm -r {} \;`,
	`sudo -n rm -r ./data`,
	`command -p psql -c 'DROP TABLE users'`,
	`env -u MODE sudo -u postgres psql -c 'DROP TABLE users'`,
];
for (const command of destructive) {
	test(`recognizes executable destruction: ${command}`, () => {
		const matches = recognizeDestructiveCommands(command);
		assert.ok(matches.length > 0);
		assert.ok(matches.every((match) => match.triggerIndex >= 0 && match.triggerIndex < command.length));
	});
}
for (const command of [
	`pnpm test && pnpm run build`, `git status`, `git push origin main`,
	`psql -c 'SELECT * FROM users'`, `sqlite3 app.db 'DELETE FROM users WHERE id=7'`,
	`psql -c "SELECT 'DROP TABLE users'"`,
	`echo 'rm -rf ./data; DROP TABLE users'`, `printf '%s' 'TRUNCATE TABLE users'`,
	`rg 'DROP TABLE' docs`, `rm ./one-file`, `find . -name '*.ts'`,
	`psql <<'SQL'\nSELECT 'DROP TABLE users';\nSQL`,
	`git log --oneline`, `env X=1 echo 'rm -r ./data'`,
	`find . -exec echo 'DROP TABLE users' {} +`,
	`git push origin main && printf '%s' '-f'`,
	`echo ';' rm -r cache`,
	String.raw`echo \; rm -r cache`,
	`printf '%s ' ';' rm -r ./data`,
	`echo '|' rm -r cache`,
	`echo '&&' rm -r cache`,
	`echo ')' rm -r cache`,
	`psql -c 'DELETE FROM "where" WHERE id=7'`,
	String.raw`psql -c "SELECT \"where\", 'DROP TABLE users'"`,
	String.raw`find cache -exec echo {} \; -exec echo 'rm -r data' {} \;`,
]) {
	test(`leaves ordinary commands and prose unchanged: ${command}`, () => {
		assert.deepEqual(recognizeDestructiveCommands(command), []);
	});
}

test("recognizes later compound destruction and shell wrappers without matching quoted prose", () => {
	const command = `echo 'rm -rf /'; env X=1 sh -c 'rm --recursive ./data'`;
	const matches = recognizeDestructiveCommands(command);
	assert.equal(matches.length, 1);
	assert.equal(matches[0].kind, "filesystem");
	assert.equal(matches[0].hardDeny, false);
});

test("root/home recursive removal and destructive git retain hard denial", () => {
	for (const command of [`rm -fr /`, `rm -r "$HOME"`, `git -C /repo reset --hard`, `git push -f`, `git push ';' -f main`, `rm -r ';' /`, `rm -rf /tmp/tmp.abcdef1234 ~/foo`, `rm -rf /tmp/tmp.abcdef1234 /`]) {
		assert.equal(recognizeDestructiveCommands(command)[0]?.hardDeny, true, command);
	}
});

// gentle-pi#2285: a reserved word that opens a compound body is not the
// segment head, and backtick and literal `eval` payloads run like `$(...)`.
const compoundRemovals = [
	`if true; then rm -rf data; fi`,
	`for d in a b; do rm -rf "$d"; done`,
	"echo `rm -rf data`",
	`eval 'rm -rf data'`,
	`if false; then :; else rm -rf data; fi`,
	`if false; then :; elif rm -rf data; then :; fi`,
	`while rm -rf data; do :; done`,
	`until rm -rf data; do :; done`,
	`if rm -rf data; then :; fi`,
	`{ rm -rf data; }`,
	`! rm -rf data`,
	`if true; then sudo rm -rf data; fi`,
	"echo \"now: `rm -rf data`\"",
	"echo `true; rm -rf data`",
	`eval "rm -rf data"`,
	`eval rm -rf data`,
	`eval -- 'rm -rf data'`,
	`command eval 'rm -rf data'`,
	`eval 'if true; then rm -rf data; fi'`,
	`eval 'git reset --hard'`,
];
for (const command of compoundRemovals) {
	test(`recognizes destruction after reserved words, in backticks and in eval: ${command}`, () => {
		const matches = recognizeDestructiveCommands(command);
		assert.ok(matches.length > 0, command);
		assert.ok(matches.every((match) => match.triggerIndex >= 0 && match.triggerIndex < command.length), command);
		assert.ok(matches.every((match) => match.removalTargets === undefined), command);
	});
}

test("issue #2285 examples are recursive filesystem data loss like a plain rm", () => {
	for (const command of [`if true; then rm -rf data; fi`, `for d in a b; do rm -rf "$d"; done`, "echo `rm -rf data`", `eval 'rm -rf data'`]) {
		const matches = recognizeDestructiveCommands(command);
		assert.ok(matches.some((match) => match.kind === "filesystem"), command);
		assert.ok(matches.every((match) => !match.hardDeny), command);
	}
});

test("root/home recursive removal behind reserved words, backticks or eval keeps its hard denial", () => {
	for (const command of [
		`if true; then rm -rf ~; fi`, `for d in a; do rm -rf /; done`, `{ rm -rf "$HOME"; }`, `! rm -rf ..`,
		"echo `rm -rf ~`", `eval 'rm -rf /'`, `while true; do rm -rf ~/foo; done`,
	]) {
		assert.ok(recognizeDestructiveCommands(command).some((match) => match.hardDeny), command);
	}
});

for (const command of [
	`if [ -f x ]; then echo ok; fi`, `for f in *; do cat "$f"; done`, "echo `date`", `eval "$(ssh-agent -s)"`,
	`grep "then rm -rf" x`, `echo 'then rm -rf data'`, "echo '`rm -rf data`'", "echo \\`rm -rf data\\`",
	`eval 'echo rm -rf data'`, `eval "$cmd"`, `while read -r line; do echo "$line"; done < x`,
	`if git diff --quiet; then git push origin main; fi`, "echo 'unterminated `rm -rf data'",
]) {
	test(`leaves ordinary compound, backtick and eval commands unchanged: ${command}`, () => {
		assert.deepEqual(recognizeDestructiveCommands(command), []);
	});
}

// Only a direct, unwrapped, unquoted `rm` exposes its literal targets; the
// YOLO temp-scratch waiver has nothing to inspect anywhere else.
test("exposes literal removal targets only for a direct top-level rm that runs before every other segment", () => {
	assert.deepEqual(recognizeDestructiveCommands(`rm -rf /tmp/tmp.abcdef1234 /tmp/x.log; git log -1`)[0]?.removalTargets, ["/tmp/tmp.abcdef1234", "/tmp/x.log"]);
	assert.deepEqual(recognizeDestructiveCommands(`rm -r -f -- /tmp/tmp.abcdef1234`)[0]?.removalTargets, ["/tmp/tmp.abcdef1234"]);
	assert.deepEqual(recognizeDestructiveCommands(`rm -rf /tmp/a && rm -r /tmp/b\n\nrm -r /tmp/c || true`).map((match) => match.removalTargets), [["/tmp/a"], ["/tmp/b"], ["/tmp/c"]]);
	assert.deepEqual(recognizeDestructiveCommands(`rm -rf /tmp/a; mv x /tmp/b; rm -rf /tmp/b`).map((match) => match.removalTargets), [["/tmp/a"], undefined]);
	for (const command of [
		`sudo rm -rf /tmp/tmp.abcdef1234`, `env rm -rf /tmp/tmp.abcdef1234`, `X=1 rm -rf /tmp/tmp.abcdef1234`,
		`xargs rm -rf /tmp/tmp.abcdef1234`, `/bin/rm -rf /tmp/tmp.abcdef1234`, `sh -c 'rm -rf /tmp/tmp.abcdef1234'`,
		`find /tmp -name tmp.abcdef1234 -exec rm -rf {} +`, `rm -rf "$TMPDIR/x"`, `rm -rf '/tmp/tmp.abcdef1234'`,
		`rm -rf --no-preserve-root /tmp/tmp.abcdef1234`, `rm -rf`,
		`mv x /tmp/tmp.abcdef1234 && rm -rf /tmp/tmp.abcdef1234`, `cp -r x /tmp/tmp.abcdef1234; rm -rf /tmp/tmp.abcdef1234`,
		`(rm -rf /tmp/tmp.abcdef1234)`, `rm -rf /tmp/tmp.abcdef1234 & true`, `rm -rf /tmp/tmp.abcdef1234 | cat`,
		`{ rm -rf /tmp/tmp.abcdef1234; }`, `! rm -rf /tmp/tmp.abcdef1234`, `if true; then rm -rf /tmp/tmp.abcdef1234; fi`,
		"echo `rm -rf /tmp/tmp.abcdef1234`", `eval 'rm -rf /tmp/tmp.abcdef1234'`, `eval rm -rf /tmp/tmp.abcdef1234`,
	]) {
		const matches = recognizeDestructiveCommands(command);
		assert.ok(matches.length > 0, command);
		assert.ok(matches.every((match) => match.removalTargets === undefined), command);
	}
});
