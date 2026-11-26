// Gentle Shell as a native chat: the centre column of design/herdr-desktop/01-inspector.html
// (T5). Shows one Gentle Shell (pi) terminal's conversation, read incrementally from its session
// JSONL, with the session header and the pending question from the session's desktop snapshot
// (docs/desktop-feed.md), and sends what you type with `hc send`. The terminal stays the real
// Gentle Shell TUI; the header's Chat | Terminal switch flips the layout stack.
// T11 (S10): any live Gentle Shell session, also one that runs outside Herdr app (the Herdr TUI,
// Ghostty, …; snapshot.js targetSession): its chat reads the exact session file its snapshot
// names; prompts and answers go through its inbox (send_prompt, answer_question via the session);
// it has no Terminal here, so the switch and ⌘J say where it runs instead.
// props: { terminal? } (else the session the window is about), and in a layout stack
// { stack, self, other } for the Chat / Terminal switch (see herdr/layouts/gentle-shell.json).
// Drawing: ui.js; colours, type and radii: tokens.js (shared with the T6 mods).
// Cost (S13, herdr/PERF.md): every redraw lays out every drawn row of the whole window, so the
// chat draws the last PAGE entries of the session's end (readTail; "Show earlier" goes back),
// wakes only for its own session file and settings files, follows the shared snapshot read
// (snapshot.js) from render instead of polling, and keeps no timer while it is hidden.

import { View, div } from "gpui-kit";
import { v_flex, TextareaState, ScrollHandle } from "gpui-base";
import { agents, props, layout, hc, run, setShared, shared, theme, watchFolder, nextCommand } from "herdr";
import { readFile } from "fs/promises";
import { sessionFileFor, readAfter, readTail, utf8 } from "./session.js";
import { FeedSource, allSessions, targetSession, machineOf, liveState } from "./snapshot.js";
import { createFeed, ingest, hideThinkingFrom, hasTranscript } from "./feed.js";
import { palette, sans, R } from "./tokens.js";
import { header, entries, entry, lane, stateLabel, askCard, askOptions, composer, icon, PERM, ELSEWHERE } from "./ui.js";
import { sendAction, errorText, safeKeys, terminalFree, tuiCommand, showTerminal, confirm, confirmed, readSnapshot } from "./actions.js";

const PAGE = 40; // entries drawn at first; "Show earlier" adds this many
const TAIL = 300 * 1024; // a session's first paint reads its last TAIL bytes and LINES lines, up to
const LINES = 300; //       TAIL_MAX bytes; each "Show earlier messages" reads as much again
const TAIL_MAX = 3 * 1024 * 1024;
const EXEC_ABOVE = 1024 * 1024; // a bigger session file is read through `sh`, only its new bytes
const LOOK_MS = 5000; // while shown: a look for a missed session switch or request (no file read)
const FILE_MS = 15000; // while shown without a folder watch: a read for missed writes
const SAFETY_MS = 60000; // while shown with one: a read for a write made before the watch began
const PLACEHOLDER = "Message Gentle Shell…  / for commands";
const PLACEHOLDER_ASK = "Answer above, or message Gentle Shell…  / for commands";
const ESC_MS = 1000; // the TUI's double-Esc window for stopping a turn (DOUBLE_ESC_CANCEL_WINDOW_MS)
const ESC_NOTICE = "Press Esc again to stop the agent.";
const SLASH_MAX = 50; // commands the "/" menu filters to at most
const REQUEST_MS = 10000; // a palette request older than this is ignored (shared values persist)
const NO_COMMANDS = "Open that session's terminal to run /commands.";
const KEPT = 30; // sessions whose opened rows are remembered when another session shows
const DOUBLE_MS = 300; // one ⌘O that reaches both the chat's key and the layout's key toggles once
const READ_FAILED = ["Cannot read this conversation", "Its session file could not be read. The chat tries again when the session updates."];

// The composer's "/" menu: open while the draft is one "/word" (no space or line break yet).
// Names that start with the word come first, then names and descriptions that contain it.
export function slashMatches(commands, draft) {
  const m = /^\/([^\s]*)$/.exec(String(draft ?? ""));
  if (!m) return null;
  const q = m[1].toLowerCase();
  const list = Array.isArray(commands) ? commands.filter((c) => c && typeof c.name === "string") : [];
  const starts = list.filter((c) => c.name.toLowerCase().startsWith(q));
  const contains = q ? list.filter((c) => !starts.includes(c) && `${c.name} ${c.description ?? ""}`.toLowerCase().includes(q)) : [];
  return [...starts, ...contains].slice(0, SLASH_MAX);
}

// A session started before desktop prompts refuses the kind: say what to do.
// A send_prompt refusal in words: a session from before desktop prompts, or one compacting that
// already holds a message.
const PROMPT_REFUSALS = {
  unknown_kind: "This session started before desktop messages: type in its own terminal, or restart it.",
  session_compacting: "A message is already waiting for compaction to finish.",
};
const promptRefusal = (r) => PROMPT_REFUSALS[r?.error?.code] ?? null;
// An apply_profile refusal in words (S12): a session from before desktop profile switching.
const PROFILE_REFUSALS = {
  unknown_kind: "This session started before desktop profile switching: use /gentle:profiles in its terminal, or restart it.",
};
const questionKey = (q) => (q ? `${q.toolCallId ?? ""}|${q.openedAt ?? ""}|${q.question ?? ""}` : null);

