import { decodePrintableKey } from "./pi-tui-keys.ts";
import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth, type EditorComponent } from "@earendil-works/pi-tui";

/**
 * Native text-selection engine for GentlePromptEditor: shift+home / shift+end
 * selection, alt+a select-all, and replace-on-key (backspace / delete /
 * printable character) with reverse-video highlight and a bottom-rule hint.
 * Ported from @exopro/pi-select-del so the petal prompt owns the feature
 * natively — no factory composition, no cross-extension focus handoff.
 *
 * Behavior contract (identical to pi-select-del):
 *   - shift+home — anchor at the cursor, move to line start (held presses at
 *     the edge keep the selection; only a zero-width span collapses)
 *   - shift+end — anchor at the cursor, move to line end
 *   - alt+a — select all
 *   - backspace / delete / printable character over an active selection —
 *     replace it in one atomic edit (undo restores text AND cursor)
 *   - any other key — collapse the selection first, then behave natively
 *
 * The engine drives the host editor's own internals (the EditorInternals
 * surface every CustomEditor-derived editor exposes) and degrades to pure
 * passthrough if that surface drifts: a pi upgrade can cost the selection
 * features, never crash editing.
 */

/** Cursor/anchor position in logical (line, col) editor coordinates. */
export interface Point {
	line: number;
	col: number;
}

/**
 * Narrow view of the private Editor internals the engine relies on. Kept in
 * one place so a pi upgrade only needs re-verifying against this interface.
 */
export interface EditorInternals {
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	paddingX: number;
	scrollOffset: number;
	renderedVisibleLineCount: number;
	/** Layout width the last base render wrapped at; soft-optional — falsy falls back to manual width math. */
	lastWidth: number;
	tui: { requestRender(): void };
	autocompleteState: "regular" | "force" | null;
	lastAction: "kill" | "yank" | "type-word" | null;
	pushUndoSnapshot(): void;
	setCursorCol(col: number): void;
	moveToLineStart(): void;
	moveToLineEnd(): void;
	exitHistoryBrowsing(): void;
	cancelAutocomplete(): void;
	updateAutocomplete(): void;
	buildVisualLineMap(width: number): Array<{ logicalLine: number; startCol: number; length: number }>;
}

const INTERNAL_PROBE_MEMBERS = {
	properties: [
		"state",
		"paddingX",
		"scrollOffset",
		"renderedVisibleLineCount",
		"autocompleteState",
		"lastAction",
		"tui",
	],
	functions: [
		"pushUndoSnapshot",
		"setCursorCol",
		"moveToLineStart",
		"moveToLineEnd",
		"exitHistoryBrowsing",
		"cancelAutocomplete",
		"updateAutocomplete",
		"buildVisualLineMap",
	],
} as const satisfies {
	properties: readonly (keyof EditorInternals)[];
	functions: readonly (keyof EditorInternals)[];
};

/**
 * Members of `target` missing or malformed against the EditorInternals
 * contract. Class-field trap: the properties are ES class fields (instance
 * own-properties), invisible to any prototype probe — probe a real instance,
 * never Editor.prototype or a subclass prototype.
 */
export function missingEditorInternals(target: object): string[] {
	const missing: string[] = [];
	const view = target as Record<string, unknown>;
	for (const name of INTERNAL_PROBE_MEMBERS.properties) {
		if (view[name] === undefined) missing.push(name);
	}
	for (const name of INTERNAL_PROBE_MEMBERS.functions) {
		if (typeof view[name] !== "function") missing.push(name);
	}
	return missing;
}

export function clamp(value: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, value));
}

/**
 * Wrap the code-unit span [startCu, endCu) of a rendered editor row in reverse
 * video. Positions are code-unit offsets into the row's PLAIN text (same unit
 * the editor uses for cursorCol and visual-line map columns). The rendered row
 * may already contain escape sequences (SGR colors, cursor markers); the walk
 * passes those through untouched, keeping code-unit alignment. The span closes
 * with SGR 27 (reverse off), not a full reset: row attributes set before the
 * span must survive. A nested SGR reset re-arms reverse right after it.
 */
