import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { CURSOR_MARKER, Editor, visibleWidth } from "@earendil-works/pi-tui";
import { AUDITED_PI_EDITOR_VERSIONS, createVimEditorAdapter, isAuditedPiEditorVersion } from "../lib/vim-editor-adapter.ts";
import { resolveVimRuntime, VIM_AGENT_INDEX_PATTERN, VIM_CLI_ENTRY_PATTERN } from "../extensions/gentle-shell.ts";
import { VimOperatorEngine } from "../lib/vim-operator-engine.ts";
import { VimVisualEngine } from "../lib/vim-visual-engine.ts";

function editor(): Editor {
  return new Editor({ terminal: { rows: 24 }, requestRender() {} } as never, { borderColor: (s: string) => s } as never);
}

// Decode the effective reverse-video state at each displayed cell, rather
// than treating the presence of an SGR 7 anywhere on a row as selection.
function paintedCells(row: string): Array<{ char: string; inverse: boolean }> {
  const cells: Array<{ char: string; inverse: boolean }> = [];
  let inverse = false;
  const tokens = row.match(/\x1b\[[0-9;]*m|\x1b_pi:c\x07|[^\x1b]/g) ?? [];
  assert.equal(tokens.join(""), row, "only known editor escape sequences are present");
  for (const token of tokens) {
    if (token === CURSOR_MARKER) continue;
    if (token.startsWith("\x1b[")) {
      const codes = token.slice(2, -1).split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        if ((codes[i] === 38 || codes[i] === 48 || codes[i] === 58) && codes[i + 1] === 2) i += 4;
        else if ((codes[i] === 38 || codes[i] === 48 || codes[i] === 58) && codes[i + 1] === 5) i += 2;
        else if (codes[i] === 0 || codes[i] === 27) inverse = false;
        else if (codes[i] === 7) inverse = true;
      }
    } else cells.push({ char: token, inverse });
  }
  return cells;
}

function selectedColumns(row: string): number[] {
  return paintedCells(row).flatMap((cell, col) => cell.inverse ? [col] : []);
}

// Exercise both module graphs from the exact declared development install.
// No user PATH shim or optional global install is needed for bundled identity.
const target = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const skip0871 = undefined;
// Development resolves Pi through an open devDependency range, so the version
// under test is the installed TUI metadata, never the manifest specifier.
const INSTALLED_PI = (createRequire(import.meta.url)("@earendil-works/pi-tui/package.json") as { version: string }).version;

let runtimeTui: typeof import("@earendil-works/pi-tui") | undefined;
let runtimeAgent: typeof import("@earendil-works/pi-coding-agent") | undefined;
let runtimeTuiPackage: { version: string } | undefined;
let runtimeAgentPackage: { version: string } | undefined;
let bundledAgent: typeof import("@earendil-works/pi-coding-agent") | undefined;
let BundledEditor: typeof Editor | undefined;
let virtualAgent: { CustomEditor?: typeof import("@earendil-works/pi-coding-agent").CustomEditor; Editor?: typeof Editor } | undefined;
let virtualTui: { CustomEditor?: typeof import("@earendil-works/pi-coding-agent").CustomEditor; Editor?: typeof Editor } | undefined;

if (target) {
  const runtimeRequire = createRequire(realpathSync(target));
  const runtimeTuiPath = runtimeRequire.resolve("@earendil-works/pi-tui");
  const runtimeAgentPath = resolve(dirname(realpathSync(target)), "../index.js");
  runtimeTuiPackage = runtimeRequire(resolve(dirname(runtimeTuiPath), "../package.json")) as { version: string };
  runtimeAgentPackage = runtimeRequire(resolve(dirname(runtimeAgentPath), "../package.json")) as { version: string };
  runtimeTui = await import(pathToFileURL(runtimeTuiPath).href) as typeof import("@earendil-works/pi-tui");
  runtimeAgent = await import(pathToFileURL(runtimeAgentPath).href) as typeof import("@earendil-works/pi-coding-agent");
  // The PATH CLI runs the bundled graph, not the package's unbundled dist/index.js.
  bundledAgent = await import(pathToFileURL(resolve(dirname(realpathSync(target)), "index.js")).href) as typeof import("@earendil-works/pi-coding-agent");
  BundledEditor = Object.getPrototypeOf(bundledAgent.CustomEditor.prototype)?.constructor as typeof Editor;
  // Follow the public bundle's actual imported module chain to the virtual
  // loader; no hash or chunk filename is assumed by the compatibility gate.
  const bundleIndex = resolve(dirname(realpathSync(target)), "index.js");
  const bundleImports = [...readFileSync(bundleIndex, "utf8").matchAll(/from"(\.\/chunks\/[^\"]+\.js)"/g)];
  const virtualPaths = bundleImports.flatMap((match) => {
    const source = readFileSync(resolve(dirname(bundleIndex), match[1]!), "utf8");
    return [...source.matchAll(/import\("(\.\/virtual-modules-[^\"]+\.js)"\)/g)]
      .map((found) => resolve(dirname(bundleIndex), "chunks", found[1]!));
  });
  assert.equal(new Set(virtualPaths).size, 1, "bundle must have exactly one reachable virtual module map");
  const virtualModule = await import(pathToFileURL(virtualPaths[0]!).href) as {
    VIRTUAL_MODULES: Record<string, { CustomEditor?: typeof bundledAgent.CustomEditor; Editor?: typeof Editor }>;
  };
  virtualAgent = virtualModule.VIRTUAL_MODULES["@earendil-works/pi-coding-agent"];
  virtualTui = virtualModule.VIRTUAL_MODULES["@earendil-works/pi-tui"];
}

