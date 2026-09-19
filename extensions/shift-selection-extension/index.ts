/**
 * pi extension: Shift+Home / Shift+End text selection with delete for the main input editor.
 *
 * Load with: pi --extension extensions/shift-selection-extension/index.ts
 *
 * Behavior contract:
 *   - shift+home — set/extend the selection anchor at the cursor, move cursor to line start
 *   - shift+end  — set/extend the selection anchor at the cursor, move cursor to line end
 *     (repeated or held presses at the edge keep the selection; movement/typing/editing keys
 *     collapse it)
 *   - alt+a     — select all text (ctrl+a keeps its native "cursor to line start"; in iTerm2
 *                  make sure Left Option Key is set to "Esc+" so option+a sends alt+a)
 *   - backspace / delete / printable character — replace the active selection in one atomic
 *     edit (a printable character is inserted in its place; raw non-ASCII keystrokes of up
 *     to 4 code units count as printable too)
 *   - any other key (arrows, home/end, pageUp/Down, up/down, enter, app shortcuts) — collapse
 *     the selection first, then behave normally; submit never deletes the selection. Paste
 *     over an active selection is in this class too: it collapses the selection and the base
 *     editor handles the payload (paste is never a replace key)
 *   - ctrl+- (tui.editor.undo) reverts a selection delete/replacement in one step, restoring
 *     text AND cursor
 *   - visual feedback: reverse-video highlight of the selected span plus a bottom-border hint
 *     ("N chars selected - Del deletes - Alt+a select all")
 * While a selection is active, this editor handles shift+home / shift+end / alt+a / backspace
 * / delete / printable keys itself, before app or extension shortcuts see them.
 *
 * Debug tap: set PI_SHIFT_SELECTION_DEBUG to a writable file path and every key is appended
 * there with its raw bytes and the branch taken. Diagnoses terminals that send nothing for
 * shift+home/end (e.g. iTerm2 default profile — map them to "Send Escape Sequence" [1;2H
 * and [1;2F in Profiles > Keys > Key Mappings). Off by default; never throws into editing.
 * WARNING: the tap file records every keystroke in plaintext and may contain secrets; it is
 * created owner-only (mode 0600), receives a warning header on creation, and a pre-existing
 * tap file is re-permissioned to 0600 on open. Debug-only caveat: if the tap file is deleted
 * mid-session, the cached fd keeps writing to the unlinked inode until the env path changes
 * or the process restarts.
 *
 * Config side effect: on session start the extension ensures <agentDir>/keybindings.json maps
 * tui.altScreen.top/bottom to ctrl+home/ctrl+end so Home/End reach the editor in fullscreen
 * mode (the transcript captures swallow the bare keys; editor defaults already equate
 * home=ctrl+a, end=ctrl+e). Only values that are absent or still at the pi defaults
 * ("home"/"end") are replaced — deliberate user customizations are never touched — and
 * unparseable JSON is backed up before rewriting. pi reads keybindings.json at boot (and on
 * /reload), so a written change takes effect on the next /reload or restart.
 *
 * Version coupling: accesses private TUI Editor internals (state, undo snapshot, line-edge
 * movement, visual-line map, autocomplete controls) through one cast view, and imports
 * decodePrintableKey via the deep path @earendil-works/pi-tui/dist/keys.js (pi-tui has no
 * exports map, so deep dist imports resolve). Written and verified against pi 0.85.1 —
 * re-verify these internals when upgrading pi. A runtime capability probe over every member
 * of the cast view (missingEditorInternals) detects drift: a degraded editor keeps stock
 * editing behavior for its whole lifetime (selection features off, never a crash), and
 * session start surfaces a warning naming the missing members.
 */

