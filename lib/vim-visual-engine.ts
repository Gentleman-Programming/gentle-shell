import type { VimPosition } from "./vim-normal-engine.ts";

const MODES = { char: "char", line: "line", block: "block" } as const;
type VisualMode = (typeof MODES)[keyof typeof MODES];
export interface VisualRange { start: VimPosition; end: VimPosition; linewise: boolean; block?: boolean }

/** Rows and inclusive columns of a blockwise range (range() orders them; end.col is exclusive). */
export function blockBounds(range: VisualRange): { first: number; last: number; minCol: number; maxCol: number } {
  return { first: range.start.line, last: range.end.line, minCol: range.start.col, maxCol: range.end.col - 1 };
}

/** The rectangle's cells per row, as the yank register text. */
export function blockMatrix(text: string, range: VisualRange): string {
  const { first, last, minCol, maxCol } = blockBounds(range);
  return text.split("\n").slice(first, last + 1).map((line) => blockCells(line, minCol, maxCol)[1]).join("\n");
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * A row split around the block's columns: [left, mid, right]. Whole grapheme
 * clusters only: a cluster belongs to the block when it starts inside it, so an
 * emoji or a combining mark is never cut in half on rows the caller did not
 * validate.
 */
export function blockCells(line: string, minCol: number, maxCol: number): [string, string, string] {
  const parts: [string, string, string] = ["", "", ""];
  for (const { segment, index } of graphemes.segment(line)) parts[index < minCol ? 0 : index <= maxCol ? 1 : 2] += segment;
  return parts;
}

/** Byte offset of a position in `text`. */
export function offsetAt(text: string, pos: VimPosition): number {
  return text.split("\n").slice(0, pos.line).reduce((n, line) => n + line.length + 1, 0) + pos.col;
}

/** Position of a byte offset in `text`. */
export function positionAt(text: string, offset: number): VimPosition {
  const lines = text.split("\n");
  let line = 0;
  while (line < lines.length - 1 && offset > lines[line]!.length) offset -= lines[line++]!.length + 1;
  return { line, col: offset };
}

/** Pairs the object machinery understands; either delimiter names the object. */
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"], ['"', '"'], ["'", "'"], ["`", "`"],
];
const PAIR_BY_KEY = new Map(PAIRS.flatMap((pair) => [[pair[0], pair], [pair[1], pair]] as const));

type Block = [number, number];

/** Quote blocks in order: unescaped quotes paired by parity. */
function quoteBlocks(text: string, quote: string): Block[] {
  const quotes: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] === quote && text[i - 1] !== "\\") quotes.push(i);
  const blocks: Block[] = [];
  for (let i = 0; i + 1 < quotes.length; i += 2) blocks.push([quotes[i]!, quotes[i + 1]!]);
  return blocks;
}

/** Offset of the delimiter closing the one opened at `open`, if any. */
function closeOf(text: string, open: number, pair: readonly [string, string]): number | undefined {
  for (let i = open, depth = 0; i < text.length; i++) {
    if (text[i] === pair[0]) depth++;
    else if (text[i] === pair[1] && --depth === 0) return i;
  }
  return undefined;
}

/** The pair block that contains `at`, delimiters included. */
function enclosingPair(text: string, at: number, pair: readonly [string, string]): Block | undefined {
  if (pair[0] === pair[1]) return quoteBlocks(text, pair[0]).find(([open, close]) => open <= at && at <= close);
  // The closer under the cursor belongs to this pair: it is never a nested one.
  for (let i = at, depth = 0; i >= 0; i--) {
    if (text[i] === pair[1] && i !== at) depth++;
    else if (text[i] === pair[0] && depth-- === 0) {
      const close = closeOf(text, i, pair);
      return close !== undefined && close >= at ? [i, close] : undefined;
    }
  }
  return undefined;
}

/**
 * Nearest complete pair block in a direction from `at`, delimiters included:
 * forward, the next one opening after `at`; backward, the last one closing
 * before it.
 */
export function seekPair(text: string, at: number, pair: readonly [string, string], direction: 1 | -1): Block | undefined {
  if (pair[0] === pair[1]) {
    const blocks = quoteBlocks(text, pair[0]);
    return direction === 1 ? blocks.find(([open]) => open > at) : blocks.findLast(([, close]) => close < at);
  }
  for (let i = at + direction; i >= 0 && i < text.length; i += direction) {
    if (text[i] !== pair[0]) continue;
    const close = closeOf(text, i, pair);
    if (close !== undefined && (direction === 1 || close < at)) return [i, close];
  }
  return undefined;
}

/**
 * The block an object key names. An explicit `seek` (the n/l prefixes) takes
 * the next/last block even inside one; without it, the block around `at`,
 * else the next one (outside a block, `vi(` selects the next one).
 */
export function pairBlock(text: string, at: number, key: string, seek?: 1 | -1): Block | undefined {
  const pair = PAIR_BY_KEY.get(key);
  if (!pair) return undefined;
  if (seek) return seekPair(text, at, pair, seek);
  return enclosingPair(text, at, pair) ?? seekPair(text, at, pair, 1);
}

/** Nearest pair block of any type in a direction: the [ and ] motions. */
export function nearestBlock(text: string, at: number, direction: 1 | -1): Block | undefined {
  let best: Block | undefined;
  for (const pair of PAIRS) {
    const block = seekPair(text, at, pair, direction);
    if (block && (!best || Math.abs(block[0] - at) < Math.abs(best[0] - at))) best = block;
  }
  return best;
}

export class VimVisualEngine {
  private anchor: VimPosition | undefined;
  private mode: VisualMode = MODES.char;

  get active(): boolean { return this.anchor !== undefined; }
  get kind(): VisualMode { return this.mode; }
  start(mode: VisualMode, cursor: VimPosition): void { this.anchor = { ...cursor }; this.mode = mode; }
  cancel(): void { this.anchor = undefined; }
  /** Resolve without changing the anchor; the caller validates paste markers before selecting. */
  object(text: string, cursor: VimPosition, boundaries: number[][], around: "i" | "a", key: string, seek?: 1 | -1): VisualRange | undefined {
    if (!this.active || this.mode !== MODES.char) return undefined;
    const at = offsetAt(text, cursor);
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
      const block = pairBlock(text, at, key, seek);
      if (!block) return undefined;
      [from, to] = block;
      if (around === "i") from++;
      else to++;
    }
    if (from >= to) return undefined;
    const start = positionAt(text, from), end = positionAt(text, to);
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
    if (this.mode === MODES.block) {
      const minCol = Math.min(anchor.col, cursor.col);
      const maxCol = Math.max(anchor.col, cursor.col);
      return {
        start: { line: first.line, col: minCol },
        // end.col is exclusive (maxCol + 1), like the charwise span; consumers
        // that need a valid apply position clamp it to the line length.
        end: { line: last.line, col: maxCol + 1 },
        linewise: false,
        block: true,
      };
    }
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
