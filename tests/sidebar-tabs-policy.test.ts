import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveSidebarTabs, writeSidebarTabs } from "../lib/sidebar-tabs-policy.ts";

test("destination preferences persist independently of global Tabs and legacy files remain enabled", t => {
 const home = mkdtempSync(join(tmpdir(), "sidebar-tabs-destinations-"));
 t.after(() => rmSync(home, { recursive: true, force: true }));
 const options = { gentlePiConfigHome: home };
 writeFileSync(join(home, "sidebar-tabs.json"), '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on"}\n');
 assert.equal(resolveSidebarTabs(options).main, "on");
 assert.equal(resolveSidebarTabs(options).git, "on");
 writeSidebarTabs("on", options, { main: "off", git: "on" });
 writeSidebarTabs("off", options);
 assert.deepEqual([resolveSidebarTabs(options).policy, resolveSidebarTabs(options).main, resolveSidebarTabs(options).git], ["off", "off", "on"]);
 writeSidebarTabs("on", options);
 assert.deepEqual([resolveSidebarTabs(options).policy, resolveSidebarTabs(options).main, resolveSidebarTabs(options).git], ["on", "off", "on"]);
});

test("global Tabs defaults off, persists both choices, and refuses malformed files", (t) => {
 const home = mkdtempSync(join(tmpdir(), "sidebar-tabs-"));
 t.after(() => rmSync(home, { recursive: true, force: true }));
 const options = { gentlePiConfigHome: home };
 assert.equal(resolveSidebarTabs(options).policy, "off");
 writeSidebarTabs("on", options);
 assert.equal(resolveSidebarTabs(options).policy, "on");
 writeSidebarTabs("off", options);
 assert.equal(resolveSidebarTabs(options).policy, "off");
 const path = resolveSidebarTabs(options).globalFile;
 for (const raw of ["broken", "null", "[]", "{}", '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","extra":true}', '{"schema":"future","policy":"on"}', '{"schema":"gentle-pi.sidebar-tabs/v1","policy":true}', '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"invalid"}']) {
  writeFileSync(path, raw);
  const result = resolveSidebarTabs(options);
  assert.equal(result.malformed, true, raw);
  assert.equal(result.policy, "off", raw);
  assert.throws(() => writeSidebarTabs("on", options));
  assert.equal(readFileSync(path, "utf8"), raw);
 }
});
