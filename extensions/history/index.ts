// SPDX-FileCopyrightText: 2026 ExoPro. Inspired by @jasonish/pi-prompt-history
// SPDX-License-Identifier: MIT

// Prompt-history extension entry: the selector open flow over the slice-1
// writer and slice-2 drains, with the search input (filterPrompts +
// forwardToSearch fallthrough), the lazy loaded window, the project<->global
// scope toggle, the preview panel + wheel handling, the slice-4 import
// (legacy migration + seed bootstrap inside getWriter), the slice-5
// modal delete (store sweep + exact tombstone), and the slice-6
// session_shutdown GC/compaction.
//
// Capture is OPT-IN: nothing is recorded unless
// GENTLE_PI_HISTORY_CAPTURE=1|true|on. The selector honors the same gate:
// with the switch off, opening the selector is a no-op — no registry entry,
// no writer init, no store reads, no deletes. Unsetting the switch only
// stops NEW captures; files already written stay on disk
// (docs/prompt-history.md).

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  getKeybindings,
  Input,
  matchesKey,
  stripTerminalSequences,
  Text,
  type TUI,
  type TuiMouseEvent,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { hidePrompt } from "./hide-prompts.ts";
import {
  appendSessionCapture,
  bootstrapProjectSeed,
  deleteFromGlobal,
  deleteFromProject,
  type DrainResult,
  drainGlobal,
  drainProject,
  ensureRegistryEntry,
  gcProjectDir,
  migrateLegacyStores,
  openSessionWriter,
  type SessionWriterState,
  sessionFilePath,
  type SweepResult,
} from "./store.ts";
import {
  buildPromptRecords,
  clampPreviewOffset,
  clampSelectedIndex,
  dedupePromptEntries,
  deleteConfirmFooterText,
  deleteConfirmStep,
  deletionActionsFor,
  EDITOR_HIDE_FAILED_TEXT,
  filterPrompts,
  getVisiblePromptRecords,
  initialLoadedCount,
  loadedCountAfterDelete,
  loadedCountForQuery,
  loadedCountForTarget,
  moveSelectedIndex,
  nextLoadedCount,
  pageSelectedIndex,
  shouldGrowWindow,
  STORE_DELETE_FAILED_TEXT,
  storeDeleteFollowUp,
  withExpandedHistoryGlobals,
  type PiHistoryGlobals,
  type PromptEntry,
  type PromptRecord,
} from "./selector-helpers.ts";

const SHORTCUT = "ctrl+shift+r";
const MAX_VISIBLE = 10;
const PREVIEW_ROWS = 10;
// Lazy windowing (design §D3; user-tuned 2026-09-08). PRELOAD_BUFFER=3
// fires growth as the cursor enters the final 3 loaded rows; BATCH_SIZE=10
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

// Default selector footer line (PR #1393): shown whenever a delete is not
// armed; the armed state swaps it for the confirmation copy.
const SELECTOR_FOOTER_HELP =
  "↑↓ move • PgUp/PgDn page • tab scope • enter select and quit • ctrl+shift+↑/↓ preview • ctrl+shift+backspace delete • esc cancel";

/** Width of the "→ " / "  " prefix on each entry line. */
const ENTRY_PREFIX_WIDTH = 2;

// Legacy agent dir: pre-v1 editor-history files live directly here and are
// migrated into the store root by migrateLegacyStores().
const AGENT_DIR = join(homedir(), ".pi", "agent");
// v2 multi-concurrency store root (design: tmp/multi-concurrency-design.md).
// It is also the tombstone state dir: <root>/hidden.json.
const PI_HISTORY_ROOT = join(AGENT_DIR, "history");
// Sessions root for the one-level transcript scan (spec C1, design §D5).
// Read-only by invariant — transcripts are never written by this extension.
const SESSIONS_ROOT = join(AGENT_DIR, "sessions");

export interface HistoryDeps {
  env?: NodeJS.ProcessEnv;
  root?: string;
  cwd?: string;
  instanceId?: string;
  now?: () => number;
  agentDir?: string;
  sessionsRoot?: string;
}

/**
 * Strict opt-in: capture stays off unless GENTLE_PI_HISTORY_CAPTURE is
 * explicitly 1, true, or on (case-insensitive). The same switch is the
 * disable path — unsetting it stops new captures; files already on disk
 * are left untouched (deletes run from the selector while capture is on).
 */