export function withReverseSpan(row: string, startCu: number, endCu: number): string {
	let out = "";
	let cu = 0;
	let i = 0;
	let opened = false;
	while (i < row.length) {
		if (!opened && cu >= startCu) {
			out += "\x1b[7m";
			opened = true;
		}
		if (opened && cu >= endCu) {
			return `${out}\x1b[27m${row.slice(i)}`;
		}
		if (row[i] === "\x1b") {
			const seq = row.slice(i, i + escapeSequenceLength(row, i));
			out += seq;
			// A nested SGR reset (e.g. the cursor block's own, when the cursor
			// sits inside the span) clears reverse for everything after it:
			// re-arm reverse right after it.
			if (opened && cu < endCu && isSgrReset(seq)) out += "\x1b[7m";
			i += seq.length;
			continue;
		}
		out += row[i];
		i += 1;
		cu += 1;
	}
	return opened ? `${out}\x1b[27m` : out;
}

/** Length of the escape sequence at s[i] (s[i] === ESC). Unterminated sequences end the row. */
export function escapeSequenceLength(s: string, i: number): number {
	const next = s[i + 1];
	if (next === "[") {
		// CSI: parameter/intermediate bytes 0x20-0x3F, final byte 0x40-0x7E.
		for (let j = i + 2; j < s.length; j++) {
			const code = s.charCodeAt(j);
			if (code >= 0x40 && code <= 0x7e) return j - i + 1;
		}
		return s.length - i;
	}
	if (next === "]" || next === "_") {
		// OSC / APC (cursor markers are APC): terminated by BEL or ST (ESC \).
		const bel = s.indexOf("\x07", i + 2);
		const st = s.indexOf("\x1b\\", i + 2);
		if (bel === -1 && st === -1) return s.length - i;
		if (bel === -1) return st - i + 2;
		if (st === -1) return bel - i + 1;
		return Math.min(bel - i + 1, st - i + 2);
	}
	return 2;
}

