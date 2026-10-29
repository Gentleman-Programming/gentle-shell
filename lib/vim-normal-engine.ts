export interface VimPosition { line: number; col: number }
export interface VimMotion { cursor: VimPosition; insert?: string; handled: boolean }

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const word = /[\p{L}\p{N}_]/u;
const whitespace = /\s/u;
function kind(char: string): number { return whitespace.test(char) ? 0 : word.test(char) ? 1 : 2; }

export class VimNormalEngine {
  private digits = "";
  private awaitingG = false;
  private gLine: number | undefined;
  private preferred: number | undefined;
  private pendingFind: { direction: number; till: boolean; count: number } | undefined;
  private lastFind: { char: string; direction: number; till: boolean; target: VimPosition; landing: VimPosition } | undefined;

  reset(): void {
    this.digits = ""; this.awaitingG = false; this.gLine = undefined; this.preferred = undefined;
    this.pendingFind = undefined; this.lastFind = undefined;
  }

  cancelPendingFind(): boolean {
    if (!this.pendingFind) return false;
    this.pendingFind = undefined;
    this.digits = "";
    return true;
  }

  input(key: string, text: string, cursor: VimPosition, motionBoundaries?: number[][]): VimMotion {
    const lines = text.split("\n");
    const positions = motionBoundaries ?? lines.map((line) => [...segmenter.segment(line)].map((part) => part.index).concat(line.length));
    const firstNonWhitespace = (line: number): number => {
      const stops = positions[line]!;
      return stops.find((col, index) => index === stops.length - 1 || !whitespace.test(lines[line]!.slice(col, stops[index + 1]))) ?? 0;
    };
    const result = (line: number, col: number, insert?: string): VimMotion => ({
      cursor: { line, col }, handled: true, ...(insert === undefined ? {} : { insert }),
    });
    const find = this.pendingFind;
    if (find) {
      this.pendingFind = undefined;
      if ([...segmenter.segment(key)].length !== 1 || key.includes("\n")) return { cursor, handled: false };
      return this.findOnLine(key, find.direction, find.till, find.count, text, cursor, positions);
    }
    if (/^[1-9]$/.test(key) || /^[0-9]+[^0-9]$/.test(key)) {
      if (key.length === 1) { this.digits += key; return result(cursor.line, cursor.col); }
      this.digits = key.slice(0, -1);
      key = key.at(-1)!;
    } else if (key === "0" && this.digits) {
      this.digits += key;
      return result(cursor.line, cursor.col);
    }
    const count = Math.min(10000, Number(this.digits) || 1);
    const explicit = this.digits.length > 0;
    this.digits = "";
    if (this.awaitingG) {
      this.awaitingG = false;
      if (key === "g") {
        this.preferred = undefined;
        const line = this.gLine ?? 0;
        this.gLine = undefined;
        return result(Math.min(lines.length - 1, line), 0);
      }
      this.gLine = undefined;
    }
    if (key === "g") { this.awaitingG = true; this.gLine = explicit ? count - 1 : undefined; return result(cursor.line, cursor.col); }
    if (key === "f" || key === "F" || key === "t" || key === "T") {
      this.pendingFind = { direction: key === "f" || key === "t" ? 1 : -1, till: key === "t" || key === "T", count };
      return result(cursor.line, cursor.col);
    }
    if (key === ";" || key === ",") {
      if (!this.lastFind) return result(cursor.line, cursor.col);
      const { char, direction, till, target, landing } = this.lastFind;
      const motion = this.findOnLine(char, direction * (key === ";" ? 1 : -1), till, count, text, cursor, positions,
        till && cursor.line === landing.line && cursor.col === landing.col ? target : undefined);
      if (this.lastFind) this.lastFind.direction = direction;
      return motion;
    }
    const current = positions[cursor.line] ?? [0];
    const colIndex = Math.max(0, current.indexOf(cursor.col));
    if (key === "h" || key === "l" || key === "Space" || key === " ") {
      this.preferred = undefined;
      return result(cursor.line, current[Math.max(0, Math.min(current.length - 1, colIndex + (key === "h" ? -count : count)))]!);
    }
    if (key === "j" || key === "k") {
      this.preferred ??= colIndex;
      const line = Math.max(0, Math.min(lines.length - 1, cursor.line + (key === "j" ? count : -count)));
      return result(line, positions[line]![Math.min(this.preferred, positions[line]!.length - 1)]!);
    }
    this.preferred = undefined;
    if (key === "0") return result(cursor.line, 0);
    if (key === "^") return result(cursor.line, firstNonWhitespace(cursor.line));
    if (key === "$" || key === "A") return result(cursor.line, lines[cursor.line]!.length, key === "A" ? "" : undefined);
    if (key === "G") return result(Math.min(lines.length - 1, explicit ? count - 1 : lines.length - 1), 0);
    if (key === "i") return result(cursor.line, cursor.col, "");
    if (key === "I") return result(cursor.line, firstNonWhitespace(cursor.line), "");
    if (key === "a") return result(cursor.line, current[Math.min(current.length - 1, colIndex + 1)]!, "");
    if (key === "o") return result(cursor.line, lines[cursor.line]!.length, "\n");
    if (key === "O") return result(cursor.line, 0, "\n");
    if (key === "w" || key === "e" || key === "b") {
      const units = lines.flatMap((line, index) => [...segmenter.segment(line)].map((part) => ({ line: index, col: part.index, char: part.segment })).concat(
        index < lines.length - 1 ? [{ line: index, col: line.length, char: "\n" }] : []));
      if (!units.length) return result(cursor.line, cursor.col);
      let at = units.findIndex((p) => p.line === cursor.line && p.col === cursor.col);
      if (at < 0) at = units.length;
      for (let n = 0; n < count; n++) {
        if (key === "w") {
          const currentKind = kind(units[Math.min(at, units.length - 1)]!.char);
          if (currentKind !== 0) while (at < units.length && kind(units[at]!.char) === currentKind) at++;
          while (at < units.length && kind(units[at]!.char) === 0) at++;
        } else if (key === "e") {
          if (at < units.length - 1) at++;
          while (at < units.length - 1 && kind(units[at]!.char) === 0) at++;
          const group = kind(units[Math.min(at, units.length - 1)]!.char);
          while (at < units.length - 1 && kind(units[at + 1]!.char) === group) at++;
        } else {
          at = Math.max(0, at - 1);
          while (at > 0 && kind(units[at]!.char) === 0) at--;
          const group = kind(units[at]!.char);
          while (at > 0 && kind(units[at - 1]!.char) === group) at--;
        }
      }
      const target = units[Math.min(at, units.length - 1)]!;
      return result(target.line, target.col);
    }
    return { cursor, handled: false };
  }

  private findOnLine(char: string, direction: number, till: boolean, count: number, text: string,
    cursor: VimPosition, positions: number[][], skip?: VimPosition): VimMotion {
    const line = text.split("\n")[cursor.line];
    const stops = positions[cursor.line];
    if (line === undefined || !stops) return { cursor, handled: true };
    let at = stops.indexOf(cursor.col);
    if (at < 0) return { cursor, handled: true };
    // Search only complete motion units: registered paste placeholders are
    // atomic even if the target occurs inside their displayed marker.
    for (let n = 0; n < count; n++) {
      let found = -1;
      for (let i = at + direction; i >= 0 && i < stops.length - 1; i += direction) {
        if (skip?.line === cursor.line && skip.col === stops[i]) continue;
        if (line.slice(stops[i], stops[i + 1]) === char) { found = i; break; }
      }
      if (found < 0) return { cursor, handled: true };
      at = found;
      skip = undefined;
    }
    const col = stops[Math.max(0, Math.min(stops.length - 1, at - (till ? direction : 0)))]!;
    const landing = { line: cursor.line, col };
    this.preferred = undefined;
    this.lastFind = { char, direction, till, target: { line: cursor.line, col: stops[at]! }, landing };
    return { cursor: landing, handled: true };
  }
}
