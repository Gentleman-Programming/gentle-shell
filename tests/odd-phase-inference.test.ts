import assert from "node:assert/strict";
import test from "node:test";
import { inferOddPhase } from "../lib/odd-phase-inference.ts";

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
