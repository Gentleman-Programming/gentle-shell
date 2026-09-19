// SPDX-FileCopyrightText: 2026 ExoPro. Inspired by @jasonish/pi-prompt-history
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { homedir } from "node:os";
import fs from "node:fs";
import {
  DynamicBorder,
  type ExtensionAPI,
  type ShortcutContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  appendSessionCapture,
  bootstrapProjectSeed,
  deleteFromGlobal,
  deleteFromProject,
  drainGlobal,
  drainProject,
  gcProjectDir,
  migrateLegacyStores,
  openSessionWriter,
  type SessionWriterState,
} from "./store.ts";
import { ensureRegistryEntry } from "./store.ts";
import { randomUUID } from "node:crypto";
import { hidePrompt } from "./hide-prompts.ts";
import {
  buildPromptRecords,
  filterPrompts,
  type PromptEntry,
  clampPreviewOffset,
  clampSelectedIndex,
  deletionActionsFor,
  dedupePromptEntries,
  getVisiblePromptRecords,
  initialLoadedCount,
  loadedCountAfterDelete,
  loadedCountForQuery,
  loadedCountForTarget,
  moveSelectedIndex,
  nextLoadedCount,
  pageSelectedIndex,
  shouldGrowWindow,
  withExpandedHistoryGlobals,
  type PiHistoryGlobals,
  type PromptRecord,
} from "./selector-helpers.ts";
import {
  Container,
  type Focusable,
  getKeybindings,
  Input,
  matchesKey,
  Text,
  type TUI,
  type TuiMouseEvent,
  truncateToWidth,
} from "@earendil-works/pi-tui";

const SHORTCUT = "ctrl+shift+r";
const MAX_VISIBLE = 10;
const PREVIEW_ROWS = 10;
// Lazy windowing (design §D3; user-tuned 2026-09-08). PRELOAD_BUFFER=2
// fires growth as the cursor enters the final 2 loaded rows; BATCH_SIZE=10
// loads exactly one viewport per growth; INITIAL_BATCH=10 paints one
// viewport at open. PRELOAD_BUFFER <= MAX_VISIBLE keeps a jump within one
// viewport covered by the catch-up loop; review all three together.
const INITIAL_BATCH = 10;
const BATCH_SIZE = 10;
const PRELOAD_BUFFER = 3;
// Wheel regions over the fixed 30-row overlay geometry (design §D6): the
// list container renders at rows 5-14 and the preview container at rows
// 17-26; every other row is a consumed no-op.
const LIST_WHEEL_Y_FIRST = 5;
const LIST_WHEEL_Y_LAST = 14;
const PREVIEW_WHEEL_Y_FIRST = 17;
const PREVIEW_WHEEL_Y_LAST = 26;

    // v2 multi-concurrency store root (design: tmp/multi-concurrency-design.md).
    const PI_HISTORY_ROOT = join(
      homedir(),
      ".pi",
      "agent",
      "history",
    );
    const AGENT_DIR = join(homedir(), ".pi", "agent");
    const CURRENT_CWD = process.cwd();
    // Instance identity: one exclusive capture file per pi process.
    const INSTANCE_ID = randomUUID();

// State dir for the session index and the tombstone file (spec C2/C4,
// design §D5). Derived state only — deleting the directory restores cold
// start and unhides every prompt; transcripts and the editor store are
// never written here.
// Tombstone state dir: the store root itself (user-directed FINAL):
// ~/.pi/agent/history/hidden.json — one directory for everything.
const PI_HISTORY_NAV_STATE_DIR = join(
  homedir(),
  ".pi",
  "agent",
  "history",
);

// Sessions root for the one-level transcript scan (spec C1, design §D5):
// ~/.pi/agent/sessions/. Read-only by invariant — transcripts are never
// written by this extension.
const SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");

/** Width of the "→ " / "  " prefix on each entry line. */
const ENTRY_PREFIX_WIDTH = 2;

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/**
 * Replace control characters with visible escape notation so the terminal
 * renders them as text instead of interpreting them as commands.
 * Preserves \n (newlines) and \t (tabs).
 */
