// gentle-confirm: Herdr's confirm dialog (the shipped `confirm` mod: title, detail, Cancel /
// Confirm; Enter confirms, Esc cancels) that also reports a cancel (T7). Opened as a dialog with
// props { title, detail, command: { name, args }, cancel: { name, args } }: Confirm runs `command`,
// Cancel and Esc run `cancel`, so the mod that opened it forgets the dialog's nonce at once and a
// cancelled dialog can never be confirmed later.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, theme } from "herdr";

export default class GentleConfirm extends View {
  init(_props, cx) {
    this.done = false;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  // Runs one of the two commands once, then closes the dialog.
  finish(which) {
    if (this.done) return;
    this.done = true;
    const p = props() ?? {};
    closeOverlay(p.overlay);
    const command = p[which];
    if (command?.name) run(command.name, command.args ?? {});
  }

  render(_cx) {
    const t = theme();
    const p = props() ?? {};
    const button = (id, label, bg, fg, onClick) =>
      h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(id === "no" ? t.input : bg).bg(bg).text_color(fg).cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
    return v_flex()
      .id("gentle-confirm")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "enter") this.finish("command");
        else if (e.key === "escape") this.finish("cancel");
        else return;
        cx.stop_propagation();
      })
      .size_full()
      .min_h(0)
      .p(18)
      .gap(12)
      .rounded(8)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child(p.title ?? "Are you sure?")).child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().flex_1().min_h(0).overflow_y_scrollbar().text_color(t.muted).child(p.detail ?? ""))
      .child(
        h_flex()
          .justify_end()
          .gap(8)
          .text_size(12)
          .child(button("no", "Cancel", t.raised, t.foreground, () => this.finish("cancel")))
          .child(button("yes", "Confirm", t.solid, t.solid_foreground, () => this.finish("command"))),
      );
  }
}
