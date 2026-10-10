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
	for (const command of [`rm -fr /`, `rm -r "$HOME"`, `git -C /repo reset --hard`, `git push -f`, `git push ';' -f main`, `rm -r ';' /`]) {
		assert.equal(recognizeDestructiveCommands(command)[0]?.hardDeny, true, command);
	}
});
