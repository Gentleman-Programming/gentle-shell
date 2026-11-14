// Gentle Shell as a native chat (T1 spike, read side + prompt). Shows one Gentle Shell (pi)
// terminal's conversation, read incrementally from its session JSONL, and sends what you type
// with `hc send`. The terminal stays the real Gentle Shell TUI.
// props: { terminal? } (else the focused / shown tab's Gentle Shell), and in a layout stack
// { stack, self, other } for the Chat / Terminal switch (see herdr/layouts/gentle-shell.json).

import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView, InputState, Input, ScrollHandle } from "gpui-base";
import { agents, terminals, focused, props, layout, hc, run, theme, watchFolder } from "herdr";
import { sessionFileFor, readAfter } from "./session.js";
import { createFeed, ingest, money } from "./feed.js";

const APPS = new Set(["gentle-shell", "pi"]);
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PAGE = 150; // items drawn at first; "Show earlier" adds this many
const CLIP = 6000; // characters of a tool's args/result shown when expanded
const MONO = "Menlo";

const isGentle = (v) => typeof v === "string" && APPS.has(v);
const fence = (lang, s) => {
  const body = s.length > CLIP ? s.slice(0, CLIP) + "\n… (truncated)" : s;
  return "```" + lang + "\n" + body.replace(/```/g, "ˋˋˋ") + "\n```";
};

export default class GentleChat extends View {
  init(_props, cx) {
    this.feed = createFeed();
    this.address = null;
    this.file = null;
    this.dir = null;
    this.pos = 0;
    this.watched = null;
    this.loading = false;
    this.again = false;
    this.real = new Map(); // cwd -> real path, for sessionFileFor
    this.open = new Set(); // expanded thinking / tool cards
    this.limit = PAGE;
    this.stick = true; // scroll to the newest item after the next draw
    this.error = null;
    this.sending = false;
    this.scroll = ScrollHandle.new();
    this.input = InputState.new({ placeholder: "Message Gentle Shell…  (Enter sends)" });
    this.input.on("submit", (e, cx) => { if (!e?.shift) this.send(cx); });
    cx.timer.every(2000, (cx) => this.tick(cx)); // fallback when a watch event is missed
    this.tick(cx);
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
    cx.spawn(async (cx) => { await this.refresh(cx); });
  }

  // Finds the session file for the target terminal and reads what was added.
  async refresh(cx) {
    const term = this.target();
    const address = term?.address ?? null;
    if (address !== this.address) { this.address = address; this.reset(null); cx.notify(); }
    if (!term) return;
    if (String(address).includes("/")) { this.error = "Remote terminals are not read in this spike."; cx.notify(); return; }
    const where = await sessionFileFor(term, this.real);
    if (this.address !== address) return;
    if (!where) return;
    if (where.dir !== this.dir) { this.dir = where.dir; this.watch(where.dir, cx); }
    if (where.file !== this.file) { this.reset(where.file); cx.notify(); }
    if (this.file) await this.load(cx);
  }

  reset(file) {
    this.feed = createFeed();
    this.file = file;
    this.pos = 0;
    this.limit = PAGE;
    this.open = new Set();
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
    const text = this.input.value().trim();
    const address = this.address;
    if (!text || !address || this.sending) return;
    this.sending = true;
    this.error = null;
    this.input.set_value("");
    cx.notify();
    cx.spawn(async (cx) => {
      try {
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

  // In a layout stack: whether the chat is the shown child.
  showing() {
    const { stack, self } = props() ?? {};
    if (!stack) return true;
    const find = (node) => (node?.id === stack ? node : (node?.children ?? []).map(find).find(Boolean));
    const node = find(layout());
    return (node?.active ?? node?.children?.[0]?.id) === self;
  }

  toggle(key, cx) {
    if (this.open.has(key)) this.open.delete(key); else this.open.add(key);
    cx.notify();
  }

  render(_cx) {
    const t = theme();
    const agent = this.address ? agents().find((a) => a.address === this.address) : null;
    const working = agent?.status === "working";
    const items = this.feed.items;
    const from = Math.max(0, items.length - this.limit);
    const rows = [];
    if (from > 0) {
      rows.push(div().id("earlier").self_center().px(10).py(4).rounded(6).text_size(12).text_color(t.muted)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.limit += PAGE; cx.notify(); })
        .child(`Show earlier (${from})`));
    }
    for (let i = from; i < items.length; i++) rows.push(this.item(items[i], t, working));
    if (working) {
      rows.push(h_flex().gap(6).text_size(12).text_color(t.working)
        .child(div().frames(SPINNER, 90)).child("Working…"));
    }
    if (!rows.length) rows.push(this.empty(t));
    if (this.stick && rows.length) { this.scroll.scroll_to_item(rows.length - 1); this.stick = false; }

    return v_flex().id("root").size_full().bg(t.background).text_color(t.foreground).text_size(13)
      .child(this.header(t, agent, working))
      .child(v_flex().id("log").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll)
        .px(18).py(14).gap(14).children(rows))
      .child(this.composer(t));
  }

  header(t, agent, working) {
    const f = this.feed;
    const { stack, self, other } = props() ?? {};
    const dot = { working: t.working, blocked: t.blocked, done: t.done, idle: t.idle }[agent?.status] ?? t.unknown;
    const chip = (text, color) => div().px(7).py(2).rounded(6).bg(t.raised).text_size(11).text_color(color ?? t.muted).child(text);
    const seg = (id, label, active, onClick) => div().id(id).px(10).py(3).rounded(6).text_size(12)
      .text_color(active ? t.foreground : t.muted).when(active, (el) => el.bg(t.selected))
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick).child(label);
    const showing = this.showing();
    return h_flex().id("header").h(40).flex_shrink_0().px(14).gap(8).items_center().justify_between()
      .bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(working ? div().text_color(t.working).frames(SPINNER, 90) : div().w(8).h(8).rounded_full().bg(dot))
        .child(div().font_semibold().truncate().child(f.name ?? "Gentle Shell"))
        .child(div().text_size(11).text_color(t.dim).child(this.address ?? "no terminal")))
      .child(h_flex().gap(6).items_center().flex_shrink_0()
        .when(Boolean(f.model), (el) => el.child(chip(f.model)))
        .when(Boolean(f.thinking), (el) => el.child(chip(`think ${f.thinking}`)))
        .child(chip(money(f.total), t.foreground))
        .when(Boolean(stack), (el) => el.child(h_flex().gap(2).p(2).rounded(8).border(1).border_color(t.border)
          .child(seg("sw-chat", "Chat", showing, (_e, _cx) => run("layout.select", { stack, child: self })))
          .child(seg("sw-term", "Terminal", !showing, (_e, _cx) => run("layout.select", { stack, child: other }))))));
  }

  empty(t) {
    const msg = !this.address
      ? "No Gentle Shell terminal. Start one with `gentle-shell` in a terminal."
      : !this.file
        ? "Waiting for this session's first message…"
        : "No messages yet.";
    return div().self_center().mt(40).text_color(t.muted).child(TextView.markdown("empty", msg));
  }

  item(item, t, working) {
    if (item.kind === "user") {
      return h_flex().justify_end().w_full()
        .child(div().max_w("85%").px(12).py(8).rounded(12).bg(t.raised).border(1).border_color(t.border)
          .child(TextView.markdown(`u-${item.id}`, item.text).selectable(true)));
    }
    if (item.kind === "note") {
      return div().px(10).py(6).rounded(8).border_l(2).border_color(t.accent).bg(t.surface).text_size(12)
        .child(TextView.markdown(`n-${item.id}`, item.text).selectable(true));
    }
    const parts = item.blocks.map((b, k) => this.block(item, b, k, t, working));
    if (item.error) parts.push(div().text_size(12).text_color(t.blocked).child(`⚠ ${item.error}`));
    if (item.cost) {
      parts.push(h_flex().gap(8).text_size(11).text_color(t.dim)
        .when(Boolean(item.model), (el) => el.child(item.model))
        .child(money(item.cost)));
    }
    return v_flex().gap(8).w_full().children(parts);
  }

  block(item, b, k, t, working) {
    const key = `${item.id}-${k}`;
    if (b.type === "text") return div().w_full().child(TextView.markdown(`a-${key}`, b.text).selectable(true));
    if (b.type === "thinking") {
      const open = this.open.has(`th-${key}`);
      return v_flex().gap(4)
        .child(h_flex().id(`th-${key}`).gap(6).text_size(12).text_color(t.dim).italic().cursor_pointer()
          .hover((s) => s.text_color(t.muted))
          .on_click((_e, cx) => this.toggle(`th-${key}`, cx))
          .child(open ? "▾" : "▸").child("Thinking"))
        .when(open, (el) => el.child(div().pl(10).border_l(2).border_color(t.border).opacity(0.8)
          .child(TextView.markdown(`tht-${key}`, b.text).selectable(true))));
    }
    return this.toolCard(b.call, key, t, working);
  }

  toolCard(call, key, t, working) {
    const open = this.open.has(`tool-${key}`);
    const r = call.result;
    const mark = r ? div().text_color(r.error ? t.blocked : t.done).child(r.error ? "✕" : "✓")
      : working ? div().text_color(t.working).frames(SPINNER, 90) : div().text_color(t.dim).child("•");
    return v_flex().w_full().rounded(8).border(1).border_color(r?.error ? t.blocked : t.border).bg(t.surface)
      .child(h_flex().id(`tool-${key}`).gap(8).px(10).py(6).items_center().cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.toggle(`tool-${key}`, cx))
        .child(mark)
        .child(div().font_semibold().text_size(12).flex_shrink_0().child(call.name))
        .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(12).text_color(t.muted).child(call.summary))
        .child(div().text_size(11).text_color(t.dim).child(open ? "▾" : "▸")))
      .when(open, (el) => el.child(v_flex().gap(6).px(10).pb(8).border_t(1).border_color(t.border).text_size(12)
        .child(div().pt(6).text_color(t.dim).child("Arguments"))
        .child(TextView.markdown(`ta-${key}`, fence("json", JSON.stringify(call.args, null, 2) ?? "")).selectable(true))
        .child(div().text_color(t.dim).child(r ? (r.error ? "Error" : "Result") : "No result yet"))
        .when(Boolean(r), (e2) => e2.child(TextView.markdown(`tr-${key}`, fence("", r.text || "(empty)")).selectable(true)))));
  }

  composer(t) {
    return v_flex().flex_shrink_0().gap(6).px(14).py(10).bg(t.chrome).border_t(1).border_color(t.border)
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).px(10).py(6).rounded(10).bg(t.background).border(1).border_color(t.input)
          .child(Input.new(this.input)))
        .child(div().id("send").px(14).py(6).rounded(10).bg(this.address ? t.solid : t.raised)
          .text_color(this.address ? t.solid_foreground : t.dim).font_semibold().cursor_pointer()
          .on_click((_e, cx) => this.send(cx))
          .child(this.sending ? div().frames(SPINNER, 90) : div().child("Send"))));
  }
}