test("local bundled virtual host is admitted only through its exact bundled class and version", { skip: skip0871 }, () => {
  assert.equal(bundledAgent.VERSION, INSTALLED_PI);
  assert.notEqual(bundledAgent.CustomEditor, runtimeAgent.CustomEditor);
  assert.notEqual(BundledEditor, runtimeTui.Editor);
  assert.equal(virtualAgent?.CustomEditor, bundledAgent.CustomEditor);
  assert.equal(virtualTui?.Editor, BundledEditor);
  assert.equal(Object.getPrototypeOf(bundledAgent.CustomEditor.prototype), BundledEditor.prototype);
  assert.deepEqual(resolveVimRuntime(target, bundledAgent.CustomEditor), { version: INSTALLED_PI, editorClass: BundledEditor });
  assert.equal(resolveVimRuntime("/nonexistent/cli.js", bundledAgent.CustomEditor), undefined);
  const e = new bundledAgent.CustomEditor({ terminal: { rows: 6, columns: 30 }, requestRender() {} } as never,
    { borderColor: (s: string) => s } as never, { matches: () => false } as never);
  e.setText("alpha beta");
  const adapter = createVimEditorAdapter(e, INSTALLED_PI, BundledEditor, bundledAgent.VERSION);
  adapter.move({ line: 0, col: 6 });
  adapter.replace({ line: 0, col: 6 }, { line: 0, col: 10 }, "snow");
  assert.equal(e.getText(), "alpha snow");
  adapter.undo();
  assert.equal(e.getText(), "alpha beta");
  e.setText("[paste #1 3 chars] tail");
  (e as unknown as { pastes: Map<number, string> }).pastes.set(1, "abc");
  assert.ok(!adapter.motionBoundaries()[0]!.includes(4));
  const rows = e.render(30);
  assert.ok(adapter.renderSelection(30, { line: 0, col: 0 }, { line: 0, col: 18 }, rows).some(row => row.includes("\x1b[7m")));
});

test("bundled installed editor accepts visual c/p ranges at Unicode and multiline endpoints", { skip: skip0871 }, () => {
  const e = new bundledAgent.CustomEditor({ terminal: { rows: 6, columns: 30 }, requestRender() {} } as never,
    { borderColor: (s: string) => s } as never, { matches: () => false } as never);
  const adapter = createVimEditorAdapter(e, INSTALLED_PI, BundledEditor, bundledAgent.VERSION);
  const visual = new VimVisualEngine();
  const operator = new VimOperatorEngine();
  e.setText("👩‍💻é\n雪");
  adapter.move({ line: 0, col: 0 });
  visual.start("char", e.getCursor());
  const yankRange = visual.range(e.getText(), e.getCursor(), adapter.motionBoundaries())!;
  operator.visualRegister(adapter.readRange(yankRange.start, yankRange.end), false);
  visual.cancel();
  adapter.move({ line: 1, col: 0 });
  visual.start("char", e.getCursor());
  const pasteRange = visual.range(e.getText(), e.getCursor(), adapter.motionBoundaries())!;
  const selected = adapter.readRange(pasteRange.start, pasteRange.end);
  assert.equal(selected, "雪");
  const paste = operator.visualEdit("p", e.getText(), pasteRange).edit!;
  adapter.replace(paste.start, paste.end, paste.text);
  adapter.move(paste.cursor);
  operator.visualRegister(selected, false);
  assert.equal(e.getText(), "👩‍💻é\n👩‍💻");
  visual.cancel();
  visual.start("char", e.getCursor());
  const changeRange = visual.range(e.getText(), e.getCursor(), adapter.motionBoundaries())!;
  const change = operator.visualEdit("c", e.getText(), changeRange).edit!;
  adapter.replace(change.start, change.end, change.text);
  adapter.move(change.cursor);
  assert.equal(e.getText(), "👩‍💻é\n");
});

test("bundled installed full-line characterwise visual c/p stages preserve host rows and autocomplete", { skip: skip0871 }, () => {
  for (const command of ["c", "p"] as const) {
    const e = new bundledAgent.CustomEditor({ terminal: { rows: 6, columns: 30 }, requestRender() {} } as never,
      { borderColor: (s: string) => s } as never, { matches: () => false } as never);
    const adapter = createVimEditorAdapter(e, INSTALLED_PI, BundledEditor, bundledAgent.VERSION);
    const visual = new VimVisualEngine();
    const operator = new VimOperatorEngine();
    e.setText("asdf asdf asd f");
    adapter.move({ line: 0, col: 0 });
    visual.start("char", e.getCursor());
    adapter.move({ line: 0, col: e.getText().length });
    const range = visual.range(e.getText(), e.getCursor(), adapter.motionBoundaries())!;
    assert.equal(range.linewise, false);
    assert.equal(adapter.readRange(range.start, range.end), "asdf asdf asd f");
    const frame = e.render(30);
    assert.equal(adapter.renderSelection(30, range.start, range.end, frame).length, frame.length);
    if (command === "p") operator.visualRegister("saved", false);
    (e as unknown as { autocompleteState: unknown }).autocompleteState = "force";
    const edit = operator.visualEdit(command, e.getText(), range).edit!;
    if (edit.insert) adapter.beginInsertSession();
    adapter.replace(edit.start, edit.end, edit.text);
    adapter.move(edit.cursor);
    assert.equal(e.getText(), command === "c" ? "" : "saved");
    assert.equal((e as unknown as { autocompleteState: unknown }).autocompleteState, null);
    assert.ok(e.render(30).length > 0);
  }
});

test("runtime identity resolves only the matching installed coding-agent/TUI pair", { skip: skip0871 }, () => {
  assert.deepEqual(resolveVimRuntime(target, runtimeAgent.CustomEditor), { version: INSTALLED_PI, editorClass: runtimeTui.Editor });
  assert.deepEqual(resolveVimRuntime(target), { version: INSTALLED_PI, editorClass: Editor }, "the declared local pair retains its own constructor identity");
  // A virtual-module Editor alias can be the host class, so only the
  // matching installed pair may certify its version.
  assert.equal(runtimeAgentPackage.version, INSTALLED_PI);
  assert.deepEqual(resolveVimRuntime(target, runtimeAgent.CustomEditor), { version: runtimeTuiPackage.version, editorClass: runtimeTui.Editor });
  assert.equal(resolveVimRuntime(target, class Impostor extends runtimeTui.Editor {} as typeof runtimeAgent.CustomEditor), undefined);
  assert.deepEqual(resolveVimRuntime("/nonexistent/cli.js", runtimeAgent.CustomEditor), { version: INSTALLED_PI, editorClass: Editor });
});

