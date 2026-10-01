import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Source-parsing tests (§D3): never import extensions/history/index.ts — it
// pulls the pi-tui runtime graph. Mirrors history-command-registration.test.ts.
const sourcePath = fileURLToPath(
  new URL("../extensions/history/index.ts", import.meta.url),
);
const source = fs.readFileSync(sourcePath, "utf8");

/** The extension entry point to the end of the file. */
function factoryBody(): string {
  const start = source.indexOf("export default function");
  assert.ok(start >= 0, "extension entry point should exist");
  return source.slice(start);
}

test("history store and sessions roots default to Pi's active agent dir (#1618)", () => {
  // The extension must import Pi's own resolver, which honors
  // PI_CODING_AGENT_DIR (the Gentle Shell home), exactly like the startup
  // banner fixes 39c8d870 / 1393db7c.
  assert.match(
    source,
    /import\s*\{[^}]*getAgentDir[^}]*\}\s*from\s*"@earendil-works\/pi-coding-agent"/,
    "index.ts should import getAgentDir from @earendil-works/pi-coding-agent",
  );
  const body = factoryBody();
  const active = body.match(/const (\w+) = getAgentDir\(\);/);
  assert.ok(
    active,
    "the factory should resolve the active agent dir via getAgentDir()",
  );
  assert.match(
    body,
    new RegExp(`root = deps\\.root \\?\\? join\\(${active[1]}, "history"\\)`),
    "the v2 store root should default to <active agent dir>/history",
  );
  assert.match(
    body,
    new RegExp(
      `sessionsRoot = deps\\.sessionsRoot \\?\\? join\\(${active[1]}, "sessions"\\)`,
    ),
    "the transcript scan root should default to <active agent dir>/sessions",
  );
  assert.ok(
    !body.includes("homedir()"),
    "the factory must not resolve any default from homedir()",
  );
});

test("legacy pre-v1 migration still reads the vanilla agent dir (#1618)", () => {
  // Pre-v1 editor-history files were written by vanilla Pi under ~/.pi/agent
  // and are migrated by migrateLegacyStores(); only the store and sessions
  // roots follow the active home.
  assert.match(
    source,
    /const LEGACY_AGENT_DIR = join\(homedir\(\), "\.pi", "agent"\);/,
    "the vanilla agent dir should remain, named as the legacy source",
  );
  assert.match(
    factoryBody(),
    /agentDir = deps\.agentDir \?\? LEGACY_AGENT_DIR;/,
    "migrateLegacyStores must keep receiving the vanilla dir by default",
  );
});