export default class GentleChat extends View {
  init(_props, cx) {
    this.feed = createFeed();
    this.snap = null; // the session's desktop snapshot (gentle-shell.desktop-feed/v1), or null
    this.key = null; // the shown session (snapshot.js allSessions key)
    this.want = null; // the session to show, picked in a host call (render, a timer)
    this.address = null; // its Herdr terminal, or null when it runs elsewhere
    this.cwd = null;
    this.file = null;
    this.dir = null;
    this.pos = 0; // the byte read up to
    this.start = 0; // the byte the read part begins at (S13: a long session's tail; 0 = all of it)
    this.size = 0; // the file's size at the last read
    this.back = 1; // how many tails are read (readTail: TAIL, LINES and TAIL_MAX times this)
    this.readAt = 0;
    this.watched = null;
    this.loading = false;
    this.again = false;
    this.refreshing = false;
    this.reagain = false;
    this.kicked = false; // a refresh is set for the next host call (see follow)
    this.looking = false; // the shown-only fallback look is set (see look)
    this.requesting = false;
    this.settingsDirs = new Set(); // the folders of the shown session's settings files, watched
    this.real = new Map(); // cwd -> real path, for sessionFileFor
    // A session that publishes a feed without a Pi session file (another agent): there is no
    // transcript this view can read, and falling back to the folder would show a different one.
    this.foreign = false;
    this.readFailed = false; // the last read of the session file failed (#3537): never shown as an empty conversation
    this.open = new Map(); // row id -> open, when flipped from its default (S11: per row, kept across reads)
    this.hunkAt = new Map(); // diff card id -> shown hunk
    this.kept = new Map(); // session file -> { open, hunkAt } of a session shown before
    this.expandAll = false; // ⌘O: every row open (the TUI's ctrl+o); a click on a row still flips it
    this.expandAt = 0;
    this.hideThinking = true; // the session's hideThinkingBlock (read with its snapshot)
    this.settingsOf = null;
    this.limit = PAGE;
    this.stick = true; // scroll to the newest entry after the next draw
    this.error = null;
    this.sending = false;
    this.typing = false; // the composer has the keyboard
    this.permOpen = false;
    this.profOpen = false; // the profiles menu (S12), on the header's Model fact
    this.profAt = null; // the profile the menu shows the agents of (hovered or picked)
    this.answered = null; // { key, index, custom } once an option of the open question was picked
    this.busy = null; // the desktop action in flight ("perm", "stop-<id>", "attach", …), for its pending look
    this.notice = null; // one calm line under the composer after an action that has no other trace
    this.draft = ""; // the composer's text, kept from its change events (Send / Stop, the "/" menu)
    this.slashAt = 0; // the "/" menu's selected row
    this.slashClosed = null; // the draft Esc closed the "/" menu on; it opens again once the draft changes
    this.escAt = 0; // the first Esc of an Esc Esc while the agent works
    this.lastRequest = 0;
    this.scroll = ScrollHandle.new();
    this.focus = cx.focus_handle();
    this.makeInput(PLACEHOLDER);
    // Enter sends, Shift+Enter is the Textarea's new line; ⌘J shows the Terminal; ⌘K opens the
    // Gentle commands palette; Esc Esc stops the agent's turn (Esc first closes the "/" menu).
    // While the "/" menu is open, ↑/↓ move in it and Tab completes the command.
    cx.bind_keys([
      { keystroke: "enter", action: "gentle_chat_send", context: "GentleChatComposer > Input" },
      { keystroke: "cmd-j", action: "gentle_chat_terminal", context: "GentleChat" },
      { keystroke: "cmd-k", action: "gentle_chat_palette", context: "GentleChat" },
      { keystroke: "cmd-o", action: "gentle_chat_expand", context: "GentleChat" },
      { keystroke: "escape", action: "gentle_chat_escape", context: "GentleChat" },
      { keystroke: "escape", action: "gentle_chat_escape", context: "GentleChatComposer > Input" },
      { keystroke: "up", action: "gentle_chat_slash_up", context: "GentleSlashMenu > Input" },
      { keystroke: "down", action: "gentle_chat_slash_down", context: "GentleSlashMenu > Input" },
      { keystroke: "tab", action: "gentle_chat_slash_complete", context: "GentleSlashMenu > Input" },
    ]);
    // Every live snapshot (and whether its publisher still runs): the status bar's shared read
    // (snapshot.js FeedSource). A new read re-renders this view, and render follows it.
    this.source = new FeedSource();
    this.source.start(cx);
    this.tick(cx);
    this.commands(cx);
    this.look(cx);
  }

  // From render (every shared-state or Herdr change re-renders the mods) and the fallback look:
  // a refresh when the shown session, its terminal or its snapshot changed, and a palette request
  // once the chat shows (a hidden stack child gets no commands). Host work runs in a timer
  // callback: render may not notify, and request() sets shared state.
  follow(cx) {
    const want = this.pick();
    if (want?.key !== this.key || (want?.terminal?.address ?? null) !== this.address
      || (want?.feed?.updatedAt ?? null) !== (this.snap?.updatedAt ?? null)) {
      if (!this.kicked) {
        this.kicked = true;
        cx.timer.after(1, (cx) => { this.kicked = false; this.tick(cx); });
      }
    }
    if (!this.requesting && this.showing()) {
      const req = shared("gentle-chat.request");
      if (req && typeof req === "object" && Number.isFinite(req.at) && req.at !== this.lastRequest) {
        this.requesting = true;
        cx.timer.after(1, (cx) => { this.requesting = false; this.request(cx); });
      }
    }
  }

  // The fallback for a missed event, only while the chat shows (S13): a look every LOOK_MS (no
  // file read), and a read every FILE_MS when the session folder has no watch (SAFETY_MS when it
  // has one). It stops once the chat is hidden; render starts it again.
  look(cx) {
    if (this.looking) return;
    this.looking = true;
    try {
      cx.timer.after(LOOK_MS, (cx) => {
        this.looking = false;
        if (!this.showing()) return;
        this.follow(cx);
        if (this.file && Date.now() - this.readAt >= (this.watched ? SAFETY_MS : FILE_MS)) cx.spawn(async (cx) => { await this.load(cx); });
        this.look(cx);
      });
    } catch {
      this.looking = false;
    }
  }

