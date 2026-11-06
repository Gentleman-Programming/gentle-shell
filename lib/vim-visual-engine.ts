import type { VimPosition } from "./vim-normal-engine.ts";

const MODES = { char: "char", line: "line" } as const;
type VisualMode = (typeof MODES)[keyof typeof MODES];
export interface VisualRange { start: VimPosition; end: VimPosition; linewise: boolean }

export class VimVisualEngine {
  private anchor: VimPosition | undefined;
  private mode: VisualMode = MODES.char;

  get active(): boolean { return this.anchor !== undefined; }
  get kind(): VisualMode { return this.mode; }
  start(mode: VisualMode, cursor: VimPosition): void { this.anchor = { ...cursor }; this.mode = mode; }
  cancel(): void { this.anchor = undefined; }
  /** Resolve without changing the anchor; the caller validates paste markers before selecting. */
  object(text: string, cursor: VimPosition, boundaries: number[][], around: "i" | "a", key: string): VisualRange | undefined {
    if (!this.active || this.mode !== MODES.char) return undefined;
    const lines = text.split("\n");
    const at = lines.slice(0, cursor.line).reduce((n, line) => n + line.length + 1, 0) + cursor.col;
    if (!boundaries[cursor.line]?.includes(cursor.col)) return undefined;
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let from: number, to: number;
    if (key === "w" || key === "W") {
      const units = [...segmenter.segment(text)].map((unit) => ({ from: unit.index, to: unit.index + unit.segment.length, value: unit.segment }));
      let index = units.findIndex((unit) => unit.from <= at && at < unit.to);
      if (index < 0) return undefined;
      const kind = (value: string) => /\s/u.test(value) ? 0 : key === "W" || /[\p{L}\p{N}_]/u.test(value) ? 1 : 2;
      while (index < units.length - 1 && kind(units[index]!.value) === 0) index++;
      const group = kind(units[index]!.value);
      if (group === 0) return undefined;
      let first = index, last = index + 1;
      while (first > 0 && kind(units[first - 1]!.value) === group) first--;
      while (last < units.length && kind(units[last]!.value) === group) last++;
      if (around === "a") {
        if (last < units.length && kind(units[last]!.value) === 0) {
          while (last < units.length && kind(units[last]!.value) === 0 && units[last]!.value !== "\n") last++;
        } else while (first > 0 && kind(units[first - 1]!.value) === 0 && units[first - 1]!.value !== "\n") first--;
      }
      from = units[first]!.from; to = units[last - 1]!.to;
    } else {
      const pairs: Record<string, readonly [string, string]> = {
        '"': ['"', '"'], "'": ["'", "'"], '`': ['`', '`'], '(': ['(', ')'], ')': ['(', ')'],
        '[': ['[', ']'], ']': ['[', ']'], '{': ['{', '}'], '}': ['{', '}'], '<': ['<', '>'], '>': ['<', '>'],
      };
      const pair = pairs[key];
      if (!pair) return undefined;
      let left = -1, right = -1;
      if (pair[0] === pair[1]) {
        const quotes: number[] = [];
        for (let i = 0; i < text.length; i++) if (text[i] === pair[0] && (i === 0 || text[i - 1] !== "\\")) quotes.push(i);
        for (let i = 0; i + 1 < quotes.length; i += 2) {
          if (quotes[i]! <= at && at <= quotes[i + 1]!) {
            left = quotes[i]!; right = quotes[i + 1]!; break;
          }
        }
      } else {
        let depth = 0;
        for (let i = at; i >= 0; i--) {
          if (text[i] === pair[1]) depth++;
          else if (text[i] === pair[0] && depth-- === 0) { left = i; break; }
        }
        if (left >= 0) {
          depth = 0;
          for (let i = left; i < text.length; i++) {
            if (text[i] === pair[0]) depth++;
            else if (text[i] === pair[1] && --depth === 0) { right = i; break; }
          }
        }
      }
      if (left < 0 || right <= left) return undefined;
      from = left + (around === "i" ? 1 : 0);
      to = right + (around === "a" ? 1 : 0);
    }
    if (from >= to) return undefined;
    const position = (offset: number): VimPosition => {
      let line = 0;
      while (line < lines.length - 1 && offset > lines[line]!.length) offset -= lines[line++]!.length + 1;
      return { line, col: offset };
    };
    const start = position(from), end = position(to);
    if (!boundaries[start.line]?.includes(start.col) || !boundaries[end.line]?.includes(end.col)) return undefined;
    return { start, end, linewise: false };
  }
  swap(cursor: VimPosition): VimPosition | undefined {
    if (!this.anchor) return undefined;
    const old = this.anchor;
    this.anchor = { ...cursor };
    return old;
  }
  range(text: string, cursor: VimPosition, boundaries: number[][]): VisualRange | undefined {
    const anchor = this.anchor;
    if (!anchor) return undefined;
    const lines = text.split("\n");
    const order = (a: VimPosition, b: VimPosition) => a.line - b.line || a.col - b.col;
    const first = order(anchor, cursor) <= 0 ? anchor : cursor;
    const last = order(anchor, cursor) <= 0 ? cursor : anchor;
    if (this.mode === MODES.line) return {
      start: { line: first.line, col: 0 }, end: { line: last.line, col: lines[last.line]!.length }, linewise: true,
    };
    const stops = boundaries[last.line];
    if (!stops) return undefined;
    const index = stops.indexOf(last.col);
    if (index < 0) return undefined;
    return { start: { ...first }, end: index === stops.length - 1 && last.line < lines.length - 1
      ? { line: last.line + 1, col: 0 } : { line: last.line, col: stops[Math.min(stops.length - 1, index + 1)]! }, linewise: false };
  }
}