function sanitizeForDisplay(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    if (cp === 0x0a) {
      out += "\n";
    } else if (cp === 0x09) {
      out += "\t";
    } else if (cp < 0x20 || cp === 0x7f) {
      out += "\\x" + cp.toString(16).padStart(2, "0");
    } else if (cp >= 0x80 && cp < 0xa0) {
      out += "\\x" + cp.toString(16).padStart(2, "0");
    } else {
      out += text[i];
    }
    if (cp > 0xffff) i++; // skip low surrogate of astral pair
  }
  return out;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Keybinding lookup returned by getKeybindings(). */
interface Keybindings {
  matches(data: string, action: string): boolean;
}

type InputMatcher = (data: string, kb: Keybindings) => boolean;
type InputHandler = () => void;

interface DispatchEntry {
  match: InputMatcher;
  handler: InputHandler;
}

/** Notification sink for selector feedback; an absent callback drops notifications. */
type SelectorNotify = (message: string, level: "error" | "warning" | "info") => void;

/** Single rendered row; always occupies exactly one terminal row. */
class FixedRowText {
  constructor(
    private text: string = "",
    private readonly centered = false,
  ) {}

  /** Replace the row content in place; padding contract comes from render(). */
  setText(next: string): void {
    this.text = next;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width <= 0) return [" "] as string[];
    if (this.text.length === 0) {
      // Use a space so the terminal always renders this as a visible row
      // and differential rendering correctly detects it as a changed line.
      return [" ".repeat(width)] as string[];
    }
    const rendered = this.centered
      ? (() => {
          // Truncate first so an overlong help row can never exceed width,
          // then center the truncated copy (design §C hardening).
          const truncated = truncateToWidth(this.text, width, "…");
          const visible = truncated.replace(/\x1b\[[0-9;]*m/g, "");
          const pad = Math.max(0, Math.floor((width - visible.length) / 2));
          return " ".repeat(pad) + truncated;
        })()
      : truncateToWidth(this.text, width, "…");
    // Pad to full terminal width so the overlay fully overwrites
    // whatever is beneath it and leaves no ghost characters on dismiss.
    return [rendered + " ".repeat(Math.max(0, width - rendered.length))];
  }
}

/** Word-wrap plain text so each line fits within maxWidth characters. */
function wordWrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text || " "];
  const paragraphs = text.split("\n");
  const result: string[] = [];
  for (const para of paragraphs) {
    if (para.length === 0) {
      result.push("");
      continue;
    }
    let remaining = para;
    while (remaining.length > 0) {
      if (remaining.length <= maxWidth) {
        result.push(remaining);
        break;
      }
      const breakAt = remaining.lastIndexOf(" ", maxWidth);
      if (breakAt <= 0) {
        result.push(remaining.substring(0, maxWidth));
        remaining = remaining.substring(maxWidth);
      } else {
        result.push(remaining.substring(0, breakAt));
        remaining = remaining.substring(breakAt + 1);
      }
    }
  }
  return result.length > 0 ? result : [""];
}

// ---------------------------------------------------------------------------
// TUI Selector
// ---------------------------------------------------------------------------

class PromptHistorySelector extends Container implements Focusable {
  private readonly searchInput: Input;
  private readonly previewContainer: Container;
  private readonly listContainer: Container;
  private readonly headerRow: FixedRowText;
  private readonly previewLabelRow: FixedRowText;
  private records: PromptRecord[];
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly onSelect: (record: PromptRecord) => void;
  private readonly onCancel: () => void;
  private filteredRecords: PromptRecord[] = [];
  private selectedIndex = 0;
  /** Number of records loaded (newest-first) from the top of `records`. */
  private loadedCount = 0;
  /** Active scope (design v2): project (default) or global. */
  private scope: "project" | "global" = "project";
  /** Last render width, used for entry truncation. */
  private lastWidth = 800;
  /** Word-wrapped lines of the currently selected prompt. */
  private wrappedPreviewLines: string[] = [];
  /** Scroll offset into wrappedPreviewLines for the preview viewport. */
  private previewScrollOffset = 0;
  /**
   * Transient indexing progress (spec C6, design §D7). Status text ONLY:
   * records, filteredRecords, and every counter stay untouched while the
   * overlay is open. Declaration-initialized, so the constructor child
   * sequence (12 children) is unchanged.
   */
  private indexProgress: { processed: number; total: number } | null = null;

