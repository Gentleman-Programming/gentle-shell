// Gentle Shell as a native chat: the centre column of design/herdr-desktop/01-inspector.html
// (T5). Shows one Gentle Shell (pi) terminal's conversation, read incrementally from its session
// JSONL, with the session header and the pending question from the session's desktop snapshot
// (docs/desktop-feed.md), and sends what you type with `hc send`. The terminal stays the real
// Gentle Shell TUI; the header's Chat | Terminal switch flips the layout stack.
// props: { terminal? } (else the focused / shown tab's Gentle Shell), and in a layout stack
// { stack, self, other } for the Chat / Terminal switch (see herdr/layouts/gentle-shell.json).
// Drawing: ui.js; colours, type and radii: tokens.js (shared with the T6 mods).

import { View, div } from "gpui-kit";
import { v_flex, TextareaState, ScrollHandle } from "gpui-base";
import { agents, terminals, focused, props, layout, hc, run, setShared, shared, theme, watchFolder, nextCommand } from "herdr";
import { sessionFileFor, readAfter, feedDir } from "./session.js";
import { createFeed, ingest } from "./feed.js";
import { palette, sans, R } from "./tokens.js";
import { header, entries, entry, lane, stateLabel, askCard, askOptions, composer, icon, PERM } from "./ui.js";
import { sendAction, errorText, safeKeys, terminalFree, tuiCommand, showTerminal, confirm, confirmed, readSnapshot } from "./actions.js";

const APPS = new Set(["gentle-shell", "pi"]);
const PAGE = 150; // entries drawn at first; "Show earlier" adds this many
const TICK = 5000; // fallback refresh when a watch event is missed (both folders are watched)
const PLACEHOLDER = "Message Gentle Shell…  / for commands";
const PLACEHOLDER_ASK = "Answer above, or message Gentle Shell…  / for commands";
const ESC_MS = 1000; // the TUI's double-Esc window for stopping a turn (DOUBLE_ESC_CANCEL_WINDOW_MS)
const ESC_NOTICE = "Press Esc again to stop the agent.";
const SLASH_MAX = 50; // commands the "/" menu filters to at most
const REQUEST_MS = 10000; // a palette request older than this is ignored (shared values persist)
const REQUEST_POLL = 500; // how often a shown chat looks for a palette request

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

const isGentle = (v) => typeof v === "string" && APPS.has(v);
const questionKey = (q) => (q ? `${q.toolCallId ?? ""}|${q.openedAt ?? ""}|${q.question ?? ""}` : null);

