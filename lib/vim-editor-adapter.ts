import { CURSOR_MARKER, Editor, visibleWidth } from "@earendil-works/pi-tui";
import { createRequire } from "node:module";

// Private shape pinned to @earendil-works/pi-tui 0.85.1. Never silently adapt
// another build: the editor's undo snapshot also owns the paste registry.
interface Position { line: number; col: number }
interface State { lines: string[]; cursorLine: number; cursorCol: number }
interface Snapshot { state: State; pastes: Map<number, string>; pasteCounter: number }
interface Stack { stack: Snapshot[]; length: number; push(snapshot: Snapshot): void; pop(): Snapshot | undefined }
interface InsertSession { prefix: Snapshot[]; before: Snapshot; text: string; anchor: number }
const insertSessions = new WeakMap<object, InsertSession>();
interface LayoutLine { text: string; hasCursor: boolean; cursorPos?: number }
interface PrivateEditor {
  state: State;
  getText(): string;
  getCursor(): Position;
  onChange?: (text: string) => void;
  pastes: Map<number, string>;
  pasteCounter: number;
  undoStack: Stack;
  history: string[];
  historyIndex: number;
  historyDraft: State | null;
  lastAction: string | null;
  preferredVisualCol: number | null;
  snappedFromCursorCol: number | null;
  scrollOffset: number;
  renderedVisibleLineCount: number;
  paddingX: number;
  layoutText(width: number): LayoutLine[];
  render(width: number): string[];
  lastWidth: number;
  pushUndoSnapshot(): void;
  undo(): void;
  setCursorCol(col: number): void;
  autocompleteState: unknown;
  cancelAutocomplete(): void;
  exitHistoryBrowsing(): void;
}

const SUPPORTED_VERSIONS = new Set(["0.85.1", "0.87.1"]);
const importedTuiMetadata: unknown = createRequire(import.meta.url)("@earendil-works/pi-tui/package.json");
const IMPORTED_TUI_VERSION = typeof importedTuiMetadata === "object" && importedTuiMetadata !== null &&
  "version" in importedTuiMetadata ? importedTuiMetadata.version : undefined;

// The caller supplies the Editor constructor from the same Pi/TUI package pair
// as the version metadata. An arbitrary object with matching fields is not an editor.
function hasEditorIdentity(value: unknown, version: string, editorClass: typeof Editor, verifiedVersion?: string): boolean {
  if (!SUPPORTED_VERSIONS.has(version) || typeof value !== "object" || value === null ||
      (verifiedVersion !== undefined ? version !== verifiedVersion :
        editorClass === Editor ? version !== IMPORTED_TUI_VERSION : version !== "0.87.1") || !(value instanceof editorClass)) return false;
  let prototype: unknown = Object.getPrototypeOf(value);
  for (let depth = 0; depth < 3; depth++) {
    if (prototype === editorClass.prototype) return true;
    if (typeof prototype !== "object" || prototype === null || !Object.hasOwn(prototype, "constructor")) return false;
    prototype = Object.getPrototypeOf(prototype);
  }
  return false;
}
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const marker = /\[paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?\]/g;

// Only CSI SGR and Pi's own zero-width cursor marker are expected in editor
// text. Unknown escapes leave the unmodified frame intact (fail closed).
function highlightRenderedRow(row: string, chunk: LayoutLine, left: number, right: number, padding: number): string | undefined {
  const cursor = chunk.hasCursor ? chunk.cursorPos : undefined;
  const tokens = row.match(/\x1b\[[0-9;]*m|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)|[^\x1b]/g);
  if (!tokens || tokens.join("") !== row) return undefined;
  let plain = "";
  for (const token of tokens) if (!token.startsWith("\x1b")) plain += token;
  const before = " ".repeat(padding);
  if (!plain.startsWith(before + chunk.text)) return undefined;
  // Pi's fake cursor inserts one space only when it sits at the end.
  const expected = before + chunk.text + (cursor === chunk.text.length ? " " : "");
  if (!plain.startsWith(expected)) return undefined;
  let result = "";
  let col = 0;
  let selected = false;
  let inverse = false;
  let nativeInverse = false;
  for (const token of tokens) {
    if (token.startsWith("\x1b[")) {
      const codes = token.slice(2, -1).split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if ((code === 38 || code === 48 || code === 58) && codes[i + 1] === 2 && i + 4 < codes.length) i += 4;
        else if ((code === 38 || code === 48 || code === 58) && codes[i + 1] === 5 && i + 2 < codes.length) i += 2;
        else if (code === 0 || code === 27) nativeInverse = inverse = false;
        else if (code === 7) nativeInverse = inverse = true;
      }
      result += token;
      if (selected && !inverse) { result += "\x1b[7m"; inverse = true; }
    } else if (token.startsWith("\x1b")) {
      if (token !== CURSOR_MARKER) return undefined;
      result += token;
    } else {
      const local = col - padding;
      const shouldSelect = local >= left && local < right && local < chunk.text.length;
      if (shouldSelect !== selected) {
        // SGR 27 changes only reverse video; keep foreground/background intact.
        if (shouldSelect || !nativeInverse && inverse) result += shouldSelect ? "\x1b[7m" : "\x1b[27m";
        selected = shouldSelect;
        inverse = shouldSelect || nativeInverse;
      }
      result += token;
      col++;
    }
  }
  if (selected && !nativeInverse) result += "\x1b[27m";
  return result;
}

