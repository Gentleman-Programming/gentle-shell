import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { readSidebarGitGraph, renderSidebarGitGraph, SidebarGitFrameCache, SidebarGitHistory } from "../lib/sidebar-git-graph.ts";

test("Git heading uses the shared section roles and preserves branch and folding", () => {
 const theme = { fg: (role: string, text: string) => `<${role}>${text}</${role}>`, bold: (text: string) => `<bold>${text}</bold>` };
 const graph = { state: "ready" as const, branch: "feature", lines: ["* history"] };
 const open = renderSidebarGitGraph(graph, theme, 100, 5);
 assert.match(open[0]!, /<muted>▾<\/muted> <text><bold>GIT<\/bold><\/text>/);
 assert.match(open[0]!, /feature/); assert.match(open.join("\n"), /history/);
 const closed = renderSidebarGitGraph(graph, theme, 100, 5, 0, true);
 assert.match(closed[0]!, /<muted>▸<\/muted> <text><bold>GIT<\/bold><\/text>/);
 assert.equal(closed.length, 1);
});

test("reads only bounded HEAD history and rejects partial output", async () => {
 const calls: string[][] = [];
 const graph = await readSidebarGitGraph(async args => {
  calls.push(args);
  return { code: 0, stdout: args[0] === "symbolic-ref" ? "main\n" : args[0] === "rev-parse" ? "abc\n" : "* \x1eabc\x1fHEAD -> main\x1ffeat: hello\x1e\n" };
 });
 assert.equal(graph.state, "ready");
 assert.deepEqual(calls[2]!.slice(-2), ["--format=%x1e%h%x1f%D%x1f%s%x1e", "HEAD"]);
 assert.ok(calls[2]!.includes("--max-count=50"));
 assert.deepEqual(await readSidebarGitGraph(async args => ({ code: 0, stdout: args[0] === "symbolic-ref" ? "main" : "partial", truncated: args[0] === "-c" })), { state: "error" });
});

test("graph rendering sanitizes input, clips widths, bounds viewport and caches theme", () => {
 let color = 32;
 const theme = { fg: (_role: string, text: string) => `\x1b[${color}m${text}\x1b[0m` };
 const graph = { state: "ready" as const, branch: "branch-".repeat(20), lines: Array.from({ length: 30 }, (_, i) => `* \x1eabc\x1fref\x1ffeat: row ${i}\x1b]0;bad\x07\x1e`) };
 const cache = new SidebarGitFrameCache();
 const rows = cache.render(graph, 1, theme, 24, 5, 12);
 assert.equal(rows.length, 5); assert.ok(rows.every(row => visibleWidth(row) <= 24));
 assert.match(rows.join(""), /row 12/); assert.doesNotMatch(rows.join(""), /\x1b\]/);
 assert.strictEqual(cache.render(graph, 1, theme, 24, 5, 12), rows);
 color = 33; assert.notStrictEqual(cache.render(graph, 1, theme, 24, 5, 12), rows);
 assert.deepEqual(renderSidebarGitGraph(graph, theme, 0, 5), []);
});

test("history is inactive until enabled and discards work after deactivation", async () => {
 let calls = 0, publishes = 0, release!: () => void;
 const history = new SidebarGitHistory(async args => {
  calls++; if (calls === 1) await new Promise<void>(resolve => { release = resolve; });
  return { code: 0, stdout: args[0] === "symbolic-ref" ? "main" : args[0] === "rev-parse" ? "abc" : "* \x1eabc\x1f\x1fsubject\x1e\n" };
 }, async () => "clean", () => { publishes++; });
 await history.refresh(); assert.equal(calls, 0);
 history.setActive(true); await Promise.resolve(); history.setActive(false); release();
 await new Promise(resolve => setImmediate(resolve)); assert.equal(publishes, 0);
 history.setActive(true); await Promise.resolve(); await history.refresh();
 assert.equal(history.graph.state, "ready"); assert.ok(publishes > 0);
 history.setActive(false);
});