export default class GentleChat extends View {
  init(_props, cx) {
    this.feed = createFeed();
    this.snap = null; // the session's desktop snapshot (gentle-shell.desktop-feed/v1), or null
    this.address = null;
    this.cwd = null;
    this.file = null;
    this.dir = null;
    this.pos = 0;
    this.watched = null;
    this.feedWatch = false;
    this.loading = false;
    this.again = false;
    this.real = new Map(); // cwd -> real path, for sessionFileFor
    this.open = new Map(); // card id -> open, when flipped from its default
    this.hunkAt = new Map(); // diff card id -> shown hunk
    this.limit = PAGE;
    this.stick = true; // scroll to the newest entry after the next draw
    this.error = null;
    this.sending = false;
    this.typing = false; // the composer has the keyboard
    this.permOpen = false;
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
      { keystroke: "escape", action: "gentle_chat_escape", context: "GentleChat" },
      { keystroke: "escape", action: "gentle_chat_escape", context: "GentleChatComposer > Input" },
      { keystroke: "up", action: "gentle_chat_slash_up", context: "GentleSlashMenu > Input" },
      { keystroke: "down", action: "gentle_chat_slash_down", context: "GentleSlashMenu > Input" },
      { keystroke: "tab", action: "gentle_chat_slash_complete", context: "GentleSlashMenu > Input" },
    ]);
    cx.timer.every(TICK, (cx) => this.tick(cx));
    this.tick(cx);
    this.commands(cx);
    // Palette requests: a hidden stack child stays alive but gets no commands, so a request made
    // while the Terminal showed is picked up here once the chat shows (a shared read, no redraw).
    cx.timer.every(REQUEST_POLL, (cx) => { if (this.showing()) this.request(cx); });
  }

  // Key commands ("<key>": "gentle-chat.<command>" in keys.json, or `herdr-app do gentle-chat.<command>`;
  // herdr/keys.json binds them): chat, terminal, toggle (Chat ↔ Terminal), perm (opens the
  // permission menu), mode-<normal|auto|yolo|super-yolo> (the menu's own path: Super-YOLO asks in
  // a dialog first), stop (the agent's turn, as Esc Esc), palette (the Gentle commands palette)
  // and request (a palette row: the slash command it names, see gentle-palette).
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
          else if (c === "stop") this.stop(cx);
          else if (c === "palette") this.palette();
          else if (c === "request") this.request(cx);
          else if (mode && PERM.some((m) => m.mode === mode)) this.setMode(mode, cx);
        } catch (e) {
          this.error = String(e?.message ?? e);
        }
        cx.notify();
      }
    });
  }

  // props.terminal, else the focused Gentle Shell, else one in the shown tab, else the first.
  target() {
    const gentleAgents = agents().filter((a) => isGentle(a.app));
    const set = new Set(gentleAgents.map((a) => a.address));
    const all = terminals().filter((t) => set.has(t.address) || isGentle(t.agent) || isGentle(t.report?.app) || isGentle(t.app));
    const want = props()?.terminal;
    if (want) return all.find((t) => t.address === want) ?? null;
    const f = focused();
    const byAddr = (a) => all.find((t) => t.address === a);
    const inTab = gentleAgents.filter((a) => a.tab === f?.tab);
    return byAddr(f?.agent) ?? byAddr(f?.terminal) ?? byAddr(inTab[0]?.address) ?? byAddr(this.address) ?? all[0] ?? null;
  }

  tick(cx) {
    this.watchFeeds(cx);
    cx.spawn(async (cx) => { await this.refresh(cx); });
  }

  // Finds the session file and snapshot for the target terminal and reads what was added.
  async refresh(cx) {
    const term = this.target();
    const address = term?.address ?? null;
    if (address !== this.address) { this.address = address; this.cwd = term?.cwd ?? null; this.reset(null); this.setSnap(null); cx.notify(); }
    if (!term) return;
    if (String(address).includes("/")) { this.error = "Remote terminals are not read yet."; cx.notify(); return; }
    const where = await sessionFileFor(term, this.real);
    if (this.address !== address) return;
    if (this.setSnap(where?.feed ?? null)) cx.notify();
    if (!where) return;
    if (where.dir !== this.dir) { this.dir = where.dir; this.watch(where.dir, cx); }
    if (where.file !== this.file) { this.reset(where.file); cx.notify(); }
    if (this.file) await this.load(cx);
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
    // The state has no placeholder setter: an empty composer gets a fresh one.
    const want = q ? PLACEHOLDER_ASK : PLACEHOLDER;
    if (want !== this.placeholder && !this.typing && !this.input.value()) {
      const old = this.input;
      try {
        this.makeInput(want);
        old.release();
      } catch {
        this.input = old; // the old placeholder stays; nothing else depends on it
      }
    }
    return true;
  }

  makeInput(placeholder) {
    this.placeholder = placeholder;
    this.input = TextareaState.new({ placeholder, rows: 2 });
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
    this.feed = createFeed();
    this.file = file;
    this.pos = 0;
    this.limit = PAGE;
    this.open = new Map();
    this.hunkAt = new Map();
    this.stick = true;
    this.error = null;
  }

  // Wakes on any change in the session folder (a new session file appears there too).
  watch(dir, cx) {
    if (this.watched === dir) return;
    this.watched = dir;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === dir) {
          await watchFolder(dir);
          if (this.watched !== dir) break;
          await this.refresh(cx);
        }
      } catch {
        if (this.watched === dir) this.watched = null; // the timer keeps it fresh
      }
    });
  }

  // Wakes on any snapshot write (<agentDir>/desktop/sessions). Before the first Gentle Shell
  // session creates the folder the watch fails; the next tick tries again.
  watchFeeds(cx) {
    if (this.feedWatch) return;
    this.feedWatch = true;
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          await watchFolder(feedDir());
          await this.refresh(cx);
        }
      } catch {
        this.feedWatch = false;
      }
    });
  }

  // Reads only the complete lines added since `pos`. The file only grows; if it shrank, start over.
  async load(cx) {
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    const file = this.file;
    try {
      do {
        this.again = false;
        const before = this.feed.items.length;
        const { text, end, more } = await readAfter(file, this.pos);
        if (file !== this.file) return;
        if (text === null) {
          if (this.pos > 0) { this.reset(file); this.again = true; }
          continue;
        }
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
    if (!text || !address || this.sending) return;
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
        const r = await hc(["send", address, text]);
        if (r.code !== 0) { this.error = (r.stderr || r.stdout || "hc send failed").trim(); this.input.set_value(text); }
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
    if (!pq || !address || this.answered) return;
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
      if (!pq.toolCallId) throw new Error("Answer it in the Terminal view.");
      const r = await sendAction(cx, this.snap?.identity?.sessionId, "answer_question", { toolCallId: pq.toolCallId, ...answer });
      if (!r.ok) {
        if (r.error?.code === "answer_in_terminal") this.later(cx, () => this.toTerminal());
        throw new Error(errorText(r));
      }
      if (!safeKeys(r.data.keys)) throw new Error("The session answered keys this view does not press.");
      // The question may have closed or changed since the session answered: read it again and
      // press nothing unless it is still the same one.
      const still = async () => {
        const fresh = await readSnapshot(this.snap?.identity?.sessionId);
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
    this.act(key, cx, (cx) => tuiCommand(this.address, this.snap, text, () => this.later(cx, () => this.toTerminal())));
  }

  // A slash command from the composer, its "/" menu or the palette: typed into the TUI like the
  // person would. `terminal`: its result is a TUI screen, so the Terminal shows; otherwise the
  // chat stays (a prompt template's turn, /new, /name …). The draft comes back if it failed.
  runCommand(text, terminal, cx) {
    if (this.busy) return;
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
      const r = await sendAction(cx, this.snap?.identity?.sessionId, "abort_turn", {});
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
    setShared("gentle-palette.terminal", { address: this.address, at: Date.now() });
    run("mod.open", { name: "gentle-palette" });
  }

  // A palette request (gentle-palette): a permission mode, or a slash command. Consume-once: it is
  // cleared when taken, and one older than REQUEST_MS is dropped. Without the session's snapshot
  // yet it waits for the next look (REQUEST_POLL).
  request(cx) {
    const req = shared("gentle-chat.request");
    if (!req || typeof req !== "object" || !Number.isFinite(req.at) || req.at === this.lastRequest) return;
    if (Math.abs(Date.now() - req.at) > REQUEST_MS) { setShared("gentle-chat.request", null); return; }
    if (!this.snap || !this.address) return;
    this.lastRequest = req.at;
    setShared("gentle-chat.request", null);
    if (req.kind === "mode") {
      if (PERM.some((m) => m.mode === req.mode)) this.setMode(req.mode, cx);
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
      const r = await sendAction(cx, this.snap?.identity?.sessionId, "set_permission_mode", { mode });
      return r.ok ? null : errorText(r);
    });
    if (mode !== "super-yolo") return go(cx);
    confirm("gentle-chat", {
      title: "Switch this session to Super-YOLO?",
      detail: "The agent runs ordinary and destructive shell work without asking; private paths stay blocked and consent prompts remain. Only this session changes. The session accepts it only while its agent, jobs and subagents are idle.",
    }, go);
  }

  stopAgent(id, cx) {
    this.act(`stop-${id}`, cx, async (cx) => {
      const r = await sendAction(cx, this.snap?.identity?.sessionId, "cancel_subagent", { id });
      return r.ok ? null : errorText(r);
    });
  }

  // Pastes the clipboard (an image, or files on macOS) into the session's draft, as Ctrl+V in the
  // terminal does; it goes with the next message sent.
  attach(cx) {
    this.act("attach", cx, async () => {
      const address = this.address;
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

  go(which, _cx) {
    const { stack, self, other } = this.stackProps();
    if (stack) run("layout.select", { stack, child: which === "chat" ? self : other });
  }

  isOpen(id, def) {
    return this.open.has(id) ? this.open.get(id) : def;
  }

  toggle(id, def, cx) {
    this.open.set(id, !this.isOpen(id, def));
    cx.notify();
  }

  key(e, cx) {
    if (this.typing || e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt) return;
    const pq = this.snap?.pendingQuestion;
    const n = Number(e.key);
    if (pq && Number.isInteger(n) && n >= 1 && n <= askOptions(pq).length) { this.answer(n - 1, cx); cx.stop_propagation(); }
  }

  render(_cx) {
    const p = palette(theme());
    const agent = this.address ? agents().find((a) => a.address === this.address) : null;
    this.agentInfo = agent;
    const working = agent?.status === "working" || this.snap?.activity?.state === "working";
    const list = entries(this.feed.items);
    const from = Math.max(0, list.length - this.limit);
    const rows = [];
    if (from > 0) {
      rows.push(div().flex_none().self_center().child(div().id("earlier").px(10).py(3).rounded(R.inner).text_size(12).text_color(p.muted)
        .cursor_pointer().hover((s) => s.bg(p.selected))
        .on_click((_e, cx) => { this.limit += PAGE; this.pinned = false; cx.notify(); })
        .child(`Show earlier (${from} ${from === 1 ? "message" : "messages"})`)));
    }
    for (let i = from; i < list.length; i++) rows.push(lane(entry(this, p, list[i], working && i === list.length - 1)));
    const pq = this.snap?.pendingQuestion;
    if (pq) rows.push(lane(askCard(this, p, pq)));
    else if (working) rows.push(lane(stateLabel(p, "work", "Working")));
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
  empty(p) {
    const [title, about] = !this.address
      ? ["No Gentle Shell session", "Start one with + in the tab bar, or run gentle-shell in a terminal."]
      : !this.file
        ? ["Waiting for the first message", "This session has not written its conversation yet."]
        : ["No messages yet", "Type below to start. ⌘J shows the Terminal."];
    return v_flex().id("log").flex_1().min_h(0).items_center().justify_center().gap(6).px(28).pb(40)
      .on_mouse_down("left", () => this.focus.focus())
      .child(icon("mark", 26).text_color(p.faint).mb(4))
      .child(div().text_size(14).font_semibold().text_color(p.text).child(title))
      .child(div().text_size(12.5).text_color(p.muted).text_center().child(about));
  }
}