import {
	chmodSync,
	closeSync,
	copyFileSync,
	existsSync,
	openSync,
	readFileSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { CustomEditor, type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { decodePrintableKey } from "@earendil-works/pi-tui/dist/keys.js";

/** Cursor/anchor position in logical (line, col) editor coordinates. */
interface Point {
	line: number;
	col: number;
}

/**
 * Narrow view of the private Editor internals this extension relies on. Kept in one place so
 * a pi upgrade only needs re-verifying against this interface.
 */
interface EditorInternals {
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	paddingX: number;
	scrollOffset: number;
	renderedVisibleLineCount: number;
	/**
	 * Layout width the last base render wrapped at (the base clamps paddingX and stores its
	 * wrap width here). Soft-optional: deliberately NOT probed as a hard requirement — when
	 * it is falsy (render before the first base layout, or internal drift) render() falls
	 * back to a manual width computation instead of degrading the editor.
	 */
	lastWidth: number;
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

/**
 * Every hard-required member of EditorInternals, split by kind, probed at runtime to detect
 * internal drift after a pi upgrade. Keep in lockstep with the interface above: the satisfies
 * clause makes a typo or a renamed member a compile error. lastWidth is deliberately unprobed:
 * its only consumer falls back to a manual width computation when it is falsy, so its absence
 * costs nothing and must not degrade the editor.
 */
const INTERNAL_PROBE_MEMBERS = {
	properties: ["state", "paddingX", "scrollOffset", "renderedVisibleLineCount", "autocompleteState", "lastAction"],
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
 * Members of `target` missing or malformed against the EditorInternals contract: a property
 * member counts as missing when its value is undefined (null is a legitimate runtime value
 * for autocompleteState/lastAction), a function member when its value is not a function.
 * Property access walks the prototype chain, so passing CustomEditor.prototype probes the
 * real runtime base where the internals live.
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
 * Warning header written once when the debug tap file is created: the tap records raw
 * keystrokes, so anyone opening the file must know what it holds before sharing it.
 */
const DEBUG_TAP_HEADER =
	"# PI_SHIFT_SELECTION_DEBUG appends EVERY keystroke VERBATIM; the log may include secrets.\n" +
	"# Debug output only: use a private path and delete the file afterwards.\n";

let debugFd: number | null = null;
let debugFdPath: string | null = null;

/**
 * One debug-tap line per key when PI_SHIFT_SELECTION_DEBUG points to a file. Never throws:
 * any error resets the cached fd and is swallowed — debugging must never break editing.
 * The fd is cached per env path: a changed path closes the previous fd (a stale-fd close
 * error is swallowed — it must not break the reopen) and reopens fresh; a newly created file
 * gets mode 0600 (owner-only) and the warning header, and a pre-existing file is
 * re-permissioned to 0600 on open.
 */
function debugKey(data: string, note: string): void {
	const path = process.env.PI_SHIFT_SELECTION_DEBUG;
	if (!path) return;
	try {
		let fd = debugFd;
		if (fd === null || debugFdPath !== path) {
			if (fd !== null) {
				try {
					closeSync(fd);
				} catch {
					/* stale fd (already closed or invalid): never block the reopen */
				}
			}
			const existed = existsSync(path);
			fd = openSync(path, "a", 0o600);
			if (existed) chmodSync(path, 0o600);
			else writeSync(fd, DEBUG_TAP_HEADER);
			debugFd = fd;
			debugFdPath = path;
		}
		writeSync(fd, `${new Date().toISOString()} ${JSON.stringify(data)} ${note}\n`);
	} catch {
		debugFd = null;
		debugFdPath = null;
		/* debugging must never break editing */
	}
}

/**
 * Wrap the code-unit span [startCu, endCu) of a rendered editor row in reverse video.
 *
 * Positions are code-unit offsets into the row's PLAIN text (same unit the editor uses for
 * cursorCol and visual-line map columns), so no display-width math is needed. The rendered
 * row may already contain escape sequences (SGR colors, the APC CURSOR_MARKER); the walk
 * passes those through untouched, which keeps the code-unit count aligned with the text.
 *
 * The span closes with SGR 27 (reverse off), not a full SGR reset (0): the row may carry
 * attributes set before the span (theme colors, bold, the cursor marker's styling) that a
 * full reset would wipe. SGR 27 is universally supported.
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
			const seq = escapeSequenceLength(row, i);
			const chunk = row.slice(i, i + seq);
			out += chunk;
			// A nested SGR reset (e.g. the cursor block's own, when the cursor sits inside the
			// span) clears reverse for everything after it: re-arm reverse right after it.
			if (opened && cu < endCu && isSgrReset(chunk)) out += "\x1b[7m";
			i += seq;
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
		// OSC / APC (CURSOR_MARKER is APC): terminated by BEL or ST (ESC \).
		const bel = s.indexOf("\x07", i + 2);
		const st = s.indexOf("\x1b\\", i + 2);
		if (bel === -1 && st === -1) return s.length - i;
		if (bel === -1) return st - i + 2;
		if (st === -1) return bel - i + 1;
		return Math.min(bel - i + 1, st - i + 2);
	}
	return 2;
}

/**
 * True for SGR reset sequences: a CSI ... m sequence whose parameter list is empty
 * ("\x1b[m") or whose first parameter is zero ("\x1b[0m", and multi-parameter resets like
 * "\x1b[0;31m" — reset everything, then apply red). Anything else — SGR with a nonzero
 * first parameter, truncated input, or non-SGR sequences — is false.
 */
export function isSgrReset(seq: string): boolean {
	const match = /^\x1b\[([\d;]*)m$/.exec(seq);
	if (!match) return false;
	const params = match[1];
	if (params === "") return true;
	// First parameter only; leading zeros are still zero ("00" resets too).
	return /^0+$/.test(params.split(";")[0]);
}

export class SelectingEditor extends CustomEditor {
	private anchor: Point | null = null;

	/**
	 * Capability probe cache for the private EditorInternals reached through the cast view:
	 * null until first use, then the (possibly empty) list of missing members, computed once
	 * on the first handleInput/render/renderBottomBorder call. Any defect permanently
	 * DEGRADES THE INSTANCE TO A STOCK EDITOR for its whole lifetime: handleInput delegates
	 * straight to the base, render/renderBottomBorder return the base output, and no
	 * internal is ever touched again — no anchor tracking, no debug tap on the degraded
	 * path. Total and one-way: internal drift after a pi upgrade can only cost the selection
	 * features, never crash editing.
	 */
	private internalDefects: string[] | null = null;

	/** True once the probe found missing internals; computes and caches the probe on first call. */
	private get degraded(): boolean {
		if (this.internalDefects === null) {
			this.internalDefects = missingEditorInternals(this);
		}
		return this.internalDefects.length > 0;
	}

	private get internals(): EditorInternals {
		return this as unknown as EditorInternals;
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

	/**
	 * Ordered (start, end) selection range, or null when no anchor is set. Pure: collapse
	 * decisions belong to the key handlers, not to this read.
	 */
	private range(): [Point, Point] | null {
		if (!this.anchor) return null;
		const a = this.anchor;
		const c = this.cursor();
		const anchorFirst = a.line < c.line || (a.line === c.line && a.col < c.col);
		return anchorFirst ? [a, c] : [c, a];
	}

	/** Number of characters covered by the active selection (0 when none). Counts the line breaks a deletion would remove, so multi-line labels match the spliced amount. */
	private selectionLength(): number {
		const range = this.range();
		if (!range) return 0;
		const [start, end] = range;
		const lines = this.s.lines;
		if (start.line === end.line) return end.col - start.col;
		let n = (lines[start.line] ?? "").length - start.col;
		for (let i = start.line + 1; i < end.line; i++) n += (lines[i] ?? "").length;
		return n + end.col + (end.line - start.line);
	}

	override handleInput(data: string): void {
		// Degraded instances keep pure stock key handling: no selection logic, no debug tap.
		if (this.degraded) {
			super.handleInput(data);
			return;
		}
		// Kitty flag 2 release byte strings still match their own key ("\x1b[1;2:3F" matches
		// shift+end), so releases must be dropped before any matchesKey. pi-tui's TUI already
		// filters releases for the editor; this guards direct dispatch and future changes.
		// Repeats (":2" event type) still get through and keep acting.
		if (isKeyRelease(data)) {
			debugKey(data, "-> release ignored");
			return;
		}
		if (matchesKey(data, "shift+home")) {
			debugKey(data, "-> shift+home");
			this.selectToLineEdge(false);
			return;
		}
		if (matchesKey(data, "shift+end")) {
			debugKey(data, "-> shift+end");
			this.selectToLineEdge(true);
			return;
		}
		if (matchesKey(data, "alt+a")) {
			debugKey(data, "-> select all");
			this.selectAll();
			return;
		}

		if (this.anchor) {
			if (this.isReplaceKey(data)) {
				const replaced = this.replaceSelection(data);
				debugKey(data, replaced ? "-> replace selection" : "-> empty selection, native");
				if (replaced) return;
				// Selection collapsed to empty (anchor met cursor): native key behavior.
				this.anchor = null;
				super.handleInput(data);
				return;
			}
			// Movement, enter, history, kill/yank, app shortcuts: collapse first, then normal behavior.
			this.anchor = null;
			debugKey(data, "-> collapse, native");
		} else {
			debugKey(data, "-> native");
		}

		super.handleInput(data);
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
	 * True when the input inserts a text character (Kitty/CSI-u and modify-other-keys aware,
	 * plus raw terminal bytes for terminals without those protocols). The raw fallback
	 * accepts at most 4 UTF-16 code units with no control bytes (every unit >= 32, excluding
	 * DEL 0x7f and the C1 range 0x80-0x9f): one keystroke is 1-4 units (ASCII, accented BMP
	 * letters, emoji surrogate pairs, flags), while the 4-unit cap keeps paste payloads and
	 * longer IME commits on the collapse-first behavior so they never splice over an active
	 * selection. Control bytes — including the escape byte 0x1b that marks bracketed-paste
	 * payloads and other terminal sequences — never count as printable. DEL and C1 controls
	 * must NOT count as printable either: the editor routes them to delete/other actions
	 * before its own printable fallback, so re-submitting them after a splice would
	 * double-edit.
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
		// Repeated or held presses at the edge KEEP the selection: legacy terminals repeat the
		// press byte-identically, so only keep semantics work everywhere. Only a zero-width span
		// (cursor landed exactly on the anchor) collapses.
		this.anchor ??= before;
		if (this.anchor.line === this.s.cursorLine && this.anchor.col === this.s.cursorCol) {
			this.anchor = null;
		}
		if (this.internals.autocompleteState) this.internals.updateAutocomplete();
		this.tui.requestRender();
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
		this.tui.requestRender();
	}

	/**
	 * Replace the active selection in ONE atomic edit (delete, or delete + printable char):
	 * a single undo snapshot before any mutation, then one splice. Never re-dispatches into
	 * super.handleInput — the base insertCharacter would push a second undo snapshot, making
	 * replacement need two undos. Returns false when the span is empty; the caller falls back
	 * to native key behavior.
	 */
	private replaceSelection(data: string): boolean {
		const range = this.range();
		if (!range) return false;
		const [start, end] = range;
		if (start.line === end.line && start.col === end.col) return false;
		// decodePrintableKey hit, or the full raw string when the raw printable fallback
		// passes (e.g. a terminal sending raw "é" inserts it as one unit, cursor +1).
		const resolved = decodePrintableKey(data) ?? (this.insertsCharacter(data) ? data : undefined);
		// Control characters still arrive through the decoded path: decodeKittyPrintable only
		// rejects codepoints < 32, so Kitty CSI-u DEL (127) and C1 bytes (0x80-0x9f) decode as
		// printable. Same rationale as the insertsCharacter fallback: over a selection they
		// must act delete-only, exactly like backspace.
		const cp = resolved?.codePointAt(0) ?? 0;
		const char = cp === 127 || (cp >= 0x80 && cp <= 0x9f) ? undefined : resolved;
		const internals = this.internals;
		const lines = internals.state.lines;
		// Clone-on-push snapshot: exactly one undo step restores text AND cursor.
		internals.pushUndoSnapshot();
		const merged =
			(lines[start.line] ?? "").slice(0, start.col) + (char ?? "") + (lines[end.line] ?? "").slice(end.col);
		lines.splice(start.line, end.line - start.line + 1, merged);
		this.anchor = null;
		this.setCursor({ line: start.line, col: start.col + (char?.length ?? 0) });
		internals.exitHistoryBrowsing();
		internals.lastAction = null;
		if (internals.autocompleteState) internals.cancelAutocomplete();
		this.onChange?.(this.getText());
		this.tui.requestRender();
		return true;
	}

	override render(width: number): string[] {
		if (this.degraded) return super.render(width);
		const rows = super.render(width);
		const range = this.range();
		if (!range) return rows;
		const internals = this.internals;
		const [start, end] = range;
		// The map must be built at the SAME width the base used for its own buildVisualLineMap:
		// the base render above clamps paddingX to floor((width-1)/2) and stores its layout
		// width in lastWidth, so prefer it verbatim. Fall back to the manual computation only
		// when lastWidth is falsy (a render before the first base layout, or internal drift).
		const contentWidth = Math.max(1, width - internals.paddingX * 2);
		const layoutWidth = internals.lastWidth || Math.max(1, contentWidth - (internals.paddingX ? 0 : 1));
		const visual = internals.buildVisualLineMap(layoutWidth);
		for (let r = 0; r < internals.renderedVisibleLineCount; r++) {
			const vr = visual[internals.scrollOffset + r];
			if (!vr || vr.logicalLine < start.line || vr.logicalLine > end.line) continue;
			const from =
				clamp(vr.logicalLine === start.line ? start.col - vr.startCol : 0, 0, vr.length) + internals.paddingX;
			const to =
				clamp(vr.logicalLine === end.line ? end.col - vr.startCol : vr.length, 0, vr.length) + internals.paddingX;
			if (to <= from) continue;
			const index = 1 + r; // rows[0] is the top border
			if (index < rows.length) rows[index] = withReverseSpan(rows[index] ?? "", from, to);
		}
		return rows;
	}

	// Runtime-dispatched override: pi-tui's Editor.render() base pipeline calls this.renderBottomBorder() (editor.js), invisible to static analysis.
	override renderBottomBorder(width: number, hiddenLineCount: number): string {
		if (this.degraded) return super.renderBottomBorder(width, hiddenLineCount);
		const base = super.renderBottomBorder(width, hiddenLineCount);
		const n = this.selectionLength();
		if (n <= 0) return base;
		const label = ` ${n} char${n === 1 ? "" : "s"} selected - Del deletes - Alt+a select all `;
		const labelWidth = visibleWidth(label);
		if (labelWidth + 1 >= width) return base;
		return truncateToWidth(base, width - labelWidth, "") + label;
	}
}

/** Managed actions whose fullscreen transcript captures must map to the ctrl variants for Home/End. */
const EDITOR_KEYBINDING_ACTIONS = ["tui.altScreen.top", "tui.altScreen.bottom"] as const;

/** Target bindings written for the managed actions. */
const EDITOR_KEYBINDING_TARGETS: Record<(typeof EDITOR_KEYBINDING_ACTIONS)[number], string> = {
	"tui.altScreen.top": "ctrl+home",
	"tui.altScreen.bottom": "ctrl+end",
};

/** pi's built-in bindings for the managed actions — values still at these defaults are replaceable. */
const EDITOR_KEYBINDING_PI_DEFAULTS: Record<(typeof EDITOR_KEYBINDING_ACTIONS)[number], string[]> = {
	"tui.altScreen.top": ["home"],
	"tui.altScreen.bottom": ["end"],
};

/** Result of ensureEditorHomeEndKeybindings — failures surface as status "error", never a throw. */
export interface EditorKeybindingsResult {
	status: "created" | "updated" | "unchanged" | "error";
	/** Managed actions left untouched because the user deliberately customized them. */
	skippedCustom?: string[];
	/** Sibling backup path, present when the original file held unparseable JSON. */
	backedUp?: string;
	/** Failure detail, present when status is "error". */
	error?: string;
}

/**
 * Collapse a raw keybindings value for the default-equality guard. Strict rule: a string
 * -> [v]; a pure-string array -> its elements; anything else — including an array with ANY
 * non-string element — is unrecognizable (null) and therefore treated as a deliberate
 * customization that is never replaced (no lossy filtering of the non-string entries).
 */
function normalizeKeybindingValue(value: unknown): string[] | null {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) {
		return value.every((item): item is string => typeof item === "string") ? value : null;
	}
	return null;
}

/** error.message for Error instances, String() for anything else a runtime may throw. */
function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Ensure the keybindings config maps tui.altScreen.top/bottom to ctrl+home/ctrl+end so
 * Home/End reach the editor in fullscreen mode (the transcript captures swallow the bare
 * keys; editor defaults already equate home=ctrl+a, end=ctrl+e). Guarded merge: a managed
 * key is only written when it is absent or still at the pi default ("home"/"end");
 * deliberate customizations (any other value, including the explicitly disabled []) are left
 * untouched and reported in skippedCustom; mixed-type arrays are never replaced, since
 * string-filtering them would silently drop entries. A leading UTF-8 BOM is stripped
 * before parsing (pi itself tolerates one). Unparseable JSON is copied to
 * <configPath>.broken-<Date.now()>-<process.pid>.bak before rewriting — the pid suffix
 * keeps same-millisecond concurrent writers from colliding, so the original bytes are
 * never destroyed without a backup. Writes 2-space-indented JSON with a trailing newline.
 * Never throws: any failure returns status "error" so config plumbing cannot break pi startup.
 */
export function ensureEditorHomeEndKeybindings(configPath: string): EditorKeybindingsResult {
	try {
		let existed = false;
		let raw = "";
		try {
			raw = readFileSync(configPath, "utf-8");
			existed = true;
		} catch (readError) {
			if ((readError as NodeJS.ErrnoException).code !== "ENOENT") {
				return { status: "error", error: describeError(readError) };
			}
		}

		let config: Record<string, unknown> = {};
		let backedUp: string | undefined;
		if (existed) {
			let parsed: unknown;
			try {
				// Tolerate a UTF-8 BOM: pi strips it before parsing this same file
				// (core/keybindings.js), so a BOM-prefixed config is valid, not broken.
				parsed = JSON.parse(raw.startsWith("\uFEFF") ? raw.slice(1) : raw);
			} catch {
				parsed = undefined;
			}
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				// Unusable document (unparseable or not a key/value map): preserve the original
				// bytes in a sibling backup, then start from an empty config.
				// pid suffix: two writers in the same millisecond must not share a name,
				// or copyFileSync would truncate the first writer's backup.
				backedUp = `${configPath}.broken-${Date.now()}-${process.pid}.bak`;
				copyFileSync(configPath, backedUp);
			} else {
				config = parsed as Record<string, unknown>;
			}
		}

		const skippedCustom: string[] = [];
		let changed = false;
		for (const action of EDITOR_KEYBINDING_ACTIONS) {
			if (!(action in config)) {
				config[action] = EDITOR_KEYBINDING_TARGETS[action];
				changed = true;
				continue;
			}
			const normalized = normalizeKeybindingValue(config[action]);
			const piDefault = EDITOR_KEYBINDING_PI_DEFAULTS[action];
			if (
				normalized !== null &&
				normalized.length === piDefault.length &&
				normalized.every((binding, index) => binding === piDefault[index])
			) {
				config[action] = EDITOR_KEYBINDING_TARGETS[action];
				changed = true;
			} else {
				skippedCustom.push(action);
			}
		}

		if (!changed) {
			return skippedCustom.length > 0 ? { status: "unchanged", skippedCustom } : { status: "unchanged" };
		}

		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
		return {
			status: existed ? "updated" : "created",
			...(skippedCustom.length > 0 ? { skippedCustom } : {}),
			...(backedUp !== undefined ? { backedUp } : {}),
		};
	} catch (error) {
		return { status: "error", error: describeError(error) };
	}
}

// pi extension loader contract: pi loads this module via --extension/auto-discovery and invokes the default factory (docs/extensions.md: "An extension exports a default factory function").
export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		// Capability probe on the real runtime base (property access walks the prototype
		// chain): missing internals mean every editor instance self-degrades to a stock
		// editor, so name the defect instead of silently losing the selection features.
		const missing = missingEditorInternals(CustomEditor.prototype);
		if (missing.length > 0) {
			ctx.ui.notify(
				`Shift+Home/End selection: pi editor internals changed (missing: ${missing.join(", ")}) — selection features are disabled for this session.`,
				"warning",
			);
		}
		// Installed regardless: SelectingEditor degrades itself when the probe finds defects.
		ctx.ui.setEditorComponent((tui, theme, kb) => new SelectingEditor(tui, theme, kb));

		// Config side effect (see header): surface the outcome instead of staying silent.
		const keybindings = ensureEditorHomeEndKeybindings(join(getAgentDir(), "keybindings.json"));
		if (keybindings.status === "error") {
			ctx.ui.notify(`Shift+Home/End selection: keybindings.json update failed: ${keybindings.error}`, "warning");
		} else if (keybindings.status === "created" || keybindings.status === "updated") {
			const details: string[] = [];
			if (keybindings.backedUp !== undefined) details.push(`original backed up to ${keybindings.backedUp}`);
			if (keybindings.skippedCustom !== undefined && keybindings.skippedCustom.length > 0) {
				details.push(`kept your custom binding for ${keybindings.skippedCustom.join(", ")}`);
			}
			const suffix = details.length > 0 ? ` (${details.join("; ")})` : "";
			ctx.ui.notify(`Shift+Home/End selection: ${keybindings.status} keybindings.json${suffix}`, "info");
		}
	});
}
