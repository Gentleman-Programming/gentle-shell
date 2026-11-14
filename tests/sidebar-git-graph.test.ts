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
 assert.equal(rows.length, 5); assert.ok(rows.every(row => visibleWidth(row) === 24), "padded rows fill the rail exactly");
 assert.match(rows.join(""), /row/); assert.doesNotMatch(rows.join(""), /\x1b\]/);
 assert.strictEqual(cache.render(graph, 1, theme, 24, 5, 12), rows);
 color = 33; assert.notStrictEqual(cache.render(graph, 1, theme, 24, 5, 12), rows);
 assert.deepEqual(renderSidebarGitGraph(graph, theme, 0, 5), []);
});

test("identical completed history captures signal settlement without increasing revision", async () => {
 let publishes = 0;
 const history = new SidebarGitHistory(async args => ({ code: 0, stdout: args[0] === "symbolic-ref" ? "main" : args[0] === "rev-parse" ? "abc" : "* history\n" }), async () => "clean", () => { publishes++; });
 history.setActive(true);
 // Drain the automatic entry capture before requesting an independent capture.
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(publishes, 1);
 const graph = history.graph, revision = history.revision;
 assert.equal(revision, 1);
 await history.refresh();
 assert.equal(publishes, 2, "an identical completed capture still signals settlement");
 assert.equal(history.revision, revision);
 assert.strictEqual(history.graph, graph);
 history.setActive(false);
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

test("a failing repaint never rejects capture and keeps the reported graph", async () => {
 // requestRender can throw once the terminal has stopped. A repaint failure
 // must never reject capture: setActive() refreshes fire-and-forget, so a
 // rejected capture would surface as an unhandled rejection.
 let subject = "first";
 const history = new SidebarGitHistory(async args => ({
  code: 0,
  stdout: args[0] === "symbolic-ref" ? "main" : args[0] === "rev-parse" ? "abc" : `* \x1eabc\x1f\x1f${subject}\x1e\n`,
 }), async () => "clean", () => { throw new Error("the terminal stopped: requestRender failed"); });
 history.setActive(true);
 await assert.doesNotReject(history.refresh(), "a repaint failure does not reject the queued refresh");
 await new Promise(resolve => setImmediate(resolve));
 assert.deepEqual(history.graph, { state: "ready", branch: "main", lines: ["* \x1eabc\x1f\x1ffirst\x1e"] });
 assert.equal(history.revision, 1);
 subject = "second";
 await assert.doesNotReject(history.refresh(), "a later repaint failure does not reject either");
 assert.deepEqual(history.graph, { state: "ready", branch: "main", lines: ["* \x1eabc\x1f\x1fsecond\x1e"] });
 assert.equal(history.revision, 2);
 history.setActive(false);
});

test("a realistic long branch and ref name clip inside a narrow rail", () => {
 // A real destination branch plus the ref shorthand Git prints for HEAD and
 // its upstream: both far wider than the rail's card, which must truncate and
 // keep every row inside the width instead of dropping the section.
 const branch = "feature/2750-git-sidebar-destination-with-a-very-long-branch-name-overflow";
 const refs = `HEAD -> ${branch}, origin/${branch}`;
 const graph = { state: "ready" as const, branch, lines: [
  `* \x1e8d2f1aa\x1f${refs}\x1ffeat(sidebar): add the git history destination\x1e`,
  "* \x1e1f9c204\x1f\x1ffix(sidebar): keep the rail width stable\x1e",
 ] };
 const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
 const cache = new SidebarGitFrameCache();
 for (const width of [20, 24, 30]) {
  const rows = renderSidebarGitGraph(graph, theme, width, 4);
  assert.equal(rows.length, 3, `the narrow rail keeps its header and both commits at ${width}`);
  assert.ok(rows.every(row => visibleWidth(row) <= width), `every row fits the ${width}-column rail`);
  assert.ok(rows.every(row => !row.includes(branch)), `the branch name is clipped at ${width}`);
  assert.ok(rows[1]!.includes("…") && rows[2]!.includes("…"), `the clipped rows show the truncation marker at ${width}`);
  // The graph column and short hash are the identity that must survive clipping.
  assert.match(rows[1]!, /^ {2}\* 8d2f1aa /, "body rows carry the panel indent like MAIN/PROFILE");
  // The rail's frame cache stores exactly those clipped rows and reuses them.
  assert.deepEqual(cache.render(graph, 7, theme, width, 4), rows, "the frame cache keeps the clipped rows");
  assert.strictEqual(cache.render(graph, 7, theme, width, 4), cache.render(graph, 7, theme, width, 4), "a settled frame is served from the cache");
 }
});

test("graph rows fill the rail width so the tinted surface has no bare notches", () => {
 const plain = { fg: (_role: string, text: string) => text };
 const styled = { fg: (_role: string, text: string) => `\x1b[33m${text}\x1b[0m` };
 const graph = { state: "ready" as const, branch: "main", lines: Array.from({ length: 6 }, (_, i) => `* \x1eabc\x1f\x1ffeat: row ${i}\x1e`) };
 for (const theme of [plain, styled]) {
  assert.equal(renderSidebarGitGraph(graph, theme, 40, 5).length, 5);
  assert.equal(renderSidebarGitGraph(graph, theme, 40, 5, 2).length, 5);
  const collapsed = renderSidebarGitGraph(graph, theme, 40, 3, 0, true);
  assert.equal(collapsed.length, 1);
  for (const rows of [renderSidebarGitGraph(graph, theme, 40, 5), renderSidebarGitGraph(graph, theme, 40, 5, 2), collapsed,
   renderSidebarGitGraph({ state: "unborn", branch: "main" }, theme, 40, 3)]) {
   assert.ok(rows.every(row => visibleWidth(row) === 40), rows.map(row => `${visibleWidth(row)}`).join(","));
  }
 }
});