  /** Dispatch table: first match wins, fallthrough last. */
  private readonly dispatch: readonly DispatchEntry[] = [
    {
      match: (_d, kb) => kb.matches(_d, "tui.select.up"),
      handler: () => this.moveUp(),
    },
    {
      match: (_d, kb) => kb.matches(_d, "tui.select.down"),
      handler: () => this.moveDown(),
    },
    {
      match: (_d, kb) => kb.matches(_d, "tui.select.pageUp"),
      handler: () => this.pageListUp(),
    },
    {
      match: (_d, kb) => kb.matches(_d, "tui.select.pageDown"),
      handler: () => this.pageListDown(),
    },
    {
      match: (d, kb) => d === "\r" || kb.matches(d, "tui.select.confirm"),
      handler: () => this.selectCurrent(),
    },
    { match: (d, _kb) => d === "\t", handler: () => this.toggleScope() },
    {
      match: (_d, kb) => kb.matches(_d, "tui.select.cancel"),
      handler: () => this.onCancel(),
    },
    {
      match: (d, _kb) => matchesKey(d, "home"),
      handler: () => this.jumpToFirst(),
    },
    {
      match: (d, _kb) => matchesKey(d, "end"),
      handler: () => this.jumpToLast(),
    },
    {
      match: (d, _kb) => matchesKey(d, "ctrl+shift+backspace"),
      handler: () => this.deleteCurrent(),
    },
    {
      match: (d, _kb) => matchesKey(d, "ctrl+shift+up"),
      handler: () => this.previewPageUp(),
    },
    {
      match: (d, _kb) => matchesKey(d, "ctrl+shift+down"),
      handler: () => this.previewPageDown(),
    },
  ];

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(
    tui: TUI,
    theme: Theme,
    records: PromptRecord[],
    onSelect: (record: PromptRecord) => void,
    onCancel: () => void,
    private readonly onNotify?: SelectorNotify,
  ) {
    super();

    this.tui = tui;
    this.theme = theme;
    this.records = records;
    this.loadedCount = initialLoadedCount(records.length, INITIAL_BATCH);
    this.onSelect = onSelect;
    this.onCancel = onCancel;

    // ── Search panel (top) ──
    this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    this.headerRow = new FixedRowText(
      theme.fg("accent", theme.bold(" History Search ")),
    );
    this.addChild(this.headerRow);
    this.addChild(
      new Text(
        theme.fg("dim", "Type to filter (multi-word AND substring, case-insensitive)"),
        0,
        0,
      ),
    );
    this.searchInput = new Input();
    this.searchInput.onSubmit = () => this.selectCurrent();
    this.searchInput.onEscape = () => this.onCancel();
    this.addChild(this.searchInput);
    this.addChild(new DynamicBorder((s: string) => theme.fg("dim", s)));

    this.listContainer = new Container();
    this.addChild(this.listContainer);

    // ── Preview panel (bottom) ──
    this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    this.previewLabelRow = new FixedRowText(
      theme.fg("accent", theme.bold(" Preview ")),
    );
    this.addChild(this.previewLabelRow);
    this.previewContainer = new Container();
    this.addChild(this.previewContainer);

    this.addChild(new DynamicBorder((s: string) => theme.fg("dim", s)));
    this.addChild(
      new FixedRowText(
        theme.fg(
          "dim",
          "↑↓ move • PgUp/PgDn page • tab scope • enter select and quit • ctrl+shift+↑/↓ preview • ctrl+shift+backspace delete • esc cancel",
        ),
        true /* centered */,
      ),
    );
    this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    this.applyFilter("");
  }

  // -- Filtering & list building ------------------------------------------

  private applyFilter(query: string): void {
    // AC-L2-3r (user-directed 2026-09-08): a non-empty query implies
    // full-snapshot visibility — one-shot and idempotent, never a batch —
    // so per-keypress incremental loads remain impossible (C2).
    this.loadedCount = loadedCountForQuery(
      this.loadedCount,
      this.records.length,
      query,
    );
    this.filteredRecords = filterPrompts(
      this.records.slice(0, this.loadedCount),
      query,
    );
    this.selectedIndex = clampSelectedIndex(
      this.selectedIndex,
      this.filteredRecords.length,
    );
    this.previewScrollOffset = 0;
    this.rebuildList();
    this.rebuildPreview();
  }

  private rebuildList(): void {
    this.rebuildListWithWidth(this.lastWidth);
  }

