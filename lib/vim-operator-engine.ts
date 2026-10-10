import { VimNormalEngine, type VimPosition } from "./vim-normal-engine.ts";
import type { VisualRange } from "./vim-visual-engine.ts";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const word = /[\p{L}\p{N}_]/u;
const space = /\s/u;
const OPERATORS = { d: "delete", c: "change", y: "yank", ">": "indent", "<": "dedent" } as const;
type Operator = keyof typeof OPERATORS;
interface Range { start: VimPosition; end: VimPosition }
export interface OperatorEdit extends Range { text: string; cursor: VimPosition; insert?: boolean }
interface RepeatChange { keys: string[]; register?: Register; inserted?: string; insertCommand?: string }
export interface OperatorResult { edit?: OperatorEdit; handled: true; repeat?: RepeatChange }
interface Register { text: string; linewise: boolean }

export class VimOperatorEngine {
  private pending: Operator | undefined;
  private digits = "";
  private operandCount = "";
  private object: "i" | "a" | undefined;
  private find: "f" | "F" | "t" | "T" | undefined;
  private shiftG = false;
  private register: Register | undefined;
  private sequence: string[] = [];
  private lastChange: RepeatChange | undefined;

  /** Only completed, successfully applied NORMAL edits become repeatable. */
  remember(result: OperatorResult): void {
    if (result.edit) this.lastChange = result.edit.insert ? undefined : result.repeat;
  }

  forgetRepeat(): void { this.lastChange = undefined; }

  rememberInsert(result: OperatorResult, inserted: string): void {
    if (result.repeat && inserted) this.lastChange = { ...result.repeat, inserted };
  }

  rememberLiteralInsert(command: string, inserted: string): void {
    if (["i", "a", "I", "A", "o", "O"].includes(command) && inserted)
      this.lastChange = { keys: [], insertCommand: command, inserted };
  }

  get repeatInsertion(): string | undefined { return this.lastChange?.inserted; }
  get repeatInsertCommand(): string | undefined { return this.lastChange?.insertCommand; }

  repeatAt(text: string, cursor: VimPosition, boundaries?: number[][]): OperatorResult | undefined {
    const change = this.lastChange;
    if (!change || change.insertCommand) return undefined;
    const replay = new VimOperatorEngine();
    replay.register = change.register && { ...change.register };
    let result: OperatorResult | null = null;
    for (const key of change.keys) result = replay.input(key, text, cursor, boundaries);
    return result?.edit ? result : undefined;
  }

  /** A count typed immediately before dot belongs to dot, not a subsequent operator. */
  takeRepeatCount(): number {
    const count = Math.min(100, Number(this.digits) || 1);
    this.cancel();
    return count;
  }

  get isPending(): boolean { return !!(this.pending || this.object || this.find); }

  // Caller validates registered paste markers before committing this register.
  visualRegister(text: string, linewise: boolean): void {
    if (text || linewise) this.register = { text, linewise };
  }

