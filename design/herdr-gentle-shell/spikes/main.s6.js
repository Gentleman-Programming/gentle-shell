// Spike S6: Markdown via TextView.markdown and a Mermaid-style diagram as SVG via image().
import { View, div, image } from "gpui-kit";
import { TextView } from "gpui-base";
const PLAN = `### Fix token refresh

1. ✓ Reproduce: a test that fails after the first renewal
2. ✓ Re-arm the timer on every renewal in \`session.go\`
3. … Retry once when the refresh call fails
4. Update the session docs

**Risk:** none outside \`internal/auth\`. 42 tests pass.`;
export default class S6 extends View {
  render(cx) {
    return div().id("root").size_full().relative().bg("#f3ecdf").text_color("#2a1838")
      .child(div().absolute().top(14).left(20).w(330).text_size(14).child(TextView.markdown("plan", PLAN)))
      .child(image("mods/tower-spike/flow.svg").absolute().top(14).left(360).w(760).h(300));
  }
}