  /** Rebuild list rows: header counter + entries. Always MAX_VISIBLE rows. */
  private rebuildListWithWidth(width: number): void {
    const count = this.filteredRecords.length;
    const position = count === 0 ? 0 : this.selectedIndex + 1;
    this.headerRow.setText(
      this.theme.fg("accent", this.theme.bold(" History Search ")) +
        this.theme.fg("dim", ` · ${position} of ${count} `) +
        this.theme.fg(
          "dim",
          ` · loaded ${this.loadedCount} of ${this.records.length} `,
        ) +
        // Right-aligned scope radio: pad from plain-text lengths so the
        // radio ends flush at the header's last column at any width.
        (() => {
          const scopeRadio =
            this.scope === "project"
              ? "◉ Current project | ○ All projects"
              : "○ Current project | ◉ All projects";
          const leftWidth =
            " History Search ".length +
            ` · ${position} of ${count} `.length +
            ` · loaded ${this.loadedCount} of ${this.records.length} `.length;
          return (
            " ".repeat(Math.max(1, width - leftWidth - scopeRadio.length)) +
            this.theme.fg("dim", scopeRadio)
          );
        })(),
    );
    this.listContainer.clear();

    if (count === 0) {
      this.listContainer.addChild(
        new FixedRowText(this.theme.fg("warning", "No matching prompts")),
      );
      for (let i = 1; i < MAX_VISIBLE; i++) {
        this.listContainer.addChild(new FixedRowText());
      }
      return;
    }

    const entryMax = Math.floor(width * 0.95) - ENTRY_PREFIX_WIDTH;

    const visible = getVisiblePromptRecords(
      this.filteredRecords,
      this.selectedIndex,
      MAX_VISIBLE,
    );

    for (const { record, isSelected } of visible) {
      const prefix = isSelected ? "→ " : "  ";
      const color = isSelected ? "accent" : "text";
      const compacted = sanitizeForDisplay(record.text)
        .replace(/\s+/g, " ")
        .trim();
      const truncated = truncateToWidth(compacted, entryMax, "…");
      const line = prefix + this.theme.fg(color, truncated);
      this.listContainer.addChild(new FixedRowText(line));
    }

    for (let i = visible.length; i < MAX_VISIBLE; i++) {
      this.listContainer.addChild(new FixedRowText());
    }
  }

  /**
   * Rebuild preview: word-wrap the full selected prompt text and show
   * a PREVIEW_ROWS-tall viewport starting at previewScrollOffset.
   * Content starts immediately below the "Preview" label (no top padding).
   * PgUp/PgDn scroll through the wrapped lines.
   */
  private rebuildPreviewWithWidth(width: number): void {
    this.previewContainer.clear();

    const wrapWidth = Math.max(1, width - 2);
    const selected = this.filteredRecords[this.selectedIndex];
    if (selected) {
      const safeText = sanitizeForDisplay(selected.text);
      this.wrappedPreviewLines = wordWrapText(safeText, wrapWidth);
      this.previewScrollOffset = clampPreviewOffset(
        this.previewScrollOffset,
        this.wrappedPreviewLines.length,
        PREVIEW_ROWS,
      );
    } else {
      this.wrappedPreviewLines = [];
      this.previewScrollOffset = 0;
    }

    // P1-3 indicator: fresh wrap is known here — one update site covers all
    // paths; the label appends the 1-based range only when content overflows.
    this.previewLabelRow.setText(this.previewLabelRowText());

    for (let i = 0; i < PREVIEW_ROWS; i++) {
      const lineIdx = this.previewScrollOffset + i;
      if (lineIdx < this.wrappedPreviewLines.length) {
        // Pad the plain text to wrapWidth so FixedRowText.render()
        // never truncates — the visible width is always ≤ width-2.
        const raw = this.wrappedPreviewLines[lineIdx];
        const padded = raw + " ".repeat(Math.max(0, wrapWidth - raw.length));
        this.previewContainer.addChild(
          new FixedRowText(this.theme.fg("text", padded)),
        );
      } else {
        this.previewContainer.addChild(new FixedRowText());
      }
    }
  }

  /** " Preview " label; appends the 1-based visible range only on overflow. */
  private previewLabelRowText(): string {
    const total = this.wrappedPreviewLines.length;
    if (total <= PREVIEW_ROWS) {
      return this.theme.fg("accent", this.theme.bold(" Preview "));
    }
    const start = this.previewScrollOffset + 1;
    const end = Math.min(this.previewScrollOffset + PREVIEW_ROWS, total);
    return this.theme.fg(
      "accent",
      this.theme.bold(` Preview — ${start}–${end}/${total} `),
    );
  }