  visualEdit(key: string, text: string, range: VisualRange): OperatorResult {
    const lines = text.split("\n");
    const offset = (p: VimPosition) => lines.slice(0, p.line).reduce((n, line) => n + line.length + 1, 0) + p.col;
    if (key === "y" || (!range.linewise && range.start.line === range.end.line && range.start.col === range.end.col)) return { handled: true };
    if (key === "J") {
      if (range.start.line === range.end.line) return { handled: true };
      const joined = lines.slice(range.start.line, range.end.line + 1).map((line, index) =>
        index === 0 ? line.replace(/\s+$/u, "") : line.replace(/^\s+/u, "").replace(/\s+$/u, "")).join(" ");
      return { handled: true, edit: { start: { line: range.start.line, col: 0 }, end: { line: range.end.line, col: lines[range.end.line]!.length }, text: joined, cursor: { line: range.start.line, col: 0 } } };
    }
    if (key === "~" || key === "u" || key === "U" || key.startsWith("r")) {
      const selected = text.slice(offset(range.start), offset(range.end));
      const replacement = key.startsWith("r") ? [...segmenter.segment(selected)].map((unit) => unit.segment === "\n" ? "\n" : key.slice(1)).join("") :
        key === "u" ? selected.toLowerCase() : key === "U" ? selected.toUpperCase() :
        [...segmenter.segment(selected)].map((unit) => unit.segment === unit.segment.toUpperCase() ? unit.segment.toLowerCase() : unit.segment.toUpperCase()).join("");
      if (replacement === selected) return { handled: true };
      return { handled: true, edit: { start: range.start, end: range.end, text: replacement, cursor: range.start } };
    }
    if (key === "p") {
      const register = this.register;
      if (!register) return { handled: true };
      const start = range.start;
      let end = range.end;
      let replacement = register.text;
      if (range.linewise) {
        if (end.line + 1 < lines.length) {
          end = { line: end.line + 1, col: 0 };
          if (!register.linewise) replacement += "\n";
        } else replacement = replacement.replace(/\n$/, "");
      } else if (register.linewise) replacement = replacement.replace(/\n$/, "");
      return { handled: true, edit: { start, end, text: replacement, cursor: start } };
    }
    if (key === ">" || key === "<") {
      const first = range.start.line;
      const last = range.end.line;
      const replacement = lines.slice(first, last + 1).map((line) =>
        key === ">" ? "  " + line : line.replace(/^(?: {1,2}|\t)/, "")).join("\n");
      if (replacement === lines.slice(first, last + 1).join("\n")) return { handled: true };
      return { handled: true, edit: { start: { line: first, col: 0 }, end: { line: last, col: lines[last]!.length },
        text: replacement, cursor: { line: first, col: 0 } } };
    }
    if (key !== "d" && key !== "c") return { handled: true };
    let start = range.start;
    let end = range.end;
    let replacement = "";
    if (range.linewise) {
      if (end.line + 1 < lines.length) {
        end = { line: end.line + 1, col: 0 };
        if (key === "c") replacement = "\n";
      } else if (start.line > 0) {
        start = { line: start.line - 1, col: lines[start.line - 1]!.length };
        if (key === "c") replacement = "\n";
      }
    }
    return { handled: true, edit: { start, end, text: replacement,
      cursor: range.linewise ? { line: Math.min(range.start.line, (text.slice(0, offset(start)) + replacement + text.slice(offset(end))).split("\n").length - 1), col: 0 } : range.start,
      ...(key === "c" ? { insert: true } : {}) } };
  }

  cancel(): boolean {
    const pending = !!(this.pending || this.digits || this.object || this.find);
    this.pending = undefined; this.digits = ""; this.operandCount = "";
    this.object = undefined; this.find = undefined; this.shiftG = false;
    this.sequence = [];
    return pending;
  }

