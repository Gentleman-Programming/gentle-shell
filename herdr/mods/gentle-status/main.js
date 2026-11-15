// gentle-status: the window's status bar (region 6, design/herdr-desktop/01-inspector.html
// `.status`, l.281-283), replacing Herdr's `workspace-status` (adapted from it: the palette hint
// reads the real binding of the Gentle commands palette, `mod.open:gentle-palette`, T10). For the focused Gentle Shell session's snapshot:
//   ODD <phase> · todo <n> of <total>   the ODD phase and the current todo position
//   streaming / working / idle      activity (tok/s only when the snapshot carries it)
//   <needs you>                     the blocked label while the session waits for the person
//   Jobs <n> running · <m> done
//   ...                             integrations summary (when published) and ⌘K Commands
//
// Key commands (T10, herdr/keys.json): the status bar is always mounted, unlike the chat (a hidden
// stack child is unloaded while the Terminal shows), so the window-wide keys live here:
//   toggle   Chat ↔ Terminal (layout.select on the `views` stack)
//   stop     the shown session's turn, through its inbox (abort_turn: the TUI's Esc Esc; the
//            session refuses it while its agent is idle)

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { run, window, keys, layout, nextCommand, notify } from "herdr";
import { tokens, state, kbd, cap } from "./tokens.js";
import { FeedSource, targetTerminal } from "./snapshot.js";
import { sendAction, errorText, showTerminal } from "./actions.js";

// The Gentle palette's key as bound (herdr/keys.json binds ⌘K in the layout's section), e.g.
// "⌘K". Unbound, the chat's own ⌘K (while the chat has the keyboard) is the artboard's ⌘K.
const PALETTE = "mod.open:gentle-palette";
function paletteKey() {
  const mac = window()?.platform === "macos";
  const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
  const all = keys().filter((k) => k.action === PALETTE);
  const b = all.find((k) => k.section === "layout:gentle-shell") ?? all.find((k) => k.section === "global") ?? all[0];
  if (!b) return mac ? "⌘K" : null;
  const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
  return parts ? parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("") : null;
}

export default class GentleStatus extends View {
  init(_props, cx) {
    this.last = null;
    this.source = new FeedSource();
    this.source.start(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand());
        try {
          if (c === "toggle") this.toggle();
          else if (c === "stop") this.stop(cx);
        } catch { /* a key command never breaks the bar */ }
      }
    });
  }

  toggle() {
    const find = (node) => (node?.id === "views" ? node : (node?.children ?? []).map(find).find(Boolean));
    const node = find(layout());
    if (!node) return;
    const chat = (node.active ?? node.children?.[0]?.id) === "chat";
    if (chat) showTerminal(targetTerminal(this.last)?.address ?? null);
    else run("layout.select", { stack: "views", child: "chat" });
  }

  // A refusal (idle agent, no session) is a toast: the bar has no line of its own for it.
  stop(cx) {
    const f = this.source.of(targetTerminal(this.last));
    cx.spawn(async (cx) => {
      const r = await sendAction(cx, f, "abort_turn", {});
      if (!r.ok) cx.timer.after(1, () => notify({ title: "Stop the agent", body: errorText(r), level: "info", timeout: 4000 }));
    });
  }

  render() {
    const c = tokens();
    const term = targetTerminal(this.last);
    if (term) this.last = term.address;
    const f = this.source.of(term);
    const a = f?.activity;
    const items = f?.todo?.items ?? [];
    const at = items.findIndex((t) => t.state === "in_progress" || t.state === "blocked");
    const position = at >= 0 ? `todo ${at + 1} of ${items.length}` : items.length ? `todo ${f.todo.progress?.done ?? 0} of ${items.length} done` : null;
    const running = f?.jobs?.running?.length ?? 0;
    const done = f?.jobs?.recent?.length ?? 0;
    const tps = Number(a?.tps ?? a?.tokensPerSecond);
    const key = paletteKey();
    const integrations = Array.isArray(f?.integrations) ? f.integrations : null;

    let bar = h_flex().id("root").size_full().px(14).gap(18).items_center().bg(c.chrome).border_t(1).border_color(c.line)
      .font_family(c.sans).text_size(12).line_height("18px").text_color(c.muted).whitespace_nowrap();
    if (!f) {
      bar = bar.child(div().child("No Gentle Shell session focused"));
    } else {
      // .phase: text colour, the phase word in accent 600.
      // Without a phase: "ODD · todo 5 of 10", or "ODD —" when there is nothing to say.
      bar = bar.child(h_flex().gap(3.5).flex_none().text_color(c.text)
        .child("ODD")
        .when(Boolean(a?.phase) || !position, (el) => el.child(div().font_weight(600).text_color(a?.phase ? c.accent : c.muted).child(a?.phase ? cap(a.phase) : "—")))
        .when(Boolean(position), (el) => el.child(`· ${position}`)));
      if (a?.streaming || a?.state === "working") {
        bar = bar.child(state(c, "work", a.streaming ? "streaming" : "working",
          Number.isFinite(tps) && tps > 0 ? h_flex().gap(3.5).child("·").child(div().font_family(c.mono).child(`${Math.round(tps)} tok/s`)) : null));
      } else if (a?.state !== "blocked") {
        bar = bar.child(state(c, "idle", "idle"));
      }
      if (a?.state === "blocked") bar = bar.child(state(c, "need", a.blockedLabel || "Main agent waiting for your answer"));
      bar = bar.child(h_flex().gap(3.5).flex_none()
        .child("Jobs").child(div().font_family(c.mono).child(String(running))).child("running ·")
        .child(div().font_family(c.mono).child(String(done))).child("done"));
    }
    bar = bar.child(div().flex_1());
    if (integrations) {
      const ready = integrations.filter((i) => i.ok).length;
      bar = bar.child(div().child(`Integrations ${ready}/${integrations.length}`));
    }
    return bar.child(h_flex().id("palette").gap(6).items_center().cursor_pointer().hover((s) => s.text_color(c.text))
      .on_click(() => run("mod.open", { name: "gentle-palette" }))
      // The artboard's kbd sits on the text baseline of an 18px line: 1px lower than centred.
      .when(Boolean(key), (el) => el.child(kbd(c, key).mt(2)))
      .child("Commands"));
  }
}
