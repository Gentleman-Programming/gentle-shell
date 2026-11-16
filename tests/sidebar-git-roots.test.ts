import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverSidebarGitRoots } from "../lib/sidebar-git-roots.ts";

test("discovers only primary and current roots from bounded metadata", async () => {
 const calls: string[][] = [];
 const result = await discoverSidebarGitRoots(async args => {
  calls.push(args);
  return { code: 0, stdout: args[0] === "rev-parse" ? "/repo/wt\n" : "worktree /repo/main\0branch refs/heads/main\0\0worktree /repo/wt\0branch refs/heads/feature\0\0worktree /repo/other\0\0" };
 });
 assert.deepEqual(result, { state: "ready", main: "/repo/main", wt: "/repo/wt" });
 assert.deepEqual(calls, [["rev-parse", "--show-toplevel"], ["worktree", "list", "--porcelain", "-z"]]);
});

test("recognizes a primary checkout and rejects incomplete or unrelated metadata", async () => {
 const run = (top: string, list: string, truncated = false) => discoverSidebarGitRoots(async args => ({ code: 0, stdout: args[0] === "rev-parse" ? top : list, truncated: args[0] !== "rev-parse" && truncated }));
 assert.deepEqual(await run("/repo/main\n", "worktree /repo/main\0\0"), { state: "ready", main: "/repo/main", wt: "/repo/main" });
 for (const [top, list, truncated] of [["/repo/wt\n", "worktree /repo/main\0\0", false], ["/repo/main\n", "worktree /repo/main\0", false], ["/repo/main\n", "worktree /repo/main\0\0", true]] as const) {
  assert.deepEqual(await run(top, list, truncated), { state: "error", message: "Could not detect Git worktree roots." });
 }
});