  input(key: string, text: string, cursor: VimPosition, boundaries?: number[][]): OperatorResult | null {
    const prior = this.sequence;
    const register = this.register && { ...this.register };
    const result = this.evaluate(key, text, cursor, boundaries);
    if (result?.edit && (prior.length || !this.isPending)) {
      // A finite command grammar, not a recording of arbitrary terminal input.
      const keys = [...prior, key];
      if (keys.length <= 12 && keys.every((part) => [...segmenter.segment(part)].length === 1) &&
          /^(?:[0-9]*[dc<>]?(?:[0-9]*[wbe$0^Gjk]|gg|[ia][wW"'`()\[\]{}<>]|[ftFT].)|[0-9]*[dy<>][0-9]*[dy<>]|[0-9]*[xJsSpP])$/u.test(keys.join(""))) {
        result.repeat = { keys, ...(key === "p" || key === "P" ? { register } : {}) };
      }
    }
    if (this.isPending || (!result?.edit && /^[1-9]$/.test(key) && prior.length < 12)) {
      this.sequence = [...prior, key];
    } else this.sequence = [];
    return result;
  }

  private evaluate(key: string, text: string, cursor: VimPosition, boundaries?: number[][]): OperatorResult | null {
    if (!this.pending && !this.find && !this.object && /^[0-9]$/.test(key) && (key !== "0" || !!this.digits)) {
      this.digits += key; return { handled: true };
    }
    if (!this.pending && key in OPERATORS) {
      this.pending = key as Operator;
      return { handled: true };
    }
    if (this.pending && !this.find && !this.object && /^[0-9]$/.test(key) && (key !== "0" || !!this.operandCount)) {
      this.operandCount += key; return { handled: true };
    }
    if (this.pending && (key === "i" || key === "a") && !this.object && !this.find) {
      this.object = key; return { handled: true };
    }
    if ((this.pending === ">" || this.pending === "<") && key === "g" && !this.shiftG) {
      this.shiftG = true; return { handled: true };
    }
    if (this.pending && (key === "f" || key === "F" || key === "t" || key === "T") && !this.object && !this.find) {
      this.find = key; return { handled: true };
    }
    let op = this.pending;
    const object = this.object;
    const find = this.find;
    const shiftG = this.shiftG;
    const explicitShift = !!(this.digits || this.operandCount);
    const count = Math.min(10000, (Number(this.digits) || 1) * (Number(this.operandCount) || 1));
    const lines = text.split("\n");
    const stops = boundaries ?? lines.map((line) => [...segmenter.segment(line)].map((part) => part.index).concat(line.length));
    const offset = (p: VimPosition) => lines.slice(0, p.line).reduce((n, line) => n + line.length + 1, 0) + p.col;
    const position = (n: number): VimPosition => {
      let line = 0;
      while (line < lines.length - 1 && n > lines[line]!.length) n -= lines[line++]!.length + 1;
      return { line, col: n };
    };
    const safe = (a: number, b: number): boolean => {
      for (let line = 0, base = 0; line < lines.length; base += lines[line++]!.length + 1) {
        const points = stops[line]!;
        for (let i = 0; i < points.length - 1; i++) {
          const from = base + points[i]!;
          const to = base + points[i + 1]!;
          if (to > from && [...segmenter.segment(text.slice(from, to))].length > 1 && a < to && b > from) return false;
        }
      }
      return true;
    };
    const edit = (a: number, b: number, replacement: string, linewise = false, insert = false): OperatorResult => {
      if (!safe(a, b) || (a === b && !replacement && op !== "y")) return { handled: true };
      if (op) {
        this.register = { text: text.slice(a, b), linewise };
        if (op === "y") return { handled: true };
      }
      return { handled: true, edit: { start: position(a), end: position(b), text: replacement,
        cursor: position(a), ...(insert || op === "c" ? { insert: true } : {}) } };
    };
    if (op) {
      this.cancel();
      if ((op === ">" || op === "<") && key === op && !find && !object) {
        const last = Math.min(lines.length - 1, cursor.line + count - 1);
        const start = offset({ line: cursor.line, col: 0 });
        const end = offset({ line: last, col: lines[last]!.length });
        const replacement = lines.slice(cursor.line, last + 1).map((line) =>
          op === ">" ? "  " + line : line.replace(/^(?: {1,2}|\t)/, "")).join("\n");
        if (replacement === lines.slice(cursor.line, last + 1).join("\n")) return { handled: true };
        return { handled: true, edit: { start: { line: cursor.line, col: 0 }, end: { line: last, col: lines[last]!.length },
          text: replacement, cursor: { line: cursor.line, col: 0 } } };
      }
      if (op === ">" || op === "<") {
        let target: VimPosition | undefined;
        if (shiftG && key === "g") target = { line: 0, col: 0 };
        else if (key === "j" || key === "k") target = { line: Math.max(0, Math.min(lines.length - 1, cursor.line + (key === "j" ? count : -count))), col: 0 };
        else if (key === "G") target = { line: explicitShift ? Math.min(lines.length - 1, count - 1) : lines.length - 1, col: 0 };
        else if (!shiftG && !find && ["w", "e", "b", "$", "0", "^"].includes(key)) {
          const motion = new VimNormalEngine().input(`${count === 1 ? "" : count}${key}`, text, cursor, stops);
          if (motion.handled) target = motion.cursor;
        } else if (find && [...segmenter.segment(key)].length === 1 && !key.includes("\n")) {
          const motion = new VimNormalEngine();
          motion.input(`${count === 1 ? "" : count}${find}`, text, cursor, stops);
          target = motion.input(key, text, cursor, stops).cursor;
        }
        if (!target || (target.line === cursor.line && target.col === cursor.col)) return { handled: true };
        const first = Math.min(cursor.line, target.line);
        // Characterwise motions ending at the next line's column zero exclude
        // that line; j/k/G/gg remain inclusive linewise shift motions.
        const exclusiveEnd = !shiftG && !["j", "k", "G"].includes(key) &&
          target.line > cursor.line && target.col === 0;
        const last = Math.max(cursor.line, target.line) - (exclusiveEnd ? 1 : 0);
        const original = lines.slice(first, last + 1).join("\n");
        const replacement = lines.slice(first, last + 1).map((line) =>
          op === ">" ? "  " + line : line.replace(/^(?: {1,2}|\t)/, "")).join("\n");
        if (replacement === original) return { handled: true };
        return { handled: true, edit: { start: { line: first, col: 0 }, end: { line: last, col: lines[last]!.length },
          text: replacement, cursor: { line: first, col: 0 } } };
      }
      if (key === op && !find && !object) {
        const last = Math.min(lines.length - 1, cursor.line + count - 1);
        const a = offset({ line: cursor.line, col: 0 });
        const b = last + 1 < lines.length ? offset({ line: last + 1, col: 0 }) : text.length;
        const lineText = lines.slice(cursor.line, last + 1).join("\n") + "\n";
        if (op === "y") {
          if (safe(a, b)) this.register = { text: lineText, linewise: true };
          return { handled: true };
        }
        const from = a === 0 || b < text.length ? a : a - 1;
        const result = edit(from, b, op === "c" && b < text.length ? "\n" :
          op === "c" && from !== a ? "\n" : "", true);
        if (result.edit) {
          this.register = { text: lineText, linewise: true };
          const remaining = text.slice(0, from) + result.edit.text + text.slice(b);
          result.edit.cursor = { line: Math.min(cursor.line, remaining.split("\n").length - 1), col: 0 };
        }
        return result;
      }
      let a = offset(cursor);
      let b: number | undefined;
      if (object) {
        const range = this.textObject(key, object, text, a, count);
        if (range) { a = range[0]; b = range[1]; }
      } else if (find) {
        if ([...segmenter.segment(key)].length === 1 && !key.includes("\n")) {
          const points = stops[cursor.line]!;
          let index = points.indexOf(cursor.col);
          const direction = find === "f" || find === "t" ? 1 : -1;
          for (let n = 0; n < count; n++) {
            let hit = -1;
            for (let i = index + direction; i >= 0 && i < points.length - 1; i += direction) {
              if (lines[cursor.line]!.slice(points[i], points[i + 1]) === key) { hit = i; break; }
            }
            if (hit < 0) return { handled: true };
            index = hit;
          }
          const target = offset({ line: cursor.line, col: points[index]! });
          const after = offset({ line: cursor.line, col: points[index + 1]! });
          b = direction > 0 ? (find === "t" ? target : after) : (find === "T" ? after : target);
        }
      } else if (key === "w" || key === "b" || key === "e" || key === "$" || key === "0") {
        if (key === "$") b = offset({ line: cursor.line, col: lines[cursor.line]!.length });
        else if (key === "0") b = offset({ line: cursor.line, col: 0 });
        else {
          const units = [...segmenter.segment(text)].map((p) => ({ at: p.index, char: p.segment }));
          let index = units.findIndex((p) => p.at === a);
          if (index < 0) return { handled: true };
          const kind = (char: string) => space.test(char) ? 0 : word.test(char) ? 1 : 2;
          for (let n = 0; n < count; n++) {
            if (key === "w") {
              const group = kind(units[index]!.char);
              if (group) while (index < units.length && kind(units[index]!.char) === group) index++;
              while (index < units.length && kind(units[index]!.char) === 0) index++;
            } else if (key === "b") {
              index = Math.max(0, index - 1);
              while (index > 0 && kind(units[index]!.char) === 0) index--;
              const group = kind(units[index]!.char);
              while (index > 0 && kind(units[index - 1]!.char) === group) index--;
            } else {
              if (index < units.length - 1) index++;
              while (index < units.length - 1 && kind(units[index]!.char) === 0) index++;
              const group = kind(units[index]!.char);
              while (index < units.length - 1 && kind(units[index + 1]!.char) === group) index++;
            }
          }
          b = index === units.length ? text.length : units[index]!.at + (key === "e" ? units[index]!.char.length : 0);
        }
      }
      if (b === undefined || b === a) return { handled: true };
      return edit(Math.min(a, b), Math.max(a, b), "");
    }
    if (key === "J") {
      this.cancel();
      const last = Math.min(lines.length - 1, cursor.line + Math.max(2, count) - 1);
      if (last === cursor.line) return { handled: true };
      const joined = lines.slice(cursor.line, last + 1).map((line, index) =>
        index === 0 ? line.replace(/\s+$/u, "") : line.replace(/^\s+/u, "").replace(/\s+$/u, "")).join(" ");
      return { handled: true, edit: { start: { line: cursor.line, col: 0 }, end: { line: last, col: lines[last]!.length },
        text: joined, cursor: { line: cursor.line, col: Math.min(lines[cursor.line]!.length, joined.length) } } };
    }
    if (key === "x" || key === "s" || key === "S") {
      this.cancel();
      if (key === "S") {
        const a = offset({ line: cursor.line, col: 0 });
        const b = offset({ line: cursor.line, col: lines[cursor.line]!.length });
        if (a === b) return { handled: true, edit: { start: cursor, end: cursor, text: "", cursor: { line: cursor.line, col: 0 }, insert: true } };
        op = "c";
        return edit(a, b, "", true, true);
      }
      const points = stops[cursor.line]!;
      const at = points.indexOf(cursor.col);
      if (at < 0 || at === points.length - 1) return { handled: true };
      const b = offset({ line: cursor.line, col: points[Math.min(points.length - 1, at + count)]! });
      op = key === "s" ? "c" : "d";
      const result = edit(offset(cursor), b, "", false, key === "s");
      return result;
    }
    if (key === "p" || key === "P") {
      this.cancel();
      const register = this.register;
      if (!register) return { handled: true };
      const a = register.linewise ? key === "P" ? offset({ line: cursor.line, col: 0 }) :
        cursor.line + 1 < lines.length ? offset({ line: cursor.line + 1, col: 0 }) : text.length :
        key === "P" ? offset(cursor) : offset({ line: cursor.line, col: stops[cursor.line]![Math.min(stops[cursor.line]!.length - 1, stops[cursor.line]!.indexOf(cursor.col) + 1)]! });
      const inserted = register.linewise && a === text.length && a !== 0 ?
        "\n" + register.text.slice(0, -1) : register.text;
      const result = edit(a, a, inserted);
      if (result.edit && register.linewise) result.edit.cursor = { line: cursor.line + (key === "p" ? 1 : 0), col: 0 };
      return result;
    }
    if (this.digits) this.cancel();
    return null;
  }

  private textObject(key: string, around: "i" | "a", text: string, at: number, count: number): [number, number] | undefined {
    if (key === "w" || key === "W") {
      const units = [...segmenter.segment(text)].map((p) => ({ start: p.index, end: p.index + p.segment.length, char: p.segment }));
      let index = units.findIndex((p) => p.start <= at && p.end > at);
      if (index < 0) return undefined;
      const kind = (char: string) => space.test(char) ? 0 : key === "W" ? 1 : word.test(char) ? 1 : 2;
      if (kind(units[index]!.char) === 0) {
        while (index < units.length - 1 && kind(units[index]!.char) === 0) index++;
      }
      let start = index;
      const group = kind(units[index]!.char);
      while (start > 0 && kind(units[start - 1]!.char) === group) start--;
      let end = index + 1;
      for (let n = 0; n < count; n++) {
        while (end < units.length && kind(units[end]!.char) === kind(units[end - 1]!.char)) end++;
        if (n + 1 < count) {
          while (end < units.length && kind(units[end]!.char) === 0) end++;
          if (end === units.length) return undefined;
          end++;
        }
      }
      if (around === "a") {
        if (end < units.length && kind(units[end]!.char) === 0) while (end < units.length && kind(units[end]!.char) === 0) end++;
        else while (start > 0 && kind(units[start - 1]!.char) === 0) start--;
      }
      return [units[start]!.start, units[end - 1]!.end];
    }
    const pairs: Record<string, [string, string]> = {
      '"': ['"', '"'], "'": ["'", "'"], "`": ["`", "`"], "(": ["(", ")"], ")": ["(", ")"],
      "[": ["[", "]"], "]": ["[", "]"], "{": ["{", "}"], "}": ["{", "}"], "<": ["<", ">"], ">": ["<", ">"],
    };
    const pair = pairs[key];
    if (!pair) return undefined;
    let left = at, right = at;
    if (pair[0] === pair[1]) {
      left = text.lastIndexOf(pair[0], at);
      if (left === at) left = text.lastIndexOf(pair[0], at - 1);
      right = text.indexOf(pair[1], at + (at === left ? 1 : 0));
    } else {
      let depth = 0;
      for (; left >= 0; left--) {
        if (text[left] === pair[1]) depth++;
        else if (text[left] === pair[0] && depth-- === 0) break;
      }
      depth = 0;
      right = left;
      for (; right < text.length; right++) {
        if (text[right] === pair[0]) depth++;
        else if (text[right] === pair[1] && --depth === 0) break;
      }
    }
    if (left < 0 || right < 0 || right >= text.length || left >= right) return undefined;
    return around === "a" ? [left, right + 1] : [left + 1, right];
  }
}