/** True for SGR reset sequences: CSI ... m with an empty or all-zero parameter list. */
export function isSgrReset(seq: string): boolean {
	const match = /^\x1b\[([\d;]*)m$/.exec(seq);
	if (!match) return false;
	const params = match[1];
	if (params === "") return true;
	return /^0+$/.test(params.split(";")[0]);
}

/**
 * Selection engine driving a host editor through the EditorInternals cast.
 * `handleInput` takes the host's native dispatch as a `native` callback so the
 * host keeps its own key chain (Esc gates, autocomplete, history) intact:
 * selection keys are handled here; everything else collapses the anchor first,
 * then behaves natively.
 */
export class SelectionEngine {
	/** Selection anchor in logical (line, col) coordinates; adapter-exposed state. */
	anchor: Point | null = null;

	/**
	 * Capability probe cache for the host internals: null until first use, then
	 * the (possibly empty) list of missing members, computed once on the first
	 * handleInput/render call. Any defect permanently DEGRADES the host to
	 * passthrough — selection features off, never a crash.
	 */
	private internalDefects: string[] | null = null;

	private readonly editor: EditorComponent;

	constructor(editor: EditorComponent) {
		this.editor = editor;
	}

	/** True once the probe found missing internals; computes and caches the probe on first call. */
	get degraded(): boolean {
		if (this.internalDefects === null) {
			this.internalDefects = missingEditorInternals(this.editor);
		}
		return this.internalDefects.length > 0;
	}

	private get internals(): EditorInternals {
		return this.editor as unknown as EditorInternals;
	}

	private get s(): EditorInternals["state"] {
		return this.internals.state;
	}

	private cursor(): Point {
		return { line: this.s.cursorLine, col: this.s.cursorCol };
	}

	private setCursor(p: Point): void {
		this.s.cursorLine = p.line;
		this.internals.setCursorCol(p.col);
	}

	/** Ordered (start, end) selection range, or null when no anchor is set. */
	range(): [Point, Point] | null {
		if (!this.anchor) return null;
		const a = this.anchor;
		const c = this.cursor();
		const anchorFirst = a.line < c.line || (a.line === c.line && a.col < c.col);
		return anchorFirst ? [a, c] : [c, a];
	}

	/** Number of characters covered by the active selection (0 when none). Counts line breaks a deletion would remove. */
	selectionLength(): number {
		const range = this.range();
		if (!range) return 0;
		const [start, end] = range;
		const lines = this.s.lines;
		if (start.line === end.line) return end.col - start.col;
		let n = (lines[start.line] ?? "").length - start.col;
		for (let i = start.line + 1; i < end.line; i++) n += (lines[i] ?? "").length;
		return n + end.col + (end.line - start.line);
	}

	/**
	 * Selection dispatch in front of the native chain. Selection and replace
	 * keys are handled here; everything else collapses the anchor first, then
	 * behaves natively. Degraded hosts keep pure native key handling.
	 */
	handleInput(data: string, native: (data: string) => void): void {
		if (this.degraded) {
			native(data);
			return;
		}
		// Kitty flag 2 release byte strings still match their own key, so
		// releases must be dropped before any matchesKey.
		if (isKeyRelease(data)) return;
		if (matchesKey(data, "shift+home")) {
			this.selectToLineEdge(false);
			return;
		}
		if (matchesKey(data, "shift+end")) {
			this.selectToLineEdge(true);
			return;
		}
		if (matchesKey(data, "alt+a")) {
			this.selectAll();
			return;
		}

		if (this.anchor) {
			if (this.isReplaceKey(data)) {
				const replaced = this.replaceSelection(data);
				if (replaced) return;
				// Selection collapsed to empty (anchor met cursor): native key behavior.
				this.anchor = null;
				native(data);
				return;
			}
			// Movement, enter, history, kill/yank, app shortcuts: collapse first, then native behavior.
			this.anchor = null;
		}

		native(data);
	}

	/** Keys whose native effect replaces a selection: backspace/delete (and shift variants) or a printable character. */
	private isReplaceKey(data: string): boolean {
		return (
			matchesKey(data, "backspace") ||
			matchesKey(data, "shift+backspace") ||
			matchesKey(data, "delete") ||
			matchesKey(data, "shift+delete") ||
			this.insertsCharacter(data)
		);
	}

	/**
	 * True when the input inserts a text character (Kitty/CSI-u and
	 * modify-other-keys aware, plus raw terminal bytes). The raw fallback
	 * accepts at most 4 UTF-16 code units with no control bytes; DEL and C1
	 * controls must not count as printable (the editor routes them to
	 * delete/other actions before its printable fallback, so re-submitting
	 * them after a splice would double-edit).
	 */
	private insertsCharacter(data: string): boolean {
		if (decodePrintableKey(data) !== undefined) return true;
		if (data.length > 4) return false;
		for (let i = 0; i < data.length; i++) {
			const c = data.charCodeAt(i);
			if (c < 32 || c === 127 || (c >= 0x80 && c <= 0x9f)) return false;
		}
		return true;
	}

	private selectToLineEdge(toEnd: boolean): void {
		const before = this.cursor();
		if (toEnd) this.internals.moveToLineEnd();
		else this.internals.moveToLineStart();
		this.internals.exitHistoryBrowsing();
		// Repeated or held presses at the edge KEEP the selection: legacy
		// terminals repeat the press byte-identically. Only a zero-width span
		// (cursor landed exactly on the anchor) collapses.
		this.anchor ??= before;
		if (this.anchor.line === this.s.cursorLine && this.anchor.col === this.s.cursorCol) {
			this.anchor = null;
		}
		if (this.internals.autocompleteState) this.internals.updateAutocomplete();
		this.internals.tui.requestRender();
	}

	/** Select the entire editor text (alt+a). Cursor moves to the end of the last line. */
	private selectAll(): void {
		const lines = this.s.lines;
		const lastLine = Math.max(0, lines.length - 1);
		this.anchor = { line: 0, col: 0 };
		this.s.cursorLine = lastLine;
		this.internals.setCursorCol((lines[lastLine] ?? "").length);
		this.internals.lastAction = null;
		this.internals.exitHistoryBrowsing();
		if (this.internals.autocompleteState) this.internals.cancelAutocomplete();
		this.internals.tui.requestRender();
	}

	/**
	 * Replace the active selection in ONE atomic edit (delete, or delete +
	 * printable character): a single undo snapshot before any mutation, then
	 * one splice. Returns false when the span is empty; the caller falls back
	 * to native key behavior.
	 */
	private replaceSelection(data: string): boolean {
		const range = this.range();
		if (!range) return false;
		const [start, end] = range;
		if (start.line === end.line && start.col === end.col) return false;
		const resolved = decodePrintableKey(data) ?? (this.insertsCharacter(data) ? data : undefined);
		const cp = resolved?.codePointAt(0) ?? 0;
		const char = cp === 127 || (cp >= 0x80 && cp <= 0x9f) ? undefined : resolved;
		const internals = this.internals;
		const lines = internals.state.lines;
		internals.pushUndoSnapshot();
		const merged =
			(lines[start.line] ?? "").slice(0, start.col) + (char ?? "") + (lines[end.line] ?? "").slice(end.col);
		lines.splice(start.line, end.line - start.line + 1, merged);
		this.anchor = null;
		this.setCursor({ line: start.line, col: start.col + (char?.length ?? 0) });
		internals.exitHistoryBrowsing();
		internals.lastAction = null;
		if (internals.autocompleteState) internals.cancelAutocomplete();
		this.editor.onChange?.(this.editor.getText());
		internals.tui.requestRender();
		return true;
	}

	/**
	 * Render post-pass: wrap the selected span of each visible row in reverse
	 * video. `inset` is the number of columns the host render adds on EACH side
	 * before the editor's own content (0 for plain content rows, 1 for a
	 * one-column frame wall); `width` is the width the content was rendered at.
	 */
	decorateRows(rows: string[], width: number, inset: number): string[] {
		const range = this.range();
		if (!range) return rows;
		const internals = this.internals;
		const [start, end] = range;
		const contentWidth = Math.max(1, width - inset * 2 - internals.paddingX * 2);
		const layoutWidth = internals.lastWidth || Math.max(1, contentWidth - (internals.paddingX ? 0 : 1));
		const visual = internals.buildVisualLineMap(layoutWidth);
		for (let r = 0; r < internals.renderedVisibleLineCount; r++) {
			const vr = visual[internals.scrollOffset + r];
			if (!vr || vr.logicalLine < start.line || vr.logicalLine > end.line) continue;
			const from =
				clamp(vr.logicalLine === start.line ? start.col - vr.startCol : 0, 0, vr.length) +
				internals.paddingX +
				inset;
			const to =
				clamp(vr.logicalLine === end.line ? end.col - vr.startCol : vr.length, 0, vr.length) +
				internals.paddingX +
				inset;
			if (to <= from) continue;
			const index = 1 + r; // rows[0] is the top border/rule in every layout
			if (index < rows.length) rows[index] = withReverseSpan(rows[index] ?? "", from, to);
		}
		return rows;
	}

	/**
	 * Bottom-rule selection hint. `corner` re-attaches the host frame's right
	 * corner glyph after the label. Widths always add up: the rule is truncated
	 * to make exact room for label + corner.
	 */
	decorateBottomRule(baseRow: string, width: number, corner: string): string {
		const n = this.selectionLength();
		if (n <= 0) return baseRow;
		const label = ` ${n} char${n === 1 ? "" : "s"} selected - Del deletes - Alt+a select all `;
		const labelWidth = visibleWidth(label);
		if (labelWidth + visibleWidth(corner) + 1 >= width) return baseRow;
		return `${truncateToWidth(baseRow, width - labelWidth - visibleWidth(corner), "")}${label}${corner}`;
	}
}
