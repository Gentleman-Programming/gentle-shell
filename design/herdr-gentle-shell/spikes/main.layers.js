// Spike S1 (b): layered monochrome glyph sprites. Each character = 6 stacked text layers
// (outline, hair, skin, shirt, shade, pants) tinted with text_color and stepped by .frames()
// on Herdr's shared clock. One font serves every shirt colour.
import { View, div } from "gpui-kit";

const ANIMATE = true;
const LAYERS = ["pants", "shade", "shirt", "skin", "hair", "outline"];
const ORDER = { outline: 0, hair: 1, skin: 2, shirt: 3, shade: 4, pants: 5 };
const glyph = (layer, f) => String.fromCharCode(0x21 + ORDER[layer] * 12 + f);
const SHIRTS = ["#f095c8", "#5ee6e6", "#e0c27a", "#b48cff", "#b4e7c7"];
const shade = { "#f095c8": "#a8507e", "#5ee6e6": "#2a8a9a", "#e0c27a": "#a08036", "#b48cff": "#6a4aa8", "#b4e7c7": "#5a9a7a" };
const tint = (layer, shirt) => ({ outline: "#0c0714", hair: "#2a1b27", skin: "#e8b496", shirt, shade: shade[shirt], pants: "#2a2448" })[layer];

function sprite(id, x, y, shirt, walking) {
  const frames = walking ? [0, 1, 2, 3, 4, 5, 6, 7] : [8, 9, 10, 11];
  const box = div().id(id).absolute().top(y).left(x).w(32).h(56);
  const layers = LAYERS.map((l) => {
    let el = div().absolute().top(0).left(0).font_family("TowerPix").text_size(52).text_color(tint(l, shirt));
    return ANIMATE ? el.frames(frames.map((f) => glyph(l, f)), walking ? 125 : 170) : el.child(glyph(l, frames[0]));
  });
  let wrap = box.children(layers);
  if (ANIMATE && walking) wrap = wrap.loop("left", { from: x, to: x + 90, period: 7000, easing: "linear" });
  return wrap;
}

export default class TowerSpike extends View {
  render(cx) {
    const kids = [];
    for (let i = 0; i < 15; i++) {
      const row = Math.floor(i / 5), col = i % 5;
      kids.push(sprite(`p${i}`, 50 + col * 175, 60 + row * 125, SHIRTS[i % 5], i % 2 === 0));
    }
    return div().id("root").size_full().relative().bg("#1a0f26").text_color("#f6eff3")
      .child(div().absolute().top(10).left(14).text_size(12).child(`S1 (b): 15 layered glyph sprites · animate=${ANIMATE}`))
      .child(div().absolute().top(26).left(14).font_family("PxPlus IBM VGA 8x16").text_size(16).child("win98 pixel font test ABC"))
      .children(kids);
  }
}