function assertInstalledPiPairBehavior(version: string, EditorClass: typeof Editor, CustomClass: { prototype: unknown } | undefined, verifiedVersion?: string): void {
  assert.equal(CustomClass ? Object.getPrototypeOf(CustomClass.prototype) : EditorClass.prototype, EditorClass.prototype);
  const e = new EditorClass({ terminal: { rows: 6, columns: 22 }, requestRender() {} } as never, { borderColor: (s: string) => s } as never);
  e.setText("alpha beta\nthird line");
  const adapter = createVimEditorAdapter(e, version, EditorClass, verifiedVersion);
  adapter.move({ line: 0, col: 6 });
  adapter.replace({ line: 0, col: 6 }, { line: 0, col: 10 }, "snow");
  assert.equal(e.getText(), "alpha snow\nthird line");
  adapter.undo();
  assert.equal(e.getText(), "alpha beta\nthird line");
  e.addToHistory("earlier draft");
  e.setText("");
  e.handleInput(`\x1b[200~${"z".repeat(1001)}\x1b[201~`);
  e.insertTextAtCursor("\ntail");
  const pastedText = e.getText();
  const expandedText = e.getExpandedText();
  adapter.replace({ line: 1, col: 0 }, { line: 1, col: 4 }, "snow");
  assert.equal(e.getExpandedText(), expandedText.replace("tail", "snow"), `${version}: real paste survives edit`);
  adapter.undo();
  assert.equal(e.getText(), pastedText, `${version}: undo restores collapsed marker`);
  assert.equal(e.getExpandedText(), expandedText, `${version}: undo restores paste registry`);
  e.setText("");
  e.handleInput("\x1b[A");
  assert.equal(e.getText(), "earlier draft", `${version}: history survives private edit`);
  e.setText("[paste #1 3 chars] wrapping text\nthird line");
  (e as unknown as { pastes: Map<number, string> }).pastes.set(1, "abc");
  assert.ok(!adapter.motionBoundaries()[0]!.includes(4), `${version}: paste marker atomic`);
  e.focused = true;
  const rows = e.render(18);
  const selected = adapter.renderSelection(18, { line: 0, col: 0 }, { line: 0, col: "[paste #1 3 chars]".length }, rows);
  assert.ok(selected.some((row: string) => row.includes("\x1b[7m")), `${version}: selection`);
  assert.ok(selected.join("").includes(CURSOR_MARKER), `${version}: cursor`);
  assert.ok((e as unknown as { scrollOffset: number }).scrollOffset >= 0);
  assert.ok(rows.length > 3, `${version}: wrapped frame`);
  const privateEditor = e as unknown as { autocompleteState: string; autocompleteList: { render(width: number): string[] }; scrollOffset: number };
  privateEditor.autocompleteState = "force";
  privateEditor.autocompleteList = { render: () => ["completion"] };
  assert.ok(e.render(18).some((row: string) => row.includes("completion")), `${version}: autocomplete renders after frame`);
  privateEditor.autocompleteState = "";
  e.setText("repeat ".repeat(60));
  adapter.move({ line: 0, col: 0 });
  e.render(18);
  adapter.move({ line: 0, col: e.getText().length });
  const scrolled = e.render(18);
  assert.ok(privateEditor.scrollOffset > 0, `${version}: scrolled wraps`);
  assert.equal(adapter.renderSelection(18, { line: 0, col: 0 }, { line: 0, col: 6 }, scrolled).length, scrolled.length);
}

test(`actual bundled Pi ${INSTALLED_PI} proves editing, undo, paste, selection, wrap and autocomplete`, () => {
  assert.equal(bundledAgent.VERSION, INSTALLED_PI);
  assertInstalledPiPairBehavior(bundledAgent.VERSION, BundledEditor, bundledAgent.CustomEditor, bundledAgent.VERSION);
});

test("installed audited Pi local pair proves version, constructor identity, editing, paste, selection, wrap and autocomplete", () => {
  assertInstalledPiPairBehavior(INSTALLED_PI, Editor, undefined);
});

test("resolveVimRuntime's default entry resolves the declared local audited install without any PATH Pi", () => {
  assert.deepEqual(resolveVimRuntime(), { version: INSTALLED_PI, editorClass: Editor });
  assert.deepEqual(resolveVimRuntime("/nonexistent/cli.js"), { version: INSTALLED_PI, editorClass: Editor });
  assert.deepEqual(resolveVimRuntime("C:\\nonexistent\\cli.js"), { version: INSTALLED_PI, editorClass: Editor });
});

test("resolveVimRuntime path patterns admit Windows and POSIX separators and reject impostors", () => {
  assert.equal(VIM_CLI_ENTRY_PATTERN.test("/opt/pi/dist/bundle/cli.js"), true);
  assert.equal(VIM_CLI_ENTRY_PATTERN.test("C:\\pi\\dist\\bundle\\cli.js"), true);
  assert.equal(VIM_CLI_ENTRY_PATTERN.test("dist/bundle/cli.js"), true);
  assert.equal(VIM_CLI_ENTRY_PATTERN.test("dist\\bundle\\cli.js"), true);
  assert.equal(VIM_CLI_ENTRY_PATTERN.test("/opt/pi/other-dist/bundle/cli.js"), false);
  assert.equal(VIM_CLI_ENTRY_PATTERN.test("C:\\pi\\other-dist\\bundle\\cli.js"), false);
  assert.equal(VIM_CLI_ENTRY_PATTERN.test("/opt/pi/dist/bundle/cli.js.map"), false);

  assert.equal(VIM_AGENT_INDEX_PATTERN.test("/node_modules/@earendil-works/pi-coding-agent/dist/index.js"), true);
  assert.equal(VIM_AGENT_INDEX_PATTERN.test("C:\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\index.js"), true);
  assert.equal(VIM_AGENT_INDEX_PATTERN.test("dist/index.js"), true);
  assert.equal(VIM_AGENT_INDEX_PATTERN.test("dist\\index.js"), true);
  assert.equal(VIM_AGENT_INDEX_PATTERN.test("/node_modules/@earendil-works/pi-coding-agent/notdist/index.js"), false);
  assert.equal(VIM_AGENT_INDEX_PATTERN.test("C:\\node_modules\\@earendil-works\\pi-coding-agent\\notdist\\index.js"), false);
  assert.equal(VIM_AGENT_INDEX_PATTERN.test("/dist/index.js.map"), false);
});

test("resolveVimRuntime resolves local bundle cli entrypoint when provided", () => {
  const localCli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  if (existsSync(localCli)) {
    assert.deepEqual(resolveVimRuntime(localCli), { version: INSTALLED_PI, editorClass: Editor });
  }
});

