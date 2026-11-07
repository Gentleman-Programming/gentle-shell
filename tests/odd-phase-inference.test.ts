import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SHELL_ACTIVITIES, SHELL_ACTIVITY_IDENTITY, inferOddPhase, inferShellActivity, shellCommandSegments } from "../lib/odd-phase-inference.ts";

// Deterministic, conservative tool -> ODD phase mapping for the Gentle Shell
// working label. Unknown tools and ambiguous shell commands never change it.

test("read-only file tools infer exploring", () => {
	for (const tool of ["read", "grep", "find", "ls", "codegraph"]) {
		assert.equal(inferOddPhase(tool, { path: "src/index.ts" }), "exploring", tool);
	}
});

test("asking the user infers deciding", () => {
	assert.equal(inferOddPhase("ask_user_choice", {}), "deciding");
	assert.equal(inferOddPhase("ask_user_question", {}), "deciding");
});

test("todo and edits to ODD feature documents infer planning", () => {
	assert.equal(inferOddPhase("todo", { items: [] }), "planning");
	assert.equal(inferOddPhase("write", { path: "odd/tasks/feature.md" }), "planning");
	assert.equal(inferOddPhase("edit", { path: "/repo/odd/tasks/feature.md" }), "planning");
	assert.equal(inferOddPhase("edit", { path: "C:\\repo\\odd\\tasks\\feature.md" }), "planning");
});

test("edits and writes to other paths infer implementing", () => {
	assert.equal(inferOddPhase("edit", { path: "lib/odd-phase.ts" }), "implementing");
	assert.equal(inferOddPhase("write", { path: "tests/new.test.ts" }), "implementing");
	assert.equal(inferOddPhase("write", {}), "implementing", "a write without a readable path is still a write");
	assert.equal(inferOddPhase("edit", undefined), "implementing");
});

test("native review tools infer checking", () => {
	for (const tool of ["gentle_review", "gentle_review_scope", "gentle_review_capture", "gentle_review_capture_group"]) {
		assert.equal(inferOddPhase(tool, {}), "checking", tool);
	}
});

test("shell test, typecheck, lint, and build commands infer checking", () => {
	for (const command of [
		"pnpm test",
		"npm test",
		"npm run test -- --watch=false",
		"node --experimental-strip-types --test tests/odd-phase.test.ts",
		"npx vitest run",
		"jest --ci",
		"go test ./...",
		"cargo test",
		"python -m pytest -q",
		"pytest tests/",
		"tsc --noEmit",
		"pnpm typecheck",
		"node scripts/check-types.mjs",
		"pnpm lint",
		"eslint .",
		"npm run build",
		"go build ./...",
		"make",
		"cd sub && make check",
	]) {
		assert.equal(inferOddPhase("bash", { command }), "checking", command);
	}
	assert.equal(inferOddPhase("powershell", { command: "npm test" }), "checking");
});

// A monorepo flags the workspace before the script, and every language has a
// deterministic runner of its own; each of these verifies work.
test("workspace flags and language check families infer checking", () => {
	for (const command of [
		"pnpm -C pkg test",
		"pnpm -C packages/app run test",
		"pnpm --filter app test",
		"pnpm --filter=app build",
		"pnpm -w typecheck",
		// A namespaced script keeps its base family, so a repo's `test:unit` and
		// `check:runtime-modules` still verify work.
		"pnpm run test:unit",
		"npm run test:e2e",
		"pnpm run check:runtime-modules",
		"pnpm check:provider-contract",
		"yarn test:ci",
		"npm --prefix pkg run test:e2e",
		"npm --prefix pkg test",
		"yarn --cwd pkg test",
		"python -m unittest",
		"python3 -m unittest discover -s tests",
		"python3.12 -m pytest -q",
		"ruff check .",
		"ruff format --check .",
		"cargo fmt --check",
		"cargo fmt -- --check",
		"cargo nextest run",
		"cargo nextest run --workspace",
		"deno test",
		"deno test -A tests/",
		"deno check mod.ts",
		"deno lint",
		"deno fmt --check",
		"deno task test",
		"make test",
		"make check",
		"make build",
		"make -j4 test",
		"make -j 4 test",
		"make VAR=1 check",
	]) {
		assert.equal(inferOddPhase("bash", { command }), "checking", command);
	}
});