function boundaries(line: string, pastes: Map<number, string>): number[] {
  const units = [...segmenter.segment(line)].map((part) => part.index);
  for (const match of line.matchAll(marker)) {
    if (!pastes.has(Number(match[1]))) continue;
    const start = match.index;
    const end = start + match[0].length;
    for (let i = units.length - 1; i >= 0; i--) {
      if (units[i]! > start && units[i]! < end) units.splice(i, 1);
    }
  }
  return [...units, line.length];
}

function assertUniquePastes(editor: PrivateEditor): void {
  const registered = new Set<number>();
  for (const match of editor.getText().matchAll(marker)) {
    const id = Number(match[1]);
    if (!editor.pastes.has(id)) continue;
    if (registered.has(id)) throw new Error("Duplicate registered paste marker: private Vim editing is unsafe");
    registered.add(id);
  }
}

function assertPosition(editor: PrivateEditor, pos: Position): void {
  assertUniquePastes(editor);
  const line = editor.state.lines[pos.line];
  if (line === undefined || !Number.isInteger(pos.col) || !boundaries(line, editor.pastes).includes(pos.col)) {
    throw new Error("Cursor must be on a valid grapheme or paste boundary");
  }
}

export function createVimEditorAdapter(value: unknown, version: string, editorClass: typeof Editor = Editor, verifiedVersion?: string) {
  if (!hasEditorIdentity(value, version, editorClass, verifiedVersion)) throw new Error("Unsupported Pi editor layout/version");
  const editor = value as unknown as PrivateEditor;
  const s = editor.state;
  if (!s || !Array.isArray(s.lines) || s.lines.length === 0 || !s.lines.every((line) => typeof line === "string") ||
      !Number.isInteger(s.cursorLine) || !Number.isInteger(s.cursorCol) || !(editor.pastes instanceof Map) ||
      !Number.isInteger(editor.pasteCounter) || !Array.isArray(editor.history) ||
      typeof editor.undoStack?.push !== "function" || typeof editor.undoStack?.pop !== "function" ||
      !Array.isArray(editor.undoStack.stack) || editor.undoStack.length !== editor.undoStack.stack.length ||
      typeof editor.pushUndoSnapshot !== "function" || typeof editor.undo !== "function" || typeof editor.setCursorCol !== "function" ||
      typeof editor.cancelAutocomplete !== "function" || typeof editor.exitHistoryBrowsing !== "function" ||
      typeof editor.layoutText !== "function" || typeof editor.render !== "function" ||
      !Number.isInteger(editor.paddingX) || editor.paddingX < 0) {
    throw new Error("Unsupported Pi editor layout/version");
  }
  assertPosition(editor, { line: s.cursorLine, col: s.cursorCol });
  return {
    dismissAutocomplete(): void { editor.cancelAutocomplete(); },
    undo(): void { assertUniquePastes(editor); editor.undo(); },
    beginInsertSession(): void {
      assertUniquePastes(editor);
      if (insertSessions.has(editor)) throw new Error("Insert session already active");
      const cursor = editor.getCursor();
      const anchor = editor.state.lines.slice(0, cursor.line).reduce((n, line) => n + line.length + 1, 0) + cursor.col;
      insertSessions.set(editor, { prefix: editor.undoStack.stack.slice(), anchor,
        before: structuredClone({ state: editor.state, pastes: editor.pastes, pasteCounter: editor.pasteCounter }), text: editor.getText() });
    },
    markInsertAnchor(): void {
      assertUniquePastes(editor);
      const session = insertSessions.get(editor);
      if (!session) return;
      const cursor = editor.getCursor();
      session.anchor = editor.state.lines.slice(0, cursor.line).reduce((n, line) => n + line.length + 1, 0) + cursor.col;
      session.text = editor.getText();
    },
    endInsertSession(): string | undefined {
      const session = insertSessions.get(editor);
      insertSessions.delete(editor);
      assertUniquePastes(editor);
      if (!session) return;
      const stack = editor.undoStack;
      // Submission clears Pi's stack. Never resurrect a pre-submit snapshot.
      const depth = session.prefix.length;
      if (stack.length < depth || stack.length !== stack.stack.length ||
          session.prefix.some((snapshot, index) => stack.stack[index] !== snapshot)) return;
      const after = editor.getText();
      const inserted = after.startsWith(session.text.slice(0, session.anchor)) &&
        after.endsWith(session.text.slice(session.anchor)) ? after.slice(session.anchor, after.length - (session.text.length - session.anchor)) : undefined;
      if (after === session.before.state.lines.join("\n") && editor.pasteCounter === session.before.pasteCounter) {
        stack.stack.splice(depth);
        editor.lastAction = null;
        return;
      }
      // A mutation without a Pi snapshot is not an editor-owned insert session.
      if (stack.length === depth) return;
      stack.stack.splice(depth);
      stack.push(session.before);
      editor.lastAction = null;
      // A repeat can only carry an insertion at its original anchor. Reject
      // collapsed paste additions and edits to pre-existing text, even if Pi
      // successfully grouped the original session into one undo snapshot.
      return inserted && editor.pasteCounter === session.before.pasteCounter &&
        ![...inserted.matchAll(marker)].some((match) => editor.pastes.has(Number(match[1]))) ? inserted : undefined;
    },
    motionBoundaries(): number[][] {
      assertUniquePastes(editor);
      return editor.state.lines.map((line) => boundaries(line, editor.pastes));
    },
    move(pos: Position): void {
      assertPosition(editor, pos);
      editor.state.cursorLine = pos.line;
      editor.setCursorCol(pos.col);
      editor.lastAction = null;
      if (editor.autocompleteState) editor.cancelAutocomplete();
    },
    moveByGraphemes(delta: number): void {
      if (!Number.isInteger(delta)) throw new Error("Invalid motion");
      const positions = editor.state.lines.flatMap((line, index) =>
        boundaries(line, editor.pastes).map((col) => ({ line: index, col })));
      const current = editor.getCursor();
      const at = positions.findIndex((p) => p.line === current.line && p.col === current.col);
      if (at < 0) throw new Error("Invalid cursor boundary");
      const target = positions[Math.max(0, Math.min(positions.length - 1, at + delta))]!;
      this.move(target);
    },
    readRange(start: Position, end: Position): string {
      assertPosition(editor, start);
      assertPosition(editor, end);
      const offset = (p: Position) => editor.state.lines.slice(0, p.line).reduce((n, line) => n + line.length + 1, 0) + p.col;
      const a = offset(start), b = offset(end);
      if (b < a) throw new Error("Invalid selection range");
      const source = editor.getText();
      for (const match of source.matchAll(marker)) {
        if (editor.pastes.has(Number(match[1])) && a < match.index + match[0].length && b > match.index)
          throw new Error("Selection cannot edit collapsed paste marker");
      }
      return source.slice(a, b);
    },
    replace(start: Position, end: Position, text: string): void {
      assertPosition(editor, start);
      assertPosition(editor, end);
      const source = editor.getText();
      const offset = (p: Position) => editor.state.lines.slice(0, p.line).reduce((n, line) => n + line.length + 1, 0) + p.col;
      const a = offset(start);
      const b = offset(end);
      if (b < a || (b === a && !text) || text.includes("\r")) throw new Error("Invalid operator range or replacement");
      // No registry surgery: a range intersecting a collapsed paste is unsafe.
      for (const match of source.matchAll(marker)) {
        if (editor.pastes.has(Number(match[1])) && a < match.index + match[0].length && b > match.index) {
          throw new Error("Operator cannot edit collapsed paste marker");
        }
      }
      const next = source.slice(0, a) + text + source.slice(b);
      const registered = new Set<number>();
      for (const match of next.matchAll(marker)) {
        const id = Number(match[1]);
        if (!editor.pastes.has(id)) continue;
        if (registered.has(id)) throw new Error("Duplicate registered paste marker: private Vim editing is unsafe");
        registered.add(id);
      }
      if (next === source) return;
      const lines = next.split("\n");
      const prefix = next.slice(0, a + text.length).split("\n");
      editor.cancelAutocomplete();
      editor.exitHistoryBrowsing();
      editor.pushUndoSnapshot();
      editor.state.lines = lines;
      editor.state.cursorLine = prefix.length - 1;
      editor.setCursorCol(prefix.at(-1)!.length);
      editor.lastAction = null;
      editor.scrollOffset = 0;
      editor.onChange?.(next);
    },
    renderSelection(width: number, start: Position, end: Position, rendered?: string[]): string[] {
      assertPosition(editor, start);
      assertPosition(editor, end);
      if (!Number.isInteger(width) || width < 1) throw new Error("Invalid render width");
      const offset = (pos: Position) => editor.state.lines.slice(0, pos.line)
        .reduce((n, line) => n + line.length + 1, 0) + pos.col;
      const from = offset(start);
      const to = offset(end);
      if (from === to) return rendered ?? editor.render(width);
      const selectionFrom = Math.min(from, to);
      const selectionTo = Math.max(from, to);
      // Observe Pi's completed render; never replace its layout method or
      // reconstruct its cursor, borders, autocomplete, or padded row geometry.
      const rows = rendered ?? editor.render(width);
      const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
      const padding = Math.min(editor.paddingX, maxPadding);
      const layoutWidth = Math.max(1, width - padding * 2 - (padding ? 0 : 1));
      if (editor.lastWidth !== layoutWidth || !Number.isInteger(editor.scrollOffset) || editor.scrollOffset < 0) return rows;
      const layout = editor.layoutText(layoutWidth);
      if (!Number.isInteger(editor.renderedVisibleLineCount) || editor.renderedVisibleLineCount < 1 ||
          editor.renderedVisibleLineCount + 2 > rows.length) return rows;
      const visible = layout.slice(editor.scrollOffset, editor.scrollOffset + editor.renderedVisibleLineCount);
      if (visible.length !== editor.renderedVisibleLineCount) return rows;
      let logicalLine = 0;
      let searchFrom = 0;
      // Advance through hidden wraps before mapping visible chunks.
      for (const hidden of layout.slice(0, editor.scrollOffset)) {
        if (typeof hidden.text !== "string") return rows;
        let index = editor.state.lines[logicalLine]?.indexOf(hidden.text, searchFrom) ?? -1;
        while (index < 0 && logicalLine + 1 < editor.state.lines.length) {
          logicalLine++;
          searchFrom = 0;
          index = editor.state.lines[logicalLine]!.indexOf(hidden.text, searchFrom);
        }
        if (index < 0) return rows;
        searchFrom = index + hidden.text.length;
      }
      const replacements: Array<[number, string]> = [];
      for (let row = 0; row < visible.length; row++) {
        const chunk = visible[row]!;
        if (typeof chunk.text !== "string" || typeof chunk.hasCursor !== "boolean" ||
            (chunk.hasCursor && (!Number.isInteger(chunk.cursorPos) || chunk.cursorPos! < 0 || chunk.cursorPos! > chunk.text.length))) return rows;
        let index = editor.state.lines[logicalLine]?.indexOf(chunk.text, searchFrom) ?? -1;
        while (index < 0 && logicalLine + 1 < editor.state.lines.length) {
          logicalLine++;
          searchFrom = 0;
          index = editor.state.lines[logicalLine]!.indexOf(chunk.text, searchFrom);
        }
        if (index < 0) return rows;
        searchFrom = index + chunk.text.length;
        const chunkStart = offset({ line: logicalLine, col: index });
        const left = Math.max(0, Math.min(chunk.text.length, selectionFrom - chunkStart));
        const right = Math.max(0, Math.min(chunk.text.length, selectionTo - chunkStart));
        if (right <= left) continue;
        const original = rows[row + 1]!;
        const prefix = " ".repeat(padding);
        if (!original.startsWith(prefix)) return rows;
        const result = highlightRenderedRow(original, chunk, left, right, padding);
        if (result === undefined || visibleWidth(result) !== visibleWidth(original)) return rows;
        replacements.push([row + 1, result]);
      }
      const result = rows.slice();
      for (const [index, replacement] of replacements) result[index] = replacement;
      return result;
    },
  };
}