  private rebuildPreview(): void {
    this.rebuildPreviewWithWidth(this.lastWidth);
  }

  /**
   * Transient indexing suffix update (spec C6, design §D7): clears at
   * processed >= total and repaints the header text. Zero rows, zero
   * geometry movement — OVERLAY_LINES is untouched.
   */
  notifyIndexProgress(processed: number, total: number): void {
    this.indexProgress = processed >= total ? null : { processed, total };
    this.rebuildList();
  }

  // -- Selection actions --------------------------------------------------

  private selectCurrent(): void {
    const selected = this.filteredRecords[this.selectedIndex];
    if (selected) this.onSelect(selected);
  }

  /**
   * Toggle project <-> global (design v2): re-drain the other scope,
   * rebuild the merged records, reset the window. Tab's only role.
   */
  private toggleScope(): void {
    this.scope = this.scope === "project" ? "global" : "project";
    const entries = drainForScope(this.scope);
    this.records = recordsFromEntries(entries);
    this.loadedCount = initialLoadedCount(this.records.length, INITIAL_BATCH);
    this.applyFilter(this.searchInput.getValue());
  }

  /** Delete the currently selected prompt from disk and refresh the list. */
  private deleteCurrent(): void {
    const selected = this.filteredRecords[this.selectedIndex];
    if (!selected) return;

    // C4 delete flows (design §F): the record's provenance decides the
    // actions via the pure planner; module constants are used directly.
    const actions = deletionActionsFor(selected.source ?? "editor");

    if (actions.deleteFromEditorStore) {
      // Store path: physically remove EVERY copy from the JSONL store
      // (memory + file in one atomic rewrite).
      const { removed } =
        this.scope === "global"
          ? deleteFromGlobal(PI_HISTORY_ROOT, selected.text)
          : deleteFromProject(PI_HISTORY_ROOT, CURRENT_CWD, selected.text);
      if (removed === 0) return;
    }

    // Tombstone ALWAYS: the session transcripts are immutable and would
    // re-supply the deleted prompt on the next merge (hide-file suppresses
    // the twin). Only the session path aborts on a hide error — the store
    // row is already gone on the editor path, so the splice proceeds.
    const hide = hidePrompt(PI_HISTORY_NAV_STATE_DIR, selected.text);
    if (hide.status === "error") {
      this.onNotify?.(hide.message, "error");
      if (!actions.deleteFromEditorStore) {
        return;
      }
    }
    // Remove from the master records array so a subsequent filter doesn't
    // bring it back.
    const idx = this.records.indexOf(selected);
    if (idx !== -1) {
      this.records.splice(idx, 1);
      // C4 delete backfill (design §B3): shrink the window with the splice,
      // then pull the next unloaded row while any remain — genuine shrink
      // only at exhaustion.
      this.loadedCount = loadedCountAfterDelete(
        this.loadedCount,
        this.records.length,
      );
    }

    // Re-apply current filter (rebuilds filteredRecords, list, preview).
    this.applyFilter(this.searchInput.getValue());
  }

  // -- Navigation ---------------------------------------------------------

  private moveUp(): void {
    this.selectedIndex = moveSelectedIndex(
      this.selectedIndex,
      this.filteredRecords.length,
      -1,
    );
    if (
      shouldGrowWindow(
        this.selectedIndex,
        this.loadedCount,
        this.records.length,
        PRELOAD_BUFFER,
      )
    ) {
      this.loadedCount = nextLoadedCount(
        this.loadedCount,
        this.records.length,
        BATCH_SIZE,
      );
      this.applyFilter(this.searchInput.getValue());
    }
    this.previewScrollOffset = 0;
    this.rebuildList();
    this.rebuildPreview();
  }