  // Key commands ("<key>": "gentle-chat.<command>" in keys.json, or `herdr-app do gentle-chat.<command>`;
  // herdr/keys.json binds them): chat, terminal, toggle (Chat ↔ Terminal), perm (opens the
  // permission menu), profiles (opens or closes the profiles menu, S12), mode-<normal|auto|yolo|super-yolo>
  // (the menu's own path: Super-YOLO asks in a dialog first), stop (the agent's turn, as Esc Esc), palette (the Gentle commands palette)
  // request (a palette row: the slash command it names, see gentle-palette), and the minimal
  // view's expand (⌘O: every row open ↔ the minimal view), expand-all and collapse-all (S11).
  commands(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand());
        try {
          const mode = c.startsWith("mode-") ? c.slice(5) : null;
          if (confirmed(c, cx)) { /* a confirm dialog's Confirm */ }
          else if (c === "chat" || c === "terminal") this.go(c, cx);
          else if (c === "toggle") this.go(this.showing() ? "terminal" : "chat", cx);
          else if (c === "perm") this.permOpen = true;
          else if (c === "profiles") { this.profOpen = !this.profOpen; this.profAt = null; }
          else if (c === "stop") this.stop(cx);
          else if (c === "palette") this.palette();
          else if (c === "expand") this.expandToggle(cx);
          else if (c === "expand-all" || c === "collapse-all") this.setExpandAll(c === "expand-all", cx);
          else if (c === "request") this.request(cx);
          else if (mode && PERM.some((m) => m.mode === mode)) this.setMode(mode, cx);
        } catch (e) {
          this.error = String(e?.message ?? e);
        }
        cx.notify();
      }
    });
  }

  // props.terminal's session, else the session the window is about (snapshot.js targetSession).
  // Herdr's ambient reads belong to a host call, so this runs in render and in timers only.
  pick() {
    const want = props()?.terminal;
    if (want) return allSessions(this.source.feeds).find((s) => s.terminal?.address === want) ?? null;
    return targetSession(this.source.feeds, this.key);
  }

  // The shown session follows the pick at once, before any await: Send, answers and actions go to
  // it even while a refresh of the session shown before still reads.
  tick(cx) {
    this.want = this.pick();
    this.wantFeeds = this.source.feeds;
    this.show(this.want, cx);
    cx.spawn(async (cx) => { await this.refreshNow(cx); });
  }

  // Makes `s` the shown session: its key, its Herdr terminal and its snapshot (where actions go).
  show(s, cx) {
    const key = s?.key ?? null;
    const address = s?.terminal?.address ?? null;
    if (key !== this.key) {
      this.key = key;
      this.cwd = s?.terminal?.cwd ?? s?.feed?.identity?.cwd ?? null;
      this.dir = null;
      this.reset(null);
      this.setSnap(s?.feed ?? null);
      cx.notify();
    }
    if (address !== this.address) { this.address = address; cx.notify(); }
  }

  // One refresh at a time; a call during one runs it again after, for the newest `want`.
  async refreshNow(cx) {
    if (this.refreshing) { this.reagain = true; return; }
    this.refreshing = true;
    try {
      do {
        this.reagain = false;
        await this.refresh(cx);
      } while (this.reagain);
    } finally {
      this.refreshing = false;
    }
  }

  // A session that runs outside Herdr app: no terminal to type into or to show.
  elsewhere() {
    return Boolean(this.key) && !this.address;
  }

  // Finds the session file and snapshot of the shown session and reads what was added.
  async refresh(cx) {
    const s = this.want;
    const key = s?.key ?? null;
    const address = s?.terminal?.address ?? null;
    this.show(s, cx);
    if (!s && this.foreign) { this.foreign = false; cx.notify(); }
    if (!s) return;
    // S14: a terminal on another machine. Its session file and snapshot are on that machine and the
    // desktop feed reads this computer's, so nothing is read (a local file of the same folder would
    // be another session): the empty state says where it runs, the Terminal shows it.
    // A remote terminal renders its own state, so a foreign flag from the previous session stops
    // here; routine refreshes of the shown session must not clear it.
    if (machineOf(address)) {
      if (this.foreign) { this.foreign = false; this.dir = null; this.reset(null); cx.notify(); }
      return;
    }
    // The snapshot names the exact session file; a terminal without one falls back to its folder.
    const exact = s.feed?.identity?.sessionFile;
    const foreign = Boolean(s.feed) && !hasTranscript(s.feed.identity);
    if (foreign !== this.foreign) {
      this.foreign = foreign;
      // The same key can turn foreign (a feed that stops naming a Pi session file): drop the
      // transcript read earlier, or it would sit beside the notice that we cannot read it.
      if (foreign) { this.dir = null; this.reset(null); }
      cx.notify();
    }
    const where = typeof exact === "string" && exact.endsWith(".jsonl")
      ? { dir: exact.slice(0, Math.max(exact.lastIndexOf("/"), exact.lastIndexOf("\\"))), file: exact, feed: s.feed }
      : foreign ? null : s.terminal ? await sessionFileFor(s.terminal, this.real, this.wantFeeds) : null;
    if (this.key !== key) return;
    if (this.setSnap(where?.feed ?? s.feed ?? null)) cx.notify();
    if (this.settingsOf !== key) await this.readSettings(s, cx);
    if (this.key !== key) return;
    if (!where) return;
    if (where.dir !== this.dir) { this.dir = where.dir; this.watch(where.dir, cx); }
    if (where.file !== this.file) { this.reset(where.file); cx.notify(); }
    // Once read, the file's writes come through its watch (S13: a snapshot change reads nothing).
    if (this.file && (this.pos === 0 || this.watched !== this.dir)) await this.load(cx);
  }

  // The session's hideThinkingBlock (pi settings; ctrl+t in its TUI writes it): read when the
  // session shows and again when one of its two settings files changes (S13: a watch on their
  // folders, not a read per refresh). A missing or unreadable file reads as not set.
  async readSettings(s, cx) {
    this.settingsOf = s.key;
    const dir = s.feed?.identity?.agentDir;
    const cwd = s.feed?.identity?.cwd ?? s.terminal?.cwd ?? null;
    const files = [typeof dir === "string" ? `${dir.replace(/\/+$/, "")}/settings.json` : null,
      typeof cwd === "string" ? `${cwd.replace(/\/+$/, "")}/.pi/settings.json` : null];
    this.settingsFiles = files;
    for (const f of files) if (f) this.watchSettings(f.slice(0, f.lastIndexOf("/")), s.key, cx);
    const text = async (path) => { try { return utf8(await readFile(path)); } catch { return null; } };
    const hide = hideThinkingFrom(files[0] ? await text(files[0]) : null, files[1] ? await text(files[1]) : null);
    if ((this.want?.key ?? null) !== s.key) return;
    if (hide !== this.hideThinking) { this.hideThinking = hide; cx.notify(); }
  }

  // One watch per settings folder of the shown session; it ends at its next event once another
  // session shows. Only a change of one of the two settings files reads them again.
  watchSettings(dir, key, cx) {
    if (this.settingsDirs.has(dir)) return;
    this.settingsDirs.add(dir);
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          const paths = await watchFolder(dir);
          const files = (this.settingsFiles ?? []).filter(Boolean);
          if (this.key !== key || !files.some((f) => f.startsWith(`${dir}/`))) break;
          if (!Array.isArray(paths) || paths.some((p) => p === dir || files.includes(p))) {
            const s = this.want;
            if (s?.key === key) await this.readSettings(s, cx);
          }
        }
      } catch {
        // no such folder (a project without .pi): read when the session shows
      }
      this.settingsDirs.delete(dir);
    });
  }

  // Keeps the newest snapshot; true when what it shows changed. A new or cleared question
  // forgets the option picked for the old one.
  setSnap(snap) {
    const before = this.snap;
    if (before?.updatedAt === snap?.updatedAt && before?.identity?.sessionId === snap?.identity?.sessionId) return false;
    this.snap = snap;
    const q = questionKey(snap?.pendingQuestion);
    if (this.answered && this.answered.key !== q) this.answered = null;
    if (q && q !== questionKey(before?.pendingQuestion)) this.stick = true;
    // The composer draws its own placeholder (ui.js composer: one line, truncated with an
    // ellipsis, centred with the clip and Send), so a question only changes its words.
    this.placeholder = q ? PLACEHOLDER_ASK : PLACEHOLDER;
    return true;
  }

  makeInput(placeholder) {
    this.placeholder = placeholder;
    // No native placeholder: it can neither centre nor end in an ellipsis in a narrow card. One
    // row while the draft is one line (centred in the 42px field), growing with the text.
    this.input = TextareaState.new({ placeholder: "", rows: 1 });
    try { this.input.set_auto_grow(1, 8); } catch { /* an older host keeps one row and scrolls */ }
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.input.on("change", (_e, cx) => {
      const before = this.draft;
      this.draft = this.input.value();
      if (this.draft !== before) { this.slashAt = 0; if (this.slashClosed !== this.draft) this.slashClosed = null; }
      cx.notify();
    });
  }

  reset(file) {
    // The rows opened in a session stay open when it is read again or shown again (S11).
    if (file !== this.file) {
      if (this.file && (this.open.size || this.hunkAt.size)) {
        this.kept.delete(this.file);
        this.kept.set(this.file, { open: this.open, hunkAt: this.hunkAt });
        while (this.kept.size > KEPT) this.kept.delete(this.kept.keys().next().value);
      }
      const back = file ? this.kept.get(file) : null;
      this.open = back?.open ?? new Map();
      this.hunkAt = back?.hunkAt ?? new Map();
    }
    this.feed = createFeed();
    this.file = file;
    this.pos = 0;
    this.start = 0;
    this.size = 0;
    this.back = 1;
    this.limit = PAGE;
    this.stick = true;
    this.error = null;
    this.readFailed = false;
  }

  // Watches the session folder. With the snapshot's exact file, only a write to that file reads
  // (S13: the other sessions of the folder write there too); without one (an older Gentle Shell,
  // found by folder) any change looks again, since a new session file appears there.
  watch(dir, cx) {
    if (this.watched === dir) return;
    this.watched = dir;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === dir) {
          const paths = await watchFolder(dir);
          if (this.watched !== dir) break;
          const file = this.file;
          if (this.foreign) { this.watched = null; return; } // nothing to read: the empty state already says why
          if (!file || typeof this.snap?.identity?.sessionFile !== "string") { await this.refreshNow(cx); continue; }
          const name = file.slice(file.lastIndexOf("/") + 1);
          if (!Array.isArray(paths) || paths.some((p) => p === file || p === dir || String(p).endsWith(`/${name}`))) await this.load(cx);
        }
      } catch {
        if (this.watched === dir) this.watched = null; // the fallback look reads it while shown
      }
    });
  }

  // A session with a snapshot starts from its tail (S13): the snapshot carries the header's facts
  // (cost, model, name), so the history before the tail is needed only to scroll back.
  useTail() {
    return Boolean(this.snap);
  }

  // "Show earlier": the drawn entries go back PAGE more; once every read entry is drawn, one more
  // tail of the file is read (the read part is rebuilt from the new start; opened rows stay).
  earlier(from, cx) {
    this.limit += PAGE;
    this.pinned = false;
    if (from <= 0 && this.start > 0 && this.file) {
      this.back += 1;
      this.pos = 0;
      cx.spawn(async (cx) => { await this.load(cx); });
    }
    cx.notify();
  }

  // Reads only the complete lines added since `pos` (a long session: first its tail, readTail).
  // The file only grows; if it shrank, start over. A big file is read through `sh`, which gives
  // its size and only the new bytes; a small one is read whole and sliced (session.js). A read
  // from the start that fails is shown as a failure; `pos` stays 0, so the next refresh reads again.
  async load(cx) {
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    const file = this.file;
    try {
      do {
        this.again = false;
        this.readAt = Date.now();
        const before = this.feed.items.length;
        if (this.pos === 0 && this.useTail()) {
          const first = !this.feed.items.length;
          const t = await readTail(file, TAIL * this.back, LINES * this.back, TAIL_MAX * this.back);
          if (file !== this.file) return;
          if (!t) { this.readFailed = true; cx.notify(); continue; }
          this.readFailed = false;
          const feed = createFeed();
          ingest(feed, t.text);
          this.feed = feed;
          this.start = t.start;
          this.pos = t.end;
          this.size = t.size;
          if (first) this.stick = true;
          cx.notify();
          continue;
        }
        const { text, end, more, size } = await readAfter(file, this.pos, undefined, this.size > EXEC_ABOVE);
        if (file !== this.file) return;
        if (Number.isFinite(size)) this.size = size;
        if (text === null) {
          if (this.pos > 0) { this.reset(file); this.again = true; }
          else { this.readFailed = true; cx.notify(); }
          continue;
        }
        if (this.readFailed) { this.readFailed = false; cx.notify(); }
        if (text) {
          ingest(this.feed, text);
          this.pos = end;
          if (this.feed.items.length !== before) this.stick = true;
          cx.notify();
        }
        if (more) this.again = true;
      } while (this.again);
    } finally {
      this.loading = false;
    }
  }

  send(cx) {
    // Enter on the "/" menu runs (or completes) the selected command.
    if (this.slashMenu()) { this.slashPick(this.slashAt, false, cx); return; }
    const text = this.input.value().trim();
    const address = this.address;
    if (!text || !this.key || this.sending) return;
    if (!address && !this.snap) { this.error = "This session publishes no snapshot; it takes no messages from here."; cx.notify(); return; }
    const pq = this.snap?.pendingQuestion;
    // "Something else…" was picked: this text is the answer to that question.
    const typedAnswer = this.answered?.custom && pq && this.answered.key === questionKey(pq) ? pq : null;
    // A slash command goes to the TUI as typed; one whose result is a TUI screen (or one this
    // session does not list) shows the Terminal.
    if (!typedAnswer && text.startsWith("/")) {
      const name = text.slice(1).split(/\s/)[0];
      const known = (this.snap?.commands?.items ?? []).find((c) => c.name === name);
      this.runCommand(text, known ? known.terminal !== false : true, cx);
      return;
    }
    // An open question or prompt would take the typed text (and its Enter) as its answer.
    if (!typedAnswer) {
      const busy = terminalFree(this.snap);
      if (busy) { this.error = busy; cx.notify(); return; }
    }
    this.sending = true;
    this.error = null;
    this.notice = null;
    this.input.set_value("");
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (typedAnswer) {
          await this.pressAnswer(cx, address, typedAnswer, { text });
          this.sending = false;
          cx.notify();
          return;
        }
        if (!address) {
          // Outside Herdr app: the session's inbox types it into its editor (T11 send_prompt).
          const r = await sendAction(cx, this.snap, "send_prompt", { text });
          if (!r.ok) { this.error = promptRefusal(r) ?? errorText(r); this.input.set_value(text); }
          else if (r.data?.queued && r.data?.after === "compaction") this.notice = "Queued until compaction ends";
          else if (r.data?.queued) this.notice = "Queued: the agent reads it after its current step, as Enter does in the TUI.";
        } else {
          const r = await hc(["send", address, text]);
          if (r.code !== 0) { this.error = (r.stderr || r.stdout || "hc send failed").trim(); this.input.set_value(text); }
        }
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.input.set_value(text);
      }
      this.sending = false;
      this.stick = true;
      cx.notify();
    });
  }

  // Picks option `i` of the open question (a click, or keys 1–N).
  answer(i, cx) {
    const pq = this.snap?.pendingQuestion;
    const address = this.address;
    if (!pq || !this.key || this.answered) return;
    const o = askOptions(pq)[i];
    if (!o) return;
    this.answered = { key: questionKey(pq), index: i, custom: o.custom };
    this.error = null;
    cx.notify();
    if (o.custom) { this.input.focus(); return; }
    cx.spawn(async (cx) => { await this.pressAnswer(cx, address, pq, { option: i }); });
  }

  // Answers the open question like the person would in the terminal: the session first checks
  // that it is still the open one (by its toolCallId) and names the keys its real list takes
  // (the lists ignore digits); then those keys, and a typed answer, go to the terminal.
  async pressAnswer(cx, address, pq, answer) {
    try {
      if (!pq.toolCallId) throw new Error(address ? "Answer it in the Terminal view." : "Answer it in that session's terminal.");
      if (!address) {
        // Outside Herdr app: the question's own list takes the answer (T11, answer_question via the
        // session); the session checks it is still the open one, as for the keys.
        const r = await sendAction(cx, this.snap, "answer_question", { toolCallId: pq.toolCallId, ...answer, via: "session" });
        if (!r.ok) throw new Error(r.error?.code === "invalid_action" ? "Answer it in that session's terminal: it started before desktop answers." : errorText(r));
        cx.notify();
        return;
      }
      const r = await sendAction(cx, this.snap, "answer_question", { toolCallId: pq.toolCallId, ...answer });
      if (!r.ok) {
        if (r.error?.code === "answer_in_terminal") this.later(cx, () => this.toTerminal());
        throw new Error(errorText(r));
      }
      if (!safeKeys(r.data.keys)) throw new Error("The session answered keys this view does not press.");
      // The question may have closed or changed since the session answered: read it again and
      // press nothing unless it is still the same one.
      const still = async () => {
        const fresh = await readSnapshot(this.snap);
        if (questionKey(fresh?.pendingQuestion) !== questionKey(pq)) throw new Error("The question changed before the answer was sent; nothing was pressed.");
      };
      await still();
      const k = await hc(["keys", address, ...r.data.keys]);
      if (k.code !== 0) throw new Error((k.stderr || k.stdout || "hc keys failed").trim());
      if (answer.text !== undefined) {
        await still();
        const t = await hc(["send", address, answer.text]);
        if (t.code !== 0) throw new Error((t.stderr || t.stdout || "hc send failed").trim());
      }
    } catch (err) {
      this.error = String(err?.message ?? err);
      this.answered = null;
      if (answer.text !== undefined && !this.input.value()) this.input.set_value(answer.text);
    }
    cx.notify();
  }

  // ---- Desktop actions (T7): the person's own authority, through the session's owners ----

  toTerminal() {
    if (this.elsewhere()) { this.notice = `${ELSEWHERE}.`; return; }
    const { stack, other } = this.stackProps();
    showTerminal(this.address, stack ?? "views", other ?? "main");
  }

  // Runs `fn` in a host call (a timer callback): Herdr's ambient calls (run, props, setShared)
  // throw after an await in a spawned task.
  later(cx, fn) {
    cx.timer.after(1, () => { try { fn(); } catch (e) { this.error = String(e?.message ?? e); } });
  }

  // One action at a time per control; the result or refusal shows under the composer.
  act(key, cx, work) {
    if (this.busy) return;
    this.busy = key;
    this.error = null;
    this.notice = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const line = await work(cx);
        if (line) this.error = line;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.busy = null;
      cx.notify();
    });
  }

  // The TUI's own screen for this (its slash command), shown in the Terminal.
  command(key, text, cx) {
    if (this.elsewhere()) { this.error = NO_COMMANDS; cx.notify(); return; }
    this.act(key, cx, (cx) => tuiCommand(this.address, this.snap, text, () => this.later(cx, () => this.toTerminal())));
  }

  // A slash command from the composer, its "/" menu or the palette: typed into the TUI like the
  // person would. `terminal`: its result is a TUI screen, so the Terminal shows; otherwise the
  // chat stays (a prompt template's turn, /new, /name …). The draft comes back if it failed.
  runCommand(text, terminal, cx) {
    if (this.busy) return;
    if (this.elsewhere()) { this.promptCommand(text, cx); return; }
    this.input.set_value("");
    this.draft = "";
    this.act("command", cx, async (cx) => {
      // Herdr's ambient calls (run, props) only work inside a host call: after the await, the
      // switch runs from a timer callback.
      const line = await tuiCommand(this.address, this.snap, text, terminal ? () => this.later(cx, () => this.toTerminal()) : null);
      if (line) { if (!this.input.value()) { this.input.set_value(text); this.draft = text; } return line; }
      this.stick = true;
      if (!terminal) this.notice = `${text.split(/\s/)[0]} sent to the session.`;
      return null;
    });
  }

  // Outside Herdr app (T11): a prompt template or a skill becomes the prompt it expands to, through
  // the session's inbox; every other command is TUI code and stays in that session's terminal.
  promptCommand(text, cx) {
    const name = text.slice(1).split(/\s/)[0];
    const known = (this.snap?.commands?.items ?? []).find((c) => c.name === name);
    if (known?.source !== "prompt" && known?.source !== "skill") { this.error = NO_COMMANDS; cx.notify(); return; }
    this.input.set_value("");
    this.draft = "";
    this.act("command", cx, async (cx) => {
      const r = await sendAction(cx, this.snap, "send_prompt", { text });
      if (!r.ok) { if (!this.input.value()) { this.input.set_value(text); this.draft = text; } return promptRefusal(r) ?? errorText(r); }
      this.stick = true;
      this.notice = `${text.split(/\s/)[0]} sent to the session.`;
      return null;
    });
  }

  // ---- The "/" menu (T10): the session's commands, filtered as you type ----

  slashMenu() {
    if (!this.typing || this.slashClosed === this.draft) return null;
    const items = slashMatches(this.snap?.commands?.items, this.draft);
    if (!items?.length) return null;
    this.slashAt = Math.max(0, Math.min(this.slashAt, items.length - 1));
    return { items, at: this.slashAt };
  }

  slashMove(step, cx) {
    const m = this.slashMenu();
    if (!m) return;
    this.slashAt = (m.at + step + m.items.length) % m.items.length;
    cx.notify();
  }

  // Tab (or a command that needs an argument) puts "/name " in the composer; Enter and a click
  // run it.
  slashPick(i, complete, cx) {
    const c = this.slashMenu()?.items[i];
    if (!c) return;
    if (complete || c.args) {
      this.setDraft(`/${c.name} `);
      cx.notify();
      return;
    }
    this.runCommand(`/${c.name}`, c.terminal !== false, cx);
  }

  // Puts `text` in the composer with the caret at its end, and the keyboard on it.
  setDraft(text) {
    this.input.set_value(text);
    this.draft = text;
    try { this.input.set_selected_range({ start: text.length, end: text.length }); } catch { /* caret stays */ }
    this.input.focus();
  }

  // ---- Stop the agent (T10): the TUI's Esc Esc, through the session's own abort ----

  working() {
    const agent = this.address ? agents().find((a) => a.address === this.address) : null;
    return agent?.status === "working" || this.snap?.activity?.state === "working";
  }

  stop(cx) {
    this.escAt = 0;
    this.act("stop", cx, async (cx) => {
      const r = await sendAction(cx, this.snap, "abort_turn", {});
      if (!r.ok) return errorText(r);
      this.notice = "Stopped the agent's turn.";
      return null;
    });
  }

  // Esc: closes the "/" menu; while the agent works, a second Esc within a second stops it.
  escape(cx) {
    if (this.slashMenu()) { this.slashClosed = this.draft; cx.notify(); return; }
    if (!this.working()) { cx.propagate(); return; }
    const now = Date.now();
    if (this.escAt && now - this.escAt <= ESC_MS) { this.stop(cx); return; }
    this.escAt = now;
    this.notice = ESC_NOTICE;
    cx.notify();
    cx.timer.after(ESC_MS, (cx) => {
      if (this.notice === ESC_NOTICE) this.notice = null;
      this.escAt = 0;
      cx.notify();
    });
  }

  // ---- The Gentle commands palette (gentle-palette) ----

  palette() {
    // The palette is about this chat's session, not whichever pane had the keyboard.
    setShared("gentle-palette.terminal", { address: this.address, key: this.key, at: Date.now() });
    run("mod.open", { name: "gentle-palette" });
  }

  // A palette request (gentle-palette): a permission mode, or a slash command. Consume-once: it is
  // cleared when taken, and one older than REQUEST_MS is dropped. Without the session's snapshot
  // yet it waits for the next render or look (follow).
  request(cx) {
    const req = shared("gentle-chat.request");
    if (!req || typeof req !== "object" || !Number.isFinite(req.at) || req.at === this.lastRequest) return;
    if (Math.abs(Date.now() - req.at) > REQUEST_MS) { setShared("gentle-chat.request", null); return; }
    if (req.kind === "expand") {
      this.lastRequest = req.at;
      setShared("gentle-chat.request", null);
      this.setExpandAll(Boolean(req.expanded), cx);
      return;
    }
    if (!this.snap || !this.key) return;
    this.lastRequest = req.at;
    setShared("gentle-chat.request", null);
    if (req.kind === "mode") {
      if (PERM.some((m) => m.mode === req.mode)) this.setMode(req.mode, cx);
      return;
    }
    if (req.kind === "profile") {
      if (typeof req.name === "string" && req.name) this.applyProfile(req.name, cx);
      return;
    }
    if (typeof req.text !== "string" || !req.text.startsWith("/")) return;
    if (req.args) {
      // It needs an argument: the chat shows with "/name " in the composer.
      this.go("chat", cx);
      this.setDraft(`${req.text} `);
      return;
    }
    if (!req.terminal) this.go("chat", cx);
    this.runCommand(req.text, Boolean(req.terminal), cx);
  }

  // The permission menu: the same owner as /gentle:mode decides. Super-YOLO asks first, with the
  // TUI's own words for it.
  setMode(mode, cx) {
    this.permOpen = false;
    cx.notify();
    if (mode === this.snap?.permission?.mode) return;
    const go = (cx) => this.act("perm", cx, async (cx) => {
      const r = await sendAction(cx, this.snap, "set_permission_mode", { mode });
      return r.ok ? null : errorText(r);
    });
    if (mode !== "super-yolo") return go(cx);
    confirm("gentle-chat", {
      title: "Switch this session to Super-YOLO?",
      detail: "The agent runs ordinary and destructive shell work without asking; private paths stay blocked and consent prompts remain. Only this session changes. The session accepts it only while its agent, jobs and subagents are idle.",
    }, go);
  }

  // S12: "Use in this session" through the session's own /gentle:profiles apply (apply_profile).
  // When the owner shows a dialog (the routing it changes), the same words show here, and Confirm
  // sends its token back; the owner checks it against what it would show now.
  applyProfile(name, cx, confirmation = null) {
    this.profOpen = false;
    cx.notify();
    if (!confirmation && name === this.snap?.profiles?.active) { this.notice = `"${name}" is already this session's profile.`; return; }
    this.act("profile", cx, async (cx) => {
      const r = await sendAction(cx, this.snap, "apply_profile", confirmation ? { name, confirmation } : { name });
      if (!r.ok) return PROFILE_REFUSALS[r.error?.code] ?? errorText(r);
      const d = r.data ?? {};
      const said = (Array.isArray(d.notes) ? d.notes : []).map((n) => n?.text).filter(Boolean).at(-1);
      if (d.status === "confirmation_required" && typeof d.confirmation?.token === "string") {
        const c = d.confirmation;
        this.later(cx, () => confirm("gentle-chat", {
          title: c.title || `Use "${name}" in this session?`,
          detail: c.message || `Routes this session's agents with the "${name}" profile.`,
          height: 280,
        }, (cx) => this.applyProfile(name, cx, c.token)));
        return null;
      }
      if (d.status === "applied") { this.notice = said || `"${name}" is now this session's profile.`; return null; }
      return said || `"${name}" was not applied.`;
    });
  }

  stopAgent(id, cx) {
    this.act(`stop-${id}`, cx, async (cx) => {
      const r = await sendAction(cx, this.snap, "cancel_subagent", { id });
      return r.ok ? null : errorText(r);
    });
  }

  // Pastes the clipboard (an image, or files on macOS) into the session's draft, as Ctrl+V in the
  // terminal does; it goes with the next message sent.
  attach(cx) {
    this.act("attach", cx, async () => {
      const address = this.address;
      if (this.elsewhere()) return "Attachments are pasted in that session's terminal.";
      if (!address) return "No Gentle Shell terminal.";
      const busy = terminalFree(this.snap);
      if (busy) return busy;
      const r = await hc(["keys", address, "ctrl+v"]);
      if (r.code !== 0) return (r.stderr || r.stdout || "hc keys failed").trim();
      this.notice = "Clipboard pasted into the session's draft; it goes with your next message.";
      return null;
    });
  }

  // "Open in Changes": the inspector shows its Changes tab with this file marked.
  openInChanges(path, cx) {
    setShared("gentle-inspector.reveal", { tab: "changes", path: String(path ?? ""), at: Date.now() });
    cx.notify();
  }

  stackProps() {
    return props() ?? {};
  }

  // In a layout stack: whether the chat is the shown child.
  showing() {
    const { stack, self } = this.stackProps();
    if (!stack) return true;
    const find = (node) => (node?.id === stack ? node : (node?.children ?? []).map(find).find(Boolean));
    const node = find(layout());
    return (node?.active ?? node?.children?.[0]?.id) === self;
  }

  go(which, cx) {
    // A session outside Herdr app has no Terminal here: say where it runs instead.
    if (which === "terminal" && this.elsewhere()) { this.notice = `${ELSEWHERE}.`; cx?.notify?.(); return; }
    const { stack, self, other } = this.stackProps();
    if (stack) run("layout.select", { stack, child: which === "chat" ? self : other });
  }

  // A row's state: its own flip, else ⌘O's "every row open", else its default (the minimal view).
  isOpen(id, def) {
    return this.open.has(id) ? this.open.get(id) : this.expandAll || def;
  }

  toggle(id, def, cx) {
    this.open.set(id, !this.isOpen(id, def));
    this.pinned = false; // the row stays where it was clicked
    cx.notify();
  }

  // ⌘O, "Expand all / Collapse all": every row of every session follows, like the TUI's ctrl+o;
  // the rows flipped one by one start over.
  setExpandAll(on, cx) {
    this.expandAll = Boolean(on);
    this.open = new Map();
    this.kept = new Map();
    cx.notify();
  }

  expandToggle(cx) {
    const now = Date.now();
    if (now - this.expandAt < DOUBLE_MS) return;
    this.expandAt = now;
    this.setExpandAll(!this.expandAll, cx);
  }

  key(e, cx) {
    if (this.typing || e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt) return;
    const pq = this.snap?.pendingQuestion;
    const n = Number(e.key);
    if (pq && Number.isInteger(n) && n >= 1 && n <= askOptions(pq).length) { this.answer(n - 1, cx); cx.stop_propagation(); }
  }

  render(cx) {
    try { this.follow(cx); this.look(cx); } catch { /* the fallback look keeps it fresh */ }
    const p = palette(theme());
    const agent = this.address ? agents().find((a) => a.address === this.address) : null;
    this.agentInfo = agent;
    const working = agent?.status === "working" || this.snap?.activity?.state === "working";
    const list = entries(this.feed.items);
    const from = Math.max(0, list.length - this.limit);
    const rows = [];
    if (from > 0 || this.start > 0) {
      rows.push(div().flex_none().self_center().child(div().id("earlier").px(10).py(3).rounded(R.inner).text_size(12).text_color(p.muted)
        .cursor_pointer().hover((s) => s.bg(p.selected))
        .on_click((_e, cx) => this.earlier(from, cx))
        .child(from > 0 ? `Show earlier (${from} ${from === 1 ? "message" : "messages"})` : "Show earlier messages")));
    }
    for (let i = from; i < list.length; i++) rows.push(lane(entry(this, p, list[i], working && i === list.length - 1)));
    const pq = this.snap?.pendingQuestion;
    if (pq) rows.push(lane(askCard(this, p, pq)));
    else {
      // S15: "Working · 2 agents" while the turn runs, "Waiting on 2 agents" once it ended while its
      // background subagents or jobs still run.
      const live = this.snap ? liveState(this.snap) : null;
      const busy = live && (live.status === "working" || live.status === "waiting");
      if (working || busy) rows.push(lane(stateLabel(p, "work", busy ? live.label : "Working")));
    }
    // A foreign session or a failed read can still have a status row; the explanation has to appear anyway.
    if ((this.foreign || this.readFailed) && rows.length > 0) {
      const [title, about] = this.foreign ? this.foreignText() : READ_FAILED;
      rows.push(lane(v_flex().id("foreign").flex_none().self_center().items_center().px(28).py(24).gap(4)
        .child(div().text_size(14).font_semibold().text_color(p.text).child(title))
        .child(div().text_size(12.5).text_color(p.muted).text_center().child(about))));
    }
    const empty = !rows.length;
    // Pinned to the newest entry: new items pin it, scrolling up unpins it. scroll_to_item
    // reveals a child with the least scroll, so the target is a 1px sentinel after the last row,
    // asked again whenever the last row changes height (markdown settles a frame later).
    if (this.stick) { this.pinned = true; this.stick = false; }
    if (this.pinned && rows.length) {
      this.scroll.scroll_to_item(rows.length);
      const n = rows.length - 1;
      rows[n] = rows[n].on_size_change((size, cx) => {
        if (this.pinned && Math.abs((this.lastH ?? 0) - size.height) >= 1) { this.lastH = size.height; cx.notify(); }
      });
    }
    rows.push(div().id("log-end").flex_none().w_full().h(1));

    return v_flex().id("root").size_full().min_h(0).bg(p.background).text_color(p.text).text_size(13).line_height(1.5)
      .font_family(sans()).rounded(R.window - 1)
      .key_context("GentleChat").track_focus(this.focus)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_action("gentle_chat_terminal", (_e, cx) => this.go("terminal", cx))
      .on_action("gentle_chat_palette", () => this.palette())
      .on_action("gentle_chat_expand", (_e, cx) => this.expandToggle(cx))
      .on_action("gentle_chat_escape", (_e, cx) => this.escape(cx))
      .child(header(this, p))
      .child(empty ? this.empty(p) : v_flex().id("log").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll)
        .pt(18).pb(7).gap(14) // .log padding-bottom 22 = gap 14 + the 1px sentinel + 7
        .on_scroll_wheel((e) => { if ((e.delta?.y ?? 0) > 0) this.pinned = false; })
        .on_mouse_down("left", () => this.focus.focus())
        .children(rows))
      .child(composer(this, p, pq));
  }

  // No conversation yet (the artboard has no such state): a calm block in the middle of the
  // log, in the design's type: the mark in faint, a 14px semibold line, a 12.5px muted line.
  // The same words in the empty state and above any status row: a feed with no Pi session file
  // cannot be read here, and where the session runs changes what the person can do about it.
  foreignText() {
    const where = this.address
      ? "This view can only show its Terminal (⌘J)."
      : "Open its terminal where it runs to follow the conversation.";
    return ["No transcript for this session", `It publishes a desktop feed but no Pi session file. ${where}`];
  }

  emptyText() {
    const machine = machineOf(this.address);
    return machine
      ? [`Runs on ${machine}`, `Herdr shows its state and its Terminal (⌘J). Its conversation and desktop feed stay on ${machine}: this window reads this computer's.`]
      : this.foreign
      ? this.foreignText()
      : !this.key
      ? ["No Gentle Shell session", "Start one with + in the tab bar, or run gentle-shell in a terminal."]
      : !this.file
        ? ["Waiting for the first message", "This session has not written its conversation yet."]
        : this.readFailed
        ? READ_FAILED
        : ["No messages yet", this.address ? "Type below to start. ⌘J shows the Terminal." : "Type below to start."];
  }

  empty(p) {
    const [title, about] = this.emptyText();
    return v_flex().id("log").flex_1().min_h(0).items_center().justify_center().gap(6).px(28).pb(40)
      .on_mouse_down("left", () => this.focus.focus())
      .child(icon("mark", 26).text_color(p.faint).mb(4))
      .child(div().text_size(14).font_semibold().text_color(p.text).child(title))
      .child(div().text_size(12.5).text_color(p.muted).text_center().child(about));
  }
}
