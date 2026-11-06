import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(process.env.CI_MERGE_BASE_IDENTITY_WORKFLOW ?? new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const identityError = "Checkout is not the declared PR synthetic merge of base and head";

test("Windows CI executes its checkout identity regressions", () => {
  assert.match(workflow, /name: Test immutable checkout identity\r?\n\s+shell: pwsh\r?\n\s+run: node --experimental-strip-types --test tests\/ci-merge-base-identity\.test\.ts/);
});

test("CI checkout identity through native Windows PowerShell", { skip: process.platform !== "win32" }, async (t) => {
  const step = workflow.indexOf("      - name: Verify merged inventory and run focused routing cases");
  const run = workflow.indexOf("        run: |", step);
  const inventory = workflow.indexOf("          $names = @(", run);
  assert.ok(step >= 0 && run > step && inventory > run, "public CI guard boundaries must exist");
  const prefix = workflow.slice(workflow.indexOf("\n", run) + 1, inventory)
    .split(/\r?\n/).map((line) => {
      assert.ok(line === "" || line.startsWith("          "));
      return line.slice(10);
    }).join("\n");

  const root = mkdtempSync(join(tmpdir(), "ci-merge-identity-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  const parents = new Map<string, string[]>();
  function git(args: string[], input?: string): string {
    const result = spawnSync("git", ["-c", "user.name=CI fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], {
      cwd: repo, env: cleanEnv, encoding: "utf8", input, timeout: 10_000,
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function tree(content: string): string {
    const blob = git(["hash-object", "-w", "--stdin"], content);
    return git(["mktree"], `100644 blob ${blob}\tsentinel.txt\n`);
  }
  function commit(treeId: string, previous: string[], message: string): string {
    const sha = git(["commit-tree", treeId, ...previous.flatMap((sha) => ["-p", sha]), "-m", message]);
    parents.set(sha, previous);
    return sha;
  }
  function snapshot(): string {
    return JSON.stringify({
      head: git(["rev-parse", "HEAD"]),
      refs: git(["for-each-ref", "--format=%(refname):%(objectname)"]),
      status: git(["status", "--porcelain=v1"]),
      sentinel: readFileSync(join(repo, "sentinel.txt"), "utf8"),
    });
  }

  try {
    git(["init", "--quiet", "-b", "fixture"]);
    const originalTree = tree("unchanged fixture data\n");
    const base = commit(originalTree, [], "event base");
    const advancedBase = commit(originalTree, [base], "advanced base");
    const head = commit(originalTree, [base], "PR head");
    const otherHead = commit(originalTree, [base], "different PR head");
    const originalMerge = commit(originalTree, [base, head], "original run merge");
    const runMerge = commit(originalTree, [advancedBase, head], "current run merge");
    const wrongTree = commit(tree("different tree with identical parents\n"), [advancedBase, head], "wrong tree");
    const wrongHead = commit(originalTree, [advancedBase, otherHead], "wrong head");
    const script = join(root, "guard.ps1");
    // Only package-manager version metadata is stubbed; Git and the CI guard execute unchanged.
    writeFileSync(script, `$ErrorActionPreference = 'Stop'\nfunction pnpm { 'fixture-pnpm' }\ntry {\n${prefix}\n} catch {\n[Console]::Error.WriteLine($_.Exception.Message)\nexit 1\n}\n`);

    const cases: { name: string; checkout: string; run: string; base?: string; status: number; override?: string }[] = [
      { name: "matching event tuple retains its previous success", checkout: originalMerge, run: originalMerge, base, status: 0 },
      { name: "reported older event base does not reject the immutable run merge", checkout: runMerge, run: runMerge, base, status: 0 },
      { name: "a newer event base does not redefine the already selected run", checkout: originalMerge, run: originalMerge, base: advancedBase, status: 0 },
      { name: "stale checkout is rejected even when its event parents match", checkout: originalMerge, run: runMerge, base, status: 1 },
      { name: "another tree with identical parents is rejected", checkout: wrongTree, run: runMerge, base: advancedBase, status: 1 },
      { name: "declared PR head remains mandatory", checkout: wrongHead, run: wrongHead, base: advancedBase, status: 1 },
      { name: "two-parent synthetic merge remains mandatory", checkout: head, run: head, base, status: 1 },
      { name: "missing independent run SHA is rejected", checkout: originalMerge, run: "", base, status: 1 },
      { name: "missing event base metadata is still rejected", checkout: originalMerge, run: originalMerge, status: 1 },
      { name: "inherited Git overrides remain blocked without revealing values", checkout: originalMerge, run: originalMerge, base, status: 1, override: "override-value-must-not-appear" },
    ];
    for (const [index, entry] of cases.entries()) {
      await t.test(entry.name, () => {
        git(["checkout", "--quiet", "--detach", entry.checkout]);
        const before = snapshot();
        const evidenceDir = join(root, String(index));
        mkdirSync(evidenceDir);
        const eventPath = join(evidenceDir, "event.json");
        writeFileSync(eventPath, JSON.stringify({ pull_request: { head: { sha: head }, base: { sha: entry.base } } }));
        const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script], {
          cwd: repo, encoding: "utf8", timeout: 30_000,
          env: { ...cleanEnv, RUNNER_TEMP: evidenceDir, GITHUB_EVENT_PATH: eventPath, GITHUB_SHA: entry.run, ...(entry.override ? { GIT_DIR: entry.override } : {}) },
        });
        assert.equal(result.error, undefined, String(result.error));
        assert.equal(result.signal, null);
        assert.equal(result.status, entry.status, result.stderr);
        const stdout = result.stdout.replace(/\r\n/g, "\n");
        const stderr = result.stderr.replace(/\r\n/g, "\n");
        const expected = entry.override
          ? "Blocked inherited Git overrides (names only): GIT_DIR\n"
          : `checkout=${entry.checkout} parents=${[entry.checkout, ...parents.get(entry.checkout)!].join(" ")} prHead=${head} prBase=${entry.base ?? ""} runMerge=${entry.run} node=${process.version} pnpm=fixture-pnpm\n`;
        assert.equal(stdout, expected);
        assert.equal(stderr, entry.status === 0 ? "" : `${entry.override ? "Inherited Git environment equivalence is unproved" : identityError}\n`);
        assert.equal(readFileSync(join(evidenceDir, "review-routing-focused-windows.tap.log"), "utf8").replace(/\r\n/g, "\n"), expected);
        assert.equal(snapshot(), before, "guard must not mutate checkout data or refs");
        if (entry.override) assert.ok(!stdout.includes(entry.override) && !stderr.includes(entry.override));
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