export function captureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.GENTLE_PI_HISTORY_CAPTURE?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

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
    const cp = text.codePointAt(i);
    if (cp === undefined) break;
    if (cp === 0x0a) {
      out += "\n";
    } else if (cp === 0x09) {
      out += "\t";
    } else if (cp < 0x20 || cp === 0x7f) {
      out += "\\x" + cp.toString(16).padStart(2, "0");
    } else if (cp >= 0x80 && cp < 0xa0) {
      out += "\\x" + cp.toString(16).padStart(2, "0");
    } else {
      // Astral code points (> 0xFFFF) span a surrogate pair; append the
      // full code point, not just the high surrogate at text[i], so emoji
      // and other non-BMP characters survive sanitization intact.
      out += cp > 0xffff ? String.fromCodePoint(cp) : text[i];
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

/**
 * Store access the open flow hands the selector (per-load deps root/cwd):
 * the selector never resolves store paths itself, so a bare constructor
 * (tests, tooling) cannot touch any store. `root` is also the tombstone
 * state dir (hidden.json); `drain` is the fail-closed scope drain.
 */
interface SelectorStore {
  root: string;
  cwd: string;
  drain: (scope: HistoryScope) => DrainResult;
}

/** Single rendered row; always occupies exactly one terminal row. */
class FixedRowText {
  private text: string;
  private readonly centered: boolean;

  constructor(text: string = "", centered = false) {
    this.text = text;
    this.centered = centered;
  }

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
          const visible = stripTerminalSequences(truncated);
          const pad = Math.max(0, Math.floor((width - visible.length) / 2));
          return " ".repeat(pad) + truncated;
        })()
      : truncateToWidth(this.text, width, "…");
    // Pad to full terminal width so the overlay fully overwrites
    // whatever is beneath it and leaves no ghost characters on dismiss.
    // Measure the VISIBLE width: SGR escape sequences (colored rows from
    // rebuildListWithWidth) occupy no terminal cells.
    const visible = rendered.replace(/\x1b\[[0-9;]*m/g, "");
    return [rendered + " ".repeat(Math.max(0, width - visible.length))];
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
  private readonly footerRow: FixedRowText;
  private records: PromptRecord[];
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly onSelect: (record: PromptRecord) => void;
  private readonly onCancel: () => void;
  /** Notification sink for selector feedback (wired by the factory). */
  private readonly onNotify?: SelectorNotify;
  /** Injected store access; null disables scope drains and deletes. */
  private readonly store: SelectorStore | null;
  private filteredRecords: PromptRecord[] = [];
  private selectedIndex = 0;
  /** Number of records loaded (newest-first) from the top of `records`. */
  private loadedCount = 0;
  /** Active scope (design v2): project (default) or global. */
  private scope: HistoryScope = "project";
  /** Last render width, used for entry truncation. */
  private lastWidth = 800;
  /** Word-wrapped lines of the currently selected prompt. */
  private wrappedPreviewLines: string[] = [];
  /** Scroll offset into wrappedPreviewLines for the preview viewport. */
  private previewScrollOffset = 0;
  /**
   * Modal delete confirmation (PR #1393 follow-up): armed by the first
   * ctrl+shift+backspace press; while armed, y executes, n/Esc cancels,
   * and every other key is swallowed. Nothing is deleted on the arming
   * press.
   */
  private confirmArmed = false;

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
    onNotify?: SelectorNotify,
    store?: SelectorStore,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.records = records;
    this.loadedCount = initialLoadedCount(records.length, INITIAL_BATCH);
    this.onSelect = onSelect;
    this.onCancel = onCancel;
    this.onNotify = onNotify;
    this.store = store ?? null;

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
    this.footerRow = new FixedRowText(
      theme.fg("dim", SELECTOR_FOOTER_HELP),
      true /* centered */,
    );
    this.addChild(this.footerRow);
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
      // Armed delete (PR #1393): the armed row repaints in the error color
      // while the confirmation is pending, then reverts on disarm.
      const color = isSelected
        ? this.confirmArmed
          ? "error"
          : "accent"
        : "text";
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

  // -- Selection actions --------------------------------------------------

  private selectCurrent(): void {
    const selected = this.filteredRecords[this.selectedIndex];
    if (selected) this.onSelect(selected);
  }

  /**
   * Toggle project <-> global (design v2): re-drain the other scope,
   * rebuild the records, reset the window. Tab's only role. Fail-closed
   * (slice-02 contract): a blocked drain keeps the working scope and
   * surfaces the recovery warning instead of a blocked (entry-less) list.
   */
  private toggleScope(): void {
    const previous = this.scope;
    this.scope = this.scope === "project" ? "global" : "project";
    const drained: DrainResult = this.store?.drain(this.scope) ?? {
      status: "ok",
      prompts: [],
    };
    if (drained.status === "blocked") {
      this.scope = previous;
      this.onNotify?.(drained.message, "error");
      return;
    }
    this.records = recordsFromEntries(drained.prompts);
    this.loadedCount = initialLoadedCount(this.records.length, INITIAL_BATCH);
    this.applyFilter(this.searchInput.getValue());
  }

  /**
   * Delete-combo entry (slice-05 D3): the FIRST press arms the modal
   * confirm for the selected row; while armed, the modal router in
   * handleInput calls executeDelete() on `y`. Session-derived rows are
   * read-only (slice-05 D1): a delete press on one is a silent no-op.
   */
  private deleteCurrent(): void {
    const selected = this.filteredRecords[this.selectedIndex];
    if (!selected) return;

    // Session rows are read-only: session transcripts are immutable and
    // owned by Pi core — the extension never deletes from or writes to
    // them. Silent no-op: no arm, no footer change, no tombstone.
    if ((selected.source ?? "editor") === "session") return;

    if (!this.confirmArmed) {
      this.armDelete();
      return;
    }
    this.executeDelete();
  }

  /** Arm the confirm: footer copy + error-colored row, nothing executes. */
  private armDelete(): void {
    this.confirmArmed = true;
    this.refreshDeleteFooter();
    this.rebuildList(); // repaint the armed-row highlight
  }

  /** The executing half of the delete: leave the armed state, then mutate. */
  private executeDelete(): void {
    // Leave the armed state first: help footer back, highlight dropped.
    this.confirmArmed = false;
    this.refreshDeleteFooter();
    this.rebuildList(); // drop the highlight before the flow mutates rows

    const selected = this.filteredRecords[this.selectedIndex];
    if (!selected || !this.store) return;
    const { root, cwd } = this.store;

    // C4 delete flows (design §F): the record's provenance decides the
    // actions via the pure planner over the injected store root/cwd.
    const actions = deletionActionsFor(selected.source ?? "editor");

    if (actions.deleteFromEditorStore) {
      // Store path: physically remove EVERY copy from the JSONL store, one
      // atomic rewrite per file. A thrown store failure is contained here
      // (PR #1393): toast + abort — nothing was removed and no tombstone is
      // written, so the delete never lies about state.
      let sweep: SweepResult;
      try {
        sweep =
          this.scope === "global"
            ? deleteFromGlobal(root, selected.text)
            : deleteFromProject(root, cwd, selected.text);
      } catch {
        this.onNotify?.(STORE_DELETE_FAILED_TEXT, "error");
        return;
      }
      // Files that could not be read or rewritten may still hold a copy:
      // say so, and still write the tombstone that hides them.
      const followUp = storeDeleteFollowUp(sweep);
      if (followUp.notice) this.onNotify?.(followUp.notice, "error");
      if (!followUp.proceed) return;
    }

    // Tombstone ALWAYS: the session transcripts are immutable and would
    // re-supply the deleted prompt on the next merge (hide-file suppresses
    // the twin). Only the session path aborts on a hide error — the store
    // row is already gone on the editor path, so the splice proceeds; its
    // toast says exactly that (PR #1393).
    const hide = hidePrompt(root, selected.text);
    if (hide.status === "error") {
      if (!actions.deleteFromEditorStore) {
        this.onNotify?.(hide.message, "error");
        return;
      }
      this.onNotify?.(EDITOR_HIDE_FAILED_TEXT, "error");
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

  /** Footer line: confirm copy while armed, help otherwise. */
  private refreshDeleteFooter(): void {
    if (!this.confirmArmed) {
      this.footerRow.setText(this.theme.fg("dim", SELECTOR_FOOTER_HELP));
      return;
    }
    this.footerRow.setText(
      this.theme.fg("warning", deleteConfirmFooterText()),
    );
  }

  /** Leave the armed state: restore the help footer and the plain row. */
  private disarmDeleteConfirm(): void {
    this.confirmArmed = false;
    this.refreshDeleteFooter();
    this.rebuildList();
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
    // Modal armed confirm (slice-05 D3): while a delete is armed the pure
    // router consumes EVERY key — y executes, n/Esc cancels (esc must NOT
    // close the overlay here), anything else stays armed and is swallowed
    // — so no key reaches the dispatch table or the search input. When not
    // armed, behavior is unchanged.
    if (this.confirmArmed) {
      const step = deleteConfirmStep(
        this.confirmArmed,
        matchesKey(data, "ctrl+shift+backspace"),
        matchesKey(data, "escape"),
        data,
      );
      if (step.execute) this.executeDelete();
      else if (step.cancel) this.disarmDeleteConfirm();
      this.tui.requestRender();
      return;
    }
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
    // A wheel scroll can move the selection off the armed row — disarm so
    // the next delete press re-arms for the NEW row first (PR #1393).
    if (this.confirmArmed) this.disarmDeleteConfirm();
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
// Overlay glue
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

/** TUI handle captured when the selector overlay mounts. */
let selectorTui: { requestRender(): void } | null = null;

/** Stored close callback for the currently-open overlay. Null when closed. */
let activeOverlayClose: (() => void) | null = null;

function createPromptHistorySelectorFactory(
  records: PromptRecord[],
  onNotify?: SelectorNotify,
  store?: SelectorStore,
): SelectorFactory {
  return (tui, theme, _keybindings, done) => {
    selectorTui = tui as { requestRender(): void };
    const finish = (result: PromptRecord | null) => {
      activeOverlayClose = null;
      done(result);
    };
    // Expose close so the tool_call handler can dismiss the overlay.
    activeOverlayClose = () => finish(null);
    const [typedTui, typedTheme] = castSelectorArgs(tui, theme);
    return new PromptHistorySelector(
      typedTui,
      typedTheme,
      records,
      (record) => finish(record),
      () => finish(null),
      onNotify,
      store,
    );
  };
}

async function runPromptHistorySelection(
  ctx: Pick<ExtensionCommandContext, "ui">,
  records: PromptRecord[],
  store?: SelectorStore,
): Promise<PromptRecord | null> {
  const historyGlobals: PiHistoryGlobals = globalThis as Record<
    string,
    unknown
  >;
  return withExpandedHistoryGlobals(historyGlobals, async () =>
    ctx.ui.custom<PromptRecord | null>(
      createPromptHistorySelectorFactory(
        records,
        (message, level) => ctx.ui.notify(message, level),
        store,
      ),
      {
        overlay: true,
        overlayOptions: { anchor: "bottom-center", width: "100%", offsetY: 5 },
      },
    ),
  );
}

/** Build selector records from drain entries (shared by both scopes). */
function recordsFromEntries(
  entries: Array<string | PromptEntry>,
): PromptRecord[] {
  return buildPromptRecords(dedupePromptEntries(entries));
}

// ---------------------------------------------------------------------------
// Open flow: capture gate → fail-closed drain → records → overlay
// ---------------------------------------------------------------------------

type HistoryScope = "project" | "global";

/**
 * Per-load open flow over the slice-1 deps (env/root/cwd): the selector is
 * a pure store reader plus the explicit delete action, so it never
 * initializes the capture writer — the capture gate in openHistorySelector
 * runs before any store access and a capture-off session performs no
 * registry/writer/delete side effects on the open path.
 */
function createOpenFlow(env: NodeJS.ProcessEnv, root: string, cwd: string) {
  /**
   * Scope drain for the selector: project scope drains the project's store
   * files; global scope is the store-only cross-project view (all project
   * dirs + the legacy global seed). Both apply the fail-closed tombstone
   * filter — the state dir is the store root itself (hidden.json contract).
   * The DrainResult is returned verbatim: `blocked` must stop the open flow
   * before any records build, and the selector's scope toggle surfaces it.
   */
  function drainForScope(scope: HistoryScope): DrainResult {
    return scope === "project"
      ? drainProject(root, cwd, 1000, root)
      : drainGlobal(root, 1000, root);
  }

  const store: SelectorStore = { root, cwd, drain: drainForScope };

  async function openHistorySelector(
    ctx: Pick<ExtensionCommandContext, "ui">,
  ): Promise<void> {
    // Capture gate (#1390) FIRST: with capture off the selector is a no-op —
    // no registry writes, no writer init, no store reads, no overlay.
    if (!captureEnabled(env)) {
      ctx.ui.notify(
        "Prompt history is disabled (GENTLE_PI_HISTORY_CAPTURE is not set).",
        "warning",
      );
      return;
    }

    // Store-only drain (user-directed): the selector reads the store files —
    // no live transcript merge. `blocked` (untrusted hidden.json) fails
    // CLOSED: surface the recovery message and stop before building records.
    const drained = drainForScope("project");
    if (drained.status === "blocked") {
      ctx.ui.notify(drained.message, "error");
      return;
    }
    const entries = drained.prompts;
    if (entries.length === 0) {
      // a22588fc empty-store policy: no history warns and skips the overlay.
      // A later slice changes this, not this one.
      ctx.ui.notify("No prompt history available.", "warning");
      return;
    }

    const records = recordsFromEntries(entries);
    const selected = await runPromptHistorySelection(ctx, records, store);
    if (selected) {
      // pasteToEditor routes through the editor's input pipeline (bracketed
      // paste), so the text renders immediately (a22588fc).
      ctx.ui.pasteToEditor(selected.text);
      // The overlay teardown can race the paste render: force one more
      // frame on the next tick so the editor box shows the text at once.
      setTimeout(() => selectorTui?.requestRender(), 0);
    }
  }

  return { openHistorySelector };
}

export default function promptHistoryExtension(
  pi: ExtensionAPI,
  deps: HistoryDeps = {},
): void {
  const env = deps.env ?? process.env;
  const root = deps.root ?? PI_HISTORY_ROOT;
  const cwd = deps.cwd ?? process.cwd();
  const instanceId = deps.instanceId ?? randomUUID();
  const now = deps.now ?? Date.now;
  const agentDir = deps.agentDir ?? AGENT_DIR;
  const sessionsRoot = deps.sessionsRoot ?? SESSIONS_ROOT;
  let writerState: SessionWriterState | null = null;

  /**
   * One-time init per extension load: migrate legacy stores, register the
   * project, bootstrap the seed, then open this instance's exclusive file.
   */
  const getWriter = (): SessionWriterState => {
    if (!writerState) {
      try {
        migrateLegacyStores(root, agentDir);
      } catch {
        // migration is best-effort; the gate keeps it one-shot
      }
      try {
        ensureRegistryEntry(root, cwd);
      } catch {
        // registry is advisory
      }
      try {
        bootstrapProjectSeed(
          root,
          cwd,
          sessionsRoot,
          500,
          root,
        );
      } catch {
        // bootstrap is a rebuildable cache
      }
      writerState = openSessionWriter(root, cwd, instanceId);
    }
    return writerState;
  };

  // Warm migrate/registry/seed OFF the first-prompt path, but only for
  // opted-in sessions: with capture disabled nothing may be written —
  // no registry entry, no seed files, no store (docs/prompt-history.md).
  setImmediate(() => {
    if (!captureEnabled(env)) return;
    try {
      getWriter();
    } catch {
      // init is best-effort; the lazy path retries on the next prompt
    }
  });

  // Persist every delivered user prompt (write-through, append-only JSONL),
  // but only for opted-in sessions — see captureEnabled(). The local
  // ExtensionAPI stub types handler args as unknown; narrow here.
  pi.on("before_agent_start", (...args: unknown[]) => {
    if (!captureEnabled(env)) return;
    try {
      const event = args[0] as { prompt?: string } | undefined;
      appendSessionCapture(getWriter(), event?.prompt ?? "", now());
    } catch {
      // A capture failure must never break the agent loop or unregister
      // the handler - swallow and keep the next prompt capturable.
    }
  });

  // Consolidate this project's store files on graceful shutdown (slice 6),
  // only for opted-in sessions: with capture off the store is never
  // rewritten. This instance's own capture file is never a merge candidate.
  pi.on("session_shutdown", () => {
    if (!captureEnabled(env)) return;
    try {
      gcProjectDir(root, cwd, {
        keepFiles: [sessionFilePath(root, cwd, instanceId)],
      });
    } catch {
      // GC is best-effort and never blocks shutdown
    }
  });

  // When a tool asks for user input while the history overlay is open,
  // dismiss the overlay so the tool can take over the UI.
  pi.on("tool_call", () => {
    activeOverlayClose?.();
  });

  // Selector open flow (slice 3, stage 3): both entry points share it.
  const { openHistorySelector } = createOpenFlow(env, root, cwd);

  pi.registerShortcut(SHORTCUT, {
    description: "Search prompt history",
    handler: async (ctx) => openHistorySelector(ctx),
  });

  pi.registerCommand("history", {
    description: "Search prompt history",
    handler: async (_args, ctx) => openHistorySelector(ctx),
  });
}