test("audited Pi editor releases are one frozen exact allowlist that includes the installed TUI", () => {
  assert.deepEqual([...AUDITED_PI_EDITOR_VERSIONS], ["0.99.1", "0.99.2", "1.0.0", "1.1.0"]);
  assert.equal(bundledAgent.VERSION, INSTALLED_PI, "bundled and local metadata must describe the same actual installed release");
  assert.ok(Object.isFrozen(AUDITED_PI_EDITOR_VERSIONS));
  assert.throws(() => (AUDITED_PI_EDITOR_VERSIONS as unknown as string[]).push("0.99.3"), TypeError);
  assert.ok(isAuditedPiEditorVersion(INSTALLED_PI), `installed pi-tui ${INSTALLED_PI} must be audited`);
  for (const unknown of ["0.99.3", "0.99.10", "0.99", "v0.99.2", " 0.99.2", "0.99.2-rc.1", ">=0.99.2", "1.0.1", ">=1.0.0", "v1.0.0", " 1.0.0", "1.0.0-rc.1", undefined, 99.2]) {
    assert.equal(isAuditedPiEditorVersion(unknown), false, String(unknown));
  }
});

// A fabricated package root reuses the real installed classes but declares its
// own release metadata, isolating the audited-version allowlist from identity.
function fabricatedPiCli(t: test.TestContext, version: string, tuiVersion = version, bundledVersion = version): string {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "gentle-vim-audit-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const realBundle = resolve(dirname(realpathSync(target)), "index.js");
  const realAgent = resolve(dirname(realpathSync(target)), "../index.js");
  const realTui = createRequire(realpathSync(target)).resolve("@earendil-works/pi-tui");
  const tuiRoot = resolve(root, "node_modules", "@earendil-works", "pi-tui");
  mkdirSync(resolve(root, "dist", "bundle"), { recursive: true });
  mkdirSync(resolve(tuiRoot, "dist"), { recursive: true });
  writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }));
  writeFileSync(resolve(root, "dist", "bundle", "cli.js"), "");
  writeFileSync(resolve(root, "dist", "bundle", "index.js"),
    `const real = require(${JSON.stringify(realBundle)});\nmodule.exports = { CustomEditor: real.CustomEditor, VERSION: ${JSON.stringify(bundledVersion)} };\n`);
  writeFileSync(resolve(root, "dist", "index.js"), `module.exports = { CustomEditor: require(${JSON.stringify(realAgent)}).CustomEditor };\n`);
  writeFileSync(resolve(tuiRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui", version: tuiVersion, main: "dist/index.js" }));
  writeFileSync(resolve(tuiRoot, "dist", "index.js"), `module.exports = { Editor: require(${JSON.stringify(realTui)}).Editor };\n`);
  return resolve(root, "dist", "bundle", "cli.js");
}

test("bundled host admits each audited release and rejects unknown or mismatched bundle metadata", (t) => {
  for (const version of AUDITED_PI_EDITOR_VERSIONS) {
    assert.deepEqual(resolveVimRuntime(fabricatedPiCli(t, version), bundledAgent.CustomEditor), { version, editorClass: BundledEditor }, version);
  }
  for (const version of ["0.99.3", "1.0.1", ">=1.0.0", "v1.0.0"]) {
    assert.equal(resolveVimRuntime(fabricatedPiCli(t, version), bundledAgent.CustomEditor), undefined, version);
  }
  assert.equal(resolveVimRuntime(fabricatedPiCli(t, "1.0.0", "1.0.0", "0.99.2"), bundledAgent.CustomEditor), undefined);
});

test("installed agent/TUI pair admits each audited release and skips unknown or mismatched pairs", (t) => {
  for (const version of AUDITED_PI_EDITOR_VERSIONS) {
    assert.deepEqual(resolveVimRuntime(fabricatedPiCli(t, version), runtimeAgent.CustomEditor), { version, editorClass: runtimeTui.Editor }, version);
  }
  // Rejected candidates must resolve to the real local pair, not their claim.
  for (const version of ["0.99.3", "1.0.1", ">=1.0.0", "v1.0.0"]) {
    assert.deepEqual(resolveVimRuntime(fabricatedPiCli(t, version), runtimeAgent.CustomEditor), { version: INSTALLED_PI, editorClass: runtimeTui.Editor }, version);
  }
  assert.deepEqual(resolveVimRuntime(fabricatedPiCli(t, "0.99.2", "1.0.0"), runtimeAgent.CustomEditor),
    { version: INSTALLED_PI, editorClass: runtimeTui.Editor }, "mismatched pair falls back to verified local metadata");
});

test("adapter admits each verified audited release and rejects unknown or mismatched claims without mutation", () => {
  const host = () => new BundledEditor!({ terminal: { rows: 6 }, requestRender() {} } as never, { borderColor: (s: string) => s } as never);
  for (const version of AUDITED_PI_EDITOR_VERSIONS) {
    const e = host();
    e.setText("alpha beta");
    const adapter = createVimEditorAdapter(e, version, BundledEditor, version);
    adapter.move({ line: 0, col: 6 });
    adapter.replace({ line: 0, col: 6 }, { line: 0, col: 10 }, "snow");
    assert.equal(e.getText(), "alpha snow", version);
  }
  const e = host();
  e.setText("untouched");
  const frame = e.render(30);
  const cursor = e.getCursor();
  const snapshots = structuredClone((e as unknown as { undoStack: { stack: unknown[] } }).undoStack.stack);
  for (const version of ["0.99.3", "1.0.1", ">=1.0.0", "v1.0.0"]) {
    assert.throws(() => createVimEditorAdapter(e, version, BundledEditor, version), /unsupported/i, version);
    assert.throws(() => createVimEditorAdapter(editor(), version), /unsupported/i, version);
  }
  assert.throws(() => createVimEditorAdapter(e, "1.0.0", BundledEditor, "0.99.2"), /unsupported/i);
  assert.equal(e.getText(), "untouched");
  assert.deepEqual(e.getCursor(), cursor);
  assert.deepEqual(e.render(30), frame);
  assert.deepEqual((e as unknown as { undoStack: { stack: unknown[] } }).undoStack.stack, snapshots);
});

test("installed audited Pi pair proves version, constructor identity, editing, paste, selection, wrap and autocomplete", { skip: skip0871 }, () => {
  assert.equal(runtimeTuiPackage.version, INSTALLED_PI);
  assert.equal(runtimeAgentPackage.version, INSTALLED_PI);
  assertInstalledPiPairBehavior(INSTALLED_PI, runtimeTui.Editor, runtimeAgent.CustomEditor);
});

test("installed CustomEditor subclass admits the same adapter and preserves its own frame", { skip: skip0871 }, () => {
  class RuntimePrompt extends runtimeAgent.CustomEditor {}
  const e = new RuntimePrompt({ terminal: { rows: 6, columns: 30 }, requestRender() {} } as never,
    { borderColor: (s: string) => s } as never, { matches: () => false } as never);
  e.setText("one two");
  const adapter = createVimEditorAdapter(e, INSTALLED_PI, runtimeTui.Editor);
  adapter.move({ line: 0, col: 0 });
  adapter.replace({ line: 0, col: 0 }, { line: 0, col: 3 }, "snow");
  assert.equal(e.getText(), "snow two");
  adapter.undo();
  assert.equal(e.getText(), "one two");
  const rows = e.render(30);
  assert.equal(adapter.renderSelection(30, { line: 0, col: 0 }, { line: 0, col: 3 }, rows).length, rows.length);
});

test("runtime identity and prototype mismatch reject without mutation", { skip: skip0871 }, () => {
  const e = new runtimeTui.Editor({ terminal: { rows: 6 }, requestRender() {} } as never, { borderColor: (s: string) => s } as never);
  e.setText("untouched");
  assert.throws(() => createVimEditorAdapter(e, "0.85.1", Editor), /unsupported/i);
  assert.throws(() => createVimEditorAdapter(e, "0.88.0", runtimeTui.Editor), /unsupported/i);
  const forged = Object.create(e) as typeof e;
  assert.throws(() => createVimEditorAdapter(forged, INSTALLED_PI, runtimeTui.Editor), /unsupported/i);
  assert.equal(e.getText(), "untouched");
});

test("audited shape rejects corrupt undo snapshots without mutation", () => {
  const e = editor();
  e.setText("safe");
  const before = e.getText();
  const stack = (e as unknown as { undoStack: { stack: unknown[] } }).undoStack.stack;
  stack.push({ state: { lines: ["unsafe"], cursorLine: 0, cursorCol: 0 }, pastes: {}, pasteCounter: 0 });
  assert.throws(() => createVimEditorAdapter(e, INSTALLED_PI), /unsupported/i);
  assert.equal(e.getText(), before);
});

test("bundled constructor needs matching runtime authority, not a guessed version", () => {
  const e = new BundledEditor!({ terminal: { rows: 6 }, requestRender() {} } as never,
    { borderColor: (s: string) => s } as never);
  assert.throws(() => createVimEditorAdapter(e, INSTALLED_PI, BundledEditor), /unsupported/i);
  assert.throws(() => createVimEditorAdapter(e, INSTALLED_PI, BundledEditor, "0.99.0"), /unsupported/i);
});

test("rejects unknown editor shape without mutation", () => {
  const unknown = { getText: () => "untouched" };
  assert.throws(() => createVimEditorAdapter(unknown, INSTALLED_PI), /unsupported/i);
  assert.equal(unknown.getText(), "untouched");
});

test("Unicode and multiline cursor stays on atomic grapheme boundaries", () => {
  const e = editor();
  e.setText("a👩‍💻b\néx");
  const adapter = createVimEditorAdapter(e, INSTALLED_PI);
  adapter.move({ line: 0, col: 1 });
  adapter.moveByGraphemes(1);
  assert.deepEqual(e.getCursor(), { line: 0, col: 6 });
  adapter.moveByGraphemes(2);
  assert.deepEqual(e.getCursor(), { line: 1, col: 0 });
  assert.throws(() => adapter.move({ line: 0, col: 2 }), /boundary/i);
});

test("duplicate literal registered paste markers reject private Vim operations without changing expanded text", () => {
  const e = editor();
  e.handleInput(`\x1b[200~${"z".repeat(1001)}\x1b[201~`);
  const markerText = e.getText();
  e.insertTextAtCursor(` ${markerText}`);
  const before = e.getText();
  const expanded = e.getExpandedText();
  assert.throws(() => createVimEditorAdapter(e, INSTALLED_PI), /duplicate.*paste marker/i);
  assert.equal(e.getText(), before);
  assert.equal(e.getExpandedText(), expanded);
});

test("motion boundaries treat registered collapsed paste as one unit, not marker-shaped plain text", () => {
  const e = editor();
  e.setText("a");
  e.handleInput(`\x1b[200~${"z".repeat(1001)}\x1b[201~`);
  const end = e.getText().length;
  const adapter = createVimEditorAdapter(e, INSTALLED_PI);
  assert.deepEqual(adapter.motionBoundaries()[0], [0, 1, end]);
  adapter.move({ line: 0, col: 1 });
  assert.throws(() => adapter.move({ line: 0, col: 2 }), /boundary/i);
  const plain = editor();
  plain.setText("a[paste #1 1001 chars]b");
  assert.ok(createVimEditorAdapter(plain, INSTALLED_PI).motionBoundaries()[0]!.includes(2));
});

test("a complete insert session undoes in one unit without crossing an earlier edit", () => {
  const e = editor();
  e.setText("base");
  const adapter = createVimEditorAdapter(e, INSTALLED_PI);
  adapter.replace({ line: 0, col: 4 }, { line: 0, col: 4 }, "!");
  adapter.beginInsertSession();
  e.handleInput("a"); e.handleInput(" "); e.handleInput("b");
  e.handleInput("\x1b[200~é\n👩‍💻\x1b[201~");
  adapter.endInsertSession();
  assert.equal(e.getText(), "base!a bé\n👩‍💻");
  adapter.undo();
  assert.equal(e.getText(), "base!");
  adapter.undo();
  assert.equal(e.getText(), "base");
});

test("change operators followed immediately by Escape preserve deletion as one undo unit", () => {
  for (const keys of [["c", "w"], ["s"], ["S"]]) {
    const e = editor();
    e.setText("alpha beta");
    const adapter = createVimEditorAdapter(e, INSTALLED_PI);
    const operator = new VimOperatorEngine();
    let edit;
    for (const key of keys) edit = operator.input(key, e.getText(), { line: 0, col: 0 }, adapter.motionBoundaries())?.edit ?? edit;
    assert.ok(edit?.insert, keys.join(""));
    adapter.beginInsertSession();
    adapter.replace(edit.start, edit.end, edit.text);
    adapter.move(edit.cursor);
    adapter.markInsertAnchor();
    adapter.endInsertSession();
    assert.notEqual(e.getText(), "alpha beta");
    adapter.undo();
    assert.equal(e.getText(), "alpha beta", `${keys.join("")} must undo its deletion`);
    adapter.undo();
    assert.equal(e.getText(), "", "a second undo reaches the preexisting baseline");
  }
});

test("insert capture records only anchored semantic text, not edits elsewhere or paste markers", () => {
  const e = editor(); e.setText("ab");
  const adapter = createVimEditorAdapter(e, INSTALLED_PI);
  adapter.move({ line: 0, col: 1 }); adapter.beginInsertSession();
  e.handleInput("👩‍💻"); e.handleInput("é");
  assert.equal(adapter.endInsertSession(), "👩‍💻é");
  adapter.move({ line: 0, col: 0 }); adapter.beginInsertSession();
  adapter.replace({ line: 0, col: 1 }, { line: 0, col: 7 }, "x");
  assert.equal(adapter.endInsertSession(), undefined);
  adapter.beginInsertSession();
  assert.equal(adapter.endInsertSession(), undefined);
  const paste = editor();
  const guarded = createVimEditorAdapter(paste, INSTALLED_PI);
  guarded.beginInsertSession();
  paste.handleInput(`\x1b[200~${"z".repeat(1001)}\x1b[201~`);
  assert.equal(guarded.endInsertSession(), undefined);
  assert.equal(paste.getExpandedText(), "z".repeat(1001));
});

test("rejected duplicate marker closes insert session without touching undo, allowing a repaired retry", () => {
  const e = editor();
  e.handleInput(`\x1b[200~${"z".repeat(1001)}\x1b[201~`);
  const markerText = e.getText();
  const adapter = createVimEditorAdapter(e, INSTALLED_PI);
  adapter.beginInsertSession();
  e.insertTextAtCursor(markerText);
  const undo = (e as unknown as { undoStack: { stack: unknown[] } }).undoStack.stack.slice();
  assert.throws(() => adapter.endInsertSession(), /duplicate registered paste marker/i);
  assert.deepEqual((e as unknown as { undoStack: { stack: unknown[] } }).undoStack.stack, undo,
    "rejection must not group or rewrite undo snapshots");
  assert.equal(e.getText(), markerText + markerText);
  // Simulate the host repairing the invalid draft before private Vim operations resume.
  const state = (e as unknown as { state: { lines: string[]; cursorCol: number } }).state;
  state.lines = [markerText]; state.cursorCol = markerText.length;
  adapter.beginInsertSession();
  assert.equal(adapter.endInsertSession(), undefined);
  assert.deepEqual((e as unknown as { undoStack: { stack: unknown[] } }).undoStack.stack, undo);
});

test("insert session does not resurrect an undone pre-session snapshot", () => {
  const e = editor();
  e.setText("base");
  const adapter = createVimEditorAdapter(e, INSTALLED_PI);
  adapter.beginInsertSession();
  adapter.undo();
  assert.equal(e.getText(), "");
  e.handleInput("X"); e.handleInput(" ");
  adapter.endInsertSession();
  assert.equal(e.getText(), "X ");
  adapter.undo();
  assert.notEqual(e.getText(), "base", "Pi's replacement snapshots must not resurrect the old baseline");
});

test("empty insert session does not add an undo unit or lose paste registration", () => {
  const e = editor();
  e.handleInput(`\x1b[200~${"z".repeat(1001)}\x1b[201~`);
  const adapter = createVimEditorAdapter(e, INSTALLED_PI);
  adapter.beginInsertSession();
  adapter.endInsertSession();
  assert.equal(e.getExpandedText(), "z".repeat(1001));
  adapter.undo();
  assert.equal(e.getText(), "");
});

test("equal-text range replacement does not hide an earlier undo", () => {
  const e = editor();
  e.setText("abc");
  const adapter = createVimEditorAdapter(e, INSTALLED_PI);
  adapter.replace({ line: 0, col: 0 }, { line: 0, col: 1 }, "");
  assert.equal(e.getText(), "bc");
  adapter.replace({ line: 0, col: 0 }, { line: 0, col: 2 }, "bc");
  adapter.undo();
  assert.equal(e.getText(), "abc");
});

test("one range edit is one undo; history and collapsed paste registry survive", () => {
  const e = editor();
  e.addToHistory("earlier");
  e.handleInput(`\x1b[200~${"z".repeat(1001)}\x1b[201~`);
  e.insertTextAtCursor("👩‍💻\ntail");
  const before = e.getText();
  const expanded = e.getExpandedText();
  const adapter = createVimEditorAdapter(e, INSTALLED_PI);
  adapter.replace({ line: 1, col: 0 }, { line: 1, col: 4 }, "new");
  assert.equal(e.getText(), before.replace("tail", "new"));
  assert.equal(e.getExpandedText(), expanded.replace("tail", "new"));
  e.handleInput("\x1f");
  assert.equal(e.getText(), before);
  assert.equal(e.getExpandedText(), expanded);
  e.setText("");
  e.handleInput("\x1b[A");
  assert.equal(e.getText(), "earlier");
});

test("visual register reads reject registered paste markers without mutating the editor", () => {
  const e = editor();
  e.handleInput(`\x1b[200~${"z".repeat(1001)}\x1b[201~`);
  const markerText = e.getText();
  const adapter = createVimEditorAdapter(e, INSTALLED_PI);
  assert.throws(() => adapter.readRange({ line: 0, col: 0 }, { line: 0, col: markerText.length }), /paste marker/i);
  assert.equal(e.getText(), markerText);
  assert.equal(e.getExpandedText(), "z".repeat(1001));
  const plain = editor(); plain.setText("[paste #1 1001 chars]");
  assert.equal(createVimEditorAdapter(plain, INSTALLED_PI).readRange({ line: 0, col: 0 }, { line: 0, col: plain.getText().length }), plain.getText());
});

test("real Pi editor shifts tab-indented lines in both directions with one undo per edit", () => {
  for (const key of [">", "<"] as const) {
    const e = editor();
    // Pi's public setText normalizes tabs; seed the actual private editor state
    // to exercise the adapter's version-gated handling of legacy literal tabs.
    e.setText("    👩‍💻 alpha\nnext");
    (e as unknown as { state: { lines: string[] } }).state.lines[0] = "\t👩‍💻 alpha";
    const adapter = createVimEditorAdapter(e, INSTALLED_PI);
    const operator = new VimOperatorEngine();
    let result;
    for (const stroke of [key, key]) result = operator.input(stroke, e.getText(), { line: 0, col: 0 }, adapter.motionBoundaries());
    assert.ok(result?.edit, `${key}${key} must produce a real edit`);
    adapter.replace(result.edit.start, result.edit.end, result.edit.text);
    adapter.move(result.edit.cursor);
    assert.equal(e.getText(), key === ">" ? "  \t👩‍💻 alpha\nnext" : "👩‍💻 alpha\nnext");
    adapter.undo();
    assert.equal(e.getText(), "\t👩‍💻 alpha\nnext", `${key}${key} is one Pi undo unit`);
  }
});

test("tab-bearing replacement cannot duplicate a registered paste marker", () => {
  const e = editor();
  e.handleInput(`\x1b[200~${"z".repeat(1001)}\x1b[201~`);
  const original = e.getText();
  const expanded = e.getExpandedText();
  const adapter = createVimEditorAdapter(e, INSTALLED_PI);
  assert.throws(() => adapter.replace({ line: 0, col: 0 }, { line: 0, col: 0 }, `\t${original}`), /duplicate.*paste marker/i);
  assert.equal(e.getText(), original);
  assert.equal(e.getExpandedText(), expanded);
  adapter.replace({ line: 0, col: 0 }, { line: 0, col: 0 }, "\t👩‍💻");
  assert.equal(e.getText(), `\t👩‍💻${original}`);
  assert.equal(e.getExpandedText(), `\t👩‍💻${expanded}`);
  adapter.undo();
  assert.equal(e.getText(), original);
  assert.equal(e.getExpandedText(), expanded);
});

test("operator insertion and registered marker guards keep one undo snapshot", () => {
  const e = editor();
  e.setText("a\nb");
  const adapter = createVimEditorAdapter(e, INSTALLED_PI);
  adapter.replace({ line: 0, col: 1 }, { line: 0, col: 1 }, "👩‍💻\n");
  assert.equal(e.getText(), "a👩‍💻\n\nb");
  e.handleInput("\x1f");
  assert.equal(e.getText(), "a\nb");
  const paste = editor();
  paste.handleInput(`\x1b[200~${"z".repeat(1001)}\x1b[201~`);
  const end = paste.getText().length;
  assert.throws(() => createVimEditorAdapter(paste, INSTALLED_PI).replace(
    { line: 0, col: 0 }, { line: 0, col: end }, ""), /paste marker/i);
  assert.equal(paste.getExpandedText(), "z".repeat(1001));
});

test("selection survives fake cursor reset and retains surrounding color", () => {
  const e = editor();
  e.setText("abcd");
  createVimEditorAdapter(e, INSTALLED_PI).move({ line: 0, col: 1 });
  const frame = createVimEditorAdapter(e, INSTALLED_PI).renderSelection(20, { line: 0, col: 0 }, { line: 0, col: 4 });
  const row = frame.find((line) => line.includes("a")) ?? frame.join("");
  let reverse = false;
  const selected: string[] = [];
  for (const token of row.matchAll(/\x1b\[[0-9;]*m|[^\x1b]/g)) {
    const value = token[0];
    if (value.startsWith("\x1b[")) {
      for (const code of value.slice(2, -1).split(";").map(Number)) {
        if (code === 0 || code === 27) reverse = false;
        if (code === 7) reverse = true;
      }
    } else if ("abcd".includes(value)) selected.push(reverse ? value : `!${value}`);
  }
  assert.deepEqual(selected, ["a", "b", "c", "d"], "every visible cell must have effective reverse SGR");
});

test("truecolor channels do not change inverse state across selected and unselected cells", () => {
  const e = editor();
  e.setText("ab");
  const adapter = createVimEditorAdapter(e, INSTALLED_PI);
  const rows = e.render(20);
  rows[1] = rows[1]!.replace("ab", "a\x1b[38;2;7;0;27mb");
  const row = adapter.renderSelection(20, { line: 0, col: 0 }, { line: 0, col: 1 }, rows)[1]!;
  let inverse = false;
  let foreground = "";
  const cells: Array<[string, boolean, string]> = [];
  for (const token of row.matchAll(/\x1b\[[0-9;]*m|[^\x1b]/g)) {
    const value = token[0];
    if (value.startsWith("\x1b[")) {
      const codes = value.slice(2, -1).split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        if (codes[i] === 38 && codes[i + 1] === 2) { foreground = codes.slice(i + 2, i + 5).join(";"); i += 4; }
        else if (codes[i] === 0 || codes[i] === 27) inverse = false;
        else if (codes[i] === 7) inverse = true;
      }
    } else if (value === "a" || value === "b") cells.push([value, inverse, foreground]);
  }
  assert.deepEqual(cells, [["a", true, ""], ["b", false, "7;0;27"]]);
});

test("focused cursor marker survives highlighting while unfocused rows remain valid", () => {
  const e = editor();
  e.setText("abcd");
  const adapter = createVimEditorAdapter(e, INSTALLED_PI);
  adapter.move({ line: 0, col: 2 });
  e.focused = true;
  const source = e.render(20);
  assert.ok(source.some((row) => row.includes(CURSOR_MARKER)));
  const highlighted = adapter.renderSelection(20, { line: 0, col: 0 }, { line: 0, col: 4 }, source);
  assert.ok(highlighted.some((row) => row.includes(CURSOR_MARKER) && row.includes("\x1b[7m")));
  const unfocused = source.map((row) => row.replaceAll(CURSOR_MARKER, ""));
  assert.ok(adapter.renderSelection(20, { line: 0, col: 0 }, { line: 0, col: 4 }, unfocused).some((row) => row.includes("\x1b[7m")));
});

test("selection ending at the software cursor retains its inverse cell", () => {
  const e = editor();
  e.setText("abcd");
  const adapter = createVimEditorAdapter(e, INSTALLED_PI);
  adapter.move({ line: 0, col: 2 });
  e.focused = false;
  const row = adapter.renderSelection(20, { line: 0, col: 0 }, { line: 0, col: 2 }).find((line) => line.includes("a"))!;
  assert.ok(row.includes("\x1b[7m"), "selection must be visible");
  assert.doesNotMatch(row, /\x1b\[7m\x1b\[27m[^]*c/);
});

test("scrolled identical wraps paint exactly the selected visible cells, not earlier copies", () => {
  const e = editor();
  e.setText("a".repeat(80));
  const adapter = createVimEditorAdapter(e, INSTALLED_PI);
  adapter.move({ line: 0, col: 80 });
  const rows = adapter.renderSelection(6, { line: 0, col: 55 }, { line: 0, col: 67 });
  assert.equal((e as unknown as { scrollOffset: number }).scrollOffset, 9);
  assert.deepEqual(rows.slice(1, -1).map(selectedColumns), [
    [], [], [0, 1, 2, 3, 4], [0, 1, 2, 3, 4], [0, 1], [], [5],
  ], "last row contains Pi's inverse software cursor at the end of the last wrap");
  assert.ok(rows.every((row) => visibleWidth(row) === 6));
});

test("focused marker remains at its original visual column through selection", () => {
  const e = editor();
  e.setText("abcd");
  e.focused = true;
  const adapter = createVimEditorAdapter(e, INSTALLED_PI);
  adapter.move({ line: 0, col: 2 });
  const before = e.render(12);
  const after = adapter.renderSelection(12, { line: 0, col: 0 }, { line: 0, col: 3 }, before);
  assert.equal(paintedCells(after[1]!.split(CURSOR_MARKER)[0]!).length,
    paintedCells(before[1]!.split(CURSOR_MARKER)[0]!).length, "marker stays at the same terminal column");
  assert.deepEqual(paintedCells(after[1]!).slice(0, 4),
    "abcd".split("").map((char, index) => ({ char, inverse: index < 3 })));
  assert.ok(after.every((row) => visibleWidth(row) === 12));
});

test("empty logical line column zero keeps the focused cursor and paints neighboring rows", () => {
  const e = editor();
  e.setText("a\n\nb");
  e.focused = true;
  const adapter = createVimEditorAdapter(e, INSTALLED_PI);
  adapter.move({ line: 1, col: 0 });
  const rows = adapter.renderSelection(12, { line: 0, col: 0 }, { line: 2, col: 1 });
  assert.equal(rows[2]!.indexOf(CURSOR_MARKER), 0);
  assert.deepEqual(rows.slice(1, 4).map(selectedColumns), [[0], [0], [0]]);
  assert.ok(rows.every((row) => visibleWidth(row) === 12));
});

test("split paste marker paints its visible cells across scroll without selecting adjacent text", () => {
  const e = editor();
  e.setText("a".repeat(35));
  e.handleInput(`\x1b[200~${"z".repeat(1001)}\x1b[201~`);
  const pasteEnd = e.getText().length;
  e.insertTextAtCursor("TAIL");
  const adapter = createVimEditorAdapter(e, INSTALLED_PI);
  adapter.move({ line: 0, col: pasteEnd });
  const rows = adapter.renderSelection(8, { line: 0, col: 35 }, { line: 0, col: pasteEnd });
  assert.ok((e as unknown as { scrollOffset: number }).scrollOffset > 0);
  const internal = e as unknown as { scrollOffset: number; layoutText(width: number): Array<{ text: string; hasCursor: boolean; cursorPos?: number }> };
  const layout = internal.layoutText(7);
  let start = layout.slice(0, internal.scrollOffset).reduce((n, chunk) => n + chunk.text.length, 0);
  const painted = rows.slice(1, -1).map((row, index) => {
    const chunk = layout[internal.scrollOffset + index]!;
    const expected = [...chunk.text].flatMap((_, col) => start + col >= 35 && start + col < pasteEnd ? [col] : []);
    if (chunk.hasCursor && chunk.cursorPos !== undefined) expected.push(chunk.cursorPos);
    start += chunk.text.length;
    return { row, expected };
  });
  assert.ok(painted.some(({ row }) => paintedCells(row).some((cell) => cell.char === "[" && cell.inverse)));
  assert.ok(painted.some(({ row }) => paintedCells(row).some((cell) => cell.char === "]" && cell.inverse)));
  for (const { row, expected } of painted) assert.deepEqual(selectedColumns(row), expected,
    "marker cells and Pi's native cursor are the only inverse cells in each visible row");
  assert.ok(rows.every((row) => visibleWidth(row) === 8));
  assert.equal(e.getExpandedText(), "a".repeat(35) + "z".repeat(1001) + "TAIL");
});

test("installed-version mismatch fails closed without changing the rendered frame or editor state", () => {
  const e = editor();
  e.setText("abcd");
  e.focused = true;
  const frame = e.render(12);
  assert.throws(() => createVimEditorAdapter(e, "0.85.1"), /unsupported/i);
  assert.deepEqual(e.render(12), frame);
  assert.equal(e.getText(), "abcd");
  assert.deepEqual(e.getCursor(), { line: 0, col: 4 });
});

test("empty logical line accepts cursor column zero", () => {
  const e = editor();
  e.setText("a\n\nb");
  createVimEditorAdapter(e, INSTALLED_PI).move({ line: 1, col: 0 });
  assert.deepEqual(e.getCursor(), { line: 1, col: 0 });
});

test("visual highlight spans wraps and treats collapsed paste as one selection unit", () => {
  const e = editor();
  e.handleInput(`\x1b[200~${"z".repeat(1001)}\x1b[201~`);
  e.insertTextAtCursor(" following long words");
  const adapter = createVimEditorAdapter(e, INSTALLED_PI);
  const lines = adapter.renderSelection(12, { line: 0, col: 0 }, { line: 0, col: e.getText().length });
  assert.ok(lines.filter((line) => line.includes("\x1b[7m")).length > 1);
  assert.equal(e.getExpandedText(), "z".repeat(1001) + " following long words");
});
