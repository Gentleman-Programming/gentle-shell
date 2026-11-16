// gentle-tokens: the shared design tokens of the Gentle Shell Desktop mods (tokens.js) and the
// snapshot reader (snapshot.js). Not placed by the layout; opened on its own (mod.open
// gentle-tokens) it shows a swatch of every token next to the live theme role, for fidelity checks.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { HEX, tokens, eyebrow } from "./tokens.js";

export default class GentleTokens extends View {
  render() {
    const c = tokens();
    const row = (name) => h_flex().gap(8).items_center().h(22)
      .child(div().size(14).rounded(4).border(1).border_color(c.lineStrong).bg(c[name] ?? HEX[name]))
      .child(div().w(90).text_color(c.text).child(name))
      .child(div().font_family(c.mono).text_color(c.muted).child(`${c[name] ?? "—"}  (artboard ${HEX[name] ?? "—"})`));
    return v_flex().size_full().p(14).gap(4).bg(c.chrome).font_family(c.sans).text_size(12)
      .child(eyebrow(c, "Gentle Shell Desktop tokens"))
      .children(Object.keys(HEX).map(row));
  }
}