  private moveDown(): void {
    // Grow-before-move (design §D1): the C2 trigger fires while the cursor
    // sits in the final PRELOAD_BUFFER rows of the loaded window, so the
    // modulo below moves into freshly loaded rows — a wrap to index 0 is
    // reachable only on the exhausted set.
    if (
      shouldGrowWindow(
        this.selectedIndex,
        this.loadedCount,
        this.records.length,
        PRELOAD_BUFFER,
      )
    ) {
      this.loadedCount = nextLoadedCount(
        this.loadedCount,
        this.records.length,
        BATCH_SIZE,
      );
      this.applyFilter(this.searchInput.getValue());
    }
    this.selectedIndex = moveSelectedIndex(
      this.selectedIndex,
      this.filteredRecords.length,
      1,
    );
    this.previewScrollOffset = 0;
    this.rebuildList();
    this.rebuildPreview();
  }

  /** Page the LIST up by MAX_VISIBLE with clamping (no wrap). */
  private pageListUp(): void {
    this.selectedIndex = pageSelectedIndex(
      this.selectedIndex,
      this.filteredRecords.length,
      -MAX_VISIBLE,
    );
    this.previewScrollOffset = 0;
    this.rebuildList();
    this.rebuildPreview();
  }

  /** Page the LIST down by MAX_VISIBLE with clamping (no wrap). */
  private pageListDown(): void {
    // PgDn catch-up (design §D7): grow in whole batches until the paged-to
    // row is loaded BEFORE the selection lands on it.
    const grown = loadedCountForTarget(
      this.loadedCount,
      this.records.length,
      this.selectedIndex + MAX_VISIBLE,
      BATCH_SIZE,
    );
    if (grown !== this.loadedCount) {
      this.loadedCount = grown;
      this.applyFilter(this.searchInput.getValue());
    }
    this.selectedIndex = pageSelectedIndex(
      this.selectedIndex,
      this.filteredRecords.length,
      MAX_VISIBLE,
    );
    this.previewScrollOffset = 0;
    this.rebuildList();
    this.rebuildPreview();
  }

  private previewPageUp(): void {
    this.previewScrollOffset = Math.max(
      0,
      this.previewScrollOffset - PREVIEW_ROWS,
    );
    this.rebuildPreview();
  }

  private previewPageDown(): void {
    this.previewScrollOffset = clampPreviewOffset(
      this.previewScrollOffset + PREVIEW_ROWS,
      this.wrappedPreviewLines.length,
      PREVIEW_ROWS,
    );
    this.rebuildPreview();
  }

  private jumpToFirst(): void {
    if (this.filteredRecords.length === 0) return;
    this.selectedIndex = 0;
    this.previewScrollOffset = 0;
    this.rebuildList();
    this.rebuildPreview();
  }

  private jumpToLast(): void {
    // End full-jump (design §D7): one-shot load of everything BEFORE the
    // empty guard, so End also surfaces matches beyond the window.
    if (this.loadedCount < this.records.length) {
      this.loadedCount = this.records.length;
      this.applyFilter(this.searchInput.getValue());
    }
    if (this.filteredRecords.length === 0) return;
    this.selectedIndex = this.filteredRecords.length - 1;
    this.previewScrollOffset = 0;
    this.rebuildList();
    this.rebuildPreview();
  }

  // -- Input handling -----------------------------------------------------

  private forwardToSearch(data: string): void {
    this.searchInput.handleInput(data);
    this.selectedIndex = 0;
    this.applyFilter(this.searchInput.getValue());
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    let handled = false;
    for (const { match, handler } of this.dispatch) {
      if (match(data, kb)) {
        handler();
        handled = true;
        break;
      }
    }
    if (!handled) this.forwardToSearch(data);
    this.tui.requestRender();
  }

  // -- Mouse (wheel-only) -------------------------------------------------

  /**
   * Wheel-only mouse handling over the fixed 30-row geometry (design
   * §D6). Non-wheel events stay host-owned (undefined = Container child
   * dispatch); EVERY wheel path — including the no-op regions — reaches
   * the single consumed return, closing the pre-existing SGR-fallthrough
   * hazard where raw wheel bytes were typed into the search box.
   */
  override handleMouse(
    event: TuiMouseEvent,
  ): ReturnType<Container["handleMouse"]> {
    if (event.type !== "wheel") return undefined;
    const delta = event.wheelDelta ?? 0;
    if (event.y >= LIST_WHEEL_Y_FIRST && event.y <= LIST_WHEEL_Y_LAST) {
      const steps = Math.min(Math.abs(delta), this.filteredRecords.length);
      for (let i = 0; i < steps; i++) {
        if (delta > 0) this.moveDown();
        else this.moveUp();
      }
    } else if (
      event.y >= PREVIEW_WHEEL_Y_FIRST &&
      event.y <= PREVIEW_WHEEL_Y_LAST
    ) {
      if (delta !== 0) {
        this.previewScrollOffset = clampPreviewOffset(
          this.previewScrollOffset + (delta > 0 ? 1 : -1),
          this.wrappedPreviewLines.length,
          PREVIEW_ROWS,
        );
        this.rebuildPreview();
      }
    }
    return {
      handled: true,
      target: {
        component: this,
        originX: event.screenX - event.x,
        originY: event.screenY - event.y,
        width: event.width,
        height: event.height,
      },
    };
  }

