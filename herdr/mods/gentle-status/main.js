// gentle-status: the window's status bar (region 6, design/herdr-desktop/01-inspector.html
// `.status`, l.281-283), replacing Herdr's `workspace-status` (adapted from it: the palette hint
// reads the real binding). For the focused Gentle Shell session's snapshot:
//   ODD <phase> · todo <n> of <total>   the ODD phase and the current todo position
//   streaming / working / idle      activity (tok/s only when the snapshot carries it)
//   <needs you>                     the blocked label while the session waits for the person
//   Jobs <n> running · <m> done
//   ...                             integrations summary (when published) and ⌘K Commands

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { run, window, keys } from "herdr";
import { tokens, state, kbd, cap } from "./tokens.js";
import { FeedSource, targetTerminal } from "./snapshot.js";

// The palette key as bound (workspace-status), e.g. "⌘K".
function paletteKey() {
  const mac = window()?.platform === "macos";
  const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
  const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
  const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
  return parts ? parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("") : null;
}

export default class GentleStatus extends View {
  init(_props, cx) {
    this.last = null;
    this.source = new FeedSource();
    this.source.start(cx);
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
      bar = bar.child(h_flex().gap(3.5).flex_none().text_color(c.text)
        .child("ODD")
        .child(div().font_weight(600).text_color(a?.phase ? c.accent : c.muted).child(a?.phase ? cap(a.phase) : "—"))
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
      .on_click(() => run("app.palette"))
      .when(Boolean(key), (el) => el.child(kbd(c, key)))
      .child("Commands"));
  }
}