// The same runners mutate when asked to rewrite files or install dependencies,
// and an unlisted `make` recipe is an unknown action rather than a check.
test("installing, rewriting and unknown make recipes never infer checking", () => {
	for (const command of [
		"cargo fmt",
		"ruff check --fix .",
		"ruff check --fix-only .",
		"deno lint --fix",
		"deno fmt",
		"deno task deploy",
		"pnpm install",
		"pnpm -C pkg install",
		"npm run deploy",
		"yarn add left-pad",
		"make install",
		"make deploy",
		"make clean",
		"make release",
		"make test install",
		"make ci",
		// `-j` takes an optional job count, so it must never swallow the recipe.
		"make -j install",
		"make -j clean",
		"make -j release",
		"make --jobs install",
		"make -j2 deploy",
	]) {
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
});

// A watchdog bounds how long a check may run; it does not change what the check
// does, so the runner behind it still names the call. Only the check families are
// unwrapped: any other command behind a `timeout` keeps the reading it had.
test("a verification runner behind timeout still infers checking", () => {
	for (const command of [
		"timeout 900 pnpm typecheck 2>&1 | tail -20",
		"timeout 900 pnpm typecheck",
		"timeout 30 pnpm test",
		"timeout 5 npx vitest run",
		"timeout 60 pnpm -C packages/app run test",
		"timeout 30 make test",
		"timeout -k 5 60 pnpm test",
		"timeout --foreground 900 make check",
		"timeout --signal=KILL 30 cargo test",
	]) {
		assert.equal(inferOddPhase("bash", { command }), "checking", command);
		assert.equal(inferShellActivity(command), "checking", command);
	}
	// A timeout around anything else is not a check, and not inspection either.
	for (const command of [
		"timeout 5 node scripts/release.mjs",
		"timeout 5 git status",
		"timeout 300 unknown-script --watch",
		"timeout 5",
	]) {
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
		assert.equal(inferShellActivity(command), undefined, command);
	}
});

test("waiting on or reading CI results infers checking", () => {
	for (const command of [
		"gh pr checks 1511",
		"gh pr checks 1511 --repo owner/name --watch --interval 20",
		"sleep 30; gh pr checks 1511 --watch 2>&1 | tail -10",
		"gh run watch 123",
		"gh run view 123 --log-failed",
		"gh run list --branch main",
	]) {
		assert.equal(inferOddPhase("bash", { command }), "checking", command);
	}
	for (const command of ["gh pr view 1511", "gh pr diff 1511", "gh issue list"]) {
		assert.equal(inferOddPhase("bash", { command }), "exploring", command);
	}
});

test("read-only shell inspection infers exploring", () => {
	for (const command of [
		"git status",
		"git log --oneline -5",
		"git diff --stat",
		"git show HEAD",
		"git branch -a",
		"ls -la",
		"cat package.json",
		"head -20 README.md",
		"tail -n 5 log.txt",
		"grep -rn foo lib",
		"rg oddPhase",
		"find . -name '*.ts'",
		"wc -l lib/odd-phase.ts",
		"pwd",
	]) {
		assert.equal(inferOddPhase("bash", { command }), "exploring", command);
	}
});

// Metadata probes answer "what is here?" without resolving, building or
// mutating anything.
test("read-only metadata probes infer exploring", () => {
	for (const command of [
		"locale",
		"locale -a",
		"locale | head -4",
		"cargo tree",
		"cargo tree -e normal --depth 1",
		"go env",
		"go env GOPATH",
		"go version",
		"gh auth status",
		"gh search prs --repo owner/name login",
		"gh label list",
		"gh workflow list",
		"gh workflow view ci.yml",
		"gh api repos/owner/name/pulls",
		"gh api --paginate repos/owner/name/commits",
	]) {
		assert.equal(inferOddPhase("bash", { command }), "exploring", command);
	}
});

// `go env` reads the Go configuration; `-w` and `-u` write it.
test("go env writes never infer exploring", () => {
	for (const command of [
		"go env -w GOPATH=/tmp/go",
		"go env -u GOPATH",
		"go env -w GOFLAGS=-mod=mod GOPATH=/tmp/go",
	]) {
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
});

// `gh api` writes whenever it is given a method or a field, so only the plain
// GET form is a query.
test("gh api calls that write never infer exploring", () => {
	for (const command of [
		"gh api repos/o/n -X POST",
		"gh api repos/o/n --method POST",
		"gh api repos/o/n/issues -f title=x",
		"gh api repos/o/n/issues --raw-field title=x",
		"gh api graphql -F query=@q.graphql",
		"gh api repos/o/n/issues --input body.json",
	]) {
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
});

// Reconstructed from one live session: reading a job log and the locale is
// inspection, and the composition must not fall back to an unchanged label.
test("a log-and-locale inspection composition infers exploring", () => {
	const command = `rg -n 'i (tests|pass|fail|skipped)|\u2717 failing|\u2717 ' /tmp/pi/job-1.log | tail -20; git diff --stat; locale | head -4`;
	assert.equal(inferOddPhase("bash", { command }), "exploring");
});

// The splitter follows `$(...)` but not backticks or `<(...)`, so their inner
// commands are invisible; a segment carrying one is never read as inspection.
test("hidden backtick and process substitutions never infer exploring", () => {
	for (const command of [
		"git log --oneline `git rev-parse HEAD`",
		"rg foo `cat files.txt`",
		"cat <(touch marker)",
		"diff <(sort a) <(sort b)",
		"ls <(rm -rf dist)",
	]) {
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
});

// The read-only half of the same families verifies work and stays a check.
test("read-only lint and --check runs still infer checking", () => {
	for (const command of [
		"prettier --check .",
		"prettier -l src/app.ts",
		"eslint .",
		"eslint src/app.ts",
		"eslint --fix-dry-run src/app.ts",
		"cargo fmt --check",
		"ruff format --check .",
		"ruff check .",
		"deno fmt --check",
		"deno lint",
		"black --check .",
		"rustfmt --check src/main.rs",
	]) {
		assert.equal(inferShellActivity(command), "checking", command);
		assert.equal(inferOddPhase("bash", { command }), "checking", command);
	}
});

// A formatter reports instead of rewriting only when it is told to, and the
// report flag belongs to the tool that defines it: `-l` lists files for gofmt
// and shfmt but is the line length for black, and a write flag next to a report
// flag rewrites anyway, so `gofmt -l -w .` is a reformat rather than a check.
test("formatter report modes infer checking while rewrites never do", () => {
	for (const command of [
		"gofmt -l .",
		"gofmt -d cmd/app",
		"gofumpt -l .",
		"shfmt -l scripts",
		"shfmt -d scripts/build.sh",
		"black --check .",
		"black --diff src/app.py",
		"black --line-length=100 --check .",
		"prettier --check .",
		"prettier -l src/app.ts",
		"clang-format --dry-run src/app.c",
		"swiftformat --lint .",
		"npx prettier -l src/app.ts",
		"pnpm exec prettier --check .",
		"timeout 60 gofmt -l .",
	]) {
		assert.equal(inferShellActivity(command), "checking", command);
		assert.equal(inferOddPhase("bash", { command }), "checking", command);
	}
	for (const command of [
		"gofmt -l -w .",
		"gofmt -w -l .",
		"gofumpt -w -l .",
		"shfmt -w -l scripts",
		"gofmt -w .",
		"prettier --write .",
		// `-l` is black's line length, and black rewrites in place by default.
		"black -l 100 .",
		"black --line-length 100 src/app.py",
		"clang-format -i src/app.c",
	]) {
		// A write flag wins over a report flag, so the call reforms code: the card
		// names the rewrite, and a rewrite verifies nothing so the phase stays unset.
		assert.equal(inferShellActivity(command), "formatting", command);
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
});

// make reads its options before the recipe, so an option that never changes
// which recipe runs must not hide the check. A recipe this classifier cannot
// name still leaves the label alone, alone or beside a check.
test("make options before the recipe keep a check while unknown recipes do not", () => {
	for (const command of [
		"make -B test",
		"make -e -i -O test",
		"make --no-print-directory check",
		"make --always-make -j4 test",
		"make -B -j 4 test",
		"make -rR build",
		"make -s -k check",
		"make -C pkg -B test",
		"make -f Makefile.ci --no-print-directory test",
	]) {
		assert.equal(inferOddPhase("bash", { command }), "checking", command);
		assert.equal(inferShellActivity(command), "checking", command);
	}
	for (const command of [
		"make -B install",
		"make --no-print-directory deploy",
		"make -e test install",
		"make -C pkg ci",
		"make -f Makefile.ci clean",
		"make -O install",
	]) {
		assert.equal(inferShellActivity(command), undefined, command);
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
});

test("a checking segment wins over an exploring segment in the same command", () => {
	assert.equal(inferOddPhase("bash", { command: "git status && pnpm test" }), "checking");
	assert.equal(inferOddPhase("bash", { command: "pnpm test | tail -20" }), "checking");
});

// Real compound commands an orchestrator ran during one live session: loops,
// command substitutions, quoted pipes, and stderr redirects are routine, so
// read-only inspection must still read as exploring.
test("real compound read-only shell commands infer exploring", () => {
	for (const command of [
		`cd /repo && git rev-parse --show-toplevel && ls -d .codegraph 2>/dev/null; git log -1 --oneline; grep -rniI "bridge" --include=*.ts -l . 2>/dev/null | grep -v node_modules | head -30`,
		`ls ~/work | grep -i -E "shell|pi"; for d in ~/work/a ~/dev/b; do [ -d $d ] && echo "== $d" && cd $d && git log -1 --oneline && grep -rniI "bridge" -l . 2>/dev/null | grep -v node_modules | head -20; done`,
		`cd ~/w && grep -rniI "bridge" src | grep -v test | head -15; echo ===; cat ~/.config/settings.json 2>/dev/null | head -40; cd ~/repo && git branch -a --contains 6776520be 2>/dev/null | head`,
		`f=~/.local/bin/tool; ls -la $f; file -h $f; readlink -f $f; head -c 1500 "$(readlink -f $f)" | strings | head -40`,
		`which -a pi; readlink -f "$(which pi)"; cd ~/work/pi 2>/dev/null && git branch --show-current && git rev-list --left-right --count HEAD...origin/main 2>/dev/null`,
		`ps -axo pid,command | grep -E "gentle-shell|pi-coding-agent|/pi " | grep -v grep | cut -c1-300; echo ===; cd ~/w && grep -n "isInteractiveMode" -A8 lib/rpc-host.ts | head -30`,
		`pgrep -P 96445; for p in 96445 $(pgrep -P 96445); do echo "== $p"; ps -o command= -p $p | cut -c1-250; lsof -p $p 2>/dev/null | grep -E "lib/(a|b)" | awk '{print $NF}' | sort -u | head; done`,
		`d=~/.sessions; for x in $(grep -l "probe" $(find $d -name "*.jsonl" -mmin -120) 2>/dev/null); do echo "== $x"; grep -o '"toolName":"[^"]*"' $x | sort | uniq -c; done`,
		`cd ~/w && git tag --contains 53d62fbf3 | head; git log -1 --format='%h %ad' --date=short 53d62fbf3; git tag --sort=-creatordate | head -3`,
		`git -C ~/w remote -v && git worktree list && git stash list && git config --get user.name && gh pr view 1415 && jq .version package.json && sed -n '1,20p' README.md`,
	]) {
		assert.equal(inferOddPhase("bash", { command }), "exploring", command);
	}
});

test("compound commands that mutate anything leave the label unchanged", () => {
	for (const command of [
		"git switch main 2>&1 && git pull --ff-only 2>&1 | tail -3",
		"sed -i '' 's/a/b/' odd/tasks/f.md && grep -n x odd/tasks/f.md",
		"ln -s ~/a node_modules && echo linked",
		`git add f && git commit -q -m "x" && git log --oneline -3`,
		"cat >> f.md <<'EOF'\nhello\nEOF",
		"x=$(rm -rf dist); echo $x",
		`for f in *.ts; do grep -l x "$f" && rm "$f"; done`,
		"echo hi > out.txt",
		"sort -o out.txt in.txt",
		"git tag v1.0",
		"git branch new-branch",
		"git remote add origin https://example.com/r.git",
		"git config user.name someone",
		"ls $(touch marker)",
		"grep x f | xargs rm",
	]) {
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
});

// Inference runs synchronously on tool_execution_start, so a pathological
// command must never backtrack exponentially and freeze the host.
test("adversarial assignment runs classify in bounded time", () => {
	for (const command of ["a=".repeat(26) + '"', "a=".repeat(26) + "\\\"", "a=".repeat(26) + "'"]) {
		const start = performance.now();
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
		assert.ok(performance.now() - start < 50, `${command} took ${performance.now() - start}ms`);
	}
});

test("no-op-only commands leave the label unchanged", () => {
	for (const command of ["sleep 4", "echo ===", "cd /repo && echo done", "true"]) {
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
});

test("ambiguous or mutating shell commands leave the label unchanged", () => {
	for (const command of [
		"git commit -m 'feat: x'",
		"git push",
		"rm -rf dist",
		"echo hello",
		"pnpm install",
		"curl https://example.com",
		"ls && rm -rf dist",
		"",
	]) {
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
	assert.equal(inferOddPhase("bash", {}), undefined);
	assert.equal(inferOddPhase("bash", { command: 42 }), undefined);
	assert.equal(inferOddPhase("bash", undefined), undefined);
});

test("known delegated agents infer the parent work phase in foreground and background", () => {
	for (const [agent, phase] of [
		["gentle-ai-worker", "implementing"],
		["gentle-ai-verify", "checking"],
		["gentle-ai-explore", "exploring"],
	] as const) {
		for (const mode of ["task", "background"]) {
			assert.equal(inferOddPhase("subagent_run", { agent, mode, task: "untrusted task prose" }), phase);
		}
	}
});

test("unknown or malformed delegation arguments never infer from task prose", () => {
	for (const args of [
		{}, null, "gentle-ai-worker", { agent: 5 }, { agent: "gentle-ai-writer" },
		{ task: "gentle-ai-verify checking" }, { agent: "gentle-ai-verify-extra" },
	]) assert.equal(inferOddPhase("subagent_run", args), undefined);
	for (const tool of ["subagent_start", "subagent_wait", "gentle_odd_phase", "mem_save", "web_fetch", ""]) {
		assert.equal(inferOddPhase(tool, {}), undefined, tool);
	}
});

test("MCP-prefixed tool names are normalized before mapping", () => {
	assert.equal(inferOddPhase("mcp__custom-tools__read", { path: "a.ts" }), "exploring");
	assert.equal(inferOddPhase("mcp__custom-tools__edit", { path: "a.ts" }), "implementing");
	assert.equal(inferOddPhase("mcp__custom-tools__write", { path: "odd/tasks/f.md" }), "planning");
	assert.equal(inferOddPhase("mcp__custom-tools__bash", { command: "pnpm test" }), "checking");
	assert.equal(inferOddPhase("mcp__custom-tools__mem_save", {}), undefined);
	assert.equal(inferOddPhase("mcp__custom-tools__subagent_run", { agent: "gentle-ai-worker" }), "implementing");
});

// A bash card names the activity its own command implies, so the vocabulary it
// words a heading with is a closed list: an activity without a mark and a theme
// role could not be drawn, and one the phase enum also owned would move the
// working label it must never touch.
test("the activity vocabulary names each card identity once", () => {
	assert.deepEqual([...SHELL_ACTIVITIES], ["checking", "formatting", "preparing", "publishing", "versioning", "exploring"]);
	assert.deepEqual(Object.keys(SHELL_ACTIVITY_IDENTITY).sort(), [...SHELL_ACTIVITIES].sort());
});

// Each activity carries its own mark, so a heading is never told apart by its
// color alone — two identities share the code palette, and a status tone shares
// none of the roles. A mark is one counted column, because a heading's width is
// the terminal's count and a glyph the font paints wide would overflow it.
// Exactly one mark carries a trailing gap of its own; see SHELL_ACTIVITY_IDENTITY.
test("every activity wears its own mark and theme role", () => {
	assert.deepEqual(SHELL_ACTIVITY_IDENTITY, {
		checking: { glyph: "✓", titleRole: "mdHeading" },
		formatting: { glyph: "≋", titleRole: "syntaxFunction" },
		preparing: { glyph: "⚒ ", titleRole: "syntaxFunction" },
		publishing: { glyph: "↑", titleRole: "success" },
		versioning: { glyph: "⎇", titleRole: "warning" },
		exploring: { glyph: "⌕", titleRole: "mdLink" },
	});
	const marks = SHELL_ACTIVITIES.map((activity) => SHELL_ACTIVITY_IDENTITY[activity].glyph);
	assert.equal(new Set(marks.map((mark) => mark.trim())).size, marks.length, "no two activities share a mark");
	for (const activity of SHELL_ACTIVITIES) {
		const glyph = SHELL_ACTIVITY_IDENTITY[activity].glyph;
		assert.equal(visibleWidth(glyph), activity === "preparing" ? 2 : 1, `${activity}: one counted column plus its own gap`);
	}
});

// The card's own reader: an exploration card names what the call does, which is
// the same reading the phase label makes of a read-only composition.
test("a read-only composition names the exploring activity", () => {
	for (const command of ["git status", "git diff", "git log --oneline -3", "gh pr view 12", "cat package.json && git diff"]) {
		assert.equal(inferShellActivity(command), "exploring", command);
		assert.equal(inferOddPhase("bash", { command }), "exploring", command);
	}
});

test("a verification runner names the checking activity", () => {
	for (const command of ["pnpm test", "npm run lint", "cargo test", "make", "npx vitest run a.test.ts", "gh pr checks 12"]) {
		assert.equal(inferShellActivity(command), "checking", command);
		assert.equal(inferOddPhase("bash", { command }), "checking", command);
	}
});

// The activity is a composition rule, like the phase: a check outranks the
// inspection beside it, and a segment this classifier cannot name keeps the whole
// call generic so a mutation is never hidden behind a labelled neighbour.
test("the strongest named segment decides the card, and an unnamed one keeps it generic", () => {
	assert.equal(inferShellActivity("git status && pnpm test"), "checking");
	assert.equal(inferShellActivity("pnpm test | tail -20"), "checking");
	for (const command of [
		"pnpm test && node scripts/release.mjs",
		"pnpm test && echo ok > out.txt",
		"pnpm test && echo done | tee log.txt",
		"pnpm test && ./scripts/deploy.sh",
		"pnpm test && bash -c 'unknown-tool --flag'",
	]) {
		assert.equal(inferShellActivity(command), undefined, command);
		// The working label still follows the check that ran.
		assert.equal(inferOddPhase("bash", { command }), "checking", command);
	}
});

// A call that changes nothing cannot name an activity, and neither can one with
// no command at all: the card falls back to the tool's own identity.
test("a neutral or empty command names no activity", () => {
	for (const command of ["cd repo", "echo ok", "CI=1 pnpm test"] as const) {
		assert.equal(inferShellActivity(command), command === "CI=1 pnpm test" ? "checking" : undefined, command);
	}
	for (const command of [undefined, "", "   "]) assert.equal(inferShellActivity(command), undefined, String(command));
});

// Four of the six activities are card-only: preparing, formatting, versioning
// and publishing are not steps of the ODD protocol, so the working label and the
// exploration budget read inferOddPhase, which never returns them. Every family
// is asserted through both readers so a card identity can never move the label.
test("installations, scaffolding and stored configuration name the preparing activity", () => {
	for (const command of [
		"pnpm install",
		"pnpm install --frozen-lockfile",
		"npm ci",
		"npm install left-pad",
		"pnpm -C packages/app install",
		"yarn add left-pad",
		"bun install",
		"pip install -r requirements.txt",
		"python3 -m pip install -e .",
		"uv sync",
		"uv pip install pytest",
		"poetry install",
		"bundle install",
		"composer install",
		"brew install jq",
		"apt-get install -y jq",
		"apk add jq",
		"pacman -S jq",
		"go mod download",
		"go install ./cmd/tool",
		"cargo install cargo-nextest",
		"dotnet restore",
		"git init",
		"git clone https://example.com/repo.git",
		"cargo new crate",
		"mkdir -p tmp/scratch",
		"touch tmp/scratch/file",
		"cp package.json package.json.bak",
		"ln -s ../lib/odd-phase.ts odd-phase.ts",
		"git config user.name 'A B'",
		"npm config set fund false",
		"go env -w GOFLAGS=-mod=mod",
	]) {
		assert.equal(inferShellActivity(command), "preparing", command);
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
});

test("formatters and lint fixers that rewrite files name the formatting activity", () => {
	for (const command of [
		"prettier --write .",
		"prettier -w src/app.ts",
		"npx prettier --write src/app.ts",
		"pnpm exec prettier --write .",
		"cargo fmt",
		"ruff format .",
		"ruff check --fix .",
		"deno fmt",
		"deno lint --fix",
		"gofmt -w main.go",
		"go fmt ./...",
		"black .",
		"black -l 100 .",
		"rustfmt src/main.rs",
		"biome format --write .",
		"stylelint --fix '**/*.css'",
	]) {
		assert.equal(inferShellActivity(command), "formatting", command);
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
	// A formatter told to report is the check it really is, and one whose flags
	// this classifier cannot read names nothing at all rather than claiming a
	// rewrite that never happened.
	for (const command of ["prettier --check .", "eslint .", "cargo fmt --check", "black --check .", "gofmt -l ."]) {
		assert.equal(inferShellActivity(command), "checking", command);
	}
	for (const command of ["prettier 'a --write b.ts'"]) {
		assert.equal(inferShellActivity(command), undefined, command);
	}
});

// A flag keeps its meaning when it is quoted, while quoted text that only
// contains a flag is one argument: `black "--check" .` asks black to report, and
// `prettier --check "a --write b.ts"` names a file whose text says `--write`.
test("a quoted flag keeps its mode while quoted text never becomes one", () => {
	for (const command of [
		`black "--check" .`,
		"black '--check' .",
		`black "--diff" src/app.py`,
		`prettier "--check" .`,
		`gofmt "-l" .`,
		`black "--line-length=100" --check .`,
		`prettier --check "a --write b.ts"`,
	]) {
		assert.equal(inferShellActivity(command), "checking", command);
		assert.equal(inferOddPhase("bash", { command }), "checking", command);
	}
	// A quoted non-flag argument rewrites when the formatter writes by default, and
	// leaves the card generic when it merely names a file whose text looks like a flag.
	for (const command of [`black "--line-length=100" .`, `gofmt "-w" main.go`]) {
		assert.equal(inferShellActivity(command), "formatting", command);
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
	for (const command of [`prettier "a --write b.ts"`, `prettier 'a --check b.ts'`]) {
		assert.equal(inferShellActivity(command), undefined, command);
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
});

// eslint keeps verifying work whatever write flag it carries, quoted or not, so
// a fix flag never turns it into a rewrite. The other fixers still repair what
// they read, so `ruff check '--fix'` and `deno lint "--fix"` are no more a check
// than their unquoted forms, while a quoted file name that only carries the
// flag's spelling stays a file.
test("eslint with a fix flag verifies work, quoted or not", () => {
	for (const command of [
		"eslint --fix .",
		"eslint . --fix",
		"eslint src --fix --max-warnings 0",
		`eslint "--fix" .`,
		"eslint '--fix' .",
		`eslint "--fix" src/app.ts`,
		`npx eslint "--fix" src`,
		"pnpm exec eslint '--fix' src",
		"npm exec eslint --fix .",
		`timeout 60 eslint "--fix" .`,
		// A quoted argument whose text merely carries the flag names a file, and a
		// dry run writes nothing: both stay the check they were.
		`eslint "src/--fix.ts"`,
		"eslint 'a --fix b.js'",
		`eslint "--fix-dry-run" src/app.ts`,
	]) {
		assert.equal(inferShellActivity(command), "checking", command);
		assert.equal(inferOddPhase("bash", { command }), "checking", command);
	}
});

test("a quoted fix flag on the other fixers never verifies work", () => {
	for (const command of [`ruff check "--fix" .`, "ruff check '--fix' .", "ruff check '--fix-only' .", `deno lint "--fix" .`, "deno lint '--fix' ."]) {
		assert.equal(inferShellActivity(command), "formatting", command);
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
	for (const command of [`ruff check "src/--fix.py"`, `deno lint "src/--fix.ts"`]) {
		assert.equal(inferShellActivity(command), "checking", command);
		assert.equal(inferOddPhase("bash", { command }), "checking", command);
	}
});

// An installer told to report prepares nothing: `cargo install --list` lists what
// is already installed and `--dry-run` resolves a tree without writing it, so
// neither is a build-up, neither names a card identity, and neither moves the
// phase. The writing forms keep that identity, including a report-shaped argument.
test("an installer told to list or dry-run prepares nothing", () => {
	for (const command of [
		"cargo install --list",
		"cargo install --list --quiet",
		"npm install --dry-run",
		"npm install --dry-run left-pad",
		"npm ci --dry-run",
		"npm install --dry-run=true",
		"pip install --dry-run .",
		"pip install -e . --dry-run",
		"uv pip install --dry-run pytest",
		"brew install --dry-run jq",
	]) {
		assert.equal(inferShellActivity(command), undefined, command);
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
	for (const command of [
		"npm install",
		"npm install --save-dev left-pad",
		"cargo install cargo-nextest",
		"pip install --no-deps .",
		"brew install jq",
	]) {
		assert.equal(inferShellActivity(command), "preparing", command);
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
});

test("local history changes name the versioning activity", () => {
	for (const command of [
		"git add -A",
		"git add lib/odd-phase-inference.ts",
		"git -C /repo add .",
		"git commit -m 'feat: x'",
		"git commit --amend --no-edit",
		`git commit -m "$(cat msg.txt)"`,
		"git commit -m x && git log --oneline -3",
		"git rebase main",
		"git rebase -i origin/main",
		"git rebase --continue",
		"git rebase --abort",
		"git cherry-pick abc1234",
		"git cherry-pick --continue",
		"git cherry-pick --abort",
		"git add -A && git commit -m x",
		// A stack's local half touches branches on this machine only.
		"gh stack init",
		"gh stack init --base feat/tracker feat/one feat/two",
		"gh stack add feat/three",
		"gh stack rebase --upstack",
	]) {
		assert.equal(inferShellActivity(command), "versioning", command);
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
});

test("remote writes name the publishing activity", () => {
	for (const command of [
		"git push",
		"git push -u origin HEAD",
		"git push origin feat/x",
		"gh pr create --title x --body y",
		"gh pr edit 12 --add-label bug --add-assignee octocat",
		"gh pr close 12",
		"gh pr reopen 12",
		"gh pr merge 12 --squash",
		"gh pr ready 12",
		"gh pr review 12 --approve",
		"gh pr update-branch 12",
		"gh pr comment 12 --body hi",
		"gh issue create --title x --label bug --assignee octocat",
		"gh issue edit 7 --add-label bug --remove-label wip --add-assignee octocat",
		"gh issue close 7",
		"gh issue reopen 7",
		"gh issue comment 7 --body hi",
		"gh issue pin 7",
		"gh issue transfer 7 owner/other",
		"gh label create bug --color ff0000",
		"gh label edit bug --new-name defect",
		"gh label delete bug --yes",
		"gh label clone owner/other",
		"gh release create v1.0.0 --generate-notes",
		"gh release edit v1.0.0 --draft=false",
		"gh release upload v1.0.0 dist/app.tgz",
		// A stack's remote half pushes branches and rewrites its PRs.
		"gh stack submit",
		"gh stack submit --auto --open",
		"gh stack push",
		"gh stack sync",
		"gh stack merge",
		"gh stack link",
		"gh stack unstack",
	]) {
		assert.equal(inferShellActivity(command), "publishing", command);
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
});

// Moving between branches and aliasing a command publish nothing and read
// nothing, so those stack subcommands name no activity at all.
test("a stack view is inspection and the rest of the stack subcommands name nothing", () => {
	for (const command of ["gh stack view", "gh stack view --json", "gh stack view | jq -r .name"]) {
		assert.equal(inferShellActivity(command), "exploring", command);
		assert.equal(inferOddPhase("bash", { command }), "exploring", command);
	}
	for (const command of [
		"gh stack checkout",
		"gh stack bottom",
		"gh stack top",
		"gh stack up",
		"gh stack down",
		"gh stack trunk",
		"gh stack switch",
		"gh stack modify",
		"gh stack alias co",
		"gh stack feedback",
	]) {
		assert.equal(inferShellActivity(command), undefined, command);
	}
});

// The ladder ranks the identities under the check that already ranked first, so
// the strongest named segment names the card while the phase still follows the
// check that ran.
test("the strongest named activity ranks the card under a check", () => {
	assert.equal(inferShellActivity("git push && git commit -m x"), "publishing");
	assert.equal(inferShellActivity("git commit -m x && prettier --write ."), "versioning");
	assert.equal(inferShellActivity("pnpm install && git config user.name x"), "preparing");
	assert.equal(inferShellActivity("prettier --write . && pnpm install"), "formatting");
	assert.equal(inferShellActivity("git status && pnpm install"), "preparing");
	for (const command of ["pnpm install && pnpm test", "git push && pnpm test", "git commit -m x && make test"]) {
		assert.equal(inferShellActivity(command), "checking", command);
		assert.equal(inferOddPhase("bash", { command }), "checking", command);
	}
});

// A segment whose output lands in a file, or that hides a command in a
// substitution the splitter cannot follow, is a write this classifier cannot
// name: it keeps the whole card generic rather than claiming a clean identity.
test("a redirect or an unreadable substitution keeps a card-only identity generic", () => {
	for (const command of ["git push > out.txt", "npm install > install.log", "git commit -m `cat msg`", "git add <(cat list)"]) {
		assert.equal(inferShellActivity(command), undefined, command);
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
});

// `systemd-run` starts a transient unit, so it invokes a process rather than
// reading anything. Nothing about it is known, so it names no activity and
// leaves the label alone until a bounded recognizer has proof for it.
test("systemd-run names no activity and infers no phase", () => {
	for (const command of [
		"systemd-run --unit=probe --wait curl https://example.com",
		"systemd-run --user --scope sleep 5",
		"systemd-run --pty bash",
	]) {
		assert.equal(inferShellActivity(command), undefined, command);
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
});

// `--help` asks a program to print its usage and stop, which is a query on any
// command family. The flag is read only from a segment's own unquoted text and
// only for a program this classifier already knows.
test("a genuine help flag on a known command is inspection", () => {
	for (const command of [
		"git --help",
		"git push --help",
		"git commit --help",
		"git add --help",
		"git rebase --help",
		"gh --help",
		"gh pr create --help",
		"gh issue edit --help",
		"gh stack --help",
		"gh stack submit --help",
		"gh stack init --help",
		"pnpm test --help",
		"cargo clippy --help",
		"make install --help",
		"git push --help | head -40",
	]) {
		assert.equal(inferShellActivity(command), "exploring", command);
		assert.equal(inferOddPhase("bash", { command }), "exploring", command);
	}
});

test("help detection never masks a mutation or a payload it cannot read", () => {
	// The flag belongs to one segment; a neighbouring mutation still names the card.
	assert.equal(inferShellActivity("git add -A && git commit --help"), "versioning");
	assert.equal(inferShellActivity("git commit -m x && gh pr create --help"), "versioning");
	// A quoted flag is text, not a request, so the command keeps its own activity.
	assert.equal(inferShellActivity(`git commit -m "--help"`), "versioning");
	assert.equal(inferShellActivity(`git commit -m 'docs: mention --help'`), "versioning");
	assert.equal(inferShellActivity(`printf 'git push --help'`), undefined);
	assert.equal(inferShellActivity(`echo "--help"`), undefined);
	// An unknown program's help flag is a guess, and a payload flag can swallow the
	// help flag, so neither is a query.
	for (const command of [
		"unknown-tool --help",
		"./scripts/deploy.sh --help",
		"bash -c 'git status' --help",
		"node -e 'process.exit(0)' --help",
		"python -c 'print(1)' --help",
		"git commit --help > help.txt",
		"git push --help `date`",
	]) {
		assert.equal(inferShellActivity(command), undefined, command);
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
});

test("an escaped space keeps a help flag inside the value it belongs to", () => {
	// The shell joins `foo\ --help` into one word, so git commits the message
	// `foo --help`, gh posts it, and no usage page is printed.
	for (const [command, activity] of [
		["git commit -m foo\\ --help", "versioning"],
		["gh issue comment 7 --body foo\\ --help", "publishing"],
		["gh pr create --title foo\\ --help", "publishing"],
		// The escape can sit on the other side of the word as well.
		["git commit -m --help\\ foo", "versioning"],
		// A word that may expand to an option (`$OPTS`) is no proof of a query either.
		["git commit -m $OPTS --help", "versioning"],
	] as const) {
		assert.equal(inferShellActivity(command), activity, command);
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
	// A value that holds escaped whitespace still leaves a real help flag after it.
	for (const command of [
		"git commit -m foo\\ bar --help",
		"gh issue comment 7 --body foo\\ bar --help",
		"git commit -m 'foo bar' --help",
		"git commit -m \"foo bar\" --help",
	]) {
		assert.equal(inferShellActivity(command), "exploring", command);
		assert.equal(inferOddPhase("bash", { command }), "exploring", command);
	}
	// An escaped backslash is a literal backslash, not a word boundary: `a\\b` is one
	// word, so the help flag after it is still its own argument.
	assert.equal(inferShellActivity("git commit -m a\\\\b --help"), "exploring");
	assert.equal(inferShellActivity("git commit -m a\\\\ --help"), "exploring");
	assert.equal(inferShellActivity("git commit -m a\\\\b\\ --help"), "versioning");
	// A line continuation joins the lines, so the help flag after it is still its own
	// argument — but a value that holds the escaped space keeps the flag inside it.
	assert.equal(inferShellActivity("git commit -m foo \\\n--help"), "exploring");
	assert.equal(inferOddPhase("bash", { command: "git commit -m foo \\\n--help" }), "exploring");
	assert.equal(inferShellActivity("git commit -m foo\\ \\\n--help"), "versioning");
	assert.equal(inferOddPhase("bash", { command: "git commit -m foo\\ \\\n--help" }), undefined);
});

test("a help flag an option consumed as its value is not a query", () => {
	// `--help` right after a flag may be that flag's value: git commits a message
	// spelled `--help`, and gh posts it as a comment body. Nothing is printed, so
	// the segment keeps its own verb's activity and never becomes a query.
	for (const [command, activity] of [
		["git commit -m --help", "versioning"],
		["git commit --message --help", "versioning"],
		["git commit -m -m --help", "versioning"],
		["git commit -a -m --help", "versioning"],
		["gh issue comment 7 --body --help", "publishing"],
		["gh pr create --title --help", "publishing"],
		["gh pr edit 12 --add-label --help", "publishing"],
		["git push --force --help", "publishing"],
	] as const) {
		assert.equal(inferShellActivity(command), activity, command);
		// Neither reading reaches the phase label, so a commit-or-comment never
		// becomes a tracked lookup.
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
	// A flag separated from the help flag by its value is still a genuine request.
	for (const command of [
		`git commit -m "x" --help`,
		`gh issue comment 7 --body "hi" --help`,
		"git commit --help",
		"git push --help",
		"gh stack submit --help",
		"pnpm test --help",
	]) {
		assert.equal(inferShellActivity(command), "exploring", command);
		assert.equal(inferOddPhase("bash", { command }), "exploring", command);
	}
	// A quoted value that is itself an option still consumes the help flag that
	// follows it, whatever quoting style wrote it, so both stay on the safe side.
	for (const command of [`git commit -m '--help' --help`, `git commit -m "--help" --help`]) {
		assert.equal(inferShellActivity(command), "versioning", command);
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
});

// A quoted `>` is text the shell hands to the program, never a redirect, so it
// must not turn a command into a write. An unquoted one still does.
test("quoted text never turns a command into a write", () => {
	for (const [command, activity] of [
		[`git commit -m "fix: a > b"`, "versioning"],
		[`git commit -m 'x > y' --amend`, "versioning"],
		[`gh issue comment 7 --body "before > after"`, "publishing"],
	] as const) {
		assert.equal(inferShellActivity(command), activity, command);
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
	// A quoted `>` in a read-only command is still inspection.
	for (const command of [`git log --format="%h > %s" -3`, `printf '%s\n' "a > b" | cat`]) {
		assert.equal(inferShellActivity(command), "exploring", command);
		assert.equal(inferOddPhase("bash", { command }), "exploring", command);
	}
	// The redirect guard itself is unchanged: an unquoted `>` is a write.
	for (const command of ["git commit -m x > out.txt", "cat src/a > out", "echo 'a > b' > out.txt"]) {
		assert.equal(inferShellActivity(command), undefined, command);
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
});
// The quote-aware splitter is the one segmenter, so a reader that needs the same
// split reads this one and never a second, quoting-blind copy: a separator inside
// quoted text is the program's argument, not a boundary between two commands.
test("the shared segmenter splits only where the shell would", () => {
	assert.deepEqual(shellCommandSegments(`git commit -m "a && b"`), [`git commit -m "a && b"`]);
	assert.deepEqual(shellCommandSegments(`git log --format="%h; %s" -3`), [`git log --format="%h; %s" -3`]);
	assert.deepEqual(shellCommandSegments("git status && git diff"), ["git status ", " git diff"]);
	// A substitution contributes its own commands and leaves a placeholder behind.
	assert.deepEqual(shellCommandSegments("echo $(git status && git diff)"), ["git status ", " git diff", "echo $_"]);
});