  // -- Render override for dynamic entry width ---------------------------

  /** Fixed overlay height so the TUI never repositions the panel. */
  private static readonly OVERLAY_LINES = 30;

  override render(width: number): string[] {
    if (width !== this.lastWidth) {
      // Pre-clamp against the previous wrap so a width change can never
      // drive the rebuilds with a stale selection/offset (AC-P1-4.1/4.2).
      this.selectedIndex = clampSelectedIndex(
        this.selectedIndex,
        this.filteredRecords.length,
      );
      this.previewScrollOffset = clampPreviewOffset(
        this.previewScrollOffset,
        this.wrappedPreviewLines.length,
        PREVIEW_ROWS,
      );
    }
    this.lastWidth = width;
    this.rebuildListWithWidth(width);
    this.rebuildPreviewWithWidth(width);
    const raw = super.render(width);
    // Pad or trim to exactly OVERLAY_LINES so the overlay never shifts.
    const blank = " ".repeat(Math.max(1, width));
    while (raw.length < PromptHistorySelector.OVERLAY_LINES) raw.push(blank);
    return raw.slice(0, PromptHistorySelector.OVERLAY_LINES);
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

type SelectorDone = (result: PromptRecord | null) => void;

type SelectorFactory = (
  tui: unknown,
  theme: unknown,
  keybindings: unknown,
  done: SelectorDone,
) => PromptHistorySelector;

function castSelectorArgs(tui: unknown, theme: unknown): [TUI, Theme] {
  return [tui as TUI, theme as Theme];
}

/** Stored close callback for the currently-open overlay. Null when closed. */
let activeOverlayClose: (() => void) | null = null;

/**
 * Progress sink for the background index build (spec C6, design §D7): set by
 * the selector factory beside activeOverlayClose, nulled in finish. Status
 * text only — merged records and counters are never swapped mid-open.
 */
let activeIndexProgressNotify:
  | ((processed: number, total: number) => void)
  | null = null;

function createPromptHistorySelectorFactory(
  records: PromptRecord[],
  onNotify?: SelectorNotify,
): SelectorFactory {
  return (tui, theme, _keybindings, done) => {
    selectorTui = tui as { requestRender(): void };
    const finish = (result: PromptRecord | null) => {
      activeOverlayClose = null;
      activeIndexProgressNotify = null;
      done(result);
    };
    // Expose close so the tool_call handler can dismiss the overlay.
    activeOverlayClose = () => finish(null);
    const [typedTui, typedTheme] = castSelectorArgs(tui, theme);
    const selector = new PromptHistorySelector(
      typedTui,
      typedTheme,
      records,
      (record) => finish(record),
      () => finish(null),
      onNotify,
    );
    // Wire the transient indexing suffix (design §D7): the live
    // selector's header is the only consumer; finish() nulls the sink.
    activeIndexProgressNotify = (processed, total) =>
      selector.notifyIndexProgress(processed, total);
    return selector;
  };
}

async function runPromptHistorySelection(
  ctx: ShortcutContext,
  records: PromptRecord[],
): Promise<PromptRecord | null> {
  const historyGlobals: PiHistoryGlobals = globalThis as Record<
    string,
    unknown
  >;
  return withExpandedHistoryGlobals(historyGlobals, async () =>
    ctx.ui.custom<PromptRecord | null>(
      createPromptHistorySelectorFactory(records, (message, level) =>
        ctx.ui.notify(message, level),
      ),
      {
        overlay: true,
        overlayOptions: { anchor: "bottom-center", width: "100%", offsetY: 5 },
      },
    ),
  );
}

/** Shared entry point for the ctrl+shift+r shortcut and the /history command. */
// ---------------------------------------------------------------------------
// Multi-concurrency store (v2): per-session writes, scope drains
// ---------------------------------------------------------------------------

type HistoryScope = "project" | "global";

/** TUI handle captured when the selector overlay mounts. */
let selectorTui: { requestRender(): void } | null = null;

let writerState: SessionWriterState | null = null;

/**
 * One-time init per extension load: migrate legacy stores, register the
 * project, bootstrap the seed, then open this instance's exclusive file.
 */
function getWriter(): SessionWriterState {
  if (!writerState) {
    try {
      migrateLegacyStores(PI_HISTORY_ROOT, AGENT_DIR);
    } catch {
      // migration is best-effort; the gate keeps it one-shot
    }
    try {
      ensureRegistryEntry(PI_HISTORY_ROOT, CURRENT_CWD);
    } catch {
      // registry is advisory
    }
    try {
      bootstrapProjectSeed(
          PI_HISTORY_ROOT,
          CURRENT_CWD,
          SESSIONS_ROOT,
          500,
          PI_HISTORY_NAV_STATE_DIR,
        );
    } catch {
      // bootstrap is a rebuildable cache
    }
    writerState = openSessionWriter(PI_HISTORY_ROOT, CURRENT_CWD, INSTANCE_ID);
  }
  return writerState;
}

/**
 * Scope drain for the selector: project scope merges the project's store
 * files with the live session-index view; global scope is the store-only
 * cross-project view (all project dirs + the legacy global seed).
 */
function drainForScope(scope: HistoryScope): string[] {
  getWriter(); // ensure init ran
  return scope === "project"
    ? drainProject(PI_HISTORY_ROOT, CURRENT_CWD, 1000, PI_HISTORY_NAV_STATE_DIR)
    : drainGlobal(PI_HISTORY_ROOT, 1000, PI_HISTORY_NAV_STATE_DIR);
}

async function openHistorySelector(
  ctx: Pick<ShortcutContext, "ui">,
): Promise<void> {
  // Store-only drain (user-directed): both scopes read the store files
  // symmetrically — no live transcript merge (the one-time seed bootstrap
  // covers pre-store history).
  const entries = drainForScope("project");
  if (entries.length === 0) {
    ctx.ui.notify("No prompt history available.", "warning");
    return;
  }

  const records = recordsFromEntries(entries);
  const selected = await runPromptHistorySelection(ctx, records);
  if (selected) {
    // pasteToEditor routes through the editor's input pipeline
    // (bracketed paste), so the text renders immediately. Plain
    // setText left the editor stale until the next keypress after
    // overlay close.
    ctx.ui.pasteToEditor(selected.text);
    // The overlay teardown can race the paste render: force one more
    // frame on the next tick so the editor box shows the text at once.
    setTimeout(() => selectorTui?.requestRender(), 0);
  }
}

/** Build selector records from merged/drain entries (shared by both scopes). */
function recordsFromEntries(
  entries: Array<string | PromptEntry>,
): PromptRecord[] {
  return buildPromptRecords(dedupePromptEntries(entries));
}

export default function promptHistoryExtension(pi: ExtensionAPI) {
  // One writer per extension load; see getWriter() for the init order.

  // Persist every delivered user prompt (write-through, append-only JSONL).
  // The local ExtensionAPI stub types handler args as unknown; narrow here.
    pi.on("before_agent_start", (...args: unknown[]) => {
    try {
      const event = args[0] as { prompt?: string } | undefined;
      appendSessionCapture(getWriter(), event?.prompt ?? "", Date.now());
    } catch {
      // A capture failure must never break the agent loop or unregister
      // the handler - swallow and keep the next prompt capturable.
    }
  });

  // Backup pass: enforce the 1000-line limit on graceful shutdown.
    pi.on("session_shutdown", () => {
    try {
      gcProjectDir(PI_HISTORY_ROOT, CURRENT_CWD);
    } catch {
      // GC is best-effort
    }
  });

  // When a tool asks for user input while the history overlay is open,
  // dismiss the overlay so the tool can take over the UI.
  pi.on("tool_call", () => {
    activeOverlayClose?.();
  });

  pi.registerShortcut(SHORTCUT, {
    description: "Search prompt history",
    handler: async (ctx) => openHistorySelector(ctx),
  });

  pi.registerCommand("history", {
    description: "Search prompt history",
    handler: async (_args, ctx) => openHistorySelector(ctx),
  });
}
