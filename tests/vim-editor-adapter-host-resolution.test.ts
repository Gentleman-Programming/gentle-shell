import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// A git install (`pi install git:...`) has no node_modules next to the
// extension: Pi aliases ES imports of host packages, but nothing else
// resolves them (#1586). Reproduce that layout with an ESM-only alias.
test("vim adapter loads without an extension-local pi-tui and fails closed without a verified version", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gentle-vim-host-resolution-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "lib"));
  copyFileSync(fileURLToPath(new URL("../lib/vim-editor-adapter.ts", import.meta.url)), join(root, "lib", "vim-editor-adapter.ts"));
  const tuiUrl = import.meta.resolve("@earendil-works/pi-tui");
  writeFileSync(join(root, "alias-hooks.mjs"), `export async function resolve(specifier, context, next) {
  if (specifier === "@earendil-works/pi-tui") return { url: ${JSON.stringify(tuiUrl)}, shortCircuit: true };
  return next(specifier, context);
}
`);
  writeFileSync(join(root, "register.mjs"), `import { register } from "node:module";
register("./alias-hooks.mjs", import.meta.url);
`);
  writeFileSync(join(root, "probe.mjs"), `import { Editor } from "@earendil-works/pi-tui";
const { createVimEditorAdapter } = await import("./lib/vim-editor-adapter.ts");
const editor = new Editor({ terminal: { rows: 24 }, requestRender() {} }, { borderColor: (s) => s });
let unverified = "admitted";
try { createVimEditorAdapter(editor, "0.99.1"); } catch (error) { unverified = error.message; }
const verified = typeof createVimEditorAdapter(editor, "0.99.1", Editor, "0.99.1").move;
process.stdout.write(JSON.stringify({ unverified, verified }));
`);
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--import", pathToFileURL(join(root, "register.mjs")).href, join(root, "probe.mjs")], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { unverified: "Unsupported Pi editor layout/version", verified: "function" });
});
